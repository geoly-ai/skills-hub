# 类型包：PRD（产品需求文档）

对齐 design.md §5.2。受众 internal，封面变体 technical。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，按 design.md §5.1 字段 |
| skeleton.md | 10 节骨架表 + 每节写法要点与反例（文档控制与修订记录、摘要由引擎与 summary 块生成，不计入编号章节，2026-09-15 第三波去重） |
| writing-contract.md | lark-doc genres/prd.md 快照（2026-09-15） |
| qa-rules.md | 自动 + 人工质检规则，PRD-01–09 自动、PRD-H1–H6 人工 |
| glossary.json | 术语与禁用同义写法、禁止在需求正文出现的实现术语清单 |
| templates/doc.md | 正文模板，占位提示写法 |
| templates/figures/user-flow.mmd | 用户流程图模板源 |
| samples/membership-points-v2/ | 完整样张：19 条需求、1 张流程图、需求清单 CSV |

## 与其他包的关联

- 是「会员积分系统 v2」样张链路的起点，related_docs 指向 mrd、tech-spec、test-plan 三个包的同名样张。
- data/requirements.csv 被 test-plan、test-cases 两个包的样张引用，用于需求覆盖矩阵与用例关联需求校验（design.md §5.5 的自动检查「关联需求编号在 PRD 中存在」）。
- REQ 编号体系是 tech-spec「接口设计」章节与 api-reference 接口描述的追溯依据。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
