# jev-client-contract — Jev 请求/响应契约与降级（回归流程契约）

- 断言：VAL-009（a-final-2-r2 判定 **pass**，可回归，**含显式局限**，见 Scope）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 Jev 客户端与降级路径的 wire 契约（FR-010/FR-011/FR-017/FR-028，p1 §6.4 用户确认口径）：

- 请求体顶层只有协议字段 `model/state/questions`；岗位数据只在 `state`，且 `state` 键集合恰为 `{job_title, job_description}`（多一个键 fail-closed 拒绝）。
- 超时 → 待复核（不是错误、不是放行）；页面直连不可达时走扩展后台降级，后台不可达如实说明原因；后台中继不含密钥与端点。
- 实测常量口径：`JEV_TIMEOUT_MS = 8000`、state 允许清单 `['job_title','job_description']`、`JEV_UNCERTAIN_BAND = {0.2, 0.8}`、会话级缓存键含响应具体模型版本。

**显式局限（必须与结论一起引用）**：本流程是 bun 层 wire 断言；真实 Jev 端点调用属 p1 HITL（用户批准），不在本流程内重复。p1 记录另如实声明「zhipin 页面内直连未测」（见 VAL-016 流程契约）。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位（`git submodule update --init --recursive && bun install`）。
- 无一次性脚本：本流程直接跑仓库既有测试 `src/utils/jev.test.ts`（请求体/超时/错误三形态/降级/后台中继）与 `src/entrypoints/boss/delivery.test.ts`。测试内不发起真实网络（fetch 被注入/桩替换）。
- 实现锚点（供对照，勿在本流程中修改）：`src/utils/jev.ts:43`（`JEV_TIMEOUT_MS=8000`）、`src/utils/jev.ts:383-388`（state 允许清单）、`src/composables/useApplying/jevDirection.ts:36`（不确定带）。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/jev-client-contract

# 1) jev 客户端 + 投递接入（junit）
bun test src/utils/jev.test.ts src/entrypoints/boss/delivery.test.ts --reporter=junit \
  | tee .run/qa/jev-client-contract/buntest.txt
```

补充核对（只读，非阻断）：`grep -n "JEV_TIMEOUT_MS\|job_description" src/utils/jev.ts`、`grep -n "JEV_UNCERTAIN_BAND" src/composables/useApplying/jevDirection.ts`，确认常量口径与契约一致。

## Blocking checks for future runs

1. 步骤 1 输出 `0 fail`；通过数基线 `41 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致）；JUnit 根节点 `tests=41 assertions=110 failures=0`。新增用例使计数上升不算失败；任何 `fail` 即停。
2. JUnit 中必须存在并全过：请求体顶层只有协议字段、state 键集合恰为 `job_title`+`job_description`、超时→待复核、页面直连失败不静默放行、FR-017 后台中继、FR-028 中继不含密钥。
3. 若某条关键用例被改名或删除（上述语义在 JUnit 中找不到），视为契约失效，须停下核对，不得以「通过数未降」放行。

## Evidence expected

落盘 `.run/qa/jev-client-contract/`：

- `buntest.txt` — 晋升基线副本：`VAL-009-buntest.txt`，sha256 `d6e826e0f7e73d7032d10007e78a17b7b5ef4b82b934cd4da97f179f7264f9a1`。
- JUnit 基线：`VAL-009-junit.xml`，sha256 `c0e21315d6a38ea83dc5fa3700b9730c9848a79b8b96bae022b352da08c03975`（41 testcase / failures=0）。
- p1 实测记录（口径依据，只读）：`docs/probes/jev-p1-record.md`；晋升快照副本 `VAL-016-jev-p1-record.md`，sha256 `549437bd7f61…`（全量 sha 见 VAL-016 流程契约）。
