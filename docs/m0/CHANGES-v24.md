# M0 v24 变更台账

Codex 第二十四轮：3 组，全部集中在 repair 的**数据契约**与 child 的**运行时状态机**。
评审同时确认：历史原子写口径、2b-1/2b-2 的文字优先级、quarantine 的挂载/symlink/水位纳入
**均已一致**；quarantine **不会**形成「有它就永远不能 reset」的死结
（拦截 reset 的是未完成的 `repair-intent`，方向正确）。

## ① 🔴 规范会拒绝自己的 repair-intent

`plan.roots[k] = null`、`child = null` 都不在 §11 的 `null` 白名单里 ——
严格解析器会把一份**合法的** repair-intent 直接拒掉。

v24：这三处（含 `ledger_baseline` 内需要表达缺席的 map）**一律改用「字段缺席」**，
并在 §11 就地写明。

## ② 四项隔离还不是可恢复的整体

| 评审 | v24 |
|---|---|
| 物理实况表只覆盖三个 rename；`ledger.transaction` 只有一个布尔 `ledger_had_transaction`，**判不出崩溃后看到的是原事务、已清空、还是不匹配的值** | 四项各记**可验证身份**：`tx.fingerprint`、`journal.digest`、🔴 `ledger_transaction.digest`（旧 transaction 值的 canonical 摘要）、每棵 target 的观测指纹。<br>`transaction` 单独一张表：摘要匹配 → 置 `null`；已是 `null` → 跳过；🔴 **既不匹配又不是 `null` → `corrupt`**（有第三方改过账本） |
| 🔴 **被隔离的 corrupt target 本来就不该匹配 plan 里的期望摘要** —— 拿期望值验它是逻辑错误 | `isolate.targets[*].observed` 明确记的是**实际观测指纹**，不是 plan 的期望值 |
| 恢复判据 | 只接受「原位置**精确匹配**」或「隔离位置**精确匹配**」；两边都在 / 都不在 / 身份不匹配 → `corrupt`。进入 `isolated` 前**重验四项全部到位** |
| 🔴 child 的物理操作映射未定 | 新增 `plan.items[*].child_op`：target 已进 quarantine 后，原 `swap` **不能**作为 child 的 `swap` 重放（原位已无旧树可退役），必须显式转成受 `ledger_baseline` 约束的 **`install-new`** |

## ③ child 生命周期与 2b/2c 不闭合

**评审指出的直接矛盾**：一处要求「2c 前无未完成安装事务」，另一处要求「2c 后启动/继续 child」——
child 已 `prepared` 时两者不能同时成立。

v24 定为：

```
无 child        → 先过 2c 归档 → 才登记并创建 child
已提交的 child  → 直接恢复它，**跳过 2c**（归档与 child 不交错）
```

并补两个缺失的崩溃分支：

| 缺口 | v24 |
|---|---|
| child 在 journal 提交前崩溃：清掉 pre-commit `tx-<child-gen>` 后该 generation 不可复用，而 intent 又永久绑住它 | `child.committed: false` 时清掉 pre-commit tx，🔴 **然后先持久化重绑一个新 generation**（水位只增、旧号作废），才允许再建 child |
| child 已完成、intent 尚未删 —— 没有验证与收尾路径 | 🔴 child 跑完 **重验最终 ledger 与目标树是否符合 `plan`** → 通过才写 `child_done` → 再写 `done` → 删 intent；新增 `child_done` 的恢复分支（只重做删除） |

另按建议：🔴 **child journal 必须带父 repair 的不可变标识 `repair_id`**，
不能只靠目录名认领。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
