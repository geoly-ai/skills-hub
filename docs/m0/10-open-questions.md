# M0 · 留给 M1 的问题

v1 列了 8 个。Codex 第二轮指出其中 5 个是**承诺的正确性依赖**，已在 v2 定死；
第三轮又指出 2 个（路径字符集、交换语义），已在 v3 定死。本文件只剩真正能推迟的。

## 已定死（不再是问题）

| 原编号 | 决定 | 落在 |
|---|---|---|
| Q1 账本位置 | **D2′**（v8 反转）：全部 per-target 状态回到 `<target>/.geoly/`。bind-alias 反例证明相邻位置躲不掉 —— 同一棵树可以有任意多个 parent | [`04-install.md`](04-install.md) §3 |
| Q2 遮蔽规则 | **D4**：全局已有同名时项目级默认拒绝；`--shadow-global` = 用户明确接受歧义 | [`04-install.md`](04-install.md) §8.2 |
| Q3 活跃 agent 检测 | **D5**：不检测、不阻断、不提示，只在 README 记为已知限制；`--assume-idle` 删除 | [`04-install.md`](04-install.md) §9 |
| Q7 lockfile 命名 | **D6**：`geoly-skills.lock.json` | [`04-install.md`](04-install.md) §8 |
| Q8 `contract_paths` | **D8**：本版 ∪ 上版，只增不减；变更即升 Tier 2 | [`03-packs.md`](03-packs.md) §3.1 |
| Q9 stage 可见性 | **并入 Q12**。v8/v9 之后 stage 就在 `<target>/.geoly/tx-*` 内，与账本、journal、attic 同处一地 —— 是否被客户端发现由 Q12 的 adapter 验收门统一回答 | [`04-install.md`](04-install.md) §3.2 |
| （v3 新）路径字符集 | **D9**：ASCII-only。一并解决 macOS 归一化、USTAR 编码、同形字混淆 | [`01-artifacts.md`](01-artifacts.md) §4.1 |
| （v3 新）交换语义 | **D10**：承诺改为「不会读到半棵树，但可能短暂读不到」；不引原生 syscall 绑定 | [`04-install.md`](04-install.md) §5.7 |

## 仍然开放

### Q4 · `publish` 的 token 能不能收窄到单仓

`public_repo` 能改用户所有公开仓，远大于所需。候选：GitHub App（权限细到单仓）。
**时间点统一在 M3 之前。**

**实验**：验证 App 能否在用户 fork 上开 PR 到上游。

**落到**：[`06-submission.md`](06-submission.md) §9。M3 来不及则用 `public_repo` 上线，
但 `login` 时必须明确告知权限面，README 列为已知残余风险。

### Q5 · 验签依赖的体积与冷启动

`npx` 每次冷启动都要下载整个包。验签库若大，会拖慢最高频的「装一个 skill」。

**实验**：量含/不含验签依赖时 `npx … list` 的冷启动耗时与包体积。

**落到**：若差距不可接受，考虑把验签放进 optional 子包 ——
🔴 **默认路径必须验签**，不接受「默认不验、可选开启」。

### Q6 · 解包库选型

候选 node-tar。需确认：能否逐条 entry 过滤而不落盘、能否**完全禁用** symlink/hardlink 处理、
遇到 PAX/GNU 扩展头能否**报错而非静默忽略**。

若没有库满足「拒绝扩展头」，则在库之外先做一遍原始 tar 头扫描。

**落到**：[`04-install.md`](04-install.md) **§7**（解包策略层）的依赖名与版本。

### Q10 · 确定性归档在不同 Node / zlib 版本间是否稳定

[`02-registry.md`](02-registry.md) §4.1 要求 promotion 与 release 两次打包字节一致，
但两者可能跑在不同 Node / zlib 上。

**实验**：跨 Node 20 / 22 / 24 与不同 zlib 构建比对同一载荷的 `.tar.gz` 字节。

**落到**：若不稳定 → 改为「promotion 生成的资产字节**作为构建产物直接传递**给 release」，
确定性只需在单次运行内成立。

### ~~Q11 · 锁原语~~ —— v6 已实测定死

v5 用「`O_EXCL` 创建 + 人工 unlink」，评审指出 **`unlink` 无条件按路径删除**，
两个合法的清锁交错就能删掉第三方刚建的锁 —— 竞态没消掉，只是换了触发者。

v6 改用 **`node:sqlite` 的 `BEGIN EXCLUSIVE`**：Node 内建、无原生依赖、
进程退出由内核释放、**协议里没有任何 unlink**。

实测（2026-08-25，Node v25.2.0 / macOS APFS）：活持有者阻塞 ✓；`SIGKILL` 后自动释放 ✓；
持锁期间可读持有者信息 ✓；npx 冷启动无可测量差异 ✓；取锁+提交+关闭 ≈ 8.7 ms。

代价：Node 门槛 20 → **22.13**（22.12 及以前仍需 `--experimental-sqlite` 开关）；`ExperimentalWarning` 需在任何 import 之前抑制，用法封在适配层；
SQLite 在网络文件系统上不可靠（与已有的「拒绝 NFS/SMB/FUSE」对齐）。详见
[`04-install.md`](04-install.md) §5.1。

### 🔴 Q12 · `<target>/.geoly/` 的 discoverability —— **M1 的阻塞验收门**

D2′ 把全部 per-target 状态放回 target 内，因此「客户端忽略它」从「未实测假设」
变成**规范唯一依赖的一条假设**，必须验，且是**门不是实验**。

**验收用例**（四端 × 全局/项目级）：

在 target 内造出真实形态 ——
`<target>/.geoly/lock.db`（含 `-wal`/`-shm`）、`<target>/.geoly/ledger.json`、
`<target>/.geoly/tx-1/stage/<name>/SKILL.md`、`<target>/.geoly/attic/1/<name>.tar` ——
启动客户端，确认：**不被当作 skill 加载、不报错、不影响其它 skill 的加载与路由。**

- 🔴 **M1 的 adapter 未过此用例不得合入。**
- 某一端不通过 → **只把那一端标为不支持**，不改整体设计。
- 🔴 门要**绑定具体客户端版本**，adapter 或客户端升级时**复测**。
- 测试用的 staged `SKILL.md` 必须是一个**可被识别、有效且唯一**的 skill —— 否则测不出。
- 项目级另需：`.gitignore` 忽略 adapter 派生的实际路径
  （`/.claude/skills/.geoly/` 等，**不是**根上的 `/.geoly/`）；
  README 说明 🔴 `git clean -xfd` 会删掉整个 `.geoly/` —— **既包括进行中的事务状态，也包括本地 audit 历史**。
