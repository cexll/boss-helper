import { isKeywordRuleEmpty } from '@/composables/useApplying/keywordMatch'
import type { KeywordRule } from '@/composables/useApplying/keywordMatch'
import { keywordIncludeModes } from '@/types/formData'
import type {
  FormData,
  JevConfig,
  KeywordFieldConfig,
  KeywordGroup,
  KeywordIncludeMode,
} from '@/types/formData'

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

/** 词表里只接受字符串词；缺失或损坏的存储（旧 value 键与 groups 词表共用）按空词表处理，不抛错。 */
function wordsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((w): w is string => typeof w === 'string') : []
}
/** includeMode 归一：合法候选值（any/all）原样保留，缺失/损坏一律回退 any（缺省即旧包含语义）。 */
function resolveIncludeMode(mode: unknown): KeywordIncludeMode {
  return (keywordIncludeModes as readonly string[]).includes(mode as string)
    ? (mode as KeywordIncludeMode)
    : 'any'
}
export type MigratedKeywordField = KeywordFieldLike & { groups: KeywordGroup }

/**
 * 旧配置 -> 关键词组（FR-006）：include=true 的旧词进包含组并设“任一满足”；
 * include=false 的旧词进排除组（只设排除组）；其他旧键原样保留，不删除用户数据。
 * 已带 groups 键的字段按同一规则归一（词表只留字符串词、includeMode 缺失/损坏回退 any），
 * 因此对同一份配置重复执行结果不变（幂等）；形状损坏的 groups（缺词表 / 词表非数组 /
 * 非 plain 对象）经此归一后总能成为可求值的良构规则，不再向流水线输出会抛错的规则
 * （评审 F-005）；只有 groups 键缺失时才按旧 include/value 推导（评审 F-001 的存量路径）。
 */
export function migrateKeywordGroups(field: KeywordFieldLike): MigratedKeywordField {
  const groups = field.groups
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    return {
      ...field,
      groups: {
        includeWords: wordsOf(groups.includeWords),
        excludeWords: wordsOf(groups.excludeWords),
        includeMode: resolveIncludeMode(groups.includeMode),
      },
    }
  }
  const words = wordsOf(field.value)
  return {
    ...field,
    groups:
      field.include === true
        ? { includeWords: words, excludeWords: [], includeMode: 'any' }
        : { includeWords: [], excludeWords: words, includeMode: 'any' },
  }
}

/** 只迁移存在的字段；其余输入（缺失/非对象）原样返回 undefined。 */
function migrateKeywordField(field: unknown): KeywordFieldLike | undefined {
  return field && typeof field === 'object'
    ? migrateKeywordGroups(field as KeywordFieldLike)
    : undefined
}

/** 取字段生效的关键词组：缺失/未迁移/形状损坏的 groups 原地按 FR-006 推导或归一。 */
function keywordGroupOf(field: KeywordFieldLike): KeywordGroup {
  return migrateKeywordGroups(field).groups
}

/** 字段生效的关键词组 -> 新引擎规则（字段名与 KeywordRule 对齐）。 */
export function keywordRuleOf(field: KeywordFieldLike): KeywordRule {
  const group = keywordGroupOf(field)
  return {
    includeWords: group.includeWords,
    excludeWords: group.excludeWords,
    includeMode: resolveIncludeMode(group.includeMode),
  }
}

/**
 * enable 门控（FR-002 / AC-003）：空规则不能启用；同一词同在包含与排除组（冲突）时，
 * 修正前同样不能启用——冲突规则经 exclusion-wins 求值后排除组失效， Registration 门控
 * 必须与 t4 设置页共用同一判定（评审 F-002）。
 */
export function keywordGroupEnabled(field: KeywordFieldLike): boolean {
  return (
    field.enable === true &&
    !isKeywordRuleEmpty(keywordRuleOf(field)) &&
    keywordConflictWords(keywordGroupOf(field)).length === 0
  )
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

/**
 * 存储损坏的 jev 值归一（评审 F-010）：null / 非对象 / 数组 / 缺字段一律回退
 * 默认关闭形态 {enable:false, targetDirection:''}；良构形状（boolean enable +
 * string targetDirection）原样保留（含「未启用但已填方向」的用户选择）。
 * 纯函数：不碰 Vue / 存储，可在 bun test 下逐条验证。
 */
export function normalizeJevConfig(value: unknown): JevConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { enable: false, targetDirection: '' }
  }
  const jev = value as Record<string, unknown>
  return typeof jev.enable === 'boolean' && typeof jev.targetDirection === 'string'
    ? { enable: jev.enable, targetDirection: jev.targetDirection }
    : { enable: false, targetDirection: '' }
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
