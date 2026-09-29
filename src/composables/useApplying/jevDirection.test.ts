import { beforeEach, describe, expect, test } from 'bun:test'

import { createJevCache, jevCache } from './jevCache'
import type { JevCache } from './jevCache'
import { JEV_UNCERTAIN_BAND, createJevStageHandoff, judgeJevDirection } from './jevDirection'
import type { JevAskFn, JevDirectionDeps, JevDirectionJob, JevStage } from './jevDirection'
import type { ReviewNeededReasonKind } from './reviewNeeded'

// t9 单测卫生：流水线测试走 jevDirection 的会话级单例缓存，测试间必须清空（页面刷新语义）
beforeEach(() => {
  jevCache.clear()
})
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
  /** t9：注入缓存实例；缺省为每个 deps 一块独立缓存，测试间不串台 */
  cache?: JevCache
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
    cache: over.cache ?? createJevCache(),
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

describe('启用但方向为空（F-029：FR-013 缺字段 → 待复核，禁止静默放行）', () => {
  test('目标方向为空字符串 → 待复核（missing_field），零请求', async () => {
    const { askJev, calls } = scriptedAsk([])
    const record = recorder()
    const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record, { direction: '' }))

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'missing_field' })
    expect(calls).toEqual([]) // 空方向不组题：零请求，但必须记账——缺字段不是「未启用」
    expect(record.entries.length).toBe(1)
    expect(record.entries[0]!.kind).toBe('missing_field')
  })

  test('目标方向未配置（undefined/null）/纯空白 → 同样待复核（missing_field），零请求', async () => {
    for (const direction of [undefined, null, '   ']) {
      const { askJev, calls } = scriptedAsk([])
      const record = recorder()
      const verdict = await judgeJevDirection(jobOf(), makeDeps(askJev, record, { direction }))
      expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'missing_field' })
      expect(calls).toEqual([])
      expect(record.entries.length).toBe(1)
    }
  })

  test('复判阶段：方向被清空 → 不拿空方向组题问 Jev，同样待复核（missing_field）', async () => {
    const handoff = createJevStageHandoff()
    handoff.markPending('k1')
    const { askJev, calls } = scriptedAsk([])
    const record = recorder()
    const verdict = await judgeJevDirection(
      jobOf({ jobDescription: '负责前端界面开发' }),
      makeDeps(askJev, record, { stage: 'recheck', direction: '', handoff }),
    )

    expect(verdict).toMatchObject({ decision: 'reviewNeeded', kind: 'missing_field' })
    expect(calls).toEqual([])
    expect(record.entries.length).toBe(1)
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
