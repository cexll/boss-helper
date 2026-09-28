# config-migration — 旧配置迁移与结果一致性（回归流程契约）

- 断言：VAL-005（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护旧存量配置的迁移契约（AC-005 / FR-006）：

- A 迁移原样性：一份 version `'20260718'`、只有 `include/value/options/enable` 旧键的真实存储 blob 走真实 `useConf().confReload()` 加载路径——旧键原样保留（不删用户数据）、`groups` 按 FR-006 推导（include=true→包含组+any；include=false→排除组）、version 落 `'20260926'`、重复加载幂等。
- B 结果一致性：以 t0 旧实现（`decideJobTitleKeyword` / `decideJobContentKeyword` oracle）为参照，与「迁移后字段 → `keywordRuleOf` → `evaluateKeywordRule`」在 27 条语料上对照：22 条一致语料必须 old==new，5 条登记语义变化（AC-005 明文允许的完整词/后缀/否定窗口差异）必须 old!=new。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位（`git submodule update --init --recursive && bun install`）。
- 驱动脚本（冻结证据，byte-identical，勿改动）：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/val-005-migration.ts`，sha256 `69d50efc3a0db5499e713a4263d43861af7d062737e20dd0d12b3503cf642b86`。sha 不符即视为驱动漂移，先核对再跑。
- 脚本性质：自带宿主边界桩（`localStorage`/`useToast`/`@/message` 受控 Map 存储），只向 stdout 写 JSON 与 summary；读写失败会显式暴露，不静默吞。无网络。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/config-migration

# 1) 迁移驱动（真实 confReload 路径 + 27 条语料新旧对照）
bun run .specs/jev-job-filter/missions/evidence/a-final-2-r2/val-005-migration.ts \
  | tee .run/qa/config-migration/migration.stdout.txt

# 2) conf 迁移/门控套件（7 文件：conf/ 全部 + formData 类型契约）
bun test src/composables/conf src/types/formData.test.ts \
  | tee .run/qa/config-migration/conf-buntest.txt
```

> **驱动脚本可用性（披露）**：本契约引用的驱动脚本 `val-005-migration.ts` 位于 `.specs/jev-job-filter/missions/evidence/`（被 `.specs/.gitignore` 的 `*/missions/` 规则忽略，git 不跟踪）。fresh checkout 下不可执行。替代核实路径：直接运行 `bun test src/composables/conf/`（同一断言集的仓库内测试；驱动脚本与之的差异仅是「逐行对照 spec 期望值」的呈现层，判定逻辑同源）。

## Blocking checks for future runs

任一不满足即停：

1. 步骤 1 退出码 = 0。
2. 步骤 1 stdout 含 `# A 迁移原样性: OK`。
3. 步骤 1 stdout 含 `# B 对照: 22 条一致性语料（old==new），5 条登记语义变化（old!=new）； 失败 0`。
4. 步骤 1 JSON 体内 `"idempotent": true`、`"versionAfter": "20260926"`、`legacyKeysPreserved` 各字段全 true。
5. 步骤 2 输出 `0 fail`；通过数基线 `105 pass`（7 文件，2026-09-29 于 303c82a 观测并复跑一致）。新增用例使计数上升不算失败；任何 `fail` 即停。

## Evidence expected

落盘 `.run/qa/config-migration/`：

- `migration.stdout.txt` — 晋升基线副本：`VAL-005-migration.stdout.txt`，sha256 `2cbfedf58ec5cf2a3fd2c17fed021c827feb7d06cff488b5a6c83943324aab2e`。
- `conf-buntest.txt` — 基线副本：`VAL-005-conf-buntest.txt`，sha256 `7acebf60847639f4a8f474d69b8c630e8b3c8ed8a29f34a885f7fd90868201fa`（105 pass / 0 fail / 354 expect()）。
- 驱动脚本本体：`val-005-migration.ts`（sha256 见上）。
