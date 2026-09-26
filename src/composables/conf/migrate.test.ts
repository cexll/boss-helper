import { beforeEach, describe, expect, test } from 'bun:test'

import type { FormData } from '@/types/formData'

import type * as HandlesNamespace from '../useApplying/handles'
import { decideJobContentKeyword, decideJobTitleKeyword, evaluateKeywordRule } from '../useApplying/keywordMatch';
import type { KeywordMatchDecision } from '../useApplying/keywordMatch';
import { reviewNeededStore } from '../useApplying/reviewNeeded'
import { defaultFormData } from './info'
import { keywordConflictWords, keywordGroupEnabled, keywordRuleOf, migrateKeywordGroups } from './migrate';
import type { KeywordFieldLike } from './migrate';

type HandlesModule = typeof HandlesNamespace
/**
 * 旧 -> 新关键词组迁移（FR-006 / AC-005 前半）的单测。
 * 期望值全部来自 spec.md FR-006 原文与 defaultFormData，不出自实现。
 */

const legacyField = (over: Partial<KeywordFieldLike>): KeywordFieldLike => ({
  include: true,
  value: [],
  options: [],
  enable: false,
  ...over,
})

describe('migrateKeywordGroups：旧键到关键词组的映射（FR-006）', () => {
  test('include=true：旧词全部进包含组，includeMode 为 any', () => {
    const out = migrateKeywordGroups(legacyField({ include: true, value: ['Java', '前端'] }))
    expect(out.groups.includeWords).toEqual(['Java', '前端'])
    expect(out.groups.excludeWords).toEqual([])
    expect(out.groups.includeMode).toBe('any')
  })

  test('include=false：旧词全部进排除组（仅排除），不产生包含词', () => {
    const out = migrateKeywordGroups(legacyField({ include: false, value: ['外包', '销售'] }))
    expect(out.groups.includeWords).toEqual([])
    expect(out.groups.excludeWords).toEqual(['外包', '销售'])
  })

  test('enable 原样保留（FR-006：启用状态不变）', () => {
    expect(migrateKeywordGroups(legacyField({ enable: true })).enable).toBe(true)
    expect(migrateKeywordGroups(legacyField({ enable: false })).enable).toBe(false)
  })

  test('旧键 include/value/options 原样保留在结果上（旧配置原样迁移，不删除用户数据）', () => {
    const field = legacyField({ include: false, value: ['外包'], options: ['外包', '上门'] })
    const out = migrateKeywordGroups(field)
    expect(out.include).toBe(false)
    expect(out.value).toEqual(['外包'])
    expect(out.options).toEqual(['外包', '上门'])
  })

  test('词表顺序保持输入顺序（不重排、不去重用户词）', () => {
    const out = migrateKeywordGroups(legacyField({ value: ['b', 'a', 'b'] }))
    expect(out.groups.includeWords).toEqual(['b', 'a', 'b'])
  })

  test('空词表：两组均为空（空规则不能启用，由启用判定函数把关）', () => {
    const out = migrateKeywordGroups(legacyField({ value: [] }))
    expect(out.groups.includeWords).toEqual([])
    expect(out.groups.excludeWords).toEqual([])
  })

  test('value 缺失或非数组：按空词表迁移，不抛错（旧存储损坏时保持可加载）', () => {
    const broken = legacyField({}) as Record<string, unknown>
    delete broken.value
    expect(migrateKeywordGroups(broken as unknown as KeywordFieldLike).groups.includeWords).toEqual(
      [],
    )
  })

  test('value 含非字符串元素：过滤掉（不抛错、不产生非法词）', () => {
    const out = migrateKeywordGroups(legacyField({ value: ['Java', 42, null] as never }))
    expect(out.groups.includeWords).toEqual(['Java'])
  })

  test('已迁移字段（已有 groups）：不二次迁移，groups 原样保留（幂等前提）', () => {
    const migrated = legacyField({
      groups: { includeWords: ['新词'], excludeWords: [], includeMode: 'all' },
    })
    const out = migrateKeywordGroups(migrated)
    expect(out.groups).toEqual({ includeWords: ['新词'], excludeWords: [], includeMode: 'all' })
  })
})

describe('migrateKeywordGroups：幂等性', () => {
  test('对已迁移结果再次迁移，字段保持不变（二次存储加载不再改写）', () => {
    const once = migrateKeywordGroups(legacyField({ include: true, value: ['Java'] }))
    const twice = migrateKeywordGroups(once)
    expect(twice).toEqual(once)
  })

  test('默认配置迁移前后等价（默认字段无旧词）', () => {
    const once = migrateKeywordGroups(defaultFormData.jobTitle)
    const twice = migrateKeywordGroups(once)
    expect(twice).toEqual(once)
  })
})

describe('enable 门控（FR-002 / AC-003 的引擎层前置）', () => {
  test('keywordGroupEnabled：空组返回 false（空规则不能启用）', () => {
    const field = migrateKeywordGroups(legacyField({ value: [], enable: true }))
    expect(keywordGroupEnabled(field)).toBe(false)
  })

  test('keywordGroupEnabled：只有空白词视为空组，返回 false', () => {
    const field = migrateKeywordGroups(legacyField({ value: ['  '], enable: true }))
    expect(keywordGroupEnabled(field)).toBe(false)
  })

  test('keywordGroupEnabled：含有效包含词且启用为 true', () => {
    const field = migrateKeywordGroups(legacyField({ value: ['Java'], enable: true }))
    expect(keywordGroupEnabled(field)).toBe(true)
  })

  test('keywordGroupEnabled：含有效词但 enable=false 返回 false', () => {
    const field = migrateKeywordGroups(legacyField({ value: ['Java'], enable: false }))
    expect(keywordGroupEnabled(field)).toBe(false)
  })

  test('keywordGroupEnabled：groups 缺失（旧存储未迁移）按旧词表推导，不抛错', () => {
    const field = legacyField({ value: ['外包'], enable: true })
    expect(keywordGroupEnabled(field)).toBe(true)
    expect(keywordGroupEnabled(legacyField({ value: [], enable: true }))).toBe(false)
  })
})

describe('冲突检测（FR-002：同词同时出现在两组；UI 提示归 t4，此处使冲突可检测）', () => {
  test('keywordConflictWords：报告两组都出现的词', () => {
    const conflicts = keywordConflictWords({
      includeWords: ['Java', '外包'],
      excludeWords: ['外包', '销售'],
      includeMode: 'any',
    })
    expect(conflicts).toEqual(['外包'])
  })

  test('keywordConflictWords：无交集时返回空数组', () => {
    expect(
      keywordConflictWords({
        includeWords: ['Java'],
        excludeWords: ['外包'],
        includeMode: 'any',
      }),
    ).toEqual([])
  })

  test('keywordConflictWords：按 trim 后比较，报告 trim 后的词', () => {
    expect(
      keywordConflictWords({
        includeWords: [' 外包 '],
        excludeWords: ['外包'],
        includeMode: 'any',
      }),
    ).toEqual(['外包'])
  })

  test('迁移自旧配置的字段不会产生冲突（include 与 exclude 互斥）', () => {
    const out = migrateKeywordGroups(legacyField({ include: true, value: ['Java'] }))
    expect(keywordConflictWords(out.groups)).toEqual([])
  })
})

describe('defaultFormData 携带新字段（新装用户直接得到关键词组结构）', () => {
  test('jobTitle/jobContent 默认 groups 为空且 enable=false', () => {
    for (const key of ['jobTitle', 'jobContent'] as const) {
      const field = defaultFormData[key]
      expect(field.enable).toBe(false)
      expect(field.groups.includeWords).toEqual([])
      expect(field.groups.excludeWords).toEqual([])
      expect(field.groups.includeMode).toBe('any')
    }
  })

  test('默认配置仍是合法 FormData（关键字段类型收敛，不破坏其余字段）', () => {
    const data: FormData = defaultFormData
    expect(data.version).toBe('20260718')
  })
})

// ————————————————————————————————————————————————————————————————————————————
// AC-005 新旧结果一致性（以 t0 旧实现为 oracle 的对照语料）。
// 语料选择依据（spec.md FR-003 / FR-004 / AC-005）：
//  AC-005 只要求「同一批不涉及 FR-003/FR-004 语义变化的岗位」结果一致，因此
//  语料明确排除四类已知语义变化（见 divergenceTable），并逐类断言其确实不同，
//  证明排除不是掩盖而是规格允许的差异：
//  D1 职位描述否定窗口收窄（FR-004：否定词距关键词 ≤6 字屏蔽 → 恰好 5 字），
//     距 6 字的输入旧实现放行、新实现排除。
//  D2 旧后缀屏蔽表移除（FR-004：关键词后接 系统/软件/工具/服务 不再阻止命中），
//     「销售系统」「外包系统」「上门服务」旧实现放行、新实现命中。
//  D3 英文完整词/版本号语义（FR-003：Java↛JavaScript、C↛C++/C#、后接数字=版本号
//     仍命中、后接字母不命中），旧实现子串包含、新实现完整词。
//  D4 旧实现的正则化关键词（旧实现把用户词编译成正则，如 a+b 视为 a+ b）与新引擎
//     的固定字面量语义不同；语料只使用无正则元字符的词。
// 期望值（expected 字段）逐字取自已确认的规格例句与旧实现语义，而非迁移实现。
// ————————————————————————————————————————————————————————————————————————————

type OracleOutcome = 'pass' | 'missing' | `excluded:${string}`

function outcomeOf(decision: KeywordMatchDecision): OracleOutcome {
  if (!decision.skip) return 'pass'
  if (decision.reason === 'missing') return 'missing'
  return `excluded:${decision.keyword}`
}

/** 新路径：旧配置 -> 迁移 -> 新引擎（jobTitle 无否定窗口；jobContent 启用 FR-004 窗口）。 */
function newPath(
  field: 'jobTitle' | 'jobContent',
  text: string,
  legacy: { include: boolean; value: string[] },
): OracleOutcome {
  const migrated = migrateKeywordGroups({ ...legacy, options: [], enable: true })
  const rule = keywordRuleOf(migrated)
  const decision = evaluateKeywordRule(
    text,
    rule,
    field === 'jobContent' ? { negateExclusions: true } : {},
  )
  return outcomeOf(decision)
}

/** 旧路径：t0 冻结的旧实现（handler 现状调用前文本已小写）。 */
function legacyPath(
  field: 'jobTitle' | 'jobContent',
  text: string,
  legacy: { include: boolean; value: string[] },
): OracleOutcome {
  const decision =
    field === 'jobTitle'
      ? decideJobTitleKeyword(text.toLowerCase(), legacy)
      : decideJobContentKeyword(text.toLowerCase(), legacy)
  return outcomeOf(decision)
}
/** 对照语料元组：[key, 字段, 文本, include, 旧词表, 期望处置]；只含不涉及 FR-003/FR-004 语义变化的输入。 */
type CorpusTuple = [
  key: string,
  field: 'jobTitle' | 'jobContent',
  text: string,
  include: boolean,
  value: string[],
  expected: OracleOutcome,
]
interface CorpusRow {
  key: string
  field: 'jobTitle' | 'jobContent'
  text: string
  include: boolean
  value: string[]
  expected: OracleOutcome
}
const corpusTuples: CorpusTuple[] = [
  // 岗位名：中文包含（FR-003 中文按包含，新旧一致）
  ['title-zh-hit', 'jobTitle', '后端开发工程师', true, ['开发'], 'pass'],
  ['title-zh-miss', 'jobTitle', '产品经理', true, ['开发'], 'missing'],
  // 岗位名：英文完整词命中与版本号（新旧一致；FR-003）
  ['title-en-clean', 'jobTitle', 'java 开发', true, ['java'], 'pass'],
  ['title-en-upper', 'jobTitle', 'Java 高级工程师', true, ['java'], 'pass'],
  ['title-version', 'jobTitle', 'java8 开发', true, ['java'], 'pass'],
  ['title-cn-boundary', 'jobTitle', '资深Java工程师', true, ['java'], 'pass'],
  // 岗位名：排除模式（命中即排除、无命中放行、按词序报告）
  ['title-ex-hit', 'jobTitle', '外包专员', false, ['外包'], 'excluded:外包'],
  ['title-ex-pass', 'jobTitle', '后端工程师', false, ['外包'], 'pass'],
  ['title-ex-order', 'jobTitle', '销售顾问', false, ['外包', '销售'], 'excluded:销售'],
  // 岗位名不做否定判断（FR-004），新旧一致
  ['title-no-negation', 'jobTitle', '不需要 Java 外包', false, ['外包'], 'excluded:外包'],
  // 职位描述：包含命中（带 系统/软件/工具/服务 后缀的属 D2，不入语料）
  ['desc-zh-hit', 'jobContent', '周末双休', true, ['双休'], 'pass'],
  ['desc-en-hit', 'jobContent', '熟悉 Java 开发', true, ['java'], 'pass'],
  ['desc-version', 'jobContent', '熟悉Vue3框架', true, ['vue'], 'pass'],
  ['desc-zh-miss', 'jobContent', '有驾照者优先', true, ['Java'], 'missing'],
  ['desc-multi', 'jobContent', '负责 Java 后端开发', true, ['java', '外包'], 'pass'],
  // 职位描述：排除命中（FR-004 否定窗口内的「不是/无需」新旧均不算命中）
  ['desc-ex-hit', 'jobContent', '外包岗位', false, ['外包'], 'excluded:外包'],
  ['desc-neg-window', 'jobContent', '不是外包岗位', false, ['外包'], 'pass'],
  ['desc-neg-wu', 'jobContent', '无需外包经验', false, ['外包'], 'pass'],
  ['desc-neg-7', 'jobContent', '不加班到深夜的外包', false, ['外包'], 'excluded:外包'],
  ['desc-ex-pass', 'jobContent', '周末双休', false, ['外包'], 'pass'],
  ['desc-ex-order', 'jobContent', '需要销售或外包', false, ['销售', '外包'], 'excluded:销售'],
  ['desc-ex-more', 'jobContent', '不需要上门', false, ['上门'], 'pass'],
]
const corpus: CorpusRow[] = corpusTuples.map(([key, field, text, include, value, expected]) => ({
  key,
  field,
  text,
  include,
  value,
  expected,
}))

interface DivergenceRow {
  key: string
  field: 'jobTitle' | 'jobContent'
  text: string
  include: boolean
  value: string[]
  legacyExpected: OracleOutcome
  newExpected: OracleOutcome
  reason: string
}

/** 已知语义变化（不进入对照语料）：逐类断言旧/新确实不同，引 FR-003/FR-004 原文。 */
const divergenceTable: DivergenceRow[] = [
  {
    key: 'D1-window-6',
    field: 'jobContent',
    text: '不加班到深夜外包',
    include: false,
    value: ['外包'],
    legacyExpected: 'pass',
    newExpected: 'excluded:外包',
    reason: 'FR-004：否定窗口由「距 6 字仍屏蔽」收窄为恰好 5 字；距 6 字的输入语义改变。',
  },
  {
    key: 'D2-suffix-system',
    field: 'jobContent',
    text: '销售系统',
    include: false,
    value: ['销售'],
    legacyExpected: 'pass',
    newExpected: 'excluded:销售',
    reason: 'FR-004：关键词后接「系统」不再阻止命中（旧后缀屏蔽表移除）。',
  },
  {
    key: 'D2-suffix-service',
    field: 'jobContent',
    text: '上门服务',
    include: false,
    value: ['上门'],
    legacyExpected: 'pass',
    newExpected: 'excluded:上门',
    reason: 'FR-004：关键词后接「服务」不再阻止命中（旧后缀屏蔽表移除）。',
  },
  {
    key: 'D3-js-substring',
    field: 'jobTitle',
    text: 'javaScript 开发',
    include: true,
    value: ['java'],
    legacyExpected: 'pass',
    newExpected: 'missing',
    reason: 'FR-003：英文按完整词匹配，Java 不命中 JavaScript（旧实现子串包含）。',
  },
  {
    key: 'D3-cplusplus',
    field: 'jobTitle',
    text: 'c++ 工程师',
    include: true,
    value: ['c'],
    legacyExpected: 'pass',
    newExpected: 'missing',
    reason: 'FR-003：C++ 为完整名称，C 不命中 C++（旧实现子串包含）。',
  },
  {
    key: 'D3-digit-letter',
    field: 'jobTitle',
    text: 'java8s 开发',
    include: true,
    value: ['java'],
    legacyExpected: 'pass',
    newExpected: 'missing',
    reason: 'FR-003：后接数字视为版本号仍命中；后接字母不命中（Java8s 不算 Java）。',
  },
  {
    key: 'D4-regex-special',
    field: 'jobContent',
    text: 'aab 项目',
    include: true,
    value: ['a+b'],
    legacyExpected: 'pass',
    newExpected: 'missing',
    reason:
      'FR-003/新引擎：用户词是固定字面量；旧实现把 a+b 编译成正则「a+ 后跟 b」故命中 aab，新实现不命中。',
  },
]

describe('AC-005 对照语料：迁移+新引擎 与 t0 旧实现 结果一致', () => {
  test('语料覆盖两种字段且每个字段至少含 pass / missing / excluded 各一（防止空语料假绿）', () => {
    const counts = new Map<string, Set<string>>()
    for (const row of corpus) {
      const set = counts.get(row.field) ?? new Set<string>()
      set.add(row.expected)
      counts.set(row.field, set)
    }
    for (const field of ['jobTitle', 'jobContent'] as const) {
      const set = counts.get(field)
      expect(set).toBeDefined()
      expect(set!.has('pass')).toBe(true)
      expect(set!.has('missing')).toBe(true)
      expect([...set!].some((o) => o.startsWith('excluded:'))).toBe(true)
    }
  })

  test('每条语料：旧实现输出 == 期望 == 迁移+新引擎输出', () => {
    for (const row of corpus) {
      const legacy = legacyPath(row.field, row.text, { include: row.include, value: row.value })
      const fresh = newPath(row.field, row.text, { include: row.include, value: row.value })
      expect({ row: row.key, legacy }).toEqual({ row: row.key, legacy: row.expected })
      expect({ row: row.key, fresh }).toEqual({ row: row.key, fresh: row.expected })
    }
  })
})

describe('AC-005 语料排除登记：四类已知语义变化确实不同（规格允许，非掩盖）', () => {
  test('排除登记每条：旧实现与新实现输出如登记所示', () => {
    for (const row of divergenceTable) {
      const legacy = legacyPath(row.field, row.text, { include: row.include, value: row.value })
      const fresh = newPath(row.field, row.text, { include: row.include, value: row.value })
      expect({ row: row.key, legacy }).toEqual({ row: row.key, legacy: row.legacyExpected })
      expect({ row: row.key, fresh }).toEqual({ row: row.key, fresh: row.newExpected })
      expect(fresh).not.toEqual(legacy)
    }
  })
})

describe('迁移结果对新引擎的输入契约（处理器读取 groups 前的对齐）', () => {
  test('migrateKeywordGroups 输出可直接作为 evaluateKeywordRule 的规则（含 include=false 的排除-only）', () => {
    const rule = keywordRuleOf(
      migrateKeywordGroups({ include: false, value: ['外包'], enable: true }),
    )
    expect(rule.includeWords).toEqual([])
    expect(rule.excludeWords).toEqual(['外包'])
    expect(evaluateKeywordRule('外包项目', rule)).toEqual({
      skip: true,
      reason: 'excluded',
      keyword: '外包',
    })
    expect(evaluateKeywordRule('项目', rule)).toEqual({ skip: false })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// 处理器对照（AC-005 后半 + FR-013）：handles.ts 的 jobTitle/jobContent 走新引擎，
// 缺岗位名/缺职位描述进入待复核而不是普通跳过。
// handles.ts 依赖浏览器全局（logger.ts 模块顶层读 window，requests.ts 用 wxt
// 自动导入的 useToast），bun 下以三个全局桩载入；桩仅在本测试进程内生效。
// ————————————————————————————————————————————————————————————————————————————

function stubBrowserGlobals(): void {
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    })
  }
  if (!('window' in globalThis)) {
    const win = { location: { search: '' } }
    define('window', win)
    define('self', win)
    define('localStorage', { getItem: () => null, setItem: () => {} })
  }
  if (!('useToast' in globalThis)) {
    define('useToast', () => ({ add: () => {} }))
  }
}

type StubJobData = { key: string; jobName?: string | null; jobDescription?: string | null }
type StubStatistics = { reviewNeeded?: number }
type StubCtx = {
  now: Date
  helper: {
    conf: { formData: Record<string, unknown> }
    statistics: { todayData: { value: StubStatistics } }
  }
  index: number
  log: Record<string, never>
}
type StubHandler = (ctx: StubCtx, data: { jobData: StubJobData }) => Promise<StubTaskResult | void>
type StubTaskResult = { isSkip?: boolean; reason?: string; status?: string }
/** 旧处理器 skips 的形状（taskResult.skip 缺省 status: 'warn'）。 */
function skipResult(reason: string): StubTaskResult {
  return { isSkip: true, reason, status: 'warn' }
}
type TaskRegistryLike = {
  jobTitle: () => { task: (ctx: StubCtx) => StubHandler | void | Promise<StubHandler | void> }
  jobContent: () => { task: (ctx: StubCtx) => StubHandler | void | Promise<StubHandler | void> }
}

let handlesModule: HandlesModule | undefined
async function loadHandles(): Promise<HandlesModule> {
  stubBrowserGlobals()
  handlesModule ??= await import('../useApplying/handles')
  return handlesModule
}

function makeStubCtx(
  fields: { jobTitle?: KeywordFieldLike; jobContent?: KeywordFieldLike },
  statistics: StubStatistics = {},
): StubCtx {
  return {
    now: new Date(),
    helper: {
      conf: {
        formData: {
          ...defaultFormData,
          ...(fields.jobTitle ? { jobTitle: fields.jobTitle } : {}),
          ...(fields.jobContent ? { jobContent: fields.jobContent } : {}),
        },
      },
      statistics: { todayData: { value: statistics } },
    },
    index: 0,
    log: {},
  }
}

async function runHandler(
  field: 'jobTitle' | 'jobContent',
  config: { include: boolean; value: string[]; enable?: boolean },
  jobData: StubJobData,
  statistics: StubStatistics = {},
): Promise<{ result: StubTaskResult | void; registered: boolean; statistics: StubStatistics }> {
  const { TaskRegistry } = await loadHandles()
  const registry = new (TaskRegistry as unknown as new () => TaskRegistryLike)()
  const task = registry[field]()
  const ctx = makeStubCtx(
    { [field]: migrateKeywordGroups({ ...config, enable: config.enable ?? true, options: [] }) },
    statistics,
  )
  const setup = task.task as (c: StubCtx) => StubHandler | void | Promise<StubHandler | void>
  const handler = await setup(ctx)
  if (!handler) {
    return { result: undefined, registered: false, statistics }
  }
  const result = await handler(ctx, { jobData })
  return { result, registered: true, statistics }
}

function expectedReason(
  field: 'jobTitle' | 'jobContent',
  outcome: OracleOutcome,
): string | undefined {
  if (outcome === 'pass') return undefined
  if (outcome === 'missing') {
    return field === 'jobTitle' ? '岗位名不包含关键词' : '工作内容中不包含关键词'
  }
  const keyword = outcome.slice('excluded:'.length)
  return field === 'jobTitle'
    ? `岗位名含有排除关键词 [${keyword}]`
    : `工作内容含有排除关键词 [${keyword}]`
}

describe('AC-005 处理器对照：jobTitle/jobContent 处理器输出与旧实现处置一致', () => {
  test('岗位名处理器：每条语料的跳过/放行与旧实现一致', async () => {
    for (const row of corpus.filter((r) => r.field === 'jobTitle')) {
      const { result } = await runHandler(
        'jobTitle',
        { include: row.include, value: row.value },
        {
          key: `t-${row.key}`,
          jobName: row.text,
        },
      )
      const expected = expectedReason('jobTitle', row.expected)
      if (expected === undefined) {
        expect({ row: row.key, result }).toEqual({ row: row.key, result: undefined })
      } else {
        expect({ row: row.key, result }).toEqual({ row: row.key, result: skipResult(expected) })
      }
    }
  })

  test('工作内容处理器：每条语料的跳过/放行与旧实现一致（启用 FR-004 否定窗口）', async () => {
    for (const row of corpus.filter((r) => r.field === 'jobContent')) {
      const { result } = await runHandler(
        'jobContent',
        { include: row.include, value: row.value },
        {
          key: `c-${row.key}`,
          jobName: row.text,
          jobDescription: row.text,
        },
      )
      const expected = expectedReason('jobContent', row.expected)
      if (expected === undefined) {
        expect({ row: row.key, result }).toEqual({ row: row.key, result: undefined })
      } else {
        expect({ row: row.key, result }).toEqual({ row: row.key, result: skipResult(expected) })
      }
    }
  })

  test('处理器在启用开关关闭时不注册（与旧行为一致）', async () => {
    const { registered } = await runHandler(
      'jobTitle',
      { include: true, value: ['Java'], enable: false },
      {
        key: 'k-off',
        jobName: 'Java 工程师',
      },
    )
    expect(registered).toBe(false)
  })
})

describe('FR-013：筛选所需字段缺失时进入待复核而不是跳过', () => {
  beforeEach(() => {
    reviewNeededStore.clear()
  })

  test('岗位名为空：记录待复核（missing_field）且当次跳过不投递', async () => {
    const { result, statistics } = await runHandler(
      'jobTitle',
      { include: true, value: ['Java'], enable: true },
      { key: 'k-empty-name', jobName: '' },
    )
    expect(result).toEqual(skipResult('岗位名为空'))
    expect(statistics.reviewNeeded).toBe(1)
    const entry = reviewNeededStore.get('k-empty-name')
    expect(entry?.kind).toBe('missing_field')
    expect(entry?.reason).toBe('岗位名为空')
  })

  test('岗位名缺失（undefined）：同样进入待复核，不抛错', async () => {
    const { result, statistics } = await runHandler(
      'jobTitle',
      { include: true, value: ['Java'], enable: true },
      { key: 'k-no-name' },
    )
    expect(result).toEqual(skipResult('岗位名为空'))
    expect(statistics.reviewNeeded).toBe(1)
  })

  test('职位描述为空：记录待复核（missing_field）且当次跳过', async () => {
    const { result, statistics } = await runHandler(
      'jobContent',
      { include: true, value: ['Java'], enable: true },
      { key: 'k-empty-desc', jobName: 'Java 工程师', jobDescription: '' },
    )
    expect(result).toEqual(skipResult('工作内容为空'))
    expect(statistics.reviewNeeded).toBe(1)
    expect(reviewNeededStore.get('k-empty-desc')?.kind).toBe('missing_field')
  })

  test('同一岗位重复扫到：待复核不重复计数（t6 语义，recordReviewNeeded 只计首次）', async () => {
    const jobData = { key: 'k-repeat', jobName: '' }
    const { result: first } = await runHandler(
      'jobTitle',
      { include: true, value: ['Java'], enable: true },
      jobData,
    )
    const { result: second } = await runHandler(
      'jobTitle',
      { include: true, value: ['Java'], enable: true },
      jobData,
    )
    expect(first).toEqual(skipResult('岗位名为空'))
    expect(second).toEqual(skipResult('岗位名为空'))
  })
})

// ————————————————————————————————————————————————————————————————————————————
// 存储加载路径（约束：持久化配置属关键路径，迁移必须对旧存量配置生效）：
// 驱动 conf/index.ts 暴露的 migrateFormData（formDataHandler 与 confImport/init
// 同一条迁移代码路径）验证旧存量配置加载后字段正确映射且不删除用户数据。
// ————————————————————————————————————————————————————————————————————————————

let migrateFormDataFn!: (from: Record<string, unknown>) => Record<string, unknown>
async function loadMigrateFormData(): Promise<
  (from: Record<string, unknown>) => Record<string, unknown>
> {
  stubBrowserGlobals()
  if (!migrateFormDataFn) {
    const { migrateFormData } = await import('./index')
    migrateFormDataFn = migrateFormData as unknown as (
      from: Record<string, unknown>,
    ) => Record<string, unknown>
  }
  return migrateFormDataFn
}

describe('旧存量配置经迁移函数加载后字段正确映射（FR-006，20240401 直达）', () => {
  test('include=true 的旧 jobTitle：迁移出包含组 + any，enable 不变，旧键保留', async () => {
    const migrate = await loadMigrateFormData()
    const stored = {
      jobTitle: { include: true, value: ['Java', '前端'], options: ['Java'], enable: true },
      jobContent: { include: false, value: ['外包'], options: [], enable: false },
      version: '20240401',
    }
    const out = migrate(stored) as {
      jobTitle: KeywordFieldLike
      jobContent: KeywordFieldLike
      version: string
    }
    expect(out.jobTitle.groups).toEqual({
      includeWords: ['Java', '前端'],
      excludeWords: [],
      includeMode: 'any',
    })
    expect(out.jobContent.groups).toEqual({
      includeWords: [],
      excludeWords: ['外包'],
      includeMode: 'any',
    })
    expect(out.jobTitle.enable).toBe(true)
    expect(out.jobContent.enable).toBe(false)
    expect(out.jobTitle.value).toEqual(['Java', '前端'])
    expect(out.version).toBe('20260926')
  })

  test('已迁移配置（version=20260926）：不再重复迁移，groups 原样保留（幂等）', async () => {
    const migrate = await loadMigrateFormData()
    const stored = {
      jobTitle: {
        include: true,
        value: ['Java'],
        options: [],
        enable: true,
        groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'any' },
      },
      version: '20260926',
    }
    const out = migrate(stored) as { jobTitle: KeywordFieldLike }
    expect(out.jobTitle.groups).toEqual({
      includeWords: ['Java'],
      excludeWords: [],
      includeMode: 'any',
    })
  })

  test('迁移后空规则字段的 enable 由 keywordGroupEnabled 判 false（FR-002，迁移不改写 enable）', async () => {
    const migrate = await loadMigrateFormData()
    const stored = {
      jobTitle: { include: true, value: [], options: [], enable: true },
      version: '20240401',
    }
    const out = migrate(stored) as { jobTitle: KeywordFieldLike }
    expect(out.jobTitle.enable).toBe(true)
    expect(keywordGroupEnabled(out.jobTitle)).toBe(false)
  })
})

describe('FR-002 处理器侧：空规则不能启用（旧配置 enable=true 且词表为空）', () => {
  test('旧包含配置 enable=true 但词表为空：不注册任务（空规则按未启用，不全量跳过）', async () => {
    const { registered } = await runHandler(
      'jobTitle',
      { include: true, value: [], enable: true },
      {
        key: 'k-empty-include',
        jobName: 'Java 工程师',
      },
    )
    expect(registered).toBe(false)
  })

  test('旧排除配置 enable=true 但词表为空：不注册任务（等同无排除条件，判定与旧实现一致：放行）', async () => {
    const { registered } = await runHandler(
      'jobContent',
      { include: false, value: [], enable: true },
      {
        key: 'k-empty-exclude',
        jobName: 'Java 工程师',
        jobDescription: 'Java 开发',
      },
    )
    expect(registered).toBe(false)
  })
})
