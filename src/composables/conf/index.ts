import { reactiveComputed, useStorageAsync, watchThrottled } from '@vueuse/core'
import { reactive, ref, toRaw } from 'vue'

import { counter } from '@/message'
import { ExtStorage } from '@/message'
import type { ConfigLevel, FormData } from '@/types/formData'
import deepmerge, { jsonClone } from '@/utils/deepmerge'
import { exportJson, importJson } from '@/utils/jsonImportExport'
import { logger } from '@/utils/logger'

import { defaultFormData } from './info'
import { migrateKeywordFields, normalizeJevConfig } from './migrate'

export * from './info'

const formDataPresetKey = 'local:FormDataPrese'
const formDataPresetsKey = 'local:FormDataPreses'

export const appearanceConf = useStorageAsync(
  'appearance-conf',
  {
    hideHeader: false,
    changeIcon: false,
    dynamicTitle: false,
    changeBackground: false,
    blurCard: false,
    listSink: false,
    contentOffset: 25, // 0-25, 25则为关闭
    leftChat: false,
    chatBoxWidth: 600,
    defaultShowChatBox: false,
  },
  ExtStorage,
  { mergeDefaults: true },
)
const isLoading = ref(true)
const formData: FormData = reactive(jsonClone(defaultFormData))
const formDataPreset = ref('default')
const formDataPresets = ref([
  {
    label: '默认配置',
    value: 'default',
  },
])

const formDataKey = () => {
  if (formDataPreset.value !== 'default') {
    return `local:web-geek-job-FormData-${formDataPreset.value}`
  }
  return 'local:web-geek-job-FormData'
}
/**
 * 落盘前的 Jev 归一（评审 F-037）：`{enable:true, targetDirection:''}` 这类良构坏形状
 * 会被读路径 normalizeJevConfig 按既有决定原样保留（F-023/F-024），再经 Config.vue
 * 「保存配置」/LLMPromptEdit/AI 页 change() 等任意 confSaving 调用原样写进存储。
 * 这里在持久边界 fail-closed（AC-006：空方向不得以启用态持久化），下一次保存即修正存量。
 * 密钥不在此校验——按凭证纪律不进 FormData（formData.ts 注释），判定门 canEnableJev
 * 在判定时已双值拒判。只归一化 formData 本体；presets 是惰性副本，switchPreset 应用后
 * 仍要走 confSaving 才落盘（届时同样被归一化），不额外遍历。
 */
function normalizeJevForPersist(data: FormData): void {
  const jev = data.jev
  if (!jev || jev.enable !== true) {
    return
  }
  if (typeof jev.targetDirection === 'string' && jev.targetDirection.trim() === '') {
    jev.enable = false
  }
}

watchThrottled(
  formData,
  (v) => {
    logger.debug('formData改变', toRaw(v))
  },
  { throttle: 2000 },
)

const FROM_VERSION: [string, (from: Partial<FormData>) => Partial<FormData>][] = [
  [
    '20250826',
    (from) => {
      if (from.salaryRange && typeof from.salaryRange.value === 'string') {
        const [min, max] = (from.salaryRange.value as string).split('-').map(Number)
        from.salaryRange.value = [min ?? 0, max ?? 0, false]
      }
      if (from.companySizeRange && typeof from.companySizeRange.value === 'string') {
        const [min, max] = (from.companySizeRange.value as string).split('-').map(Number)
        from.companySizeRange.value = [min ?? 0, max ?? 0, false]
      }
      return from
    },
  ],
  [
    '20260521',
    (from) => {
      if (from.aiFiltering?.prompt) {
        if (typeof from.aiFiltering.prompt === 'string') {
          from.aiFiltering.prompt = [
            {
              role: 'user',
              content: from.aiFiltering.prompt,
            },
          ]
        }
      } else {
        from.aiFiltering = {
          ...defaultFormData.aiFiltering,
          ...from.aiFiltering,
          prompt: defaultFormData.aiFiltering.prompt,
        }
      }
      if (from.aiGreeting?.prompt) {
        if (typeof from.aiGreeting.prompt === 'string') {
          from.aiGreeting.prompt = [
            {
              role: 'user',
              content: from.aiGreeting.prompt,
            },
          ]
        }
      } else {
        from.aiGreeting = {
          ...defaultFormData.aiGreeting,
          ...from.aiGreeting,
          prompt: defaultFormData.aiGreeting.prompt,
        }
      }
      if (from.jobAddress) {
        from.jobAddress = {
          ...from.jobAddress,
          include: true,
        }
      }
      return from
    },
  ],
  [
    '20260718',
    (from) => {
      if (!('delay' in from) || typeof from.delay !== 'object') {
        return from
      }
      Object.entries(from.delay as Record<string, number>).forEach(([key, value]) => {
        // @ts-ignore
        from[`delay${key.charAt(0).toUpperCase() + key.slice(1)}`] = value
      })
      delete from['delay']
      return from
    },
  ],
  ['20260926', (from) => migrateKeywordFields(from)],
]

/**
 * 存量配置逐级迁移（FROM_VERSION 升序补跑：低于存量 version 的版本器跳过，
 * 其余按序补跑并逐个就地盖章）。与存量版本比较必须用补跑前的原始 version，
 * 不能用循环中已盖章的新值——否则首个版本器执行后即为最新，其余全部被误判为已达到。
 * 纯函数：无 toast / 日志 / 存储副作用，可被 bun test 直接验证；
 * formDataHandler 只包一层 try/catch + 用户提示。
 */
export function migrateFormData(from: Partial<FormData>): Partial<FormData> {
  const storedVersion = from?.version ?? '20240401'
  for (const [version, fn] of FROM_VERSION) {
    if (storedVersion >= version) {
      continue
    }
    from = fn(from)
    from.version = version
  }
  // 评审 F-010：损坏的 jev 值（null/非对象/缺字段）在读取路径归一为默认关闭形态，
  // AI 标签页的 computed 解引用（.enable/.targetDirection）不再可能拿到会抛错的形状。
  from.jev = normalizeJevConfig(from.jev)
  return from
}

export const useConf = () => {
  const toast = useToast()

  async function formDataHandler(from: Partial<FormData>) {
    try {
      from = migrateFormData(from)
    } catch (err) {
      logger.error('用户配置初始化失败', err)
      toast.add({
        title: `用户配置初始化失败: ${String(err)}`,
        color: 'error',
      })
    }
    return from
  }

  /**
   * 读取存储中的用户配置并走同一条迁移路径（F-001）：init / confReload / confExport
   * 一律经此函数取数，任何读存储 formData 的路径都不可能再绕过 migrateFormData。
   */
  async function readStoredFormData(): Promise<FormData> {
    const from = await counter.storageGet<Partial<FormData>>(formDataKey(), {})
    // 评审 F-008：deepmerge 在 target 上做浅拷贝、对 stored 缺失的键保留 target 的
    // 子对象引用；先深拷贝默认值，会话内对 formData 的编辑才写不进模块默认对象，
    // 存量配置（无 jev 键）也不会经由别名化的 defaultFormData 复活出启用状态。
    return deepmerge<FormData>(jsonClone(defaultFormData), await formDataHandler(from))
  }
  async function init() {
    isLoading.value = true
    try {
      const rawFormDataPreset = await counter.storageGet(formDataPresetKey, 'default')
      const rawFormDataPresets = await counter.storageGet(formDataPresetsKey, [
        {
          label: '默认配置',
          value: 'default',
        },
      ])
      formDataPreset.value = rawFormDataPreset
      formDataPresets.value = rawFormDataPresets

      Object.assign(formData, await readStoredFormData())
    } catch (e) {
      toast.add({
        title: `配置加载失败: ${String(e)}`,
        color: 'error',
      })
      logger.error('配置加载失败', e)
    } finally {
      isLoading.value = false
    }
  }

  async function confSaving() {
    try {
      normalizeJevForPersist(formData)
      await counter.storageSet(formDataKey(), jsonClone(formData))
      await counter.storageSet(formDataPresetKey, jsonClone(formDataPreset.value))
      await counter.storageSet(formDataPresetsKey, jsonClone(formDataPresets.value))

      toast.add({
        title: '保存成功',
        color: 'success',
      })
      logger.debug('formData保存')
    } catch (error: any) {
      toast.add({
        title: `保存失败: ${error.message}`,
        color: 'error',
      })
      throw error
    }
    // const helper = useHelper()
    // helper.workflow?.rebuild()
  }

  async function confReload() {
    deepmerge(formData, await readStoredFormData(), { clone: false })
    logger.debug('formData已重置')
    toast.add({
      title: '重置成功',
      color: 'success',
    })
  }

  async function confExport() {
    // 与 confReload 同路径：导出迁移后的形状，导入端拿到的就是带 groups 的新配置（F-001）。
    exportJson(await readStoredFormData(), '打招呼配置')
  }

  async function confImport() {
    let jsonData = await importJson<Partial<FormData>>()
    jsonData = (await formDataHandler(jsonData)) ?? jsonData
    deepmerge(formData, jsonData, { clone: false })
    toast.add({
      title: '导入成功, 切记要手动保存哦',
      color: 'success',
    })
  }

  function confRecommend() {
    deepmerge(
      formData,
      [
        'deliveryLimit',
        'activityFilter',
        'friendStatus',
        'sameCompanyFilter',
        'sameHrFilter',
        'goldHunterFilter',
        'notification',
        'useCache',
        'delay',
      ].reduce(
        (result, key) => {
          result[key] = defaultFormData[key as keyof FormData]
          return result
        },
        {} as Record<string, any>,
      ),
      { clone: false },
    )
    logger.debug('formData推荐配置已应用')
    toast.add({
      title: '推荐配置已应用, 不会自动保存, 请手动保存或重载恢复',
      color: 'success',
    })
  }

  function confDelete() {
    deepmerge(formData, defaultFormData, { clone: false })
    logger.debug('formData已清空')
    toast.add({
      title: '配置清空成功, 不会自动保存, 请手动保存或重载恢复',
      color: 'success',
    })
  }

  const order: Record<ConfigLevel, number> = {
    beginner: 1,
    intermediate: 2,
    advanced: 3,
    expert: 4,
  }

  const configLevel = reactiveComputed(() => {
    const val = order[formData.configLevel]
    return {
      intermediate: order['intermediate'] <= val,
      advanced: order['advanced'] <= val,
      expert: order['expert'] <= val,
    }
  })

  async function createPreset(label: string) {
    isLoading.value = true
    try {
      const value = Date.now().toString()
      formDataPresets.value.push({
        label,
        value,
      })
      formDataPreset.value = value

      await counter.storageSet(formDataPresetKey, formDataPreset.value)
      await counter.storageSet(formDataPresetsKey, formDataPresets.value)
      await counter.storageSet(formDataKey(), jsonClone(formData))

      toast.add({
        title: '预设创建成功',
        color: 'success',
      })
    } catch (e) {
      toast.add({
        title: `预设创建失败: ${String(e)}`,
        color: 'error',
      })
      logger.error('预设创建失败', e)
    } finally {
      isLoading.value = false
    }
  }

  async function switchPreset(value: string) {
    isLoading.value = true
    try {
      formDataPreset.value = value
      await counter.storageSet(formDataPresetKey, value)
      await init()
    } catch (e) {
      toast.add({
        title: `预设切换失败: ${String(e)}`,
        color: 'error',
      })
      logger.error('预设切换失败', e)
    } finally {
      isLoading.value = false
    }
  }

  return {
    confInit: init,
    confSaving,
    confReload,
    confExport,
    confImport,
    confDelete,
    confRecommend,
    formDataKey,
    defaultFormData,
    formData,
    configLevel,
    formDataPreset,
    formDataPresets,
    createPreset,
    switchPreset,
    isLoading,
  }
}
