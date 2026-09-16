# CHANGELOG · doc-qa

版本号语义见 doc-shared/references/pack-interface.md §6。scripts/qa.py ENGINE_VERSION = 1.0.0（写进 qa-result.json engine.version）。

## 1.0.0 — 2026-09-15

首版质检引擎（1d），验收关闭（Codex 四轮，主代理复跑自测 226 项全过，golden 四目录 0 差异）。

### 能力
- 三层规则：引擎通用规则（L1、L2、L4、L6–L10、S1–S3、X1–X4、C1、R1、H1–H4、T1–T12）、类型包 qa_rules.py check(doc, ctx)、业务钩子 pre_qa；并入 out/render.json 版式问题。
- engine_rules 过滤、severity_overrides、去重与截断；E-TYPE、E-HOOK 故障定级。
- 写 qa-result.json（带 rule_source、engine、source_sha256）、qa-report.md 自动区块、out/<源文件名>.resolved.md；run-state 写回（有必改而 D3 已过时 fail-gate D3）。
- 售前两包迁移期配置（engine_rules 只开 L1、L2、L4、C1、R1；meta_file brief.json；include_deny *internal*；banned_terms 置空），在 golden 四目录与旧 qa_checks.py 逐项一致。
- 固定流程：人工检查 + Codex 找茬、证伪两轮。

### 进行中 / 已知缺口
- S1 按 mode 取骨架、presales-site 0-1 禁写 301 与有效期两处一致、类型包 banned_terms 优先于内置 T11：归第三波 W3-A。

### 变更
- W3-I：同一张图 L6（原因仅为字号）与 render.json LY4 双必改去重，只留 LY4 并注明「另见 L6 字号」；--only 不并入 render.json 时不让位（scripts/engine_rules.py、qa.py，自测 +8）。
- W3-H（2026-09-15）：docmodel.mode_meta 上移为 doc-shared/scripts/validate.mode_meta，docmodel 转发，mode_skeleton 调 validate.resolve_mode(run_dir=…)。

### 重点高亮颜色变体（2026-09-15 主代理追加，并入 1.0.0）
- 引擎不感知 `kind`：H1、H2 对 5 种颜色合计计数，H3 按去掉前缀后的长度判，H4 与颜色无关。`engine_rules.py` 无改动，仅补自测正反例。
