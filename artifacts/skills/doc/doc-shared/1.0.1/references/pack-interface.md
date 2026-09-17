# 类型包接口

类型包 = 一个目录 `types/<id>/`，描述一种文档的形态：骨架、必备章节、编号、封面、质检规则、模板、钩子。类型包是数据，不是 skill（不单独触发）；由 doc-orchestrator 按 doc.json type 加载。

阶段 1 期间类型包先在 ~/workspace/docs/doc-skill-platform-2026-09-15/staging/types/ 起草，验收后移入 doc-shared/types/。脚本查找类型包的顺序：命令行 --pack → 环境变量 DOC_TYPES_DIRS（冒号分隔的 types 根目录）→ doc-shared/types/<id>/。

## 1. 目录结构

```
types/<id>/
  pack.json          机器可读声明（本文件 §2；schemas/pack.schema.json）
  skeleton.md        写作者看的骨架说明，章节 id 与 pack.json skeleton 一致
  qa-rules.md        本包专属规则（自动 + 人工 + 伪问题）
  qa_rules.py        check(doc, ctx)（§4）；可先空实现
  templates/         正文模板、固定版式块
  writing-contract/  写作约束快照（可选，decisions ⑨A）
  samples/           样张运行目录（回归 golden）
```

## 2. pack.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| schema_version | 否 | "1" |
| id | 是 | 小写短横线，如 prd、tech-spec、test-cases；模板用 _template |
| name | 是 | 中文名，如「产品需求文档」；封面类型名、PDF Subject、文件名 {name} |
| version | 是 | 类型包自身版本，三段式 X.Y.Z；递增语义与 CHANGELOG 约定见 §6 |
| status | 是 | planned（只登记）、draft（样张未过）、stable（样张 D3 通过） |
| description | 否 | 一句话 |
| audience | 是 | internal / external；决定默认品牌档案与封面 |
| brand_profile | 是 | 默认品牌档案 id，必须存在于 brand/profiles/ |
| run_root | 是 | 运行目录根，如 `~/workspace/docs/{project}` |
| run_dir_pattern | 否 | 默认 `{type}-{short}-v{version}` |
| source_file | 是 | 正文文件名，默认 doc.md（售前 proposal.md） |
| outline_file | 否 | 默认 outline.md |
| meta_file | 否 | 默认 doc.json；售前兼容期声明 brief.json |
| inputs | 是 | D0 必需输入：[{id, desc, required, path（运行目录内 glob）, doc_field（doc.json 点号路径）}] |
| skeleton | 是 | 章节：[{id, title, level 1–3, required, when（按需条件）, aliases[], must_answer[], appendix}]；S1 按 title 或 aliases 匹配标题，或按 `{#sec:<id>}` 锚点匹配 |
| numbering | 是 | {section: decimal / none, appendix: alpha / none, max_depth 1–4, figure 模板, table 模板, entities[{kind, label, prefix, pattern, unique, contiguous}]} |
| include_allow | 是 | include 白名单 glob（运行目录相对路径，不含 .. 与绝对路径）；空数组表示禁止 include |
| include_deny | 否 | 在白名单之后再排除的 glob，如 `*internal*` |
| features | 是 | 开关：code_blocks、landscape、data_blocks、summary_block、footnotes、h1_page_break（always / auto / never，null 表示随品牌档案；旧字段 h1_new_page 布尔仍兼容）、toc、table_captions、figure_numbers、thead_repeat。售前包迁移期可关掉新特性以保 golden |
| stages | 否 | 业务阶段名，追加到通用阶段 |
| related | 否 | 本类型需要的关联文档：[{type, role, for_gate（用于 D2 门相关检查）, required（D0 时必须已登记且可解析）, desc}]；同一 type + role 不重复。run_state.py D0 检查 required 项；doc-qa 按 for_gate 给缺失定级 |
| gates | 是 | {D2: null 或 命令}；命令见 §3 |
| qa | 是 | {rules_py（可 null）, rules_md, engine_rules{include: "all" 或 [规则], exclude[]}, severity_overrides{规则: 定级}, glossary（{正写: [异写]} 对象，或包内 JSON 文件路径如 glossary.json）, banned_terms[{term, regex, severity, message, columns[]}]（无 columns 的词按 R1 全文检查；有 columns 的词按 T11 只查这些列）, highlight_limits{total, per_page, max_length}（可选，H1–H3）, key_figures[{id, label, pattern, normalize, severity}]（可选，X4）, allowed_languages[]（可选，代码块语言白名单；类型包 qa_rules.py 优先读它、读不到回退脚本内常量，引擎不直接使用）} |
| hooks | 是 | {pre_render, pre_qa, pre_publish, post_publish}，每项 null 或命令 |
| cover | 是 | marketing / technical（覆盖品牌档案的封面） |
| filename | 是 | PDF 文件名模板，占位符见 layout.md §11 |
| writing_contract | 否 | {source, snapshot（包内相对路径）, source_version, snapshot_date} |
| templates | 否 | 包内模板文件列表（validate 检查存在，且按 realpath 必须在包目录内；modes 的 templates 同样）；组织级章节不写这里，写 org_sections |
| org_sections | 否 | 本包引用的组织级章节：[{id, path（相对 doc-shared，必须在 brand/org/sections/ 内）, required, desc}]。required 为真表示使用本包的文档正文必须 include 该章节：validate 要求基础 skeleton 有同 id 的必备章节，正文里是否真有该章由 doc-qa S1 检查（类型包 engine_rules 没开 S1 时不检查）；为假表示可选引用。validate 另查 id 不重复、path 按 realpath 规范化后仍在 brand/org/sections/ 内且是文件。例：`[{"id": "qms", "path": "brand/org/sections/qms.md", "required": false}]` |
| triggers | 否 | 判型关键词（非空字符串数组，不重复），口径同 doc-orchestrator/references/type-triggers.json types.<id>。2026-09-15 起 detect_type.py 读取本字段，追加到该类型关键词（去重）；转交 handoff 规则只在 type-triggers.json 定义，本字段不能改变售前转交 |
| samples | 否 | 样张运行目录（包内相对路径或绝对路径） |
| doc_extra_schema | 否 | 约束 doc.json extra 的 JSON Schema（只能用 validate.py 支持的关键字） |
| modes | 否 | 项目类型变体：{field（元数据文件点号路径，如 site.project_type）, default, items[{id, name, desc, aliases[], skeleton_patch, skeleton_insert[], skeleton_remove[], forbidden_terms[], templates[]}]}，见 §2.1 |

### 2.1 modes（项目类型变体）

同一类型文档按项目类型有骨架差异时（例如建站售前的 0-1 新建、同店重构、跨平台迁移），不拆成多个类型包，而在 pack.json 声明 modes：基础 skeleton 是 default mode 的骨架，其他 mode 只写差异。

| 字段 | 说明 |
|---|---|
| field | 元数据文件（meta_file）里取 mode 的点号路径；值匹配 items 的 id 或 aliases；缺省取 default |
| default | 默认 mode id，必须在 items 里 |
| items[].skeleton_patch | {基础章节 id: {title, aliases, must_answer}}，只能改这三项，不能改 required |
| items[].skeleton_insert | [{after: 章节 id, section: 与 skeleton 项同结构}]，按顺序插入；after 可以指本 mode 之前插入的章节 |
| items[].skeleton_remove | 只能删 required 为 false 的基础章节；同一章节不能既补丁又删除 |
| items[].forbidden_terms | 该 mode 客户可见正文不得命中的 Python 正则（include 展开后、去掉 HTML 注释等例外区再匹配；数字类禁词写非数字边界，如 `(?<!\d)301(?!\d)`，避免误伤股票代码这类长数字）。契约只登记，validate 检查可编译；`validate.forbidden_hits(pack, mode, text)` 给质检复用 |
| items[].templates | 该 mode 专用的包内模板或内容片段，validate 检查存在 |

取 mode（取值规则，2026-09-15 契约第二轮）：

1. 先按 field 的点号路径读元数据文件（meta_file，默认 doc.json）；路径完整且值非空就用它，值无法识别抛 ModeError，不被其他来源覆盖、不静默回落。
2. 路径不全（任一段缺失或值为空）且元数据文件不是 brief.json 时，读运行目录 brief.json 的同一路径；有值就用 brief.json。
3. 都没有时回到元数据文件：兼容旧写法（site.migration 为真 → migration，若该 mode 存在），否则取 default。

唯一实现：`validate.resolve_mode(pack, meta, run_dir=运行目录, meta_file=元数据文件名)`（给 run_dir 时按 1–3 走；只传 pack、meta 时只看传入的 meta，供没有运行目录的调用方）；选元数据这一步是 `validate.mode_meta(run_dir, pack, meta, meta_file)`。doc-qa `docmodel.mode_meta` 转发到它，doc-author `authorlib.skeleton_for(pack, meta, run_dir=…)` 同一规则；其他消费方（写作、质检、类型包 qa_rules）复用这两个函数，不自己拼路径或另读 brief.json。取打完补丁的骨架：`validate.resolve_skeleton(pack, mode_id)`（mode_id 为 None 取 default，可传别名）。章节标题里的手写序号不影响匹配（S1 去掉手写序号后比较），插入章节后显示编号由编号引擎重排。消费方（写作、S1 章节检查、质检禁词）按运行目录元数据选 mode；尚未接入 mode 的引擎按基础 skeleton 工作，所以基础 skeleton 必须是一个完整可用的 mode。

校验：`python3 <doc-shared>/scripts/validate.py <类型包目录>`。除 schema 外还检查：章节 id 与实体 kind 不重复、实体正则可编译、品牌档案存在、qa 与模板文件存在、qa_rules.py 顶层定义 check(doc, ctx)、命令占位符合法、include 白名单不越界、modes 的 default 存在且补丁 / 插入 / 删除引用的章节合法、mode 模板文件存在、org_sections 路径合法；CLI 另做发布约定检查（§6）。

## 3. 命令与钩子约定

命令对象：`{"command": [argv…], "desc": "…", "pass_exit_codes": [0], "timeout_s": 600}`。

- argv 是数组，不经过 shell。占位符只能用：{run_dir} {pack_dir} {skills_dir} {doc_shared} {python}（当前 Python 解释器）。
- 工作目录 = 运行目录。环境变量：DOC_RUN_DIR、DOC_PACK_DIR、DOC_SHARED、DOC_TYPE。
- 超时默认 600 秒。

| 钩子 | 调用者与时机 | 退出码 | stdout 约定 |
|---|---|---|---|
| gates.D2 | run_state.py pass-gate --gate D2 --run | 在 pass_exit_codes 内为通过 | 不解析，尾部 300 字记入拒绝原因 |
| pre_render | doc-render 解析正文之前（生成片段、数据） | 0 继续；非 0 中止渲染 | 可选 JSON：{"generated": [文件]} |
| pre_qa | doc-qa 跑完引擎与类型规则之后、写 qa-result 之前 | 0 或 3（3 表示有必改，仍合并）；其他为钩子故障 | JSON：{"issues": [{rule, severity, line, excerpt, message}]}；引擎补 rule_source=hook。钩子故障时引擎记一条必改 E-HOOK |
| pre_publish | doc-publish 在 G3/D3 检查之后、写飞书之前 | 0 继续；非 0 拒绝发布 | JSON：{"ok": true, "extra": {…}, "message": "…"}；extra 合并进 published.json |
| post_publish | doc-publish 回查之后 | 非 0 记入 problems，不回滚发布 | JSON：{"extra": {…}} |

## 4. qa_rules.py 接口

```python
def check(doc, ctx):
    """返回问题列表；不修改 doc，不写文件。"""
    out = []
    for e in doc.entities.get('requirement', []):
        if not e['row'] or not e['row'].get('验收标准'):
            out.append(ctx.issue('PRD2', '必改', e['line'], e['code'], f"{e['code']} 缺验收标准"))
    return out
```

规则：
- 规则编号用本包前缀（PRD1、SPEC2、TC3、售前沿用 A1–A3、C2、C3、B1、F2、F4、R2、R3、L3、L5）；不得占用引擎编号 L1、L2、L4、L6–L10、S1–S3、X1–X3、C1、R1、T1–T12、E-TYPE、E-HOOK。
- 抛异常时引擎记一条必改 E-TYPE（含异常摘要），不静默跳过。
- 不 import 引擎内部模块；需要的能力都从 doc 与 ctx 取。
- 可选导出 `MESSAGE_OVERRIDES = {键: 模板}` 覆盖引擎消息文案（目前只有 `L1.forbidden`，模板占位符 {allow}）。只用于迁移期保证旧结果逐项比对，新类型包不要用。

### doc（文档模型，只读；由共享 DocMark 解析器产出，doc-render 与 doc-qa 同一份）

| 属性 | 类型 | 说明 |
|---|---|---|
| source_file | str | 正文文件名 |
| raw、raw_lines | str、list[str] | include 展开前的正文（金额溯源这类规则要看手写部分） |
| text、lines | str、list[str] | include 展开后的正文；issues 的 line 按 lines 1 起计 |
| line_origin | list[(file, line)] | lines 每行来自哪个文件第几行 |
| title | str | 文档标题 |
| headings | list[dict] | {level, number, title, line, anchor, appendix, skeleton_id}（skeleton_id 为匹配到的骨架章节 id 或 None） |
| section(key) | 方法 | 按 skeleton_id、anchor 或 number 返回 {heading, start, end, text, blocks} 或 None |
| blocks | list[dict] | 按顺序的全部块：{kind: p / ul / ol / table / figure / image / code / data / callout / summary / pagebreak / landscape, line, section_number, …} |
| tables | list[dict] | {caption, anchor, number, header[], rows[[…]], records[{列名: 值}], widths, line, source: md / data, data_file, landscape} |
| figures | list[dict] | {src, caption, anchor, number, engine, width_pct, line}（位图 engine 为 image） |
| code_blocks | list[dict] | {lang, text, line} |
| callouts | list[dict] | {kind, text, line} |
| lists | list[dict] | {kind, line, items[{text, line, level}]} |
| links | list[dict] | {text, url, line} |
| footnotes | dict | {id: {text, line}}；footnote_refs list[{id, line}] |
| anchors | dict | {"fig:x": {kind, id, number, line}} |
| refs | list[dict] | {target: "fig:x", line} |
| entities | dict | 按 numbering.entities：{kind: [{code, line, section_number, row（所在表格行的 records 字典，不在表格里为 None）}]} |
| includes | list[dict] | {target, line, status: ok / forbidden / missing} |

### ctx

| 属性或方法 | 说明 |
|---|---|
| run_dir、pack、pack_dir | 运行目录绝对路径；pack.json 内容；包目录 |
| meta、meta_file | 元数据文件内容（默认 doc.json；售前 brief.json）与文件名 |
| profile、tokens | 品牌档案与 tokens.json 内容 |
| exists(rel)、read_text(rel)、read_json(rel) | 读运行目录内文件；路径越出运行目录时抛错（售前 A1–A3 读 pricing/、scope.json 用这些） |
| related(type, role=None, title=None) | 基于 scripts/related.py 的 Related.find：返回 RelatedDoc，没登记返回 None；同条件命中多份抛 AmbiguousRelated（引擎记 E-TYPE，类型包应传 role）。RelatedDoc：ok、error、type、role、version_mismatch、meta（对方 doc.json）、run_dir、exists(rel)、read_text(rel)、read_json(rel)、read_csv(rel) → list[dict]、column(rel, 列名) → list[str]；doc-qa 另挂 doc 属性（对方文档模型，按需解析） |
| related_all(type=None, role=None) | 返回全部命中的 RelatedDoc |
| missing_related_issue(rule, type, role=None, for_gate=False, detail='') | 关联文档缺失的问题：for_gate 为 True（D2 门相关）定必改，否则定提示；for_gate 取 pack.json related 里对应条目 |
| render_json、figures_review | out/render.json 与 figures/review.json 内容，不存在为 None |
| issue(rule, severity, line, text, msg) | 构造问题字典；excerpt 截断 120 字 |
| exists_safe(rel)、read_json_opt(rel) | doc-qa 扩展：越界或不存在时返回 False / None，不抛错 |
| list_dir(rel)、glob(pattern) | doc-qa 扩展：列运行目录内的文件（不得越界） |
| feature(name)、qa | doc-qa 扩展：pack.features 开关（缺省为假）；pack.qa 内容 |

### 通用小工具（doc-shared/scripts/qa_pack_helpers.py）

七个内部类型包 qa_rules.py 共用的章节、表格、CSV 与跨文档读取小工具（section、tables、col、cell、records、where、ent_where、finish、body、visible、subheadings、read_csv、related 等），类型包用 `from qa_pack_helpers import section as _section, …` 引入，不再各带一份副本；doc-qa 进程里 doc-shared/scripts 已在 sys.path，直接加载 qa_rules.py 时按包目录相对路径兜底。`related(ctx, rule, type, role, memo)` 按 type + role 命中且可读才用，related_docs.role 必填（artifacts.md §2.1），缺 role 的条目一律按缺失报、不兼容读取。只和某几类文档有关的读取函数（如按对方 CSV 取需求或用例）留在用到它的类型包里。

### 跨文档检查的写法

```python
def check(doc, ctx):
    out = []
    prd = ctx.related('prd', role='source_prd')
    if prd is None or not prd.ok:
        return [ctx.missing_related_issue('XX2', 'prd', role='source_prd', for_gate=True, detail=prd.error if prd else '')]
    known = set(prd.column('data/requirements.csv', '需求编号'))
    for t in doc.tables:
        for r in t['records']:
            if r.get('关联需求') and r['关联需求'] not in known:
                out.append(ctx.issue('XX3', '必改', t['line'], r['关联需求'], '关联需求在 PRD 中不存在'))
    return out
```

D2 门命令（run_state.py pass-gate --gate D2 --run 执行）需要读关联文档时，把 {doc_shared}/scripts 加进 sys.path 后 `from related import Related`；找不到关联文档时以非 0 退出码结束，即「必改」语义。

### 引擎自动生成的前置页与骨架的关系（2026-09-15 第三波去重）

doc-render 按 doc.json 与品牌档案自动生成两类前置页（common.py front_pages()）：封面文档控制表（profile.doc_control_table 为真时，读 doc.json 的 status、owner、reviewers、related_docs、version）与修订记录页（profile.revision_page 为真且 doc.json.revision_history 非空）；`<!-- summary --> … <!-- /summary -->` 块生成摘要页。doc-qa 的 LY10 规则会检查正文一、二级标题是否与这些自动生成页同名或同义（"文档控制""修订记录""摘要""执行摘要"），命中即报重复。

pack.json 的 skeleton 数组没有字段能表达"这章由引擎生成、不需要正文标题匹配"（schema 里 skeleton 的 additionalProperties 为 false，且没有 engine_generated 这类布尔字段）。因此类型包处理办法是：**直接从 skeleton 数组删掉这个章节条目**（不是设为 required: false 留着），并在该包的 skeleton.md 里用一段说明文字标注"由引擎按 doc.json 生成，不在正文写"；「摘要」类章节同理删掉编号章节条目，改为在 skeleton.md 里要求正文含 `<!-- summary --> ... <!-- /summary -->` 块，并列出必须回答的要点（原 must_answer 内容原样保留在 skeleton.md 里，不再是 pack.json 里可被 S1 引擎规则机器校验的字段）。prd、mrd、tech-spec、api-reference、test-plan、test-report 六个类型包已按此处理（2026-09-15 第三波，去重前 pack.json 里 control/summary 两个 id 的写法与 must_answer 见各包 git 历史或备份 `~/.claude/skills-backups/doc-platform-20260915-pre-wave3.tgz`）。

若将来需要机器校验 summary 块是否存在、或校验封面控制表字段是否齐全，需要给 schema 新增字段（如 skeleton 条目的 `engine_generated: true` 或 pack.json 顶层的 `must_have_summary_block: true`），这超出类型包目录自身能改的范围，需要主代理改 schemas/pack.schema.json。

## 5. 新类型扩展流程（design §5.7）

1. 复制 types/_template/ 为 types/<id>/，改 pack.json（id、name、audience、brand_profile、skeleton、numbering、features、filename）与 skeleton.md，把 CHANGELOG.md 首条改成本包（标题为 pack.json version）。跑 validate.py 通过。
2. 写 qa-rules.md 人工清单；qa_rules.py 可先空实现（返回 []）。新自动规则先定级「提示」。
3. 若对齐 lark-doc genres：把对应文件复制进 writing-contract/，writing_contract 写来源路径、lark-cli 版本与快照日期（decisions ⑨A：快照而非引用）。
4. 做一份样张运行目录（samples/），依次跑 doc-figures build、doc-qa、doc-render；qa-result.json 与 render.json 无必改后存为 golden，status 改 draft → stable。
5. doc-shared/SKILL.md 类型表加一行；doc-orchestrator 的 description 补触发词。

## 6. 版本号语义与 CHANGELOG（v1.5 维护约定，2026-09-15）

类型包 pack.json version 与 doc-* 各 skill 的版本都用三段式 `X.Y.Z`（semver，不带预发布号与构建号）。

| 递增 | 何时 | 例 |
|---|---|---|
| +0.0.1 修正 | 不改契约的修正：文案与模板错字、样张数据、规则误报修正；已有文档按新版本质检不会变严 | 1.1.0 → 1.1.1 |
| +0.1.0 新增能力 | 向后兼容地新增：可选字段、新 mode、新模板或内容片段、新自动规则（先定级「提示」）、新的按需章节 | 1.0.0 → 1.1.0 |
| +1.0.0 破坏性变更 | 按原契约写的运行目录或下游会失败：删改必填字段或字段含义、新增必备章节或必需输入、改编号格式、规则定级升到「必改」、改文件名模板 | 1.4.2 → 2.0.0 |

- 版本在哪：类型包写 pack.json version（qa-result.json engine.pack_version 会记录它）。skill 没有单独的版本字段，以 skill 目录 CHANGELOG.md 最新一条标题为当前版本；引擎写进产物的版本常量（如 doc-figures build.py VERSION、doc-qa qa.py ENGINE_VERSION）随能力变化同步，常量写成两段的按补零理解（1.0 = 1.0.0）。
- 同一版本在首次对外使用（被运行目录引用、发布）之前的多批改动可并入同一条目；之后再改，按上表递增。
- CHANGELOG.md：放在每个类型包目录与每个 doc-* skill 目录；新版本在上；每版一个二级标题 `## X.Y.Z — YYYY-MM-DD`，下面分「能力 / 变更 / 修正 / 已知缺口」写要点与来源（批次、拍板编号），不写讨论过程。
- 校验：`validate.py <类型包目录>` 在 schema 与语义检查之外做发布约定检查（version 为三段式、CHANGELOG.md 存在、当前版本的二级标题「## X.Y.Z — YYYY-MM-DD」（须带日期）存在且是最上面一条版本标题；不识别代码块，代码块里写成标题形的行也会被当作标题），`--no-release` 跳过；引擎运行时调用的 validate_data 不做这项检查（临时包与自测夹具不受约束）。改 pack.json version 时同一次改动补 CHANGELOG 条目，否则 validate 不通过。
