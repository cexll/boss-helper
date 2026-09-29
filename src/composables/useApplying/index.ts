import type { ContextLogger } from 'devlog-ui'
import type { Ref, ShallowRef } from 'vue'
import { computed, shallowRef, ref } from 'vue'

import { PipelineCacheManager } from '@/composables/usePipelineCache'
import type { PipelineCacheItem, ProcessorType } from '@/types/pipelineCache'

import type { HelperContext, JobData } from '../useHelper'
import { decideDeliveryLimitAbort, decideTaskErrorAbort } from './abortPolicy'
import type { WorkflowAbortDecision } from './abortPolicy'
import type { BackgroundThrottleStore } from './backgroundState'
import type {
  Handler,
  JobStatus,
  Task,
  TaskContext,
  TaskPipeline,
  TaskResult,
  TaskStatus,
  WorkflowData,
} from './type'
import { DependencyMissingError, jobStatusList } from './type'

// 全局缓存管理器实例
let cacheManager: PipelineCacheManager | null = null

/**
 * 创建缓存实例
 */
export function getCacheManager(): PipelineCacheManager {
  if (!cacheManager) {
    cacheManager = new PipelineCacheManager()
  }
  return cacheManager
}

/**
 * 缓存Pipeline处理结果
 */
export async function cachePipelineResult(
  key: string,
  jobName: string,
  brandName: string,
  status: JobStatus,
  message: string,
  processorType?: ProcessorType,
): Promise<void> {
  const cacheManager = getCacheManager()
  await cacheManager.setCacheResult(key, jobName, brandName, status, message, processorType)
}

/**
 * 检查职位是否有有效缓存
 */
export function checkJobCache(key: string): PipelineCacheItem | null {
  const cacheManager = getCacheManager()

  if (cacheManager.isValidCache(key)) {
    const cached = cacheManager.getCachedResult(key)
    return cached
  }
  return null
}

export type DeliveryWorkflow<C extends HelperContext<C, T, S>, T, S> = Awaited<
  ReturnType<typeof useDeliveryWorkflow<C, T, S>>
>

export function defineTaskWorkflow<C extends HelperContext<C, T, S>, T, S = {}>(
  ...items: Array<Task<C, T, S> | TaskPipeline<C, T, S> | (() => Task<C, T, S>)>
): (ctx: C) => Promise<DeliveryWorkflow<C, T, S>> {
  const allDefinitions = items.flatMap((i) => (typeof i === 'function' ? i() : i))

  return async (_ctx: C) => useDeliveryWorkflow(allDefinitions, _ctx)
}

function meginResults(res: void | TaskResult | Array<TaskResult | void>): TaskResult | void {
  if (!res) return
  if (Array.isArray(res)) {
    if (res.length === 0) return
    return res.reduce((acc: TaskResult, r) => {
      if (!r) return acc
      let mergedStatus = acc.status
      if (r.status) {
        const accStatusIndex = jobStatusList.indexOf(acc.status as any) ?? -1
        const rStatusIndex = jobStatusList.indexOf(r.status)
        if (rStatusIndex > accStatusIndex) {
          mergedStatus = r.status
        }
      }
      return {
        id: acc.id || r.id,
        isSkip: acc.isSkip || r.isSkip,
        reason: [acc.reason, r.reason].filter(Boolean).join('\n') || undefined,
        status: mergedStatus,
        msg: [acc.msg, r.msg].filter(Boolean).join('\n') || undefined,
        isCache: acc.isCache || r.isCache,
      }
    }, res[0] ?? {})
  }
  return res
}

// 拆分说明：useDeliveryWorkflow 原先内嵌 rebuild/executeTask/execute/executeAll 四个闭包，
// 复杂度被门禁折算进父函数（cx 64 > 15.76）。此处按职责上提为顶层函数，行为逐字保持：
// delay 实参与顺序、节流 observe 接线、投递上限/停机/异常语义、通知与 onEnd 收尾均不变。
// 共享状态通过显式 rt 上下文传递；C 的自引用约束只在 rt 的类型参数里出现一次。
type WorkflowRuntime<C extends HelperContext<C, T, S>, T, S> = {
  items: Array<Task<C, T, S> | TaskPipeline<C, T, S> | (() => Task<C, T, S>)>
  helper: C
  status: Ref<'pending' | 'running' | 'stop' | 'error'>
  current: Ref<number>
  errorMessage: Ref<string | null>
  pipeline: ShallowRef<Task<C, T, S>[]>
  nodes: ShallowRef<
    Array<{
      id: string
      label: string
      status: TaskStatus
      deps: string[]
      error?: any
    }>
  >
  stateMaps: Ref<Map<string, any>>
  resolvedHandlers: Map<string, Handler<C, T, S>>
}

function buildNodeStates(
  rawTasks: Task<any, any, any>[],
  taskMap: Map<string, Task<any, any, any>>,
  resolvedHandlers: Map<string, any>,
  errors: Map<string, any>,
  requiredIds: Set<string>,
) {
  return rawTasks.map((t) => {
    const isLastDefinition = taskMap.get(t.id)?.task === t.task
    const isResolved = resolvedHandlers.has(t.id)
    const error = errors.get(`${t.id}::${t.label}`)
    let nStatus: TaskStatus = 'disabled'
    if (!isLastDefinition) nStatus = 'shadowed'
    else if (error) nStatus = 'failed'
    else if (isResolved) nStatus = 'active'
    else if (requiredIds.has(t.id)) nStatus = 'dependency_only'

    return {
      id: t.id,
      label: t.label || t.id,
      status: nStatus,
      deps: t.deps,
      error,
    }
  })
}

function buildNodeErrorMessage(
  nodes: Array<{ id: string; label: string; status: TaskStatus; deps: string[]; error?: any }>,
) {
  return nodes
    .map((i) => {
      if (i.error) {
        return `${i.label}: ${i.error instanceof Error ? i.error.message : JSON.stringify(i.error)}`
      }
    })
    .filter(Boolean)
    .join('\n')
}

async function rebuildWorkflow<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
): Promise<void> {
  const _ctx: TaskContext<C, T, S> = {
    helper: rt.helper,
    now: new Date(),
    index: 0,
    log: logger.withContext({ id: 'workflow-rebuild' }),
  }
  const taskMap = new Map<string, Task<C, T, S>>()
  const _resolvedHandlers = new Map<string, any>()
  const errors = new Map<string, any>()

  const rawTasks = rt.items.flatMap((i) =>
    typeof i === 'function' ? { ...i() } : Array.isArray(i) ? i : { ...i },
  )
  const requiredIds = new Set<string>()
  for (const task of rawTasks) {
    try {
      taskMap.set(task.id, task)
      const result = await task.task(_ctx)
      if (!result) continue

      requiredIds.add(task.id)
      task.deps.forEach((d) => requiredIds.add(d))

      if (typeof result === 'function') {
        _resolvedHandlers.set(task.id, result)
      } else {
        _resolvedHandlers.set(task.id, result.fn)
        if (result.before) task.before.push(...result.before)
        if (result.after) task.after.push(...result.after)
      }
    } catch (e) {
      errors.set(`${task.id}::${task.label}`, e)
      _resolvedHandlers.set(task.id, async () => {
        throw e
      })
    }
  }

  const _pipeline: Task<C, T, S>[] = []
  const visited = new Set<string>()
  const stack = new Set<string>()
  const sort = (id: string) => {
    if (stack.has(id)) throw new Error(`Cycle: ${id}`)
    if (visited.has(id)) return
    const t = taskMap.get(id)
    if (!t || !requiredIds.has(id)) return
    stack.add(id)
    t.deps.forEach(sort)
    stack.delete(id)
    visited.add(id)
    _pipeline.push(t)
  }
  Array.from(requiredIds).forEach(sort)

  rt.pipeline.value = _pipeline
  rt.resolvedHandlers.clear()
  _resolvedHandlers.forEach((v, k) => rt.resolvedHandlers.set(k, v))

  rt.nodes.value = buildNodeStates(rawTasks, taskMap, _resolvedHandlers, errors, requiredIds)
  const errMsg = buildNodeErrorMessage(rt.nodes.value)
  if (errMsg) {
    logger.error('工作流构建错误, 请检查配置:', errMsg)
    alert(`工作流构建错误, 请检查配置:\n${errMsg}`)
    rt.errorMessage.value = errMsg
  } else {
    logger.debug('Pipeline rebuilt', jsonClone(rt.pipeline.value))
  }
}

async function runTaskWithHooks<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  task: Task<C, T, S>,
  data: WorkflowData<T, S>,
  index: number,
  log: ContextLogger,
) {
  let res: TaskResult | void = undefined
  const isStop = () => rt.status.value === 'stop'
  const handler = rt.resolvedHandlers.get(task.id)
  if (!handler || isStop()) return

  const fns = [...task.before, handler, ...task.after]
  log = log.withContext({ task_id: task.id })

  for (const fn of fns) {
    try {
      res = meginResults(
        await fn(
          {
            helper: rt.helper,
            now: new Date(),
            index,
            log,
          },
          data,
        ),
      )
      if (res?.isSkip || isStop()) break
    } catch (e) {
      if (e instanceof DependencyMissingError) {
        const dep = rt.resolvedHandlers.get(e.taskId)
        if (dep) {
          await dep(
            {
              helper: rt.helper,
              now: new Date(),
              index,
              log,
            },
            data,
          )
          res = meginResults(
            await fn(
              {
                helper: rt.helper,
                now: new Date(),
                index,
                log,
              },
              data,
            ),
          )
          if (res?.isSkip || isStop()) break
          continue
        }
      }
      throw e
    }
  }
  return res
}

// 单任务结果落账：合并进 jobResultMaps 并按任务/状态累加统计。
function recordTaskResult<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  t: Task<C, T, S>,
  data: WorkflowData<T, S>,
  res: void | TaskResult,
) {
  if (res == null) return
  rt.helper.jobResultMaps.set(data.jobData.key, {
    ...(rt.helper.jobResultMaps.get(data.jobData.key) ?? {}),
    ...res,
  })
  if (res.status) {
    rt.helper.statistics.todayData.value.tasks[t.id] ??= {}
    rt.helper.statistics.todayData.value.tasks[t.id]![res.status] ??= 0
    rt.helper.statistics.todayData.value.tasks[t.id]![res.status]! += 1
  }
}

function applyTaskLabel(res: TaskResult, t: Task<any, any, any>) {
  res.msg ??= t.label ?? t.id
  res.status ??= res.isSkip ? 'warn' : undefined
}

function buildTaskErrorResult(t: Task<any, any, any>, e: unknown): TaskResult {
  return {
    isSkip: true,
    status: 'error',
    reason: `任务${t.label ?? t.id}执行失败: ${e instanceof Error ? e.message : JSON.stringify(e)}`,
    msg: `报错/${t.label ?? t.id}`,
  }
}

/** 流水线内单个任务的执行结果。stopLoop = true 表示不再继续后续任务。 */
type PipelineStep = {
  res: TaskResult | void
  abortDecision: WorkflowAbortDecision | undefined
  skipPipeline: boolean
  errorLog: boolean
  stopLoop: boolean
}

const STEP_CONTINUE: PipelineStep = {
  res: undefined,
  abortDecision: undefined,
  skipPipeline: false,
  errorLog: false,
  stopLoop: false,
}

async function runPipelineTask<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  t: Task<C, T, S>,
  data: WorkflowData<T, S>,
  index: number,
  log: ContextLogger,
): Promise<PipelineStep> {
  const isStop = () => rt.status.value === 'stop'
  let res: TaskResult | void = undefined
  let abortDecision: WorkflowAbortDecision | undefined = undefined
  try {
    if (isStop()) return { ...STEP_CONTINUE, stopLoop: true }
    rt.helper.jobResultMaps.set(data.jobData.key, {
      status: t.state || 'running',
      msg: t.stateMsg || '运行中',
    })
    res = await runTaskWithHooks(rt, t, data, index, log)
    if (res != null) {
      applyTaskLabel(res, t)
      if (res.isSkip) {
        return { ...STEP_CONTINUE, res, skipPipeline: true, stopLoop: true }
      }
    }
    if (isStop()) return { ...STEP_CONTINUE, res, stopLoop: true }
  } catch (e) {
    res = buildTaskErrorResult(t, e)
    log.error(`任务${t.label ?? t.id}执行失败`, e)
    const decision = decideTaskErrorAbort(e)
    if (decision.abort) {
      abortDecision = decision
    }
    return {
      ...STEP_CONTINUE,
      res,
      skipPipeline: true,
      errorLog: true,
      stopLoop: true,
      abortDecision,
    }
  } finally {
    recordTaskResult(rt, t, data, res)
  }
  return { ...STEP_CONTINUE, res }
}

async function executeWorkflowJob<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  data: WorkflowData<T, S>,
  index = 0,
): Promise<WorkflowAbortDecision | undefined> {
  const helper = rt.helper
  helper.statistics.todayData.value.total++
  const log = logger.withContext({
    id: 'workflow-execute',
    job_key: data.jobData.key,
    job_name: data.jobData.jobName,
  })
  try {
    let skipPipeline = false
    let abortDecision: WorkflowAbortDecision | undefined
    let errorLog = false
    for (const t of rt.pipeline.value) {
      const step = await runPipelineTask(rt, t, data, index, log)
      if (step.abortDecision) {
        abortDecision = step.abortDecision
      }
      errorLog = errorLog || step.errorLog
      skipPipeline = skipPipeline || step.skipPipeline
      if (step.stopLoop) break
    }
    if (!skipPipeline) {
      helper.jobResultMaps.set(data.jobData.key, {
        status: 'success',
        msg: '投递成功',
      })
      helper.statistics.todayData.value.success++
    } else if (!errorLog) {
      const r = helper.jobResultMaps.get(data.jobData.key)
      log.warn(`投递过滤: ${data.jobData.jobName}`, r?.msg, r?.reason)
    }
    return abortDecision
  } catch (e) {
    rt.status.value = 'error'
    throw e
  }
}

// t11 薄委托：把每次 delay 的实测耗时喂给节流提示 store（判定与文案都在 backgroundState.ts）。
// 只观测、不干预：await delay(...) 的实参、顺序与 isStop 语义完全不变。
// store 由 BossHelperCtx 提供；测试桩等未挂载该字段的 helper 直接跳过观测，不参与判定。
function makeThrottleObserver(helper: HelperContext<any, any, any>) {
  const throttle = (
    helper as HelperContext<any, any, any> & { backgroundThrottle?: BackgroundThrottleStore }
  ).backgroundThrottle
  return (requested: number) => {
    if (!throttle) return undefined
    const timer = throttle.begin(requested)
    return () => throttle.end(timer())
  }
}

function resetWaitingJobs(helper: HelperContext<any, any, any>) {
  helper.jobList.value.forEach((job) => {
    const v = helper.jobResultMaps.get(job.key)
    if (!v) {
      helper.jobResultMaps.set(job.key, { status: 'wait', msg: '等待中' })
      return
    } else if (v.status === 'success' || v.status === 'warn') {
      return
    }
    v.status = 'wait'
    v.msg = '等待中'
    helper.jobResultMaps.set(job.key, v)
  })
}

/** 单岗执行结果：undefined = 正常走完本岗（含岗间隔）；'continue' = 跳到下一岗；其余 = 停机决定。 */
type JobStepOutcome =
  | { abort: true; status: 'stop' | 'error'; reason: string }
  | 'continue'
  | undefined

async function runJobInPage<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  jobData: JobData,
  index: number,
  rawDataMap: Map<string, T>,
): Promise<JobStepOutcome> {
  const helper = rt.helper
  const limitDecision = decideDeliveryLimitAbort(
    helper.statistics.todayData.value.success,
    helper.conf.formData.deliveryLimit.value,
  )
  if (limitDecision.abort) {
    return limitDecision
  }

  const jobStatus = helper.jobResultMaps.get(jobData.key)?.status
  if (jobStatus === 'success' || jobStatus === 'warn') {
    return 'continue'
  }
  const data: WorkflowData<T, S> = {
    jobData,
    rawData: rawDataMap.get(jobData.key)!,
    state: rt.stateMaps.value.get(jobData.key) || {},
  }
  helper.jobMaps.set(jobData.key, data)
  helper.currentJob.value = jobData.key
  const abortDecision = await executeWorkflowJob(rt, data, index)
  if (abortDecision?.abort) {
    return abortDecision
  }

  const afterSuccessLimit = decideDeliveryLimitAbort(
    helper.statistics.todayData.value.success,
    helper.conf.formData.deliveryLimit.value,
  )
  return afterSuccessLimit.abort ? afterSuccessLimit : undefined
}

async function finalizeWorkflowRun<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  stepMsg: string,
): Promise<void> {
  if (!stepMsg) {
    stepMsg = '投递结束'
    rt.status.value = 'pending'
  } else if (rt.status.value !== 'stop') {
    rt.status.value = 'error'
    rt.errorMessage.value = stepMsg
  } else {
    rt.errorMessage.value = stepMsg
  }
  void rt.helper.notification(stepMsg)

  const now = new Date()
  for (const t of rt.pipeline.value) {
    try {
      await t.onEnd?.({
        now,
        helper: rt.helper,
        index: 0,
        log: logger.withContext({ id: 'workflow-end' }),
      })
    } catch (e) {
      logger.error('onEnd error', t.id, e)
    }
  }
}

async function executeWorkflowAll<C extends HelperContext<C, T, S>, T, S>(
  rt: WorkflowRuntime<C, T, S>,
  rawDataMap: Map<string, T>,
) {
  await rebuildWorkflow(rt)

  let stepMsg = ''
  rt.errorMessage.value = null
  rt.status.value = 'running'
  const isStop = () => rt.status.value === 'stop'
  const observe = makeThrottleObserver(rt.helper)
  const helper = rt.helper

  try {
    while (rt.status.value === 'running') {
      if (helper.jobList.value.length === 0) {
        stepMsg = '没有职位可投递'
        break
      }
      resetWaitingJobs(helper)

      const finishStart = observe(helper.conf.formData.delayDeliveryStarts)
      await delay(helper.conf.formData.delayDeliveryStarts, isStop)
      finishStart?.()

      for (const [index, jobData] of helper.jobList.value.entries()) {
        rt.current.value = index + 1
        if (isStop()) break

        const outcome = await runJobInPage(rt, jobData, index, rawDataMap)
        if (outcome === 'continue') continue
        if (outcome) {
          rt.status.value = outcome.status
          stepMsg = outcome.reason
          break
        }

        const finishInterval = observe(helper.conf.formData.delayDeliveryInterval)
        await delay(helper.conf.formData.delayDeliveryInterval, isStop)
        finishInterval?.()
      }
      const finishPage = observe(helper.conf.formData.delayDeliveryPageNext)
      const hasMore = await helper.loadMoreJob(
        delay(helper.conf.formData.delayDeliveryPageNext, isStop),
      )
      finishPage?.()
      if (!hasMore) {
        rt.status.value = 'stop'
        stepMsg = '投递结束, 无法继续下一页'
        break
      }
    }
  } catch (e) {
    logger.error('投递未知错误', e)
    stepMsg = `未知错误: ${e instanceof Error ? e.message : JSON.stringify(e)}`
  } finally {
    await finalizeWorkflowRun(rt, stepMsg)
  }
}

export async function useDeliveryWorkflow<C extends HelperContext<C, T, S>, T, S>(
  items: Array<Task<C, T, S> | TaskPipeline<C, T, S> | (() => Task<C, T, S>)>,
  helper: C,
) {
  const status = ref<'pending' | 'running' | 'stop' | 'error'>('pending')
  const current = ref(0)
  const total = computed(() => helper.jobList.value.length)
  const errorMessage = ref<string | null>(null)
  const pipeline = shallowRef<Task<C, T, S>[]>([])
  const nodes = shallowRef<
    Array<{
      id: string
      label: string
      status: TaskStatus
      deps: string[]
      error?: any
    }>
  >([])
  const stateMaps = ref(new Map<string, any>())
  const resolvedHandlers = new Map<string, Handler<C, T, S>>()

  const rt: WorkflowRuntime<C, T, S> = {
    items,
    helper,
    status,
    current,
    errorMessage,
    pipeline,
    nodes,
    stateMaps,
    resolvedHandlers,
  }

  const execute = async (
    data: WorkflowData<T, S>,
    index = 0,
  ): Promise<WorkflowAbortDecision | undefined> => executeWorkflowJob(rt, data, index)

  const executeAll = async (rawDataMap: Map<string, T>) => executeWorkflowAll(rt, rawDataMap)

  const stop = () => (rt.status.value = 'stop')
  const reset = () => {
    rt.status.value = 'pending'
    helper.jobList.value.forEach((job) => {
      const v = helper.jobResultMaps.get(job.key)
      if (!v || v.status === 'success') {
        return
      }
      v.msg = '等待中'
      v.status = 'wait'
    })
  }

  return {
    items,
    status,
    current,
    total,
    errorMessage,
    pipeline,
    nodes,
    ctx: helper,
    stateMaps,
    rebuild: () => rebuildWorkflow(rt),
    execute,
    executeAll,
    stop,
    reset,
  }
}
