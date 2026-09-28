# keyword-settings-ui — 关键词设置页规则态与候选词（流程契约；**状态：blocked，未证实**）

- 断言：VAL-004、VAL-006（a-final-2-r2 判定均为 **blocked**，**不得**作为已通过流程回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`
- **本文件状态：blocked（部分/不可用）**。按工单要求，未证实断言不得写成已通过流程；此处只登记真实状态、解除条件与本候选上**已成立的那部分**证据。

## Scope

目标行为（尚未在本候选上完整证实）：

- **VAL-004**：配置页两种规则形态——空规则（岗位名包含词为空）与包含/排除同词冲突（岗位名包含词「外包」+ 工作内容排除词「外包」）——均须「启用开关禁用」且提示入画（「空规则不能启用」/「包含与排除含同一词：外包」）。
- **VAL-006**：候选词下拉展开，且清单仅含用户用过的词（本例「外包」）。

**真实状态（关键）**：

| 断言    | r2 判定 | 已成立的部分                                                                                                                                                                                                             | 缺失的决定性证据                                                                                      |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| VAL-004 | blocked | `04-empty-rule`/`04-inspect3` 可见「空规则不能启用」提示（空规则半边有本候选画面证据）；重建产物 `boss.js` 中两条提示串各 1 处；同候选 keywordRules+keywordMatch `120 pass`、migrate 门控用例通过；`consoleErrors: none` | 冲突形态的「包含与排除含同一词：外包」提示与启用开关禁用态**被视口裁切未入画**（README 自评「部分」） |
| VAL-006 | blocked | 面板已打开、「空规则不能启用」提示可见；同候选 `keywordRules.test` 断言 `keywordCandidates` 仅取 `options ∪ 两组当前词`、`mergeCandidate` 只显式 ADD（`120 pass`）                                                       | 候选词下拉**未展开**，无法确认候选清单内容（README 自评「不可用」）                                   |

解除条件（主控补拍，属另一轮 user-validate-flow）：在面板内滚动后拍冲突提示与禁用开关（VAL-004）；拍候选词下拉展开态（VAL-006）。本候选上「代码面」证据不能替代「画面面」决定性证据。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位。
- **代码面（可跑，作为部分证据，不构成整条断言通过）**：仓库既有 `keywordRules.test.ts` + `keywordMatch.test.ts`。
- **画面面（仅主控 HITL，worker 不驱动浏览器）**：调试实例 Chrome，仅 Page/DOM/Log/Input 域，**绝不启用 Runtime 域**；在 zhipin 职位页对已加载扩展面板做 DOM 穿透定位 + Input 精确点击；不投递、不点写操作、不读凭证。采集面板内滚动后的冲突提示与禁用开关，以及候选词下拉展开态。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/` 或主控 UI 证据目录。

## Future run steps

```bash
mkdir -p .run/qa/keyword-settings-ui

# 1) 代码面：规则引擎与候选词逻辑（部分证据）
bun test src/composables/useApplying/keywordRules.test.ts src/composables/useApplying/keywordMatch.test.ts \
  | tee .run/qa/keyword-settings-ui/buntest.txt

# 2) 重建产物内两条提示串（渲染代码入包，只证实现存在，不证渲染画面）
grep -c "空规则不能启用" .output/chrome-mv3/boss.js
grep -c "包含与排除含同一词" .output/chrome-mv3/boss.js
```

画面面（主控 HITL，缺一不可）：

1. 岗位名包含词置空（另一种：仅剩单标签）→ 拍「空规则不能启用」提示 + 启用开关禁用态（面板内滚动后）。
2. 构造冲突形态：岗位名包含词「外包」+ 工作内容排除词「外包」→ 拍「包含与排除含同一词：外包」提示 + 启用开关禁用态。
3. 聚焦候选词输入并展开下拉 → 拍展开态，确认候选清单仅含用过的词「外包」。
4. 采集 console：`consoleErrors: none`。

## Blocking checks for future runs

- **本流程当前不可判 pass**；在画面面证据补齐并经复核前，任何运行结论只能是 **blocked**。
- 代码面可运行的检查：`0 fail`，通过数基线 `120 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致）；任何 `fail` 即停。
- 解除 blocked 的判据（全部满足才算通过）：
  1. VAL-004：空规则与冲突两种形态的「提示入画 + 启用开关禁用态」均有本候选截图；OCR 读回对应串。
  2. VAL-006：候选词下拉展开态截图，OCR 读回清单仅含用过的词。
  3. 两次采集 `consoleErrors: none`。
- 若步骤 2 的 grep 计数为 0（提示串从产物消失），即使关键词测试全过也须停下核对，不得放行。

## Evidence expected

已存在（本候选 303c82a 的部分证据，诚实标注「部分/不可用」）：

- `VAL-004-empty-rule-303c82a.png`，sha256 `50d412ba8d035da535cc331c98d1bb4fa36465108167d2f42fd8012c3982be03`
- `VAL-004-inspect3-303c82a.png`，sha256 `c497364b7302d08c0d52a77d413f045213f6862f6daf7f3f993216bd647aea03`
- `VAL-004-conflict-303c82a.png`，sha256 `32044edd9e6c154bb724cf44b1424c5875e6af0e969b44dc8783c5d4c10ed866`（**冲突提示与禁用态被裁切，未入画**）
- `VAL-006-candidates-303c82a.png`，sha256 `140c47ebcd6bc7a6462d1e3dac3ef3d482ded94a8eb01162408dc7de809b90af`（**下拉未展开**）
- OCR 文本：`VAL-004-conflict-ocr-303c82a.txt`（`e1eae88bfd4a…`）、`VAL-004-empty-rule-ocr-303c82a.txt`（`4b4cf179a60f…`）、`VAL-006-candidates-ocr-303c82a.txt`（`2cf4f1219e0e…`）
- console：`VAL-004-006-008-014-console-303c82a.txt`，sha256 `f3ee19907661fc3495442a6d5b994f5f48b5a23db60b3110876eeaa0d7c2b250`（`consoleErrors: none`）
- 分级说明（只读）：`VAL-UI-grading-README-303c82a.md`（04-conflict/04-empty-rule=「部分」、06-candidates=「不可用」）

尚缺（解除条件）：面板内滚动后的冲突提示 + 禁用开关截图；候选词下拉展开态截图。

## Current status (blocked)

- **VAL-004：blocked。** 冲突形态的「包含与排除含同一词：外包」提示与启用开关禁用态被视口裁切，本候选（303c82a）上缺少决定性画面证据；空规则半边已有本候选画面证据但不覆盖整条断言。
- **VAL-006：blocked。** 本候选上没有「候选词下拉展开且仅含用过的词」的画面证据（实拍下拉未展开）。
- **解除路径（另一轮 user-validate-flow，主控 HITL）**：
  1. 配置页构造冲突形态（岗位名包含词「外包」+ 工作内容排除词「外包」）→ **面板内滚动**至提示与开关 → 补拍「包含与排除含同一词：外包」提示 + 启用开关禁用态（解除 VAL-004）。
  2. 聚焦候选词输入并展开下拉 → 补拍展开态，OCR 读回候选清单仅含用过的词「外包」（解除 VAL-006）。
  3. 两次采集 console：`consoleErrors: none`。
- 两条断言在上述画面证据补齐并复核前，任何流程结论必须写 **blocked**；代码面/产物 grep 证据只能作为佐证，不能替代画面。
