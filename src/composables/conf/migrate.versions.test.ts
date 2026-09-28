import { describe, expect, test } from 'bun:test'

import { defaultFormData } from './info'

/**
 * 存量配置逐级迁移（FROM_VERSION 四个版本器）的行为测试。
 * 期望值来自各版本器的迁移契约与 defaultFormData（info.ts），不出自实现：
 *  - 20250826：字符串 'min-max' 区间 -> [min, max, false]（已是数组则不动）
 *  - 20260521：字符串提示词 -> 单条 user 消息；缺 prompt 时按 defaultFormData 重建；jobAddress.include=true
 *  - 20260718：delay<Key> 展开到顶层，删除 delay
 *  - 20260926：关键词组（组内细节见 migrate.test.ts）
 * 版本边界：存量 version 达到即停、更高版本不降级、缺失按 20240401 处理。
 */

function stubBrowserGlobals(): void {
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
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

type Migration = (from: Record<string, unknown>) => Record<string, unknown>
let migration: Migration | undefined
async function loadMigration(): Promise<Migration> {
  stubBrowserGlobals()
  migration ??= (await import('./index')).migrateFormData as unknown as Migration
  return migration
}

type RangeField = { value: unknown; enable?: boolean }
type AiField = { enable?: boolean; score?: number; prompt: unknown }

describe('20250826：字符串区间迁移为 [min, max, false]', () => {
  test('pre-20250826 存量配置经公开迁移路径：字符串区间/字符串提示词/嵌套 delay 全部落到当前形状', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20240401',
      salaryRange: { value: '10-20', enable: true },
      companySizeRange: { value: '100-500', enable: false },
      aiFiltering: { enable: true, score: 7, prompt: '旧筛选提示' },
      aiGreeting: { enable: true, prompt: '旧招呼提示' },
      jobAddress: { value: ['北京'], options: ['北京'], enable: true, include: false },
      delay: { deliveryStarts: 3, deliveryInterval: 5, deliveryPageNext: 60, messageSending: 2 },
    }
    const out = migrate(stored) as {
      salaryRange: RangeField
      companySizeRange: RangeField
      aiFiltering: AiField
      aiGreeting: AiField
      jobAddress: { value: string[]; options: string[]; enable: boolean; include: boolean }
      delayDeliveryStarts: number
      delayDeliveryInterval: number
      delayDeliveryPageNext: number
      delayMessageSending: number
      version: string
    }
    expect(out.salaryRange.value).toEqual([10, 20, false])
    expect(out.companySizeRange.value).toEqual([100, 500, false])
    expect(out.aiFiltering).toEqual({
      enable: true,
      score: 7,
      prompt: [{ role: 'user', content: '旧筛选提示' }],
    })
    expect(out.aiGreeting).toEqual({
      enable: true,
      prompt: [{ role: 'user', content: '旧招呼提示' }],
    })
    expect(out.jobAddress).toEqual({
      value: ['北京'],
      options: ['北京'],
      enable: true,
      include: true,
    })
    expect(out.delayDeliveryStarts).toBe(3)
    expect(out.delayDeliveryInterval).toBe(5)
    expect(out.delayDeliveryPageNext).toBe(60)
    expect(out.delayMessageSending).toBe(2)
    expect('delay' in out).toBe(false)
    expect(out.version).toBe('20260926')
  })

  test('已是 [min, max, flag] 数组的区间值原样保留（只迁移字符串形态）', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20250825',
      salaryRange: { value: [8, 13, true], enable: true },
      companySizeRange: { value: [500, 2000, true], enable: true },
    }
    const out = migrate(stored) as { salaryRange: RangeField; companySizeRange: RangeField }
    expect(out.salaryRange).toEqual({ value: [8, 13, true], enable: true })
    expect(out.companySizeRange).toEqual({ value: [500, 2000, true], enable: true })
  })

  test('缺失区间字段时不新增键', async () => {
    const migrate = await loadMigration()
    const out = migrate({ version: '20250825' })
    expect('salaryRange' in out).toBe(false)
    expect('companySizeRange' in out).toBe(false)
  })
})

describe('20260521：提示词字符串 -> 单条 user 消息 / 缺省按默认重建', () => {
  test('字符串提示词迁移为单条 user 消息，enable/score 保留', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20260520',
      aiFiltering: { enable: true, score: 7, prompt: '旧筛选提示' },
      aiGreeting: { enable: true, prompt: '旧招呼提示' },
    }
    const out = migrate(stored) as { aiFiltering: AiField; aiGreeting: AiField }
    expect(out.aiFiltering).toEqual({
      enable: true,
      score: 7,
      prompt: [{ role: 'user', content: '旧筛选提示' }],
    })
    expect(out.aiGreeting).toEqual({
      enable: true,
      prompt: [{ role: 'user', content: '旧招呼提示' }],
    })
  })

  test('已是消息数组的提示词原样保留（不重复包装）', async () => {
    const migrate = await loadMigration()
    const prompt = [{ role: 'system', content: '既有提示' }]
    const stored = { version: '20260520', aiFiltering: { enable: false, prompt } }
    const out = migrate(stored) as { aiFiltering: AiField }
    expect(out.aiFiltering.prompt).toEqual([{ role: 'system', content: '既有提示' }])
  })

  test('缺 prompt 时按 defaultFormData 重建提示词，保留其余字段', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20260520',
      aiFiltering: { enable: true, score: 7 },
      aiGreeting: { enable: true },
    }
    const out = migrate(stored) as { aiFiltering: AiField; aiGreeting: AiField }
    expect(out.aiFiltering.prompt).toEqual(defaultFormData.aiFiltering.prompt)
    expect(out.aiFiltering.enable).toBe(true)
    expect(out.aiFiltering.score).toBe(7)
    expect(out.aiGreeting.prompt).toEqual(defaultFormData.aiGreeting.prompt)
    expect(out.aiGreeting.enable).toBe(true)
  })

  test('aiFiltering/aiGreeting 整体缺失时补默认形态', async () => {
    const migrate = await loadMigration()
    const out = migrate({ version: '20260520' }) as { aiFiltering: AiField; aiGreeting: AiField }
    expect(out.aiFiltering).toEqual(defaultFormData.aiFiltering)
    expect(out.aiGreeting).toEqual(defaultFormData.aiGreeting)
  })

  test('jobAddress 存在时补 include=true 并保留其他键；缺失时不新增', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20260520',
      jobAddress: { value: ['北京'], options: ['北京'], enable: true, include: false },
    }
    const out = migrate(stored) as { jobAddress: Record<string, unknown> }
    expect(out.jobAddress).toEqual({
      value: ['北京'],
      options: ['北京'],
      enable: true,
      include: true,
    })
    expect('jobAddress' in migrate({ version: '20260520' })).toBe(false)
  })
})

describe('20260718：delay<Key> 展开到顶层并删除 delay', () => {
  test('delay 各键以 delay<Key> 落到顶层（覆盖已有值），delay 键被删除', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20260717',
      delayDeliveryStarts: 99,
      delay: { deliveryStarts: 3, deliveryInterval: 5, deliveryPageNext: 60, messageSending: 2 },
    }
    const out = migrate(stored) as {
      delayDeliveryStarts: number
      delayDeliveryInterval: number
      delayDeliveryPageNext: number
      delayMessageSending: number
    }
    expect(out.delayDeliveryStarts).toBe(3)
    expect(out.delayDeliveryInterval).toBe(5)
    expect(out.delayDeliveryPageNext).toBe(60)
    expect(out.delayMessageSending).toBe(2)
    expect('delay' in out).toBe(false)
  })

  test('delay 缺失或不是对象时原样返回（不新增顶层键、不改写值）', async () => {
    const migrate = await loadMigration()
    const withoutDelay = migrate({ version: '20260717' })
    expect('delay' in withoutDelay).toBe(false)
    expect('delayDeliveryStarts' in withoutDelay).toBe(false)

    const scalarDelay = migrate({ version: '20260717', delay: 5 })
    expect(scalarDelay.delay).toBe(5)
  })
})

describe('版本边界：达到即停、不降级、缺失按 20240401', () => {
  test('version=20260718：已达版本不重跑，只有更晚的 20260926 关键词组迁移生效', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20260718',
      salaryRange: { value: '10-20', enable: false },
      jobAddress: { value: [], options: [], enable: false, include: false },
      delay: { deliveryStarts: 3 },
      jobTitle: { include: false, value: ['外包'], options: [], enable: true },
    }
    const out = migrate(stored) as {
      salaryRange: RangeField
      jobAddress: { include: boolean }
      delay: Record<string, number>
      jobTitle: { groups: Record<string, unknown> }
      version: string
    }
    expect(out.salaryRange.value).toBe('10-20')
    expect(out.jobAddress.include).toBe(false)
    expect(out.delay).toEqual({ deliveryStarts: 3 })
    expect(out.jobTitle.groups).toEqual({
      includeWords: [],
      excludeWords: ['外包'],
      includeMode: 'any',
    })
    expect(out.version).toBe('20260926')
  })

  test('version=20260926：不再迁移，区间字符串与既有 groups 原样保留', async () => {
    const migrate = await loadMigration()
    const stored = {
      version: '20260926',
      salaryRange: { value: '10-20', enable: false },
      jobTitle: {
        include: true,
        value: ['Java'],
        options: [],
        enable: true,
        groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'any' },
      },
    }
    const out = migrate(stored) as {
      salaryRange: RangeField
      jobTitle: { groups: Record<string, unknown> }
      version: string
    }
    expect(out.salaryRange.value).toBe('10-20')
    expect(out.jobTitle.groups).toEqual({
      includeWords: ['Java'],
      excludeWords: [],
      includeMode: 'any',
    })
    expect(out.version).toBe('20260926')
  })

  test('高于所有版本器的 version 不被降级，也不做任何迁移', async () => {
    const migrate = await loadMigration()
    const out = migrate({
      version: '20279999',
      salaryRange: { value: '10-20', enable: false },
    }) as {
      salaryRange: RangeField
      version: string
    }
    expect(out.salaryRange.value).toBe('10-20')
    expect(out.version).toBe('20279999')
  })

  test('缺失 version 视为 20240401：全部版本器补跑', async () => {
    const migrate = await loadMigration()
    const out = migrate({
      salaryRange: { value: '10-20', enable: false },
      delay: { deliveryStarts: 3 },
    }) as { salaryRange: RangeField; delayDeliveryStarts: number; version: string }
    expect(out.salaryRange.value).toEqual([10, 20, false])
    expect(out.delayDeliveryStarts).toBe(3)
    expect(out.version).toBe('20260926')
  })
})
