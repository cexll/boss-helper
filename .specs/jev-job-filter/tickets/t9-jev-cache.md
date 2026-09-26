## Issue: t9 — Jev 结果缓存

Description: 按岗位与判定依据缓存 Jev 明确结果，判定依据变化即失效
Type: AFK
Milestone: m2-jev
Touches: src/composables/useApplying/jevDirection.ts, src/composables/useApplying/jevDirection.test.ts, src/composables/useApplying/jevCache.ts, src/composables/useApplying/jevCache.test.ts
Blocked by: t8
User stories covered: G3
Estimate: 0.5 人天

### What to build

只缓存明确的匹配/不匹配；判定依据为目标岗位方向描述与 Jev 模型标识；任一变化失效；待复核不缓存；缓存期限按 p1 定下的值。

### Acceptance criteria

- [ ] 同岗位同依据第二次不请求 Jev
- [ ] 修改目标方向后重新请求
- [ ] 待复核结果不写缓存

### Validation

Fulfills: VAL-011

- Verification: bun test ./src (exit zero)
- Evidence expected: 用例输出
