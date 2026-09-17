# 样张：会员积分系统 v2 测试用例

- data/cases.csv：47 条用例，7 个模块（ACCT 4、EARN 13、REDEEM 11、TIER 6、RULE 6、NOTIFY 4、ADMIN 3），6 种类型（功能 20、异常 19、边界 3、性能 2、接口 2、安全 1）。
- 覆盖 PRD v1.2 全部 19 条 REQ，17 条 P0/P1 需求全部至少 1 条用例覆盖（已用脚本核对，见本文件旁的核对记录，无遗漏）。
- doc.md 用 <!-- landscape --> 包裹 7 个模块分节，每节用 <!-- data: data/cases.csv ... filter=... --> 渲染该模块的用例子集；filter 属性写法为本包对 DocMark 数据块语法的扩展提案，design.md §3.3 未定义 filter 参数，已记入 OPEN-QUESTIONS.md，待 doc-author 实现子代理确认最终语法。
- 链路位置：MRD → PRD → tech-spec → api-reference → test-plan → **test-cases（本文档）** → test-report。related_docs 指向 prd、test-plan、test-report 三个包的同名样张。
