---
name: doc-author
description: 专业文档生产体系（doc-*）的写作引擎：按类型包把骨架写成正文。从 pack.json skeleton 动态生成 doc.md 骨架与 outline.md（D1 拍板稿），按 must_answer 逐章写 DocMark 正文，数据块（CSV）优先、图先写源再引用、摘要用 summary 块、编号实体与交叉引用、高亮与禁用词限额、中文排版 T1–T12；写作期用 fill_check 查章节完成度与占位符残留、用 lint_draft 在副本上跑质检子集只看本章问题。用户要「写 / 续写 / 改写」PRD、MRD、技术 Spec、API 参考、测试计划、测试用例、测试报告的正文或骨架，要「按类型包生成大纲」「检查哪几章还没写完」「写到一半先查本章排版问题」时使用；整条流程（判型、建目录、守门、渲染、质检、发布）由 doc-orchestrator 串联。只小改一篇已有飞书文档走 lark-doc；售前方案正文仍由 presales-solution 写。
---

> **路径约定**：`<doc-X>` = 兄弟 skill doc-X 的目录（与本 SKILL.md 同级；矩阵由 pack 整体安装，成员始终并排）。

# doc-author（写作引擎）

开工前读 doc-shared：references/docmark.md（语法）、typography.md（T1–T12）、figures-policy.md（图怎么选、怎么画）、pack-interface.md（类型包字段）、qa-engine.md（质检规则编号）。再读本次类型包：`doc-shared/types/<type>/` 的 pack.json、skeleton.md（各章写法要点与反例）、writing-contract.md、qa-rules.md、templates/、samples/（正式样张是「写到什么程度算专业」的答案）。本 skill 不定规则，只按规则写。

## 1. 职责与边界

| 做 | 不做 |
|---|---|
| outline.md（D1 拍板稿）、doc.md 骨架与正文、sections/*.md、data/*.csv、figures/ 下的图源（.mmd、.dot、.fig.json） | 建运行目录、写 doc.json 与 run-state（doc-orchestrator / run_state.py） |
| 写作期自查：fill_check（完成度）、lint_draft（本章质检子集） | 构建图、渲染、正式质检、发布（doc-figures、doc-render、doc-qa、doc-publish） |
| 回答类型包 must_answer；按类型包 numbering 编号 | 自己定章节、编号格式、禁用词——一律以 pack.json 为准 |

## 2. 写作流程

1. **骨架**：`outline.py <运行目录>`（new_run.py 已调用过）。doc.md 只预建必备章节，形如 `## 标题 {#sec:<id>}`——锚点必须与标题同一行，doc-qa S1 才认；按需章节写进 outline.md 的拍板项。章节标题可以按内容改写，**锚点不要删**，改了标题 S1 仍靠锚点匹配。
2. **D1 拍板后**：用户选纳入的按需章节用 `outline.py <运行目录> --add-section <id>` 插入（按骨架顺序定位）；不纳入的不写。
3. **逐章写**：每章下面的 `<!-- 写作提示 must_answer: … -->` 是本章必须回答的问题清单，逐条回答；`【待写：…】` 占位写完删掉。写完一章跑 `lint_draft.py <运行目录> --section <id>`，把本章必改与建议改掉再写下一章。
（outline.md 永远有「① 按此骨架开写」拍板项；D1 要求 run-state decisions 条数不少于拍板项数，逐项 decide 后才能签。）
4. **收尾**：`fill_check.py <运行目录>` 退出 0（无缺章、无空章、无占位符）；写作提示注释删掉；交回 doc-orchestrator 跑 advance。

## 3. 写法规则（专业度的来源）

### 3.1 must_answer 逐条回答
- 每个 must_answer 条目在本章都有一段、一张表或一张图直接回答，读者不用翻别章就能找到答案。
- 答不了的写明缺口与责任人：「[目标值待运营确认，owner：xxx，截止：日期]」。**不编数字、不编来源**。
- fill_check 的覆盖统计是启发式（条目关键词是否出现在本章正文或表格里），只作提示；人工仍要逐条过。

### 3.2 数据块优先
- 行数多、会被别的文档引用、需要分组小计的内容（需求清单、用例、覆盖矩阵、缺陷列表、接口字段）放 `data/*.csv`，正文用数据块引用：`<!-- data: data/x.csv columns=列1,列2 filter=列^前缀 group=列 sort=列 caption=表题 id=tbl:x widths=1,4,1 -->`（参数规则见 docmark.md §2）。
- 同一份 CSV 可以按 filter 拆到多个章节；合计、小计由数据块生成，**不手写合计数字**。
- CSV：UTF-8、首行表头、编号列补零便于排序；下游文档（related_docs）会按列名读，列名定了就别改。
- 小表（≤ 8 行、只在本文用）直接写 Markdown 表格，上方加 `<!-- table: 表题 {#tbl:id} -->`。

### 3.3 图：先写源，再引用
- 按 figures-policy.md §3 选引擎：流程 / 时序 / 状态 / 甘特 / ER 用 Mermaid（.mmd），分层架构用 svgkit layered-arch（.fig.json），依赖关系用 Graphviz（.dot），矩阵、泳道、里程碑用 svgkit 模板（doc-figures/templates/ 有正例）。
- 源写在 figures/，正文引用源文件：`![图题](figures/x.mmd){#fig:x}`，正文至少一处 `@fig:x` 引用（X2）。
- 一张图 ≤ 20 个节点；有图题时图内不再写同名主标题；颜色表达角色，同图 ≤ 4 种角色色。
- 不手画 PNG 截图代替架构图；位图只用于真实界面截图（shots/）。

### 3.4 摘要用 summary 块
- 类型包 features.summary_block 开启时，摘要写在文首 `<!-- summary -->` … `<!-- /summary -->`，渲染为目录前的摘要页；块内只用段落与列表。
- 结论先行，3–5 句：问题、目标、范围、判据（或本类型包 skeleton.md 规定的摘要要素）。**不要再写一个编号章节「摘要」**，会与摘要页重复（LY10）。
- 文档控制表、修订记录由引擎按 doc.json 生成，正文不重复写。

### 3.5 编号实体与交叉引用
- 编号格式只来自 pack.json numbering.entities（prefix、pattern）；定义处 = 表格首列或数据块首列匹配 pattern 的行，全文唯一（S3）。
- 引用别的文档的编号（如下游引用上游的需求编号）必须能在关联文档里找到；改版删编号前先跑 doc-orchestrator 的 xref_check 看谁在引用。
- 章节、图、表互相引用用 `@sec:id`、`@fig:id`、`@tbl:id`，不手写「见 3.2 节」「如图 2 所示」——编号会变，引用文字由渲染器生成。
- 标题不手写序号（T5）；附录用 `{#sec:id .appendix}`，不手写「附录 A」。

### 3.6 高亮 ⟪⟫ 的用量
- `⟪重点片段⟫` 只标读者必须记住的结论或数字（承诺值、判据、红线），不标整句。
- 上限按类型包 qa.highlight_limits，缺省：全文 ≤ 25 处（H1）、每页 ≤ 3 处（H2）、单处 ≤ 40 个汉字当量（H3）；不嵌套、不跨行、必须成对（H4 必改）。
- 加粗 `**…**` 用于小标题式的词组，不和高亮叠用。

### 3.7 禁用词与措辞
- 绝对化用语（R1，必改）：零风险、无损、完全保证、确保排名、100% 通过、保证排名、绝对安全、万无一失；否定语境「不承诺…」除外。
- 类型包 qa.banned_terms：无 columns 的词全文禁用；有 columns 的词只在这些列里禁用（T11）。写之前先看本包清单。
- 验收、预期、判据类列不写空泛词（T11）：等等、若干、相关、尽量、合理、适当、友好、及时、体验更好、性能高、显著；整格不能只有「正常 / 成功 / 通过 / 符合预期」。
- 术语按类型包 glossary 的正写（T8）。

### 3.8 中文排版 T1–T12（判据以 typography.md 为准）
中英文与数字之间留半角空格（T1）；中文语境全角标点、同句不混用（T2）；区间用「3–5」不用波浪号（T3，必改，飞书会吞）；引号全文统一用「」（T4）；标题不带句末标点、不手写序号（T5）；数字与单位之间留空格、百分号紧跟数字（T6）；同一列表句末标点一致（T7）；术语一致（T8）；不用行内代码（T9，代码只放代码块，且类型包开了 code_blocks 才能用）；表格单元格不写长段（T10，> 80 字挪到正文）；验收列不空泛（T11）；段落 ≤ 250 字、句子 ≤ 80 字（T12）。另：不用 HTML 标签、斜体、删除线（L1）。

## 4. 专业度检查清单（交回编排前逐条过）

1. 必备章节齐，每章 must_answer 逐条有答案；按需章节与 D1 拍板一致。
2. 没有占位符、TODO、写作提示注释残留（fill_check 退出 0）。
3. 结论先行：摘要块能独立读懂；每章第一段说结论，再给依据。
4. 每个判断有来源（数据口径、工单、访谈、日志），推断与事实分开写。
5. 数字全文一致（同一指标、金额、数量只有一个值；X4 按类型包口径查）；合计由数据块生成。
6. 编号唯一、格式合规；跨文档引用的编号在关联文档里存在。
7. 每张图都有图题与锚点、正文有引用，图源在 figures/；表格有表题。
8. 验收与预期结果可核验：有阈值、有观察对象、有判定方式。
9. 范围与非目标不矛盾；风险有应对、开放问题有 owner 与截止时间。
10. lint_draft 全文无必改；建议级逐条判断改或在 qa-report 说明。

## 5. 脚本

| 命令 | 作用 | 退出码 |
|---|---|---|
| `python3 <doc-author>/scripts/outline.py <运行目录> [--target doc\|outline\|both] [--force] [--stdout] [--pack 包目录]` | 从 pack.json skeleton（按元数据 mode 打补丁）生成 doc.md 骨架与 outline.md；不写死任何章节名；已存在不覆盖 | 0 成功；1 已存在；2 用法 / mode 无法识别 |
| `outline.py <运行目录> --add-section <id> [--add-section …]` | D1 拍板纳入的按需章节插入正文，放在骨架顺序中其后第一个已有章节之前；章节在 include 片段里也算已有；其后章节在片段里时追加到文末并在 notes 提示手动挪位 | 0；1 有章节不存在或已有 |
| `python3 <doc-author>/scripts/fill_check.py <运行目录> [--section id]` | 章节完成度：缺必备章、必备章为空、占位符（【待写…】、{占位}、TODO / TBD / FIXME；HTML 注释内不算，含行内起始与跨行注释，与 xref_check 共用 authorlib.masked_lines）阻塞；must_answer 覆盖与写作提示残留只提示 | 0 无阻塞；3 有阻塞；2 用法（含 mode 无法识别）|
| `python3 <doc-author>/scripts/lint_draft.py <运行目录> [--section id\|标题\|编号] [--rules L1,T3] [--all-lines]` | 在运行目录临时副本上跑 doc-qa `--only` 写作期子集（去掉 L4 L6 S1 X2 C1 H2），只保留本章行号区间内的问题；不写真运行目录的 qa-result.json | 0 无必改；3 有必改；2 用法；4 doc-qa 故障 |

骨架细节：锚点 `{#sec:<id>}` 与标题同一行；二级、三级章节用 `###`、`####`；附录加 `.appendix` 并去掉标题里手写的「附录：」；类型包将来给 skeleton 项标 engine_generated 时跳过该项。

## 6. 衔接

| 上下游 | 约定 |
|---|---|
| doc-orchestrator | new_run.py 建目录时调 outline.py；advance.py 用 fill_check 判「正文是否写完」，阻塞时 actor=author 交回本 skill |
| doc-shared | 骨架与规则来自 types/<type>/pack.json；解析用 scripts/docmark_parse.py（与 doc-render、doc-qa 同一个）；mode 用 validate.resolve_mode / resolve_skeleton |
| doc-figures | 图源写好后由 advance --run 调 build.py；图机器检查必改时改图源 |
| doc-qa | lint_draft 调 qa.py --only；正式 D3 质检由编排层跑全量 |

## 7. 自测

```sh
python3 <doc-author>/tests/run_tests.py
```

覆盖：outline 按临时类型包动态生成（删章、改名、加一级与二级章、modes 补丁、mode 无法识别报错）、锚点与 doc-qa S1 对齐、按需章节不预建与 --add-section 定位、拍板项、不覆盖已有文件；fill_check 占位符（锚点、代码块、跨行注释不误报）、缺章、must_answer 不被写作提示注释自己命中、正式样张零误报（样张与当前骨架未对齐时判缺章）；lint_draft 不写真运行目录、--section 过滤、T3 命中；业务词守卫。
