# M0 v5 → v6 变更台账

Codex 第六轮判定「P0-2、P0-3 均未关闭」，给了 5 组最小通过集合。

**这一轮的关键不是改文档，是先做了一次实测。** 用户拍板「先做可行性试验再定」，
试验结果推翻了 v5 的整条锁路线。

## ① 锁：实测后改用 `node:sqlite`（D11′）

**评审**：`unlink` 无条件按路径删除，所以「读 nonce 再 unlink」是 TOCTOU；
两个**完全合法**的 `--clear-lock` 交错就能删掉第三方刚建的锁。
「仅把 unlink 交给人，不能成为并发安全保证。」

**试验**（2026-08-25，Node v25.2.0 / macOS APFS）：

| 检验 | 结果 |
|---|---|
| 活持有者阻塞第二个写者 | ✓ |
| `SIGKILL` 持锁者后 | ✓ 内核自动释放 |
| 持锁期间读持有者信息 | ✓ WAL 下读者不阻塞 |
| npx 冷启动开销 | ✓ **量不出差别**（内建、惰性加载） |
| 取锁+提交+关闭 | ≈ 8.7 ms |

**v6**：三把锁（target / metadata / repo）统一改用 `node:sqlite` 的 `BEGIN EXCLUSIVE`。
🔴 **协议里没有任何一处 unlink 锁文件** —— 评审找到的整个 TOCTOU 类别不复存在，
`--clear-lock` 整个删除，崩溃后**不需要任何人工干预**。

代价如实记：Node 门槛 20 → **22.12**；`ExperimentalWarning` 需抑制且用法封在
`src/lock.mjs` 适配层加集成测试；SQLite 在网络文件系统上不可靠 ——
与已有的「拒绝 NFS/SMB/FUSE」正好对齐，不是新增限制。

**加锁全序**（防死锁）：`metadata（用完即放）→ repo → target（按 id 字节序）`。
🔴 不得存在「先 target 后 repo」的路径；`sync-lock` 只取 repo 锁。

## ② trust floor

| 评审 | v6 |
|---|---|
| 「写前重读」不是 CAS，无锁时仍会回退 | 明说：**真锁是必需的，重读只是额外防御层**。v5 说「无锁也够」是错的 |
| 发现磁盘 floor 更高时「沿用磁盘值继续」会让本进程仍按旧快照下载 | 改为**从磁盘 floor 重做完整绑定比较**：版本更高 → 放弃本次结果重走 §6 第 3–5 步；版本相同但 `(latest_snapshot, snapshot_sha256)` 不同 → 报完整性事件终止 |

## ③ 恢复：四个位置 + 三套表

| 评审 | v6 |
|---|---|
| 少了第四个位置 `A = attic tar`；`T=new,R=缺席,S=缺席` 被直接判「清理完成」却没验 A | §5.4 加入 **A**，四处**都实测摘要**（不是只 `stat`）。A 缺失/损坏时既不宣告完成也不承诺可 rollback |
| `T=new, R=部分（rmtree 中途）, S=缺席, A=old` **正常可达**，却被兜底判 corrupt —— 这否定了「未列全 corrupt」与「清理可自动续做」同时成立 | 该行**列进表里**，判定为「从 §5.6 ⑤ 续删」。冲突消除 |
| 缺 `install-new` / `retire-only` 的独立表 | 拆成**三套表**。🔴 `install-new` 没有 old tar，**不能套用「从 attic 解回」**；它的 rollback 是删除 T（唯一一处 rollback 需要删除，因为原本就不存在） |
| 「清理后 rollback」没有可执行顺序（target 仍占着路径） | 定死三步：`T(new) → stage` 腾路径 → 从 A 解到 `retired` 并逐文件验证 → `retired → T` |
| 清理副本论证太粗 | 逐段列出「完整副本在哪」，并加**三条前提**：崩在 checkpoint 前必须**从磁盘重验 A**（不能只信 journal）；每次 `fsync` 失败必须 fail-closed；保留代数清完后**不再承诺 old 存在**（迁移期 `--freeze-attic` 是例外） |

## ④ journal 自相矛盾与 pre-commit

| 评审 | v6 |
|---|---|
| 三处对第 9 步之后的 phase 说法不一（停机 / `completed` / `cleanup_pending`） | 第 9 步统一写 **`cleanup_pending`**，`transaction` 保留至清理结束；清理全部完成才写 `completed` 并把 `transaction` 置 `null` |
| ledger 与 journal 只写成功一个时未定义 | 新增双文件规则表，**journal 权威**；四种组合逐一定义 |
| pre-commit 漏洞：第 5 步建了 tx、第 6 步 journal 未写就崩溃 → 扫到 tx 停机却无 journal 可判 | 明确：**有 tx 但无 journal = 结构上可证明未动 target**，允许直接删该 tx |
| `corrupt` 能否 rollback 三处说法不一 | 统一为**只能 `--reinstall` 或人工介入** |

## ⑤ lockfile：按 target 分组的无损投影

**评审**：「各 target 的 roots 并集」会丢掉四样东西 —— 哪个 root 属于哪个 target、
同一 root 在不同 target 的不同 `intent`、同名 skill 在不同 target 的不同已解析版本、
root 与 `requested_by` 的 refcount 关系。并集反推不出唯一项目状态。

**v6**：schema 升到 `geoly.skills.lock/2`，**按 target 分组**，
每组各自带 `roots`（含 per-root `snapshot` / `intent`）与 `entries`（各带 `requested_by`）。
target 标识改用**可移植的 `client` + `scope` + 仓库内相对 `path`**，不再用本机 `target-id`。
示例已与正文同步（v5 的示例还留着已删掉的顶层 `snapshot`）。

## 其余跨文件矛盾

- 03 的 `requested_by` 写成对象、04 是字符串数组 → 统一为 **root key 字符串数组**，
  详情记在账本顶层 `roots`。
- 07 仍描述废弃的「attic rename 后删旧」协议 → 改为 retirement + 事务后清理的口径。
- 07 / 09 残留的 flock / `--clear-lock` 措辞 → 全部改到 D11′。
- 10 仍把 pid/boot_id 自动接管列为已定方案（直接违反 D11）→ Q11 改写为「v6 已实测定死」。
- 09 补 Node ≥ 22.12；退出码 5 的措辞改为「另一个**活着的** CLI 进程占用」。

## 仍然开放

Q4（token 收窄，M3 前）、Q5（验签依赖体积）、Q6（解包库选型）、
Q10（跨 Node/zlib 归档确定性）、Q12（stage discoverability，adapter 验收用例）。
**Q11 已由实测关闭。** 全部不阻塞接口定型。
