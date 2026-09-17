# CHANGELOG · doc-render

版本号语义见 doc-shared/references/pack-interface.md §6。scripts/common.py RENDERER_VERSION 目前写作两段 1.0，按 1.0.0 理解。

## 1.0.1 — 2026-09-16

路径可移植：文档不再硬编码 `~/.claude/skills`，统一 `<doc-X>` 兄弟目录约定。

## 1.0.0 — 2026-09-15

首版渲染引擎（1b），第三波 W3-D1 docx 后端并入同一版。

### 能力
- DocMark 正文经共享解析器渲染为品牌 HTML、PDF（Chrome CDP：定位遍回填目录页码、终遍页眉页脚与书签、封面单独打印后替换）、飞书 XML，写 out/render.json。
- 封面 marketing / technical（文档控制表）、internal 修订记录页、summary 块摘要页、两级目录带页码、图表编号与交叉引用、thead 跨页重复、宽表缩字号或横向页段。
- 一级标题分页 always / auto / never（类型包 features.h1_page_break → h1_new_page → 品牌档案 → 封面默认）。
- 版式检查 LY1–LY10（layout.md §12）；LY9 手工分页不算自然章末，LY10 检查正文与自动生成前置页重复。
- docx 输出（--docx，W3-D1）：Heading 1–4、TOC 域、表格标题行重复与列宽、横向节、doc-figures PNG、原生脚注、页眉页脚、核心属性；读回校验 DX1–DX9；可选 LibreOffice 转换核验。默认输出优先级：--docx / --no-docx > 类型包 outputs > 品牌档案 outputs。
- 迁移期开关 --legacy-tilde、--legacy-widths-px（主代理拍板：飞书 widths 一律按权重归一化，旧 golden 用开关）。
- 安全：正文、include、数据块、图文件做 realpath 边界校验。

### 已知限制
- 运行目录按单用户单进程可信写入，TOCTOU 为已知限制（主代理拍板不改 openat）。
- LibreOffice 在「手工分页 + 标题 + 横向页段」处多排一张空白页，Word 行为未验证；docx 未做字体嵌入。

### 重点高亮颜色变体（2026-09-15 主代理追加，并入 1.0.0）
- 三个后端按 highlight 节点的 `kind` 取色，统一走 `common.hl_callout_kind` / `common.hl_fill`（映射表在 doc-shared/scripts/docmark_parse.py `HL_KIND_CALLOUT`）：
  - HTML：`mark.dm-hl-{risk,tip,warn,decision}` 四条 CSS，底色与描边取 `--dm-callout-*-bg` / `--dm-callout-*-border`；无前缀仍是原来的 `dm-hl`（视觉零变化，golden 逐页差异 0）。目录副本沿用同一套 class。
  - docx：run 底纹取 `tokens.callout[kind].bg` 对应的 color 键（tint / danger_tint / ok_tint / warn_tint / info_tint）；DX8 读回改为匹配 5 种底色，计数口径不变。
  - 飞书：底色复用 `brand/generated/feishu-callouts.json` 的 callout 映射，不再写死 `light-purple`。
- `render.highlights` 条目新增 `kind`。
