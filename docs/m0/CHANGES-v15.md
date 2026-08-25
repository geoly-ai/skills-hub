# M0 v14 → v15 变更台账

Codex 第十五轮：P0-2 关闭；rollback 终结顺序与 pending 段维持关闭。剩 3 组 P0，全部已改。

## ① 🔴 postimage 在时间上不可实现 → 基线固定在收尾那一刻

评审的关键指认：v14 把「当前账本里任何指向 touched_entries 的 root」纳入 `touched_roots`，
再要求 `postimage` 记录每个 touched root 的值 —— **G1 收尾时 `P` 还不存在，
manifest 不可能预先存下 `postimage.roots.P = null`**。

v15 按它给的形状改：基线固定在第 N 代收尾那一刻

```
E_N = 本代 items 的 entry
R_N = 本代 delta.roots ∪ **当时**指向 E_N 的 roots
```

`postimage` 存 `E_N`/`R_N` 的值、🔴 **`E_N` 的完整入边集**、`R_N` 的完整出边集、
`frozen_attic` 与 `{present,digest}`。

后来的 `P → a` **不需要也不能**预存 `roots.P` ——
它会以「`a` 的当前入边集比 `in_edges[a]` 多了一条」被抓住。

两条一并写进规范：

- 🔴 **二部图约束**：当前账本的引用只有 `root → entry`（在 entry 的 `requested_by` 里），
  root 没有指向 root 的字段，因此**没有 root→root 的传递漏项**。
  将来若允许 root→root，本节必须改为不动点闭包。
- ⚠️ 全入边/出边比对**不会**因无关变更误报，但会**保守拒绝**
  「原先引用 `a` 的 root 后来改去引用 `b`」这类后续图变更 —— 可接受的安全保守性。

## ② 🔴 `--only` 没过滤 delta（新发现的 P0）

v14 允许 `--only` 选闭包，提交时却仍写「完整 `ledger_delta`」——
那会让 `--only a` **改到没被选中的条目**。

v15 定义 `selected_items / selected_roots / selected_delta` 的过滤规则，
并规定：🔴 **只要本代 `ledger_delta.frozen_attic` 有变化，就禁止部分复位**
（它是 target 级的、切不开），要求选整代或拒绝。

## ③ null / absence 契约闭合

| 评审 | v15 |
|---|---|
| `postimage.frozen_attic` 可为 `null` 却不在白名单 | 补进白名单 |
| `audit[].advisory` 允许 `null` 也没进白名单 | 🔴 改为**「没有就缺席」**，不加 `null`（评审建议的更好解法） |
| journal 的 `old_digest` / `new_digest` 只说「必须含」，没按 `op` 定义缺席 | 🔴 按 `op` 定必填/缺席三行表：`install-new` 无 old、`retire-only` 无 new。**不补裸 `null`** |
| manifest 示例仍把 `postimage.digests` 写成裸 digest，与 tagged 契约冲突 | 示例改为 tagged，并补 `in_edges` / `out_edges` |
| 要不要把所有 absence 都改 tagged | **不要**。`entries`/`roots`/`frozen_attic` 是「已枚举 key 的状态值」，`null` 够用；只有**物理目录摘要**用 tagged。真正的要求是**每个 map 的 key 集必须可定义** —— §5.8.1 的 `E_N`/`R_N` 正是这么定的 |

## ④ audit 的三个缺口

| 评审 | v15 |
|---|---|
| audit 追加没进事务镜像，崩溃恢复会**丢审计记录** | 明确进 `ledger_image.pre/post`；`--from-generation` 的顺序改为「postimage 比对 → 构造（过滤后 delta **+** audit 追加）作为 `post` → 正常事务提交」 |
| `install-new → retire-only` 复位后**没有 entry 可挂** | 改记 target 级事件到账本顶层 `audit_target`（同样只增、同样进镜像） |
| 「只增不减」与「单 JSON ≤ 8 MiB」冲突，反复复位能把账本写到**自己解析器都拒绝**的大小 | ① 追加前**容量预检**，预计超限则在提交点之前失败；② 超过 `audit_max_entries`（默认 1000）把最旧一批原子归档到 `audit-archive/<seq>.json`，账本只留 `audit_archived_until` 游标 |

## ⑤ `--reset-generation` 补完

| 评审 | v15 |
|---|---|
| 「所有可观察 generation」只数了 attic 与账本，漏了 `entries[*].generation`、journal 的文件名与内部 `generation`、`tx-<N>`、`frozen_attic` 引用的 generation | 全部补进下界计算；**completed journal 即使不阻塞 reset 也要参与** |
| `N + 1` 未受整数上限约束 | 要求 `N+1` 仍是 §11 允许的整数（≤ 2^53−1） |
| CLI 里根本没有这个 flag，多 target 作用域也未定义 | 09 补 `--reset-generation <N>`，并定死**作用域是单个 target**（多目标必须配单一 client，否则拒绝 —— 不同 target 的水位互不相干） |
| 「历史不可证明」只在那一次口头声明，之后 CLI 无从得知 | 🔴 账本写持久标记 `history_unproven: true`（只增不撤），并把 §4.1 的绝对措辞降级为「该标记为真时，generation 只保证本地单调，不再是完整历史证明」 |
| 之后该不该禁 `--from-generation` | **不禁**。只要目标 manifest、tar、postimage 都在，它们**自身**就足以证明那一次复位可执行，不依赖 generation 编号的历史完整性 —— 但输出必须带降级告警 |

## ⑥ 其余

- 🔴 `rmtree(D)` 的通用规则改为「**成功后必须 `fsync(parent(D))`**」，
  覆盖 cleanup 的 `retired/<name>`、rollback 的 `R`、`unpack/`、tx 与 attic 清理
  （v14 只在 cleanup 那一处写了）。
- 09 残留的「恢复矩阵」措辞改为**段模型**（04 早已改）。
- 08 把 `--from-generation` 指到 09 §2 → 实际在 §1.1。
