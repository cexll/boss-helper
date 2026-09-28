# pipeline-disposition — 待复核处置（不投递/不排除/不缓存/单独计数）（回归流程契约）

- 断言：VAL-007（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护投递流水线对「待复核（reviewNeeded）」的处置（AC-008 前半）：Jev 超时 → 待复核，且**零投递、不写排除、不写缓存、统计单独计数**；再次扫到同一岗位重新判断（证明不缓存）；对照组 Jev 明确 pass 照常投递（证明投递探针有效）；岗位名为空 / 职位描述为空分别走 missing_field 路径入待复核。

驱动方式为真实流水线 `src/composables/useApplying/index.ts` 的 `useDeliveryWorkflow`，挂真实 `TaskRegistry.jevDirection/jobTitle/jobContent/customGreeting` 处理器；Jev 结果按 `jevDirection.test.ts` 先例脚本注入（真实 Jev 调用属 p1 HITL，worker 不驱动）。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位（`git submodule update --init --recursive && bun install`）。
- 驱动脚本（冻结证据，byte-identical，勿改动）：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/val-007-pipeline.ts`，sha256 `57b617004990bdb7c7e686a3b573a8a81fbb8af150a4fca13d6d9d79a14c0317`。sha 不符即驱动漂移，先核对再跑。
- 脚本性质：自带宿主边界桩（DOM/扩展 API/wxt 自动导入符号如 `logger`/`computed`/`jsonClone`/`delay`/`requestAnimationFrame`）；`delay` 走真实实现、配置延迟调到极小以便流水线跑起来；向 stdout 写 JSON + summary。无网络。
- 哨兵设计：若流水线真去写排除/缓存存储，未初始化的 `counter` 会当场抛出——该场景即为通道哨兵，不得删。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/review-disposition

# 1) 流水线驱动：6 场景（超时/重扫重判/对照投递/缺岗位名/空描述/写通道哨兵）
bun run .specs/jev-job-filter/missions/evidence/a-final-2-r2/val-007-pipeline.ts \
  | tee .run/qa/review-disposition/pipeline.stdout.txt

# 2) 流水线测试套件（index.pipeline + handles.pipeline，junit）
bun test src/composables/useApplying/index.pipeline.test.ts src/composables/useApplying/handles.pipeline.test.ts --reporter=junit \
  | tee .run/qa/review-disposition/buntest.txt
```

## Blocking checks for future runs

任一不满足即停：

1. 步骤 1 退出码 = 0。
2. 步骤 1 stdout 含精确行 `# summary: 6/6 scenarios OK`；等价地 JSON 体 `allOk: true`。
3. 步骤 1 六个场景 id 齐全：`1-jev-timeout`、`1b-rescan-rejudge`、`2-control-pass`、`3-missing-field`、`4-empty-desc`、`5-exclusion-write-canary`。
4. 步骤 2 输出 `0 fail`；通过数基线 `27 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致）；JUnit 根节点 `tests=27 failures=0`。新增用例使计数上升不算失败；任何 `fail` 即停。

## Evidence expected

落盘 `.run/qa/review-disposition/`：

- `pipeline.stdout.txt` — 晋升基线副本：`VAL-007-pipeline.stdout.txt`，sha256 `7d6045cd18e6c16972f1e246746e65483e8175297d047c7804f3ceb292f45ae4`。
- `buntest.txt` — 基线副本：`VAL-007-buntest.txt`，sha256 `aef21145a82a3aed868b616c2d991491b569483fb538e4fbe72990a4dc8eaa61`。
- JUnit 基线：`VAL-007-junit.xml`，sha256 `c8bc7dbcd13f34685d823c0c099c91210f8e6bed4cfc92e56c2098bab15c54fe`（27 testcase / failures=0）。
- 驱动脚本本体：`val-007-pipeline.ts`（sha256 见上）。
