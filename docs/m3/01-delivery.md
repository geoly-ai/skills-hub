# M3 交付汇报（投稿与审核）

> 2026-08-31。M0 已封版在 `docs/m0/`，本文**不修改**它。
> 结论若与 M0 正文冲突，以 M0 为准并在这里注明。
>
> 🔴 本文只写**已经发生的事**与**明确没做到的事**。不写计划，不写「以后再说」。
> 一条边界要么在这里说清为什么接受，要么就不该被写成已交付。

---

## 1. 交付了什么

| 块 | commit | 内容 |
|---|---|---|
| promotion inputs | `a97dddb` | `scripts/promote/build-inputs.mjs` —— owner / review / provenance，闭合 M2 待拍板项① |
| 投稿结构门 | `5134ec2` | §6 表里尚无实现的四条：保留 namespace、归一化重名、版本未占用、capability 一致性 |
| PR 分流 + 路径白名单 | `9744547` | §4 router（分支名 + 作者 node id + head repo 三元判据）、§5 硬拒路径 |
| 投稿 PR 的验证门 | `eb525ab` | `validate-pr.yml`：**可信代码 × 不可信数据** |
| promote 前重新验证 | `a8fde47` | §3 第 1、4 项：approve 未失效、版本号仍空 |
| promotion 的确定性复算 | `23ab5e1` | §4 的复算门 + 不可变门 |
| promote 流水线 | `8b8c8ba` `1665f25` | `stage-submissions.mjs` + `promote.yml`：§3 四项 → 阶段 A → 开 promotion PR |
| §8 第 5 条做成门 | `dd24121` `e6e14c2` `43dc058` | `scan-text.mjs`：bidi / 零宽拒，同形字与兼容形报注解 |
| §7 Tier 门（合并前） | `e6e14c2` `9a87fa8` | `tier-gate.mjs` 挂进 `pr-gate` |
| §9 token 存储 | `860efd2` | keychain 优先 + 文件兜底、`npx github:` 拒绝 |
| §10 要人点的那部分 | `dd24121` | `CODEOWNERS`、PR 模板、`docs/m3/00-branch-protection.md` |
| §1 阶段 C 的资产重建 | `8ea130d` `cd96dac` | `build-release-assets.mjs`：按已定稿的快照重建制品、逐字节比对、写出 `.tgz` 供 Release 挂载 |
| workflow 的安全不变量 | `585372c` `8a2f2ae` `55847d3` `f93f308` | `workflow-invariants.test.mjs`：写法子集门 + 25 个变异自检 |

全量 **1179/1179** 绿，`check:all` ok。

---

## 2. 🔴 这一轮**改掉了自己**的十处，都记下来

这些不是「优化」，是第一版**真的可以被绕过**。写在这里是因为它们共享同一个
形状：**用一个「看起来像什么」的信号，去决定要不要做检查。**

| 第一版怎么写的 | 为什么是个洞 |
|---|---|
| 扫描器按扩展名白名单选文件 | 载荷里的 `.sh` / `.py` / `.js` 一个都不扫 —— 而人要读的恰恰是那些 |
| 「含 NUL 就当二进制跳过」 | `NUL` + `U+202E` 放进 `.md`，整道门失效 |
| 「不是合法 UTF-8 就跳过」 | 同上，换一个非法字节就行 |
| `assertNoSymlinks` 不查根自己 | 整棵 `pr/artifacts` 是个链接时一路遍历过去 |
| Tier 只按投稿者声明的 capability 算 | 等于让被检的一方决定要几个人审他 |
| invariants 用正则读 YAML，没匹配到就当没问题 | `permissions: write-all`、引号 key、行尾注释全能绕 |
| 从 ArtifactId 正则解析出路径 | `.+` 把 `../../etc` 吃进 version，拼进 `join()` 就是穿越 |
| 资产扩展名 `.tar.gz`，workflow 却 glob `*.tgz` | **检查全过、分发全缺**，而 `if-no-files-found` 不响（npm 的 .tgz 在） |
| 阶段 C 排在签名与 `npm publish` 之后 | 失败时三样产物都已撤不回来 |
| `release-assets` 拿下载来的快照当摘要真值 | 快照与资产一起换成自洽的一套，复核照样绿 |

🔴 **两条教训，写在这里，不要再犯。**

**其一**：一道门要么检查**全部**输入，要么明确说出
「哪些没检查、为什么、谁来补」。「看起来是二进制/看起来正常」不是理由 ——
那个信号本身就在被检方的控制之下。

**其二**：**别拿被验的东西当判据。** 「按这张快照记的 sha256 去验这张快照带来的
资产」看着很像在验证，其实只证明了它自洽 —— 把两边一起换掉就全绿。
判据必须来自**另一处**：上一张快照、上一个 job 的输出、base 分支。
本轮这一条踩了三次（复算门、release-assets、阶段 C 的文件名绑定）。

⚠️ 还有一条是**关于测试自己的**：本轮我写了三处 `assert.ok(… || true)`
（永远为真的断言），一处在 `commands-install-pack`、两处在 `workflow-invariants`。
一道永远为真的断言比没有更糟 —— 它让人以为这件事被盯住了。
所以 `workflow-invariants.test.mjs` 末尾有一节**变异自检**：25 个「改一行就是洞」
的改动在测试里跑，每一个都必须让**指定的那一条**断言变红。
把「写完断言就去改坏它一次」从自觉变成机械动作。

---

## 3. 明确**没有**做到的

### 3.1 §9 只做了存储那一半

`login`（device flow）、`publish`（fork → 分支 → PR）、`logout`（撤销授权）
**都没写**。已做的是 token 存储（keychain 优先、文件 `0600`/`0700`）、
`npx github:` 拒绝、以及 Q4 要求的权限面披露文案。

⚠️ **这不影响投稿流水线本身**：fork + 手动开 PR 走的是**完全一样**的门。
`publish` 是省几下点击，不是唯一入口。

### 3.2 promotion 现在只收「已注册 namespace 下的 skill 续版本」

首次注册 namespace 要 `--claim-owner`、所有 pack 要 `--provenance-of`，
而这两份「PR 侧的事实」从投稿的哪儿来，规格没定。见 [R-19](../m2/01-residual-risks.md#r-19)。
🔴 **没有在 workflow 里编一个默认值** —— owner 与 provenance 是要签进快照的，
写错了事后改不动。

### 3.3 promotion PR 现在**跑不了任何门**

`promote.yml` 用 `GITHUB_TOKEN` 开 PR，而 GitHub 不为它触发 workflow，
PR 作者也会是 `github-actions[bot]` 而非 release bot。见
[R-20](../m2/01-residual-risks.md#r-20)。

⚠️ 现在被更前面的 fail-closed 挡着（`RELEASE_BOT_ID` 是占位、
`maintainers.json` 是空的），所以**跑不到**这一步。填上那两个之前，
这条不是活的洞；填上之后它立刻是。

### 3.4 Tier 的判据仍以声明为主

载荷下限只堵住**看得见的**可执行迹象。
「`SKILL.md` 正文让 agent 去 `bash helper.md`」这一类静态判据认不出来。
见 [R-21](../m2/01-residual-risks.md#r-21)，**待拍板**。

### 3.5 R-17 只闭合了一半

长期坏状态没了（回读比摘要 + 失败即回滚），**瞬时的两资产窗口还在**。
🔴 **打开 timestamp cron 之前必须先定它**。见 [R-17](../m2/01-residual-risks.md#r-17)。

### 3.6 workflow 全部**没有真跑过**

`validate-pr.yml` / `promote.yml` 里的判定逻辑都抽成了 `.mjs` 并有单测覆盖，
但 **YAML 本身、GitHub 的事件语义、token 权限**三样本机无从证明。
具体地：
- fork PR 上 `pull-requests: read` 能不能读到 `/pulls/<n>/reviews`（拿不到会
  fail-closed，是可用性问题不是安全问题）；
- `pull_request_review` 事件下 `github.event.pull_request.*` 各字段是否如预期；
- CODEOWNERS 指向一个不存在的团队时到底发生什么（我原先的判断被 Codex 纠正过，
  现在的说法是「先建团队再用真 PR 验一次」）。

---

## 4. 与 M0 字面表述的偏离（**待规格侧确认**）

| # | 偏离 | 理由 |
|---|---|---|
| D-1 | §4 的两个 workflow → **一个聚合 `pr-gate`** | 「两个中恰好一个通过、且必须是 router 判定的那个」在分支保护里配不出来；聚合门让误配在构造上不可能 |
| D-2 | §6 的「外部 URL」从拒绝降为**告警** | `SKILL.md` 里放参考链接极其常见；一道几乎总在报红的门两周内就会被关掉 |
| D-3 | 保留 namespace 用**归一化**匹配 | 精确匹配挡不住 `ge0ly` / `geo-ly` 这类 |
| D-4 | pack 在 Tier 门里**一律按 Tier 2** | 成员 capability 在别的制品里，这一步看不到；fail-safe |

---

## 5. 上线前的硬前置

1. 建 `@geoly-ai/maintainers`，填 `registry/maintainers.json`（现在是空的 → 审批门直接拒）；
2. 建 release bot，填 `RELEASE_BOT_ID`，替换 `promote.yml` 的 token（R-20）；
3. 定 R-19（claim-owner / pack provenance 从哪来）；
4. 定 R-17 剩下那一半，才能开 timestamp cron；
5. 按 `00-branch-protection.md` 配分支保护，并用**一张真 PR** 验一次 CODEOWNERS。

⚠️ 在 1–5 全部做完之前，仓库处于 fail-closed 状态。**这是有意的**，
不要为了「先跑通」把占位值填成看起来合法的东西。
