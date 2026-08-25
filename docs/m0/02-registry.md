# M0 · 注册表：快照、timestamp、防回放、签名与验证链

## 1. 三个签名对象

| 对象 | 有效期 | 签名身份 | 解决什么 |
|---|---|---|---|
| `snapshots/hub-<N>.json` | 长期（只增不改） | `release.yml` | 「装到的东西是不是审过的」 |
| `timestamp.json` | **7 天** | **`timestamp.yml`（独立身份）** | 「我拿到的清单是不是**现在**的」 |
| `attestations/hub-<N>.intoto.jsonl` | 长期 | `release.yml` | 「这张快照是哪条流水线、从哪个 commit 生成的」 |

🔴 v2 把 snapshot 与 timestamp 交给同一个 `release.yml` 身份。timestamp 签名者拥有
「指向哪张已签快照」的高权限，必须**单独身份、单独最小权限**，且 CLI 分别固定两个 identity。

### 1.1 attestation（v3 新增）

P0-1 把 release commit SHA 从快照里删掉了，代价是失去「哪条流水线生成了它」的强审计。
补回来的方式不是塞回快照（那是自引用），而是**另发一个签名对象**：

```json
{ "subject": [{ "name": "hub-42.json", "digest": { "sha256": "…" } }],
  "predicate": { "buildType": "geoly-skills/release/v1",
                 "sourceRepo": "geoly-ai/skills-hub",
                 "sourceCommit": "9a71…",
                 "workflowRef": ".github/workflows/release.yml@9a71c3f0b2e14d5a8c6f37b9e0d4a1c85f2e6b30",
                 "promotionPr": 214 } }
```

它**绑定快照的 sha256 ↔ 源 commit**，单向依赖（`source commit → snapshot → attestation`），
不构成自引用。安装链路**不读它**；它只服务取证。

契约（v4 定死，v3 只给了示例）：

| 项 | 要求 |
|---|---|
| 封装 | **DSSE** envelope，`payloadType = application/vnd.in-toto+json` |
| `predicateType` | `https://geoly.ai/skills-hub/release/v1`（固定字符串，变更即升版本） |
| `subject[].digest.sha256` | 快照文件的 sha256，必须与 `timestamp.snapshot_sha256` 一致 |
| `sourceCommit` | **40 位小写 hex**，且该 commit 的树里必须包含与 subject 逐字节相同的快照文件 |
| `workflowRef` | 🔴 **不可变标识**：`.github/workflows/release.yml@<40 位 commit sha>`。**不接受 `@refs/heads/main`** —— 分支引用本身可变，写它等于没写 |
| 验证者 | 取证工具与人；CLI 的安装链路不读 |

## 2. 快照 schema `geoly.skills.snapshot/2`

```json
{
  "schema": "geoly.skills.snapshot/2",
  "snapshot": 42,
  "previous": 41,
  "created_at": "2026-08-25T12:00:00Z",
  "repo": "geoly-ai/skills-hub",

  "artifacts": [
    {
      "id": "skill:geoly/plaud-theme-dev@0.3.6",
      "kind": "skill", "namespace": "geoly",
      "name": "plaud-theme-dev", "version": "0.3.6",
      "path": "artifacts/skills/geoly/plaud-theme-dev/0.3.6",
      "tree_digest": "geoly-tree-v1:sha256:…",
      "asset": { "file": "skill_geoly_plaud-theme-dev_0.3.6.tar.gz",
                 "sha256": "sha256:…", "size": 48213 },
      "clients": ["claude","cursor","codex","agents"],
      "capabilities": ["none"],
      "replaces": [], "conflicts": [],
      "license": "MIT",
      "owner": { "kind": "github-user", "login": "chovizzz", "id": "U_kgDODu4RvA" },
      "provenance": { "…": "见 05-lifecycle §6" },
      "status": "published",
      "review": { "pr": 118, "approved_by": ["chovizzz"],
                  "head_sha": "c1d2…", "capability_tier": 0 }
    }
  ],

  "yanked": [ { "id": "skill:x/y@1.0.0", "at": "…", "reason": "…",
                "advisory": "GSA-2026-0001", "superseded_by": "skill:x/y@1.0.1" } ],

  "latest": { "skill:geoly/plaud-theme-dev": "0.3.6" }
}
```

### 2.1 🔴 快照里不含**生成/承载它自己**的 commit SHA

v1 把「本快照对应的 commit」写进快照，而快照本身参与那个 commit 的 hash 计算 —— **不可构造**。

v3 的准确表述（v2 的措辞过宽，已改正）：

| 允许存在 | 为什么不是自引用 |
|---|---|
| `review.head_sha` | 指向**投稿 PR 的 head**，早于本快照存在 |
| `provenance.origin_commit` | 指向**上游别的仓库**的 commit |
| （无） `release commit` / `snapshot commit` | 这两个才会自引用，已删除 |

git 坐标一律是**定位提示，不是信任输入**。真伪只看 `tree_digest`。

### 2.2 `created_at` 与确定性

`created_at` 是快照生成的**输入**：promotion workflow 生成一次并写进 PR 描述，
`build-snapshot.mjs --created-at <值>` 能复算出逐字节相同的快照。审的人可以本地比对。

### 2.3 其他约束

- `artifacts` 按 `id` 字节序排序；`latest` 只列非 yank、非 prerelease、**非 `degraded`** 的最高版本
  （v2 会把 `degraded` 的最高版选成默认，然后安装必失败）。
- 禁 `+build`（D7）后 precedence 唯一。
- `status` ∈ `published` | `deprecated` | `yanked` | `degraded`。
- `submitted` / `in_review` / `approved` / `rejected` 不进快照。

## 3. timestamp schema `geoly.skills.timestamp/1`

```json
{
  "schema": "geoly.skills.timestamp/1",
  "version": 137,
  "repo": "geoly-ai/skills-hub",
  "latest_snapshot": 42,
  "snapshot_sha256": "sha256:…",
  "min_cli_version": "1.2.0",
  "created_at": "2026-08-25T12:00:00Z",
  "valid_until": "2026-09-01T12:00:00Z"
}
```

约束（CLI 必须逐条验，任一不符即拒绝）：

- 严格 schema；**拒绝重复 JSON key**；`repo` 必须等于内置常量。
- 时间必须是 `YYYY-MM-DDTHH:MM:SSZ`（UTC，无偏移，无小数秒）。
- 🔴 **完整时间规则**（v3 只写了上界，允许负有效期与遥远未来的签发时间）：

  ```
  0 < (valid_until - created_at) ≤ 7 天
  created_at ≤ now + SKEW          （SKEW = 5 分钟）
  now < valid_until
  ```

- `version` 单调递增。

🔴 **本机时钟是 freshness 的输入。** 时钟被大幅拨快 → 一切 timestamp 显得过期（fail-closed，可接受）；
被拨慢 → 过期的 timestamp 仍被接受，回放窗口被拉长。这条写进
[`07-threat-model.md`](07-threat-model.md)，**不假装它不存在**。

### 3.1 `min_cli_version` 的准确语义

它**只对新版 CLI 有效**：已装的旧 CLI 不会因为这个字段停机（它那一版的代码里没这个逻辑）。
因此它是**止血提示，不是撤销机制**：

- CLI 自身版本 < `min_cli_version` → 拒绝安装，提示升级。
- 真正的紧急撤销靠 yank + `GSA-` 公告 + 发新 CLI，三者缺一不可。

（v2 把它写成了能让旧 CLI 停机，那是做不到的。）

### 3.2 🔴 timestamp 的分发不走 commit

v2 说「由 release bot commit 落盘」——但分支保护禁止直推（含管理员），**跑不起来**。

v3：timestamp **只作为 GitHub Release 资产分发**，挂在一个专用的滚动 release
`tag: timestamp` 上（连同它的 `.sigstore` bundle）。更新 release 资产**不需要 commit**。

- 每次发布后由 `timestamp.yml` 更新一次；另有 cron 每 3 天更新一次。
- 允许连续失败约 4 天而不让客户端大面积过期。
- 仓库里**不存** timestamp 的当前值。归档需求由 `timestamp.yml` 定期开一张普通 PR
  往 `registry/timestamp-archive/` 追加历史副本，走正常审批 —— 归档失败不影响分发。
- cron 只更新资产、不写仓库、不打新 tag，因此**不会触发发布循环**。

`registry/index.json` 仅供人和网页用，**不参与信任**，CLI 不读。

## 4. 分发

| 通道 | 用途 |
|---|---|
| Release `hub-v<N>` 资产 | 每个制品的 `.tar.gz`、快照、attestation 及各自 bundle |
| Release `timestamp` 资产 | `timestamp.json` + bundle（滚动更新） |
| git 仓库树 | 取证回退，只按 `tree_digest` 判真伪 |

### 4.1 canonical tar.gz

| 项 | 取值 |
|---|---|
| 格式 | `ustar`，**无 PAX / GNU 扩展头** |
| 条目顺序 | 与树摘要相同的 path 字节序 |
| 条目集合 | **只有普通文件**；不写目录条目 |
| 路径编码 | 必须能装进 ustar 的 `prefix`(155) + `name`(100)，见 [`01-artifacts.md`](01-artifacts.md) §4.1 |
| mode | `0644` / `0755` |
| uid / gid / uname / gname | `0` / `0` / `""` / `""` |
| mtime | `0` |
| gzip | `mtime=0`、`OS=255`、level `9`、无 `FNAME`/`FCOMMENT` |

资产在 **promotion 阶段**打包并算 sha256；`release.yml` 用同一脚本重建，
CI 断言字节完全一致后才上传。不一致即发布失败。
（跨 Node/zlib 版本的稳定性风险见 [`10-open-questions.md`](10-open-questions.md) Q10。）

## 5. 本地信任状态

`~/.local/state/geoly-skills/trust.json`：

```json
{ "schema": "geoly.skills.trust/1",
  "timestamp_version": 137,
  "timestamp_sha256": "sha256:…",
  "latest_snapshot": 42,
  "snapshot_sha256": "sha256:…",
  "last_verified_at": "2026-08-25T12:00:00Z" }
```

🔴 **写入规则（v2 的 P0 残留）**：

- 用 `临时文件 → fsync → rename → fsync 父目录` 原子写；
- **在下载任何制品、动任何 target 之前**就写入 ——
  v2 说「全部安装成功后更新」，崩溃在中间就会让 floor 退回，旧 timestamp 又能被接受；
- 多进程并发：`~/.local/state/geoly-skills/metadata.lock.db`，
  与 target 锁**同一套机制**（[`04-install.md`](04-install.md) §5.1：`node:sqlite`
  的 `BEGIN EXCLUSIVE`，进程退出由内核释放，**协议里没有任何 unlink**）。
  持有整个「验证 + 推进 floor」区间，用完立即释放（加锁全序见 §5.1 末尾）。
🔴 **临界区内不得 `COMMIT`** —— SQLite 的 `COMMIT` 会释放锁。holder 写入留到最终提交。

🔴 **写入规则本身必须是单调的，不能只靠锁**（v4 的 P0-2 残留）：

评审的反例 —— P1、P2 都从 floor=10 读；P2 写 12；P1 后写 11；**floor 回退到 11**，
旧的 11 可再次被回放。原子写不等于单调提交。

```
在 metadata 排他锁下：
    重新读一次磁盘上的 floor          ← 不用内存里那份
    若 磁盘floor.timestamp_version ≥ 待写值:
        🔴 不是「沿用磁盘值继续」，而是【从磁盘 floor 重做完整绑定比较】：
            磁盘版本 > 我的  → 放弃本次结果，用磁盘那份重新走 §6 第 3–5 步
            版本相同但 (latest_snapshot, snapshot_sha256, timestamp_sha256) 任一不同
                → 🔴 报完整性事件，终止（v6 漏了 timestamp_sha256，与 §6 第 3 步的
                   三元组要求不一致 —— 两个同 version、同 snapshot、不同签名内容的
                   timestamp 会让后到的进程继续按旧 timestamp 行为运行，
                   绕过同版本绑定与 min_cli_version 收紧）
    否则 → 原子写
```

🔴 **「写前重读」本身不是 CAS。** 没有真锁时，P1、P2 都重读 floor=10，
P2 写 12、P1 写 11 —— 仍会回退。所以**真锁是必需的，重读只是额外的防御层**。
（v5 把重读说成「无锁也够」，那是错的。）

🔴 而且发现磁盘 floor 更高时**不能沿用自己已验的旧 timestamp/旧 snapshot 继续下载** ——
否则 floor 虽未落盘回退，本进程仍会按旧快照装东西。必须重做绑定比较。

## 6. 验证链

1. 取 `timestamp.json` + bundle，**验签**（identity = `timestamp.yml`，见 §8）。
2. 严格校验（§3 全部约束）。
3. **防回放三分支**：

   | 与本地 floor 比 | 动作 |
   |---|---|
   | `version` < 本地 | **拒绝**（回滚攻击） |
   | `version` == 本地 | 只在 `(latest_snapshot, snapshot_sha256, timestamp_sha256)` **完全一致**时接受；任一不同 → 拒绝并报告为完整性事件 |
   | `version` > 本地 | 🔴 **还要过 snapshot 单调性**（下表），全过才接受 |

   **snapshot 单调性**（v3 缺失：高 version 指向旧 snapshot 会让旧 yank 状态重新生效）：

   | `latest_snapshot` 与 floor 比 | 动作 |
   |---|---|
   | 小于 | **拒绝**。timestamp 再新也不能把清单退回去 |
   | 相等 | `snapshot_sha256` 必须与 floor 记录的**完全相等**，否则拒绝并报完整性事件 |
   | 大于 | 接受，允许换摘要 |

   `now > valid_until` → 拒绝（退出码 8）。`--offline` 时改为**标记 stale**，
   `install` 在 stale 下默认拒绝，需 `--allow-stale`。

4. 取 `hub-<N>.json`（N = `latest_snapshot`），验其 sha256 == `snapshot_sha256`，
   **再独立验它自己的签名**（identity = `release.yml`）。
5. 严格解析快照：schema、**拒绝重复 key**、`snapshot == N`、`repo`、`id` 全局唯一、
   `latest` 投影自洽、`status` 合法。
   🔴 **只校验 snapshot 自身可得的数据** —— v3 在这里要求校验「record 与载荷 manifest 的
   六项（skill 七项）绑定」，但 manifest 在资产内部，第 7 步才下载得到，**顺序上不可能**。
6. 🔴 **原子推进 trust floor**（§5）。此后才允许下载。
7. 下载资产 → 验 `asset.sha256` → 隔离临时目录解包（[`04-install.md`](04-install.md) §7）
   → 重算 `tree_digest` → 校验归档内逻辑路径与 mode
   → **此时**才校验载荷 manifest 与 record 的六项（skill 七项）绑定（[`01-artifacts.md`](01-artifacts.md) §5.3）。
8. **把已验证的暂存物交给安装事务**（[`04-install.md`](04-install.md) §5）。
   🔴 本步**不写账本**；账本只在事务的第 9 步提交。

**不提供 `--no-verify` / `--insecure`。** 唯一放宽是 `--offline` + `--allow-stale`，且持续标注。

### 6.1 历史快照的读取路径（v2 缺失，导致 `check` 与 `--snapshot` 跑不起来）

第 3 步的「`N` 小于本地 floor 即拒绝」**只适用于「解析当前」**。
读历史快照是另一条路径，规则不同：

```
① 先按 §6 第 1–6 步验证并推进「当前」（离线则标 stale）
② 再按 ID 取回目标历史快照 hub-<M>（M 可以 < 当前）
③ 独立验它自己的签名 + 严格解析
④ 🔴 只读：可用于验字节、取证、--snapshot 复现
   ❌ 不得用它回答「现在还能不能用」——那必须查当前快照
```

这正是 `check` 两阶段（[`09-cli.md`](09-cli.md) §4）与 `--snapshot <N>` 的依据。

### 6.2 `--snapshot <N>` 钉版

允许钉旧快照复现，但仍须先验当前 timestamp（除非 `--offline`）；
若目标制品在**当前**快照里已 `yanked` → 默认拒绝，需 `--allow-yanked`，并写进账本。
🔴 若是 `degraded`（pack 的成员被 yank）→ **一律拒绝，`--allow-yanked` 不放行**（[`04-install.md`](04-install.md) §8.1.1）。

## 7. 🔴 bootstrap 残余风险

首次安装（本地无 floor）时，攻击者可以喂一份**旧但尚未过期**的 timestamp，
窗口最长 7 天。这是 timestamp 方案的固有 bootstrap 缺口，**不可能靠 timestamp 自身消除**。

缓解（不是消除）：CLI 首次运行时打印所取 timestamp 的 `version` / `created_at`，
让用户能对照公开值；`GSA-` 公告里必须给出「受影响窗口内的 timestamp version 区间」。
写进 [`07-threat-model.md`](07-threat-model.md)。

## 8. 签名身份

```
issuer = https://token.actions.githubusercontent.com
snapshot / attestation:
  https://github.com/geoly-ai/skills-hub/.github/workflows/release.yml@refs/heads/main
timestamp:
  https://github.com/geoly-ai/skills-hub/.github/workflows/timestamp.yml@refs/heads/main
```

**精确比对**，不做前缀匹配、不做通配。**两个身份不可互换**：
用 `release.yml` 身份签出来的 timestamp 必须被拒绝，反之亦然。

### 8.1 TUF 根

Sigstore TUF trust root 随 CLI 内置，记 `root_version` 与过期时间。
根过期/轮换走 Sigstore 标准流程，**拒绝在无法验证的情况下接受新根**；更新失败即拒绝安装。

### 8.2 🔴 npm 是被承认的信任锚

「TUF 根内置在 CLI 里、CLI 靠 npm provenance」**不是自洽闭环**：
`npx` 不会替用户强制验证 provenance，被替换的 CLI 也可以谎称自己验过。

规范明确承认：**第一跳的信任锚是 npm registry + TLS + 用户对所执行包的信任。**
不接受该锚的使用者，走 README 里的离线引导：从 GitHub Release 直接取 CLI tarball 与其
bundle，离线验签后本地安装。

npm 发布走 OIDC（`--provenance`），无长期 token。
CLI 以 `npx github:` 运行时，`login` / `publish` 拒绝执行。

## 9. 缓存

### 9.1 制品资产

`~/.cache/geoly-skills/assets/<sha256>`，**每次读取都重验摘要**。不缓存已解包的树。

### 9.2 🔴 元数据缓存（v3 缺失）

「先推进 floor 再下载」是正确的 fail-closed，但它意味着离线时也需要
**已验签的 timestamp、当前 snapshot、历史 snapshot 及各自 bundle** ——
v3 只定义了资产缓存，这些东西无处存放，`--offline` 与 `check` 的历史路径实际跑不了。

`~/.local/state/geoly-skills/cache/meta/<sha256>`（放 state 而不是 cache 目录：
它参与安全判定，不该被「清缓存」顺手删掉）：

| 内容 | 何时写 | 何时读 |
|---|---|---|
| `timestamp.json` + bundle | 每次成功验签后 | `--offline` 时作为**已知最新**，且必须重验签名与 §6 全部规则；过期即标 stale |
| 当前 snapshot + bundle | 同上 | 同上 |
| 历史 snapshot + bundle | `check` / `--snapshot` 取回并验签后 | 后续 `check` 的字节校验阶段 |

🔴 **缓存命中不跳过验签。** 缓存只省网络，不省任何一次密码学校验 ——
本机文件可被同权限进程改写（对手 E）。

`--offline` 只允许命中缓存；未命中即失败（退出码 6）。
