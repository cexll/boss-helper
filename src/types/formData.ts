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

  [key: string]: any
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
