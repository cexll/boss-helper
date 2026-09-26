## Issue: t10 — 待复核重试与人工确认

Description: 待复核列表支持重试、跳过、人工确认方向
Type: AFK
Milestone: m2-jev
Touches: src/composables/useApplying/reviewNeeded.ts, src/composables/useApplying/reviewNeeded.test.ts, src/composables/useApplying/jevCache.ts, src/components/Tabs/Statistics.vue
Blocked by: t6, t9
User stories covered: G2
Estimate: 1 人天

### What to build

重试重新请求 Jev；跳过移出列表；人工确认只对当前岗位与当前判定依据有效，记录随 Jev 缓存保存并同样失效；确认后仍须通过硬条件。

### Acceptance criteria

- [ ] 重试产生新的 Jev 请求
- [ ] 人工确认不放行同名其他岗位
- [ ] 确认后命中排除词仍不投递

### Validation

Fulfills: VAL-012

- Verification: bun test ./src (exit zero)
- Evidence expected: 用例输出 + 截图
