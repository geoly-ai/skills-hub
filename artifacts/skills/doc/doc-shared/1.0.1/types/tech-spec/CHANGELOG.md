# CHANGELOG · 类型包 tech-spec（技术 Spec / 设计文档）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/tech-spec/），第三波改动在首次对外使用前并入本条。

### 能力
- 骨架 11 节（skeleton.md）；qa-rules.md：SPEC-01–09 自动、SPEC-H1–H6 人工；glossary.json（含允许代码语言清单）。
- 模板 templates/doc.md 与 5 个图源模板（current-arch、target-arch 为 svgkit layered-arch，data-model、sequence、state-machine 为 Mermaid）；writing-contract.md 快照 lark-doc genres/technical-doc.md（design_rfc 模式）。
- 样张 samples/membership-points-v2/：11 节、2 个备选方案、5 张图；链路第三环。
- 关联：related 声明 prd（source_prd，D0 必需、D2 相关）。

### 第三波变更
- W3-C（v1.5 吸收）：可引用组织级 QMS 章 brand/org/sections/qms.md。
- W3-F 骨架去重：删除「文档控制与修订记录」「摘要」骨架条目；样张渲染 14 页、LY10 与版式问题 0。
- W3-E：QMS 章从 templates 的 ../../brand/org/sections/qms.md 挪到 org_sections（required false）；样张 related_docs 补 role（prd source_prd、api-reference references、test-plan references）。

### 已知遗留
- 样张 target-arch 同层非相邻节点连线仍有交叉（doc-figures 遗留）。
- qa_rules.py 自动规则由 W3-A 实现。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报；pack.json 声明 qa.allowed_languages（与脚本常量同一份），SPEC-06 / API-06 优先读它、读不到回退常量。
