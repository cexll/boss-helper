## Issue: p2 — 后台节流实测（规格前置 P4）

Description: 实测切换标签页后流水线计时与请求被浏览器节流的程度
Type: HITL
Milestone: m0-probe
Touches: None
Blocked by: None
User stories covered: G3
Estimate: 0.5 人天

### What to build

加载当前构建，在测试账号上启动不投递的模拟流程（或仅观察计时器），切换标签页 5、15、30 分钟，记录计时延迟与是否暂停。

### Acceptance criteria

- [ ] 记录各时长下的实际间隔与暂停情况
- [ ] 给出 t11 应提示的判定条件

### Validation

Supports: VAL-013（实测部分）

- Evidence expected: 实测记录与截图

### Notes

- 不得真实投递；使用现有安全间隔。
