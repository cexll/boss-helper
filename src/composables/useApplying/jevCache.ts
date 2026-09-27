/**
 * Jev 明确结果缓存（t9）：按「岗位 + 判定依据」缓存 Jev 的明确终判，判定依据变化即失效。
 *
 * 判定依据（t9 单 / spec FR-015 / p1 §6.3）：目标岗位方向描述 + 所用 Jev 模型标识。
 * - 只缓存明确终判：pass（noul ≥ high）与 confirmed-negative（noul ≤ low）；
 *   待复核（不确定 / 超时 / 报错）永不写入（FR-013 / AC-008：再次扫到重新判断）。
 * - 模型标识取响应返回的具体版本（p1 §3.2：如 jev-1.13.0，而非请求别名 jev-latest）：
 *   会话中观测到模型版本变化 → 整库失效（任一变化即失效；防供应商滚动别名后沿用旧判定）。
 * - 目标方向变化 → 键不同 → 自然失效；JEV_CACHE_PROTOCOL 是判定口径修订位
 *   （判定带 JEV_UNCERTAIN_BAND / 问题协议变化时 +1，整库失效）。
 * - 存储为模块级内存 Map：仓库没有 Jev 结果持久化通道（t5 只持久化密钥，
 *   t8 交接是内存 Set），故缓存生命周期 = 一次投递运行（内容脚本会话）。
 *   刷新页面即进程重建 → 缓存自然清空（与待复核列表同生命周期）；会话内不过期，无 TTL。
 */

import type { JevDirectionDecision } from './jevDirection'

/** 缓存里只允许明确的终判；待复核结果永不写入（FR-013） */
export type JevCachedDecision =
  | Extract<JevDirectionDecision, { decision: 'pass' }>
  | Extract<JevDirectionDecision, { decision: 'skip' }>

/** 判定口径修订位：判定带或问题协议变化时 +1，整库失效 */
const JEV_CACHE_PROTOCOL = 1

export interface JevCache {
  /** 按「岗位 + 目标方向 + 会话模型」命中时返回缓存的明确终判，否则 undefined */
  get(jobKey: string, targetDirection: string): JevCachedDecision | undefined
  /** 写入一条明确终判；模型标识来自 Jev 响应，模型版本变化时整库失效 */
  set(jobKey: string, targetDirection: string, model: string, decision: JevCachedDecision): void
  /** 清空整库并重置模型指针（页面刷新语义；测试隔离） */
  clear(): void
}

export function createJevCache(): JevCache {
  const entries = new Map<string, JevCachedDecision>()
  /** 最近一次响应观测到的具体模型版本；null = 会话内尚未收到任何明确响应 */
  let activeModel: string | null = null

  const keyOf = (jobKey: string, targetDirection: string, model: string): string =>
    `${JEV_CACHE_PROTOCOL}\u0000${model}\u0000${jobKey}\u0000${targetDirection}`

  return {
    get(jobKey, targetDirection) {
      if (activeModel === null) return undefined
      return entries.get(keyOf(jobKey, targetDirection, activeModel))
    },
    set(jobKey, targetDirection, model, decision) {
      if (activeModel !== null && activeModel !== model) {
        entries.clear()
      }
      activeModel = model
      entries.set(keyOf(jobKey, targetDirection, model), decision)
    },
    clear() {
      entries.clear()
      activeModel = null
    },
  }
}

/** 页面会话级单例：随内容脚本存活，刷新即重建（同 reviewNeededStore / jevHandoff 生命周期） */
export const jevCache = createJevCache()
