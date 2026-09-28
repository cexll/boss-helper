# build-manifest — 构建冒烟与产物清单（回归流程契约；含 components.d.ts 再生恢复规程）

- 断言：VAL-015（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 `bun run build:smoke` 的清单契约：chrome-mv3 构建成功、manifest 与入口文件齐备（基线 PASS 行：`build-smoke: PASS — chrome-mv3 manifests and entry files conform (9 outputs in .output)`），并处理 wxt prepare 对 `components.d.ts` 的再生成（ops.yaml 规程），使工作树回到 clean。

**重要边界（诚实标注）**：`manifest.json` 的 sha256 在 aa7fb66 与 303c82a 相同——它只证明**清单契约**，不单独证明 bundle 新鲜度；bundle 新鲜度由 303c82a 之后重建 + 在产物中 grep 到修复后的接线/文案佐证（如「空规则不能启用」「包含与排除含同一词」各 1 处，见 keyword-settings-ui / jev-gating-ui 流程契约）。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖与子模块就位（fresh checkout 先 `git submodule update --init --recursive && bun install`；`build:smoke` 需要 wxt prepare，postinstall 会跑）。
- 前置：工作树 clean（本流程会触 `components.d.ts`，脏树上跑会混淆漂移来源）。
- 恢复规程（ops.yaml 原文）：`components.d.ts` 由 wxt prepare 生成；若构建再生成它，**运行 `bunx oxfmt components.d.ts` 恢复**（格式化结果与已提交字节一致），**绝不手工编辑**。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/build-manifest
git status --porcelain   # 前置确认：应为空

# 1) 构建冒烟
bun run build:smoke | tee .run/qa/build-manifest/build-smoke.stdout.txt

# 2) components.d.ts 再生恢复（若步骤 1 弄脏了它）
git status --porcelain components.d.ts || true
bunx oxfmt components.d.ts
git status --porcelain   # 期望：干净

# 3) 清单指纹（对照记录；manifest 字段未变时跨候选一致）
shasum -a 256 .output/chrome-mv3/manifest.json
```

## Blocking checks for future runs

任一不满足即停：

1. 步骤 1 退出码 0，stdout 含 PASS 行 `build-smoke: PASS — chrome-mv3 manifests and entry files conform (9 outputs in .output)`。
2. 步骤 2 后 `git status --porcelain` 为空（含 `components.d.ts`）。若 `oxfmt` 后仍有 diff，说明再生成内容与已提交字节真实分叉——停下核对，不得手工编辑、不得带脏树继续。
3. 步骤 3 记录 manifest sha256 与上一轮对照：基线 `ccd0a229…`（r2 观测，全量见 r2 报告/证据 `VAL-015-build-smoke.stdout.txt`）。sha 变化本身不阻断（字段可合法变化），但**必须**在结论中说明变化来自哪个 manifest 字段；无解释的 sha 漂移即停。
4. 通过判定的结论若声称「bundle 新鲜」，必须附产物内 grep 佐证（如两条提示串各 1 处）；只有 PASS 行不得得出该结论。

## Evidence expected

落盘 `.run/qa/build-manifest/`：

- `build-smoke.stdout.txt` — 晋升基线副本：`VAL-015-build-smoke.stdout.txt`，sha256 `098683012a9ddd66df07a2605ec5c648584a317bda8a003babaa853b4fb1a6e4`（含 PASS 行与 manifest sha `ccd0a229…`）。
- 再生 diff 记录（基线存在，证明 oxfmt 规程精确复现已提交字节）：`VAL-015-components.d.ts.generated-diff.txt`，sha256 `aeefd39d5a0aafb0d0da5ca48ac6b478d573cb13abc12456e45b82cc5ed3441f`。

## Assertion coverage map（本目录全部 13 个流程契约 / 17 条断言）

每条断言恰好归属一个文件。判定来源统一为 `.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（candidate `303c82a`）。

| 断言    | r2 判定     | 流程契约文件                                                     |
| ------- | ----------- | ---------------------------------------------------------------- |
| VAL-001 | pass        | `keyword-matching.md`                                            |
| VAL-002 | pass        | `keyword-matching.md`                                            |
| VAL-003 | pass        | `keyword-matching.md`                                            |
| VAL-004 | **blocked** | `keyword-settings-ui.md`（标注真实状态与解除路径，非可回归流程） |
| VAL-005 | pass        | `config-migration.md`                                            |
| VAL-006 | **blocked** | `keyword-settings-ui.md`（同上）                                 |
| VAL-007 | pass        | `pipeline-disposition.md`                                        |
| VAL-008 | pass        | `jev-gating-ui.md`                                               |
| VAL-009 | pass        | `jev-client.md`                                                  |
| VAL-010 | pass        | `jev-pipeline.md`                                                |
| VAL-011 | pass        | `jev-cache.md`                                                   |
| VAL-012 | pass        | `review-needed.md`                                               |
| VAL-013 | pass        | `background-throttle.md`                                         |
| VAL-014 | pass        | `about-page.md`                                                  |
| VAL-015 | pass        | `build-manifest.md`（本文件）                                    |
| VAL-016 | pass        | `jev-p1-record.md`                                               |
| VAL-017 | pass        | `background-throttle.md`                                         |

合计：15 条 pass（写成可回归流程）、2 条 blocked（VAL-004 / VAL-006，如实标注，未写成已通过流程）。
