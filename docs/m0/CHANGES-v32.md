# M0 v32 变更台账

Codex 第三十一轮：4 处。评审同时确认三件事已成立 ——
`geoly-tx-v1` **用目录项覆盖空目录是必要的**；v31 的**两次期望值校验能封住那个窗口**；
`0/0′/1` 改成优先级守卫**解决了「逐行唯一匹配」的直接矛盾**。

## ① `geoly-tx-v1` 的定义还不够严

评审：排序本身无歧义（合法树里同一相对路径不可能既是文件又是目录），
但**一边说纳入目录项、一边覆盖范围只写「全部普通文件」**——自相矛盾。

v32 补齐：

- 枚举范围 = 🔴 **全部非根目录的目录 + 全部普通文件**；
- 目录项**带 mode**（强制 `0755`）；
- 排序键明确为 **`(path_bytes, kind)`**，`kind` 序 `"d" < "f"`；
- 🔴 一律拒绝 socket / FIFO / 设备 / symlink / **hardlink（`nlink != 1`）** / 其它类型；
- 🔴 一律拒绝重复路径与「同路径双类型」；
- 与 `geoly-tree-v1` **复用同一实现模块**。

并按建议在 §01 补了**适用边界**（新增 §6.2.1）：`geoly-tree-v1` 只证明制品的文件叶子
（因为制品禁止空目录），**不得用于 tx**；tx 用 `geoly-tx-v1`。

## ② 🔴 「`old_digest` 取实测值」与 repair-child 的继承要求打架

v31 只在 §5.10 写了「继承期望值」，而 §5.2 第 6 步与 §5.6 的全局文字仍要求它是**实测**值。

v32 明确 **repair-child 是该通则的例外**，并把三件事写死：

- `expected_old = plan.items[<name>].old_digest`（来自原 journal 的已验证值）；
- 写 child `prepared` 前实测**必须等于**它；
- 🔴 **写进 child journal 的仍是 `expected_old`**，不是实测值。

另按评审澄清：「首次 `T→R` 动作点校验」**就是 §5.4 五分支里 `planned` 段的源端校验**，
**不是另加一次独立断言**，恢复重跑沿用同一分支 ——
因此 `logical-only` 仍是**唯一**的「提交账本前复验 `target`」例外。

## ③ 🔴 `quarantine-tx` 会松动隔离语义

v31 允许从隔离区取用，却**没规定能不能移动它** —— 与「quarantine 不自动删除、保留证据」冲突。

v32 把它定成**只读恢复介质**：

| 项 | 规定 |
|---|---|
| 定位 | 新增 `slot ∈ {stage, retired, undo}`，🔴 路径由「当前 repair generation + item name」**推导**，**不接受自由路径** |
| 前提 | 🔴 原 journal **完整**且该 slot 在 journal 里**可解释** |
| 取用 | 🔴 **无跟随复制**到 child stage；**禁止 rename、hardlink、以任何方式修改 quarantine** |
| 校验 | **复制前 / stage 完成后 / 最终落位后**三次都必须 == `target.digest` |

隔离区因此始终**原样、只读、可取证**。

## ④ `journal` 的观测范围未定

评审：同时存在 child journal 与他代 journal 时，四元组**没有唯一输入** ——
「完整优先级矩阵」的宣称不成立。

v32 增加守卫 **0″**：🔴 **存在任何不属于 `child.generation` 的 journal 残留即 fail-closed**
（等价于 §5.2 的「无关残留」前置检查）；守卫之后，矩阵里的 `journal` **专指 child 那一份**。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
