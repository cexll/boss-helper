/**
 * 后台节流提示（t11 / FR-020 / AC-013 / VAL-013）。
 *
 * 判定条件来自 p2 实测记录 §5（docs/probes/throttle-p2-record.md），单一来源：
 * - 常态：`delay()` 实测只比请求值多 ≤ 1 秒（实测 3/5/10 那一档）；
 * - 被节流：Chrome 的 intensive throttling 把后台计时唤醒压到约每分钟一次，
 *   单次 `delay()` 被钳制到 60 秒量级，实测中最小超时也有 7.8 秒。
 * 两侧余量充足，因此用「连续 2 次」而不是时间阈值区分常态抖动与真实节流
 * （强化节流的起始点无法用单次计时定位，见 §7 局限）。
 *
 * 本模块只**如实提示**：不缩短任何间隔、不提高并发、不提供加速选项、
 * 不用 setInterval 轮询探测、不引入 Web Worker / AudioContext / chrome.alarms
 * 等绕过节流的计时通道（那属于变相加速，违反 FR-021 与 AC-013）。
 * 提示出现后也绝不改变流水线节奏——只是把浏览器已经造成的变慢告诉用户。
 *
 * 纯逻辑 + 注入依赖：不依赖 Vue / DOM / 存储 / 日志，可在 bun test 下逐条验证。
 */

/** 页面可见性取值；与 `document.visibilityState` 同口径，非 'visible' 一律算后台。 */
export type VisibilityState = 'visible' | 'hidden' | 'prerender' | 'unloaded'

/** 同时满足两者才算提示：页面不可见 且 连续多次计时被显著拉长。 */
export type ThrottleHintDecision = 'hidden' | 'throttled'

/** 触发提示所需的**连续**被节流次数：p2 §5 定为 2（避免把切换瞬间的抖动当成节流）。 */
export const THROTTLE_CONSECUTIVE_THRESHOLD = 2

/**
 * 单次 `delay()` 是否被显著拉长（p2 §5）：
 * `actual >= max(2 × requested, requested + 10)`。
 * `requested` 非正或非有限（关闭延迟等配置）时永不判定为节流——阈值失义时宁可沉默。
 */
export function isThrottledDelay(requested: number, actual: number): boolean {
  if (!Number.isFinite(requested) || requested <= 0) return false
  if (!Number.isFinite(actual)) return false
  return actual >= Math.max(2 * requested, requested + 10)
}

/** 提示的展示口径（p2 §5 文案要点）：如实说明变慢与任务仍在继续，不含任何加速选项。 */
export function decideThrottleHint(state: {
  visibility: VisibilityState
  consecutiveThrottled: number
}): ThrottleHintDecision {
  if (state.visibility === 'visible') return 'hidden'
  return state.consecutiveThrottled >= THROTTLE_CONSECUTIVE_THRESHOLD ? 'throttled' : 'hidden'
}

/**
 * 清除条件（p2 §5）：页面重新可见 **且** 下一次 `delay()` 恢复常态
 * （`actual < requested + 3`）。仍不可见时即使计时恢复也不清除——
 * 用户没在看页面，此时收回提示反而会掩盖后续再次变慢的事实。
 */
export function shouldClearThrottleHint(
  visibility: VisibilityState,
  requested: number,
  actual: number,
): boolean {
  return visibility === 'visible' && actual < requested + 3
}

/**
 * 提示正文：只说事实与后果，**不提供**「忽略节流继续加速」之类的选项，
 * 也不承诺任何加速手段（FR-021 / AC-013）。
 */
export const BACKGROUND_THROTTLE_HINT =
  '浏览器已限制后台页面的计时：投递间隔被显著拉长（实测每次等待可达约 60 秒），任务仍在继续。把本页面切回前台即可恢复正常节奏。'

/** store 的注入面：可见性与单调时钟都由调用方提供，便于在测试中驱动。 */
export interface BackgroundThrottleDeps {
  /** 当前页面可见性；缺省读取 `document.visibilityState`（非浏览器环境视为 visible）。 */
  visibility?: () => VisibilityState
  /** 单调时钟（毫秒）；缺省 `performance.now()`，同源用于测量单次 delay 的墙钟耗时。 */
  now?: () => number
}

/** `begin(requested)` 的返回值：拿到该次 delay 的实际耗时后交给 `end`。 */
export type DelayTimer = (actual: number) => { requested: number; actual: number }

export interface BackgroundThrottleStore {
  /** 开始观察一次 `delay(requested)`；返回一个精确配对的测量收尾器（不会串到别次计时）。 */
  begin: (requested: number) => DelayTimer
  /**
   * 反馈一次 `delay()` 的实测耗时，返回反馈后的提示文案（无提示时为 undefined）。
   * 调用方把它渲染到界面上即可；提示状态变化时通知订阅者。
   */
  end: (sample: { requested: number; actual: number }) => string | undefined
  /** 当前提示文案；无提示为 undefined。 */
  hint: () => string | undefined
  /** hint() 的别名，与 reviewNeeded 的 list()/count() 读法保持一致。 */
  copy: () => string | undefined
  /** 当前连续被节流次数（诊断用；与提示是否展示无关的部分也可读）。 */
  count: () => number
  /** 提示状态订阅：只在提示出现/清除时通知，返回取消订阅函数。 */
  subscribe: (listener: (hint: string | undefined) => void) => () => void
  /** 手动清除提示与计数（提示被用户关闭等场景）。 */
  clear: () => void
}

function defaultVisibility(): VisibilityState {
  if (typeof document === 'undefined') return 'visible'
  const state = document.visibilityState
  if (state === 'visible' || state === 'hidden' || state === 'prerender' || state === 'unloaded') {
    return state
  }
  // 未知取值按不可见处理：宁可沉默（判定还要配合计时比值），也不假装在执行
  return 'hidden'
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export function createBackgroundThrottleStore(
  deps: BackgroundThrottleDeps = {},
): BackgroundThrottleStore {
  const visibility = deps.visibility ?? defaultVisibility
  const now = deps.now ?? defaultNow

  let hint: string | undefined
  let consecutiveThrottled = 0
  const listeners = new Set<(hint: string | undefined) => void>()

  const setHint = (next: string | undefined) => {
    if (next === hint) return
    hint = next
    // 只在提示状态真的变化时通知（与 reviewNeeded 的 notify 同口径）
    listeners.forEach((listener) => listener(next))
  }

  const begin = (requested: number): DelayTimer => {
    const startedAt = now()
    return (actual?: number) => ({
      requested,
      actual: actual ?? (now() - startedAt) / 1000,
    })
  }

  /**
   * 反馈一次 delay 的实测耗时。返回反馈之后的提示文案。
   * 顺序即 §5 的语义：先看能否清除（可见且恢复常态），再看是否新触发。
   */
  const end = (sample: { requested: number; actual: number }): string | undefined => {
    const view = visibility()

    // 恢复：可见且下一次计时已回到常态 —— 立即清除并通知
    if (hint !== undefined && shouldClearThrottleHint(view, sample.requested, sample.actual)) {
      consecutiveThrottled = 0
      setHint(undefined)
      return undefined
    }

    const throttled = isThrottledDelay(sample.requested, sample.actual)

    // 可见且已恢复到常态（actual < requested + 3）却仍在提示中：
    // 说明是「可见但被拉长」的残留提示，同样要清除（与上一分支合起来覆盖 §5 的恢复条件）。
    if (hint !== undefined && view === 'visible' && !throttled) {
      consecutiveThrottled = 0
      setHint(undefined)
      return undefined
    }

    // 可见但计时仍未恢复（actual >= requested + 3）：保留提示，让节奏自行收敛。
    if (hint !== undefined && view === 'visible') {
      consecutiveThrottled += 1
      return hint
    }

    if (view === 'visible' || !throttled) {
      consecutiveThrottled = 0
      return hint
    }

    consecutiveThrottled += 1
    if (decideThrottleHint({ visibility: view, consecutiveThrottled }) === 'throttled') {
      setHint(BACKGROUND_THROTTLE_HINT)
    }
    return hint
  }

  return {
    begin,
    end,
    hint: () => hint,
    copy: () => hint,
    count: () => consecutiveThrottled,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clear() {
      consecutiveThrottled = 0
      setHint(undefined)
    },
  }
}

/**
 * 当前页面的节流提示单例：随内容脚本 / 页面存活，刷新后进程重建即为空。
 * 与 reviewNeeded 同构——页面内内存态，永不持久化。
 */
export const backgroundThrottleStore = createBackgroundThrottleStore()
