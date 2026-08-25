# M0 · 威胁模型

## 1. 要保护什么

| 资产 | 被破坏的后果 |
|---|---|
| 用户机器上 skills 目录的内容 | agent 按恶意指令行事：读凭据、外发数据、改仓库 |
| 用户的 GitHub token（`publish` 用） | 攻击者能改用户所有公开仓 |
| hub 的发布链（快照 + 签名 + npm 包） | 一次投毒影响全部使用者 |
| 已发布制品的字节 | 「审过的东西」与「装到的东西」不是一个东西 |
| 事故取证能力 | 出事之后无法判断谁装了什么 |

## 2. 对手

| 对手 | 能力 |
|---|---|
| **A. 恶意投稿者** | 能提交任意内容、开任意 PR、注册 namespace |
| **B. 被接管的投稿者账号** | A 的能力 + 已有 namespace 的所有权 |
| **C. 被接管的维护者账号** | A/B + approve + merge + 改 workflow |
| **D. 中间人 / 恶意镜像** | 篡改传输中的字节 |
| **E. 本机同权限进程** | 改本地账本、缓存、target 目录 |
| **F. 上游仓（vendored 来源）** | 移动 tag、改默认分支 |
| **G. 分发前端** | 返回**旧的、签名依然有效**的元数据（回放） |

## 2.1 🔴 被承认的信任锚（不假装它被覆盖了）

「TUF 根内置在 CLI 里、CLI 靠 npm provenance」**不是自洽闭环**：
`npx` 不会替用户强制验证 provenance，被替换的 CLI 也可以谎称自己验过。

因此规范明确承认：**第一跳的信任锚是 npm registry + TLS + 用户对所执行包的信任。**
provenance 提供的是**可追溯性**，不是 CLI 的自证完整性。

外部可验证的引导路径（供不接受该锚的使用者）：
从 GitHub Release 直接取 CLI tarball 与其 Sigstore bundle，离线验签后本地安装。
README 必须给出这条路径。

## 3. 攻击路径与缓解

| # | 路径 | 对手 | 缓解 | 残余风险 |
|---:|---|---|---|---|
| 1 | `SKILL.md` 里埋 prompt injection（诱导 agent 读环境变量、执行命令、外发文件、忽略系统指令） | A | 人工审查清单（[`06`](06-submission.md) §6）；capability 分级；非 `geoly` 的 Tier 1/2 装前确认 | 🔴 **高**。安装器不执行载荷 ≠ 使用时无害。这是**没有自动解**的一类 |
| 2 | Unicode 混淆 / 零宽 / 双向控制符 / base64 / 拆词绕过关键词扫描 | A | 载荷强制 NFC；渲染审查视图时高亮不可见字符与 bidi；关键词扫描**只用于排优先级** | 中。人眼仍会被绕 |
| 3 | 间接指令：正文说「按 `https://…` 那份文档做」 | A | 审查清单第 6 条；`network` capability 强制声明 | 中 |
| 4 | 抢路由：宽泛 `description` 或近名 | A | 归一化重名硬拒；近名进审查清单；`conflicts` | 中 |
| 5 | 审核后改内容：上游移动 tag / 改默认分支 | F | provenance 记 **40 位 commit SHA** 而非 tag；hub **物化**副本（①C 之后 hub 就是唯一源，此路径基本消失） | 低 |
| 6 | 篡改传输字节 | D | 快照 Sigstore 签名 + 资产 sha256 + 解包后重算树摘要 | 低 |
| 6f | 🔴 **本机时钟**被拨慢 → 过期 timestamp 仍被接受，回放窗口被拉长 | E | 无密码学解。fail-closed 的一侧（时钟拨快）只造成拒绝服务。规范如实承认时钟是 freshness 输入 | 中，**如实承认** |
| 6c | 🔴 **bootstrap 窗口**：本地无 trust floor 时（首次安装、新机器、清了 state），喂一份**旧但未过期**的 timestamp | D, G | **无法靠 timestamp 自身消除**，窗口最长 7 天。缓解：首次运行打印所取 timestamp 的 `version` / `created_at` 供人工对照；`GSA-` 公告必须给出受影响的 version 区间 | 🔴 **中，且明确承认** |
| 6d | 抢锁并发：两个进程同时改同一个 target，丢掉唯一旧副本 | E | `node:sqlite` 的 `BEGIN EXCLUSIVE`：进程退出由内核释放，**协议里没有任何 unlink**，因此不存在「删掉别人刚建的锁」这一类竞态（[`04-install.md`](04-install.md) §5.1） | 低 |
| 6e | 断电时唯一旧副本丢失 | — | 事务内**没有删除**：旧树 rename 进 `<target>/.geoly/tx-<gen>/retired/` 整棵保留（[`04-install.md`](04-install.md) §3.2）。删除只发生在事务之后的清理阶段，且 tar 持久并逐文件验证通过才删（§5.6）。新建目录链逐层 fsync（§5.2.1） | 低 |
| 6b | 🔴 **回放**：返回一份旧的、签名完全有效的快照，使 yank 失效、旧漏洞版本重新可装 | D, G | **签名的 timestamp 元数据**（7 天有效 + 单调 `version`）+ 客户端记录的最低已见 `snapshot`/`timestamp_version`（[`02-registry.md`](02-registry.md) §3、§5） | 低 —— **但 v1 完全没有这一条，被评为 P0** |
| 7 | 投稿 PR 顺手改 CI / schema / 生成器 | A | 路径白名单硬拒 + CODEOWNERS + 这些路径只收 org 成员 PR | 低 |
| 8 | 诱导特权 workflow checkout fork head 偷 token | A | **禁用 `pull_request_target`**；`validate.yml` 无 secrets、只读 token、不执行载荷 | 低 |
| 9 | 自写 tar reader 的格式差异写出目录 / 解压炸弹 | A | 不自写：成熟库 + 自己的策略层 + 上限 + 隔离目录 + 解包后重算摘要 | 低 |
| 10 | 恶意/被改的 CLI 读走 `auth.json` | A, E | token 只在三条命令里读；优先 keychain；`0600`；`npx github:` 下拒绝 login/publish；npm provenance | 中（`public_repo` 权限面过大，见 [`10`](10-open-questions.md) Q4） |
| 11 | 维护者账号被接管，直接发一版投毒快照 | C | 分支保护（禁直推、必须 approve、stale dismissal）、Tier 2 双人 approve、promotion PR 二次审、确定性复算门、Rekor 透明日志 | 🔴 **中**。签名会如实签下投毒快照；透明日志只保证**事后可发现**。timestamp 的 `min_cli_version` 是紧急止血手段 |
| 15 | 归档字节不确定（gzip 时间戳等）导致 `asset.sha256` 对不上，逼迫实现放宽校验 | — | canonical tar.gz 格式（[`02-registry.md`](02-registry.md) §4.1）+ release 阶段字节级断言 | 低 |
| 16 | 摘要未覆盖目录 mode / xattr / ACL，两个运行语义不同的树同摘要 | A | 规范强制这些取值，并在解包策略层**拒绝**任何扩展记录（[`01-artifacts.md`](01-artifacts.md) §6.2） | 低 |
| 12 | 本机进程改账本，让 `check` 说「一切正常」 | E | `check` **从快照重算**，不读账本里的摘要值；账本只是定位信息 | 低 |
| 13 | 替换正在被读取的 skill 目录 | — | 两次整棵目录的 `rename`，事务内无递归删除，故不会读到半棵树。**本工具不检测、不阻断、也不提示**（D5′）：只在 README 记为已知限制 | 中，且**如实承认**（见 [`04`](04-install.md) §9） |
| 13b | 🔴 **能改仓库的人改 lockfile**，换成另一个**已签名、未 yank**的制品，或改 `no_bundled` | 🔴 **能使受信任 checkout 发生该修改的人**（不是泛称的 A：外部投稿者做不到这件事） | §8.1 的闭包只能保证「不装未签名字节、不写出 adapter target」。**它挡不住这个** —— 这与任何包管理器的 lockfile 是同一条信任边界（能改 lockfile 的人本来就能决定项目装什么）。要更强只能给 lockfile 签名，或在本地另存一份已批准图并强制 `update` 走 diff 确认 | 中，**如实承认，v1 不做** |
| 14 | 装了之后上游 yank，用户不知道 | A/B | `check` 报告 yank 状态与 advisory；`update` 阻断 | 低 |

## 4. 🔴 安全剧场清单

以下**不是**安全门，只能用来排人工审查的优先级。文档、PR 模板、对外说明里都不得
把它们描述成「保障」：

- `license` 字段存在、frontmatter 通过 schema、版本号递增、PR 模板填写完整、自测说明；
- 危险词正则（`curl … | sh`、`rm -rf`、外发 URL）—— §3 路径 2 一行就绕过；
- gitleaks / secret 扫描 —— 只找已知格式的密钥，不判断指令是否恶意；
- 投稿者自己声明的 digest / 自己声明的 capability；
- 单靠 `CODEOWNERS` —— 它不做内容分析，不阻止 stale approval，不阻止账号被接管。

真正的自动门只做**结构与完整性**；真正的内容门是**人**，加上未来的对抗性 eval。

## 5. 明确不在范围内

- 判定一个 skill 的**指令是否会让 agent 做坏事**的自动化方法。M0 承认这做不到。
- 保密性（⑧A：v1 不做私有）。仓库公开 = 全部投稿与审查记录公开。
- 供应链的更上游：GitHub、npm、Sigstore、Node、依赖库自身被攻破。
- 用户机器已被攻破的情形（对手 E 拥有完全控制时，本地任何检查都不可信）。
- DoS：投稿量攻击、release 资产带宽。靠 GitHub 自身限流与维护者关闭投稿。
- **Windows 原生**（D1）。v1 只支持 macOS / Linux / WSL。
- **不受支持的文件系统**（NFS / SMB / FUSE 等）。CLI 直接拒绝在其上安装，
  而不是在上面提供一个较弱的保证。

## 6. 事故响应

1. yank 受影响版本（[`05`](05-lifecycle.md) §5），发 `GSA-<年>-<序号>`。
2. 若涉及发布链（对手 C）：撤销相关 OIDC 配置、轮换 CODEOWNERS、
   用 Rekor 日志列出该时间窗内全部签名快照，逐个复核。
3. 公告里必须写明：**受影响的 snapshot 区间**与**如何判断自己装了没有**
   （`npx @geoly/skills-hub check` 的具体输出特征）。
4. 不删任何制品或快照——取证需要它们。
