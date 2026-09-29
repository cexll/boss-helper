/**
 * 岗位名 / 工作内容关键词判定的纯函数模块。
 *
 * 既有行为（t0 逐字刻画自 handles.ts 迁移前，t3 语义迁移的 oracle，行为不得改动）：
 * - 岗位名：小写包含匹配，无空关键词保护；
 * - 工作内容：正则匹配，带否定词回溯 `(?<!(不|无).{0,5})` 与后缀屏蔽表 `(?!系统|软件|工具|服务)`，
 *   跳过空关键词，文本 null 保护在正则构造之后。
 * 新引擎（t1/t2）：`evaluateKeywordRule` + 调用点选项，全部固定字面量匹配，
 * 用户关键词不进正则；FR-004 否定窗口只作用于职位描述排除词。
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

/**
 * 规则求值的调用点选项：否定窗口是字段语义而非用户配置——职位描述字段传
 * `{ negateExclusions: true }`，岗位名称字段省略（缺省 false，不做否定判断）。
 */
export type KeywordRuleOptions = {
  /**
   * FR-004：true 时排除词命中前 5 个字内出现「不/无」不算命中；包含词一律
   * 不做否定判断。缺省 false = 岗位名称字段契约（不做否定判断）。
   */
  negateExclusions?: boolean
}

const TOKEN_CHAR = /[a-z0-9+#.]/
const NON_TOKEN = /[^a-z0-9+#.]/
/** 版本尾段（评审 F-021）：数字段加点，如 "3.2" / "1.8" / "14.17"；点后须仍是数字段。 */
const VERSION_TAIL = /^\d+(\.\d+)*$/

/**
 * t1 新关键词引擎的 token 化（带起点下标）：英文技术名词的完整词边界由
 * `[a-z0-9+#.]` 连写段决定，'+' '#' '.' 与字符同属一个 token，因此 `C++`、`C#`、
 * `.NET`、`asp.net` 各为完整名称，段末的点（"Java."）不算 token 内容。
 * 起点下标用于否定窗口逐处判定（全部固定字面量，用户输入不进正则）。
 */
function tokenStarts(text: string): Array<{ word: string; start: number }> {
  const out: Array<{ word: string; start: number }> = []
  let cur = ''
  let curStart = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (TOKEN_CHAR.test(ch)) {
      if (!cur) {
        curStart = i
      }
      cur += ch
    } else if (cur) {
      out.push({ word: cur.replace(/\.+$/, ''), start: curStart })
      cur = ''
    }
  }
  if (cur) {
    out.push({ word: cur.replace(/\.+$/, ''), start: curStart })
  }
  return out
}

/**
 * 关键词在已小写文本上的全部命中起点（全部固定字面量，用户输入不进正则）：
 * - 英文词 = 完整词命中，词后紧跟数字段（含点分版本段，如 3.2 / 1.8 / 14.17）视为
 *   版本号仍算命中（评审 F-021），紧跟字母或点后接字母则不属于该词；
 * - 其余（中文、混合中英、带 '/'- 等非 token 字符的词）= 忽略大小写的子串包含，
 *   逐处扫描以便否定窗口逐处判定。
 * FR-004：关键词后接「系统、软件、工具、服务」不再阻止命中（旧后缀屏蔽表移除）。
 */
function wordHitsIn(t: string, word: string): number[] {
  if (NON_TOKEN.test(word)) {
    const hits: number[] = []
    let from = t.indexOf(word)
    while (from !== -1) {
      hits.push(from)
      from = t.indexOf(word, from + 1)
    }
    return hits
  }
  return tokenStarts(t)
    .filter(
      (tok) =>
        tok.word === word ||
        (tok.word.startsWith(word) && VERSION_TAIL.test(tok.word.slice(word.length))),
    )
    .map((tok) => tok.start)
}

/**
 * 单关键词匹配（包含组路径）：命中位置非空即命中；空词 / 空文本无命中。
 * 包含词不做否定判断（FR-004）。
 */
function matchesWord(text: string | null | undefined, rawWord: string): boolean {
  const word = rawWord.trim().toLowerCase()
  if (!word || text == null) {
    return false
  }
  return wordHitsIn(text.toLowerCase(), word).length > 0
}

/** FR-004 否定窗口宽度：命中起点前 5 个字符（码元）内出现否定词即不算命中。 */
const NEGATION_WINDOW = 5

/** 命中起点前的否定窗口内是否有「不」或「无」（字面扫描固定字，不构造正则）。 */
function isNegatedAt(t: string, hit: number): boolean {
  const from = Math.max(0, hit - NEGATION_WINDOW)
  for (let i = from; i < hit; i += 1) {
    if (t[i] === '不' || t[i] === '无') {
      return true
    }
  }
  return false
}

/**
 * 排除组命中判定：negate 为 true 时启用 FR-004 否定窗口——命中前 5 字内有
 * 「不/无」的出现不算命中，其余出现仍算；negate 为 false 时不做否定判断
 * （岗位名称字段契约）。包含词一律走 matchesWord，不经此函数。
 */
function exclusionHit(text: string | null | undefined, rawWord: string, negate: boolean): boolean {
  const word = rawWord.trim().toLowerCase()
  if (!word || text == null) {
    return false
  }
  const t = text.toLowerCase()
  const hits = wordHitsIn(t, word)
  if (!negate) {
    return hits.length > 0
  }
  return hits.some((hit) => !isNegatedAt(t, hit))
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
 * 规则求值：排除词命中任意一个即拒绝（优先于包含组），调用点启用 negateExclusions
 * 时排除词命中前 5 字内有「不/无」的出现不算命中；包含组一律不做否定判断。
 * includeMode 为 all 时包含组需全部命中，any 时命中任一即可；未命中则缺少关键词。
 * 只设排除组时排除未命中即放行；两组都空按缺少关键词不放行（fail-closed）。
 * 判定复用 t0 的 skip 语义，t3 处理器按原样翻译 skip 文案。
 */
export function evaluateKeywordRule(
  text: string | null | undefined,
  rule: KeywordRule,
  options: KeywordRuleOptions = {},
): KeywordMatchDecision {
  const negate = options.negateExclusions === true
  const includeWords = rule.includeWords.map((w) => w.trim())
  const excludeWords = rule.excludeWords.map((w) => w.trim())
  for (const word of excludeWords) {
    if (exclusionHit(text, word, negate)) {
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
