# CHANGELOG · 类型包 test-cases（测试用例）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/test-cases/，与 test-plan 为两个独立包），第三波改动在首次对外使用前并入本条。

### 能力
- 正文分节结构与用例字段表（skeleton.md）；数据源 CSV / YAML（decisions ⑧A）；qa-rules.md：CASE-01–08 自动、CASE-H1–H5 人工；glossary.json。
- 模板 templates/doc.md（landscape 包裹的按模块分节数据块）。
- 样张 samples/membership-points-v2/：47 条用例、data/cases.csv；链路第六环，cases.csv 被 test-plan 覆盖矩阵与 test-report 执行统计读取。
- 关联：related 声明 prd（source_prd，D0 必需、D2 相关）、test-plan（references）。

### 第三波变更
- W3-D3：test-cases 全流程到「等用户确认发布」、qa 必改 0。
- W3-E：样张 related_docs 补 role（prd source_prd、test-plan references、test-report references）。

### 进行中 / 已知缺口
- banned_terms 被内置 T11 覆盖成死配置：主代理拍板类型包配置优先，doc-qa 合并逻辑由 W3-A 改。
- skeleton 标题改为章节名、banned_terms 补 columns 限定范围、qa_rules.py 自动规则由 W3-A 处理。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报。
