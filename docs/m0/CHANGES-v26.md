# M0 v26 变更台账

Codex 第二十六轮：3 组。**2c / audit 边界已确认一致，不再是阻塞点**
（§5.2、§5.10 与 CLI 三处口径统一）。

## ① `repair_ledger_image` 的语义落差与计算时点

| 评审 | v26 |
|---|---|
| 🔴 普通 `ledger_image` 里「键缺席 = 不 patch、`null` = 删键」，repair 却定「closure 内缺席 = 应不存在」—— **两者不能说成同一套 patch 规则**（v25 的说法错） | 列表说清两套语义的差别，并给**物化规则**：closure 内 `post` 缺席的键 → 物化成普通 image 的 **`null` 删除哨兵**；closure 内存在 → 照值写；🔴 **closure 外的键一律不出现在 child 的 image 里** |
| 没规定谁、何时、按哪个快照算 closure | 🔴 **repair 第 ① 步、任何隔离之前**算并持久化；输入 = 原 journal 的 `ledger_image`（pre ∪ post）+ 当前 ledger；在 **root ↔ entry 二部图**上取**不动点闭包** |
| 没要求当前投影 == `pre` | 🔴 **当前账本在 closure 上的投影必须精确等于 `repair_ledger_image.pre`**，否则 `corrupt` |
| 与 §5.8.1 的 `E_N/R_N` 关系 | 不冲突但要分清：那是**已完成 generation 的历史基线**，repair closure 是**此刻**的现场闭包。另定：child 的 `ledger_image.pre` == **隔离完成之后**的实际投影，`post` 是唯一最终投影 |

## ② 🔴 映射表的键选错了

v25 用「原 op × 是否隔离」做键，**推不出该做什么**。评审三个反例全部成立：

- 原 `install-new` 且 target 已隔离 → **target 已经不存在**，映射成 `retire-only` 执行不了
  （`retire-only` 的 `planned` 段要求原位有待退役的树）；
- 原 `install-new` **尚未落位**、target 未隔离且不存在 → 应重做 `install-new`，v25 没这行；
- 某项**物理已成功、账本仍停在 `pre`**（另一项 corrupt 导致第 9 步没跑，**正常可达**）→
  v25 归成「不进 child、pre/post 同值」，留下**树是 post、账本是 pre** 的撕裂。

v26 改用**两个实测量**做键：

```
phys = 隔离后该 name 的物理起点 ∈ { 无树, 旧树在原位, 新树在原位 }
ledg = 原账本对该 name 的提交状态 ∈ { pre, post }
```

六格全覆盖，并**新增 `logical-only` 这个 child op**（只 patch 账本、不做物理动作）——
它正是 v25 两个漏格（「无树 + post」「新树在原位 + pre」）的正确答案。

另按评审要求补 🔴 **`restore_from`**（`artifact` / `snapshot` / `tree_digest` / `source`）——
v25 单个 `artifact` + `tree_digest` **分不清要装的是旧树还是新树**。

## ③ child 状态机的三处补齐

| 评审 | v26 |
|---|---|
| `committed:true`、journal 是 `completed` 残留、tx 已清 —— **正常清理末尾的可达状态** | **先按 `completed` 清掉该 journal**，再做最终重验 |
| `committed:true`、**tx 仍在但 journal 不在** | 🔴 **`corrupt` 停机**，不得落入「只恢复 child」那句泛化 |
| 双向校验只覆盖 journal | 扩为**四项**：外加 🔴「若 `ledger.transaction` 存在，必须属于 `child.generation`」 |
| `committed:false` 的 pre-commit 清理 | 🔴 除清 tx，还必须按双文件规则**清掉该 child 的 `ledger.transaction`** —— 否则重绑 generation 后留下旧 transaction |
| 缺 `state` × `child` 的合法组合表 | 补：五种合法组合逐一列出（含 🔴 `isolated` 时**磁盘上不得有任何 child 残留**），**其余一律 fail-closed** |

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
