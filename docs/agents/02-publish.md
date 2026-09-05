# 发 skill 进来 —— agent 操作手册

> 权威定义在 [`docs/m0/06-submission.md`](../m0/06-submission.md) 与
> [`docs/m0/01-artifacts.md`](../m0/01-artifacts.md)。
> 这份文档讲**实际怎么做**，以及**哪些坑真的踩过**。

---

## 全流程一眼

```
你准备 submissions/<ns>/<name>@<version>/
        ↓ 开 PR（只动 submissions/**）
  validate-pr.yml：分流 → 结构门 / 字符扫描 / Tier 审批门
        ↓ 合并进 main
  promote.yml：重新验证四项 → 铺进 artifacts/ → 生成快照 → 开 promotion PR
        ↓ 合并 promotion PR
  release.yml（手动触发）：签名 + 时间戳 + 发 npm
```

🔴 **必须走 PR。** 直推 main 的话 promote 会 fail-closed ——
它要从 PR 上取审批归属、作者 node id、PR 号、创建时刻，直推一样都拿不到。
（审批豁免免的是"要几个人点头"，**不是"可以不走 PR"**。）

---

## 投稿目录长什么样

```
submissions/<namespace>/<name>@<version>/
├── SKILL.md          必需，YAML frontmatter 含 name、description
├── skill.json        必需，见下
├── PROMOTION.json    首次注册 namespace 时需要
└── …                 载荷
```

⚠️ 目录名是 **`<name>@<version>`**，不是 `<name>/<version>`。
"目录名本身就是投稿在声明它是什么，不该靠猜。"

### `skill.json`

```json
{
  "schema": "geoly.skills.skill/1",
  "kind": "skill",
  "namespace": "prompts-map",
  "name": "prompt-map-generator",
  "version": "0.7.0",
  "description": "…",
  "license": "MIT",
  "clients": ["claude", "cursor", "codex", "agents"],
  "capabilities": ["shell"],
  "replaces": [], "conflicts": [],
  "provenance": {
    "kind": "original",
    "author_github_id": "U_…",
    "submitted_by_pr": 42
  }
}
```

🔴 **没有 `digest` 字段，永远不会有。** 摘要由发布器计算，投稿者声明的一律不读。

### 🔴 `provenance` 现在**可以不写**（2026-09-05 起）

**最省事的做法：`skill.json` 里干脆不写 `provenance`**，由 promote 按 PR 事实填。

原因是它构成一个**时间循环**：`submitted_by_pr` 必须等于真实 PR 号，
而 PR 号只有开了 PR 才知道 —— 于是投稿者被要求在开 PR **之前**写进一个
开 PR 之后才存在的值。漏回填的投稿会**先进 main、再在 promote 卡死**。

⚠️ 它还与 `PROMOTION.json` **自相矛盾**：那边明确**拒绝**投稿者声明
`author_github_id` / `submitted_by_pr`，而这边曾要求他自己写同样两个字段。

**写了会怎样**：仍然逐字核对，写错就拒（`assertProvenanceMatchesPr`，
fail-closed、不静默改写）。那时顺序仍是「先开 PR → 拿号 → 回填 → 强推同一分支」。

🔴 **例外：`vendored` 必须自己声明。**「这是搬来的、上游在哪、license 凭什么」
只有你知道，promote 无从得知 —— 缺省只会填 `original`。
把一次搬运记成原创，是出处记录里最不该错的一格。

✅ **skill 也可以靠「不写，让 promote 填」省掉这一圈**（2026-09-05 起，commit `8b9741c`）。
`build-inputs.mjs` 在 skill 的 provenance 缺失时会自己填
`{kind:'original', author_github_id: <PR 作者>, submitted_by_pr: <PR 号>}` 并打一行提示。

📌 **本段此前写的是相反的话**（「skill 不能靠不写绕过、缺了直接报必填」）——
那是 `8b9741c` 之前的规则，2026-09-05 已作废。留这条记录是因为
`skills-hub publish` 会直接引用本节，而一份说反了的操作手册比没有手册更坏。

⚠️ 仍然**相反**的只剩一格：**pack** 的 provenance 缺了会被拒
（`pack.json` 的键集里没有这个字段，只能由 `PROMOTION.json` 的 `--provenance-of` 给）。

### `PROMOTION.json`（首次注册 namespace **或任何 pack**）

🔴 **每一个 pack 都要它，不只是首次注册 namespace。**
`pack.json` 的键集里**没有** `provenance`（03-packs §2），所以 pack 的出处
只能由投稿声明 —— 缺了会被结构门当场拒：
「pack 必须有 PROMOTION.json」。
⚠️ 本节标题此前写的是「首次注册 namespace 才需要」，**对 pack 是错的**
（2026-09-04 发 `pack:plaud-theme/plaud-theme-matrix` 时被门拒了才发现）。

```json
{
  "schema": "geoly.skills.promotion-file/1",
  "claim_owner": { "kind": "org", "login": "geoly-ai" }
}
```

⚠️ **只写"只有你知道的事"。** `owner.id` / `author_github_id` / `submitted_by_pr`
由 promote 填 —— 投稿者写了会被**拒绝**，不是被覆盖。
（skill 的 `provenance` 在 `skill.json` 里，**不要**在这里重复声明。）

---

## capability 怎么填

🔴 **capability 描述的是「这个 skill 会让 agent 做什么」，不是「它自己带了什么文件」。**

这一条踩过：最初按"载荷里有没有可执行文件"判，于是一堆 SKILL.md 里明确写着
`python3 …` 的 skill 被标成了 `external-tool` —— 那会让客户端在运行时按**更低**
的权限放行它，等于把风险瞒给使用者。

| capability | Tier | 什么时候用 |
|---|:--:|---|
| `none` | 0 | 纯文档，不让 agent 做任何外部动作 |
| `network` / `external-tool` | 1 | 联网、调外部工具 |
| `shell` / `credentials` / `writes-repo` | 2 | 跑命令、碰凭据、写仓库 |

⚠️ **认不出来的 capability 一律按最高档**，不是忽略。拼错 `network` 写成
`nework` 会被判 Tier 2，而不是悄悄降成 Tier 0。

⚠️ **声明压不住载荷**：载荷里有可执行迹象（可执行位 / `.sh` `.py` `.ps1` /
shebang），Tier 自动升到 2，不管你声明了什么。

---

## 审批要几个人

| Tier | 需要 |
|:--:|---|
| 0 / 1 | 1 名维护者 approve |
| 2 | **2 名不同的**维护者 approve |

作者本人的 approve **计入**（`EXCLUDE_AUTHOR = false`）。
另有一份审批豁免名单（`scripts/submission/approval-policy.mjs`），名单上的人
自己投的稿**跳过审批人数门**。

🔴 **豁免只跳过"要几个人点头"**：结构门、字符扫描、路径白名单、版本号占用、
确定性复算 —— 一条都照跑。放行时会在 stderr 大声打一行，因为
**一次静默的豁免和一道坏掉的门，事后看起来一模一样**。

---

## 本地先跑一遍门（强烈建议）

```sh
node scripts/submission/run-gates.mjs --submissions submissions --reserved registry/reserved.json
node scripts/submission/scan-text.mjs --submissions submissions
```

省掉一整轮 CI 往返。下面这些是**真的被抓到过**的：

| 症状 | 原因 | 怎么办 |
|---|---|---|
| `E_PATH_LEADING: .DS_Store` | macOS 目录元数据混进源仓库 | 删掉，并给源仓库加 `.gitignore` |
| `空目录不可表示` | 删掉 `.DS_Store` 后目录空了 | 删目录。空目录不进树摘要也不进归档，留着会让制品与源目录不是同一棵树 |
| `E_PATH_CHARSET` 非 ASCII 文件名 | 中文/emoji 文件名 | **改成 ASCII**，见下 |
| `有 U+200B / U+FEFF` | 正文里的零宽字符 | 见下 |
| `PROMOTION.json.schema 应为…` | schema 串写错 | 报错里给了正确值 |

### 为什么文件名必须 ASCII

不是洁癖：**macOS 把中文文件名存成 NFD、Linux 存成 NFC**，同一个文件在两台
机器上算出的**树摘要不一样** —— 那会直接打断「快照必须能被字节一致地复算
出来」，而签名与时间戳的信任链就建在它上面。

📌 改名时**同时写清对应关系**（比如在 README 加一张映射表）。只改名不说明
就是纯损失。

### 零宽字符

`scan-text` 把两类分开：

- **拒绝**：`U+200B`（ZWSP）、`U+FEFF`（BOM）、bidi 控制符 —— 它们能让
  **人读到的与 agent 读到的不是同一段文字**
- **告警（人看一眼）**：`①②③`、`z²` 这类 —— NFKC 折叠后会变形，但是正常排版

⚠️ 踩过一次**合法**用法被拒：文档里一段正则 `.replace(/…/g," ")` 要匹配的
**正是** NBSP/ZWSP/BOM，字面量写在了正则里。改成 `\u00A0|\u200B|\uFEFF`
转义写法 —— 语义完全一致，而且**读的人才看得见它匹配什么**。
正则里放字面不可见字符本来就是坏写法。

---

## namespace 是永久的

namespace 进 artifact id，**发布之后改不了**（换 owner 要走 §7 转让流程，
那改的是归属不是名字）。

- 保留清单（`registry/reserved.json`）里的名字**普通投稿不能用**：
  `anthropic` / `claude` / `openai` / `geoly` 等
- ⚠️ **别拿真实品牌当 namespace**：在公开 registry 里占住 `plaud` 这种名字
  会像官方发布。用 `plaud-theme` 这类"做什么的"而不是"是谁"的名字

---

## pack（矩阵包）

pack 把多个 skill 绑成一个可整体安装的单元。

🔴 **pack 只能等成员先发出去之后再发**：`pack.json` 的 `members` 要填每个成员的
`tree_digest`，而摘要由发布器计算、投稿者写的一律不读。所以是两阶段 ——
成员和 pack **不能同一批投**。

### 投稿目录

```
submissions/<ns>/<pack-name>@<version>/
├── pack.json         必需
└── PROMOTION.json    🔴 **必需**（不是「首次注册才要」，见上）
```

### `pack.json`

键集是**封闭**的（多一个少一个都拒）：`schema` `kind` `namespace` `name`
`version` `description` `license` `members` `bundled` `conflicts`
`contract_paths` `compatibility`。

· `members[]` 只允许 `role: "matrix"`；`bundled[]` 只允许 `role: "tool"`
· 每个成员要 `id` / `tree_digest` / `role`（`order` 可选）
· `tree_digest` 从**已发布快照**里取那条记录的真值，不要自己算

```sh
# 从当前快照取成员摘要（照抄，别手敲）
node -e '
  const s=require("./registry/snapshots/hub-<N>.json");
  const r=s.artifacts.find(a=>a.id==="skill:<ns>/<name>@<ver>");
  console.log(r.tree_digest);'
```

### 这个 `PROMOTION.json` 该写什么

```json
{
  "provenance": { "kind": "original" },
  "schema": "geoly.skills.promotion-file/1"
}
```

🔴 **就这么点。** `owner.id` / `author_github_id` / `submitted_by_pr`
**一律由 promote 填** —— 投稿者写了会被**直接拒**（不是忽略）：
写它们等于自称是谁。

✅ **这与 `skill.json` 现在是同一条规则了**（2026-09-05 起，commit `8b9741c`）：
skill 的 `provenance` 也是**可选**的，缺省同样由 promote 按 PR 事实填。
两边都不必开 PR 拿号再回填。

⚠️ 仍然不同的只有一格：**pack 缺了 provenance 会被拒**（`pack.json` 的键集里
没有这个字段，只能由这份 `PROMOTION.json` 给），而 skill 缺了会被自动补上。

📌 本段此前写的是「skill 必须自己写 `submitted_by_pr` 并在开 PR 后回填」——
那是 `8b9741c` 之前的规则，已作废。`skills-hub publish` 会引用本文件，
一份说反了的操作手册比没有手册更坏。

### 发之前自己验一遍（结构门只查形状）

```sh
node --no-warnings scripts/submission/run-gates.mjs      # 结构门
node -e '
  const {validatePackManifest}=await import("./src/pack.mjs");
  validatePackManifest(require("./submissions/<ns>/<name>@<ver>/pack.json"));'
```
再自己核一遍：**每个成员都在目标快照里**、`tree_digest` 逐个一致、
成员 `status` 全是 `published`（有 `yanked` / `degraded` 会把整个 pack 拖下水）。

⚠️ 如果几个 skill 之间靠 `../<sibling>/…` 相对路径互相引用（prompt-map 那套
就是），**单独装其中一个会拿到一个引用不到兄弟的坏 skill** —— 这种情况 pack
不是锦上添花，是必需品。
