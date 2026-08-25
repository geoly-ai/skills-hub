# M0 v10 → v11 变更台账

Codex 第十一轮：**P0-2 维持关闭；幂等前向恢复的方向被认可**
（并确认 `swapped → verified` 的重跑本身安全 —— 纯读校验、校验成功才写 checkpoint）。
P0-3 未关，4 组最小阻断集合。

## ① 段状态机

| 评审 | v11 |
|---|---|
| §5.3 仍要求持久化 `retiring`，§5.4 又取消它 —— 崩在该 checkpoint 后会落进 v10 不承认的状态 | 🔴 §5.3 删掉 `retiring` 那一步。`planned` 段直接覆盖「② rename + 两次 fsync」，靠幂等重跑处理中途崩溃 |
| rename 四分支**只验目标 `Y`，不验源 `X`** —— `Y` 已正确但 `X` 被外部重建时仍会 rename 覆盖它 | 改为**两端都验**的五分支：`Y` 正确**且 `X` 缺席**才算完成；`Y` 正确但 `X` 也在 → `corrupt`；`X` 摘要不符 → `corrupt` |
| `rmtree` 的「天然幂等」不足以证明回滚安全 | 补：一旦进入 `cleanup=tar_durable`，`R` 可能已是部分树，**不得再对 `R` 做三方比对**，只重验 `A == old_digest` 再续删 |

## ② rollback

**评审的正常崩溃反例**：`cleanup=tar_durable`、`rmtree(R)` 删到一半，此时 `A=old`、`R=partial`。
v10 只在「清理已做完」时才从 `A` 解回，于是这个点会**把部分 `R` 直接 `R→T`**，
再照 `ledger_image.pre` 写账本 —— **错误复位**。

v11：

- **入场预检**（在持久化 `direction=rollback` **之前**）：逐项判断需要 `R` 还是 `A`；
  凡需要 `A` 的先验 `A` 存在且 `== old_digest`。任一不满足 → **拒绝整个 rollback**，
  不开始一个注定做不完的回滚。
- **反向段按 `cleanup` 精确分支**：`R != old_digest` 时先在 `.geoly` 内清干净 `R`、
  从 `A` 解并验，再 `R→T`。
- 补**反向 checkpoint 的 journal 契约**（`rollback.items.<name>.state`）与
  **终结顺序**：算 `next_generation` → 写 `pre` → `transaction=null` → 重算 lockfile
  → 清 `undo/` 与 tx → 清 `direction`、`phase=completed`。v10 只有叙述没有契约。

## ③ ledger 与 §5.8

| 评审 | v11 |
|---|---|
| `ledger_existed=false` 时 journal 成功、ledger 未成功 → patch **没有基底可打** | 🔴 规则：**首次安装必须「先成功写出 ledger 骨架，再写 journal」**（骨架含 schema/target/空 entries/空 roots/generation）。骨架写失败即终止。⚠️ **原文「此时磁盘上什么都没发生」已被 v22 废止** —— 见 [`11-wire-contract.md`](11-wire-contract.md) §5 |
| v10 新增的 `frozen_attic` 不在 image 覆盖范围 | 纳入 image；冻结记录进 `post`，回滚随 `pre` 撤销，与本次 attic 的产生**原子关联** |
| 🔴 **§5.8 不可实现** —— 事务收尾后 tx 与 completed journal 都被清掉，「该 generation 记录」不存在；光有 tar 拿不到 `old_digest`，更恢复不了 entries/roots/snapshot/refcount | 补**每代 manifest** `attic/<N>/manifest.json`：tar 映射、`old_digest`、`op`、以及复位所需的 `ledger_restore`（entries/roots/snapshot）。在 §5.6 ③ 之后 ⑤ 之前写入并 fsync，与 tar 同生共死。并定清「复位某代」影响该 manifest 里**全部**条目，要只复位一项用 `--only <name>` |

## ④ lockfile

| 评审 | v11 |
|---|---|
| 🔴 `root-key == artifact` 与 `direct:` 的 grammar 冲突，**项目级 direct 安装会被自己的闭包规则拒掉**；`all@snapshot` 又没有 artifact | 改为三种精确关系：`pack` → 相等；`direct` → `root = "direct:" + artifact`；`all` → 无 artifact，只校验专有 record |
| `allow_yanked` 已从示例移除，正文却仍称「lockfile 里记着它」 | 统一为**没有这个字段** |
| 「未 yank」只是威胁模型里的愿望，不是校验 | 🔴 新增**当前状态门**：对 lockfile 物化的每一个制品，还必须过**当前** timestamp 所指快照的 yank / degraded 门。闭包只证明「与某张历史签名快照一致」，不代表现在还能装 |
| 13b 的对手界定 | 从泛称 A 收紧为「**能使受信任 checkout 发生该修改的人**」—— 外部投稿者做不到这件事 |

## ⑤ 跨文件

- 00 的版本号 v9 → v11，补齐 v10/v11 台账链接。
- 09 的 `--continue` 说明从「恢复矩阵」改到**段模型**；`--from-generation` 说明改为按
  attic manifest 复位并补 `--only`。
- §5.6 里把 item state 误称为 `phase` 的措辞已改；引用不存在的 §5.4.3 → §5.4.2。

## 仍然开放

Q4、Q5、Q6、Q10、`ExperimentalWarning` 抑制方式实测。Q12 是 M1 的阻塞门。
