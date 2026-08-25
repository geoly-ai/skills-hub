# M0 v37 变更台账

Codex 第三十六轮：入场表的 9 类正常物理态**未见误杀**、合法迁移语义**够**
（`t_parked` 只属 `as-swapped` 系列**是对的**）、`rollback.items` 键集等于 `journal.items`
与 `logical-only` **不冲突**（两者都可为 `{}`）。剩 3 项。

## 🔴 ① 我把规则写进了台账，没写进规范

评审：「`CHANGES-v36.md` **不能替代规范正文**，且 wire contract 明示变更台账不是现行规范。」

核实属实 —— v36 那次 `.replace()` 的锚点没匹配上，**静默什么也没做**。
这是我编辑流程的**第二类静默失败**（第一类是锚点吞掉整节，v29 修过）：

> `.replace()` 找不到锚点时**不报错、不改动** —— 台账里写得头头是道，规范里一个字没有。

v37 起，涉及规范正文的替换**一律带 `assert anchor in s`**，改完再 grep 确认落地。

本次补进正文的：`direction` 与 `rollback` 的 **iff**、`rollback.items` **必填/可空/键集严格相等**、
`entry_class` 的**全枚举**（v36 正文还写着旧的三值，漏了三个新值）、
以及 🔴 **终结时同一次原子写删除 `direction` 与 `rollback` 两者**（v36 只写了「清 `direction`」）。

## ② 入场表还不算闭合的两点

| 评审 | v37 |
|---|---|
| 没禁止 `swap` 的 `old_digest == new_digest` —— 于是「`T==new` 要 park」与「`T==old` 不 park」**无优先级、判不出来** | 🔴 结构门在生成 plan 时**直接拒绝**这种物理 `swap`（它本来也没意义）；并写明 park 最终**以入场表的 `park T` 列为准** |
| 「正向 `state` 只做一致性校验」**没落实** —— 反向执行表仍按 `state = planned` 分支 | 🔴 反向调度**整表改以 `entry_class` + `rstate` 为键**（6 行）；另给 `(op → 允许的 entry_class)` 一致性矩阵，**只做校验、不做调度** |

## ③ 候选槽表 9 行不够，且有错

| 评审 | v37 |
|---|---|
| `as-retired-cleaned + restored` **缺行** | 补，为「无候选」 |
| `as-retired-cleaned + pending` 不能固定为「无」 —— **从 attic 重建 `R` 之后、`R→T` 之前崩溃时，`retired(old)` 是合法候选** | 改为 `retired(old)`；重建之前该槽不存在，**由摘要条件自然筛掉** |
| `as-swapped-cleaned + t_parked` 不能是「无」 —— 此时有 `stage(new) + retired(old)`；其 `pending` 也应保守允许 `retired(old)` | 两行都补上 |

9 行 → **12 行**。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
