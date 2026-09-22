import { expect, test } from 'bun:test'

import { decideDeliveryLimitAbort, decideTaskErrorAbort } from './abortPolicy'
import { LimitError, PublishError, RateLimitError } from './deliverError'

/**
 * 模拟 executeAll 对单岗结果的停机决策（不拉 Vue/DOM）。
 * 覆盖：致命错误立刻停；普通错误继续；本地上限岗前/岗后停。
 */
function simulateBatch(jobs: Array<{ ok?: boolean; error?: unknown }>, deliveryLimit: number) {
  let success = 0
  let processed = 0
  let stopReason: string | null = null

  for (const job of jobs) {
    const before = decideDeliveryLimitAbort(success, deliveryLimit)
    if (before.abort) {
      stopReason = before.reason
      break
    }

    processed += 1
    if (job.error) {
      const decision = decideTaskErrorAbort(job.error)
      if (decision.abort) {
        stopReason = decision.reason
        break
      }
      continue
    }

    if (job.ok) {
      success += 1
      const after = decideDeliveryLimitAbort(success, deliveryLimit)
      if (after.abort) {
        stopReason = after.reason
        break
      }
    }
  }

  return { success, processed, stopReason }
}

test('150 limit error stops batch immediately and skips remaining jobs', () => {
  const result = simulateBatch(
    [
      { ok: true },
      { error: new LimitError('您今天已与150位BOSS沟通') },
      { ok: true },
      { ok: true },
    ],
    200,
  )
  expect(result.success).toBe(1)
  expect(result.processed).toBe(2)
  expect(result.stopReason).toContain('150')
})

test('rate limit stops batch immediately', () => {
  const result = simulateBatch(
    [{ ok: true }, { error: new RateLimitError('操作过于频繁') }, { ok: true }],
    200,
  )
  expect(result.success).toBe(1)
  expect(result.processed).toBe(2)
  expect(result.stopReason).toContain('频繁')
})

test('ordinary publish error continues to next jobs', () => {
  const result = simulateBatch(
    [{ error: new PublishError('岗位已下线') }, { ok: true }, { ok: true }],
    200,
  )
  expect(result.success).toBe(2)
  expect(result.processed).toBe(3)
  expect(result.stopReason).toBeNull()
})

test('local deliveryLimit stops after reaching cap', () => {
  const result = simulateBatch([{ ok: true }, { ok: true }, { ok: true }, { ok: true }], 2)
  expect(result.success).toBe(2)
  expect(result.processed).toBe(2)
  expect(result.stopReason).toContain('本地投递上限')
})
