# M0 v4 → v5 变更台账

Codex 第五轮判定「P0-2、P0-3 均未关闭」，给了 4 组最小通过集合。逐条如下。

## ① 互斥原语（同时关掉 P0-2 的并发与 P0-3 的抢锁）

**评审**：`O_EXCL` 只保证创建时不存在，不提供安全的陈旧锁**接管**。
A、B 同时读到旧锁；A 删旧锁并建新锁；B 按先前的「陈旧」结论把 A 的新锁删掉。
**没有 CAS，pid / boot_id / 启动时刻一条都补不上。** 容器共享 bind mount 时，
B 还看不到 A 的 pid namespace 里活着的进程。

**v5**（D11）：协议只剩两个各自原子的操作，**没有任何一步是「先删后建」**——

| 操作 | 实现 | 谁发起 |
|---|---|---|
| 取锁 | `open(O_CREAT\|O_EXCL)` | CLI |
| 清锁 | 单次 `unlink` | 🔴 **只有人**（`recover --clear-lock`） |

- 锁已存在 → 报出持有者信息并退出，**不判活、不接管、不等待**；
- 锁里的 `pid` / `boot_id` / `host` / `started_at` **只供人阅读**，不参与任何自动决策
  （v4 让它们参与判定，那正是错误来源）；
- 释放前校验 `nonce` 是自己写的 —— 这是**防误删**，不是 fencing（v3 曾错拿它当 fencing）；
- 清锁与重建是两条独立命令，两个 CLI 同时抢也只有一个 `create` 成功。

代价：崩溃后需人介入一次。用「多一次人工」换掉一个纯 Node 消不掉的竞态。

**同一协议用于 `metadata.lock`**（v4 那里还写着「内核 advisory lock」）与
**新增的 repo 级锁**（见④）。

**trust floor 的单调提交**（评审反例：P1、P2 都读 floor=10，P2 写 12，P1 后写 11 → 回退）：
光有锁不够，**写入规则本身必须单调** ——

```
在 metadata.lock 下：
    重新读一次磁盘上的 floor        ← 不用内存里那份
    磁盘值 ≥ 待写值 → 放弃写入（不回退）
    否则            → 原子写
```

## ② 目录链 fsync + 完整恢复矩阵 + retire-only

| 评审 | v5 |
|---|---|
| 缺 `<stage-parent>` 的 fsync → **旧树与新树会一起丢**（tx 根的目录项未持久，而 target 的删除已持久） | §5.2.1：**任何新建目录，创建后必须 fsync 它自己和它的父目录，一路到已存在的祖先**。适用于 `.geoly-tx-*` / `targets/<id>/` / `attic/<gen>/` 三条链 |
| 「以磁盘为准」不够 —— `stat` 只知有无，不知 target 里是旧树、新树还是第三棵树 | §5.4 重写：journal 每项记 `op` / `had_old` / `old_digest` / `new_digest`；恢复时对 **T / R / S 三处各自求摘要**，得到五元判定，查**穷尽表**。🔴 **未列组合一律 `corrupt` 停机**，报告三处实际摘要，绝不按 item state 猜着继续 |
| `replaces` 与 pack 移除成员是 retire-only，当前矩阵执行不了 | §5.3 引入三种 `op`：`swap` / `install-new` / **`retire-only`**，各有自己的步骤子集 |
| 未规定同一 target 内计划项名称唯一 | 补：结构门 + 运行时都查唯一性 |

## ③ 清理阶段独立成可恢复协议

**评审**：v4 第 10 步「打 tar、删 retired、删 tx」没有任何顺序约束，崩在中间可丢唯一旧备份；
而第 2 步刻意忽略 `completed` journal，**没人负责续做**；`done` 行却承诺可从 tar 回滚，
tar 尚未持久时不成立。

**v5** §5.6 定死六步：`tar.tmp → fsync → 逐文件验证 → rename → fsync(attic 及父链) →
checkpoint tar_durable → 删 retired → checkpoint done`。

并证明**为什么可以自动续做**：④ 之前旧树完整躺在 `retired/`，④ 之后 tar 已持久且已验证 ——
**任何时刻旧树至少有一份完整副本**，续做只前进不毁东西。
这与「不自动接管锁」不冲突：那条防的是两个活进程并发，续做发生在已合法取到锁之后。

第 2 步规则相应细化为三分支（未完成事务 → 停机；`cleanup_pending` → 自动续做；
`completed` 残留 → 直接清掉）。

## ④ lockfile 重做

**评审**：v4 说它是投影、可从账本推导 —— **不成立**。账本缺 pack 根的 `tree_digest`、
`direct` 请求的具体 artifact、单一 `snapshot`（多 root 可来自不同快照）、解析意图。
且「原子重算」不能替代 repo 锁。

**v5 两步都做**：

1. **补足账本**：新增顶层 `roots`，每个请求根记 `artifact` / `tree_digest` / `snapshot` /
   `intent`（`no_bundled` / `allow_yanked` / `pre`）。`requested_by` 改为引用 `roots` 的 key。
   lockfile 顶层的单一 `snapshot` 字段**删除**，改为 per-root。
2. **repo 级锁** `<repo>/.geoly-skills.lock-guard`，与 §5.1 完全相同的协议，
   重算与写入全程持有。

补足之后 lockfile 每个字段都有来源，因此**保留它作为 `install` 的权威输入**。
任一项目级 target 处于未恢复事务中 → 拒绝重算（不写基于半完成状态的 lockfile）。

## 跨文件矛盾（评审列的七条）

| 矛盾 | v5 |
|---|---|
| 00 仍称当前版本 v3 | 改为 v5，并列出四份变更台账 |
| 02 的 attestation 示例用 `@refs/heads/main`，违反同页 v4 契约 | 示例改为 `@<40 位 commit sha>` |
| 04 / 06 说「六项绑定」，skill 实际有第七项 | 全改为「六项（skill 七项）绑定」 |
| 04 / 05 仍保留「归档→验证→删除」的旧事务描述 | 04 的照搬表注明「移到事务之后的清理阶段」；05 的 `replaces` 改为「以 `retire-only` 项退役」 |
| 10 说 Q9 已消失，Q12 又承认 stage 未验证 | Q9 改为「**只关闭了一半**」，并说明另一半升级为 Q12 的 adapter 验收用例 |
| 01 §6.2 引用已不存在的「§5 的 200 字节上限」 | 改为引用 §4.3 的 USTAR 可编码性 |
| wire contract 要求所有对象 canonical，但示例本身不是 | 新增 §6：**文档示例为可读性书写，不是 canonical**；实际文件必须 canonical，CI 有门校验 |

另：07 与 09 里残留的 flock 措辞已统一到 D11 的协议；
09 补 `--clear-lock`、`--resume-cleanup`、`sync-lock`。

## 仍然开放

Q4（token 收窄，M3 前）、Q5（验签依赖体积）、Q6（解包库选型）、
Q10（跨 Node/zlib 归档确定性）、Q12（stage discoverability，已是 adapter 验收用例）。
全部不阻塞接口定型。
