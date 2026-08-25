# M0 v40 变更台账

Codex 第三十九轮：**只剩 1 个阻断**。并确认：

- `cleanup = tar_durable` 的现场归类**已正确**（完整旧树走未清理类、部分/空走 cleaned，
  `cleanup = done` 才只允许 cleaned）；`install-new` 的三种 `done` 态**已闭合**；
- ledger-only 的**四个崩溃点都可恢复**（prepared 复验后提交、post 后重放幂等、
  manifest 前重做 B 阶段、completed 前按空清理收尾），与 §5.2、§5.6 **相容**。

## 🔴 唯一阻断：把「受管化」当成独立事务，漏了它出现在 pack 里的情形

> `items: {}` 被**无条件**用于「同名且相同」分支，但 `--replace` **也可发生在 pack 的多成员安装中**。
> 若其中一个成员可受管化、另一些仍需物理安装，当前规范**无法在同一 target 事务中
> 完成完整 root→成员图**；拆成两个事务会留下或崩溃在「root 已写、成员未全写」的半完成图，
> **违背 pack 的单事务语义**。

我设计这条分支时，脑子里只有「单独 `--replace` 一个目录」这一个画面。

v40 分两种情形：

| 情形 | 处理 |
|---|---|
| 该 target 的完整解析计划**一个物理项都没有** | 走空 `items` 的 ledger-only 事务 |
| 🔴 **混合计划** | **同一个 target 事务**里一起做：物理成员进 `journal.items`，可受管化的成员进新增的 **`journal.adopt_assertions`** |

### `adopt_assertions` 的定位

| 规则 | |
|---|---|
| 性质 | 🔴 **不是** `journal.items[*].op` 的第四种取值（与 `logical-only` 同样的处理方式），不建 stage / retired / attic item |
| 共享 | 🔴 与其它物理 `items` **共用同一份 journal、同一次 ledger post、同一份 manifest** —— root→成员图因此在**一个事务内闭合** |
| 复验 | 🔴 **每次 post / 重放之前**按 v39 的严格规则重新验明该目录，不成立即 `corrupt` |
| manifest | 记为 `{"op":"adopt","tar":null,"reverse_op":"retire-only"}` —— 复位时把当初受管化的 entry 退役掉 |
| 键集 | 与 `items` **不相交**；🔴 `rollback.items` 的键集等于两者**之并**（受管化项也要能回滚） |
| wire | 没有可受管化成员时**整个字段缺席**（不写 `{}`、不写 `null`） |

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
