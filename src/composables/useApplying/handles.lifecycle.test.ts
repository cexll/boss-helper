import { beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  createDrivers,
  ctxOf,
  defaultFormData,
  distanceCalls,
  geocodeCalls,
  jobDataOf,
  makeHelper,
  resetFixtures,
  setDistanceReply,
  setGeocodeReply,
} from './handles.harness.test'

/**
 * handles.ts 处理器矩阵（二）：AI / 招呼语 / 高德地图 / 重复沟通 / 结果状态契约。
 *
 * 说明（发现的接线缺口，未改生产代码）：index.ts rebuild 只把处理器返回的 fn/before/after
 * 装进 Task（type.ts defineTaskHandler 的 options 才有 onEnd 位），返回对象上的 onEnd
 * 不会进入 Task.onEnd，故 onEnd 不会随 executeAll 收尾触发。本文件对 onEnd 用
 * 「处理器返回的钩子契约」直接驱动（断言其落盘语义），不用它声称端到端生命周期；
 * 生命周期（注册期读存储 → fn 跳过 → after 落盘）由真实工作流执行验证。
 *
 * 桩与 import 顺序（bun 模块桩只对同文件后续 import 生效）：
 * 先 mock.module('@/message')，再 await import('./handles')。
 */

const storageMapControlled = new Map<string, unknown>()
void mock.module('@/message', () => ({
  counter: {
    storageGet: async (key: string, fallback?: unknown) =>
      storageMapControlled.has(key) ? storageMapControlled.get(key) : fallback,
    storageSet: async (key: string, value: unknown) => {
      storageMapControlled.set(key, value)
      return true
    },
    storageRm: async (key: string) => {
      storageMapControlled.delete(key)
      return true
    },
  },
  ExtStorage: {
    getItem: async (key: string) =>
      storageMapControlled.has(key) ? storageMapControlled.get(key) : null,
    setItem: async (key: string, value: unknown) => {
      storageMapControlled.set(key, value)
    },
    removeItem: async (key: string) => {
      storageMapControlled.delete(key)
    },
  },
}))
// 受控存储：loadSet/saveSet 的唯一落盘通道（与本文件的 mock 模块同源）
const storage = storageMapControlled

beforeEach(resetFixtures)
beforeEach(() => {
  storageMapControlled.clear()
})

const handles = (await import('./handles')) as Record<string, any>
const { HelperConfigError, TaskRegistry, taskResult } = handles
const applyingType = (await import('./type')) as Record<string, any>
const applyingIndex = (await import('./index')) as Record<string, any>
const { drive, registrationError, runWorkflow } = createDrivers({
  TaskRegistry,
  defineTaskWorkflow: applyingIndex.defineTaskWorkflow,
})

// ———————————————— AI 筛选 / AI 招呼语 ————————————————

describe('AI 筛选与 AI 招呼语', () => {
  const aiFiltering = { ...defaultFormData.aiFiltering, enable: true, prompt: [], score: 10 }

  test('AI筛选：评分低于阈值跳过并带上模型理由，达标放行', async () => {
    const content =
      '```json\n{"positive":[{"reason":"双休","score":3}],"negative":[{"reason":"需要上门","score":5}]}\n```'
    const low = await drive((r) => r.aiFiltering(), {
      formData: { aiFiltering },
      helper: { chatModel: { createAgent: () => ({}), chat: async () => ({ text: content }) } },
      jobData: jobDataOf(),
    })
    expect(low.res).toEqual({
      isSkip: true,
      status: 'warn',
      reason: '分数-2\n消极:\n需要上门/(5分)\n\n积极:\n双休/(3分)',
    })

    const pass = await drive((r) => r.aiFiltering(), {
      formData: { aiFiltering },
      helper: {
        chatModel: {
          createAgent: () => ({}),
          chat: async () => ({
            text: '```json\n{"positive":[{"reason":"双休","score":30}],"negative":[]}\n```',
          }),
        },
      },
      jobData: jobDataOf(),
    })
    expect(pass.res).toBeUndefined()
  })

  test('AI筛选：模型输出不可解析时按 0 分处理（fail-closed 跳过而不是放行）', async () => {
    const bad = await drive((r) => r.aiFiltering(), {
      formData: { aiFiltering },
      helper: {
        chatModel: { createAgent: () => ({}), chat: async () => ({ text: '抱歉，无法给出分数' }) },
      },
      jobData: jobDataOf(),
    })
    expect(bad.res).toEqual({
      isSkip: true,
      status: 'warn',
      reason: '分数0\n消极:undefined\n\n积极:undefined',
    })
  })

  test('AI筛选：未配置模型时注册期抛 HelperConfigError（不静默放行）', async () => {
    const error = await registrationError((r) => r.aiFiltering(), {
      formData: { aiFiltering },
      helper: { chatModel: { createAgent: () => null, chat: async () => ({ text: '' }) } },
    })
    expect(error).toBeInstanceOf(HelperConfigError)
    expect(error.key).toBe('aiFiltering.model')
    expect(error.message).toBe('AI筛选模型未配置')
  })

  test('AI招呼语：模型文本原样发给 sendMessage；未配置模型同样注册期抛错', async () => {
    const aiGreeting = { ...defaultFormData.aiGreeting, enable: true, prompt: [] }
    const sent: any[] = []
    const chatCalls: any[] = []
    const agentCalls: any[] = []
    const greeting = await drive((r) => r.aiGreeting(), {
      formData: { aiGreeting },
      helper: {
        sendMessage: async (data: any, msg: any) => {
          sent.push([data, msg])
        },
        chatModel: {
          createAgent: (conf: any, role: string) => {
            agentCalls.push([conf, role])
            return { role }
          },
          chat: async (role: string, data: any) => {
            chatCalls.push([role, data])
            return { text: '您好，我对这个岗位很感兴趣' }
          },
        },
      },
      jobData: jobDataOf(),
    })
    expect(greeting.res).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toBe('您好，我对这个岗位很感兴趣')
    expect(sent[0][0].jobData.key).toBe('k1') // 发给 sendMessage 的是完整 WorkflowData
    expect(chatCalls[0][0]).toBe('greetings')
    expect(agentCalls[0][0]).toBe(aiGreeting)
    expect(agentCalls[0][1]).toBe('greetings')

    const error = await registrationError((r) => r.aiGreeting(), {
      formData: { aiGreeting },
      helper: { chatModel: { createAgent: () => null, chat: async () => ({ text: '' }) } },
    })
    expect(error).toBeInstanceOf(HelperConfigError)
    expect(error.key).toBe('aiGreeting.model')
    expect(error.message).toBe('AI招呼模型未配置')
  })
})

// ———————————————— 自定义招呼语 ————————————————

describe('自定义招呼语', () => {
  test('变量渲染：字符串模板与富文本数组逐项渲染；关变量时原样发送', async () => {
    const sent: any[] = []
    const sendMessage = async (data: any, msg: any) => {
      sent.push([data, msg])
    }
    const template = '你好，我是{{ jobData.jobName }}的候选人'

    const variableOn = await drive((r) => r.customGreeting(), {
      formData: {
        customGreeting: { enable: true, value: template },
        greetingVariable: { value: true },
      },
      helper: { sendMessage },
      jobData: jobDataOf(),
    })
    expect(variableOn.res).toBeUndefined()
    expect(sent[0][1]).toBe('你好，我是前端开发工程师的候选人')
    expect(sent[0][0].jobData.key).toBe('k1')

    const variableOff = await drive((r) => r.customGreeting(), {
      formData: {
        customGreeting: { enable: true, value: template },
        greetingVariable: { value: false },
      },
      helper: { sendMessage },
      jobData: jobDataOf(),
    })
    expect(variableOff.res).toBeUndefined()
    expect(sent[1][1]).toBe(template)

    const rich = await drive((r) => r.customGreeting(), {
      formData: {
        customGreeting: {
          enable: true,
          value: [
            { type: 'text', content: '你好{{ jobData.jobName }}' },
            { type: 'image', image: 'https://img.example/x.png' },
          ],
        },
        greetingVariable: { value: true },
      },
      helper: { sendMessage },
      jobData: jobDataOf(),
    })
    expect(rich.res).toBeUndefined()
    expect(sent[2][1]).toEqual([
      { type: 'text', content: '你好前端开发工程师' },
      { type: 'image', image: 'https://img.example/x.png' },
    ])
  })

  test('helper 未挂载 sendMessage 时不抛错（可选链）', async () => {
    const { res } = await drive((r) => r.customGreeting(), {
      formData: {
        customGreeting: { enable: true, value: '你好' },
        greetingVariable: { value: false },
      },
      jobData: jobDataOf(),
    })
    expect(res).toBeUndefined()
  })
})

// ———————————————— 高德地图 ————————————————

describe('高德地图（距离/时间阈值 + 前置失败）', () => {
  const amapConf = {
    enable: true,
    straightDistance: 10,
    drivingDistance: 15,
    drivingDuration: 40,
    walkingDistance: 3,
    walkingDuration: 30,
    key: '',
    origins: '',
  }

  test('空地址 / 未取到经纬度 / 距离数据缺失：三种前置失败各自跳过', async () => {
    const noAddress = await drive((r) => r.amap(), {
      formData: { amap: amapConf },
      jobData: jobDataOf({ address: undefined }),
      state: {},
    })
    expect(noAddress.res).toEqual({ isSkip: true, reason: '地址信息为空', status: 'warn' })
    expect(geocodeCalls).toEqual([]) // 前置失败不发地理编码请求

    setGeocodeReply({})
    const noLocation = await drive((r) => r.amap(), {
      formData: { amap: amapConf },
      jobData: jobDataOf(),
      state: {},
    })
    expect(noLocation.res).toEqual({ isSkip: true, reason: '未获取到地址经纬度', status: 'warn' })
    expect(geocodeCalls).toEqual(['北京市朝阳区望京SOHO'])

    setGeocodeReply({ location: '116.4,39.9' })
    setDistanceReply(null)
    const badApi = await drive((r) => r.amap(), {
      formData: { amap: amapConf },
      jobData: jobDataOf(),
      state: {},
    })
    expect(badApi.res).toEqual({ isSkip: true, reason: 'api数据异常', status: 'warn' })
    expect(distanceCalls).toEqual(['116.4,39.9'])
  })

  test('三种出行方式逐项判定：ok=false / 距离超标 / 时间超标 / 全部达标', async () => {
    setGeocodeReply({ location: '116.4,39.9' })

    setDistanceReply({
      straight: { ok: false, distance: 0, duration: 0 },
      driving: { ok: true, distance: 1000, duration: 600 },
      walking: { ok: true, distance: 500, duration: 300 },
    })
    const apiFailed = await drive((r) => r.amap(), {
      formData: { amap: amapConf },
      jobData: jobDataOf(),
      state: {},
    })
    expect(apiFailed.res).toEqual([
      { isSkip: true, reason: '高德地图未初始化', status: 'warn' },
      undefined,
      undefined,
    ])

    setDistanceReply({
      straight: { ok: true, distance: 20000, duration: 0 },
      driving: { ok: true, distance: 1000, duration: 3000 },
      walking: { ok: true, distance: 4000, duration: 600 },
    })
    const state: any = {}
    const overLimit = await drive((r) => r.amap(), {
      formData: { amap: amapConf },
      jobData: jobDataOf(),
      state,
    })
    expect(overLimit.res[0]).toEqual({
      isSkip: true,
      reason: '直线距离超标: 20 设定: 10',
      status: 'warn',
    })
    expect(overLimit.res[1]).toEqual({
      isSkip: true,
      reason: '驾车时间超标: 50 设定: 40',
      status: 'warn',
    })
    expect(overLimit.res[2]).toEqual({
      isSkip: true,
      reason: '步行距离超标: 4 设定: 10',
      status: 'warn',
    })
    expect(state.amap.geocode).toEqual({ location: '116.4,39.9' })
    expect(state.amap.distance.straight.distance).toBe(20000)

    setDistanceReply({
      straight: { ok: true, distance: 9000, duration: 0 },
      driving: { ok: true, distance: 14000, duration: 2000 },
      walking: { ok: true, distance: 2500, duration: 1700 },
    })
    const within = await drive((r) => r.amap(), {
      formData: { amap: amapConf },
      jobData: jobDataOf(),
      state: {},
    })
    expect(within.res).toEqual([undefined, undefined, undefined])
  })
})

// ———————————————— 重复沟通过滤 ————————————————

describe('重复沟通过滤（注册期读存储 → fn 跳过 → after 落盘）', () => {
  test('相同公司：首单 after 落盘、非 3 倍数单不落盘、再扫同 key 跳过并计入 repeat', async () => {
    const { helper, statistics } = makeHelper({
      formData: { sameCompanyFilter: { value: true, expire: 0 } },
    })

    // index 0：after 钩子（ctx.index % 3 === 0）落盘
    await runWorkflow([new TaskRegistry().SameCompanyFilter()], helper, jobDataOf({ key: 'c1' }), 0)
    expect(storage.get('local:sameCompany')).toEqual({
      'u-handles': { c1: expect.any(Number) },
    })

    // index 1：注册期读到的集合仍是 {c1}，after 只改内存、不落盘
    await runWorkflow([new TaskRegistry().SameCompanyFilter()], helper, jobDataOf({ key: 'c2' }), 1)
    expect(helper.jobResultMaps.get('c2').status).toBe('success')
    expect(storage.get('local:sameCompany')).toEqual({
      'u-handles': { c1: expect.any(Number) },
    })

    // 重新注册（读回存储）再扫 c1：命中集合 → 跳过本轮 + 统计 repeat
    await runWorkflow([new TaskRegistry().SameCompanyFilter()], helper, jobDataOf({ key: 'c1' }), 0)
    expect(helper.jobResultMaps.get('c1')).toMatchObject({
      isSkip: true,
      reason: '相同公司已投递',
      status: 'warn',
      msg: '相同公司',
    })
    expect(statistics.repeat).toBe(1)
  })

  test('相同公司：onEnd 收尾把内存集合落盘（处理器返回的钩子契约）', async () => {
    const { helper } = makeHelper({ formData: { sameCompanyFilter: { value: true, expire: 0 } } })
    const ctx = ctxOf(helper)
    const built = await new TaskRegistry().SameCompanyFilter().task(ctx)
    if (!built) throw new Error('SameCompanyFilter 未注册')

    await built.after[0]({ ...ctx, index: 1 }, { jobData: jobDataOf({ key: 'c9' }) })
    expect(storage.has('local:sameCompany')).toBe(false) // index%3 !== 0：只改内存

    await built.onEnd(ctx)
    expect(storage.get('local:sameCompany')).toEqual({
      'u-handles': { c9: expect.any(Number) },
    })
  })

  test('相同 HR：key 缺失不判、命中去重集合跳过并计入 repeat', async () => {
    const formData = { sameHrFilter: { value: true, expire: 0 } }
    const noKey = await drive((r) => r.SameHrFilter(), {
      formData,
      jobData: jobDataOf({ key: undefined }),
    })
    expect(noKey.res).toBeUndefined()
    expect(noKey.statistics.repeat).toBe(0)

    storage.set('local:sameHr', { 'u-handles': { h1: 1 } })
    const hit = await drive((r) => r.SameHrFilter(), {
      formData,
      jobData: jobDataOf({ key: 'h1' }),
    })
    expect(hit.res).toEqual({ isSkip: true, reason: '相同hr已投递', status: 'warn' })
    expect(hit.statistics.repeat).toBe(1)
  })

  test('相同 HR：after 每 3 单落盘一次，onEnd 收尾落盘', async () => {
    const { helper } = makeHelper({ formData: { sameHrFilter: { value: true, expire: 0 } } })
    const ctx = ctxOf(helper)
    const built = await new TaskRegistry().SameHrFilter().task(ctx)
    if (!built) throw new Error('SameHrFilter 未注册')

    await built.after[0]({ ...ctx, index: 4 }, { jobData: jobDataOf({ key: 'h4' }) })
    expect(storage.has('local:sameHr')).toBe(false)

    storage.clear() // 清掉 after 的中间落盘，只留 onEnd 这一条写入路径可产生内容
    await built.onEnd(ctx)
    expect(storage.get('local:sameHr')).toEqual({ 'u-handles': { h4: expect.any(Number) } })
  })
})

// ———————————————— 结果状态契约 ————————————————

describe('taskResult 结果状态经真实 execute 记账', () => {
  test('error() 结果在 jobResultMaps 标 error 并计入 statistics.tasks[id].error', async () => {
    const { helper, statistics } = makeHelper()
    const wf = await applyingIndex.defineTaskWorkflow(
      applyingType.defineTaskHandler('模型缺失', () => async () => taskResult.error('模型未配置')),
    )(helper)
    await wf.rebuild()
    await wf.execute({ jobData: jobDataOf({ key: 'e1' }), rawData: {}, state: {} }, 0)

    expect(helper.jobResultMaps.get('e1')).toEqual({
      isSkip: true,
      status: 'error',
      reason: '模型未配置',
      msg: '模型缺失',
    })
    expect(statistics.tasks['模型缺失']).toEqual({ error: 1 })
    expect(statistics.success).toBe(0)
  })
})
