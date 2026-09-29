## Issue: t0 — 旧关键词逻辑抽离（行为不变）

Description: 把岗位名与职位描述现有匹配逻辑移入有测试的独立模块，处理器薄委托，行为完全不变
Type: AFK
Milestone: m1-keyword
Touches: src/composables/useApplying/keywordMatch.ts, src/composables/useApplying/keywordMatch.test.ts, src/composables/useApplying/handles.ts
Blocked by: None
User stories covered: G1
Estimate: 0.5 人天

### What to build

预重构：为现有岗位名、职位描述匹配（含否定词与后缀规则）写刻画测试，抽出为纯函数模块，处理器改为调用它。旧逻辑保留在模块中作为 t3 迁移对照的参照实现。

### Acceptance criteria

- [ ] 现有测试全部原样通过
- [ ] 新模块刻画测试覆盖现有包含/排除、否定词与后缀规则
- [ ] 新模块行覆盖率 ≥85%

### Validation

- Verification: bun test ./src (exit zero)
- Evidence expected: 对照抽离前后同一批岗位文本的结果

### Notes

- 预重构不认领断言；handles.ts 在零覆盖遗留清单，只做薄委托改动。
