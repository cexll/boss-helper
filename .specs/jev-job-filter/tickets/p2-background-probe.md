## Issue: p2 — 后台节流实测（规格前置 P4）

Description: 实测切换标签页后流水线计时与请求被浏览器节流的程度，把脱敏实测记录提交为仓库文档
Type: HITL
Milestone: m0-probe
Touches: docs/probes/throttle-p2-record.md
Blocked by: None
User stories covered: G3
Estimate: 0.5 人天

### What to build

加载当前构建，在测试账号上启动不投递的模拟流程（或仅观察计时器），切换标签页 5、15、30 分钟，记录计时延迟与是否暂停。结论写成本票交付文件 docs/probes/throttle-p2-record.md，供 t11 与用户引用。

### Acceptance criteria

- [ ] 记录各时长下的实际间隔与暂停情况
- [ ] 给出 t11 应提示的判定条件

### Validation

Fulfills: VAL-017

- Verification: bun run test (exit zero)
- Evidence expected: 实测记录文档与截图路径

### Notes

- 不得真实投递；使用现有安全间隔。
- HITL 实测：涉及驱动真实浏览器与 zhipin 页面前须先取得批准（2026-09-26 用户已批准 p2 用本机浏览器驱动测试账号观察、不投递）。
- 本票为 HITL 只读实测（Type: HITL）：不改产品代码；实测结论提交为 docs/probes/throttle-p2-record.md，不包含账号或个人信息。
