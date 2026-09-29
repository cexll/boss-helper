import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { ConfigLevel, JevConfig } from '@/types/formData'

import type * as ConfNamespace from './index'
import { defaultFormData } from './info'

/**
 * conf/index.ts 的 useConf 存储读写与预设行为测试（公开接口驱动）：
 *  - init：默认/存量加载、读存储失败进 catch（配置加载失败 toast + isLoading 复位）
 *  - confSaving：三处存储写入 + 成功 toast / 写失败 toast 且原样抛出
 *  - confReload / confImport / confExport：读取路径（exportJson 收到迁移后形状）
 *  - confDelete / confRecommend：字段复位与推荐子集（含 toast）
 *  - createPreset / switchPreset：预设创建/切换及其失败分支
 *  - configLevel computed 的门槛映射、formDataKey 的预设键
 *
 * '@/message' 与 '@/utils/jsonImportExport' 以受控桩替身（受控 Map + 可注入失败）：
 * 桩变量在本文件作用域，失败注入用于驱动 catch 分支，不吞读写失败。
 */

const storageMap = new Map<string, unknown>()
type ToastOptions = { title?: string; color?: string }
let toasts: ToastOptions[] = []
let failGet = false
let failSet = false
let exportedJson: unknown
let importPayload: unknown

async function primeMockedModules(): Promise<void> {
  await import('@/message')
  await import('@/utils/jsonImportExport')
}

function mockMessage(): void {
  void mock.module('@/message', () => ({
    counter: {
      storageGet: async (key: string, fallback?: unknown) => {
        if (failGet) throw new Error('storageGet boom')
        return storageMap.has(key) ? storageMap.get(key) : fallback
      },
      storageSet: async (key: string, value: unknown) => {
        if (failSet) throw new Error('storageSet boom')
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
  define('useToast', () => ({
    add: (options: ToastOptions) => {
      toasts.push(options)
    },
  }))
}

type ConfModule = typeof ConfNamespace
let confModule: ConfModule | undefined
async function loadConf(): Promise<ConfModule> {
  stubBrowserGlobals()
  confModule ??= await import('./index')
  return confModule
}

type ConfInstance = ReturnType<ConfModule['useConf']>
const FORM_DATA_KEY = 'local:web-geek-job-FormData'

async function freshConf(): Promise<ConfInstance> {
  const conf = (await loadConf()).useConf()
  await conf.confInit()
  return conf
}

describe('useConf.init：读取配置与失败分支', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    toasts = []
    failGet = false
    failSet = false
    exportedJson = undefined
    importPayload = undefined
  })

  test('空存储：init 加载默认配置、isLoading 复位、预设为 default', async () => {
    const conf = await freshConf()
    expect(conf.isLoading.value).toBe(false)
    expect(conf.formData.version).toBe('20260926')
    expect(conf.formData.deliveryLimit.value).toBe(120)
    expect(conf.formDataPreset.value).toBe('default')
  })

  test('存储中的预设名与列表被 init 读取', async () => {
    storageMap.set('local:FormDataPrese', 'p-1')
    storageMap.set('local:FormDataPreses', [{ label: '一', value: 'p-1' }])
    const conf = await freshConf()
    expect(conf.formDataPreset.value).toBe('p-1')
    expect(conf.formDataPresets.value).toEqual([{ label: '一', value: 'p-1' }])
  })

  test('读存储抛错：走 catch 分支（toast error），isLoading 仍复位、配置保持默认', async () => {
    failGet = true
    const conf = (await loadConf()).useConf()
    await conf.confInit()
    expect(conf.isLoading.value).toBe(false)
    expect(toasts.some((t) => t.title?.startsWith('配置加载失败') && t.color === 'error')).toBe(
      true,
    )
    expect(conf.formData.deliveryLimit.value).toBe(120)
  })

  test('存储的配置是 null（迁移必抛）：toast 用户配置初始化失败，isLoading 复位、配置保持默认', async () => {
    storageMap.set(FORM_DATA_KEY, null)
    const conf = (await loadConf()).useConf()
    await conf.confInit()
    expect(conf.isLoading.value).toBe(false)
    expect(
      toasts.some((t) => t.title?.startsWith('用户配置初始化失败') && t.color === 'error'),
    ).toBe(true)
    expect(conf.formData.deliveryLimit.value).toBe(120)
  })
})

describe('useConf.confSaving：写入与失败', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    toasts = []
    failGet = false
    failSet = false
    importPayload = undefined
  })

  test('成功：三处存储键写入且提示保存成功', async () => {
    const conf = await freshConf()
    await conf.confSaving()
    expect(storageMap.has(FORM_DATA_KEY)).toBe(true)
    expect(storageMap.has('local:FormDataPrese')).toBe(true)
    expect(storageMap.has('local:FormDataPreses')).toBe(true)
    expect(
      (storageMap.get(FORM_DATA_KEY) as { deliveryLimit: { value: number } }).deliveryLimit.value,
    ).toBe(120)
    expect(toasts.some((t) => t.title === '保存成功' && t.color === 'success')).toBe(true)
  })

  test('F-037：空方向的启用态 Jev 在落盘门前强制回禁用', async () => {
    const conf = await freshConf()
    conf.formData.jev = { enable: true, targetDirection: '' }
    await conf.confSaving()
    expect((storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }).jev).toEqual({
      enable: false,
      targetDirection: '',
    })
  })

  test('F-037 回归：已填方向的启用态原样落盘；无 jev 键不新增键', async () => {
    const conf = await freshConf()
    conf.formData.jev = { enable: true, targetDirection: '前端开发' }
    await conf.confSaving()
    expect((storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }).jev).toEqual({
      enable: true,
      targetDirection: '前端开发',
    })

    const noJev = await freshConf()
    delete noJev.formData.jev
    await noJev.confSaving()
    expect('jev' in (storageMap.get(FORM_DATA_KEY) as Record<string, unknown>)).toBe(false)
  })

  test('F-037：导入坏形状（启用 + 空方向）后手动保存归一化落盘', async () => {
    importPayload = { version: '20260718', jev: { enable: true, targetDirection: '   ' } }
    const conf = await freshConf()
    await conf.confImport()
    expect(conf.formData.jev).toEqual({ enable: true, targetDirection: '   ' }) // 读路径不改语义（F-023/F-024）
    await conf.confSaving()
    expect((storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }).jev).toEqual({
      enable: false,
      targetDirection: '   ',
    })
  })

  test('写失败：toast 保存失败并原样抛出存储错误', async () => {
    const conf = await freshConf()
    failSet = true
    let thrown: unknown
    try {
      await conf.confSaving()
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error).message).toBe('storageSet boom')
    expect(toasts.some((t) => t.title === '保存失败: storageSet boom' && t.color === 'error')).toBe(
      true,
    )
  })
})

describe('useConf.confReload / confExport / confImport：同一读取迁移路径', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    toasts = []
    failGet = false
    failSet = false
    exportedJson = undefined
    importPayload = undefined
  })

  test('confReload：从存储重载并提示重置成功', async () => {
    storageMap.set(FORM_DATA_KEY, {
      version: '20260718',
      deliveryLimit: { value: 5 },
    })
    const conf = await freshConf()
    conf.formData.deliveryLimit.value = 999
    await conf.confReload()
    expect(conf.formData.deliveryLimit.value).toBe(5)
    expect(toasts.some((t) => t.title === '重置成功' && t.color === 'success')).toBe(true)
  })

  test('confExport：exportJson 收到迁移后的形状（旧区间字符串已转数组）', async () => {
    storageMap.set(FORM_DATA_KEY, {
      version: '20240401',
      salaryRange: { value: '10-20', enable: false },
    })
    const conf = await freshConf()
    await conf.confExport()
    expect((exportedJson as { salaryRange: { value: unknown } }).salaryRange.value).toEqual([
      10,
      20,
      false,
    ])
  })

  test('confImport：导入数据走迁移后合并进 formData，提示手动保存', async () => {
    importPayload = { version: '20240401', salaryRange: { value: '10-20', enable: true } }
    const conf = await freshConf()
    await conf.confImport()
    expect(conf.formData.salaryRange.value).toEqual([10, 20, false])
    expect(conf.formData.salaryRange.enable).toBe(true)
    expect(toasts.some((t) => t.title === '导入成功, 切记要手动保存哦')).toBe(true)
  })
})

describe('useConf.confDelete / confRecommend：字段复位与推荐子集', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    toasts = []
    failGet = false
    failSet = false
  })

  test('confDelete：改动过的字段逐项复位为默认、不写存储并提示清空成功', async () => {
    const conf = await freshConf()
    conf.formData.deliveryLimit.value = 999
    conf.formData.activityFilter.value = false
    conf.formData.configLevel = 'expert'
    conf.formData.customGreeting.value = '自定义'
    conf.formData.salaryRange.value = [1, 2, true]
    conf.formData.jobTitle.enable = true
    conf.confDelete()
    expect(conf.formData.deliveryLimit.value).toBe(defaultFormData.deliveryLimit.value)
    expect(conf.formData.activityFilter.value).toBe(defaultFormData.activityFilter.value)
    expect(conf.formData.configLevel as ConfigLevel).toBe(defaultFormData.configLevel)
    expect(conf.formData.customGreeting.value).toBe(defaultFormData.customGreeting.value as string)
    expect(conf.formData.salaryRange.value).toEqual(defaultFormData.salaryRange.value)
    expect(conf.formData.jobTitle.enable).toBe(defaultFormData.jobTitle.enable)
    expect(storageMap.size).toBe(0) // toast 声明「不会自动保存」：不得落盘
    expect(toasts.some((t) => t.title?.startsWith('配置清空成功'))).toBe(true)
  })

  test('confRecommend：9 个推荐键回到默认，无关字段保持用户改动', async () => {
    const conf = await freshConf()
    conf.formData.deliveryLimit.value = 999
    conf.formData.activityFilter.value = false
    conf.formData.friendStatus.value = false
    conf.formData.sameCompanyFilter.value = true
    conf.formData.sameHrFilter.value = false
    conf.formData.goldHunterFilter.value = true
    conf.formData.notification.value = false
    conf.formData.useCache.value = true
    conf.formData.jobAddress.value = ['上海']
    conf.formData.customGreeting.value = '自定义'
    conf.confRecommend()
    expect(conf.formData.deliveryLimit).toEqual(defaultFormData.deliveryLimit)
    expect(conf.formData.activityFilter).toEqual(defaultFormData.activityFilter)
    expect(conf.formData.friendStatus).toEqual(defaultFormData.friendStatus)
    expect(conf.formData.sameCompanyFilter).toEqual(defaultFormData.sameCompanyFilter)
    expect(conf.formData.sameHrFilter).toEqual(defaultFormData.sameHrFilter)
    expect(conf.formData.goldHunterFilter).toEqual(defaultFormData.goldHunterFilter)
    expect(conf.formData.notification).toEqual(defaultFormData.notification)
    expect(conf.formData.useCache).toEqual(defaultFormData.useCache)
    // 推荐子集之外的键不得被复位
    expect(conf.formData.jobAddress.value).toEqual(['上海'])
    expect(conf.formData.customGreeting.value).toBe('自定义')
    expect(toasts.some((t) => t.title?.startsWith('推荐配置已应用'))).toBe(true)
  })
})

describe('useConf.createPreset / switchPreset：预设创建与切换', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    toasts = []
    failGet = false
    failSet = false
  })

  test('createPreset：追加预设、切换当前预设并落盘三处', async () => {
    const conf = await freshConf()
    await conf.createPreset('工作日')
    const created = conf.formDataPresets.value.find((p) => p.label === '工作日')
    expect(created).toBeDefined()
    expect(conf.formDataPreset.value).toBe(created!.value)
    expect(storageMap.get('local:FormDataPrese')).toBe(created!.value)
    expect(storageMap.has(`local:web-geek-job-FormData-${created!.value}`)).toBe(true)
    expect(conf.isLoading.value).toBe(false)
    expect(toasts.some((t) => t.title === '预设创建成功' && t.color === 'success')).toBe(true)
  })

  test('createPreset 写失败：toast 预设创建失败，isLoading 仍复位', async () => {
    const conf = await freshConf()
    failSet = true
    await conf.createPreset('会失败')
    expect(toasts.some((t) => t.title?.startsWith('预设创建失败') && t.color === 'error')).toBe(
      true,
    )
    expect(conf.isLoading.value).toBe(false)
  })

  test('switchPreset：切换键并从该预设的存储重载配置', async () => {
    const conf = await freshConf()
    storageMap.set('local:web-geek-job-FormData-p-2', {
      version: '20260718',
      deliveryLimit: { value: 7 },
    })
    await conf.switchPreset('p-2')
    expect(conf.formDataPreset.value).toBe('p-2')
    expect(conf.formData.deliveryLimit.value).toBe(7)
    expect(storageMap.get('local:FormDataPrese')).toBe('p-2')
  })

  test('switchPreset 写失败：toast 预设切换失败并复位 isLoading', async () => {
    const conf = await freshConf()
    failSet = true
    await conf.switchPreset('p-3')
    expect(toasts.some((t) => t.title?.startsWith('预设切换失败') && t.color === 'error')).toBe(
      true,
    )
    expect(conf.isLoading.value).toBe(false)
  })
})

describe('useConf.configLevel / formDataKey：等级门槛与预设键', () => {
  beforeEach(async () => {
    await primeMockedModules()
    mockMessage()
    mockJsonImportExport()
    storageMap.clear()
    toasts = []
    failGet = false
    failSet = false
  })

  test('configLevel 门槛：beginner 全关、advanced 开两级、expert 全开', async () => {
    const conf = await freshConf()
    conf.formData.configLevel = 'beginner'
    expect(conf.configLevel).toEqual({ intermediate: false, advanced: false, expert: false })
    conf.formData.configLevel = 'advanced'
    expect(conf.configLevel).toEqual({ intermediate: true, advanced: true, expert: false })
    conf.formData.configLevel = 'expert'
    expect(conf.configLevel).toEqual({ intermediate: true, advanced: true, expert: true })
  })

  test('formDataKey：default 用固定键，自定义预设用带后缀键', async () => {
    const conf = await freshConf()
    conf.formDataPreset.value = 'default'
    expect(conf.formDataKey()).toBe(FORM_DATA_KEY)
    conf.formDataPreset.value = 'mine'
    expect(conf.formDataKey()).toBe('local:web-geek-job-FormData-mine')
    conf.formDataPreset.value = 'default'
  })
})
