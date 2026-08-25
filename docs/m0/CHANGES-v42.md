# M0 v42 变更台账

Codex 第四十一轮：确认 `unadopt` 的「绝不碰用户目录」语义**正确**、
四张表在「断言仍成立」的正常路径上**一致**。最小修订**只剩两组**。

## ① 🔴 我自己承诺、又自己堵死

> 入场表规定 adopt 只有 `T == digest` 才能 `noop`；断言失败后再执行 `--rollback`
> 会落入「其它 → `corrupt`」，**恰好拒绝了你承诺允许的 rollback**。

v42：`assertion-corrupt` 时**不检查 `T`**，直接 `noop / restored`。

并把两种 `corrupt` **明确分流**（v41 的例外与通用规则冲突）：

| 情形 | 阻止 `--rollback`？ | 处置 |
|---|---|---|
| `journal.items[*].state = corrupt` | 🔴 阻止（维持原规则） | `--reinstall` 或人工 |
| `adopt_assertions[*].state = assertion-corrupt` | ✅ **不阻止** | 入场 `noop/restored`、不检查 `T`、不动目录；账本按**过滤后的 `ledger_delta`** 撤销认领 |
| 两者同时存在 | 🔴 物理 `corrupt` **仍然阻止** | 先处理物理项 |

外加三条：

- 🔴 **`--reinstall` 遇到 `assertion-corrupt` → 拒绝整个自动 repair，转人工**
  （那是**用户自己的目录**，自动隔离/覆盖都不该落到它头上）；
- `state` 必填、初值 `ok`；合法迁移 `ok → assertion-corrupt`；
- 🔴 **`assertion-corrupt → ok` 仅在严格复验成功时允许**（`--continue` 的唯一出路），
  否则只能 `--rollback` 或人工。

## ② `unadopt` 有语义、没有落盘方式

v41 定义了「只撤销认领、不动目录」，但**新事务怎么持久化它、崩溃后怎么续做、
那一代又怎么再被反向复位**都没定义；manifest 的 op 枚举也只有三种。

v42 把它做成与 `adopt` **完全对称**的逻辑项：

- 新增 `journal.unadopt_assertions`（含 `state`），**不是** item op；
- 与该事务的物理项**共用同一 journal / 同一次 ledger post / 同一份 manifest**；
- 每次 post / 重放前验明该目录**仍在、且没变**（因为 `unadopt` 承诺不动它）；
- manifest 记 `{"op":"unadopt","tar":null,"reverse_op":"adopt"}` ——
  🔴 **`unadopt ↔ adopt` 互为逆映射**（v41 缺这一半）；
- `items` / `adopt_assertions` / `unadopt_assertions` **三者键集互不相交**，
  `rollback.items` 等于**三者之并**；
- manifest 的 `op` / `reverse_op` 枚举、§5.8 的执行表、§11 的缺席规则**同步扩展**。

另按评审要求收紧：🔴 **`unadopt` 不得笼统「删除对应 root」** ——
只删 entry、相关边，以及**仅当过滤后的 `ledger_delta` 明确指定时**才删 root，
否则混合 pack / 共享 root 的语义会被误实现。

## 编辑纪律

本轮 `assert` 又拦下一次（`reverse_op` 映射表的锚点对不上），
脚本在 `write_text` 之前中止，**没有出现改一半**。补对锚点后重跑并计数确认落地。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
