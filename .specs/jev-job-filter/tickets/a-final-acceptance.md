## Issue: a-final — 整体验收

Description: 在最终构建上逐条验证全部断言
Type: ACCEPTANCE
Milestone: acceptance
Touches: None
Blocked by: v-m1, v-m2, t11
User stories covered: 全部
Estimate: 0.5 人天

### What to build

不做实现。在最终集成构建上验证全部断言并运行构建检查。

### Acceptance criteria

- [ ] 每条断言有结论与证据
- [ ] npm run build:smoke 退出码 0

### Validation

Proves: VAL-001, VAL-002, VAL-003, VAL-004, VAL-005, VAL-006, VAL-007, VAL-008, VAL-009, VAL-010, VAL-011, VAL-012, VAL-013, VAL-014, VAL-015

- Evidence expected: 逐条报告 + 截图 + 命令输出

### Notes

- 仓库规定界面为人工审查；不做真实投递除非用户逐次批准。
