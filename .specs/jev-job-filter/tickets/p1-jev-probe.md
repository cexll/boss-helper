## Issue: p1 — Jev 接口实测（规格前置 P5）

Description: 在真实环境只读实测 Jev 可达性、请求响应形态、超时与不确定结果，把脱敏实测记录提交为仓库文档
Type: HITL
Milestone: m0-probe
Touches: docs/probes/jev-p1-record.md
Blocked by: None
User stories covered: G2
Estimate: 0.5 人天

### What to build

用测试密钥和公开岗位文本调用 Jev：分别从插件页面与扩展后台发起，记录是否受跨域限制、请求/响应字段、耗时分布、错误与不确定结果的表现。据此提出超时秒数、不确定判定方式与缓存期限。结论写成本票交付文件 docs/probes/jev-p1-record.md，供 m2 各票与用户确认引用。

### Acceptance criteria

- [ ] 记录插件页面与扩展后台两条路径各自是否可达
- [ ] 记录实际发出的请求体只含岗位标题与职位描述
- [ ] 超时秒数、不确定判定、缓存期限给出建议值并请用户确认（结论记录在交付文件中）

### Validation

Fulfills: VAL-016

- Verification: bun run test (exit zero)
- Evidence expected: 实测记录文档（脱敏请求与响应样本、耗时统计）

### Notes

- 不得发送个人信息；不得真实投递。若两条路径都不可达：m2 全部停止并报告，不改用其他模型。
- HITL 实测：涉及真实 Jev 调用前须先向用户说明并取得批准（2026-09-26 用户已批准 p1 实测，凭证置于 .run/p1-jev.env，gitignored）。
- 本票为 HITL 只读实测（Type: HITL）：不改产品代码；实测结论提交为 docs/probes/jev-p1-record.md，密钥与令牌一律脱敏，不得写入任何个人信息。
