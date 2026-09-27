import { describe, expect, test } from 'bun:test'

import { createJevCache, jevCache } from './jevCache'
import type { JevCache } from './jevCache'
import { createJevStageHandoff, judgeJevDirection } from './jevDirection'
import type { JevAskFn, JevDirectionDeps } from './jevDirection'
import type { ReviewNeededReasonKind } from './reviewNeeded'

/**
 * Jev 明确结果缓存（t9 / FR-015 / AC-009）：
 * 键 = 岗位标识 + 判定依据（目标方向 + 会话模型 + 协议修订）；判定依据任一变化即失效。
 * 只缓存明确终判（pass / confirmed-negative）；待复核永不写入（FR-013）。
 * 内存存储、随投递运行（页面会话）生命周期：刷新即清空，无 TTL（orchestrator 口径）。
 */

const DIRECTION = '前端开发'
const MODEL = 'jev-1.13.0'

/** 每个用例一块独立缓存，互不串台（同 makeDeps 的 freshStatistics 口径） */
function freshCache(): ReturnType<typeof createJevCache> {
  return createJevCache()
}

describe('createJevCache：键与失效语义（t9 / FR-015）', () => {
  test('未写入任何明确终判前，get 返回 undefined', () => {
    const cache = freshCache()
    expect(cache.get('k1', DIRECTION)).toBeUndefined()
  })

  test('同岗位同判定依据：set 后 get 命中并原样返回终判', () => {
    const cache = freshCache()
    const pass = { decision: 'pass' as const }
    cache.set('k1', DIRECTION, MODEL, pass)
    expect(cache.get('k1', DIRECTION)).toEqual(pass)
  })

  test('岗位不同 → 未命中', () => {
    const cache = freshCache()
    cache.set('k1', DIRECTION, MODEL, { decision: 'pass' })
    expect(cache.get('k2', DIRECTION)).toBeUndefined()
  })

  test('目标方向变化 → 未命中（判定依据变化即失效，AC-009 后半）', () => {
    const cache = freshCache()
    cache.set('k1', DIRECTION, MODEL, { decision: 'pass' })
    expect(cache.get('k1', '后端开发')).toBeUndefined()
  })

  test('模型版本变化 → 整库失效（p1 §3.2：响应具体版本参与判定依据）', () => {
    const cache = freshCache()
    cache.set('k1', DIRECTION, 'jev-1.13.0', { decision: 'pass' })
    cache.set('k2', DIRECTION, 'jev-1.14.0', { decision: 'skip', reason: 'r' })
    expect(cache.get('k1', DIRECTION)).toBeUndefined() // 旧模型条目全量失效
    expect(cache.get('k2', DIRECTION)).toEqual({ decision: 'skip', reason: 'r' })
  })

  test('模型版本回滚后旧条目不复活（A→B→A：set 已清掉的旧代条目不会回来）', () => {
    const cache = freshCache()
    cache.set('k1', DIRECTION, 'jev-1.13.0', { decision: 'pass' })
    cache.set('k2', DIRECTION, 'jev-1.14.0', { decision: 'pass' }) // 供应商滚动别名
    cache.set('k3', DIRECTION, 'jev-1.13.0', { decision: 'pass' }) // 别名滚回旧版本
    expect(cache.get('k1', DIRECTION)).toBeUndefined() // k1 的旧代条目已随模型变化清除
    expect(cache.get('k3', DIRECTION)).toEqual({ decision: 'pass' })
  })

  test('confirmed-negative（skip）与原因原样缓存', () => {
    const cache = freshCache()
    const skip = {
      decision: 'skip' as const,
      reason: 'Jev 判定岗位与目标方向不相关（标题 noul=0.02）',
    }
    cache.set('k1', DIRECTION, MODEL, skip)
    expect(cache.get('k1', DIRECTION)).toEqual(skip)
  })

  test('同键重复写入：后者覆盖前者', () => {
    const cache = freshCache()
    cache.set('k1', DIRECTION, MODEL, { decision: 'pass' })
    cache.set('k1', DIRECTION, MODEL, { decision: 'skip', reason: '复判不相关' })
    expect(cache.get('k1', DIRECTION)).toEqual({ decision: 'skip', reason: '复判不相关' })
  })

  test('clear 清空全部条目并重置模型指针（页面刷新语义）', () => {
    const cache = freshCache()
    cache.set('k1', DIRECTION, 'jev-1.13.0', { decision: 'pass' })
    cache.clear()
    expect(cache.get('k1', DIRECTION)).toBeUndefined()
    // 清空后模型指针归零：新模型直接写入，不再触发全量失效
    cache.set('k1', DIRECTION, 'jev-2.0.0', { decision: 'pass' })
    expect(cache.get('k1', DIRECTION)).toEqual({ decision: 'pass' })
  })
})

describe('模块级单例 jevCache（随投递运行生命周期）', () => {
  test('单例与工厂实例行为一致：写读命中', () => {
    jevCache.clear()
    jevCache.set('k1', DIRECTION, MODEL, { decision: 'pass' })
    expect(jevCache.get('k1', DIRECTION)).toEqual({ decision: 'pass' })
  })
})

/** 判定结果来自 t9 单验收标准（AC-009）与 p1 实测口径，不走实现重算 */

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

/** 每块 deps 自带一块独立缓存，用例之间不串台 */
function makeDeps(
  askJev: JevAskFn,
  record: ReturnType<typeof recorder>,
  over: Partial<JevDirectionDeps> & { cache?: JevCache; direction?: string } = {},
): JevDirectionDeps {
  return {
    stage: over.stage ?? 'title',
    askJev,
    getTargetDirection: () => over.direction ?? DIRECTION,
    recordReviewNeeded: record.recordReviewNeeded,
    statistics: (over.statistics ?? {}) as JevDirectionDeps['statistics'],
    getToday: () => TODAY,
    getApiKey: over.getApiKey,
    cache: over.cache ?? createJevCache(),
    handoff: over.handoff,
  }
}

const jobOf = (over: { key?: string; jobName?: string; jobDescription?: string } = {}) => ({
  key: over.key ?? 'k1',
  jobName: over.jobName ?? '前端开发工程师',
  jobDescription: over.jobDescription,
})

describe('结果缓存（t9 / FR-015 / AC-009 / VAL-011）', () => {
  test('(a) 同岗位同判定依据第二次扫到：命中缓存，不再请求 Jev', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.97 }])
    const record = recorder()
    const deps = makeDeps(askJev, record, { cache })
    const first = await judgeJevDirection(jobOf(), deps)
    const second = await judgeJevDirection(jobOf(), deps)

    expect(first).toEqual({ decision: 'pass' })
    expect(second).toEqual({ decision: 'pass' }) // 缓存回放与新鲜终判一致（FR-018）
    expect(calls.length).toBe(1) // 第二次零请求（AC-009 前半）
  })

  test('(a2) confirmed-negative 同样命中缓存：零请求、skip 原样回放', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.02 }])
    const record = recorder()
    const deps = makeDeps(askJev, record, { cache })
    const first = await judgeJevDirection(jobOf({ jobName: '数据标注员' }), deps)
    const second = await judgeJevDirection(jobOf({ jobName: '数据标注员' }), deps)

    expect(first.decision).toBe('skip')
    expect(second).toEqual(first)
    expect(calls.length).toBe(1)
  })

  test('(b) 修改目标方向后重新请求 Jev（判定依据变化即失效）', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.97 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.05 },
    ])
    const record = recorder()
    const before = await judgeJevDirection(
      jobOf(),
      makeDeps(askJev, record, { cache, direction: '前端开发' }),
    )
    const after = await judgeJevDirection(
      jobOf(),
      makeDeps(askJev, record, { cache, direction: '算法工程师' }),
    )

    expect(before).toEqual({ decision: 'pass' })
    expect(after.decision).toBe('skip') // 新方向下重新判定
    expect(calls.length).toBe(2) // 方向变化 → 重新请求（AC-009 后半）
  })

  test('(c) 不确定结果不写缓存：同一岗位再次扫到重新请求 Jev（FR-013）', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
    ])
    const record = recorder()
    const deps = makeDeps(askJev, record, { cache })
    const first = await judgeJevDirection(jobOf({ jobName: '全栈工程师' }), deps)
    const second = await judgeJevDirection(jobOf({ jobName: '全栈工程师' }), deps)

    expect(first).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_uncertain' })
    expect(second).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_uncertain' })
    expect(calls.length).toBe(2) // 待复核口径：再次扫到重新判断（AC-008 后半）
  })

  test('(c2) 报错 / 超时同样不写缓存：第二次重新请求（FR-013）', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([
      { status: 'error', reason: '当前上下文无法连接 Jev 服务' },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.97 },
    ])
    const record = recorder()
    const deps = makeDeps(askJev, record, { cache })
    const first = await judgeJevDirection(jobOf(), deps)
    const second = await judgeJevDirection(jobOf(), deps)

    expect(first).toMatchObject({ decision: 'reviewNeeded', kind: 'jev_error' })
    expect(second).toEqual({ decision: 'pass' }) // 重新请求后判明相关
    expect(calls.length).toBe(2)
  })

  test('交接的「继续」不是终判：不写缓存，下一轮标题阶段仍重新请求', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
      { status: 'decided', model: 'jev-1.13.0', noul: 0.25 },
    ])
    const record = recorder()
    const deps = makeDeps(askJev, record, { cache, handoff: createJevStageHandoff() })
    const first = await judgeJevDirection(jobOf({ jobName: '全栈工程师' }), deps)
    const second = await judgeJevDirection(jobOf({ jobName: '全栈工程师' }), deps)

    expect(first).toEqual({ decision: 'pass' }) // markPending 的继续动作，不是明确终判
    expect(second).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(2) // 每轮都要问 Jev
  })

  test('复判的明确终判写缓存：下一轮标题阶段直接命中（判定依据不含阶段）', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([{ status: 'decided', model: 'jev-1.13.0', noul: 0.89 }])
    const record = recorder()
    const pendingHandoff = createJevStageHandoff()
    pendingHandoff.markPending('k1')
    const recheck = await judgeJevDirection(
      jobOf({ jobName: '后端开发工程师', jobDescription: '负责前端界面开发' }),
      makeDeps(askJev, record, { cache, stage: 'recheck', handoff: pendingHandoff }),
    )
    expect(recheck).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1)

    const nextRound = await judgeJevDirection(
      jobOf({ jobName: '后端开发工程师', jobDescription: '负责前端界面开发' }),
      makeDeps(askJev, record, { cache }),
    )
    expect(nextRound).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(1) // 第二轮标题阶段零请求（AC-009 端到端）
  })

  test('模型标识参与判定依据：会话内观测到模型版本变化 → 旧缓存整库失效（p1 §3.2）', async () => {
    const cache = createJevCache()
    const { askJev, calls } = scriptedAsk([
      { status: 'decided', model: 'jev-1.13.0', noul: 0.97 }, // 岗位 a 在旧模型下判相关
      { status: 'decided', model: 'jev-1.14.0', noul: 0.97 }, // 供应商滚动别名后的新响应
      { status: 'decided', model: 'jev-1.14.0', noul: 0.97 }, // 旧模型的缓存已失效 → 重新请求
    ])
    const record = recorder()
    const deps = makeDeps(askJev, record, { cache })
    const firstA = await judgeJevDirection(jobOf({ key: 'a' }), deps)
    const firstB = await judgeJevDirection(jobOf({ key: 'b' }), deps)
    const secondA = await judgeJevDirection(jobOf({ key: 'a' }), deps)

    expect(firstA).toEqual({ decision: 'pass' })
    expect(firstB).toEqual({ decision: 'pass' })
    expect(secondA).toEqual({ decision: 'pass' })
    expect(calls.length).toBe(3) // 岗位 a 的旧模型缓存不再命中
  })
})
