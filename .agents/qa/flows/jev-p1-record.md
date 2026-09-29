# jev-p1-record — p1 Jev 实测记录核对（回归流程契约）

- 断言：VAL-016（a-final-2-r2 判定 **pass**，可回归）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

守护 p1 实测记录（`docs/probes/jev-p1-record.md`）对断言各项的**覆盖完整性与脱敏**，以及「实现 = 记录 = 用户确认口径」三方一致：

- §2 可达性矩阵：插件页面 10/10 200、扩展后台 10/10 200、普通网页/about:blank 对照 `TypeError: Failed to fetch`；预检任意浏览器源 400 `Disallowed CORS origin` ⇒ 可达靠 `host_permissions` 直连；§2.3 如实声明 zhipin 页面内直连未测。
- §3.1 抓包 `state` 仅 `job_title + job_description`；§3.2 响应 `model` 为具体版本；§3.3 错误三形态。
- §4.1 耗时 p50≈349ms / p95≤569ms；§4.2 挂起形态；§5 noul 标定带；§6.1–6.3 建议值；§6.4 用户确认（2026-09-28 确认并回写 spec.md）。
- 全文 `Authorization: Bearer <REDACTED>` 脱敏。
- 实现口径核对（303c82a 未触及这些模块）：`JEV_TIMEOUT_MS=8000`、state 允许清单 `['job_title','job_description']`、`JEV_UNCERTAIN_BAND={0.2,0.8}`、会话级缓存键含响应具体模型版本。

**边界**：本流程只核对记录与代码口径，**不发起任何真实 Jev 调用**（真实调用属 p1 HITL，需用户逐次批准）。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0（仅跑配套测试）；`python3`/`grep` 做记录结构核对。
- 记录本体（只读）：`docs/probes/jev-p1-record.md`；晋升快照副本 `VAL-016-jev-p1-record.md`。
- 配套测试：`src/utils/jev.test.ts` + `src/entrypoints/boss/delivery.test.ts`（与 jev-client.md 同一批，`41 pass` 基线）。
- 实现锚点：`src/utils/jev.ts:43`（超时）、`src/utils/jev.ts:383-388`（state 允许清单）、`src/composables/useApplying/jevDirection.ts:36`（不确定带）、`src/composables/useApplying/jevCache.ts`（会话级缓存键含模型版本）。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/jev-p1-record

# 1) 记录结构核对：九节齐全、脱敏、无明文密钥
python3 - <<'PY'
import re
rec = open('docs/probes/jev-p1-record.md').read()
need = ['## 1. 结论速览','## 2. 可达性与跨域','## 3. 请求与响应形态','## 4. 耗时分布',
        '## 5. 不确定结果的表现','## 6. 建议值','## 7. 未尽事项','## 8. 复现命令','## 9. 对 m2 的落地提示']
missing = [s for s in need if s not in rec]
assert not missing, f'missing sections: {missing}'
assert rec.count('Bearer <REDACTED>') >= 2, 'redaction markers missing'
raw = re.findall(r'Bearer [A-Za-z0-9_.\-]{20,}', rec)
assert not raw, f'RAW TOKEN LEAK: {raw[:1]}'
print('p1 record: 9 sections present, redacted, no raw token')
PY

# 2) 实现口径常量核对
python3 - <<'PY'
jev = open('src/utils/jev.ts').read(); jdir = open('src/composables/useApplying/jevDirection.ts').read()
assert 'JEV_TIMEOUT_MS = 8000' in jev
assert "allowed = ['job_title', 'job_description']" in jev
assert 'JEV_UNCERTAIN_BAND = { low: 0.2, high: 0.8 }' in jdir
print('constants match p1 §6.4 confirmed values')
PY

# 3) 口径被测试钉住（junit；与 jev-client.md 同批）
bun test src/utils/jev.test.ts src/entrypoints/boss/delivery.test.ts --reporter=junit --reporter-outfile=.run/qa/jev-p1-record/junit.xml
```

## Blocking checks for future runs

任一不满足即停：

1. 步骤 1 输出 `p1 record: 9 sections present, redacted, no raw token`。出现任何明文长 token、缺节、或 §2.3「未测路径」声明被删，即记录契约失效。
2. 步骤 2 输出 `constants match p1 §6.4 confirmed values`。常量改动而记录未同步 = 失效（三方一致被破坏）。
3. 步骤 3 输出 `0 fail`，基线 `41 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致；JUnit `tests=41 assertions=110 failures=0`）。新增用例使计数上升不算失败；任何 `fail` 即停。
4. 结论若声称「请求体/超时/带宽行为已验证」，必须同时引用 p1 记录（实测面）与 junit（wire 面）；只引用其一视为覆盖不足。

## Evidence expected

落盘 `.run/qa/jev-p1-record/`：

- `junit.xml` — 本流程产出（`--reporter-outfile` 落盘）。参照基线：`VAL-009-junit.xml`，sha256 `c0e21315d6a38ea83dc5fa3700b9730c9848a79b8b96bae022b352da08c03975`（41 testcase / failures=0）。历史人读摘要基线（默认 reporter 文本，现版步骤不再落盘）：`VAL-009-buntest.txt`，sha256 `d6e826e0f7e73d7032d10007e78a17b7b5ef4b82b934cd4da97f179f7264f9a1`；JUnit `VAL-009-junit.xml`，sha256 `c0e21315d6a38ea83dc5fa3700b9730c9848a79b8b96bae022b352da08c03975`。
- 记录快照基线：`VAL-016-jev-p1-record.md`，sha256 `549437bd7f617fa2ee125f04a1810f5c08f8b5d88ba115f0de33f379214ed93b`（与 `docs/probes/jev-p1-record.md` 当前内容一致）。
