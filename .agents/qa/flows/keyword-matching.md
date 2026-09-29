# keyword-matching — 关键词匹配语义（回归流程契约）

- 断言：VAL-001、VAL-002、VAL-003（a-final-2-r2 判定均为 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 上一轮背景：`.specs/jev-job-filter/missions/reports/a-final-2.json`（r1 三断言同判 pass，但其证据绑定旧候选 aa7fb66；r2 已在 303c82a 用 byte-identical 脚本全量重跑）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护关键词过滤引擎的判定语义（真实模块公开接缝，不是「函数存在」式检查）：

- VAL-001（17 行）：英文完整词（Java 不命中 JavaScript）、版本号语义（Vue→Vue3 命中、Vue→Vuex 不命中）、技术名称语义（C 不命中 C++/C#/.NET，各自为完整词）、大小写归一、中文边界不粘连英文、用户输入绝不进正则（`a+b` 字面量）。
- VAL-002（9 行）：包含组与排除组并存时排除优先（AC-001 首例「JavaScript 外包」被拒）、任一/全部满足语义、只设排除组、空规则 fail-closed（`isKeywordRuleEmpty({}) === true`）。
- VAL-003（8 行）：否定窗口只作用于排除词、岗位名不做否定判断、后缀屏蔽表已移除、逐处判定、窗口边界（否定词距命中起点 5 字以内才算否定）。

## Driver contract for future runs

- 工作目录：仓库根（`/Users/chenwenjie/Downloads/boss-helper`，判定基线 HEAD `303c82a`）。分支：jev-job-filter 集成分支。
- 工具：`bun` ≥ 1.4.0；依赖与子模块就位（fresh checkout 先 `git submodule update --init --recursive && bun install`，见 `.specs/jev-job-filter/ops.yaml`）。
- 驱动脚本（冻结证据，byte-identical，勿改动）：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/val-001-003-matcher.ts`，sha256 `8c590a2d5553f1158ae55ec9a903bb6181092336a2fd16a079ac1a63ca041ff5`。若 sha256 不符，视为驱动漂移：先对照 spec.md 的 AC/FR 原文核对期望，再重跑。
- 脚本性质：只 import 真实模块 `@/composables/useApplying/keywordMatch` 并向 stdout 写 JSON + summary；不写仓库任何文件（重定向落盘由运行者负责）。
- 目录纪律：`.specs/jev-job-filter/` 是计划目录，worker 只读；新证据落 `.run/qa/`（已 gitignore）。

## Future run steps

```bash
mkdir -p .run/qa/keyword-matching

# 1) 关键词语义驱动：34 行 AC/FR 对照（VAL-001 17 行 + VAL-002 9 行 + VAL-003 8 行）
bun run .specs/jev-job-filter/missions/evidence/a-final-2-r2/val-001-003-matcher.ts \
  | tee .run/qa/keyword-matching/matcher.stdout.txt

# 2) 同语义 bun test 交叉参照（keywordRules + keywordMatch 两文件）
bun test src/composables/useApplying/keywordRules.test.ts src/composables/useApplying/keywordMatch.test.ts \
  | tee .run/qa/keyword-matching/buntest.txt
```

> **驱动脚本可用性（披露）**：本契约引用的驱动脚本 `val-001-003-matcher.ts` 位于 `.specs/jev-job-filter/missions/evidence/`（被 `.specs/.gitignore` 的 `*/missions/` 规则忽略，git 不跟踪）。fresh checkout 下不可执行。替代核实路径：直接运行 `bun test src/composables/useApplying/keywordRules.test.ts src/composables/useApplying/keywordMatch.test.ts`（同一断言集的仓库内测试；驱动脚本与之的差异仅是「逐行对照 spec 期望值」的呈现层，判定逻辑同源）。

## Blocking checks for future runs

任一不满足即停，不得把该流程标为通过：

1. 步骤 1 退出码 = 0（脚本任一行与 AC 期望不符时 exit 1）。
2. 步骤 1 stdout 含精确行 `# summary: 34/34 rows matched AC expectations`。
3. 步骤 1 stdout 含 `# isKeywordRuleEmpty({}) = true`（AC-003 空规则 fail-closed）。
4. 步骤 2 输出 `0 fail`；通过数基线 `120 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致）。后续新增用例使通过数上升不算失败；出现任何 `fail` 即停。
5. 若需要全库口径：`bun run test` 退出码 0，基线 `426 pass / 0 fail / 1209 expect() / 22 files`（同上观测；计数回退需排查，不得只看退出码）。

## Evidence expected

落盘 `.run/qa/keyword-matching/`：

- `matcher.stdout.txt` — 晋升基线副本：证据目录 `VAL-001-002-003-matcher.stdout.txt`，sha256 `c643637119524fc86bcfda111fc1a4c2ae72ca338d3799b85f8ecece6d9585b1`。
- `buntest.txt` — 基线副本：`VAL-004-006-keywordRules-buntest.txt`，sha256 `e5d6c1f1bffdab3b0cd4c65273ee3640664f80fa00f206d7b0626f7f95079a94`。
- 全套件基线：`VAL-buntest-full.stdout.txt`，sha256 `1aebb0ed1666eccac706d9f6f5b13f4d0146227671b2eb50ea1839c609d8aec8`。
