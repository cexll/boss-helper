import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { LimitError, PublishError } from './deliverError'

/**
 * useDeliveryWorkflow 执行语义（v-m1 同款 seam：真实工作流 + 假 helper ctx）：
 * - 模块缓存 API：getCacheManager 单例、cachePipelineResult 写入与错误不缓存、checkJobCache 命中/过期
 * - meginResults 合并：状态按 jobStatusList 高位胜出、reason/msg 换行拼接、isSkip/isCache 累积、空数组无产出
 * - rebuild：任务注册抛错的 failed 节点与 alert/errorMessage 上报、依赖成环拒绝
 * - execute：业务错误记账与停机决定、DependencyMissingError 解析重试、统计容器缺失时上抛
 * - executeAll：节流观察器接线、预置状态重置、本地上限岗前/岗后停机、LimitError 停机、翻页异常、stop 收尾、onEnd 容错
 * - reset：success 保留、其余重置回等待
 *
 * 环境注入沿用 jevDirection.pipeline.test.ts：wxt 自动导入（computed/logger/jsonClone/delay）、
 * window/localStorage/useToast/alert 全局；'@/message' 用受控 Map 桩。本文件按文件序先于
 * delivery.test.ts 求值，PipelineCacheManager 保持真实实现，缓存断言走真实读写路径。
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
  if (!('useToast' in globalThis)) {
    define('useToast', () => ({ add: () => {} }))
  }
  // rebuild 构建出错会 alert：记录而非抛出，用于断言上报文案（含错误明细）
  define('alert', (message: string) => {
    alerts.push(message)
  })
}

stubBrowserGlobals()

/** 与 migrate.storage.test.ts 同口径的受控存储桩：PipelineCacheManager 的持久化通道 */
const storageMap = new Map<string, unknown>()
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

const { computed } = await import('vue')
const { logger } = await import('@/utils/logger')
const { jsonClone } = await import('@/utils/deepmerge')
// executeAll 的三处 delay 全部瞬时化；isStop 传参语义不受影响
const delay = async () => {}
Object.assign(globalThis, { computed, logger, jsonClone, delay })

const workflowModule = (await import('./index')) as Record<string, any>
const { useDeliveryWorkflow, getCacheManager, cachePipelineResult, checkJobCache } = workflowModule
const { DependencyMissingError } = await import('./type')

beforeEach(() => {
  alerts.length = 0
  storageMap.clear()
})

// ———————————————— 测试脚手架 ————————————————

type AnyTask = {
  id: string
  task: (ctx: any) => Promise<any>
  deps: string[]
  before: Array<(ctx: any, data: any) => any>
  after: Array<(ctx: any, data: any) => any>
  label?: string
  onEnd?: (ctx: any) => any
}

/** id 即 label；注册期 task 返回 handler（任务进入流水线），执行期才调用 handler */
function makeTask(
  id: string,
  handler: (ctx: any, data: any) => any,
  over: Partial<AnyTask> = {},
): AnyTask {
  return {
    id,
    deps: [],
    before: [],
    after: [],
    label: id,
    task: async () => handler,
    ...over,
  }
}

function makeHelper(over: Record<string, any> = {}) {
  const statistics = { total: 0, success: 0, repeat: 0, tasks: {} as Record<string, any> }
  const jobResultMaps = new Map<string, any>()
  const jobMaps = new Map<string, any>()
  const helper: Record<string, any> = {
    uid: 'u-test',
    conf: {
      formData: {
        delayDeliveryStarts: 0,
        delayDeliveryInterval: 0,
        delayDeliveryPageNext: 0,
        deliveryLimit: { value: 10 },
      },
    },
    jobList: { value: [] as Array<Record<string, any>> },
    jobResultMaps,
    jobMaps,
    currentJob: { value: '' },
    statistics: { todayData: { value: statistics } },
    onJobCardClick: async () => {},
    loadMoreJob: async () => false,
    notification: async () => {},
    ...over,
  }
  return { helper, statistics, jobResultMaps }
}

const job = (key: string): Record<string, any> => ({
  key,
  jobName: `岗位${key}`,
  positionName: `岗位${key}`,
  jobDescription: '',
})

// ———————————————— meginResults 合并语义 ————————————————

describe('meginResults 合并语义（经真实 executeTask 汇流）', () => {
  test('状态按 jobStatusList 高位胜出，reason/msg 换行拼接，isSkip/isCache 累积', async () => {
    const { helper, jobResultMaps, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('合并任务', async () => [
          undefined,
          { id: 'a', status: 'success', msg: '第一段', reason: 'r1' },
          { id: 'b', status: 'error', msg: '第二段', reason: 'r2', isCache: true, isSkip: true },
          { status: 'wait', msg: '低位不覆盖' },
        ]),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })

    // isSkip 中途出现 → 流水线中断，合并结果原样落 jobResultMaps
    expect(jobResultMaps.get('k1')).toEqual({
      id: 'a',
      isSkip: true,
      reason: 'r1\nr2',
      status: 'error',
      msg: '第一段\n第二段\n低位不覆盖',
      isCache: true,
    })
    expect(statistics.tasks['合并任务'].error).toBe(1)
    expect(statistics.success).toBe(0)
  })

  test('空数组视为无产出（后续任务照常执行）；id 取首个非空、缺 reason 归 undefined', async () => {
    const seq: string[] = []
    const { helper, jobResultMaps, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('空结果', async () => {
          seq.push('空结果')
          return []
        }),
        makeTask('合并任务', async () => {
          seq.push('合并')
          return [
            undefined,
            { status: 'wait', msg: 'm1', reason: 'r1', isSkip: true },
            { id: 'b', status: 'success', msg: 'm2' },
          ]
        }),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })

    expect(seq).toEqual(['空结果', '合并'])
    expect(jobResultMaps.get('k1')).toEqual({
      id: 'b',
      isSkip: true,
      reason: 'r1',
      status: 'success',
      msg: 'm1\nm2',
    })
    expect(statistics.tasks['合并任务'].success).toBe(1)
  })
})

// ———————————————— rebuild 构建期 ————————————————

describe('rebuild 构建期错误分支', () => {
  test('任务注册抛错 → 节点 failed、alert 上报、errorMessage 汇总，不进流水线', async () => {
    const { helper } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        {
          id: 'boom',
          label: '爆炸任务',
          task: async () => {
            throw new Error('注册失败')
          },
          deps: [],
          before: [],
          after: [],
        } as never,
      ],
      helper as never,
    )
    await wf.rebuild()

    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('工作流构建错误')
    expect(alerts[0]).toContain('注册失败')
    expect(wf.errorMessage.value).toBe('爆炸任务: 注册失败')
    expect(wf.nodes.value[0]).toMatchObject({ id: 'boom', label: '爆炸任务', status: 'failed' })
    expect(wf.pipeline.value).toHaveLength(0)
  })

  test('依赖成环时 rebuild 拒绝并指认环上任务', async () => {
    const { helper } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('A', async () => {}, { deps: ['B'] }),
        makeTask('B', async () => {}, { deps: ['A'] }),
      ] as never,
      helper as never,
    )
    let caught: unknown
    try {
      await wf.rebuild()
    } catch (e) {
      caught = e
    }
    expect(String(caught)).toContain('Cycle: A')
  })
})

// ———————————————— execute 执行语义 ————————————————

describe('execute 单岗执行语义', () => {
  test('普通业务错误 → 记账 error、跳过后续任务、不产生停机决定', async () => {
    const { helper, jobResultMaps, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('投递', async () => {
          throw new PublishError('岗位已下线')
        }),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    const decision = await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })

    expect(decision).toBeUndefined()
    expect(jobResultMaps.get('k1')).toEqual({
      isSkip: true,
      status: 'error',
      reason: '任务投递执行失败: 岗位已下线',
      msg: '报错/投递',
    })
    expect(statistics.tasks['投递'].error).toBe(1)
    expect(statistics.success).toBe(0)
    expect(wf.status.value).toBe('pending') // 状态机归 executeAll 管，execute 不改
  })

  test('LimitError 转为停机决定返回', async () => {
    const { helper, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('投递', async () => {
          throw new LimitError('您今天已与150位BOSS沟通')
        }),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    const decision = await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })

    expect(decision).toEqual({
      abort: true,
      status: 'stop',
      reason: '您今天已与150位BOSS沟通',
    })
    expect(statistics.tasks['投递'].error).toBe(1)
  })

  test('DependencyMissingError：先执行缺失依赖再重试原处理器，随后依赖任务照常排跑', async () => {
    const seq: string[] = []
    let first = true
    const { helper, jobResultMaps, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('主任务', async () => {
          if (first) {
            first = false
            seq.push('主任务:首次')
            throw new DependencyMissingError('依赖任务')
          }
          seq.push('主任务:重试')
          return { status: 'success', msg: '重试成功' }
        }),
        makeTask('依赖任务', async () => {
          seq.push('依赖任务')
        }),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    const decision = await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })

    expect(decision).toBeUndefined()
    expect(seq).toEqual(['主任务:首次', '依赖任务', '主任务:重试', '依赖任务'])
    expect(jobResultMaps.get('k1')).toEqual({ status: 'success', msg: '投递成功' })
    expect(statistics.success).toBe(1)
    expect(statistics.tasks['主任务'].success).toBe(1)
  })

  test('统计记账容器缺失时 finally 抛错向上传播，状态置 error', async () => {
    const { helper, statistics } = makeHelper()
    delete (statistics as Record<string, any>).tasks
    const wf = await useDeliveryWorkflow(
      [makeTask('投递', async () => ({ status: 'success', msg: 'ok' }))] as never,
      helper as never,
    )
    await wf.rebuild()
    let caught: unknown
    try {
      await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(wf.status.value).toBe('error')
  })

  test('注册抛错任务：有下游依赖时进入流水线，执行时原样上抛并记账 error', async () => {
    const { helper, jobResultMaps, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        {
          id: 'boom',
          label: '爆炸任务',
          task: async () => {
            throw new Error('注册失败')
          },
          deps: [],
          before: [],
          after: [],
        } as never,
        makeTask(
          '下游',
          async () => {
            throw new Error('不应执行')
          },
          { deps: ['boom'] },
        ),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    // 抛错任务的兜底 handler 也进流水线，排在依赖它的下游之前
    expect(wf.pipeline.value.map((t: { id: string }) => t.id)).toEqual(['boom', '下游'])

    await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })
    expect(jobResultMaps.get('k1')).toEqual({
      isSkip: true,
      status: 'error',
      reason: '任务爆炸任务执行失败: 注册失败',
      msg: '报错/爆炸任务',
    })
    expect(statistics.tasks['boom'].error).toBe(1)
  })

  test('DependencyMissingError 指向未知任务时重试缺位，execute 记账 error 不上抛', async () => {
    const seq: string[] = []
    const { helper, jobResultMaps, statistics } = makeHelper()
    const wf = await useDeliveryWorkflow(
      [
        makeTask('主任务', async () => {
          seq.push('主任务')
          throw new DependencyMissingError('不存在的任务')
        }),
      ] as never,
      helper as never,
    )
    await wf.rebuild()
    await wf.execute({ jobData: job('k1'), rawData: {}, state: {} })

    expect(seq).toEqual(['主任务']) // 无依赖可解析：不重试、不进后续流程
    expect(jobResultMaps.get('k1')).toEqual({
      isSkip: true,
      status: 'error',
      reason: '任务主任务执行失败: Task dependency missing: 不存在的任务',
      msg: '报错/主任务',
    })
    expect(statistics.tasks['主任务'].error).toBe(1)
  })
})

// ———————————————— executeAll 批量语义 ————————————————

describe('executeAll 批量语义', () => {
  test('整批投递：预置状态重置、节流观察器接线、翻页续跑、空列表收尾、onEnd 抛错被吞', async () => {
    const seq: string[] = []
    const throttleCalls: number[] = []
    const notificationCalls: string[] = []
    const { helper, jobResultMaps, statistics } = makeHelper({
      jobList: { value: [job('j1'), job('j2')] },
      backgroundThrottle: {
        begin: (requested: number) => {
          throttleCalls.push(requested)
          return () => ({ requested, actual: 0 })
        },
        end: () => undefined,
      },
      loadMoreJob: async () => {
        seq.push('翻页')
        if (seq.filter((s) => s === '翻页').length >= 2) {
          helper.jobList.value = []
          return true
        }
        return true
      },
      notification: async (msg: string) => {
        notificationCalls.push(msg)
      },
    })
    jobResultMaps.set('j1', { status: 'running', msg: '获取中' })
    jobResultMaps.set('j2', { status: 'success', msg: '旧成功' })
    const wf = await useDeliveryWorkflow(
      [
        makeTask(
          '投递',
          async (_c: unknown, d: any) => {
            seq.push(`投递:${d.jobData.key}`)
            return { status: 'success', msg: '已投递' }
          },
          {
            onEnd: async () => {
              throw new Error('收尾炸了')
            },
          },
        ),
      ] as never,
      helper as never,
    )
    await wf.executeAll(new Map())

    // 只投 j1（j2 旧成功被跳过）；两轮翻页后列表清空收尾
    expect(seq).toEqual(['投递:j1', '翻页', '翻页'])
    expect(statistics.success).toBe(1)
    expect(statistics.tasks['投递'].success).toBe(1)
    expect(jobResultMaps.get('j1')).toEqual({ status: 'success', msg: '投递成功' })
    expect(jobResultMaps.get('j2')).toEqual({ status: 'success', msg: '旧成功' })
    // starts + interval + page（第一轮）与 starts + page（第二轮，双双跳过无 interval）
    expect(throttleCalls).toEqual([0, 0, 0, 0, 0])
    expect(wf.status.value).toBe('error')
    expect(wf.errorMessage.value).toBe('没有职位可投递')
    expect(notificationCalls).toEqual(['没有职位可投递'])
  })
})

// ———————————————— reset ————————————————

describe('executeAll 批量语义（续）：上限、停机与异常收尾', () => {
  test('本地投递上限岗前拦截：达到上限后不再发任何投递', async () => {
    const seq: string[] = []
    const notificationCalls: string[] = []
    const { helper, jobResultMaps, statistics } = makeHelper({
      conf: {
        formData: {
          delayDeliveryStarts: 0,
          delayDeliveryInterval: 0,
          delayDeliveryPageNext: 0,
          deliveryLimit: { value: 1 },
        },
      },
      jobList: { value: [job('j1'), job('j2')] },
      loadMoreJob: async () => false,
      notification: async (msg: string) => {
        notificationCalls.push(msg)
      },
    })
    helper.statistics.todayData.value.success = 1 // 预置已达上限
    const wf = await useDeliveryWorkflow(
      [
        makeTask('投递', async (_c: unknown, d: any) => {
          seq.push(`投递:${d.jobData.key}`)
          return { status: 'success', msg: '已投递' }
        }),
      ] as never,
      helper as never,
    )
    await wf.executeAll(new Map())

    expect(seq).toEqual([]) // 岗前拦截，零投递
    expect(statistics.success).toBe(1)
    expect(wf.status.value).toBe('stop')
    expect(wf.errorMessage.value).toBe('投递结束, 无法继续下一页')
    expect(notificationCalls).toEqual(['投递结束, 无法继续下一页'])
    expect(jobResultMaps.get('j1')).toEqual({ status: 'wait', msg: '等待中' })
  })

  test('本地投递上限岗后达标：本轮岗位投出后立即停机，上限原因原样通知', async () => {
    const seq: string[] = []
    const notificationCalls: string[] = []
    const { helper, jobResultMaps, statistics } = makeHelper({
      conf: {
        formData: {
          delayDeliveryStarts: 0,
          delayDeliveryInterval: 0,
          delayDeliveryPageNext: 0,
          deliveryLimit: { value: 1 },
        },
      },
      jobList: { value: [job('j1')] },
      loadMoreJob: async () => true,
      notification: async (msg: string) => {
        notificationCalls.push(msg)
      },
    })
    const wf = await useDeliveryWorkflow(
      [
        makeTask('投递', async (_c: unknown, d: any) => {
          seq.push(`投递:${d.jobData.key}`)
          return { status: 'success', msg: '已投递' }
        }),
      ] as never,
      helper as never,
    )
    await wf.executeAll(new Map())

    expect(seq).toEqual(['投递:j1'])
    expect(statistics.success).toBe(1)
    expect(wf.status.value).toBe('stop')
    expect(wf.errorMessage.value).toBe('已达到本地投递上限 1，已停止投递')
    expect(notificationCalls).toEqual(['已达到本地投递上限 1，已停止投递'])
    expect(jobResultMaps.get('j1')).toEqual({ status: 'success', msg: '投递成功' })
  })

  test('LimitError 停机决定上抛 → executeAll 置 stop 并原样通知', async () => {
    const notificationCalls: string[] = []
    const { helper, statistics } = makeHelper({
      jobList: { value: [job('j1'), job('j2')] },
      loadMoreJob: async () => true,
      notification: async (msg: string) => {
        notificationCalls.push(msg)
      },
    })
    const wf = await useDeliveryWorkflow(
      [
        makeTask('投递', async () => {
          throw new LimitError('您今天已与150位BOSS沟通')
        }),
      ] as never,
      helper as never,
    )
    await wf.executeAll(new Map())

    expect(statistics.tasks['投递'].error).toBe(1)
    expect(statistics.success).toBe(0)
    expect(wf.status.value).toBe('stop')
    expect(wf.errorMessage.value).toBe('您今天已与150位BOSS沟通')
    expect(notificationCalls).toEqual(['您今天已与150位BOSS沟通'])
  })

  test('翻页抛错 → 未知错误分支：状态 error、errorMessage 带前缀，普通岗位错误只记账不终止', async () => {
    const notificationCalls: string[] = []
    const { helper, statistics } = makeHelper({
      jobList: { value: [job('j1')] },
      loadMoreJob: async () => {
        throw new Error('翻页失败')
      },
      notification: async (msg: string) => {
        notificationCalls.push(msg)
      },
    })
    const wf = await useDeliveryWorkflow(
      [
        makeTask('投递', async () => {
          throw new Error('意外炸了')
        }),
      ] as never,
      helper as never,
    )
    await wf.executeAll(new Map())

    expect(statistics.tasks['投递'].error).toBe(1) // abort:false → 继续走完才在翻页处炸
    expect(wf.status.value).toBe('error')
    expect(wf.errorMessage.value).toBe('未知错误: 翻页失败')
    expect(notificationCalls).toEqual(['未知错误: 翻页失败'])
  })

  test('运行中 stop → 收尾归 pending，提示「投递结束」，不写 errorMessage', async () => {
    const notificationCalls: string[] = []
    const wfHolder: { wf?: { stop: () => void } } = {}
    const { helper, statistics } = makeHelper({
      jobList: { value: [job('j1')] },
      loadMoreJob: async () => {
        wfHolder.wf?.stop()
        return true
      },
      notification: async (msg: string) => {
        notificationCalls.push(msg)
      },
    })
    const wf = await useDeliveryWorkflow(
      [makeTask('投递', async () => ({ status: 'success', msg: '已投递' }))] as never,
      helper as never,
    )
    wfHolder.wf = wf
    await wf.executeAll(new Map())

    expect(statistics.success).toBe(1)
    expect(wf.status.value).toBe('pending')
    expect(wf.errorMessage.value).toBeNull()
    expect(notificationCalls).toEqual(['投递结束'])
  })
})

describe('reset 重置语义', () => {
  test('状态归 pending；非 success 结果重置回等待，success 与缺失条目不动', async () => {
    const { helper, jobResultMaps } = makeHelper({
      jobList: { value: [job('j1'), job('j2'), job('j3')] },
    })
    jobResultMaps.set('j1', { status: 'success', msg: '投递成功' })
    jobResultMaps.set('j2', { status: 'error', msg: '报错/投递' })
    const wf = await useDeliveryWorkflow([] as never, helper as never)
    await wf.rebuild()

    wf.reset()

    expect(wf.status.value).toBe('pending')
    expect(jobResultMaps.get('j1')).toEqual({ status: 'success', msg: '投递成功' })
    expect(jobResultMaps.get('j2')).toEqual({ status: 'wait', msg: '等待中' })
    expect(jobResultMaps.has('j3')).toBe(false)
  })
})

// ———————————————— 模块缓存 API ————————————————

describe('模块缓存 API（getCacheManager / cachePipelineResult / checkJobCache）', () => {
  test('单例复用；过期条目与 error 结果不命中；成功结果写入并可命中且持久化', async () => {
    const past = Date.now() - 1000
    storageMap.set('local:pipeline-cache', {
      data: {
        'stale-job': {
          encryptJobId: 'stale-job',
          jobName: '旧岗',
          brandName: '旧公司',
          status: 'success',
          message: '旧结果',
          expireAt: past,
          createdAt: past,
          lastAccessed: past,
          hitCount: 0,
          processorType: 'basic',
        },
      },
      lastCleanup: Date.now(),
    })

    const first = getCacheManager()
    await new Promise((resolve) => setTimeout(resolve, 0)) // initCache 异步装填
    expect(getCacheManager()).toBe(first) // 模块级单例
    // 防 mock 串扰自证：若本文件被别处的空类桩抢先解析，这里立即失败而不是静默假绿
    expect(typeof (first as unknown as Record<string, unknown>).setCacheResult).toBe('function')
    expect(typeof (first as unknown as Record<string, unknown>).isValidCache).toBe('function')
    expect(checkJobCache('stale-job')).toBeNull() // 过期条目不命中

    await cachePipelineResult('job-1', '前端工程师', '某公司', 'success', '投递成功', 'aiFiltering')
    const hit = checkJobCache('job-1')
    expect(hit).not.toBeNull()
    expect(hit!.status).toBe('success')
    expect(hit!.message).toBe('投递成功')
    expect(hit!.processorType).toBe('aiFiltering')
    expect(hit!.hitCount).toBeGreaterThanOrEqual(1) // 命中刷新 LRU 计数
    const persisted = storageMap.get('local:pipeline-cache') as { data: Record<string, any> }
    expect(persisted.data['job-1'].message).toBe('投递成功')

    await cachePipelineResult('job-err', '出错岗', '某公司', 'error', '失败', 'basic')
    expect(checkJobCache('job-err')).toBeNull() // error 结果不缓存
  })
})
