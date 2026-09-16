# CHANGELOG · 类型包 test-report（测试报告）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版（1e 落位 types/test-report/，按 2026-09-15 全量拍板完整落地），第三波改动在首次对外使用前并入本条。

### 能力
- 骨架 7 节含附录（skeleton.md）；qa-rules.md：REPORT-01–08 自动、REPORT-H1–H3 人工；glossary.json（合法准出结论与用例状态取值）。
- 模板 templates/doc.md、templates/figures/defect-trend.mmd（Mermaid xychart-beta）。
- 样张 samples/membership-points-v2/：47 条用例执行结果、4 条缺陷；链路终点。
- 关联：related 声明 test-plan（executes_plan，D0 必需）、test-cases（reports_on，D0 必需）。

### 第三波变更
- 1c 出图验收时主代理修缺陷趋势图：样张改按日 08-13..08-19，与 defects.csv 和正文一致；模板 y 轴上限 30。
- W3-F 骨架去重：删除「文档控制」骨架条目；样张渲染 8 页、LY10 与版式问题 0。
- W3-E：样张 related_docs 补 role（test-plan executes_plan、test-cases reports_on）。

### 进行中
- qa_rules.py 自动规则由 W3-A 实现。

### 变更
- W3-H（2026-09-15）：qa_rules.py 通用小工具改为 import doc-shared/scripts/qa_pack_helpers.py（行为不变）；related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退，缺 role 一律按关联文档缺失报。
