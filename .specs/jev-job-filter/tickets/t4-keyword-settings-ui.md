## Issue: t4 — 关键词设置界面

Description: 设置页提供两组关键词输入、任一/全部切换、候选词与启用校验
Type: AFK
Milestone: m1-keyword
Touches: src/components/Tabs/ConfigItem/ConfigItem.vue, src/components/Tabs/ConfigItem/Form/FormSelect.vue, src/composables/useApplying/keywordRules.ts, src/composables/useApplying/keywordRules.test.ts
Blocked by: t3
User stories covered: G1
Estimate: 1.5 人天

### What to build

岗位名与职位描述各有包含组、排除组输入和任一/全部切换；候选词来自用过的关键词，可多选或自由输入，不自动成为条件；空规则与同词冲突时提示且不能启用。校验逻辑放在 .ts 模块。

### Acceptance criteria

- [ ] 空规则与冲突时启用开关不可用并有提示
- [ ] 候选词只来自用过的关键词
- [ ] 选中候选前不影响筛选

### Validation

Fulfills: VAL-004, VAL-006

- Verification: bun test ./src (exit zero)
- Evidence expected: 截图 + 控制台无新增错误

### Notes

- components.d.ts 如需变化须重新生成，不手改。
