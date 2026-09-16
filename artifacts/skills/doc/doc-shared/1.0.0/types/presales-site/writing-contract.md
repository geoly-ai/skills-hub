# 写作约束快照（建站售前方案）

无对应 lark-doc genre（检索 25 个体裁文件，proposal.md 类体裁最接近"方案投标"但售前方案在本平台已有独立、更成熟的既有约定，不需要再从 lark-doc 复制）。

本包不是新写作约束，而是**沿用现有的售前既有约定**，来源与读取日期如下：

| 来源文件 | 内容 | 读取日期 |
|---|---|---|
| ~/.claude/skills/presales-shared/references/skeleton.md | 11 节骨架、需求梳理速览维度表、确认单固定项表、RFP 应答模式 | 2026-09-15 |
| ~/.claude/skills/presales-shared/references/company-profile.md | 公司介绍口径（第 11 节 include） | 2026-09-15 |
| ~/.claude/skills/presales-shared/references/pricing-policy.md | 计价与报价呈现规则 | 2026-09-15 |
| ~/.claude/skills/presales-shared/packs/site/pack.md、discovery-checklist.md、module-library.md、terms.md | 建站业务线专属调研清单、模块库、条款库 | 2026-09-15 |

这些文件本身不搬迁、不复制（design.md §6.1：presales-shared/references/skeleton.md、pricing-policy.md、packs/ 原样留在 presales-shared，加 pack.json 并注册为 doc 类型包），本文件只是登记引用关系，不是快照全文复制。

## 与本平台通用规则的关系

- 品牌 token、DocMark 语法、T1–T12 中文排版规则、封面/目录/页眉页脚规范全部改走 doc-shared 的通用契约（design.md §3），售前文档零改动可渲染（design.md §3.3 明确保证）。
- 售前专属的质检规则（A1–A3、B1–B4、C2–C3、F1–F4、L3、L5、R2–R4）留在本包（qa-rules.md），不下沉到引擎通用层；引擎通用的 L1、L2、L4、R1、C1 见 doc-shared（design.md §6.1 拆分方案）。
