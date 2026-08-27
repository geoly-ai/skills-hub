# 变更日志

本文件记录**发布给用户**的变化。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 🔴 **`+build` metadata 被禁用**（`docs/m0/00-decisions.md` D7）：
> `1.0.0+a` 与 `1.0.0+b` 的 precedence 相同，`latest` 会无法唯一确定。
>
> 预发布版本的比较按标准 SemVer 优先级（`ERRATA.md` E-4）：
> 预发布**低于**同数字的正式版本。

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
