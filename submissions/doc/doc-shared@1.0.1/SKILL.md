---
name: doc-shared
description: 专业文档生产体系（doc-* 矩阵）的契约层：DocMark 语法、doc.json 与运行工件字段、阶段门 D0–D4、品牌 token 与版式规范、中文排版规则 T1–T12、质检分层、图表引擎路由与画板约束、类型包接口，以及 PRD、MRD、技术 Spec、API 参考、测试计划、测试用例、测试报告、售前方案的类型表。用户要写 PRD / MRD / 技术方案或设计文档（Spec）/ 接口文档 / 测试计划 / 测试用例 / 测试报告等专业文档，或要求「PDF 与飞书双输出」「带目录页码、图表编号、品牌封面的正式文档」「新增一种文档类型」「文档版式与排版规范是什么」时，doc-* 任何 skill 开工前必读本 skill。本 skill 只定规则、不写正文。只读取、编辑或小改一篇已有飞书文档（不需要类型骨架、质检、PDF）走 lark-doc。
---

# doc-shared（契约层）

> **路径约定**：`<doc-X>` = 兄弟 skill doc-X 的目录（与本 SKILL.md 同级；矩阵由 pack 整体安装，成员始终并排）。

本层只定义规则、schema、品牌 token 与类型包接口。数值、字段、门条件只在本层定义；引擎与类型包引用，不复制——复制会产生第二个事实源。

## 矩阵一览（decisions ①A）

| 层 | skill | 职责 | 产出 | 状态（2026-09-15） |
|---|---|---|---|---|
| 契约 | doc-shared | DocMark、工件字段、D0–D4、定级、品牌 token、版式与排版规则、质检分层、类型包接口、组织口径 | 规则、schema、生成物，无正文 | 1a 已建 |
| 编排 | doc-orchestrator | 判类型与模式（new / revision / import）、建运行目录、收 Brief、串引擎、守门、组织拍板 | doc.json、run-state.json | 已交付（W3；详见 doc-orchestrator/SKILL.md） |
| 引擎 | doc-author | 按类型包写骨架（D1 拍板）与正文；数据块 | outline.md、doc.md、data/ | 已交付（W3；详见 doc-author/SKILL.md） |
| 引擎 | doc-figures | Mermaid、Graphviz、svgkit 路由；PDF 用 SVG 与飞书画板源；图检查 | figures/ | 已交付（详见 doc-figures/SKILL.md） |
| 引擎 | doc-render | DocMark → HTML → PDF（Chrome CDP）与飞书 XML；封面、目录页码、书签、页眉页脚、图表编号 | out/、out/render.json | 已交付（含 docx 等输出，以 doc-render/SKILL.md 为准） |
| 引擎 | doc-qa | 通用规则 + 类型包规则 + 业务钩子；Codex 找茬与证伪 | qa-result.json、qa-report.md | 已交付（详见 doc-qa/SKILL.md） |
| 引擎 | doc-publish | 发布到飞书项目文件夹、回查、归档 | published.json | 已交付（详见 doc-publish/SKILL.md） |
| 类型包 | doc-shared/types/<id>/ | 骨架、必备章节、编号、封面、质检规则、模板、样张 | pack.json 等 | _template 已建；业务类型 1e 在 staging 起草 |
| 业务线 | presales-orchestrator、discovery、research、pricing、terms | 售前专属阶段，售前类型包的上游 | 各自工件 | 原样保留；1f 改调引擎 |

设计要点：类型包是数据，不做成独立 skill；**引擎不认识任何业务词**（tests/run_tests.py 对 scripts/ 与 references/ 做业务词守卫）；业务专属阶段经 pack.json hooks 接入。

## 运行目录与工件

`~/workspace/docs/<项目>/<类型>-<短名>-v<版本>/`（类型包 run_root 可改；售前沿用 `~/workspace/presales/<客户>/<业务线>-v<版本>/`）。

| 文件 | 写入者 | 说明 |
|---|---|---|
| doc.json | doc-orchestrator | 文档清单；schemas/doc.schema.json |
| run-state.json | scripts/run_state.py | 阶段与门；不手改 |
| outline.md、doc.md、sections/、data/ | doc-author | 骨架、正文（DocMark）、片段、CSV 数据 |
| figures/、figures/review.json | doc-figures | 图源、SVG、PNG 预览、检查记录 |
| base/ | scripts/import_doc.py | 改版底稿 |
| qa-result.json、qa-report.md | doc-qa | 结构化结果与报告 |
| out/（doc.html、feishu.xml、PDF、render.json、*.resolved.md） | doc-render | 渲染产物与版式检查 |
| published.json | doc-publish | 发布记录 |

字段详见 references/artifacts.md。

## 阶段门 D0–D4

| 门 | 位置 | 完成条件 | 售前对应 |
|---|---|---|---|
| D0 | 输入齐 | doc.json 合法；类型包 inputs 必需项齐 | G0 = D0 + 诊断产物 |
| D1 | 骨架 | 用户确认 outline.md（带字母选项） | G1 |
| D2 | 类型专属门 | 类型包 gates.D2 命令通过；为 null 时 skip | G2（计价脚本退出码 0） |
| D3 | 质检 | must_fix 为 0；render.json 无版式必改；Codex 两轮完成或写明降级；质检与渲染之后未再改源文件 | G3 |
| D4 | 发布 | 用户看过 PDF 预览并确认范围、版本、账号；doc.json lark_folder 有 token | G4 |

写门：`python3 <doc-shared>/scripts/run_state.py <运行目录> pass-gate --gate D1 --evidence "<用户原话>"`。规则、skip / waive、改版重开见 references/gates.md。

## 定级

| 定级 | 含义 | 发布前 |
|---|---|---|
| 必改 | 影响承诺范围、验收或合同责任、事实正确性，违反红线，或版式缺陷影响阅读 | 必须清零 |
| 建议 | 一致性与表达问题，不改会被追问 | 列入报告由用户选择 |
| 提示 | 可选优化；新规则试运行 | 只进报告 |

## 类型表

| id | 名称 | 读者 / 品牌档案 | 封面 | 阶段 | 类型包状态 |
|---|---|---|---|---|---|
| prd | 产品需求文档（技术 PRD） | internal / internal | technical | 阶段 1 | draft，已落位 types/prd/，样张通过 validate.py 与 related.py |
| tech-spec | 技术 Spec / 设计文档 | internal / internal | technical | 阶段 1 | draft，已落位 types/tech-spec/，样张通过 validate.py 与 related.py |
| test-plan | 测试计划 | internal / internal | technical | 阶段 1 | draft，已落位 types/test-plan/，D2 门脚本已接入，样张通过 validate.py 与 related.py |
| test-cases | 测试用例（CSV 数据块为主，横向宽表） | internal / internal | technical | 阶段 1 | draft，已落位 types/test-cases/，样张通过 validate.py 与 related.py |
| mrd | 市场需求文档 | internal / internal | technical | 阶段 2 | draft，已落位 types/mrd/，样张通过 validate.py 与 related.py |
| api-reference | 接口参考 | internal 或 external | technical | 阶段 2 | draft，已落位 types/api-reference/，样张通过 validate.py 与 related.py |
| test-report | 测试报告（执行结果、缺陷统计、准出结论） | internal / internal | technical | 二期 | draft，已落位 types/test-report/，样张通过 validate.py 与 related.py |
| presales-site | 售前方案：建站 | external / cyberklick | marketing | 1f 注册 | 已落位 types/presales-site/；qa_rules.py、qa-rules.md 待 1d 补齐后 validate.py 才能全绿；1f 与 presales-shared/packs/site 合并注册 |
| presales-reddit | 售前方案：Reddit | external / cyberklick | marketing | 1f 注册 | 已落位 types/presales-reddit/；qa_rules.py、qa-rules.md 待 1d 补齐后 validate.py 才能全绿；1f 与 presales-shared/packs/reddit 合并注册 |

九个类型是**九个独立类型包**（主代理 2026-09-15 定）：api-reference 是独立包，不是 tech-spec 的子模式；test-plan 与 test-cases 是两个包，不合并为一个包的两个子类型。跨文档关系（MRD → PRD → Spec / API 参考 → 测试计划 → 测试用例 → 测试报告）通过 doc.json related_docs 与 scripts/related.py 读取，见 references/artifacts.md §2.1。

九个业务类型包已落位 types/（1e，2026-09-15）；staging 目录 ~/workspace/docs/doc-skill-platform-2026-09-15/staging/types/ 只保留原始草稿供追溯，不再是脚本查找路径。脚本查找顺序：--pack → DOC_TYPES_DIRS → doc-shared/types/。新类型扩展流程见 references/pack-interface.md §5。

## 与 lark-doc、presales-* 的边界

| 用户要做的事 | 走哪里 |
|---|---|
| 读、总结、局部修改、评论一篇已有飞书文档；轻量飞书文档（纪要、周报、随手记） | lark-doc |
| 按类型骨架写正式文档，要质检、目录页码、图表编号、品牌封面，PDF 与飞书双输出 | doc-*（入口 doc-orchestrator，建成前主代理按本契约） |
| 售前方案（建站、Reddit）含计价、条款、确认 | presales-orchestrator（迁移后内部调 doc-* 引擎） |

doc-* 发布到飞书时仍遵守 lark-doc 的 XML 规范与 references/feishu.md 的约束；写作约束可以快照 lark-doc/references/genres 下的对应文件（decisions ⑨A）。

## References

| 文件 | 何时读 |
|---|---|
| references/docmark.md | 写正文、写解析器或渲染器时 |
| references/artifacts.md | 读写任何工件时 |
| references/gates.md | 推进阶段、写门、改版重开时 |
| references/layout.md | 渲染、封面、目录、表格、图版式、文件名时 |
| references/typography.md | 写正文、实现或解释 T1–T12 时 |
| references/qa-engine.md | 质检、实现 doc-qa、排查规则来源时 |
| references/figures-policy.md | 画图、选引擎、检查图、做 svgkit 模板时 |
| references/feishu.md | 渲染飞书 XML、发布、回查时 |
| references/pack-interface.md | 写或改类型包、写 qa_rules.py、写钩子时 |

## 品牌与组织口径

| 路径 | 说明 |
|---|---|
| brand/tokens.json | 品牌 token 唯一事实源（颜色、字体、字号、间距、调色板、图风格、callout、飞书色名） |
| brand/generated/ | tokens.py 生成：tokens.css、svg-palette.json、mermaid-theme.json、feishu-callouts.json；不手改 |
| brand/profiles/cyberklick.json、internal.json | 品牌档案（decisions ③A）：对外营销封面 / 对内技术封面 + 文档控制表 + 修订记录 + 「内部资料」页脚 |
| brand/org/ | 组织级资产，从 presales-shared **复制**（原文件未动）：company.json、company-profile.md（只用登记了来源的内容）、eclicktech-logo.png（白底原图）、eclicktech-logo-transparent.png（color-to-alpha 生成，只适合浅底）、cyberklick-logo-dark.svg、cyberklick-logo-white.svg |

兼容说明：brand/org/company.json 与 presales-shared/references/company.json 逐字节相同，其中 logo 字段是相对 presales-shared 的旧路径；doc-* 引擎读 tokens.json brand.logo，不读该字段。1f 迁移售前时二者收敛为一份。

## 脚本

| 命令 | 作用 |
|---|---|
| `python3 scripts/validate.py <文件或类型包目录> [--kind …]` | 按 schemas 校验 doc / pack / run-state / render / qa-result，含语义检查；纯标准库 |
| `python3 scripts/tokens.py [--check]` | 从 tokens.json 生成 brand/generated/；--check 检出漂移；`--equiv-pt PX WIDTH` 算图等效字号 |
| `python3 scripts/run_state.py <运行目录> init / set-stage / pass-gate / skip-gate / waive-gate / fail-gate / reset-gate / decide / show` | run-state.json 唯一写入口 |
| `python3 scripts/related.py <运行目录> [--type T] [--role R] [--csv data/x.csv --column 列名]` | 解析 related_docs、读关联文档的 CSV；库形态供 doc-qa 的 ctx.related 与 D2 门脚本使用 |
| `python3 scripts/import_doc.py <来源> <运行目录> [--count 名称=正则]` | 飞书 / XML / PDF 导入为 base/base-doc.md |
| `python3 scripts/org_section.py <运行目录> [--delivery KEY] [--cases KEY]` | 生成组织介绍章节 sections/org.md |

脚本来源：import_doc.py 复制自 presales-orchestrator/scripts/import_doc.py（去掉金额与工作量统计，改为 --count；输出名改 base-doc.md）；org_section.py 复制自 presales-terms/scripts/company_section.py（业务线分支改为 --delivery、--cases、--cases-columns 参数，传入售前参数时输出逐字节一致，见自测）。旧路径未改动。

## 复核状态

**未经 Codex 复核**（2026-09-15）：开工前计划评审与交付前评审，gpt-5.6-terra（xhigh）与 gpt-5.6-sol（medium）各试一次，四次均 429 Too Many Requests，按约定未再重试。额度恢复后应补一轮只读评审，本想让 Codex 挑的点：
1. golden/compare.py 口径漏洞（PDF 全文删空白、60% 重复行当页眉页脚、feishu.xml 规范化正则）。
2. validate.py 自带 JSON Schema 子集校验器的错判（oneOf、additionalProperties 与 patternProperties 组合、$ref 与同级关键字）。
3. run_state.py 门逻辑：D3 用 mtime 判过期能否被绕过或误报；D2 --run 占位符；文件锁；fail / reset 后状态一致性；waive 范围。
4. schemas 与 references 字段是否互相矛盾。
5. qa_rules.py 接口（doc 模型、ctx、related）是否够 1d 搬迁售前 A1–A3、C3。
6. tokens 生成物是否够 1b、1c 用；等效字号公式。
7. T1–T12 判据误报面。
8. 业务词守卫词表与范围。
评审提示词：/private/tmp/claude-501/-Users-chovi-workspace/aa8a62cd-4840-4fd3-9466-543096044d4a/scratchpad/codex-review.md（会话临时目录，可能被清理；要点以本节为准）。

## 自测

改动本层任何脚本、schema、token 或 references 后运行，ALL PASS 才算改完：

```sh
python3 <doc-shared>/tests/run_tests.py
```

覆盖：schema 只用校验器支持的关键字；doc / pack / run-state / render / qa-result 正反例；tokens 生成物与 tokens.json 一致、调色板与售前 svgkit 一致、漂移可检出、等效字号公式；run_state 门顺序与各门自动检查（含 D0 关联文档）；related.py 路径解析、类型与版本核对、CSV 读取、越界拦截、缺失定级；_template 类型包通过校验；org_section 与旧脚本输出一致；import_doc；引擎业务词守卫。
