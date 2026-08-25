# M0 v23 变更台账

Codex 第二十三轮：6 组，全部围绕 v22 新增的 `repair-intent`。

## ① repair-intent 不是完整的外层事务

| 评审 | v23 |
|---|---|
| ③ 只移了 `tx-<gen>`，**同代 journal 与 `ledger.transaction` 没处置** —— 完成后 2b 仍会把它识别为残留事务，进不了新事务 | 隔离范围定为**四样**：`tx-<gen>/`、`journal/<gen>.json`、`ledger.transaction` 置 `null`、🔴 **因自身 corrupt 而不可信的 target 树**（v22 完全没提这一类 —— 若 corrupt 的原因就是目标树本身，不隔离它就无从重建） |
| `items = name/op/expect` **不足以确定性重装** | `plan` 扩为：解析快照、逐项 `artifact` + `tree_digest`、`roots` 变更、`ledger_baseline`。枚举不出任何一项 → 拒绝 |

## ② ③⑤⑥ 没有崩溃可重入闭环

| 评审 | v23 |
|---|---|
| 崩在 rename 之后、`state=isolated` 之前时 intent 仍是 `planned`，而现文断言「tx 还在原处」 | 🔴 **恢复一律按「物理实况」定位，不按 `state` 断言**：源在/目的地不在 → 续做；源不在/目的地在 → 跳过；**两边都在** → `corrupt`；**两边都不在或内容不符** → `corrupt`。创建 `quarantine/` 链同样逐层 fsync |
| `state = done` 没有恢复分支 | 补：`done` 而 intent 仍在 → 只重做第 ⑥ 步的删除 |
| ⑤ 创建的新事务**没有持久绑定**到 repair intent，崩溃后 2b 分不清它与旧事务，可能重开第二个重装事务 | 🔴 **先持久化 `child{generation,tx_dir}` 与 `state=child_registered`，再创建那个事务**；`child_registered` 时**只允许恢复 child 那一个事务**；child 的 `prepared`/`cleanup_pending` 作为 repair 的**子步骤**恢复；🔴 **child 再次 corrupt → fail-closed 转人工，绝不再开一个 repair**（不做嵌套隔离） |

## ③ 优先级文字互相冲突

评审：2b 的通用分支排在 repair intent **前面**，与「2b 必须先认 repair intent」矛盾；
且 ⑤ 说「走正常新事务」，另一处又说「repair 完成后才进 2c 与新事务」。

v23：2b 拆成 **2b-1（先认 repair intent）** 与 **2b-2（没有 intent 才走通用分支）**；
并把总顺序定死为

```
2a audit → 2b repair（只允许恢复已登记的 child）→ 2c 阈值归档
→ 启动/继续「已登记的重装 child」
```

即 **child 事务本身就是 repair 的一部分**，在 2c 之后启动；
与 child 无关的新安装事务，必须等 repair 整体 `done`。无关残留一律 fail-closed。

## ④ 人工出口写具体

v22 只有「转人工」三个字。v23 给可执行路径：保留现场与 `quarantine/` 并打包留存 →
恢复一份完整一致的 target 状态，或整体迁走 target、新建空 target 重装（🔴 明确放弃本地 audit）；
🔴 **禁止只删 intent / journal / tx 来「解锁」** —— 那正好丢掉判断依据。

## ⑤ 原子写口径的历史残留

评审指出 `CHANGES-v21.md` 与 `CHANGES-v11.md` 里仍有「失败 → 磁盘未变 / 什么都没发生」。
v23 就地标注为**已被 v22 废止**，并在 §11 加一条总覆盖：
「`CHANGES-v*.md` 是变更记录、不是现行规范，其中任何旧表述一律以本条为准。」

另按建议收紧 §5.2 第 6 步的「此前 = 什么也没发生」——
改为「target 未被改动，但 ledger 骨架 / journal 各自原子写，可能已有一份落盘」。

## ⑥ `quarantine/` 纳入恢复边界

v22 新增了这块持久状态却没纳入任何边界。v23 补齐四处：
状态布局图、symlink/挂载点检查、generation 缺失的「已有 hub 状态」证据集、
`--reset-generation` 的拦截清单与可观察 generation 下界。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
