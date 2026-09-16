---
name: doc-publish
description: 专业文档生产体系（doc-*）的发布引擎：对已过 D3 的运行目录做发布预检（门状态、qa-result 与 render.json 的 source_sha256 与当前正文一致、源文件与 D3 签门清单一致、飞书排版与资源守卫），执行类型包 pre_publish 检查钩子（沙箱内、禁止调用 lark-cli），把 PDF、docx、feishu.xml、render.json、qa-result.json 按类型包命名规则归档到 out/published/v<版本>/，按「客户或项目文件夹 → 子项目文件夹」从根目录解析或新建飞书落点，首次 create、已有文档 overwrite（默认 dry-run，显式 --apply 才写飞书；写命令全局串行、不自动重试），回查画板、图片、代码块与格式残留，写 published.json 与 run-state 的 D4、publish 阶段。用户要把 PRD、MRD、技术 Spec、API 参考、测试计划、测试用例、测试报告等 doc-* 文档「发布到飞书」「发飞书项目文件夹」「更新已发布的飞书版」「归档发布版本」「过 D4 发布门」时使用；doc-orchestrator 在用户确认 PDF 后调用。只读取或小改一篇已有飞书文档、不需要质检与 PDF 时走 lark-doc；售前方案的入口仍是 presales-publish（1f 迁移后内部调用本引擎）。
---

> **路径约定**：`<doc-X>` = 兄弟 skill doc-X 的目录（与本 SKILL.md 同级；矩阵由 pack 整体安装，成员始终并排）。

# doc-publish（发布引擎）

开工前读 doc-shared（契约层）：references/feishu.md（飞书约束、落点、新建与覆盖、回查）、gates.md（D3、D4、§6 source_manifest）、artifacts.md §7（published.json）、pack-interface.md §3（pre_publish、post_publish 钩子）。写飞书前读 lark-doc 与 lark-shared；lark-cli 退出码 10 的处理以 lark-shared/references/lark-shared-high-risk-approval.md 为准。本 skill 不定规则，只实现。

## 职责

| 做 | 不做 |
|---|---|
| 预检：D0、D1 passed，D2 passed / skipped / waived，D3 passed 或 waived；qa-result.json 与 out/render.json 过 schema，两者 source_sha256 都等于现算正文哈希；源文件新鲜度（有 gates.D3.source_manifest 时调 run_state.py check-manifest 比内容哈希，没有时退回严格修改时间比较并警告）；PDF 文件名与命名规则一致；feishu.xml 用 XML 解析器检查（行内代码、同一块或属性里两个以上 ~、所有 path 属性必须是 @./ 且不越界）；恢复记录、正式归档与未决新建的状态 | 不渲染、不质检（缺产物或过期就拒绝，回 doc-render、doc-qa） |
| 执行 hooks.pre_publish（dry-run 也执行）与 post_publish：钩子只做检查、只在 stdout 输出 JSON | 钩子不得调用 lark-cli、不得改动运行目录；飞书读写一律由引擎发起 |
| 归档：PDF 与 docx 按类型包 filename 模板命名，feishu.xml、render.json、qa-result.json、qa-report.md 原名，XML 引用的本地资源按原相对路径；每个文件记 sha256 | 不改 out/ 下的渲染产物 |
| 飞书：去代理、账号目录、parse 预检、按 path 从根目录逐层解析或新建文件夹、create 或 overwrite、回查；写命令在跨进程全局写锁内串行执行、间隔 ≥ 1 秒、不自动重试 | 不 import、不 move、不删文档；不自动追加 --yes 等确认 flag |
| 写 run-state：apply 时写飞书前 pass-gate D4（证据 = 用户原话）、set-stage publish；解析或新建出的文件夹 token 写回元数据 lark_folder（不伪造修改时间） | dry-run 不写 run-state、不改元数据 |

## 命令

```sh
# 默认 dry-run：预检 + 检查钩子 + 归档到 out/published/v<版本>.dry-run/ + 只读 lark-cli（parse、files list、list-comments）
python3 <doc-publish>/scripts/publish.py <运行目录> [--pack <类型包>] [--profile account1|account2]

# 真发布（D4：用户已看过 PDF 并确认范围、版本、账号、文件夹）
python3 <doc-publish>/scripts/publish.py <运行目录> --apply --evidence "用户原话" \
  [--doc-token <已有文档 token> | --create] [--allow-new-project-folder] [--abandon-recovery] [--by 谁]
```

| 选项 | 说明 |
|---|---|
| --apply | 没有它一律 dry-run，不调用任何写命令（+create、+update、+create-folder） |
| --evidence | --apply 与 --abandon-recovery 必填，可多次；原样写进 run-state D4（放弃恢复记录时同时写进 published.json recovery_abandoned） |
| --doc-token / --create | 覆盖指定文档 / 强制新建。都不给时：运行目录 published.json（非 dry-run、过 schema）有 lark_doc_id 则覆盖，否则新建；该文件损坏或是旧格式时退出 2。存在恢复记录时 --create 退出 8。dry-run 与 apply 用同一推断 |
| --abandon-recovery | 存在恢复记录（已写入但回查未完成）或未决新建（create 结果不确定）时，用户确认放弃后才用；须带 --evidence，published.json 留痕 |
| --allow-new-project-folder | 允许新建一级「客户或项目」文件夹（新客户），编排层问过用户才传 |
| --offline | 只用于 dry-run：不调用 lark-cli（与 --apply 互斥） |
| --pack | 只接受 doc-shared/types 或环境变量 DOC_TYPES_DIRS 下的类型包目录（其他路径退出 2）；加载前过 pack schema（不过退出 1）；run_state 调用透传解析后的目录 |

## 流程（apply）

1. 加锁（out/.publish.lock，同一运行目录同时只允许一个发布进程）→ 预检（任一不过退出 1，不调用 lark-cli）→ 未决状态检查（退出 8 的情形见退出码表）。
2. pre_publish 钩子（沙箱，见下节；失败或越权退出 4）→ 重新加载上下文并重做预检 → 推断模式，都在任何 lark-cli 调用之前。
3. lark-cli 环境：删除 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY（大小写各版本）；PATH 前置最新 nvm bin（lark-cli 本身按调用方 PATH 解析）；account2 设 LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-account2，account1 清掉该变量。
4. `docs +script --as user --command parse` 预检（assessment.status 必须 passed，否则退出 1）。
5. overwrite 先 `drive +list-comments --solved-status all`（翻完所有页；超过 50 页或分页不完整退出 7），评论数 > 0 退出 6。
6. 归档写入暂存目录 out/published/.staging-v<版本>/（dry-run 为 .staging-v<版本>.dry-run/，通过后换成 v<版本>.dry-run/；失败时删暂存、旧记录不动）；published.json 结构先用占位值预校验。
7. 文件夹解析（下节），解析或新建出的 token 写回元数据。
8. `run_state.py pass-gate --gate D4 --evidence …`（被拒退出 1）→ `set-stage publish`（失败退出 1，不写飞书）。
9. create 前先写新建意图 out/published/.create-intent.json，再 `docs +create --as user --doc-format xml --content @./out/feishu.xml --parent-token <token>`；overwrite：`docs +update --as user --doc <token> --command overwrite --doc-format xml --content @./out/feishu.xml`（同步已发布文档用 overwrite，不用 import，链接不变）。成功后先在运行目录根写恢复记录 published.json（verify 为 null、problems 注明回查未完成），删新建意图，再把暂存归档转为 out/published/v<版本>/（旧目录先改名备份，换入失败还原）并在归档里写同一份。
10. 回查 `docs +fetch`（服务端会把本地资源换成 token、给块加 id，按 XML 解析计数）：画板数 = render.json feishu.whiteboards（且等于 XML 实际数）；图片 ≥ XML；代码块 = 源文件代码块数（类型包不允许时为 0）；行内代码、斜体、删除线 0；字面 * 不多于 XML；服务端 warnings 空；overwrite 的 result 必须为 success。不通过退出 3，按 problems 局部修复（画板失败修 SVG 后 block_insert_after 补插），不重建文档。
11. post_publish 钩子（同一沙箱；失败或越权记 problems，不回滚）→ 最终 published.json 过 schema 后覆盖恢复记录（归档目录与运行目录根各一份）。

## 钩子沙箱（pre_publish、post_publish）

- 环境变量只给：PATH（拦截 shim 目录、当前 Python 目录、/usr/bin、/bin）、临时 HOME、TMPDIR、LANG、LC_ALL、指向空目录的 LARKSUITE_CLI_CONFIG_DIR、DOC_RUN_DIR、DOC_PACK_DIR、DOC_SHARED、DOC_TYPE、DOC_PUBLISH_DRY_RUN、DOC_PUBLISH_HOOK（post_publish 另有 DOC_PUBLISHED_JSON）。不继承父进程的代理、凭证与其他变量。
- PATH 最前面的 lark-cli 与 lark 是拦截 shim：一经调用即记 E-HOOK，钩子判失败。
- 钩子前后对整个运行目录递归快照（不跟随软链）：目录与权限位、普通文件权限位与 sha256、软链目标及目标文件 sha256，含 out/ 下的渲染产物、docx、正式归档与发布记录；只排除本进程的 out/.publish.lock。有新增、删除或修改即 E-HOOK。
- 超时、无法执行、触发拦截 shim 时同样先做后快照比对，再按 E-HOOK 退出，残留改动写进消息。
- 与钩子无关、一律生效的写入边界：运行目录锁、暂存归档、正式归档与备份目录、发布记录（含 .tmp）、新建意图文件、元数据写回，写之前逐级 lstat 与 realpath 校验，任何一级是软链或越出运行目录都拒绝（退出 1，step path-guard）。
- stdout 必须是 JSON 对象；pre_publish 必须 ok=true。extra 合并进 published.json（同名键 post 覆盖 pre）。
- 钩子退出后等 1 秒再做后快照；归档完成后、写飞书前再调一次 run_state.py check-manifest 复核源文件清单（有变化退出 1，step recheck）。
- 调用 run_state.py 之前对 run-state.json、run-state.json.lock、run-state.json.tmp 逐级做边界校验；run_state.py 自身以 O_NOFOLLOW 打开 lock 与 tmp。

### 威胁模型（主代理 2026-09-15 定）

- 运行目录由单用户、单进程可信写入；发布期间不应有其他进程改运行目录（同目录并发发布由 out/.publish.lock 拒绝）。
- 类型包钩子只从可信目录（doc-shared/types、DOC_TYPES_DIRS）加载，属于可信的包代码。沙箱、快照、shim 防的是误改与误调用，不防恶意钩子。
- 已知限制，不防：
  - 钩子启动脱离会话的后台进程，在后快照与归档复核之后才改运行目录；
  - 钩子以绝对路径直接执行真实 lark-cli（只靠临时 HOME 与空配置目录让它拿不到凭证，钥匙串凭证不保证）；
  - 检查与使用之间的竞态：guard_rel 校验完到真正写入之间，路径被并发替换为软链（未改用 dir_fd 逐级打开）。

## 飞书文件夹解析

元数据（类型包 meta_file，默认 doc.json）的 lark_folder：

| 情况 | 行为 |
|---|---|
| path 不足「客户或项目/子项目」两段（无论有没有 token） | 退出 5：归属拿不准，编排层给字母选项问用户（不落根目录，也不落一级文件夹） |
| 逐层 `drive files list`（根目录 folder_token 为空串；根与子目录都按 has_more 翻页，分页信息不完整退出 7）：恰好一个同名文件夹 | 用它 |
| 给了 token | 仍从根目录按 path 逐层解析，末级 token 必须与给的一致；中途不存在或末级不一致退出 5；不新建 |
| 同名多个 / 没有同名但有近似名（去空白、大小写、互相包含） | 退出 5，输出 candidates |
| 子项目层不存在（没给 token） | apply 时 `drive +create-folder --folder-token <父> --name <名>` 先建再发；dry-run 只列入 plan.folders_to_create |
| 一级项目文件夹不存在（新客户） | 没有 --allow-new-project-folder 退出 5；有则在根目录建 |
| +create-folder 报错（429、超时、无响应、响应缺字段、服务端报错） | 不自动重试、不继续发布，一律退出 7（uncertain_write）；退出前只读重列父目录，把同名文件夹放进 located_folders。编排层核对后重跑：按 path 解析直接用已存在的文件夹，同名多个时退出 5 |

真发布记录的 lark_folder 必须同时有 token 与至少两段的 path（schema 强制）。

## 写命令、全局写锁与未决状态

- 所有引擎发出的飞书写命令都在 ~/.cache/doc-publish/lark-write.lock（fcntl）内执行：锁文件记最后写入时间，持锁后等到距上次写入 ≥ 1 秒再执行（DOC_PUBLISH_WRITE_INTERVAL 只能调大）。跨运行目录、跨进程生效。
- 写命令（+create、+update、+create-folder）一律不自动重试。超时、限流（429 等）、无响应、响应缺字段都按「可能已写入」处理：退出 7，message 写明先只读定位；+create-folder 失败时顺带只读重列并在 located_folders 给出同名文件夹，但同样不继续发布。读命令遇到限流或超时退避重试至多 3 次。
- create 前写新建意图文件 out/published/.create-intent.json，字段 schema_version、created_at、version、source_sha256、folder_token、folder_path、title（feishu.xml 的 title）、argv（docs +create 参数）。
- 意图文件存在即未决：结构不合法（{}、[]、null、损坏、缺字段、软链）同样视为未决。之后任何发布（含 dry-run、--create）退出 8。
- 解除只有两种方式。一是 --doc-token：引擎只读列意图记录的文件夹，找到与 title 同名的文档且 token 一致才放行，否则退出 8、不更新、不清除意图；意图结构不合法或 --offline 时无法核对，同样退出 8。二是用户确认后加 --abandon-recovery --evidence，这是唯一的放弃方式。
- docs +create 返回退出码 10 且确认 envelope 存在（请求未执行）时删除刚写的意图，输出 intent_cleared；没有 envelope 的失败按退出码 7 保留意图。
- 恢复记录（已写入、回查未完成）存在时：默认按其 lark_doc_id 覆盖；--create 退出 8；同版本正文不同时拒绝，用户确认放弃后加 --abandon-recovery --evidence。
- 同版本比较同时看运行目录根记录与正式归档记录：已写入过飞书（完整记录或恢复记录）且 source_sha256 不同即拒绝，先升版本号。正式归档记录读不出或不合 schema 退出 2。

## 退出码

| 码 | 含义 | 编排层怎么做 |
|---|---|---|
| 0 | 成功；dry-run 为预检与计划通过 | apply：交付 lark_url 与归档 PDF；dry-run：把 plan 给用户确认后再 --apply |
| 1 | 预检拒绝（门状态、哈希不一致、源文件与清单不一致或晚于产物、产物缺失、PDF 名不一致、XML 守卫、parse 未过、同版本不同正文、类型包不合 schema）或 run_state 拒绝 D4 / set-stage | 按 problems 回 doc-qa / doc-render / 升版本 |
| 2 | 用法或读写错误（--apply 或 --abandon-recovery 缺 --evidence、--apply 与 --offline 同给、类型包不在可信目录、另一个发布进程持锁、published.json 损坏或旧格式、JSON 读不出、run_state 超时、文件不可读） | 修命令或显式给 --doc-token / --create |
| 3 | 已发布但回查不通过、post_publish 失败或越权 | 局部修复，不重建文档 |
| 4 | pre_publish 钩子失败或越权（E-HOOK：调用 lark-cli、改动运行目录） | 看钩子输出，修业务前置条件或修类型包钩子 |
| 5 | 飞书文件夹归属需用户拍板（路径不足两段、token 与 path 不一致、同名多个、近似名、新客户文件夹未授权） | 用 options / candidates 出字母选项问用户，改 lark_folder 或加 --allow-new-project-folder 后重跑 |
| 6 | 覆盖目标有评论 | 问用户：改 --create 新建，或先处理评论 |
| 7 | lark-cli 调用失败。写命令失败时 uncertain_write=true：可能已写入，先只读定位再决定；读命令失败为认证、网络、分页不完整等 | 写命令：drive files list / docs +fetch 只读核对；认证问题读 lark-shared，先确认代理已去掉（503 会伪装成认证失效） |
| 8 | 存在未决新建或恢复记录，需用户决定 | 只读定位；找到文档用 --doc-token 覆盖，确认放弃用 --abandon-recovery --evidence 用户原话 |
| 10 | lark-cli 高风险确认门（确认 envelope：type confirmation、subtype confirmation_required） | 原样透传：输出 action、risk、hint、argv。停下向用户展示并取得显式同意；本引擎不追加确认 flag |

## 衔接

| 上游 / 下游 | 约定 |
|---|---|
| doc-shared | schemas/published.schema.json（本引擎用 validate.check 直接校验）；scripts/run_state.py（D4、set-stage、check-manifest；源文件集合 source_files 与 build_manifest 直接复用）；docmark_parse.py（正文哈希、代码块数）；validate.py pack schema |
| doc-render | 读 out/render.json（source_sha256、pdf.path、feishu.path 与画板数、docx 字段）；render.json 有 docx 字段时以它为准（null 表示本次未出 docx），旧 render.json 没有该字段时才取与 PDF 同名的 .docx，且不能比 PDF 旧 |
| doc-qa | 读 qa-result.json（source_sha256、must_fix） |
| doc-orchestrator | D3 通过、用户看过 PDF 后先 dry-run，把 plan 与文件夹给用户确认，再 --apply --evidence 用户原话；退出码 5、6、8、10 以及写命令的 7 需要问用户 |

## 测试用例导出电子表格（export_cases_sheet.py，2026-09-15 W3-G）

把 test-cases 运行目录的用例数据导出为飞书电子表格，给测试执行填状态用。默认 dry-run；写入规则与本引擎发布一致（写命令全局写锁内串行、间隔 ≥ 1 秒、不自动重试；读命令限流退避；去代理；账号目录；退出码 10 透传不加 --yes；落点「客户或项目/子项目」）。

```sh
python3 <doc-publish>/scripts/export_cases_sheet.py <test-cases 运行目录> [--layout per-module|single] [--status-column 执行状态|none] \
  [--folder-path 客户或项目/子项目] [--title 表格标题] [--profile account1|account2] [--offline]
python3 <doc-publish>/scripts/export_cases_sheet.py <运行目录> --apply --evidence "用户原话" \
  [--spreadsheet-token <已有表格> | --create] [--allow-new-project-folder] [--allow-missing-required]
```

| 项 | 约定 |
|---|---|
| 数据 | 解析正文取用例实体（类型包 numbering.entities）与整行 CSV 字段；列顺序按数据块 columns=，未显示的 CSV 列接后；模块 = CSV「模块」列或用例所在一级章节标题；同编号内容不同即预检失败 |
| 必填与下拉 | 读类型包 skeleton.md「用例字段」表：必填=是 → 必填列（表头红字；空值预检失败，--allow-missing-required 降为警告）；说明为「P0–P3」或「a / b / c」→ 下拉；另加状态列（默认「执行状态」：未执行 / 通过 / 失败 / 阻塞，初值未执行）；已有值不在选项内预检失败 |
| 版式 | per-module 每模块一个工作表（名称去掉 [ ] : * ? / \、截 31 字、重名加 -2），single 一个「全部用例」表且首列为模块；表头加粗底色、冻结首行首列、列宽按内容估算（80–360 px）、自动换行；优先级与状态胶囊用浅色语义色 |
| 新建 | 按 lark_folder.path（或 --folder-path，此时忽略 doc.json token）逐层解析落点 → `sheets +workbook-create --sheets @./out/sheet-export/sheets.json --styles @./out/sheet-export/styles.json --folder-token` → 每组下拉一次 `sheets +dropdown-update --ranges/--options/--colors @文件` → +workbook-info 与 +csv-get 回读核对表头与用例编号列 |
| 更新（不改链接） | out/sheet-export.json 记录或 --spreadsheet-token：+workbook-info → 已有工作表 +sheet-info（有合并单元格拒绝）与 +csv-get（旧区域比新表宽拒绝；多出的旧行用空值覆盖）→ `sheets +table-put`（缺的工作表自动建）→ +dropdown-update → 回读；计划外的旧工作表不删、只警告（删除与清空是高风险命令，须用户确认） |
| 未决写入 | 写之前落 out/sheet-export/.write-intent.json，全部成功才删；残留时退出 8：只读核对后 --spreadsheet-token <已建表格> 重跑（更新幂等），或 --abandon-recovery --evidence |
| 产物 | out/sheet-export/plan.json（reads、writes argv、工作表规格、problems、warnings）；apply 写 out/sheet-export.json（spreadsheet_token、url、sheets[{name, sheet_id, rows}]、cases_sha256、evidence） |
| 退出码 | 0 成功或计划通过；1 预检不过；2 用法；3 已写入但回读不一致；5 落点需拍板；7 lark-cli 失败（写命令 uncertain_write）；8 未决写入；10 确认门 |

复用：lark_env、find_lark、write_interval、rate_limited、GlobalWriteLock、Lark.call / parse、list_folder、norm 与 resolve_folder 逻辑复制自 publish.py（写命令判定改为「不在读命令白名单即为写」，覆盖 sheets 写命令）；合并为共享模块前两边改动须同步。自测：`python3 <doc-publish>/tests/test_export_cases_sheet.py`（PATH 注入带状态假 lark-cli，严格校验 argv 与 @文件内容；真实 lark-cli 只跑 --help 核对用到的 flag）。

## 售前迁移接口（1f）

presales-publish 改为薄壳：

```sh
python3 <doc-publish>/scripts/publish.py <运行目录> --pack <doc-shared>/types/presales-<site|reddit> \
  --apply --evidence "<G4 用户原话>" [--doc-token <旧文档 token> | --create] [--profile <brief.json lark_profile>]
```

- 售前包 meta_file 为 brief.json：brief.json 需补 lark_folder（{token, path} 或 {pending_reason, path}，path 至少两段），D4 检查同一字段。
- pricing 哈希校验改为售前包 hooks.pre_publish：只读检查后输出 `{"ok": true, "extra": {"pricing_model_hash": "…"}}`，不符时 ok=false（本引擎退出 4）；钩子不能写文件、不能调用 lark-cli。
- 旧 publish_lark.py 退出码映射：旧 1 → 新 1 / 7；旧 2（覆盖目标有评论）→ 新 6；旧 3 → 新 3。新增 5、8 要由包装层转成问用户。
- 旧 published.json 的 client、line 由包装层在引擎写完后补写（schema 允许 client、line、pricing_model_hash 兼容字段），或 1f 统一迁入 extra。
- 旧运行目录根的 published.json 不过新 schema：本引擎退出 2，包装层从旧记录取 lark_doc_id 显式传 --doc-token。
- 旧流程没有 run-state D0–D3、outline 拍板记录与 render.json source_sha256：迁移时先按 gates.md §4 转换 run-state，并让售前经 doc-qa、doc-render 出新产物、重过 D3 得到 source_manifest。

## 自测

```sh
python3 <doc-publish>/tests/run_tests.py          # 全部，含 golden smoke-site dry-run（真实 lark-cli 只读 + --help 参数核对，写命令被守卫拦截）
python3 <doc-publish>/tests/run_tests.py --fast   # 显式跳过 golden：记为关键契约 SKIP，退出码 2「INCOMPLETE」，不算通过
# 结果：0 = ALL PASS；1 = 有 FAIL；2 = INCOMPLETE（有关键契约 SKIP）。
# 开关：--allow-missing-golden 是唯一不影响通过的例外（golden 输入缺失记 SKIP）；--no-real-lark、--allow-unverified-lark 会让真实 lark-cli 核对变成 SKIP，结果为 INCOMPLETE
```

假 lark-cli 通过 PATH 注入，是一个带状态的假服务端：按命令严格校验 argv（必需与允许的 flag、取值、@./ 文件存在、--format json 在最后，违规计 FAIL），按文档形状响应，create / update 时保存并转换文档内容，fetch 返回服务端版本（不读本地 feishu.xml）。覆盖验收 8 项与原有场景：钩子沙箱、可信类型包、写命令不重试与状态机（服务端已写入但客户端失败）、token 与 path 一致、恢复记录与重发保护、全局写锁并发、source_manifest 与严格修改时间、XML 解析守卫，以及 dry-run、哈希、D3、create 与 overwrite、评论、退出码 10、代理、账号、文件夹、归档、schema、回查、锁、业务词守卫。
