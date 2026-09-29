import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type * as HandlesNamespace from '../useApplying/handles'
import { evaluateKeywordRule } from '../useApplying/keywordMatch'
import type * as ConfNamespace from './index'
import { defaultFormData } from './info'
import { keywordGroupEnabled, keywordRuleOf, migrateKeywordGroups } from './migrate'
import type { KeywordFieldLike } from './migrate'

/**
 * 持久化配置关键路径（评审 F-001 / F-002 / F-005 的注册与读取侧）：
 * 驱动真实的 confReload / confExport / confImport 与 jobTitle/jobContent 注册门控。
 *
 * '@/message' 与 '@/utils/jsonImportExport' 的桩只替身本文件的模块解析：先按真实
 * 模块导入一次（保证这两个文件进入覆盖率工件），再以 mock.module 覆盖后续导入；
 * 兜底桩一律注入受控 Map，不会静默吞掉读写失败。
 */

const storageMap = new Map<string, unknown>()
let exportedJson: unknown
let importPayload: unknown

async function primeMockedModules(): Promise<void> {
  await import('@/message')
  await import('@/utils/jsonImportExport')
}

function mockMessage(): void {
  void mock.module('@/message', () => ({
    counter: {
      storageGet: async (key: string, fallback?: unknown) =>
        storageMap.has(key) ? storageMap.get(key) : fallback,
      storageSet: async (key: string, value: unknown) => {
        storageMap.set(key, value)
        return true
      },
      storageRm: async (key: string) => {
        storageMap.delete(key)
        return true
      },
    },
    ExtStorage: {
      getItem: async (key: string) => (storageMap.has(key) ? storageMap.get(key) : null),
      setItem: async (key: string, value: unknown) => {
        storageMap.set(key, value)
      },
      removeItem: async (key: string) => {
        storageMap.delete(key)
      },
    },
  }))
}

function mockJsonImportExport(): void {
  void mock.module('@/utils/jsonImportExport', () => ({
    exportJson: (data: object) => {
      exportedJson = data
    },
    importJson: async () => importPayload,
  }))
}

type ConfModule = typeof ConfNamespace
let confModule: ConfModule | undefined
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
async function loadConf(): Promise<typeof ConfNamespace> {
  stubBrowserGlobals()
  confModule ??= await import('./index')
  return confModule
}

/** 评审复现用的旧存量配置：version < '20260926'，只有 include/value/enable 旧键。 */
const legacyStoredConfig = () => ({
  version: '20260718',
  jobTitle: { include: false, value: ['外包', '销售'], options: [], enable: true },
})

type ConfInstance = ReturnType<(typeof ConfNamespace)['useConf']>
const titleRuleOf = (conf: ConfInstance) => keywordRuleOf(conf.formData.jobTitle)
const titleEnabled = (conf: ConfInstance): boolean => keywordGroupEnabled(conf.formData.jobTitle)

describe('F-001：confReload/confExport/confImport 与 init 走同一迁移（旧存量配置不丢关键词组）', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    exportedJson = undefined
    importPayload = undefined
  })

  test('confReload：旧存量配置重载后 groups 完成迁移且排除语义生效', async () => {
    storageMap.set('local:web-geek-job-FormData', legacyStoredConfig())
    const conf = (await loadConf()).useConf()
    await conf.confReload()
    expect(conf.formData.jobTitle.groups).toEqual({
      includeWords: [],
      excludeWords: ['外包', '销售'],
      includeMode: 'any',
    })
    expect(conf.formData.jobTitle.value).toEqual(['外包', '销售']) // 旧键保留
    expect(conf.formData.version).toBe('20260926')
    expect(titleEnabled(conf)).toBe(true)
    expect(evaluateKeywordRule('java 外包工程师', titleRuleOf(conf))).toEqual({
      skip: true,
      reason: 'excluded',
      keyword: '外包',
    })
    expect(evaluateKeywordRule('java 工程师', titleRuleOf(conf))).toEqual({ skip: false })
  })

  test('confExport：导出迁移后的配置形状（groups 已生成，导入端不依赖二次迁移）', async () => {
    storageMap.set('local:web-geek-job-FormData', legacyStoredConfig())
    const conf = (await loadConf()).useConf()
    await conf.confExport()
    const exported = exportedJson as { version: string; jobTitle: KeywordFieldLike }
    expect(exported.jobTitle.groups).toEqual({
      includeWords: [],
      excludeWords: ['外包', '销售'],
      includeMode: 'any',
    })
    expect(exported.version).toBe('20260926')
  })

  test('confImport：导入旧存量配置后 groups 完成迁移（钉住既有 formDataHandler 路径）', async () => {
    importPayload = legacyStoredConfig()
    const conf = (await loadConf()).useConf()
    await conf.confImport()
    expect(conf.formData.jobTitle.groups).toEqual({
      includeWords: [],
      excludeWords: ['外包', '销售'],
      includeMode: 'any',
    })
    expect(titleEnabled(conf)).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————————————————
// 处理器注册门控（评审 F-002 冲突 / F-005 损坏 groups）：真实 TaskRegistry 注册判定。
// ————————————————————————————————————————————————————————————————————————————

type StubJobData = { key: string; jobName?: string | null; jobDescription?: string | null }
type StubCtx = {
  now: Date
  helper: { conf: { formData: Record<string, unknown> } }
  index: number
  log: Record<string, never>
}

type StubHandler = (ctx: StubCtx, data: { jobData: StubJobData }) => Promise<unknown>

async function loadHandles(): Promise<typeof HandlesNamespace> {
  stubBrowserGlobals()
  return import('../useApplying/handles')
}

function makeStubCtx(field: 'jobTitle' | 'jobContent', rawField: KeywordFieldLike): StubCtx {
  return {
    now: new Date(),
    helper: {
      conf: { formData: { ...defaultFormData, [field]: rawField } },
    },
    index: 0,
    log: {},
  }
}

async function isRegistered(
  field: 'jobTitle' | 'jobContent',
  rawField: KeywordFieldLike,
): Promise<boolean> {
  const { TaskRegistry } = await loadHandles()
  const registry = new TaskRegistry()
  const setup = registry[field]().task as unknown as (
    c: StubCtx,
  ) => StubHandler | void | Promise<StubHandler | void>
  return Boolean(await setup(makeStubCtx(field, rawField)))
}

/** 旧配置形状的字段工厂（与 migrate.test.ts 同口径：旧键齐全、enable 缺省关闭）。 */
const legacyField = (over: Partial<KeywordFieldLike>): KeywordFieldLike => ({
  include: true,
  value: [],
  options: [],
  enable: false,
  ...over,
})

describe('注册门控（持久化配置侧）：冲突与损坏形状不注册任务', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    storageMap.clear()
  })

  test('F-002：同词同在包含/排除组（冲突）→ jobTitle/jobContent 均不注册', async () => {
    const field = migrateKeywordGroups(
      legacyField({
        enable: true,
        groups: { includeWords: ['外包'], excludeWords: ['外包'], includeMode: 'any' },
      }),
    )
    expect(await isRegistered('jobTitle', field)).toBe(false)
    expect(await isRegistered('jobContent', field)).toBe(false)
  })

  test('F-005：损坏 groups（{}）归一为空规则 → 不注册任务且不抛错', async () => {
    const field = migrateKeywordGroups(
      legacyField({ value: ['外包'], enable: true, groups: {} as never }),
    )
    expect(await isRegistered('jobTitle', field)).toBe(false)
  })

  test('F-005：经 migrateFormData 加载的损坏 groups 归一为良构组，处理器不再收到会抛错的规则', async () => {
    const { migrateFormData } = await loadConf()
    const stored = {
      jobTitle: { include: false, value: ['外包'], options: [], enable: true, groups: {} },
      jobContent: {
        include: false,
        value: ['上门'],
        options: [],
        enable: true,
        groups: { includeWords: null, excludeWords: ['上门'], includeMode: 'any' },
      },
      version: '20240401',
    }
    const out = migrateFormData(stored as never) as {
      jobTitle: KeywordFieldLike
      jobContent: KeywordFieldLike
    }
    expect(out.jobTitle.groups).toEqual({ includeWords: [], excludeWords: [], includeMode: 'any' })
    expect(keywordGroupEnabled(out.jobTitle)).toBe(false)
    expect(await isRegistered('jobTitle', out.jobTitle)).toBe(false)
    expect(out.jobContent.groups).toEqual({
      includeWords: [],
      excludeWords: ['上门'],
      includeMode: 'any',
    })
    expect(keywordGroupEnabled(out.jobContent)).toBe(true)
    expect(evaluateKeywordRule('外包岗位', keywordRuleOf(out.jobTitle))).toEqual({
      skip: true,
      reason: 'missing',
    })
  })
})
