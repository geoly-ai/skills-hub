# 图表政策

doc-figures 按本文件路由引擎、检查图、统一风格。数值（颜色、字号、圆角）来自 brand/tokens.json，生成物 brand/generated/svg-palette.json 与 mermaid-theme.json。

## 1. 引擎与 vendoring（decisions ④A、⑤A）

| 引擎 | 版本与位置 | 能力状态 |
|---|---|---|
| Mermaid | 11.17.2，doc-figures/vendor/mermaid-11.17.2/mermaid.min.js（哈希见 vendor/VERSIONS.md） | 已验证：Chrome 内加载本地 mermaid.min.js 渲染时序、状态、甘特、ER 矢量 SVG；2026-09-15 阶段 0 用本 vendored 文件在 Chrome 152 headless 实测 xychart-beta（柱状 + 折线）与 xychart 两种写法均渲染成功，SVG 含 rect、path、text，无 foreignObject；飞书 XML whiteboard type="mermaid" 本地 parse 通过；真实发布后画板可编辑性未验证 |
| Graphviz | @hpcc-js/wasm-graphviz 1.29.1（内嵌 Graphviz 16.1.0），doc-figures/vendor/wasm-graphviz-1.29.1/index.js | 已验证：node 离线 dot → SVG，中文正常，无 clipPath / mask / foreignObject |
| svgkit 模板 | doc-figures/scripts/svgkit.py、figures.py（1c 从售前上移） | 已验证：MOBYVOW 3 个画板发布成功 |
| D2、PlantUML | 不引入 | D2 的 SVG 含 mask 与 style，违反画板约束；PlantUML 需 JVM |

## 2. 路由：扩展名 → 引擎 → 两端产物

| 图源 | 引擎 | PDF 用 | 飞书用 |
|---|---|---|---|
| figures/x.mmd | Mermaid（与 PDF 同一个 Chrome 进程渲染） | x.svg | whiteboard type="mermaid"，直接给源 |
| figures/x.dot | Graphviz WASM | x.svg | whiteboard type="svg"，用同一个 x.svg |
| figures/x.fig.json | svgkit 模板（spec 里 `"template"` 字段选模板） | x.svg | whiteboard type="svg" |
| figures/x.svg | 成品（手画 svgkit） | 原样（加 id 命名空间） | whiteboard type="svg" |
| shots/x.png 等 | 位图 | 降采样后内嵌 | img |

每张 build 后都产出同名 .png 预览（自查用）。

### .fig.json schema 定稿（doc-figures 1c，2026-09-15）

`"template"` 选模板（兼容草案 `"kind"`）。字段全表、示例与排版规则见 doc-figures/SKILL.md §5，各模板正例在 doc-figures/templates/*.fig.json；本节只登记模板清单与关键字段，类型包模板按此同步。

| 模板 | 必填字段 | 常用可选字段 | 与草案的关系 |
|---|---|---|---|
| layered-arch | layers[{id, nodes[{id, label}]}] | title、subtitle、layers[].label / frame（group · emphasis · none）/ direction / beside / weight / columns；nodes[].body / role / dashed / emphasis / compact / fill；edges[{from, to, label, dashed, role}]（from / to 可为节点或层）；legend、legend_style | tech-spec 草案的 layers / nodes / edges 原样可用（缺省 frame=group、role=generic_layer） |
| coverage-heatmap | rows[]、cols[]、cells[{row, col, value 0–1}] | cells[].count、row_title、col_title、count_format、scale[{min, role, label}]、missing_label | test-plan 草案原样可用（note 字段忽略） |
| phases | phases[{name}] | rows（auto：≤4 一行、5–8 两行、9–12 三行）、row_labels、row_style（label · frame）、card_style（band · plain）、phases[].badge / meta / items / gate / tag / role、gate_label、loops（只允许同一行） | 兼容旧 weeks / days / milestones |
| milestone | phases[{name, duration}] | unit、phases[].items / role、milestones[{after 或 at, label, tag}]、rows、start_label | 新增 |
| swimlane | lanes[{id, label}]、steps[{id, lane, label}] | steps[].kind（task · decision · start · end）/ body / col、edges[{from, to, label, dashed}] | 新增 |
| compare-matrix | columns[{label}]、rows[{label, cells[]}] | columns[].highlight、rows[].group、cells 取 full · half · none · - · 文字、legend_labels、split | 新增 |
| funnel | steps[{name}]（2–8） | steps[].action / source / problem、source_prefix、problem_prefix | 沿用旧字段 |
| sitemap | lanes[{name, groups[{name, children}]}] | root、lanes[].color | 沿用旧字段 |

通用：title、subtitle、display {width_ratio, landscape}（反推画布宽，保证 17px 等效 ≥ 7pt）、aspect_check（flow · off；phases、swimlane、milestone 默认 flow）、legend（auto · false · 列表）、legend_style（swatch · text）。角色色 role：generic_layer、business_line、category、deliverable、neutral、placeholder，或调色板色名。

不做模板：缺陷趋势用 Mermaid xychart-beta（柱 + 线、轴标题、两端原生，字号与主题已由 doc-figures 配好）；定位象限用 Mermaid quadrantChart。

## 3. 每类图的默认引擎

| 图 | 默认 | 备选 | 理由 |
|---|---|---|---|
| 流程图（含判断） | Mermaid flowchart | svgkit 泳道模板 | 飞书端原生可编辑 |
| 架构图（分层 / 部署） | svgkit layered-arch 模板 | Graphviz | 分层架构要版式控制，Mermaid 布局不稳定 |
| 时序图 | Mermaid sequence | — | 两端原生 |
| 状态图 | Mermaid stateDiagram | Graphviz | 两端原生 |
| 阶段 / 里程碑 | svgkit phases | — | 沿用已验证模板 |
| 甘特 | Mermaid gantt | svgkit 里程碑 | 实测默认刻度文字重叠：必须配 axisFormat 与 tickInterval（已写进 mermaid-theme.json 的 gantt 默认值，效果未验证） |
| 数据模型 | Mermaid erDiagram | Graphviz record | 两端原生 |
| 依赖 / 模块关系、复杂有向图 | Graphviz | — | Mermaid 布局失控时 |
| 覆盖矩阵、对比矩阵 | svgkit 热图 / 矩阵模板，或直接用数据表 | — | 行列多时优先用表 |
| 漏斗、站点结构 | svgkit funnel / sitemap | — | 沿用 |

两端「不是同一张图」的风险：Mermaid 源交给飞书、Chrome 渲染的 SVG 交给 PDF，节点顺序与换行可能不同（未验证）。规则：**评审以 PDF 渲染结果为准**；阶段 1 真实发布后对比两端，差异影响理解的图改走 SVG 画板（whiteboard type="svg" 用 PDF 同一个 SVG）。

## 4. build 检查（doc-figures 对每张图做，结果写 figures/review.json 的 machine 部分）

1. 渲染 SVG。
2. id 命名空间：所有 id、`url(#…)`、`href="#…"` 加 `f<序号>-` 前缀。
3. **画板约束 lint**（whiteboard type="svg" 的图；Mermaid 源走飞书时跳过此项，但其 PDF 用 SVG 仍做 4–5）：
   - 不得出现 clipPath、mask、pattern、foreignObject、style 元素；filter 只允许单个 feDropShadow 阴影。
   - 不得有高度小于 2 的 rect（飞书画板解析失败；分隔线用 line）。
   - 文字必须是 text / tspan，不得转成 path。
   - 不得引用外部图片、脚本、远程资源；必须有 viewBox。
4. whiteboard-cli --check：text-overflow、node-overlap 为 0（npx @larksuite/whiteboard-cli，已验证 0.2.13 可用）。
5. **等效最小字号**：取 SVG 内所有 text 的最小 font-size（含继承），按 layout.md §7 公式算等效 pt；< tokens size.figure_min（7 pt）即必改。常用下限（版心全宽时）：画布宽 1200 px → 最小 17 px；1000 px → 14 px；800 px → 11 px。tokens.py 的 min_px_for 可算任意宽度。
6. 输出 PNG 预览，写 machine 结果；**人工看图结论仍须填写**（human 部分），不填 L4 报建议。

## 5. 品牌图风格（以 architecture.svg 为质量参照）

参照文件：~/workspace/docs/doc-skill-platform-2026-09-15/architecture.svg（用户 2026-09-15 点名表扬的矩阵图）。新模板与手画图对齐以下做法：

| 维度 | 做法 | tokens 字段 |
|---|---|---|
| 画布 | 宽 1200 px，外边距 40 px，白底 | figure.canvas_width_px、margin_px |
| 标题区 | 左上：主标题 30 px 粗体 ink；下方一行副标题 18 px muted，写「这张图的读法」而不是重复标题。放进文档时若已有图题，去掉图内主标题，保留副标题或一并去掉 | figure.font_px.title、subtitle |
| 层次框 | 分组用大圆角容器（圆角 12 px，底 surface_2，边 border 1.5 px），容器左上角 18 px 粗体组名写「这一层是什么：包含什么」；需要强调的层用 layer_emphasis（淡紫底 + 主色 2 px 边） | figure.radius_px.group、group、layer_emphasis |
| 节点 | 圆角 10 px，1.8 px 边；节点标题 19 px 粗体（强调节点 22 px），节点内说明 17 px；文字水平居中，标题与说明行距约 1.5 倍字号 | figure.radius_px.node、font_px.node_* |
| 配色语义 | 颜色表达角色而非装饰：通用层 purple、业务线 orange、分类 blue、交付物 green、中性 gray、待扩展 white + 虚线；同一张图不超过 4 种角色色；节点底用调色板 fill，边用 stroke，标题字用 text | figure.role_colors、palette |
| 虚线 | 「保留原样 / 待扩展」节点用虚线边（7 5 或 6 4）；「参考、只读」关系用虚线连线（6 5） | figure.dash |
| 连线 | 正交折线（polyline），2 px；箭头为 11 px 实心三角 polygon，颜色同连线；连线标签 17 px 放在线旁空白处，不压线 | figure.stroke_px.edge、arrowhead_px |
| 图例 | 底部一行 17 px muted：「紫色：通用层　橙色：业务线　虚线框：保留原样或待扩展　绿色：交付物」，与图内实际使用的颜色一一对应 | figure.font_px.legend |
| 字号层级 | 只用 30 / 22 / 19 / 18 / 17 五档；最小 17 px 保证 1200 宽画布等效 7.31 pt | figure.font_px |
| 留白 | 同组节点间距 12 px 左右，组与组之间 ≥ 40 px；文字离框边 ≥ 12 px | figure.gap_px |
| 信息量 | 一张图 ≤ 20 个节点；超过就拆成总览图 + 分图 | — |

检查清单（人工看图时逐条过，结论写 review.json human.issues）：标题与图题不重复；颜色与图例一致；无文字压线、越界、重叠；最小字号达标；连线方向与正文描述一致；打印成灰度仍能靠形状与文字区分角色。

## 6. Mermaid 主题

- 由 tokens.py 生成 brand/generated/mermaid-theme.json：theme base + themeVariables（主色、边框、线色、字体来自 tokens），fontSize 按 figure_min 7 pt、参考宽 1200 px 反推为 17 px。
- htmlLabels 设为 false：减少 foreignObject（状态图、ER 图实测含 foreignObject 与 filter；设 false 后是否完全消除未验证，1c 实测）。
- Mermaid 实际 SVG 宽度随内容变化，主题字号只是起点：**每张图仍按实际 viewBox 宽算等效字号**。

## 7. figures/review.json

```json
{"figures": [{"file": "figures/order-state.svg", "source": "figures/order-state.mmd", "engine": "mermaid",
  "machine": {"checked_at": "2026-09-15T10:00:00+08:00", "board_lint": [], "whiteboard_check": [], "viewbox_width": 960, "min_font_px": 17, "min_font_pt": 9.13, "ok": true},
  "human": {"checked_at": "2026-09-15", "checked_by": "Claude", "issues": "无"}}]}
```

兼容：旧格式 `{"figures": [{"file", "checked_at", "issues"}]}` 视为只有 human 部分。
