# M0 v22 变更台账

Codex 第二十二轮：**2a→2b→2c、②′重验、bootstrap 顺序本身都成立**；
`install / update / remove`、`recover --continue/--rollback` 均**不交错也不饥饿**；
`check / sync-lock` 正确地不跑这三步。
唯一阻塞点是 `--reinstall`，评审明说：**补完这组后，可以通过 M0。**

## 🔴 唯一 P0：`--reinstall` 的「消除/隔离」没有可崩溃恢复的状态机

v21 只写了这句话，背后没有任何持久状态。评审给的致命路径：

> `--reinstall` 先删/移走 corrupt journal，隔离尚未完成就崩溃 →
> 下次启动看到 `tx-*` **无 journal** → 按「pre-commit、target 未动」**直接删掉**。
> 但该 tx **可能已经交换过目标树**，而 `corrupt` 本来就包含 journal CRC 损坏的情形。

根因值得记：**我那条「有 tx 无 journal = pre-commit」的规则本身没错，
但 `--reinstall` 自己会制造出这个形状** —— 把一个危险状态伪装成安全状态。

### v22 新增 §5.10 · repair intent

`<target>/.geoly/repair-intent.json`（canonical、原子写），
🔴 **必须在改动 corrupt journal、tx 或 target 之前落盘并 fsync**：

```
① 从 corrupt journal 枚举完整计划（tx 目录、逐项 name 与 op）
   🔴 枚举不出完整计划（CRC 损坏、journal 缺失）→ **拒绝自动 --reinstall**，转人工。
      **绝不猜测、绝不清扫 target。**
② 写 repair-intent（state=planned）→ fsync
③ 隔离：整个 tx rename 到 <target>/.geoly/quarantine/<gen>/ → fsync 两侧父目录
④ state = isolated → fsync
⑤ 按 items 重新解析安装（走正常的新事务）
⑥ state = done → 删 intent → fsync 父目录
```

**与 §5.2 步骤 2 的衔接**：

- 🔴 2b **必须先认 repair intent**，且**只允许按该状态机续做**；
- 🔴 **存在 `repair-intent.json` 且其 `tx_dir` 指向某个 tx 时，
  绝不把它当「无 journal = pre-commit」**（§5.4.2 的双文件规则加了这条例外）；
- `state = planned` → 从③；`state = isolated` → 从⑤；
- 普通命令遇到 repair intent → 停机，提示先跑 `recover --reinstall`；
- `quarantine/` **不自动删除**（可能是唯一残存证据），由人确认后清理；
- **audit plane 全程排除** —— repair 不读、不写、不删任何 audit；
- 🔴 repair 完成并清掉旧事务线索之后，**才允许进入 2c 与新的安装事务**。

## 措辞更正：原子写「失败」不等于「磁盘未变」

评审：`audit-seq` 写入「失败 → 磁盘未变」不成立 ——
原子写在 `rename` **之后**、父目录 `fsync` 报错时，文件**可能已经存在**。

v22 在 §11 立了统一口径，并要求规范内任何一处都不得再写「写失败 → 磁盘未变」：

> **失败即停机（fail-closed）；下次启动按磁盘上的实际内容判定 ——
> 读到合法内容则沿用，读到非法内容则 fail-closed，
> 绝不「因为上次报错了」就重置。**

bootstrap 的两步（`audit-seq`、ledger 骨架）措辞同步收紧。

## 评审确认无需再动的

- **②′ 重验**：②′ 后、③ 前崩溃 = 「archive 已持久、intent 尚在、账本仍旧」，
  下次 2a 重验同一 archive 后再 patch；cursor 仍只在③前进。**没有问题。**
- **bootstrap**：`无 ledger + 有合法 audit-seq` 已被定义为可恢复且不重置的状态，
  没有新的语义不一致。
- **各命令的 2a/2b/2c 走查**：`install / update / remove` 不交错不饥饿；
  `recover --continue/--rollback` 作为 2b 的处理、完成旧事务后才进 2c；
  `check`（只读）与 `sync-lock`（只重算投影）不跑这三步。

## M1 开工清单

1. **Q12**：按具体客户端版本完成四端 × 全局/项目级的 `.geoly` discoverability 验收。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复验证，
   以及 `ExperimentalWarning` 抑制方式的实测。
