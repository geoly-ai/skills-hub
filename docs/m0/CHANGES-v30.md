# M0 v30 变更台账

Codex 第二十九轮（补跑上一轮被中断的评审）。
🎉 **全量扫描确认：除 v29 已修的那一处，没有别处被整块替换吞掉**；
本地链接与章节引用均有目标；v12 曾丢失的 rollback 终结顺序**仍在**。

剩 4 个 P0 + 3 项补定。

## ① `tx.fingerprint` 只有字段名，没有算法

没有算法就谈不上「精确匹配」，于是隔离恢复表里 tx 那一项**无法判定**。

v30 定死：对 `tx-<gen>/` **整棵树**跑 §01-6.1 的 `geoly-tree-v1`（同一套规范化与排序），
覆盖 `stage/` 与 `retired/` 的全部普通文件；🔴 **`lstat`/dirfd 无跟随**，
遇 symlink / 设备 / FIFO **无法成像 → 不写 intent、转人工**；隔离前后各算一次必须相等。

## ② 两段式 intent 缺 `restore_from` 的持久化点

`install-new` / `swap` **都必需** `restore_from`，而 v29 的 ④ 只原子写 `cur` / `child_op` ——
于是 `isolated` 可以成为一份**合法性不成立、又无法恢复**的 intent。

v30 把三者放进**同一次**原子写，并定死两阶段的**字段集**（多一个少一个都算非法 intent），
同时统一 v29 自相矛盾的两处表述（一处说 planned 只写 `target`、字段表又把 `old_digest` 标在 planned）。

## ③ 🔴 `cur` / `target` 的重测范围错了

评审：child 一旦 `prepared`，`swap` / `install-new` 的物理起点**必然不再等于隔离时的 `cur`**；
而「每次重放前复验 `target` 断言」还会把**合法的** `install-new` 起点 `absent` 判死。

v30 分三段：

| 时机 | 规则 |
|---|---|
| `planned` / `isolated`，**创建 child 之前** | 重测 `cur` 并要求与持久值一致 |
| 🔴 **child journal 已存在之后** | **只按 §5.4 段模型恢复**，不再重测 `cur`、不在每步复验 `target` |
| child 跑完的最终重验 | 才校验 `target` 与 `postimage` |

## ④ 🔴 12 行矩阵：**已列行误杀正常状态**

评审指出两个硬伤：

- 正常清理是**先删 tx、再写 `journal=completed`**，所以可以崩在
  `journal=cleanup_pending, tx=无, transaction=本代, committed=true` ——
  而第 7 行「有 journal 无 tx → `corrupt`」把它一刀切了。
  **这不是兜底误杀，是我自己列的行杀的。**
- **`committed` 其实是第四个观测量**：第 2 行与第 11 行三元组完全相同，
  只靠动作文字区分，不满足「从上到下唯一匹配」。

v30 重写为**四观测量、17 行**的矩阵，把 `prepared` 与 `cleanup_pending` 拆开，
新增第 10 行（`cleanup_pending` + tx 已删 = ✅ 正常可达，收尾即可）。

## ⑤–⑦ 三项补定

| 项 | v30 |
|---|---|
| `restore_from` 只说「绑定精确对象」 | 按 `source` 给三张定位/验法：`registry` 走完整验证链、`attic/<gen>` 对 manifest 的 `old_digest`、`quarantine` 对 `isolate.targets[*].observed`；三者共同要求落位后**重算 == `target.digest`** |
| `plan.snapshot` 未绑定 | 🔴 必须等于**原 journal 记录的解析快照**，且能按 §02-6.1 取回并验签 —— 不能「随便挑一个当前快照」 |
| 🔴 `plan.roots` 是**孤儿概念** | 只出现在示例与 absence 规则里，**没有生成、校验、消费规则** → **删除**（root 变更本就由 `repair_ledger_image` 覆盖） |
| 空 `items` 的 `--from-generation` | 明确：纯账本变更那一代同样创建**普通的 `items: {}` ledger-only 事务**；`reverse_op` 是**空的物理操作序列**（不是新取值）；🔴 **照常写本代 manifest**，否则这一代又变得不可复位 |

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
