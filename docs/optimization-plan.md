# boss-helper 投递体验优化方案（Jev 判定 · 筛选 · 提速 · 自动回复 · 话术 · Trace · 关于页）

日期：2026-09-22 · 依据：AGENTS.md / CONTEXT.md / 代码勘察（file:line 见各节）/ TypeSafe 一手材料
（npm tarball `@typesafe-ai/sdk@0.6.0` + docs.typesafe.ai 检索快照）。
状态：**方案，未实施**。所有涉及 `src/composables/useApplying/`、`src/entrypoints/boss/chat/` 的改动均为 AGENTS.md Critical Paths，需维护者白盒 review（即你本人把关）。

---

## 0. 先厘清一件事：Jev 不是第二个大模型

`systemOne` 只返回三种结构化判定：`noul`（是/否）、`choice`（N 选 1）、`score`（档位评分）。**它不会写文案、不会生成回复**。
因此全方案统一分工：

| 职责                                                                               | 用什么                                                      | 为什么                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 岗位 title 是否匹配（需求0）、话术挑选（需求4）、"这条消息要不要回复"（需求3前半） | **Jev**                                                     | 70–500ms、输入 $0.042/Mtok、输出免费（官方 blog/docs 口径，SECONDHAND 数字以 docs 为准）；比调一次 ChatGPT 快 2~3 个数量级，适合放在每岗位流水线上 |
| AI 筛选打分、打招呼文案生成、自动回复正文（需求3后半）                             | **现有 ChatModel**（`useModel/test.ts:102`，ai SDK + BYOK） | 需要生成文本，Jev 明确不做（docs：for software, not generation）                                                                                   |

Jev 的两条硬约束写进设计：

1. **BYOK**：`TYPESAFE_API_KEY` 不进代码库，沿用 `conf-model` 存储键模式（`useModel/index.ts:24-35`）。⚠ 顺带发现的既有问题：该键目前无 `local:` 前缀 → 走 `sync:` 跨设备同步，密钥卫生差一档，建议本次一并改为 `local:`。
2. **敌意内容不设防**：官方 jaggedness 页明说 jev-1.13 默认不把 state 当敌意输入（不可靠计数、字面理解、易被无关内容干扰）。→ Jev 只做**低风险门卫判断**，任何产出内容/执行动作前保留现有 LLM + 显式用户开关。

传输层未知数（Day-1 验证项）：流水线跑在 zhipin 页面 MAIN world，`fetch → api.typesafe.ai` 受页面 CSP/CORS 约束，官方文档无浏览器端指引（CORS 头 UNVERIFIED）。**兜底路径现成**：`src/composables/useModel/openai.ts:184` 有注释掉的 `fetch: counter.fetch` —— comctx 转发到 background（`host_permissions: http(s)://*/*`）天然绕开页面 CSP。方案默认：**主路径页面直连，失败自动降级走 background 中继**，一次性 spike 定案。

---

## 1. 需求0：Jev 岗位 title 匹配门（P0）

**语义（已确认）**：用户在设置里填一段自然语言「目标岗位描述」（如"前端开发，接受 web前端/React 工程师，不接受纯后端/测试/外包驻场"），Jev 对岗位 title 做同族近似判定。

**落点**（管道 DAG，`entrypoints/boss/delivery.ts:16-126`）：

- 新 handler `defineTaskHandler('目标岗位匹配', …)` 放在**廉价筛选带**（`tasks.jobTitle()` 旁，`deps: []`）——用列表字段 `jobData.jobName/brand.industry/jobLabels`（`boss/index.ts:62-115` 已可见），**不匹配即在详情请求前 skip**，每岗位省一次点击+60s 轮询（`delivery.ts:37-87`）。
- 判定：`client.systemOne({ state: title+公司行业+职位标签, questions: { match: noul('是否属于用户目标岗位族', criteria:{true:用户描述, false:'明确跨族'}) } })`。
- 失败策略：**fail-open** —— Jev 超时/429/网络错 → 记录 warn 放行到后续筛选，绝不让外部 API 故障挡投递（`TaskResult` 三态之一选 done，CONTEXT.md 不变量）。
- 结果进 `jobResultMaps[key].reason`，UI（JobCards）自动可见跳过原因。

**配置面**：`types/formData.ts` + `conf/info.ts` 新增 `jevTargetMatch: { enable, targetDescription, apiKey? }`（同 PR，AGENTS.md 惯例）。deepmerge 默认回填已保证旧配置兼容（`conf/index.ts:138`）。

**费用估算**：默认日上限 120 岗（`deliveryLimit`，`info.ts:225`）× ~300 tok ≈ $0.015/天；限速 1200 req/min 远未触及。

**验证**：纯逻辑（prompt 组装/三态/降级）以 `abortPolicy.test.ts` 模式做 `*.test.ts`；一次真实 zhipin 手动跑批 + `## Runtime evidence` 截图（Verification Matrix UI 行走 review-only 协议）。

**工作量**：半天 spike（CORS 定案）+ 1 天实现 + 0.5 天测试。

---

## 2. 需求1：筛选增强（P0）

现状逐条（`handles.ts`）：

| 筛选              | 现在                          | 问题                                                      |
| ----------------- | ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| jobTitle (L142)   | `includes` 子串、忽略大小写   | 只能整表一个「包含/排除」布尔（`FormDataSelect.include`） |
| company (L169)    | `includes`、**区分大小写**    | 与 jobTitle 行为不一致，英文公司名漏匹配                  |
| jobContent (L244) | 每关键词 `new RegExp('(?<!(不 | 无).{0,5})'+kw+…)`                                        | 用户关键词**裸拼进正则** → 特殊字符直接 SyntaxError/误匹配（注入面，inferred→已核对源码拼接方式） |
| hrPosition (L277) | trim 全等                     | 太脆                                                      |
| jobAddress (L297) | 恒 skip unless 命中           | 帮助文本已声明，保持                                      |

**改法（全部向后兼容，schema 只增不改）**：

1. **每关键词独立开关**：`FormDataSelect` 增 `items?: {text, exclude}[]`（新），`value: string[]` 保留为旧数据镜像；handler 优先读 `items`，无则按现行为。UI：`form/FormSelect.vue` 的 `<UInputTags>` 换 `<UInputMenu multiple>` 带候选（`options` 字段本来就在 schema 里躺着没人用——现成槽位），tag 上直接标 红=排除/绿=包含。
2. **匹配模式统一**：`matchMode?: 'contains'|'regex'`，关键词输入框旁一个 `.*` 小开关；默认 contains、统一 lowercase（顺手把 company 的大小写不一致当 bug 修掉，写进 PR 描述）。
3. **jobContent 安全化**：contains 模式不再拼 RegExp（`String.includes`），regex 模式显式开启并 try/catch 报友好错误——修掉注入崩溃面。
4. 多关键词布尔（any/all）：仅给 jobTitle/jobContent 加 `all?: boolean`（"含 A 且含 B"），其余保持 any。

**验证**：每个 handler 边界单测（大小写、正则报错、exclude 优先序）；`bun run test` 全绿 + 手动一批真实搜索页截图。
**工作量**：1.5–2 天（UI 占一半）。

---

## 3. 需求5：日志加 trace（P0，先行——它是需求2的前置）

现状：两套都断——`utils/logger.ts` 的 `logTree` **零消费者**；`helper.logs`（`ctx.ts:44-70`）+ `Tabs/Logs.vue` 有 UI 但**无人写入**，且 Logs 页挂着"维护当中"。

**设计**：

- `TaskContext`（`type.ts:19`）加 `traceId`（每次 `executeAll` 每岗位一个：`${Date.now().toString(36)}-${jobKey}`），`WorkflowData` 透传；`logger.info/warn/error` 首参统一带 `{traceId}`。
- `jobResultMaps[key]`（已按 jobKey 关联）增 `trace: {startedAt, perTask: {id, ms, result}[]}[]` —— `executeTask`（`index.ts:183-230`）是唯一切点，插桩只动一处。
- Logs.vue 接上 `helper.logs`（把 `logs.add` 系上 logger，删"维护当中"banner），表格加 traceId 列 + 按岗位过滤 + 一键导出 JSON（排障贴 issue 用）。
- 保留 `logTree` 上限 500；持久化仿 `useStatistics` 节流 `storageSet`（只存 warn/error/trace 摘要，不存全量）。

**验证**：跑一批后 Logs 页每岗位一条链 + 导出 JSON 里 traceId 一致（单测：mock ctx 断言字段）。**0.5–1 天**。

---

## 4. 需求2：投递速度与后台运行（P1，先测量后调参）

**语义澄清（重要）**：整条流水线活在**页面 MAIN world**（`content.ts` 注入 `boss.js`），MV3 service worker 只是 comctx 中继——**SW 休眠不影响批量**，但 **zhipin 标签页必须开着**。"纯后台关标签页跑"= 架构级重写（server-side 模拟登录态），超出本方案边界，列为明确不做。

**真实瓶颈与可动空间**（pacing 默认值是封号安全线，AGENTS Note 7——**只调不删，改动白盒 review**）：

1. **后台标签页定时器节流**（Chrome 5min 后 setTimeout ≈1/min）：这才是"挂着跑就变慢"的主因。修法：`utils/index.ts:64 delay()` 改用 Web Worker `setInterval` 宿主（页面上下文即可，~20 行，节流豁免）。**先修这个再谈提度。**
2. 详情获取 100ms 轮询/60s 超时（`delivery.ts:44-52`）：改 Mutation/watch `_jobDetail` 引用（已有 `useHookVueData` 基建，`boss/index.ts:311-349`）——平均每岗位省 1–3s。
3. 消息发送硬编码 1500ms（`boss/index.ts:255`）：接回本就存在却被标"暂未实现"的 `delay.messageSending`（`info.ts:350`），默认维持 5s 语义、可下调。
4. **流水线缓存是死代码**：`usePipelineCache.ts` 写好了，`checkJobCache/cachePipelineResult` 调用点被注释（`boss/index.ts:319-326`）。同一批搜索结果反复翻页时缓存 filter 判定（title 匹配、JEV 结果、AI 分数），命中直接 skip/continue——第二次扫同类列表近零成本。启用前先补 TTL/失效语义。
5. 有了 §3 的 per-task 耗时，调参有数据：目标不是"最快"，是"同样 120 投递用最少墙上时间且不触 RateLimit"。

**验证**：trace 前后对比中位 `deliveryInterval→task done` 墙钟（导出 JSON 直接算），一次 20 岗小样本。合计 **1.5–2 天**。

---

## 5. 需求4：多套打招呼话术，Jev 择优（P1）

- 配置增 `greetingTemplates: { enable, value: string[] }`（可含 `{{jobData.*}}` 变量——现有 `renderTemplate` 即引擎，`utils/ai.ts:15`）。
- 发送前一次 `choice()`：state = 岗位 title/JD 摘要 + 公司行业，criteria = N 套模板的**短标签**（不塞全文，token 极省），选中套 `renderTemplate` 后走原 `sendMessage`。
- 失败/超时 → 回落现行 `customGreeting.value`（fail-open 同上）。
- 与 `aiGreeting` 的关系：Jev choice 是**模板库内挑**（零生成成本、毫秒级）；aiGreeting 是**整句生成**。建议 choice 优先、aiGreeting 兜底二选一的开关放进阶配置。
- ⚠ 顺带修 AGENTS.md Note 3 既有 bug（`handles.ts:405` union 入 `renderTemplate(string)`）——本需求正落在这段代码上，同 PR 修掉。

**验证**：choice 组装/回落单测 + 真机发一条观察 Logs。**1 天**。

---

## 6. 需求3：投递后自动回复 + 发送附件简历（P2，最后做，独立开关）

三件事拆开，风险各异：

1. **入站订阅（新连线行为，最高风险）**：聊天线今天**只发不收**（`chat/index.ts:13-58` 无 subscribe/onmessage）。要在 `connect()` 后挂 `client.on('message')` + `ProtoBufferMessage.decode`，按 boss uid 路由。zhipin 对"连接后收消息行为"的风控未知 → 需要小规模实测。
2. **附件=真实文件消息（你已确认）**：wire 上**有字段无实现**——`chat.proto` 有 `TechwolfResume`(L112) / `body.resume`(f12) / `resumeShare`(f19)，`oneKeyResumeInfo.canSendResume`（`types.ts:505`）证明平台有一键简历；但 `geek-chat-core.ts` 无 builder，服务端接受语义未知。→ **定位成研究轨道**：从 web 端手动点一次"发送简历"抓 MQTT 出帧比对 proto 字段，再生成 builder（proto 是权威，regenerate 不手改，CONTEXT.md 不变量）。研究失败则回退图片简历（wire 已支持 `createImageMessage`）。**不承诺交付日期**。
3. **自动回复正文**：`aiReply` 配置整链路已存在只差执行（`formData.ts:35`、UI 开关 `AI.vue:56` 硬 disabled）。流程：收到 boss 消息 → **Jev gate**（noul "是否需回复" + choice "问题类型：薪资/到岗/经验/闲聊/要简历"）→ 简单类型走 **ChatModel 模板化短答**（BYOK 现成），复杂/敏感 → 只通知不代答（ChatBox 已有会话 UI）。**门是 Jev，笔是 LLM**——正合你"因为有 Jev 所以能接"的直觉，但明确：生成文本的仍是你自己的模型。
4. 硬约束：CONTEXT.md 不变量——自动代答必须 `aiReply.enable` 显式开；默认关闭 + 顶部风险横幅（复用 README CAUTION 措辞）。

**验证**：decode/路由单测（离线 pcap 帧）→ 小号实测订阅 → 附件研究结论单独出纪要。**2–3 天 + 研究不确定项**。

---

## 7. 需求6：关于&赞赏精简（P0，顺手）

已确认：删赞赏、留精简关于。

- 删 `About.vue:64-76` 远程 reward.png UPopover（外部 OSS 依赖一并消失）。
- 保留：开源声明、仓库链接、版本号；反馈统一走 `netConf.feedback`（`App.vue:231-237` 已有按钮），删 About 里硬编码的两条飞书链接（与 README 重复且会腐烂）。
- 三处注册无需动（tab 保留）。**0.5 小时**。

---

## 8. 前置修复与总排期

**第 0 步（阻塞大半工作）**：先修 AGENTS.md Notes 1–3 三个 typecheck 红（`@/components/Form/*` 大小写、`@types/bun`、union bug）——本次改动全部落在这几个文件上，红着 typecheck 改代码等于裸奔。0.5 天，顺带把 `check:baseline` 的 8 个 typecheck 计数清零。

| 阶段           | 内容                                                                              | 累计        |
| -------------- | --------------------------------------------------------------------------------- | ----------- |
| P0（第 1 周）  | §0 spike（CORS 定案）→ Notes1-3 修复 → §3 trace → §1 Jev 门 → §2 筛选 → §7 关于页 | ~5 天       |
| P1（第 2 周）  | §4 提速（worker-timer、详情事件化、缓存启用）→ §5 话术选择                        | ~3 天       |
| P2（独立分支） | §6.1 订阅实测 → §6.3 自动回复 → §6.2 附件研究轨道                                 | 2–3 天+研究 |

每个 PR 的最低证据：`bun run check:fast` + 新增单测 + （涉 UI/发送）一次真机 Runtime evidence；`useApplying/`、`chat/` 内改动你亲自白盒过。

**开放风险**：Jev CORS（spike 定，兜底 relay 已设计）· 简历文件帧语义（研究轨道，可能只交付图片方案）· 订阅行为的风控（小号先测）· Jev 无免费额度、等保/数据出境自行权衡（官方 ZDR 说明见 docs/models；不想引入外部依赖时，需求0/4 可退化为让现有 ChatModel 输出 JSON 判定——慢且贵一个量级，但零新增供应商）。
