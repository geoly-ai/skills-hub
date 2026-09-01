# skills-hub

> npm 包名：**`@geoly-ai/skills-hub`**，bin `skills-hub`。
> （M0 正文写的是 `@geoly/skills-hub`，那是拍板时没核实 org —— 见 [`docs/m0/ERRATA.md`](docs/m0/ERRATA.md) E-7）

`geoly-ai` 的 skill 分发中心：一条命令装单个 skill、装矩阵包，
并支持外部投稿与过审。

## 安装

```sh
npm i -g @geoly-ai/skills-hub     # 或 npx @geoly-ai/skills-hub <命令>
skills-hub --help
```

**已发布**：[`@geoly-ai/skills-hub@0.1.0`](https://www.npmjs.com/package/@geoly-ai/skills-hub)
（46 个文件，带 npm provenance；发布 workflow 会用**本包自带的验签器 + 内置信任根**
自验一遍它自己签的 tarball）。

平台：**macOS / Linux / WSL**，**Node ≥ 22.13**。

### 当前能装到哪几端

| client | 全局 | 项目级 | 说明 |
|---|:--:|:--:|---|
| `claude` | ✅ | ✅ | |
| `codex` | ✅ | ✅ | |
| `agents` | ✅ | ✅ | **present-only**：`.agents` 已存在才加入，**不会被创建** |
| `cursor` | ❌ | ❌ | 无运行时证据，且静态读其加载器**预判会失败**（R-8） |

⚠️ `codex` 与 `agents` 同时装时，同一个 skill 会在 codex 的 catalog 里出现两次 ——
这两个位置本身重叠，CLI 会告警但不拦截。

## 现在在哪一步

| 阶段 | 状态 |
|---|---|
| **M0 · 制品与信任模型** | ✅ 已通过（v45，2026-08-25） |
| **M1 · 只读分发** | ✅ **已完成并发布 0.1.0** —— resolve / install / recover / check / list-search-why / sync-lock |
| **M2 · pack 与受控 catalog** | 🚧 进行中 —— 命令面已齐（`vendor` / `install pack:` / `install --all`）；promotion 的**派生**那一半已就绪（`scripts/build-snapshot.mjs`），元数据来源待 M3 |
| M3 · 投稿与审核 | — |
| M4 · update / remove | — |

**930 个测试**在 Node 22.13.0 / 24.19.0 双版本全绿；穷举崩溃注入（真内核 51 个注入点
逐个反向命中）是 CI 的合并门。

### 🔴 0.1.0 明确**没有**做到的

不写清楚就等于默认承诺了，所以逐条列出：

- **制品（skill tar.gz）与快照的签发链不存在** —— packer 是 M2。
  这一版签的是 **npm 包本身**（provenance + cosign 对 `.tgz` 的签名），不是 skill 制品。
  ⚠️ M2 进行中：`scripts/build-snapshot.mjs` 已能从 `artifacts/**` 确定性地**构建**
  快照与资产（打包、摘要、pack 的 clients 交集 / capabilities 并集、`degraded` 重算、
  `latest` 投影），但**它不签名** —— 签名仍是 release workflow 的事，尚未接上。
  且 record 必填的 `owner` / `review`（以及 pack 的 `provenance`，`pack.json` 里没有
  这个字段）目前由显式的 `--inputs` 提供，M3 的投稿流水线接上后才自动产出。
- **registry 是纯缓存，没有网络客户端** —— `resolveCurrent()` 是同步的，接不进 `fetch`。
- **`--from-generation` 只做到编译计划**，接成正向事务的入口还没写。
- **`--release-frozen` 如实拒绝**（没有按 label 解冻 attic 的导出），不提供假装成功的路径。
- `cursor` 未验证；`search` 搜不了 description（快照 record 里没有这个字段）。

已知且**明确接受**的残余风险见 [`docs/m1/01-residual-risks.md`](docs/m1/01-residual-risks.md)（R-1 … R-11）
与 [`docs/m2/01-residual-risks.md`](docs/m2/01-residual-risks.md)（R-12 … R-16），
M0 正文的勘误见 [`docs/m0/ERRATA.md`](docs/m0/ERRATA.md)（E-1 … E-8）。

M2 交出了什么、**明确没做到什么**、以及三条待拍板项，见
[`docs/m2/00-delivery.md`](docs/m2/00-delivery.md)。

## 从哪读起

- **[`docs/m0/00-decisions.md`](docs/m0/00-decisions.md)** —— 决策台账、术语、
  以及 🔴 **M1 开工前的两道硬门**（§6）
- [`docs/m0/01-artifacts.md`](docs/m0/01-artifacts.md) 起是规范正文，共 12 份
- `docs/m0/CHANGES-v*.md` 是 v2 → v45 的逐轮变更台账
  （**变更台账不是现行规范**，以正文为准 —— 见
  [`11-wire-contract.md`](docs/m0/11-wire-contract.md)）

## 已经能跑的

```sh
node bin/skills-hub.mjs --help
node bin/skills-hub.mjs stats            # 本地埋点文本报表
node bin/skills-hub.mjs telemetry status # 埋点/上报开关
npm test                                 # 60 个测试
npm run test:matrix                      # 在 Node 22.13 / 24.19 上各跑一遍
```

基础模块：`canonical-json`、`atomic-fs`、`safe-fs`、`tree-digest`/`tx-digest`、
`lock`（`node:sqlite` 的 `BEGIN EXCLUSIVE`，内核释放）、故障注入框架、
信任与制品链（Sigstore 验签 + 受限 tar 解包）、adapter 与 target 预检。

- 两道 M1 前置 gate 的实测记录：[`docs/m1/00-gates.md`](docs/m1/00-gates.md)
- 🔴 **已知且接受的残余风险**：[`docs/m1/01-residual-risks.md`](docs/m1/01-residual-risks.md)
- M0 勘误（正文已封版，冲突以勘误为准）：[`docs/m0/ERRATA.md`](docs/m0/ERRATA.md)

**当前可安装的组合**：`claude` / `codex` / `agents` × 全局 / 项目级。

- `agents` 是 **present-only**：只在 `.agents` 已存在时加入，**不会被创建**
  （它是共享约定路径，读者是 codex，不是独立客户端）
- ⚠️ `codex` 与 `agents` 同时装时，同一个 skill 会在 codex 的 catalog 里出现两次 ——
  CLI 会告警但不拦截
- `cursor` 未启用：本机无运行时证据，且静态读它的加载器**预判会失败**，见 R-8

## 项目级安装：先改 `.gitignore`

装到项目级（`<repo>/.claude/skills` 等）时，状态目录 `.geoly/` 会落在仓库里。
把下面几条加进 `.gitignore` —— 🔴 注意是 **adapter 派生的实际路径**，
不是根上的 `/.geoly/`：

```gitignore
/.claude/skills/.geoly/
/.codex/skills/.geoly/
/.cursor/skills/.geoly/
/.agents/skills/.geoly/
```

（`skills-hub` 会在项目级安装时提示缺哪几条；`gitignorePatternsFor()` 按启用的
client 生成，`test/adapters.test.mjs` 用真 git 仓库验证过它确实忽略状态目录、
且**不误伤 skill 本体**。）

### ⚠️ `git clean -xfd` 会删掉整个 `.geoly/`

不只是「进行中的事务状态」，**还包括本地审计历史**（live `audit` 与 `audit-archive/`）。
清掉之后 `event_id` 序列会从头开始。这是规范承认的「放弃本地 audit」边界，
但它**不可恢复** —— 清之前想清楚。

## 埋点与面板

规格：[`docs/telemetry/00-spec.md`](docs/telemetry/00-spec.md)（v6，已过六轮 Codex 评审）。
端点实现见 [`server/`](server/)。

🔴 **上报默认开**（2026-09-01 起，规格 §4.2）—— CLI 有内置默认端点。
首次运行会打印一次告知（收什么、发到哪、怎么关），**这段告知一定先于第一次出网**。
🔴 **一次 `install` 成功收尾后会静默上报一次**（规格 §5.1.1，2026-09-01 起）：
24 小时最多一次，网络那一段超时 1 秒，发不出去就留在本地等下次，不影响安装结果、
也不改退出码。`install` 失败（含部分失败）不发；`check` / `list` / `stats` 等命令
只写本地，不出网。也可以随时 `skills-hub telemetry flush` 手动发。

事件只含制品坐标、客户端、操作、结果、耗时、CLI/OS/Node 版本和一个本机随机 ID，
**不含路径、目录清单、文件内容、用户名、命令行原文、异常栈**；
这条契约由 `assertValidEvent()` 在落盘/读回/上报/导出四个边界执行，
**端点侧跑的是同一个校验器**（不另写一份，两份必然分叉）。

- 关掉：`GEOLY_TELEMETRY=0`　只留本地：`GEOLY_TELEMETRY_UPLOAD=0`　断网：`--offline`
  （⚠️ `GEOLY_TELEMETRY_ENDPOINT=` 空值是**配置错误**，不是关闭开关）
- 面板：[`docs/dashboard/`](docs/dashboard/)（零依赖静态页，
  `skills-hub stats --export` 出的 JSON 拖进去即可）

## M0 定了什么

不可变制品布局与树摘要、签名快照 + timestamp 防回放、pack lock 与 yank 闭包、
崩溃安全的安装事务（幂等前向恢复 / retirement rename / repair intent）、
投稿与三阶段发布、威胁模型、CLI 命令面与退出码、JSON wire contract。

平台：**macOS / Linux / WSL**，**Node ≥ 22.13**（锁用内建 `node:sqlite`）。
