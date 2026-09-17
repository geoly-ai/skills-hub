# 样张：会员积分系统 v2 测试计划

- doc.md：8 节全齐（文档控制由引擎按 doc.json 生成，不计正文章节数，2026-09-15 第三波去重），准入准出标准含数字（P0 通过率 100%、P1 通过率 ≥ 95%），需求覆盖矩阵引用 data/coverage.csv。
- data/coverage.csv：由 PRD 的 data/requirements.csv 与 test-cases 的 data/cases.csv 交叉生成（19 条 REQ 全部覆盖，已用脚本核对，见 test-cases 样张 README 的核对记录），满足 D2 门判据。
- 链路位置：MRD → PRD → tech-spec → api-reference → **test-plan（本文档）** → test-cases → test-report。related_docs 指向 prd、tech-spec、test-cases、test-report 四个包的同名样张。
