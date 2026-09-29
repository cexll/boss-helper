/**
 * 设置页关键词表单的纯逻辑层（t4 / FR-001 / FR-002 / FR-005）。
 *
 * 只做字段读取与词表推导，无 Vue 依赖：模板经 computed 取视图快照，判定口径全部复用
 * t3 的单点实现——conf/migrate.ts 的 keywordGroupEnabled / keywordConflictWords /
 * keywordRuleOf，以及 keywordMatch.ts 的 isKeywordRuleEmpty，本模块不复制第二套规则。
 */

import {
  keywordConflictWords,
  keywordGroupEnabled,
  keywordRuleOf,
} from '@/composables/conf/migrate'
import type { KeywordFieldConfig, KeywordIncludeMode } from '@/types/formData'

import { isKeywordRuleEmpty } from './keywordMatch'
import type { KeywordRule } from './keywordMatch'

/** 任一/全部切换的固定候选项：文案只此一处，UI 与判定共用同一组取值。 */
export const keywordIncludeModeOptions: Array<{ value: KeywordIncludeMode; label: string }> = [
  { value: 'any', label: '任一' },
  { value: 'all', label: '全部' },
]

/** 设置页视图快照：模板只读这些字段，判定与推导都在本模块。 */
export interface KeywordFieldView {
  /** 候选词：只来自用户用过的关键词（FR-005），不含预设词库。 */
  candidates: string[]
  /** 规则可用（非空且无同词冲突）；false 时启用开关不可用。 */
  usable: boolean
  /** 不可用原因文案；可用时为空串。 */
  hint: string
}

/** 非关键词字段的视图哨兵：字段形状不匹配时使用，模板不会渲染它。 */
export const EMPTY_KEYWORD_VIEW: KeywordFieldView = { candidates: [], usable: false, hint: '' }

/** 字段是否是带 groups 的新关键词组字段（jobTitle / jobContent）；旧单列表字段走原 UI。 */
export function isKeywordFieldConfig(field: unknown): field is KeywordFieldConfig {
  const groups = (field as Partial<KeywordFieldConfig> | null | undefined)?.groups
  return !!groups && typeof groups === 'object' && !Array.isArray(groups)
}

/**
 * 字段 -> 新引擎规则（读 groups 新键）。旧键字段的读兼容由 t3 的迁移单点负责，
 * 这里只是转发 keywordRuleOf，不重复迁移逻辑（FR-006）。
 */
export function keywordFieldToRule(field: KeywordFieldConfig): KeywordRule {
  return keywordRuleOf(field)
}

/**
 * 规则是否可用（AC-003）：空规则、或同词既包含又排除时不可用（冲突词经 exclusion-wins
 * 求值后排除组失效）。判定与引擎门控必须同源：以 enable=true 复用 keywordGroupEnabled，
 * 只剥掉它的 enable 前置——开关当前值不该影响"这条规则能不能启用"。
 */
export function isKeywordFieldUsable(field: KeywordFieldConfig): boolean {
  return keywordGroupEnabled({ ...field, enable: true })
}

/** 启用开关不可用的原因文案（AC-003）：空规则不能启用；冲突时点名同名词。 */
export function keywordUsabilityHint(field: KeywordFieldConfig): string {
  const rule = keywordFieldToRule(field)
  const conflicts = keywordConflictWords(rule)
  if (conflicts.length > 0) {
    return `包含与排除含同一词：${conflicts.join('、')}`
  }
  return isKeywordRuleEmpty(rule) ? '空规则不能启用' : ''
}

/**
 * 候选词（FR-005）：用户用过的关键词 = 旧 options 键 ∪ 两组当前词；按 trim 去重、丢弃空词。
 * 候选词本身不是条件——它只在用户显式选中时经 mergeCandidate 进入词表。
 */
export function keywordCandidates(field: KeywordFieldConfig): string[] {
  const rule = keywordFieldToRule(field)
  const seen = new Set<string>()
  const words: string[] = []
  for (const word of [...(field.options ?? []), ...rule.includeWords, ...rule.excludeWords]) {
    const trimmed = word.trim()
    if (trimmed === '' || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    words.push(trimmed)
  }
  return words
}

/**
 * 显式选中候选词：只向词表 ADD，返回新数组；不就地修改、不自动启用字段（enable）、
 * 也不改任一/全部（includeMode）（FR-005）。纯空白候选忽略，已在词表里的候选不重复并入。
 */
export function mergeCandidate(existingWords: string[], candidates: string[]): string[] {
  const merged = [...existingWords]
  const seen = new Set(merged.map((word) => word.trim()))
  for (const candidate of candidates) {
    const word = candidate.trim()
    if (word === '' || seen.has(word)) {
      continue
    }
    seen.add(word)
    merged.push(word)
  }
  return merged
}

/** 设置页视图：候选词 / 可用性 / 提示一次算好，模板只做绑定。 */
export function keywordFieldView(field: KeywordFieldConfig): KeywordFieldView {
  return {
    candidates: keywordCandidates(field),
    usable: isKeywordFieldUsable(field),
    hint: keywordUsabilityHint(field),
  }
}
