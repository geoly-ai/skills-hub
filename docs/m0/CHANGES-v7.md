# M0 v6 → v7 变更台账

Codex 第七轮：**SQLite 路线本身认了**（我问的坑都答在安全一侧），
但 v6 还没把它写成一个在全部声称环境中成立的协议。给了 4 组最小通过集合。

## Codex 对 SQLite 路线的技术确认（记下来，免得重问）

| 我的疑问 | 结论 |
|---|---|
| WAL 下 `BEGIN EXCLUSIVE` 拿什么锁？读者会降级它吗？ | 等同 `BEGIN IMMEDIATE`：排他阻止其他**写者**，读者仍可读，**不会降级** |
| 长事务（几十秒）会被 SQLite 自行超时/回滚吗？ | **不会**。`busy_timeout=0` 只让竞争者立即失败 |
| 同进程多次 open 同一 db（fcntl「关闭任一 fd 释放全部锁」陷阱） | SQLite 的 Unix VFS 自己协调，**不必**强制一进程只开一次；但**绕过 SQLite 的 fd** 仍会触发该陷阱 → 写成「`src/lock.mjs` 独占该 db 路径」的硬约束 |

## ① 🔴 target 锁的作用域（v7 最重要的修复）

**评审**：v6 把 target 锁放在 `~/.local/state/.../targets/<target-id>/lock.db`，
而 `<target-id>` 来自 mount namespace 内的 `realpath`。
**两个容器 / 两个 state root 访问同一个本地 bind-mounted target，会各自创建不同的
`lock.db`，两边都能成功 `BEGIN EXCLUSIVE` —— 根本不是同一把锁。**
NFS/SMB/FUSE 的拒绝规则挡不住它（这是本地 bind mount）。

**v7**（§5.1.1）：target 锁移到**所有竞争者必然共享的位置** —— target 的相邻目录
（stage-parent，与 target 同设备），并以**物理身份**命名：

```
<stage-parent>/.geoly-lock-<st_dev>-<st_ino>.db
```

同一个物理 target 无论从哪个 namespace 访问都是同一个文件 → 同一把锁；
用 `(st_dev, st_ino)` 而非路径命名，target 改名后仍是同一把锁。
state 目录只留账本与 journal —— 那些本就是每个 state root 各自的视图。

## ② 锁适配层的其余契约

| 评审 | v7 |
|---|---|
| 「取锁前写 holder，WAL 下别人可读当前 holder」不成立 | 改为**先取锁、再写 holder 并 COMMIT 子事务**；外部读到的明定为「**上一次已提交的诊断信息，可能陈旧**」，**不承诺是当前持有者** |
| 不应承诺 `-wal/-shm`「永不删除、无害」 | 改为「CLI 不手动删，但不承诺它们不变」（SQLite 会 checkpoint / 重建 / 最后连接关闭后移除）；🔴 **不得长期持有诊断读连接**，否则 checkpoint starvation + WAL 增长 |
| Node 22.12 不自洽 | 🔴 门槛升到 **22.13**（22.12 及以前仍需 `--experimental-sqlite`）；CI 锁集成测试跑**最低版本 + 当前 LTS** |
| 警告抑制写在适配层来不及 | 承认：警告在**模块导入时**发出。抑制必须在**任何 import 之前**（bin 入口第一行），或 launcher re-exec 带 `--no-warnings=ExperimentalWarning`。**M1 必须实测确认哪种有效** |
| 加锁全序无法证明所有路径遵守 | 补**每个命令的取锁表**；`adopt --rebind` 明确要取**旧、新两把**并按 `(st_dev, st_ino)` 排序；🔴 后续取锁失败时必须对已持有的锁逐一 `ROLLBACK + close` |

## ③ 恢复：键从「四处摘要」改为四元组

**评审**：`T=new, R=old, S=缺席, A=缺席` 在「第 8 步前」与「`cleanup_pending` 尚未写 tar」
之间**是歧义的**，v6 只判前者。

**v7**：判定键 = `(journal.phase, item.state, item.cleanup, T/R/S/A 实测摘要)`。
journal 给阶段、磁盘给事实；两者冲突一律 `corrupt`
（v6 那句「以磁盘为准就继续」在这里不成立）。

其余逐条：

| 评审 | v7 |
|---|---|
| `retire-only` 的 `R=old, A=.tmp` 回滚不能「参照解 A」（tmp 未 durable） | 改为 🔴 **`R → T`，再删 `.tmp`** |
| `R=部分, A=.tmp` 不是协议可达状态 | 明确归 `corrupt` |
| `retire-only` 从「已退役」直接进清理会**跳过第 9 步的账本更新** | 改为**先补做第 9 步，再进清理** |
| `install-new` 没定义怎样到达 cleanup `done`，却被「全部项 done」当作删 tx 的条件 | 明确：`install-new` 没有 `retired/`，§5.6 对它是**空操作**，第 9 步后直接置 `done` |
| `corrupt` 能否 rollback 两处仍矛盾 | 统一为**不允许**，与 09 的 CLI 定义一致 |
| 表未覆盖「T 是第三棵树」 | 补一行 → `corrupt` |

## ④ `old_digest` 的来源（§5.6）

**评审**：第 ② 步只验「tar == retired」，**没要求两者都等于首次 rename 前实测的
`old_digest`** —— 两者可能一起是错的（中途被外部改写），自动续做会把错误副本固化成唯一备份。

**v7**：
- 第 6 步写 transaction 时对**即将退役的目录**实测摘要并持久化为 `old_digest`；
  `--replace` 的未认领目录同样实测（账本里没有它的期望值）；
- 清理第 ② 步改为**三方比对**：`tar == retired == old_digest`；
- 新增第 3 条前提：**自动清理只在 `phase = cleanup_pending` 之后进入**，
  更早阶段必须先完成第 8 步验证与第 9 步账本更新。

## ⑤ lockfile

| 评审 | v7 |
|---|---|
| §8 仍有一段活着的 `/1` schema 与旧行为示例，与 `/2` 直接冲突 | 删除，改为指向 §8.1 |
| 缺 root-key grammar，尤其 `direct:` 与 `--all` | 定义三种形态，含 `all@snapshot:<N>` |
| 缺 target / root / entry 的唯一性与排序、`requested_by` 的引用与去重约束 | 补齐五条约束表 |
| 「无损」含义不清 | 🔴 明确为 **「可复现的期望安装图」无损**，不是 ledger 的逐字段投影。明列**不进** lockfile 的字段（`requested_at` / `installed_at` / `generation` / entry `state` / 本机 `target-id` / `fstype`）—— 它们是本机运行历史，跨机器无意义 |

## ⑥ P0-2 的最后一块

**评审**：锁内重读在同版本时只比 `(latest_snapshot, snapshot_sha256)`，
**漏了 `timestamp_sha256`**，与 §6 第 3 步的三元组要求不一致 ——
两个同 version、同 snapshot、不同签名内容的 timestamp 会让后到的进程
继续按旧 timestamp 行为运行，绕过同版本绑定与 `min_cli_version` 收紧。

**v7**：锁内分支改为比较**完整三元组**，任一不同即完整性事件、终止。

## 跨文件

- 状态树里的 `metadata.lock` / `lock` → 统一为 `*.db`；target 锁移出 state 目录。
- wire contract 的「不适用」条目从旧的 `targets/<id>/lock` 改为三把 `*.db`，
  并说明 `holder` 表是可能陈旧的诊断信息。
- 09 / 10 / 00 的 Node 门槛统一到 22.13。

## 仍然开放

Q4、Q5、Q6、Q10、Q12，外加 **v7 新增的实测项**：
`ExperimentalWarning` 的抑制方式（适配层 vs launcher re-exec）必须在 M1 实测确认。
