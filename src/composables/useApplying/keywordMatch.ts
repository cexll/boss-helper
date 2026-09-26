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

export type KeywordRule = {
  includeWords: string[]
  excludeWords: string[]
  /** any：包含词命中任一即过；all：包含词需全部命中（运行时缺省按 any，对应旧配置迁移默认）。 */
  includeMode: 'any' | 'all'
}

const TOKEN_CHAR = /[a-z0-9+#.]/
const NON_TOKEN = /[^a-z0-9+#.]/
const DIGITS = /^\d+$/

/**
 * t1 新关键词引擎的 token 化：英文技术名词的完整词边界由 `[a-z0-9+#.]` 连写段决定，
 * '+' '#' '.' 与字符同属一个 token，因此 `C++`、`C#`、`.NET`、`asp.net` 各为完整名称，
 * 段末的点（"Java."）不算 token 内容。
 */
function tokensOf(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    if (TOKEN_CHAR.test(ch)) {
      cur += ch
    } else {
      if (cur) {
        out.push(cur.replace(/\.+$/, ''))
      }
      cur = ''
    }
  }
  if (cur) {
    out.push(cur.replace(/\.+$/, ''))
  }
  return out
}

/**
 * 单关键词匹配（全部固定字面量，用户输入不进正则）：
 * - 英文词 = 完整词匹配，忽略大小写；词后紧跟数字段视为版本号仍算命中，
 *   紧跟字母则属于另一个词不命中；
 * - 其余（中文、混合中英、带 '/'- 等非 token 字符的词）= 忽略大小写的子串包含。
 */
function matchesWord(text: string | null | undefined, rawWord: string): boolean {
  const word = rawWord.trim().toLowerCase()
  if (!word || text == null) {
    return false
  }
  const t = text.toLowerCase()
  if (NON_TOKEN.test(word)) {
    return t.includes(word)
  }
  return tokensOf(t).some(
    (tok) => tok === word || (tok.startsWith(word) && DIGITS.test(tok.slice(word.length))),
  )
}

/**
 * 空规则判定：包含组与排除组都无有效词（空串与纯空白不算词）时为空规则，
 * 空规则不能启用；UI 用它决定表单能否开启（ac-003）。
 */
export function isKeywordRuleEmpty(rule: KeywordRule): boolean {
  return (
    rule.includeWords.every((w) => w.trim() === '') &&
    rule.excludeWords.every((w) => w.trim() === '')
  )
}

/**
 * 规则求值：排除词命中任意一个即拒绝（优先于包含组）；includeMode 为 all 时
 * 包含组需全部命中，any 时命中任一即可；未命中则缺少关键词。
 * 只设排除组时排除未命中即放行；两组都空按缺少关键词不放行（fail-closed）。
 * 判定复用 t0 的 skip 语义，t3 处理器按原样翻译 skip 文案。
 */
export function evaluateKeywordRule(
  text: string | null | undefined,
  rule: KeywordRule,
): KeywordMatchDecision {
  const includeWords = rule.includeWords.map((w) => w.trim())
  const excludeWords = rule.excludeWords.map((w) => w.trim())
  for (const word of excludeWords) {
    if (matchesWord(text, word)) {
      return { skip: true, reason: 'excluded', keyword: word }
    }
  }
  const validIncludes = includeWords.filter((w) => w !== '')
  if (validIncludes.length === 0) {
    // 只设排除组：排除未命中即放行；两组都空按缺少关键词处理（fail-closed）。
    return excludeWords.some((w) => w !== '') ? { skip: false } : { skip: true, reason: 'missing' }
  }
  const matched = includeWords.filter((w) => matchesWord(text, w))
  if (rule.includeMode === 'all') {
    return matched.length === validIncludes.length
      ? { skip: false }
      : { skip: true, reason: 'missing' }
  }
  return matched.length > 0 ? { skip: false } : { skip: true, reason: 'missing' }
}
