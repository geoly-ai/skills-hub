# 样张：会员积分系统 v2 API 参考

- doc.md：7 节全齐（文档控制与修订记录由引擎按 doc.json 生成，不计正文章节数，2026-09-15 第三波去重），5 个接口详情（账户查询、积分获取回调、积分兑换、规则查询、运营人工调整），每个接口含请求参数表、权限、行为/副作用、请求/响应示例代码块、已知错误表。
- 与 tech-spec 样张 §5 接口设计节的 2 个摘要接口（redeem、rules/current）字段保持一致，属于跨文档一致性人工检查项（API-H4）。
- 无独立 figures（本样张鉴权简单，未使用 auth-flow.mmd 可选图，仅文字说明，符合 templates/figures/README.md 的用法说明）。
- 链路位置：MRD → PRD → tech-spec → **api-reference（本文档）** → test-plan → test-cases → test-report。related_docs 指向 tech-spec 包同名样张。
