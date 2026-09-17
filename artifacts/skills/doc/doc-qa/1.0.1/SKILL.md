---
name: doc-qa
description: 专业文档生产体系（doc-*）的质检引擎：对 DocMark 正文执行引擎通用规则（include 与占位符、行内代码、图自查与机器检查、表题、代码块、数据块、链接、必备章节、标题层级、编号实体、交叉引用、关键数字一致性、版本一致、绝对化用语、重点高亮用量、中文排版 T1–T12）、类型包 qa_rules.py 规则与业务钩子 pre_qa，合并 render.json 版式问题，产出 qa-result.json 与 qa-report.md 自动区块，并按固定流程做人工检查与 Codex 找茬、证伪两轮。用户要「质检 / 检查 / 审校」PRD、MRD、技术 Spec、API 参考、测试计划、测试用例、测试报告等 doc-* 文档，要跑 D3 质检门、查中文排版问题、解释某条质检规则或 qa-result，或给类型包写 qa_rules.py 时使用。售前方案质检的入口仍是 presales-qa（迁移后内部调用本引擎）；只改一篇飞书文档不需要质检时走 lark-doc。
---

> **路径约定**：`<doc-X>` = 兄弟 skill doc-X 的目录（与本 SKILL.md 同级；矩阵由 pack 整体安装，成员始终并排）。

# doc-qa（质检引擎）

开工前读：doc-shared/SKILL.md；doc-shared/references/qa-engine.md（分层、判据、合并与退出码）、typography.md（T1–T12 判据）、pack-interface.md §3–4（钩子与 qa_rules.py 接口）；本文档类型包的 qa-rules.md。判据只在这些契约文件里定义，本文件只说怎么用引擎。

## 职责

| 做 | 不做 |
|---|---|
| 解析正文（共享解析器 doc-shared/scripts/docmark_parse.py，与 doc-render 同一份）、跑三层规则、合并 render.json 版式问题、写 qa-result.json、qa-report.md 自动区块与 out/<源文件名>.resolved.md、写回 run-state 阶段 | 不改正文；不写 D3 门（由主代理用 run_state.py pass-gate 写）；不联网核实事实；不发布 |

## 流程

1. 自动检查：`python3 <doc-qa>/scripts/qa.py <运行目录>`（类型取 doc.json type；售前等无 doc.json 的目录加 `--type`）。
2. 人工检查：类型包 qa-rules.md 中「脚本」为否的规则逐条给结论（通过 / 问题）；问题写位置、原文、证据、修改指令，写在 qa-report.md 自动区块之外。
3. Codex 找茬轮（只读，见下文命令）：输入 out/<源文件名>.resolved.md、类型包声明的关键输入（关联文档、data/*.csv）与 qa-report 草稿，要求补漏并逐条落到段落。
4. 回原文核实 Codex 每条意见；需要网络或回执的事实由主代理自己取证（Codex 只看得到提问里的摘要，会把有回执的完成态误判为杜撰）。
5. Codex 证伪轮：要求逐条论证「这条其实不是问题」；裁定确认、降级（写理由）、撤回；撤回项对照 qa-rules.md 伪问题清单，新伪问题提议追加。
6. 修改源文件后重跑第 1 步（D3 会检查质检之后源文件是否又改过）。

完成条件：qa-result.json must_fix 为 0；Codex 两轮正文已原样展示给用户，或写明失败原因（terra 与 sol 各试一次均失败）与本想让 Codex 挑的点；然后主代理写 D3。

### Codex 两轮命令

```sh
codex exec -m gpt-5.6-terra -c model_reasoning_effort="xhigh" -s read-only \
  -C <运行目录> --skip-git-repo-check -o <运行目录>/out/codex-qa-<find|refute>.txt \
  "……" < /dev/null
```

terra 报「已达容量」才换 `-m gpt-5.6-sol -c model_reasoning_effort="medium"`。-o 文件放 out/（不算源文件，不触发 D3 过期判断）。返回正文原样展示给用户，开头标「Codex:」。

## CLI

```
qa.py <运行目录> [--type 类型] [--pack 类型包目录或 pack.json] [--only R1,T3] [--exclude T1]
      [--no-hooks] [--no-state] [--allow-invalid-pack] [--quiet]
```

| 项 | 说明 |
|---|---|
| 类型包查找 | --pack → 环境变量 DOC_TYPES_DIRS（冒号分隔的 types 根）→ doc-shared/types/<类型>/ |
| --only | 只跑列出的引擎规则（调试、校准用）；同时跳过钩子与 render.json 并入；列表只含引擎编号时不导入类型包，含非引擎编号或 E-TYPE 时才加载并运行类型包规则 |
| --exclude | 在 pack.qa.engine_rules 之外再关闭规则 |
| 输出 | qa-result.json（schema 校验后写入，issues 带 rule_source）、qa-report.md 自动区块（`<!-- qa-auto:start -->` 与 `<!-- qa-auto:end -->` 之间覆盖，区块外人工内容保留，旧「## 自动检查（qa_checks.py）」区块移除）、out/<源文件名>.resolved.md；stdout 为结果 JSON 加 model_source 与 run_state 写回情况 |
| run-state 写回 | run-state.json 存在且是新格式时：阶段置 qa；本次有必改而 D3 已通过时 fail-gate D3（其后的门回到 pending）。写回失败退出 4，不静默。旧 G0–G4 格式或不存在时跳过并在输出注明 |
| 退出码 | 0 无必改；3 有必改；1 缺源文件；2 用法错误或找不到类型包；4 引擎故障（pack.json 读不出或不过 schema、rules_py 越出包目录、解析器不可用、规则代码异常、结果不过 schema；这些情况下旧 qa-result.json 改名为 .stale），或 run-state.json 写回失败（此时 qa-result.json 已按本次结果写入） |

## 规则分层与编号

执行顺序：解析 → 引擎规则（按 pack.qa.engine_rules 过滤）→ 类型包 check(doc, ctx) → 钩子 pre_qa → 并入 out/render.json 的 layout_issues → severity_overrides → 去重（完全相同的只留一条；同规则同行只留定级最高的一条并注明另有 N 条，行号 0 不合并）与截断（单条规则超过 30 条时非必改的超出部分折叠为一条汇总，必改不折叠）→ 写结果。

| 层 | rule_source | 编号 |
|---|---|---|
| 引擎通用 | engine | 见下表；另有并入的 LY1–LY8（来自 render.json，带 file=out/render.json） |
| 类型包 | type | 包前缀（PRD1、SPEC2、TC3…；售前沿用 A1–A3、C2、C3、B1、F2、F4、R2、R3、L3、L5）；异常与非法返回记 E-TYPE |
| 业务钩子 | hook | 钩子自定；故障记 E-HOOK |

| 编号 | 检查 | 默认定级 | 事实来源 |
|---|---|---|---|
| L1 | 白名单外或找不到的 include、占位符、HTML 标签、斜体、删除线、成对标记不配对等 | 必改 | 标记行 + 解析器诊断 + 行扫描 |
| L2 | 行内代码、波浪号区间（兼容规则，新类型包关闭） | 建议 | 行扫描 |
| L4 | 图缺 PNG 预览或 review.json 自查记录（human 部分） | 建议 | 正文 figures/ 图片引用（旧正则，代码块外，含行内与路径带空格）并上解析器 figures |
| L6 | 图缺 machine 检查；画板 lint 必改项；whiteboard-cli 错误（对象 errors>0 或 issues 有 error，数组形态兼容）；machine.issues 其他必改；等效字号低于 7 pt（有 render.json 时以其为准）；ok=false 只有在必改项全是字号类且 render 字号达标时才清除 | 必改 | review.json（doc-figures 实际结构）、render.json |
| L7 | 表题缺失（table_captions 开启）、表格结构问题 | 提示 | 解析器 |
| L8 | 未开启 code_blocks 却写代码块（必改）；代码块未标语言（建议） | 必改 / 建议 | 解析器 |
| L9 | 数据块文件、格式、列、filter 错误（必改）；过滤后 0 行（提示） | 必改 | 解析器 |
| L10 | 相对链接或图源文件不存在、协议不合规、链接文字为空 | 建议 | 解析器 links、figures |
| S1 | 必备章节缺失（标题、别名、{#sec:id}）；pack 声明 modes 时按元数据取 mode 的骨架，mode 无法识别报配置错误 | 必改 | 解析器 + mode 骨架（validate.resolve_mode / resolve_skeleton） |
| S2 | 标题跳级、超过 max_depth、标题为空、缺文档标题 | 必改 | 解析器 |
| S3 | 编号实体重复（必改）；组内跳号（提示，按「编号去掉末尾序号」分组） | 必改 / 提示 | 解析器 entities |
| X1 | 交叉引用、脚注引用指向不存在 | 必改 | 解析器 |
| X2 | 有锚点的图表未被引用（逐条）；无锚点的图表（全文汇总一条）；脚注未被引用 | 提示 | 解析器 |
| X3 | 锚点重复、锚点写法不合法 | 必改 | 解析器 |
| X4 | 关键数字多处不一致（口径由 qa.key_figures 声明） | 必改 | 解析器纯文本单元（段落续行已拼接，注释与代码块不参与） |
| C1 | 元数据版本与正文前 2000 字、published.json、PDF 文件名不一致 | 提示 | 行扫描 |
| R1 | 绝对化用语（内置词表 + 无 columns 的 banned_terms） | 必改 | 行扫描 |
| H1–H4 | 高亮总量、单页密度、单处长度（建议）；标记未配对或渲染产物残留（必改） | 建议 / 必改 | 解析器 highlights、render.json |
| T1–T12 | 中文排版（判据与校准例外见 typography.md） | 见 typography.md | 解析器纯文本单元 |
| E-TYPE、E-HOOK | 类型包规则异常或返回不合法、钩子故障 | 必改 | 引擎 |

## 类型包接入

| 声明（pack.json） | 引擎怎么用 |
|---|---|
| qa.rules_py | 加载 check(doc, ctx)。doc 是解析器 Document 的只读代理（字段见 pack-interface.md §4），另有 code_mask、comment_mask、text_units()、diag(规则)；ctx 除契约字段外有 exists_safe、read_json_opt、list_dir、glob、feature、qa、message。可选导出 MESSAGE_OVERRIDES（只为迁移期逐项比对） |
| qa.engine_rules | include "all" 或列表，exclude 列表。新类型包 exclude L2；售前迁移期只开 L1、L2、L4、C1、R1 |
| qa.severity_overrides | 规则编号 → 定级，最后应用 |
| qa.glossary | T8 术语：{正写: [异写]} 或包内 JSON 文件；异写是正写子串时按最长匹配，术语表章节与引号内不查 |
| qa.banned_terms | 无 columns 的词按 R1 全文查；有 columns 的词按 T11 只查这些列，与内置空泛词命中同一片段时保留类型包定级与文案、同行去重类型包优先（R1 内置红线不被降级） |
| qa.highlight_limits | {total, per_page, max_length}，缺省 25、3、40 |
| qa.key_figures | [{id, label, pattern, normalize: number / text, severity}]；pattern 命名组 value 取值、可选 key 分组 |
| numbering.entities | S3 与 X1 用；contiguous 按「编号去掉末尾序号」分组 |
| hooks.pre_qa | argv 数组，占位符 {run_dir} {pack_dir} {skills_dir} {doc_shared} {python}；cwd 为运行目录；退出码 0 或 3 且 stdout 为 {"issues": [...]} 时并入 |

写规则的约定：编号用包前缀，不占用引擎编号；不修改 doc、不写文件；新自动规则先定级「提示」试运行；跨文档读取用 ctx.related(type, role=…)，找不到时返回 ctx.missing_related_issue(...)（D2 相关必改，其余提示）；同条件命中多份会抛 AmbiguousRelated 并记 E-TYPE，所以要传 role。

## 定级与 D3

定级口径以 doc-shared/SKILL.md「定级」为准：必改（承诺范围、验收或合同责任、事实正确性、红线、影响阅读的版式缺陷）发布前必须清零；建议列入报告由用户选择；提示只进报告。

D3 通过条件（run_state.py 自动检查）：qa-result.json 合法且 must_fix 为 0、out/render.json 无版式必改、质检与渲染之后源文件未再修改；证据写 Codex 两轮位置或降级说明。doc-qa 并入 render.json 的 LY 问题只是让报告完整，不替代 D3 对 render.json 的检查。

## 售前迁移期配置

售前两个类型包的规则搬迁以 presales-qa/scripts/qa_checks.py 为准（types/presales-site 与 presales-reddit 的 qa_rules.py，共同部分除 PACK_ID 外逐字一致；presales-site 在文件末尾追加本包专属 SITE-06～09：mode 必备章节提示、0-1 禁词、有效期两处、mode 配置错误，与旧脚本比对时剔除）。两个包的 pack.json 已采用下面这组迁移期设置（2026-09-15 12:11 起，内容与 tests/fixtures/presales-migration-overlay.json 相同），在这组设置下新引擎在 golden 四个目录上与旧脚本逐项一致：

| 设置 | 值 | 不这样设的后果（2026-09-15 实测） |
|---|---|---|
| qa.engine_rules.include | L1、L2、L4、C1、R1 | 只关 T3、T9 时，四个目录新增 S1、L6、L7、X2、T 类问题；smoke-site must_fix 0 → 8，MOBYVOW 0 → 9（S1 骨架标题「01 背景与目标」与正文标题不匹配、旧 review.json 没有 machine 部分），D3 会被拦 |
| meta_file | brief.json | doc.json：售前运行目录没有 doc.json，C1 读不到版本，旧 C1 结果静默消失 |
| include_deny | ["*internal*"] | null：sections/internal-x.md 这类白名单内但带 internal 的文件会被放行，旧脚本拒绝 |
| qa.banned_terms | [] | 含「绝对」「永久」等宽词：样张「绝对化用语规则」一句被 R1 必改误报 |

qa_rules.py 仍直接读运行目录的 brief.json（与旧脚本一致），不依赖 meta_file。新旧之间有意保留的差异（契约 §3 同规则同行合并、第 4 层 include 报 L1 等）逐条见 ~/workspace/docs/doc-skill-platform-2026-09-15/wave2/qa-calibration.md §4。以后打开新规则前先改 skeleton 标题或 aliases、补 figures machine 检查，差异登记为有意。

## 解析器接线

doc-qa 不自带 DocMark 解析，scripts/docmodel.py 只做适配：结构、诊断、锚点、实体、高亮全部来自 doc-shared/scripts/docmark_parse.parse_file()（字段见 doc-shared/references/docmark-ast.md），解析器缺失或导入失败时退出码 4。

唯一差异：include 白名单外或找不到时，旧质检写 `[[FORBIDDEN include: x]]` / `[[UNRESOLVED include: x]]` 标记行，解析器保留原注释。doc.text 与 out/<源文件名>.resolved.md 用标记版（行数不变，结构仍取解析器），保证 golden 逐字一致。doc-render 遇到这类 include 直接中止、不写 resolved.md；include 全部正常时两份文本逐字相同，所以 artifacts.md「两者写出的 resolved.md 必须一致」成立（2026-09-15 读 doc-render/scripts/render.py 核实）。

高亮统计：H1、H3 用解析器 doc.highlights；H2 读 out/render.json 的 highlights.per_page，render.schema.json 还没有 highlights 字段期间读 doc-render 另写的 out/render.highlights.json。

## 自测

改动 scripts/ 或售前两个包的 qa_rules.py 后运行，ALL PASS 才算改完：

```sh
python3 <doc-qa>/tests/run_tests.py          # 全量（含 golden 与售前等价，约 1 分钟）
python3 <doc-qa>/tests/run_tests.py --fast   # 跳过 golden 与售前等价
```

覆盖：解析器接线；引擎规则正反例；engine_rules 过滤、severity_overrides、去重、截断；类型包结果并入、E-TYPE（抛异常、非法定级、占用引擎编号、AmbiguousRelated）、ctx.related 缺失定级；pre_qa 钩子并入、退出码故障、非 JSON、超时、--no-hooks；render.json 并入；qa-result schema；qa-report 区块；run_state 写回与旧格式跳过；退出码 0 / 1 / 2 / 3 / 4；golden 四目录迁移期配置逐项一致与 resolved.md 逐字一致、落位 pack.json 原样运行不丢旧结果、守卫在新路径触发；售前 7 条回归与 Waykar 摘句全量等价；边界夹具旧新等价（include 嵌套、越界、黑名单、找不到、占位符与售前全部自动规则）；两份 qa_rules.py 共同部分一致；业务词守卫；S1 按 mode 取骨架（含 presales-site 真实包反向集成）；T11 与类型包 banned_terms 优先级；七个内部类型包 qa_rules 逐条正反例（样张副本变异）与跨文档四种关联情形；presales-site SITE-06～09 正反例。改动七个内部类型包的 qa_rules.py 后同样要跑。
