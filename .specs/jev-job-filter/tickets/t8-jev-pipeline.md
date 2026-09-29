## Issue: t8 — Jev 接入流水线

Description: 本地筛选先行，Jev 先判标题、必要时详情后复判，排在 AI 筛选之前
Type: AFK
Milestone: m2-jev
Touches: src/entrypoints/boss/delivery.ts, src/composables/useApplying/handles.ts, src/composables/useApplying/jevDirection.ts, src/composables/useApplying/jevDirection.test.ts
Blocked by: t3, t5, t7
User stories covered: G2, G3
Estimate: 1 人天

### What to build

标题阶段：硬条件先跑，未排除的岗位由 Jev 判标题；不相关直接跳过且不取详情；不确定则取详情，职位描述关键词通过后复判；复判不确定进入待复核；Jev 在 AI 筛选之前，不匹配不进入 AI 筛选。

### Acceptance criteria

- [ ] 硬条件排除的岗位无 Jev 请求
- [ ] 标题判不相关时无详情请求、无 AI 筛选调用
- [ ] 复判不确定进入待复核

### Validation

Fulfills: VAL-010

- Verification: bun test ./src (exit zero)
- Evidence expected: 请求次数断言输出

### Notes

- 投递流水线属关键路径；不改间隔、延迟、上限。
