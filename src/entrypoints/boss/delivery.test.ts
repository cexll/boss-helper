import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { createJevCache } from '@/composables/useApplying/jevCache';
import type { JevCache } from '@/composables/useApplying/jevCache';
import { judgeJevDirection } from '@/composables/useApplying/jevDirection';
import type { JevDirectionJob } from '@/composables/useApplying/jevDirection';
import { JEV_API_KEY_STORAGE_KEY, JEV_ASK_MESSAGE } from '@/utils/jev'

/**
 * F-028：流水线 Jev 调用（delivery.ts 的 askJev）必须「页面直连优先，
 * 传输/跨域失败时经 content script 中继转扩展后台」。
 *
 * seam：真实 delivery.askJev + 假 @/message counter（storageGet / askJevBackground），
 * 直连路径用全局 fetch 注入 TypeError（模拟 p1 §2.1 的 CORS preflight 失败），
 * 结果经 judgeJevDirection（流水线的真实消费方）断言是 consumed 而非丢弃。
 */

const stubLog: Record<string, unknown> = {}
stubLog.debug = () => {}
stubLog.info = () => {}
stubLog.warn = () => {}
stubLog.error = () => {}
stubLog.withContext = () => stubLog

void mock.module('@/utils/logger', () => ({ logger: stubLog }))
void mock.module('@/composables/usePipelineCache', () => ({
  PipelineCacheManager: class {},
}))

void mock.module('./requests', () => ({
  sameCompanyKey: 'local:sameCompany',
  sameHrKey: 'local:sameHr',
  getBossData: async () => ({}),
  sendPublishReq: async () => ({ status: 'success' }),
}))

const storageMap: Record<string, unknown> = { [JEV_API_KEY_STORAGE_KEY]: 'k-page' }
let backgroundCalls = 0
let backgroundReply: unknown = { status: 'decided', model: 'jev-1.13.0', noul: 0.9 }
const sentMessages: Array<Record<string, unknown>> = []
const failingFetch = (async () => {
  throw new TypeError('Failed to fetch')
}) as unknown as typeof globalThis.fetch

void mock.module('@/message', () => ({
  counter: {
    storageGet: async (key: string) => storageMap[key] ?? null,
    askJevBackground: async (message: Record<string, unknown>) => {
      backgroundCalls += 1
      sentMessages.push(message)
      return backgroundReply
    },
  },
}))

const { askJev, bossWorkflow } = await import('./delivery')

const job: JevDirectionJob = {
  key: 'job-1',
  jobName: '前端开发工程师',
  jobDescription: '负责后台管理界面开发。',
}
const DIRECTION = '前端开发'
const TODAY = '2026-09-26'

beforeEach(() => {
  backgroundCalls = 0
  sentMessages.length = 0
  backgroundReply = { status: 'decided', model: 'jev-1.13.0', noul: 0.9 }
  globalThis.fetch = failingFetch
})

afterEach(() => {
  globalThis.fetch = failingFetch
})

function directionDeps(over: { cache?: JevCache; statistics?: unknown } = {}) {
  const recorded: Array<{ reason: string; kind: string }> = []
  return {
    deps: {
      stage: 'title' as const,
      askJev,
      getTargetDirection: () => DIRECTION,
      recordReviewNeeded: (_jobData: unknown, reason: string, kind: string): boolean => {
        recorded.push({ reason, kind })
        return true
      },
      statistics: (over.statistics ?? {}) as never,
      getToday: () => TODAY,
      cache: over.cache ?? createJevCache(),
    },
    recorded,
  }
}

test('F-028：页面直连失败（跨域/传输）时后台转发恰好一次，decided 结果被流水线消费', async () => {
  const { deps, recorded } = directionDeps()

  const decision = await judgeJevDirection(job, deps)

  expect(backgroundCalls).toBe(1)
  expect(Object.keys(sentMessages[0]!).sort()).toEqual(['payload', 'type'])
  expect(sentMessages[0]!.type).toBe(JEV_ASK_MESSAGE)
  expect(decision).toEqual({ decision: 'pass' })
  expect(recorded).toHaveLength(0)
})

test('F-028：转给后台的消息只含标题/描述载荷，不带端点与密钥', async () => {
  const { deps } = directionDeps()

  await judgeJevDirection(job, deps)

  const wire = JSON.stringify(sentMessages[0])
  expect(wire).not.toContain('Bearer')
  expect(wire).not.toContain('k-page')
  expect(wire).not.toContain('https://api.typesafe.ai')
  expect(wire).not.toContain('Authorization')
})

test('F-028：页面直连成功时零后台调用（行为不变，直连优先）', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ model: 'jev-1.13.0', answers: { direction: { type: 'noul', noul: 0.9 } } }),
  })) as unknown as typeof globalThis.fetch
  const { deps, recorded } = directionDeps()

  const decision = await judgeJevDirection(job, deps)

  expect(backgroundCalls).toBe(0)
  expect(decision).toEqual({ decision: 'pass' })
  expect(recorded).toHaveLength(0)
})

test('F-028：直连与后台都不可达 → 待复核 jev_error（fail-closed，不放行不排除）', async () => {
  backgroundReply = undefined
  const { deps, recorded } = directionDeps()

  const decision = await judgeJevDirection(job, deps)

  expect(backgroundCalls).toBe(1)
  expect(decision.decision).toBe('reviewNeeded')
  expect(recorded).toHaveLength(1)
  expect(recorded[0]!.kind).toBe('jev_error')
  expect(recorded[0]!.reason).toContain('无法连接')
})

test('F-028：后台 error outcome 原样消费为待复核 jev_error，不吞原因', async () => {
  backgroundReply = { status: 'error', reason: '后台处理 Jev 请求失败' }
  const { deps, recorded } = directionDeps()

  const decision = await judgeJevDirection(job, deps)

  expect(decision.decision).toBe('reviewNeeded')
  expect(recorded[0]!.kind).toBe('jev_error')
  expect(recorded[0]!.reason).toBe('后台处理 Jev 请求失败')
})
/**
 * F-028 端到端：真实的 bossWorkflow（jevDirection 任务消费 delivery.askJev）在
 * 页面直连不可达时经后台转发完成判定（jev enable、方向明确 pass → 走到投递步骤）。
 * 运行环境只补 auto-import 的 delay/notification 与最小 helper ctx。
 */
type DelayFn = (s: number, isStopped?: () => boolean) => Promise<void>
const realDelay = (globalThis as { delay?: DelayFn }).delay
const realNotification = (globalThis as { notification?: unknown }).notification

test('F-028：流水线端到端——直连失败后台转发成功 → 投递任务执行、结果成功', async () => {
  ;(globalThis as { computed?: unknown }).computed = (await import('vue')).computed
  ;(globalThis as { logger?: unknown }).logger = stubLog
  ;(globalThis as { jsonClone?: unknown }).jsonClone = (await import('@/utils/deepmerge')).jsonClone
  ;(globalThis as { delay?: DelayFn }).delay = (async () => {}) as never
  ;(globalThis as { notification?: unknown }).notification = async () => {}

  const formData = new Proxy(
    {
      jev: { enable: true, targetDirection: '前端开发' },
      bossGoldMedalHr: { value: false },
      delayDeliveryStarts: 0,
      delayDeliveryInterval: 0,
      delayDeliveryPageNext: 0,
      deliveryLimit: { value: 10 },
    } as Record<string, unknown>,
    {
      get(target, key: string) {
        // 未列出的开关一律按「未启用」处理：流水线非 Jev 步骤全部空转
        return key in target ? target[key] : { value: false, enable: false }
      },
    },
  )
  const helper = {
    uid: 'u-1',
    conf: { formData },
    jobList: {
      value: [
        {
          key: 'job-1',
          jobName: '前端开发工程师',
          positionName: '前端开发工程师',
          jobDescription: '负责后台管理界面开发。',
        },
      ],
    },
    jobResultMaps: new Map(),
    jobMaps: new Map(),
    currentJob: { value: '' },
    statistics: { todayData: { value: { total: 0, success: 0, repeat: 0, tasks: {} } } },
    onJobCardClick: async () => {},
    loadMoreJob: async () => false,
    notification: async () => {},
    log: stubLog,
  } as never

  globalThis.fetch = failingFetch
  const run = await bossWorkflow(helper)
  await run.executeAll(
    new Map([
      ['job-1', { jobitem: { securityId: 's', encryptJobId: 'e' }, detail: {}, boss: {} }],
    ]) as never,
  )

  const result = run.ctx.jobResultMaps.get('job-1')
  expect(backgroundCalls).toBe(1)
  expect(sentMessages[0]!.type).toBe(JEV_ASK_MESSAGE)
  expect(result?.status).toBe('success')

  ;(globalThis as { delay?: DelayFn }).delay = realDelay
  ;(globalThis as { notification?: unknown }).notification = realNotification
})
