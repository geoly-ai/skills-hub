# 飞书约束

doc-render 生成飞书 XML、doc-publish 发布与回查时遵守本文件。XML 语法以 lark-doc skill 的 references/lark-doc-xml.md 为准（写飞书前读 lark-doc 与 lark-shared）；本文件只登记本矩阵踩过的约束与固定做法。

## 1. 排版约定（全局，用户 2026-08-21 定）

| 约束 | 做法 | 质检 |
|---|---|---|
| 一律不用行内代码格式 | 表名、字段名、接口路径、文件名也写普通文字；需要区分时用引号、加粗或列表 | T9 / L2 |
| 区间不用波浪号 | 写「3–5」或「3 至 5」。飞书 Markdown 解析会把同段两个 ~ 配对成删除线，工时区间会被整段划掉 | T3 |
| 不用斜体、删除线 | 回查时 `<i>`、`<em>`、`<del>` 残留都算问题 | L1 |
| 加粗紧邻中文 | XML 用 `<b>` 不受影响；走 Markdown 时偶发跨单元格错配，回查残留字面 `*` | 回查 |
| 代码块 | 只在类型包 features.code_blocks 为 true 时输出 `<pre lang="…"><code>…</code></pre>`（decisions ⑦A）；否则代码块为必改 | L8 |

## 2. XML 结构约束（lark-doc XML 规范摘录）

- 完整文档以唯一 `<title>` 开头；正文标题 h1–h6，层级连续不跳级，用 `seq="auto"` 自动编号（S2 检查跳级）。
- 表格写 `<thead>` 与 `<tbody>`；列宽用紧跟 table 的 `<colgroup><col width="…"/></colgroup>`；表头底色用 light-gray（tokens feishu.table_header_bg）。
- 高亮块 `<callout emoji background-color border-color>`：子块只能是 p、ol、ul、checkbox 与行内标签，**不能放表格、图片、代码块、画板**；颜色映射见 brand/generated/feishu-callouts.json。
- 颜色只能用命名色：色相 red、orange、yellow、green、blue、purple、gray；高亮块背景 gray、light-{色相}、medium-{色相}；边框与文字用基础色相。tokens.py 自检会拦截非法色名。
- 嵌套列表：子列表放在 `<li>` 内。
- 转义：只转义标签内文本（`<` `>` `&`），不要转义标签本身。
- grid 各列 width-ratio 之和为 1。
- 本地资源一律 `path="@./相对路径"`，相对的是**运行 lark-cli 时的工作目录**（发布脚本 cwd = 运行目录）。

## 3. 图与画板

| 图 | XML | 约束 |
|---|---|---|
| .mmd | `<whiteboard type="mermaid" path="@./figures/x.mmd"></whiteboard>` | 本地 parse 已验证；真实发布后是否可编辑未验证（阶段 1 验证） |
| .svg、.dot、.fig.json 的 build 产物 | `<whiteboard type="svg" path="@./figures/x.svg"></whiteboard>` | 画板 lint：无 clipPath、mask、pattern、foreignObject、style，filter 只允许阴影；无高度小于 2 的 rect；文字为 text；有 viewBox；不引用外部资源（详见 figures-policy.md §4） |
| 位图 | `<img path="@./shots/x.png" caption="…"/>` | PNG、JPEG、GIF、WebP，单图 ≤ 20 MiB |

画板里解析不了的元素会降级为内嵌图片（可显示不可编辑）；clipPath、mask 等会导致画板渲染问题，不是降级。

## 4. lark-cli 调用

- **先去掉代理**：本机 shell 带 HTTP_PROXY / HTTPS_PROXY，飞书 API 走代理直接 503，报错伪装成 token 刷新失败，不要误诊成要重新登录。脚本里从子进程环境删除 HTTP_PROXY、HTTPS_PROXY、http_proxy、https_proxy、ALL_PROXY、all_proxy；手动执行用单独的 `unset` 行（zsh 下 `env -u X lark-cli` 要写成 `env -u X -- lark-cli`）。
- PATH 前置最新的 ~/.nvm/versions/node/v*/bin。
- 账号：account1 为默认配置；account2 设 `LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-account2`。doc.json lark_profile 指定，命令行可覆盖。
- 文档操作显式 `--as user`；输出加 `--format json` 便于解析。
- 写之前先预检：`lark-cli docs +script --command parse --content @./out/feishu.xml`，assessment.status 必须为 passed。

## 5. 落点：项目文件夹（全局约定 2026-09-13；decisions ⑫A）

- 结构：云空间根目录 → 客户或项目文件夹 → 子项目文件夹。同一客户多条产品线按子项目分开。
- doc.json lark_folder 必填；D4 要求有 token；**没有 token 发布脚本拒绝发布**，不落根目录。
- 建文档前 `lark-cli drive files list` 看根目录与项目文件夹；有目标文件夹用 `docs +create --parent-token <folder_token>`；没有先 `drive +create-folder` 再建。归属拿不准（新客户、跨两个项目）给字母选项问用户，不猜。
- 知识库（Wiki）是团队可见空间，不作为默认落点；用户点名才放。
- 已在根目录的文档用 `drive +move --type docx --folder-token <目标>` 归位；移动前列清单让用户确认范围。**移动必须串行**：并发 +move 实测 17 个里 15 个报频率限制或资源争用；逐个移、间隔 ≥ 1 秒、失败退避重试，最后列目录核对。

## 6. 新建与覆盖

| 场景 | 做法 |
|---|---|
| 首次发布 | `docs +create --as user --doc-format xml --content @./out/feishu.xml --parent-token <token>` |
| 同一文档出新版本 | 先 `drive +list-comments --token <doc> --type docx --solved-status all`，评论数为 0 才 `docs +update --command overwrite --doc-format xml`；有评论改用新建（覆盖会丢评论） |
| 同步已发布文档的改动 | 用 overwrite，不用 import（import 会生成新文档，链接变） |

发布前必须过 D4：用户看过 PDF 预览，确认发布范围、版本号、飞书账号与文件夹。

## 7. 发布后回查（写进 published.json verify）

`docs +fetch --as user --doc <id>` 回读 XML，逐项比对：

| 项 | 期望 |
|---|---|
| 画板数 | 等于 feishu.xml 里 `<whiteboard` 数；不等说明有 SVG 解析失败，修 SVG 后用 `docs +update` 的 block_insert_after 在对应图注前补插，**不重建文档** |
| 图片数 | 不少于 feishu.xml 里 `<img` 数 |
| 代码块（`<code`、`<pre`） | 类型包不允许代码块时为 0；允许时等于源文件代码块数 |
| 斜体、删除线（`<i>`、`<em>`、`<del>`） | 0 |
| 残留字面 `*` | 0 |
| 服务端 warnings | 空 |

回查不通过时发布脚本退出码 3：文档已存在，按问题局部修复。
