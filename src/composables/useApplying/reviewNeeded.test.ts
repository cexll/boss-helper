import { beforeEach, expect, test } from 'bun:test'

import type { Statistics } from '@/types/formData'

import { createReviewNeededStore, reviewNeededStore, recordReviewNeeded } from './reviewNeeded'
import type { ReviewNeededEntry, ReviewNeededReasonKind } from './reviewNeeded'

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
/** 当前版本的统计对象结构（含可选的新计数字段） */
function freshCounter(): {
  date: string
  success: number
  total: number
  repeat: number
  activityFilter: number
  tasks: Record<string, never>
  reviewNeeded?: number
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
