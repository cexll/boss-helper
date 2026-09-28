/**
 * handles.*.test.ts 共用的环境注入与测试脚手架（不注册测试、不加载被 mock 的模块）。
 *
 * seam 沿用 jevDirection.pipeline.test.ts / index.pipeline.test.ts：真实 TaskRegistry 处理器 +
 * 真实 useDeliveryWorkflow 执行语义 + 假 helper ctx，只桩依赖（高德网络、'@/message' 存储、
 * chatModel、sendMessage）。环境注入走 wxt 自动导入全局（computed/logger/jsonClone/delay、
 * amapGeocode/amapDistance）与 window/localStorage/useToast/alert。
 *
 * 约定：`'@/message'` 的 mock.module 与 `await import('./handles')` 必须在**同一个测试文件**
 * 里按序执行（bun 的模块桩只对同文件后续 import 生效）；本模块因此不 import handles/type，
 * 由 createDrivers 注入。
 */

const alerts: string[] = []

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
  define('useToast', () => ({ add: () => {} }))
  define('alert', (message: string) => {
    alerts.push(message)
  })
}

stubBrowserGlobals()

/** 高德 API 是 wxt 自动导入的全局依赖：注入受控应答，绝不触网 */
let geocodeReply: unknown = undefined
let distanceReply: unknown = undefined
export const geocodeCalls: string[] = []
export const distanceCalls: string[] = []

export function setGeocodeReply(value: unknown): void {
  geocodeReply = value
}

export function setDistanceReply(value: unknown): void {
  distanceReply = value
}

const { computed, ref, shallowRef, reactive } = await import('vue')
const { logger } = await import('@/utils/logger')
const { jsonClone } = await import('@/utils/deepmerge')
// 所有 delay 瞬时化：这些测试断言处理器结果，不观察投递节奏
const delay = async (_seconds?: number, _isStop?: () => boolean) => {}
Object.assign(globalThis, {
  computed,
  ref,
  shallowRef,
  reactive,
  logger,
  jsonClone,
  delay,
  amapGeocode: async (address: string) => {
    geocodeCalls.push(address)
    return geocodeReply
  },
  amapDistance: async (location: string) => {
    distanceCalls.push(location)
    return distanceReply
  },
})

export const { defaultFormData } = (await import('@/composables/conf/info')) as Record<string, any>

/** 每个测试前清空受控状态（测试文件用 beforeEach(resetFixtures) 调用） */
export function resetFixtures(): void {
  alerts.length = 0
  geocodeCalls.length = 0
  distanceCalls.length = 0
  geocodeReply = undefined
  distanceReply = undefined
}

// ———————————————— 测试脚手架 ————————————————

interface HelperFixture {
  helper: Record<string, any>
  statistics: Record<string, any>
}

/** 假 helper ctx：只提供处理器真正读取的部分（conf.formData、statistics、storage 键 uid） */
export function makeHelper(over: Record<string, any> = {}): HelperFixture {
  const { formData, ...rest } = over
  const statistics = {
    total: 0,
    success: 0,
    repeat: 0,
    activityFilter: 0,
    tasks: {} as Record<string, any>,
  }
  const helper: Record<string, any> = {
    uid: 'u-handles',
    conf: { formData: { ...defaultFormData, ...formData } },
    statistics: { todayData: { value: statistics } },
    jobResultMaps: new Map<string, any>(),
    jobMaps: new Map<string, any>(),
    jobList: { value: [] as any[] },
    currentJob: { value: '' },
    loadMoreJob: async () => false,
    notification: async () => {},
    ...rest,
  }
  return { helper, statistics }
}

export function bossOf(over: Record<string, any> = {}): any {
  return { name: '张经理', title: '技术总监', avatar: '', certificated: true, ...over }
}

export function brandOf(over: Record<string, any> = {}): any {
  return {
    name: '北京某某科技有限公司',
    logo: '',
    scale: '500-999人',
    industry: '互联网',
    introduce: '',
    labels: [],
    ...over,
  }
}

export function jobDataOf(over: Record<string, any> = {}): any {
  return {
    key: 'k1',
    jobName: '前端开发工程师',
    jobDescription: '负责前端界面开发',
    salary: '15-25K',
    address: '北京市朝阳区望京SOHO',
    activeTimeStr: '刚刚活跃',
    boss: bossOf(),
    brand: brandOf(),
    ...over,
  }
}

export interface DriveOptions {
  formData?: Record<string, any>
  helper?: Record<string, any>
  jobData?: any
  state?: any
  index?: number
  now?: Date
}

export function ctxOf(helper: Record<string, any>, over: DriveOptions = {}): any {
  return { now: over.now ?? new Date(), helper, index: over.index ?? 0, log: {} }
}

export interface DriverModules {
  TaskRegistry: any
  defineTaskWorkflow: any
}

export interface Drivers {
  /** 注册期取真实处理器，再以真实 WorkflowData 形状调用：返回值即被测处理器的产出 */
  drive: (
    pick: (registry: any) => any,
    over?: DriveOptions,
  ) => Promise<{ res: any; helper: Record<string, any>; statistics: Record<string, any> }>
  /** 注册期抛错的捕获面（配置类错误必须在注册期炸，不静默放行） */
  registrationError: (pick: (registry: any) => any, over?: DriveOptions) => Promise<any>
  /** 驱动真实工作流：rebuild 注册处理器（注册期读存储）→ execute 单岗 */
  runWorkflow: (
    tasks: any[],
    helper: Record<string, any>,
    jobData: any,
    index?: number,
    state?: any,
  ) => Promise<any>
}

export function createDrivers({ TaskRegistry, defineTaskWorkflow }: DriverModules): Drivers {
  const drive: Drivers['drive'] = async (pick, over = {}) => {
    const { helper, statistics } = makeHelper({ formData: over.formData, ...over.helper })
    const ctx = ctxOf(helper, over)
    const task = pick(new TaskRegistry())
    const built = await task.task(ctx)
    if (!built) throw new Error(`处理器未注册: ${task.id}`)
    const handler = typeof built === 'function' ? built : built.fn
    const res = await handler(ctx, {
      jobData: over.jobData ?? jobDataOf(),
      rawData: {},
      state: over.state ?? {},
    })
    return { res, helper, statistics }
  }

  const registrationError: Drivers['registrationError'] = async (pick, over = {}) => {
    const { helper } = makeHelper({ formData: over.formData, ...over.helper })
    const ctx = ctxOf(helper, over)
    try {
      await pick(new TaskRegistry()).task(ctx)
      return null
    } catch (e) {
      return e
    }
  }

  const runWorkflow: Drivers['runWorkflow'] = async (
    tasks,
    helper,
    jobData,
    index = 0,
    state = {},
  ) => {
    const wf = await defineTaskWorkflow(...tasks)(helper)
    await wf.rebuild()
    await wf.execute({ jobData, rawData: {}, state }, index)
    return wf
  }

  return { drive, registrationError, runWorkflow }
}
