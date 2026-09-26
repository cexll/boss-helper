import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import * as ssrRenderer from 'vue/server-renderer'

import type { Statistics } from '@/types/formData'

import { createReviewNeededStore, reviewNeededStore, recordReviewNeeded } from './reviewNeeded'
import type {
  ReviewNeededDayBucket,
  ReviewNeededEntry,
  ReviewNeededReasonKind,
} from './reviewNeeded'

/** 旧版本统计对象的结构：没有 reviewNeeded 字段 */
interface LegacyStatistics {
  date: string
  success: number
  total: number
  repeat: number
  activityFilter: number
  tasks: Record<string, Record<string, number>>
}

function entry(key: string, reason: string) {
  return { key, jobName: `岗位-${key}`, reason, kind: 'jev_timeout' as const }
}

/** 读回模块写入的新字段：旧统计对象本身没有这个属性 */
function reviewCount(statistics: object): number | undefined {
  return (statistics as { reviewNeeded?: number }).reviewNeeded
}
/** 当前版本的统计对象结构（含可选的新计数字段与当日去重桶） */
function freshCounter(): {
  date: string
  success: number
  total: number
  repeat: number
  activityFilter: number
  tasks: Record<string, never>
  reviewNeeded?: number
  reviewNeededCounted?: ReviewNeededDayBucket
} {
  return { date: '2026-09-26', success: 3, total: 9, repeat: 1, activityFilter: 2, tasks: {} }
}

// recordReviewNeeded 写入模块级单例（当前页面的待复核列表），每个用例前清空以保证互不干扰。
beforeEach(() => {
  reviewNeededStore.clear()
})

test('add then list then count', () => {
  const store = createReviewNeededStore()
  expect(store.add(entry('a', 'Jev 超时'))).toBe(true)
  expect(store.count()).toBe(1)
  expect(store.list()).toEqual([
    expect.objectContaining({ key: 'a', jobName: '岗位-a', reason: 'Jev 超时' }),
  ])
})

test('duplicate add is rejected while the job is still present', () => {
  const store = createReviewNeededStore()
  expect(store.add(entry('a', 'Jev 超时'))).toBe(true)
  expect(store.add(entry('a', 'Jev 报错'))).toBe(false)
  expect(store.count()).toBe(1)
  expect(store.get('a')?.reason).toBe('Jev 超时')
})

test('dismiss removes the entry so the job can be judged again', () => {
  const store = createReviewNeededStore()
  store.add(entry('a', 'Jev 超时'))
  expect(store.remove('a')).toBe(true)
  expect(store.count()).toBe(0)
  expect(store.has('a')).toBe(false)
  expect(store.add(entry('a', 'Jev 报错'))).toBe(true)
})

test('count tracks add and remove across operations', () => {
  const store = createReviewNeededStore()
  store.add(entry('a', 'Jev 超时'))
  store.add(entry('b', '字段缺失'))
  store.add(entry('c', 'Jev 不确定'))
  expect(store.count()).toBe(3)
  expect(store.remove('b')).toBe(true)
  expect(store.count()).toBe(2)
  expect(store.remove('b')).toBe(false)
  expect(store.count()).toBe(2)
})

test('clear empties the whole list', () => {
  const store = createReviewNeededStore()
  store.add(entry('a', 'Jev 超时'))
  store.add(entry('b', '字段缺失'))
  store.clear()
  expect(store.count()).toBe(0)
  expect(store.list()).toEqual([])
})

test('refresh clears: a new page store starts empty and is independent', () => {
  const page = createReviewNeededStore()
  page.add(entry('a', 'Jev 超时'))
  expect(page.count()).toBe(1)

  // 页面刷新 = 进程重建 = 新 store；旧列表不会残留
  const afterRefresh = createReviewNeededStore()
  expect(afterRefresh.count()).toBe(0)
  expect(afterRefresh.list()).toEqual([])
  afterRefresh.add(entry('a', 'Jev 超时'))
  expect(afterRefresh.count()).toBe(1)
  expect(page.count()).toBe(1)
})

test('list is a snapshot: mutating it does not change the store', () => {
  const store = createReviewNeededStore()
  store.add(entry('a', 'Jev 超时'))
  const snapshot = store.list()
  snapshot.length = 0
  expect(store.count()).toBe(1)
})

test('subscribe notifies on add, remove and clear; unsubscribe stops', () => {
  const store = createReviewNeededStore()
  const seen: ReviewNeededEntry[][] = []
  const unsubscribe = store.subscribe((entries) => seen.push(entries))

  store.add(entry('a', 'Jev 超时'))
  store.add(entry('b', '字段缺失'))
  expect(seen).toHaveLength(2)
  expect(seen[1]?.map((e) => e.key)).toEqual(['a', 'b'])

  store.remove('a')
  store.clear()
  expect(seen).toHaveLength(4)

  unsubscribe()
  store.add(entry('c', 'Jev 不确定'))
  expect(seen).toHaveLength(4)
})

test('recordReviewNeeded records the job and counts it once', () => {
  const t = freshCounter()
  expect(recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t)).toBe(
    true,
  )
  expect(reviewNeededStore.count()).toBe(1)
  expect(t.reviewNeeded).toBe(1)
  expect(reviewNeededStore.get('a')).toMatchObject({
    key: 'a',
    jobName: '岗位-a',
    reason: 'Jev 超时',
  })
})

test('duplicate recordReviewNeeded for the same job does not double count', () => {
  const t = freshCounter()
  expect(recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t)).toBe(
    true,
  )
  expect(
    recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 不确定', 'jev_uncertain', t),
  ).toBe(false)
  expect(reviewNeededStore.count()).toBe(1)
  expect(t.reviewNeeded).toBe(1)
  expect(reviewNeededStore.get('a')?.reason).toBe('Jev 超时')
})

test('statistics with and without reviewNeeded field both load and count from 0', () => {
  // 当前版本的统计对象（formData.ts 的 Statistics）
  const current: Statistics = {
    date: '2026-09-26',
    success: 2,
    total: 6,
    repeat: 0,
    activityFilter: 1,
    tasks: {},
  }
  expect(
    recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', current),
  ).toBe(true)
  expect(reviewCount(current)).toBe(1)
  expect(current.success).toBe(2)

  // 旧版本写入的统计对象：没有 reviewNeeded 字段
  const legacy: LegacyStatistics = {
    date: '2026-09-25',
    success: 11,
    total: 33,
    repeat: 4,
    activityFilter: 7,
    tasks: { 岗位详情: { warn: 8 } },
  }

  const counted = recordReviewNeeded(
    { key: 'b', jobName: '岗位-b' },
    '字段缺失',
    'missing_field',
    legacy,
  )

  expect(counted).toBe(true)
  expect(reviewCount(legacy)).toBe(1)
  expect(legacy.success).toBe(11)
  expect(legacy.total).toBe(33)
  expect(legacy.repeat).toBe(4)
  expect(legacy.activityFilter).toBe(7)
  expect(legacy.tasks).toEqual({ 岗位详情: { warn: 8 } })
  expect(reviewNeededStore.count()).toBe(2)
})

test('recording a review-needed job performs no storage write', () => {
  const writes: string[] = []
  const storage = {
    getItem: () => null,
    setItem: (_k: string, v: string) => writes.push(v),
    removeItem: () => {},
    clear: () => {},
  } as unknown as Storage
  // 把"存储"换成记录器：模块任何持久化行为都会在这里留下痕迹
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

  const t = freshCounter()
  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t)
  reviewNeededStore.remove('a')
  reviewNeededStore.clear()

  expect(writes).toEqual([])
})

test('reviewNeeded entry carries no exclusion or cache marker', () => {
  reviewNeededStore.add(entry('a', 'Jev 超时'))
  const listed = reviewNeededStore.list()
  expect(listed[0]).toMatchObject({ key: 'a', jobName: '岗位-a', reason: 'Jev 超时' })
  expect(Object.prototype.hasOwnProperty.call(listed[0], 'excluded')).toBe(false)
  expect(Object.prototype.hasOwnProperty.call(listed[0], 'cached')).toBe(false)
  expect(Object.prototype.hasOwnProperty.call(listed[0], 'isSkip')).toBe(false)
})

test('recordReviewNeeded accepts every reason kind', () => {
  const kinds: ReviewNeededReasonKind[] = [
    'jev_error',
    'jev_timeout',
    'jev_uncertain',
    'missing_field',
  ]
  const t = freshCounter()
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!
    const added = recordReviewNeeded(
      { key: `k${i}`, jobName: `岗位-${i}` },
      `理由-${kind}`,
      kind,
      t,
    )
    expect(added).toBe(true)
  }
  expect(reviewNeededStore.count()).toBe(kinds.length)
  expect(t.reviewNeeded).toBe(kinds.length)
})

/** F-004：当日去重需要显式注入日期键（getCurDay 口径），跨日自动重置 */
const DAY = '2026-09-26'
const NEXT_DAY = '2026-09-27'

test('同一岗位当日重复进入待复核只计一次（F-004）', () => {
  const t = freshCounter()
  const first = recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t, {
    today: DAY,
  })
  // 模拟刷新：页面列表清空后同一岗位再次进入待复核
  reviewNeededStore.clear()
  const second = recordReviewNeeded(
    { key: 'a', jobName: '岗位-a' },
    'Jev 不确定',
    'jev_uncertain',
    t,
    { today: DAY },
  )

  expect(first).toBe(true)
  expect(second).toBe(true) // 页面列表仍按 t6 语义重新记录
  expect(t.reviewNeeded).toBe(1) // 今日累计不再重复计
  expect(reviewNeededStore.count()).toBe(1)
})

test('不同岗位分别计数（F-004）', () => {
  const t = freshCounter()
  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t, { today: DAY })
  recordReviewNeeded({ key: 'b', jobName: '岗位-b' }, '字段缺失', 'missing_field', t, {
    today: DAY,
  })
  expect(t.reviewNeeded).toBe(2)
})

test('跨日重置后同一岗位可再次计入（F-004）', () => {
  const t = freshCounter()
  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t, { today: DAY })
  expect(t.reviewNeeded).toBe(1)

  // 注入的日期跨过午夜：计数与去重集合一起重置，同岗位重新计入
  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t, {
    today: NEXT_DAY,
  })
  expect(t.reviewNeeded).toBe(1)
  const bucket = t.reviewNeededCounted
  expect(bucket?.date).toBe(NEXT_DAY)
  expect(bucket?.countedKeys).toEqual(['a'])
})

test('去重状态随统计对象落盘，刷新后仍然生效（F-004）', () => {
  const t = freshCounter()
  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t, { today: DAY })
  expect(t.reviewNeeded).toBe(1)

  // 模拟刷新：统计对象经 JSON 往返（落盘→读回），页面列表进程重建为空
  const reloaded = JSON.parse(JSON.stringify(t)) as typeof t
  reviewNeededStore.clear()
  expect(reviewNeededStore.count()).toBe(0)

  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', reloaded, {
    today: DAY,
  })
  expect(reviewNeededStore.count()).toBe(1) // 列表按 t6 语义重新记录
  expect(reloaded.reviewNeeded).toBe(1) // 计数不重复
})

test('页面列表清空时当日计数保留（F-003/F-004）', () => {
  const t = freshCounter()
  recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t, { today: DAY })
  expect(reviewNeededStore.count()).toBe(1)

  reviewNeededStore.clear()
  expect(reviewNeededStore.count()).toBe(0)
  expect(t.reviewNeeded).toBe(1)
})

test('缺省 today 时保持 t6 页面内语义（4 参契约不回归）', () => {
  const t = freshCounter()
  expect(recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 超时', 'jev_timeout', t)).toBe(
    true,
  )
  reviewNeededStore.remove('a')
  // 移除后同一岗位再次进入：无日期键时按页面内口径重新计数（t6 行为）
  expect(
    recordReviewNeeded({ key: 'a', jobName: '岗位-a' }, 'Jev 不确定', 'jev_uncertain', t),
  ).toBe(true)
  expect(t.reviewNeeded).toBe(2)
  expect(t.reviewNeededCounted).toBeUndefined()
})

// ===== F-003：真实 Statistics.vue 模板 + vue/compiler-sfc SSR 渲染证明 =====

/** 模板里用到的 Nuxt UI 全局组件：桩件透传默认插槽，断言只看真实文本。 */
const SSR_UI_COMPONENTS = ['UBadge', 'UDropdownMenu', 'UFieldGroup', 'UButton', 'UProgress']

/** 桩件：透传默认插槽为 span，断言只依赖真实模板文本。 */
const ssrSlotStub = vue.defineComponent({
  name: 'SsrSlotStub',
  setup(_props, { slots }) {
    return () => vue.h('span', slots.default?.())
  },
})

/** 读取真实 Statistics.vue 源码（相对本测试文件定位）。 */
function readStatisticsSfc(): string {
  const url = new URL('../../components/Tabs/Statistics.vue', import.meta.url)
  return readFileSync(url, 'utf8')
}

/** 编译真实 SFC（inlineTemplate + ssr）：得到 setup 与 ssrRender 合一的模块代码。 */
function compileStatisticsSsr(): string {
  const source = readStatisticsSfc()
  const { descriptor } = parse(source, { filename: 'Statistics.vue' })
  if (!descriptor.scriptSetup) throw new Error('Statistics.vue 缺少 <script setup>')
  return compileScript(descriptor, {
    id: 'statistics-ssr-test',
    inlineTemplate: true,
    templateOptions: { ssr: true },
  }).content
}

/** `a as b` 的导入清单 → 解构重命名 `a: b`；无名导入保持原样。 */
function toDestructure(names: string): string {
  return names
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [imported, local] = item.split(/\s+as\s+/)
      return local ? `${imported}: ${local}` : `${imported}`
    })
    .join(',')
}

/** ESM import/export 改写为沙箱绑定：vue / server-renderer 用真实运行时，其余走桩映射。 */
function rebindSsrImports(code: string): string {
  return code
    .replace(/^import\s+type\s.*?$/gm, '') // 纯类型导入（单行）：运行时无需绑定
    .replace(
      /^import\s*\{([^}]*)\}\s*from\s*['"]vue['"];?\s*$/gm,
      (_m, names: string) => `const {${toDestructure(names)}} = __vue__;`,
    )
    .replace(
      /^import\s*\{([^}]*)\}\s*from\s*['"]vue\/server-renderer['"];?\s*$/gm,
      (_m, names: string) => `const {${toDestructure(names)}} = __ssr__;`,
    )
    .replace(
      /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm,
      (_m, names: string, from: string) =>
        `const {${toDestructure(names)}} = __mod__[${JSON.stringify(from)}];`,
    )
    .replace(
      /^import\s+(\w+)\s*from\s*['"]([^'"]+)['"];?\s*$/gm,
      (_m, name: string, from: string) => `const ${name} = __mod__[${JSON.stringify(from)}];`,
    )
    .replace(/^export\s+default\s+/gm, 'const __sfc_main__ = ')
}

/** 组件依赖的 useHelper / useConf / Alert 桩：todayData 走真实 vue ref，计数由参数注入。 */
function makeStatisticsModules(
  entries: { key: string; jobName: string; reason: string; kind: string }[],
  reviewNeededCount: number,
): Record<string, unknown> {
  const todayData = vue.ref({
    date: '2026-09-26',
    success: 3,
    total: 9,
    repeat: 1,
    activityFilter: 2,
    tasks: {},
    reviewNeeded: reviewNeededCount,
  })
  return {
    '@/components/Alert.vue': ssrSlotStub,
    '@/composables/conf': {
      useConf: () => ({
        configLevel: { intermediate: false },
        formData: { deliveryLimit: { value: 120 } },
      }),
    },
    '@/composables/useApplying/reviewNeeded': {
      reviewNeededStore: {
        list: () => entries,
        subscribe: () => () => {},
      },
    },
    '@/composables/useHelper': {
      useHelper: () => ({
        statistics: {
          todayData,
          statisticsData: vue.ref([]),
          updateStatistics: () => {},
        },
        workflow: { status: vue.ref('stop') },
        start: () => {},
        reset: () => {},
        stop: () => {},
      }),
    },
  }
}
function buildStatisticsComponent(modules: Record<string, unknown>): vue.Component {
  const ts = rebindSsrImports(compileStatisticsSsr())
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(ts)
  const sandbox: { component?: vue.Component } & Record<string, unknown> = {
    __vue__: vue,
    __ssr__: ssrRenderer,
    __mod__: modules,
    __set__: (component: vue.Component) => {
      sandbox.component = component
    },
  }
  // 沙箱代替 new Function：同一作用域执行编译产物，避免隐式 eval 口径
  vm.runInNewContext(`${js}\n__set__(__sfc_main__)`, sandbox)
  return sandbox.component!
}

/** 用真实 Statistics.vue 渲染一段 HTML：entries 为页面列表，count 为今日累计。 */
async function renderStatisticsHtml(
  entries: { key: string; jobName: string; reason: string; kind: string }[],
  reviewNeededCount: number,
) {
  const app = vue.createSSRApp(
    buildStatisticsComponent(makeStatisticsModules(entries, reviewNeededCount)),
  )
  for (const name of SSR_UI_COMPONENTS) app.component(name, ssrSlotStub)
  return ssrRenderer.renderToString(app)
}

test('「今日累计」在页面列表为空时仍然渲染（F-003）', async () => {
  const html = await renderStatisticsHtml([], 7)

  expect(html).toContain('待复核：')
  expect(html).toContain('今日累计 7') // 计数不再挂在列表长度上
  expect(html).not.toContain('岗位-') // 列表确为空
})

test('待复核列表行在列表非空时照常渲染（t6 kept）', async () => {
  const html = await renderStatisticsHtml([entry('复核A', 'Jev 超时')], 7)

  expect(html).toContain('岗位-复核A')
  expect(html).toContain('Jev 超时')
})

test('待复核提示文案改为与实际口径一致', async () => {
  const html = await renderStatisticsHtml([], 0)

  expect(html).not.toContain('不投递也不计入过滤') // 旧文案已不存在
  expect(html).toContain('当次不投递、不缓存、不计入排除')
})
