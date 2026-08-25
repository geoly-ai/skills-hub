# M0 v25 变更台账

Codex 第二十五轮：3 组。评审同时确认两件事：
**三个 rename 项的崩溃中间态已覆盖**、`ledger.transaction` 与它们**不需要固定先后顺序**；
**「已提交 child 时跳过 2c」不会重新引入饥饿**（child 完成、intent 删除后，
下一次新事务仍必须经过 2c）。

## ① 四项缺「同事务绑定」

分别核验摘要**不够**。v25 补：

- `tx` 目录名、`journal` 文件名、`ledger.transaction` 里记的 generation，
  三者**必须都等于 `intent.generation`**；
- `journal` 内容必须与该 `tx` 对应（journal 里的 `tx_dir` == 实际隔离的那个）；
- 任一不一致 → **`corrupt` 停机**（现场混进了别的代的残留）。

另补：🔴 **清空 `transaction` 时只改这一个键**，用 §11 的 patch 语义，
保证 `entries` / `roots` / audit plane / `frozen_attic` / `last_applied_generation`
**未被覆盖或漂移**。

## ② 🔴 物理操作改了、账本语义没跟着改 → 回滚必然撕裂

评审点出的后果：物理 `install-new` 若仍以旧 `swap` 的 ledger preimage 为基线，
之后从该 child generation 回滚会**删除目标树、却恢复旧 entry/root** ——
**账本与目标树必然不一致**。

v25 两处一起改：

**其一**，`ledger_baseline` 换成 **`repair_ledger_image`**，把 v24 没定义的三件事定死：

- `closure_entries` / `closure_roots` **显式列出闭包的 key 集** ——
  于是「不在闭包」= 不在数组里；「应不存在」= 在数组里但 `pre`/`post` 中该键缺席；
- `pre` / `post` 语义与 §5.4.2 的 `ledger_image` 一致，走同一套 patch 规则。

**其二**，补**完整的 op → child_op 映射**（v24 只写了一条）：

| 原 op | target 被隔离 | `child_op` | `post` 里该 entry |
|---|---|---|---|
| `swap` | 是 | `install-new` | 🔴 **按 install-new 语义写，不得沿用 swap 的 preimage** |
| `swap` | 否 | `swap` | 照常 |
| `retire-only` | 是 | `install-new` | 存在 |
| `retire-only` | 否 | `retire-only` | 缺席 |
| `install-new` | 是 | `retire-only` | 缺席 |
| 🔴 已成功、未被隔离的项 | — | **不进 child plan** | 但 key 进 `closure_*`，`pre`/`post` 记同值（用于比对不漂移） |

并定义**共享 `requested_by` 边**：root 同时指向未被隔离的 entry 时，该 root 进 `closure_roots`，
`post` 只增删与本次相关的那条边，其余边原样保留。

## ③ child 子状态机漏了三条真实崩溃路径

| 路径 | v24 的行为 | v25 |
|---|---|---|
| `committed:false` 已登记、**tx 还没建**（无 tx 无 journal） | 未定义 | **沿用该 `child.generation` 创建 tx**（号已登记、水位已推进，不必重绑） |
| 🔴 child journal **已提交**、父 intent 还没写 `committed:true` | **误归为 pre-commit → 清掉一个已提交的事务** | **先把 `committed` 补写成 `true`**，再正常恢复 |
| `committed:true` 但 tx 与 journal **都已不在**（child 跑完并清理，崩在最终重验前） | 未定义 | **直接做最终重验**，通过就前进，不通过 `corrupt` |

另补：

- 🔴 **双向校验**：认领 child 时 journal 的 `repair_id` / `generation` / tx 目录名
  必须与 intent **互相对得上**，任一不符即 `corrupt`；
- 🔴 `child_done` **先写 `done` 再删 intent** —— v24 的「只重做删除」跳过了
  `child_done → done` 这一跳。

## ④ 2c 与 audit 边界的措辞统一

09 仍写「repair 完成后才进 2c」，与 v24 的「无 child 时在登记 child 前进 2c」冲突；
且与「repair 全程排除 audit plane」的字面表述冲突（2c 本身就要归档）。

v25 统一为：**2c 是外层流程在「`isolated` 且尚未登记 child」这个边界执行的一次独立 audit 操作；
repair 的其它子步骤一律不触碰 audit plane。** 04 与 09 同步。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
