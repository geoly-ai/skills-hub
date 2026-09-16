# DocMark 解析结果（AST）接口

实现：scripts/docmark_parse.py（纯标准库，VERSION 1.0）。doc-render 与 doc-qa **同一份**；类型包 qa_rules.py 通过 doc-qa 拿到同一个 Document，不直接 import 本模块（pack-interface.md §4）。

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-15 | 1.0 | 首版（1b）。含重点高亮 ⟪…⟫（主代理 2026-09-15 追加） |
| 2026-09-15 | 1.1 | 按 Codex 交付评审修正（只收紧判定，字段只增不改名）：① includes 与 include-* 诊断的 line 改为**展开后正文行号**，新增 source_line（指令所在文件的行号），file 不变；② 锚点类型不符（标题非 sec:、图非 fig:、表非 tbl:）由 warning 改为 **error 并丢弃该锚点**；标题上写类型包实体锚点时转为行内锚点；③ table / widths 注释必须紧挨表格（之间只允许空行与另一个 table / widths 注释），否则 directive-dangling 并丢弃；④ 分隔行必须是表格第二行，新增 table-separator-position；⑤ grid 内混入非图内容新增 grid-child（L1，error）；⑥ include 与数据块经符号链接指向运行目录外时拒绝（realpath 校验，已有行为，补回归用例） |
| 2026-09-15 | 1.2 | 第三波 W3-D1 按 1b 验收修正（只收紧判定）：① parse_file 对正文源文件做 path_safe + realpath 边界校验，越界（含指向外部的符号链接）抛 SourcePathError（PermissionError 子类，属「源文件读不出」）；② 图：图源及派生文件（build 后 .svg、doc-figures .png）经符号链接越出运行目录时报 figure-path；新增 figure_files()、safe_source()；③ 表格第二行分隔行必须每列都是分隔符且列数等于表头，否则报 table-no-separator 并忽略该行；④ widths 非法时清空挂起的 widths，不继承之前的合法值；⑤ 新增 §10 安全前提 |
| 2026-09-15 | 1.3 | W3-D1 验收：新增行内节点 `anchor`（行内锚点 `{#kind:id}` 的位置，渲染器在此发射链接目标；inline_plain 与旧节点语义不变） |

接口冻结：字段只增不改名。必须改名或改语义时在本表登记，并同时通知 doc-qa、doc-render。

## 1. 入口

```python
import sys; sys.path.insert(0, '<doc-shared>/scripts')
from docmark_parse import parse_file, parse_text, inline_plain, walk_inline, engine_for, svg_path_for
doc = parse_file(run_dir, 'doc.md', pack=pack_dict)        # 展开 include，读 data/*.csv
doc = parse_text(text, pack=pack_dict, run_dir=run_dir)     # 不展开 include（测试用）
```

| 参数 | 说明 |
|---|---|
| pack | pack.json 内容（dict）或 None。用到 features、numbering、include_allow、include_deny、skeleton |
| include_allow / include_deny | 显式覆盖白名单；缺省取 pack，pack 为 None 时 allow=['sections/*.md']、deny=['*internal*'] |

- **从不抛业务异常**：语法问题、include 被拒、数据文件缺失都进 `doc.diagnostics`。只有源文件本身读不出（OSError）才抛。
- 无类型包时 features 全开且不拦代码块（code_blocks=None）；类型包显式写 false 的特性出现时报诊断。
- CLI：`python3 docmark_parse.py <运行目录> [--source doc.md] [--pack 包] [--json] [--resolved-out 文件]`；有 error 级诊断退出码 1。

## 2. Document 字段

行号一律是 **include 展开后正文 `doc.lines` 的 1 起行号**（与 qa-result issues.line 同口径）；`line_origin[行号-1]` 给出 (文件, 原文件行号)。

| 字段 | 类型 | 说明 |
|---|---|---|
| version | str | 解析器版本 |
| source_file、run_dir | str | 正文文件名；运行目录绝对路径（parse_text 可为 None） |
| raw、raw_lines | str、list | include 展开前正文 |
| text、lines | str、list | include 展开后正文；doc-render 原样写 out/<源名>.resolved.md（与旧渲染器逐字一致） |
| line_origin | list[(file, line)] | 每行来源 |
| title、title_line | str、int | 第一行 `# 标题`；缺失报 title-missing |
| headings | list[Heading] | §3 |
| blocks | list[Block] | 按文档顺序的**扁平**块流（§4）；summary、landscape、grid 用 start / end 标记块，块内元素带 in_summary、in_landscape、grid |
| tables | list[Block] | kind 为 table（Markdown）或 data（CSV 成功解析）的块，与 blocks 中同一对象 |
| figures | list[Block] | kind 为 figure（.mmd .dot .fig.json .svg）或 image（位图）的块 |
| code_blocks | list[Block] | kind=code |
| callouts | list | {kind, text, line, blocks}（kind 为 note / warn / tip / decision / risk） |
| lists | list | ul / ol 块（含高亮块内的列表，带 in_callout） |
| links | list | {text, url, line} |
| footnotes | dict | {id: {text, line, inline, section_number}}；footnote_refs：[{id, line}] |
| anchors | dict | 锚点表 §5 |
| refs | list | [{target: "fig:x", line, resolved}] |
| entities | dict | {kind: [{code, line, section_number, row, table_line, csv_line}]}：定义（§6） |
| entity_mentions | dict | {kind: [{code, line}]}：定义以外出现的编号（跨文档核对、覆盖率） |
| includes | list | [{target, line（展开后正文行号）, source_line（指令所在文件的行号）, file, status, depth, reason}]；status：ok / forbidden / missing / too_deep（parse_text 为 unresolved） |
| highlights | list | 重点高亮：[{line, text（纯文本，已去掉颜色前缀）, length（去空白字符数，不含前缀）, context: p / li / table / th / callout / caption / heading / footnote, kind: neutral / risk / tip / warn / decision}] |
| diagnostics | list[Diag] | §7 |
| features、numbering | dict | 生效的特性开关与编号设置（pack 覆盖缺省后） |

方法：

| 方法 | 返回 |
|---|---|
| section(key) | key 可为 skeleton_id、锚点（`sec:x` 或 `x`）、章节号（`7.1`、`A`）；返回 {heading, start, end, text, blocks} 或 None；end 为下一个同级或更高级标题的前一行 |
| errors() | severity 为 error 的诊断 |
| resolve_ref(target) | anchors 中的记录或 None |
| to_dict() | 可 JSON 序列化的字典（lines 只给行数） |

## 3. Heading

| 字段 | 说明 |
|---|---|
| level | 1–4（`##` 为 1 级，`#####` 为 4 级） |
| number | 自动编号：`1`、`1.2`；附录 `A`、`A.1`；numbering.section=none 或超过 max_depth 时为空串 |
| label | 引用与目录用：一级附录为「附录 A」，其余同 number |
| title | 显示标题：已去掉尾部 `{#…}` 属性块；**手写序号只有与自动编号完全相同时才去掉**（如「## 1. 摘要」自动编号也是 1），「附录 A：」前缀总是去掉并置 appendix |
| title_raw | 原样标题文字（T5 用） |
| manual_number | 识别到的手写序号（`1`、`7.1`、`附录 A`）或 None |
| plain、inline | 纯文本与行内节点 |
| line、anchor、classes | 行号；`sec:id` 等；属性块里的 `.xxx` |
| appendix | `.appendix` 或「附录 X」前缀；附录一级标题之下的子标题同为 True |
| skeleton_id | 按 pack.skeleton 的 `{#sec:<id>}`、title、aliases（去空白后相等）匹配到的章节 id |
| in_landscape | 是否在横向页段内 |

## 4. Block

公共字段：kind、line、section_number（所在最近标题的 number）、chapter（所在一级章节号或附录字母，首个标题之前为 "0"）、in_summary、in_landscape。

| kind | 其他字段 |
|---|---|
| heading | level、heading（headings 下标） |
| p | text（续行已拼接）、inline、end_line |
| ul / ol | items[{text, line, level 1–2, kind, inline}]；一个列表内两级混排，level 2 紧随其父项 |
| table / data | caption、anchor（tbl:x）、number（「表 3-2」，无表题且无锚点时为空串）、header[]、rows[[…]]、records[{列名: 值}]、header_inline、rows_inline、row_lines（正文行号；data 为指令行）、widths（列表或 None）、source（md / data）、data_file、landscape、groups、params |
| data 追加 | csv_lines（每行在 CSV 的行号）、records_full（CSV 全部列，不只 columns 选中的列）、groups[{value, count, start}]（start 为 rows 下标）；解析失败时 error=True 且不进 tables |
| figure / image | src、svg（build 后 SVG 的运行目录相对路径；位图为 None）、engine（mermaid / graphviz / svgkit / svg / image / unknown）、caption、caption_inline、anchor、number（「图 3-2」）、width_pct（10–100）、landscape、grid（在 grid 内时为 grid 序号） |
| grid | edge（start / end）、cols（2 或 3）、grid |
| code | lang、text、end_line |
| callout | callout（种类）、text、blocks（子块只有 p、ul、ol） |
| summary / landscape | edge（start / end） |
| pagebreak | — |
| footnote | id（定义位置；内容在 doc.footnotes） |

编号：图「图 章-序」、表「表 章-序」，模板取 numbering.figure / table（占位符 {chapter} {seq}，兼容 {章} {序}）；features.figure_numbers / table_captions 为 false 时不编号。

## 5. 锚点表 anchors

键 `kind:id`，值 {kind, id, number, line, label, target}：

| 来源 | kind | label（交叉引用渲染文字） | target |
|---|---|---|---|
| 标题 `{#sec:x}` | sec | 「3.2 节」；一级附录「附录 A」；无编号时为标题文字 | heading |
| 图 `{#fig:x}` | fig | 「图 3-2」（未编号时为图题） | figure |
| 表 `<!-- table: 题 {#tbl:x} -->`、数据块 id=tbl:x | tbl | 「表 5-1」 | table |
| 行内 `{#<实体>:id}`（段落、表格单元格等） | 类型包实体 kind | id 本身 | inline |

锚点重复只保留第一个并报 anchor-duplicate（X3）。引用 `@kind:id` 解析后在行内节点上带 resolved 与 label。

## 6. 编号实体 entities

按 pack.numbering.entities 的 pattern（fullmatch）：
- **定义**：任一表格（Markdown 或数据块）**首列**单元格完整匹配；或行内锚点 `{#kind:id}`。表格定义的 row 为该行 records（数据块用 records_full）。
- **提及**（entity_mentions）：段落、列表项、高亮块文字、表格非定义单元格里 search 到的编号（先去掉 `@kind:id` 引用）。
- unique / contiguous 的判定（S3）由 doc-qa 做；解析器不报。

## 7. 诊断 diagnostics

每条 {code, rule, severity: error / warning / info, line, message, …}。rule 是**建议归属**的质检规则编号，doc-qa 负责定级与去重；doc-render 不把诊断写进 qa-result（渲染器只写 render.json 的版式事实，避免双报）。

| code | rule | severity | 触发 |
|---|---|---|---|
| include-forbidden / include-missing / include-too_deep | L1 | error | 白名单外、include_deny、绝对路径或 ..、越界（含符号链接指向外部） / 文件不存在 / 超过 3 层（第 4 层原文插入不再展开，与旧行为一致）；line 为展开后行号，另带 file 与 source_line |
| grid-child | L1 | error | grid 内出现图以外的内容（渲染时按 grid 之前的正文输出，两端一致） |
| html-tag | L1 | error | 正文出现 HTML 标签（注释指令除外） |
| blockquote | L1 | warning | 普通 `> ` 引用（按段落处理，旧行为） |
| callout-kind | L1 | error | `[!xxx]` 种类不支持（按 note） |
| figure-ext / figure-path / figure-width / figure-attr / figure-trailing | L1 | error / warning | 图源扩展名、路径（含图源或派生 .svg / .png 经符号链接越出运行目录）、width、属性、行尾文字 |
| grid-invalid / grid-nested / grid-unopened / grid-unclosed | L1 | error | grid 标记 |
| summary-unbalanced / summary-unclosed / summary-duplicate / heading-in-summary | L1 | error | summary 块 |
| landscape-unbalanced / landscape-unclosed | L1 | error | 横向页段 |
| feature-disabled | L1 或 L9 | error | 类型包关掉的特性被使用（summary_block、landscape、footnotes、data_blocks），带 feature 字段 |
| list-depth | L1 | warning | 缩进超过两级 |
| title-missing | S2 | error | 没有 `# 标题` |
| title-duplicate | S2 | warning | 第二个 `# ` 行（按段落处理，与旧渲染器一致） |
| heading-skip / heading-depth / heading-empty | S2 | error | 跳级、超过 max_depth、空标题 |
| code-disabled / code-unclosed | L8 | error | features.code_blocks=false 时出现代码块 / 缺结束围栏 |
| code-no-lang | L8 | warning | 代码块未标语言 |
| widths-invalid / widths-count / directive-dangling | L7 | error / warning | widths 注释非法（同时清空之前挂起的 widths）、个数与列数不符（忽略）、注释与表格之间隔着其他内容或后面没有表格（丢弃注释） |
| table-no-separator / table-separator-position / table-shape / table-empty-header | L7 | warning | 第二行不是分隔行，或第二行形似分隔行但有空列、列数不等于表头（忽略该行）；分隔行出现在其他位置（忽略该行）；行列数不齐（补空或截断）；表头空列名 |
| data-args / data-param / data-id / data-widths / data-format / data-yaml / data-path / data-missing / data-empty / data-read / data-column / data-filter / data-filter-empty / data-no-rows / data-no-run-dir | L9 | error（data-param 为 warning，data-no-rows 为 info） | 数据块参数与文件；YAML 阶段 1 不支持 |
| anchor-invalid / anchor-duplicate / footnote-duplicate | X3 | error | 锚点写法、重复 |
| anchor-kind | X3 | error | 标题只收 sec:、图只收 fig:、表只收 tbl:；不符时丢弃该锚点（引用随之报 ref-unresolved） |
| ref-unresolved / footnote-missing | X1 | error | 引用不存在的锚点 / 脚注 |
| footnote-unused | X2 | info | 脚注未被引用 |
| inline-code | T9 | warning | 反引号（渲染时去掉反引号，旧行为） |
| highlight-unclosed / highlight-unopened / highlight-nested / highlight-multiline | HL1 | error | ⟪…⟫ 未闭合、缺开头、嵌套、跨行 |
| highlight-empty | HL1 | warning | ⟪⟫ 内容为空 |
| entity-pattern | S3 | error | 实体正则无法编译（line 0） |

HL1 是解析器侧编号：doc-qa 把 highlight-unclosed / unopened / nested / multiline 定为 H4 必改，highlight-empty 定为 H3 建议（qa-engine.md H1–H4）。

## 8. 行内节点

`inline` 字段是节点列表：

| t | 字段 | 说明 |
|---|---|---|
| text | v | 纯文字（未转义） |
| bold | c | `**…**` |
| highlight | c, kind | `⟪…⟫`；内部可含 bold、link、ref，不可含 highlight。非法的 ⟪ ⟫ 已被丢弃，**任何节点里都不会出现 ⟪ ⟫ 字符**。`kind` 为颜色变体：`neutral`（无前缀，默认）/ `risk`（`!`）/ `tip`（`+`）/ `warn`（`~`）/ `decision`（`?`），映射见 `docmark_parse.HL_PREFIX` 与 `HL_KIND_CALLOUT`；前缀字符已被消费，不在 `c` 里 |
| link | url、c、line | `[文字](url)` |
| ref | target、kind、id、line、resolved、label | `@kind:id` |
| fnref | id、line | `[^id]` |
| anchor | target、kind、id、line | 行内锚点 `{#kind:id}` 所在位置（1.3 新增）；不产生文字，渲染器据此发射书签或 id。同一锚点重复出现时每处都有节点，渲染器只在第一处发射 |

行内锚点 `{#kind:id}` 从显示文字中去掉，位置保留为 anchor 节点。`inline_plain(nodes)` 给纯文本（引用用 label）；`walk_inline(nodes)` 深度遍历。

## 9. 兼容性约定

- 旧语法（brand-layout.md 全表）零改动可解析：`> [!note] 文字` 单行、`<!-- grid: 2 -->`、`<!-- widths: … -->`、`<!-- include: … -->`、`<!-- pagebreak -->`、`![图注](figures/x.svg)`。golden 四份 proposal.resolved.md 解析无 error 级诊断（doc-render 自测断言）。
- 续行：拉丁字母或数字相邻时插入一个空格（新规则，docmark.md §4）；中文结果与旧渲染器相同。
- 反引号：去掉并报 inline-code。波浪号：解析器不改写（旧的 ~ → – 替换由 doc-render 的 legacy_tilde 选项承担）。
- 缩进列表项：旧渲染器当段落，新解析器为二级列表（有意差异）。
- 多行 HTML 注释整段跳过（旧渲染器只跳首行）。

## 10. 安全前提（威胁模型）

- **运行目录由单用户、单进程可信写入**：解析与渲染期间不应有其他进程改写运行目录。
- 路径校验是「先检查、后打开」：include、数据块、正文源文件、图文件在读取前做 path_safe 与 realpath 边界校验（拦截 ..、绝对路径、检查时已存在的外指符号链接）。检查与打开之间被并发替换为外指符号链接（TOCTOU）不在防护范围内；本实现**不**使用 openat / O_NOFOLLOW。这是已知限制，doc-shared/tests/test_docmark_parse.py 有说明性用例（标 KNOWN，不计失败）。
- 运行目录若要放在多人或多进程可写的位置，先复制到私有临时目录再解析与渲染。
- 飞书后端对图文件二次校验，越界时不写 path（发布端按 path 上传文件）。
