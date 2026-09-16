# 版式规范

数值一律来自 brand/tokens.json（生成物 brand/generated/tokens.css）；本文件只写规则与实现要点，不重复数值以外的第二份色值。陈述分三类：**已验证**（本机实测过）、**设计**、**未验证**。

## 1. 页面

| 项 | 规范 |
|---|---|
| 纸张 | A4 纵向；页边距 上 20 / 左右 14 / 下 18 mm；版心宽 182 mm |
| 横向页段 | `<!-- landscape -->` 段内 A4 横向，版心宽 269 mm；段前段后自动分页（设计；Chrome 对同一文档混排纵横页的打印行为未验证，1b 实测，不行则退化为宽表自动缩字号） |
| 正文 | 10.5 pt，行高 1.7，字体 PingFang SC 优先 |
| 标题 | 一级 16.5 pt 主色下划线；二级 13 pt 深主色；三级 11 pt |

## 2. 封面（两种变体，由品牌档案决定，类型包 cover 可覆盖）

**marketing**（brand/profiles/cyberklick.json，对外）：
- 元素自上而下：logo（透明底，高 14 mm）→ 标题（28 pt）→ 副标题（doc.json cover.subtitle）→ 元信息（对象、版本、日期、cover.meta 各行）→ 类型包提供的封面徽标文字（可空）→ 底部官网。
- 标题断行：标题容器加 `text-wrap: balance`，避免第二行只剩两三个字（MOBYVOW 第 1 页问题；Chrome 114 起支持 balance，打印时是否生效未验证）。无效时渲染器按字数在标题中点附近的词边界插入换行。
- logo 用 brand/org/eclicktech-logo-transparent.png（修 MOBYVOW 第 1 页白底矩形）。透明底版本只适合浅底。

**technical**（brand/profiles/internal.json，对内）：
- 紧凑标题块：文档类型名（类型包 name）、标题、副标题。
- 文档控制表：文档编号（doc_no）、版本、状态、Owner、评审人（名字与结论）、日期、密级（品牌档案 classification）。
- 无营销语、无渐变底。

**封面不印页眉页脚**（decisions ⑩A）：
- 已验证：@page :first 设 margin 0 仍会印出页眉；封面与正文分开打印后用 pdfunite 合并，书签从 2 个变 0 个。
- 做法：封面单独打印（displayHeaderFooter=false），正文单独打印（带页眉页脚与书签），用 doc-render 专用 venv 的 pypdf 6.18.1 合并，并按正文书签的页码整体 +封面页数 重建书签（设计；书签重建逻辑未验证，1b 自测必须断言合并后书签数 = 合并前正文书签数）。
- 页码：正文页脚「页码 / 总页数」从正文第 1 页起算还是含封面，由品牌档案决定；默认**含封面**（与旧 PDF 一致，golden 页数口径不变）。正文单独打印时 Chrome 的 pageNumber 从 1 起，需要把封面页数作为偏移注入页脚模板（设计，未验证）。

## 3. 修订记录与摘要页

- 修订记录页：品牌档案 revision_page 为 true 时，封面后第 1 页；表格列：版本、日期、作者、变更摘要；数据来自 doc.json revision_history，按版本倒序。
- 执行摘要页：`<!-- summary -->` 块存在时独占一页，排在修订记录之后、目录之前。

## 4. 目录与书签（decisions ⑫A）

- 两级（一级、二级标题），带页码，点击跳转。
- **两遍打印**：第 1 遍打 PDF → 定位每个标题所在页 → 回填目录页码 → 第 2 遍打印。回填后页码位数变化可能再次改变分页：第 2 遍后再定位一次，不一致则再回填，最多 3 遍，仍不一致时 render.json 记 LY1 必改。
- **标题定位推荐做法**（设计，比按标题文字匹配稳）：第 1 遍 HTML 在每个标题前插入不可见唯一标记串（如 `⟦h017⟧`，白色 1 pt 文字），pdftotext 按页找标记；第 2 遍去掉标记。备选：按标题文字从目录页之后顺序匹配，同名标题靠顺序消歧。
- 书签：printToPDF 传 generateDocumentOutline（已验证 Chrome 152 生成 /Outlines）。书签层级 = 标题层级；书签数应等于一、二、三级标题总数（LY2）。

## 5. 页眉页脚

| 位置 | cyberklick | internal |
|---|---|---|
| 页眉左 | logo（高 6 mm） | logo |
| 页眉右 | 官网 | 文档标题 |
| 页脚左 | tokens brand.footer_text：`{brand} · {party} · v{version} · {website}` | `{brand} · {classification} · {title} · v{version}` |
| 页脚右 | `{page} / {pages}` | 同左 |

占位符：{brand} {website} {logo} {title} {subtitle} {version} {date} {party}（doc.json client，缺省 project）{classification} {doc_no} {status} {page} {pages} {footer_text} {disclaimer}。字号 tokens size.header_footer（6 pt，即旧模板的 8 px）。

文末声明：品牌档案 disclaimer 不为 null 时在正文末尾输出一行；具体声明文字由类型包提供（引擎不写任何业务声明）。

## 6. 表格

| 项 | 规范 |
|---|---|
| 表头 | 必有 thead，跨页重复（已验证 Chrome 打印 thead 跨页重复）；表头底色 surface |
| 表题 | 表格上方，左对齐，「表 3-2 表题」，9 pt |
| 列宽 | 有 widths 按权重；无 widths 时估算：每列权重 = clamp(max(表头字数, 该列单元格字数的 80 分位), 4, 40)，再归一化 |
| 宽表 | 超过 6 列（tokens table.dense_columns_over）自动用 table_dense 8.5 pt；类型包开了 landscape 且放在横向页段内则用横向版心 |
| 断行 | 行不跨页断开（tr break-inside: avoid）；表格本身可跨页 |
| 单元格 | 内边距 1.6 / 2 mm，顶端对齐；长段落拆分（T10） |

## 7. 图

| 项 | 规范 |
|---|---|
| 宽度 | 默认占版心宽；`width=60%` 按比例 |
| 等效字号 | **不低于 7 pt**：等效 pt = 图内最小 px × 显示宽 mm ÷ viewBox 宽 × 72 ÷ 25.4；显示宽 = 182 mm × 宽度比例。低于 7 pt 必改（LY4）。校核：architecture.svg 最小 17 px、宽 1200 → 7.31 pt；MOBYVOW 信息架构图 12 px、宽 1180 → 5.25 pt（与 assessment「印出约 5–6 pt」一致）。命令：tokens.py --equiv-pt PX WIDTH |
| 图题 | 图下方居中，「图 3-2 图题」，9 pt，muted 色；图内不再写与图题重复的大标题（MOBYVOW 第 7、15 页问题） |
| 每页数量 | 一页最多两张图（LY5 建议） |
| 断页 | 图不断开 |
| 位图 | 截图最大高度为版心高的 60%；嵌入前按显示尺寸 2 倍像素降采样（控制 PDF 体积；MOBYVOW 3 张截图原图嵌入导致 7.8 MB）（设计） |

## 8. 其他块

- 高亮块：背景与左边框色来自 tokens callout；圆角 2 mm；五种 note、warn、tip、decision、risk。
- 代码块：等宽 8.5 pt、行高 1.45、surface 底；右上角标语言；不超过一页时不断开。
- 列表：最多两级；二级缩进 6 mm。
- 签字区等固定版式块由类型包模板提供，引擎只保证块不断开。

## 9. 分页

- 标题与其后第一个块不分离（break-after: avoid）。
- 表格行、图、代码块（短于一页）不断开。
- 一级标题分页 h1_page_break：always（一级标题一律新页起）/ auto（上一章末页剩余不足约三分之一时才换页，避免稀疏页）/ never。优先级：类型包 features.h1_page_break → 类型包 features.h1_new_page 显式布尔（旧字段，true=always、false=never，null 跳过）→ 品牌档案 h1_page_break → 按封面（technical 为 auto，marketing 为 never 以保持旧版页数）。internal 档案为 auto，cyberklick 为 never。
- 孤行寡行：正文段落 orphans / widows 2（CSS；Chrome 打印是否完全遵守未验证）。

## 10. 编号

| 对象 | 规则 | 声明处 |
|---|---|---|
| 章节 | 1 / 1.1 / 1.1.1，最深由 numbering.max_depth 决定（默认 3，最多 4）；附录 A、A.1 | 类型包 numbering |
| 图 | 「图 章-序」，章 = 所在一级章节号（附录为字母），序在章内递增 | numbering.figure 模板 |
| 表 | 「表 章-序」 | numbering.table 模板 |
| 业务实体 | 类型包 numbering.entities：label、prefix、pattern、是否唯一、是否连续（例如需求、测试项的编号） | 类型包 |

## 11. PDF 元数据与文件名

- 元数据：Title = 文档标题；Author = doc.json owner（对外文档可写品牌名，由品牌档案决定）；Subject = 类型包 name；Keywords = project、type、version；Creator = doc-render 版本。旧 PDF 只有 Title（assessment §4.3）。
- 文件名：类型包 filename 模板。占位符 {project} {client} {title} {name}（类型包 name）{type} {version} {yyyymmdd} {date}。文件名里的 `/`、`:` 等替换为「-」。

## 12. render.json 版式检查（doc-render 写入 layout_issues）

| 编号 | 检查 | 定级 |
|---|---|---|
| LY1 | 目录项缺页码，或回填 3 遍后页码仍不稳定 | 必改 |
| LY2 | 书签数 ≠ 一至三级标题数 | 建议 |
| LY3 | 表格没有 thead | 必改 |
| LY4 | 图等效最小字号 < size.figure_min（7 pt） | 必改 |
| LY5 | 同一页超过两张图 | 建议 |
| LY6 | 封面页出现页眉或页脚文字（pdftotext 第 1 页检出页脚模板文字或页码） | 必改 |
| LY7 | 表格或图超出版心宽度 | 必改 |
| LY8 | 一级标题位于页面最后 15% 且其后无内容（标题孤悬页底；用第 1 遍定位结果判断，未验证可测性） | 建议 |
| LY9 | 稀疏页：正文区字符数低于阈值（默认 400，render.py --sparse-chars 可改）。不计前置页、全文末页、有图页、自然结束的章末页；被一级标题强制换页截断的章末页仍计 | 建议 |
| LY10 | 正文一、二级标题与引擎自动生成的前置页（修订记录 / 文档控制 / 摘要 / 执行摘要）同名或同义，内容重复 | 建议 |

同一张图 doc-figures 的 review.json 与 render.json 都报字号不足时，以 render.json（按实际显示宽计算）为准。

## 13. docx 输出读回校验（doc-render --docx 写入 render.json docx.readback 与 layout_issues）

第三波 W3-D1 登记（2026-09-15）。docx 交付规范来自《Shopify 建站方案 SKILL v1.5.0》§8，配色与字号沿用 tokens（㉕A）。readback.ok 表示没有必改级失败，readback.all_passed 表示含建议级在内全部通过。写完 docx 后分三层核验：ZIP + lxml 核对精确 XML，python-docx 核对对象模型，LibreOffice 转 PDF 核对真实客户端（未安装时 docx.readback.soffice 为 null，render.py 输出 warnings）。

| 编号 | 检查 | 定级 |
|---|---|---|
| DX1 | 标题段落数与层级序列不等于解析器 headings（Word 内置 Heading 1–4 样式），或标题文字（含编号）不一致；可见书签集合不等于一至三级标题（四级标题、图、表、实体锚点的链接目标用 `_` 开头的隐藏书签） | 必改 |
| DX2 | 内容表数不等于解析器 tables；表格缺种类样式标记（DM Table 等）；启用 thead_repeat 时首行缺「标题行重复」（tblHeader）；有行缺 cantSplit | 必改 |
| DX3 | 内容表不满足列宽自适应三件套（tblLayout=autofit、tblW=auto、无 tcW，§8）；或初始网格 tblGrid 不等于 common.table_widths × 当前版心宽（总宽误差 > 2% 或单列比例误差 > 1%） | 必改 |
| DX4 | 正文图片数与嵌入统计不符；或有图未嵌入（doc-figures 未产出 figures/<名>.png、位图不存在或格式无法转换） | 必改 |
| DX5 | 页眉或页脚不是 1 行 2 列、fixed 布局、无可见边框的表格；页脚模板含 {page} / {pages} 却缺 PAGE / NUMPAGES 域；页眉页脚表的 tblW、tblGrid 总宽、首行 tcW 总宽不等于该节版心宽（页宽减左右页边距，误差 > 3 twips；横向节同样逐节比较）；首节未设首页不同或封面首页页眉页脚不为空 | 必改 |
| DX6 | 正文、页眉页脚、脚注里残留 ⟪ ⟫、HTML 注释、行内锚点 {#kind:、脚注标记 [^id]、高亮块标记 [!kind]（代码块段落除外） | 必改 |
| DX7 | 核心属性 Title / Author / Subject / Keywords 有空，或任一项不等于 §11 PDF 元数据口径（common.doc_metadata，逐项精确比较） | 必改 |
| DX8 | 目录域缺失、条目数不等于目录标题数或缺 updateFields（打开时提示更新域）；内部链接没有书签目标；任一已解析的交叉引用（doc.refs，含实体锚点）在正文或脚注里没有指向其书签的内部链接，或书签不存在；原生脚注的引用、正文、footnoteRef 数与被引用脚注数不一致或再次引用未用 NOTEREF；重点高亮组数不一致；横向节数或纸张方向不符；LibreOffice 转出的 PDF 有空白页（只剩页眉页脚，docx.readback.soffice.blank_pages） | 建议 |
| DX9 | docx 无法重新打开；或 LibreOffice 转 PDF 失败、页数少于 2、横向页与横向节不一致、转换后找不到标题文字、缺 pdffonts 无法核验字体、转出文字含中文却没有嵌入中文字体 | 必改 |

实现取舍：
- 列宽：§8 要求交给 Word 自适应，common.table_widths 只作为 tblGrid 初始网格；Word 与 LibreOffice 的最终列宽可能不同，DX3 只断言生成的 XML，不断言视觉列宽。
- 一级标题分页：always 写 pageBreakBefore；auto 与 never 在 docx 里都不强制分页（Word 自行排版，无定位遍）。
- 目录页码由 Word 打开时更新域生成；LibreOffice 转换时 PAGEREF 由其自行计算。
- 重点高亮用 tokens tint 底色 + 加粗（run 底纹），不用 §8 的黄色 highlight。
- 脚注为原生脚注（word/footnotes.xml），同一脚注再次引用为 NOTEREF 域。
