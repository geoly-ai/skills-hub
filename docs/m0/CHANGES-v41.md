# M0 v41 变更台账

Codex 第四十轮：确认 v40 **解决了 pack 必须单事务的问题**，但受管化路径本身尚未闭合。4 项。

## ① manifest 规则自相矛盾

混合计划要求 manifest 同时含物理项与 adopt 项，而另一处又规定**两种情形都生成 `items: {}`**。
且 manifest 的 op 枚举只有三种、wire 也只允许 `install-new` 的 `tar/old_digest = null`。

v41：**空 manifest 仅限**「既无物理项、也无逻辑受管化项」的纯账本事务；
**混合与纯 adopt 都在 Stage B 写入「物理项 ∪ adopt 项」**；
adopt **不参与 A / C 阶段**（无旧树、无 `retired/`）。
§11 同步：`op` 加 `adopt`、`reverse_op` 加 `unadopt`，`op = adopt` 时 `tar` / `old_digest` 可为 `null`。

## ② 🔴 `reverse_op: retire-only` 是错的

> 用户原有目录在受管化前后**都应留在 target**；`retire-only` 会把它移到 `retired/`、
> 最终只留 attic，**使 target 缺席**。这不是复位到该代之前的状态。

根因：受管化**本来就没动过那个目录**，反向操作当然也不该动它 ——
我却让它去执行一个物理退役，等于**替用户删掉了他自己的目录**。

v41 定义 manifest 级的 **`unadopt`**：严格通过 `postimage` 后，
🔴 **只撤销 entry、root 与 `requested_by` 边；不移动、不归档、不删除**那个目录 ——
它回到「未被账本认领的同名目录」这一初始状态。混合复位时与其它反向物理项共享同一个新事务。

## ③ adopt 没有入场分类 → 含 adopt 的事务**必然无法 rollback**

v40 把 `rollback.items` 键集扩成了并集，却没给 adopt 一个 `entry_class`；
按「未定义即拒绝」，这类事务直接回滚不了。

v41 复用 **`noop` / `restored`**（无 park、无恢复源、无物理动作），
并把它写进**四张表**：入场分类表、一致性矩阵、反向调度、候选槽表。
正常入场要求 `T == 断言的 digest`。

## ④ 断言失败没有可持久化的 `corrupt` 路径

v40 说「不成立即 `corrupt`」，但 `corrupt` 只对 `journal.items[*].state` 有定义，
而 adopt **明确不是 item** —— 失败**无处记录**。

v41：journal 增加 **`adopt_assertions[<name>].state ∈ { ok, assertion-corrupt }`**，
失败时原子持久化。并按评审建议定成一种**非物理异常**：

- ✅ **允许 `--rollback`** —— 撤回其它物理项与账本 patch；
- 🔴 **始终保留那个用户目录**（`unadopt` 语义）；
- 🔴 **禁止 `--reinstall` 自动隔离或覆盖它** —— 那是用户自己的目录，不是我们的制品。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
