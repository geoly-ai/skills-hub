# 质检规则（presales-site：建站售前方案）

「脚本」为是的规则由 doc-qa 自动检查：引擎通用规则见 doc-shared/references/qa-engine.md，本包专属规则在同目录 qa_rules.py（从 presales-qa/scripts/qa_checks.py 逐条搬迁，判据与消息不变；文件末尾追加本包专属的 SITE-06～09，W3-A 2026-09-15）。其余由主代理逐条人工检查，流程见 qa-engine.md §5（人工检查、Codex 找茬轮与证伪轮）。

来源：~/.claude/skills/presales-shared/references/qa-rules.md 与 presales-shared/packs/site/qa-extra.md（2026-09-15 读取，原文件未改）。

## 1. 引擎通用规则（本包启用，不在 qa_rules.py 重复）

| 编号 | 规则 | 脚本 | 默认定级 | 说明 |
|---|---|---|---|---|
| L1 | 未解析的 include、占位符，或 include 了白名单外的文件（internal-cost.json、路径穿越） | 是 | 必改 | 白名单由 pack.json include_allow 声明；白名单外消息文案由 qa_rules.py 的 MESSAGE_OVERRIDES 保持与旧脚本一致 |
| L2 | 行内代码格式、未转义波浪号 | 是 | 建议 | 迁移期保留 L2，关闭 T3、T9（否则重复报） |
| L4 | 每张 SVG 有同名 PNG 与 figures/review.json 自查记录 | 是 | 建议 | — |
| C1 | 版本号在封面、文件名、published.json 一致 | 是 | 提示 | 迁移期读 brief.json 的 version |
| R1 | 绝对化用语 | 是 | 必改 | SEO 零风险 |

迁移期只启用上面五条引擎规则（见 doc-qa/SKILL.md「售前迁移期配置」）；T1–T12、S1–S3、X1–X4、H1–H4、L6–L10 打开后产生的差异登记为有意，逐条评估后再开。

## 2. 本包专属自动规则（qa_rules.py）

| 编号 | 类别 | 规则 | 脚本 | 默认定级 | 来源案例 |
|---|---|---|---|---|---|
| A1 | 算术 | 正文手写的每个金额都与 pricing/ 产物精确匹配（不是子串匹配）；第三方费用等非报价金额登记在 pricing/allowed-amounts.json；人天数不匹配为建议 | 是 | 必改 | GNOCE 30 人天漏计 |
| A2 | 算术 | 建站必须有 scope.json，且每个方案的报价工作项与 scope.json 一一对应（price_site.py 与质检双重检查） | 是 | 必改 | Waykar 88 SKU 填充 9 人天不在明细 |
| A3 | 算术 | 比例、倍数表述与模型一致（含「工期与成本约为某方案的一半」「约 1.5 倍」这类不带「方案」二字的写法） | 是 | 建议 | Waykar「一半」与「2/3」 |
| C2 | 一致 | 「N 大模块（见 X.Y）」与 X.Y 节模块表实际行数一致；写计数时必须带「见 X.Y」 | 是 | 建议 | Waykar 9 大模块实列 8 个 |
| C3 | 一致 | 需求梳理速览的待确认项都出现在确认单 | 是 | 必改 | — |
| B1 | 边界 | 否定性条款不得吞掉报价承诺（仅供参考、不作为报价依据） | 是（关键词） | 必改 | GNOCE 3.3.1 |
| F2 | 事实 | 已知过时表述（qa_rules.py 的 STALE 表） | 是 | 建议 | Hydrogen（Remix） |
| F4 | 事实 | 量化或效果承诺（零成本、找回 N/N、提升 N%、翻倍）需有实测依据与口径 | 是 | 建议 | Waykar「零成本找回 1/3 的产品曝光面」 |
| R2 | 红线 | 内部口径泄露（成本、毛利、AI 辅助、Codex、内部代号） | 是 | 必改 | — |
| R3 | 红线 | 不可售项被报价或承诺（建站通常不触发，保留以防跨包误用模板） | 是 | 必改 | — |
| L3 | 版式 | 必备章节与 include：报价 include pricing/、include terms.md 与 confirm-list.md、有需求梳理速览与需求与范围确认单章节 | 是 | 必改 | — |
| L5 | 专业度 | include sections/company.md；brief.json 填项目联系人（缺联系人为建议） | 是 | 必改 | 用户 2026-09-15：logo、官网与专业度内容必不可少 |
| SITE-06 | 版式 | 按 mode 的必备章节：brief.json site.project_type 经 validate.resolve_mode 取 mode、resolve_skeleton 取打完补丁的骨架，required 章按标题（去手写序号）、aliases 或 {#sec:id} 匹配；缺章全文汇总为一条。引擎 S1 迁移期未开，是否打开由 1f 定 | 是 | 提示（试运行） | W3-C 转交：0-1 与迁移插入章无自动必备检查 |
| SITE-07 | 红线 | mode 禁词：客户可见正文（include 展开后，去掉围栏代码、HTML 注释、链接与图片地址、锚点与交叉引用、裸 URL；数据块单元格另查）按 modes.items[].forbidden_terms 用 validate.forbidden_hits 匹配。0-1 新建站「301 跳转」必报，「3010」「301171」不误伤 | 是 | 必改 | W3-C 验收 P1：0-1 禁写 301 未接入 QA |
| SITE-08 | 一致 | 有效期两处：封面 = presales-publish 渲染封面的数据源（pricing/site-model.json validity_days 为 30，且 brief.json validity_days 缺省或等于它）；第二处 = 报价章或商务条款章，或 include 的 pricing/、terms.md 展开正文里有「30 天内有效」（「30 个自然日 / 日历日内有效」同样算，「工作日」不算）。缺一处必改 | 是 | 必改 | W3-C 转交：有效期封面与商务条款两处出现 |
| SITE-09 | 一致 | mode 配置错误：site.project_type 不是已声明的 mode 或别名（不回落默认骨架，SITE-06、07 不跑） | 是 | 必改 | 同上 |

说明：L3、L5、A2 与旧脚本一样按 brief.json 的 line 字段分支（site / reddit），不按类型包 id；SITE-06～09 同口径，只在 line 为 site 时检查。pack.json qa.key_figures 已声明有效期、付款比例、方案总价、方案总人天（提示试运行），迁移期 engine_rules 不含 X4，暂不生效。

## 3. 人工规则

| 编号 | 类别 | 规则 | 脚本 | 默认定级 | 来源案例 |
|---|---|---|---|---|---|
| B2 | 边界 | 「若失败则改由」有工作包或变更机制 | 否 | 必改 | GNOCE Weaverse |
| B3 | 边界 | 内容填充、素材、设计、第三方费用的归属写清 | 否 | 必改 | Waykar 88 SKU |
| B4 | 边界 | 验收标准可测、不与方案冲突 | 否 | 必改 | GNOCE 埋点完全一致 |
| F1 | 事实 | 平台能力结论附官方链接与核验日期 | 否 | 必改（结论错时） | GNOCE Multipass |
| F3 | 事实 | 实测数字下结论前核对口径 | 否 | 必改 | Waykar 找回 1/3 曝光面 |
| SITE-01 | 补充 | 迁移项目的数据迁移工作包进入开发小计 | 否 | 必改 | packs/site/qa-extra.md |
| SITE-02 | 补充 | 不写 SEO 零风险、无损迁移、确保排名（「零风险」「确保排名」由引擎 R1 自动检查，「无损迁移」由 R1 的「无损」覆盖） | 部分 | 必改 | packs/site/qa-extra.md |
| SITE-03 | 补充 | site-audit 的未收录产品在正文下结论前已按占位、重复、他牌、测试、真实缺口分类 | 否 | 必改 | packs/site/qa-extra.md |
| SITE-04 | 补充 | 内容录入（W23）若由我方做，已计工时并写进确认单；若客户做，确认单写明 | 否 | 必改 | packs/site/qa-extra.md |
| SITE-05 | 补充 | 平台能力结论（客户账户、Headless 下的 App、结账）附官方链接与核验日期 | 否 | 必改 | packs/site/qa-extra.md |

## 4. 术语（glossary.json 的辨析说明）

| 正写 | 异写 | 说明 |
|---|---|---|
| 需求与范围确认单 | 确认表、范围清单 | 骨架第 10 节固定标题，不可改名（skeleton.md 不可删除节） |
| 需求梳理速览 | 现状梳理、需求盘点 | 骨架第 01 节子表固定标题 |

T8 迁移期未启用；打开后按上表检查异写。

## 5. 伪问题（不要报）

- 商务方案不写日历日期、排期放合同附件。
- 复刻现网口径下不含 UI/UX 重新设计费。
- 文档内自洽的项目管理比例，与其他项目不同。
- 团队内部技术栈认知分歧（提醒用户，不写进客户文档）。
