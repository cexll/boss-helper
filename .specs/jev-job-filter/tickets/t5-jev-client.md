## Issue: t5 — Jev 请求客户端

Description: 按用途组装 Jev 请求，只发标题与职位描述，必要时经扩展后台发起，超时进入待复核
Type: AFK
Milestone: m2-jev
Touches: src/utils/jev.ts, src/utils/jev.test.ts, src/message/index.ts, src/message/background.ts, src/entrypoints/background.ts
Blocked by: p1, t6
User stories covered: G2
Estimate: 1 人天

### What to build

根据 p1 结论实现 Jev 调用：请求体只含岗位标题与职位描述；插件页面不可达时经扩展后台发起；超时或不确定返回待复核；后台也不可达时给出如实说明。岗位文本只作为被判断内容。

### Acceptance criteria

- [ ] 请求体断言只含标题与职位描述
- [ ] 超时返回待复核
- [ ] 不可达时返回明确原因且不调用其他模型

### Validation

Fulfills: VAL-009

- Verification: bun test ./src (exit zero)
- Evidence expected: 请求体断言输出

### Notes

- 跨里程碑依赖：p1（m0-probe）。消息协议页面与后台同批发布。
