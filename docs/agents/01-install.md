# 装 skill —— agent 操作手册

> 权威定义在 [`docs/m0/09-cli.md`](../m0/09-cli.md)。这份文档只讲**怎么用**，
> 以及**出错了怎么读那条错误**。

---

## 最短路径

不用先装 CLI：

```sh
npx @geoly-ai/skills-hub install skill:<ns>/<name> --clients claude
```

要常驻就 `npm i -g @geoly-ai/skills-hub`，之后直接 `skills-hub …`。

制品 id 的形状是固定的三段式：

```
skill:prompts-map/prompt-map-generator@0.7.0
pack:plaud-theme/plaud-theme-matrix@0.3.6
└┬──┘ └────┬────┘ └────────┬────────┘ └─┬─┘
 kind   namespace        name         semver
```

**版本可以省略** —— 省略即取快照的 `latest`（非 yank、非 prerelease、非 degraded）。
写版本就必须写全：`@0.7.0`，**不能**是 `@0.7`，也**没有** `@latest` 这个写法
（"最新"是快照的 `latest` 字段，不是一个可以写进命令的版本号）。

🔴 **不确定就别写版本。** 钉死一个版本意味着：那个版本日后被 yank 了，
你的命令仍然指着它 —— 而 `install` 会**拒绝**装 yanked（退出码 3），
于是一条昨天还好好的命令今天开始失败。省略版本则自动落到当前可装的那一个。
⚠️ 反过来，需要**可复现**（CI、lockfile、事故复盘）时必须写全版本 ——
那正是「不可变制品」存在的理由。两种需求，两种写法，别混。

📌 这一条 2026-09-03 更正过：本文原先写的是「版本必须写全」，
   而 grammar 一直是 `[@<version>]`（`resolve.mjs:26`），省略是合法的。

---

## 常用命令

| 命令 | 干什么 |
|---|---|
| `install <spec>…` | 装一个或多个 |
| `install --all` | 装快照里的全部（非交互下还要 `--yes-i-really-want-everything`） |
| `update [<spec>…]` / `--all` | 重解析账本里的 root：**展示 diff、要求确认**（非交互下要 `--yes`），确认后在一个事务里应用。不给 spec = 全部 root |
| `remove <name>` | **减引用；引用归零才删目录**。真会删目录时要确认（非交互下要 `--yes`） |
| `list --installed` / `--outdated` / `--packs` | 看装了什么 |
| `search <kw>` | 搜 |
| `check` | 两阶段校验：**字节对不对** + **现在还该不该用** |
| `why <name>` | 这东西是谁请求装的（pack 带进来的还是直接装的） |
| `sync-lock` | 重算 `geoly-skills.lock.json` |
| `recover` | 装到一半崩了之后收拾现场 |
| `vendor <pack> --out <dir>` | 把 pack 与成员物化成一棵目录树，**不走安装账本** |

🔴 **`remove <name>` 减掉的是「你自己那一条 direct 引用」**，不是「把这个目录删掉」。
一个 skill 可以同时被你直接装过、又被某个 pack 带进来（`why <name>` 就是看这个）：
那时 `remove` 只摘掉 direct 那条边，**目录照旧留着**，并如实告诉你还有谁在要它。
只被 pack / `all@snapshot` 请求的成员**删不掉** —— 它的引用永远不归零。
想去掉它请走 `update pack:<name>`（新版本不再含它就会被退役）。

🔴 **`update` 不接受 `--snapshot`**：钉快照能决定「解析到哪个版本」，
但回答不了「现在还该不该用」。要复现某一版用 `install <name>@<version>`。

---

## 先决条件

- **Node ≥ 22.13**（macOS / Linux / WSL）。
- ⚠️ **在企业代理后面需要 Node ≥ 24**：Node 的内建 fetch 直到 24 才认
  `HTTPS_PROXY` / `NO_PROXY`（CLI 会自动启用）。22.x 在代理后面会以
  `UND_ERR_CONNECT_TIMEOUT` 失败 —— 那不是 registry 挂了。
  变通：先在能直连的网络里跑一次把缓存热起来，之后 `--offline` 可用。
- 首次装到某个 client 时它的目录可能还不存在，加 `--create-missing <client>`；
  不加会以「客户端目录不存在」失败。

## 装到哪

```sh
skills-hub install <spec>                    # 全局，装到本机已存在的所有 client
skills-hub install <spec> --clients claude   # 只装 claude
skills-hub install <spec> --project          # 装进当前仓库，维护 lock 文件
```

| client | 全局 | 项目级 | 备注 |
|---|:--:|:--:|---|
| `claude` | ✅ | ✅ | |
| `codex` | ✅ | ✅ | |
| `agents` | ✅ | ✅ | **present-only**：`.agents` 已存在才加入，**不会被创建** |
| `cursor` | ❌ | ❌ | 无运行时证据，静态读其加载器**预判会失败**（R-8） |

⚠️ `--clients` 里写了**本机没装的 client 是硬错误**，不是警告。
这是有意的：静默跳过会让你以为装上了。

---

## 🔴 读错误信息，不要绕过

**CLI 没有 `--no-verify` / `--insecure` / `--force` / `--force-unlock`。**
验签与摘要校验不可关闭。装不上时，答案在错误信息里，不在 flag 里。

几个**有**开关的场合，每个都窄且独立：

| 情况 | 开关 | 代价 |
|---|---|---|
| timestamp 过期 | `--allow-stale` | 后续输出**持续标注 stale** |
| 制品已被 yank | `--allow-yanked` | 大声告警 + 写进账本；**不放行 degraded** |
| 全局已有同名 | `--shadow-global` | 仅项目级安装可用 |
| 要替换未被账本认领的同名目录 | `--replace <name>` | **必须点名**，没有"全部替换" |

📌 注意它们是**分开的**：没有一个万能开关。这是为了让你每次只放行你真正
理解的那一件事。

---

## 复现与离线

```sh
skills-hub install <spec> --snapshot 42     # 钉快照，复现当时的解析结果
skills-hub install <spec> --offline         # 只用缓存；未命中即失败，禁止一切网络出口
```

`--offline` 是**硬的**：不是"尽量不联网"，是一个字节都不出去。

---

## 装崩了

```sh
skills-hub recover                 # 看现场
skills-hub recover --continue      # 接着装完
skills-hub recover --rollback      # 退回去
skills-hub recover --reinstall
```

安装是**分代**的（generation），旧代进 attic，默认保留 3 代
（`--keep-generations N` 可调）。所以"装坏了"几乎总能退回去。

---

## 埋点

🔴 **默认开**。`install` 成功收尾后静默发一次：24 小时最多一次、超时 1 秒、
**失败不影响安装**。别的命令只写本地。

```sh
skills-hub telemetry status        # 看开关与队列
skills-hub telemetry flush         # 手动发
skills-hub stats                   # 本地报表
GEOLY_TELEMETRY=0 skills-hub …     # 完全关闭：本地一个字节都不写
```

采集面是**穷举白名单**：不含路径、目录清单、文件内容、用户名。
⚠️ 但**平台请求日志会记录你的 IP，且我们关不掉** —— 这是明确接受的残余风险
（T-20），不是"已缓解"。见 [`docs/telemetry/00-spec.md`](../telemetry/00-spec.md)。
