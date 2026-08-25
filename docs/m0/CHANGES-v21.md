# M0 v20 → v21 变更台账

Codex 第二十一轮：P0-2、P0-3 维持关闭。剩 2 个 P0 + 1 处措辞。

## ① 🔴 我把顺序补错了位置，重新打开了刚关上的洞

v20 为防饥饿加的 **2b 阈值归档，排在「发现安装事务」之前** ——
这直接违反 §4 自己刚定的「**安装事务进行中不触发归档**」。
`--reinstall` 又明确要求先跑 2a/2b，于是它会**踩到 corrupt journal**。
而且「任一命中即停机」还与 `cleanup_pending` 的自动续清理冲突。

v21 按评审给的顺序重排：

```
2a  先清 audit intent（完成，或 fail-closed 停机；绝不跳过/删除）
2b  再发现并处理安装事务：
      cleanup_pending → 自动续做到 completed
      prepared / 任一项 corrupt → 普通命令停机提示 recover；recover 自己进 §5.4
      有 tx 无 journal → pre-commit，直接删
2c  确认已无未完成安装事务之后，才做阈值归档（live > max → 归档到 == max）
    完成 2c 才允许创建新的安装事务
```

`--reinstall` 的顺序同步为：2a → **消除/隔离 corrupt 安装事务并保留 audit plane** → 2c。

防饥饿的目标仍然保留（归档发生在「创建新安装事务之前」），只是**挪到了正确的位置**。

## ② 🔴 「重验后才前进」只写在崩溃恢复里，正常路径没有

归档步骤从「写 archive」**直接跳到**「patch 账本 / 更新 cursor」，
重验只定义在崩溃恢复分支 —— 于是文字承诺与可执行协议差了一步。

v21 在正常路径插入 **②′**：**重新打开** `<seq>.json`，严格校验 schema、`seq`、
`from_event`/`to_event` 范围、events 完整性与 `batch_digest`；任一不符 → **停机，不 patch 账本**。
正常路径与崩溃恢复**走同一段重验**。

## ③ bootstrap 的两文件原子性措辞

评审：ledger 骨架与 `audit-seq` 是**两份各自原子的文件**，不是一次跨文件原子操作；
v20 那句「骨架写失败时磁盘上什么都没发生」不精确。

v21 写明顺序与部分成功的处置：

- ① 先写 `audit-seq = 0`（若不存在）→ fsync。失败 → 终止。<br>⚠️ **此处原写「磁盘未变」，已被 v22 废止** —— 见 [`11-wire-contract.md`](11-wire-contract.md) §5 的原子写失败口径。
- ② 再写 ledger 骨架 → fsync。失败 → 终止，**留下一个孤立的 `audit-seq`** ——
  这正是 §4 已承认的合法状态「无 ledger 但有 seq」，下次**沿用、不重置、不删除**。

## ④ 评审确认无需再动的

- **`audit-seq`**：正常崩溃模型下**没有新的烧号复用路径**。
  seq 的 fsync 失败时事件尚未获准使用；已成功 fsync 之后的失败只会烧号、不会回退；
  ledger 与 seq 分属两个 fsync 边界也不改变这一点。
- **cursor 归属**：当前有效规范里安装事务 `post` 只含 `audit_append`，写入归属已统一
  （历史 CHANGES 文件里的旧说法不构成当前规范）。
- **2b 崩溃不产生活锁**：intent 由 2a 恢复；永久 I/O 故障则 fail-closed。

顺带按评审建议补一句作用域：🔴 **`event_id` 的作用域是「这一份 `.geoly` 状态谱系」，
不是那个路径名** —— 「移走整个 target 重装」与 `git clean -xfd` 都会开启**新序列**，
这是规范已承认的「放弃本地 audit」边界，不算复用。
