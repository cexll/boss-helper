## Issue: p1 — Jev 接口实测（规格前置 P5）

Description: 在真实环境只读实测 Jev 可达性、请求响应形态、超时与不确定结果，回写规格待定项
Type: HITL
Milestone: m0-probe
Touches: None（实测记录写入会话证据目录，不改仓库代码）
Blocked by: None
User stories covered: G2
Estimate: 0.5 人天

### What to build

用测试密钥和公开岗位文本调用 Jev：分别从插件页面与扩展后台发起，记录是否受跨域限制、请求/响应字段、耗时分布、错误与不确定结果的表现。据此提出超时秒数、不确定判定方式与缓存期限，交用户确认后回写规格 Terms / Assumptions。

### Acceptance criteria

- [ ] 记录插件页面与扩展后台两条路径各自是否可达
- [ ] 记录实际发出的请求体只含岗位标题与职位描述
- [ ] 超时秒数、不确定判定、缓存期限经用户确认并写入规格

### Validation

Supports: VAL-009（实测部分）

- Evidence expected: 实测命令与脱敏响应样本

### Notes

- 不得发送个人信息；不得真实投递。若两条路径都不可达：m2 全部停止并报告，不改用其他模型。
