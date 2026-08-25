# M0 · 1C 切换方案：matrix 仓归档，hub 成唯一源

## 1. 爆炸半径（已核实，2026-08-24）

`chovizzz/plaud-theme-matrix`：**公开，0 star，0 fork**，最新 tag `v0.3.6`。
没有仓库外的未知使用者，只有以下已知下游：

| # | 下游 | 引用方式 | 归档后是否受影响 |
|---:|---|---|---|
| 1 | 四端本机安装 `~/.{claude,cursor,codex,agents}/skills/plaud-theme-*` | `install.sh --ref vX.Y.Z` | 会（安装器不再是入口） |
| 2 | `shopify-plaud-yidian` 的 `.github/codex/plaud-theme-matrix/`（vendored 副本） | `VENDORED.md` 里的同步命令 `git clone … chovizzz/plaud-theme-matrix` | 会（命令要改指向） |
| 3 | `shopify-plaud-yidian` 的 `.github/scripts/codex-pr-spec.mjs` | 读**本地** vendored 副本，`POLICY_ROOT` 常量 | 否（路径不变，只是内容来源换了） |
| 4 | 中转仓 `chovizzz/plaud-pr-review-relay` | 从主题仓 checkout 那份 vendored 副本 | 否（不直连 matrix 仓） |
| 5 | `~/workspace/skills-lock.json` | 需核对是否含 matrix 条目 | 待查（M2 前确认） |

结论：**只有 #1 和 #2 需要改**。#3 #4 靠 #2 间接完成。

## 2. 🔴 归档不会让 raw 链接 404 —— 而墓碑只挡得住其中一半

GitHub 归档的仓库仍然公开可读，`raw.githubusercontent.com/.../main/install.sh`
**继续正常返回**。旧的一行安装命令不会自己失效，而是会**继续装出一套过时的东西**——比 404 更糟。

**但墓碑挡不住带 `--ref` 的调用。** 先例安装器明确支持
`… | sh -s -- --ref v0.3.6`，而墓碑只改 `main` 分支上的那一份。
任何指向历史 tag、历史 commit、fork 或本地缓存的调用**仍会执行旧安装器**，
而历史 tag 又必须为 provenance 永久保留（§7），删不掉。

因此措辞必须诚实：

| ✅ 墓碑能做到 | ❌ 墓碑做不到 |
|---|---|
| 让 branch-based URL（`/main/install.sh`）停止安装并打印新命令 | 阻断 `--ref vX.Y.Z` |
| 让 `auto-update` 停下来并告知用户 | 阻断历史 commit / fork / 缓存 |
| **降低误用** | **阻断旧入口** |

（v1 写的是「阻断旧入口」，那是个兑现不了的承诺。）

真正让旧路径失效的只有一件事：**在每台机器上完成切换（步骤 ③）**，
之后旧安装器即使被跑到，装出来的东西也会被 `check` 立刻标出。

因此归档前必须先落墓碑：

**归档前最后一个 commit**（打 tag `v0.3.7-tombstone`，写进 CHANGELOG）：

- `install.sh` / `install.ps1` 整体替换为墓碑脚本：打印新命令、**退出码非零**、不安装任何东西；
- `README.md` 顶部加迁移说明与新仓地址；
- `auto-update/update.py` 同样墓碑化（它会定期跑，必须让它停下来并告知用户）；
- `release-meta.json` 的 `compatibility` 置 `breaking`，`headline` 写迁移。

墓碑脚本**不做自动转发**。理由：一条 `curl | sh` 静默换成从另一个仓下载并执行，
正是我们在 [`07-threat-model.md`](07-threat-model.md) 里要防的形状。让人自己看一眼再跑新命令。

## 3. 版本连续性

matrix 的 10 个矩阵 skill + 1 个附带 skill，按 `v0.3.6` 的**字节**导入：

| hub 制品 | 版本 | provenance |
|---|---|---|
| `skill:geoly/plaud-theme-shared` … 等 10 个 | `0.3.6` | `origin_ref: v0.3.6`，`origin_commit: 0aa7711707bcc3a7856a558e6cb9ca28b79555bf` |
| `skill:geoly/yidian-draft-pr` | `0.3.6`（首版跟随，之后独立走自己的 semver） | 同上 |
| `pack:geoly/plaud-theme-matrix` | `0.3.6` | 成员锁定上面 10 个 + `bundled` 里的 `yidian-draft-pr` |

### 3.1 🔴 双摘要 —— v1 的验证承诺是错的

hub 强制每个 skill 有 `skill.json`，而上游 `v0.3.6` 的树里没有这个文件。
**加了文件，摘要就不可能与上游相等。** v1 那句「任何人算出的上游摘要应与
hub 的 `tree_digest` 一致」当场作废。

v2 记两个值（定义见 [`05-lifecycle.md`](05-lifecycle.md) §6.1）：

| 字段 | 覆盖 |
|---|---|
| `provenance.origin_tree_digest` | 上游 `v0.3.6` 的 `plaud-theme-dev/` 原始文件 |
| `tree_digest` | 上游文件 + 新增的 `skill.json` |

CI 门 `scripts/verify-vendored.mjs` 校验：hub 载荷**去掉 `added_files` 白名单里的文件后**，
逐字节等于上游那棵树，摘要 == `origin_tree_digest`。
`added_files` 只允许 `["skill.json"]`；任何其他新增、任何修改、任何删除都让门失败。

（导入 PR 上跑一次即可；matrix 仓归档后该门可退役，但两个摘要值永久留在快照里。）

导入之后：**每个 skill 各自走自己的 semver 线**，pack 版本另走一条线。
`plaud-theme-dev` 改一处文案 → `0.3.7`；pack 若只是跟随成员变化 → `0.3.7`。
两条线号码会逐渐分叉，这是预期行为，文档要写清楚。

## 4. 不导入的东西

matrix 仓里这些**不是 skill 内容**，其职能由 hub 承担，不进制品：

| 文件 | 去向 |
|---|---|
| `install.sh` / `install.ps1` | 被 `@geoly/skills-hub` CLI 取代。护栏逻辑按 [`04-install.md`](04-install.md) §10 移植 |
| `auto-update/update.py` / `vendor_sync.py` | 被 `update` 命令 + lockfile 取代 |
| `auto-update/check_release_meta.py` | **职能保留**：契约文件零差异门，移植为 `scripts/check-pack-compat.mjs`（[`03-packs.md`](03-packs.md) §3） |
| `RELEASING.md` | 被 `docs/` + promotion PR 流程取代 |
| `release-meta.json` | 被 pack 的 `compatibility` 字段取代 |
| `MATRIX.md` / `AGENTS.md` / `README.md` / `CHANGELOG.md` | 作为 pack 载荷的说明文档带进 `pack:geoly/plaud-theme-matrix` |

`auto-update/tests/` 里的用例要在移植时逐条对照，作为 M1 故障注入用例的起点。

## 5. 切换顺序（不可调换）

```
① hub 侧准备好，并且真的能装出来
   M2 完成：hub 上 pack:geoly/plaud-theme-matrix@0.3.6 已发布、已签名，
   四端一条命令装出来 + check 全绿。此前不动 matrix 仓一根手指。

② 改下游 #2
   shopify-plaud-yidian 的 VENDORED.md 同步命令改为从 hub 取制品；
   开 PR，跑一次 CI 审查确认 codex-pr-spec.mjs 的 readPolicy() 断言仍通过；
   POLICY_VERSION 递增。

③ 各机器重装
   每台开发机跑一次 hub 的 install，然后 check 确认与旧安装字节一致。
   ⚠️ 这一步会遇到「未被账本认领的同名目录」——旧的 plaud-theme-* 是 matrix 安装器装的。
   走 --replace 点名路径（归档 → 逐文件验证 → 删除），不要用任何批量绕过。

④ matrix 仓落墓碑（§2），打 v0.3.7-tombstone

⑤ 归档 matrix 仓（Settings → Archive）
```

🔴 **①②③ 全绿之前不做 ④⑤。** 墓碑之后就没有回头路了：旧安装器不再能装。

### 5.1 🔴 迁移期必须冻结 attic

步骤 ③ 的回滚依赖每台机器 `<target>/.geoly/attic/<gen>/<name>.tar` 里那份旧目录，
但 attic 默认只保留 3 代 —— 迁移后再装几次，⑥ 所说的「从 attic 回滚」就不成立了。

因此步骤 ③ 必须用 `--freeze-attic <label>`：
被标记的 attic 条目**不参与保留代数清理**，只能由 `recover --release-frozen <label>` 显式释放。

🔴 **事务早已 `completed` 之后要从冻结的 attic 回滚**，用
`recover --rollback --from-generation <N>`（[`09-cli.md`](09-cli.md) §1.1）——
v7 只承诺「可以从 attic 回滚」，却没有能选 generation 的命令。
迁移完全稳定（建议观察两周）之前不释放。

另：步骤 ③ 之前，每台机器额外做一次**仓库外的完整备份**
（`tar` 整个 `~/.claude/skills` 等四个目录到本地某处），不依赖工具自身的机制。

## 6. 回滚

在 ⑤ 之前的任何一步失败：
- ④ 之后 ⑤ 之前 → 取消归档不需要（还没归档），revert 墓碑 commit 即可；
- ③ 失败 → 每台机器从 `attic` 回滚（[`04-install.md`](04-install.md) §5.8），旧安装器仍可用；
- ② 失败 → revert 那张 PR，vendored 副本回到从 matrix 取。

⑤ 之后要回滚需要先取消归档（GitHub 支持 unarchive），然后 revert 墓碑 commit。
代价是这期间任何跑过旧命令的人拿到的是墓碑输出——可接受。

### 6.1 真正不可逆的三个点

| 点 | 为什么不可逆 | 怎么办 |
|---|---|---|
| **hub 发布了 `0.3.6` 快照与制品** | 按 §01-1 永久保留、版本号永久占用。失败时只能 yank，**不能称为「完全回滚」** | 步骤 ① 必须在**真发布之前**用本地 registry 演练一遍完整链路 |
| **本机 attic 的保留代数** | 再装几次旧副本就没了 | §5.1 的 `--freeze-attic` + 仓库外完整备份 |
| **matrix 历史 tag** | 必须为 provenance 永久保留，因此 `--ref` 路径永远存在 | 接受，并按 §2 诚实描述 |

## 7. matrix 仓的长期处置

**归档，不删除。** 理由：

- provenance 里的 `origin_commit` 需要它可读，才能验证导入的字节；
- 历史 tag（v0.1.0 … v0.3.6）是唯一的历史证据；
- 归档是可逆的，删除不是。
