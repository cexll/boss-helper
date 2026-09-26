## Issue: t13 — 构建烟测门禁

Description: 以构建产物清单与入口断言认领 VAL-015，纳入常规验证命令
Type: AFK
Milestone: acceptance
Touches: package.json
Blocked by: t6
User stories covered: —

### What to build

确认 `build:smoke`（`wxt build -b chrome` + `scripts/build-smoke.mjs` 对 `.output/chrome-mv3` 的 manifest 与入口断言）作为 VAL-015 的实现载体可重复执行；若现有脚本已满足则仅补齐认领所需的最小接线，不改变行为。检查脚本缺失或断言口径不符时修正脚本本身。

### Acceptance criteria

- [ ] `bun run build:smoke` 退出码 0 且报告列出 manifest 与入口断言
- [ ] VAL-015 由本任务认领，构建产物清单与入口断言可重复验证

### Validation

Fulfills: VAL-015

- Verification: bun run build:smoke (exit zero)
- Evidence expected: build:smoke 报告输出

### Notes

- 从 a-final 拆出的实现任务：a-final 是验收（只验证不实现），VAL-015 需要实现侧认领人。
- 不改 wxt.config.ts 的 store 身份相关字段。
