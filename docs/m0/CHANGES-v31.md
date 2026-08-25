# M0 v31 变更台账

Codex 第三十轮：**「补完这 4 组后我认为可以通过 M0」**。逐条改如下。

评审同时确认：矩阵**基本闭合、未见其它正常可达态被误杀**；第 6 行**不会循环**
（`false → true` 单调，原子写失败按实际磁盘状态重试，不构成状态环）；
`tx.fingerprint` 的双全树扫描在 `--reinstall` 路径**可接受**，
**没有更轻的同等强度替代**（inode / mtime / 缓存摘要都挡不住同权限改写）。

## ① 矩阵的两处

- 第 10 行先清 `transaction` 再写 `completed`，因此**最终必到第 13 行**（不是第 12 行）——已改。
- 🔴 `0` / `0′` / `1` 三条**互相重叠**，与「逐行唯一匹配」的说法冲突 ——
  提出来单列为**优先级前置守卫**（先跑守卫，全过再进矩阵），不再混在表里。

## ② 🔴 「重测之后、child `prepared` 之前」的窗口

评审：外部可在该窗口改动 target，而普通 child 会**把此刻实测到的值写成自己的 `old_digest`** ——
于是**把一棵外部的树当成旧树退役掉**。

v31 的修法**不是**在 child 提交后再重测（那会把合法的 `install-new` 起点判死），
而是**让 child 继承期望值**：

- 🔴 child 的 `swap` / `retire-only` 的 `old_digest` **必须继承 repair plan 的期望旧摘要**，
  **不得**用此刻实测值替代；
- 🔴 在**写 child `prepared` 之前**、以及**首次 `T→R` 的动作点**，都要求 target 仍等于该期望值。

窗口被两个动作点夹住，child 提交后也就不需要再重测 `cur`。

## ③ 🔴 `tx.fingerprint` 用错了算法

`geoly-tree-v1` **只覆盖文件叶子**。而制品**禁止空目录**、tx 的 `stage/` 与 `retired/`
**恰恰可以是空的** —— 空目录被删掉，摘要一模一样，「精确匹配」不成立。

v31 定义 **`geoly-tx-v1`**：在 `geoly-tree-v1` 基础上**把规范化的目录项也纳入摘要**
（`d\0path\0` 形式，含空目录），域分离前缀独立。

## ④ `restore_from` 漏了一种来源

评审：缺 `quarantine/<gen>/tx/` 内的已验证来源，尤其 `stage/<name>` ——
🔴 **原事务崩在 stage 尚未移入 target 时，那里可能是 `D` 唯一的本地副本**，
而 v30 的三种 source 会在离线或资产取不到时**无谓地转人工**。

v31 新增受限的 **`quarantine-tx`** source：限定 journal 可解释的
`stage/<name>` / `retired/<name>` / `undo/<name>` 三个槽位，**无跟随打开**，
**取用前与落位后各重算一次**，都必须 == `target.digest`。

同时按建议**删掉 `restore_from.snapshot`** —— 它恒等于 `plan.snapshot`，
冗余字段只会制造第二份真相。

## ⑤ v30 引入的两处自相矛盾

| 矛盾 | v31 |
|---|---|
| 六步里写 planned intent「只含 target 与 old_digest」，字段集表却要求还必须有 `plan.snapshot`、`repair_ledger_image`、四项 `isolate` 身份 | 六步改为指向字段集表，口径统一 |
| 第 ④ 步漏写「同次原子加入 `restore_from`」 | 已补 |
| 「child journal 存在后不再校验 target」与 `logical-only` 的「每次重放前复验 target」冲突 | 明确 🔴 **`logical-only` 是该规则的唯一例外** —— 它没有物理动作，因此在**提交账本之前**必须复验断言；其余三种 op 在 journal 存在后一律按 §5.4 段模型恢复 |

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
