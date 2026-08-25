# M0 v13 → v14 变更台账

Codex 第十四轮：P0-2 维持关闭。**rollback 终结顺序与 pending 段判定为已修好、可维持关闭**
（只要求补两句：每次递归删除后 fsync 父目录；`unpack/` 残留的幂等规则）。
剩 3 组 P0，全部具体可执行。

## ① null / absence 契约补全

评审列出 v13 漏掉的四处，补齐后「严格解析器」与「恢复语义」才能同时成立：

- `journal.ledger_image.{pre,post}.frozen_attic` —— 04 明定它进镜像且可表示「原本不存在」，wire 没允许；
- `attic-manifest.ledger_delta.frozen_attic` —— v13 用 `.*` 模糊覆盖，不符合「逐项列出」；
- 🔴 `postimage.entries[k]` / `.roots[k]` —— 必须能表示「该键当时**应不存在**」，
  否则 `retire-only` 之后根本无法比对 absence；
- 🔴 `postimage.digests[name]` —— 改用**显式 tagged 形式**
  `{"present":true,"digest":…}` / `{"present":false}`。
  「目标应缺席」是一个**正面断言**，不该和「字段忘了填」共用同一个表示。

## ② `postimage` 形式化（v13 只说了「受影响闭包」四个字）

评审的关键指认：**G1 的 `a` 若被之后新增的 root `P → a` 引用，
只过滤「G1 当时记录的 root」是看不见 `P` 的** —— 反例照样漏过去。

v14 新增 §5.8.1，定死：

```
touched_entries = 本代 items 里的全部 entry name
touched_roots   = 本代 delta 里的 root
              ∪  当前账本里**任何**指向 touched_entries 的 root   ← 关键
touched_frozen  = 本代 delta 触及的 frozen_attic label
```

`postimage` 记录：每个 touched entry / root 的值（或 `null` 表示当时应不存在）、
🔴 **每个 touched entry 的全部入边与每个 touched root 的全部出边**（不是只记本代产生的边）、
`frozen_attic` 的 touched 键、以及每项的 `{present, digest}`。

比对 = 把当前账本按同样投影算一遍、逐项相等。不等 → 报冲突并**列出具体键/边**。

🔴 **「先复位更近的代」降级为条件提示，不是承诺** —— 更近的 manifest 可能已被保留策略删掉，
或冲突来自人工改动，那时旧代确实不能自动复位，如实报告需要人工处理。

**提交方式**：比对通过后，`ledger_delta` 作为这次新正向事务
`ledger_image.post` 的一部分提交，走完整事务纪律，**不是模糊的「收尾 patch」**。

## ③ `--from-generation` / generation reset 的可执行契约

| 评审 | v14 |
|---|---|
| 🔴 同一页里一处写「解 tar 后按普通 swap」，一处又定义了 `reverse_op` —— 自相矛盾 | 改为**逐项按各自 `reverse_op`** 并给出三行对照表；特别标出原 `install-new` 的反向是 `retire-only` 且 **`tar = null`，没有可解的东西**，靠 retirement rename |
| 要求把 yanked/degraded 复位告警写进账本，但**账本 schema 没有该字段**，严格未知字段规则会拒掉它 | 账本 entry 新增只增数组 **`audit`**（`installed-yanked` / `restored-yanked` / `restored-degraded` / `restored-state-unknown`），并把 `frozen_attic` 一并补进账本示例 |
| 离线时当前状态未知怎么办没定 | 记 `restored-state-unknown` 并大声告警，**不得假定「没被 yank」** |
| generation 缺失判据只查了 ledger/attic，漏 `journal/`、`tx-*` | 补上 |
| `--reset-generation` 在 CLI 里**根本没定义** | 新增 §5.9 完整契约：仅水位缺失时可用、持 target 锁、有未完成事务先拒绝、`<N>` 必须高于所有可观察值、写入的是水位值下一代为 `N+1`。🔴 并明确诚实边界：**没有任何状态证据时只能承认「历史已不可证明」，不得声称此后仍保持「永不复用」** |

## ④ 两处跨文件矛盾

- 06 仍写「signature bundle 由 release bot 事后 commit 归档」，与「禁止直推（含管理员）」
  和「timestamp 只经普通 PR 归档」冲突 → 统一为：**bundle 作为 release 资产分发，
  归档副本一律走普通 PR，没有任何 bot 直推**。
- 08 把已完成事务的 attic 复位指向 §5.5 → 改指 §5.8。

## ⑤ 评审确认已修好的（记下来，避免下轮重复讨论）

- rollback 五步终结可崩溃续做；第①步删本代 attic 后崩溃也安全
  （此时所有项已 `restored`、旧树已回到 target、attic 已非恢复源）。
- 新 pending 顺序消除了「先毁 `R`、再发现 `A` 坏了」这条最后旧树丢失路径。
