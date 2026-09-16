# 类型包：建站售前方案与报价

对齐 design.md §5.6。受众 external，封面变体 marketing。本包沿用现有 presales-shared 的骨架与业务规则，不新增写作约束，只补 doc-shared 类型包层的接口声明（pack.draft.json）与迁移后的样张。

## 文件清单

| 文件 | 说明 |
|---|---|
| pack.draft.json | 类型包接口草稿，include_allow/gates/hooks/cover/filename 对齐 design.md §5.6 描述 |
| skeleton.md | 引用上游 11 节骨架 + 建站业务线落地说明（不复制上游全文） |
| writing-contract.md | 登记引用关系（不是快照全文复制，因为上游本身就是既有约定，design.md §6.1 明确原样留在 presales-shared） |
| qa-rules.md | 售前专属规则（A1-A3、B1-B4、C2-C3、F1-F4、R2-R3、L3、L5 + SITE-01–05），引擎通用的 L1/L2/L4/R1/C1 已下沉到 doc-shared |
| glossary.json | 固定标题词表 + 建站场景绝对化用语扩展词表 |
| templates/doc.md | proposal.md 的 DocMark 模板，对应上游 templates/presales-site.md 的写法要求 |
| templates/figures/sitemap.mmd | 站点结构图模板 |
| samples/smokesite/ | 完整样张，改编自 presales-orchestrator 冒烟测试的 SmokeSite 场景 |

## 与其他包的关联

- 不是「会员积分系统 v2」样张链路的一部分（售前与内部产品文档是两条独立链路）。
- 与 presales-reddit 包共享上游 presales-shared 的通用骨架（第 01/07/09/10 节不可删除）与公司介绍 include。
- 本次交付**不修改**任何 presales-* 目录下的文件，只在 doc-shared/types 层新增声明与样张，遵守任务边界。
