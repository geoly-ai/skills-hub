# 变更日志

本文件记录**发布给用户**的变化。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 🔴 **`+build` metadata 被禁用**（`docs/m0/00-decisions.md` D7）：
> `1.0.0+a` 与 `1.0.0+b` 的 precedence 相同，`latest` 会无法唯一确定。
>
> 预发布版本的比较按标准 SemVer 优先级（`ERRATA.md` E-4）：
> 预发布**低于**同数字的正式版本。

---

## [0.3.6] — 2026-09-05

### 修复

🔴 **在真实的 skill 目录下可能一个都装不上。** 嵌套 target 扫描的深度上限是 8，
而任何 vendor 了一个仓库的 skill 都会轻松超过它 —— 一台开发机上实测：
`~/.claude/skills` 有 657 个目录、**最深 17 层**（某个 skill 里 vendor 了
一整个仓库）。于是三个 target 全部 `[target.nested-scan-incomplete]` 失败，
而目录数上限（5000）**连八分之一都没碰到**。

判据错在把**深度**当成预算：遍历成本是 O(目录数)，**与深度无关**。
现在深度降级成防病态路径的 sanity guard（8 → 64），目录数才是真预算
（5000 → 100000），另加一道单目录条目数的闸。

⚠️ **fail-closed 一点没动**，也**没有**「跳过这道检查」的开关 ——
一个 `--skip-nested-scan` 等于把那道门交给最不想被它拦的人去关。
要抬预算用 `--scan-max-depth` / `--scan-max-dirs`（仍是真扫描、仍然 fail-closed）。

**报错现在能指导行动**：点名撞的是哪个上限、还剩多少没看、样例路径是什么、
以及你能做什么。三种停因（深度 / 预算 / 读不进去）**互斥归因** ——
权限问题不会再被说成「深度不够」。

### 新增

- **`update`** —— 受控地改 lockfile 并应用；重解析账本里的 root，展示 diff、要求确认。
- **`remove`** —— 🔴 **减引用，不是删目录**：一个 skill 可能被多个 root 请求
  （直接装的 + pack 带进来的），**只有引用归零才删**。

### 变更

- **投稿时 `skill.json` 的 `provenance` 可以不写了**，由 promote 按 PR 事实填。
  原先它要求你在**开 PR 之前**写进一个开 PR **之后**才存在的 PR 号。
  ⚠️ 写了仍然逐字核对，写错就拒；`vendored` 仍**必须**你自己声明。
- 连不上时的提示按你的环境分情形给建议，并直接给出可执行的命令。

---

## [0.3.5] — 2026-09-04

### 修复

**连不上时的提示此前经常一个字都不打。** 它按错误码枚举
（`TIMEOUT` / `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN`）才触发，
而真实现场返回的是 `UND_ERR_SOCKET` —— 不在名单里。
undici 的错误码谱系又长又会变，枚举注定漏；现在改成**取不到字节就给提示**。

### 明确的边界：**我们不管你的网络**

- 你设了 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` → **照你说的走**。
  （Node 的内建 fetch 默认不认这些变量，我们做的只是把你已经表达过的意图变成生效的。）
- 你什么都没设 → **直连，绝不自作主张**。连不上就明确告诉你怎么设。

🔴 开发中一度加过「没有环境变量就去读系统代理（macOS 的 `scutil --proxy`）」，
**已撤掉**。设环境变量 = 你说「这次走这儿」；系统设置只是「这台机器平时怎样」，
不等于你要让这个工具走那儿。**静默把请求送进一个代理，是改变了流量的去向，
而你没有要求过。**

### 变更

`list` / `why` / `stats` 这些纯本地命令不再为代理多起一个进程 ——
只有 `install` 与 `telemetry` 会出网。

---

## [0.3.4] — 2026-09-04

### 变更

**连不上时的提示改成直接给命令。** 此前它只说「设置 HTTPS_PROXY 后重试」——
而对一个「我明明挂着代理、浏览器也能开 github」的人来说，那句话读起来像答非所问。

真正的原因是：Clash / Surge / VPN 客户端通常只写**系统代理**设置，
而 **Node 的内建 fetch 不读系统代理**（curl 和浏览器读，所以浏览器能打开
不能证明 CLI 能）。现在提示会直接给出两行可执行的命令，并带上你当前的
Node 版本（代理支持需要 ≥ 24）。

---

## [0.3.3] — 2026-09-03

### 修复

**代理支持在 0.3.2 里是无效的，本版才真正生效。**

0.3.2 的做法是在进程内设 `NODE_USE_ENV_PROXY` —— 而 Node 在**启动时**读它，
之后再改不算数。所以 0.3.2 在代理后面**仍然装不上**。

现在改成：检测到你配了代理、而你又没有显式表态时，CLI 会**带着这个变量把
自己重启一次**。你若显式设过 `NODE_USE_ENV_PROXY`（哪怕设成 `0`），
它尊重你的选择、不重启。没配代理时也不会多起进程。

⚠️ **仍然需要 Node ≥ 24**（代理支持是 Node 24 引入的）。
22.x 用户可以先在能直连的网络里跑一次把缓存热起来，之后 `--offline` 可用。

### 变更

连不上时的提示改成**按你的环境分情形**：没配代理 / 配了但 Node 太老 /
配了但显式关掉 / 配了也启用了但仍连不上 —— 四种情形给四句不同的话。
此前无论如何都说「需要 Node ≥ 24」，而在 Node 25 上那句话正确却不适用，
反而会把人带偏。

---

## [0.3.2] — 2026-09-03

### 修复

**在企业代理后面装不上。** Node 的内建 fetch 默认**不认**
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，而 npm、git、curl 都认 ——
于是 `install` 报 `UND_ERR_CONNECT_TIMEOUT`，而同一台机器上
`curl` 同一个地址是通的。现象看起来像「registry 连不上」，
而不是「我这边要走代理」。

现在 CLI 会认这几个环境变量。你若显式设过 `NODE_USE_ENV_PROXY`
（哪怕设成 `0`），CLI 尊重你的选择、不覆盖。

⚠️ **这需要 Node ≥ 24。** 22.x 上代理仍然不生效 —— 那些用户要么升级 Node，
要么在能直连的网络里跑一次把缓存热起来，之后 `--offline` 可用。
这是**已知缺口，不是已解决**。

📌 走代理不削弱安全性：HTTPS 是 CONNECT 隧道、TLS 端到端；
而且我们对取回的字节做**签名验证**，恶意代理改了字节只会验签失败。

### 变更

下载失败的报错现在带上真因。此前无论是超时、DNS 还是证书问题，
用户看到的都只有一句 `fetch failed`（那是 undici 的统一包装，
真因藏在 `cause` 里）—— 什么都定位不了。

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
