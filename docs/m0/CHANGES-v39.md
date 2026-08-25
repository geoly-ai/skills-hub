# M0 v39 变更台账

Codex 第三十八轮：最小阻断集合**只剩两处正文修订**。
并确认 `planned` / `retired` / `swapped·verified` 的映射与 `state=corrupt` 不入表**处理一致**、
`as-installed` 收紧为 `pending / restored` **正确且无新增问题**。

## ① 🔴 一致性矩阵与清理协议自相矛盾

> `swap` / `retire-only` 在 `state=done, cleanup=tar_durable` 时，
> `retired/` **可能仍是完整旧树**，也可能已被递归删除到部分或空。
> 现表只允许 cleaned 类，**和清理协议矛盾**。

`tar_durable` 是 **checkpoint**，而**递归删除发生在它之后**（§5.6 阶段 C）——
所以那一刻两种物理现场都合法，我却只列了一种，会把正常态判 `corrupt`。

v39：`tar_durable` 一行**同时允许未清理类与 cleaned 类**；
只有 `cleanup = done` 才收紧为 cleaned 类。

另一处：`install-new` 的表**没有 `cleanup` 维度**，
而它的 `done` 可以合法对应缺席 / `tar_durable` / `done` 三种
（§5.6 对 `install-new` 是空操作，但 `cleanup` 字段本身仍会依次经过）。
既然规定「未列即 `corrupt`」，v39 把三种**显式列出**，其余 state 只允许 `cleanup` 缺席。

## ② §4.2 的 ledger-only 分支必须走 journal

评审确认它与禁令、候选槽表、schema **语义上相容**，空 `items` 也与空 `rollback.items` 相容 ——
**但必须走 journal**，v38 那句「只写账本」会被误实现成「原子写一次 ledger」。

v39 定死四条：

| 项 | 规定 |
|---|---|
| 流程 | 按既有**空 items 语义**走 `prepared → post patch → cleanup_pending → completed`，带 `ledger_image`；🔴 **照常生成 `items: {}` 的 manifest**（否则这一代不可复位） |
| 🔴 `ledger_image` 覆盖面 | 含新增 entry、**其对应 root**、`requested_by` 边、generation 等全部实际变化 —— v38 只写 entry 与 `requested_by`，会留下**悬挂的 root 关系** |
| 🔴 提交前复验 | 写 ledger post **之前再验一次**目标断言（复用 `logical-only` 的规则）；否则外部在初验后改树，账本会**认领错误内容** |
| 🔴 「严格验明」的含义 | **不只是** `geoly-tree-v1` 摘要相等 —— 它**不覆盖空目录与部分元数据**。还须过最终结构与元数据约束：目录、空目录、类型、mode、无 xattr / 无 ACL、`nlink == 1` |

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
