/**
 * 待复核处置（review-needed）：Jev 报错/超时/不确定，或启用筛选所需字段缺失时的岗位处置结果。
 *
 * 与流水线步骤结果 done / skip / abort 分开建模（spec 约束 84 行）：
 * - 当次不投递；
 * - 不记为排除、不写入任何排除/结果缓存（sameCompany / sameHr 集合、pipeline cache 均不触碰）；
 * - 只在当前页面内存活，刷新即清空；
 * - 再次扫到该岗位时重新判断（不在列表中即可重新进入）。
 *
 * 本模块是纯状态实现，不依赖 Vue / DOM / 存储 / 日志，可在 bun test 下逐条验证上述不变量。
 * t10（重试 / 跳过 / 人工确认方向）在不改变条目结构的前提下扩展动作。
 */

/** 进入待复核的原因分类；仅用于展示与后续动作分流，不参与缓存键。 */
export type ReviewNeededReasonKind = 'jev_error' | 'jev_timeout' | 'jev_uncertain' | 'missing_field'

export interface ReviewNeededEntry {
  /** 岗位唯一标识（jobData.key） */
  key: string
  /** 岗位名称，列表展示用 */
  jobName: string
  /** 进入待复核的原因，列表展示用 */
  reason: string
  /** 原因分类 */
  kind: ReviewNeededReasonKind
  /** 记录时间戳（毫秒），仅用于展示排序 */
  at: number
}

/** add / recordReviewNeeded 的入参：`at` 由 store 填充，调用方不需要构造完整条目。 */
type ReviewNeededInput = Omit<ReviewNeededEntry, 'at'>

/** 当日去重桶：日期键 + 当日已计数的岗位 key 集合。 */
export interface ReviewNeededDayBucket {
  /** YYYY-MM-DD（本地时区，与 getCurDay() 同口径） */
  date: string
  countedKeys: string[]
}

/**
 * 待复核计数宿主：真实的统计对象（src/types/formData.ts 的 Statistics）。
 * 旧版本统计对象没有 reviewNeeded / reviewNeededCounted 字段，因此均为可选
 * （缺省按 0 起算 / 空集起算，见 recordReviewNeeded）；与 object 求交让任意既有
 * 统计对象（含类型文件中没有这些字段的旧结构）都能直接传入。
 */
export type ReviewNeededCounter = object & {
  reviewNeeded?: number
  /** 当日去重桶：挂在统计对象上，随统计对象一起落盘，因此跨页面/刷新保持。 */
  reviewNeededCounted?: ReviewNeededDayBucket
}

/** recordReviewNeeded 的可注入项。 */
export interface RecordReviewNeededOptions {
  /**
   * 当日日期键，调用方传 getCurDay() 口径的 YYYY-MM-DD。
   * 提供后启用当日按岗位去重：同一岗位当日只计一次；
   * 缺省时保持 t6 的页面内语义（计数跟随页面内首次记录）。
   */
  today?: string
}

type ReviewNeededListener = (entries: ReviewNeededEntry[]) => void

export interface ReviewNeededStore {
  /**
   * 记录一个待复核岗位。
   * 已在列表中的岗位不再重复添加（返回 false），同一页面内不重复计数。
   */
  add: (input: ReviewNeededInput) => boolean
  has: (key: string) => boolean
  get: (key: string) => ReviewNeededEntry | undefined
  /** 当前页面的待复核列表快照（按加入顺序）。 */
  list: () => ReviewNeededEntry[]
  /** 当前页面的待复核数量。 */
  count: () => number
  /** 移除一个岗位（重试、跳过或人工确认后调用）；不存在时返回 false。 */
  remove: (key: string) => boolean
  /** 清空列表：页面刷新等价于新建一个 store。 */
  clear: () => void
  /** 列表变化订阅：供页面 UI 刷新。返回取消订阅函数。 */
  subscribe: (listener: ReviewNeededListener) => () => void
}

export function createReviewNeededStore(): ReviewNeededStore {
  const entries = new Map<string, ReviewNeededEntry>()
  const listeners = new Set<ReviewNeededListener>()

  const notify = () => {
    const snapshot = list()
    listeners.forEach((l) => l(snapshot))
  }

  function list(): ReviewNeededEntry[] {
    return [...entries.values()]
  }

  return {
    add(input) {
      if (entries.has(input.key)) return false
      entries.set(input.key, { ...input, at: Date.now() })
      notify()
      return true
    },
    has(key) {
      return entries.has(key)
    },
    get(key) {
      return entries.get(key)
    },
    list,
    count() {
      return entries.size
    },
    remove(key) {
      const removed = entries.delete(key)
      if (removed) notify()
      return removed
    },
    clear() {
      entries.clear()
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * 处理器侧的待复核入口（t3 字段缺失 / t8 Jev 报错超时不确定 在返回 skip 前调用）：
 *
 * - 记录到当前页面列表（同一岗位不重复记录，刷新即清空——t6 语义不变）；
 * - 统计待复核计数 +1：options.today 提供时按岗位当日去重，同岗位当日仅首次 +1；
 *   缺省时保持 t6 语义（页面内首次记录 +1）；
 * - 当次投递已由调用方的 skip 结果阻止，本函数只记账，不投递、不写任何排除缓存；
 * - 计数与当日去重集合都写在传入的统计对象上，随 todayData 一起落盘，刷新后沿用。
 *
 * @returns 是否为本次页面内首次记录该岗位
 */
export function recordReviewNeeded(
  jobData: { key: string; jobName: string },
  reason: string,
  kind: ReviewNeededReasonKind,
  statistics: ReviewNeededCounter,
  options: RecordReviewNeededOptions = {},
): boolean {
  const added = reviewNeededStore.add({
    key: jobData.key,
    jobName: jobData.jobName,
    reason,
    kind,
  })
  let bucket: ReviewNeededDayBucket | undefined
  if (options.today) {
    const stored = statistics.reviewNeededCounted
    if (stored && stored.date === options.today) {
      bucket = stored
    } else {
      // 跨日：计数与去重集合一起重置，旧日计数不跨午夜继承。
      // stored 缺省（旧统计对象）时不清零，避免丢弃当日已累计的持久化计数。
      if (stored) statistics.reviewNeeded = 0
      bucket = { date: options.today, countedKeys: [] }
      statistics.reviewNeededCounted = bucket
    }
  }
  if (bucket) {
    if (!bucket.countedKeys.includes(jobData.key)) {
      bucket.countedKeys.push(jobData.key)
      statistics.reviewNeeded = (statistics.reviewNeeded ?? 0) + 1
    }
  } else if (added) {
    // 无日期键：t6 页面内语义
    statistics.reviewNeeded = (statistics.reviewNeeded ?? 0) + 1
  }
  return added
}

/**
 * 当前页面的待复核列表。模块级单例：随内容脚本 / 页面存活，刷新后进程重建即为空。
 * 永不持久化，因此不存在跨页面残留，也不与任何排除缓存产生交集。
 */
export const reviewNeededStore = createReviewNeededStore()
