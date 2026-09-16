# CHANGELOG · 类型包 api-reference（API 参考）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/api-reference/，按 2026-09-15 拍板独立成包，与 tech-spec 平级），第三波改动在首次对外使用前并入本条。

### 能力
- 骨架 7 节（skeleton.md）；qa-rules.md：API-01–08 自动、API-H1–H4 人工；glossary.json。
- 模板 templates/doc.md、templates/figures/auth-flow.mmd；writing-contract.md 快照 lark-doc genres/technical-doc.md（api_reference 模式）。
- 样张 samples/membership-points-v2/：7 节、5 个接口详情；链路第四环。
- 关联：related 声明 tech-spec（source_spec，D0 必需）。

### 第三波变更
- W3-F 骨架去重：删除「文档控制与修订记录」骨架条目（由引擎生成）。
- W3-E：样张 related_docs 补 role（tech-spec source_spec）。

### 已知遗留
- 与 tech-spec 的字段一致性（API-H4）为人工检查项。
- qa_rules.py 自动规则由 W3-A 实现。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报；pack.json 声明 qa.allowed_languages（与脚本常量同一份），SPEC-06 / API-06 优先读它、读不到回退常量。
