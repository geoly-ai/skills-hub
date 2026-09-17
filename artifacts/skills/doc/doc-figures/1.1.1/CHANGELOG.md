# CHANGELOG · doc-figures

版本号语义见 doc-shared/references/pack-interface.md §6。scripts/build.py VERSION = 1.1.0。

## 1.1.1 — 2026-09-16

路径可移植：文档与维护者校验命令不再硬编码 `~/.claude/skills`，统一 `<doc-X>` 兄弟目录约定。

## 1.1.0 — 2026-09-16

### 行为变化（会影响本机渲染）
- **mermaid.min.js 不再随 skill 分发**（3.4 MB，超出分发渠道单文件 2 MiB 上限）。改为：首次渲染 Mermaid 时按 `vendor/VERSIONS.md` 登记的 npm tarball 地址**联网拉取一次**，双重校验 sha256（tarball + 单文件），原子写入 `${XDG_CACHE_HOME:-~/.cache}/doc-figures/mermaid-11.17.2/`，**之后一律离线复用缓存**。
  - 新增 `DOC_FIGURES_MERMAID_JS`：直接指向本地 mermaid.min.js，跳过缓存与下载（离线环境 / 测试夹具）。
  - 新增 `DOC_FIGURES_CACHE_DIR`：改写缓存目录。
  - 新增 CLI：`python3 scripts/mermaid.py --ensure-js`（预拉取并打印路径）、`--cache-path`。
  - `mermaid.VENDOR_JS` 常量删除，改为 `mermaid.mermaid_js()`。
  - `vendor/mermaid-11.17.2/mermaid.min.js` 已删除；同目录 LICENSE 保留。
  - 自测改用 `DOC_FIGURES_MERMAID_JS` 夹具，**测试期间不发任何网络请求**；本机无缓存时相关 Mermaid 断言转 SKIP。

## 1.0.0 — 2026-09-15

首版图表引擎（1c），主代理验收通过。

### 能力
- 图源路由：Mermaid .mmd、Graphviz .dot、svgkit .fig.json、成品 .svg、位图 → PDF 用 SVG 与 PNG 预览；Mermaid 源交飞书画板。
- svgkit 八个模板：layered-arch、swimlane、compare-matrix、milestone、coverage-heatmap、phases、funnel、sitemap。
- Mermaid 实测处理（Chrome 152 + mermaid 11.17.2）：去 foreignObject、样式内联、字号抬到 17px、甘特刻度防重叠、xychart 与 quadrantChart 中文加引号、时序图文字衬底与预断行、阶梯式生成器。
- 机器检查写 figures/review.json machine：画板约束 lint、whiteboard-cli 检查、等效最小字号（≥ 7 pt）、宽高比、Chrome 实测越界与重叠。
- lint 库函数供 doc-render、doc-qa 复用（namespace_ids、board_lint、font_stats、equiv_pt、aspect_check、whiteboard_check）。

### 已知遗留（wave3-backlog.md G 节）
- layered-arch 同层非相邻节点连线仍可能交叉（tech-spec 样张 target-arch）。
- 中文断词无词典，三字词可能被拆。
- xychart 小整数数据 y 轴出现 0.5 刻度。
- 飞书端画板可编辑性、两端节点顺序一致性未做真实发布验证。
