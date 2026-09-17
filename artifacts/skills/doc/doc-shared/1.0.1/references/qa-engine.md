# 质检引擎契约

doc-qa 按本文件分层执行规则、合并结果、写 qa-result.json 与 qa-report.md 自动区块。中文排版 T1–T12 的判据只在 typography.md 定义；类型包接口（qa_rules.py、doc 模型、ctx、钩子）只在 pack-interface.md 定义。

## 1. 分层

| 层 | 来源 | rule_source | 例子 |
|---|---|---|---|
| 引擎通用 | doc-qa 引擎（本文件 §2、typography.md） | engine | include 与占位符、行内代码、图自查、绝对化用语、版本一致、必备章节、交叉引用、T1–T12 |
| 类型包 | types/<id>/qa_rules.py + qa-rules.md（人工） | type | PRD：需求有编号与验收标准；Spec：至少两个备选方案；测试：每项有前置条件、步骤、预期结果 |
| 业务钩子 | pack.json hooks.pre_qa 调用的业务线脚本 | hook | 业务线专属的金额、范围、泄露、不可售检查 |

执行顺序：解析（共享 DocMark 解析器）→ 引擎规则（按 pack.qa.engine_rules 过滤）→ 类型包 check(doc, ctx) → 钩子 pre_qa → 应用 severity_overrides → 去重与截断 → 写结果。

## 2. 引擎通用规则

从售前 qa-rules.md 上移的通用部分（L1、L2、L4、R1、C1）保留原编号与判据，保证售前迁移后结果可逐项比对；新增规则用未被占用的编号。售前留在类型包的编号：A1–A3、B1–B4、C2、C3、F1–F4、R2–R4、L3、L5。

| 编号 | 规则 | 判据 | 定级 | 来源 |
|---|---|---|---|---|
| L1 | 未解析的 include、占位符，或 include 了白名单外的文件 | include 目标不匹配 pack.include_allow、匹配 include_deny、绝对路径或含 ..、越出运行目录 → 「白名单外」；文件不存在 → 「未解析」；正文出现 `{{…}}` → 占位符；另：正文出现 DocMark 不支持的 HTML 标签、斜体或删除线标记；以及解析器归入 L1 的全部诊断（docmark-ast.md §7：include-too_deep、html-tag、blockquote、callout-kind、figure-*、grid-*、summary-*、landscape-*、feature-disabled、list-depth），定级按诊断 severity：error 必改、warning 建议、info 提示 | 必改 | 售前 L1（白名单改由类型包声明；HTML、斜体、删除线为新增判据） |
| L2 | 行内代码格式、未转义波浪号（兼容规则） | 行内出现反引号；`\d\s*~\s*\d` | 建议 | 售前 L2。新类型包用 T9、T3 取代：engine_rules 默认 include "all" 时 L2 与 T3、T9 同时存在会重复报，**新类型包应 exclude L2**，售前包迁移期 exclude T3、T9 |
| L4 | 每张图有 PNG 预览与 figures/review.json 自查记录 | 正文引用的 figures/ 下每张图（.svg，或 .mmd、.dot、.fig.json build 出的 .svg）都有同名 .png，且 review.json 有该文件的记录（旧格式 file 字段或新格式 human 部分） | 建议 | 售前 L4（扩展到新图源） |
| L6 | 图机器检查未通过 | figures/review.json 中该图缺 machine 部分；machine.ok 为 false；或 board_lint 有必改（条目无 severity 时每条都算）、whiteboard_check 有错误（doc-figures 写对象 {errors, warnings, summary, issues}：errors>0 或 issues 有 severity=error；数组形态兼容，非空即算）、machine.issues 有其他必改、等效字号 < 7 pt。**字号清除例外**：ok 为 false 时，只有必改项全是字号类（规则编号在白名单内，目前只有 doc-figures 的 LY4_font，按编号精确判定，不按消息子串）、没有 lint 与 whiteboard 错误、machine 没有认不出的非空列表字段、machine.must_fix 存在且等于识别出的字号必改条数（缺失即不清除），且 out/render.json 按实际显示宽算的字号 ≥ 7 pt 时，才不报。**与 LY4 去重**（W3-I）：本次运行会并入 render.json（不带 --only）、L6 唯一原因是字号（判据同字号清除例外，只差 render 字号仍 < 7 pt）、且 render.json 对同一图文件（target 为 src 或 svg）已报 LY4 时，不报 L6，LY4 消息末尾注明「（另见 L6 字号）」；L6 其他原因（lint、whiteboard、machine 其他必改、原因不明）照报 | 必改 | 新增 |
| L7 | 表题与表格 | features.table_captions 开启时：表格上方没有 `<!-- table: … -->`；表头行有空列名 | 提示 | 新增（新规则先提示） |
| L8 | 代码块政策 | features.code_blocks 为 false 时出现围栏代码块 → 必改；为 true 时代码块未标语言 → 建议 | 必改 / 建议 | 新增（decisions ⑦A） |
| L9 | 数据块 | `<!-- data: … -->` 指向的文件不存在、不是 CSV、columns 或 group 引用了不存在的列 | 必改 | 新增 |
| L10 | 链接 | 相对链接指向运行目录内不存在的文件；链接文字为空；URL 不是 http(s) 或相对路径 | 建议 | 新增（只做本地解析，不联网） |
| S1 | 必备章节 | pack.skeleton 中 required 为 true 的章节，按 title、aliases 或 `{#sec:<id>}` 匹配不到标题。pack 声明 modes 时按 mode 取骨架（pack-interface.md §2.1）：mode 取自元数据文件，完整字段路径缺失且元数据文件不是 brief.json 时回退运行目录 brief.json；用 validate.resolve_skeleton 打完补丁的骨架检查，解析器 headings.skeleton_id 与 doc.section() 同样按该骨架；mode 值无法识别时报一条必改配置错误，不回落默认骨架、不按默认骨架报缺章 | 必改 | 新增（由 skeleton 声明驱动，类型包无需重复实现） |
| S2 | 标题层级 | 标题跳级（一级后直接三级）；超过 numbering.max_depth；标题为空 | 必改 | 新增（飞书 XML 要求层级连续） |
| S3 | 编号实体 | numbering.entities 中 unique 为 true 的编号重复 → 必改；contiguous 为 true 时同前缀序号不连续 → 提示。「同前缀」= 编号去掉末尾数字后的部分（REQ-ACCT-01 与 REQ-EARN-01 分属两组），只报组内跳号，不要求从 1 开始。定义处 = 表格首列匹配 pattern 的行（含数据块）与 `{#kind:id}` 锚点，正文里的其他出现算提及 | 必改 / 提示 | 新增 |
| X1 | 交叉引用 | `@kind:id` 指向不存在的锚点 | 必改 | 新增 |
| X2 | 图表未被引用 | features.figure_numbers 开启时，有编号的图或表在正文中没有任何 `@fig:` / `@tbl:` 引用 | 提示 | 新增 |
| X3 | 锚点重复与写法 | 同一 `{#kind:id}` 出现两次；锚点写法不合法；锚点种类与所在元素不符（图上写 tbl: 之类，解析器 anchor-kind 为 error）；脚注重复定义 | 必改 | 新增 |
| C1 | 版本一致 | 元数据文件 version 与正文前 2000 字中出现的 `v数字.数字` 不一致；发布后与 published.json version、PDF 文件名中的版本不一致 | 提示 | 售前 C1（元数据文件由 doc.json 取代 brief.json；售前兼容期仍读 brief.json） |
| R1 | 绝对化用语 | 出现「零风险、无损、完全保证、确保排名、100% 通过、保证排名、绝对安全、万无一失」任一词，且同一行没有「不(承诺\|保证\|写\|提供)…该词」的否定语境；类型包 banned_terms 可追加 | 必改 | 售前 R1（词表原样保留，保证比对一致） |
| T1–T12 | 中文排版 | 见 typography.md | 见 typography.md | 新增 |
| E-TYPE | 类型包规则异常 | check(doc, ctx) 抛异常 | 必改 | 新增 |
| E-HOOK | 钩子故障 | pre_qa 退出码不是 0 或 3、stdout 不是合法 JSON、超时 | 必改 | 新增 |
| H1 | 高亮总量 | 全文 `⟪…⟫` 高亮数（解析器 doc.highlights）超过 qa.highlight_limits.total（默认 25） | 建议 | 新增（2026-09-15 主代理拍板吸收自《Shopify 建站方案 SKILL v1.5.0》；语法与计数由共享解析器实现） |
| H2 | 单页高亮密度 | 按页高亮数超过 qa.highlight_limits.per_page（默认 3）。读 out/render.json 的 highlights.per_page（{页: 数}）；render.schema.json 未收 highlights 字段期间 doc-render 另写 out/render.highlights.json（同结构），doc-qa 读它；两处都没有时不查（渲染未跑） | 建议 | 新增，同上 |
| H3 | 单处高亮长度 | 单个 `⟪…⟫` 的纯文本超过 qa.highlight_limits.max_length（默认 40 个汉字当量：East Asian Wide / Fullwidth 字符计 1，其余计 0.5）；高亮内容为空也记 H3 | 建议 | 新增，同上 |
| H4 | 高亮标记泄漏 | 解析器报 `⟪…⟫` 未配对、嵌套、跨行（渲染时这些分隔符会被丢弃，源文件与预期不符）；或 out/*.html、out/feishu.xml 存在时其中残留 `⟪` `⟫` 字符 | 必改 | 新增，同上 |
| X4 | 关键数字一致性 | 类型包 qa.key_figures 声明识别口径：每项 {id, label, pattern, normalize: number / text, severity}，pattern 为 Python 正则，命名组 value 取值、可选命名组 key 分组；同一组内出现多个不同的值即报（number 口径去千分位逗号后按数值比较）。在解析器纯文本单元（标题、段落、列表项、表格单元格、高亮块段落、图表题、脚注）上匹配：段落续行已按 DocMark 规则拼接，所以跨行数字能比对，代码块与 HTML 注释（含行内注释）不参与；行号为单元起始行；引擎不内置任何口径；章节、图、表引用是否指向存在的锚点由 X1–X3 负责 | 必改（可由口径 severity 改） | 新增（2026-09-15 同上拍板） |

说明：
- 版式事实（目录页码、书签、thead、按实际显示宽算的图字号、封面页眉）由 doc-render 写进 out/render.json 的 layout_issues（layout.md §12），D3 同时读取；doc-qa 不重复报这些。
- doc-qa 把 render.json 的 layout_issues 原样并入 qa-result（rule 与 severity 不改，file=out/render.json，位置写页码与 target；rule 为空时补 LY；同一图 L6 只因字号而让位时 LY4 消息末尾加「（另见 L6 字号）」，见 L6 行），便于报告完整；D3 仍单独检查 render.json。当前 doc-render 写入的编号与定级以 layout.md §12 为准，其中 2026-09-15 1b 新增两条：LY9 稀疏页（非自然章末页正文少于阈值，默认 400 字，建议）、LY10 自动生成的修订记录页或摘要页与正文同名章节重复（建议）。
- HL1 不是版式问题，不进 render.json：它是共享解析器对 `⟪…⟫` 的诊断（docmark-ast.md §7）。doc-render 不因 HL1 拒绝渲染（不在 REFUSE_CODES 内），而是丢弃非法分隔符照常输出（2026-09-15 读 doc-render/scripts/render.py、common.py 核实），所以定级由 doc-qa 决定：highlight-unclosed / unopened / nested / multiline 记 H4 必改，highlight-empty 记 H3 建议。
- 高亮按页统计：H2 读 render.json 顶层 highlights（字段存在即使用，per_page 为空也不回退）；字段不存在时才读旁路文件 out/render.highlights.json（兼容保留）。
- 高亮颜色前缀（`⟪!…⟫` / `⟪+…⟫` / `⟪~…⟫` / `⟪?…⟫`，docmark.md「重点高亮颜色前缀」）**不影响 H1–H4 的任何口径**：H1 与 H2 对 5 种 kind **合计计数**，不按颜色分配额度；H3 的长度按**去掉前缀后**的纯文本算（前缀不计入）；H4 只看分隔符配对与残留，与 kind 无关。引擎不感知 kind，`engine_rules.py` 无需按颜色分支。
- R1 词表里「确保排名」「保证排名」带营销语境，但属于通用绝对化承诺，保留在引擎。
- T11 与类型包 banned_terms（有 columns）的优先级（2026-09-15 主代理拍板）：同一单元格里类型包命中片段与内置命中片段重叠时，保留类型包的定级与文案、丢弃内置那条；同一行只留一条时类型包来源优先。优先级在 T11 内部完成（最终合并按定级取高，不识别来源）。数据块（CSV）单元格的 T11 问题报全文级（行号 0），摘录与消息写数据文件与 CSV 行号，按 CSV 行去重，避免各行共用指令行号被「同规则同行只留一条」合并。R1 不适用：内置绝对化词表是红线，类型包不能降级。
- H1–H4、X4（2026-09-15 追加）：doc-qa 1d 已实现。阈值与口径声明在 pack.json 的 qa.highlight_limits、qa.key_figures（pack.schema.json 新增的两个可选字段，不影响已有类型包）。「关键数字」的具体口径（哪些数字、正则怎么写）由各类型包自己声明，本文件不列举，避免引擎侧出现业务口径原词。

## 3. 合并、去重、截断

1. 类型包与钩子返回的问题补 rule_source；缺字段（excerpt 等）补空串，severity 非法记一条 E-TYPE / E-HOOK。
2. 应用 pack.qa.severity_overrides（规则编号 → 新定级）。
3. 去重键：(rule, line, message) 完全相同只留一条。
4. 同一规则同一行（line > 0）只保留一条：保留定级最高的那条（同级取第一条），消息末尾追加「（同一行另有 N 条同规则问题）」；line 0 为全文级问题，不合并。
5. 截断：单条规则超过 30 条时，非必改的超出部分折叠为一条汇总（line 0，「另有 N 处」，定级取被折叠问题中最高的）；**必改永不折叠**，保证 must_fix 如实计数。
6. must_fix = 必改条数；total = 条数。

## 4. 输出与退出码

- qa-result.json：字段见 artifacts.md §4，写之前按 schemas/qa-result.schema.json 校验。
- out/<源文件名>.resolved.md：include 展开后的正文（与 doc-render 写出的必须一致）。
- qa-report.md：覆盖 `<!-- qa-auto:start -->` 到 `<!-- qa-auto:end -->` 之间的自动区块；表头按 artifacts.md §5「| 编号 | 规则 | 定级 | 位置 | 原文摘录 | 证据 | 修改指令 | 状态 | 复核记录 |」：编号 Q1…，位置「第 N 行」或「全文」（问题不在正文时附 file），证据为规则说明并注明来源 engine / type / hook，修改指令与复核记录留空由人工填写，状态初始为「待修改」；区块外人工内容保留。
- 引擎故障（退出码 4：类型包读不出或不合法、rules_py 越出包目录、解析器不可用、规则代码异常、结果不过 schema）时，旧 qa-result.json 改名为 qa-result.json.stale，不留过期结果给 D3。run-state.json 为新格式而写回（set-stage、D3 fail-gate）失败时同样退出 4；此时 qa-result.json 已按本次结果写入。
- 退出码：0 无必改；3 有必改；1 缺源文件；2 用法错误；4 引擎自身故障（与售前 qa_checks.py 的 0 / 3 / 1 兼容）。

## 5. 人工检查与 Codex 两轮（通用流程）

从售前质检流程上移，与文档类型无关：

1. 自动检查：运行 doc-qa，结果进 qa-report.md 自动区块。
2. 人工检查：pack qa-rules.md 中「脚本」为否的规则逐条给结论（通过 / 问题）；问题写位置、原文、证据、修改指令。
3. Codex 找茬轮（codex exec，只读）：输入 out/<源文件名>.resolved.md、类型包声明的关键输入（关联文档、数据文件）与 qa-report 草稿，要求补漏并逐条落到段落。
4. 回原文核实 Codex 每条意见；需要网络或回执的事实由主代理自己取证（Codex 只看得到提问里给的摘要，会把有回执的完成态误判为杜撰）。
5. Codex 证伪轮：要求逐条论证「这条其实不是问题」；裁定为确认、降级（写理由）、撤回；撤回项对照 qa-rules.md 伪问题清单，新伪问题提议追加。
6. 修改源文件后重跑第 1 步；D3 会检查质检之后源文件是否又被改过。

降级：Codex 两轮因额度或容量失败（terra 与 sol 各试一次），在 qa-report.md 写明失败原因与本想让 Codex 挑的点，作为 D3 的 --evidence。Codex 返回的正文要原样展示给用户。
