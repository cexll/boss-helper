# about-page — 关于页无赞赏区块（回归流程契约；画面面需 HITL）

- 断言：VAL-014（a-final-2-r2 判定 **pass**，可回归；画面取证部分需主控 HITL 会话）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 t12 的验收行为：扩展「关于」页**不含任何赞赏/打赏（reward）区块**；页面只展示免费开源声明、作者/鸣谢/贡献者、开源地址与反馈问卷。

判定锚点（2026-09-29 于 303c82a 截图实测）：

- 标签栏：统计/筛选/配置/AI/日志/关于/帮助，且「关于」选中。
- 页面内容：`扩展完全免费且开源`、`要是付费购买请申请退款并举报，谢谢~`、`作者:Ocyss_04`、`鸣谢:yangfeng20`、`感谢贡献:engvuchen`、`Github地址`、`greasyfork地址`、`飞书反馈问卷(匿名)`。
- 无任何「赞赏」字样、无 reward 图/区块。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0（代码面）；画面面需主控 HITL 浏览器会话（worker 不驱动浏览器）。
- 代码面：直接对渲染源码与产物做字符串核对；无网络、无浏览器。
- 产物面（可选）：`boss.js` 检查需要先 `bun run build:smoke`（会重写 `components.d.ts`，必须随后执行 `bunx oxfmt components.d.ts` 恢复，见 build-manifest.md 流程契约）。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/about-page

# 1) 渲染源码：赞赏/reward 不得出现（grep 退出码 1 = 无匹配，即为期望）
grep -rn "赞赏" src/components/Tabs/About.vue src/App.vue
grep -rni "reward" src/components/Tabs/About.vue src/App.vue

# 2) （可选，需先跑 build:smoke 并按规程恢复 components.d.ts）产物级核对
grep -c "赞赏" .output/chrome-mv3/boss.js
grep -ci "reward" .output/chrome-mv3/boss.js
```

画面面（主控 HITL 复核，判定要素）：

1. 打开关于标签页并选中，截图落 `.run/qa/about-page/14-about.png`。
2. OCR/目检：标签栏含「关于」且选中；Scope 列出的页面内容逐项在画；**无任何赞赏/打赏区块**。
3. 采集 console：`consoleErrors: none`。

## Blocking checks for future runs

代码面任一不满足即停：

1. 步骤 1 两条 grep 均无匹配（退出码 1）。若源码出现「赞赏」/`reward`，即为本断言失效。
2. 步骤 2（若执行）：两处计数均为 `0`。

画面面任一要素缺失即停：标签栏「关于」选中、免费开源声明/作者/鸣谢/贡献者/两地址/问卷在画、无赞赏区块、`consoleErrors: none`。

## Evidence expected

代码面落盘 `.run/qa/about-page/`：grep 输出。

画面面（晋升基线副本，证据目录）：

- `VAL-014-about-303c82a.png`，sha256 `26c51caf4058232a458fb5b768f8967ce39b4f7c6621fcf2e4b947ce11d3e968`
- `VAL-014-about-ocr-303c82a.txt`，sha256 `19993b04c5ed0463ca54121c3604f28454863936a9ee4173d8cc4099b3a0acff`
- `VAL-004-006-008-014-console-303c82a.txt`，sha256 `f3ee19907661fc3495442a6d5b994f5f48b5a23db60b3110876eeaa0d7c2b250`（`consoleErrors: none`）
- `VAL-UI-manifest-303c82a.sha256`，sha256 `39ded1e1a6ca5d25eb8d2891edc4e295e86c35300c11421d2471fe4b357d08c7`
- 佐证（修复提交范围）：`git show --stat 303c82a` 仅触及 `src/composables/useApplying/backgroundState.{ts,test.ts}`——About 渲染路径未变；r2 重建产物 `boss.js` 中「赞赏」0 处、「reward」0 处。
