# 阶段门 D0–D4

门状态只由 scripts/run_state.py 写入 run-state.json：引擎脚本在阶段完成时调用，主代理在用户确认后调用。不手改 run-state.json（修 assessment §5 第 14 条：MOBYVOW 已发布但 G2–G4 仍 pending）。

## 1. 门定义

| 门 | 位置 | 完成条件 | run_state.py 自动检查 | 证据（--evidence） | 可 skip / waive |
|---|---|---|---|---|---|
| D0 | 输入齐 | doc.json 必填项齐；类型包 inputs 声明的必需输入齐 | doc.json 通过 schema 与语义校验；inputs 的 path 存在、doc_field 非空；元数据文件为 doc.json 时，既无 path 也无 doc_field 的必需输入读 brief.json inputs，缺 brief.json 或值为空即拒绝（元数据文件为 brief.json 的业务线只记 checks）；required 关联文档已登记且可解析 | 可选 | 否 |
| D1 | 骨架 | 用户确认 outline.md（带字母选项的拍板项） | 前序门完成；类型包 outline_file（默认 outline.md）存在；run-state decisions 至少 1 条，且不少于 outline 行首 ①–⑳ 拍板项数 | 必填：用户原话或选项回复，如「①A ②B」 | 否 |
| D2 | 类型专属门 | 类型包 gates.D2 声明的命令通过；声明为 null 时跳过 | 类型包 D2 为 null 时拒绝 pass、只允许 skip；有命令时必须带 --run（不带即拒绝），执行并按 pass_exit_codes 判定 | 必填：命令与结果摘要 | skip（仅 D2 为 null）；waive（需 --by 与 --reason） |
| D3 | 质检 | qa-result.json must_fix 为 0；render.json 版式检查无必改；Codex 两轮完成或写明降级 | qa-result.json 与 out/render.json 存在且通过 schema；must_fix 0；layout_issues 无必改；质检、渲染之后运行目录内没有再改过源文件（严格比较修改时间，无容差；out/、base/、qa-result.json、qa-report.md、run-state.json、published.json、*.lock、点开头文件不计）；qa-report.md 存在，人工区块（qa-auto 标记之外、去掉标题行）非空，出现 Codex，且非标题的正文行里同时记有「找茬」「证伪」两轮（标题「Codex 找茬与证伪」本身不算记录）；证据可定位（写出运行目录内存在的文件名，或人工区块的某个标题）。通过时写 source_manifest（§6） | 必填：Codex 两轮结论位置，或「terra 与 sol 均 429，降级」这类说明（降级时仍按找茬、证伪两轮分别写明） | waive（需 --by 与 --reason；豁免不写 manifest） |
| D4 | 发布 | 用户看过 PDF 预览，确认范围、版本、飞书账号与项目文件夹 | doc.json lark_folder 有 token（decisions ⑫A） | 必填：用户确认原话 | 否 |

通用规则：
- 后序门要求前序门都是 passed、skipped 或 waived。
- fail-gate 把该门置 failed，其后的门全部回到 pending。
- reset-gate Dn 把 Dn 及其后的门回到 pending：改版（revision）重开时从 D1 或 D2 起重走。
- 每次写入都追加 history（时间、动作、门、谁、摘要），并在写盘前按 schemas/run-state.schema.json 校验，不合法就不写。
- 写入是原子的（临时文件 + rename），并用文件锁防止并行子代理同时写。

## 2. 阶段名

通用阶段：intake、outline、author、figures、render、qa、review、publish、done。类型包 pack.json 的 stages 可追加业务阶段（如售前的 discovery、research、pricing、terms）。set-stage 只接受这两类名字。

## 3. 定级

| 定级 | 含义 | 发布前 |
|---|---|---|
| 必改 | 影响承诺范围、合同或验收责任、事实正确性，违反红线，或版式缺陷影响阅读（如图字号低于下限、表格无表头） | 必须清零（D3） |
| 建议 | 一致性与表达问题，不改会被追问 | 列入 qa-report 由用户选择 |
| 提示 | 可选优化、内部对齐项；新规则的试运行定级 | 只进报告 |

## 4. 与售前 G0–G4 的映射

| 售前门 | 通用门 | 说明 |
|---|---|---|
| G0 | D0 + 类型包阶段 discovery 的诊断产物 | 售前类型包 inputs 声明 brief 必填项与诊断产物路径（如 site-audit.json）；「退出码 3、4 已向用户说明缺口」作为 D0 证据 |
| G1 | D1 | 同 |
| G2 | D2 | 售前类型包 gates.D2 声明计价脚本（建站带 --scope 核对；Reddit 套餐底线与产能状态 ok），退出码 0 通过 |
| G3 | D3 | 迁移前售前没有 render.json：1f 让售前也经 doc-render 产出 render.json；兼容期内缺 render.json 只能 waive 并写明原因 |
| G4 | D4 | 售前沿用 brief.json 的发布参数；D4 要求的 lark_folder 由售前类型包在 brief 兼容字段里提供（1f 定） |

旧 run-state.json（`"gates": {"G0": "passed", …}` 字符串格式）不通过本 schema，run_state.py 拒绝读写。1f 迁移时转换（presales-shared/scripts/presales_migrate.py，2026-09-15 定）：D0–D4 一律置 pending——旧 passed 无法按新门的自动检查与证据要求核实；原 G0–G4 对象整体放进 legacy，g1_decisions → decisions，g1_user_words → user_words；脚本打印每个门需要人工执行的 pass-gate 命令，由用户或主代理按新门条件逐门重新签过，不自动判 passed。

## 5. 编排执行边界（doc-orchestrator advance.py，2026-09-15 W3 补登记）

| 动作 | 由 advance.py --run 自动执行 | 必须人或主代理 |
|---|---|---|
| pass-gate D0 | 是（先核对 brief.json inputs） | — |
| pass-gate D1 | 否 | 用户确认 outline.md，证据为原话 |
| skip-gate D2（类型包 D2 为 null，带 --reason）/ pass-gate D2 --run | 是 | — |
| doc-figures build、doc-render、doc-qa（产物缺失或早于源文件） | 是 | — |
| reset-gate D3（D3 通过后源文件又被改） | 是 | — |
| pass-gate D3 | 否 | 主代理：Codex 两轮或降级说明 |
| doc-publish dry-run | 是 | — |
| D4 与 publish --apply | 否 | 用户确认 PDF 后主代理执行 publish.py --apply --evidence（doc-publish 写 D4） |

## 6. gates.D3.source_manifest（W3 补登记，主代理 2026-09-15 定）

run_state.py pass-gate D3 成功时写入；D3 回到 pending（reset-gate D0–D3）或 failed（fail-gate D0–D3）、以及 waive-gate D3 时不存在。

```json
{"algorithm": "sha256", "generated_at": "2026-09-15T14:30:00-04:00",
 "files": [{"path": "data/requirements.csv", "sha256": "…64 位小写十六进制…"}, {"path": "doc.json", "sha256": "…"}]}
```

| 字段 | 说明 |
|---|---|
| algorithm | 恒为 sha256 |
| generated_at | 写入时间（本地时区 ISO 8601） |
| files | 运行目录内全部源文件，按 path 排序；集合与 D3 新鲜度判定一致（run_state.source_files）＝ ① 目录遍历：out/、base/、.git/ 目录，qa-result.json、qa-report.md、run-state.json、published.json，*.lock、*.tmp、点开头文件与目录之外的全部文件（正文、include 片段、figures 源与生成物、data、outline.md、doc.json 或 brief.json）∪ ② 解析器实际引用到的文件：include（含嵌套）、图源与构建出的 SVG、数据块文件、指向运行目录内本地文件的链接——**隐藏路径（如 .data/table.csv、.draft/a.md）也收**；只收存在的普通文件、realpath 在运行目录内，out/、base/、.git/、*.tmp、*.lock 与运行、发布产物仍排除（主代理 2026-09-15 核对后补） |
| files[].sha256 | 文件内容的 SHA-256；doc.json 与 brief.json 先去掉 lark_folder 字段，再按 json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')) 的 UTF-8 字节计算（doc-publish 写回 token 不算改源） |

核对：`run_state.py <运行目录> check-manifest` 输出 {ok, gate_d3, manifest_at, files, added[], removed[], changed[]}；一致退出 0，不一致退出 3，没有 manifest 退出 1。doc-publish 发布前调用；doc-orchestrator advance.py 在 D3 已签时按同一清单判定是否 reset D3（有 manifest 就不再看修改时间）。

