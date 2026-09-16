# 质检规则（presales-reddit：Reddit 售前方案）

「脚本」为是的规则由 doc-qa 自动检查：引擎通用规则见 doc-shared/references/qa-engine.md，本包专属规则在同目录 qa_rules.py（从 presales-qa/scripts/qa_checks.py 逐条搬迁，与 presales-site 同一份实现）。其余由主代理逐条人工检查，流程见 qa-engine.md §5。

来源：~/.claude/skills/presales-shared/references/qa-rules.md 与 presales-shared/packs/reddit/qa-extra.md（2026-09-15 读取，原文件未改）。

## 1. 引擎通用规则（本包启用，不在 qa_rules.py 重复）

| 编号 | 规则 | 脚本 | 默认定级 | 说明 |
|---|---|---|---|---|
| L1 | 未解析的 include、占位符，或 include 了白名单外的文件 | 是 | 必改 | 白名单由 pack.json include_allow 声明 |
| L2 | 行内代码格式、未转义波浪号 | 是 | 建议 | 迁移期保留 L2，关闭 T3、T9 |
| L4 | 每张 SVG 有同名 PNG 与 figures/review.json 自查记录 | 是 | 建议 | — |
| C1 | 版本号在封面、文件名、published.json 一致 | 是 | 提示 | 迁移期读 brief.json 的 version |
| R1 | 绝对化用语 | 是 | 必改 | — |

迁移期只启用上面五条引擎规则（见 doc-qa/SKILL.md「售前迁移期配置」）。

## 2. 本包专属自动规则（qa_rules.py）

| 编号 | 类别 | 规则 | 脚本 | 默认定级 | 来源案例 |
|---|---|---|---|---|---|
| A1 | 算术 | 正文手写的每个金额都与 pricing/ 产物精确匹配；第三方费用登记在 pricing/allowed-amounts.json | 是 | 必改 | GNOCE 30 人天漏计 |
| A3 | 算术 | 比例、倍数表述与模型一致（有 pricing/site-model.json 的 ratios 时才检查，Reddit 通常不触发） | 是 | 建议 | Waykar「一半」与「2/3」 |
| C2 | 一致 | 「N 大模块（见 X.Y）」与 X.Y 节实际行数一致 | 是 | 建议 | Waykar 9 大模块实列 8 个 |
| C3 | 一致 | 需求梳理速览的待确认项都出现在确认单 | 是 | 必改 | — |
| B1 | 边界 | 否定性条款不得吞掉报价承诺 | 是（关键词） | 必改 | GNOCE 3.3.1 |
| F2 | 事实 | 已知过时表述（STALE 表） | 是 | 建议 | Hydrogen（Remix） |
| F4 | 事实 | 量化或效果承诺需有实测依据与口径 | 是 | 建议 | Waykar「零成本找回 1/3」 |
| R2 | 红线 | 内部口径泄露（成本、毛利、AI 辅助、Codex、内部代号） | 是 | 必改 | — |
| R3 | 红线 | Reddit 不可售项（点赞助推、互动量保证、批量私信、虚假测评、虚假身份、诱导投票、黑灰产外链）出现在非拒绝语境 | 是 | 必改 | — |
| L3 | 版式 | 必备章节与 include：报价 include pricing/、include terms.md 与 confirm-list.md、有需求梳理速览与需求与范围确认单章节 | 是 | 必改 | — |
| L5 | 专业度 | include sections/company.md；brief.json 填项目联系人（缺联系人为建议） | 是 | 必改 | 用户 2026-09-15 |

说明：A2（scope.json 核对）只在 brief.json line 为 site 时触发，本包不适用。

## 3. 人工规则

| 编号 | 类别 | 规则 | 脚本 | 默认定级 | 来源案例 |
|---|---|---|---|---|---|
| R4 | 红线 | 交付量超过产能核查上限且未写缺口 | 否 | 必改 | Insta360 RFP |
| REDDIT-01 | 补充 | 交付量不超过 price_reddit.py capacity 的上限；超过时报价前写明缺口与可行解（D2 门的产能核查覆盖计算部分，正文表述人工核对） | 否 | 必改 | packs/reddit/qa-extra.md |
| REDDIT-02 | 补充 | 不可售项（cost-model.json 的 not_for_sale）未出现在报价与承诺中（R3 自动覆盖固定词表；cost-model.json 新增项人工核对） | 部分 | 必改 | packs/reddit/qa-extra.md |
| REDDIT-03 | 补充 | 存活期承诺与补发窗口一致；评论是否补发写清 | 否 | 必改 | packs/reddit/qa-extra.md |
| REDDIT-04 | 补充 | 品牌露出比例三口径分母一致 | 否 | 建议 | packs/reddit/qa-extra.md |
| REDDIT-05 | 补充 | 对赌方案写出最差净收并与固定价比较 | 否 | 建议 | packs/reddit/qa-extra.md |
| REDDIT-06 | 补充 | 声量数据写取数日期与来源 | 否 | 建议 | packs/reddit/qa-extra.md |

staging 草稿把 REDDIT-01 至 06 标为「脚本：是」，但旧 qa_checks.py 没有实现（以现有代码为准），这里改为人工；需要自动化时在 qa_rules.py 新增，先定级「提示」试运行。

## 4. 术语（glossary.json 的辨析说明）

| 正写 | 异写 | 说明 |
|---|---|---|
| 需求与范围确认单 | 确认表、范围清单 | 骨架第 10 节固定标题 |
| 补发 | 重发、补投 | 统一用「补发」，与 terms.md 的补发规则用词一致 |
| 披露规范 | 免责声明、利益相关声明 | 统一用「披露规范」，指代 Reddit 社区要求的商业关系公开方式 |

## 5. 伪问题（不要报）

- 商务方案不写日历日期、排期放合同附件。
- 文档内自洽的项目管理比例，与其他项目不同。
