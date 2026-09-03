---
name: skills-hub-install
description: 用 skills-hub CLI 装 skill / pack —— 命令、装到哪一端、复现与离线、装崩了怎么恢复、以及为什么没有 --force。当用户要装 geoly 的 skill、说「装一下 xxx skill」、要查装了什么、或者安装失败要排查时使用。
---

# 用 skills-hub 装 skill

> 本文针对 `@geoly-ai/skills-hub@0.2.x`。
> ⚠️ **照做之前先跑一次 `skills-hub --help` 核对** —— 本文写死了 flag 名，
> CLI 改了它不会自动跟着变。以 `--help` 为准。

## 最短路径

```sh
npm i -g @geoly-ai/skills-hub          # 或每次 npx @geoly-ai/skills-hub …
skills-hub install skill:<ns>/<name>@<version>
```

制品 id 是固定三段式：

```
skill:prompts-map/prompt-map-generator@0.7.0
pack:plaud-theme/plaud-theme-matrix@0.3.6
└┬──┘ └────┬────┘ └────────┬────────┘ └─┬─┘
 kind   namespace        name         semver
```

🔴 **版本必须写全**（`@0.7.0`，不是 `@0.7`、不是 `latest`）。制品是不可变的，
「最新」只存在于快照的 `latest` 字段里，不在安装命令里。

## 常用命令

| 命令 | 干什么 |
|---|---|
| `install <spec>…` | 装一个或多个 |
| `install --all` | 装快照里的全部（非交互下还要 `--yes-i-really-want-everything`） |
| `list --installed` / `--outdated` / `--packs` | 看装了什么 |
| `search <kw>` | 搜 |
| `check` | 两阶段校验：**字节对不对** + **现在还该不该用** |
| `why <name>` | 这东西是谁请求装的（pack 带进来的，还是直接装的） |
| `recover` | 装到一半崩了之后收拾现场 |

## 装到哪一端

```sh
skills-hub install <spec>                    # 本机已存在的所有 client
skills-hub install <spec> --clients claude   # 只装 claude
skills-hub install <spec> --project          # 装进当前仓库，维护 lock 文件
```

`claude` / `codex` / `agents` 支持全局与项目级；**`cursor` 不支持**。
`agents` 是 **present-only**：`.agents` 已存在才加入，不会被创建。

⚠️ `--clients` 里写了本机没装的 client 是**硬错误**，不是警告 ——
静默跳过会让你以为装上了。

## 🔴 装不上时：读错误，不要找绕过的开关

**CLI 没有 `--no-verify` / `--insecure` / `--force` / `--force-unlock`。**
验签与摘要校验**不可关闭**。答案在错误信息里，不在 flag 里。

有开关的几个场合，每个都**窄且独立**（没有万能开关 —— 这样你每次只放行你
真正理解的那一件事）：

| 情况 | 开关 | 代价 |
|---|---|---|
| timestamp 过期 | `--allow-stale` | 后续输出**持续标注 stale** |
| 制品已被 yank | `--allow-yanked` | 大声告警 + 写进账本；**不放行 degraded** |
| 全局已有同名 | `--shadow-global` | 仅项目级安装可用 |
| 替换未被账本认领的同名目录 | `--replace <name>` | **必须点名**，没有「全部替换」 |

## 复现与离线

```sh
skills-hub install <spec> --snapshot 42     # 钉快照，复现当时的解析结果
skills-hub install <spec> --offline         # 只用缓存；未命中即失败
```

`--offline` 是**硬的**：不是「尽量不联网」，是一个字节都不出去。

## 装崩了

```sh
skills-hub recover                 # 先看现场
skills-hub recover --continue      # 接着装完
skills-hub recover --rollback      # 退回去
```

安装是**分代**的，旧代进 attic（默认留 3 代），所以「装坏了」几乎总能退回去。

## 埋点

🔴 **默认开**：`install` 成功收尾后静默发一次（24h 最多一次、超时 1 秒、
**失败不影响安装**）。采集面是穷举白名单 —— 不含路径、目录清单、文件内容、用户名。

```sh
skills-hub telemetry status    # 看开关与队列
skills-hub stats               # 本地报表
GEOLY_TELEMETRY=0 skills-hub … # 完全关闭：本地一个字节都不写
```

⚠️ **平台请求日志会记录 IP，这一条我们关不掉** —— 是明确接受的残余风险，
不是「已缓解」。用户在意的话，`GEOLY_TELEMETRY=0` 是唯一彻底的办法。
