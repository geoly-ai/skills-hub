# M2 交付汇报

> 2026-08-30。M0 已封版在 `docs/m0/`，本文**不修改**它。
> 结论若与 M0 正文冲突，以 M0 为准并在这里注明。
>
> 🔴 本文只写**已经发生的事**与**明确没做到的事**。不写计划，不写「以后再说」。
> 一条边界要么在这里说清为什么接受，要么就不该被写成已交付。

---

## 1. 交付了什么

| 块 | commit | 内容 |
|---|---|---|
| `vendor` 命令面 | `eaeeda2` | `vendor <pack-spec> --out <dir> [--layout flat]`，整目录替换 + 自动收敛上一次未收尾的物化 |
| `install pack:` | `541906c` | 装 pack 的成员；pack 自己是账本里的一条 **root**，不落成目录 |
| `install --all` | `d0a0299` | 名单取自快照的 `latest` 投影；一条 `all@snapshot:N` root |
| promotion 的派生一半 | `a048c44` | `scripts/build-snapshot.mjs`：打包、摘要、pack 的 clients 交集 / capabilities 并集、`degraded` 重算、`latest` 投影、canonical 字节 |
| 快照签名 | `8732378` | `release.yml` 补上 §1 三个签名对象里**一直没人签**的那一个 |

配套：`src/commands/pack-errors.mjs`（库层 `E_…` 码 → §6 退出码）、
`test/commands-vendor.test.mjs`(18) / `commands-install-pack.test.mjs`(14) /
`commands-install-all.test.mjs`(15) / `build-snapshot.test.mjs`(14)。

---

## 2. 明确**没有**做到的

不写清楚就等于默认承诺了，所以逐条列出。

### 2.1 promotion 只有派生那一半

快照 record 必填 `owner` 与 `review{pr, approved_by, head_sha, capability_tier}`，
而这四样全是**投稿 PR 的事实**（[`06-submission.md`](../m0/06-submission.md)），属于 M3。
`build-snapshot.mjs` 因此收一份显式的 `--inputs`，**不发明**它们。

于是 M2 交付的 promotion **跑不通「从 PR 到快照」的全程** —— 需要有人手工准备 inputs。
M3 接上投稿流水线时把那份 inputs 换成流水线的产物即可，脚本一行不用改。

### 2.2 签名本身**本机从未验证过**

`release.yml` 的签快照一步、以及既有的 `.tgz` 签名与 attestation，
都依赖 cosign + GitHub OIDC + Rekor。**这三样本机无从证明**。

本轮能验的都验了：三段 `run` 脚本原样抽出来，在 bash 3.2 上配桩程序跑过四种现场
（空目录 / 部分已签 / 全已签 / dry_run），**选择逻辑与拒绝逻辑**都对。
但「cosign v2.4.3 签出来的 bundle 我们的验签器一定收」仍然是待验证值（见 R-6）。

🔴 **第一次真跑必须 `dry_run: true`。**

### 2.3 timestamp 的分发（**已按 §3.2 改**，但留了一条）

原本走 `git push origin main`（§3.2 明确否掉的 v2 方案），已改成滚动 Release 资产，
并新增 `scripts/release/build-timestamp.mjs` 生成 timestamp。见 [R-13](01-residual-risks.md#r-13)。

遗留：两个资产的更新**不是原子的**，见 [R-17](01-residual-risks.md#r-17)。
🔴 打开 cron 之前必须先解决它 —— 否则「新鲜度链」在一个可长期停留的坏状态上运转。

### 2.4 M2 之外

`update pack:` 与 `remove` 是 M4；投稿与审核是 M3；
registry 仍**没有网络客户端**（`resolveCurrent()` 是同步的，接不进 `fetch`）。

---

## 3. 本轮撞到的规格缺口

### 3.1 🔴 pack 的 `provenance` 没有出处

快照 record **必填** `provenance`（`snapshot.mjs` 的 `RECORD_KEYS`），
而 `pack.json` 的键集里**根本没有这个字段**
（[`03-packs.md`](../m0/03-packs.md) §2 的 schema，`validatePackManifest()` 也不认它）。

skill 走 `skill.json`；pack 只能走 `--inputs`。
`build-snapshot.mjs` 的处理是：两边都没有就**拒绝并说清原因** ——
编一个 `{kind:'original', author_github_id:'?'}` 会让一条**查不到来源的记录**
混进签名对象里。

**要闭合就得改 §2 的 pack.json schema**，那是规格侧的决定。

### 3.2 `--json` 输出的 schema 名尚未登记

`geoly.skills.cli.<cmd>/1` 与它的字段表不在
[`11-wire-contract.md`](../m0/11-wire-contract.md) §1 的适用对象清单里。
本轮新增了 `cli.vendor/1`，同样未登记。（`src/commands/output.mjs` 顶部已注明。）

---

## 4. 待拍板

| # | 事项 | 现状 | 代价 |
|---|---|---|---|
| ① | promotion 的 `owner` / `review` 来源 | 已按「显式 `--inputs`」实现 | 全程跑不通，需人工准备 inputs |
| ② | `timestamp.yml` 的分发方式 | ✅ 已按 §3.2 改成滚动 Release 资产 | 遗留 R-17（两资产非原子），打开 cron 前须解决 |
| ③ | bundled 成员是 `degraded` 的 pack 时，跳过还是终止 | 已选「跳过并告警」 | 见下 |

**③ 的原委**（`src/pack.mjs` 的 `resolvePackInstall` 里已写明，这里归位）：
§4 第 2 步说「所属 pack 为 degraded → 整个安装终止」，没区分必装与 bundled；
§5 的表只为 **yanked** 的 bundled 开了「跳过并告警」的口子，没提 degraded。

选了统一到 §5：bundled 成员**按定义就是可跳过的**，它 degraded 与它被 yank
对「这个 pack 还能不能装」的答案应该相同。选 fail-closed 也行，
但**两处必须同时改** —— `resolvePackInstall()` 与 `computePackStatus()` 对 bundled
的处理。只改一处会造成「快照写着 published、普通安装却必然失败」。

---

## 5. 🔴 「见交付汇报」的悬空引用

源码里有 **17 处**注释把某个取舍/缺口推给了「交付汇报」，而在本文之前，
M2 的那一份并不存在。逐条列出以便归位 —— **本轮只清点，未逐条归位**：

| 位置 | 主题 | 有没有家 |
|---|---|---|
| `packer.mjs:344` | `origin_tree_digest` 的书写形式冲突 | ✅ [`ERRATA E-8`](../m0/ERRATA.md) |
| `pack.mjs:680` | bundled 成员 degraded 的取舍 | ✅ 本文 §4 ③ |
| `registry.mjs:13` | 没有网络客户端 | ✅ README + 本文 §2.4 |
| `packer.mjs:315` | 打包端比安装端**严**，两侧接受集合不等 | ❌ |
| `trust.mjs:83` / `trust.mjs:541` | 实测复现的覆盖问题 / 规格缺口 | ❌ |
| `pack.mjs:213` | 契约门看不见的那一类变更 | ❌ |
| `untar.mjs:17` | 自写受限 tar 解析器的取舍 | ❌ |
| `plan.mjs:29` | 「还没被证明的性质」 | ❌ |
| `output.mjs:16` | `--json` schema 未登记 | ✅ 本文 §3.2 |
| `install.mjs:57` | 磁盘余量只在动手前查**一次**，不是「期间持续检查」 | ✅ 本文（此行） |
| `artifact.mjs:84` | 中间目录 check-then-use 非原子 | 近似 [`R-2`](../m1/01-residual-risks.md) / `R-3` |
| `recover.mjs` ×4 | 内核 API 缺口（`--continue` / `--rollback` / `--from-generation`） | ❓ 疑似 `R-11`，未逐条核对 |

⚠️ **标 ❌ 的那几条不是「不重要」，是「还没人把它写下来」。**
一条推给交付汇报却没有交付汇报的注释，与「以后再说」没有区别。
