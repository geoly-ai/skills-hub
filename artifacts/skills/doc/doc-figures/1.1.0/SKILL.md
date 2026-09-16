---
name: doc-figures
description: 专业文档生产体系（doc-*）的图表引擎：把运行目录 figures/ 下的图源（Mermaid .mmd、Graphviz .dot、svgkit 品牌模板 .fig.json、成品 .svg、位图）渲染成 PDF 用 SVG 与 PNG 预览，Mermaid 源同时交飞书画板；做画板约束 lint、whiteboard-cli 检查、等效最小字号（≥ 7pt）、宽高比、Chrome 实测越界与重叠，写 figures/review.json。模板含分层架构 layered-arch（architecture.svg 风格）、泳道 swimlane、对比矩阵 compare-matrix、里程碑 milestone、覆盖矩阵热图 coverage-heatmap、阶段 / 阶梯 phases、漏斗 funnel、站点结构 sitemap。用户要给 PRD、技术 Spec、测试计划等 doc-* 文档画架构图、流程图、时序 / 状态 / ER / 甘特、质量门阶梯图，要「图出 PDF 高清且飞书可编辑」「检查图字号、越界、画板能不能解析」，或 doc-render 需要图产物时使用。开工前先读 doc-shared（figures-policy.md、layout.md §7、feishu.md §3）。
---

# doc-figures（图表引擎）

规则、数值、路由原则在 doc-shared：references/figures-policy.md（路由、检查、品牌图风格、review.json、.fig.json schema 定稿）、layout.md §7（等效字号公式）、feishu.md §3（画板约束）；颜色与字号只读 brand/generated/svg-palette.json、mermaid-theme.json 与 brand/tokens.json。本 skill 不复制数值。

质量基准：~/workspace/docs/doc-skill-platform-2026-09-15/architecture.svg（1200 宽画布，字号 30 / 22 / 19 / 18 / 17 五档，分组容器 + 圆角卡片 + 正交箭头 + 底部图例）。

## 1. 职责与边界

| 做 | 不做 |
|---|---|
| 图源 → SVG（PDF 用）+ PNG 预览；Mermaid 源（必要时预处理后的 .resolved.mmd）交飞书 | 写 figures/ 以外的文件；渲染 PDF / 飞书 XML（doc-render）；质检正文（doc-qa）；发布（doc-publish） |
| 机器检查写 review.json machine 部分；保留 human 部分 | 替主代理填人工看图结论（human 留空待填） |
| 提供 lint 库函数（画板约束、字号、id 命名空间）给 doc-render / doc-qa | 改 vendor/ 与 mermaid 拉取地址／哈希（升级流程见 vendor/VERSIONS.md） |

## 2. 默认引擎与备选（figures-policy §3 路由表的实现）

| 图 | 默认 | 备选 | 说明 |
|---|---|---|---|
| 流程图（含判断） | Mermaid flowchart | svgkit swimlane | > 4 节点线性流程加 `%% doc-figures: stairs` 改阶梯式 |
| 架构图（分层 / 部署） | svgkit layered-arch | Graphviz | |
| 时序图 | Mermaid sequence | — | build 自动给消息与分支条件文字加衬底、长条件按标点预断行 |
| 状态图 | Mermaid stateDiagram-v2 | Graphviz | |
| 阶段 / 里程碑 / 质量门阶梯 | svgkit phases、milestone | Mermaid（stairs 生成器，飞书可编辑版） | |
| 甘特 | Mermaid gantt | svgkit milestone | 刻度实测不重叠，重叠自动放大 tickInterval |
| 数据模型 | Mermaid erDiagram | Graphviz record | ER 图很窄：按 suggested_width_ratio 缩小显示 |
| 依赖 / 模块关系 | Graphviz .dot | — | |
| 覆盖矩阵 / 对比矩阵 | svgkit coverage-heatmap / compare-matrix | 数据表 | 行列多时优先数据表 |
| 缺陷趋势（柱 + 线） | Mermaid xychart-beta | 数据表 | **不做 svgkit 模板**：xychart 已覆盖柱 + 线 + 轴标题，两端原生；本机实测字号可调到 17px、无 foreignObject；飞书画板 whiteboard-cli 可解析（见 §6） |
| 定位象限 | Mermaid quadrantChart | compare-matrix | |
| 漏斗、站点结构 | svgkit funnel / sitemap | — | |

## 3. CLI

```sh
S=~/.claude/skills/doc-figures/scripts
python3 $S/build.py <运行目录> [--only 名称[,名称]] [--no-png] [--no-wb] [--jobs 4]   # 退出码 0 无必改 / 1 有必改 / 2 参数错误
python3 $S/figures.py <spec.fig.json> <out.svg> [--png]      # 单张 svgkit 图（兼容旧用法 figures.py <模板> <spec> <out>）
python3 $S/lint.py <x.svg|x.mmd> [--width-ratio 0.6] [--landscape] [--flow] [--no-wb]
python3 $S/build.py --regen-metrics                           # 换字体或 Chrome 大版本后重测字宽
```

图源内选项：Mermaid 写 `%% doc-figures: width=0.6 landscape aspect=off stairs rows=2`；DOT 写 `// doc-figures: width=0.6`；.fig.json 用 `"display": {"width_ratio": 0.6, "landscape": false}` 与 `"aspect_check": "flow" | "off"`。

## 4. 产物与给 doc-render 的接口

| 产物 | 说明 |
|---|---|
| figures/x.svg | PDF 用。所有 id 已加 `fig-<名>-` 前缀（成品 .svg 不改写）；有 viewBox 与 px 宽高；无 style 元素（Mermaid 的 CSS 已内联为属性） |
| figures/x.png | Chrome 截图预览（2 倍像素），自查用 |
| figures/x.resolved.mmd | 仅当预处理改了源码时生成；飞书端用 review.json 里 `feishu.path` 指向的文件 |
| figures/review.json | 见下 |

review.json 每项：`file, source, engine (mermaid|graphviz|svgkit|svg|bitmap), png, feishu {type: mermaid|svg|img, path}, machine {...}, human {checked_at, checked_by, issues}`。
machine 字段：`checked_at, engine_version, template, diagram, board_lint_applies, board_lint[], whiteboard_check {errors, warnings, summary, issues} | {skipped}, render_check {text_overflow, text_overlaps, outside_canvas}, viewbox_width, viewbox_height, min_font_px, min_font_pt（按 display_width_ratio）, display_width_ratio, suggested_width_ratio（= min(1, viewBox 宽 / 1200)，窄图不必撑满版心）, aspect_ratio（高 ÷ 宽）, mermaid {diagram_type, foreign_objects, removed_styles, removed_filters, text_overlaps, hyphenated}, gantt {attempts, tick_interval, tick_overlaps}, notes[], issues[{rule, severity 必改|建议|提示, message, target}], must_fix, ok`。

lint 库函数（`sys.path.insert(0, "~/.claude/skills/doc-figures/scripts"); import lint`）：

| 函数 | 签名 | 用途 |
|---|---|---|
| namespace_ids | `namespace_ids(svg_text: str, prefix: str) -> str` | 所有 id 与引用（url(#)、href、xlink:href、aria-labelledby / describedby、style 里 #id）加前缀；只改真实存在的 id，颜色值不受影响；幂等；prefix 须字母开头（建议 `f{序号}-`） |
| board_lint | `board_lint(svg_text: str) -> list[issue]` | 画板约束：clipPath / mask / pattern / foreignObject / style / script、非单阴影 filter、rect 高 < 2、文字转 path、外部资源、缺 viewBox |
| font_stats | `font_stats(svg_text: str) -> {viewbox_width, viewbox_height, min_font_px, min_font_text, texts, notes}` | 最小字号（属性、style、g 继承、em / pt 换算；残留 style 元素时保守计入） |
| equiv_pt / font_issue | `equiv_pt(px, viewbox_width, width_ratio=1.0, landscape=False) -> float`；`font_issue(stats, width_ratio, landscape) -> (pt, issue|None)` | layout.md §7 公式；< 7pt 为 LY4 必改 |
| aspect_check | `aspect_check(svg_text, lo=0.35, hi=0.7) -> issue|None` | 流程类图宽高比（建议级） |
| whiteboard_check | `whiteboard_check(path, timeout=180) -> dict` | npx @larksuite/whiteboard-cli@0.2.13 --check；不可用时 `{"skipped": 原因}` |

## 5. .fig.json 模板 schema

`"template"` 选模板（兼容类型包草案的 `"kind"`）。所有模板通用：`title`、`subtitle`（放进文档且有图题时建议不写 title）、`display`、`legend` / `legend_style`（swatch 色块 | text 一行文字）、`font_scale` 与 `canvas_width`（只用于反例测试）。角色色 `role`：generic_layer 紫、business_line 橙、category 蓝、deliverable 绿、neutral 灰、placeholder 白 + 虚线；也可直接写调色板色名。完整示例见 templates/*.fig.json；各模块 `SCHEMA` 常量是字段说明的代码内版本。

**layered-arch**（分层架构，architecture.svg 复刻见 tests/fixtures/architecture-replica.fig.json）

```json
{"template": "layered-arch", "title": "…", "subtitle": "…",
 "layers": [
  {"id": "entry", "frame": "none", "nodes": [{"id": "a", "label": "入口", "body": "说明", "role": "generic_layer", "emphasis": true, "weight": 480}]},
  {"id": "svc", "label": "服务层：按领域拆分", "frame": "group", "columns": 4, "nodes": [{"id": "b", "label": "订单服务", "body": ["下单", "状态机"]}]},
  {"id": "out", "label": "双输出", "beside": "svc", "direction": "column", "weight": 236, "nodes": [{"id": "c", "label": "PDF", "role": "deliverable", "compact": true}]},
  {"id": "base", "label": "契约层", "frame": "emphasis", "nodes": [{"id": "d", "label": "规则", "fill": "white"}]}],
 "edges": [{"from": "a", "to": "svc"}, {"from": "svc", "to": "out", "role": "deliverable"}, {"from": "base", "to": "svc", "dashed": true, "label": "只读引用"}],
 "legend": "auto"}
```
层：`frame` group（灰底）/ emphasis（淡紫强调）/ none（无框，卡片按 weight 分宽）；`direction` row / column；`beside` 放到前面某层右侧同一行；放不下自动折行（每张卡不窄于最长词）。节点：`dashed` 虚线（保留原样 / 待扩展），`emphasis` 22px 标题，`compact` 17px 标题，无 body 的卡片 18px 标题，`fill: "white"`。连线：可连节点或层；正交 A* 路由避开卡片与文字，跨行只走上下边、落点为边中点（多条时 ±24 / ±48 槽位）、平行线保持 ≥ 8px 间距、不水平穿过层标题带；标签放线旁空白处并加衬底，同一目标的同名标签只标一次。

**swimlane**：`lanes[{id, label, role}]`、`steps[{id, lane, label, body, kind: task|decision|start|end, col}]`、`edges[{from, to, label, dashed}]`。列按连线拓扑自动分（回边不参与），`col` 可显式指定；判断菱形只从四个顶点进出。

**compare-matrix**：`columns[{label, highlight}]`、`rows[{label, group, cells[]}]`，cell 取 full / half / none（或 ● ◐ ○、true / false）、`-` 或 null、其他文字；`legend_labels {full, half, none}`；`split`（默认 true，列放不下自动分块并重复首列）。

**milestone**：`unit`（默认「周」）、`phases[{id, name, duration, items, role}]`、`milestones[{after: 阶段 id 或下标 | at: 时长位置, label, tag, role}]`、`rows`、`start_label`。阶段条宽按时长比例（放不下文字时保底宽度），里程碑标签两道避让，多行时行尾经通道连到下一行首段。

**coverage-heatmap**（test-plan 草案字段原样可用）：`rows[]`、`cols[]`、`cells[{row, col, value 0–1, count}]`、`row_title`、`col_title`、`count_format`（默认 `n={count}`）、`scale[{min, role|color, label}]`（默认 100% 绿 / 80–99% 青 / 50–79% 橙 / < 50% 红）、`missing_label`、`legend_title`。

**phases**（阶段 / 环节，含多行阶梯）：`rows` auto（≤ 4 一行、5–8 两行、9–12 三行）| N；`row_labels[]`；`row_style` label（左侧标签列）| frame（分组容器，标题左对齐加粗，同 architecture.svg 层容器）；`card_style` band（表头色带）| plain（三段式：「编号 名称」粗体 / 关键活动 / ◆「gate_label：条件」阶段色 + 细分隔线；frame 时默认）；`phases[{id, badge, name, meta, items, gate, tag, role}]`；`gate_label`（默认「准出」）；`loops[{from, to, label}]` 只允许同一行（跨行回环抛 SpecError）；`milestones[]`（旧格式，单行）。frame 模式所有卡片等宽等高、分隔线对齐，行尾卡片底边 → 行间通道 → 容器左内边距 → 下一行首卡左边中点；徽标骑在卡片右上边框上。

**funnel**：`steps[{name, action, source, problem, role}]`（2–8 级）、`source_prefix`（默认「参考：」）、`problem_prefix`（默认「解决：」）。

**sitemap**：`root`、`lanes[{name, color, groups[{name, children[]}]}]`；分组过多时道内自动折行。

排版规则（所有模板）：文字按词换行不截断——优先在空格、标点、/ · + → 处断，中文词不从中间断、不留单字碎片（罚分最优断行），行尾标点可悬挂半字宽，放不下时先用卡片内边距兜底再退回逐字断；编号与名称用不断行空格绑定；中英文之间自动补空格（T1）；单词宽于可用宽度时报 word_too_long。输出前自检：text_overflow、node_overlap、text_overlap、out_of_canvas、font_too_small、label_collision、edge_overlap、edge_through_title、arrow_on_corner、edge_unroutable、board_thin_rect，全部为必改。

## 6. Mermaid 实测处理（Chrome 152 + mermaid 11.17.2，2026-09-15）

| 问题 | 处理 | 结果 |
|---|---|---|
| foreignObject | initialize 传 htmlLabels=false（全局与 flowchart / state / class） | flowchart、sequence、state、er、gantt、xychart、quadrant 全部 0 个；若仍出现，review.json 标注「该图飞书端走 mermaid 源，PDF 端 SVG 含 foreignObject」 |
| style 元素、阴影 filter | 渲染后在 Chrome 里把计算样式写回属性，删 style 与 filter | PDF 用 SVG 无 style / filter，字号可精确统计 |
| 小字号（sequence 16、ER 14、gantt 刻度 10、quadrant 点 12） | theme 配置 + themeCSS 把 CSS 类字号抬到 17px | 全部 ≥ 17px |
| 甘特刻度重叠、今日红线 | axisFormat %m-%d、tickInterval 1week 起步；Chrome 测刻度文字外接框，重叠则依次放大到 2week、1month…；todayMarker 配置项不生效，写进源码 `todayMarker off` | 全年三段计划默认 1week 重叠 → 自动改 1month 后 0 重叠，写入 .resolved.mmd |
| init 指令 fontFamily 带引号 | 预处理去引号；lint 必改；主题注入本身不带引号 | 实测带引号时整条 init 失效（mainBkg 不生效），去引号后生效 |
| xychart 中文分类未加引号 | 预处理加引号；lint 必改 | 未加引号报 Lexical error |
| quadrantChart 中文未加引号 | 预处理给轴、象限、标题、点名加引号；lint 必改 | Chrome 能渲染但飞书画板解析器报 Lexical error；加引号后两端都通过 |
| xychart 图例越出 viewBox | viewBox 扩到内容外接框 | 实测越界文字 0 |
| xychart 数据超出 y 轴范围 | lint 必改 | — |
| 时序图生命线穿过文字、长条件自动连字符 | 消息 / 分支条件 / 段标题后插入白色衬底 rect；分支条件宽于 220px、消息宽于 420px 时按标点预断行（<br/>）；渲染后检测「汉字 + 连字符」行尾，命中报必改 | 衬底无 filter、高度 ≥ 2 |
| flowchart 边标签底半透明 | themeCSS 设 opacity 1 | — |
| 飞书端主题 | whiteboard-cli 渲染 Mermaid 源时不读 init 主题（用自带配色） | 事实；两端配色不同，评审以 PDF 为准 |

阶梯式：`mermaid.stairs_mmd(spec)`（phases 形式 spec → 外层 TB + 每行 direction LR 子图，子图间 `R1 --> R2`，节点圆角按行着色）；或在线性 flowchart 源里写 `%% doc-figures: stairs rows=2` 由 build 改写（有分叉 / 跨行回环时不改写并在 notes 说明）。Mermaid 限制：子图内节点直连子图外会让子图 direction 失效，所以行间只能子图对子图；卡片不能强制等宽、容器标题居中——PDF 端要品牌图质量用 svgkit phases（row_style frame）。

Graphviz：WASM 版无 PingFang 字宽，实测中文估窄约 23%；排版时 fontsize × 1.3、输出后还原，节点与标签按放大字号留空间。自动注入品牌默认属性（字体、紫色圆角节点、灰色连线、cluster 灰底）。

## 7. 自测

```sh
python3 ~/.claude/skills/doc-figures/tests/run_tests.py [--no-wb] [--keep]
```
覆盖见文件头：换行与 T1、lint 反例、id 命名空间、Mermaid 预处理与阶梯式、八个模板正例与越界 / 重叠 / 字号不足 / spec 错误反例、连线自检反例（重叠段、穿标题、角点箭头）、build 集成（六类 Mermaid + Graphviz + 模板 + 坏成品）、architecture.svg 复刻对照、业务词守卫。改 scripts/、templates/、vendor/ 后必须 ALL PASS。

## 8. 文件

| 路径 | 说明 |
|---|---|
| scripts/build.py | 路由与检查主入口 |
| scripts/chrome.mjs | Chrome CDP 工人：Mermaid 渲染与样式内联、实测越界 / 重叠、PNG 截图、字宽测量 |
| scripts/mermaid.py | 主题配置、预处理、源码 lint、阶梯式生成器 |
| scripts/graphviz.py、graphviz.mjs | 品牌注入、WASM 渲染、后处理 |
| scripts/svgkit.py | 画布、字宽与断行、A* 正交路由、标签放置、自检 |
| scripts/templates/*.py | 八个模板（每个含 SCHEMA 与 render） |
| scripts/lint.py | 检查库与 CLI |
| scripts/figures.py | 单张 svgkit 图 CLI |
| scripts/font_metrics.json | Chrome 实测字宽（生成物） |
| templates/*.fig.json、deps.dot | 各模板正例 |
| tests/run_tests.py、tests/fixtures/ | 自测与复刻 spec |
| vendor/ | wasm-graphviz 1.29.1、mermaid LICENSE（不改）；mermaid.min.js 不随 skill 分发，见下 |

### mermaid.min.js：首次联网拉取、之后离线复用

mermaid.min.js 3.4 MB，不随 skill 分发。`scripts/mermaid.py` 的 `mermaid_js()` 按以下顺序取：

1. 环境变量 `DOC_FIGURES_MERMAID_JS` 指向的本地文件（显式覆盖 / 测试夹具 / 完全离线环境，不校验 sha256）；
2. 本机缓存 `${XDG_CACHE_HOME:-~/.cache}/doc-figures/mermaid-11.17.2/mermaid.min.js`，sha256 匹配就直接用（**不联网**）；
3. 都没有 → 按 `vendor/VERSIONS.md` 登记的 npm tarball 地址联网拉取一次，校验 **tarball sha256 与单文件 sha256**（两道），只按名取 `package/dist/mermaid.min.js` 与 `package/LICENSE`（不做 extractall），原子写入缓存。

即：**首次渲染 Mermaid 需要一次联网，之后一律走缓存离线**。缓存目录可用 `DOC_FIGURES_CACHE_DIR` 改写。
预拉取：`python3 ~/.claude/skills/doc-figures/scripts/mermaid.py --ensure-js`（打印路径）；`--cache-path` 只打印缓存路径。
自测不会发网络请求：`tests/run_tests.py` 一律把 `DOC_FIGURES_MERMAID_JS` 指向本地文件；本机没有时相关 Mermaid 断言转 SKIP 并提示先跑 `--ensure-js`。

从售前迁移：svgkit.py / figures.py 由 presales-publish/scripts 复制改写（调色板改读 svg-palette.json，旧模板 funnel / phases / sitemap 字号升到 ≥ 17px 并支持换行），售前原文件未改。
