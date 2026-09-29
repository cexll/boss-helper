## Issue: t6 — 待复核处置结果

Description: 新增待复核处置：当次不投递、不记排除、不缓存，统计单独计数，页面内列表展示
Type: AFK
Milestone: m1-keyword
Touches: src/composables/useApplying/type.ts, src/composables/useApplying/index.ts, src/composables/useApplying/reviewNeeded.ts, src/composables/useApplying/reviewNeeded.test.ts, src/composables/useStatistics.ts, src/types/formData.ts, src/components/Tabs/Statistics.vue
Blocked by: None
User stories covered: G2
Estimate: 1 人天

### What to build

在流水线结果中区分待复核与跳过；投递统计新增待复核计数（旧统计数据可加载）；当前页面显示待复核列表，刷新后清空。

### Acceptance criteria

- [ ] 待复核岗位不投递、不写入任何排除缓存
- [ ] 统计待复核计数加一且旧统计可加载
- [ ] 页面列表显示待复核岗位与原因

### Validation

Fulfills: VAL-007

- Verification: bun test ./src (exit zero)
- Evidence expected: 用例输出 + 列表截图

### Notes

- 与 done / skip / abort 分开建模；关键路径逐行审查。
