import { isKeywordRuleEmpty } from '@/composables/useApplying/keywordMatch'
import type { KeywordRule } from '@/composables/useApplying/keywordMatch'
import { keywordIncludeModes } from '@/types/formData'
import type { FormData, KeywordFieldConfig, KeywordGroup } from '@/types/formData'

/**
 * 旧“包含/排除”二选一配置 -> 新关键词组的迁移与校验（FR-002 / FR-006）。
 *
 * 纯函数模块：不依赖 Vue / 存储 / 日志，可在 bun test 下逐条验证，
 * 由 conf/index.ts 的 FROM_VERSION 迁移步骤与设置页（t4）共同调用。
 */
export type KeywordFieldLike = Partial<KeywordFieldConfig> & {
  include?: boolean
  value?: unknown
  enable?: boolean
}

/** 空关键词组缺省值：新装用户与字段缺失时使用。 */
export function emptyKeywordGroup(): KeywordGroup {
  return { includeWords: [], excludeWords: [], includeMode: 'any' }
}

/** value 里只接受字符串词；缺失或损坏的旧存储按空词表处理，不抛错。 */
function legacyWords(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((w): w is string => typeof w === 'string') : []
}
export type MigratedKeywordField = KeywordFieldLike & { groups: KeywordGroup }

/**
 * 旧配置 -> 关键词组（FR-006）：include=true 的旧词进包含组并设“任一满足”；
 * include=false 的旧词进排除组（只设排除组）；其他旧键原样保留，不删除用户数据。
 * 已带 groups 的字段不再改写，因此对同一份配置重复执行结果不变（幂等）。
 */
export function migrateKeywordGroups(field: KeywordFieldLike): MigratedKeywordField {
  if (field.groups) {
    return field as MigratedKeywordField
  }
  const words = legacyWords(field.value)
  const groups: KeywordGroup =
    field.include === true
      ? { includeWords: words, excludeWords: [], includeMode: 'any' }
      : { includeWords: [], excludeWords: words, includeMode: 'any' }
  return { ...field, groups }
}

/** 只迁移存在的字段；其余输入（缺失/非对象）原样返回 undefined。 */
function migrateKeywordField(field: unknown): KeywordFieldLike | undefined {
  return field && typeof field === 'object'
    ? migrateKeywordGroups(field as KeywordFieldLike)
    : undefined
}

/** 取字段生效的关键词组：缺少 groups 的旧存储原地按 FR-006 推导（容错未迁移配置）。 */
function keywordGroupOf(field: KeywordFieldLike): KeywordGroup {
  return field.groups ?? migrateKeywordGroups(field).groups
}

/** 字段生效的关键词组 -> 新引擎规则（字段名与 KeywordRule 对齐）。 */
export function keywordRuleOf(field: KeywordFieldLike): KeywordRule {
  const group = keywordGroupOf(field)
  return {
    includeWords: group.includeWords,
    excludeWords: group.excludeWords,
    // 存储值损坏/未知时回退 any（迁移与默认值均为 any）
    includeMode: (keywordIncludeModes as readonly string[]).includes(group.includeMode)
      ? (group.includeMode as KeywordRule['includeMode'])
      : 'any',
  }
}

/**
 * enable 门控（FR-002 / AC-003）：空规则不能启用。
 * 关键路径上的两处使用——迁移不改写旧 enable，判定时以本函数为准。
 */
export function keywordGroupEnabled(field: KeywordFieldLike): boolean {
  return field.enable === true && !isKeywordRuleEmpty(keywordRuleOf(field))
}

/**
 * 冲突词（FR-002）：同一个词同时出现在包含组与排除组。
 * 按 trim 后比较，报告 trim 后的词；顺序先包含组后排除组，便于 UI 提示（t4）。
 */
export function keywordConflictWords(group: KeywordGroup): string[] {
  const includeSet = new Set(group.includeWords.map((w) => w.trim()).filter(Boolean))
  const seen = new Set<string>()
  const conflicts: string[] = []
  for (const word of group.excludeWords) {
    const w = word.trim()
    if (includeSet.has(w) && !seen.has(w)) {
      seen.add(w)
      conflicts.push(w)
    }
  }
  return conflicts
}

/** FormData 迁移：只处理 jobTitle / jobContent 两个关键词字段（其余字段不动）。 */
export function migrateKeywordFields(from: Partial<FormData>): Partial<FormData> {
  for (const key of ['jobTitle', 'jobContent'] as const) {
    const migrated = migrateKeywordField(from[key])
    if (migrated) {
      from[key] = migrated as FormData[typeof key]
    }
  }
  return from
}
