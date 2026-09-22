import { expect, test } from 'bun:test'

import { decideDeliveryLimitAbort, decideTaskErrorAbort } from './abortPolicy'
import { LimitError, PublishError, RateLimitError } from './deliverError'

test('LimitError aborts whole workflow as stop', () => {
  const decision = decideTaskErrorAbort(new LimitError('您今天已与150位BOSS沟通'))
  expect(decision).toEqual({
    abort: true,
    status: 'stop',
    reason: '您今天已与150位BOSS沟通',
  })
})

test('RateLimitError aborts whole workflow as stop', () => {
  const decision = decideTaskErrorAbort(new RateLimitError('操作过于频繁'))
  expect(decision).toEqual({
    abort: true,
    status: 'stop',
    reason: '操作过于频繁',
  })
})

test('ordinary PublishError does not abort whole workflow', () => {
  const decision = decideTaskErrorAbort(new PublishError('岗位已下线'))
  expect(decision).toEqual({ abort: false })
})

test('unknown non-business error does not abort whole workflow', () => {
  const decision = decideTaskErrorAbort(new Error('network glitch'))
  expect(decision).toEqual({ abort: false })
})

test('delivery limit reached aborts workflow as stop', () => {
  expect(decideDeliveryLimitAbort(120, 120)).toEqual({
    abort: true,
    status: 'stop',
    reason: '已达到本地投递上限 120，已停止投递',
  })
  expect(decideDeliveryLimitAbort(121, 120).abort).toBe(true)
})

test('delivery limit not reached continues', () => {
  expect(decideDeliveryLimitAbort(119, 120)).toEqual({ abort: false })
  expect(decideDeliveryLimitAbort(0, 120)).toEqual({ abort: false })
})

test('invalid delivery limit never aborts', () => {
  expect(decideDeliveryLimitAbort(10, 0)).toEqual({ abort: false })
  expect(decideDeliveryLimitAbort(10, -1)).toEqual({ abort: false })
})
