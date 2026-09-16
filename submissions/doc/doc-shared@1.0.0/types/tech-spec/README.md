# 类型包：技术 Spec / Design RFC

对齐 design.md §5.4。受众 internal，封面变体 technical。写作约束对齐 lark-doc genres/technical-doc.md 的 design_rfc 模式。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，含 decisions.md ⑦A 的代码块政策字段 |
| skeleton.md | 11 节骨架表 + 写法要点与反例（文档控制与修订记录、摘要由引擎与 summary 块生成，不计入编号章节，2026-09-15 第三波去重） |
| writing-contract.md | lark-doc genres/technical-doc.md（design_rfc 模式）快照 |
| qa-rules.md | SPEC-01–09 自动、SPEC-H1–H6 人工 |
| glossary.json | 术语一致 + 允许代码语言清单 |
| templates/doc.md | 正文模板，含架构 / 时序 / ER / 状态机四类图占位 |
| templates/figures/ | 5 个图源模板 + README（含 .fig.json 分层架构 schema 自拟说明） |
| samples/membership-points-v2/ | 完整样张：11 节、2 个备选方案、5 张图 |

## 与其他包的关联

- 是「会员积分系统 v2」链路第三环，related_docs 指向 prd、api-reference、test-plan 三个包的同名样张。
- 正文引用 PRD 的 REQ 编号做交叉追溯，不单独编需求号（本包备选方案用 ALT-{序号}）。
- 接口设计节只覆盖核心接口摘要，完整契约（权限、限流、分页、全部错误码）的编写规范见 api-reference 包。
- .fig.json 分层架构 schema 由内容侧自拟（design.md §4.2 未给字段），最终以 doc-figures 引擎实现为准，已记入 OPEN-QUESTIONS.md。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
