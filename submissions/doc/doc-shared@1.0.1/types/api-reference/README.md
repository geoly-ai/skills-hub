# 类型包：API 参考文档

design.md §5.4 把 api_reference 列为 tech-spec 的二期子类型；按用户 2026-09-15「涉及文档类型都要完整覆盖」的拍板，本包独立成包（与 tech-spec 平级），tech-spec 的「接口设计」节只放摘要并交叉引用本包（见 tech-spec/writing-contract.md 补充说明）。写作约束对齐 lark-doc genres/technical-doc.md 的 api_reference 模式。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，含独立成包的说明字段 note |
| skeleton.md | 7 节骨架表 + 写法要点与反例（文档控制与修订记录由引擎生成，不计入编号章节，2026-09-15 第三波去重） |
| writing-contract.md | lark-doc genres/technical-doc.md（api_reference 模式）快照 |
| qa-rules.md | API-01–08 自动、API-H1–H4 人工 |
| glossary.json | 术语一致 + 允许代码语言清单 |
| templates/doc.md | 正文模板，7 节 |
| templates/figures/auth-flow.mmd | 鉴权流程图模板（可选） |
| samples/membership-points-v2/ | 完整样张：7 节、5 个接口详情 |

## 与其他包的关联

- 是「会员积分系统 v2」链路第四环，related_docs 指向 tech-spec 包同名样张。
- 与 tech-spec 的字段一致性（API-H4）是人工检查项，design.md 未定义跨文档自动一致性检查机制，已记入 OPEN-QUESTIONS.md。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
