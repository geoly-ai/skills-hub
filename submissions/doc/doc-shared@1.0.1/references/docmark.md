# DocMark 语法

DocMark 是 doc.md（售前类型包为 proposal.md）的写法：Markdown 子集 + 若干 HTML 注释指令。doc-render 把它渲染为 HTML / PDF 与飞书 XML，doc-qa 用同一份解析结果做检查。

**一个解析器**：渲染与质检必须共用同一个 DocMark 解析模块（建议 1b 实现为 doc-shared/scripts/docmark_parse.py，doc-render 与 doc-qa 都 import）。两份解析器迟早会对同一行给出不同结论。

## 1. 兼容的原有语法（售前文档零改动可渲染）

| 写法 | 含义 | 飞书输出 | PDF 输出 |
|---|---|---|---|
| 第一行 `# 标题` | 文档标题（封面标题），全文唯一 | title | 封面标题、PDF Title |
| `## ` / `### ` / `#### ` | 一级、二级、三级标题；编号自动生成，标题里不手写序号（T5） | h1–h3 seq="auto" | 编号标题 |
| 空行分隔的文字 | 段落；续行按规则拼接（见 §4） | p | p |
| `**加粗**` | 加粗；全文唯一的行内格式 | b | b |
| `- ` / `1. ` | 无序、有序列表 | ul / ol | ul / ol |
| Markdown 表格 | 首行表头，第二行分隔行 | table + thead | table + thead（跨页重复） |
| 表格上一行 `<!-- widths: 100,300,300 -->` | 列宽权重，个数须等于列数；HTML、飞书、docx 都按权重归一化（飞书迁移期开关 --legacy-widths-px 例外） | colgroup | colgroup 百分比 |
| `> [!note] 文字`、`> [!warn] 文字` | 高亮块 | callout（配色见 brand/generated/feishu-callouts.json） | 配色块 |
| `![图注](figures/x.svg)` | SVG 图 | whiteboard type="svg" | 内联 SVG |
| `![图注](shots/x.png)` | 位图（png、jpg、jpeg、webp） | img | 内嵌图片 |
| `<!-- grid: 2 -->` … `<!-- /grid -->` | 2 或 3 列图片网格 | grid / column | CSS grid |
| `<!-- include: sections/x.md -->` | 原样插入运行目录内文件；白名单由类型包 include_allow 声明，最多嵌套 3 层 | 展开后内容 | 展开后内容 |
| `<!-- pagebreak -->` | 强制分页 | 忽略 | 分页 |

## 2. 新增语法

| 写法 | 含义 | 飞书输出 | PDF 输出 | 开关 |
|---|---|---|---|---|
| 表格上一行 `<!-- table: 表题 {#tbl:id} -->` | 表题与锚点；表号自动「表 章-序」 | 表前段落「表 3-2 表题」 | caption，计入表目录 | features.table_captions |
| `![图题](figures/x.mmd){#fig:id}` | 图按扩展名路由引擎：.mmd Mermaid、.dot Graphviz、.fig.json svgkit 模板、.svg 成品 | .mmd → whiteboard type="mermaid"；其余 → whiteboard type="svg"（用 build 后的 .svg） | 内联 SVG（id 加命名空间） | features.figure_numbers |
| `{#fig:id width=60%}` | 图占正文宽比例（10%–100%，默认 100%）；参与等效字号计算 | 忽略 | 宽度 | — |
| `## 标题 {#sec:id}` | 章节锚点 | 忽略锚点 | 锚点 | — |
| `## 术语表 {#sec:glossary .appendix}` | 附录章节，编号「附录 A」 | 标题前缀「附录 A」 | 同左 | numbering.appendix |
| `@fig:id`、`@tbl:id`、`@sec:id` | 交叉引用，渲染为「图 3-2」「表 5-1」「3.2 节」 | 文字 | 文字 + 内部链接 | — |
| `{#<实体>:id}` 与 `@<实体>:id` | 类型包 numbering.entities 声明的实体锚点与引用（如需求、测试项） | 文字 | 文字 + 链接 | 类型包声明 |
| 列表项缩进两个空格 | 二级嵌套列表（最多两级） | 嵌套 ul / ol | 嵌套列表 | — |
| 围栏代码块 ```` ```lang ```` … ```` ``` ```` | 块级代码，必须标语言 | pre lang + code | 等宽、浅底、不断页（超过一页时允许断） | features.code_blocks（decisions ⑦A：技术类允许） |
| `[文字](https://…)` | 外链；运行目录内相对路径也可（L10 检查可解析） | a | 可点链接 | — |
| `> [!tip]`、`> [!decision]`、`> [!risk]` | 更多高亮块；`> ` 开头的续行属于同一块 | callout | 配色块 | — |
| `<!-- data: data/cases.csv columns=编号,标题,优先级 group=模块 sort=编号 filter=编号^TC-ACCT- caption=表题 id=tbl:cases widths=1,4,1 -->` | 数据块：CSV 渲染为表；参数见下方「数据块参数规则」 | table | table（跨页重复表头） | features.data_blocks |
| `<!-- summary -->` … `<!-- /summary -->` | 执行摘要，PDF 独占一页排在目录前 | 文首高亮块（callout 子块只能是 p / ul / ol） | 摘要页 | features.summary_block |
| `<!-- landscape -->` … `<!-- /landscape -->` | 横向页段（宽表） | 忽略 | 横向页，版心宽 269 mm | features.landscape |
| `[^1]` 与段后 `[^1]: 注释` | 脚注 | 页末文字段 | 章末注 | features.footnotes |
| `⟪重点片段⟫`、`⟪!…⟫`、`⟪+…⟫`、`⟪~…⟫`、`⟪?…⟫`（U+27EA / U+27EB） | 重点高亮（主代理 2026-09-15 追加，同日补颜色前缀）：段落、表格单元格、列表项、标题里可用；不嵌套、不跨行；未闭合、缺开头、嵌套、跨行为解析错误（HL1，带行号）；非法的 ⟪ ⟫ 渲染时丢弃，任何输出都不出现这两个字符。开括号后可紧跟一个颜色前缀，见下方「重点高亮颜色前缀」 | `<b><span background-color="…">…</span></b>`，底色按 kind 取 callout 映射 | 加粗 + 底色，底色按 kind 取 tokens `callout` 表 | — |

锚点 id 只用 `[A-Za-z0-9_-]`，全文唯一（X3）。引用不存在的锚点为必改（X1）。

重点高亮颜色前缀（主代理 2026-09-15 定）：`⟪` 之后可以紧跟**一个**颜色前缀字符（不留空格），复用 `brand/tokens.json` 的 `callout` 表配色，不另发明色值。前缀字符本身不渲染、不进入高亮内容、不计入字数（H3 长度按去掉前缀后的内容算）。

| 前缀 | kind | 语义 | tokens 来源 | HTML class | 飞书底色 | docx 底色 |
|---|---|---|---|---|---|---|
| （无） | neutral | 默认，向后兼容 | callout.note（color.tint） | `dm-hl` | light-purple | tint |
| `!` | risk | 风险 / 警示 | callout.risk | `dm-hl dm-hl-risk` | light-red | danger_tint |
| `+` | tip | 利好 / 结论 | callout.tip | `dm-hl dm-hl-tip` | light-green | ok_tint |
| `~` | warn | 需注意 | callout.warn | `dm-hl dm-hl-warn` | light-orange | warn_tint |
| `?` | decision | 待确认 / 决策 | callout.decision | `dm-hl dm-hl-decision` | light-blue | info_tint |

示例：`本期 ⟪+兑换失败率低于 2%⟫，但 ⟪!积分池在 3 月见底⟫，口径 ⟪?按自然月还是账期⟫ 待确认，⟪~历史数据只回溯到 2025-06⟫。`

规则：
- `⟪` 后紧跟的字符不是这 4 个之一（含无前缀、前面有空格、是 `#` 之类别的字符）时，整体按 neutral 处理，**该字符原样留在内容里，不被吞掉**。
- 前缀后立即闭合（如 `⟪!⟫`）仍按空高亮报 HL1 warning，kind 保留。
- **kind 不影响用量限额**：H1（全文总数）、H2（单页处数）、H3（单处长度）对 5 种颜色**合计计数**，与颜色无关。
- 颜色只表达语义，不表达褒贬；不要靠颜色承载正文没写出来的信息（打印成黑白仍要读得懂）。

数据块参数规则（filter 为主代理 2026-09-15 定）：

| 参数 | 语义 |
|---|---|
| columns=列1,列2 | 选列与顺序；缺省为全部列。列名按 CSV 表头精确匹配 |
| filter=列名^前缀 | 只保留该列（去掉首尾空白后）以「前缀」开头的行；区分大小写，原样匹配，不是正则。以第一个 `^` 为界：左边是列名，右边整段是前缀（前缀里可以再出现 `^`）。可写多个 filter，取交集；需要「或」时拆成多个数据块 |
| group=列名 | 按该列分节，每节带行数小计；分组与小计只计 filter 之后的行 |
| sort=列名 | 按该列升序（字符串比较；数字序号请补零） |
| caption=表题、id=tbl:x、widths=1,4,1 | 同普通表格的表题、锚点、列宽 |

转义与限制：参数之间用空白分隔；值里有空格时用英文双引号包住整个值，如 `filter="模块^账户 管理"`、`caption="表 题"`；值里不能出现英文双引号与 `-->`。列名本身含逗号、`^`、`=` 或双引号时不支持，改 CSV 表头。引用不存在的列、前缀为空（`列名^`）为 L9 必改；filter 之后 0 行时只输出表头并报 L9 提示。PDF 与飞书输出同一批行。

数据块 YAML：decisions ⑧A 允许 CSV 或 YAML，但 Python 标准库没有 YAML 解析器，本机也未装 PyYAML（未验证）。阶段 1 先只支持 CSV（UTF-8、首行表头、RFC 4180 引号）；要 YAML 时由 1b 决定装进 doc-render 专用 venv 并记录版本。

## 3. 禁止项

| 禁止 | 原因 | 质检 |
|---|---|---|
| 行内代码（反引号） | 飞书约定不用行内代码 | T9 / 兼容 L2 |
| 波浪号区间（3~5） | 飞书会吞，写「3–5」或「3 至 5」 | T3 / 兼容 L2 |
| HTML 标签（DocMark 注释指令除外） | 双输出无法保证一致 | L1 |
| 斜体、删除线 | 飞书回查把斜体、删除线残留视为问题 | L1 |
| 未开启 code_blocks 的类型包里写围栏代码块 | 类型包没有代码块版式 | L8 必改 |
| 手写合计数字 | 由类型包规则约束（例如售前的金额溯源） | 类型包规则 |

## 4. 渲染细节约定（兼容性决定）

- **续行拼接**：旧渲染器把续行直接拼接，英文续行会粘成一个词。新规则：前一行末字符与后一行首字符都是拉丁字母或数字时插入一个空格，否则直接拼接。中文文档结果不变。
- **波浪号**：旧渲染器把所有 ~ 替换为「–」（会改坏 URL）。新规则：链接 URL 与代码块内原样保留；正文里的 ~ 不静默改写，由 T3 拦截。售前类型包在迁移期保留旧行为，保证 golden 比对一致，改掉算有意差异。
- **SVG 内联**：每张图的 id、class、url(#…) 引用加 `f<序号>-` 前缀，避免多图串样式（旧渲染器未做）。
- **标题层级**：飞书要求标题层级连续不跳级（lark-doc XML 规范），S2 检查。

## 5. 与售前旧文档的关系

旧 references/brand-layout.md 的语法表是本文 §1 的子集，写法与含义完全一致。旧文档里没有 §2 的语法时，新渲染器的输出应与旧渲染器一致（golden 比对口径见 ~/workspace/docs/doc-skill-platform-2026-09-15/golden/README.md）；表头重复、目录页码、图表编号等版式增强作为有意差异逐条登记。
