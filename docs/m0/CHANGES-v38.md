# M0 v38 变更台账

Codex 第三十七轮复核确认：**正式 rollback schema 已在规范正文**
（iff、空但必填的 `rollback.items`、严格同键集、6 值 `entry_class`、终结同次原子删除**均已落实**，
且与入场表、合法迁移、终结步骤一致）；**9 类入场物理态归约为 6 个 `entry_class`，
6 行反向调度全覆盖、无缺调度类**；候选槽表 v37 的三处修正**均正确**；
`old_digest == new_digest` 的禁令**对正常受管升级不误伤**。

剩 3 项。

## ① 一致性矩阵少了一个维度

标题与正文都说「用正向 `state` 做校验」，而表里**只有 `op → entry_class`** ——
**实现不了 fail-closed 校验**。

v38 补成 **`(op, 正向 state, cleanup, entry_class)` 的闭合矩阵**（三种 op 各一张）：
覆盖 `planned` 的两种（动作未做 / 已做但 journal 未跟上）、
`retired` 的两种、以及 `done` 按 `cleanup` 分出的 `*-cleaned`。
`state = corrupt` 不在表内 —— 入场检查已规定任一项 `corrupt` 则整个事务不允许 rollback。

## ② `as-installed` 的 `rstate` 写「任意」过宽

与合法迁移冲突（`as-installed` **没有 `t_parked`**）。收紧为 `pending / restored`。

## ③ 🔴 新禁令截断了旧承诺

评审：禁止物理 `swap` 的 `old_digest == new_digest` 之后，
会拒绝「**旧目录恰好是目标制品逐字节副本**」的合法 `--replace` ——
**「`--replace` 是出口」这个既有承诺在此被截断**。

v38 在 §4.2 补一条分支：该未认领目录**经严格验明**树摘要 == 目标制品的 `tree_digest`
（同一套算法 + 满足载荷规则）时，**不构造物理 `swap`**，
改为建立 **`items: {}` 的 ledger-only 事务**把它受管化 —— 只写账本，不做物理动作。

## 编辑纪律：assert 这次立刻起作用了

v37 起要求「动规范正文的替换一律带 `assert anchor in s`」。
本轮第 3 项的第二个锚点**当场没匹配上**，脚本在 `write_text` 之前中止 ——
**没有出现「改了一半」或「台账说改了、正文没改」**。
补对锚点后重跑，并用 `grep` 计数确认落地（2 处）。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
