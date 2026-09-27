import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { getCurDay } from '@/utils'

import { jevCache } from './jevCache'
import { createJevStageHandoff } from './jevDirection'
import type { JevAskFn } from './jevDirection'
import { reviewNeededStore } from './reviewNeeded'

// jevDirection 的流水线接线测试（t8 起的既有内容 + fx-010 F-029/F-025 新增）：
// 从 jevDirection.test.ts 按既有 seam 整体迁出（jest 判定单元测试留在原文件，
// 真实 TaskRegistry/工作流的接线测试在本文件），迁移动机见 fx-010 回执：
// 原 916 行超过 .oxlintrc.gate.json 的 eslint/max-lines 800 上限。
// 本文件与单元文件共用 scriptedAsk/DIRECTION 形状的桩：jscpd 忽略 *.test.*（恒定），非重复元组来源。

// t9 单测卫生：流水线测试走 jevDirection 的会话级单例缓存，测试间必须清空（页面刷新语义）
beforeEach(() => {
  jevCache.clear()
})

const DIRECTION = '前端开发'
const TODAY = '2026-09-26'

interface AskRecord {
  job: { title: string; description?: string }
  question: { id: string; instructions: string }
}

/** 记录每次 askJev 的入参，按脚本顺序吐出结果（绝不触网） */
function scriptedAsk(script: Array<Record<string, unknown>>): {
  askJev: JevAskFn
  calls: AskRecord[]
} {
  const calls: AskRecord[] = []
  let i = 0
  const askJev: JevAskFn = async (job, question) => {
    calls.push({ job: { ...job }, question: { ...question } })
    const next = script[i]
    i += 1
    if (!next) throw new Error(`askJev 被调用了 ${i} 次，脚本只有 ${script.length} 条`)
    return next as never
  }
  return { askJev, calls }
}

// 流水线接线（t8）：真实 TaskRegistry 处理器 + 真实 useDeliveryWorkflow 执行语义
//（VAL-010 / AC-007：硬条件排除零 Jev 请求；标题判不相关不取详情、不调 AI 筛选；
//  复判不确定进待复核。bun test 断言请求次数。）
// ————————————————————————————————————————————————————————————————————————————

function stubBrowserGlobals(): void {
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  if (!('window' in globalThis)) {
    const win = { location: { search: '' } }
    define('window', win)
    define('self', win)
    define('localStorage', { getItem: () => null, setItem: () => {} })
  }
  define('useToast', () => ({ add: () => {} }))
  // 流水线构建出错时 rebuild 会 alert：让它在测试里炸出来，而不是被吞掉
  define('alert', (message: string) => {
    throw new Error(`流水线构建错误: ${message}`)
  })
}

/** 与 migrate.storage.test.ts 同口径的受控存储桩：TaskRegistry 的重复沟通过滤器在注册时读存储 */
const storageMap = new Map<string, unknown>()
async function stubCounterStorage(): Promise<void> {
  await import('@/message')
  void mock.module('@/message', () => ({
    counter: {
      storageGet: async (key: string, fallback?: unknown) =>
        storageMap.has(key) ? storageMap.get(key) : fallback,
      storageSet: async (key: string, value: unknown) => {
        storageMap.set(key, value)
        return true
      },
      storageRm: async (key: string) => {
        storageMap.delete(key)
        return true
      },
    },
    ExtStorage: {
      getItem: async (key: string) => (storageMap.has(key) ? storageMap.get(key) : null),
      setItem: async (key: string, value: unknown) => {
        storageMap.set(key, value)
      },
      removeItem: async (key: string) => {
        storageMap.delete(key)
      },
    },
  }))
}

let vueGlobals: Record<string, any> | undefined
async function stubVueAutoImports(): Promise<void> {
  if (vueGlobals) return
  // useApplying/index 依赖 wxt 自动导入的 vue 组合式 API；bun 测试下没有自动导入，注入最小实现
  const { computed, ref, shallowRef, reactive } = await import('vue')
  Object.assign(globalThis, { computed, ref, shallowRef, reactive })
  vueGlobals = {}
}

/** useApplying/index 还靠自动导入拿到 logger / jsonClone / delay；补上真实依赖与观察用 delay */
let stubAutoImportsDone = false
async function stubAutoImports(): Promise<void> {
  if (stubAutoImportsDone) return
  await stubVueAutoImports()
  const [{ logger }, { jsonClone }] = await Promise.all([
    import('@/utils/logger'),
    import('@/utils/deepmerge'),
  ])
  const delay = async (_seconds: number) => {}
  Object.assign(globalThis, { logger, jsonClone, delay })
  stubAutoImportsDone = true
}

let pipelineModules: Record<string, any> | undefined
async function loadPipelineModules(): Promise<Record<string, any>> {
  stubBrowserGlobals()
  await stubAutoImports()
  await stubCounterStorage()
  pipelineModules ??= {
    handles: await import('./handles'),
    workflow: await import('./index'),
    type: await import('./type'),
    delivery: await import('@/entrypoints/boss/delivery'),
    defaultFormData: (await import('@/composables/conf/info')).defaultFormData,
  }
  return pipelineModules
}

interface PipelineFixture {
  seq: string[]
  jevCalls: Array<{ title: string; description?: string }>
  statistics: { reviewNeeded: number; total: number; success: number; tasks: Record<string, any> }
  handoff: ReturnType<typeof createJevStageHandoff>
}

/**
 * 组一条真实流水线：硬条件排除 → Jev 标题阶段 → 岗位详情获取 → Jev 复判 → AI 筛选。
 * askJev 按脚本应答，绝不触网；detail 桩只记录调用并填充职位描述。
 */
async function runPipeline(
  job: { jobName: string; exclude?: boolean; fillDescription?: boolean },
  script: Array<Record<string, unknown>>,
  over: { direction?: string } = {},
): Promise<PipelineFixture> {
  const m = await loadPipelineModules()
  const { defineTaskHandler } = m.type
  const seq: string[] = []
  const jevCalls: Array<{ title: string; description?: string }> = []
  const statistics = { reviewNeeded: 0, total: 0, success: 0, tasks: {} as Record<string, any> }
  const handoff = createJevStageHandoff()
  const scripted = scriptedAsk(script)
  const askJev: JevAskFn = async (j, q, k) => {
    seq.push('jev')
    jevCalls.push({ ...j })
    return scripted.askJev(j, q, k)
  }

  const tasks = new m.handles.TaskRegistry()
  const wf = await m.type.defineTaskWorkflow(
    defineTaskHandler('硬条件排除', () => async () => {
      if (job.exclude) return m.handles.taskResult.skip('硬条件排除')
    }),
    tasks.jevDirection({ stage: 'title', handoff, askJev }),
    defineTaskHandler('岗位详情获取', () => async (_c: unknown, d: any) => {
      seq.push('detail')
      if (job.fillDescription) d.jobData.jobDescription = '负责前端界面开发，Vue + TypeScript'
    }),
    tasks.jevDirection({ stage: 'recheck', handoff, askJev, deps: ['岗位详情获取'] }),
    defineTaskHandler('AI筛选', () => async () => {
      seq.push('ai')
    }),
  )({
    conf: {
      formData: {
        ...m.defaultFormData,
        jev: { enable: true, targetDirection: over.direction ?? DIRECTION },
      },
    },
    statistics: { todayData: { value: statistics } },
    jobResultMaps: new Map(),
    jobList: { value: [] },
    currentJob: { value: null },
    jobMaps: new Map(),
  } as any)
  await wf.rebuild()
  await wf.execute(
    { jobData: { key: 'k1', jobName: job.jobName, jobDescription: '' }, rawData: {}, state: {} },
    0,
  )
  return { seq, jevCalls, statistics, handoff }
}

describe('流水线接线（AC-007 / VAL-010：bun test 断言请求次数）', () => {
  test('(b) 硬条件排除的岗位：零 Jev 请求、零详情请求、零 AI 调用', async () => {
    const run = await runPipeline({ jobName: '数据录入员', exclude: true, fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.97 },
    ])
    expect(run.jevCalls).toEqual([]) // spy askJev 从未被调用
    expect(run.seq).toEqual([]) // 详情与 AI 也没跑
  })

  test('Jev 未启用（FR-010）→ 任务不注册、零请求、不拦截（岗位照常进 AI 筛选）', async () => {
    const m = await loadPipelineModules()
    const seq: string[] = []
    const jevCalls: unknown[] = []
    const askJev: JevAskFn = async () => {
      jevCalls.push(1)
      return { status: 'decided', model: 'm', noul: 0.99 }
    }
    const tasks = new m.handles.TaskRegistry()
    const wf = await m.type.defineTaskWorkflow(
      tasks.jevDirection({
        stage: 'title',
        handoff: createJevStageHandoff(),
        askJev,
      }),
      m.type.defineTaskHandler('AI筛选', () => async () => {
        seq.push('ai')
      }),
    )({
      conf: {
        formData: {
          ...m.defaultFormData,
          jev: { enable: false, targetDirection: DIRECTION },
        },
      },
      statistics: { todayData: { value: { reviewNeeded: 0, total: 0, success: 0, tasks: {} } } },
      jobResultMaps: new Map(),
      jobList: { value: [] },
      currentJob: { value: null },
      jobMaps: new Map(),
    } as any)
    await wf.rebuild()
    await wf.execute(
      {
        jobData: { key: 'k1', jobName: '前端开发工程师', jobDescription: '' },
        rawData: {},
        state: {},
      },
      0,
    )

    expect(wf.pipeline.value.map((t: { id: string }) => t.id)).not.toContain('Jev方向判断')
    expect(jevCalls).toEqual([])
    expect(seq).toEqual(['ai']) // 未启用不拦截（FR-010）
  })

  test('Jev 未启用且方向为空（FR-010）→ 不注册任务、零请求、零记账、不拦截（F-029 的边界）', async () => {
    const m = await loadPipelineModules()
    const seq: string[] = []
    const statistics = { reviewNeeded: 0, total: 0, success: 0, tasks: {} as Record<string, any> }
    const tasks = new m.handles.TaskRegistry()
    const wf = await m.type.defineTaskWorkflow(
      tasks.jevDirection({
        stage: 'title',
        handoff: createJevStageHandoff(),
        askJev: async () => {
          throw new Error('未启用时不应请求 Jev')
        },
      }),
      m.type.defineTaskHandler('AI筛选', () => async () => {
        seq.push('ai')
      }),
    )({
      conf: {
        formData: { ...m.defaultFormData, jev: { enable: false, targetDirection: '' } },
      },
      statistics: { todayData: { value: statistics } },
      jobResultMaps: new Map(),
      jobList: { value: [] },
      currentJob: { value: null },
      jobMaps: new Map(),
    } as any)
    await wf.rebuild()
    await wf.execute(
      {
        jobData: { key: 'k1', jobName: '前端开发工程师', jobDescription: '' },
        rawData: {},
        state: {},
      },
      0,
    )

    expect(wf.pipeline.value.map((t: { id: string }) => t.id)).not.toContain('Jev方向判断')
    expect(statistics.reviewNeeded).toBe(0) // 未启用不是缺字段：零记账
    expect(seq).toEqual(['ai']) // 未启用不拦截（FR-010）
  })

  test('启用但方向为空（F-029 持久态）→ 岗位待复核、零 Jev 请求、不取详情不进 AI', async () => {
    const run = await runPipeline({ jobName: '前端开发工程师', fillDescription: true }, [], {
      direction: '',
    })

    expect(run.seq).toEqual([]) // 不取详情、不进 AI 筛选
    expect(run.jevCalls).toEqual([]) // 空方向不组题：零请求
    expect(run.statistics.reviewNeeded).toBe(1) // 记账待复核，不再静默放行
  })

  test('标题判不相关（0.02 确认带外）→ 无详情请求、无 AI 筛选调用', async () => {
    const run = await runPipeline({ jobName: '后端开发工程师', fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.02 },
    ])
    expect(run.seq).toEqual(['jev'])
    expect(run.jevCalls).toEqual([{ title: '后端开发工程师' }])
    expect(run.statistics.reviewNeeded).toBe(0) // 明确不相关不是待复核
  })

  test('标题判相关（0.97）→ 详情后零复判请求，进入 AI 筛选（Jev 在 AI 之前）', async () => {
    const run = await runPipeline({ jobName: '前端开发工程师', fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.97 },
    ])
    expect(run.seq).toEqual(['jev', 'detail', 'ai'])
    expect(run.jevCalls.length).toBe(1)
  })

  test('标题含糊（0.25）→ 取详情后按描述复判（0.89 翻转）→ 再进 AI 筛选', async () => {
    const run = await runPipeline({ jobName: '后端开发工程师', fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.89 },
    ])
    expect(run.seq).toEqual(['jev', 'detail', 'jev', 'ai'])
    expect(run.jevCalls[1]).toEqual({
      title: '后端开发工程师',
      description: '负责前端界面开发，Vue + TypeScript',
    })
    expect(run.statistics.reviewNeeded).toBe(0)
  })

  test('(d) 复判不确定 → 待复核并计入统计（当次不投递、不进 AI 筛选）', async () => {
    const run = await runPipeline({ jobName: '全栈工程师', fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.26 },
    ])
    expect(run.seq).toEqual(['jev', 'detail', 'jev']) // AI 筛选未被调用
    expect(run.statistics.reviewNeeded).toBe(1)
  })

  test('详情后描述仍为空 → 待复核（不发起复判请求）', async () => {
    const run = await runPipeline({ jobName: '全栈工程师', fillDescription: false }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
    ])
    expect(run.seq).toEqual(['jev', 'detail'])
    expect(run.statistics.reviewNeeded).toBe(1)
  })
})

describe('delivery 流水线顺序（FR-012/FR-016：硬条件 → Jev 标题 → 详情 → 关键词 → Jev 复判 → AI）', () => {
  test('真实 bossWorkflow 的注册顺序满足全部先后约束', async () => {
    const m = await loadPipelineModules()
    // 启用全部同阶段/详情阶段本地硬条件，保证 indexOf 比较的是真实先后而不是 -1
    const keywordField = () => ({
      enable: true,
      groups: { includeWords: ['前端开发'], excludeWords: [], includeMode: 'any' },
      include: true,
      value: ['前端开发'],
      options: ['前端开发'],
    })
    const helper = {
      conf: {
        formData: {
          ...m.defaultFormData,
          sameCompanyFilter: { ...m.defaultFormData.sameCompanyFilter, value: true },
          sameHrFilter: { ...m.defaultFormData.sameHrFilter, value: true },
          jobTitle: keywordField(),
          company: { ...m.defaultFormData.company, enable: true, value: ['虚构公司'] },
          salaryRange: { ...m.defaultFormData.salaryRange, enable: true },
          companySizeRange: { ...m.defaultFormData.companySizeRange, enable: true },
          goldHunterFilter: { ...m.defaultFormData.goldHunterFilter, value: true },
          activityFilter: { ...m.defaultFormData.activityFilter, value: true },
          hrPosition: { ...m.defaultFormData.hrPosition, enable: true },
          jobAddress: { ...m.defaultFormData.jobAddress, enable: true },
          friendStatus: { ...m.defaultFormData.friendStatus, value: true },
          jobContent: keywordField(),
          bossGoldMedalHr: { ...m.defaultFormData.bossGoldMedalHr, value: true },
          amap: { ...m.defaultFormData.amap, enable: true },
          aiFiltering: { ...m.defaultFormData.aiFiltering, enable: true, score: 10 },
          jev: { enable: true, targetDirection: DIRECTION },
        },
      },
      chatModel: {
        createAgent: () => ({}),
        chat: async () => ({ text: '' }),
      },
      statistics: {
        todayData: {
          value: { date: TODAY, success: 0, total: 0, repeat: 0, activityFilter: 0, tasks: {} },
        },
      },
      jobResultMaps: new Map(),
      jobList: { value: [] },
      currentJob: { value: null },
      jobMaps: new Map(),
    }
    const wf = await m.delivery.bossWorkflow(helper)
    await wf.rebuild()
    const ids: string[] = wf.pipeline.value.map((t: { id: string }) => t.id)
    // 先断言这些节点确实注册了：否则 indexOf 的 -1 会让比较变成恒真
    for (const id of [
      'Jev方向判断',
      'Jev方向复判',
      'AI筛选',
      '猎头过滤',
      '岗位详情获取',
      '工作内容',
    ]) {
      expect(ids).toContain(id)
    }
    expect(ids.indexOf('Jev方向判断')).toBeGreaterThan(ids.indexOf('猎头过滤')) // 同阶段硬条件先于 Jev
    expect(ids.indexOf('Jev方向判断')).toBeLessThan(ids.indexOf('岗位详情获取')) // 标题判不相关时不取详情
    expect(ids.indexOf('工作内容')).toBeLessThan(ids.indexOf('Jev方向复判')) // 描述关键词先于复判
    expect(ids.indexOf('Jev方向复判')).toBeLessThan(ids.indexOf('AI筛选')) // Jev 在 AI 筛选之前
  })
})

describe('流水线缓存（t9 / AC-009 / FR-018：命中缓存与新鲜终判流水线效果一致）', () => {
  test('(d) confirmed-negative 命中缓存：零 Jev 请求、不取详情、不调 AI（与新鲜 skip 同效）', async () => {
    // 第一轮：标题确认不相关（0.02 ≤ 0.2）→ skip，不取详情（基线行为）
    const first = await runPipeline({ jobName: '数据标注员' }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.02 },
    ])
    expect(first.seq).toEqual(['jev'])
    expect(first.jevCalls).toEqual([{ title: '数据标注员' }])

    // 第二轮：同岗位同判定依据 → 缓存命中，零请求、零详情、零 AI
    const second = await runPipeline({ jobName: '数据标注员' }, [])
    expect(second.seq).toEqual([])
    expect(second.jevCalls).toEqual([])
    expect(second.statistics.reviewNeeded).toBe(0)
  })

  test('pass 命中缓存：零 Jev 请求，照常取详情并进 AI 筛选（与新鲜 pass 同效）', async () => {
    const first = await runPipeline({ jobName: '前端开发工程师', fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.97 },
    ])
    expect(first.seq).toEqual(['jev', 'detail', 'ai'])

    const second = await runPipeline({ jobName: '前端开发工程师', fillDescription: true }, [])
    expect(second.seq).toEqual(['detail', 'ai']) // 标题阶段命中 pass，后续步骤照常
    expect(second.jevCalls).toEqual([])
  })

  test('复判的明确结果入缓存：第二轮从标题阶段起零请求且后续效果一致（AC-009 端到端）', async () => {
    const first = await runPipeline({ jobName: '全栈工程师', fillDescription: true }, [
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.89 },
    ])
    expect(first.seq).toEqual(['jev', 'detail', 'jev', 'ai'])

    const second = await runPipeline({ jobName: '全栈工程师', fillDescription: true }, [])
    expect(second.seq).toEqual(['detail', 'ai'])
    expect(second.jevCalls).toEqual([])
    expect(second.statistics.reviewNeeded).toBe(0)
  })
})

describe('F-025：缺字段记账的当日去重（handles.ts 缺字段路径补 {today}）', () => {
  test('岗位名为空：页面列表清空后重扫同一岗位 → 今日累计只 +1', async () => {
    const m = await loadPipelineModules()
    const { migrateKeywordGroups } = await import('@/composables/conf/migrate')
    const field = migrateKeywordGroups({
      include: true,
      value: ['前端开发'],
      options: [],
      enable: true,
    })
    const statistics: Record<string, unknown> = {}
    const now = new Date()
    const ctx = {
      now,
      helper: {
        conf: { formData: { jobTitle: field } },
        statistics: { todayData: { value: statistics } },
      },
      index: 0,
      log: {},
    } as never
    const registry = new m.handles.TaskRegistry()
    const handler = await registry.jobTitle().task(ctx)
    if (!handler) throw new Error('jobTitle 处理器未注册')
    const jobData = { key: 'k-title-empty', jobName: '', jobDescription: '' }
    expect(await handler(ctx, { jobData })).toEqual({
      isSkip: true,
      reason: '岗位名为空',
      status: 'warn',
    })
    expect(statistics.reviewNeeded).toBe(1)
    reviewNeededStore.clear() // 列表被跳过/重试清掉：当日重扫同岗位不得重复计数
    await handler(ctx, { jobData })
    expect(statistics.reviewNeeded).toBe(1)
    expect((statistics.reviewNeededCounted as { date: string }).date).toBe(getCurDay(now))
  })

  test('工作内容为空：同样当日去重，列表清空后重扫只 +1', async () => {
    const m = await loadPipelineModules()
    const { migrateKeywordGroups } = await import('@/composables/conf/migrate')
    const field = migrateKeywordGroups({
      include: false,
      value: ['外包'],
      options: [],
      enable: true,
    })
    const statistics: Record<string, unknown> = {}
    const now = new Date()
    const ctx = {
      now,
      helper: {
        conf: { formData: { jobContent: field } },
        statistics: { todayData: { value: statistics } },
      },
      index: 0,
      log: {},
    } as never
    const registry = new m.handles.TaskRegistry()
    const handler = await registry.jobContent().task(ctx)
    if (!handler) throw new Error('jobContent 处理器未注册')
    const jobData = { key: 'k-content-empty', jobName: '前端开发工程师', jobDescription: '' }
    expect(await handler(ctx, { jobData })).toEqual({
      isSkip: true,
      reason: '工作内容为空',
      status: 'warn',
    })
    expect(statistics.reviewNeeded).toBe(1)
    reviewNeededStore.clear()
    await handler(ctx, { jobData })
    expect(statistics.reviewNeeded).toBe(1)
  })
})
