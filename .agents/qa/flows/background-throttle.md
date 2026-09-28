# background-throttle — 后台节流提示与 p2 记录（回归流程契约；**证据局限必须随结论引用**）

- 断言：VAL-013、VAL-017（a-final-2-r2 判定均为 **pass**，可回归；但 pass 附带显式局限，见 Scope 末尾，不得脱离局限引用）
- 判定来源：`.specs/jev-job-filter/missions/reports/a-final-2-r2.json`（runId `a-final-2-r2/2026-09-29T03:15+08:00/w-1790616759604-a9rqp4`，candidate `303c82a0bb5d577ca8cfe2af4b7bf097358e4f6b`）
- 背景修复：r1 曾判 VAL-013 **fail**（可见态清除带比 p2 §5 字面恢复条件宽，矩阵 12 点中 8 点偏离）；修复提交 `303c82a` 把 `end()` 第二清除分支改为 `actual < requested + 3` 后逐点复验一致。
- 证据目录：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/`

## Scope

- **VAL-013**：节流提示触发/清除语义与 p2 实测记录 §5 字面条件逐点一致——触发 = 不可见 且 连续 ≥2 次 `actual >= max(2×requested, requested+10)`；清除（可见为前提）= `actual < requested + 3`。矩阵 12 点（requested∈{5,30} × actual∈{r+1, r+3, r+3.001, r+9.9, r+10, r+11}）零偏离。
- **VAL-017**：p2 实测记录（`docs/probes/throttle-p2-record.md`）的数字可从其冻结快照复现：快照 sha256 与记录 §3 声明一致、行数/kinds 齐全；记录表 1–4 的 headline 数字经独立重算一致（33 轮、隐藏窗内 15 轮、7 轮 60s 钳制、自报 hidden 28 轮中 22 轮 rAF 全 0、四区间吞吐 0.127/0.158/0.148/0.628、net 201/隐藏窗内 7）；§5 给出的 t11 判定条件与实现逐点一致。

**显式局限（pass 结论必须连同以下三点一起引用，缺一即误导）**：

1. 本候选上**没有**「提示横幅在真实页面渲染」的截图：`t11-hint-shown.png` 与 `t11-hint-cleared.png` byte-identical（sha256 `f9e919e6…`），取证脚本未触达 store。要拍正例需一次真实的受节流投递运行（HITL 授权，本轮范围外）。
2. p2 记录测的是 `delay()` **计时原语**而非投递流水线（记录 §7 自述）；「流水线在后台跑完」为未测项。已证的是后台计时回调仍被调度、只是被显著拉长——只提示、不加速。
3. `.run/p2/shots/` 五张 PNG byte-identical（sha256 全部 `1fe993d0…`）：截图不提供逐闸门视觉区分，记录的数字证据全部落在冻结快照上。

## Driver contract for future runs

- 工作目录：仓库根；`bun` ≥ 1.4.0；依赖就位。
- 驱动脚本（冻结证据，byte-identical）：`.specs/jev-job-filter/missions/evidence/a-final-2-r2/VAL-013-clearband-matrix.ts`，sha256 `eefa2d3393681af0dfc650a3267fbcca42bca52d135264c20c33ccc727f87e64`。
- **注意：该脚本没有失败退出逻辑——无论 mismatches 多少都 exit 0**。判定必须解析输出 JSON 的 `mismatches` 为空，**不能只看退出码**。
- 快照与记录（只读）：`.run/p2/events.frozen.ndjson`（gitignored，若工作树没有该文件需从主会话冻结产物恢复，不得自行重造）、`docs/probes/throttle-p2-record.md`（晋升快照副本 `VAL-013-017-throttle-p2-record.md`）。
- 记录 headline 数字的重算脚本未入库（validator 一次性脚本）；未来运行的**可判定校验**是快照完整性（sha/行数/kinds/与记录 §3 声明一致）；如需逐数字复算，须自写独立脚本（不得复用记录自带生成器）。
- 目录纪律：`.specs/jev-job-filter/` 只读；新证据落 `.run/qa/`。

## Future run steps

```bash
mkdir -p .run/qa/background-throttle

# 1) 清除带矩阵：12 点逐点比对 p2 §5 字面条件（解析 mismatches，非 exit code）
bun run .specs/jev-job-filter/missions/evidence/a-final-2-r2/VAL-013-clearband-matrix.ts \
  | tee .run/qa/background-throttle/clearband-matrix.json
python3 -c "import json; d=json.load(open('.run/qa/background-throttle/clearband-matrix.json')); assert d['mismatches']==[], d['mismatches']; assert len(d['matrix'])==12; print('matrix: 12 points, mismatches=0')"

# 2) 触发/清除/接线/并发间隔语义（backgroundState + index.pipeline，junit）
bun test src/composables/useApplying/backgroundState.test.ts src/composables/useApplying/index.pipeline.test.ts --reporter=junit \
  | tee .run/qa/background-throttle/buntest.txt
python3 -c "import xml.etree.ElementTree as ET; r=ET.parse('.run/qa/background-throttle/buntest.txt').getroot(); assert r.get('failures')=='0', r.attrib; print('junit tests', r.get('tests'), 'failures 0')"

# 3) p2 冻结快照完整性（VAL-017 可判定校验）
shasum -a 256 .run/p2/events.frozen.ndjson
wc -l .run/p2/events.frozen.ndjson
python3 -c "import json,collections; c=collections.Counter(json.loads(l)['kind'] for l in open('.run/p2/events.frozen.ndjson')); print(dict(sorted(c.items())))"
```

## Blocking checks for future runs

任一不满足即停：

1. 步骤 1 JSON：`mismatches == []` 且 `matrix` 恰 12 点；12 点的 `hinted` 全为 true（两次隐藏钳制后提示态已建立）。
2. 步骤 2 输出 `0 fail`；通过数基线 `39 pass`（2 文件，2026-09-29 于 303c82a 观测并复跑一致；JUnit 根节点 `tests=39 assertions=167 failures=0`）。新增用例使计数上升不算失败；任何 `fail` 即停。
3. 步骤 2 JUnit 中必须存在并全过：「隐藏且连续 2 次节流才提示」「切回前台且 actual<requested+3 时清除」「可见但 actual 恰为 requested+3 时不清除」「可见但 actual∈[requested+3, 门槛) 时不清除」；单文件基线 `backgroundState.test.ts` = `21 pass`。
4. 步骤 3 快照 sha256 = `2eded95e8f8faefe7cb428efa2ce290bfea20bfc4a15252beb715d8ed754af7f`（与 `docs/probes/throttle-p2-record.md` §3 声明一致）、行数 256、`kind` 计数非空。若工作树无 `.run/p2/`（fresh worktree），此步不可跳过也不可伪造——先恢复冻结产物，再判定。
5. 结论表述检查：任何「后台流水线跑完」「横幅已渲染」的表述超出已证范围（见 Scope 局限 1/2），视为误述，须改正后重报。

## Evidence expected

落盘 `.run/qa/background-throttle/`：

- `clearband-matrix.json` — 晋升基线副本：`VAL-013-clearband-matrix.stdout.txt`，sha256 `62771cda7e8857cdb0eb976b0b8667c3e8afb42f216904a9b6671b9b2663604c`。
- `buntest.txt`（junit） — 基线副本：`VAL-013-buntest.txt`，sha256 `09a658bb43c4f935649ad2621918f35b522b1164cfb99b9042894e7db1018883`；JUnit `VAL-013-junit.xml`，sha256 `ff979dff4b205ffd3fde8aad9a47b3be039361dc95545b8869ea500f33f0883e`。
- 单文件基线：`VAL-013-backgroundState-buntest.txt`，sha256 `084382cdde4be00951416f8dfb4ced0ca9c13e6df8329208ba5f6cbf14bc65d4`（21 pass / 0 fail / 85 expect()）。
- 记录与快照基线：`VAL-013-017-throttle-p2-record.md`，sha256 `7cecc12ccf9378076aae00053308eea9c0ed81cba228a873f32779e11afbd325`（= `docs/probes/throttle-p2-record.md`）；`VAL-017-events.frozen.ndjson`，sha256 `2eded95e8f8faefe7cb428efa2ce290bfea20bfc4a15252beb715d8ed754af7f`（256 行）；`VAL-017-CHECKSUMS.txt`，sha256 `f8fd2c7b49744b529e9c63f0ea591d4112f498f9fe754a5a5dfea0264327f7ca`。
- 实现冻结源码参照：`VAL-013-backgroundState.source.ts`（`06a0b77fd0a9…`）、`VAL-013-backgroundState.test.source.ts`（`755c13f57a11…`）。
