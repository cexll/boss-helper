# review-needed — 人工确认放行语义（回归流程契约）

- 断言：VAL-012（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护待复核的人工确认/重试语义：

- 重试重新请求 Jev（待复核不是终态，重试必发新请求）。
- 人工「继续」只放行**当前岗位方向阶段**，且放行仍受硬条件约束（关键词排除等先行判定不被跳过）。
- 同名其他岗位各自判断：确认不跨岗位生效。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位（`git submodule update --init --recursive && bun install`）。
- 无一次性脚本：直接跑仓库既有 `src/composables/useApplying/reviewNeeded.test.ts`。Jev 调用经注入桩计数，不触网。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/review-needed

# 1) 待复核 store 语义（junit）
bun test src/composables/useApplying/reviewNeeded.test.ts --reporter=junit --reporter-outfile=.run/qa/review-needed/junit.xml
```

## Blocking checks for future runs

1. 步骤 1 退出码 0 且输出 `0 fail`；通过数基线 `35 pass`（1 文件，2026-09-29 于 303c82a 观测并复跑一致）；JUnit 根节点 `tests=35 assertions=128 failures=0`。新增用例使计数上升不算失败；任何 `fail` 即停。
2. JUnit 中必须存在并全过的语义：重试重新请求、人工确认只放行当前岗位方向阶段且仍受硬条件约束、同名其他岗位各自判断。
3. 上述语义用例若被改名/删除，视为本契约失效，须停下核对，不得以「通过数未降」放行。

## Evidence expected

落盘 `.run/qa/review-needed/`：

- `junit.xml` — 本流程产出（`--reporter-outfile` 落盘）。参照基线：`VAL-012-junit.xml`，sha256 `5e0334209fa86cc89c3e4ccff849ec43f331167cbde075ab20bbc5ac645dcc69`（35 testcase / failures=0）。历史人读摘要基线（默认 reporter 文本，现版步骤不再落盘）：`VAL-012-buntest.txt`，sha256 `6a60e01886c89a41569a4e4c4e820b48f81e562f822d8a1671b486a41ed1a0b8`。
