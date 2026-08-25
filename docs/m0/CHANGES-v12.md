# M0 v11 → v12 变更台账

Codex 第十二轮：P0-2 维持关闭；**rename 五分支被确认正确**（"Y 正确且 X 缺席"是原子 rename
唯一的正常后态，把"两端都在"判 corrupt 是对的）。P0-3 未关，5 组最小阻断集合。

## ① 🔴 rollback 需要**子操作** checkpoint

**评审**：五分支只适用于「一段内只有一次 rename」的前向段。**rollback 不满足**：

```
T=new,R=old,S=∅  →  T→S  →  R→T  →  崩溃
```

journal 仍是 `pending`，重跑第一步得到 `T=old, S=new`，
**正好命中五分支的「Y 正确且 X 也在 → corrupt」—— 这是正常崩溃，不是损坏。**

（同一个教训我在正向段上已经学过一次，反向段上又犯了一遍。）

v12：反向子状态 `pending → t_parked → restored`，`swap` 的两次 rename 之间有 checkpoint。
恢复按子状态定位；五分支的幂等规则在**每个子操作内部**仍然适用（各只含一次 rename）。

## ② rollback 的入场预检与分支补全

| 评审 | v12 |
|---|---|
| `swap` / `install-new` 仍在 `planned`（首次正向 rename 未做）时，回滚应**不动 target**，现表会去做 `T→S` 然后被正常地判 corrupt | 两种 `planned` 各补一行：直接置 `restored`，收尾清 tx |
| `cleanup=tar_durable` 但 `rmtree` 尚未开始时 `R == old_digest` 是正常状态，表却只列了 `R != old_digest` | 分支改为按 `R` 的实测摘要分，而不是按 `cleanup` 值分 |
| 入场预检只验 `A`，没验选 `R` 的项，也没验将被移走的 `T` | 预检扩为三项：选 `A` 的验 `A`、选 `R` 的验 `R`、被移走的 `T` 验 `== new_digest`。任一不满足 → **拒绝整个 rollback，不写 `direction`**，免得把注定做不完的回滚锁死在 rollback 方向 |
| 🔴 六步收尾的 bootstrap 矛盾：`ledger_existed=false` 时第②步删 `ledger.json`、第③步又要写 `transaction=null` | 合成二选一分支：`true` → patch + 置 `transaction=null`；`false` → **删除整个 ledger.json**（不存在"往哪写"的问题） |

## ③ bootstrap 与 generation 水位

| 评审 | v12 |
|---|---|
| 骨架须含 `transaction:null`；「骨架成功、journal 未写」怎么恢复 | 骨架含 `transaction: null`；该状态视为 **pre-commit**，删掉骨架与残留 tx（规范选删除，不留语义含混的空壳） |
| `ledger_existed` 不能因残留骨架改变语义 | 明确它表示**本次事务开始之前**的状态 |
| 🔴 bootstrap rollback 删掉账本后 `next_generation` 无处安放；**纯 `install-new` 没有 attic**，tx 与 completed journal 又会被清 → generation 会复用 | 🔴 **独立文件 `<target>/.geoly/generation`**：原子写、**永不删除**、只增不减、不进 `ledger_image`、不参与回滚。取号 = 读 → +1 → **先写回 fsync 再使用**。恢复一律以它为准，不再扫描目录 |

## ④ attic manifest 改两阶段

**评审**：逐项 ①…⑥ 下，第一份 tar durable 后就要写 manifest，而 manifest 要记整代所有 item，
此时后续 tar 还不存在；等全部 tar 都有了再写，又没有 checkpoint 阻止恢复逻辑先删 retired。

v12 拆三段：**A 全部 tar 落地（一棵 retired 都不删）→ B 写整代 manifest 并 checkpoint
→ C 才允许删**。🔴 在 B 的 checkpoint 落盘前不许删任何 retired 树，
因此不会留下「retired 已删而 manifest 未持久」的、无法 `--from-generation` 的代。

manifest 本身的三处修正：

| 评审 | v12 |
|---|---|
| 没定义 `install-new` 的无 tar 回退，也没定义 `retire-only` 在「新正向事务」中的反向 op；"按普通 swap"不成立 | 每项显式记 **`reverse_op`**：原 `swap` → `swap`；原 `retire-only` → **`install-new`**；原 `install-new` → **`retire-only`**（无 tar，靠 retirement rename）。`tar` 可为 `null` |
| `ledger_restore` 的"完整 entries/roots"会在复位较旧 generation 时**抹掉后续各代的无关变更** | 改为 **`ledger_delta`**，只记本代动过的键（`null` = 复位后应不存在） |
| `frozen_attic` 未纳入 | 纳入 delta |
| `--only` 在 pack root 下会形成根—成员图不闭合 | 🔴 只允许选出**完整、且与未选项不共享 root** 的闭包；否则**拒绝**并列出「要一起选的还有哪些」 |
| 新 schema 未进 wire contract | 已纳入 11 的适用对象；`generation` 文件因为是纯整数、明确列为**不适用** |

## ⑤ 状态门与 `--allow-yanked`

| 评审 | v12 |
|---|---|
| 当前状态门只写了「物化的制品」，而 **`degraded` 是 pack 的状态、pack 不作为目录物化**，等于漏掉 | 覆盖面改为三类：每个 **root artifact**（pack/direct）、每个 **entry**、`all` 的全部重解析 entry |
| 🔴 跨文件冲突：02 说 `degraded` 可用 `--allow-yanked` 放行，03 说 degraded pack 不能新装 | **定死：`--allow-yanked` 只放行 `yanked`，绝不放行 `degraded`**（§8.1.1）。理由：`yanked` 是针对具体制品的知情豁免；`degraded` 是「连带装一个已知被 yank 的成员」，用户并没有对那个成员表达豁免意图。要装就按成员逐个装。02 §6.2 与 03 §5 已同步 |

## ⑥ 三处规范矛盾

- 「合法 `item.state`」里仍列着 `retiring` → 删（v10 的段模型早已取消它，v11 两处没清干净）。
- cleanup 发现规则把 item state 写成 journal phase（`phase ∈ {planned…verified}` 不存在）→ 改为
  `journal.phase = prepared` 且尚有 item 未到 `done`。
- 「只有这些情况 corrupt」错列 rename 分支（漏第五分支、误述第二分支）→ 改为 ②④⑤。
