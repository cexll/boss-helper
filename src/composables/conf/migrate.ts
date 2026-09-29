import { isKeywordRuleEmpty } from '@/composables/useApplying/keywordMatch'
import type { KeywordRule } from '@/composables/useApplying/keywordMatch'
import { keywordIncludeModes } from '@/types/formData'
import type {
  FormData,
  FormDataSelect,
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

/** 字段形状损坏：null / 非对象原始值 / 数组。undefined = 配置缺该字段，不算损坏。 */
function corruptedKeywordField(value: unknown): boolean {
  return (
    value === null || (typeof value !== 'object' && value !== undefined) || Array.isArray(value)
  )
}

/**
 * 存量关键词字段的默认形态（与 info.ts 的 defaultFormData 对齐：jobTitle 白名单、
 * jobContent 黑名单，一律关闭 + 空词表）。不可 import info.ts 复用：info.ts 反向 import
 * 本模块的 emptyKeywordGroup，import/no-cycle 是 gate 红线的 lint 违规；此处按字段名
 * 构造新对象/新数组，天然不与模块默认共享引用（对齐漂移由测试断言捕获）。
 */
function defaultKeywordFieldShape(key: 'jobTitle' | 'jobContent'): KeywordFieldConfig {
  return {
    include: key === 'jobTitle',
    value: [],
    options: [],
    enable: false,
    groups: emptyKeywordGroup(),
  }
}

/** 存量 hrPosition 的默认形态（与 defaultFormData.hrPosition 对齐；单列表字段无关键词组）。 */
function defaultHrPositionShape(): FormDataSelect {
  return {
    include: true,
    value: [],
    options: ['经理', '主管', '法人', '人力资源主管', 'hr', '招聘专员'],
    enable: false,
  }
}

/**
 * FormData 迁移：只处理 jobTitle / jobContent / hrPosition 三个字段（其余字段不动）。
 *
 * 字段读取归一（评审 F-024，参照 fx-007 normalizeJevConfig 的读路径模式）：形状损坏
 * （null / 非对象 / 数组）的存量字段对象不能原样放行——deepmerge 会把 null 原样覆盖
 * 默认值，注册期 keywordGroupEnabled / keywordRuleOf 与处理器对 .enable / .groups 的
 * 解引用会抛 TypeError，造成每单 error-skip（评审 probe6 复现）。
 * 一律回退该字段默认形态。字段缺失（undefined）则原样跳过：deepmerge 按默认补齐，
 * 缺失键不会覆盖默认形态。hrPosition 是单列表字段，不参与关键词组迁移：仅做损坏归一。
 */
export function migrateKeywordFields(from: Partial<FormData>): Partial<FormData> {
  for (const key of ['jobTitle', 'jobContent'] as const) {
    const stored = from[key]
    if (corruptedKeywordField(stored)) {
      from[key] = defaultKeywordFieldShape(key)
    } else if (stored !== undefined) {
      from[key] = migrateKeywordGroups(stored as KeywordFieldLike) as FormData[typeof key]
    }
  }
  if (corruptedKeywordField(from.hrPosition)) {
    from.hrPosition = defaultHrPositionShape()
  }
  return from
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
 * 按 trim 后、忽略大小写比较——匹配引擎对词做 toLowerCase 后求值，冲突判定必须与
 * 引擎共用同一相等关系，否则 include[Java]+exclude[java] 能启用并静默排除全部命中
 * （评审 F-023）；报告 trim 后的排除侧原词。顺序先包含组后排除组，便于 UI 提示（t4）。
 */
export function keywordConflictWords(group: KeywordGroup): string[] {
  const includeSet = new Set(group.includeWords.map((w) => w.trim().toLowerCase()).filter(Boolean))
  const seen = new Set<string>()
  const conflicts: string[] = []
  for (const word of group.excludeWords) {
    const w = word.trim()
    const key = w.toLowerCase()
    if (includeSet.has(key) && !seen.has(key)) {
      seen.add(key)
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
