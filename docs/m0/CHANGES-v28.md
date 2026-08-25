# M0 v28 变更台账

Codex 第二十八轮：3 组。物化规则被确认「pre/post 分别物化后**确实已经可验**」，
只要求补一个正式定义。

## ① `cur × target` 不可执行 —— 三处欠定义 + 一个时序不可能

| 评审 | v28 |
|---|---|
| `C` 是**任意 digest**，而 `other` 定义成「非旧非新」—— **实现分不出来**；正式字段里也没保存「旧」的权威摘要 | `cur` 的取值域封闭为四个：`absent` / `old` / `target` / `other`；`old_digest` **取自原 journal item 已验证的值**并写进 plan；其余任何完整树、部分树、读不出摘要 → `other` → `corrupt` |
| `target` 没规定由谁、何时、从何导出 | 🔴 repair 第 ① 步，从**有效原 journal 意图 + 已验签 snapshot** 导出，并与 `repair_ledger_image.post.entries[name]` **严格对应**（缺席 → absent；存在 → 其 `tree_digest`）。不一致即 `corrupt` |
| `restore_from` 没绑定 | 🔴 `restore_from.tree_digest` **必须 == `target.digest`**，绑定已验签 snapshot record 或精确的 quarantine/attic 对象，落位后**重算必须等于该值** |
| 🔴 **时序不可能**：`cur` 隔离后才测得，intent 却要**先于隔离**落盘 | 拆两段：`planned` **只写 `target`**（隔离前就能定）；`planned → isolated` 那**一次原子写**才补 `cur` 与 `child_op`；🔴 恢复时**必须重测 `cur` 并与持久值一致**，不一致 `corrupt` |
| 示例仍留着旧的 `op` / `artifact` / `tree_digest` | 已统一 —— 在「严格拒绝未知字段」下，那会让一份**合法**的 intent 被拒 |

## ② 🔴 零 item 的 child 不能把清理当成完全空操作

评审指出的真实缺口：跳过 §5.6 就**不会生成 `attic/<gen>/manifest.json`**，
于是**该 generation 的账本变更永远无法被 `--from-generation` 复位**。

v28：零 item child 的 **A / C 阶段为空，但 B 阶段仍必须写 manifest** ——
带 `items: {}`、本代 `ledger_delta` 与 `postimage`；写完才做 tx / transaction / journal 的收尾。

**「不建 attic item」≠「不建 manifest」。**

## ③ child 状态机不是封闭矩阵

评审：v27 只封闭了 `state × child`，没封闭
`committed × tx × journal.phase × ledger.transaction`，且**多行互相覆盖**
（`committed:true` 的泛化恢复行盖住了 completed 残留与「tx/journal 皆无」两行）。

v28 给 `child_registered` 一张**按优先级从上往下匹配、每格唯一动作**的 12 行矩阵，
三个观测量分别是 journal（无 / valid-prepared·cleanup_pending / valid-completed / corrupt）、
tx（无 / 本代 / 他代）、transaction（null / 本代 / 他代）；**未列组合 fail-closed**。

其中新暴露出来的几格：

- tx 或 transaction 属于**他代** → 一律 `corrupt`（现场混进别代残留）；
- `valid-prepared` 但**无 tx** → `corrupt`（不对称）；
- `valid-completed` 却**还留着 tx** → `corrupt`。

并定死：🔴 **`child_done` / `done` 的三项前置断言优先于整张矩阵判定** ——
否则一个非法的 done 状态会被泛化恢复路径「修好」。

## ④ 物化：补正式定义

评审确认 pre/post 分别物化后**已经可验**，只要求把「投影」写成函数：

```
proj(ledger) = { entries: { k: ledger.entries[k] for k ∈ closure_entries },
                 roots:   { k: ledger.roots[k]   for k ∈ closure_roots  } }
```

并明确：🔴 普通 image 里的 `last_applied_generation` 与**整张** `frozen_attic`
**一律从「隔离后的账本」取值**，不属于 repair image ——
不得笼统说「整个 image 等于 repair image」。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
