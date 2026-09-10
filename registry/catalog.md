# 可安装清单 —— agent 直接读这一份

> 🔴 **本文件由 `scripts/promote/build-catalog.mjs` 从快照生成，不要手改。**
> 手改会被 `test/agents-catalog.test.mjs` 逐字节比对挡下来。
> 权威源是 `registry/snapshots/hub-<N>.json`（已签名对象里的那份清单），
> 这里只是把它渲染成人和 agent 都能直接读的形状。

快照 **5** · 生成于 `2026-09-05T04:59:27Z` · 仓库 `geoly-ai/skills-hub`

## 怎么装

```sh
# 装一个 skill（不用先装 CLI）
npx @geoly-ai/skills-hub install skill:<ns>/<name> --clients claude
# 装一整套 pack（成员一次装完）
npx @geoly-ai/skills-hub install pack:<ns>/<name> --clients claude
```

**版本可以省略** —— 省略即取快照的 `latest`（非 yank、非 prerelease、非 degraded）。
写版本就要写全：`@0.7.0`，没有 `@latest` 这个写法。
首次装到某个 client 时目录可能不存在，加 `--create-missing <client>`。
细节见 [`docs/agents/01-install.md`](../docs/agents/01-install.md)，投稿见 [`docs/agents/02-publish.md`](../docs/agents/02-publish.md)。

⚠️ **Tier 2 的制品能执行 shell、读凭据或写仓库。** 装之前先看它的 `SKILL.md`；
agent 不要在没有用户明确同意的情况下装 Tier 2。

## Pack（2）

| id | latest | tier | clients | 说明 |
|---|---|---|---|---|
| `pack:plaud-theme/plaud-theme-matrix@0.4.0` | ✓ | 2 | agents claude codex cursor | PLAUD Shopify 主题矩阵全套 10 个 skill（order 0–9）。它们共用 plaud-theme-shared 的契约层（两轴状态机、handoff schema、SyncReach），必须并排安装… |
| `pack:prompts-map/prompt-map@0.7.0` | ✓ | 2 | agents claude codex cursor | product-card Prompt Map 全套 9 个 skill。它们靠 ../prompt-map-shared/ 的兄弟路径互相引用，必须并排安装 —— 单独装其中一个会得到引用不到 shared 的坏 sk… |

## Skill（33）

| id | latest | tier | clients | 说明 |
|---|---|---|---|---|
| `skill:geoly-ai/skills-hub-install@0.2.0` | ✓ | 2 | claude cursor codex agents | 用 skills-hub CLI 装 skill / pack —— 命令、装到哪一端、复现与离线、装崩了怎么恢复、以及为什么没有 --force。当用户要装 geoly 的 skill、说「装一下 xxx skill」… |
| `skill:geoly-ai/skills-hub-publish@0.2.0` |  | 2 | claude cursor codex agents | 把 skill 投稿进 geoly skills-hub —— 投稿目录长什么样、skill.json 怎么写、capability 怎么定、要过哪几道门、被拒了怎么改。当用户要发布/投稿一个 skill 到 hub、或… |
| `skill:geoly-ai/skills-hub-publish@0.3.0` | ✓ | 2 | claude cursor codex agents | 把 skill 或 pack（矩阵包）投稿进 geoly skills-hub —— 投稿目录长什么样、skill.json / pack.json 怎么写、PROMOTION.json 什么时候要、capability… |
| `skill:plaud-theme/plaud-theme-dev@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-dev@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题 Path A 通用开发（Implement 阶段，order 3）：bug 修复、性能优化、 新功能、UX 微调。用户说改 Plaud 主题 bug、修 Swiper、 swiper c… |
| `skill:plaud-theme/plaud-theme-feedback-triage@0.3.6` |  | 1 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-feedback-triage@0.4.0` | ✓ | 1 | claude cursor codex agents | PLAUD Shopify 主题矩阵的反馈归因入口（order 8）：把运营/PM/QA/线上来的反馈逐条判成 「交付缺陷」还是「需求演进」，并给出依据与去向。按《DTC 开发交付标准 v1.0》§六、§七执行。 用户说… |
| `skill:plaud-theme/plaud-theme-impact@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-impact@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的 Assess 阶段（order 2）：改动影响面侦察。 用户问"改这个会影响什么""影响范围多大""blast radius""波及哪些模板/页面""依赖树""上下游调用方" "这… |
| `skill:plaud-theme/plaud-theme-orchestrator@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-orchestrator@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的全流程编排入口（order 1）。 **进入门槛只有一条：这项工作必须拆成 ≥2 个可独立验收的 ChangeSet。** 典型是迁移 wave（一次刷多个模板/模块）、跨多个互不相… |
| `skill:plaud-theme/plaud-theme-qa-intake@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-qa-intake@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的提测准入关口（order 6），夹在 Implement 与 Verify 之间： 按《DTC 开发交付标准 v1.0》§四 组装并校验提测包，材料不齐 QA 不启动。 用户说提测、… |
| `skill:plaud-theme/plaud-theme-qa@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-qa@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的 Verify 阶段（order 7）——矩阵唯一有权宣布可交付的 skill。 触发前提二选一，缺一不得路由到本 skill：已存在 ChangeSetId / HandoffCo… |
| `skill:plaud-theme/plaud-theme-release-ops@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-release-ops@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的发版与上线后治理（order 9），在 Verify 之后： 按《DTC 开发交付标准 v1.0》§五 做发版前的推送站点二次确认、PR 汇总、上线后跟踪与回归用例入库。 用户说要发… |
| `skill:plaud-theme/plaud-theme-section-build@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-section-build@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD 主题矩阵 Path B 的 Implement 阶段（order 4）：把 Figma 设计稿按 vendor 规范实现成 sa- 前缀 section。 触发："按设计稿做模块""按稿搭模块""设计还原/切… |
| `skill:plaud-theme/plaud-theme-shared@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-shared@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的契约层（order 0）：两轴状态机、handoff schema、ChangeSetId 绑定、 交付权归属、Stop-don't-guess 停机规则、全路径红线、视觉与 UX … |
| `skill:plaud-theme/plaud-theme-ux-migration@0.3.6` |  | 2 | claude cursor codex agents | > |
| `skill:plaud-theme/plaud-theme-ux-migration@0.4.0` | ✓ | 2 | claude cursor codex agents | PLAUD Shopify 主题矩阵的 Path C 实现阶段（order 5）：UX Spec v1.3 迁移。 用户说"按 UX Spec v1.3 对齐""刷模块""spec 迁移""对齐 ux""对齐规范""这个… |
| `skill:plaud-theme/yidian-draft-pr@0.3.6` | ✓ | 2 | claude cursor codex agents | Enforce the yidian pull request workflow for GitHub repos. Use when a user asks to create, inspect, or prepare… |
| `skill:prompts-map/prompt-map-coverage-audit@0.7.0` | ✓ | 2 | claude cursor codex agents | Audit whether a product-card Prompt Map covers every approved demand cell, Topic, decision angle, and accepted… |
| `skill:prompts-map/prompt-map-delivery@0.7.0` | ✓ | 2 | claude cursor codex agents | Deliver an approved cold-start or revision product-card Prompt Map as CSV and Excel using the reusable seven-c… |
| `skill:prompts-map/prompt-map-demand-extractor@0.7.0` | ✓ | 2 | claude cursor codex agents | Extract a traceable category demand universe and the standardized evidence index from normalized Reddit VOC, S… |
| `skill:prompts-map/prompt-map-demand-grid@0.7.0` | ✓ | 1 | claude cursor codex agents | Build the initial coverage baseline inside a living demand coverage registry for a cold-start or revision Prom… |
| `skill:prompts-map/prompt-map-generator@0.7.0` | ✓ | 2 | claude cursor codex agents | Generate a first-version-compatible natural Prompt Map through two independent streams — a Closure Stream that… |
| `skill:prompts-map/prompt-map-input-normalizer@0.7.0` | ✓ | 2 | claude cursor codex agents | Validate, inventory, and normalize Reddit, Semrush, GEOly, and optional brand inputs for one physical-product … |
| `skill:prompts-map/prompt-map-orchestrator@0.7.0` | ✓ | 2 | claude cursor codex agents | Orchestrate a first-version-compatible physical-product Prompt Map workflow through convergence-profile freezi… |
| `skill:prompts-map/prompt-map-semantic-dedupe@0.7.0` | ✓ | 1 | claude cursor codex agents | Remove exact and semantic duplicate product-card prompts while preserving distinct people, scenes, pains, resu… |
| `skill:prompts-map/prompt-map-shared@0.7.0` | ✓ | 2 | claude cursor codex agents | Shared contracts, schemas, evidence policy, product-card rules, and handoff requirements for the modular produ… |

