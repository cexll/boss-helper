import { BossHelperError, LimitError, RateLimitError } from '@/composables/useApplying/deliverError'

export type WorkflowAbortDecision =
  | { abort: false }
  | {
      abort: true
      /** stop: 正常停机（达上限/风控）；error: 意外错误 */
      status: 'stop' | 'error'
      reason: string
    }

/**
 * 判定当前任务异常是否应终止整轮投递。
 * 普通岗位级失败返回 abort:false，由调用方继续下一岗。
 */
export function decideTaskErrorAbort(error: unknown): WorkflowAbortDecision {
  if (error instanceof LimitError) {
    return {
      abort: true,
      status: 'stop',
      reason: error.message || '今日沟通已达平台上限，已停止投递',
    }
  }
  if (error instanceof RateLimitError) {
    return {
      abort: true,
      status: 'stop',
      reason: error.message || '操作过于频繁，已停止投递以避免风控',
    }
  }
  // 预留：其它带 danger 的致命业务错误未来可扩展；默认不中断
  if (error instanceof BossHelperError) {
    return { abort: false }
  }
  return { abort: false }
}

/**
 * 本地投递数量上限：达到后停止，避免继续打接口触发平台限制。
 */
export function decideDeliveryLimitAbort(
  successCount: number,
  deliveryLimit: number,
): WorkflowAbortDecision {
  if (!Number.isFinite(deliveryLimit) || deliveryLimit <= 0) {
    return { abort: false }
  }
  if (successCount >= deliveryLimit) {
    return {
      abort: true,
      status: 'stop',
      reason: `已达到本地投递上限 ${deliveryLimit}，已停止投递`,
    }
  }
  return { abort: false }
}
