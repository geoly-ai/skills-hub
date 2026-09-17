# 类型包：测试报告

design.md §5.7 列为二期候选（"执行结果、缺陷统计、准出结论，与测试计划分开"）；按用户 2026-09-15 的全量拍板与补充指令（"执行概况、用例执行统计（按模块/优先级）、缺陷统计（级别、状态、趋势）、未通过与遗留问题、准出结论与依据、风险与建议"），本次完整落地。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，含 consistency 字段说明编号一致性要求 |
| skeleton.md | 7 节骨架表 + 写法要点与反例（含附录；文档控制由引擎生成，不计入编号章节，2026-09-15 第三波去重） |
| writing-contract.md | 检索记录 + 本包自定约束（无上游快照） |
| qa-rules.md | REPORT-01–08 自动、REPORT-H1–H3 人工 |
| glossary.json | 术语一致 + 合法准出结论取值 + 合法用例状态取值 |
| templates/doc.md | 正文模板，含缺陷趋势图占位 |
| templates/figures/defect-trend.mmd | 缺陷趋势图模板（Mermaid xychart-beta，版本支持性见 README 说明） |
| samples/membership-points-v2/ | 完整样张：6 节、47 条用例执行结果、4 条缺陷 |

## 与其他包的关联

- 是「会员积分系统 v2」链路的终点，related_docs 指向 test-plan、test-cases 两个包的同名样张。
- REPORT-06（准出依据与 test-plan 口径一致）与 REPORT-05（TC 编号在 test-cases 中存在）都需要跨包读取，design.md 未定义具体机制，已记入 OPEN-QUESTIONS.md。
- 样张的执行数据（data/execution.csv）与 test-cases 的 data/cases.csv 用例编号逐一对应，已用脚本核对（P0/P1 通过率均为 100%，与 test-plan 准出标准比对一致）。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
