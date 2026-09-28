# jev-gating-ui — AI 设置页 Jev 启用门控（回归流程契约；画面面需 HITL）

- 断言：VAL-008（a-final-2-r2 判定 **pass**，可回归；画面取证部分需主控 HITL 会话）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 背景：r1（`missions/reports/a-final-2.json`）曾因截图判「不可用」维持 blocked；r2 经裁切放大 OCR + 像素取证独立核验后改判 pass——四个门控要素全部在画，且像素证据排除了「全局锁」误读。
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 AC-006 / FR-010 的 Jev 启用门控：缺密钥或缺目标岗位方向时，Jev 开关禁用、提示「缺少：密钥、目标岗位方向，填写后才能启用」；密钥为 password 型并注明只写本机存储（不上传、不进日志）；方向输入注明「修改后已缓存的结果会失效并重新判断」；「数据接收与授权（FR-010 / FR-011）」披露条可见。

分两个面：

- **代码面（本流程可回归部分）**：门控纯函数与渲染条件、SSR 测试。
- **画面面（需主控 HITL，属 user-validate-flow 范围）**：截图 + OCR + 像素取证。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位。
- 代码面直接跑仓库既有 `src/composables/conf/jevConfig.test.ts`（真实 `AI.vue` SSR）。无网络。
- 实现锚点（只读，勿改动）：
  - `src/types/formData.ts:108-110` — `canEnableJev(input) = input.apiKey.trim() !== '' && input.targetDirection.trim() !== ''`
  - `src/components/Tabs/AI.vue:172` — `<p v-if="!jevCanEnable" ...>，填写后才能启用</p>`
  - `src/components/Tabs/AI.vue:213` — `title="数据接收与授权（FR-010 / FR-011）"`
- 画面面由**主控**在调试实例 Chrome 上执行（仅 Page/DOM/Log/Input 域，绝不启用 Runtime 域；不投递、不点写操作、不读凭证）；worker 不驱动浏览器。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

代码面（worker 可直接跑）：

```bash
mkdir -p .run/qa/jev-gating-ui

# 1) 门控 SSR 测试（真实 AI.vue）
bun test src/composables/conf/jevConfig.test.ts | tee .run/qa/jev-gating-ui/buntest.txt

# 2) 门控语义与渲染条件锚点核对（期望各 1 处、行号如锚点）
grep -n "apiKey.trim() !== '' && input.targetDirection.trim() !== ''" src/types/formData.ts
grep -n "填写后才能启用" src/components/Tabs/AI.vue
grep -n "数据接收与授权（FR-010 / FR-011）" src/components/Tabs/AI.vue
```

画面面（主控 HITL 补拍/复核，判定要素缺一不可）：

1. 打开 AI 设置页，保持密钥与方向为空（门控态）；截图 `08-ai.png` 落 `.run/qa/jev-gating-ui/`。
2. OCR 读回应含：「缺少: 密钥、目标岗位方向，填写后才能启用」「粘贴你的 Jev API 密钥」「密钥只写入本机浏览器存储…不会上传、不会进入日志」「修改后已缓存的结果会失效并重新判断」「数据接收与授权（FR-010 / FR-011）」。
3. 像素取证：顶排胶囊「Jev 方向判断」为 75% 混合禁用色 `rgb(240,110,132)`，同排「AI打招呼」「AI过滤」为实色 `rgb(235,61,91)`（AI回复恒禁用同为混合色）⇒ 证明 Jev 禁用来自 AC-006 门控而非全局锁。
4. console 采集：`consoleErrors: none`。

## Blocking checks for future runs

代码面任一不满足即停：

1. 步骤 1 退出码 0 且 `0 fail`；通过数基线 `10 pass`（1 文件，2026-09-29 于 303c82a 观测；该文件同时包含在 conf 7 文件批 `105 pass` 内）。
2. 步骤 2 三条 grep 各恰好命中锚点行（`formData.ts:109`、`AI.vue:172`、`AI.vue:213`）；行号漂移需先核对实现是否被改。

画面面任一要素缺失/与期望不符即停：提示文案、password 型密钥框、方向输入说明、披露条、禁用像素色、`consoleErrors: none`。

## Evidence expected

代码面落盘 `.run/qa/jev-gating-ui/`：`buntest.txt`。

画面面（晋升基线副本，证据目录）：

- `VAL-008-ai-303c82a.png`，sha256 `bd0614d3916a8ac3399909aa41a816efa3ee2012717ca8ae6f6fe04f6ddd097f`
- `VAL-008-ai-crop.png`（裁切放大取证），sha256 `13197e8621a1bb823ca9f4a59ae5aa285e52f2cdcbc91c2371aa5cc8a12edb42`
- `VAL-008-ai-ocr-303c82a.txt`，sha256 `f0a3172f760be364dac7f9c683dd63c39d62dc018aea941da361c2fca2a1bfea`；`VAL-008-ai-crop-ocr.txt`，sha256 `ab248141da0532544d8ff20d5f96e15be9025f532df288d42c8f0a737785f3be`
- `VAL-004-006-008-014-console-303c82a.txt`，sha256 `f3ee19907661fc3495442a6d5b994f5f48b5a23db60b3110876eeaa0d7c2b250`（内容：`consoleErrors: none`）
- `VAL-UI-manifest-303c82a.sha256`，sha256 `39ded1e1a6ca5d25eb8d2891edc4e295e86c35300c11421d2471fe4b357d08c7`
