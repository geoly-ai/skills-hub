# CHANGELOG · 类型包 presales-site（建站售前方案）

版本号语义见 doc-shared/references/pack-interface.md §6。

## 1.1.0 — 2026-09-15

v1.5 吸收（《Shopify 建站方案 SKILL v1.5.0》，W3-C，返修 7 项验收关闭），新增能力、向后兼容：不写 site.project_type 的旧 brief 按 rebuild（site.migration 为真按 migration）。

### 新增
- modes（pack-interface.md §2.1）：field site.project_type，默认 rebuild（别名 同店重构、重构），另有 greenfield（0-1、0-1 新建站、新建站、新建）与 migration（跨平台迁移、迁移）；各 mode 对基础骨架打补丁、插入章节。
- greenfield 禁词 `(?<!\d)301(?!\d)`（0-1 项目不写 301 跳转）。
- 组织级 QMS 章 brand/org/sections/qms.md 作为必备章节（骨架最后一章，㉔A）；W3-E 登记为 org_sections（required true）。
- migration 插入章 data-migration：迁移范围含评价（Review）迁 / 不迁 / 部分迁移及原因，评价迁移单列 W33。
- 内容库 content/：reindex-answer.md、seo-foundation-greenfield.md、geo-seven-points.md、cro-six-steps.md、validation-metrics.md；模板 templates/modes/greenfield.md；竞品能力矩阵首列维度、第二列我方现状。

### 变更
- W3-I（2026-09-15，类型包文件未改）：售前包装层 presales_migrate.py 改把报价有效期写 brief cover.badge、称谓写 cover.party_label「客户」（brief.schema 契约补丁），封面回到旧版视觉；presales-shared/packs/{site,reddit}/terms.md 首行标题改二级（原被 S2 按段落输出，现为章节标题，后续章号 +1）；公司介绍「Cyberklick 是」补空格。golden -v2 已重建。

### 已知缺口 / 未验证
- engine_rules 目前不含 S1；按 mode 的 S1、0-1 禁写 301 与有效期封面、商务条款两处一致的质检接入归 W3-A（打开 S1 前先核 golden）。
- 真实 0-1 / 迁移项目端到端未验证；smoke-site golden 新基线（页数 7 → 8）由 1f 登记。

## 1.0.0 — 2026-09-15

- 1e 落位 types/presales-site/：沿用 presales-shared 骨架与业务规则，补类型包接口声明与样张 samples/smokesite/（改编自 presales-orchestrator 冒烟测试）。
- 1d：qa_rules.py 与 qa-rules.md 落位（与 presales-reddit 两份 qa_rules.py 除 PACK_ID 外逐字一致）；迁移期覆盖配置（engine_rules 只开 L1、L2、L4、C1、R1；meta_file brief.json；include_deny *internal*；banned_terms 置空，原词表存档 wave2/presales-pack-pre-overlay/），golden 四个目录 must_fix 与 issues 逐项一致。
