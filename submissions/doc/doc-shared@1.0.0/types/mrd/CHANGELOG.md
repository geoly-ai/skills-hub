# CHANGELOG · 类型包 mrd（市场需求文档）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/mrd/），第三波改动在首次对外使用前并入本条。

### 能力
- 骨架 9 节（skeleton.md）；qa-rules.md：MRD-01–05 自动、MRD-H1–H4 人工；glossary.json（含夸大用语词表）。
- 模板 templates/doc.md、templates/figures/positioning.mmd（定位象限图）；writing-contract.md 为检索记录 + 本包自定约束。
- 样张 samples/membership-points-v2/：9 节、6 条 MR 需求、1 张图、竞品矩阵；链路第一环。

### 第三波变更
- 1c 出图验收时主代理修定位象限图中文加引号（飞书画板解析）。
- W3-F 骨架去重：删除「摘要」骨架条目，改为 summary 块。
- W3-E：样张 related_docs 补 role（prd references）。

### 进行中
- qa_rules.py 自动规则由 W3-A 实现。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报。
