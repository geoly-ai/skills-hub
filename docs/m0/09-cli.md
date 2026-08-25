# M0 · CLI 命令面

包名 `@geoly/skills-hub`，bin `skills-hub`。

## 0. 平台契约（D1）

支持 **macOS / Linux / WSL**。`win32` 且非 WSL → **直接拒绝运行**并给 WSL 指引。
不支持的文件系统（NFS / SMB / FUSE / 跨设备 overlayfs）→ 拒绝安装并报出 fstype。
🔴 **Node ≥ 22.13**（锁依赖内建的 `node:sqlite`；`DatabaseSync` 自 22.5.0 存在，但**到 22.12 为止仍需 `--experimental-sqlite` 启动开关**，22.13 起默认启用）。CI 的锁集成测试必须同时跑最低版本与当前 LTS。
依赖锁版本、个位数、CI 跑 `npm audit` + 许可证检查。

## 1. 命令

| 命令 | 说明 | 阶段 |
|---|---|---|
| `install <spec>…` | 装制品 | M1 / pack 在 M2 |
| `install --all` | 全部兼容 skill（强确认，§3） | M2 |
| `list [--packs] [--installed] [--outdated]` | 列制品 | M1 |
| `search <kw>` | 搜 name / description | M1 |
| `check` | 两阶段校验（§4） | M1 |
| `why <name>` | 谁请求装的（读账本 `roots` + `requested_by`） | M1 |
| `sync-lock` | 在 repo 锁下重算并原子写 `geoly-skills.lock.json`（[`04-install.md`](04-install.md) §8.1） | M1 |
| `recover [--continue \| --rollback \| --reinstall] [--release-frozen <label>]` | 处理残留事务（§2.1） | M1 |
| `vendor <pack-spec> --out <dir> [--layout flat]` | 物化 pack 成员为目录树 | M2 |
| `update [<spec>] \| --all` | 受控地改 lockfile 并应用 | M4 |
| `remove <name>` | 减引用；为空才删目录 | M4 |
| `login` / `logout` | GitHub device flow | M3 |
| `publish [path] [--pack]` | 投稿 | M3 |
| `status [<submission>]` | 查投稿状态 | M3 |

### 1.1 `recover` 的子 flag

| flag | 语义 |
|---|---|
| `--continue` | 按 [`04-install.md`](04-install.md) §5.4 的**段模型**幂等重跑续做。<br>🔴 **物理 `journal.items[*].state = corrupt` → 拒绝**（只能 `--reinstall` 或人工）。<br>🔴 `adopt` 的 `assertion-corrupt` → 拒绝（它的出路是 `--rollback`）。<br>🔴 `unadopt` 的 `assertion-corrupt` → **这里是它唯一的自动出路**：把目录严格恢复为断言的 `D` 后复验成功，即转回 `ok` 并继续 |
| `--rollback` | 🔴 **分流**：物理 `journal.items[*].state = corrupt` → **拒绝**；`adopt` 的 `assertion-corrupt` → **允许**（撤销认领，安全）；`unadopt` 的 `assertion-corrupt` → **拒绝**（恢复认领会让账本错认一棵非制品目录）。<br>放行后按 [`04-install.md`](04-install.md) §5.4.1 的**反向段**逐项复位（rollback 自身也有 journal 方向、可续做）—— **不是一律从 attic 解包**，多数是 `retired → target` 的 rename；复位完成后用 `ledger_image.pre` 写账本并重算 lockfile |
| `--reinstall` | 🔴 **仅物理 `corrupt`**（即 `journal.items[*].state = corrupt`）可用：丢弃当前两份树，重新解析安装。🔴 **「丢弃」不含 audit plane** —— live `audit`、`audit-archive/`、`audit-seq`、`audit_archived_until` 一律保留。<br>🔴 顺序：先过 §5.2 **2a** → 再按 [`04-install.md`](04-install.md) **§5.10 的 repair intent 状态机**隔离并重装（枚举不出完整计划就拒绝自动执行、转人工）→ 才进入 **2c** 的阈值归档与新事务。<br>🔴 **逻辑断言异常的例外**（[`04-install.md`](04-install.md) §5.4 通用规则）：存在**任一** `assertion-corrupt`（`adopt` 或 `unadopt`）→ **本命令不自动执行**，此时物理项也只能转人工 |
| `--from-generation <N>` | 事务**早已 `completed`** 之后，按该代的 attic manifest 复位（[`04-install.md`](04-install.md) §5.8）。加 `--only <name>`（🔴 **可重复**：`--only a --only b`）可只复位一个完整闭包；重复给同一个 name 视为一次（去重）；闭包不完整时 CLI **拒绝并列出要一起选的全部 name**，由用户原样重提（[`04-install.md`](04-install.md) §5.8.1） |
| `--reset-generation <N>` | 🔴 仅当 `<target>/.geoly/generation` 缺失时可用（契约见 [`04-install.md`](04-install.md) §5.9）。**作用域是单个 target**：多目标时必须配 `--clients <单个>`（或 `--project` 下的单一 target），否则拒绝 —— 不同 target 的水位互不相干，一个 `<N>` 套不上所有 |
| `--release-frozen <label>` | 释放 `--freeze-attic` 冻结的 attic（迁移收尾用，[`08-matrix-migration.md`](08-matrix-migration.md) §5.1） |
| `--resume-cleanup` | 显式续做 `cleanup_pending`（正常情况下下一次运行会自动续做，[`04-install.md`](04-install.md) §5.6） |

🔴 **没有 `--force-unlock`，也没有 `--clear-lock`。** 锁是 `node:sqlite` 的排他事务，
**进程退出由内核释放**——崩溃后下一次运行直接就能取到，不需要任何人工干预。
锁被别的活进程占用时，CLI 退出（码 5）。🔴 措辞只能是
「**上一次持锁的是 pid X（可能已不是当前持有者）**」——
锁只证明「有一个活持有者」，`holder` 表里的 pid 不保证就是它
（[`04-install.md`](04-install.md) §5.1）。

## 2. 全局 flag

| flag | 默认 | 说明 |
|---|---|---|
| `--clients <list>` | 本机已存在的全部 | 含未安装 client 时是硬错误 |
| `--create-missing <client\|all>` | 关 | 允许创建目录 |
| `--project [path]` | 关 | 装到仓库内，维护 `geoly-skills.lock.json` |
| `--shadow-global` | 关 | 全局已有同名时，项目级安装才允许继续（D4） |
| `--snapshot <N>` | timestamp 指向的最新 | 钉快照复现（[`02-registry.md`](02-registry.md) §6.2） |
| `--offline` | 关 | 只用缓存；未命中即失败 |
| `--allow-stale` | 关 | timestamp 过期时才允许继续，输出持续标注 stale |
| `--allow-yanked` | 关 | 仅取证；大声告警并写进账本 |
| `--replace <name>` | — | 点名替换未被账本认领的同名目录 |
| `--no-bundled` | 关 | 装 pack 时跳过 `role: tool` 成员 |
| `--freeze-attic <label>` | — | 冻结本次 attic，不参与保留代数清理 |
| `--keep-generations <N>` | 3 | attic 保留代数 |
| `--json` | 关 | 机器可读输出 |
| `--yes` | 关 | 跳过可跳过的确认。**不能**替代 §3 的全量确认 |
| `--yes-i-really-want-everything` | 关 | **仅** `--all` 在非交互下使用（§3） |
| `--pre` | 关 | 允许预发布版本 |

**没有** `--no-verify`、`--insecure`、`--force`、`--force-unlock`、`--assume-idle`。

- 验签与摘要校验不可关闭；
- 替换必须点名（`--replace`）；
- 陈旧、yank、全量各有独立开关，不共用一个大锤；
- `--assume-idle` 随 D5 删除 —— 本工具**不检测也不阻断**正在运行的 agent
  （[`04-install.md`](04-install.md) §9）。

## 3. `--all`（⑥A）

= 当前快照里全部 `kind: skill`、`status: published`、且声明支持该 target client 的制品。
不含 pack、`deprecated`、`degraded`、`yanked`、prerelease。

- 交互式：列出**完整名单与数量**，要求输入**数量数字**确认（不是敲回车）。
- 非交互：必须 `--yes-i-really-want-everything`。`--yes` **不够**。
- 一律打印告警：装太多 skill 会让 agent 的路由判定互相竞争。

日常「一键装一组」的正确入口是 `install pack:<name>`。

## 4. `check` 的两阶段

| 问题 | 依据 |
|---|---|
| 磁盘上的字节对不对 | 账本记录的**安装时快照**（按 [`02-registry.md`](02-registry.md) §6.1 的历史读取路径取回并验签），重算树摘要比对 |
| 这东西现在还该不该用 | **当前 timestamp 指向的快照**里的 `status` / `yanked` / advisory |

`--offline` 时第二问答不了 → 输出标注
`状态未知（离线，最后验证于 <时间>）`，**不得默认为「正常」**。

还必须如实报告项目级/全局并存，不声称哪份生效（[`04-install.md`](04-install.md) §8.2）。

## 5. 解析规则

1. 含 `@` → 精确版本；否则取 `latest`（非 yank、非 prerelease、**非 `degraded`**）。
2. 含 `/` → namespace 已定；否则 ①先在 `geoly` 里找 ②全快照找唯一匹配
   ③多 namespace 同名 → **报错列候选**，不猜。
3. `pack:` 前缀强制 kind；无前缀且同名同时存在 skill 与 pack → 报错列候选。
4. 目标 pack 的全部版本都 `degraded` → 报「无可安装版本」并列出各版本被哪个成员拖累。

## 6. 退出码

| 码 | 含义 |
|---:|---|
| 0 | 全部成功（`skipped: 目录不存在` / `skipped: unsupported` 算成功） |
| 1 | 用法错误 / 解析失败 / 候选歧义 |
| 2 | **完整性失败**：验签失败、摘要不符、算法不认识、资产 sha256 不符、签名身份不对 |
| 3 | 冲突未解决 |
| 4 | 部分 target 失败 |
| 5 | 残留事务需 `recover`；或锁被占用（🔴 措辞只能是「上一次持锁的是 pid X，**可能不是当前持有者**」） |
| 6 | 网络 / 缓存未命中 |
| 7 | 需要认证或权限不足 |
| 8 | **陈旧**：timestamp 过期且未给 `--allow-stale` |
| 9 | 平台 / 文件系统不受支持；或 `.geoly` 是挂载点、检出嵌套 target（[`04-install.md`](04-install.md) §3.4、§3.5） |
| 10 | target 不可写（无法创建 `<target>/.geoly/`） |
| 11 | CLI 版本低于 timestamp 的 `min_cli_version` |

## 7. 输出契约

- 人类输出 stdout；进度与告警 stderr。
- `--json` 时 stdout **只有**一个 JSON 对象。
- 每次 `install` 结尾必须打印逐 target 结果表，即使全部成功。**不允许只打一句 done。**
- stale / offline / yanked / degraded / shadowed 必须在**每一次**相关输出里重复标注。
