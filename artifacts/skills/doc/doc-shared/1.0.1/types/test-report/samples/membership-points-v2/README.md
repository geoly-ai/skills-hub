# 样张：会员积分系统 v2 测试报告

- doc.md：6 节全齐（文档控制由引擎按 doc.json 生成，不计正文章节数，2026-09-15 第三波去重），用例执行统计按模块与优先级双维度给出，缺陷统计含级别/状态/趋势，准出结论逐条比对 test-plan 的 4 条准出标准。
- data/execution.csv：47 条用例的实际执行状态（通过 43、失败 1、阻塞 3），与 test-cases 的 data/cases.csv 用例编号一一对应。
- data/defects.csv：4 条缺陷（DEF-001–004），级别覆盖 P0–P3，关联用例编号可在 test-cases 中核实。
- 核对结果：P0 通过率 16/16=100%，P1 通过率 15/15=100%，均满足 test-plan 第 4 节的准出标准，准出结论为「建议发布」。
- figures/defect-trend.mmd：缺陷发现趋势图（Mermaid xychart-beta），对应正文 @fig:defect-trend。
- 链路位置：MRD → PRD → tech-spec → api-reference → test-plan → test-cases → **test-report（本文档，链路终点）**。related_docs 指向 test-plan、test-cases 两个包的同名样张。
