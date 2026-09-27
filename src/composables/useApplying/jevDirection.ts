/**
 * Jev 方向判定（t8）：把 t5 的 `JevOutcome` 翻译成流水线决策。
 *
 * 两阶段语义（FR-012 / CONTEXT.md，p1 docs/probes/jev-p1-record.md 实测口径）：
 * - 标题阶段只凭岗位标题问 Jev：明确相关 → 继续流水线；**确认**不相关 → 跳过（不取详情、不调 AI）；
 *   含糊 → 取详情后用标题+描述复判一次，仍无法判断 → 待复核（p1 §5：标题 0.02 的描述翻转 0.89，
 *   故带内的标题否定不是终判）。
 * - 失败一律 fail-closed：报错 / 超时 / 形态异常绝不放行也绝不当作排除（AGENTS.md、FR-013）。
 *
 * 本模块是纯逻辑 + 注入依赖：不发请求（askJev 注入）、不读配置（getTargetDirection 注入）、
 * 不记账（recordReviewNeeded 注入）、不读存储（getApiKey 透传给 t5 客户端）。因此可在 bun 下
 * 单测覆盖，不依赖 Vue/DOM/扩展上下文（spec Constraints：匹配与处置逻辑放 .ts 模块）。
 *
 * 交接（handoff）：标题含糊且当前没有描述时，判定不在这里终结——由流水线的「岗位详情获取 +
 * 职位描述关键词」步骤之后再次调用本模块（stage='recheck'）完成复判。交接标记由调用方持有
 * （delivery.ts 每次构建流水线时创建一次）。
 *
 * 结果缓存（t9 / FR-015）：明确终判（pass / confirmed-negative）按「岗位 + 判定依据」缓存，
 * 判定依据 = 目标方向描述 + Jev 模型标识（响应里的具体版本，p1 §3.2）。命中缓存在 askJev
 * 之前直接复用，后续流水线步骤与新鲜终判一致；待复核（不确定 / 超时 / 报错）绝不写缓存
 * （FR-013）。缓存实现与键语义在 jevCache.ts，本模块只做查 / 写，实例经 deps.cache 注入，
 * 缺省用会话级单例（随投递运行生命周期）。
 */

import type { JevJobInput, JevKeyReader, JevNoulQuestion, JevOutcome } from '@/utils/jev'

import { jevCache } from './jevCache'
import type { JevCache, JevCachedDecision } from './jevCache'
import type {
  ReviewNeededCounter,
  ReviewNeededReasonKind,
  RecordReviewNeededOptions,
} from './reviewNeeded'

/** p1 §6.2 建议带（待用户确认，只改这一处）：noul ≤ low 判「否」，noul ≥ high 判「是」 */
export const JEV_UNCERTAIN_BAND = { low: 0.2, high: 0.8 } as const

/**
 * 标题阶段「确认不相关」的下界：与含糊带共用同一个带（p1 §6.2 镜像口径）。
 * 只有落在带外（≤ low）的标题否定才允许跳过详情获取；带内一律当作「待复判」。
 */
const JEV_TITLE_CONFIRM_NO = JEV_UNCERTAIN_BAND.low

/** 发往 Jev 的问题 id（t5 单问题载荷） */
const JEV_QUESTION_ID = 'direction'

/** F-029：启用但方向为空的缺字段口径（与 handles.ts 的 missing-field 路径同类）。 */
const MISSING_DIRECTION_REASON = '目标方向为空，Jev 无法判断'

/** 发给 Jev 的是非（noul）问题定义：目标方向进入问题文本，岗位内容只走 state（FR-011） */
interface JevDirectionQuestion {
  id: string
  instructions: string
  criteria: { true: string; false: string }
}

export type JevStage = 'title' | 'recheck'

export interface JevDirectionJob {
  key: string
  jobName: string
  jobDescription?: string
}

export type JevDirectionDecision =
  | { decision: 'pass' }
  | { decision: 'skip'; reason: string }
  | { decision: 'reviewNeeded'; reason: string; kind: ReviewNeededReasonKind }

/** 注入的 t5 客户端形态：模块只组装岗位内容与问题，密钥读取透传给调用方注入的读取器 */
export type JevAskFn = (
  job: JevJobInput,
  question: JevDirectionQuestion,
  getApiKey?: JevKeyReader,
) => Promise<JevOutcome>

/** 标题阶段 → 复判阶段的交接：按岗位 key 记一次「待复判」，取走即消费 */
export interface JevStageHandoff {
  markPending(key: string): void
  takePending(key: string): boolean
}

export interface JevDirectionDeps {
  /** title：流水线标题阶段（详情未取）；recheck：详情阶段复判 */
  stage: JevStage
  askJev: JevAskFn
  getTargetDirection: () => string | null | undefined
  recordReviewNeeded: (
    jobData: { key: string; jobName: string },
    reason: string,
    kind: ReviewNeededReasonKind,
    statistics: ReviewNeededCounter,
    options?: RecordReviewNeededOptions,
  ) => boolean
  statistics: ReviewNeededCounter
  /** t6 / fx-006：当日去重键（getCurDay() 口径），注入保持本模块无时钟依赖 */
  getToday: () => string
  getApiKey?: JevKeyReader
  /**
   * t9：明确结果缓存（判定依据 = 目标方向 + Jev 模型标识）。缺省用 jevCache 会话级单例；
   * 注入用于单测隔离。命中缓存时不再请求 Jev，流水线后续步骤与新鲜终判一致。
   */
  cache?: JevCache
  handoff?: JevStageHandoff
}

export function createJevStageHandoff(): JevStageHandoff {
  const pending = new Set<string>()
  return {
    markPending(key: string) {
      pending.add(key)
    },
    takePending(key: string) {
      return pending.delete(key)
    },
  }
}

function questionOf(targetDirection: string): JevDirectionQuestion {
  return {
    id: JEV_QUESTION_ID,
    instructions: `该岗位是否属于以下目标岗位方向？\n${targetDirection}`,
    criteria: {
      true: '岗位的主要职责属于该目标岗位方向',
      false: '岗位的主要职责不属于该目标岗位方向',
    },
  }
}

type BandVerdict = 'yes' | 'no' | 'uncertain'

function bandOf(noul: number): BandVerdict {
  if (noul >= JEV_UNCERTAIN_BAND.high) return 'yes'
  if (noul <= JEV_TITLE_CONFIRM_NO) return 'no'
  return 'uncertain'
}

function recordAndReturn(
  job: JevDirectionJob,
  deps: JevDirectionDeps,
  reason: string,
  kind: ReviewNeededReasonKind,
): Extract<JevDirectionDecision, { decision: 'reviewNeeded' }> {
  deps.recordReviewNeeded({ key: job.key, jobName: job.jobName }, reason, kind, deps.statistics, {
    today: deps.getToday(),
  })
  return { decision: 'reviewNeeded', reason, kind }
}

function asReviewNeeded(
  job: JevDirectionJob,
  deps: JevDirectionDeps,
  outcome: Extract<JevOutcome, { status: 'reviewNeeded' | 'error' }>,
): Extract<JevDirectionDecision, { decision: 'reviewNeeded' }> {
  // t5 的 reviewNeeded 只来自超时与形态异常：超时单独记账，形态异常按错误处理
  const kind: ReviewNeededReasonKind =
    outcome.status === 'reviewNeeded' && outcome.reason.includes('超时')
      ? 'jev_timeout'
      : 'jev_error'
  return recordAndReturn(job, deps, outcome.reason, kind)
}

/** t9：取缓存实例（缺省会话级单例），供查 / 写两处使用 */
function cacheOf(deps: JevDirectionDeps): JevCache {
  return deps.cache ?? jevCache
}

/**
 * t9：decided outcome → 明确终判并写缓存；含糊返回 null（绝不写缓存，FR-013）。
 * 判定依据 = job.key + 目标方向 + 响应模型标识（p1 §3.2 具体版本），model 变化即整库失效。
 */
function definitiveVerdict(
  job: JevDirectionJob,
  deps: JevDirectionDeps,
  outcome: Extract<JevOutcome, { status: 'decided' }>,
  direction: string,
  label: '标题' | '复判',
): JevCachedDecision | null {
  const band = bandOf(outcome.noul)
  if (band === 'uncertain') return null
  const verdict: JevCachedDecision =
    band === 'yes'
      ? { decision: 'pass' }
      : {
          decision: 'skip',
          reason: `Jev 判定岗位与目标方向不相关（${label} noul=${outcome.noul}）`,
        }
  cacheOf(deps).set(job.key, direction, outcome.model, verdict)
  return verdict
}

/** 标题+描述复判：决定 pass / skip / 待复核（含糊即待复核，没有第三次判断） */
async function recheckWithDescription(
  job: JevDirectionJob,
  deps: JevDirectionDeps,
  direction: string,
): Promise<JevDirectionDecision> {
  const description = job.jobDescription?.trim()
  if (!description) {
    // p1 §5：空标题/空 state 落在含糊带；没有描述就无法复判
    return recordAndReturn(job, deps, '标题阶段无法确定方向，且没有职位描述可复判', 'jev_uncertain')
  }
  const outcome = await deps.askJev(
    { title: job.jobName, description },
    questionOf(direction),
    deps.getApiKey,
  )
  if (outcome.status !== 'decided') {
    return asReviewNeeded(job, deps, outcome)
  }
  // t9：复判的明确终判同样按「岗位 + 判定依据」写缓存（判定依据不含阶段），
  // 下次扫到该岗位时标题阶段直接命中，零请求复现同一条终判（AC-009）
  const verdict = definitiveVerdict(job, deps, outcome, direction, '复判')
  if (verdict) return verdict
  return recordAndReturn(job, deps, `复判仍无法确定方向（noul=${outcome.noul}）`, 'jev_uncertain')
}

/**
 * Jev 方向判定主入口。stage='title'：只凭标题判断；stage='recheck'：取到描述后的复判。
 */
export async function judgeJevDirection(
  job: JevDirectionJob,
  deps: JevDirectionDeps,
): Promise<JevDirectionDecision> {
  if (deps.stage === 'recheck') {
    // 标题阶段没有留下复判标记 → 标题已定论（相关或已跳过），本轮零请求放行给后续步骤
    if (!deps.handoff?.takePending(job.key)) {
      return { decision: 'pass' }
    }
    // F-029：运行中方向被清空 → 缺字段待复核，不拿空方向组题请求（fail-closed）
    const direction = deps.getTargetDirection()?.trim() ?? ''
    if (!direction) {
      return recordAndReturn(job, deps, MISSING_DIRECTION_REASON, 'missing_field')
    }
    return recheckWithDescription(job, deps, direction)
  }
  // 上一轮留下的复判标记先消费掉：标题本轮自己会给出新的结论，
  // 残留标记（上轮含糊、这轮已定论）会让详情阶段再发一次无谓的复判请求
  deps.handoff?.takePending(job.key)

  // F-029 / FR-013：启用但目标方向为空（用户可达的持久态 {enable:true,targetDirection:''}）
  // 是「所需字段缺失」而非「未启用」——未启用在注册门（handles.ts 按 jev.enable）已被拦下。
  // 空方向无法组题、无法进缓存：记账待复核（missing_field），零请求，绝不静默放行。
  const direction = deps.getTargetDirection()?.trim() ?? ''
  if (!direction) {
    return recordAndReturn(job, deps, MISSING_DIRECTION_REASON, 'missing_field')
  }

  // t9 / AC-009：同岗位同判定依据命中缓存 → 直接复用明确终判，不再请求 Jev；
  // 命中 pass 与新鲜 pass 一样继续流水线（取详情、AI 筛选），
  // 命中 confirmed-negative 与新鲜 skip 一样终止流水线（不取详情、不调 AI）
  const cached = cacheOf(deps).get(job.key, direction)
  if (cached) {
    return cached
  }

  const outcome = await deps.askJev({ title: job.jobName }, questionOf(direction), deps.getApiKey)
  if (outcome.status !== 'decided') {
    return asReviewNeeded(job, deps, outcome)
  }
  const verdict = definitiveVerdict(job, deps, outcome, direction, '标题')
  if (verdict) {
    return verdict
  }
  // 含糊：交回收尾逻辑（有描述则复判，否则交接详情阶段或待复核）
  return uncertainAfterTitle(job, deps, direction)
}

/**
 * 标题含糊的收尾：能拿到描述就直接复判；拿不到则交给流水线的详情复判阶段（FR-012），
 * 没有交接（单次调用上下文）时按「无描述可复判」进待复核（fail-closed）。
 */
async function uncertainAfterTitle(
  job: JevDirectionJob,
  deps: JevDirectionDeps,
  direction: string,
): Promise<JevDirectionDecision> {
  if (job.jobDescription?.trim()) {
    return recheckWithDescription(job, deps, direction)
  }
  if (deps.handoff) {
    deps.handoff.markPending(job.key)
    return { decision: 'pass' }
  }
  return recordAndReturn(job, deps, '标题阶段无法确定方向，且没有职位描述可复判', 'jev_uncertain')
}
