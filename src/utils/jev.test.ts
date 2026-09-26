import { expect, mock, test } from 'bun:test'

import {
  JEV_ASK_MESSAGE,
  JEV_BASE_URL,
  JEV_TIMEOUT_MS,
  askJev,
  askJevWithFallback,
  buildJevRequestBody,
  createJevBackgroundSender,
  registerJevBackgroundHandler,
} from './jev'
import type { JevRawResponse } from './jev'

/**
 * 请求体口径来自 p1 实测记录 §3.1（docs/probes/jev-p1-record.md）：
 * 顶层是协议必备的 model / state / questions，岗位数据只存在于 state，
 * 且 state 的键集合恰为 {job_title, job_description}（AC-011 / FR-011）。
 */
const question = {
  id: 'direction',
  instructions: '该岗位是否属于目标岗位方向？',
  criteria: { true: '岗位以前端开发为主要职责', false: '岗位与前端开发无关' },
}

const job = {
  title: '前端开发工程师',
  description: '负责后台管理界面开发，要求熟悉 Vue 与 TypeScript。',
}

/** 记录调用并返回给定响应的假传输层（绝不触网） */
function recordingTransport(response: () => JevRawResponse) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    transport: async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return response()
    },
  }
}

function jsonResponse(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) }
}

function okBody(noul: number) {
  return jsonResponse(200, { model: 'jev-1.13.0', answers: { direction: { type: 'noul', noul } } })
}

/**
 * 内存消息通道，按 browser.runtime 的语义实现：监听器返回 true 表示异步应答，
 * sendMessage 等待 sendResponse；无人应答时返回 undefined。
 */
function runtimeChannel() {
  type Listener = (
    message: unknown,
    sender: unknown,
    sendResponse: (value: unknown) => void,
  ) => boolean | undefined
  const listeners: Listener[] = []
  return {
    addListener(listener: Listener) {
      listeners.push(listener)
    },
    async sendMessage(message: unknown): Promise<unknown> {
      for (const listener of listeners) {
        let settle: (value: unknown) => void = () => {}
        const answered = new Promise<unknown>((resolve) => {
          settle = resolve
        })
        if (listener(message, undefined, settle) === true) {
          return await answered
        }
      }
      return undefined
    },
  }
}

test('请求体顶层只有协议字段 model/state/questions', () => {
  const body = buildJevRequestBody(job, question)

  expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
  expect(body.model).toBe('jev-latest')
})

test('岗位数据只在 state，且 state 的键集合恰为 job_title 与 job_description', () => {
  const body = buildJevRequestBody(job, question)

  expect(Object.keys(body.state).sort()).toEqual(['job_description', 'job_title'])
  expect(body.state.job_title).toBe(job.title)
  expect(body.state.job_description).toBe(job.description)
})

test('只给标题（标题阶段）时 state 不含 job_description', () => {
  const body = buildJevRequestBody({ title: job.title }, question)

  expect(Object.keys(body.state)).toEqual(['job_title'])
  expect(body.state.job_title).toBe(job.title)
})

test('questions 使用调用方给定的问题 id 与 noul 定义', () => {
  const body = buildJevRequestBody(job, question)

  expect(Object.keys(body.questions)).toEqual(['direction'])
  expect(body.questions.direction).toEqual({
    type: 'noul',
    instructions: question.instructions,
    criteria: { true: question.criteria.true, false: question.criteria.false },
  })
})

test('没有 criteria 的问题定义不产生空 criteria 字段', () => {
  const body = buildJevRequestBody(job, { id: 'direction', instructions: '问题' })

  expect('criteria' in body.questions.direction!).toBe(false)
})

test('默认超时是 8 秒单次尝试（p1 §6.1 建议值，待用户确认）', () => {
  expect(JEV_TIMEOUT_MS).toBe(8000)
  expect(JEV_BASE_URL).toBe('https://api.typesafe.ai/v1/systemone')
})

test('向 Jev 端点发起 POST，携带 Bearer 密钥与 JSON 请求体', async () => {
  const { calls, transport } = recordingTransport(() => okBody(0.98))
  const outcome = await askJev(job, question, { getApiKey: async () => 'k-test', transport })

  expect(outcome.status).toBe('decided')
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(calls[0]!.init.method).toBe('POST')
  expect(calls[0]!.init.headers).toEqual({
    Authorization: 'Bearer k-test',
    'Content-Type': 'application/json',
  })
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    model: 'jev-latest',
    state: { job_title: job.title, job_description: job.description },
    questions: {
      direction: {
        type: 'noul',
        instructions: question.instructions,
        criteria: { true: question.criteria.true, false: question.criteria.false },
      },
    },
  })
})

test('decided 返回响应中解析后的具体模型版本与 noul 数值', async () => {
  const { transport } = recordingTransport(() => okBody(0.03))
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome).toEqual({ status: 'decided', model: 'jev-1.13.0', noul: 0.03 })
})

test('密钥缺失时返回明确错误且不发起任何请求', async () => {
  let called = 0
  const outcome = await askJev(job, question, {
    getApiKey: async () => null,
    transport: async () => {
      called += 1
      throw new Error('must not be called')
    },
  })

  expect(outcome).toEqual({ status: 'error', reason: '未配置 Jev 密钥' })
  expect(called).toBe(0)
})

test('空白密钥视同未配置', async () => {
  const outcome = await askJev(job, question, {
    getApiKey: async () => '   ',
    transport: async () => {
      throw new Error('must not be called')
    },
  })

  expect(outcome).toEqual({ status: 'error', reason: '未配置 Jev 密钥' })
})

test('密钥读取失败（读取器拒绝）时返回明确错误且不发起任何请求', async () => {
  let called = 0
  const outcome = await askJev(job, question, {
    getApiKey: async () => {
      throw new Error('storage read failed')
    },
    transport: async () => {
      called += 1
      throw new Error('must not be called')
    },
  })

  expect(outcome).toEqual({ status: 'error', reason: '读取 Jev 密钥失败' })
  expect(called).toBe(0)
})

test('超时（传输层被中止）返回待复核，而不是错误或放行', async () => {
  const outcome = await askJev(job, question, {
    getApiKey: async () => 'k',
    timeoutMs: 15,
    transport: (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal
        if (signal) {
          signal.addEventListener('abort', () => reject(new Error('AbortError')))
        }
      }),
  })

  expect(outcome.status).toBe('reviewNeeded')
  expect((outcome as { reason: string }).reason).toContain('超时')
})

test('传输层无视中止信号一直挂起时，客户端仍按超时返回待复核（p1 §4.2 偶发挂起）', async () => {
  const outcome = await askJev(job, question, {
    getApiKey: async () => 'k',
    timeoutMs: 15,
    transport: () => new Promise(() => {}),
  })

  expect(outcome.status).toBe('reviewNeeded')
  expect((outcome as { reason: string }).reason).toContain('超时')
})

test('422 的 detail 数组：逐条给出字段校验原因（p1 §3.3 形态一）', async () => {
  const { transport } = recordingTransport(() =>
    jsonResponse(422, {
      detail: [
        { type: 'missing', loc: ['body', 'model'], msg: 'Field required', input: {} },
        { type: 'missing', loc: ['body', 'questions'], msg: 'Field required', input: {} },
      ],
    }),
  )
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome).toEqual({
    status: 'error',
    reason: 'Jev 服务返回 422：Field required；Field required',
  })
})

test('400 的 detail 对象：给出 message（p1 §3.3 形态二）', async () => {
  const { transport } = recordingTransport(() =>
    jsonResponse(400, {
      detail: { error_type: 'api_usage_error', message: 'Unknown model: no-such-model' },
    }),
  )
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome).toEqual({
    status: 'error',
    reason: 'Jev 服务返回 400：Unknown model: no-such-model',
  })
})

test('405 的 detail 字符串：原样透出（p1 §3.3 形态三）', async () => {
  const { transport } = recordingTransport(() =>
    jsonResponse(405, { detail: 'Method Not Allowed' }),
  )
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome).toEqual({ status: 'error', reason: 'Jev 服务返回 405：Method Not Allowed' })
})

test('非 JSON 的错误体：透出原始文本，不掩盖状态码', async () => {
  const { transport } = recordingTransport(() => ({ status: 502, text: async () => 'Bad Gateway' }))
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome).toEqual({ status: 'error', reason: 'Jev 服务返回 502：Bad Gateway' })
})

test('401/403 的 authentication_error 给出鉴权失败的明确原因', async () => {
  const authBody = {
    detail: {
      error_type: 'authentication_error',
      message: 'Cannot authenticate with the server. Please check your API key and try again.',
    },
  }
  const bad = recordingTransport(() => jsonResponse(401, authBody))
  const missing = recordingTransport(() => jsonResponse(403, authBody))
  const badOutcome = await askJev(job, question, {
    getApiKey: async () => 'k',
    transport: bad.transport,
  })
  const missingOutcome = await askJev(job, question, {
    getApiKey: async () => 'k',
    transport: missing.transport,
  })

  expect(badOutcome.status).toBe('error')
  expect((badOutcome as { reason: string }).reason).toContain('鉴权失败')
  expect(missingOutcome.status).toBe('error')
  expect((missingOutcome as { reason: string }).reason).toContain('鉴权失败')
})

test('200 但缺 model 或 answers：按字段缺失进入待复核，绝不放行', async () => {
  const noModel = recordingTransport(() =>
    jsonResponse(200, { answers: { direction: { type: 'noul', noul: 0.9 } } }),
  )
  const noAnswers = recordingTransport(() => jsonResponse(200, { model: 'jev-1.13.0' }))
  const notNoul = recordingTransport(() =>
    jsonResponse(200, { model: 'jev-1.13.0', answers: { direction: { type: 'noul' } } }),
  )
  const a = await askJev(job, question, {
    getApiKey: async () => 'k',
    transport: noModel.transport,
  })
  const b = await askJev(job, question, {
    getApiKey: async () => 'k',
    transport: noAnswers.transport,
  })
  const c = await askJev(job, question, {
    getApiKey: async () => 'k',
    transport: notNoul.transport,
  })

  expect([a.status, b.status, c.status]).toEqual(['reviewNeeded', 'reviewNeeded', 'reviewNeeded'])
})

test('200 但响应体不是 JSON：进入待复核', async () => {
  const { transport } = recordingTransport(() => ({ status: 200, text: async () => '<html>' }))
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome.status).toBe('reviewNeeded')
})

test('页面直连失败（非中止的传输错误）返回明确原因，不静默放行', async () => {
  const { transport } = recordingTransport(() => {
    throw new TypeError('Failed to fetch')
  })
  const outcome = await askJev(job, question, { getApiKey: async () => 'k', transport })

  expect(outcome.status).toBe('error')
  expect((outcome as { reason: string }).reason).toContain('无法连接')
})

test('FR-017：页面发消息 → 后台用存储的密钥执行请求 → 返回解析结果', async () => {
  const channel = runtimeChannel()
  const backgroundTransport = recordingTransport(() => okBody(0.9))
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'background-key',
    transport: backgroundTransport.transport,
  })

  const outcome = await askJevWithFallback(job, question, {
    getApiKey: async () => null,
    viaBackground: createJevBackgroundSender((message) => channel.sendMessage(message)),
  })

  expect(outcome).toEqual({ status: 'decided', model: 'jev-1.13.0', noul: 0.9 })
  expect(backgroundTransport.calls).toHaveLength(1)
  expect(backgroundTransport.calls[0]!.init.headers).toEqual({
    Authorization: 'Bearer background-key',
    'Content-Type': 'application/json',
  })
  expect(
    Object.keys(JSON.parse(backgroundTransport.calls[0]!.init.body as string).state).sort(),
  ).toEqual(['job_description', 'job_title'])
})

test('消息校验 fail-closed：state 出现第三个键时拒绝且不向 Jev 发起请求', async () => {
  const channel = runtimeChannel()
  let jevCalls = 0
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'k',
    transport: async () => {
      jevCalls += 1
      throw new Error('must not be called')
    },
  })

  const response = await channel.sendMessage({
    type: JEV_ASK_MESSAGE,
    payload: {
      state: { job_title: job.title, job_description: job.description, company_brand: '虚构品牌' },
      questions: { direction: { type: 'noul', instructions: question.instructions } },
    },
  })

  expect(response).toEqual({
    status: 'error',
    reason: 'Jev 请求载荷不合法（只允许岗位标题与职位描述）',
  })
  expect(jevCalls).toBe(0)
})

test('消息校验 fail-closed：标题/描述不是字符串时拒绝且不向 Jev 发起请求', async () => {
  const channel = runtimeChannel()
  let jevCalls = 0
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'k',
    transport: async () => {
      jevCalls += 1
      throw new Error('must not be called')
    },
  })

  const response = await channel.sendMessage({
    type: JEV_ASK_MESSAGE,
    payload: { state: { job_title: 123, job_description: 'desc' }, questions: {} },
  })

  expect(response).toEqual({
    status: 'error',
    reason: 'Jev 请求载荷不合法（只允许岗位标题与职位描述）',
  })
  expect(jevCalls).toBe(0)
})

test('后台路径：密钥读取失败时 sendResponse 收到密钥读取失败原因，且不向 Jev 发起请求', async () => {
  const channel = runtimeChannel()
  let jevCalls = 0
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => {
      throw new Error('storage read failed')
    },
    transport: async () => {
      jevCalls += 1
      throw new Error('must not be called')
    },
  })

  const response = await channel.sendMessage({
    type: JEV_ASK_MESSAGE,
    payload: {
      state: { job_title: job.title, job_description: job.description },
      questions: { direction: { type: 'noul', instructions: question.instructions } },
    },
  })

  expect(response).toEqual({ status: 'error', reason: '读取 Jev 密钥失败' })
  expect(jevCalls).toBe(0)
})

test('后台应答链兜底：载荷解析之外的依赖失败也必须 sendResponse 关闭端口', async () => {
  const channel = runtimeChannel()
  let jevCalls = 0
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'k',
    transport: async () => {
      jevCalls += 1
      throw new Error('must not be called')
    },
  })

  // 载荷经 Proxy 让 parseJevAskPayload 抛错（模拟未预料的依赖失败）：
  // 应答链必须兜底为 error outcome，否则消息端口不关闭、service worker 记未处理 rejection
  const explodingPayload = new Proxy(
    {},
    {
      get() {
        throw new Error('payload explode')
      },
    },
  )
  const response = await channel.sendMessage({ type: JEV_ASK_MESSAGE, payload: explodingPayload })

  expect(response).toEqual({ status: 'error', reason: '后台处理 Jev 请求失败' })
  expect(jevCalls).toBe(0)
})

test('非 Jev 消息（如 comctx 协议消息）不响应、不发起请求', async () => {
  const channel = runtimeChannel()
  let jevCalls = 0
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'k',
    transport: async () => {
      jevCalls += 1
      throw new Error('must not be called')
    },
  })

  const response = await channel.sendMessage({ type: 'comctx-other', payload: {} })

  expect(response).toBeUndefined()
  expect(jevCalls).toBe(0)
})

test('降级路径：页面直连不可达时才走后台，且请求体只含标题与描述', async () => {
  const channel = runtimeChannel()
  const backgroundTransport = recordingTransport(() => okBody(0.9))
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'k',
    transport: backgroundTransport.transport,
  })
  const directTransport = recordingTransport(() => {
    throw new TypeError('Failed to fetch')
  })

  const outcome = await askJevWithFallback(job, question, {
    getApiKey: async () => 'page-key',
    transport: directTransport.transport,
    viaBackground: createJevBackgroundSender((message) => channel.sendMessage(message)),
  })

  expect(outcome).toEqual({ status: 'decided', model: 'jev-1.13.0', noul: 0.9 })
  expect(directTransport.calls).toHaveLength(1)
  expect(backgroundTransport.calls).toHaveLength(1)
  expect(
    Object.keys(JSON.parse(backgroundTransport.calls[0]!.init.body as string).state).sort(),
  ).toEqual(['job_description', 'job_title'])
})

test('降级路径：页面直连成功时不调用后台，直连超时也不调用后台', async () => {
  let backgroundCalls = 0
  const successDirect = recordingTransport(() => okBody(0.9))
  await askJevWithFallback(job, question, {
    getApiKey: async () => 'k',
    transport: successDirect.transport,
    viaBackground: async () => {
      backgroundCalls += 1
      return { status: 'error', reason: 'must not be called' }
    },
  })
  expect(backgroundCalls).toBe(0)

  const outcome = await askJevWithFallback(job, question, {
    getApiKey: async () => 'k',
    timeoutMs: 15,
    transport: () => new Promise(() => {}),
    viaBackground: async () => {
      backgroundCalls += 1
      return { status: 'error', reason: 'must not be called' }
    },
  })
  expect(outcome.status).toBe('reviewNeeded')
  expect(backgroundCalls).toBe(0)
})

test('降级路径：页面侧密钥读取失败时返回密钥读取失败，不发起任何请求也不降级', async () => {
  let backgroundCalls = 0
  const outcome = await askJevWithFallback(job, question, {
    getApiKey: async () => {
      throw new Error('storage read failed')
    },
    transport: async () => {
      throw new Error('must not be called')
    },
    viaBackground: async () => {
      backgroundCalls += 1
      return { status: 'error', reason: 'must not be called' }
    },
  })

  expect(outcome).toEqual({ status: 'error', reason: '读取 Jev 密钥失败' })
  expect(backgroundCalls).toBe(0)
})

test('降级路径：后台也不可达时如实说明原因', async () => {
  const channel = runtimeChannel()
  registerJevBackgroundHandler(channel, {
    getApiKey: async () => 'k',
    transport: async () => {
      throw new TypeError('Failed to fetch')
    },
  })

  const outcome = await askJevWithFallback(job, question, {
    getApiKey: async () => null,
    viaBackground: createJevBackgroundSender((message) => channel.sendMessage(message)),
  })

  expect(outcome.status).toBe('error')
  expect((outcome as { reason: string }).reason).toContain('无法连接')
})

test('后台入口接线：起用即注册 Jev 监听，收到消息后用存储密钥在后台发起请求', async () => {
  // 覆盖 src/entrypoints/background.ts 的接线：注册监听 + 从存储读密钥 + 发起请求
  const listeners: Array<
    (
      message: unknown,
      sender: unknown,
      sendResponse: (value: unknown) => void,
    ) => boolean | undefined
  > = []
  const storageMap: Record<string, unknown> = { 'local:jev-api-key': 'k-stored' }
  let definition: { main: () => void } | null = null

  mock.module('#imports', () => ({
    defineBackground: (def: { main: () => void }) => {
      definition = def
      return def
    },
    browser: {
      runtime: {
        onMessage: {
          addListener: (
            listener: (
              message: unknown,
              sender: unknown,
              respond: (value: unknown) => void,
            ) => boolean | undefined,
          ) => {
            listeners.push(listener)
          },
          removeListener: () => {},
        },
      },
    },
    storage: { getItem: async (key: string) => storageMap[key] ?? null },
  }))

  const entry = await import('../entrypoints/background')
  expect(typeof entry.default.main).toBe('function')
  expect(definition).not.toBeNull()
  definition!.main()

  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  const globalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof url === 'string'
        ? url
        : url instanceof URL
          ? url.href
          : url instanceof Request
            ? url.url
            : ''
    fetchCalls.push({ url: href, init: init ?? {} })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { direction: { type: 'noul', noul: 0.5 } },
        }),
    }
  }) as typeof fetch
  try {
    let response: unknown
    const jevListener = listeners.at(-1)!
    jevListener(
      {
        type: JEV_ASK_MESSAGE,
        payload: {
          state: { job_title: job.title, job_description: job.description },
          questions: { direction: { type: 'noul', instructions: question.instructions } },
        },
      },
      {},
      (value) => {
        response = value
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(response).toEqual({ status: 'decided', model: 'jev-1.13.0', noul: 0.5 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.init.headers).toEqual({
      Authorization: 'Bearer k-stored',
      'Content-Type': 'application/json',
    })
    expect(Object.keys(JSON.parse(fetchCalls[0]!.init.body as string).state).sort()).toEqual([
      'job_description',
      'job_title',
    ])
  } finally {
    globalThis.fetch = globalFetch
  }
})
