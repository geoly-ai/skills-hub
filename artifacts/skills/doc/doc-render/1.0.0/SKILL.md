---
name: doc-render
description: 专业文档生产体系（doc-*）的渲染引擎：把 DocMark 正文（doc.md / proposal.md）渲染为品牌 HTML、PDF（Chrome CDP，两遍打印回填目录页码、书签、封面无页眉页脚、页眉页脚与元数据）、飞书 XML 与 Word docx（--docx，读回校验 + LibreOffice 转换核验），并写 out/render.json 版式检查（LY1–LY8）。用户要把 PRD、MRD、技术 Spec、API 参考、测试计划、测试用例、测试报告等 doc-* 文档「出 PDF」「出 Word / docx」「生成飞书版」「渲染」「看版式预览」「检查目录页码、书签、表头、图字号」时使用；doc-orchestrator 在 D3 前调用。只改飞书文档不需要 PDF 时走 lark-doc；售前方案的入口仍是 presales-publish（1f 迁移后内部调用本引擎）。
---

# doc-render（渲染引擎）

开工前读 doc-shared（契约层）：references/docmark.md（语法）、docmark-ast.md（解析结果）、layout.md（版式与 LY 规则）、feishu.md（飞书约束）、artifacts.md §6（render.json）。本 skill 不定规则，只实现。

## 职责

| 做 | 不做 |
|---|---|
| 调 doc-shared/scripts/docmark_parse.py 解析正文（与 doc-qa 同一个解析器），写 out/<源名>.resolved.md | 不写 qa-result.json；解析诊断由 doc-qa 转成质检问题 |
| HTML：tokens.css + 引擎 CSS；封面 marketing / technical（文档控制表）；internal 修订记录页；摘要页；两级目录带页码；图表编号与交叉引用；表格一律 thead；宽表缩字号或横向页段 | 不画图：.mmd / .dot / .fig.json 的 SVG 由 doc-figures build；本引擎只读 figures/ 下已构建的 .svg、加 id 命名空间、内联、算等效字号 |
| PDF：定位遍回填目录页码（最多 3 遍）→ 终遍（页眉页脚、Chrome 书签）→ 封面单独打印 → pypdf 替换封面页、按标题重建书签、写元数据 | 不发布飞书（doc-publish）；不改 run-state 的门（只 set-stage render） |
| 飞书 XML：标题 seq=auto、表格 thead + colgroup、callout 配色映射、whiteboard（Mermaid 给源、其余给 SVG）、代码块、链接、重点高亮 | |
| docx（--docx）：Word 内置 Heading 1–4、TOC 域（打开提示更新）、表格标题行重复与列宽自适应（§8）、横向节、doc-figures PNG、原生脚注、两列无边框页眉页脚、核心属性；写完读回校验 DX1–DX9（layout.md §13） | |
| out/render.json：页数、书签数、目录页码、图表编号表、每图等效最小字号、宽表、layout_issues（LY1–LY10、DX1–DX9 按 layout.md §12 §13）、docx 段 | |

## 命令

```sh
python3 ~/.claude/skills/doc-render/scripts/render.py <运行目录> [--printer cdp|none] [--profile internal|cyberklick] [--pack <类型包目录>] [--no-feishu] [--docx | --no-docx] [--legacy-tilde] [--legacy-widths-px] [--keep-work] [--no-state] [--sparse-chars N]
```

- 自动切到 doc-render/.venv 的 Python（pypdf 6.18.1；docx 另需 python-docx 1.2.0 与 lxml，见 requirements.txt）；LibreOffice 可选（docx 转换核验，没有时 readback.soffice 为 null 并在 warnings 说明「未做客户端核验」；自动生成 fonts.conf 把系统字体目录交给 headless soffice，否则中文字形不可见）；Node 18+、Chrome、poppler（pdftotext、pdftoppm）；ImageMagick 可选（位图与 logo 降采样）。
- Chrome 路径：DOC_RENDER_CHROME / CHROME_PATH / CHROME_BIN → 常见安装路径 → PATH。
- 类型包：--pack → DOC_TYPES_DIRS → doc-shared/types/<type>/；找不到时按缺省特性渲染并在输出 warnings 里说明。
- docx 默认输出：--docx / --no-docx > 类型包 outputs（pack.schema，只收 docx）> 品牌档案 outputs > 不输出。文件名 = 类型包 filename 模板换扩展名 .docx。
- 迁移期开关：--legacy-tilde（~ → –）、--legacy-widths-px（飞书列宽 widths 全部 ≥ 20 时按像素原样；缺省一律按权重归一化）只给售前迁移包保 golden 用。
- 退出码：0 完成且无版式必改；3 完成但 layout_issues 有必改；1 拒绝或失败（include 越权或缺失、图片或数据路径越界、类型包禁用的块出现（code-disabled、feature-disabled）、pre_render 钩子失败、打印失败、render.json 不合 schema）；2 用法错误。其他解析错误（如交叉引用不存在）照常出预览，由 doc-qa 定级。
- 产物：out/<源名>.html、out/<类型包 filename 模板>.pdf、out/<同模板>.docx（--docx）、out/feishu.xml、out/render.json、out/<源名>.resolved.md、out/render.highlights.json（render.schema 加 highlights 字段之前的旁路文件）。

单独打印（调试）：`node scripts/print_pdf.mjs job.json`，或 `--stdio` 常驻模式（render.py 用这个，一个 Chrome 进程处理全部打印）。

## 模块（后端无关的结构）

| 文件 | 作用 |
|---|---|
| scripts/render.py | CLI 编排：上下文 → pre_render 钩子 → 解析 → 图预处理 → 各后端 → render.json → run_state set-stage |
| scripts/common.py | Ctx（doc.json、类型包、品牌档案、tokens、占位符、id 映射、脚注编号、列宽估算、文件名）；所有后端只读 Ctx 与 Document |
| scripts/svgtools.py | SVG id / class / url(#) / href / style 命名空间；图内最小字号（属性、style、<style> 规则、继承） |
| scripts/backend_html.py | HTML 后端与页眉页脚模板 |
| scripts/pdf.py | 打印客户端、定位标记、pdftotext 核对、pypdf 合并、LY1 LY2 LY5 LY6 LY7 LY8 |
| scripts/backend_feishu.py | 飞书 XML 后端（图文件二次越界校验） |
| scripts/backend_docx.py | docx 后端：build_docx(ctx, out_path) -> stats；readback(ctx, path, stats)；soffice_check(ctx, path, stats, work_dir) |
| scripts/print_pdf.mjs | Chrome CDP 打印器（参数化，无业务文案） |

**docx 后端（第三波 W3-D1 已实现）**：scripts/backend_docx.py，`build_docx(ctx, out_path) -> stats`，只读 `ctx`（common.finish_context 之后，含 render.py prepare_figures 的 fig_info）与 `ctx.doc`；列宽 common.table_widths 只写 tblGrid 初始网格（§8 自适应三件套），编号用 block number 与 common.heading_label；render.py 在飞书段之后调用，render.json docx 段 = 统计 + readback（ok = 无必改级失败，all_passed = 含建议级全部通过）。书签：一至三级标题为可见书签，四级标题、图、表、行内实体锚点 `{#kind:id}` 为 `_` 开头的隐藏书签（HTML 为 `ent-` id）。取舍：一级标题 auto / never 在 docx 里都不强制分页；已知 LibreOffice 版式差异：`<!-- pagebreak -->` 之后紧跟标题再进入横向页段时，LibreOffice 在标题前多排一张空白页（去掉该标题的 pageBreakBefore 即消失；Word 行为未验证，引擎未改）；目录页码由 Word 打开时更新域；重点高亮用 tokens tint 底 + 加粗（不用 §8 的黄色）；字体取 tokens 首选（PingFang SC / Inter），Windows 上由 Word 替换字体，未做字体嵌入。

## 衔接

| 上游 / 下游 | 约定 |
|---|---|
| doc-shared | 解析器 scripts/docmark_parse.py；schemas/render.schema.json；brand/generated/tokens.css、feishu-callouts.json；tokens.py equiv_pt；run_state.py set-stage render |
| doc-figures | 渲染前 build：figures/x.mmd → figures/x.svg（.dot、.fig.json 同名 .svg）。缺 SVG 时 PDF 放占位框并记 LY4 必改 |
| doc-qa | 读 out/render.json layout_issues（不重复报版式）；与本引擎共用解析器，resolved.md 内容一致 |
| doc-publish | 读 out/feishu.xml（path 相对运行目录）与 render.json feishu 统计做回查 |
| doc-orchestrator | D3 前调用；退出码 3 表示有版式必改 |

## 版式要点（数值来自 tokens，规则见 layout.md）

- 封面：technical = logo + 密级徽标 + 类型名 + 标题（text-wrap: balance）+ 文档控制表（thead）；marketing = 透明底 logo（打印用降采样副本）+ 标题 + 副标题 + 元信息 + 徽标文字 + 官网。封面不印页眉页脚（替换封面页内容流，页码仍含封面）。
- 页眉左 logo 右标题（或官网，按品牌档案）；页脚左模板文字，右「页码 / 总页数」。
- 表格：thead 跨页重复；tr 不断开；≤ 8 行的表整体不断开（签字块等固定版式块）；无 widths 时按内容估列宽并保证每列不窄于 12 mm；> 6 列用 table_dense 字号；横向页段用 A4 横向命名页。
- 标题：break-after: avoid。一级标题分页 always / auto / never：类型包 features.h1_page_break → features.h1_new_page 显式布尔 → 品牌档案 h1_page_break → technical 封面 auto、marketing 封面 never（旧渲染器不分页，golden 页数不变）。auto：定位遍里一级标题落在页面 65% 以下，或上一章以跨页的表或图结束时才换页。
- 书签覆盖一至三级标题（layout.md §4，固定，品牌档案写 bookmark_levels 其他值时退出码 2），目录只到品牌档案 toc_levels（两级）。
- auto 分页为固定点：每遍按上一章结束处（定位标记 e<i>，绝对定位、不占版面）算出期望的 break 集合，只改文档顺序上第一个与当前不同的判定（可加可撤），其后标题的判定留到下一遍；检测到循环时取并集；遍数上限随一级标题数增加；最后一遍又改了 break 时强制再定位一遍，目录页码不再变化即视为稳定。
- LY9：以手工分页（<!-- pagebreak -->，定位标记 p<n>）结束的页不算自然章末；LY10 按受控别名（修订记录、文档控制、文档控制与修订记录、摘要、执行摘要）规范化后整串匹配；目录里的高亮不计数。
- 安全：正文源文件、include、数据块、图文件（含 build 产物 .svg / .png）都做 realpath 边界校验；运行目录由单用户单进程可信写入（TOCTOU 为已知限制，docmark-ast.md §10）。
- 表格单元格：≥ 12 字符的标识符只在 _ - / . : 之后断行；≤ 24 字符的编号类单元格不断行；无分隔的超长串才强制断开。
- 图：「图 章-序」图题在下；「表 章-序」表题在上；等效最小字号 < 7 pt 为 LY4 必改。

## 视觉回归（PDF 逐页像素比较，2026-09-15 W3-G）

```sh
python3 ~/.claude/skills/doc-render/scripts/visual_regress.py <pdf> --baseline <基线目录> [--out <热图目录>] [--threshold 0.005] [--dpi 60] [--tolerance 32]
python3 ~/.claude/skills/doc-render/scripts/visual_regress.py <pdf> --baseline <基线目录> --update-baseline [--dpi 60]
```

- 做法：pdftoppm 逐页栅格化，与基线目录 page-001.png… 逐像素比较；任一通道差 > tolerance（默认 32，吸收抗锯齿）计差异像素，差异比例 = 差异像素 / 页面像素，超过 threshold（默认 0.5%）该页失败。页面尺寸变化按并集画布计并直接判失败；页数变化时多出或缺少的页记比例 1.0、失败。
- 热图：只给有差异的页写 <out>/page-NNN.diff.png（基线灰度淡化作底，差异标红，尺寸变化区域标黄）；默认目录为 PDF 同目录 visual-diff/，每次比较前清掉旧热图。
- 结果：stdout JSON {ok, page_count{pdf, baseline, changed}, pages[{page, status: same / diff / fail / added / removed, diff_pixels, diff_ratio, size_changed, bbox, heatmap}], failed_pages, warnings}。status diff 表示有差异但未超阈值：只改一个字（不重排）通常只有几十到几百个差异像素，不会判失败，要更严调低 --threshold。
- 退出码：0 通过或基线已更新；3 有失败页或页数变化；2 用法错误、缺 Pillow 或 pdftoppm、基线缺失或损坏。缺 Pillow 时自动切到 .venv（requirements.txt 已含 Pillow）。
- 基线：baseline.json 记 dpi、页数、每页尺寸、PDF sha256、tolerance、pdftoppm 与 Pillow 版本；比较时 dpi 以基线为准。--update-baseline 覆盖 PNG 并删除多余旧页。Chrome、字体、poppler 升级都会改变像素：基线变化要人工看热图确认后再 --update-baseline。
- 平台基线：~/workspace/docs/doc-skill-platform-2026-09-15/golden/visual/<prd|tech-spec|test-cases>/，由自测第 4 节同一渲染流程（样张副本 + 占位 SVG）生成：`run_tests.py --update-visual-baseline`；平时 run_tests 逐份比对。

## 自测

```sh
python3 ~/.claude/skills/doc-render/tests/run_tests.py            # 解析器正反例 + golden 兼容 + 三份样张渲染与断言
python3 ~/.claude/skills/doc-render/tests/run_tests.py --quick    # 跳过 PDF 渲染
python3 ~/.claude/skills/doc-render/tests/run_tests.py --docx-previews <目录>   # 另把 docx 经 LibreOffice 转出的页面导出 PNG
python3 ~/.claude/skills/doc-render/tests/run_tests.py --update-visual-baseline   # 用第 4 节三份样张 PDF 重建 golden/visual 基线（人工看过热图后才用）
```

覆盖：docmark 全语法正反例（doc-shared/tests/test_docmark_parse.py）；golden 四份 proposal 解析无 error；prd、tech-spec、test-cases 样张出 HTML + PDF + XML，断言表格都有 thead、书签数 = 二级以内标题数、目录页码与 pdftotext 实际页一致、封面无页眉页脚（文字 + 像素带）、render.json 过 schema、飞书 XML 过 lark-cli docs +script parse（去代理，本地，不发布）、输出无 ⟪ ⟫ 残留；docx（全块夹具、三份样张、golden smoke-site marketing 封面）独立核对标题 / 内容表与标题行重复 / 图片 / 页眉无边框 / 核心属性 / TOC 域 / LibreOffice 转换与中文字体嵌入，缺 PNG 报 DX4、类型包 outputs 默认输出；1b 验收回归（源文件与图文件符号链接越界、飞书二次校验、飞书列宽按权重与迁移开关、LY10 写死期望、目录高亮、书签层级、飞书长标识符无 <wbr>、always / never / auto 每个一级标题位置、手工分页 LY9）；LY4 小字号与未构建反例；include 越权退出码 1；run-state set-stage；引擎业务词守卫。

## 复核状态

见交付汇报；未经 Codex 复核的部分在汇报「遗留」里逐条列出。
