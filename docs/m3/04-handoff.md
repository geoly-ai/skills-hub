# 交接文档 —— skills-hub 第一次真实发布，卡在哪、下一步做什么

> 写于 2026-09-02。读者是**接手把第一批 skill 发出去的人**。
> 这份文档只写「现在是什么状态」和「为什么是这个状态」，不重复规格 ——
> 规格在 `docs/m0/`，交付记录在 `docs/m3/01-delivery.md`。

---

## 0. 一句话

**整条链已经全自动跑通，registry 里有 20 个制品，CLI 0.2.0 已发 npm。**
📌 本文档的「下一步」与「卡点」几节写于 2026-09-02 早些时候，
   那时链条还卡着 —— 保留它们是因为**踩过的坑仍然适用**，
   但「现在的状态」以第 1 节为准。

---

## 1. 现在的状态（`main` = `4c24e66`，2026-09-02 晚）

| 东西 | 状态 |
|---|---|
| `@geoly-ai/skills-hub` (npm) | **0.2.0 已发布**（带 provenance；0.1.0 起埋点由「只写本地」变成**默认上报**） |
| `registry/snapshots/` | **`hub-0.json` → `hub-1.json`** |
| `artifacts/` | **20 个制品**：`prompts-map/*@0.7.0`（9）+ `plaud-theme/*@0.3.6`（11） |
| `registry/owners.json` | `prompts-map` 与 `plaud-theme` 都归 `geoly-ai` 组织 |
| `submissions/` | 空 —— 全部已搬进 `artifacts/` |
| 站点 | https://skills-hub-pearl.vercel.app/ |
| 埋点摄入端 | `https://skills-hub-telemetry.vercel.app/v1/events`（Vercel + Neon） |

**整条链已经全自动跑通过一次**：投稿 PR 合并 → promote 铺制品、生成快照、
release bot **自动开** promotion PR → 合并 → 制品进 registry。
`release.yml` 也真跑过：签名、时间戳、attestation、npm publish 全绿。

### 快照长这样

```
hub-1:  snapshot = 1   previous = 0        ← 编号连续
        制品 = 20（plaud-theme 11 + prompts-map 9），全部 Tier 2
        owner = {kind: org, login: geoly-ai, id: O_kgDOD7uDqA}
```

🔴 **最难验的那条在 hub-1 上验过了**：上一批 9 个制品的 `review.pr` **仍是 11**，
没有被本次 PR #14 顶掉 —— 审批归属被原样继承，审计记录没被篡改。
这条只有真的存在两代快照才走得到，本地测试很难覆盖。

`owner.id` 是 `O_` 开头的**组织** node id，不是投稿者的用户 id —— 这是对的
（记成个人 id 等于把 namespace 给了这个人却显示成组织的）。
---

## 2. 下一步：三件事，按顺序

### ① 验证 promotion PR #8 现在能不能过（先做这个）

`eb7ea27` 修的正是拒掉 #8 的那条规则。**但那个修复还没有在真实 PR 上验证过。**

```sh
gh pr view 8 --json headRefOid --jq .headRefOid   # 记下它
# 让 validate-pr 重跑（改 base 或 push 一个空 commit 到 promotion/hub-0）
gh pr checks 8
```

⚠️ **`gh run rerun` 没用** —— 它回到原 commit 上的 workflow，修复不生效。
这一点在这条链上反复咬人，见 §4。

预期：`route` 判成 `promotion`、`promotion-gates` 跑起来（确定性复算门 +
制品不可变门，**这两道从来没在真实环境跑过**），`pr-gate` 绿。

### ② 给 release bot 的 PAT 补 `Pull requests: write`

promote 的最后一步失败在：

```
pull request create failed: GraphQL: Resource not accessible by personal access token
```

分支推上去了（Contents 权限够），但开不了 PR。#8 是**我手工开的**。

- 改这里：https://github.com/settings/personal-access-tokens → 找到 skills-hub 那个
  token → Repository permissions → **Pull requests** 改成 **Read and write**
- 仓库在组织下，如果开了 PAT 审批，还要在
  https://github.com/organizations/geoly-ai/settings/personal-access-tokens/active
  重新批准
- **secret 不用重填** —— 改的是权限，token 值没变

### ③ 合并 #8 之后：钉 required status checks

**顺序不能反。** 现在门跑归跑、**拦不住合并**（PR 里所有 check 都是可选的）。
要钉的是 `pr-gate` + `ci-gate` 两个聚合门，建成**第三条 Ruleset，不给任何人豁免**。

⚠️ 别钉矩阵 job 的名字（`test (22.13.0)` 这种）—— 版本号一换，那条 required check
就再也不会出现，而 **GitHub 不会报错，它只是不再拦**。这就是 `ci-gate` 存在的理由。

---

## 3. 分支保护现状（两条 Ruleset，2026-09-01 建）

| Ruleset | 规则 | 谁能绕 |
|---|---|---|
| `main：不可绕过的底线` (22001700) | 禁删 main、禁 force push | **没人** |
| `main：PR 与审批` (22001715) | 必须走 PR、1 名 approve、CODEOWNERS、push 后作废旧审批 | **只有 chovizzz** |

🔴 **审批豁免 ≠ 可以不走 PR。** 这两件事极容易混成一件（我混过）：
promote 要从 PR 上取审批归属、作者 node id、PR 号、创建时刻 ——
直推 main 的话它一样都拿不到，只能 fail-closed。

⚠️ `gh pr merge` 会看 `mergeStateStatus=BLOCKED` **自己拒绝**，
而直接调 merge API 时 Ruleset 豁免生效、能过。CLI 的预判比服务端严：

```sh
gh api repos/geoly-ai/skills-hub/pulls/<N>/merge -X PUT -f merge_method=squash
```

### 审批策略（`scripts/submission/approval-policy.mjs`）

- `EXCLUDE_AUTHOR = false` —— 作者本人的 approve **计入**（用户 2026-09-01 拍板）
- `APPROVAL_BYPASS_IDS = ['U_kgDODu4RvA']`（chovizzz）—— 他自己投的稿**跳过审批人数门**

🔴 **豁免只跳过「要几个人点头」**，不跳过别的：结构门、字符扫描、路径白名单、
版本号占用、确定性复算 —— 一条都照跑。放行时两处都会在 stderr 大声打一行，
因为**一次静默的豁免和一道坏掉的门，事后看起来一模一样**。

⚠️ **残余风险，明写**：名单上的账号被接管 = 对方可以在无人复核的情况下往
registry 里发任何东西。内容门还在，但内容门管不了「这东西该不该发」。
这是用户在明知的前提下选的形态，不是疏漏。

---

## 4. 这条链上踩过的坑 —— 接手前请读完这一节

第一次真跑挖出 **6 个 bug，全部是本地测试挖不到的**。它们的共同点比它们本身更重要。

### ① 直推 main 绕过 PR
promote 报 `这个 push 关联到 0 张 PR，必须恰好 1 张`。
**审批豁免不等于可以不走 PR。** 门判得对。

### ② 审批判定其实有**三处**，不是两处
`tier-gate`（合并前）、`verify-merged-pr`（promote 时）、
`build-inputs`（`assertApprovalsSatisfyTier`）各写了一遍作者排除。

🔴 **我为此写的防分叉不变式当时写死了两个文件名** ——
于是它证明的是「我知道的那两处没分叉」，不是「没有分叉」。
**一条维护着已知清单的不变式，只能守住你已经知道的东西**，
这跟它想解决的问题是同一个形状。现在改成全仓搜实现形状。

📌 **教训：「有几处」不能靠读注释确认，要靠搜实现形状。**

### ③ provenance 从不核对 —— 真漏洞
`build-inputs` 把 `manifest.provenance` **原样进快照**，从不与 `review.pr` /
`review.author` 核对，而那两个值就在同一个作用域的下两行。
投稿者可以在自己的 `skill.json` 里写任意 `author_github_id` / `submitted_by_pr`。

加上核对之后 **7 个既有测试立刻变红** —— 全都是 fixture 里声明的作者/PR 号
与传给 promote 的值互不相干。**那不是回归，是这个洞存在了多久的证据**：
一道从不比对两个值的门，自然也不会有人发现喂给它的两个值从来对不上。

### ④ collect 的输出污染 build-inputs 的输入
`collect-promotion-inputs` 把首次注册写回 `registry/owners.json`，
下一步 `build-inputs` 再读**同一个文件**，于是看到「已注册却还声明 claim_owner」
—— 而那个「已注册」是本次运行三行之前自己写的。
**第一步的输出污染了第二步的输入。**

### ⑤ 创世快照从来没跑通过
`--previous` 不传时默认 `null`，`null` 原样进 doc，读取端拒绝。
**每个单元测试都传着 `previous`**（helper 里 `o.previous ?? 41`），
唯一不传它的场合是「registry 空的」—— 那正是**只发生一次、没人测过**的那次。

修的时候特意区分：创世缺 `previous` → 补 0；**非创世缺 → 报错**。
静默填 0 会让第 42 张快照声称自己接在创世后面，而读取端看不出来（`0 < 42` 照样成立）。

### ⑥ promote 产出的 PR 过不了它自己的白名单（← 当前卡点）
搬运 = 复制进 `artifacts/` + 从 `submissions/` 移走，所以 PR 必然带
`submissions/**` 的删除，而 `PROMOTION_PATHS` 里没有它。
**单元测试喂的一直是手造的路径列表，从没喂过 promote 实际产出的那一组。**

🔴 修法**不是**把 `submissions/` 加进白名单 —— 那等于允许 promotion **新增**投稿，
而复算门只验 `artifacts/ ↔ 快照`，看不见 `submissions/`。
改成 `PROMOTION_DELETE_ONLY`：只许删。判据用 route 早算好的 `present`。

---

## 5. 一个被否掉的想法，别再走一遍

**promote 没有安全的重跑入口**，所以每修一个 bug 就要新开一张 PR
（还要改 9 个 `skill.json` 里的 `submitted_by_pr`）。已经做了四轮（PR #4/5/6/7）。

我两次想给 `promote.yml` 加 `workflow_dispatch`，两次都被否：

1. **自己发现**：`inputs.sha` 查 PR、checkout 却用 main HEAD —— 证据与内容脱钩。
2. **连 checkout 也用同一个 sha**，本以为安全。**Codex 指出仍然不安全**：

   > 同一个 SHA 只修复了"证据和内容不是同一棵树"，没有修复"**特权 workflow
   > 执行了谁的代码**"。

   具体路径：只有 Write、**不能合并**的协作者，推一个改了
   `scripts/submission/pr-classify.mjs` 的分支、开一张**未合并**的 PR、dispatch 它的
   SHA。流程会先执行那份 `pr-classify.mjs`，**之后**才检查 `merged_at` ——
   恶意代码在「PR 未合并」被发现之前就跑完了，而那时 `GITHUB_TOKEN` 还带着
   `contents: write` + `pull-requests: write`。加上 `persist-credentials: true`
   把凭据写进 `.git/config`，还能改 `origin` 外传 token、或设 `core.hooksPath`
   让后续 `git commit` 触发钩子，连 `RELEASE_BOT_TOKEN` 一起偷走。

`test/workflow-invariants.test.mjs` 里那条「`on:` 块必须**恰好**是三行」的
白名单拦住了这个改动。**它是对的，别绕过它。**

### 要做重跑入口的话，正确形状（Codex 给的）

独立的 `promote-retry.yml`：
- 只接受 `run_id`，**不接受任意 SHA**
- 第一个 job **不 checkout、不跑 Node、不碰 PAT**，只用只读 token 查原始 run
- 验证：确实是 Promote、原事件是 push、分支是 main、状态是失败
- 从 run 元数据取 `head_sha`，再验证它是 main 祖先且**唯一**关联一张**已合并** PR
- 处理时用两棵树：`base-tools`（受保护 main 的脚本）× `subject`（原始 SHA，
  **仅作数据**）—— 只执行 `base-tools/scripts/...`，**绝不执行 `subject` 里的脚本**

这正是 `validate-pr.yml` 已经在用的形状（`base-tools/` × `pr/`），
promote 这条路上一直没有，因为它假定「能进 main 的都可信」——
而 dispatch 打破的正是这个假设。

---

## 6. 已知但没修的问题（按优先级）

### ~~P1 保留 namespace 挡不住数字冒充~~ → **已修**（2026-09-03）

`ge0ly` / `geo1y` / `anthrop1c` 这类曾经**全部放行**，现在拦住了。

判据加在 `normalizeName()`（NFKC + 小写 + 去连字符）**之后**，只作用于
**与保留清单比对**这一侧：单字符折叠（10 个数字 + `l`/`i`）、`6`/`9` 作为
歧义占位符走非传递的逐位候选集比较、四条多字符折叠（`rn→m` `nn→m` `vv→w` `ci→d`）。

🔴 **明确不覆盖的，代码与测试各钉了一条**（写清代价，不假装全覆盖）：
· **子串/前缀包含** —— `geoly-ai`、`my-claude-helper` 放行。包含式判定会**当场
  杀掉 `geoly-ai`**（我们自己的 namespace）。
· **`l`/`i` 之外的字母↔字母替换** —— `qeoly` `githug` 放行。这是算过账的：
  挡它们要把 b/g/q 并成一类 ⇒ 推出 `b ≡ g` ⇒ **正常词 `hug` 被判成冒充 `hub`**。
  数字能按歧义处理，是因为「名字里出现数字」本身就是信号；两个都是普通字母时
  没有这个信号。

📌 **为什么这不是无底洞**：namespace grammar 只允许 `[a-z0-9-]`，连字符已被去掉、
   非 ASCII 已被 NFKC 与 grammar 拦住 —— 所以残余同形手段**只剩两类且可枚举**。

⚠️ 判据**只放在保留清单一侧**，不放进 `assertNoNormalizedCollision`：那边是
**开放集合**，折叠会让两个正常名字互撞，且撞的对数随注册量二次增长。

### ~~P1 `geoly` 这个 namespace 谁都用不了~~ → **不是 bug，是有意的取舍**

⚠️ **这一条是我读漏了注释报错的**（2026-09-03 更正）。

`assertReservedNamespaceAllowed()` 里的 `if (byMaintainer) return true` 看起来像
死代码（`--by-maintainer true` 确实从没被传过），但 `validate-pr.yml` 的
`maintainer-gates` 上写着**为什么故意不传**：

> `promote.yml` 合并后会把结构门原样重跑一遍，而它那一侧**没有这个开关**
> （promote 时「谁是维护者」已经不是一个 PR 事实了）。两边不一致的话，
> 一份占用保留 namespace 的投稿会顺利合进 main，**然后卡死整条发布流水线**
> —— 比「维护者也用不了保留 namespace」难查得多。

所以真实状态是：**保留 namespace 要用，得先把它从 `reserved.json` 里拿掉**
（一个显式的、要走 PR 的动作），而不是靠一个只在半条链上生效的开关。

📌 要放开的话**必须两侧一起改**，别只改 `validate-pr.yml` 那一处。

### P2 `skill.json` 要求投稿者自己写 PR 事实
`provenance.submitted_by_pr` 必须等于触发 promote 的 PR，而 PR 号只有开了 PR
才知道 —— 所以流程是「先开 PR → 拿到号 → 写进 skill.json → 强推」。
⚠️ 而 `PROMOTION.json` 的设计**恰好相反**：PR 事实由 promote 填，投稿者写了就拒。
同一个仓库两套相反的判断。更好的形态是让 `skill.json` 也别要求投稿者写、由 promote 填。

📌 这还带来一个副作用：`assertProvenanceMatchesPr` 假定「触发 promote 的 PR」
就是「提交这个制品的 PR」，**promote 自己出 bug 需要重跑时这个假设不成立**。

### P2 `vendored` 的 `imported_at` 没有核对
`build-inputs` 拿不到 PR 的创建时刻，投稿者仍可把它写成任意时间。
**这是已知缺口，不是「已缓解」。**

### P3 pack 还没发
9 个 skill 靠 `../prompt-map-shared/scripts/*.py` **兄弟路径**互相引用，
所以**单独装 `prompt-map-generator` 会得到一个引用不到 shared 的坏 skill**。
正确形态是再发一个 pack 绑定它们 —— 但 `pack.json` 的 members 要填每个成员的
`tree_digest`，而摘要由发布器计算、投稿者写的一律不读，
**所以 pack 只能等这 9 个先发出去之后再发**。

### P3 授权根文件没有「两名维护者」门
`maintainer` 路径按设计允许改 `registry/maintainers.json`、`.github/workflows/**`、
`CODEOWNERS`、各校验脚本 —— 这些正是「决定以后谁能改什么」的授权根。
加上 chovizzz 的豁免，改这些文件目前**不需要任何人复核**。
用户已知悉并选择维持现状（2026-09-01）。

---

## 7. 其他还在树上、但与发包无关的东西

| | |
|---|---|
| `site/` | registry 浏览站，**已上线**：https://skills-hub-pearl.vercel.app/ 。`DESIGN.md` 是 2026-09-01 重写的 v2，**还没套用到实现上** |
| `dashboard/` | skill 埋点数据平台，Next.js，94 测试。部署进行中 |
| `server/` | 埋点摄入端，**已上线**：`https://skills-hub-telemetry.vercel.app/v1/events`（Vercel + Neon Postgres） |

🔴 **站点的地址不是 `skills-hub.vercel.app`。** `.vercel.app` 子域名全局唯一，
项目名撞车时 Vercel 自动追加随机词 —— 裸域名**不属于本项目**，访问它拿到的是
边缘层的 `NOT_FOUND`（`text/plain`），不是站点自己的 404 页（那会是 HTML）。

⚠️ **这里踩过两次，第二次更值得记**：
① 看到裸域名 404 就以为是自己误部署搞坏了 —— 站点一直是好的，
   两件不相干的事被连成了因果。
② 更早还在**那个 404 页面**上 `grep _vercel/insights` 判断「站点有没有引
   analytics」。**在错误的 URL 上取证，结论就算碰巧对也是无效的。**
   与本仓库反复出现的那条同形：「看起来没有」往往由你正在看的那个东西决定。

⚠️ `site/` 和 `site/DESIGN.md` 里的 v2 设计有**九条 🔴 硬约束是正确性不是审美**
（不出任何使用量数字、信任信息不进右栏、不给综合绿勾而拆四格、
`1.1.0-rc.1` 不许被 uppercase 成 `RC`……）。视觉可以改，那九条不能。

---

## 8. 干活的约定

- **跟 Codex 协作走 `codex exec`，不要走 MCP**（MCP 会漏进程）。
  `codex exec -m gpt-5.6-terra -c model_reasoning_effort="xhigh" -s read-only -C <repo> -o /tmp/x.txt "..." </dev/null`
- 提交前跑 `npm run check:all` + `node --test test/*.test.mjs`（当前 **1313/1313**）
- commit 信息用 heredoc，**别用双引号** —— 里面的反引号会被 shell 当命令替换执行（我踩过）
- `git push` **不要加 `2>/dev/null`** —— 会把「推送被拒绝」也吞掉，
  然后你会在一个错误的前提上继续操作好几步（我踩过）
