# M0 v15 → v16 变更台账

## 🎯 里程碑：**P0-3 判定可关闭**

Codex 第十六轮：

> P0-3 可关闭的依据：反向段的 checkpoint、恢复源复验与终结顺序已闭合；
> 清理也保证 manifest 持久前不删 retired。

**两个原始 P0（回放、唯一旧副本）现在都关上了。**
剩下的 4 项 P0 全部来自后期才加的三个机制（postimage / audit / reset），
是新功能自己的缺口，不是原始 P0 的复发。

## ① `E_N` 集合不闭合（与③同一个根因）

**评审**：`E_N` 只取本代物理 `items`，遗漏**只改账本引用、无需物理交换**的 entry ——
pack 的 `requested_by` 增减本来就允许这种变更。之后给该 entry 加 root，再复位 N，
会**抹掉后来的 root 而比对不报错**。

v16：`E_N = names(items) ∪ keys(ledger_delta.entries)`。
`in_edges`、`digests`、`--only` 的选择域一律改用这个集合。

## ② `frozen_attic` 跨代丢数据

**评审**：`ledger_delta.frozen_attic` 是**整字段 patch**，而 `postimage` 只比「相关 label」。
G1 改 alpha、G2 改 beta，复位 G1 能通过 alpha 比对，**却用 G1 的旧整图覆盖掉 beta**。

v16 取评审给的更小改法：**定为整张 map，delta 与 postimage 都全量存、全量比。**

## ③ `--only` 仍未关闭

**评审**：`selected_roots` 没说取哪个时点、`unselected` 的全集是什么，
且仍以 `items` 而非账本 delta 的 entry 集合为基础 → 会漏掉「仅 refcount 改动」的 pack 成员，
重新形成部分 root 图。

v16 把闭包定义在**第 N 代收尾时的 `E_N` / `R_N` 二部图**上，取不动点连通分量；
`selected_items` 是闭包里**有物理项**的那些，`selected_delta` 只取闭包对应的键。
闭包不完整即拒绝并列出「要一起选的还有哪些」。冻结字段有改动时继续禁止部分复位。

## ④ audit 升级为独立平面

**评审**：归档没有原子、可恢复的契约；`ledger_image` 覆盖面不含 `audit_target` 与游标；
`audit-archive` 不在 wire contract 里；**manifest delta 若写完整 entry，
之后的 `--from-generation` 会覆盖掉新增 audit，违反「只增」**。

v16 定为独立平面：

- 全局递增 `event_id`（独立文件 `audit-seq`，原子写只增）→ 去重与序号复用都靠它；
- 归档 schema 带 `from_event` / `to_event` / `batch_digest`；
- 🔴 **归档是一次有 journal 的小事务**：intent → 写文件 → 账本 patch → 清 intent；
  崩溃按 intent 重跑，`batch_digest` 相符则跳过重写。**序号不复用、事件不重复**；
- `ledger_image` 明确覆盖 live `audit`、`audit_target`、`audit_archived_until`；
- 🔴 **manifest 的 `ledger_delta` 与 `postimage` 一律排除 audit plane** —— **复位永远保留审计历史**；
- 三处 `advisory` 统一为「没有就缺席」，不是 `null`。

## ⑤ `history_unproven` 与 `next_generation`

| 评审 | v16 |
|---|---|
| 先写水位、崩在标记之前 → 后续运行**看到水位却不知道历史不可证明** | 🔴 **顺序写死：先原子写并 fsync 标记，再写水位**；reset 设计为可重试 |
| `next_generation` 仍在账本示例与第 9 步被维护，却既不进 reset 下界、也没规定是派生的 | 🔴 **删除该字段**。水位只有一处 —— 独立文件 `<target>/.geoly/generation` |
| `audit-archive/` 未计入「已有 hub 状态」的证据集合 | 补进去 |
| §4.1 标题与事务表仍写「永不复用」这种绝对措辞 | 标题改为「generation 单调水位」；措辞一律改为「在 `history_unproven` 缺席时…」 |

## ⑥ 示例与 wire contract

- manifest 示例缺 `ledger_delta` 的闭合 `}`、漏 `postimage.frozen_attic` → 已修（花括号已校验平衡）。
- wire contract 适用对象补 `audit-archive`；`generation` 与 `audit-seq`（纯整数）明列不适用；
  原子写清单补 `attic/<gen>/manifest.json`、`audit-archive/<seq>.json`、两个计数文件。
