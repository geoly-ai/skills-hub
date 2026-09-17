# 写作约束快照（Reddit 售前方案）

无对应 lark-doc genre。本包不是新写作约束，沿用现有的售前既有约定，来源与读取日期如下：

| 来源文件 | 内容 | 读取日期 |
|---|---|---|
| presales-shared/references/skeleton.md | 11 节骨架、需求梳理速览维度表、确认单固定项表、RFP 应答模式 | 2026-09-15 |
| presales-shared/references/company-profile.md | 公司介绍口径（第 11 节 include） | 2026-09-15 |
| presales-shared/packs/reddit/pack.md、discovery-checklist.md、content-library.md、terms.md、cost-model.json | Reddit 业务线专属调研清单、内容库、条款库、计价模型 | 2026-09-15 |

这些文件不搬迁、不复制（design.md §6.1），本文件只登记引用关系。

## 与本平台通用规则的关系

- 品牌 token、DocMark 语法、T1–T12、封面/目录/页眉页脚规范全部改走 doc-shared 通用契约，售前文档零改动可渲染。
- 售前专属质检规则（A1、A3、B1、C2-C3、F2、F4、R2-R4、L3、L5）留在本包，引擎通用的 L1、L2、L4、R1、C1 见 doc-shared。
- 与 presales-site 包的边界：两包共享上游骨架与公司介绍，但计价模型（cost-model.json vs wbs-library.csv）、条款库（补发与验收口径不同）、不可售项清单完全独立，不互相引用。
