---
name: doc-orchestrator
description: 专业文档生产体系（doc-*）的通用入口：用户要写或改任何 doc-* 类型文档——技术 PRD / 产品需求文档、MRD / 市场需求文档、技术方案 / 设计文档 / Spec、API 参考 / 接口文档、测试计划、测试用例、测试报告——并要求结构完整、品牌版式、目录页码、图表编号、PDF 与飞书双输出时使用。负责判型（判不准给选项问用户）、收 brief 并追问缺项、建运行目录、守 D0–D4 门、按顺序调 doc-author → doc-figures → doc-render → doc-qa → doc-publish、组织 Codex 找茬与证伪两轮、改稿与版本迭代、跨文档（PRD → Spec → 测试计划 → 用例 → 报告）需求与用例追踪复查。售前方案（建站、Reddit、报价、RFP）转 presales-orchestrator；只读、总结或小改一篇已有飞书文档、周报纪要这类轻量文档走 lark-doc。
---

> **路径约定**：`<doc-X>` = 兄弟 skill doc-X 的目录（与本 SKILL.md 同级；矩阵由 pack 整体安装，成员始终并排）。

# doc-orchestrator（编排入口）

开工前读 doc-shared/SKILL.md，按需读 references/gates.md（门）、artifacts.md（工件与 brief）、pack-interface.md（类型包）、qa-engine.md §5（Codex 两轮）。本 skill 不写正文、不算版式、不定规则：写作交 doc-author，图、渲染、质检、发布交各引擎，规则以 doc-shared 为准。

脚本目录 `S=<doc-orchestrator>/scripts`；门状态只通过 `python3 <doc-shared>/scripts/run_state.py` 写。

## 1. 流程

| 步 | 做什么 | 命令 | 完成条件 |
|---|---|---|---|
| 1 判型 | 把用户原话映射到类型包 | `python3 $S/detect_type.py "<原话>"` | 退出 0（single）直接用；3（ask）把 options 按字母发给用户选；4（handoff）转 presales-orchestrator 或 lark-doc，本 skill 结束 |
| 2 收 brief | 按 pack.json 收 doc.json 必填项、inputs 必需项（声明了 path 的给本机文件路径，建目录时复制进去）、related 必需的关联文档；能从链接、文件、已有文档查到的先自己查 | 写 brief.json（字段见 artifacts.md §8） | 下一步 new_run 不再退出 3 |
| 3 建运行目录 | 目录 `~/workspace/docs/<项目>/<类型>-<短名>-v<版本>/`（类型包 run_root / run_dir_pattern 可改） | `python3 $S/new_run.py <type> <目录> --brief brief.json [--import <旧稿>]` | 退出 0：doc.json、brief.json、run-state.json、outline.md、doc.md 骨架、figures/、data/ 就绪；退出 3 时把 ask_user 一次性问用户（带默认值），补齐后重跑 |
| 4 D0 | 输入齐 | `python3 $S/advance.py <目录> --run`（自动过 D0 后停在 D1） | gates.D0 passed |
| 5 D1 | 把 outline.md 发给用户（章节树 + 带字母选项与代价的拍板项，按全局约定可勾选）；逐项 `run_state.py <目录> decide --key ① --value "A …"`；纳入的按需章节 `doc-author/scripts/outline.py <目录> --add-section <id>` | `run_state.py <目录> pass-gate --gate D1 --evidence "<用户原话>"` | gates.D1 passed，decisions 与 outline 拍板项数一致 |
| 6 写正文 | 读并执行 doc-author/SKILL.md：逐章回答 must_answer、数据块、图源、summary 块 | doc-author 的 fill_check / lint_draft | `fill_check.py` 退出 0 |
| 7 D2 + 图 + 渲染 + 质检 | 本地脚本步骤全部由 advance 串联：D2（类型包无 D2 时 skip；有命令时 `pass-gate --run`）→ doc-figures build → doc-render → doc-qa | `python3 $S/advance.py <目录> --run` | 停在 gate-D3；qa-result.json must_fix 0；render.json 无版式必改。阻塞时按 blocking_reasons 交回 doc-author 改源文件，再跑 advance（过期产物自动重跑） |
| 8 D3 | Codex 找茬 + 证伪两轮（§4），结论与采纳说明写进 qa-report.md 人工区块；采纳后改了源文件就回第 7 步 | `run_state.py <目录> pass-gate --gate D3 --evidence "qa-report.md「Codex 找茬与证伪」节"` | gates.D3 passed |
| 9 发布预检 | doc-publish dry-run（归档、飞书文件夹解析、写入计划，不写飞书） | `python3 $S/advance.py <目录> --run`（离线时加 `--publish-offline`） | out/publish-dry-run.json 退出码 0。退出 5（文件夹归属）、6（覆盖目标有评论）、7（写命令结果不确定，可能已写入）、8（存在未决新建或恢复记录）、10（高风险确认门）时 advance 阻塞、runnable=false，输出 question 与带代价的字母选项，主代理原样转给用户；不自动重试，不自动加 --abandon-recovery、--create 或任何确认 flag，用户选定后由主代理手动执行并记原话 |
| 10 D4 + 发布 | 把 PDF（out/*.pdf）与发布计划给用户看，确认范围、版本、飞书账号、项目文件夹 | `python3 <doc-publish>/scripts/publish.py <目录> --apply --evidence "<用户确认原话>"`（doc-publish 写飞书前自己 pass-gate D4） | 根目录 published.json 过 published.schema、dry_run 为 false、verify 为对象、lark_doc_id 与 lark_url 齐、problems 为空、版本与 doc.json 等值；archive 唯一的 role=pdf 条目在运行目录内且文件存在、bytes 与 sha256 正确、与当前渲染 PDF 哈希一致（source 只作溯源）；advance 显示 done |
| 11 交付 | 飞书链接、PDF 路径、版本号、qa-report 遗留建议项、未经 Codex 复核的说明（如有）、待下游复查的文档（§6） | `python3 $S/status.py <目录>` | — |

doc-publish 退出码的处理（dry-run 由 advance 自动映射；--apply 由主代理手动执行，照同一张表处理；对齐 doc-publish/SKILL.md 退出码表）：

| 退出码 | 含义 | advance 输出 | 下一步 |
|---|---|---|---|
| 0 | 成功 | dry-run 后停在用户确认发布 | 把 PDF 与 plan 给用户看，确认后 --apply --evidence 原话 |
| 1 | 预检拒绝 | actor=author，runnable=false | 按 problems 回 doc-qa / doc-render 或升版本 |
| 2 | 用法或读写错误 | actor=orchestrator | 修命令或运行目录后重跑 |
| 3 | 已发布但回查不通过 | actor=orchestrator | 局部修复，不重建文档 |
| 4 | pre_publish 钩子失败或越权 | actor=orchestrator | 看钩子输出，修前置条件或钩子 |
| 5 | 文件夹归属需拍板 | actor=user，question + 字母选项 | 用户选定后改 lark_folder 或加 --allow-new-project-folder 再跑 |
| 6 | 覆盖目标有评论 | 同上 | 用户选改 --create 新建或先处理评论 |
| 7 | 写命令结果不确定，可能已写入 | 同上 | 先只读核对飞书，再由用户决定是否重跑 |
| 8 | 存在未决新建或恢复记录 | 同上 | 用户决定续用（--doc-token）或放弃（--abandon-recovery --evidence 原话，主代理手动加） |
| 10 | 高风险确认门 | 同上 | 向用户展示 action 与 risk，取得显式同意后主代理手动处理 |

所有非 0 码：runnable=false，advance 不自动重试（同一份预检记录不重跑），从不自动追加 --apply、--create、--abandon-recovery 或确认 flag。

任何时候不确定进度：`python3 $S/status.py <目录>`（人读）或 `python3 $S/advance.py <目录>`（JSON：step、actor、next_command、blocking_reasons）。advance 每次从头判定，不信任 stage 字段。

## 2. 门：通过条件、谁签、失败回到哪

| 门 | 通过条件（run_state.py 自动检查 + 本 skill 追加） | 谁签 | 失败回到 |
|---|---|---|---|
| D0 输入齐 | doc.json 过 schema 与语义；类型包 inputs（path 存在、doc_field 非空）、required 关联文档可解析；文本型必需输入在 brief.json inputs 里非空（run_state 强制） | 脚本（advance --run） | 第 2 步补 brief（改 brief.json / doc.json 后重跑 advance） |
| D1 骨架 | outline.md 存在；run-state decisions 条数不少于 outline 的 ①② 拍板项（至少有 ① 骨架确认）；证据为用户原话或「①A ②B」（run_state 强制） | 用户 | 第 5 步：改 outline 重新拍板；拍板改了按需章节就 --add-section 或删节 |
| D2 类型专属 | 类型包 gates.D2 命令退出码在 pass_exit_codes 内，且必须由 run_state --run 执行（不带 --run 拒绝）；无 D2 时 skip（带原因） | 脚本 | 第 6 步：按命令输出改数据（如覆盖矩阵）后重跑 advance |
| D3 质检 | must_fix 0；render.json 无版式必改；质检与渲染之后未改源文件（严格比较，无容差）；qa-report.md 人工区块非空，正文行记有 Codex 找茬、证伪两轮（或两轮均失败的降级说明）；证据写出文件名或人工区块标题（run_state 强制）。通过时写 gates.D3.source_manifest（gates.md §6），发布前 `run_state.py <目录> check-manifest` 核对 | 主代理（Codex 结论为输入） | 第 6 步改源文件 → 第 7 步自动重跑。D3 通过后源文件变了：advance 第一时间给出 reset-D3（先于正文、交叉引用检查），重走 7–8。有 source_manifest 时按内容比对（doc.json / brief.json 去掉 lark_folder，doc-publish 写回 token 不作废 D3、不触发重渲染；改内容后回拨修改时间也查得出），没有 manifest（豁免或旧 run-state）时严格比较修改时间 |
| D4 发布 | 用户看过 PDF 并确认范围、版本、账号、文件夹；doc.json lark_folder 有 token（doc-publish 解析出 token 会写回 doc.json，修改时间照常更新；D3 已签时 advance 按 source_manifest 内容比对（去掉 lark_folder），所以不触发 D3 过期） | 用户（证据由 publish.py --apply 写入） | 第 9 步：文件夹、评论、范围问题问用户后重跑预检 |

waive：只有 D2、D3 可以豁免，必须 `--by <拍板人> --reason`，并在交付说明里写明。D0、D1、D4 不能豁免。

## 3. advance.py 的执行边界

| 步骤 | advance --run 自动执行 | 说明 |
|---|---|---|
| pass-gate D0、skip-gate / pass-gate --run D2、reset-gate D3（源文件在 D3 后被改：有 manifest 按内容、无 manifest 按修改时间；判定排在 fill_check 与 xref 之前）、set-stage done | 是 | 纯机器检查 |
| xref_check（带 --pack 与当前类型包） | 是（只读） | 退出 3 阻塞交写作者；退出码不是 0 也不是 3 按引擎故障阻塞（advance 退出 1），不跳过 |
| doc-figures build、doc-render、doc-qa | 是 | 产物缺失或早于源文件时重跑；退出 1 / 3 且产物已写出时转为阻塞原因（actor=author）；执行后仍判为同一待执行步骤（引擎没产出）时退出 1，不重复执行 |
| doc-publish dry-run | 是 | 记录写 out/publish-dry-run.json，绑定 doc.json 版本与 render / qa 的 source_sha256，任一变化重跑；同一份记录退出码非 0 时不重跑（5 / 6 / 7 / 8 / 10 转用户选项，其余交写作者或主代理） |
| source_manifest 核对 | 是（只读） | D3 已签时 advance 用 run_state.diff_manifest 判改源；doc-publish 预检调用 `run_state.py <目录> check-manifest`（stdout JSON 含 added / removed / changed，一致退出 0、不一致 3、无 manifest 1），两边同一份清单 |
| D1、D3、D4、publish --apply、写正文 | 否 | 分别需要用户原话、Codex 两轮、用户确认、写作 |

advance 只往 out/ 写（advance-last.json、publish-dry-run.json），不会让 D3 判「质检后改过源文件」。退出码：0 无阻塞；3 阻塞；1 执行的步骤故障；2 用法错误。

## 4. Codex 找茬与证伪（D3，qa-engine.md §5）

1. 人工检查：类型包 qa-rules.md 中「脚本：否」的规则逐条给结论，写进 qa-report.md。
2. 找茬轮（只读）：
   ```sh
   codex exec -m gpt-5.6-terra -c model_reasoning_effort="xhigh" -s read-only -C <运行目录> --skip-git-repo-check \
     -o /tmp/codex-doc-<短名>-hunt.txt "你是评审。读 out/doc.resolved.md、qa-report.md、data/、关联文档（doc.json related_docs）与类型包 qa-rules.md，找出 doc-qa 没报的问题：事实与数字矛盾、must_answer 没答、验收不可核验、范围矛盾、编号与关联文档对不上、图与正文不一致。逐条给：位置（章节与原文）、问题、证据、修改指令。" < /dev/null
   ```
3. 回原文核实每一条；需要网络或回执的事实主代理自己取证（Codex 只看得到提问里给的内容）。
4. 证伪轮：`codex exec resume --last "逐条论证上面每个问题其实不是问题；给出确认 / 降级 / 撤回的建议和理由"`（续聊沿用第 2 步模型）。
5. 裁定写进 qa-report.md 人工区块「Codex 找茬与证伪」节：每条标确认 / 降级（理由）/ 撤回；撤回项对照 qa-rules.md 伪问题清单。
6. 采纳后改源文件 → advance --run 重跑 → 再 pass-gate D3。
7. terra 报容量满换 `-m gpt-5.6-sol -c model_reasoning_effort="medium"`；terra 与 sol 各试一次都失败（429 等）时，在 qa-report.md 写明失败原因与本想让 Codex 挑的点，作为 D3 证据，交付说明写「未经 Codex 复核」。
8. Codex 返回的正文原样展示给用户，开头标「Codex:」。

## 5. 改稿与版本迭代

| 场景 | 做法 |
|---|---|
| 同一版本内改稿（D3 前） | 直接改源文件，advance --run 自动重跑图、渲染、质检；版本号不变 |
| 同一版本内改稿（D3 后、未发布） | 改源文件后 advance 给 reset-D3，重走质检与 Codex；doc-publish 只写回 doc.json lark_folder 时按 source_manifest 内容比对不触发 |
| 已发布后出新版本 | 新建运行目录：`python3 $S/new_run.py <type> <新目录 …-v<新版本>> --from <上一版目录> --version <新版本> --change-summary "<本版改了什么>" [--brief 只写要改的字段]`（不接受任何 --mode；path 型必需输入：brief 显式给新文件就覆盖旧副本，没给才复用上一版文件）。复制正文、data、figures、sections；base/base-doc.md 保存上一版正文快照；related_docs 相对路径按新目录重算；revision_history 追加本版；status 回 draft；run-state mode=revision、base_doc 指向上一版目录；门从 D0 重走（D1 把改动范围发给用户确认） |
| 只有飞书或 PDF 旧稿 | `new_run.py … --import <飞书链接 / token / fetch JSON / XML / PDF> [--mode revision]` → base/base-doc.md 作底稿，正文重写进 doc.md；数据块、生成章节一律重新生成 |
| 发布方式 | doc-publish 默认沿用 published.json 的 lark_doc_id 覆盖；新版本新目录没有 published.json 时：要保持原链接用 `--doc-token <旧文档>` 覆盖，覆盖目标有评论（退出 6）时问用户是否改 `--create` 新建 |

版本号语义（doc.json version，`主.次` 或 `主.次.修订`，比较时 1.0 = 1.0.0）：

| 变化 | 含义 | 例 |
|---|---|---|
| 主版本 X.0 | 评审通过的基线；范围、验收口径或对下游的承诺变了 | 0.3 → 1.0（首次评审通过）；1.2 → 2.0（新增模块、删需求） |
| 次版本 X.Y | 基线内的实质修改：补需求细节、改指标、改图，下游需要复查 | 1.0 → 1.1 |
| 修订号 X.Y.Z | 不改语义的勘误：错别字、排版、链接 | 1.1 → 1.1.1（下游不必复查） |

修订记录：每个版本一条 `{version: "v1.1", date, author, summary}`，summary 只写「改了什么、影响哪些编号或章节」，不写讨论过程；internal 品牌档案由引擎生成修订记录页。

**交叉引用复查（每次出次版本或主版本都跑）**：
```sh
python3 $S/xref_check.py <新目录> --scan ~/workspace/docs/<项目>
```
- 上游：本文 related_docs 登记版本与对方当前版本不一致 → 复查本文引用的编号与口径，确认后更新 related_docs.version；本文引用了对方文档里不存在的编号 → 悬空（advance 阻塞，actor=author）。
- 下游：谁的 related_docs 指向本文档（含指向上一版目录的）→ 列出，标 stale；下游仍在引用本版已删除或未定义的编号 → 逐条列出。把清单写进交付说明并通知下游负责人；下游文档改版时各自走本流程。

## 6. 跨文档关联

关联只通过 doc.json related_docs 登记（artifacts.md §2.1），脚本用 doc-shared/scripts/related.py 读取，禁止在正文里手抄对方编号清单当事实源。

| 本文档 | 登记 | role | 类型包要求 | 追踪什么 |
|---|---|---|---|---|
| prd | mrd | source_mrd | 可选 | MR 编号 → REQ 的来源 |
| tech-spec | prd | source_prd | D0 必需 | 设计覆盖的 REQ |
| api-reference | tech-spec | source_spec | D0 必需 | 接口与 Spec 一致 |
| test-plan | prd（source_prd，D0 必需、D2 相关）、tech-spec（source_spec）、test-cases（references，D2 相关） | | | 覆盖矩阵：每条 P0 / P1 REQ 有用例（D2 命令） |
| test-cases | prd（source_prd，D0 必需、D2 相关）、test-plan（references） | | | 用例「关联需求」列的 REQ 在 PRD 中存在 |
| test-report | test-plan（executes_plan，必需）、test-cases（reports_on，必需） | | | 执行结果对应的 TC、准出标准口径 |

产出顺序建议：MRD → PRD → tech-spec → api-reference → test-plan → test-cases → test-report；上游改版后按 §5 复查下游。path 写相对路径（按本运行目录解析）或绝对路径；同 type 同 role 多份时用 title 区分，否则 related.py 报歧义。

排查：`python3 <doc-shared>/scripts/related.py <目录> [--type prd --role source_prd --csv data/requirements.csv --column 需求编号]`。

## 7. 脚本

| 命令 | 作用 | 退出码 |
|---|---|---|
| `detect_type.py "<原话>" [--triggers 文件]` | 判型；关键词表 references/type-triggers.json + 类型包 name；最长匹配计分，第二名 ≥ 第一名 60% 时追问；关键词表损坏、数组为空、handoff 缺目标或出现白名单外字段（只允许 types、keywords、why）时退出 2 | 0 single；3 ask；4 handoff；2 用法 |
| `new_run.py <type> <目录> --brief b.json [--import 来源 [--mode revision]] [--from 上一版 --version X.Y --change-summary 文本] [--force]` | 校验 brief、在同级临时目录完成 run-state init、导入或复制上一版、outline.md 与 doc.md 骨架，全部成功才落位（失败不留半成品）；path 型必需输入把文件复制进运行目录；--from 以上一版 doc.json 为基线、inputs 沿用上一版 brief.json | 0；1 目录非空 / 已有 run-state / init 或导入失败；2 用法 / 未知类型 / 参数冲突 / 版本不递增；3 brief 缺项；4 售前转交 |
| `advance.py <目录> [--run] [--publish-offline] [--max-steps N]` | 判下一步并执行本地脚本步骤（§3） | 0；3 阻塞；1 步骤故障；2 用法 |
| `status.py <目录> [--json]` | 人读进度：门表、产物、下一步、阻塞与提示 | 0；2 |
| `xref_check.py <目录> [--scan 根目录] [--no-downstream] [--pack 本文档类型包]` | 交叉引用复查（§5）；下游默认扫运行目录的上一级（项目目录），跨项目时显式 --scan；版本 1.0 = 1.0.0；代码块与注释（含跨行）不算引用 | 0；3 悬空引用；2 用法 |

环境变量：DOC_TYPES_DIRS（额外类型包根目录）；DOC_PUBLISH_SCRIPT、DOC_FIGURES_SCRIPT、DOC_RENDER_SCRIPT、DOC_QA_SCRIPT、DOC_XREF_SCRIPT（覆盖入口）与 DOC_NEW_RUN_FAULT（落位故障注入）只供自测。

## 8. 已知缺口（2026-09-15）

- D3 对 Codex 两轮的核对是关键词级（qa-report 人工区块正文出现 Codex、找茬、证伪），不核对内容质量；主代理签门时仍要自己看。
- doc-publish 的发布前新鲜度仍按自己的容差比较（另派修改），发布前应以 check-manifest 为准。
- brief.json 结构由 doc-shared/schemas/brief.schema.json 校验（W3-E 接入）：new_run.py 用 validate.validate_brief(family='doc_brief', strict=False) 查结构（必填缺项仍按追问清单问用户）；advance 的 D0 前复查与 run_state D0 用 strict=True，错误拒绝，警告以「notes：」写进 D0 checks。
- 判型关键词 = references/type-triggers.json + 类型包 pack.json triggers（pack.schema 已声明，追加到同类型）+ 类型包 name；转交规则（售前、lark-doc）只在 type-triggers.json 定义。
- pack.schema.json 未声明 engine_generated；doc-author 跳过带该标记的骨架项，但 S1 不认，需要骨架块同步改 S1 与 schema 才能用。
- 七个内部类型包样张的 related_docs 已补 role，按样张原样建目录可以通过 D0。

## 9. 自测

```sh
python3 <doc-orchestrator>/tests/run_tests.py          # 全量（含 prd 与 test-cases 两次真实渲染与质检，约 3–5 分钟）
python3 <doc-orchestrator>/tests/run_tests.py --quick  # 跳过全流程
python3 <doc-author>/tests/run_tests.py
```

覆盖：验收 12 项回归（发布完成态严格核对、D3 1 秒窗口与改源先 reset、D2 必须 --run、自定义 --pack 的 xref 与故障、改版 path 输入覆盖与复用、行内起始注释、D0 / D1 / D3 门禁、版本等值共享函数、--from 与 --mode 互斥、落位事务与故障注入、判型配置白名单、source_manifest 与 check-manifest）；判型（含关键词表损坏）；brief 缺项（doc 必填、inputs、path 型输入、关联文档未登记与解析不到、样张缺 role）；售前转交、未知类型、非空目录、参数冲突、导入失败不留半成品；引擎无产出不循环；published.json 一致性；D3 后 1 秒内改稿；改版以上一版 doc.json 为基线、无 related 也跑下游复查、版本等值；导入；prd 与 test-cases 全流程到 doc-publish dry-run（不执行 --apply）；门禁阻塞原因（D0 输入、D1、占位符、交叉引用悬空、D3、发布脚本缺失、预检退出 5）；D3 后改源文件；改版（版本校验、修订记录、base_doc）与交叉引用复查（上游悬空、版本不一致、下游 stale、本版删除的编号）；status；业务词守卫。
