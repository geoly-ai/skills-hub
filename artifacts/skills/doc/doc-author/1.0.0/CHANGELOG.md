# CHANGELOG · doc-author

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

首版写作引擎（W3-D3）。prd、test-cases 全流程到「等用户确认发布」、qa 必改 0。

### 能力
- outline.py：从 pack.json skeleton（按元数据 mode 打补丁）动态生成 doc.md 骨架与 outline.md（D1 拍板稿），锚点 {#sec:<id>} 与标题同行；--add-section 按骨架顺序插入按需章节。
- fill_check.py：缺必备章、空章、占位符阻塞；must_answer 覆盖与写作提示残留提示。
- lint_draft.py：在临时副本上跑 doc-qa --only 写作期子集，只看本章问题。
- 写法规则：must_answer 逐条回答、数据块优先、图先写源再引用、摘要用 summary 块、编号实体与交叉引用、高亮与禁用词限额、T1–T12。

### 已知缺口
- 其余 5 类只做了 fill_check，未跑全流程。
- SKILL.md 写「类型包将来给 skeleton 项标 engine_generated 时跳过该项」；契约已定不加 engine_generated（W3-F：删除条目），该分支不会被触发。

### 变更
- W3-H（2026-09-15）：authorlib 的 masked_lines / comment_mask / code_mask 上移 doc-shared/scripts/code_scan.py，这里 re-export；skeleton_for 可传 run_dir，mode 取值与 doc-qa 同一实现（validate.resolve_mode）。
