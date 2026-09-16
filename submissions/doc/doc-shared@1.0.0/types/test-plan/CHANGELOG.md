# CHANGELOG · 类型包 test-plan（测试计划）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/test-plan/），第三波改动在首次对外使用前并入本条。

### 能力
- 骨架 8 节（skeleton.md）；qa-rules.md：PLAN-01–06 自动、PLAN-H1–H3 人工；glossary.json。
- 模板 templates/doc.md（第 8 节用数据块渲染覆盖矩阵）、templates/figures/coverage-heatmap.fig.json。
- D2 门脚本已接入（需求覆盖矩阵无未覆盖的 P0 / P1 需求）。
- 样张 samples/membership-points-v2/：8 节、19 条需求全覆盖的覆盖矩阵；链路第五环。
- 关联：related 声明 prd（source_prd，D0 必需、D2 相关）、tech-spec（source_spec）、test-cases（references，D2 相关）。

### 第三波变更
- W3-C（v1.5 吸收）：可引用组织级 QMS 章 brand/org/sections/qms.md。
- W3-F 骨架去重：删除「文档控制」骨架条目（由引擎生成）。
- W3-E：QMS 章从 templates 的 ../../brand/org/sections/qms.md 挪到 org_sections（required false）；样张 related_docs 补 role（prd source_prd、tech-spec source_spec、test-cases references、test-report references）。

### 进行中
- qa_rules.py 自动规则与用 ctx.related 跨读 PRD、test-cases 重算覆盖由 W3-A 实现。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报。
