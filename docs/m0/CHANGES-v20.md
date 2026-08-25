# M0 v19 → v20 变更台账

Codex 第二十轮：P0-2、P0-3 维持关闭；「不随 rollback 回退 / bootstrap 例外保留 /
`--keep-generations` 不清 archive」三项**文字上已闭合**。剩 3 个 P0，全在 audit plane。

## ① cursor 三处自相矛盾

§4 有正确规则（cursor 只在归档事务第③步前进），但另外两处还在往回打：

- §4 的 audit-plane 表里仍写「`audit_archived_until` 随 `audit_append` 一起前进」；
- §5.4.2 的 `ledger_image` 示例把 `audit_archived_until` 放进了**安装事务**的 `post`。

v20：删掉前两处。🔴 **安装事务的 `post` 里只允许 `audit_append` 一个 audit 字段**；
cursor **只在归档事务第③步、且 archive 文件通过重验之后**更新。

## ② 归档 intent 的恢复与准入没真正落地

§4 两处都写着「§5.2 第 2 步已拦截」，**而 §5.2 第 2 步根本没扫 `audit-archive-intent.json`** ——
引用了一个不存在的拦截。`--reinstall` 也没处理它。

v20 把第 2 步拆成三小步：

```
2a  先扫 audit-archive-intent.json：存在 → 按 §4 归档协议完成它，或 fail-closed 停机
    （绝不跳过、绝不删除）
2b  阈值前置：live 数 > audit_max_entries → 先归档到 == max
2c  才发现安装事务（ledger.transaction + journal/ + tx-*）
```

🔴 **防饥饿**（评审新指出的）：v19 只写了「intent 未清完不开始安装」，
而 **intent 尚未创建时，连续安装可以一直越过阈值却永远不启动归档** ——
2b 就是补这个。不会死锁（三把锁都是 `busy_timeout=0`，冲突即失败退出）。

`--reinstall` 同样必须先过 2a/2b，**绝不删除 intent**。

## ③ `audit-seq` 的烧号仍可被复用

评审给的路径：先成功写出 `seq=1` → 后续事务失败**烧掉**该号 → 再丢失 seq 文件。
此时 live、archive、intent、cursor **全都是空的** —— v19 的那组判据判不出来，下一次**复用 1**。

根因：**烧掉的号本身不产生任何 audit 证据。**

v20 改为按「文件生命周期」判，不再按「有没有 audit 证据」判：

- 🔴 **每次 ledger bootstrap 一并持久化 `audit-seq = 0`，此后永不删除**；
- 没有 ledger 也没有 seq → 连同骨架一起建 `audit-seq = 0`；
- 🔴 **没有 ledger 但 seq 存在 → 合法**（pre-commit 清理只删骨架、不删 seq），
  **沿用该 seq，绝不重置为 0**；
- 🔴 **已有 ledger 但 seq 缺失或格式非法 → 一律拒绝**。

bootstrap 的 pre-commit 清理措辞同步收紧：删骨架与残留 tx，**但不删 `audit-seq`**。

## ④ 去重的校验顺序（避免实现歧义）

评审确认三分支本身**不会误判**（正确顺序下 journal 重放只会撞到 live 里同字节的事件而 no-op；
归档只发生在 journal 完成之后，所以 replay 不会正常撞到 archive），但要求写明顺序：

① 先校验**已持久化的 live 流**自身唯一、且与 archive 不相交 →
② 再校验 `audit_append` **批内**唯一 → ③ 最后逐条合并。

🔴 **不得把 replay 的候选先算成「live 内重复」。**

## M1 开工清单（评审重申）

1. **Q12**：按具体客户端版本完成四端 × 全局/项目级的 `.geoly` discoverability 验收。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，以及
   `ExperimentalWarning` 抑制方式的实测。
