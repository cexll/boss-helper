# jev-cache — 结果缓存与失效语义（回归流程契约）

- 断言：VAL-011（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 Jev 结果缓存（t9 / FR-015 / AC-009 / FR-013）：

- 同岗位同判定依据第二次扫到 → 命中缓存，零请求；`confirmed-negative` 同样命中并原样回放。
- 判定依据变化即失效：目标方向变化、模型版本变化（响应具体版本参与判定依据，整库失效；A→B→A 旧条目不复活）。
- 不定终判不写缓存：`noul` 不确定、报错/超时、「继续」等非终判，下一轮仍重新请求（FR-013）。
- 会话级：`clear()` 清空全部条目并重置模型指针（页面刷新语义）。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位（`git submodule update --init --recursive && bun install`）。
- 无一次性脚本：直接跑仓库既有 `src/composables/useApplying/jevCache.test.ts`。Jev 调用经注入桩计数，不触网。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/jev-cache

# 1) 缓存键与失效语义（junit）
bun test src/composables/useApplying/jevCache.test.ts --reporter=junit --reporter-outfile=.run/qa/jev-cache/junit.xml
```

## Blocking checks for future runs

1. 步骤 1 退出码 0 且输出 `0 fail`；通过数基线 `18 pass`（1 文件，2026-09-29 于 303c82a 观测并复跑一致）；JUnit 根节点 `tests=18 assertions=39 failures=0`。新增用例使计数上升不算失败；任何 `fail` 即停。
2. JUnit 中必须存在并全过的用例（逐字取自基线 `VAL-011-junit.xml` 的 testcase `name`，2026-09-29 于 303c82a）：「(a) 同岗位同判定依据第二次扫到：命中缓存，不再请求 Jev」「(b) 修改目标方向后重新请求 Jev（判定依据变化即失效）」「(c) 不确定结果不写缓存：同一岗位再次扫到重新请求 Jev（FR-013）」「(c2) 报错 / 超时同样不写缓存：第二次重新请求（FR-013）」「模型标识参与判定依据：会话内观测到模型版本变化 → 旧缓存整库失效（p1 §3.2）」「clear 清空全部条目并重置模型指针（页面刷新语义）」。
3. 上述用例若被改名/删除，视为本契约失效，须停下核对，不得以「通过数未降」放行。

## Evidence expected

落盘 `.run/qa/jev-cache/`：

- `buntest.txt` — 晋升基线副本（默认 reporter 文本，非 junit）：`VAL-011-buntest.txt`，sha256 `091480317d35d1f56b8b84902f9f5afc0d3985c8d860784662ea9078b4065296`。
- JUnit 基线：`VAL-011-junit.xml`，sha256 `2312a65f3a329d8d1a0fe15e871e210c0c68c146f55c9adcc2202cf9a98f7cb3`（18 testcase / failures=0）。
