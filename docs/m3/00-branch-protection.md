# M3 · 分支保护与仓库设置（要**人**去点的那部分）

06-submission.md §10 要求「M3 之前配好」。这份文件把它翻译成可以照着点的清单，
并说清楚**每一条挡的是什么** —— 一条不知道在挡什么的设置，下次有人嫌它碍事就关掉了。

🔴 **这些不是代码能做到的。** 仓库里所有的门都建立在「`main` 只能通过 PR 前进」
这一个前提上：`promote.yml` 认「push 到 main」为投稿已被审过，
`verify-promotion` 拿 base 上的快照当历史事实。**直推一旦可能，这两条同时失效。**

---

## 1. `main` 的分支保护

| 设置 | 值 | 它挡的是什么 |
| --- | --- | --- |
| Require a pull request before merging | ✅ | 没有它，下面每一条都是摆设 |
| └ Require approvals | **1** | Tier 0/1 的下限。Tier 2 的第二名由 `build-inputs.mjs` 的 `assertApprovalsSatisfyTier` 强制 —— 见下面「为什么不靠这里配 2」 |
| └ Dismiss stale pull request approvals when new commits are pushed | ✅ | 「approve 之后又推了一版」。⚠️ `verify-merged-pr.mjs` 在 promote 侧**还会再判一次**，因为这是仓库设置、不是我们能证明的东西 |
| └ Require review from Code Owners | ✅ | 让 `.github/CODEOWNERS` 真正生效。只写文件不开这个开关 = 一道摆设 |
| Require status checks to pass | ✅ | |
| └ Required checks | **`pr-gate`**、**`ci-gate`** | 见下面「为什么只钉两个名字」 |
| └ Require branches to be up to date before merging | ✅ | 让 PR 上跑过的门与合并后的树是同一棵。否则 base 前进之后，一张「版本号没占用」的判定会过期 |
| Require conversation resolution before merging | ✅ | §10 明写 |
| Do not allow bypassing the above settings | ✅ | **含管理员**（§10 的原话）。这一条不开，上面全部可选 |
| Allow force pushes | ❌ | force push 会让「历史快照逐字节不变」失去意义 —— 判据本身可以被重写 |
| Allow deletions | ❌ | |

### 为什么 Required approvals 只配 1，而不是 2

§7 的分级是 **Tier 0/1 一名、Tier 2 两名**，而 Tier 取决于载荷里声明的
capability —— **分支保护表达不了「按内容决定人数」**。

配成 2 会把所有 Tier 0 投稿也卡在两名审阅上（实际结果是没人投稿）；
配成 1 再由 `build-inputs.mjs` 在 promote 时按 Tier 判第二名，
两者合起来才是 §7。**这不是把门放松了**：Tier 2 的第二名审批仍然是硬要求，
只是判它的地方从「合并前」挪到了「promote 时」——
少一名就产不出 promotion PR，制品进不了 registry。

⚠️ 代价说清楚：一个 Tier 2 投稿可以带着一名 approve **合并进 main**，
然后 promote 失败。`submissions/` 里因此会留下一个搬不走的目录，
下一次 promote 会撞上 `E_SUBMISSIONS_MISMATCH`（那是故意的，见 R-19 旁边那段）。
**这是已知的粗糙处**，闭合方式是让 `validate-pr.yml` 也读 capability 判 Tier
并在投稿 PR 上就要求两名 —— 但 required approvals 的**数量**仍然配不出动态值，
所以那条只能做成「Tier 2 时 `pr-gate` 自己去查 approvals」。**待做。**

### 为什么 Required checks 只钉 `pr-gate` / `ci-gate` 两个名字

§4 要求「两个 workflow 中**恰好一个**通过，且 router 判定的那个必须是它」。
**GitHub 配不出这个** —— required checks 是一组静态名字，没有「二选一，
且要是运行时算出来的那一个」这种表达。

所以 `validate-pr.yml` 用一个固定名的聚合 job `pr-gate`：router 在 job 内部判定，
两条路径互斥、且只认 router 的判定（见该文件顶部的说明）。
**误配在构造上就不可能发生**，这比两个 workflow + 一份正确的分支保护配置更强。

🔴 **千万不要把 `submission-gates` / `promotion-gates` 也加进 required checks。**
它们**按定义**会有一个是 skipped，而 skipped 在 required checks 里算**未通过** ——
加进去的结果是所有 PR 都合不了。

---

## 2. 仓库级设置

| 设置 | 值 | 理由 |
| --- | --- | --- |
| Actions → Workflow permissions | **Read repository contents** | 默认给写权限的话，任何一个 workflow 被改坏都是直接可写。需要写的（`promote.yml`）在自己的 `permissions:` 里显式要 |
| Actions → Allow GitHub Actions to create and approve pull requests | ✅ | `promote.yml` 要开 promotion PR。⚠️ **approve 那一半用不上** —— `verify-merged-pr.mjs` 只认 `registry/maintainers.json` 里的人，机器人的 approve 一律不计 |
| Actions → Fork pull request workflows | **Require approval for first-time contributors** | 投稿多半来自 fork。`validate-pr.yml` 本身不给 secret、也不执行载荷，所以不需要「所有外部 PR 都要批准」那一档 |
| Secrets | `promote` / `validate` 一个都不需要 | §5：不给任何能 checkout fork head 的 job 任何 secret |

---

## 3. 上线顺序（🔴 不能反）

1. 建 `@geoly-ai/maintainers` 团队，把人加进去；
2. 把这些人的**不可变 node id** 填进 `registry/maintainers.json`；
3. 建 release bot（GitHub App 或专用账号），把它的 node id 填进
   `validate-pr.yml` / `promote.yml` 的 `RELEASE_BOT_ID`；
4. 用 bot 的 token 替换 `promote.yml` 里的 `github.token`（见 R-20）；
5. 打开本文件的全部分支保护；
6. **最后**才允许第一张投稿 PR。

🔴 **第 3 步与第 4 步的顺序不能换。** 先填 id、后建 bot，中间那段时间
promotion PR 会以 `github-actions[bot]` 的身份被判成 submission、
然后被路径白名单拒掉 —— 那是安全的。反过来（bot 已经在开 PR、id 还没填）
才是危险的：那些 PR 会走 submission 那条路径，而它检的是 `submissions/**`，
对 `artifacts/**` 与 `registry/**` 的改动一个字都不看。

⚠️ 在 1–5 全部做完之前，仓库处于 **fail-closed** 状态：
`maintainers.json` 是空的 → 审批门直接拒 → promote 跑不起来。
**这是有意的**，不要为了「先跑通」把它填成占位值。
