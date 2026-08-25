# M0 v7 → v8 变更台账

Codex 第八轮：5 组最小通过集合，其中 1–3 与 4 都被判为 P0。

**这一轮反转了 D2** —— 从 v2 起坚持了六稿的方向被一个反例推翻。

## ① 🔴 D2 反转：per-target 状态回到 `<target>/.geoly/`

**评审的反例**（不需要 `st_dev` 不同）：

```
A: /repo/.claude/skills                  → parent = /repo/.claude
B: 把同一目录 bind-mount 到 /mnt/skills   → parent = /mnt
```

同一棵物理树，两个 parent。于是锁不是同一把；**更糟的是 state-local journal
也互相看不见** —— A 崩在 retirement 之后，B 的 `target-id = hash(realpath)` 不同，
会把未完成事务当成「无事务」继续，踩烂 A 的中间态。

我在 v7 写的「连 stage-parent 都不共享就不是同一棵树」**是错的**：
bind mount 一个目录，parent 当然变了，树还是同一棵。而 target 的**任何**祖先
都可以被重新挂载，所以「相邻位置」这条路根本走不通。

**v8**：`lock.db` / `ledger.json` / `journal/` / `tx-<gen>/{stage,retired}` / `attic/`
全部回到 **`<target>/.geoly/`**。任何别名路径打开的都是同一个 inode。

顺带简化掉：`<target-id>`、`<stage-parent>`、`st_dev` 命名、面包屑、
`adopt --rebind/--discard`、以及第 3 步的 `st_dev` 比对（同设备天然成立）。
复制一个 target 就得到两个各自正确的安装 —— 这是**对的语义**，不需要认领。

**代价说清楚**：这条依赖「客户端忽略 `<target>/.geoly/`」。
v7 之前一直绕着它走，但 v7 的面包屑本来就在 target 里、tx 目录还落在用户的 git 仓库根上
（会被误提交，`git clean -xfd` 会删掉正在用的锁）。v8 把它**收拢成一条**，
并升级为 **M1 的阻塞验收门**（Q12）：四端 × 全局/项目级都要造出真实形态实测；
某端不过就只把那一端标为不支持。另加：`.gitignore` 建议 `/.geoly/`、
target 不可写时预检直接拒绝。

## ② SQLite holder 契约不可实现 → 修正

**评审**：`BEGIN EXCLUSIVE` 后「写 holder 并 `COMMIT` 子事务」不成立 ——
`COMMIT` 会提交外层事务并**释放锁**；`SAVEPOINT/RELEASE` 又不会让写入对其他连接可见。
按 v7 的字面实现，**metadata 锁会在 trust floor 临界区提前释放**，所以 P0-2 不能关。

**v8**：holder 在**外层事务内**写、**不中途提交**，最终 `COMMIT + close` 时才发布。
竞争者读到的必然是**上一次完成者**，符合「必然陈旧」的定义。
02 也补上「临界区内不得 `COMMIT`」。

CLI 措辞同步收紧：锁只证明「有一个活持有者」，`holder` 里的 pid **不保证是它** ——
只能说「上一次持锁的是 pid X（可能已不是当前持有者）」。

## ③ 取锁表补漏

`adopt` 随 D2′ 删除，其余按评审补：`remove` / `recover` 多目标必须按全序排序、
同 inode 去重；🔴 **`recover` 的任一子操作成功后也必须在 repo 锁下重算 lockfile**
（v7 只列了 install/update/remove）。

## ④ §5.4 改成真正的状态机

| 评审 | v8 |
|---|---|
| 没给 `phase` / `state` / `cleanup` 的合法枚举与持久化时点 | 补三张枚举表，并写明 `install-new` 没有 `retiring`/`retired`、`retire-only` 没有 `swapped` |
| 第 8 步没定义何时持久化 `verified`，表却依赖它 | 第 8 步验证通过即**持久化 `item.state = verified`** |
| `retiring` 状态已写、rename 未发生的组合没有精确行 | swap 表按 `state` 逐行重排，`retiring` 拆成「rename 未发生」与「已发生但 journal 未跟上」两行 |
| `retire-only + cleanup_pending + cleanup 未开始` 被当成「先补第 9 步」 | 拆成两行：`state=retired`（第 9 步未做）→ 补做；`state=done`（已做）→ 直接进清理 |
| `install-new + cleanup_pending` 被让从第 8 步继续 | 拆出独立行 → **直接置 `cleanup=done`**（§5.6 对它是空操作） |
| 🔴 第 9 步已改 `entries/roots`，`--rollback` 只复位目录，账本回不去（`remove` 的 retire-only 即可复现） | 第 6 步的 journal 必须带 **`ledger_preimage`**（将被修改条目的修改前完整内容）；rollback 复位目录后用它写回账本，**并重算 lockfile** |
| 仍有一处允许 corrupt rollback | 全文统一：`corrupt` **只能 `--reinstall` 或人工介入**，`--rollback` 与 `--continue` 都不允许 |

## ⑤ §5.6 补两条

- 🔴 **§5.3 的 ② 真正 rename 之前再实测一次 `old_digest` 并比对** ——
  第 6 步与第 7 步之间用户可能改了 target；不符即停机，不静默采用新值。
- 🔴 **`--replace` 的未认领旧目录**不受 artifact 载荷规则约束（可能含 symlink、
  非白名单 mode、非 ASCII 名）。规则：满足规则的正常走 retirement + canonical tar；
  **不满足的预检直接拒绝 `--replace`**，报明违规项。
  不为它定义第二套 retired-tree 格式 —— 多一套格式就多一套要维护的解包与校验路径。

## ⑥ lockfile 的可验证闭包

**评审**：「可复现的期望安装图」这个定义可以成立，但缺闭包，
而 lockfile 是**仓库里的未签名文件**。

v8 补：

| 约束 | 规则 |
|---|---|
| target 路径 | `client` 必须是已知 adapter、`scope` 必须是 `project`、`path` **只能由 adapter 推导**并精确匹配。🔴 拒绝绝对路径、`..`、任何非 adapter 产生的 path —— 否则一个未签名的仓库文件就能把安装写到任意位置 |
| snapshot 闭合 | 每个 root 的 `snapshot` 必须能取回**已验签**的历史快照，且 `artifact`/`tree_digest` 与其 record 逐字段相符 |
| entry 闭合 | `artifact`/`tree_digest`/资产摘要与所属 root 的解析结果相符；`requested_by` 每项必须存在于同 target 的 `roots` |
| `all@snapshot:<N>` | 定义 record 变体：**不带** `artifact`/`tree_digest`，只查 snapshot 可取回且已验签 |
| 🔴 install 语义 | **按 `entries` 物化已解析图，不得按 `roots` 重新解析** —— 否则同一个 lockfile 在不同时刻会装出不同东西，那就不叫权威输入 |
| 任一不闭合 | 拒绝安装（码 2），不做「尽力而为」 |

## 跨文件

- 00 的 D2 改写为 D2′（标注反转与理由）；D3 说明它在新布局下更必要。
- 10 的 Q1 改写；**Q12 升级为阻塞验收门**并给出精确的验收形态。
- 09 的 `--rollback` 不再写成「一律从 attic 解包」（多数格子是 `retired → target` 的 rename）；
  删 `adopt`；退出码 10 改为「target 不可写」；补 `--from-generation <N>`。
- 08 补：事务早已 `completed` 之后从冻结 attic 回滚要用
  `recover --rollback --from-generation <N>`（v7 承诺了能力却没有能选 generation 的命令）。
- 全文路径引用统一到 `<target>/.geoly/…`。

## 仍然开放

Q4、Q5、Q6、Q10，加 v7 的 `ExperimentalWarning` 抑制方式实测。
**Q12 不再是「开放问题」，它是 M1 的阻塞门。**
