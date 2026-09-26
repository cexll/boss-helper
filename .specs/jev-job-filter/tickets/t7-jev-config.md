## Issue: t7 — Jev 配置与授权

Description: 新增 Jev 密钥与目标方向配置，缺一不能启用，启用时展示接收服务并取得授权
Type: AFK
Milestone: m2-jev
Touches: src/types/formData.ts, src/composables/conf/info.ts, src/components/Tabs/AI.vue
Blocked by: p1, t3
User stories covered: G2
Estimate: 0.5 人天

### What to build

新增 Jev 开关、密钥（只存浏览器存储）、目标岗位方向；任一为空时不能启用；启用时展示数据接收方与发送内容并取得授权。

### Acceptance criteria

- [ ] 缺密钥或目标时不能启用
- [ ] 启用时展示接收服务与发送字段
- [ ] 旧配置加载后 Jev 默认关闭

### Validation

Fulfills: VAL-008

- Verification: bun test ./src (exit zero)
- Evidence expected: 截图

### Notes

- 跨里程碑依赖：p1。配置属关键路径。
