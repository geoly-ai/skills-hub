# 样张：会员积分系统 v2 PRD

- doc.md：19 条需求（REQ-ACCT-01/02、REQ-EARN-01–05、REQ-REDEEM-01–04、REQ-TIER-01–03、REQ-RULE-01/02、REQ-NOTIFY-01/02、REQ-ADMIN-01），跨 7 个模块，9 个正文章节 + 1 个附录（文档控制与修订记录由引擎按 doc.json 生成，摘要由 summary 块生成，不计正文章节数，2026-09-15 第三波去重）。
- figures/points-flow.mmd：积分获取与消耗两条主路径的流程图，对应正文 @fig:points-flow。
- data/requirements.csv：REQ 编号 × 模块 × 标题 × 优先级清单，供 test-plan / test-cases 的需求覆盖矩阵引用，也供 tech-spec 的接口设计对照。
- 本样张是链路起点：MRD → **PRD（本文档）** → tech-spec → api-reference → test-plan → test-cases → test-report。
