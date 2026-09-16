# CHANGELOG · doc-publish

版本号语义见 doc-shared/references/pack-interface.md §6。scripts/publish.py ENGINE 版本常量为 1.1（写进 published.json engine.version），按 1.1.0 理解；本文件建立前 1.0 → 1.1 的差异未单独记录，统一并入本条。

## 1.1.0 — 2026-09-15

发布引擎（W3-D2），自测 112 项全过（主代理复跑）；golden smoke-site dry-run 全流程退出 0，真实 lark-cli 只收到读命令。

### 能力
- 默认 dry-run；--apply 必须带 --evidence（用户原话）。
- 预检：门状态、qa-result 与 render.json 过 schema 且 source_sha256 等于现算正文哈希、质检渲染后源文件未改、PDF 文件名、飞书排版守卫。
- 类型包钩子 pre_publish（必须 ok=true，执行后重做预检）与 post_publish，extra 合并进 published.json。
- 归档 out/published/v<版本>/（先写暂存目录，成功后换入）；每个文件记 sha256。
- 飞书文件夹「客户或项目 → 子项目」解析与新建（写命令串行、间隔 ≥ 1 秒），create 或 overwrite，回查画板、图片、代码块与格式残留。
- 退出码 0–7 与 10（lark-cli 高风险确认原样透传）。
- 售前迁移接口（1f 改调 publish.py --pack doc-shared/types/presales-<site|reddit>）。

### 未验证 / 待处理
- 真实 create、overwrite、create-folder 与回查，退出码 10 真实触发。
- preflight 两秒容差待与 W3-D3 验收结论一并处理。

### 变更
- W3-H（2026-09-15）：publish.py 与 export_cases_sheet.py 的 lark-cli 调用改为 import doc-shared/scripts/lark_io.py（写命令判定统一为「不在读命令白名单即为写」，exit 10 确认门两边同一口径并都带 uncertain_write=false；argv 序列与重构前逐条一致，唯一差异是导出工具建文件夹失败时与 publish 一样只读重列父目录给 located_folders）；export_cases_sheet --apply 增加前置检查（D3 passed 且 run_state.py check-manifest 一致，否则退出 1；dry-run 只写 warnings 与 gate）。
