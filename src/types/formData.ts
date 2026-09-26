export interface Statistics {
  date: string
  success: number
  total: number
  repeat: number
  activityFilter: number
  tasks: {
    [key: string]: { [key: string]: number }
  }
}

/** 包含词组合方式的候选值（FR-001；t4 设置页下拉与迁移共用）。 */
export const keywordIncludeModes = ['any', 'all'] as const
export type KeywordIncludeMode = (typeof keywordIncludeModes)[number]

/** 关键词组（FR-001）：同字段包含组与排除组并存，包含组可选任一/全部满足。 */
export interface KeywordGroup {
  /** 包含词：includeMode 决定任一或全部命中即放行 */
  includeWords: string[]
  /** 排除词：命中任一即排除（职位描述字段启用 FR-004 否定窗口，岗位名不做否定判断） */
  excludeWords: string[]
  /** 包含词组合方式；旧配置迁移固定为 any（FR-006） */
  includeMode: KeywordIncludeMode
}

/**
 * 关键词筛选字段：旧键（include/value/options/enable）原样保留，
 * groups 是新引擎读取的关键词组，由迁移或设置页写入（FR-006）。
 */
export interface KeywordFieldConfig extends FormDataSelect {
  groups: KeywordGroup
}

const ConfigLevels = ['beginner', 'intermediate', 'advanced', 'expert'] as const
export type ConfigLevel = (typeof ConfigLevels)[number]

export interface FormData {
  configLevel: ConfigLevel
  company: FormDataSelect
  jobTitle: KeywordFieldConfig
  jobContent: KeywordFieldConfig
  hrPosition: FormDataSelect
  jobAddress: FormDataSelect
  salaryRange: FormSalaryRangeInput
  companySizeRange: FormDataRangeInput
  customGreeting: FormDataInput
  deliveryLimit: FormDataInputNumber
  greetingVariable: FormDataCheckbox
  activityFilter: FormDataCheckbox
  friendStatus: FormDataCheckbox
  bossGoldMedalHr: FormDataCheckbox
  sameCompanyFilter: FormDataCheckbox & { expire?: number }
  sameHrFilter: FormDataCheckbox & { expire?: number }
  goldHunterFilter: FormDataCheckbox
  notification: FormDataCheckbox
  useCache: FormDataCheckbox
  aiGreeting: FormDataAi
  aiFiltering: FormDataAi & { score: number }
  aiReply: FormDataAi
  amap: {
    key: string
    origins: string
    straightDistance: number
    drivingDistance: number
    drivingDuration: number
    walkingDistance: number
    walkingDuration: number
    enable: boolean
  }
  record: { model?: string[]; enable: boolean }
  // animation?: "frame" | "card" | "together";
  delayDeliveryStarts: number
  delayDeliveryInterval: number
  delayDeliveryPageNext: number
  delayMessageSending: number
  version: string
  jev?: JevConfig

  [key: string]: any
}

/**
 * Jev 方向判断配置（FR-010 / AC-006）：开关 + 目标岗位方向描述。
 *
 * 目标方向留在 FormData（持久化配置）里，供 t8 判定依据与 t9 缓存键使用；
 * **密钥不在这里**——它只存浏览器存储 `local:jev-api-key`（t5 已合并的约定，
 * 后台代发请求 FR-017 从该键读取）。若把密钥塞进 FormData，confSaving 会把
 * 它复制进第二份存储、formData 的 watchThrottled 调试日志还会把它打进日志，
 * 违反「密钥只存浏览器存储、不进日志」的凭证纪律（这个失败模式是注释存在的理由）。
 */
export interface JevConfig {
  /** 启用开关：密钥与目标方向任一空白都不能置为 true（AC-006）。 */
  enable: boolean
  /** 目标岗位方向描述（纯字符串）。 */
  targetDirection: string
}

/** Jev 启用门控的输入：密钥来自浏览器存储，目标方向来自 FormData。 */
export interface JevEnableInput {
  apiKey: string
  targetDirection: string
}

/**
 * Jev 启用门控（FR-010 / AC-006）：密钥或目标方向为空白即不能启用。
 * 纯函数：只判空白、不碰 I/O，设置页与后续流水线共用同一判定。
 */
export function canEnableJev(input: JevEnableInput): boolean {
  return input.apiKey.trim() !== '' && input.targetDirection.trim() !== ''
}

export interface FormInfoAi {
  label: string
  'data-help'?: string
}

export interface FormDataSelect {
  include: boolean
  value: string[]
  options: string[]
  enable: boolean
}

export interface FormDataInput {
  value: string | Array<CustomGreetingItem>
  enable: boolean
}

export type FormDataRange = [number, number, boolean]

export interface FormDataRangeInput {
  value: FormDataRange
  enable: boolean
}

export interface FormSalaryRangeInput {
  // 宽松/严格 默认宽松false
  value: FormDataRange // 8-13K
  advancedValue: {
    H: FormDataRange // 45-75元/时
    D: FormDataRange // 360-600元/天
    M: FormDataRange // 8000-13000元/月
  }
  enable: boolean
}

export interface FormDataInputNumber {
  value: number
}

export interface FormDataCheckbox {
  value: boolean
}

export type Prompt = Array<{
  role: 'system' | 'user' | 'assistant'
  content: string
}>

export interface FormDataAi {
  model?: string
  prompt: Prompt
  enable: boolean
}

export type CustomGreetingItemText = {
  type: 'text'
  content: string
}

export type CustomGreetingItemImage = {
  type: 'image'
  // image: Record<
  //   string,
  //   { meta?: any; model?: File } & (
  //     | { url: string; base64?: undefined }
  //     | { url?: undefined; base64: string }
  //   )
  // >
  image: string
  model?: File
}

export type CustomGreetingItem = CustomGreetingItemText | CustomGreetingItemImage
