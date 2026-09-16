# 类型包：Reddit 售前方案与报价

对齐 design.md §5.6。受众 external，封面变体 marketing。本包沿用现有 presales-shared 的骨架与业务规则，不新增写作约束，只补 doc-shared 类型包层的接口声明（pack.draft.json）与迁移后的样张。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，include_allow/gates/hooks/cover/filename 对齐 design.md §5.6 描述 |
| skeleton.md | 引用上游 11 节骨架 + Reddit 业务线落地说明（不复制上游全文） |
| writing-contract.md | 登记引用关系（不是快照全文复制） |
| qa-rules.md | 售前专属规则（A1、A3、B1、C2-C3、F2、F4、R2-R4、L3、L5 + REDDIT-01–06），引擎通用规则已下沉到 doc-shared |
| glossary.json | 固定标题词表 + Reddit 场景绝对化用语扩展词表 |
| templates/doc.md | proposal.md 的 DocMark 模板，对应上游 templates/standard.md 的写法要求 |
| templates/figures/engine-flow.mmd | 增长获客引擎与 VOC 口碑引擎流程图模板 |
| samples/smokereddit/ | 完整样张，改编自 presales-orchestrator 冒烟测试的 SmokeReddit 场景 |

## 与其他包的关联

- 不是「会员积分系统 v2」样张链路的一部分。
- 与 presales-site 包共享上游 presales-shared 的通用骨架（第 01/07/09/10 节不可删除）与公司介绍 include，但计价模型、条款库、不可售项清单完全独立。
- 本次交付**不修改**任何 presales-* 目录下的文件。
