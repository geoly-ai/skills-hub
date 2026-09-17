# 运行目录与工件字段

## 1. 运行目录

每份文档一个目录：`~/workspace/docs/<项目>/<类型>-<短名>-v<版本>/`。类型包 run_root 与 run_dir_pattern 可改（售前沿用 `~/workspace/presales/<客户>/<业务线>-v<版本>/`，避免迁移时改路径）。

| 文件 | 写入者 | 说明 | schema |
|---|---|---|---|
| doc.json | doc-orchestrator | 文档清单（§2） | schemas/doc.schema.json |
| run-state.json | scripts/run_state.py（引擎脚本在阶段完成时调用） | 阶段与门（§3、gates.md） | schemas/run-state.schema.json |
| outline.md | doc-author | 骨架，D1 用 | — |
| doc.md | doc-author | 正文源，DocMark 语法；类型包 source_file 可改名（售前 proposal.md） | — |
| sections/*.md | doc-author 或生成脚本 | 被 include 的片段 | — |
| data/*.csv | doc-author | 结构化数据（需求表、测试项表等），数据块渲染 | — |
| figures/*.mmd、*.dot、*.fig.json、手画成品 *.svg | doc-author | 图源（作者维护；W3 补登记：原表把图源与生成物都记在 doc-figures 名下） | — |
| figures/<名>.svg（由图源生成）、*.png、*.resolved.mmd | doc-figures | build 产物：PDF 用 SVG、PNG 预览、飞书用的预处理 Mermaid | — |
| figures/review.json | doc-figures（machine）+ 主代理（human） | 图检查记录，格式见 figures-policy.md §7 | — |
| base/ | scripts/import_doc.py | revision / import 模式的导入底稿 | — |
| qa-result.json | doc-qa | 结构化质检结果（§4） | schemas/qa-result.schema.json |
| qa-report.md | doc-qa（自动区块）+ 主代理 | 质检报告（§5） | — |
| out/doc.html、out/feishu.xml、out/*.pdf | doc-render | 渲染产物 | — |
| out/<源文件名>.resolved.md | doc-render、doc-qa | include 解析后的正文（两者写出的内容必须一致） | — |
| out/render.json | doc-render | 渲染记录与版式检查（§6） | schemas/render.schema.json |
| published.json | doc-publish | 发布记录（§7）；真发布写运行目录根与归档目录各一份 | schemas/published.schema.json |
| brief.json | doc-orchestrator（用户输入整理） | 建目录前收集的输入：doc.json 字段 + 类型包 inputs 的值（§8） | schemas/brief.schema.json（§8） |
| out/advance-last.json、out/publish-dry-run.json | doc-orchestrator advance.py | 最近一次判定结果；发布预检记录（绑定版本与哈希，§8） | — |
| out/published/v<版本>/ | doc-publish | 发布归档（§7.1）；dry-run 写 v<版本>.dry-run/ | — |
| out/trace-matrix.json、out/trace-matrix.md | scripts/trace_matrix.py（2026-09-15 W3-G） | 跨文档追踪矩阵（§9）：需求 → 设计章节 → 用例 → 执行结果 → 缺陷，与追踪缺口；md 为可 include 的 DocMark 片段 | schemas/trace-matrix.schema.json |
| out/sheet-export/、out/sheet-export.json | doc-publish export_cases_sheet.py（2026-09-15 W3-G） | 测试用例导出飞书电子表格的计划与写入记录（doc-publish/SKILL.md「测试用例导出电子表格」） | — |

## 2. doc.json

| 字段 | 必填 | 说明 |
|---|---|---|
| schema_version | 否 | "1" |
| type | 是 | 类型包 id |
| title、subtitle | title 必填 | 封面标题与副标题 |
| project | 是 | 项目或客户英文短名 |
| client | 否 | 对外文档的对象名，页脚 {party} 优先用它 |
| doc_no | 否 | 文档编号（technical 封面） |
| version、date | version 必填 | 版本号 `1.0` 或 `1.0.1`；日期 YYYY-MM-DD |
| status | 是 | draft、review、approved、published |
| audience | 是 | internal、external；应与品牌档案一致（不一致给警告） |
| brand | 是 | 品牌档案 id：cyberklick、internal |
| language | 是 | 如 zh-CN |
| owner | 是 | 文档负责人 |
| reviewers | 否 | 每项为「姓名（角色）」字符串，或 {name, role, decision: pending / approved / changes_requested / rejected, date}；technical 封面要显示评审结论时用对象 |
| related_docs | 否 | 跨文档读取的唯一入口，结构见 §2.1 |
| revision_history | 否 | [{version（可带 v 前缀）, date, author, summary}]；internal 档案生成修订记录页；应包含当前 version（不含时给警告） |
| cover | 否 | {subtitle, meta[]} |
| contact | 否 | {name, title, email, phone}；org_section.py 用 |
| lark_folder | 是 | {token, path} 或 {pending_reason, path}；D4 必须有 token（decisions ⑫A，全局约定：飞书文档放项目文件夹，不留根目录） |
| lark_profile | 否 | lark-cli 账号，如 account1、account2 |
| extra | 否 | 类型包专属字段；类型包 doc_extra_schema 可约束 |

### 2.1 related_docs（跨文档读取机制，主代理 2026-09-15 定）

每项：

| 字段 | 必填 | 说明 |
|---|---|---|
| type | 是 | 对方的类型包 id |
| path | 是 | 对方运行目录，或对方的 doc.json。相对路径按**当前运行目录**解析；也可写绝对路径（支持 ~） |
| role | 是（2026-09-15 契约第二轮定为必填） | 本文档与对方的关系，小写下划线；推荐词表见下，没有更具体的关系时写 references。缺 role 时 doc.schema 校验不过，related.py 解析结果 ok=false、error 说明缺 role |
| version | 否 | 登记时对方的版本（可带 v）；与对方 doc.json 当前版本不一致时解析结果给 version_mismatch |
| title、url | 否 | 人读用；同 type 同 role 多份时 title 用于区分 |

role 推荐词表（类型包可扩展，扩展时写进 pack.json related 并补本表）：

| role | 含义 | 典型方向 |
|---|---|---|
| source_mrd | 本文档依据的 MRD | prd → mrd |
| source_prd | 本文档依据的 PRD | tech-spec、test-plan、test-cases → prd |
| source_spec | 本文档依据的技术 Spec | api-reference、test-plan → tech-spec |
| executes_plan | 本文档执行对方的测试计划 | test-cases、test-report → test-plan |
| reports_on | 本文档报告对方的执行结果 | test-report → test-cases |
| covered_by | 本文档的需求被对方覆盖 | prd → test-cases |
| supersedes | 取代对方旧版 | 任意 |
| references | 一般参考 | 任意 |

解析与读取：scripts/related.py（库与 CLI）。只能读对方运行目录内的文件（如 data/requirements.csv），路径越界抛错。

找不到或读不出时的定级：**D2 门相关的检查为必改，其余为提示**（related.missing_severity、missing_issue）。类型包在 pack.json related 里声明需要哪些关联文档、是否 D2 相关（for_gate）、是否 D0 必需（required；run_state.py D0 检查已登记且可解析）。

样张目录里的相对路径按样张运行目录本身计算，例如 staging/types/prd/samples/<样张>/ 指向 mrd 包的样张应写 `../../../mrd/samples/<样张>`。

## 3. run-state.json

schema_version、doc_type、mode（new / revision / import）、base_doc、base_version、stage、gates（D0–D4 各 {status, at, by, evidence[], reason, checks[]}；D3 通过时另有 source_manifest，格式见 gates.md §6）、decisions（拍板项键值）、user_words（用户原话）、legacy（兼容期旧状态，只读）、history[{at, action, gate, stage, by, detail}]、updated_at。

## 4. qa-result.json

| 字段 | 说明 |
|---|---|
| generated_at | 本地时间 ISO 8601 |
| source_sha256 | 解析 include 后正文的 sha256（新增；旧产物无） |
| engine | {name, version, pack, pack_version, rules_run[]}（新增） |
| must_fix | 必改条数，必须等于 issues 中必改的条数 |
| total | issues 条数 |
| issues | [{rule, severity（必改 / 建议 / 提示）, line（解析后正文的行号，0 表示全文级）, excerpt（≤ 120 字）, message, rule_source（engine / type / hook，新增）, file（问题不在正文时的文件）}] |

旧售前 qa_checks.py 产物（无 rule_source、engine、source_sha256）同样通过 schema。

## 5. qa-report.md

一条问题一行：编号 | 规则 | 定级 | 位置 | 原文摘录 | 证据 | 修改指令 | 状态（待修改 / 已修改 / 降级 / 撤回）| 复核记录。

自动区块用 `<!-- qa-auto:start -->` 与 `<!-- qa-auto:end -->` 包住，每次质检覆盖；区块外的人工内容保留。末尾附 Codex 两轮原文位置与采纳说明（流程见 qa-engine.md §5）。

## 6. out/render.json

schema_version、generated_at、source_sha256、renderer{name, version, chrome, printer, passes}、profile、cover、pdf{path, pages, bookmarks, bytes, metadata}（只出飞书时为 null）、html、toc[{level, number, title, anchor, page}]、figures[{id, number, caption, src, svg, engine, viewbox_width, min_font_px, min_font_pt, display_width_mm, page, referenced}]、tables[{id, number, caption, columns, rows, has_thead, widths_given, dense, landscape, page, referenced}]、layout_issues[{rule, severity, message, page, target}]（规则见 layout.md §12）、feishu{path, whiteboards, whiteboards_mermaid, images, code_blocks}、docx（未输出时为 null）{path, bytes, headings, tables, images, missing_images[], footnotes, footnote_repeats, highlights, code_blocks, callouts, sections, landscape_sections, toc, readback{ok（无必改级失败）, all_passed（全部检查通过，含建议级）, checks[{rule（DX1–DX9）, name, ok, severity, expected, actual}], highlights[], soffice（未安装 LibreOffice 时为 null）{ok, version, pages, landscape_pages, fonts[], blank_pages[], error}}}（规则见 layout.md §13）。

render.json 记录本次打印所用 Chrome 版本（design 风险表：Chrome 升级改变打印行为）。

## 7. published.json

schemas/published.schema.json。写入者 doc-publish（scripts/publish.py），校验通过才写。四种形态由 schema oneOf 约束：dry-run 新建（有 plan；verify、lark_doc_id、lark_url 为 null）；dry-run 覆盖（有 plan；lark_doc_id 为覆盖目标；verify、lark_url 为 null）；真发布且回查完成（verify 为完整对象、有 lark_doc_id 与 lark_url、无 plan）；真发布已写入飞书但回查未完成的恢复记录（verify 为 null、problems 至少一条、有 lark_doc_id 与 lark_url、无 plan）。两种真发布形态的 lark_folder 必须有 token，且 path 至少「客户或项目/子项目」两段。正式归档里的 published.json 读不出或不合 schema 时，doc-publish 拒绝再发布同一版本（无法确认是否已发布）。

| 字段 | 说明 |
|---|---|
| schema_version、engine | "1"；{name, version} |
| dry_run | true 表示只做了预检与计划（只写 out/published/v<版本>.dry-run/published.json，不写运行目录根） |
| doc_type、title、version、date、published_at | 发布的文档；published_at 为本地时间 ISO 8601 |
| lark_doc_id、lark_url、lark_profile | 飞书文档；dry-run 新建时 id 与 url 为 null；lark_profile 为 account1 或 account2 |
| lark_folder | {token, path, created[{name, token, parent_path}]}，与元数据 lark_folder 一致；token 是按 path 从根目录逐层解析出的末级文件夹；created 为本次新建的文件夹；dry-run 且文件夹待建时 token 为 null |
| mode | create 或 overwrite |
| source_sha256、gate_d3 | 发布时现算的正文哈希（等于 qa-result.json 与 render.json 的 source_sha256）；D3 状态 passed 或 waived |
| meta_canonical_sha256、freshness_check | 元数据文件去掉 lark_folder 后的规范 JSON sha256（口径同 gates.md §6）；新鲜度检查方式 manifest（与 gates.D3.source_manifest 比内容）或 mtime（旧 run-state 或 D3 豁免，严格修改时间比较；元数据晚于产物时只有本字段与当前一致才放行） |
| recovery_abandoned | 按 --abandon-recovery 放弃恢复记录或未决新建时的留痕：{previous_doc_id, previous_url, intent, evidence[], at} |
| pdf_path、docx_path、feishu_xml_path、qa_result_path、qa_report_path、render_json_path | 归档目录内的相对路径（相对运行目录）；docx、qa-report 没有时为 null |
| archive_dir、archive | 归档目录；[{role（pdf / docx / feishu_xml / render_json / qa_result / qa_report / resource）, source, path, bytes, sha256}] |
| verify | 回查：{whiteboards, whiteboards_expected, images, images_expected, code, code_expected, inline_code, italic, del, asterisks_extra}；dry-run 与恢复记录为 null；类型包允许代码块时 code_expected 为源文件代码块数 |
| problems、warnings | 回查问题（空表示通过）；预检与解析警告 |
| extra | 钩子 pre_publish / post_publish 返回的字段（如某业务线的模型哈希），引擎原样合并，同名键 post 覆盖 pre |
| plan | 只在 dry-run：{writes[argv], folders_to_create[{name, parent_path, parent_token}], d4_ready, d4_note}；待建父文件夹的 token 写「<待建:名>」占位 |

兼容：售前旧 published.json 的 client、line、pricing_model_hash 等字段由售前包装层继续写（schema 允许这三个字段），1f 决定何时迁入 extra。

### 7.1 发布归档 out/published/v<版本>/

| 文件 | 来源 |
|---|---|
| <类型包 filename 模板>.pdf | render.json pdf.path |
| <同名>.docx | render.json docx.path；未登记时取与 PDF 同名的 .docx（不得比 PDF 旧），没有就不带 |
| feishu.xml、render.json、qa-result.json、qa-report.md | 原名复制（qa-report.md 有才带） |
| feishu.xml 以 @./ 引用的本地资源 | 保持相对路径（如 figures/x.svg） |
| published.json | 本次发布记录 |

create 之前先写 out/published/.create-intent.json（新建意图：schema_version、created_at、version、source_sha256、folder_token、folder_path、title、argv，全部必填），create 成功并落下恢复记录后删除；确认门退出码 10（请求未执行）时也删除。意图文件存在即未决（结构不合法同样算），之后的发布一律退出 8，直到 --doc-token 经只读核对（意图文件夹里同名文档的 token 一致）或 --abandon-recovery --evidence。写入这些文件与归档目录时，路径任何一级是软链或越出运行目录都拒绝。威胁模型：运行目录由单用户、单进程可信写入；类型包钩子是可信目录里的包代码，快照与复核防误改、不防恶意；检查与使用之间的竞态（校验后路径被并发换成软链）是已知限制（详见 doc-publish SKILL.md「威胁模型」）。apply 先写 out/published/.staging-v<版本>/，飞书写入成功后替换为正式目录（旧目录先改名备份，换入失败还原）；写入前失败则删除暂存目录。dry-run 同样先写 .staging-v<版本>.dry-run/，全部通过才替换 v<版本>.dry-run/，失败时保留上一次 dry-run 记录。同一版本在运行目录根记录或正式归档记录里已写入过飞书（含恢复记录）且 source_sha256 不同时拒绝发布（先升版本号；恢复记录经用户确认可 --abandon-recovery）；相同时允许重发并替换归档。

## 8. brief.json 与编排记录（doc-orchestrator，2026-09-15 W3 补登记）

brief.json 是建运行目录前的输入整理，由 doc-orchestrator/scripts/new_run.py 校验后写 doc.json，并原样存入运行目录（算源文件）。

| 字段 | 说明 |
|---|---|
| doc.json 可写字段 | title、subtitle、project、owner、reviewers、version、date、doc_no、client、cover、contact、related_docs、revision_history、lark_folder、lark_profile、extra、status、audience、brand、language；含义同 §2。缺省：status draft、version 0.1、date 当天、audience 与 brand 取类型包 audience、brand_profile、language zh-CN |
| inputs | {类型包 inputs[].id: 文本或运行目录内路径}；类型包 inputs 中 required 为真、且没有 path / doc_field 可自动核对的项必须有值 |
| $comment | 可选注释；其他未知字段报错（类型包专属字段放 extra） |

缺项判定（new_run.py 退出 3，不建目录）：doc 必填 title、project、owner、lark_folder；类型包 required inputs；类型包 related 中 required 的关联文档已按 type + role 登记且 path 可解析；doc.json 不过 schema。advance.py 在执行 D0 前再核对一次 brief.json inputs。

schema：schemas/brief.schema.json（2026-09-15 W3-E），oneOf 两个互斥分支：

| 分支（$defs） | 用于 | 判定与深度校验 |
|---|---|---|
| doc_brief | new_run.py 的 brief（上表字段） | 只含 doc.json 可写字段、inputs、$comment、schema_version、type；各 doc 字段再按 doc.schema.json 同名字段校验 |
| presales_brief | 售前业务线 brief（字段口径 presales-shared/references/artifacts.md） | 至少含一个售前独有键（line、mode、currency、validity_days、goal、deadline、site、reddit、overview、sources、client_cn）；line 为 site 时不得有 reddit 段，反之亦然；lark_folder 按 doc.schema.json 校验 |

两个分支都不设必填（改版 brief 只写要改的字段、售前脚本自测的片段 brief 都要能通过）。必填登记在 doc_brief_strict、presales_brief_strict：默认给警告，严格模式算错误。

- 命令：`validate.py brief.json [--family doc_brief|presales_brief] [--strict] [--pack <类型包目录>]`；--pack 的类型包声明了 modes 时核对 mode 字段取值，无法识别为错误。
- 库：`validate.validate_brief(data, family=None, strict=False, pack=None)` → (errors, warnings)；`validate_data('brief', data)` 等于非严格自动判分支。
- 接入现状（2026-09-15）：doc-orchestrator 已接入——new_run.py 用 validate_brief(family=doc_brief, strict=False) 校验结构（错误退出 2，缺必填转追问退出 3）；advance 在元数据为 doc.json 时 D0 前 strict 校验；run_state.py D0 在 doc.json 运行目录存在 brief.json 时 strict 校验并拒绝错误（警告写入 checks，前缀「notes：」，--no-pack 不可跳过）。售前 G0 接入由 1f 完成。

out/publish-dry-run.json（advance.py 写）：{at, argv, exit_code, doc_version, render_sha256, qa_sha256, apply（恒为 false）, output（doc-publish 输出）}。doc_version 或任一哈希与当前 doc.json、render.json、qa-result.json 不一致即视为过期重跑。

## 9. out/trace-matrix.json（跨文档追踪矩阵，2026-09-15 W3-G）

写入者 doc-shared/scripts/trace_matrix.py（只读关联文档，只写 --out 目录，默认运行目录 out/；--snippet 另写一份到类型包 include_allow 允许的路径）。schema：schemas/trace-matrix.schema.json（脚本写出前自校验）。

命令：`trace_matrix.py <运行目录> [--prd|--spec|--plan|--cases|--report 目录] [--scan 根目录] [--out 目录] [--snippet sections/trace-matrix.md [--force]] [--print]`。退出码：0 无必改缺口；3 有必改缺口；2 用法错误、同类型多份未指定、找不到 PRD 或 PRD 无需求、文档或类型包读取失败、输出不合 schema。

| 字段 | 说明 |
|---|---|
| schema_version、generated_at、engine | "1"；本地时间 ISO 8601；{name, version} |
| root_run_dir | 输入运行目录（realpath） |
| labels | {requirement, case, defect}：显示名，取 PRD、test-cases、test-report 类型包 numbering.entities[].label（缺省 需求 / 测试项 / 缺陷）；片段表头与缺口说明用它，引擎脚本不写死业务词 |
| docs | {prd, tech-spec, test-plan, test-cases, test-report}：{run_dir, title, version} 或 null（沿 related_docs 未找到）；同类型多份时须用 --prd 等显式指定 |
| links | 已发现文档的全部 related_docs：[{from_type, from_run_dir, to_type, to_run_dir, role, registered_version, current_version, match（true / false；未登记版本或无法解析为 null）, resolved}] |
| requirements | PRD 实体（numbering.entities）：[{code, kind, title, priority, prd_section{number, title, line}, design[{number, title, line}], cases[用例编号], defects[缺陷编号], status}]；status：uncovered（无用例）、not_reported（无报告）、not_executed、partial、passed、failed、blocked |
| cases | test-cases 实体：[{code, title, priority, module, requirements[需求编号], result, defects[], line, file, csv_line}]；result 为 null 或 {status（passed / failed / blocked / not_executed / null 表示词表外）, raw_status, executed_by, executed_at, note, source} |
| defects | test-report 缺陷表：[{code, title, severity, status, cases[用例编号], source}] |
| summary | {requirements, designed, with_cases, cases, cases_linked, results, passed, failed, blocked, not_executed, no_result, defects, must_fix, complete（prd、tech-spec、test-cases、test-report 四份都找到）} |
| gaps | [{kind, severity（必改 / 建议 / 提示）, code, doc_type, line（正文行号）, file、csv_line（数据文件与行号）, message}]，kind 与定级见下表 |
| skipped_checks | 因缺文档或缺执行表没有做的检查：[{kind, reason}] |
| warnings | 关联文档无法解析、扫描截断等 |

| gap kind | 定级 | 判据 |
|---|---|---|
| doc_missing | test-cases 必改；tech-spec 建议；test-report 提示 | 沿 related_docs（与 --scan）找不到该类型文档；PRD 缺失直接退出 2 |
| req_not_designed | P0 建议，其余提示 | 需求编号没有出现在 tech-spec 第一个标题之后的正文或数据块里（遮蔽代码块与 HTML 注释；识别简写续号 REQ-X-01/02） |
| req_no_cases | P0、P1 必改，其余建议 | 没有用例的「关联需求」列引用该需求 |
| case_unknown_req | 必改 | 用例关联的需求编号不在 PRD，或关联需求列有值但不符合 PRD 编号格式 |
| case_no_req | 建议 | 用例没有关联需求列或为空 |
| case_no_result | 建议 | 报告里有执行表，但该用例没有执行结果 |
| result_unknown_case | 建议 | 执行表里的用例编号不在测试用例文档 |
| result_invalid_status | 建议 | 执行状态不在词表：通过 / 失败 / 阻塞 / 未执行（及同义：成功、不通过、受阻、跳过、待执行，英文 pass、fail、blocked、skipped、not run） |
| result_conflict | 建议 | 同一用例多条不同执行结果；取先出现的（data/*.csv 按文件名序，先于正文表格） |
| report_no_execution | 建议 | 报告 data/*.csv 与正文表格都没有执行表（一列多数单元格含 test-cases 实体编号 + 状态或结果列，且多数状态值在词表内；编号列按取值识别，不认列名） |
| defect_unknown_case | 建议 | 缺陷表（一列多数为 report 类型包实体编号 + 另一列含 test-cases 实体编号）关联的编号不在 test-cases 文档 |
| duplicate_code | 建议 | 需求或用例编号重复定义（用例仅内容不同时报） |
| version_mismatch | 建议 | related_docs.version 与对方 doc.json version 规范化后不同（scripts/versions.py：1.0 = 1.0.0 = v1.0） |

out/trace-matrix.md：首行生成标记注释；「需求追踪矩阵」表（需求编号 | 优先级 | 设计章节 | 用例编号 | 执行结果 | 缺陷，每个需求 × 用例一行，无用例的需求一行填「—」），有缺口时再加「追踪缺口」表；不含标题，test-plan、test-report 用 `<!-- include: sections/trace-matrix.md -->` 引入（先 `--snippet sections/trace-matrix.md` 生成；已有文件不是生成的时拒绝覆盖，--force 才覆盖；写入即改动源文件，D3 签门清单需重签）。
