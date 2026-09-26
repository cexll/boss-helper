# Jev 接口实测记录（p1 / 规格前置 P5）

- 日期：2026-09-26（单次会话内完成）
- 分支：`loop/jev-job-filter/p1`（基线 `a20ef1e7217505ffea41d9d8ec8d3eaf4801aa31`）
- 验证目标：VAL-016 —— 从插件页面与扩展后台两条路径分别记录 Jev 可达性与跨域限制、实际请求体字段（只含岗位标题与职位描述）、响应字段、耗时分布、错误与不确定结果的表现，并提出超时秒数、不确定判定方式与缓存期限
- 凭证：`.run/p1-jev.env`（gitignored），本文所有样本均已脱敏（`Authorization: Bearer <REDACTED>`）
- 数据合规：全部请求体只使用公开虚构岗位文本（见 §3.1），不含任何真实个人信息、简历、聊天或账号数据；未做真实投递；未打开 zhipin.com

---

## 1. 结论速览

| #   | 验收点                                  | 结论                                                                                                                                                                                           |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 插件页面路径                            | **可达**。`chrome-extension://<id>/options.html` 上下文 `fetch(POST /v1/systemone)` 返回 200（10/10 成功）                                                                                     |
| 2   | 扩展后台路径                            | **可达**。background service worker（`background.js`）上下文同样返回 200（10/10 成功）                                                                                                         |
| 3   | 请求体只含岗位标题与职位描述            | **成立（就岗位数据而言）**。线上抓包确认 `state` 对象只含 `job_title` 与 `job_description` 两个字段；请求体另有协议必备字段 `model` 与 `questions`（问题定义，非岗位数据），见 §3.1 的契约说明 |
| 4   | 超时 / 不确定判定 / 缓存期限建议值      | 见 §6：超时 **8 秒**、不确定判定 **noul ∈ (0.2, 0.8) → 待复核**、缓存期限 **7 天**。三项均为**建议值，待用户确认后回写 spec.md**                                                               |
| 5   | 既有 host_permissions 是否覆盖 Jev 域名 | **已覆盖，无需扩大权限**。`wxt.config.ts:126` 为 `['http://*/*', 'https://*/*']`，含 `https://api.typesafe.ai/*`；不存在需要商店人工审核的权限扩张（详见 §2.2）                                |

---

## 2. 可达性与跨域

### 2.1 测试矩阵

| 路径                  | 上下文                                                                                | 结果                                   | 样本                           |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ |
| 插件页面              | 扩展 options 页（`chrome-extension://ogkmgjbagackkdlcibcailacnncgonbn/options.html`） | **200 OK**                             | 10/10 成功，另有多次探测均 200 |
| 扩展后台              | MV3 service worker（`chrome-extension://…/background.js`）                            | **200 OK**                             | 10/10 成功，另有多次探测均 200 |
| 普通网页（对照）      | `https://example.com` 页面内 `fetch`                                                  | **失败**：`TypeError: Failed to fetch` | 1/1                            |
| `about:blank`（对照） | 无源页面内 `fetch`                                                                    | **失败**：`TypeError: Failed to fetch` | 1/1                            |

扩展 ID `ogkmgjbagackkdlcibcailacnncgonbn` 由 `wxt.config.ts` 里固定的 manifest `key` 派生（SHA-256 → 前 16 字节映射 a-p），因此本地构建与商店构建 ID 一致。

### 2.2 跨域限制（CORS / preflight 实测）

对 `OPTIONS https://api.typesafe.ai/v1/systemone` 的预检（`Access-Control-Request-Method: POST`，请求头 `authorization,content-type`）：

| Origin                      | 预检结果                           | `Access-Control-Allow-Origin` |
| --------------------------- | ---------------------------------- | ----------------------------- |
| `https://example.com`       | 400，body `Disallowed CORS origin` | 无                            |
| `https://www.zhipin.com`    | 400，body `Disallowed CORS origin` | 无                            |
| `chrome-extension://ogkmg…` | 400，body `Disallowed CORS origin` | 无                            |
| `moz-extension://…`         | 400，body `Disallowed CORS origin` | 无                            |

即：**服务端 CORS 白名单不放行任何浏览器源**（包括扩展源）。普通页面 `fetch` 失败（§2.1 对照组）与预检 400 相互印证。

**扩展两条路径之所以可达，靠的是 manifest 的 `host_permissions`**：MV3 中命中 `host_permissions` 的跨域请求由扩展网络栈发出，不经页面 CORS。当前配置（`wxt.config.ts:126`）：

```ts
host_permissions: ['http://*/*', 'https://*/*'],
```

覆盖 `https://api.typesafe.ai/*`，因此**本功能不需要新增任何 host 权限，也不触发商店审核的人工闸口**（AGENTS.md Note 5 关注点，此处无变更诉求）。反之这是一个约束：若未来把 `host_permissions` 收窄，插件页面/后台对 Jev 的直连会立即被 CORS 掐断（预检 400），实现方必须保留"页面不可达 → 走扩展后台"的降级路径（FR-017）。

wire 抓包（CDP `Network.requestWillBeSent`）还确认：扩展上下文发出的 POST **不携带 `Origin` 头**、不触发预检（`Referer` 为空串），与普通页面请求形态不同。

### 2.3 未测路径（如实说明）

- **zhipin 页面内（content script / MAIN world）直连未测**：任务边界禁止打开 zhipin.com（HITL 约束）。由 §2.2 的预检 400 与普通网页对照组推断，**页面源直连大概率不可行**，m2 的 t5/t8 若需要页面内直连须自行验证；本文只对"插件页面 + 扩展后台"两条路径下可达性结论负责。
- 未对 `jev-preview` 模型做调用（`GET /v1/models` 返回 `jev-latest`、`jev-preview` 两个别名），实测全部走 `jev-latest`。

---

## 3. 请求与响应形态

### 3.1 实际发出的请求体（线上抓包，字段逐一核对）

CDP `Network.requestWillBeSent` 抓到的完整 POST body（插件页面与后台两条路径各抓一次，内容一致）：

```json
{
  "model": "jev-latest",
  "state": {
    "job_title": "高级前端工程师（示例岗位，虚构）",
    "job_description": "负责虚构示例公司的后台管理界面开发，要求熟悉 Vue 与 TypeScript，工作地点：虚拟市。本岗位描述为探针测试用的公开虚构文本，不含任何真实个人信息。"
  },
  "questions": {
    "frontend_role": {
      "type": "noul",
      "instructions": "该岗位是否以前端开发为主要职责？",
      "criteria": {
        "true": "岗位描述明确以前端/界面开发为主",
        "false": "岗位描述以前端以外的工作为主"
      }
    }
  }
}
```

请求头（脱敏）：`Authorization: Bearer <REDACTED>`、`Content-Type: application/json`。

**契约说明（重要，避免误读验收点 3）**：请求体顶层是 `model` + `state` + `questions` 三个字段。其中**岗位数据只存在于 `state`，且只有 `job_title` 与 `job_description` 两个键**——这一点由抓包逐字段核实，满足"只发标题与职位描述"（FR-011 / AC-011）。`model` 是模型别名（协议必填），`questions` 是问题定义（非岗位内容）。t5 的请求体断言应按此形态写：断言 `state` 的键集合恰好为 `{job_title, job_description}`，而不是断言整个 body 只有两个字段。

### 3.2 响应形态（200）

```json
{
  "model": "jev-1.13.0",
  "answers": { "frontend_role": { "type": "noul", "noul": 0.98 } },
  "usage": { "input_tokens": 428, "output_tokens": 21 }
}
```

要点：

- 响应的 `model` 是**解析后的具体版本**（请求别名 `jev-latest` → 响应 `jev-1.13.0`）。t9 缓存键里的"Jev 模型标识"应取**响应里的具体版本**而非请求别名，否则供应商滚动别名后缓存无法随版本失效。
- `GET https://api.typesafe.ai/v1/models`（需鉴权）返回可用别名与发布时间：`jev-latest`（2026-09-10）、`jev-preview`。注意 `BASE_URL`（`…/v1/systemone`）下没有 `/models` 子路径（404），models 端点在站点根 `/v1/models`。
- token 用量：纯标题+描述的最小请求 `input_tokens≈340–430`、`output_tokens≈21`；约 4400 字的 `state` 为 `input_tokens=4348`。输入按量计费、输出免费（docs 口径），请求体没有需要分页/截断的压力，但超长描述会线性放大成本与时延。
- 公开 OpenAPI 契约可匿名获取：`GET https://api.typesafe.ai/openapi.json`（200，`SystemOneRequest` / `SystemOneResponse` / `Question`（`noul|choice|score` 判别联合）/ `Answer` / `Usage` 全量 schema），t5 建类型时以此为唯一权威，不要手抄。

### 3.3 错误与边界形态

| 场景                                                        | HTTP      | 响应体（脱敏）                                                                                                                                 |
| ----------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺 `model` / `questions` / `state`，或 `questions` 结构错误 | 422       | `{"detail":[{"type":"missing","loc":["body","model"],"msg":"Field required","input":{}}, …]}`（`detail` 是**数组**）                           |
| body 非法 JSON / `Content-Type` 非 JSON / 空 body           | 422       | `{"detail":[{"type":"json_invalid"…}]}` / `{"detail":[{"type":"model_attributes_type","loc":["body"]…}]}`                                      |
| 未知模型名                                                  | 400       | `{"detail":{"error_type":"api_usage_error","message":"Unknown model: no-such-model"}}`                                                         |
| 错误 API key                                                | 401       | `{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}`   |
| 缺 API key                                                  | 403       | `{"detail":{"error_type":"authentication_error","message":"Must supply an API key!…"}}`                                                        |
| 错误方法（GET/PUT/PATCH）或错误路径                         | 405 / 404 | `{"detail":"Method Not Allowed"}` / `{"detail":"Not Found"}`（`detail` 是**字符串**）                                                          |
| 服务端过载/限流                                             | 未复现    | 20 并发下无 429、无 `Retry-After`（CORS `access-control-expose-headers` 声明了 `Retry-After, retry-after-ms`，说明该语义存在，但本次未观测到） |
| **挂起**                                                    | 无响应    | 见 §4.2：并发压测中 60s 读超时与 TLS 握手超时各 1 次，另一次无效模型探测中 TLS 握手挂起 120s 无响应；客户端必须有超时，不能依赖服务端报错      |

`detail` 有三种形态（对象数组 / 对象 / 字符串），t5 解析错误时不能假设其中一种。

---

## 4. 耗时分布

测量环境：本机（macOS，arm64）→ Cloudflare 边缘（`remote_ip 104.18.24.46`），每样本为一次完整 `fetch` 往返（含 TLS 复用）。样本均为成功请求；失败与离群值单独列在 §4.2，不混入分位数。

### 4.1 成功请求耗时（毫秒）

| 场景                                            | n   | min | p50 | p90 | p95 | max  |
| ----------------------------------------------- | --- | --- | --- | --- | --- | ---- |
| `POST /v1/systemone`，标题+短描述（shell 直连） | 30  | 323 | 349 | 494 | 569 | 1683 |
| 同请求，40 连发序列（shell 直连）               | 40  | 324 | 360 | 439 | 689 | 972  |
| 同请求，**插件页面**上下文                      | 10  | 310 | 327 | 698 | 698 | 698  |
| 同请求，**扩展后台**（service worker）上下文    | 10  | 314 | 356 | 374 | 374 | 374  |
| 真实长度岗位描述（~500 字）                     | 10  | 336 | 363 | 392 | 392 | 392  |
| 空标题+空描述（`state` 为空串）                 | 5   | 550 | 616 | 717 | 717 | 717  |
| 超长 state（~4400 字，4348 input tokens）       | 5   | 706 | 743 | 943 | 943 | 943  |
| `choice` 型问题（3 选项）                       | 5   | 564 | 642 | 650 | 650 | 650  |
| `GET /v1/models`（鉴权）                        | 10  | 280 | 291 | 351 | 351 | 351  |

读法：典型单次判定 **300–700ms**，与官方"70–500ms"口径同量级；payload 大小在 0.4k→4.3k tokens 区间内时延只从 ~350ms 涨到 ~780ms，**时延对岗位描述长度不敏感**，两阶段（先标题后详情）设计不会因第二次调用产生明显额外时延。

### 4.2 失败、挂起与离群值（单独列出，不计入上表）

| 现象                                          | 次数 | 细节                                                                                                                                                             |
| --------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20 并发压测：2 个请求 ~60.8s 才返回 200       | 2/20 | 18 个成功（min 633 / 中位 ~700 / max 60893ms）；客户端 60s 超时场景下这 2 个会被判为超时——**服务端最终完成了计算，结果不可知**，属于典型"不确定"而非失败         |
| 20 并发压测：客户端 60s 读超时 / TLS 握手超时 | 2/20 | `TimeoutError('The read operation timed out')`、`URLError(TimeoutError('…handshake…timed out'))`；无 429、无 `Retry-After`，即客户端无法从响应区分"限流"与"挂起" |
| 15 连发序列中出现一次 30.8s 的 200            | 1/15 | 同一请求其余 14 次 567–1492ms；说明**单请求长尾可达数十秒**，非并发特有                                                                                          |
| 一次 TLS 握手挂起 120s 无响应                 | 1    | 发生在一次无效模型名探测中；重试同请求立即返回 400                                                                                                               |

结论：**"偶发挂起且无错误响应"是真实存在的形态**（约 1–3% 样本），这就是超时必须由客户端强制的直接证据，也是 FR-013"超时 → 待复核、不缓存、下次重判"的实证依据。

---

## 5. 不确定结果的表现

Jev **没有**"无法判断"的结构化标志（无状态码、无枚举、无 `uncertain` 字段）。不确定性只通过数值表达：

| 问题类型           | 响应                                                                                                                  | 不确定信号                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `noul`（是/否）    | `{"type":"noul","noul":0.98}`                                                                                         | 概率本身；**越接近 0.5 越不确定**（schema 原文：values near 0.5 indicate uncertainty）。无独立 `confidence` 字段 |
| `choice`（N 选 1） | `{"type":"choice","choice":"junior","confidence":0.26,"probabilities":{"junior":0.54,"not_a_job":0.46,"senior":0.0}}` | `confidence`（0–1）与 `probabilities` 的头部差距                                                                 |
| `score`（评分）    | `{"type":"score","score":1.7,"confidence":…,"legend":…,"probabilities":…}`                                            | 同 choice                                                                                                        |

实测标定（同一 `noul` 问题「该岗位是否以前端开发为主要职责？」，全部为虚构岗位文本；全量=标题+描述，标题=只给 `job_title`）。56 次调用全部 200：

| 输入（虚构岗位）                                 | noul（全量，重复 n=3） | noul（只给标题，n=1） | 解读                                                  |
| ------------------------------------------------ | ---------------------- | --------------------- | ----------------------------------------------------- |
| 前端开发工程师（明确前端）                       | 0.99 / 0.99 / 0.99     | 0.97                  | 明确"是"                                              |
| Web 前端工程师（可视化方向）                     | 0.99 / 0.99 / 0.99     | 0.96                  | 明确"是"                                              |
| 前端工程师（小程序）                             | 0.98 / 0.98 / 0.98     | 0.96                  | 明确"是"                                              |
| 全栈工程师（一半前端一半后端）                   | 0.26 / 0.25 / 0.25     | 0.25                  | **含糊**：语义上"一半是"，落在偏低但非极值区 → 待复核 |
| 后端开发工程师                                   | 0.03 / 0.02 / 0.02     | 0.02                  | 明确"否"                                              |
| 数据分析师                                       | 0.02 ×3                | 0.02                  | 明确"否"                                              |
| 产品经理（后台方向）                             | 0.02 ×3                | 0.03                  | 明确"否"                                              |
| 测试开发工程师                                   | 0.03 ×3                | 0.06                  | 明确"否"                                              |
| 算法工程师                                       | 0.02 ×3                | 0.02                  | 明确"否"                                              |
| UI 设计师                                        | 0.03 / 0.03 / 0.02     | 0.05                  | 明确"否"                                              |
| 运维开发工程师                                   | 0.02 ×3                | 0.04                  | 明确"否"                                              |
| 在线客服专员                                     | 0.01 ×3                | 0.02                  | 明确"否"                                              |
| AI 产品研发工程师（易混，含"少量界面联调"）      | 0.05 ×3                | 0.07                  | 明确"否"                                              |
| 数据产品经理（易混，与前端协作但不自己实现界面） | 0.03 ×3                | 0.03                  | 明确"否"                                              |
| 空标题 / 空 `state`                              | —                      | 0.32（空标题）        | 无内容时的"不知道"区；空 state 另测 0.24–0.26（n=5）  |

读法：除「全栈对半」外，两组取值都落在 ≤0.07 或 ≥0.96；**唯一落进 (0.2, 0.8) 的正是语义上真正含糊的岗位**，这正是该带的价值所在。

标题阶段的局限（支撑 FR-012 两阶段设计）：只给标题时「后端开发工程师」=0.02、「产品经理」=0.03、「数据分析师」=0.02；把这几个标题的描述换成一段明确的前端岗位描述后，分别升到 0.90 / 0.89 / 0.91——**标题说"否"、描述说"是"的情况真实存在**，故标题阶段的"否"必须先过 FR-012 的语义（明确不相关才跳过取详情），不能直接当终判。

边界抖动实测（判定方式的关键证据）：

- `noul` 型、同一含糊全栈岗位重复 8 次（本次会话早期测量，criteria 措辞与 §5 标定表略有差异）：`0.31,0.32,0.32,0.32,0.32,0.32,0.32,0.31` —— 小样本内**数值稳定但贴着含糊带**；明确输入重复 6 次：`0.98 ×6` 稳定。**样本量小（n=6/n=8、单会话），不能据此声称跨会话确定性，更不能作为"缓存永不失效"的依据。**
- `choice` 型、同一含糊输入重复 5 次：**答案在 `junior` 与 `not_a_job` 之间翻转**（`probabilities` 头部差距仅 0.01–0.04，`confidence` 0.25–0.31）——含糊带上的 choice 型输出不可靠，**不能靠重试收敛**。

推论：

1. 优先使用 `noul` 型问题；不确定性用「到 0.5 的距离」判定。
2. 含糊带内的结果**不得**当作明确结论，也不得靠重试硬判（choice 实测会翻转）；按 FR-013 进待复核。
3. 超时/网络错误（§4.2）与"模型给了个含糊数"是两类不同的不确定，都进待复核，但前者可注明"超时"以便用户重试。

---

## 6. 建议值（**待用户确认**，确认后回写 spec.md §Constraints）

以下均为工程判断 + 本次实测外推，**不是**统计学定稿；列出理由与备选，供用户拍板。

### 6.1 超时秒数：建议 **8 秒**（单次尝试，不自动重试）

- 依据：成功请求 p50≈0.35s、p95≤0.7s、70 次顺序连发 max 1.7s；同时存在 30–60s 级长尾/挂起（顺序样本约 1/200 ≈ 0.5%，20 并发时恶化到 4/20，见 §4.2）。8s ≈ 实测 p99（1.7s）的约 5 倍余量，足以覆盖正常抖动，又不至于在挂起时长时间阻塞投递流水线。
- 超时行为：`AbortController` 中断（已在扩展页面上下文实测 400ms 中断生效，抛 `AbortError`），按 FR-013 记待复核、不缓存，下次扫到重判；**不自动重试**——挂起类样本服务端可能仍在计算，自动重试有重复计费与结果翻转双重风险。
- 备选：15s（更少误判超时，但流水线单岗位最长阻塞翻倍）；5s（更激进，~1% 正常长尾会被误伤）。

### 6.2 不确定判定：建议 **noul ≤ 0.2 判"否"，noul ≥ 0.8 判"是"，(0.2, 0.8) → 待复核**

- 依据：本次标定中明确样本全部落在 ≥0.97 或 ≤0.03，含糊样本（全栈对半、空标题、纯别名）落在 0.24–0.32；(0.2, 0.8) 恰好把两组分开，且给 0.5 两侧各留 0.3 的缓冲。
- 配套规则：**超时、网络错误、4xx/5xx、字段缺失一律待复核，绝不因失败而放行或排除**（AGENTS.md：筛选 fail-open 是阻断性缺陷）；若未来用 `choice`/`score` 型，需另设 `confidence` + 头部概率差距阈值（本次数据显示 choice 在低置信区会翻转答案，阈值须显著高于实测的 0.25–0.31 才有区分力）。
- 待用户确认的点：0.2/0.8 的分界本质是业务对"误杀 vs 漏放"的取舍，实测只证明了**该分界能分开本次标定的两端**，不代表最优。

### 6.3 缓存期限：建议 **7 天**（只缓存明确结果）

- 依据与设计要点（对接 FR-015 / t9）：
  - 缓存键 = 岗位标识 + 判定依据指纹（目标方向描述 + **响应返回的具体模型版本**，如 `jev-1.13.0`，而非别名 `jev-latest`）——任一变化即失效，这是 spec 已定的语义；TTL 只兜三件事：岗位描述被招聘方编辑、同版本模型的行为漂移、存储膨胀。
  - 本次会话内同输入重复调用结果稳定（noul 0.98×6、0.25×3、0.31/0.32×8），**但没有跨天数据**，7 天是对"编辑后的岗位不该永远沿用旧判定"与"减少重复请求"的折中，属保守默认值。
  - 待复核结果不写缓存（FR-013），因此 TTL 只作用于"是/否"两种明确结果。
- 备选：24h（岗位列表编辑更频繁时的保守选择）；30d（更省钱，风险是编辑后的岗位沿用旧判定最长一个月）。

### 6.4 需要用户确认的清单

1. 超时 8s（§6.1）是否接受？
2. 不确定带 (0.2, 0.8)（§6.2）是否符合业务对误杀/漏放的偏好？
3. 缓存 7 天（§6.3）是否接受？缓存键采用响应中的具体模型版本而非别名，是否认可？
4. 契约口径（§3.1）：AC-011 的"只含标题与职位描述"按"`state` 仅含这两键、`model`/`questions` 为协议字段"理解和断言，是否认可？

---

## 7. 未尽事项

| 事项                                                 | 状态                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| zhipin 页面内（content script / MAIN world）直连 Jev | **未测**：HITL 边界禁止打开 zhipin.com。由预检 400 与普通网页对照推断大概率不可行（[INFERENCE]），m2 需页面直连时须另行获准验证 |
| `jev-preview` 模型                                   | 未调用（仅 `GET /v1/models` 确认存在）                                                                                          |
| 429/限流形态                                         | 未复现（20 并发未触发）；`Retry-After` 语义存在但无样本，t5 不应假设一定能拿到该头                                              |
| 长期确定性 / TTL 实证                                | 未测（单会话）；§6.3 的 7 天为工程默认值，非 longitudinal 结论                                                                  |
| 跨设备/跨浏览器（Firefox `moz-extension`）路径       | 未测；Firefox 预检同样 400，`host_permissions` 机制为 Chromium 语义，Firefox 下需 m2 用 `browser.runtime` 等价物另行验证        |

---

## 8. 复现命令

凭证准备（不回显）：

```bash
set -a; . /Users/chenwenjie/Downloads/boss-helper/.run/p1-jev.env; set +a
```

结构与错误形态（可重复，只读）：

```bash
# 可用模型（注意：models 在站点根，不在 BASE_URL 下）
curl -sS -w '\nhttp=%{http_code} t=%{time_total}\n' "https://api.typesafe.ai/v1/models" \
  -H "Authorization: Bearer $API_KEY"

# 最小判定请求（body 内全部为虚构岗位文本）
cat > /tmp/jev-probe.json <<'JSON'
{"model":"jev-latest",
 "state":{"job_title":"高级前端工程师（示例岗位，虚构）",
          "job_description":"负责虚构示例公司的后台管理界面开发，要求熟悉 Vue 与 TypeScript。虚构文本，无真实信息。"},
 "questions":{"frontend_role":{"type":"noul",
   "instructions":"该岗位是否以前端开发为主要职责？",
   "criteria":{"true":"岗位描述明确以前端/界面开发为主","false":"岗位描述以前端以外的工作为主"}}}}
JSON
curl -sS -w '\nhttp=%{http_code} t=%{time_total}\n' -X POST "$BASE_URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data-binary @/tmp/jev-probe.json

# 错误形态：未知模型 / 坏 key / 非法 JSON / 错误方法
curl -sS -w '\nhttp=%{http_code}\n' -X POST "$BASE_URL" -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' -d '{"model":"no-such-model","state":"x","questions":{"a":{"type":"noul"}}}'
curl -sS -w '\nhttp=%{http_code}\n' "$BASE_URL" -H "Authorization: Bearer $API_KEY"   # 405
```

CORS / 预检：

```bash
curl -sSi -X OPTIONS "$BASE_URL" \
  -H "Origin: chrome-extension://ogkmgjbagackkdlcibcailacnncgonbn" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" | sed -n '1,12p'
# 预期：HTTP 400，body "Disallowed CORS origin"，无 access-control-allow-origin
```

扩展两条路径（本会话用 CDP `Extensions.loadUnpacked` 加载 `.output/chrome-mv3` 后，分别在 options 页与 service worker 的执行环境里 `fetch`；`--load-extension` 启动参数在 Chrome 153 已不生效，必须走 CDP 私有接口）：

```bash
bun run build:smoke   # 产出 .output/chrome-mv3（退出码 0）
# Chrome 需带 --remote-debugging-port=<port> --headless=new --enable-unsafe-extension-debugging 启动，
# 然后对 browser 级 WebSocket 发 Extensions.loadUnpacked {"path":"<repo>/.output/chrome-mv3"}，
# Target.createTarget 打开 chrome-extension://<id>/options.html，
# 在页面与 SW 两个 Runtime.evaluate 里执行与上面 curl 等价的 fetch，并记录 status/耗时。
# 另用 Network.requestWillBeSent 抓 request.postData 核对请求体字段（见 §3.1）。
```

延迟分布：对 `POST $BASE_URL` 重复 ≥30 次记录 `%{time_total}`，按 §4.1 表格式汇总；并发/长尾样本按 §4.2 单列。

---

## 9. 对 m2 的落地提示（供 t5/t8/t9 引用）

1. 请求必须带 `Authorization: Bearer <key>` 与 `Content-Type: application/json`；`BASE_URL` 直接 POST，无 `/chat/completions` 类子路径。
2. 错误解析要同时处理 `detail` 的三种形态（§3.3）；鉴权失败是 401/403，不会是 200 包错误。
3. 响应 `model` 用作缓存键的模型标识（§3.2）。
4. 两条路径都可达的根因是 `host_permissions` 通配（§2.2）；实现仍应保留 FR-017 的"页面失败 → 后台转发"降级，因为权限收窄或未来 CSP 变化都会让页面直连失效。
5. 超时用 `AbortController`；超时/错误/含糊统一进待复核，不缓存（§4.2、§5、§6）。
