# CHANGELOG · doc-orchestrator

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.1 — 2026-09-16

路径可移植：文档不再硬编码 `~/.claude/skills`，统一 `<doc-X>` 兄弟目录约定。

## 1.0.0 — 2026-09-15

首版编排入口（W3-D3）。

### 能力
- detect_type.py：用户原话 → 类型包（references/type-triggers.json + 类型包 name，最长匹配计分；判不准给字母选项；售前转 presales-orchestrator、轻量文档转 lark-doc）。
- new_run.py：校验 brief、在同级临时目录完成 run-state init、导入或复制上一版、生成骨架，全部成功才落位；改版 --from 以上一版 doc.json 为基线。
- advance.py：每次从头判定下一步，自动执行 D0、D2、doc-figures、doc-render、doc-qa、doc-publish dry-run；D1、D3、D4 与 --apply 留给用户与主代理。
- status.py、xref_check.py（改版后的上游悬空与下游 stale 复查）。
- Codex 找茬与证伪两轮流程。

### 进行中 / 已知缺口
- 主代理 Codex 验收不予验收（伪造发布完成态、D3 两秒容差、D2 不带 --run 可签、xref 自定义 pack 静默跳过等 12 项），已发回 W3-D3 返修（扩边界 run_state.py、related.py）。
- 真实 publish --apply、真实 Codex 两轮 D3 未验证。
- SKILL.md §8 所列契约缺口中，brief.schema.json、pack.schema triggers、七个内部样张 related_docs role 已由 W3-E 在 doc-shared 补上；本 skill 尚未接入（new_run.py 未调 validate_brief、detect_type.py 未读 pack triggers），tests/run_tests.py「样张原始 related_docs 缺 role → 退出 3」断言需改为「样张原样可建目录 + 删 role 的副本退出 3」（W3-E 不改本 skill 代码）。

### 变更
- W3-H（2026-09-15）：xref_check.py 编号扫描改用 doc-shared/scripts/code_scan.py（与 trace_matrix、fill_check 同一遮蔽与边界口径，新增简写续号展开）；related_docs.role 必填后删除「未写 role 只查本包不定义实体」分支。
