/**
 * Jev（TypeSafe `POST /v1/systemone`）请求客户端：只负责组装请求、发起调用、
 * 解析响应形态，不做任何方向判定。
 *
 * 契约口径来自 p1 实测记录 docs/probes/jev-p1-record.md：
 * - §3.1：请求体顶层是协议必备的 `model` / `state` / `questions`；**岗位数据只存在于
 *   `state`，且只有 `job_title` 与 `job_description` 两个键**（FR-011 / AC-011）。
 * - §3.2：响应的 `model` 是解析后的具体版本（如 `jev-1.13.0`），不是请求别名；
 *   t9 的缓存键必须取响应里的这个值。
 * - §3.3：错误体 `detail` 有三种形态（对象数组 / 对象 / 字符串），解析不能假设其中一种。
 * - §2.2：服务端 CORS 不放行任何浏览器源，跨域可达性只来自 manifest 的 `host_permissions`；
 *   一旦权限收窄，页面直连会被预检 400 掐断，因此保留「页面不可达 → 经扩展后台发起」的
 *   降级路径（FR-017），见 `askJev` 与 `src/message/jevBackground.ts`。
 *
 * 不确定性判定**不在本模块**：p1 §6.2 的建议是 noul ≤ 0.2 判「否」、noul ≥ 0.8 判「是」、
 * **(0.2, 0.8) → 待复核**（该带为 p1 建议值，仍待用户确认后回写 spec）。本模块只如实返回
 * 数值，带阈值由调用方（t8 `jevDirection`）实现并只在那里声明一次。
 *
 * 失败一律 fail-closed：报错 / 超时 / 形态异常都不会被当成「明确不匹配」或放行，
 * 也绝不改用其他模型（spec Non-goals、AC-012）。密钥只从注入的 `getApiKey` 读取，
 * 本模块从不记录、从不持久化密钥。
 */

/** Jev 模型别名（p1 §3.1 实测口径；解析后的具体版本只在响应里） */
const JEV_MODEL_ALIAS = 'jev-latest'

/**
 * Jev 判断服务端点（p1 §3.1 / §8）：直连该端点，不经任何第三方中转（spec Non-goals）。
 * 后台降级路径也只使用这一个 URL，绝不接受页面传入的地址。
 */
export const JEV_BASE_URL = 'https://api.typesafe.ai/v1/systemone'

/**
 * Jev 密钥在浏览器存储中的键。t7 配置负责写入（FR-010：密钥只存浏览器存储）；
 * 后台代发请求（FR-017）从这里读取，密钥不进页面消息、不进日志。
 */
export const JEV_API_KEY_STORAGE_KEY = 'local:jev-api-key'

/**
 * 单次尝试超时（毫秒）。p1 §6.1 建议 **8 秒**、不自动重试（挂起样本服务端可能仍在计算，
 * 重试有重复计费与结果翻转双重风险）；该值仍待用户确认，故以具名常量暴露，便于回写。
 */
export const JEV_TIMEOUT_MS = 8000

/** 发给 Jev 的岗位内容：只允许标题与职位描述（FR-011） */
export interface JevJobInput {
  title: string
  description?: string
}

/** 单个是非（noul）问题的定义；`id` 用于在响应里对应回答案 */
export interface JevNoulQuestion {
  id: string
  instructions: string
  criteria?: { true: string; false: string }
}

interface JevQuestionDefinition {
  type: 'noul'
  instructions: string
  criteria?: Record<string, string>
}

export interface JevRequestBody {
  model: string
  state: Record<string, string>
  questions: Record<string, JevQuestionDefinition>
}

/**
 * 组装 Jev 请求体：岗位文本只进 `state`，键集合由 `description` 是否给出决定，
 * 结构上无法携带品牌、薪资、招聘者职务等其他岗位字段（签名只收标题与描述）。
 */
export function buildJevRequestBody(job: JevJobInput, question: JevNoulQuestion): JevRequestBody {
  const state: Record<string, string> = { job_title: job.title }
  if (job.description !== undefined) {
    state.job_description = job.description
  }

  const definition: JevQuestionDefinition = {
    type: 'noul',
    instructions: question.instructions,
  }
  if (question.criteria !== undefined) {
    definition.criteria = { true: question.criteria.true, false: question.criteria.false }
  }

  return { model: JEV_MODEL_ALIAS, state, questions: { [question.id]: definition } }
}

/** 传输层只需提供这两个字段，便于单测注入假实现（绝不触网） */
export interface JevRawResponse {
  status: number
  text: () => Promise<string>
}

/** `fetch` 形态的传输层依赖：生产用全局 `fetch`，单测注入假实现 */
export type JevTransport = (url: string, init: RequestInit) => Promise<JevRawResponse>

/** 密钥读取依赖：t7 配置落地后由调用方注入；本模块从不记录或持久化密钥 */
export type JevKeyReader = () => Promise<string | null>

/**
 * Jev 判断结果：调用方（t8）据此三分支处置。
 * - `decided`：拿到了数值，`model` 是响应里解析后的具体版本（t9 缓存键取它）；
 *   是否算「明确匹配」由调用方的含糊带决定（见文件头 p1 §6.2 说明）。
 * - `reviewNeeded`：超时或响应形态异常（p1 §6.2 配套规则：超时与字段缺失一律待复核），
 *   当次不投递、不记排除、不缓存（FR-013）。
 * - `error`：拿不到任何判定且原因确定（未配密钥、鉴权失败、请求被拒、服务不可达），
 *   原因可直接展示给用户（AC-012）。
 */
export type JevOutcome =
  | { status: 'decided'; model: string; noul: number }
  | { status: 'reviewNeeded'; reason: string }
  | { status: 'error'; reason: string }

/** 超时中断时携带的标记异常，用于区分「超时」与其他传输错误 */
class JevTimeoutError extends Error {}

/**
 * 超时处置。每次返回新对象：结果会被调用方长期持有（待复核列表），
 * 共享同一常量对象会让一处修改污染后续结果。
 */
function timeoutOutcome(): JevOutcome {
  return { status: 'reviewNeeded', reason: 'Jev 判断超时（单次尝试不重试），已放入待复核' }
}

/** 密钥读取失败（读取器拒绝）时的错误原因：与「未配置」区分，指向读取本身失败（t5 评审 F-006） */
const KEY_READ_FAILED_REASON = '读取 Jev 密钥失败'

/** 组装一次调用的 `RequestInit`：密钥只进请求头，不进任何日志 */
function buildRequestInit(apiKey: string, body: JevRequestBody, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }
}

/**
 * 发起一次 Jev 是非判断：单次尝试，超时用 `AbortController` 中断（p1 §6.1），
 * **不自动重试**。`transport` / `timeoutMs` 是注入点，单测不触网。
 */
export async function askJev(
  job: JevJobInput,
  question: JevNoulQuestion,
  deps: {
    getApiKey: JevKeyReader
    transport?: JevTransport
    timeoutMs?: number
  },
): Promise<JevOutcome> {
  // 密钥读取本身也可能失败（存储不可用等）：同样收敛为 error outcome，
  // 绝不让异常逃出 Promise<JevOutcome> 契约（t5 评审 F-006）
  let apiKey: string | undefined
  try {
    apiKey = (await deps.getApiKey())?.trim()
  } catch {
    return { status: 'error', reason: KEY_READ_FAILED_REASON }
  }
  if (!apiKey) {
    return { status: 'error', reason: '未配置 Jev 密钥' }
  }

  const transport = deps.transport ?? (fetch as unknown as JevTransport)
  const controller = new AbortController()
  let cancelTimer: () => void = () => {}
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new JevTimeoutError())
    }, deps.timeoutMs ?? JEV_TIMEOUT_MS)
    cancelTimer = () => clearTimeout(timer)
  })

  try {
    const response = await Promise.race([
      transport(
        JEV_BASE_URL,
        buildRequestInit(apiKey, buildJevRequestBody(job, question), controller.signal),
      ),
      timeout,
    ])
    return await parseJevResponse(response, question.id)
  } catch (error) {
    return decideTransportFailure(error)
  } finally {
    cancelTimer()
  }
}

/**
 * 传输层失败处置：超时（含传输层无视 `signal` 的挂起，p1 §4.2）→ 待复核；
 * 其他异常 → 如实说明不可达。两条分支都不放行、都不改用其他模型（AC-012）。
 */
function decideTransportFailure(error: unknown): JevOutcome {
  if (error instanceof JevTimeoutError || isAbort(error)) {
    return timeoutOutcome()
  }
  return {
    status: 'error',
    reason: '当前上下文无法连接 Jev 服务（跨域权限或网络受限），需经扩展后台或稍后重试',
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError')
}

/** 解析响应：200 且形态合法 → decided；其余按 p1 §3.3 的三种 detail 形态给出人话原因 */
async function parseJevResponse(response: JevRawResponse, questionId: string): Promise<JevOutcome> {
  const raw = await response.text()
  const parsed = safeJson(raw)
  if (response.status !== 200) {
    return { status: 'error', reason: describeJevError(response.status, parsed, raw) }
  }
  return parseJevSuccess(parsed, questionId)
}

function safeJson(raw: string): unknown {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 200 响应的形态校验：拿不到 model 或 answers 里的 noul 数值就是服务异常，fail-closed */
function parseJevSuccess(parsed: unknown, questionId: string): JevOutcome {
  const body = parsed as { model?: unknown; answers?: Record<string, unknown> } | null
  const answer = body?.answers?.[questionId]
  if (typeof body?.model !== 'string' || !isNoulAnswer(answer)) {
    return { status: 'reviewNeeded', reason: 'Jev 响应缺少模型标识或判定数值，已放入待复核' }
  }

  return { status: 'decided', model: body.model, noul: answer.noul }
}

function isNoulAnswer(value: unknown): value is { type: 'noul'; noul: number } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const answer = value as { type?: unknown; noul?: unknown }
  return answer.type === 'noul' && typeof answer.noul === 'number' && Number.isFinite(answer.noul)
}

/** 错误体的 `detail` 有三种形态（p1 §3.3）：对象数组 / 对象 / 字符串，逐一分出人话 */
function describeJevError(status: number, parsed: unknown, raw: string): string {
  if (isAuthFailure(status, parsed)) {
    return `Jev 鉴权失败，请检查密钥是否有效（${status}）`
  }
  const prefix = `Jev 服务返回 ${status}`
  const described = describeDetail((parsed as { detail?: unknown } | null)?.detail)
  if (described) {
    return `${prefix}：${described}`
  }
  return `${prefix}：${raw || '响应体为空'}`
}

/** 401/403：服务端以 `detail.error_type === 'authentication_error'` 表达鉴权失败（p1 §3.3） */
function isAuthFailure(status: number, parsed: unknown): boolean {
  if (status !== 401 && status !== 403) {
    return false
  }
  const detail = (parsed as { detail?: unknown } | null)?.detail
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return true
  }
  return (detail as { error_type?: unknown }).error_type === 'authentication_error'
}

function describeDetail(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail
  }
  if (Array.isArray(detail)) {
    return detail.map(describeDetailItem).filter(Boolean).join('；')
  }
  if (typeof detail === 'object' && detail !== null) {
    return detailMessage(detail)
  }
  return ''
}

function describeDetailItem(item: unknown): string {
  if (typeof item === 'object' && item !== null) {
    const msg = (item as { msg?: unknown }).msg
    if (typeof msg === 'string') {
      return msg
    }
  }
  return JSON.stringify(item)
}

function detailMessage(detail: object): string {
  const message = (detail as { message?: unknown }).message
  if (typeof message === 'string') {
    return message
  }
  const errorType = (detail as { error_type?: unknown }).error_type
  return typeof errorType === 'string' ? errorType : JSON.stringify(detail)
}

/**
 * 页面 → 后台消息协议（FR-017：插件页面无法直接访问 Jev 时由扩展后台发起请求）。
 *
 * 消息只携带岗位标题与职位描述构成的问题载荷，密钥留在后台存储里
 * （AGENTS.md 记账式处理凭证，任意页面侧载荷都不带 Authorization）；
 * 后台侧 `registerJevBackgroundHandler` 校验载荷后在 service worker
 * 上下文发起请求，返回 {@link JevOutcome}（可结构化克隆）。
 */
export const JEV_ASK_MESSAGE = 'jev:ask' as const

/** 后台侧注入的密钥读取依赖：p1 §3.3 显示缺失密钥是服务端 403，绝不明文发请求 */
export interface JevBackgroundDeps {
  getApiKey: JevKeyReader
  transport?: JevTransport
  /** 后台消息响应预算：与单次判断同一条超时常量，避免跨上下文叠加等待 */
  timeoutMs?: number
}

/** 后台消息监听器：`browser.runtime.onMessage` 形态；返回 undefined 表示放行其他监听器 */
type JevMessageListener = (
  message: unknown,
  _sender: unknown,
  sendResponse: (outcome: JevOutcome) => void,
) => boolean | undefined

export interface JevMessageBus {
  addListener(listener: JevMessageListener): void
}

export function registerJevBackgroundHandler(bus: JevMessageBus, deps: JevBackgroundDeps): void {
  bus.addListener((message: unknown, _sender, sendResponse) => {
    const payload = jevAskPayloadOf(message)
    if (!payload) {
      return
    }
    // MV3：监听器返回 true 表示异步应答，await 完成后再 sendResponse 具体结果。
    // 任何依赖失败都必须收敛为 error outcome（t5 评审 F-006）：端口才会关闭，
    // service worker 才不会留下未处理 rejection
    void runJevAskMessage(payload, deps)
      .catch(() => ({ status: 'error' as const, reason: '后台处理 Jev 请求失败' }))
      .then(sendResponse)
    return true
  })
}

/** 载荷校验：fail-closed，任何多出来的键、非字符串、非规定问题结构都拒绝 */
function parseJevAskPayload(raw: unknown): { job: JevJobInput; question: JevNoulQuestion } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const payload = raw as { state?: unknown; questions?: unknown }
  const state = payload.state
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null
  }
  const stateKeys = Object.keys(state)
  if (!isJevStateKeySet(stateKeys)) {
    return null
  }
  const stateRecord = state as Record<string, unknown>
  const title = stateRecord.job_title
  const description = stateRecord.job_description
  if (typeof title !== 'string' || (description !== undefined && typeof description !== 'string')) {
    return null
  }

  const question = parseSingleQuestion(payload.questions)
  if (!question) {
    return null
  }

  return { job: { title, description }, question }
}

/**
 * state 键集合允许清单（FR-011）：只允许 job_title 与 job_description，
 * 多一个键（品牌、薪资、招聘者职务等）一律拒绝，绝不转发给 Jev。
 */
function isJevStateKeySet(keys: string[]): boolean {
  const allowed = ['job_title', 'job_description']
  return keys.length > 0 && keys.every((key) => allowed.includes(key)) && keys.includes('job_title')
}

function parseSingleQuestion(questions: unknown): JevNoulQuestion | null {
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    return null
  }
  const entries = Object.entries(questions as Record<string, unknown>)
  if (entries.length !== 1) {
    return null
  }
  const [id, definition] = entries[0]!
  if (!isNoulDefinition(definition)) {
    return null
  }
  return {
    id,
    instructions: (definition as { instructions: string }).instructions,
    criteria: readCriteria((definition as { criteria?: unknown }).criteria),
  }
}

function isNoulDefinition(definition: unknown): unknown {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return false
  }
  const typed = definition as { type?: unknown; instructions?: unknown }
  return typed.type === 'noul' && typeof typed.instructions === 'string'
}

function readCriteria(criteria: unknown): { true: string; false: string } | undefined {
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
    return undefined
  }
  const typed = criteria as { true?: unknown; false?: unknown }
  if (typeof typed.true !== 'string' || typeof typed.false !== 'string') {
    return undefined
  }
  return { true: typed.true, false: typed.false }
}

function jevAskPayloadOf(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) {
    return null
  }
  const typed = message as { type?: unknown; payload?: unknown }
  return typed.type === JEV_ASK_MESSAGE ? typed.payload : null
}

async function runJevAskMessage(raw: unknown, deps: JevBackgroundDeps): Promise<JevOutcome> {
  const parsed = parseJevAskPayload(raw)
  if (!parsed) {
    return { status: 'error', reason: 'Jev 请求载荷不合法（只允许岗位标题与职位描述）' }
  }
  return askJev(parsed.job, parsed.question, {
    getApiKey: deps.getApiKey,
    transport: deps.transport,
    timeoutMs: deps.timeoutMs,
  })
}

/** 页面侧注入的消息发送方：comctx `counter.fetch` / `browser.runtime.sendMessage` 等皆可 */
export type JevMessageSender = (message: unknown) => Promise<unknown>

/** 把消息通道包装成后台发送器；只放行后台返回的 `JevOutcome` 形态 */
export function createJevBackgroundSender(send: JevMessageSender): JevBackgroundSender {
  return async (payload: JevRequestBody) => {
    const response = await send({ type: JEV_ASK_MESSAGE, payload })
    if (!isJevOutcome(response)) {
      throw new Error('扩展后台未响应 Jev 请求')
    }
    return response
  }
}

/** 后台执行判断的 page-side 入口：发消息等结果，后台失败由后台如实说明 */
export type JevBackgroundSender = (payload: JevRequestBody) => Promise<JevOutcome>

function isJevOutcome(value: unknown): value is JevOutcome {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const status = (value as { status?: unknown }).status
  if (status === 'decided') {
    return typeof (value as { model?: unknown }).model === 'string'
  }
  if (status === 'reviewNeeded' || status === 'error') {
    return typeof (value as { reason?: unknown }).reason === 'string'
  }
  return false
}

/**
 * 页面侧主入口（FR-013 / FR-017）：先尝试直连，**仅在直连不可达时**改经扩展后台
 * （后台同样单次尝试、不自动重试）。直连超时或已拿到明确结果时不降级，
 * 因为挂起的请求服务端可能仍在计算（p1 §6.1）。任何路径都绝不放行、
 * 也绝不改成调用其他模型。
 */
export async function askJevWithFallback(
  job: JevJobInput,
  question: JevNoulQuestion,
  deps: {
    getApiKey: JevKeyReader
    transport?: JevTransport
    viaBackground: JevBackgroundSender
    timeoutMs?: number
  },
): Promise<JevOutcome> {
  // 页面侧读不到密钥时不必先失败一次：后台持有自己的密钥（FR-017 的同一降级路径）；
  // 读取本身失败（存储不可用等）时收敛为 error outcome，绝不降级也绝不让异常逃出契约（t5 评审 F-006）
  let apiKey: string | undefined
  try {
    apiKey = (await deps.getApiKey())?.trim()
  } catch {
    return { status: 'error', reason: KEY_READ_FAILED_REASON }
  }
  if (apiKey) {
    const outcome = await askJev(job, question, {
      getApiKey: async () => apiKey,
      transport: deps.transport,
      timeoutMs: deps.timeoutMs,
    })
    if (outcome.status !== 'error' || !isUnreachableReason(outcome.reason)) {
      return outcome
    }
  }
  return askJevViaBackground(job, question, deps)
}

function isUnreachableReason(reason: string): boolean {
  return reason.includes('无法连接')
}

/** 经后台发起：用同一条请求体与超时预算，不做第二次尝试 */
async function askJevViaBackground(
  job: JevJobInput,
  question: JevNoulQuestion,
  deps: { viaBackground: JevBackgroundSender; timeoutMs?: number },
): Promise<JevOutcome> {
  const timeoutMs = deps.timeoutMs ?? JEV_TIMEOUT_MS
  let cancelTimer: () => void = () => {}
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new JevTimeoutError()), timeoutMs)
    cancelTimer = () => clearTimeout(timer)
  })

  try {
    return await Promise.race([deps.viaBackground(buildJevRequestBody(job, question)), timeout])
  } catch (error) {
    return decideTransportFailure(error)
  } finally {
    cancelTimer()
  }
}
