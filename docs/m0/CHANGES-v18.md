# M0 v17 → v18 变更台账

Codex 第十八轮：P0-2、P0-3 维持关闭，剩 3 个 P0，并明确 **「修完后可以通过 M0」**。

## ① 🔴 audit 换了地方住，还是会被拆（同一模式的第三次）

**评审**：v17 把 audit 搬到顶层，解决了「随 entry 删除」，但
`ledger_image` **明确包含 audit**，而 `--rollback` 按 `pre` 复位；
**bootstrap rollback 更会直接删掉整个 ledger**。

根因是我一直没想透的一句话：**「只增不减」与「回滚到事务前」本来就是互斥的。**
只要 audit 参与 `pre`，它就一定会被回滚抹掉。

v18：

- 🔴 **audit plane 不进 `pre`**，只在 `post` 里以 **`audit_append: [events]`** 出现，
  语义是**追加**（按 `event_id` 去重，天然幂等）；
- `--rollback` **不撤销任何已记录的 audit**；`--reinstall` 同样保留；
- 🔴 **bootstrap 收尾的「删除整个 ledger.json」加例外**：
  若存在 live audit / `audit-archive/` / audit intent → **不删**，
  改写一份合法空账本继续承载 audit plane；
- 🔴 **`audit-archive/` 永不受 `--keep-generations` 清理** —— 它是审计历史，不是可丢弃的备份；
- README 的措辞收紧：🔴 **`git clean -xfd` 会删掉整个 `.geoly/`**，
  那不只是「进行中的事务状态」，**还包括本地审计历史**。

## ② `audit-seq` 的缺失 / 损坏 / 上限 / 空批次

评审：删掉 `audit-seq` 后，若 live audit 或 archive 仍在却从零初始化，
会**复用 `event_id`**，而扫描也恢复不了已烧掉的号。

v18 与 generation 水位同规格：

- 完全没有 audit 状态的 target → 可初始化为 `0`；
- 🔴 否则**拒绝**，报明需人工恢复整份 `.geoly` 状态集，或弃置整个 target；
- 🔴 `event_id` 达 `2^53−1` → **拒绝追加**；
- 🔴 **空批次 = no-op**：不写 intent、不建 archive、不动 cursor。

评审同时确认：归档的三个崩溃点**现在可正确重跑**（前提是 intent 与 archive 都严格重验）；
`seq = to_event` 在正常路径安全 —— target 锁 + 非空前缀删除使下一批 `to_event` 必然更大，
同值只可能是恢复同一个 intent，那时已有文件会被重验、不覆盖。

## ③ bootstrap 骨架写错了字段名

评审：骨架写的仍是顶层 `generation`，不是新字段 —— 既与严格 schema 冲突，
**也会重新诱导实现者把它当水位**。

v18：骨架写 **`last_applied_generation: 0`**，并补 `audit: []` / `audit_archived_until: 0`。
正文别处没有用 `last_applied_generation` 取号（评审已复核）。

## ④ reset 的两条出路写具体

评审确认「ledger 丢失但 attic/audit-archive 尚在时拒绝 reset」是正确且安全的，
但要求写清出路。v18：

- **人工恢复** = 恢复**同一份一致的 `.geoly` 状态集**（ledger + journal + attic + audit 全套），
  🔴 **不是**凭 archive 手工拼一个 ledger；
- **放弃恢复** = **移走整个 target 后重装**（不是只移走 ledger），
  🔴 这会**放弃本地 audit**，必须明示。

## ⑤ P1 跨文件

04 已改可重复 `--only`，09 仍写单数 → 已同步（含重复 name 去重、闭包不完整时的拒绝与列举）。

## M1 开工前必须先做的

1. **Q12**：按具体客户端版本完成四端 × 全局/项目级的 `.geoly` discoverability 验收。
2. 验证 **Node 22.13 与当前 LTS** 的 SQLite 锁行为，以及 `ExperimentalWarning` 的抑制方式。
