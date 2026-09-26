## Issue: a-promote — 将已证实断言晋升为流程契约

Description: 把 a-final 证实通过的断言写成本仓库可复用的流程契约，供后续回归运行
Type: AFK
Milestone: acceptance
Touches: .agents/qa/
Blocked by: a-final
User stories covered: 全部

### What to build

读取 a-final 的逐条验证报告与证据，将已证实的断言整理为 `.agents/qa/flows/` 下的流程契约文件，每个文件带 `## Scope`、`## Driver contract for future runs`、`## Future run steps`、`## Blocking checks for future runs`、`## Evidence expected` 五节。未证实或 blocked 的断言不得写入为已通过流程，须在文件内如实标注状态。

### Acceptance criteria

- [ ] `.agents/qa/flows/` 下每个流程契约含五节且可被后续运行直接执行
- [ ] 仅 a-final 判为 pass 的断言被写成可回归流程，其余标注真实状态

### Validation

- Verification: bun run test (exit zero)
- Evidence expected: 流程契约文件清单 + 对应断言 id 映射

### Notes

- 本任务不修产品代码；发现缺陷转交修复任务（amend 追加），不在本任务内修。
- 验收阶段无 worktree 之外的写入：只写 `.agents/qa/`。
