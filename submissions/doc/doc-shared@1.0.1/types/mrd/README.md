# 类型包：MRD（市场需求文档）

对齐 design.md §5.3。受众 internal，封面变体 technical。无对应 lark-doc genre（见 writing-contract.md 的检索记录），骨架与质检规则完全自定。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿 |
| skeleton.md | 9 节骨架表 + 写法要点与反例（摘要由 summary 块生成，不计入编号章节，2026-09-15 第三波去重） |
| writing-contract.md | 检索记录 + 本包自定约束（无上游快照） |
| qa-rules.md | MRD-01–05 自动、MRD-H1–H4 人工 |
| glossary.json | 术语一致 + 夸大用语词表（MRD-04 用） |
| templates/doc.md | 正文模板 |
| templates/figures/positioning.mmd | 定位象限图模板（Mermaid quadrantChart） |
| samples/membership-points-v2/ | 完整样张：9 节、6 条 MR 需求、1 张图、竞品矩阵 |

## 与其他包的关联

- 是「会员积分系统 v2」样张链路的第一环，related_docs 指向 prd 包同名样张。
- data/mr-requirements.csv 的 MR 编号是 PRD 需求的上游输入，一条 MR 可能展开为多条 REQ（一对多，不是一一对应，见 writing-contract.md）。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
