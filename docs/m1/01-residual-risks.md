# M1 已知且接受的残余风险

> 这里只放**明确决定不闭合**的风险。每条必须写清：
> 攻击前提是什么、缓解到什么程度、**为什么不闭合**、闭合的话代价是什么。
>
> 🔴 **不允许出现「以后再说」。** 一条风险要么有闭合计划（那就进 issue，不进本文），
> 要么就在这里说明白为什么接受。把未决事项伪装成已接受，比不写更糟。
>
> 埋点子系统的 T-15 / T-16 见 [`../telemetry/00-spec.md`](../telemetry/00-spec.md) §6，
> 不在本文重复。

---

## R-1 · `treeDigest` 的 lstat → read 之间可被换文件

**攻击前提**：攻击者**已经能在 target 目录里写文件**。

**现状**：`tree-digest.mjs` 先 `lstat`（判类型、拒 symlink/硬链接）再 `readFileSync`。
两步之间，那个路径可以被换成别的东西。

**缓解**：制品解包在 `mkdtemp 0700` 的隔离目录里做，写入用 `O_EXCL|O_NOFOLLOW`，
权限与元数据检查针对 **fd** 而不是路径（`fchmod`/`fstat`）。

**为什么不闭合**：闭合要在 `openat`/`fstatat` 上重写整条读取链，而 Node 不暴露这些系统调用——
只能上原生模块。而「无原生依赖」正是当初把锁从文件锁换成 `node:sqlite` 的理由（D11′）。

**代价评估**：攻击前提已经是「能在 target 里写文件」。到那一步，攻击者有远比
竞态换文件更直接的手段（比如直接改已装好的 skill）。**为这条上原生依赖不划算。**

---

## R-2 · 目录链中途被换成 symlink

**攻击前提**：同 R-1。

**现状**：`safe-fs.assertNoSymlinkInChain(base, rel)` 从可信 base 往下逐层 `lstat`。
检查完成到实际操作之间，中间某一层仍可被换成 symlink。

**为什么不闭合**：同 R-1——需要 dirfd 相对的 `openat`/`mkdirat`。

⚠️ **不要用 `realpath` 假装解决了。** `realpath` 只是把竞态窗口挪个位置，
还会顺带把「合法的 OS 级 symlink」和「攻击性 symlink」混为一谈
（macOS 的 `/var → /private/var` 就是前者）。

---

## R-3 · 预检不保证「世界不会变」

**现状**：`target.precheckTarget()` 返回的是**一个快照**，不是一份保证。
预检通过到真正动手之间，target 可能被卸载、被改权限、被塞进嵌套 target。

**为什么不闭合**：这不是实现缺陷，是 M0 §5.10 明写的事实——
「target 锁只约束遵守该锁的 CLI，不约束用户与其它进程」。

**约定**：
- **不提供** `precheckAndLock(...)` 这类看起来像原子的 API——那会让调用方
  误以为拿到了保证。预检就叫预检。
- 真正的动作点必须**自己复验**它依赖的那几项，并在失败时 fail-closed。
- 预检的价值是**尽早、集中地报出已知死路**，不是消除竞态。

---

## R-4 · `enabledCombos()` 为空期间不能安装

**现状**：Q12 只实测过 `codex × global`，其余组合无证据，gate 表按 fail-closed 全部 `pending`。

**为什么不「先放开再补」**：Q12 是 M0 写死的**阻塞门**。
放开一格就等于把「阻塞门」降级成「建议」，而这道门防的是
「`.geoly` 被客户端当成 skill 加载」——那会直接污染用户的技能列表。

**因此也不提供 `--allow-pending`**。要开某一格，就补那一格的实测证据。

⚠️ 注意区分两种 `pending`：`scope-decision-pending`（证据齐了，等人拍板范围）
与缺证据（要重新做实验）。混在一起会让「拍个板就能开」的格子看起来像还要做实验。

---

## R-5 · Sigstore 依赖声明的 Node 下限高于我们的

**现状**：`@sigstore/verify` 及其两个一方依赖声明 `engines.node` 为
`^22.22.2 || ^24.15.0 || >=26.0.0`，而本仓库按 M0 的 D11′ 定在 `>=22.13`。
`npm install` 会在 22.13–22.22 上打 `EBADENGINE` 警告。

**为什么判定可用**：那是 Node **安全补丁**地板，不是 API 要求。
实测 Node 22.13.0 上全量测试 500/500 通过。

**为什么不抬下限**：D11′ 的 22.13 是 Gate 2 实测过的门（`node:sqlite` 在 22.13 起默认启用）。
为一个第三方包的补丁地板去改已封版的平台下限，代价不成比例。

**缓解**（把「我们觉得能用」换成「每次都验」）：
- 依赖**钉死精确版本** `4.1.2`，不用 `^` —— 浮动的话未来某个 4.x 可能真的用上
  22.22 才有的 API，而那会**静默**破掉我们的下限
- 提交 `package-lock.json`
- `scripts/test-matrix.sh` 保留 22.13.0，所以每次全量跑都在复验这条偏离

⚠️ **升级这个依赖时必须重跑 22.13 矩阵**，不能只看 CI 的高版本。

---

## R-6 · Rekor v2 会成为运维阻断点

**现状**：`assertTLogBodyShape()` 把透明日志条目钉死在 `hashedrekord 0.0.1`。
库已支持 `hashedRekordV002`，但会被我们的形状校验先挡下（`E_TLOG_BODY_VERSION`）。

**后果**：**Rekor v2 成为签发侧默认的那天，所有新制品会一次性全部装不上。**

**为什么现在不放开**：放宽形状校验等于降低验签强度，而 v2 的条目语义我们还没逐字段核过。

**这不是「接受」，是「有期限的已知债」**：要在 Rekor v2 切默认之前完成 v2 形状校验并做双版本兼容。
⚠️ 这一条与本文其余各条不同——**它会自己爆炸**，需要盯着上游排期。

---

## R-7 · 🔴 两个已通过的客户端各自只靠**一层**保护

Q12 实测发现，`.geoly/` 之所以没被当成 skill，两端的原因**完全不同**：

| client | 会递归吗 | 过滤点目录吗 | 靠哪一层活下来 |
|---|---|---|---|
| codex | ✅ 会（同深度正对照 6→7 证实能到达 `.geoly/tx-1/stage/` 那么深） | ✅ 会 | **点目录过滤** |
| claude | ❌ 不会 | ❌ 不会 | **不递归** |

**实测**：`<target>/.geoly/SKILL.md` 在 claude 里**会被当成一个名叫 `.geoly` 的 skill 加载**（15→16）。

**因此有一条硬布局不变量**：

> 🔴 **`.geoly/` 顶层永远不得出现 `SKILL.md`。**

违反它，claude 端立刻污染用户的 skill 列表。当前布局满足这一条，但它是**布局的性质，不是代码的性质**——
没有任何断言在守着它。任何调整 `.geoly/` 布局的改动都要重新过这一条。

⚠️ **更要紧的是这个结论的形状**：两端「都通过了」，但**通过的理由不共享**。
任一端改掉自己那一层（codex 取消点目录过滤、claude 改成递归），
就会**单独**破掉——而另一端的绿灯不会给出任何预警。
所以客户端升级后必须**逐端**重测，不能因为「上个版本四格全绿」就外推。

---

## R-8 · cursor 的静态预判是「会失败」，但那不是测量

**现状**：`cursor-agent 2026.02.27-e7d2ef6` 已安装但**未认证**（每条命令都 `Authentication required`，
登录要交互式浏览器 OAuth），Cursor IDE 未安装。**零条运行时读数。**

**静态读它的加载器**：递归到 **10 层**收集任意 `SKILL.md`，排除集只有
`{node_modules,.git,.svn,.hg,__pycache__,.cache,dist,build,.next,.nuxt}`——
**既不含 `.geoly`，也没有点目录过滤**。而 `.geoly/tx-1/stage/<n>/SKILL.md` 在第 3 层。
按 R-7 的两层保护看，**两层都不具备**。

**为什么仍然只标 pending 而不是 unsupported**：**预判不是测量。**
标 `unsupported` 与标 `passed` 一样都是结论，都需要证据。
evidence 里写死了「预判失败」，防止有人顺手开绿。

**要关掉这一格需要**：`cursor-agent login`，或安装 Cursor IDE。

⚠️ **附带发现（未测量，不计入任何一格的判定）**：cursor 还会看 `.agents/skills`，
开启第三方扩展后还看 `.claude/skills` 与 `.codex/skills`——
也就是说装了 cursor 的机器上，它可能扫到**其它客户端的 target**。

---

## R-9 · 解析与安装之间的 trust floor 接缝

**攻击前提**：另一个进程在本进程「`resolveCurrent()` 推进 floor、释放 metadata 锁」
与「提交安装事务」之间，把 floor 又推进一次。本进程仍会按旧快照装完。

**缓解**：`install.commitPoint()` 在**提交点之前**（target 未动、放弃仍免费）
调 `trust.assertFloorUnchanged()`，不符即 `E_FLOOR_MOVED` 停机。
`floor` 参数**必须显式给**——`undefined` 直接拒绝，无 registry 出处要显式写 `floor: null`。
**忘了传是拒绝，不是跳过。** 过了提交点不再复验：事务已被承诺，恢复只能续做或回滚
（同 §5.8「`--from-generation` 豁免当前状态门」的取法）。

**为什么不闭合**：真屏障要求在同一临界区里持 metadata 锁直到写入生效点。
而 §5.1 的加锁全序是 `metadata → repo → target`，提交点此刻**已持 target 锁**，
再取 metadata 锁是**反序**（规范明令禁止，会出现「双方各持一半」的死锁）；
`src/lock.mjs` 又禁止重入。

**代价**：闭合需要改 §5.1 的加锁全序，或把 floor 的权威搬进 target 锁——
两者都会牵动**已封版**的锁协议。

🔴 **明确不承诺**：这只把竞态窗口**缩小**到「提交点之后」（覆盖了整个下载 + 解包段），
**不消除**它。**不得宣称抗并发 floor 推进已闭合。**

---

## R-10 · 两套故障矩阵并存，`fault-matrix` 仍在测假事务

**现状**：`test/fault-matrix.test.mjs` 驱动的是 `test/harness/fake-tx.mjs` 里的**假事务**；
真内核有另一套 `test/kernel-fault-matrix.test.mjs`。CATALOG 里的 `owner` 已翻成真模块，
但那只是标注——**驱动矩阵的仍是假实现**。

**为什么会这样**：交付时 `scenarios.mjs` 在那位子代理的只读边界内，动不了。
它没有把 owner 写成纯真模块然后当作已经指向真内核——那会是假话。

**风险**：两套并存 = 假事务与真内核可能**各自收敛到不同的模型**。
Codex 说得很直接：「fake 矩阵证明的是假事务在它自己模型里收敛，不是规格的等价实现。」

**要做的**：把 `scenarios.mjs` 指向真内核，合并成一套。这不是残余风险，是**待办**——
放在这里只是为了不让它在两套都绿的假象里被忘掉。

---

## R-11 · 跨块验收挑出的 P1 接缝（未修，待办）

2026-08-27 Codex 跨块验收判定「无 P0，可以提交」，同时列出五条接缝。
其中「tar writer 接受集合大于 parser」已当场修掉（写入端改走与读取端同一条
`assertArtifactPath`），其余四条如实留着：

| 接缝 | 现象 | 为什么现在不修 |
|---|---|---|
| **audit event id 与 `audit-seq` 未绑定** | `mergeAuditAppend()` 不校验 allocator 来源或水位；`audit-seq=0` 时可写入 `event_id=999`，之后 allocator 仍返回 1 | CLI 还没接通 audit 面，接线时一并做 |
| **root key / `requested_by` 图未在边界闭合** | `validateRoot()` 不校验 root key 的 grammar，`../escape` 能当 root key 被接受；`validateEntry()` 不确认 `requested_by` 指向同一 ledger 的 root | 悬挂键会在投影到 lockfile 时才被拒；要在 ledger 边界补 |
| **lockfile 读侧比写侧宽** | `validateLockfileShape()` 接受 `all@snapshot:01` 这类别名，不校验 `target.path` 是安全相对路径 | ⚠️ **若将来直接用读侧结果物化 target 而不硬调 closure 校验，这条要升级为 P0** |
| **completed journal 删除早于 lockfile hook** | `runCleanup()` 先清事务与 journal，最后才 `runLockfileRecalc()`。hook 抛错时 ledger 已提交、project lockfile 可能陈旧，而 recover 已无 journal 可重试 | 修法是把 recalc 前移，或持久化一个 `lockfile-sync-needed` 意图 |

🔴 **共同的形状**：前三条都是「**读侧与写侧的接受集合不对称**」。
tar 那条是同一形状，只是它当场就红了（写出来的东西自己读不回来），
另外三条不会立刻红——它们要等到跨模块传递时才暴露。

**判据**：任何一对「写入 / 读回」的边界，都要问一句
**「写入端接受的每一个输入，读取端是不是都接受？」**
这个性质要写成属性测试，不能靠喂几个合法样例（我那条往返测试第一版就是只喂合法输入，
所以对 `../x` 视而不见）。
