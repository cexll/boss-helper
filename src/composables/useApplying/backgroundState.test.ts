import { expect, test } from 'bun:test'

import {
  BACKGROUND_THROTTLE_HINT,
  createBackgroundThrottleStore,
  decideThrottleHint,
  isThrottledDelay,
} from './backgroundState'

/**
 * 判定条件来自 p2 实测记录 §5（docs/probes/throttle-p2-record.md）：
 * 触发 = 页面不可见 且 连续 2 次 delay() 满足 actual >= max(2 × requested, requested + 10)；
 * 恢复 = 可见 且 下一次 delay() 满足 actual < requested + 3。
 * 本文件只驱动纯判定与可注入的 store，不碰 DOM、不碰流水线。
 */

test('常态超时（actual ≈ requested + 1）不算节流', () => {
  expect(isThrottledDelay(2, 3)).toBe(false)
  expect(isThrottledDelay(5, 5.84)).toBe(false)
  expect(isThrottledDelay(10, 11)).toBe(false)
})

test('节流判定取 max(2×requested, requested+10) 中更宽松的一侧', () => {
  // 小间隔：requested+10 更宽松（2 → 12），因此 2 秒档的最小绝对超时是 10 秒
  expect(isThrottledDelay(2, 11.99)).toBe(false)
  expect(isThrottledDelay(2, 12)).toBe(true)
  // 大间隔：两臂相等（10 → 20）
  expect(isThrottledDelay(10, 19.99)).toBe(false)
  expect(isThrottledDelay(10, 20)).toBe(true)
  // 超过 10 秒后 2×requested 更宽松（30 → 60）
  expect(isThrottledDelay(30, 59.99)).toBe(false)
  expect(isThrottledDelay(30, 60)).toBe(true)
  // p2 实测：t=916 的 9.8 / 5.2 / 10 是「被节流」轮次里的最小超时样本
  // （9.8 秒对 2 秒档仍未达 12 秒门槛，所以判定要求「连续 2 次」而非单次）
  expect(isThrottledDelay(2, 9.8)).toBe(false)
  expect(isThrottledDelay(5, 5.2)).toBe(false)
  expect(isThrottledDelay(10, 10.93)).toBe(false)
  // 强化节流把单次计时钳制到 60 秒
  expect(isThrottledDelay(2, 60)).toBe(true)
  expect(isThrottledDelay(5, 60)).toBe(true)
  expect(isThrottledDelay(60, 60)).toBe(false)
  // 阈值失义时宁可沉默：非正/非有限配置永不判为节流
  expect(isThrottledDelay(0, 600)).toBe(false)
  expect(isThrottledDelay(-5, 600)).toBe(false)
  expect(isThrottledDelay(Number.NaN, 600)).toBe(false)
  expect(isThrottledDelay(5, Number.NaN)).toBe(false)
})

test('可见时不提示：即使单次计时被钳制到 60 秒', () => {
  expect(decideThrottleHint({ visibility: 'visible', consecutiveThrottled: 5 })).toBe('hidden')
  expect(decideThrottleHint({ visibility: 'visible', consecutiveThrottled: 0 })).toBe('hidden')
})

test('隐藏但只累计 1 次节流不提示（切换瞬间的偶发抖动不算）', () => {
  expect(decideThrottleHint({ visibility: 'hidden', consecutiveThrottled: 1 })).toBe('hidden')
  expect(decideThrottleHint({ visibility: 'hidden', consecutiveThrottled: 0 })).toBe('hidden')
})

test('隐藏且连续 2 次节流才提示', () => {
  expect(decideThrottleHint({ visibility: 'hidden', consecutiveThrottled: 2 })).toBe('throttled')
  expect(decideThrottleHint({ visibility: 'hidden', consecutiveThrottled: 3 })).toBe('throttled')
})

test('提示文案如实说明：后台计时被限制、间隔被拉长、任务仍在继续、切回前台恢复，且不含任何加速选项', () => {
  expect(BACKGROUND_THROTTLE_HINT).toContain('后台')
  expect(BACKGROUND_THROTTLE_HINT).toContain('计时')
  expect(BACKGROUND_THROTTLE_HINT).toContain('拉长')
  expect(BACKGROUND_THROTTLE_HINT).toContain('60')
  expect(BACKGROUND_THROTTLE_HINT).toContain('继续')
  expect(BACKGROUND_THROTTLE_HINT).toContain('前台')
  expect(BACKGROUND_THROTTLE_HINT).not.toContain('加速')
  expect(BACKGROUND_THROTTLE_HINT).not.toContain('忽略')
})

test('store：注入可见性与时钟，观察 delay() 后按 §5 触发提示', () => {
  let visibility = 'hidden'
  let now = 0
  const store = createBackgroundThrottleStore({
    visibility: () => visibility,
    now: () => now,
  })

  expect(store.hint()).toBeUndefined()
  expect(store.copy()).toBeUndefined()

  const first = store.begin(5)
  now += 60_000
  expect(store.end(first())).toBeUndefined() // 第 1 次：只累计，不提示

  const second = store.begin(5)
  now += 60_000
  expect(store.end(second())).toBe(BACKGROUND_THROTTLE_HINT)
  expect(store.copy()).toBe(BACKGROUND_THROTTLE_HINT)
  expect(store.count()).toBe(2)
})

test('store：可见状态下不提示，且把连续计数清零', () => {
  let visibility = 'visible'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  for (let i = 0; i < 3; i += 1) {
    const begin = store.begin(5)
    now += 60_000
    expect(store.end(begin())).toBeUndefined()
  }
  expect(store.count()).toBe(0)

  // 切后台后计数从零重新开始：第一次仍然不提示，第二次才提示
  visibility = 'hidden'
  const begin = store.begin(5)
  now += 60_000
  expect(store.end(begin())).toBeUndefined()
  expect(store.count()).toBe(1)

  const next = store.begin(5)
  now += 60_000
  expect(store.end(next())).toBe(BACKGROUND_THROTTLE_HINT)
})

test('store：切回前台且下一次计时恢复常态（actual < requested + 3）时清除提示', () => {
  let visibility = 'hidden'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  const a = store.begin(5)
  now += 60_000
  store.end(a())
  const b = store.begin(5)
  now += 60_000
  expect(store.end(b())).toBe(BACKGROUND_THROTTLE_HINT)

  // 仍不可见时即使计时回到常态也不清除（p2 §5：恢复条件要求可见）——
  // 用户没在看页面，此时收回提示会掩盖后续再次变慢
  const c = store.begin(5)
  now += 1_000
  expect(store.end(c())).toBe(BACKGROUND_THROTTLE_HINT)

  visibility = 'visible'
  const d = store.begin(5)
  now += 1_000
  expect(store.end(d())).toBeUndefined()
  expect(store.copy()).toBeUndefined()
})

test('store：切回前台但下一次计时仍被拉长（actual >= requested + 3）时不提前清除', () => {
  let visibility = 'hidden'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  const a = store.begin(5)
  now += 60_000
  store.end(a())
  const b = store.begin(5)
  now += 60_000
  expect(store.end(b())).toBe(BACKGROUND_THROTTLE_HINT)

  // 已可见但超时仍达门槛（requested+3 = 8s 起算）：保留提示，等真正恢复再清除
  visibility = 'visible'
  const c = store.begin(5)
  now += 20_000
  expect(store.end(c())).toBe(BACKGROUND_THROTTLE_HINT)
  expect(store.copy()).toBe(BACKGROUND_THROTTLE_HINT)

  // 确实是「可见但计时被拉长」的残留提示：一旦恢复到常态即清除（不因残留而永久保留）
  const d = store.begin(5)
  now += 1_000
  expect(store.end(d())).toBeUndefined()
  expect(store.copy()).toBeUndefined()
})
test('store：可见且超时恰为 requested + 3 时不提前清除（保留提示等待下一次观测）', () => {
  let visibility = 'hidden'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  const a = store.begin(5)
  now += 60_000
  store.end(a())
  const b = store.begin(5)
  now += 60_000
  expect(store.end(b())).toBe(BACKGROUND_THROTTLE_HINT)

  visibility = 'visible'
  const c = store.begin(5)
  now += 3_000 // 恰为 requested + 3：actual < requested + 3 为假，不满足 §5 清除条件
  expect(store.end(c())).toBeUndefined()
  expect(store.copy()).toBeUndefined()
})
test('store：订阅只在提示状态真的变化时通知', () => {
  let visibility = 'visible'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  const seen: Array<string | undefined> = []
  const unsubscribe = store.subscribe((hint) => seen.push(hint))

  const a = store.begin(5)
  now += 3_000
  store.end(a()) // 常态：无变化 → 不通知
  expect(seen).toEqual([])

  visibility = 'hidden'
  const b = store.begin(5)
  now += 60_000
  store.end(b()) // 只有 1 次 → 仍是 hidden
  const c = store.begin(5)
  now += 60_000
  store.end(c()) // 第 2 次 → 提示出现
  expect(seen).toEqual([BACKGROUND_THROTTLE_HINT])

  const d = store.begin(5)
  now += 60_000
  store.end(d()) // 已在提示中 → 不重复通知
  expect(seen).toEqual([BACKGROUND_THROTTLE_HINT])

  visibility = 'visible'
  const e = store.begin(5)
  now += 1_000
  store.end(e()) // 恢复 → 清除
  expect(seen).toEqual([BACKGROUND_THROTTLE_HINT, undefined])

  unsubscribe()
  visibility = 'hidden'
  const f = store.begin(5)
  now += 60_000
  store.end(f())
  const g = store.begin(5)
  now += 60_000
  store.end(g())
  expect(seen).toEqual([BACKGROUND_THROTTLE_HINT, undefined])
})

test('store：clear 手动清除提示与计数', () => {
  let visibility = 'hidden'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  const a = store.begin(5)
  now += 60_000
  store.end(a())
  const b = store.begin(5)
  now += 60_000
  store.end(b())
  expect(store.copy()).toBe(BACKGROUND_THROTTLE_HINT)

  store.clear()
  expect(store.copy()).toBeUndefined()
  expect(store.count()).toBe(0)
})

test('store：不可见性包含 document 的其它非 visible 取值（如 prerender）', () => {
  let visibility = 'prerender'
  let now = 0
  const store = createBackgroundThrottleStore({ visibility: () => visibility, now: () => now })

  const a = store.begin(5)
  now += 60_000
  store.end(a())
  const b = store.begin(5)
  now += 60_000
  expect(store.end(b())).toBe(BACKGROUND_THROTTLE_HINT)
})

/**
 * 缺省依赖路径（不注入 visibility/now）：真实页面用的就是这个分支。
 * bun test 环境没有 DOM，因此 document 需要临时搭出来，并在用例结束后还原，
 * 避免污染其它用例（判定本身仍由注入的时钟驱动，不依赖真实计时）。
 */
function withDocument<T>(state: string | undefined, run: () => T): T {
  const globals = globalThis as { document?: unknown }
  const original = globals.document
  globals.document = state === undefined ? undefined : { visibilityState: state }
  try {
    return run()
  } finally {
    globals.document = original
  }
}

test('缺省可见性：没有 document 时按可见处理（不在浏览器里就不提示）', () => {
  expect(typeof globalThis.document === 'undefined' || globalThis.document === undefined).toBe(true)

  const store = createBackgroundThrottleStore({ now: () => 0 })
  store.end({ requested: 5, actual: 600 })
  store.end({ requested: 5, actual: 600 })
  expect(store.copy()).toBeUndefined()
})

test('缺省可见性：document.visibilityState 为 hidden 时正常触发提示', () => {
  withDocument('hidden', () => {
    const store = createBackgroundThrottleStore({ now: () => 0 })
    expect(store.end({ requested: 5, actual: 600 })).toBeUndefined()
    expect(store.end({ requested: 5, actual: 600 })).toBe(BACKGROUND_THROTTLE_HINT)
    expect(store.copy()).toBe(BACKGROUND_THROTTLE_HINT)
  })
})

test('缺省可见性：document.visibilityState 为 visible 时不触发', () => {
  withDocument('visible', () => {
    const store = createBackgroundThrottleStore({ now: () => 0 })
    store.end({ requested: 5, actual: 600 })
    expect(store.end({ requested: 5, actual: 600 })).toBeUndefined()
  })
})

test('缺省可见性：未知取值按不可见处理（宁可沉默也不假装在执行）', () => {
  withDocument('bogus-state', () => {
    const store = createBackgroundThrottleStore({ now: () => 0 })
    store.end({ requested: 5, actual: 600 })
    expect(store.end({ requested: 5, actual: 600 })).toBe(BACKGROUND_THROTTLE_HINT)
  })
})

test('缺省时钟：不注入 now 时 begin 返回可测量的一次采样（真实 performance.now 口径）', () => {
  withDocument('hidden', () => {
    const store = createBackgroundThrottleStore()
    const timer = store.begin(2)

    const measured = timer()
    expect(measured.requested).toBe(2)
    expect(Number.isFinite(measured.actual)).toBe(true)
    expect(measured.actual).toBeGreaterThanOrEqual(0)
    // 本次几乎瞬时：远未达 max(2×2, 2+10) = 12，因此不提示
    expect(store.end(measured)).toBeUndefined()

    // 显式传入实测耗时同样被接受（流水线侧已经量好墙钟时走这条）
    const explicit = timer(600)
    expect(explicit).toEqual({ requested: 2, actual: 600 })
    expect(store.end(explicit)).toBeUndefined()
  })
})
