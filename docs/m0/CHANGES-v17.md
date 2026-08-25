# M0 v16 → v17 变更台账

Codex 第十七轮：P0-2、P0-3 **维持关闭**。剩 3 个 P0，全在 audit / reset 平面。

## ① 🔴 排除 audit 并不能保住 audit

**评审**：`entries[*].audit` 隶属**可删除的 entry**。`install-new → retire-only` 复位时
`ledger_delta.entries[name] = null` 会把整个 entry **连同它的 audit 一起删掉** ——
「manifest 排除 audit」排除的是搬家清单，房子本身还是被拆了。
而新写一条 `audit_target` 也补不回已经丢掉的旧事件。

v17 取评审给的更小更干净的解法：**live audit 改为 target 顶层的事件流**，
事件自带 `subject`：

```json
{ "event_id": 137, "kind": "restored-yanked",
  "subject": { "kind": "entry", "name": "plaud-theme-dev" },
  "at": "…", "artifact": "…", "note": "…" }
```

entry 被删除**不影响**它的历史事件（事件在顶层，`subject.name` 只是指向一个已不存在的名字）。
v16 为兜「没有 entry 可挂」而专设的 `audit_target` **一并取消**。

## ② audit 归档小事务的逐崩溃点契约

评审列了七处未定义。v17 全部补上：

| 项 | 定死 |
|---|---|
| `event_id` 分配 | target 锁下：读 `audit-seq` → `+1` 原子写回并 fsync → 才使用 |
| seq 写失败 | **不写事件、整体终止**；写成功而后续失败 → **允许烧号**（可以有洞，**不可以重复**） |
| archive `seq` | 🔴 **`seq = to_event`**，不再单独分配 —— 天然唯一且单调 |
| 批次选择 | live `audit` 按 `event_id` 升序后的**一个前缀**（不是任意子集） |
| `batch_digest` | 对 `events` 数组按 §11 canonical 序列化后的**原始字节**求 sha256 |
| intent | 独立状态文件 `audit-archive-intent.json`，canonical + 原子写，有自己的 schema |
| 恢复优先级 | 🔴 **启动恢复先处理 audit intent，再处理安装事务**；§5.2 第 2 步一并扫描它 |
| 逐崩溃点 | ①后→重跑②③④；②后→**必须重验内容、范围与 `batch_digest`**，相符跳过②，**任一不符 fail-closed 停机（绝不覆盖）**；③后→②重验通过、③幂等、直接④ |

## ③ `--reset-generation` 在 ledger 缺失时无定义

**评审**：§4.1 把 `attic/`、`audit-archive/` 也算「已有 hub 状态」，
而 §5.9 又要求把 `history_unproven` 写进 `ledger.json` ——
**ledger 已丢而这些证据仍在时，既无处写标记、也无法重建账本。**

v17：**「存在且可解析的 ledger」列为 reset 的前置条件**；
缺失或损坏则**拒绝**，报明需要人工恢复（或移走整个 target 重装）。
拦截清单同时补上 `audit-archive-intent.json`（未完成归档）。

## ④ 评审确认已闭合 / 澄清的（记下来免得下轮重复）

- **`E_N`**：对非-audit 平面**已闭合** —— 物理变更在 `items`、纯 entry 变更在
  `ledger_delta.entries`、纯 root 变更落进 `R_N`、`frozen_attic` 全量比较。
  没有「动过但两边都不出现」的结构化 entry。
- **`frozen_attic` 全量存/比**：安全。会保守拒绝（不同 label 的两次顺序修改会让旧代复位被拒，
  须先复位较新的代），但**不存在「两代并发」问题** —— target 锁已把它们串行化。
- **`--only` 闭包**：安全取向正确。v17 澄清 CLI 语义（v16 的单数 flag 与「列出还要一起选哪些」矛盾）：
  `--only` **可重复**；CLI **不自动扩张**，而是拒绝并列出完整分量由用户原样重提；
  ⚠️ 明确**允许的退化** —— 连接密集时分量可能就是整代，那时 `--only` 等价于不加。
- **`next_generation`**：无功能性残留。按建议把账本顶层 `generation` 改名
  **`last_applied_generation`**（「最后**已应用**的代」），🔴 **可落后于水位、永远不用于取号** ——
  v16 与水位同名，容易被实现成「从账本取号」。

## M1 开工前的硬门

评审重申：**Q12** —— 按具体客户端版本完成四端 × 全局/项目级的 `.geoly` discoverability 验收。
