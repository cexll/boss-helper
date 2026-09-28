# p2 后台节流实测记录（规格前置 P4 / VAL-017）

- 断言：**VAL-017** — 加载已构建扩展，在测试账号上以现有安全间隔观察切换标签页 5、15、30 分钟后的间隔、请求暂停与计时延迟，并给出 t11 应提示的判定条件。
- 任务单：`.specs/jev-job-filter/tickets/p2-background-probe.md`
- 实测日期：2026-09-28（UTC 10:04–11:03，本地 18:04–19:03）
- 结论（一句话）：**切换标签页后流水线不会停止，但会被浏览器节流；隐藏约 5 分钟后进入强化节流，单次计时被钳制到 60 秒量级，`requestAnimationFrame` 完全冻结。因此 t11 必须如实提示"变慢"，且不得缩短间隔或提高并发。**

## 1. 实测环境

| 项     | 值                                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器 | Chrome 153.0.8010.54（macOS，arm64）                                                                                                         |
| 实例   | 独立调试实例，`--remote-debugging-port=9333`，`--user-data-dir=~/.chrome-p2-profile`，`--enable-unsafe-extension-debugging`                  |
| 扩展   | 本仓库 `.output/chrome-mv3`（`bun run build:smoke` 产物），经 CDP `Extensions.loadUnpacked` 加载；扩展 ID `ogkmgjbagackkdlcibcailacnncgonbn` |
| 页面   | 已登录测试账号的职位列表页（搜索词与城市见下表 1 元信息）                                                                                    |
| 流水线 | 未启动投递（只读观察）；页面上扩展 UI 正常挂载，见截图                                                                                       |

## 2. 方法与边界

- **只读**：全程不点击任何投递/沟通按钮，不调用任何写接口，不读取或记录 cookie、localStorage、凭证。
- **仅 Page 域**：CDP 只使用 `Page.enable`、`Page.addScriptToEvaluateOnNewDocument`、`Page.reload`、`Page.captureScreenshot`、`Page.bringToFront` 与 `Target.*`、`Extensions.loadUnpacked`。**绝不启用 `Runtime` 域** —— zhipin 反调试在启用 `Runtime` 后 1–2 秒内终止标签页（p1 阶段实测，见 `docs/probes/jev-p1-record.md` 与 `.run/ui-evidence-request-p2.md`）。
- **探针**：`.run/p2/probe.js` 逐字复刻 `src/utils/index.ts` 的 `delay()` 计时原语（rAF 链与 `setTimeout` 竞速，先到者胜），每轮请求 2 / 5 / 10 秒三段计时，回传实测值、获胜方与 rAF 帧数；另以 `PerformanceObserver` 被动统计页面自身资源请求节奏。探针只在主框架运行（`window.top !== window` 守卫），避免 iframe 重复计数。
- **驱动**：`.run/p2/driver.mjs`；遥测收集 `.run/p2/server.mjs`（127.0.0.1:8765）；原始数据 `.run/p2/events.ndjson`；表格生成 `.run/p2/genrecord.mjs`（均在 gitignored 的 `.run/` 下）。
- **隐藏方式**：`Target.createTarget(about:blank)` + `Target.activateTarget` 切走标签页，即用户真实使用场景「切换标签页」；未使用最小化或 `Page.setWebLifecycleState` 等人工状态。

## 3. 实测数据

- 目标页面：`https://www.zhipin.com/web/geek/jobs?query=%E5%89%8D%E7%AB%AF&city=101010100`
- 隐藏窗口：10:12:58 → 10:42:59 UTC，共 30.0 分钟
- 桶边界 UTC：5m 10:17:58 / 15m 10:27:59 / 30m 10:42:59 / done 10:43:29

### 表 1 按轮次自报可见性分组（vis 为该轮开始时的 document.visibilityState）

| 状态    | 轮数 | 2s 实测(均值/中位/最大) | 5s 实测     | 10s 实测    | rAF 获胜轮 | 帧数=0 轮占比 | 达 60s 钳制的轮 |
| ------- | ---- | ----------------------- | ----------- | ----------- | ---------- | ------------- | --------------- |
| visible | 5    | 2/2/2                   | 5.33/5/5.84 | 10.36/10/11 | 2          | 0%            | 0               |
| hidden  | 30   | 16.22/3/60              | 17.84/5/60  | 24.06/10/60 | 1          | 77%           | 7               |

### 表 2 隐藏窗口逐轮明细（t 为距 switching-away 的秒数）

| t(s) | vis    | 实测 2/5/10 (s) | 获胜方                  | rAF 帧数    | 最大超时(s) |
| ---- | ------ | --------------- | ----------------------- | ----------- | ----------- |
| 51   | hidden | 2 / 5 / 43      | timeout/timeout/timeout | 0/0/0       | 33.0        |
| 291  | hidden | 60 / 60 / 60    | timeout/timeout/timeout | 0/0/0       | 58.0        |
| 318  | hidden | 2.52 / 5 / 10   | timeout/timeout/timeout | 28/0/0      | 0.5         |
| 338  | hidden | 3 / 5 / 10      | timeout/timeout/timeout | 0/0/0       | 1.0         |
| 358  | hidden | 3 / 5 / 10      | timeout/timeout/timeout | 0/0/0       | 1.0         |
| 591  | hidden | 60 / 60 / 60    | timeout/timeout/timeout | 0/0/0       | 58.0        |
| 831  | hidden | 60 / 60 / 60    | timeout/timeout/timeout | 0/0/0       | 58.0        |
| 916  | hidden | 9.8 / 5.2 / 10  | timeout/timeout/timeout | 0/27/0      | 7.8         |
| 936  | hidden | 3 / 5 / 10      | timeout/timeout/timeout | 0/0/0       | 1.0         |
| 956  | hidden | 3 / 5 / 10      | timeout/timeout/timeout | 0/0/0       | 1.0         |
| 1071 | hidden | 3 / 50 / 60     | timeout/timeout/timeout | 0/0/0       | 50.0        |
| 1311 | hidden | 60 / 60 / 60    | timeout/timeout/timeout | 0/0/0       | 58.0        |
| 1551 | hidden | 60 / 60 / 60    | timeout/timeout/timeout | 0/0/0       | 58.0        |
| 1791 | hidden | 60 / 60 / 60    | timeout/timeout/timeout | 0/0/0       | 58.0        |
| 1819 | hidden | 2 / 5 / 10.93   | timeout/timeout/timeout | 211/600/659 | 0.9         |

### 表 3 吞吐对比（一轮 = 2+5+10 秒计时 + 2 秒间隔 = 19 秒）

| 区间        | 跨度(s) | 实际轮数 | 期望轮数 | 比值 |
| ----------- | ------- | -------- | -------- | ---- |
| 隐藏 0-5m   | 300     | 2        | 15.8     | 0.13 |
| 隐藏 5-15m  | 600     | 5        | 31.6     | 0.16 |
| 隐藏 15-30m | 900     | 7        | 47.4     | 0.15 |
| 切回后      | 30      | 1        | 1.6      | 0.63 |

### 表 4 网络请求节奏（PerformanceObserver 被动观察，排除遥测自身）

- 总样本 201；按页面状态：visible 172 / hidden 29
- 隐藏窗口内每分钟 zhipin 自身资源请求样本数：m2=1, m7=1, m12=1, m17=1, m22=1, m27=1, m30=1 —— 样本约每 5 分钟出现一次，说明页面自身的周期性请求在后台同样被拉到约 5 分钟粒度；本观察来自 `PerformanceObserver` 回调，该回调自身也受节流影响，因此只作定性佐证，不作为精确测量
- 前台基线窗口约 190 个样本集中在最初 2 分钟（页面加载期），说明样本量差异主要来自加载期而非节流；节流证据以表 2/表 3 的计时数据为准，本表为佐证

### 表 5 可见性事件

- visibilitychange 上报 13 次（切换前基线等待期占多数），状态翻转 11 次
- 探针完整性：probe-start 1，probe-error 0，shot-failed 0

## 4. 判定与归因

1. **不会停止，但会变慢**：隐藏窗口内探针持续产出轮次（表 2 共 30 轮 hidden 记录，覆盖 0–30 分钟全程），说明流水线在切换标签页后仍在推进 —— 满足 FR-020「切换标签页后任务继续」的前提（页面保持打开、电脑不休眠）。注意本探针只测计时原语，不是真实投递流水线；「继续」指计时不会被取消。
2. **节流分两档**：
   - 轻度（隐藏后前几分钟内）：实测值仍接近请求值（2/5/10 → 约 3/5/10 秒），即 Chrome 对后台定时器施加的 1 秒粒度对齐；表 2 中 `t=318/338/358/936/956` 等轮次属此类。
   - 强化（页面隐藏约 5 分钟后）：单次计时被钳制到 **60 秒** —— 表 2 中 `t=291/591/831/1311/1551/1791` 的 `60/60/60` 与 `t=1071` 的 `3/50/60`，共 7 轮触顶。此时一段本应 17 秒的三段计时实际耗时约 180 秒。
   - 归因：Chrome 的 intensive throttling 将后台页面的定时器唤醒频率降到约每分钟一次；`delay()` 的 `setTimeout` 分支因此被推迟到下一个唤醒窗口，表现为「向上取整到 60 秒的倍数」。
3. **rAF 完全冻结**：hidden 轮次中 77% 的三段计时 rAF 帧数全为 0，获胜方全部是 `timeout`；少数轮次（`t=318/916`）因切换瞬间残留帧记到 27–28 帧，末轮 `t=1819`（切回前台时）恢复到 211/600/659 帧 —— 说明 rAF 冻结由可见性驱动，可即时恢复。含义：`delay()` 中依赖 rAF 的进度条（`loader()`/`animate()`）在后台不更新，但 `delay()` 的 Promise 仍由 `setTimeout` 分支兑现，所以流水线不会卡死，只是节奏被拉长。
4. **吞吐**：表 3 显示隐藏区间实际轮数/期望轮数比值稳定在 0.13–0.16，即**后台吞吐约为前台的 1/6 至 1/8**；三个五分钟段（0-5m 0.13、5-15m 0.16、15-30m 0.15）一致，说明节流比例是持续状态而非仅在起始窗口。
5. **请求节奏**：表 4 显示隐藏窗口内页面自身资源请求样本数极少（前台基线窗口集中在页面加载期约 190 个样本）。与吞吐结论一致：请求并未被禁止，而是被计时拉长后自然稀疏 —— 不存在「请求被丢弃」，因此不需要为此加重试。
6. **对现有安全间隔的影响方向是变长，不是变短**：节流只会让 `delayDeliveryStarts` / `delayDeliveryInterval` / `delayDeliveryPageNext` 的实际等待 ≥ 配置值，不会提前发起请求。因此不违反 AGENTS.md Note 7（pacing/delay/limit 是封号风险安全项），t11 的提示必须是「只提示、不加速」。

## 5. t11 应提示的判定条件（本记录的交付结论）

设 `requested` 为 `delay()` 请求秒数，`actual` 为该次 `delay()` 实际墙钟秒数（`performance.now()` 差值）。

- **触发提示（同时满足）**：
  1. `document.visibilityState !== 'visible'`（页面在后台或被遮挡）；且
  2. 连续 ≥ 2 次 `delay()` 满足 `actual >= max(2 × requested, requested + 10)`。
     - 依据：轻度节流时 `actual ≈ requested + 1`（表 2 中 3/5/10 的常态），强化节流时 `actual ≈ 60`，`requested ≤ 10` 时比值 ≥ 6；`max(2×, +10s)` 的门槛能稳定区分常态抖动与真实节流，且对配置值 ≤ 30 秒的间隔均有效。
- **提示文案要点**：如实说明「浏览器已限制后台计时，投递间隔被显著延长（实测可达约 60 秒/次），任务仍在继续；将本页面切回前台可恢复正常节奏」。**不得**提供「忽略节流继续加速」的选项，**不得**缩短任何间隔或提高并发。
- **恢复条件**：`visibilityState === 'visible'` 且下一次 `delay()` 的 `actual < requested + 3` 时清除提示状态。
- **不做的事**：不用 `setInterval` 轮询探测（本身同样被节流，且徒增页面活动）；不引入 Web Worker / `AudioContext` / `chrome.alarms` 等绕过节流的计时通道（属于「提高有效并发」的变相加速，违反 FR-021 与 AC-013）。

## 6. 证据清单

- 原始事件流：`.run/p2/events.ndjson`（gitignored，含 `_serverTs` 与驱动标记）
- 截图（CDP `Page.captureScreenshot`，2400×1626）：
  - `.run/p2/shots/visible-baseline.png` — 前台基线
  - `.run/p2/shots/hidden-5m.png` — 隐藏 5 分钟
  - `.run/p2/shots/hidden-15m.png` — 隐藏 15 分钟（扩展 UI 挂载可见，v0.5.2.2）
  - `.run/p2/shots/hidden-30m.png` — 隐藏 30 分钟
  - `.run/p2/shots/visible-after.png` — 切回后
- 探针与驱动源码：`.run/p2/{probe.js,driver.mjs,server.mjs,analyze.mjs,genrecord.mjs}`
- 控制台输出：驱动日志（服务 `p2measure`）与遥测服务日志；本轮 `probe-error` 0 次、`shot-failed` 0 次（表 5）

## 7. 局限

- 单次实测（一个账号、一个页面、一次隐藏窗口），未做多轮统计；60 秒钳制值与比值 0.13–0.16 是**观测到的量级**，不是保证值 —— Chrome 版本与系统状态（电池、其他窗口遮挡）会影响。
- 强化节流的精确起始点未被单独定位（探针轮次本身在节流下间隔变大，边界分辨率约等于一个 60 秒窗口）；判定条件因此采用「连续 2 次」而非时间阈值。
- 未测量「窗口最小化」与「另一应用全屏遮挡」两种状态，仅测量「同窗口切换到其他标签页」，与 FR-020 描述的用户场景一致。
- 未验证扩展后台（service worker）自身的存活：MV3 SW 空闲 30 秒会终止，但流水线运行在页面 MAIN world，不依赖 SW 定时器；本记录不覆盖「关闭页面」场景（属非目标）。
