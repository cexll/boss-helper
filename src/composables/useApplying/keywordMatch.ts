/**
 * 岗位名 / 工作内容关键词判定的纯函数模块。
 *
 * 逐字刻画自 handles.ts 迁移前的既有行为（t3 语义迁移的 oracle）：
 * - 岗位名：小写包含匹配，无空关键词保护；
 * - 工作内容：正则匹配，带否定词回溯 `(?<!(不|无).{0,5})` 与后缀屏蔽表 `(?!系统|软件|工具|服务)`，
 *   跳过空关键词，文本 null 保护在正则构造之后。
 * 本模块不依赖 Vue/组合式上下文，也不读取全局配置；调用方（处理器）负责把判定
 * 结果翻译成原有的流水线 skip 文案。
 */

export type KeywordMatchConfig = {
  include: boolean
  value: string[]
}

export type KeywordMatchDecision =
  | { skip: false }
  | { skip: true; reason: 'missing' }
  | { skip: true; reason: 'excluded'; keyword: string }

/**
 * 岗位名判定：text 由调用方预先小写（现状），关键词小写后做子串包含。
 * 包含模式下首个命中即放行；排除模式下首个命中即排除；
 * 包含模式全程无命中则缺少关键词。
 */
export function decideJobTitleKeyword(
  text: string,
  config: KeywordMatchConfig,
): KeywordMatchDecision {
  for (const x of config.value) {
    if (text.includes(x.toLowerCase())) {
      if (config.include) {
        return { skip: false }
      }
      return { skip: true, reason: 'excluded', keyword: x }
    }
  }
  if (config.include) {
    return { skip: true, reason: 'missing' }
  }
  return { skip: false }
}

/**
 * 工作内容判定：跳过空关键词；正则带否定词回溯与后缀屏蔽表。
 * 正则在文本空值保护之前构造（非法正则关键词会抛错，行为同现状）。
 */
export function decideJobContentKeyword(
  content: string | null | undefined,
  config: KeywordMatchConfig,
): KeywordMatchDecision {
  for (const x of config.value) {
    if (!x) {
      continue
    }
    const re = new RegExp(`(?<!(不|无).{0,5})${x.toLowerCase()}(?!系统|软件|工具|服务)`)
    if (content != null && re.test(content)) {
      if (config.include) {
        return { skip: false }
      }
      return { skip: true, reason: 'excluded', keyword: x }
    }
  }
  if (config.include) {
    return { skip: true, reason: 'missing' }
  }
  return { skip: false }
}
