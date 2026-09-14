# skills-hub

[![npm](https://img.shields.io/npm/v/@geoly-ai/skills-hub)](https://www.npmjs.com/package/@geoly-ai/skills-hub)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-blue)

`geoly-ai` 的 agent skill 分发中心。一条命令把单个 skill 或整套矩阵包装进
Claude Code、Codex 等客户端；外部作者也可以用它投稿，经审核后发布。

每一次安装都会验证签名快照与内容摘要，验证**不可关闭**；装到一半中断可以恢复，不会留下半装状态。

- **npm 包**：[`@geoly-ai/skills-hub`](https://www.npmjs.com/package/@geoly-ai/skills-hub)，命令名 `skills-hub`
- **可安装清单**：[`registry/catalog.md`](registry/catalog.md)（每次发布快照时自动生成）
- **registry 浏览站**：<https://skills-hub-pearl.vercel.app/>

> 给 agent 看的入口是 [`AGENTS.md`](AGENTS.md)；本文面向人类读者。

## 目录

- [快速开始](#快速开始)
- [环境要求](#环境要求)
- [支持的客户端](#支持的客户端)
- [常用命令](#常用命令)
- [项目级安装](#项目级安装)
- [投稿一个 skill](#投稿一个-skill)
- [埋点与隐私](#埋点与隐私)
- [已知限制](#已知限制)
- [开发](#开发)
- [文档导航](#文档导航)

## 快速开始

不需要先安装，`npx` 直接运行：

```sh
# 装一个 skill
npx @geoly-ai/skills-hub install skill:geoly-ai/skills-hub-install --clients claude

# 装一整套矩阵包（pack 的全部成员一次装完）
npx @geoly-ai/skills-hub install pack:prompts-map/prompt-map --clients claude

# 装全部可装的制品（非交互下必须显式确认）
npx @geoly-ai/skills-hub install --all --clients claude --yes-i-really-want-everything
```

- 目标客户端的 skill 目录还不存在时，加 `--create-missing claude`。
- 装过一次之后可以离线复装：`--offline`（资产按 sha256 缓存在 `~/.cache/geoly-skills`）。
- 需要常驻命令时全局安装：`npm i -g @geoly-ai/skills-hub`。

有哪些 skill 和 pack 可以装，见 [`registry/catalog.md`](registry/catalog.md)。
其中 Tier 2 的制品会执行 shell 或读写凭据，安装前请先读清单里的风险说明。

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | macOS、Linux、WSL |
| Node.js | ≥ 22.13（本地锁使用内建 `node:sqlite`） |
| 通过代理访问网络 | Node ≥ 24，并设置 `HTTPS_PROXY` 环境变量 |

⚠️ **Node 不读系统代理。** Clash、Surge 或公司 VPN 客户端通常只设置系统代理，
浏览器能打开 GitHub 不代表 CLI 能连上。需要显式导出环境变量，例如 macOS 上：

```sh
scutil --proxy | grep -iE "HTTPSProxy|HTTPSPort"   # 查看代理端口
export HTTPS_PROXY=http://127.0.0.1:<端口>
```

Node 22 在代理环境下无法联网；可以先在能直连的网络里装一次，之后用 `--offline`。

## 支持的客户端

| client | 全局 | 项目级 | 说明 |
|---|:--:|:--:|---|
| `claude` | ✅ | ✅ | |
| `codex` | ✅ | ✅ | |
| `agents` | ✅ | ✅ | 仅当 `.agents` 目录已存在时加入，不会自动创建 |
| `cursor` | ❌ | ❌ | 尚无运行时验证，静态分析预判其加载器会失败（[R-8](docs/m1/01-residual-risks.md)） |

`--clients` 不指定时，默认装到本机已存在的全部客户端。
同时装 `codex` 与 `agents` 时，同一个 skill 会在 Codex 的列表里出现两次（两个目录本身重叠），CLI 会告警但不阻止。

## 常用命令

| 命令 | 作用 |
|---|---|
| `install <spec>…` | 安装 skill 或 pack |
| `update [<spec>…] \| --all` | 重新解析已安装的制品，展示差异，确认后升级 |
| `remove <name>` | 移除自己直接安装的那一条引用；引用归零才删除目录 |
| `list [--installed\|--outdated\|--packs]` | 列出可装或已装的制品 |
| `search <关键词>…` | 按名称搜索 |
| `check` | 校验已安装内容：字节是否完整、当前是否仍可使用（未被下架） |
| `why <name>` | 查看某个 skill 是被谁请求安装的 |
| `recover` | 安装中途崩溃后恢复现场 |
| `sync-lock` | 重算项目级 `geoly-skills.lock.json` |
| `vendor <pack> --out <dir>` | 把 pack 及全部成员导出成普通目录树 |
| `publish [path]` | 投稿 skill 或 pack，见[投稿一个 skill](#投稿一个-skill) |
| `stats` | 本地埋点报表 |
| `telemetry <status\|flush\|on\|off\|delete>` | 埋点开关与数据删除 |

常用全局选项：`--clients`、`--project`、`--offline`、`--snapshot <N>`（钉住快照以便复现）、`--json`、`--yes`。
完整选项与退出码见 `skills-hub --help` 与 [`docs/m0/09-cli.md`](docs/m0/09-cli.md)。

**没有**跳过校验的开关：不存在 `--no-verify`、`--insecure`、`--force`。
替换同名目录必须用 `--replace <name>` 点名；安装已下架（yanked）或过期快照都需要各自的独立开关。

## 项目级安装

加 `--project` 会把 skill 装进仓库内（如 `<repo>/.claude/skills`），并维护 `geoly-skills.lock.json`。
安装状态目录 `.geoly/` 会随之落在仓库里，请把以下路径加入 `.gitignore`（CLI 安装时也会提示缺哪几条）：

```gitignore
/.claude/skills/.geoly/
/.codex/skills/.geoly/
/.cursor/skills/.geoly/
/.agents/skills/.geoly/
```

⚠️ `git clean -xfd` 会删除整个 `.geoly/`，包括本地审计历史，且**无法恢复**。

## 投稿一个 skill

```sh
skills-hub publish ./my-skill              # 投稿 skill
skills-hub publish ./my-pack --pack        # 投稿 pack
skills-hub publish ./my-skill --dry-run    # 只做检查，不创建 fork 与 PR
```

- 在本地运行与服务端 PR 门禁相同的校验器，通过后自动 fork 并开 PR，全程不调用 `git`。
- 使用你已有的 GitHub token（按 `GEOLY_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` 查找），CLI 不保存 token。
  执行写操作前会列出该 token 的权限范围并要求确认。
- 审核通过后，由维护者发布新快照，制品随之进入可安装清单。

投稿目录结构、`skill.json` 写法和被拒原因，见 [`docs/agents/02-publish.md`](docs/agents/02-publish.md) 与 [`docs/agents/03-gates.md`](docs/agents/03-gates.md)。

## 埋点与隐私

CLI **默认上报**匿名使用数据，用于判断哪些 skill 在被使用、安装失败集中在哪里。首次运行时会打印一次说明，说明一定先于第一次联网。

- **何时上报**：只在 `install` 成功后静默发送，24 小时最多一次，超时 1 秒，失败不影响安装结果与退出码。其他命令只写本地。
- **收集什么**：制品坐标、客户端、操作、结果、耗时、CLI / 系统 / Node 版本，以及一个本机随机 ID。
- **不收集**：路径、目录清单、文件内容、命令行原文、异常栈。
- **身份信息**（登录名、主机名、来源 IP）默认**不收集**，只有显式开启并看过单独的告知后才会收集。

| 想要 | 做法 |
|---|---|
| 完全关闭（本地也不写） | `GEOLY_TELEMETRY=0` |
| 只保留本地统计，不上报 | `GEOLY_TELEMETRY_UPLOAD=0` |
| 单次命令不联网 | `--offline` |
| 只关闭身份信息，保留匿名计数 | `skills-hub telemetry off` |
| 删除已上报的身份信息与本机数据 | `skills-hub telemetry delete` |
| 查看当前状态 | `skills-hub telemetry status` |

完整规格见 [`docs/telemetry/00-spec.md`](docs/telemetry/00-spec.md)。

## 已知限制

- `cursor` 客户端尚不支持（见[支持的客户端](#支持的客户端)）。
- `remove <name>` 只移除你直接安装的那条引用；只由 pack 带进来的成员无法单独删除，需要 `update pack:<name>` 让新版本退役它。
- 项目级 lockfile 目前只用于 `check` 比对和 `sync-lock` 重算，`install` 还不会严格按 lockfile 安装。
- `search` 只能按名称搜索，不能搜索描述。
- 通过代理联网需要 Node ≥ 24。

每个版本明确未做到的事项写在 [`CHANGELOG.md`](CHANGELOG.md) 的对应条目里；
已知并接受的残余风险见 [`docs/m1/01-residual-risks.md`](docs/m1/01-residual-risks.md) 与 [`docs/m2/01-residual-risks.md`](docs/m2/01-residual-risks.md)。

## 开发

```sh
node bin/skills-hub.mjs --help   # 从源码运行
npm test                         # 全量测试
npm run test:matrix              # 在 Node 22.13 与 24.19 上各跑一遍
npm run check:all                # 发布前检查：Node 矩阵、签名身份、打包内容
```

CI 在 Node 22.13 与 24.19 上运行全量测试，并对安装事务的每个故障注入点做穷举崩溃测试，二者都是合并门禁。
提交 PR 时请按 [`.github/pull_request_template.md`](.github/pull_request_template.md) 填写。

### 仓库结构

| 目录 | 内容 |
|---|---|
| `bin/`、`src/` | CLI 本体（随 npm 包发布） |
| `test/` | 测试，含故障注入框架 |
| `registry/`、`artifacts/` | 已发布的签名快照与制品 |
| `scripts/` | 投稿门禁、promote 与发布流水线 |
| `server/` | 埋点摄入服务（Vercel + Postgres） |
| `dashboard/` | 埋点数据后台（内部使用，共享口令登录） |
| `site/` | registry 浏览站 |
| `docs/` | 规格与交付文档 |

## 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/agents/01-install.md`](docs/agents/01-install.md) | 安装指南（面向 agent，人也可以读） |
| [`docs/agents/02-publish.md`](docs/agents/02-publish.md) | 投稿指南 |
| [`docs/m0/00-decisions.md`](docs/m0/00-decisions.md) | 设计决策与术语，规格从这里读起 |
| [`docs/m0/01-artifacts.md`](docs/m0/01-artifacts.md) … [`11-wire-contract.md`](docs/m0/11-wire-contract.md) | 规格正文：制品、registry、安装事务、威胁模型、CLI 与 JSON 契约 |
| [`docs/m0/ERRATA.md`](docs/m0/ERRATA.md) | 规格勘误（与正文冲突时以勘误为准） |
| [`docs/m3/01-delivery.md`](docs/m3/01-delivery.md) | 投稿与审核流水线的交付说明 |
| [`docs/telemetry/00-spec.md`](docs/telemetry/00-spec.md) | 埋点规格 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更 |

`docs/m0/CHANGES-v*.md` 是规格评审过程的变更台账，不是现行规格。

## 许可证

见 [`LICENSE`](LICENSE)。
