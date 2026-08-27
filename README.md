# skills-hub

`geoly-ai` 的 skill 分发中心：一条命令装单个 skill、装矩阵包，
并支持外部投稿与过审。

> ⚠️ **M0 规格已封版，M1 实现刚起步** —— 目前只有基础模块和埋点子系统，
> 装 skill 的主流程还没接通。

## 现在在哪一步

| 阶段 | 状态 |
|---|---|
| **M0 · 制品与信任模型** | ✅ **已通过**（v45，2026-08-25） |
| M1 · 只读分发（单 skill 的 resolve / install / list / check） | 🚧 进行中 —— 信任链与 adapter 已就绪，事务内核在做 |
| M2 · pack 与受控 catalog | — |
| M3 · 投稿与审核 | — |
| M4 · update / remove / 正式发包 | — |

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

**当前可安装的组合**：`claude` / `codex` × 全局 / 项目级。
`cursor` 与 `agents` 未启用，理由见 gates 文档与残余风险单 R-8。

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

规格：[`docs/telemetry/00-spec.md`](docs/telemetry/00-spec.md)（v2，已过 Codex 评审）。

🔴 **默认不向任何地方发数据** —— 没有内置端点，不配 `GEOLY_TELEMETRY_ENDPOINT`
就是纯本地。事件只含制品坐标、客户端、操作、结果、耗时，**不含路径、目录清单、
文件内容、用户名**；这条契约由 `assertValidEvent()` 在落盘/读回/上报/导出四个边界执行。

- 关掉：`GEOLY_TELEMETRY=0`　只留本地：`GEOLY_TELEMETRY_UPLOAD=0`　断网：`--offline`
- 面板：[`docs/dashboard/`](docs/dashboard/)（零依赖静态页，
  `skills-hub stats --export` 出的 JSON 拖进去即可）

## M0 定了什么

不可变制品布局与树摘要、签名快照 + timestamp 防回放、pack lock 与 yank 闭包、
崩溃安全的安装事务（幂等前向恢复 / retirement rename / repair intent）、
投稿与三阶段发布、威胁模型、CLI 命令面与退出码、JSON wire contract。

平台：**macOS / Linux / WSL**，**Node ≥ 22.13**（锁用内建 `node:sqlite`）。
