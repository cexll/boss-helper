## Issue: t11 — 后台运行提示

Description: 切换标签页后继续运行，受浏览器限制时如实提示，间隔与并发不变
Type: AFK
Milestone: m3-runtime
Touches: src/entrypoints/boss/runtime.ts, src/composables/useApplying/backgroundState.ts, src/composables/useApplying/backgroundState.test.ts
Blocked by: p2, t8
User stories covered: G3
Estimate: 0.5 人天

### What to build

按 p2 结论检测后台被节流或暂停，界面如实提示；不缩短间隔、不提高并发。

### Acceptance criteria

- [ ] 被节流时出现提示
- [ ] 间隔不短于现有下限、并发不增加

### Validation

Fulfills: VAL-013

- Verification: bun test ./src (exit zero)
- Evidence expected: p2 对照记录 + 截图

### Notes

- 跨里程碑依赖：p2、t8。
