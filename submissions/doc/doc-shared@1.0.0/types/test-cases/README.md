# 类型包：测试用例

对齐 design.md §5.5（与 test-plan 同一包的两个子类型，本目录按「类型包放在 doc-shared/types 下」的设计各自独立目录，便于 pack.draft.json 的 run_root 与 filename 分开声明）。数据源用 CSV/YAML（decisions.md ⑧A）。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，含 data_source_policy 与 layout（横向页段）字段 |
| skeleton.md | 正文分节结构 + 用例字段表 + 写法要点与反例 |
| writing-contract.md | 检索记录 + 本包自定约束（无上游快照） |
| qa-rules.md | CASE-01–08 自动、CASE-H1–H5 人工 |
| glossary.json | 术语一致 + 合法优先级/类型取值 + 空泛结果词表 |
| templates/doc.md | 正文模板，含 landscape 包裹的按模块分节数据块 |
| templates/figures/README.md | 说明本类型通常不需要图 |
| samples/membership-points-v2/ | 完整样张：47 条用例、data/cases.csv |

## 与其他包的关联

- 是「会员积分系统 v2」链路第六环，related_docs 指向 prd、test-plan、test-report 三个包的同名样张。
- data/cases.csv 被 test-plan 的需求覆盖矩阵与 D2 门读取；被 test-report 的执行统计读取（用例总数、模块/优先级分布作为分母）。
- filter 数据块扩展语法未在 design.md §3.3 中定义，已记入 staging/types/OPEN-QUESTIONS.md，等待引擎侧确认。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
