# 建站售前方案骨架

复用 ~/.claude/skills/presales-shared/references/skeleton.md 的 11 节通用骨架（不可删除第 01、07、09、10 节），本文件只补建站业务线的落地说明，不重复抄录通用表（避免和上游产生第二份可能漂移的副本，只引用）。

| id | 骨架编号 | 标题 | 必备 | must_answer（建站落地） |
|---|---|---|---|---|
| background | 01 | 背景与目标 | 是 | 客户现状（实测并注明日期）；需求梳理速览覆盖商业模式、品牌资产、渠道与流量、系统与数据、运营团队、目标与约束六维度 |
| key-question | 02 | 关键问题前置 | 是 | 客户最担心的一个问题（如"迁移会不会丢排名"）的直接答案 |
| insight | 03 | 洞察与研究 | 是 | 竞品或参考站做得好的点，落到方案哪个模块 |
| solution | 04 | 解法 | 是 | 结构 / 模块 / 内容设计与每点价值 |
| delivery | 05 | 交付与验收 | 是 | 交付物、验收方式、技术或执行方案 |
| post-launch | 06 | 上线后如何验证 | 是 | 指标、工具、观察周期 |
| pricing | 07 | 报价 | 是（不可删除） | include pricing/ 产物，单价拆解、有效期、方案对比 |
| implementation | 08 | 实施计划 | 是 | 阶段、内容、周期 |
| terms | 09 | 商务条款 | 是（不可删除） | 付款、不含项、客户责任、风险与前置、补发或 SLA、不提供声明 |
| confirm | 10 | 需求与范围确认单 | 是（不可删除） | 方案选择、页面模块清单、参考站边界、内容与素材分工、第三方 App 或会员规则、上线时间与付款、范围变更机制 |
| why-us | 11 | 为什么选我们与下一步 | 是 | include sections/company.md；增值选项；下一步行动 |
| qms | 12 | 质量管理体系（QMS） | 是 | include sections/qms.md（组织级章节，复制自 doc-shared/brand/org/sections/qms.md）：3 阶段 12 环节质量门、缺陷分级 SLA、变更管理、付款与质量门对齐、风险管理双闭环、邮件留痕七节点 |

第 12 节来自《Shopify 建站方案 SKILL v1.5.0》§3、§9（2026-09-15 拍板 ㉔A），是上游 11 节骨架之外的建站专属必备章，放在全文最后收尾。

## 项目类型 modes（v1.5 §1.0）

pack.json 的 modes 按 brief.json 的 site.project_type 选骨架，缺省 rebuild。打完补丁的骨架用 `validate.resolve_skeleton(pack, mode)` 取。

| mode | 名称 | 骨架差异 | 专用模板与片段 |
|---|---|---|---|
| rebuild | 同店重构（默认） | 无补丁：现站诊断 + 关键问题（常见「会不会重新收录」） | content/reindex-answer.md |
| greenfield | 0-1 新建站 | 01 改「业务与资产盘点」；02 改「从第一天做对 SEO/GEO 地基」；03 竞品研究定位为行业最佳实践基准；**全文不写 301 跳转（按非数字边界正则判定）**；工时加 W25–W32 | templates/modes/greenfield.md、content/seo-foundation-greenfield.md |
| migration | 跨平台迁移 | 04 之后插入「数据迁移与切换」（必答项同 presales-shared/packs/site/templates/migration-addon.md）；02 必答 URL 结构变化与全量 301 | content/reindex-answer.md |

forbidden_terms 目前只是契约登记，质检引擎尚未按 mode 检查，写作者自查：用同一正则（非数字边界，股票代码这类长数字不算命中），`python3 -c "import sys,re,json; sys.path.insert(0,'$HOME/.claude/skills/doc-shared/scripts'); import validate; t=re.sub(r'<!--.*?-->','',open('proposal.resolved.md').read(),flags=re.S); print(validate.forbidden_hits(json.load(open('$HOME/.claude/skills/doc-shared/types/presales-site/pack.json')),'greenfield',t))"` 输出为空列表。

## 内容库（content/）

可 include 的论述片段，来源 v1.5 §5。用法：复制到运行目录 sections/（include_allow 已含 sections/*.md），按项目填写 {…} 占位并改写落地列，再在对应章节 include。

| 文件 | 用在 | 适用 mode |
|---|---|---|
| content/reindex-answer.md | 02 关键问题前置 | rebuild、migration |
| content/seo-foundation-greenfield.md | 02 从第一天做对 SEO/GEO 地基 | greenfield |
| content/geo-seven-points.md | 04 解法（核心价值：GEO） | 全部 |
| content/cro-six-steps.md | 04 解法（核心价值：CRO） | 全部 |
| content/validation-metrics.md | 06 上线后如何验证 | 全部 |

QMS 章：`cp ~/.claude/skills/doc-shared/brand/org/sections/qms.md sections/qms.md`，`cp ~/.claude/skills/doc-shared/brand/org/sections/figures/*.fig.json figures/`，第 12 节写 include。商务条款的风险表与 QMS 章风险管理小节互相引用，不写成两套。

## 写法要点与反例（建站业务线专属，通用部分见上游 skeleton.md）

### 背景与目标
- 要点：现状数据要标注实测日期（如"2026-08 抓取现网 88 个 SKU"），不写"目前网站较老旧"这类无日期无数据的判断。
- 反例：「客户现有网站体验不佳」——不是实测结论，缺日期与数据支撑。

### 关键问题前置
- 要点：客户最担心的问题要来自调研或客户原话，不是我方臆测；答案要直接，不绕圈子。
- 反例：把这一节写成方案概述——没有先回答客户最担心的具体问题。

### 报价
- 要点：正文不手写金额，全部通过 <!-- include: pricing/*.md --> 引入脚本产物（A1 规则）；比例/倍数表述必须与报价模型一致（A3 规则）。
- 反例：正文写"工期约为方案 A 的一半"，但未核对 pricing 产物里两个方案的实际工期比例。

### 需求与范围确认单
- 要点：速览中每一条"待确认"都必须在确认单出现（C3 规则），不能在速览提出问题却不在确认单收口。
- 反例：速览里"运营团队技术能力未确认"标为待确认，但确认单里没有对应确认项。
