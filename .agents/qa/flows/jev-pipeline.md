# jev-pipeline — 硬条件优先与零请求语义（回归流程契约）

- 断言：VAL-010（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 Jev 方向判断在投递流水线中的**零浪费**语义：被硬条件（关键词排除等）直接排除的岗位，Jev 请求数为 0；标题阶段判不相关时不发起详情请求，也不调用 AI。即：贵请求只发生在仍有资格继续的岗位上，且次数可以被直接计数断言。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位（`git submodule update --init --recursive && bun install`）。
- 无一次性脚本：直接跑仓库既有 `src/composables/useApplying/jevDirection.test.ts` 与 `src/composables/useApplying/jevDirection.pipeline.test.ts`。Jev 调用经注入桩计数，不触网（真实调用属 p1 HITL）。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/jev-pipeline

# 1) 方向判断 + 流水线请求计数（junit）
bun test src/composables/useApplying/jevDirection.test.ts src/composables/useApplying/jevDirection.pipeline.test.ts --reporter=junit --reporter-outfile=.run/qa/jev-pipeline/junit.xml
```

## Blocking checks for future runs

1. 步骤 1 退出码 0 且输出 `0 fail`；通过数基线 `35 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致）；JUnit 根节点 `tests=35 assertions=128 failures=0`。新增用例使计数上升不算失败；任何 `fail` 即停。
2. JUnit 中必须存在并全过的语义用例：硬条件排除时零 Jev 请求、标题判不相关时零详情请求且不调 AI。
3. 上述零请求用例若被改名/删除，视为本契约失效，须停下核对，不得以「通过数未降」放行。

## Evidence expected

落盘 `.run/qa/jev-pipeline/`：

- `buntest.txt` — 晋升基线副本：`VAL-010-buntest.txt`，sha256 `5e590a5f99d55e83c4b70253da376f51a869777fa3ed2fd9d435732f04ddc0bc`。
- JUnit 基线：`VAL-010-junit.xml`，sha256 `8e8a659b2c1d0832b5f3eb2f54cef026a91c2550012dfe1f0623c295314c1dd3`（35 testcase / failures=0）。
