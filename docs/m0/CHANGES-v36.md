# M0 v36 变更台账

Codex 第三十五轮：**三条指定故障路径全部确认修好** ——

| 路径 | 结论 |
|---|---|
| 正向 `planned` 段中断（`T→R` 已做） | ✅ `R=old` 会移回 `T`，不再随 tx 清理丢失旧树 |
| `rollback × swap × pending, R=old` | ✅ `retired(old)` 已成候选，`stage(new)` 被摘要条件排除 |
| 复制后注入 ACL / xattr / hardlink | ✅ ③④ 都会检查；瞬时注入再移除仍不可观测，规范已诚实限定 |

阻塞点变成 v35 新字段还没形成**可执行的闭合契约**，3 项。

## ① 🔴 立了铁律，却没改受它约束的旧条款

v35 的铁律说「不得从正向 `item.state` 推物理位置」，
而**入场预检仍以「`state` 已越过首次 rename」决定是否校验并 park `T`** ——
于是 `swap/planned` 实际已落到 `T=new, R=old, S=∅` 时，**漏掉了对 `T` 的入场校验**。

v36 把这一条也改成**按实测判定**：
`T == new_digest` → 需 park；`T == old_digest` → 不需 park；两者都不是 → `corrupt`；缺席 → 不需 park。

## ② `rstate` / `entry_class` 只有枚举，没有闭合契约

评审确认两者**概念上不冗余**（前者是回滚进度、后者是入场物理分类），
但缺 `op × 实测 T/R/S/A × entry_class × 初始 rstate × 合法迁移` 的封闭表，
也没规定必须与 `direction=rollback` 同一次原子写 —— 于是两字段可以互相矛盾。

v36 新增**入场分类封闭表**（三种 op 各一张，共 11 行 + `corrupt` 兜底），
给出每一格的 `entry_class` / 初始 `rstate` / 是否 park `T` / 恢复源；
并给出**合法迁移**（`as-swapped` 系列才有 `t_parked`）。

🔴 **`direction = rollback` 与全部 `entry_class` / 初始 `rstate` 必须在同一次原子写里落盘**，
写完才允许动手；🔴 **正向 `item.state` 只用于一致性校验，不参与判定**。

并补上 journal 的严格嵌套 schema：`direction` 与 `rollback` 必须同时出现；
🔴 **`rollback.items` 的键集必须与 `journal.items` 完全相同**；两字段都必填。

## ③ 候选槽表还没纳入 `entry_class`，仍有重叠

v35 用「原项 `planned` / `restored`」当键，两处矛盾：
`install-new` 的两行**区分不了 stage 与 undo**；
`retire-only` 把 `pending` 与 `restored` 合写，却又说 restored 后没有候选槽。

v36 把 `direction = rollback` 的候选槽**改以 `entry_class` + `rstate` 为键**（9 行），
重叠与矛盾一并消除；`as-installed` 全部标为「不适用」（回滚目标是无树，没有恢复介质）。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
