# CHANGELOG · doc-shared

版本号语义见 references/pack-interface.md §6：+0.0.1 修正、+0.1.0 新增能力、+1.0.0 破坏性变更。skill 没有单独的版本字段，最新一条标题即当前版本。

## 1.0.0 — 2026-09-15

首版契约层（1a），第三波补丁并入同一版。

### 契约
- DocMark 语法（references/docmark.md）与共享解析器 scripts/docmark_parse.py，doc-render、doc-qa、doc-author 共用一份。
- 工件字段 references/artifacts.md 与 schemas：doc、pack、run-state、render、qa-result、published、brief。
- 阶段门 D0–D4（references/gates.md），run-state.json 只经 scripts/run_state.py 写。
- 品牌 token（brand/tokens.json → brand/generated/）、品牌档案 cyberklick 与 internal、组织口径 brand/org/。
- 版式 layout.md（含 LY9、LY10 与 features.h1_page_break）、中文排版 typography.md T1–T12、质检分层 qa-engine.md、图表 figures-policy.md、飞书约束 feishu.md、类型包接口 pack-interface.md。
- 跨文档读取机制：doc.json related_docs 与 scripts/related.py（artifacts.md §2.1，role 词表）。
- 九个业务类型包落位 types/（prd、mrd、tech-spec、api-reference、test-plan、test-cases、test-report、presales-site、presales-reddit）与 types/_template。

### 第三波补登记
- pack.json modes（项目类型变体）与 validate.resolve_mode、resolve_skeleton、forbidden_hits（W3-C，v1.5 吸收）。
- 组织级 QMS 章 brand/org/sections/qms.md（㉔A）。
- render.schema highlights、pack.schema features.h1_page_break、品牌档案 h1_page_break；published.schema 登记进 validate.py。
- pack.schema outputs（默认附加输出 docx，W3-D1）。
- 引擎自动生成的前置页与骨架的关系：类型包删除「文档控制与修订记录」「摘要」骨架条目，不加 engine_generated（W3-F，pack-interface.md §4 末节）。
- W3-E 契约补丁：schemas/brief.schema.json（doc 分支与售前分支，validate.validate_brief 支持分支、严格模式与 mode 取值核对）；pack.schema 声明 triggers、org_sections；validate.py 校验 org_sections 路径、pack version 为 semver、CHANGELOG.md 含当前版本标题；版本号语义与 CHANGELOG 约定；七个内部样张 related_docs 补 role；prd input4 改为可选。

### 已知缺口
- run_state.py D1 不核对 outline 拍板项、D3 不核对 qa-report 的 Codex 两轮记录（W3-D3 在改）。
- brief.schema 尚未接入 new_run.py、run_state.py D0；pack triggers 尚未被 detect_type.py 读取（接入归 doc-orchestrator 与 1f）。
- skeleton 没有字段表达「summary 块必须存在」「封面控制表字段齐全」，需要时再改 schema。

### 变更
- W3-I：brief.schema 售前分支 cover 加可选 party_label、badge（doc-render marketing 封面已读取）；references/qa-engine.md L6 与 LY4 去重口径；scripts/org_section.py 组织介绍首句品牌名后补空格（「Cyberklick 是」，与 presales-terms company_section.py 同步，保持逐字节一致自测）。
- W3-H 合并收敛与契约第二轮（2026-09-15）：新增 scripts/lark_io.py（lark-cli 调用、读命令白名单判定、全局写锁、exit 10 确认门、文件夹解析，doc-publish 两个脚本共用）、scripts/code_scan.py（编号边界匹配与简写续号、代码块与注释遮蔽，xref_check / trace_matrix / fill_check 共用；~~~ 不再当代码块，与解析器一致）、scripts/qa_pack_helpers.py（七个内部类型包 qa_rules 通用小工具）；validate.mode_meta 与 resolve_mode(run_dir=…) 为 mode 取值唯一实现（pack-interface §2.1）；pack.schema 新增可选 qa.allowed_languages；doc.schema related_docs.role 改为必填，related.py 缺 role 时 ok=false。

### 重点高亮颜色变体（2026-09-15 主代理追加，并入 1.0.0）
- `⟪⟫` 支持可选单字符颜色前缀：`!` risk、`+` tip、`~` warn、`?` decision，无前缀为 neutral（原默认色，向后兼容）。
- 解析器：highlight 节点新增 `kind`，`doc.highlights` 条目同步带 `kind`；前缀字符被消费，不进内容、不计字数；`⟪` 后不是这 4 个字符时按 neutral 处理且不吞字符。HL1 诊断逻辑不变。
- 配色一律复用 `brand/tokens.json` 的 `callout` 表（neutral → callout.note），tokens.json 未新增字段。
- 契约文档：docmark.md 新增「重点高亮颜色前缀」一节，docmark-ast.md 补 `kind` 字段，qa-engine.md 写明 kind 不影响 H1–H4 口径（5 种颜色合计计数）。
