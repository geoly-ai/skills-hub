# M0 v8 → v9 变更台账

Codex 第九轮：**P0-2 判定关闭**（自 P0-1 之后第一个）。P0-3 未关，给了 3 组最小集合。

## P0-2 关闭

> metadata 锁持有到最终 `COMMIT`，且锁内重读完整三元组，已消除先前的提前释放与 floor 回退路径。holder 契约也正确。

唯一残留是 09 的措辞，v9 已改：不得声称「报出活着的 CLI 及其 pid」，
只能说「**上一次持锁的是 pid X，可能不是当前持有者**」。

## ① 恢复表：换掉「手工列格子」这个方法本身

**评审**指出四个缺格，而它们**全是同一种**：
`rename 已发生、但记录它的那次 journal 写还没落盘`。
`swap` 的 `state=retired, T=new`、`install-new` 的 `state=planned, T=new`、
`retire-only` 的 `state=retiring, R=old`、清理中 tar 已 rename 未 checkpoint、
retired 已删完未 checkpoint。**正常断电就会落进这些格子，而它们被判 `corrupt`，
于是要求 `--reinstall` —— 那个命令会丢弃两份树。**

病根是我在**手工枚举**，所以必然漏。v9 换成从不变式推：

> **任意两次相邻的 journal 写之间，恰好只发生一个文件系统操作。**

因此每个已持久化的 `state` 只有两种物理观测：「下一个操作未发生 / 已发生」。
三张表按这条规则生成，**可证穷尽**，四个缺格自动补上（表里逐个标了 🔴 v8 缺此格）。

另外：`corrupt` 补进 `item.state` 枚举（v8 由第 8 步写入却不在枚举里）；
`retire-only` 的终态从 `swapped` 改为 **`verified`**
（v8 的 §5.3 写 `swapped`、§5.4 又禁止该状态，自相矛盾）。

## ② 账本镜像：pre + post，且 rollback 是全事务语义

| 评审 | v9 |
|---|---|
| 第 9 步 journal 成功、ledger 失败时，只有 preimage 无法按「journal 权威」重建目标账本 | `ledger_image` 改为 **`{pre, post}` 两份**；`--continue` 按 `post` 写，`--rollback` 按 `pre` 写 |
| preimage 须覆盖「原本不存在」哨兵、`generation`、`transaction` | 覆盖本次会增/改/删的**每一个** `entries` / `roots` 键，「原本不存在」用 `null` 哨兵与「值为空」区分；含 `generation` / `transaction` |
| `next_generation` 必须明确不回退 | 🔴 **永不取自镜像**：恢复时一律 `max(账本值, 磁盘上出现过的全部 tx-* 与 attic 编号) + 1` |
| 「某项 corrupt 不阻止其余项」与全局 preimage 不相容 | 🔴 新增 §5.4.1：**`--rollback` 是全事务语义** —— 任一项 `corrupt` 则整个事务不允许回滚，报告是哪一项。`--continue` 仍可逐项推进 |

## ③ target 内状态的作用域边界

| 评审 | v9 |
|---|---|
| 可在某别名的 `<target>/.geoly` 上再挂载独立目录 → 锁与 journal 分裂；只比 fstype/`st_dev` 不够（bind mount 的 `st_dev` 可以相同） | 新增 §3.4：预检拒绝「`.geoly` 本身是挂载点」与「其下含挂载点」，判据以 `mountinfo` / `getmntinfo` 为准 |
| 嵌套 target 未处理 | 新增 §3.5：**直接拒绝嵌套 target**（祖先或后代里还有另一个已知 adapter 的 target），不做联合锁协议 |
| v8 声称同 inode 去重，正文只有排序**没有去重** | 取锁规则写实：先按 `(st_dev, st_ino)` **去重**，再按 realpath 排序取锁。bind-alias 下 `remove` / `recover` 必踩 |

## ④ lockfile 闭包补强

| 评审 | v9 |
|---|---|
| 🔴 `entries[].name` 未要求等于 artifact 的 name —— 未签名 lockfile 可写 `.geoly`、`..` 或任意目录名，而 install 按 entries 物化。**比 target path 更直接的写入逃逸** | 强制 `entries[].name == artifact.name`，并再过一遍 §01-4 的路径 grammar |
| 只做 entry → root 单向检查：**恶意 lockfile 可删掉 pack 的必装成员，剩余 entries 仍全部「闭合」** | 改为**双向图闭合**：从各 root 的已验签历史快照重新解析期望成员图，要求 `root → entry` 边集与 `entries` / `requested_by` **双向精确相等**，多一条少一条都拒绝。`all@snapshot` 按该快照的全量兼容集合比对 |
| `allow_yanked` 不能由未签名 lockfile 单独授予 | 从 `intent` 移除；lockfile 里只作记录，本次运行仍必须显式 `--allow-yanked` |
| schema 示例缺 root `artifact`、entry 缺资产摘要，却要求校验 | 示例补 `artifact` 与 `asset_sha256` |

## 跨文件

- 00 的术语表：ledger 位置改为 `<target>/.geoly/`。
- 08 的 attic 路径改为 `<target>/.geoly/attic/`。
- 10 的 stage 位置描述改写；D10 的错链 §5.6 → §5.7。
- 11 的适用对象删掉已不存在的 `breadcrumb`。
- 09 补退出码 9 的新触发（`.geoly` 是挂载点 / 嵌套 target）。

## 关于 Q12

评审明确：**Q12 的实测不阻塞 M0 文档定稿，但必须在 M1 中先于任何 adapter 合入。**
另按其建议补充：门要**绑定具体客户端版本**，adapter / 客户端升级时复测；
测试用的 staged `SKILL.md` 应是一个**可被识别的、有效且唯一**的 skill（否则测不出）；
🔴 `.gitignore` 的忽略路径写错了 —— 项目 target 实际是
`/.claude/skills/.geoly/` 等 **adapter 派生路径**，不是根上的 `/.geoly/`。

## 仍然开放

Q4、Q5、Q6、Q10，加 `ExperimentalWarning` 抑制方式的实测。Q12 是 M1 的阻塞门。
