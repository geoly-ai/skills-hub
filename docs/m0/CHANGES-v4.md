# M0 v3 → v4 变更台账

Codex 第四轮判定「P0-2、P0-3 都未关闭」，并给了 5 组最小通过集合。

**这一轮不是打补丁。** 连着三轮，每次修完都引入新的崩溃窗口 ——
那说明是设计不对，不是不够细。v4 做了两处**结构性改动**，各消掉一整类问题。

## 结构性改动一 · retirement：事务里没有「删除」

**v1–v3**：把旧目录打包成 tar → 删掉旧目录 → rename 新目录进位。

评审在这一步连续三轮找到崩溃窗口，最后一次是致命的：`archived` phase
同时覆盖「删旧之前」与「删旧之后」，恢复时 `--rollback` 会去删唯一那份 tar。

**v4**：

```
旧目录  --原子 rename-->  <tx>/retired/<name>/     ← 整棵目录，不打包
新目录  <--原子 rename--  <tx>/stage/<name>/
```

事务里**只有两次 rename，没有任何 unlink**。打包与清理挪到第 10 步（事务成功之后），
崩了随便重来 —— 那时新树已验证通过，旧树只是备份。

由此**整类消失**的问题：

| v3 的问题 | v4 |
|---|---|
| 「删了旧的、还没换上新的」中间态 | 不存在 |
| `archived` phase 歧义 → rollback 删掉唯一副本 | 没有 archive 这一步 |
| 「先 fsync(attic 目录) 再删」 | 没有删 |
| D10 未兑现（递归删除时能看到半棵旧树） | 没有递归删除，**兑现了** |
| 需要为 tar 预留磁盘 | 不需要 |

## 结构性改动二 · lockfile 是投影，不是事务参与者

评审列了 4 条 `lockfile_pending` 协议的缺陷（phase 不在恢复矩阵、与第 9 步冲突、
只存 hash 无法复位、多 target 缺 repo 级锁）。

v4 不修这个协议，**取消它**：lockfile 的内容完全可以从各 target 的账本推导出来。
既然是投影，就幂等重算 + 原子写；崩溃只会让它**过时**，不会让它与真相冲突。

消掉：repo 级锁、preimage、CAS、跨 target 协调 journal、`lockfile_pending` 及其恢复矩阵。
**Codex 最小集合的第 4 条整条消失。**

## P0-2 · 逐条

| 评审意见 | v4 |
|---|---|
| 高 version 仍可指向更旧 snapshot | 新增 **snapshot 单调性**三分支：`latest_snapshot` 小于 floor → 拒绝；相等 → `snapshot_sha256` 必须完全相等；大于 → 才允许换摘要 |
| 时间规则不完整（允许负有效期、遥远未来的 `created_at`） | 定死 `0 < valid_until - created_at ≤ 7d`、`created_at ≤ now + 5min`、`now < valid_until` |
| 本机时钟是 freshness 输入却未承认 | 威胁模型新增 6f：拨快 = fail-closed 拒绝服务；**拨慢 = 回放窗口被拉长，无密码学解**，如实承认 |
| manifest 绑定要在推进 floor 前校验，但 manifest 在资产内、第 7 步才下载 —— 顺序不可能 | 第 5 步只校验 **snapshot 自身可得的数据**；六项绑定移到第 7 步「下载并解包之后」 |
| 离线元数据无处缓存，`--offline` 与 `check` 历史路径实际跑不了 | 新增 §9.2 元数据缓存（放 **state 而非 cache 目录** —— 它参与安全判定，不该被「清缓存」删掉）。🔴 **缓存命中不跳过验签** |
| 「先推进 floor 再下载」会造成可用性失败 | 评审确认这是**正确的 fail-closed，不应改回**。v4 保持 |

## P0-3 · 逐条

| 评审意见 | v4 |
|---|---|
| `archived` phase 崩溃后 rollback 删掉唯一副本 | 结构性改动一：**没有 archive、没有删除** |
| 一个全局 phase 描述不了多项事务 | §5.3 改为**逐项** `planned → retiring → retired → swapped → done`，每项独立原子写 |
| 恢复矩阵不安全 | §5.4 逐项矩阵，并定死**权威规则**：journal 与磁盘不一致时**以磁盘为准**，恢复前先 `stat` 三个位置。🔴 每一格的回滚动作都是 **rename 不是 unlink** |
| `attic/<generation>` 若本轮创建还须 fsync 父层 | §5.3 每次 rename 后 fsync **两侧**父目录 |
| 文件系统预检只写了 target/stage，漏了 state 目录 | 第 3 步改为 **target / stage-parent / state 三者**都预检 |
| `flock` 是 Q11，后备方案会改协议，不能留到实现期 | 🔴 **v4 定死不用 flock**：Node 无内建，`O_EXLOCK` 只有 macOS/BSD。改用 pid + `boot_id` + 进程启动时刻做存活判定；**活持有者一律拒绝，不提供任何抢锁 flag**。接管陈旧锁在 retirement 设计下是安全的（窗口内无破坏性删除）。**Q11 关闭** |

## stage 位置

| 评审意见 | v4 |
|---|---|
| `.geoly-tx-<generation>` 没有 target-id，不同 target 会碰撞 | 改为 `.geoly-tx-<target-id>-<generation>` |
| 项目级 target 的 stage parent 未定义 | 定死：全局 = `<client-config-root>`；项目级 = **仓库根**（不是 `<repo>/.claude`，该目录可能不存在） |
| 「客户端不扫 config root」只是断言，未证明前不能算关闭 Q9 | 降级为 **Q12**，并明确写成 adapter 的**验收用例**（不是可选实验）：M1 的 adapter 未过此用例不得合入；任一端会加载则改用「先把整个 target 原子改名」的更重方案 |

## Wire contract

| 评审意见 | v4 |
|---|---|
| 「key 全字节序排序」与「`schema` 必须第一」矛盾 | 定死优先级：`schema` 强制置首，其余按字节序 |
| journal CRC 依赖 canonical，但 canonical 只强制 snapshot/timestamp；CRC 格式未定 | canonical **适用于全部对象**；`crc32c` = 小写 hex、固定 8 字符补零、覆盖「去掉该 key 后的 canonical 字节含结尾换行」 |
| 适用对象漏了 lockfile / `VENDORED.json` / owners / attestation，反而列入没有 `schema` 的 `lock` | 重列适用对象；明确 `targets/<id>/lock` **不适用**（进程存活元数据，不参与跨版本契约） |
| D9 只限制路径，自由文本的 surrogate 规则未定 | 定死：`\uXXXX` **hex 小写**、BMP 外用代理对、**未配对代理即拒绝整个文档**、控制符用最短转义 |

## attestation

评审确认依赖方向正确、**不自引用、不重开 P0-1**，但只是示例。v4 定死契约：
DSSE envelope、`payloadType`、固定 `predicateType`、40 位小写 `sourceCommit`
且该 commit 的树必须含与 subject 逐字节相同的快照文件、
🔴 `workflowRef` 必须是**不可变标识**（`…@<40 位 commit sha>`），
**不接受 `@refs/heads/main`** —— 分支引用可变，写它等于没写。

## 跨文件文本修正

- 01 的仓库布局删掉 `registry/timestamp.json`，改为 `timestamp-archive/`（当前值不进仓库）。
- 01、06 的「签名对象里不含任何 commit SHA」→「**不含生成/承载快照自身的 release commit SHA**」，
  并列明 `review.head_sha` / `origin_commit` / `sourceCommit` 为什么可以保留。
- 07 的路径 13 改为 D5′ 的口径（无检测、无阻断、无提示），错链 §8 → §9。
- 08 的 attic 路径改为 state 目录下。
- 09 → 08 §5.1 的链接：把 08 的 `## 5.1` 改成 `### 5.1`（标题层级错误导致引用失效）。

## 仍然开放

Q4（token 收窄，M3 前）、Q5（验签依赖体积）、Q6（解包库选型）、
Q10（跨 Node/zlib 归档确定性）、**Q12（stage discoverability，已升级为 adapter 验收用例）**。
Q11 关闭。全部不阻塞接口定型。
