# 样张：会员积分系统 v2 Tech Spec

- doc.md：11 节全齐（文档控制与修订记录由引擎按 doc.json 生成，摘要由 summary 块生成，不计正文章节数，2026-09-15 第三波去重），2 个备选方案（ALT-1 推荐 / ALT-2 否决并给具体理由），5 张图（现状架构、目标架构、时序、ER、状态机，覆盖 design.md §5.4 要求的"至少一张架构图与一张时序或状态图"）。
- 接口设计节（§5）覆盖 2 个核心接口，含错误码列，并交叉引用 api-reference 包的完整契约。
- figures/：current-arch.fig.json、target-arch.fig.json（svgkit 分层架构自拟 schema）、sequence.mmd、data-model.mmd、state-machine.mmd。
- 链路位置：MRD → PRD → **tech-spec（本文档）** → api-reference → test-plan → test-cases → test-report。related_docs 指向 prd、api-reference、test-plan 三个包的同名样张。
- 需求追溯：正文引用 PRD 的 REQ-EARN-01/04/05、REQ-REDEEM-01–04、REQ-RULE-01/02、REQ-ADMIN-01，与 PRD 样张的 REQ 编号一致。
