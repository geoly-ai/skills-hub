# 变更日志

本文件记录**发布给用户**的变化。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 🔴 **`+build` metadata 被禁用**（`docs/m0/00-decisions.md` D7）：
> `1.0.0+a` 与 `1.0.0+b` 的 precedence 相同，`latest` 会无法唯一确定。
>
> 预发布版本的比较按标准 SemVer 优先级（`ERRATA.md` E-4）：
> 预发布**低于**同数字的正式版本。

---

## [0.3.1] — 2026-09-03

### 修复

🔴 **0.3.0 装不了任何东西，请直接用本版。** 它带着五个只有真机才暴露的 bug，
而单元测试 1384 条全绿 —— 因为注入点的**缺省分支从来没被执行过**：
测试每次都注入替身，而真正的 CLI 入口一个都不传。

- `fetchImpl` / `verifier` 的缺省值是 `null`，而代码用的是默认参数
  —— **默认参数只对 `undefined` 生效**，于是生产路径上报
  「当前 Node 没有内建 fetch」（而 Node 25 明明有）与 `E_VERIFIER_MISSING`。
- `ctx.now` 是函数、内核要毫秒数 → `RangeError: Invalid time value`。
- **CLI 版本号硬编码成 `0.0.0-m1`** —— 于是刚装下来的 0.3.0 自报 0.0.0-m1，
  被 registry 的 `min_cli_version` 当场挡死。现在从 `package.json` 读。
- 干净 home 首次安装时 `lstat '<home>/.local'` ENOENT：
  建目录那一步排在了 `realpathSync` 之后。

### 已验证

干净 home 上在线安装、`--offline` 重装、整套矩阵（`pack:`）一条命令装完，
三条路径都跑通了。

---

## [0.3.0] — 2026-09-03

### 🔴 这是第一个**真的能装东西**的版本

0.1.0 和 0.2.0 都能发布、能验签、能浏览 registry，但**任何一次 `install`
都取不到字节** —— CLI 没有网络客户端，缓存未命中就直接报错。

而且 0.2.0 那次发布停在一个最尴尬的中间态：npm 收下了包，
但**回查步骤因 npm 传播延迟红了**，于是建 Release 的 job 整个被跳过 ——
GitHub Release 一个都没有，timestamp、快照、23 个制品资产全部 404。

本版把这两半都补上。

### 新增

- **CLI 会出网取字节了。** `install` 之前先联网刷新 timestamp 与当前快照，
  再按需下载制品资产。支持**两种粒度**：单个 skill、整套矩阵（`pack:`）与 `--all`。
- **矩阵下到一半断网可以接着下。** 资产按 sha256 内容寻址落盘，
  已验证的留作孤儿，重跑时直接命中，不从头再来。
- **`--offline` 走同一条码**，不是另一条不出网的实现。

### 变更

- registry 现在发**两个** Release：`v<x.y.z>`（npm 包）与 `hub-v<N>`（快照 + 资产）。
  0.2.0 之前两者挤在同一个 tag 上，导致客户端**推不出下载地址** ——
  「快照号 N → 哪个 CLI 版本」这个映射不在任何签名对象里。
  下载地址现在可从已验签对象完整推导（`02-registry.md` §4.0）。

### 安全

- 缓存里只放**验过的**字节：未验证的先落 staging，验签通过才原子提升。
  `timestamp.json` 与 `snapshots/<N>` 不是内容寻址，未验证就写进去的话，
  投毒一次就能让之后每次 `--offline` 都验签失败（持久 DoS）。
- 下载只从内建 host 取，重定向受限跟随（每跳复核 https 与 host allowlist）。
- 资产文件名按记录字段**重算比对**，不用字符黑名单 ——
  顺带堵住「`asset.file` 指向另一条记录的资产」这类完全合法的文件名。

---

## [0.2.0] — 2026-09-02

### 🔴 升级前必读：埋点上报现在**默认开**

0.1.0 只在本地记事件，不外发。**0.2.0 起，`install` 成功收尾后会静默上报一次**
（24 小时最多一次、超时 1 秒、失败不影响安装）。

- 采集面是**穷举白名单** —— 不含路径、目录清单、文件内容、用户名
- ⚠️ **平台请求日志会记录你的 IP，我们关不掉**。这是**明确接受的残余风险
  T-20，不是「已缓解」**（`docs/telemetry/00-spec.md`）
- 完全关闭：`GEOLY_TELEMETRY=0`（本地一个字节都不写）
- 只看不发：`skills-hub telemetry status` / `stats`

### 新增

- `install --all`：一条 `all@snapshot:N` root 全量安装
- `vendor <pack> --out <dir>`：把 pack 与全部成员物化成目录树，**不走安装账本**
- `skills-hub stats` / `telemetry <status|flush>`
- §9 的 token 存储（keychain 优先、文件回落），并**拒绝 `npx github:` 形态**

### 修复

- **创世快照建不出来**：registry 为空时 `--previous` 缺省成 `null`，
  读取端拒绝。现在创世补 0，而**非创世缺 `previous` 一律报错** ——
  静默填 0 会让第 42 张快照声称自己接在创世后面，且读取端看不出来
- **投稿门不解析 SKILL.md frontmatter**：于是问题拖到 promote 建快照才暴露，
  而那时投稿已经合并进 main
- **provenance 从不与真实 PR 核对**：投稿者可以在自己的 `skill.json` 里写任意
  `author_github_id` / `submitted_by_pr`，原样进快照成为权威出处记录
- 不可见字符扫描器有两处绕过；Tier 2 的审批门本该在合并前

---

## [未发布]

### 平台契约

- **Node ≥ 22.13**（D11′）。锁用 `node:sqlite` 的 `BEGIN EXCLUSIVE`，
  该模块自 22.13 起默认启用，之前的版本需要 `--experimental-sqlite` 开关。
- **仅支持 macOS / Linux / WSL，明确不支持 Windows 原生**（D1）。
  POSIX mode 与路径 grammar 直接进树摘要，Windows 上 `0755` 存不住。
- 路径 **ASCII-only**（`[A-Za-z0-9._-]`，D9）。

### 新增

- **CI 固化**（`.github/workflows/ci.yml`）
  - Node 矩阵的版本清单收敛到唯一源 `scripts/node-versions.json`，
    CI 与 `scripts/test-matrix.sh` 都从它读；`scripts/check-node-matrix.mjs`
    扫 workflow，出现硬编码版本号即失败。
  - 🔴 **穷举崩溃注入（`FX_FULL=1`）是会拦住合并的门**，且**两套故障矩阵都跑**
    —— 真事务内核（`kernel-fault-matrix`）与仍在驱动假事务的
    `fault-matrix`（R-10）。两者用 `set +e` 分别取退出码再聚合，
    确保第一套挂掉时第二套仍然会跑完。
  - 固定名的聚合 job `ci-gate` —— 分支保护要钉的是它，
    矩阵 job 的 check 名字里带版本值，版本一变就钉不住了。
- **Q12 脚手架进仓库**（`scripts/q12/`）
  四步测量协议、`.geoly` 完整夹具、`VOID-MEASUREMENT-INSENSITIVE` 判定、
  claude 请求体核对全部可重放。客户端升级后可一键复测。
  🔴 全程在临时 `HOME` / `CODEX_HOME` 沙箱里跑，跑完核对真实用户目录里
  没有出现本夹具产生的任何文件。
  - **开跑前的自检探针**（`preflight.mjs`）：先用**与真实测量完全相同的进程结构**
    跑一次最小往返，不通就报**具体现象**（客户端超时 / 被信号杀 / stub 没收到请求 /
    读到 0 个 skill），而不是产出一堆退出码让人去猜原因。
    ⚠️ 它只报现象、不报结论 —— 「网络不通」这类结论会让人去修不存在的问题。
  - 🔴 stub 必须跑在**独立进程**里：`spawnSync` 会阻塞事件循环，同进程的 stub
    永远不会被调度去读客户端已经发出的请求，表现为客户端超时 + 服务端零请求 ——
    形状酷似网络故障，实则不是。
- **签发侧**（`.github/workflows/release.yml`、`.github/workflows/timestamp.yml`）
  Sigstore keyless 签名 + npm provenance。
  🔴 **两个工作流 = 两个 OIDC 身份**（`02-registry.md` §8），不可合并、不可互换。
  两条流水线都在做任何不可逆动作之前先跑一次 canary 签名并**用本仓库自己的
  验签器**（`createSigstoreVerifier()` + `loadBuiltinTrustedRoot()`）自验；
  timestamp 那条还额外做**交叉证伪**：同一份 bundle 拿 release 身份验必须失败。
- **发布前的门**：`scripts/publish-check.mjs`（元数据）、
  `scripts/check-pack-contents.mjs`（`npm pack` 的**真实**清单，
  盯住 `src/trust-roots/` 必须在包里）、
  `scripts/release/verify-registry.mjs`（发布后回查 registry 真的在供这个版本）。

### 尚未闭合（不要读成已完成）

- 🔴 **skill 制品（tar.gz）与快照的签发链**：**完全不存在**。packer 属于 M2。
  本轮签的是 **npm 包本身**。
- 🔴 **timestamp 的 7 天新鲜度链尚未运转**：`registry/` 还不存在，
  `timestamp.yml` 的定时触发是注释掉的。
- 🔴 **Q12 的 cursor 两格**没有任何运行时证据，且静态分析**预判失败**（R-8）。
  八格里覆盖到六格，缺席不等于通过。
- 🔴 **Rekor v2（R-6）**：验签器只认 `hashedrekord 0.0.1`。
  上游把 Rekor v2 切成默认的那天，新签的东西会一次性全部验不过。
  这是一个**会自己爆炸**的已知债，需要盯上游排期。
- **R-10**：两套故障矩阵并存，`fault-matrix` 仍在测假事务。
  CI 两套都跑只是止血，合并成一套才是修法。
