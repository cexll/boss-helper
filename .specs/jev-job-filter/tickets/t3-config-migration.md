## Issue: t3 — 新配置与旧配置迁移

Description: 新增关键词组配置字段，旧配置原样迁移，筛选接入新引擎，缺字段进入待复核
Type: AFK
Milestone: m1-keyword
Touches: src/types/formData.ts, src/composables/conf/info.ts, src/composables/conf/index.ts, src/composables/conf/migrate.test.ts, src/composables/useApplying/handles.ts
Blocked by: t2, t6
User stories covered: G1
Estimate: 1 人天

### What to build

岗位名与职位描述改为包含组、排除组与任一/全部选项；旧“包含”词进包含组并设任一、旧“排除”词进排除组、启用状态不变；处理器改用新引擎；岗位名或职位描述缺失时进入待复核。

### Acceptance criteria

- [ ] 旧配置加载后字段正确映射
- [ ] 同一批不涉及语义变化的岗位，新旧结果一致（以 t0 参照实现对照）
- [ ] 缺岗位名时进入待复核而非跳过

### Validation

Fulfills: VAL-005

- Verification: bun test ./src (exit zero)
- Evidence expected: 对照用例输出

### Notes

- 持久化配置属关键路径，迁移逐行审查；不得删除用户数据。
