# M0 v27 变更台账

Codex 第二十七轮：3 组。2c/audit 边界继续确认不再是阻塞项。

## ① 🔴 键还是选错了 —— 第三次

- v25：「原 op × 是否隔离」
- v26：「`phys` × `ledg`」
- **两次都不够。**

根因（这次终于看清）：我一直在用「**原来发生了什么**」推「**现在该做什么**」，
而唯一能唯一决定动作的是「**现在是什么 × 应该变成什么**」。

评审的反例：原 `retire-only`、旧树已隔离、账本 `pre` ——
**目标终态应该是「无树」**，v26 的表却给了 `install-new`。

v27 改用两个量：

```
cur    = 隔离后该 name 在 target 上的实测   ∈ { absent, <digest>, other }
target = repair plan 的**目标物理断言**     ∈ { {present:false}, {present:true,digest:D} }
```

| `cur` | `target` | `child_op` |
|---|---|---|
| `absent` | `absent` | `logical-only` |
| `absent` | `D` | `install-new`（必带 `restore_from`） |
| `C` | `absent` | `retire-only` |
| `C` | `D`，`C == D` | `logical-only` |
| `C` | `D`，`C != D` | `swap`（必带 `restore_from`） |
| 🔴 `other`（既非旧树也非新树，含部分树） | 任意 | **`corrupt`** —— v26 的 `phys` 只有三值，漏了这一类 |

🔴 **`ledg` 降级为校验量，不参与决策**：正常事务的 ledger 是**整份原子替换**，
不存在可接受的「部分提交」；closure 内混合 pre/post 或两者皆非 → **`corrupt`**
（v26 把它当第三种取值是错的）。

并补上 v26 示例里漏掉的、自己声称必填的字段：`cur` / `target` / `child_op` /
条件必填的 `restore_from`。

## ② `logical-only` 没有事务契约

§5.3 只承认三种 journal item op，§11 也只为那三种定义了 digest 组合 ——
把它写成第四种 item op**会破坏段模型**。

v27 按评审给的最干净做法：**`logical-only` 只是 repair plan 的编译分类**，
**不出现在 `journal.items[*].op` 里**；不建 stage/retired/attic item；
child journal 照常带 `repair_id` / generation / `tx_dir` / CRC / 普通 `ledger_image`，
🔴 **并明确允许 `items` 为空**；恢复走 `prepared → ledger post patch → cleanup_pending → completed`，
🔴 **每次重放前复验计划携带的 `target` 断言**，不成立即 `corrupt`。

## ③ child 状态机的组合约束

v26 的表只校验了 `state × child` 是否存在，**没约束 `committed` 与
journal / tx / `ledger.transaction` 的组合**。v27 补：

| 缺口 | v27 |
|---|---|
| `completed journal + tx 已清` 时 `ledger.transaction` 仍可能指向 child generation | 🔴 顺序改为：**先清 transaction** → 再删 completed journal → 再最终重验（v26 漏了第一步） |
| `committed:false + 无 tx/无 journal` **但 transaction 仍在** —— 可达的半提交 | 🔴 **不得沿用该 generation**：先清 transaction，**再重绑新 generation** |
| `child_done` / `done` 没有前置断言 | 🔴 必须同时满足 `committed == true`、**无 child tx 与 journal**、**`ledger.transaction == null`**；任一不满足 `corrupt` |
| `committed` 何时写 false、何时翻 true 没定 | 登记 child 时与 `generation`/`tx_dir` **同一次原子写**写入 `false`；**child journal 成功提交（`prepared` 落盘）之后**才翻 `true` |
| `isolated` 的「无 child 残留」判据 | 明确为 child tx / journal / `ledger.transaction` **任一存在即 `corrupt`** |

## ④ 物化规则漏了 `pre`

评审：白名单本身与 child 的普通 `ledger_image` 相容，问题是 v26 **只规定了 `post`**。
closure 内 **`pre` 缺席也必须物化为 `null`**，否则 child 的 `ledger_image.pre`
表达不出「此键应不存在」，与「`pre` 精确等于隔离后投影」**自相矛盾**。

v27 改为 `pre` 与 `post` **各自**物化；并写明
🔴 **`repair-intent` 文件自身仍用字段缺席，`null` 只出现在由它物化出来的 child image 里**。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
