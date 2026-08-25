# M0 v1 → v2 变更台账

每一条都对应 Codex 第二轮评审的一项。**未修的也列出来，并说明为什么。**

## P0

| # | 评审意见 | v2 怎么改 | 落在 |
|---:|---|---|---|
| P0-1 | 快照里的 commit SHA 自引用，不可构造；bundle / `created_at` 的时点也不成立 | **删掉签名对象里的全部 git commit SHA**（git 坐标不是信任来源，`tree_digest` 才是）；`created_at` 改为快照生成的**输入**，可复算；三阶段 A 构建 / B 审 merge / C 签名分发，快照内容在阶段 A 就完全确定 | [`02`](02-registry.md) §2.1 §2.2，[`06`](06-submission.md) §2 |
| P0-2 | 无防回放，旧的合法签名快照可让 yank 失效 | 新增**签名的 timestamp 元数据**（7 天有效、`version` 单调、带 `snapshot_sha256`）；客户端 `trust.json` 记最低已见版本；过期默认拒绝，`--offline` 需 `--allow-stale` 且结果持续标注 stale | [`02`](02-registry.md) §1 §3 §5 |
| P0-3 | 第 6 步写 journal，但第 2 步只看 `ledger.transaction`，崩溃后会复用 generation 覆盖唯一旧副本 | 第 6 步**同时**把 transaction 写入账本与 journal（各自 fsync + 原子 rename）；第 2 步**两条独立线索**（账本 + 扫描 journal 与磁盘 `.geoly-tx-*`）；`next_generation` 先持久化再使用、**永不复用**；第 7 步每个子步骤 write-ahead + fsync；第 8 步 corrupt 时 transaction 保持非 null 且 attic 不清理；第 9 步账本禁止原地覆写；锁加 nonce fencing | [`04`](04-install.md) §4.1 §5 |

## P1

| # | 评审意见 | v2 怎么改 | 落在 |
|---:|---|---|---|
| 4 | `asset.sha256` 无法稳定生成（gzip 时间戳等） | 定死 **canonical tar.gz 格式**（ustar 无扩展头、路径字节序、只写文件、uid/gid=0、mtime=0、gzip mtime=0 OS=255 level=9）；资产在 promotion 阶段打包并算 hash，release 用同一脚本重建后**字节级断言** | [`02`](02-registry.md) §4.1 |
| 5 | semver `+build` 让 `latest` 不唯一 | **禁止 `+build`**（D7） | [`01`](01-artifacts.md) §3 |
| 6 | pack 成员被 yank 后规则冲突 | 定义 **yank 闭包**：不自动 yank pack，改为派生状态 `degraded`（promotion 每次重算并写进快照）；CI 的 pack lock 门**只校验新增 pack** | [`03`](03-packs.md) §5 |
| 7 | `check` 无法既按安装快照验字节又报当前 yank | `check` **两阶段**：字节按账本记录的安装时快照，状态按当前 timestamp 指向的快照；离线时状态标注「未知」而非「正常」 | [`09`](09-cli.md) §4 |
| 8 | Windows / 跨文件系统未定却已进正确性 | **D1：v1 明确不支持 Windows 原生**（win32 直接拒绝运行）；补完整路径 grammar（含 Windows 敌意路径）；**拒绝在 NFS/SMB/FUSE 等文件系统上安装** | [`01`](01-artifacts.md) §4，[`04`](04-install.md) §2.1 §2.2 |
| 9 | 投稿 PR 的路径白名单会拒绝 promotion PR | 拆成 `validate-submission.yml` 与 `validate-promotion.yml`，由 **router 按作者身份 + 分支名**（不是标题/标签）判定必需的那一个 | [`06`](06-submission.md) §4 |
| 10 | pack 只是引用，取不到完整 vendored tree | 新增 **`vendor` 子命令**：下载 pack + 全部成员、验签验摘要、按 flat layout 物化，并写 `VENDORED.json` | [`03`](03-packs.md) §6 |
| 11 | manifest ↔ ArtifactId 绑定不完整 | 定死**六项（skill 七项）全等**的结构门 | [`01`](01-artifacts.md) §5.3 |

## 树摘要

| 评审意见 | v2 怎么改 |
|---|---|
| 编码本身无歧义、无延展性、无 length-extension | 保留原算法，只改书写形式与覆盖面 |
| 目录 mode / xattr / ACL / PAX 未覆盖 | 规范**强制**这些取值（目录一律 0755、mtime 0、uid/gid 0、uname/gname 空），解包策略层**拒绝**任何 xattr / ACL / 扩展头 |
| 路径应是规范化 segment 序列 | 写成正式 grammar，逐条列拒绝规则 |
| `digest_algo` 在快照顶层使算法迁移不可行 | **算法标识下沉进每个摘要值**：`geoly-tree-v1:sha256:<hex>`，pack lock 里也是这个形式 |

## 事务十步（逐步）

第 1 步加 nonce fencing；第 2 步加双线索发现；第 3 步加文件系统与同设备预检、磁盘余量；
第 4 步解包期间持续检查空间；第 5 步跨设备时用复制而非 rename（避免 `EXDEV`）；
第 6 步落盘对象改为「账本 + journal 各自 fsync」；第 7 步每子步骤 write-ahead + 父目录 fsync；
第 8 步 corrupt 保持事务非 null、不清 attic；第 9 步账本原子写；
第 10 步失败留 `completed` 残留而非触发错误 recover。

## 信任链

第 1 步改为「先取有 freshness 保护的 timestamp」，不再从不可信的 `index.json` 接受「最新」；
第 3 步加严格 schema 校验与**拒绝重复 JSON key**；
第 6 步改为「把暂存物交给事务」，**不再写账本**（消除与 04 的顺序矛盾）；
补 TUF 根版本 / 过期 / 轮换 / 紧急撤销（`min_cli_version`）；
🔴 **明确承认 npm + TLS 是第一跳信任锚**，并给出不接受该锚时的离线验签引导路径。

## matrix 迁移

| 评审意见 | v2 怎么改 |
|---|---|
| 墓碑挡不住 `--ref vX.Y.Z`、历史 commit、fork、缓存 | 措辞从「阻断旧入口」改为「**降低误用**」，并列出墓碑能/不能做到的对照表 |
| hub 发布后不可逆，「完全回滚」说法不成立 | 单列「真正不可逆的三个点」；步骤 ① 加「真发布前用本地 registry 演练完整链路」 |
| attic 只保留 3 代，迁移期回滚承诺会失效 | 新增 `--freeze-attic <label>`（不参与保留代数清理）+ 要求做一次**工具之外**的完整备份 |
| 「按 v0.3.6 字节导入」与强制 `skill.json` 冲突 | **双摘要**：`origin_tree_digest`（上游原始）与 `tree_digest`（hub 包装后）；`verify-vendored.mjs` 校验「去掉 `added_files` 白名单后逐字节相等」 |

## 待实验问题

Q1 / Q2 / Q3 / Q7 / Q8 **从待实验提升为 M0 定死**（D2–D6、D8）。
Q4 的时间点统一到 M3 之前。Q5 / Q6 保留。
新增 Q9（四端对 `.geoly-tx-*` 短暂窗口的容忍度）与 Q10（跨 Node/zlib 的归档确定性）。

## 七条自相矛盾

| 矛盾 | 消除方式 |
|---|---|
| 02 §4.3 第 6 步写账本 vs 04 第 9 步写账本 | 02 改为「交给事务」，账本只在事务第 9 步提交 |
| 快照 commit / bundle / `created_at` 的时点 vs promotion→merge→release | 见 P0-1 |
| `validate.yml` 路径白名单 vs promotion PR 必改路径 | 拆两个入口 + router |
| 04 §6.1 断言项目级会 shadow vs Q2 承认四端未知 | 改为「不承诺谁赢，只承诺不制造歧义」：默认拒绝 + `--shadow-global`；`check` 如实并列 |
| Q4 写 M3 vs 06 §7 写 M4 | 统一 M3 之前 |
| `--no-bundled` / `--i-know-whats-running` 未进命令面 | `--no-bundled` 已补；后者随 D5 取消，改为 `--assume-idle` |
| 01 允许跨 namespace 同名 vs 05 称「全局唯一」 | 唯一性规则以 01 §3 为准，05 改为复述 |
| pack 的 `clients` / `capabilities` 未定 | 由 promotion **计算**：`clients` 取成员交集、`capabilities` 取并集，写进快照 |

## 没改的，以及为什么

| 项 | 为什么不改 |
|---|---|
| 制品不逐个签名 | 评审确认「签名覆盖快照、快照的摘要覆盖制品」这一跳在补齐 freshness 之后是足够的 |
| 树摘要的核心编码 | 评审确认无 framing 漏洞。只补覆盖面，不动算法 |
| 不承诺跨四端 ACID | 评审同意；先例也是同样的语义 |
| 保留 `--all` | ⑥A 已拍板；只加强确认 |
