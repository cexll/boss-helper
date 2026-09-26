## Issue: t2 — 职位描述否定词规则

Description: 否定词只作用于职位描述排除词，取消后缀阻止规则
Type: AFK
Milestone: m1-keyword
Touches: src/composables/useApplying/keywordMatch.ts, src/composables/useApplying/keywordMatch.test.ts
Blocked by: t1
User stories covered: G1
Estimate: 0.5 人天

### What to build

职位描述排除词前五个字内有“不”或“无”不算命中；包含词与岗位名称不做否定判断；关键词后接“系统、软件、工具、服务”不再阻止命中。

### Acceptance criteria

- [ ] “无外包”不被排除词“外包”拒绝
- [ ] “不加班，Java开发”命中包含词 Java
- [ ] “Java系统开发”命中包含词 Java

### Validation

Fulfills: VAL-003

- Verification: bun test ./src/composables/useApplying (exit zero)
- Evidence expected: 用例输出
