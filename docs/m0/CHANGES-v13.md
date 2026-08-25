# M0 v12 → v13 变更台账

Codex 第十三轮：P0-2 维持关闭。确认 **rollback 三态足够**（`t_parked` 正好隔开两次 rename，
不必为四个子操作各设状态）、**清理的 A→B→C 屏障够**、**`--allow-yanked` 不放行 degraded 正确且三处已一致**、
**独立 generation 文件方向正确**。P0-3 未关，4 组最小阻断集合。

## 🔴 ① 自噬矛盾：wire contract 拒绝 `null`，而我自己拿 `null` 当哨兵

评审判为 P0，我认。11 写着「拒绝 `null`，唯一例外是 `ledger.transaction`」，
而 `ledger_image` 的 `entries[k] / roots[k]`、attic manifest 的 `tar / old_digest / ledger_delta.*`
**全都在用 `null` 表达语义** —— 按这条规则，**正常事务与 `install-new` 的 manifest
会被自己的解析器拒掉。**

v13：改为「**`null` 只在 schema 明确声明处允许**」，并逐个列出那几处哨兵；别处仍一律拒绝。

## ② rollback 收尾协议（v12 把它弄丢了）

我上一轮改 §5.4.1 时，替换锚点把已写好的终结顺序块**吃掉了**，只剩一个 v10 的四步残块。
评审据此指出「成功 rollback 后会留下无法自行消失的事务线索」—— 属实。

v13 补回并加强：

```
① 🔴 删除**本代** attic/<gen>/ 与其 manifest
② ledger_existed=true  → 按 pre patch 并置 transaction=null
   ledger_existed=false → 删除整个 ledger.json
③ repo 锁下重算 lockfile
④ 清 <tx>/undo/、<tx>/unpack/ 与整个 tx
⑤ 清 direction、phase=completed，随后清掉 completed journal
```

🔴 第①步是评审新指出的洞：**阶段 B 之后回滚时 manifest 已经写出来了**，
不删它就会留下一个看起来「已完成」的 generation，之后被 `--from-generation` 误用。

## ③ rollback 的预检与 pending 段

| 评审 | v13 |
|---|---|
| 预检自相矛盾：要求所有非 `retire-only` 的 `T == new_digest`，但 `swap/planned` 此刻 `T=old`、`install-new/planned` 压根没有 `T` | 改为**只检查「确实要 park 的 T」**（即已越过首次正向 rename 的项） |
| `retire-only/planned` 缺分支 | 补上：不动 target，直接 `restored`（三种 `planned` 现在都有 no-op 分支） |
| 🔴 `pending` 段先清 `R` 再解 `A`，且只在入场验过一次 `A` —— 预检后 `A` 被改坏就**丢掉最后一份旧树** | 改为：**每次重放都先验 `A`** → 解到独立临时目录 `<tx>/unpack/<name>` 并验 → **通过后才**替换 `R` |
| 预检不能保证「世界不会变」 | 明确写出：target 锁只约束遵守它的 CLI，不约束用户与其它进程。预检只保证「写 `direction` 那一刻不存在已知死路」；**每次真正的 rename 与任何会毁掉恢复源的动作，都必须在动作点复验并 fail-closed** |

## ④ manifest 复位：从「盲 patch delta」改成三方冲突模型

评审的反例很有说服力：G1 装 direct root `D → a`；G2 新增 pack root `P → a`。
复位 G1 时 delta 会把 `entries.a` 置空、删 `D`，却**保留 `P`** ——
`P` 成了悬挂 root，而 `reverse_op = retire-only` 还会把 `a` 移走。
**`--only` 的「本代闭包」限制挡不住后续代新增的共享 root。**

v13：manifest 增记 **`postimage`**（受影响闭包的账本值、`root→entry` 边集、各项物理摘要）。
复位前要求**当前值仍等于该 postimage**；不等 → **报冲突并拒绝**，提示「先复位更近的第 N 代」。
🔴 **绝不把 delta 盲 patch 到当前账本上**；`reverse_op` 也只在该物理前提成立时可用。

另修两处字段错误：正文残留的 `ledger_restore` 旧名；`ledger_delta` 里那个
**账本根本不存在的顶层 `snapshot` 字段**（已移除）。

## ⑤ generation 缺失语义

评审：「人为删掉后扫描回填」维持不了「永不复用」—— 若 ledger/tx/attic 也没了，扫描没有上界。

v13 定为**降级语义**：target 内没有任何 hub 管理内容 → 从 `0` 开始；
**已有内容而水位文件没了 → 拒绝初始化**，报「本地历史被重置」，
要求人用 `--reset-generation <N>` 显式给一个高于任何历史值的起点。**不静默扫描猜。**

并删掉 §5.4.2 里那条与独立水位冲突的旧规则（「必须在删 tx/attic 之前扫描并持久化」）。

## ⑥ 其余

- 清理正文措辞「两阶段」→ **三阶段**（定义本来就是三段）。
- 🔴 明确 **`--from-generation` 豁免当前状态门** —— 它复位的是本机曾装过、且有本地备份的东西，
  不是从 registry 新装；05 §5 已承诺「已装的 yanked 制品仍能 rollback、取证」，
  在这里再卡状态门会与那条冲突。但**必须大声告警**并把「复位到了一个当前已 yanked/degraded 的版本」
  写进账本条目。
- `attic-manifest` 纳入 wire contract 适用对象；`<target>/.geoly/generation`（纯整数）明列为不适用。
- 「通用规则」里 v9 遗留的「未列出的组合一律 corrupt / 报告四处摘要」措辞已改（早就没有四位置表了）。
