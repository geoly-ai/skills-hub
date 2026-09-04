# M2 已知且接受的残余风险

> 编号接着 [`../m1/01-residual-risks.md`](../m1/01-residual-risks.md)（R-1 … R-11）往下走，
> **不复用旧号** —— 源码里到处按号引用 R-9 / R-11，重编号会让那些注释指向别的东西。
>
> 🔴 规矩同 M1：每条必须写清**前提是什么、缓解到什么程度、为什么不闭合、闭合的代价**。
> **不允许出现「以后再说」。** 有闭合计划的进 issue，不进本文。

---

## R-12 · pack 的 `provenance` 靠 promotion 的输入，而不是制品自证

**前提**：快照 record 必填 `provenance`，`pack.json` 的 schema 里没有这个字段
（[`03-packs.md`](../m0/03-packs.md) §2）。

**现状**：`build-snapshot.mjs` 对 skill 取 `skill.json` 里那份（**制品自带、进树摘要**），
对 pack 只能取 `--inputs` 里那份（**不进树摘要**）。

**后果的准确形状**：skill 的 provenance 被 `tree_digest` 覆盖，改它就会改摘要；
pack 的 provenance **不被任何摘要覆盖** —— 它只被快照签名覆盖。
于是「谁写的这个 pack」这件事，对 skill 是**制品级**事实，对 pack 是**快照级**事实。
两者的可追溯强度不同，而快照 record 里看不出这个区别。

**缓解**：两边都没有 provenance 时**拒绝**，不编一个占位值。
快照签名仍然覆盖它，所以它不是无人担保的。

**为什么不闭合**：闭合要给 `pack.json` 加字段，那是改 M0 的 schema ——
规格侧的决定，且会让已有 pack 全部需要重发。

**代价评估**：pack 是**引用**不是容器，它的载荷只有 pack.json 与说明文档；
「谁写的」在 pack 这里的取证价值低于 skill。接受。

---

## R-13 · ~~`timestamp.yml` 走 `git push origin main`~~（2026-08-30 已闭合）

**原问题**：`timestamp.yml` 的收尾 job 干的是 §3.2 明确否掉的 v2 那套 ——
`git add registry/timestamp.json` ＋ `git push origin main`，并为此持有
`contents: write`。第一次真跑会被分支保护挡住。

**已闭合**：改成滚动 Release 资产（`tag: timestamp`），并新增
`scripts/release/build-timestamp.mjs` 生成 timestamp ——
因为 §3.2 的「仓库里不存当前值」与 cron 每 3 天刷新 `created_at` / `valid_until`
是**同一件事的两半**：滚动刷新读不了一份静态的仓库文件，
留着仓库那份就会出现「仓库里的过期、Release 上的新鲜」两个真值。

**遗留**：见 [R-17](#r-17)（两个资产的更新不是原子的）。
仍然**本机验不了** cosign / OIDC / Rekor（见 [R-14](#r-14)）。

---

## R-14 · 签发链的三段，只有验证侧被证明过

**前提**：无需攻击者。

**现状**：`src/sigstore.mjs` / `trust.mjs` 的**验证**侧有完整测试（含 fixture PKI
与一份真 bundle）。而**签发**侧 —— cosign 版本、OIDC 身份、Rekor 条目形态 ——
在本机一次都没有跑过。

本轮新增的「签快照」一步把这个缺口**扩大了一格**：现在有三个签名对象依赖同一套
未验证的签发环境（R-6 记的是 Rekor v2 那一条，本条记的是覆盖面）。

**缓解**：① `release.yml` / `timestamp.yml` 都有 **canary** 步骤，在任何不可逆动作
之前先签一个一次性 blob 并用**我们自己的验签器**验一遍，身份也要对；
② 每个真实签名之后都立刻自验，且做**交叉证伪**（拿另一个身份验必须以
`E_IDENTITY_MISMATCH` 失败）—— 只证「能验过」在「身份判定退化成恒真」时也成立；
③ 三段 `run` 脚本的选择/拒绝逻辑已在本机 bash 3.2 上用桩程序验过四种现场。

**为什么不闭合**：闭合要真在 GitHub Actions 上跑一次 —— 那不是本机能做的事。

**代价评估**：canary 把失败点提前到了「任何不可逆动作之前」，
所以最坏情况是**发布失败**，不是**发布出一个验不了签的东西**。接受，
但 🔴 **第一次真跑必须 `dry_run: true`**。

---

## R-15 · `install` 拒绝换掉 pack 锁定的成员，而 `update` 还不存在

**前提**：用户已经装了一个 pack，现在想把它的某个成员换成别的版本。

**现状**：`planEntryRefs()` **硬拒绝**这种操作 —— pack.json 锁的是成员的
**精确版本 + tree_digest**，`install` 换掉它等于在用户看不见的地方弄断矩阵的锁，
而 pack 自己仍然显示 `published`。

**后果**：这条路径的正确出口是 §4.2 的 `update pack:`，**而它是 M4**。
所以在 M4 之前，用户没有任何受支持的方式去动一个被 pack 锁定的成员。

**缓解**：错误文案直接点名了这一点（「正确出口是 `update pack:`（M4）」），
不是一句泛泛的拒绝。

**为什么不闭合**：闭合就是实现 `update`，那是 M4 的整块。

**代价评估**：拒绝比放行安全得多 —— 放行会产生一个「pack 说自己完整、实际已被换过件」
的状态，而那个状态**没有任何检查能发现**（`check` 比对的是快照里的
`tree_digest`，而成员被换成另一个合法制品之后它自己是自洽的）。接受。

---

## R-16 · `--all` 的名单是**当时那一张快照**的快照

**前提**：无需攻击者。

**现状**：`install --all` 在账本里记一条 `all@snapshot:N` root，
名单取自那张快照的 `latest` 投影。此后 registry 新增的 skill **不会**自动跟进。

**为什么这不是 bug**：root 记的是**用户当时表达的意图**，而「当时全部可装的 skill」
就是一个与快照绑定的集合。让它自动跟进等于让一条历史记录随时间改变含义。

**为什么仍然记在这里**：因为它容易被读成「装了 all 就一直是 all」。
`--all` 之后再来的 skill 需要**再跑一次** `--all`（那会记一条新的
`all@snapshot:M` root），或者按名字单装。

**代价评估**：接受。真正的自动跟进语义属于 `update --all`（M4）。

---

## R-17 · timestamp 的两个资产不是原子替换（✅ **已闭合**，2026-09-04）

> ✅ **2026-09-04 闭合。** 下面整段描述的是**两个资产**时代的问题；
> timestamp 已按决策 ③ 封成**单资产信封**（正文 base64 + bundle 合一，
> `src/timestamp-envelope.mjs`），一次替换只动一个文件 ——
> 「两次上传之间的混搭态」在**构造上**不再可能。
> 线上核实：`timestamp` Release 的资产列表就是 `['timestamp.json']` 一个。
>
> 🔴 **这是打开 cron 的前置条件**（`docs/m2/00-delivery.md` ② 写着「打开 cron 前须解决 R-17」）。
> 前置已满足，`timestamp.yml` 的 `schedule` 同日启用（每 3 天）。
>
> ⚠️ **换来的不是「没有窗口」，是「窗口的形态变了」**：单资产替换本身仍不是原子的
> （`--clobber` 是删了再传），但它的中间态是**资产不存在** → 客户端拿到 404
> → 干净地重试或报「取不到」。而两资产时代的中间态是**验签失败** ——
> 那是一个看起来像被攻击的错误，会让人去查一个不存在的攻击。
>
> ⚠️ 「并发仍未闭合」那一条**依然成立**（见下），它与资产数无关。
>
> 以下原文保留，作为当时的判断记录。

**前提**：无需攻击者。客户端在一个很窄的时间窗内取 timestamp。

**现状**：`gh release upload --clobber` 是**逐文件**的。
`timestamp.json` 与 `timestamp.json.sigstore.json` 必然有一段新旧混搭的窗口：
先传 bundle 则中间态是「旧正文 + 新 bundle」，先传正文则是「新正文 + 旧 bundle」——
**两种都验不过**。GitHub 没有提供原子的多资产替换。

### ✅ 已闭合的那一半：**长期坏状态**

Codex 2026-08-31 指出，真正要命的不是那个窄窗口，而是**第二次上传失败时**
留下的「新 bundle + 旧正文」会**一直留到下一次 cron**（3 天）——
那不是窗口，是一个长期不可用的分发物。

现在 `timestamp.yml` 在两次上传之后：
① 把**线上那一对**原样拉回来，**比 sha256**（不是重新验签 —— 签名在 sign job 里
   已经对同一份字节验过了；这里要答的是「两个文件都原样落地了吗」）；
② 不符就把**上一对**传回去，**并复核回滚本身**，然后让 job 红；
③ 回读拿不到时（网络抖动）**不回滚** —— 不知道线上是什么就回滚，可能把一次成功的
   发布撤掉。大声报错，交人工；
④ 没有上一对可回滚时（首次发布）**不试图修**，只大声报错。

🔴 回滚候选在 sign job 里**先被验成一对**：不验的话，一次失败的发布会把一对
**本来就坏**的资产重新传上去 —— 回滚变成把坏状态固定下来。验不过就把它从候选里
移除并告警（而不是让整个 job 红：上一对坏了不该阻止我们发一份新的好的）。

最坏情况因此从「坏 3 天、没人知道」变成「坏几秒 + CI 立刻报警」。

⚠️ 两处**本机实测**才发现的坑，都在这条路径上：
· `publish` job **没有 checkout**（它持 `contents: write`，设计上不跑仓库里的 JS），
  第一版却在那里调 `verify-own-bundle.mjs` —— 必然 `MODULE_NOT_FOUND`、每次都回滚、
  **刷新永远不会成功**。改用 `sha256sum`（`release.yml` 的挂载资产那一步早有先例）。
· `set -e` 下 `gh release upload` 一失败就当场退出，而「第二次上传失败」**正是**
  本段要补救的场景 —— 补救代码永远走不到。判据改成**回读的结果**，不是上传的退出码。
四种现场（全成功 / 只落一半并回滚 / 回读拿不到 / 退出码）已在本机用桩程序跑过，
且**故意不提供 `node` 桩** —— 否则桩会把「这里根本不该有 node」这件事遮住。

⚠️ **并发仍未闭合**：`concurrency` 只挡本 workflow 自己。别的 workflow 或人工
`gh release upload` 仍可能在两次上传之间改动同一批资产，那时回滚会覆盖别人刚传的
新版本。Release 资产没有 compare-and-swap，没有更好的办法。

### ❌ 没闭合的那一半：**瞬时窗口**

两次上传之间的那一小段仍然存在，消不掉。

**缓解**：混搭态的后果是**验签失败**，而客户端对验签失败是 fail-closed 的 ——
它不会拿一份验不过的 timestamp 去装东西。

**为什么不闭合**：闭合有两条路，**都要改规格**：
① 把正文与 bundle 合成**一个**资产；
② 改成带 `version` 的**不可变**资产名，客户端从 Release 元数据里挑「同代且都在」的一对。
两者都改变 [`02-registry.md`](../m0/02-registry.md) §4 定义的分发形态，
并且会牵动**还不存在**的网络客户端（`registry.mjs` 至今没有出网路径）。
在客户端写出来之前就把分发形态定死，是在没有使用者的情况下设计协议。

⚠️ **「下一次取就好」仍然只是缓解，不是协议保证**（Codex 的原话）：
现在没有任何地方规定客户端要重取或做配对检查。
🔴 **打开 timestamp cron 之前，①②里要选一条，并把客户端的重取策略写进规格。**
（已闭合的那一半降低了紧迫性，但没有取消这条前置。）

---

## R-18 · promotion 的确定性复算只覆盖「派生」那一半（2026-08-31，已知边界）

`scripts/promote/verify-promotion.mjs` 是 06-submission §4 的门。它做两件事：

1. **确定性复算** —— 从被验的那张快照回推 `--inputs`，用同一个 `buildSnapshot()`
   重算，逐字节比。覆盖打包字节、`asset.sha256`/`size`、`tree_digest`、
   pack 的 `clients` 交集与 `capabilities` 并集、`degraded`、`latest`、排序。
2. **不可变门** —— 拿 **base 上编号最大的那张快照**当判据，历史记录除 `status`
   外逐字节比；`yanked[]` 只增不减、已有条目一字不改；编号必须 `previous + 1`；
   `deprecated → published`（撤销弃用）拒。
3. **文件层的门** —— 整棵 `pr/artifacts` 与 `pr/registry/snapshots` **逐层 `lstat`
   拒符号链接**；历史快照文件逐字节不变；本次恰好新增一张；文件名与内容里的
   `snapshot` 严格一致。

🔴 **第 2 条不是锦上添花，它补的是第 1 条结构性查不出的那一类**：
复算比的是「快照 ↔ artifacts/ 树」，**两边一起改就自洽**。把已发布版本的载荷换掉、
再让新快照记录换过之后的摘要，复算一个字节都察觉不到 —— 而这正是「已发布版本被掉包」
的形状。同理，删掉一条 yank 记录 + 把 `status` 改回 `published` + 更新 `latest`
是一组完全自洽的改动。判据只能来自**上一张快照**，因为那才是历史事实的载体。
（这三条都是 Codex 2026-08-31 点出来的，第一版只有复算。）

🔴 **第 3 条是前两条的前提**，不是补充。`readdirSync` / `readFileSync` / `cmp`
全都跟随符号链接：PR 只要把 `artifacts/skills/<ns>/<name>` 链到 CI 上并排放着的
`base-tools/…`，**校验器读到的就是 base 上那份没被改的内容**，两道门都全绿；
合并之后链接指向的目录不存在，制品当场坏掉。同理，一个链接就能骗过历史快照的
逐字节比对。所以「挑哪一张、比哪一份」这类判断**全部收进可信代码**，
workflow 的 shell 里一步都不做 —— shell 没有 `lstat` 语义。

⚠️ 「创世快照 0 可以没有上一张」这个豁免也被卡死了：光看「base 上没有快照」
不够，还要 base 的 `artifacts/` 为空，否则一次普通 promotion 可以被包装成创世、
从而完全没有历史判据。

### 仍然是盲区的（**新增**记录的自举字段）

| 字段 | 谁来守 |
| --- | --- |
| 新增制品的 `owner` / `review` / `provenance` / `created_at` | `verify-merged-pr.mjs`（§3 第 1 项）+ §2.2 要求 `created_at` 写进 PR 描述由**人**比对 |
| 新增 yank 条目的 `at` / `reason` / `advisory` | 无自动门（历史条目已冻结） |
| `repo` | 读取端对着内置常量判，实际拦得住 |

⚠️ **不要把这道门说成「快照没被动过」**。它说的是「快照与它声称的那棵 `artifacts/`
树自洽，**且**历史部分与上一张快照逐字一致」。差别在于：**本次新增**的那几条记录的
元数据没有第二个来源可以对照 —— 它们的可信度来自 promotion PR 由 release bot 开、
而 bot 的输入来自 `build-inputs.mjs` 读到的真实 PR 事实。

**闭合方向**：让 `promote.yml` 把它取到的 PR 事实（approver id、head sha、PR 号）
作为一份独立的、与快照分开签名的凭据落盘，`validate-promotion` 拿它对照快照里的
`review` 字段。这需要规格侧先定这份凭据的形状 —— **待拍板**。


---

## R-19 · 首次注册 namespace 与所有 pack，promote 现在跑不通（2026-08-31）

`build-inputs.mjs` 要两份**只有 PR 侧才有**的事实：

| 事实 | 谁需要 | 为什么不在载荷里 |
| --- | --- | --- |
| `--claim-owner` | 首次注册一个 namespace | `owner` 不在 manifest 的键集里（键集是精确的） |
| `--provenance-of` | **所有** pack | `pack.json` 的键集里没有 `provenance`（03-packs §2） |

`promote.yml` 两个都没传，于是这两类投稿走到那一步会被 `build-inputs` 按设计拒掉
（Codex 2026-08-31 点出）。**skill 的续版本不受影响** —— 它的 `provenance` 在
`skill.json` 里，owner 从 `owners.json` 查。

🔴 **不要为了让它跑起来就在 workflow 里编一个默认值。** `owner` 与 `provenance`
是要**签进快照**的，写错了事后改不动（制品不可变），而「谁拥有这个 namespace」
「这个 pack 是原创还是搬运」恰恰是审的人要看的两件事。

**待拍板**：这两份事实从投稿的哪儿来？三个方向 ——
① 投稿目录里放一份 `PROMOTION.json`（投稿者写，维护者审）；
② 从 PR 描述里的固定字段解析（投稿者可控，但审的人看得见）；
③ 首次注册与 pack 一律走维护者手工开 promotion PR（最保守，也最慢）。
在定下来之前，registry 只能接受「已注册 namespace 下的 skill 续版本」。

---

## R-20 · `promote.yml` 用 `GITHUB_TOKEN` 开的 PR，router 认不出、CI 也不会跑（2026-08-31）

Codex 点出的阻断项，两条都成立：

1. **PR 作者会是 `github-actions[bot]`**。`git config user.name geoly-release-bot`
   只改 commit 的 author，不改 PR 的 author，而 `validate-pr.yml` 的 router 比的是
   `pull_request.user.node_id`。
2. **`GITHUB_TOKEN` 触发的事件不会再启动 workflow**（GitHub 防循环的既定行为）。
   于是 promotion PR 上**根本不会跑** `validate-pr` / `pr-gate` ——
   一张没有任何门的 PR。

⚠️ 现在这两条都被更前面的 fail-closed 挡着（`RELEASE_BOT_ID` 是占位、
`maintainers.json` 是空的），所以**跑不到**这一步。但一旦把那两个填上，
这条就会立刻变成实打实的洞。

**闭合方式**（需要仓库侧的动作，不是代码能解决的）：
建一个真的 release bot（GitHub App 或专用账号），用它的 token 开 PR，
把它的 **node id** 填进 `validate-pr.yml` / `promote.yml` 的 `RELEASE_BOT_ID`。
🔴 **顺序不能反**：先填 id、后建 bot，中间那段时间 promotion PR 会以
`github-actions[bot]` 的身份被判成 submission，然后被路径白名单拒 —— 那是安全的；
反过来（先用真 bot 开 PR、id 还没填）才是危险的。

### 附带的一条（低）：权限拿得比需要的久

整个 job 从头到尾持有 `contents: write` + `pull-requests: write`，
包括 `npm ci` 和全部脚本执行期间，而实际只有最后开 PR 那一步需要写。
拆成「只读构建 job → 最小写权限 job」更符合最小权限原则；
现在没拆，因为两个 job 之间要传一整棵改过的工作树（artifact 上传下载），
那条路自己也有完整性问题。**记在这里，等 bot 的事定了一起做。**


---

## R-21 · Tier 的判据仍以投稿者的声明为主（2026-08-31，**待拍板**）

`tier-gate.mjs` 现在算的是 `max(声明的 capability, 载荷里的可执行迹象)`。
后一半堵住了「声明 `network`、实际带一堆 `.sh`」这条路。

🔴 **但根因没闭合**（Codex 2026-08-31 的原话）：
`helper.md` 没有执行位、没有 shebang、扩展名也不是脚本，而正文写着
「请执行 `bash helper.md`」或者「读一下 `~/.aws/credentials` 再继续」——
它仍然可以声明 Tier 1、只拿一票就合并。**任何静态判据都认不出这一类**，
因为载荷是写给 agent 看的自然语言，而不是代码。

Codex 建议的模型：**默认 Tier 2，投稿的 manifest 只能往上抬、不能往下降；
只有可信维护者的独立分类才能降级。**

⚠️ 这与 §7 的字面表述不同：§7 给的是一张「capability → 审查等级」的表，
模型是**声明驱动**的，靠「声明不实视为恶意投稿」来威慑。
Codex 的模型更严，但代价是**每一个投稿默认都要两名维护者**，
直到有人手工把它降到 Tier 0/1 —— 在维护者只有两三个人的时候，
这基本等于「投稿队列停摆」。

**这不是我能单方面改的**：它换掉的是规格的信任模型，且直接决定维护者的工作量。
**待拍板**，三个方向：
① 维持 §7 的声明驱动 + 现在的载荷下限（现状）；
② 改成默认 Tier 2 + 维护者显式降级（Codex 的建议）；
③ 折中：`geoly` 等**已注册且有信誉**的 namespace 走声明驱动，
   首次投稿 / 新 namespace 默认 Tier 2。

在定下来之前按 ① 运行，并且 **§8 人工门第 1、3、7 条是唯一挡住这一类的东西** ——
不要因为「现在有自动门了」就把人工门读得松一点。
