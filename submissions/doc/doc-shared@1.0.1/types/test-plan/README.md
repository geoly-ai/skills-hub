# 类型包：测试计划

对齐 design.md §5.5。受众 internal，封面变体 technical。无对应 lark-doc genre，骨架与质检规则自定。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，含 D2 门判据说明 |
| skeleton.md | 8 节骨架表 + 写法要点与反例（文档控制由引擎生成，不计入编号章节，2026-09-15 第三波去重） |
| writing-contract.md | 检索记录 + 本包自定约束（无上游快照） |
| qa-rules.md | PLAN-01–06 自动、PLAN-H1–H3 人工 |
| glossary.json | 术语一致 + 空泛措辞词表 |
| templates/doc.md | 正文模板，第 8 节用数据块渲染覆盖矩阵 |
| templates/figures/coverage-heatmap.fig.json | 覆盖矩阵热图模板（可选，本包自拟 svgkit schema） |
| samples/membership-points-v2/ | 完整样张：8 节、19 条需求全覆盖的覆盖矩阵 |

## 与其他包的关联

- 是「会员积分系统 v2」链路第五环，related_docs 指向 prd、tech-spec、test-cases、test-report 四个包的同名样张。
- D2 门（需求覆盖矩阵无未覆盖的 P0/P1 需求）需要跨读 prd 包的 data/requirements.csv 与 test-cases 包的 data/cases.csv，design.md 未定义具体的跨包读取机制，已记入 OPEN-QUESTIONS.md。
- 与 test-cases 包共享"测试计划与测试用例是两类合一个包的两个子类型"的设计定位（design.md §5.5 标题），本次落地为两个独立目录，理由见 test-cases/README.md。


## 质检规则代码状态

规则代码待下一波按 doc-qa 引擎实现，规则说明见 qa-rules.md。qa_rules.py 现为空实现（check 返回 []）。
