import { describe, expect, mock, test } from 'bun:test'

import { JEV_UNCERTAIN_BAND, createJevStageHandoff, judgeJevDirection } from './jevDirection'
import type { JevAskFn, JevDirectionDeps, JevDirectionJob, JevStage } from './jevDirection'
import type { ReviewNeededReasonKind } from './reviewNeeded'

/**
 * 判定口径来自 p1 实测记录 docs/probes/jev-p1-record.md：
 * - §5 标定：明确样本 ≤0.07 / ≥0.96；含糊样本（全栈对半）0.25；标题说「否」、描述说「是」
 *   真实存在（0.02 → 0.89 翻转），因此标题阶段的「否」只有在确认带外才允许跳过取详情。
 * - §6.2 建议带（待用户确认）：noul ≤ 0.2 判「否」，noul ≥ 0.8 判「是」，(0.2, 0.8) → 待复核。
 * - §6.1 超时 8 秒（t5 的 JEV_TIMEOUT_MS，单次尝试不重试）。
 */

const DIRECTION = '前端开发'
const TODAY = '2026-09-26'

function freshStatistics(): Record<string, unknown> {
  return {}
}

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

interface DepsOverride {
  stage?: JevStage
  direction?: string | null
  handoff?: JevDirectionDeps['handoff']
  getApiKey?: JevDirectionDeps['getApiKey']
  statistics?: unknown
}

function makeDeps(
  askJev: JevAskFn,
  record: ReturnType<typeof recorder>,
  over: DepsOverride = {},
): JevDirectionDeps {
  return {
    stage: over.stage ?? 'title',
    askJev,
    getTargetDirection: () => ('direction' in over ? (over.direction as string | null) : DIRECTION),
    recordReviewNeeded: record.recordReviewNeeded,
    statistics: (over.statistics ?? freshStatistics()) as JevDirectionDeps['statistics'],
    getToday: () => TODAY,
    getApiKey: over.getApiKey,
    handoff: over.handoff,
  }
}

function recorder() {
  const entries: Array<{ job: { key: string; jobName: string }; reason: string; kind: string }> = []
  return {
    entries,
    recordReviewNeeded: (
      jobData: { key: string; jobName: string },
      reason: string,
      kind: ReviewNeededReasonKind,
    ) => {
      entries.push({ job: jobData, reason, kind })
      return true
    },
  }
}

const jobOf = (over: Partial<JevDirectionJob> = {}): JevDirectionJob => ({
  key: 'k1',
  jobName: '前端开发工程师',
  ...over,
})

describe('标题阶段（FR-012：仅凭标题判断）', () => {
  test('标题明确相关（p1 §5 标定 0.97 ≥ 0.8）→ pass，且只发了一次标题请求', async () => {
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.97 }])
    const record = recorder()
    const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record))

    expect(verdict).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1)
    // FR-011 / AC-011：岗位内容只有标题与描述；标题阶段只给标题
    expect(calls[0]!.job).toEqual({ title: '前端开发工程师' })
    expect(calls[0]!.question.instructions).toContain(DIRECTION)
    expect(record.entries).toEqual([])
  })

  test('标题确认不相关（p1 §5 标定 0.02 ≤ 0.2）→ skip，且不发第二次请求', async () => {
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.02 }])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '后端开发工程师' }),
      makeDeps(askJev, record),
    )

    expect(verdict.decision).toBe('skip')
    expect(calls.length).toBe(1)
    expect(record.entries).toEqual([]) // 明确不相关不是待复核
  })

  test('标题含糊（p1 §5 全栈对半 0.25 落在含糊带）且没有描述、没有交接 → 待复核（jev_uncertain）', async () => {
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.25 }])
    const record = recorder()
    const statistics = freshStatistics()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '全栈工程师' }),
      makeDeps(askJev, record, { statistics }),
    )

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_uncertain' })
    expect(calls.length).toBe(1) // 没有描述可复判，不再多发请求
    expect(record.entries.length).toBe(1)
    expect(record.entries[0]).toMatchObject({ job: { key: 'k1' }, kind: 'jev_uncertain' })
  })
})

describe('复判阶段（p1 §5：标题说否、描述说是，0.02→0.89）', () => {
  test('标题含糊 + 描述在手 → 用标题+描述复判一次；描述翻转为 0.89 → pass', async () => {
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.89 },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '后端开发工程师', jobDescription: '负责前端界面开发，Vue + TypeScript' }),
      makeDeps(askJev, record),
    )

    expect(verdict).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(2)
    expect(calls[1]!.job).toEqual({
      title: '后端开发工程师',
      description: '负责前端界面开发，Vue + TypeScript',
    })
    expect(record.entries).toEqual([])
  })

  test('复判仍含糊（p1 §5 空 state 0.24–0.32）→ 待复核（jev_uncertain）且只记一次', async () => {
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.32 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.26 },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '全栈工程师', jobDescription: '前后端都做' }),
      makeDeps(askJev, record),
    )

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_uncertain' })
    expect(calls.length).toBe(2)
    expect(record.entries.length).toBe(1)
    expect(record.entries[0]!.kind).toBe('jev_uncertain')
  })

  test('复判确认不相关（0.03 ≤ 0.2）→ skip', async () => {
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.03 },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '产品经理', jobDescription: '负责后台产品规划' }),
      makeDeps(askJev, record),
    )

    expect(verdict.decision).toBe('skip')
    expect(calls.length).toBe(2)
    expect(record.entries).toEqual([])
  })

  test('复判报错（如密钥未配置）→ 待复核（jev_error），原因透传给用户', async () => {
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'error', reason: '未配置 Jev 密钥' },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '全栈工程师', jobDescription: '前后端都做' }),
      makeDeps(askJev, record),
    )

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_error' })
    expect((verdict as { reason: string }).reason).toContain('未配置 Jev 密钥')
    expect(calls.length).toBe(2)
    expect(record.entries.length).toBe(1)
  })
})

describe('失败与不可用（fail-closed，绝不因失败放行或排除）', () => {
  test('标题阶段报错 → 待复核（jev_error），原因透传，不再请求', async () => {
    const { askJev, calls } = scriptedAsk([
      {
        status: 'error',
        reason: '当前上下文无法连接 Jev 服务（跨域权限或网络受限），需经扩展后台或稍后重试',
      },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record))

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_error' })
    expect(calls.length).toBe(1)
    expect(record.entries.length).toBe(1)
  })

  test('标题阶段超时（t5 单次尝试不重试）→ 待复核（jev_timeout）', async () => {
    const { askJev, calls } = scriptedAsk([
      { status: 'reviewNeeded', reason: 'Jev 判断超时（单次尝试不重试），已放入待复核' },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record))

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_timeout' })
    expect(calls.length).toBe(1)
    expect(record.entries[0]!.kind).toBe('jev_timeout')
  })

  test('响应形态异常（200 但缺数值）→ 待复核且不算超时', async () => {
    const { askJev } = scriptedAsk([
      { status: 'reviewNeeded', reason: 'Jev 响应缺少模型标识或判定数值，已放入待复核' },
    ])
    const record = recorder()
    const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record))

    expect(verdict).toMatchObject({ decision: 'reviewNeeded' })
    expect((verdict as { kind: string }).kind).not.toBe('jev_timeout')
  })
})

describe('未启用 / 未配置（FR-010：不拦截、零请求）', () => {
  test('目标方向为空字符串 → pass，零请求、零记录', async () => {
    const { askJev, calls } = scriptedAsk([])
    const record = recorder()
    const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record, { direction: '' }))

    expect(verdict).toEqual({ decision: 'pass' })
    expect(calls).toEqual([])
    expect(record.entries).toEqual([])
  })

  test('目标方向未配置（undefined）/纯空白 → pass，零请求', async () => {
    for (const direction of [undefined, null, '   ']) {
      const { askJev, calls } = scriptedAsk([])
      const record = recorder()
      const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record, { direction }))
      expect(verdict).toEqual({ decision: 'pass' })
      expect(calls).toEqual([])
    }
  })
})

describe('p1 §6.2 建议带是唯一阈值来源（待用户确认后只改这一处）', () => {
  test('带上沿 0.8 算「是」、带下沿 0.2 算「否」、带内一律不确定', async () => {
    expect(JEV_UNCERTAIN_BAND.low).toBe(0.2)
    expect(JEV_UNCERTAIN_BAND.high).toBe(0.8)

    const atHigh = scriptedAsk([{ status: 'decided', model: 'm', noul: 0.8 }])
    expect(await judgeJevDirection(jobOf(), makeDeps(atHigh.askJev, recorder()))).toEqual({
      decision: 'pass',
    })
    const aboveHigh = scriptedAsk([{ status: 'decided', model: 'm', noul: 0.79 }])
    expect(await judgeJevDirection(jobOf(), makeDeps(aboveHigh.askJev, recorder()))).toMatchObject({
      decision: 'reviewNeeded',
      kind: 'jev_uncertain',
    })

    const atLow = scriptedAsk([{ status: 'decided', model: 'm', noul: 0.2 }])
    expect(
      await judgeJevDirection(jobOf(), makeDeps(atLow.askJev, recorder())).then((v) => v.decision),
    ).toBe('skip')
    const belowLow = scriptedAsk([{ status: 'decided', model: 'm', noul: 0.21 }])
    expect(await judgeJevDirection(jobOf(), makeDeps(belowLow.askJev, recorder()))).toMatchObject({
      decision: 'reviewNeeded',
      kind: 'jev_uncertain',
    })
  })
})

describe('交接：标题含糊 → 取详情后复判（FR-012「不确定则取详情，关键词通过后复判」）', () => {
  test('标题含糊且无描述：标记待复判并继续流水线（不记待复核、不再请求）', async () => {
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.25 }])
    const record = recorder()
    const handoff = createJevStageHandoff()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '全栈工程师' }),
      makeDeps(askJev, record, { handoff }),
    )

    expect(verdict).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1)
    expect(record.entries).toEqual([])
    expect(handoff.takePending('k1')).toBe(true) // 交接给详情复判阶段
    expect(handoff.takePending('k1')).toBe(false) // 取走即消费，不重复复判
  })

  test('复判阶段：有交接标记 → 直接用标题+描述复判（不重复标题请求）；无标记 → 零请求放行', async () => {
    const handoff = createJevStageHandoff()
    handoff.markPending('k-pending')

    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.9 }])
    const record = recorder()
    const pendingVerdict = await judgeJevDirection(
      jobOf({ key: 'k-pending', jobName: '后端开发工程师', jobDescription: '前端界面开发' }),
      makeDeps(askJev, record, { stage: 'recheck', handoff }),
    )
    expect(pendingVerdict).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1) // 只有复判这一次请求，标题阶段的结果被复用

    const idleVerdict = await judgeJevDirection(
      jobOf({ key: 'k-idle' }),
      makeDeps(askJev, record, { stage: 'recheck', handoff }),
    )
    expect(idleVerdict).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1) // 标题阶段已有明确结论的岗位不再请求
  })

  test('复判阶段：有交接标记但描述仍为空 → 待复核（jev_uncertain，p1 §5 空标题/空 state 属含糊带）', async () => {
    const handoff = createJevStageHandoff()
    handoff.markPending('k1')
    const { askJev, calls } = scriptedAsk([])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '全栈工程师' }),
      makeDeps(askJev, record, { stage: 'recheck', handoff }),
    )

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_uncertain' })
    expect(calls).toEqual([])
    expect(record.entries.length).toBe(1)
  })
})

describe('记账契约（t6 / fx-006：{today} 当日去重入参）', () => {
  test('recordReviewNeeded 收到统计对象与当日键', async () => {
    const { askJev } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.3 }])
    const statistics = freshStatistics()
    let seenOptions: unknown
    let seenStatistics: unknown
    const verdict = await judgeJevDirection(jobOf(), {
      stage: 'title',
      askJev,
      getTargetDirection: () => DIRECTION,
      recordReviewNeeded: (_job, _reason, kind, stats, options) => {
        seenOptions = options
        seenStatistics = stats
        void kind
        return true
      },
      statistics: statistics as JevDirectionDeps['statistics'],
      getToday: () => TODAY,
    })

    expect(verdict).toMatchObject({ decision: 'reviewNeeded' })
    expect(seenStatistics).toBe(statistics)
    expect(seenOptions).toEqual({ today: TODAY })
  })

  test('getApiKey 透传给注入的 askJev（t5 deps 直通）', async () => {
    let seenKeyReader: unknown
    const askJev: JevAskFn = async (_job, _question, getApiKey) => {
      seenKeyReader = getApiKey
      return { status: 'decided', model: 'jev-1.13.0', noul: 0.97 }
    }
    const reader = async () => 'sk-test'
    await judgeJevDirection(jobOf(), makeDeps(askJev, recorder(), { getApiKey: reader }))
    expect(seenKeyReader).toBe(reader)
  })

  test('上一轮残留的复判标记在当前标题阶段被清掉：这轮已定论则不触发复判请求', async () => {
    const handoff = createJevStageHandoff()
    handoff.markPending('k1') // 假设上一轮含糊留下了标记
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.97 }])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobName: '前端开发工程师' }),
      makeDeps(askJev, record, { handoff }),
    )

    expect(verdict).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1) // 只有本轮标题这一次请求
    expect(handoff.takePending('k1')).toBe(false) // 残留标记已被消费，详情阶段不会再复判
  })
})

// ————————————————————————————————————————————————————————————————————————————
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
    conf: { formData: { ...m.defaultFormData, jev: { enable: true, targetDirection: DIRECTION } } },
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
