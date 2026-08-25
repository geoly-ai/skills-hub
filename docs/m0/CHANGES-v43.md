# M0 v43 变更台账

Codex 第四十二轮：4 组。

## ① 🔴 `unadopt` 只进了 1/5 张表

我在 v42 引入 `unadopt` 时，只把它加进了 manifest 执行表 ——
**入场表、一致性矩阵、反向调度、候选槽表全都只有 `adopt`**。
外加 §11 仍拒绝 `op = unadopt` 与 `reverse_op = adopt`，
于是**规范自己生成的 manifest 会被自身解析器拒绝**。

v43 四张表全部补齐，并把 §11 的两侧枚举**统一**为
`swap / install-new / retire-only / adopt / unadopt`。

## ② 🔴 `unadopt` 不能照抄 `adopt` 的失败规则 —— 两者安全性方向相反

评审指出的关键不对称：

> `adopt_assertions` 这样 rollback 是安全的，因为它**撤销**认领；
> `unadopt_assertions` **不安全** —— rollback 会**恢复**受管 entry，
> 但目录已经变了，账本会**错误认领一棵非制品目录**。

我把 `unadopt` 做成 `adopt` 的对称体，就顺手让它复用了同一套失败规则 ——
可「撤销认领」和「恢复认领」在**断言已失效**时的安全性根本相反。

v43 分流：

| 情形 | `--rollback` | `--reinstall` |
|---|---|---|
| 物理 `corrupt` | 🔴 拒绝 | 可用 |
| `adopt` 的 `assertion-corrupt` | ✅ 允许（撤销认领，安全） | 🔴 拒绝整个自动 repair |
| 🔴 `unadopt` 的 `assertion-corrupt` | 🔴 **拒绝** | 🔴 拒绝 |

并写死**混合异常的命令级优先级**（消除 v42 的歧义）：
`--rollback` 只要有物理 `corrupt` 就拒绝；`--reinstall` 只要有**任一** assertion-corrupt
就不自动执行，此时物理项也只能转人工。

同时收紧 §5.4 / §5.5 / CLI 里泛称的「`corrupt` 不可 rollback」——
🔴 **一律只指物理 `journal.items[*].state = corrupt`**。

## ③ `unadopt → adopt` 的复位不可实现

v42 只写「重新认领并复验」，没规定字段来源与两处 digest 的等式。v43 定死：

- 该 unadopt 代的 `postimage`：`entries[name]` **缺席**、边已撤销，
  但 🔴 `digests[name] = {"present":true,"digest":D}`；
- 先按它做完整三方比对；
- 新事务建 `adopt_assertions[name]`：`artifact` 取自
  🔴 **`ledger_delta.entries[name].artifact`**；`tree_digest` 必须 **== 该 entry 的 digest
  且 == `postimage` 的 `D`**；🔴 **不得取 `old_digest`** —— 它在 unadopt manifest 里是 `null`；
- 写 post 前与每次重放前再验目录仍为 `D`；新一代 manifest 的 `postimage`
  记「entry 已恢复、目录仍为 `D`」。

## ④ 三处补漏

- `adopt_assertions` 示例补必填 `"state": "ok"`；
- §5.6 明写 **adopt 与 unadopt 两类逻辑项都只进 B 阶段**；
- §11 的 `op` / `reverse_op` / `null` 规则同步。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
