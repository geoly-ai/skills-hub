# CHANGELOG · 类型包 prd（产品需求文档）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/prd/），第三波改动在首次对外使用前并入本条。

### 能力
- 骨架 10 节（skeleton.md，含写法要点与反例）；质检规则说明 qa-rules.md：PRD-01–09 自动、PRD-H1–H6 人工；glossary.json。
- 模板 templates/doc.md、templates/figures/user-flow.mmd；写作约束快照 writing-contract.md（lark-doc genres/prd.md，2026-09-15）。
- 样张 samples/membership-points-v2/：19 条需求、1 张流程图、需求清单 CSV；「会员积分系统 v2」链路起点，data/requirements.csv 被 test-plan、test-cases 引用。
- 关联：related 声明 mrd（source_mrd，可选）。

### 第三波变更
- W3-F 骨架去重：删除「文档控制与修订记录」「摘要」骨架条目（前者由引擎按 doc.json 生成，摘要改为 summary 块），样张渲染 12 页、LY10 与版式问题 0。
- W3-D3：prd 全流程到「等用户确认发布」、qa 必改 0。
- W3-E：inputs.input4（关联 MRD 或立项材料，如有）由必需改为可选，与描述一致；样张 related_docs 补 role（mrd source_mrd、tech-spec references、test-plan references）。

### 进行中
- qa_rules.py 自动规则由 W3-A 实现。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报。
