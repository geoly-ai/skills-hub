# M0 v9 → v10 变更台账

Codex 第十轮：P0-2 维持关闭；P0-3 未关，5 组最小阻断集合。

**这一轮又是换方法，不是补格子。**

## ① 🔴 v9 的不变式是错的，「枚举物理状态」这条路本身走不通

v9 声称「任意两次相邻 journal 写之间恰好只发生一个文件系统操作」，据此宣称三张表可证穷尽。
评审逐条驳倒，我复核**全部属实**：

| 反例 | 出处 |
|---|---|
| 一次 rename 后紧跟**两个**目录 fsync | §5.3 ②④ |
| `swapped → verified` 之间**没有任何写操作**，只有校验读 | 第 8 步 |
| 一次 checkpoint 内依次写 `.tmp`、校验、rename tar、多级 fsync | §5.6 ①–③ |
| `rmtree` 本身是多次操作 | §5.6 ⑤ |

而且我自己表里就有 `R=部分` —— 等于承认「一个 state 对应大量物理中间态」，与「两格穷尽」自相矛盾。

**v10 换成崩溃恢复的标准解法：幂等前向恢复。**

> 每个已持久化的 `state` 界定一个**段**；`--continue` = 把该段从头幂等重跑；
> 段里每一步都写成幂等的。

规范强制每类操作的幂等写法（rename 的四分支、写 tmp+rename、rmtree、校验）。
于是**不再需要**四位置穷尽表 —— 三张表降级为「段的定义与顺序」。
`retiring` 中间态随之取消（幂等重跑不需要它）。

新增 I/O 失败统一规则：**任何 `fsync` 失败即停机、不推进 journal、不当成功**；
journal 原子写留下的 `.tmp` 一律忽略并删除；CRC 失败即 `corrupt`。

## ② `--rollback` 自己也要有 journal 方向

评审的反例：`swap` 停在 `swapped`，rollback 做完 `T→S` 就崩溃，
物理变成 `T=∅,R=old,S=new` 而 journal 仍是 `swapped` ——
这个组合在**正向**语义里恰好是「`retired`、④ 未做」，**下一次会按正向把回滚掉的又装回去**。

v10：rollback 是 journal 里的一个 `direction`，与正向共用幂等纪律；
**一旦持久化就只能续做 rollback，不得转回正向**；逐项反向段有自己的 checkpoint。

🔴 并修掉一个我自己的矛盾：`install-new` 的反向 v9 写「删除 T」——
**那是在 target 内递归删除，直接违反 §5.7 的「事务内无递归删除」**，还会留下半棵 target 树。
改为 `T → <tx>/undo/<name>`（rename），真正的删除在 `.geoly` 内、事务之后。

## ③ `ledger_image` 契约统一

| 评审 | v10 |
|---|---|
| §5.2 与 09 仍用旧名 `ledger_preimage`，与 §5.4.2 的 `{pre,post}` 冲突 | 全部改为 `ledger_image` |
| `post` 示例含 `transaction:null`，正文又说 transaction 不从镜像恢复 | 🔴 `transaction` **不进镜像**，示例已删该字段 |
| 未定义「首次安装时 ledger 原本不存在」怎么恢复 | 新增 `ledger_existed` 哨兵；`false` 时 rollback 的动作是**删除整个 `ledger.json`**，不是写空账本 |
| 「按 post 写」需定义为对受影响键的原子 patch | 明确：**patch 语义，未列出的键保持不变**，不是整文件替换 |
| `next_generation` 必须在删 tx/attic 前算出 | 明确：**先算出并持久化，再删** —— 扫描来源就是那些目录 |

## ④ 作用域与锁序

| 评审 | v10 |
|---|---|
| 锁排序自相矛盾（前文 `(st_dev,st_ino)`、后文 realpath），bind alias 下 realpath 不稳定会让两进程取得相反顺序 | 🔴 统一为**去重后仍按 `(st_dev, st_ino)` 排序** |
| `.geoly` 及状态路径需无跟随打开 | 补：**`lstat`/dirfd 无跟随，遇 symlink 即拒绝**；§10 那句泛称不足以覆盖状态目录 |
| 「已知 adapter target」若按名字扫任意后代会误伤普通目录 | 识别范围收窄为：①本次命令的目标集合，或②**实际带有有效 `.geoly/` 状态**的目录 |

## ⑤ lockfile

| 评审 | v10 |
|---|---|
| 「边集精确相等」没要求**顶点标签**也相等 —— 恶意 lockfile 可保留同名 entry 与相同边，却换成另一 namespace/版本的**已签名** artifact，违背 pack 的锁定成员 | 闭包升级为「边 + 顶点标签」：root-key == root 的 `artifact`；每个 entry 的 `name` / `artifact` / `tree_digest` / `asset_sha256` / `requested_by` 都必须等于重解析出的期望值；另校验 client 兼容性 |
| `all@snapshot` 示例仍保留 `allow_yanked` | 已删。并写明：**账本**的 intent 保留它（本机历史），**lockfile** 的 intent 没有它 |
| 即使补齐，能改仓库的人仍可换成另一个已签名制品 | 🔴 **如实承认为残余风险**（威胁模型新增 13b）：这与任何包管理器的 lockfile 是同一条信任边界。要更强只能给 lockfile 签名或本地另存已批准图 —— **v1 不做** |

## ⑥ 跨文件

- 新增 **§5.8**：事务**已 `completed`** 之后的复位 —— 它不是回滚，而是**一次新的正向事务**
  （`recover --rollback --from-generation <N>`，解 tar 到新事务的 stage 再走完整 swap）。
  08 承诺了这个能力，v9 却既没有命令也没有协议。
- 补 **`--freeze-attic` 的表示**：账本顶层 `frozen_attic: {label: [gen…]}`；
  清理跳过；`--release-frozen` 删条目后**下一次**清理才处理（留一次反悔机会）。
- 09 补 `--from-generation`；`--rollback` / `--continue` 的说明改到 v10 的段语义。
- 10 的 Q9 并入 Q12（stage 现在就在 `<target>/.geoly/tx-*`，与其余状态同处一地）。

## 仍然开放

Q4、Q5、Q6、Q10、`ExperimentalWarning` 抑制方式实测。Q12 是 M1 的阻塞门。
