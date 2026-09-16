# CHANGELOG · 类型包 presales-reddit（Reddit 售前方案）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.0.0 — 2026-09-15

- 1e 落位 types/presales-reddit/：沿用 presales-shared 骨架与业务规则，补类型包接口声明与样张 samples/smokereddit/（改编自 presales-orchestrator 冒烟测试）；templates/figures/engine-flow.mmd。
- 1d：qa_rules.py 与 qa-rules.md 落位（与 presales-site 两份 qa_rules.py 除 PACK_ID 外逐字一致）；迁移期覆盖配置（engine_rules 只开 L1、L2、L4、C1、R1；meta_file brief.json；include_deny *internal*；banned_terms 置空），golden 四个目录 must_fix 与 issues 逐项一致。

### 变更
- W3-I（2026-09-15，类型包文件未改）：售前包装层 presales_migrate.py 改把报价有效期写 brief cover.badge、称谓写 cover.party_label「客户」（brief.schema 契约补丁），封面回到旧版视觉；presales-shared/packs/{site,reddit}/terms.md 首行标题改二级（原被 S2 按段落输出，现为章节标题，后续章号 +1）；公司介绍「Cyberklick 是」补空格。golden -v2 已重建。

### 待 1f
- D2 门接入套餐与 RFP 退出码；hooks.pre_publish 回填模型哈希校验命令；迁移期覆盖配置逐项打开新规则并跑 golden。
