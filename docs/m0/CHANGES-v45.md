# M0 v45 变更台账

Codex 第四十四轮：**未见新的状态机漏洞**；四条人工出路**本身可执行**，
「恢复为 `D` 后 `--continue`」**不会死锁**，人工 B/C 与 §5.10 **一致**。
问题只是「声称已补齐，但 CLI 两行和人工出口名单**未实际闭合**」。

## ① CLI 三行没有共用同一张分流矩阵

v44 我只改对了 `--reinstall`：

| 行 | v44 的状态 |
|---|---|
| `--reinstall` | ✅ 正确 |
| `--continue` | ❌ 没写明**物理 `corrupt` 必须拒绝** |
| `--rollback` | ❌ 没写明「物理拒绝 / `adopt` 允许 / `unadopt` 拒绝」 |

v45 三行**全部写出同一张分流**，并按建议给 §5.4 的表**显式加上 `--continue` 列** ——
不再靠表外段落推导：

| 情形 | `--rollback` | `--continue` | `--reinstall` |
|---|---|---|---|
| 物理 `corrupt` | 🔴 拒绝 | 🔴 拒绝 | 可用 |
| `adopt` 的 `assertion-corrupt` | ✅ 允许 | 🔴 拒绝 | 🔴 拒绝 |
| `unadopt` 的 `assertion-corrupt` | 🔴 拒绝 | ✅ **允许**（唯一自动出路） | 🔴 拒绝 |

## ② 两处人工出口的**对象集合不一致**

| 出处 | v44 列的 |
|---|---|
| §5.4 | journal / tx / 账本 / `quarantine/` —— **漏了 `repair-intent`** |
| §5.10 | intent / `quarantine/` / tx / journal —— **漏了账本记录** |

v45 统一为**五样**：存在时，
🔴 **`repair-intent`、journal、tx、账本记录、`quarantine/`** 均不得单独删除；
恢复则必须恢复**完整一致的 `.geoly` 状态集 + 目标树**。

## ③ 顺带消歧的三处泛称

§5.4 里「触发 `corrupt`」「任一项 `corrupt`」「停在 `corrupt`」三处虽可由紧邻定义继承，
但既然目标是彻底消歧，v45 一律改写为**物理 `item.state = corrupt`**。

⚠️ 按评审提醒，**§5.10 内的 `corrupt` 不动** —— 那多是 repair 自身的 fail-closed 判定，
与 CLI 的物理状态**不是同一个概念**，混改反而会制造新歧义。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
