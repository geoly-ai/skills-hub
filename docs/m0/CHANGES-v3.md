# M0 v2 → v3 变更台账

对应 Codex 第三轮评审。它判定「P0-1 关闭；P0-2、P0-3 未关闭」，并给了 5 组最小通过集合。

## 用户拍板（2026-08-25）

| # | 决定 | 影响 |
|---|---|---|
| **D9** | 路径 **ASCII-only** | 一并关掉 macOS Unicode 归一化、USTAR 编码、同形字三个问题 |
| **D5′** | 正在跑的 agent **不设闸、也不加确认**，`--assume-idle` 删除 | 比 Codex 给的两个选项都松；风险如实写进 README 与威胁模型 |
| **D10** | 交换承诺改为「不会读到半棵树，但可能短暂读不到」 | 不引原生 syscall 绑定 |

## P0-2 · 回放（关闭）

| 评审意见 | v3 |
|---|---|
| trust floor 在「全部安装成功后」才写，且未要求原子持久化 | 🔴 **在下载任何制品、动任何 target 之前**就原子写入（临时文件 + fsync + rename + fsync 父目录）；`metadata.lock` 上的内核 advisory lock 保护整个「验证 + 推进 floor」区间 |
| 缺 `version == 本地` 时的绑定一致规则 | 定义**三分支**：小于拒绝；**等于只在 `(latest_snapshot, snapshot_sha256, timestamp_sha256)` 完全一致时接受**，任一不同即报完整性事件；大于才前进 |
| timestamp 自身缺严格校验 | schema、拒绝重复 key、`repo` 常量、严格时间格式，且强制 `valid_until - created_at ≤ 7 天` |
| 历史快照读取路径未定，导致 `check` 与 `--snapshot` 跑不起来 | 新增 §6.1：「`N < 本地 floor` 即拒绝」**只适用于解析当前**；历史快照是另一条只读路径（先验当前 → 再取回历史 → 独立验签 → 只用于验字节/取证，**不得**用来回答「现在还能不能用」） |
| bootstrap 窗口未承认 | 新增 §7 + 威胁模型 6c：首次安装可被喂旧而未过期的 timestamp，窗口最长 7 天，**无法靠 timestamp 自身消除**；缓解是打印 version/created_at 供对照 + 公告给出受影响区间 |
| snapshot 与 timestamp 共用 `release.yml` 身份 | 拆成**两个 identity**：`release.yml`（身份 A，签快照与 attestation）与 `timestamp.yml`（身份 B，只签 timestamp）。CLI 分别固定，**用错身份签的一律拒绝** |
| timestamp 的 bot commit 与分支保护冲突，跑不起来 | 🔴 timestamp **只作滚动 release `timestamp` 的资产**分发，**不 commit 进仓库**；cron 只更新资产、不写仓库、不打 tag，因此不触发发布循环；归档另走普通 PR，失败不影响分发 |
| `min_cli_version` 未进 schema，语义也不对 | 进 schema，并写明它**只对新版 CLI 有效** —— 旧 CLI 不会因它停机，它是**止血提示不是撤销机制**；真正的撤销靠 yank + GSA + 发新 CLI |

## P0-3 · 唯一旧副本（关闭）

| 评审意见 | v3 |
|---|---|
| `--force-unlock` 的 nonce 不是可靠 fencing | 🔴 **删除 `--force-unlock`**。改用**内核 advisory lock（`flock`）**持有整个事务与 recover，进程死亡自动释放；锁被占用即报出 pid 并退出，必须人工停掉持有者。取消「抢锁后继续」这个语义本身 |
| archive 只写了 tar + fsync，未规定先 `fsync(attic 目录)` 再删旧目录 | §5.3 定死八步顺序，③ 是 `rename → 🔴 fsync(attic 目录)`，⑥ 才删旧目录 |
| journal 缺可恢复的完成状态 | §5.4 定义 `prepared → archiving → archived → swapped → verified → completed` + 终态 `corrupt`，并给出完整**恢复矩阵**（每个 phase 下 `--continue` / `--rollback` 各做什么）；journal 原子替换 + `crc32c` 自校验，损坏即停机 |
| 「旧或新二选一」与「先删后 rename」矛盾 | D10：改承诺（§5.6），并写明为什么不上原子交换 syscall |
| `--replace` 的磁盘余量预检漏了待归档目录与 attic tar | 第 3 步改为 `(新制品解压后 + 待归档旧目录 + attic tar) × 2` |

## P0-1 · 措辞改正

评审指出「签名对象里没有任何 git commit SHA」这句过宽 —— `review.head_sha` 与
`provenance.origin_commit` 都还在，且它们**不是**自引用。
§2.1 改为「不含**生成/承载它自己**的 release commit SHA」，并列表说明这两个为什么可以保留。

另按建议补了 **attestation**（§1.1）：独立签名对象，绑定快照 sha256 ↔ source commit + workflow，
把 P0-1 删掉的强审计能力补回来，且单向依赖、不构成自引用。安装链路不读它。

## 其余修补

| 评审意见 | v3 |
|---|---|
| stage 留在 target 内 = 新引入的重复 skill 窗口 | 🔴 stage 移到 **`<client-config-root>/.geoly-tx-<gen>/`**（`~/.claude/.geoly-tx-17/`），与 target 同设备的兄弟目录，`rename` 仍原子但不在客户端扫描树里。**target 内真的只剩面包屑** |
| USTAR `name` 只有 100 字节，v2 允许 200 字节路径 | §4.3：路径必须能按 `/` 切成 `prefix ≤ 155` + `name ≤ 100`；结构门直接判这个条件，不判总长 |
| macOS Unicode 归一化未闭合 | D9 的 ASCII-only 直接消除 |
| 面包屑被复制 → 两个 target 争同一账本 | §3.3：面包屑记 `for_realpath`；不符即停机，要求显式 `adopt --rebind` 或 `--discard`，**绝不自动猜** |
| `latest` 会选中 `degraded` 然后安装必失败 | `latest` 排除 `degraded`；全版本 `degraded` 时明确报「无可安装版本」并列出各版本被哪个成员拖累 |
| `--project` 与 lockfile 无共同提交协议 | §8.1：lockfile 更新进同一份 journal（`lockfile_pending` phase），最后一步写；多 target 共享仓库 lockfile 时只在**全部成功后**写一次，任一失败则不写并如实报告 |
| schema 只是名字和示例，不是 wire contract | 新增 [`11-wire-contract.md`](11-wire-contract.md)：拒绝重复 key / 拒绝未知字段 / 拒绝 `null` / 数字与时间格式 / 摘要书写 / 数组顺序参与确定性 / canonical JSON / 原子写 / `schema` 主版本不同即拒绝 / **未定义即拒绝** |
| 命令面缺 flag | 补 `--yes-i-really-want-everything`、`recover --continue/--rollback/--reinstall/--release-frozen`、`adopt --rebind/--discard`；删 `--force-unlock` 与 `--assume-idle`；新增退出码 10（需 adopt）与 11（CLI 版本过低） |
| D4 措辞 | 改为「默认避免歧义；显式 flag 可允许歧义」，不再说加了 flag 仍「不制造歧义」 |
| **v2 自查发现的回归** | 重写 04 时把 v1 的「不自己写 tar reader」整节弄丢了（Codex 未提），v3 补回为 §7 |

## 交叉引用

08 的 rollback 链接 §4.3 → §5.5；08 的护栏链接 §9 → §10；10 的 Q6 → 04 §7（解包，不是 lockfile）。
Q9（stage 可见性）随 stage 移出 target 而消失；新增 Q11（`flock` 在 Node/macOS/Linux 上的一致性），
并写明退路：若拿不到 `flock`，唯一诚实的答案仍是「不提供抢锁，只能人工停掉持有者」。

## 仍然开放

Q4（token 收窄，M3 前）、Q5（验签依赖体积）、Q6（解包库选型）、Q10（跨 Node/zlib 归档确定性）、
Q11（flock 一致性）。全部是**实现期可回答**的，不阻塞接口定型。
