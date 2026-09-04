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

🔴 **`submitted_by_pr` 必须等于触发 promote 的那张 PR。** 而 PR 号只有开了 PR
才知道 —— 所以顺序是：**先开 PR → 拿到号 → 写进 skill.json → 强推同一分支**。
写错会被 `assertProvenanceMatchesPr` 直接拒（fail-closed，不静默改写）。

⚠️ **skill 不能靠「不写，让 promote 填」绕过这一圈** —— `build-inputs.mjs` 在
provenance 缺失时直接报「skill.json 必填它」。省掉回填只对 **pack** 与
**`PROMOTION.json`** 成立（那两处刻意**拒绝**投稿者声明 PR 事实）。
📌 同一件事在 skill 与 pack 上是**相反**的规则，这是本仓库最容易记反的一处。

### `PROMOTION.json`（首次注册 namespace 才需要）

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
`tree_digest`，而摘要由发布器计算、投稿者写的一律不读。所以是两阶段。

⚠️ 如果几个 skill 之间靠 `../<sibling>/…` 相对路径互相引用（prompt-map 那套
就是），**单独装其中一个会拿到一个引用不到兄弟的坏 skill** —— 这种情况 pack
不是锦上添花，是必需品。
