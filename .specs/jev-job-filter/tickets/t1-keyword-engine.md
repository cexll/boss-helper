## Issue: t1 — 新关键词匹配引擎

Description: 实现包含组与排除组并存、任一或全部满足、英文完整词与版本号语义的匹配
Type: AFK
Milestone: m1-keyword
Touches: src/composables/useApplying/keywordMatch.ts, src/composables/useApplying/keywordMatch.test.ts
Blocked by: t0
User stories covered: G1
Estimate: 1 人天

### What to build

在匹配模块中新增规则求值：包含组（任一/全部）、排除组（任一命中即拒绝）、可只设排除组；中文包含、英文忽略大小写完整词；后接数字算命中、后接字母不命中；C++、C#、.NET 完整名称。

### Acceptance criteria

- [ ] “JavaScript 外包”被拒、“Java 开发”“Java8 开发”通过
- [ ] C 不命中 C++/C#，React 命中“React开发”
- [ ] 只设排除组时未命中即通过

### Validation

Fulfills: VAL-001, VAL-002

- Verification: bun test ./src/composables/useApplying (exit zero)
- Evidence expected: 用例输出

### Notes

- 先写失败测试再实现。
