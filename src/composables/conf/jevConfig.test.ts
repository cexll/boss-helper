import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import * as ssrRenderer from 'vue/server-renderer'

import type { JevConfig } from '@/types/formData'

import type * as ConfNamespace from './index'
import { defaultFormData } from './info'

/**
 * 评审 F-008 / F-009 / F-010（t7 评审，feature fx-007）：
 *  Jev 配置的存储读写路径与 AI 标签页（真实 AI.vue 经 vue/compiler-sfc 编译 + SSR 渲染）：
 *  - F-008：会话默认值别名化 — reactive(defaultFormData) 别名同一对象，会话内编辑
 *          写穿默认对象；存量配置（无 jev 键）经 deepmerge 复活会话里的启用状态。
 *          验证：无 jev 存量配置的会话内启用不污染 defaultFormData、重载后仍默认关闭；
 *  - F-010：损坏存储值（null/非对象/缺字段）经读取路径归一为默认关闭形态，UI 不崩；
 *  - F-009：AI 页目标方向编辑有持久化路径（失焦写回存储），重载不丢失。
 * 期望值全部来自评审原文 / defaultFormData / AC-006 门控口径，不出自实现。
 *
 * '@/message' 桩与 migrate.storage.test.ts 同一模式（受控 Map）。conf/index.ts 的
 * formData/formDataPreset 是模块级单例：每个用例先 confInit 把预设复位回 default，
 * 再断言，避免上一个用例的 switchPreset 泄漏进本用例的存储键。
 */

const storageMap = new Map<string, unknown>()

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

/** '@/message' 的桩值：受控 Map 的读写 + ExtStorage，AI.vue 沙箱与进程 mock 共用。 */
function makeMessageStub() {
  return {
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
  }
}

function mockMessage(): void {
  void mock.module('@/message', () => makeMessageStub())
}

/** 复位模块单例：清空存储、预设回 default、加载给定存量 blob，返回可用 conf。 */
async function freshConf(stored: Record<string, unknown> | undefined): Promise<ConfInstance> {
  await import('@/message')
  await import('@/utils/jsonImportExport')
  mockMessage()
  storageMap.clear()
  storageMap.set('local:FormDataPrese', 'default')
  if (stored) storageMap.set(FORM_DATA_KEY, stored)
  const conf = (await loadConf()).useConf()
  await conf.confInit()
  return conf
}

type ConfModule = typeof ConfNamespace
let confModule: ConfModule | undefined
async function loadConf(): Promise<ConfModule> {
  stubBrowserGlobals()
  confModule ??= await import('./index')
  return confModule
}

type ConfInstance = ReturnType<ConfModule['useConf']>

/** 早于 Jev 的存量配置形状：没有 jev 键（评审 F-008 场景）。 */
const legacyStoredConfig = () => ({
  version: '20260718',
  jobTitle: { include: true, value: ['Java'], options: [], enable: false },
})

const FORM_DATA_KEY = 'local:web-geek-job-FormData'

// ————————————————————————————————————————————————————————————————————————————
// F-008：会话默认值别名化（评审原文：reactive(defaultFormData) 别名同一对象，
// readStoredFormData 的 deepmerge(defaultFormData, stored) 对 stored 缺键的字段
// 保留 defaultFormData 的子对象引用 → 会话内编辑写穿默认对象，存量配置复活启用态）。
// ————————————————————————————————————————————————————————————————————————————

describe('F-008：存量配置无 jev 时，会话内启用 Jev 不复活进配置、不污染默认值', () => {
  test('会话内启用 Jev 后重载无 jev 存量配置：仍默认关闭，defaultFormData 不被污染', async () => {
    const conf = await freshConf(legacyStoredConfig())
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })

    // 会话内用户启用 Jev（AI 页开关 + 授权确认的等价写）
    conf.formData.jev!.enable = true
    conf.formData.jev!.targetDirection = '前端开发'

    // 默认值对象不得被会话编辑写穿（评审的别名化判据）
    expect(defaultFormData.jev).toEqual({ enable: false, targetDirection: '' })

    // 同一份无 jev 的存量配置重载：Jev 不得以启用/带方向的状态复活
    await conf.confReload()
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })
  })

  test('评审原场景：预设 A 会话内启用并保存后，切到从未有 jev 键的存量预设 B，B 仍默认关闭', async () => {
    const conf = await freshConf(legacyStoredConfig())
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })

    // 预设 A 会话内启用并保存（confSaving 是 AI 页开关/确认后的真实写路径）
    conf.formData.jev!.enable = true
    conf.formData.jev!.targetDirection = '前端开发'
    await conf.confSaving()
    // A 落盘为启用态是用户显式选择，合理；默认对象不得因此被污染
    expect((storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }).jev).toEqual({
      enable: true,
      targetDirection: '前端开发',
    })
    expect(defaultFormData.jev).toEqual({ enable: false, targetDirection: '' })

    // 预设 B：存量 blob 早于 Jev，没有 jev 键
    const keyB = 'local:web-geek-job-FormData-B'
    storageMap.set('local:FormDataPreses', [
      { label: '默认配置', value: 'default' },
      { label: 'B', value: 'B' },
    ])
    storageMap.set(keyB, {
      version: '20260718',
      jobTitle: { include: false, value: ['外包'], options: [], enable: false },
    })
    await conf.switchPreset('B')

    // B 从未启用过 Jev：加载后必须是默认关闭形态，不带 A 的启用状态/方向
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })
    expect(defaultFormData.jev).toEqual({ enable: false, targetDirection: '' })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// F-010：损坏的存储 jev 值（null / 非对象 / 缺字段）→ 读取路径归一为默认关闭形态。
// ————————————————————————————————————————————————————————————————————————————

describe('F-010：损坏 jev 经完整读路径加载后为默认关闭形态，AI 标签页不崩溃', () => {
  test('存储 jev:null → 加载后 formData.jev 归一为默认关闭，可安全解引用', async () => {
    const conf = await freshConf({ version: '20260926', jev: null })
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })
    // AI.vue 的 computed 解引用（.enable / .targetDirection）不能抛错
    expect(() => conf.formData.jev!.targetDirection.trim()).not.toThrow()
    expect(conf.formData.jev!.enable).toBe(false)
  })

  test('存储 jev 为缺字段的非良构对象时同样归一（不落盘异常形状）', async () => {
    const conf = await freshConf({ version: '20260926', jev: { enable: true } })
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })
  })

  test('存储 jev 为非对象标量时同样归一', async () => {
    const conf = await freshConf({ version: '20260926', jev: 'oops' })
    expect(conf.formData.jev).toEqual({ enable: false, targetDirection: '' })
  })

  test('良构 jev 原样保留（归一不吞用户已有选择）', async () => {
    const conf = await freshConf({
      version: '20260926',
      jev: { enable: true, targetDirection: '前端开发' },
    })
    expect(conf.formData.jev).toEqual({ enable: true, targetDirection: '前端开发' })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// F-009 + F-010 的 UI 侧证明：真实 AI.vue 经 vue/compiler-sfc 编译 + SSR 渲染。
// 与 reviewNeeded.test.ts（t6 F-003）同一模式：桩只替身 Nuxt UI 全局组件与
// '@/composables/useHelper'，useConf 用真实 conf 组合式（存储走受控 Map）。
// ————————————————————————————————————————————————————————————————————————————

/** 每个桩组件最近一次渲染捕获的 attrs（本文件每个组件只渲染一次）。 */
const captured = new Map<string, Record<string, unknown>>()

const capturingStub = (name: string) =>
  vue.defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      // 同名组件多次渲染（如多个 UButton）只记录第一个：Jev 开关是页面里第一个 UButton，
      // 断言开关形态时必须取它而不是后面「模型配置」的按钮。
      if (!captured.has(name)) captured.set(name, { ...(attrs as Record<string, unknown>) })
      return () => vue.h('span', { 'data-cmp': name }, (slots as any).default?.())
    },
  })

/** `a as b` 的导入清单 → 解构重命名 `a: b`；无名导入保持原样。 */
function toDestructure(names: string): string {
  return names
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [imported, local] = item.split(/\s+as\s+/)
      return local ? `${imported}: ${local}` : `${imported}`
    })
    .join(',')
}

/** ESM import 改写为沙箱绑定：vue / server-renderer 用真实运行时，其余走桩映射。 */
function rebindSsrImports(code: string): string {
  return code
    .replace(/^import\s+type\s.*?$/gm, '')
    .replace(
      /^import\s*\{([^}]*)\}\s*from\s*['"]vue['"];?\s*$/gm,
      (_m, names: string) => `const {${toDestructure(names)}} = __vue__;`,
    )
    .replace(
      /^import\s*\{([^}]*)\}\s*from\s*['"]vue\/server-renderer['"];?\s*$/gm,
      (_m, names: string) => `const {${toDestructure(names)}} = __ssr__;`,
    )
    .replace(
      /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm,
      (_m, names: string, from: string) =>
        `const {${toDestructure(names)}} = __mod__[${JSON.stringify(from)}];`,
    )
    .replace(
      /^import\s+(\w+)\s*from\s*['"]([^'"]+)['"];?\s*$/gm,
      (_m, name: string, from: string) => `const ${name} = __mod__[${JSON.stringify(from)}];`,
    )
    .replace(/^export\s+default\s+/gm, 'const __sfc_main__ = ')
}

/** 编译真实 AI.vue（inlineTemplate + ssr）：得到 setup 与 ssrRender 合一的模块代码。 */
function compileAiSfc(): string {
  const url = new URL('../../components/Tabs/AI.vue', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const { descriptor } = parse(source, { filename: 'AI.vue' })
  if (!descriptor.scriptSetup) throw new Error('AI.vue 缺少 <script setup>')
  return compileScript(descriptor, {
    id: 'ai-ssr-test',
    inlineTemplate: true,
    templateOptions: { ssr: true },
  }).content
}

async function buildAiComponent(): Promise<vue.Component> {
  const confNs = await loadConf()
  const formDataNs = await import('@/types/formData')
  const jevNs = await import('@/utils/jev')
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(rebindSsrImports(compileAiSfc()))
  const sandbox: { component?: vue.Component } & Record<string, unknown> = {
    __vue__: vue,
    __ssr__: ssrRenderer,
    __mod__: {
      '@/components/AI/LLMModelManage.vue': capturingStub('LLMModelManage'),
      '@/components/AI/LLMPromptEdit.vue': capturingStub('LLMPromptEdit'),
      '@/components/Tabs/ConfigItem/Form/FormSwitch.vue': capturingStub('FormSwitch'),
      '@/composables/conf': confNs,
      '@/composables/useHelper': {
        useHelper: () => ({ workflow: { status: vue.ref('stop') } }),
      },
      '@/message': makeMessageStub(),
      '@/types/formData': formDataNs,
      '@/utils/jev': jevNs,
    },
    __set__: (component: vue.Component) => {
      sandbox.component = component
    },
  }
  // 沙箱代替 new Function：同一作用域执行编译产物，避免隐式 eval 口径
  vm.runInNewContext(`${js}\n__set__(__sfc_main__)`, sandbox)
  return sandbox.component!
}

/** 用真实 AI.vue 渲染一段 HTML；Nuxt UI 全局组件以透传插槽的桩替身。 */
async function renderAiTab(): Promise<string> {
  captured.clear()
  const app = vue.createSSRApp(await buildAiComponent())
  for (const name of [
    'UButton',
    'UFieldGroup',
    'UFormField',
    'UInput',
    'UTextarea',
    'UAlert',
    'UModal',
  ]) {
    app.component(name, capturingStub(name))
  }
  return ssrRenderer.renderToString(app)
}

describe('AI 标签页真实渲染（F-009/F-010 UI 侧）', () => {
  test('F-010：存储 jev:null 时 AI 页渲染完成，开关为关闭、方向为空、不崩溃', async () => {
    await freshConf({ version: '20260926', jev: null })
    const html = await renderAiTab()
    expect(html).toContain('Jev 方向判断')
    // 开关（Jev 按钮）处于关闭形态（error 色），方向字段为空
    expect((captured.get('UButton') as any)?.color).toBe('error')
    expect((captured.get('UTextarea') as any)?.modelValue).toBe('')
  })

  test('F-009：目标方向编辑经失焦保存落盘，重载后保留（与密钥失焦写存储同一模式）', async () => {
    const conf = await freshConf({
      version: '20260926',
      jev: { enable: true, targetDirection: '前端开发' },
    })
    await renderAiTab()
    // 已启用且方向为「前端开发」：文本域回显、开关为启用形态
    expect((captured.get('UButton') as any)?.color).toBe('success')
    expect((captured.get('UTextarea') as any)?.modelValue).toBe('前端开发')
    // 文本域失焦应触发保存（评审 F-009 的持久化路径）
    const onBlur = (captured.get('UTextarea') as any)?.onBlur as
      | (() => Promise<void> | void)
      | undefined
    expect(typeof onBlur).toBe('function')
    // 会话内编辑目标方向（v-model 写回 formData 的等价写）
    conf.formData.jev!.targetDirection = '后端开发'
    await onBlur!()
    const stored = storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }
    expect(stored.jev?.targetDirection).toBe('后端开发')
    // 重载后保留
    await conf.confReload()
    expect(conf.formData.jev!.targetDirection).toBe('后端开发')
  })

  test("t7-F-017：清空方向后失焦落盘 → enable 一并归 false，不残留 {enable:true,targetDirection:''}", async () => {
    const conf = await freshConf({
      version: '20260926',
      jev: { enable: true, targetDirection: '前端开发' },
    })
    await renderAiTab()
    // SSR 不跑 onMounted：密钥经真实 v-model 事件写回（等价用户在密钥框输入）
    const input = captured.get('UInput') as any
    input['onUpdate:modelValue']('sk-test')
    const textarea = captured.get('UTextarea') as any
    const onBlur = textarea.onBlur as () => Promise<void> | void
    // 控制组：方向在位、密钥在位 → 失焦只落盘，enable 不动
    await onBlur()
    const before = storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }
    expect(before.jev).toEqual({ enable: true, targetDirection: '前端开发' })
    // 用户清空方向再失焦：enable 同步关闭
    textarea['onUpdate:modelValue']('')
    await onBlur()
    const stored = storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }
    expect(stored.jev).toEqual({ enable: false, targetDirection: '' }) // 不残留启用态
    expect(conf.formData.jev!.enable).toBe(false) // 会话内同样降级
  })

  test('t7-F-017：密钥尚未读取完成时，失焦不据空密钥降级已启用状态（方向在位）', async () => {
    const conf = await freshConf({
      version: '20260926',
      jev: { enable: true, targetDirection: '前端开发' },
    })
    await renderAiTab()
    // 不注入密钥（模拟 onMounted 的存储回读尚未完成）：方向在位，失焦不得关闭 Jev
    const textarea = captured.get('UTextarea') as any
    await (textarea.onBlur as () => Promise<void> | void)()
    const stored = storageMap.get(FORM_DATA_KEY) as { jev?: JevConfig }
    expect(stored.jev).toEqual({ enable: true, targetDirection: '前端开发' })
    expect(conf.formData.jev!.enable).toBe(true)
  })
})
