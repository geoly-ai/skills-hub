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

## R-13 · 🔴 `timestamp.yml` 走 `git push origin main`，而规范说那条路走不通

**前提**：无需攻击者。这条是**实现与规范直接矛盾**，不是攻击面。

**事实**：[`02-registry.md`](../m0/02-registry.md) §3.2 写得很清楚 ——

> v2 说「由 release bot commit 落盘」——但分支保护禁止直推（含管理员），**跑不起来**。
> v3：timestamp **只作为 GitHub Release 资产分发**……更新 release 资产**不需要 commit**。
> 仓库里**不存** timestamp 的当前值。

而 `timestamp.yml` 的收尾 job 干的正是 v2 那套：`git add registry/timestamp.json …`
＋ `git push origin main`，并为此持有 `contents: write`
（checkout 会把 GITHUB_TOKEN 写进 `.git/config`）。

**后果**：① 第一次真跑会被分支保护挡住 —— 而 timestamp 是「我拿到的清单是不是**现在**的」
那一环，它不运转就等于新鲜度链没有闭合；
② 仓库里会存下 timestamp 的当前值，§3.2 明令不存。

**为什么本轮不闭合**：改法（滚动 Release 资产 + 去掉那个 `contents: write` 的 job）
本机**验不了** —— cosign 身份、资产上传、tag 行为都只有真跑才知道。
而它是发布关键路径，且会移除一个持写权限的 job。**这属于该由人拍板的动作**。

**代价评估**：不闭合的代价是「定时刷新至今尚未运转」——
而它**本来就没运转**：`timestamp.yml` 的 `schedule:` 是注释掉的，
理由是「仓库里还没有 registry/snapshots/，这个 job 每天都会 fail-closed 变红」。
所以这条**今天没有在造成损害**，但它是打开 cron 之前**必须先解决**的前置。

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
