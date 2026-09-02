# AGENTS.md —— 给 agent 读的入口

> 你（agent）在 `geoly-ai/skills-hub` 这个仓库里干活，或者要**用**它去装 skill。
> 这份文件是入口，只讲「这是什么、去哪找答案」。具体操作在 `docs/agents/` 下三份专题里。
>
> ⚠️ 人类读者请看 [`README.md`](README.md)。两者不重复：README 讲**产品是什么**，
> 这里讲**agent 该怎么用它、以及不该做什么**。

---

## 这个仓库是什么

`geoly-ai` 的 **skill 分发中心**：把 skill 打成不可变制品、签名、登记进快照，
然后用一条命令装到 claude / codex / agents 各端。

它跟"把文件复制过去"的区别在于**三件事都要能被证明**：

| | |
|---|---|
| **装的是不是我要的那个** | 树摘要 + 快照里的记录逐字节比对 |
| **是不是我们发的** | Sigstore keyless 签名 + Rekor 透明日志 |
| **现在还该不该用** | yank / deprecate / advisory，装的时候现查 |

📌 所以这个仓库里**大量代码是门（gate）而不是功能**。改动它们之前先读
[`docs/agents/03-gates.md`](docs/agents/03-gates.md)——很多门看起来多余，
其实每一条都对应一次真实的失败。

---

## 三份专题

| 文档 | 什么时候读 |
|---|---|
| [`docs/agents/01-install.md`](docs/agents/01-install.md) | **要装 skill** —— 命令、flag、装到哪、出错了怎么办 |
| [`docs/agents/02-publish.md`](docs/agents/02-publish.md) | **要发 skill 进来** —— 投稿目录长什么样、要过哪些门、审批要几个人 |
| [`docs/agents/03-gates.md`](docs/agents/03-gates.md) | **要改这个仓库的代码** —— 门的清单、以及改门之前必须知道的事 |

---

## 🔴 三条硬约束

### ① 不要绕过验证

CLI **没有** `--no-verify` / `--insecure` / `--force` / `--force-unlock`。
这不是遗漏，是设计：验签与摘要校验**不可关闭**。

看到"装不上，加个 force 吧"这种念头时，正确的动作是**读错误信息**——
它们都写明了是哪一道门、为什么拦。

### ② 不要用「让它变绿」的方式改测试

这个仓库的测试里有大量注释写着「不要把容忍度调大」「不要放宽这道门」。
它们不是客套：每一条都对应一次真实事故。

改一道门之前，先回答：**这道门当初是为了挡什么？** 答不上来就别改。

### ③ 报告失败要报原样

CI 红了、测试挂了、门拦了 —— 如实说是哪一条、原文是什么。
不要转述成「有点问题」，也不要因为"看起来无关"就跳过。

---

## 环境

- **Node ≥ 22.13**，macOS / Linux / WSL
- 零运行时依赖（`dependencies` 只有 `@sigstore/verify`）
- 跑测试：`node --test test/*.test.mjs`；跑检查：`npm run check:all`

## 埋点

🔴 **上报默认开**。`install` 成功收尾后会静默发一次（24h 最多一次、超时 1 秒、
失败不影响安装）。采集面是**穷举白名单**——不含路径、目录清单、文件内容、用户名。

关闭：`GEOLY_TELEMETRY=0`（本地一个字节都不写）。细节见
[`docs/telemetry/00-spec.md`](docs/telemetry/00-spec.md)。
