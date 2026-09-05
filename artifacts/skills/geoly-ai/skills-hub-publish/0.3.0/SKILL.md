---
name: skills-hub-publish
description: 把 skill 或 pack（矩阵包）投稿进 geoly skills-hub —— 投稿目录长什么样、skill.json / pack.json 怎么写、PROMOTION.json 什么时候要、capability 怎么定、要过哪几道门、被拒了怎么改。当用户要发布/投稿一个 skill 或一整套矩阵到 hub、或者投稿 PR 被门拒掉需要排查时使用。
---

# 把 skill 投稿进 skills-hub

> 本文针对 `@geoly-ai/skills-hub@0.3.x` 的投稿流程。
> ⚠️ 细则在 `references/`，**需要时才读** —— 正文只讲主干。

## 全流程

```
准备 submissions/<ns>/<name>@<version>/
      ↓ 开 PR（只动 submissions/**）
分流 → 结构门 / 不可见字符扫描 / Tier 审批门
      ↓ 合并进 main
promote：重新验证 → 铺进 artifacts/ → 生成快照 → 开 promotion PR
      ↓ 合并
制品进 registry，可被 install
```

🔴 **必须走 PR。** 直推 main 的话 promote 会 fail-closed —— 它要从 PR 上取
审批归属、作者 id、PR 号、创建时刻，直推一样都拿不到。

## 目录形状

```
submissions/<namespace>/<name>@<version>/
├── SKILL.md          必需，frontmatter 含 name、description
├── skill.json        必需
├── PROMOTION.json    首次注册 namespace 时需要（**pack 则每次都要**，见下）
└── …                 载荷
```

⚠️ 目录名是 **`<name>@<version>`**，不是 `<name>/<version>`。

### `skill.json`

```json
{
  "schema": "geoly.skills.skill/1",
  "kind": "skill",
  "namespace": "…", "name": "…", "version": "0.1.0",
  "description": "…",
  "license": "MIT",
  "clients": ["claude", "cursor", "codex", "agents"],
  "capabilities": ["shell"],
  "replaces": [], "conflicts": [],
  "provenance": { "kind": "original", "author_github_id": "U_…", "submitted_by_pr": 42 }
}
```

🔴 **没有 `digest` 字段，永远不会有** —— 摘要由发布器算，投稿者写的一律不读。

🔴 **`submitted_by_pr` 必须等于触发 promote 的那张 PR**，而 PR 号只有开了 PR
才知道 → 顺序是：**先开 PR → 拿到号 → 写进 skill.json → 强推同一分支**。
写错会被直接拒（fail-closed，不静默改写）。

### frontmatter 只认单行 `key: value`

🔴 **不支持 YAML 折叠标量 `>` / `|`**，也不支持锚点、别名 —— 那些能让同一份
文本解出不同结构。多行描述要折成一行（`>` 的语义本来就是「换行折成空格」，
折成单行**不改变解析后的值**）。

## capability 怎么填

🔴 **capability 描述的是「这个 skill 会让 agent 做什么」，不是「它自己带了
什么文件」。** 一份纯 markdown 的 skill，只要正文里写着 `python3 x.py`，
它就是 `shell`。声明成 `external-tool` 会让客户端按**更低**的权限放行它 ——
那是把风险瞒给使用者。

| capability | Tier | |
|---|:--:|---|
| `none` | 0 | 纯文档，不让 agent 做任何外部动作 |
| `network` / `external-tool` | 1 | 联网、调外部工具 |
| `shell` / `credentials` / `writes-repo` | 2 | 跑命令、碰凭据、写仓库 |

⚠️ **认不出来的 capability 一律按最高档**（拼错 `network` 写成 `nework` → Tier 2）。
⚠️ **声明压不住载荷**：载荷里有可执行迹象（可执行位 / `.sh` `.py` `.ps1` /
shebang），Tier 自动升到 2。

审批：Tier 0/1 要 1 名维护者 approve，**Tier 2 要 2 名不同的**。

## 本地先跑一遍门

在 hub 仓库里：

```sh
node scripts/submission/run-gates.mjs --submissions submissions --reserved registry/reserved.json
node scripts/submission/scan-text.mjs --submissions submissions
```

省掉一整轮 CI 往返。常见拒绝与改法见 `references/rejections.md`。

## 发一整套矩阵：pack

pack 把多个 skill 绑成**可整体安装**的一个单元，用户一条命令装完：

```sh
skills-hub install pack:<ns>/<name> --clients claude
```

🔴 **什么时候 pack 不是锦上添花、而是必需品**：矩阵内的 skill 之间有契约依赖
（互相引用 `../<sibling>/…`，或「开工前必须先读契约层」这类要求）时，
**单独装其中一个会得到一个读不到契约的 skill —— 它不会报错，
只会在该停机的地方继续往下走**。pack 把「必须并排安装」从口头约定
变成安装器保证。

### 🔴 两阶段：成员先发，pack 后发

`pack.json` 的 `members[].tree_digest` 要填**已发布快照里的真值**，
而摘要由发布器计算、投稿者写的一律不读。
**所以成员和 pack 不能同一批投** —— 先把成员发出去、拿到快照，再发 pack。

```sh
node -e '
  const s=require("./registry/snapshots/hub-<N>.json");
  console.log(s.artifacts.find(a=>a.id==="skill:<ns>/<name>@<ver>").tree_digest);'
```

### 投稿目录

```
submissions/<ns>/<pack-name>@<version>/
├── pack.json         必需
└── PROMOTION.json    🔴 **必需** —— 不是「首次注册才要」
```

### `pack.json`

键集**封闭**（多一个少一个都拒）：`schema` `kind` `namespace` `name`
`version` `description` `license` `members` `bundled` `conflicts`
`contract_paths` `compatibility`。

· `members[]` 只允许 `role: "matrix"`，`bundled[]` 只允许 `role: "tool"`
· 成员要 `id` / `tree_digest` / `role`，`order` 可选
· `contract_paths` 指向「改了就等于改整套对接语义」的文件
· `compatibility` 要 `previous` / `kind` / `breaking_reasons` 三项

### 🔴 pack 的 `PROMOTION.json` 与 skill **规则相反**

```json
{
  "provenance": { "kind": "original" },
  "schema": "geoly.skills.promotion-file/1"
}
```

**就这么点。** `owner.id` / `author_github_id` / `submitted_by_pr`
**一律由 promote 填** —— 投稿者写了会被**直接拒**（不是忽略）：
写它们等于自称是谁。

| | provenance |
|---|---|
| `skill.json` | **必填**，`submitted_by_pr` 必须等于真实 PR：先开 PR 拿号 → 回填 → 强推同一分支 |
| pack 的 `PROMOTION.json` | **拒绝**你声明 PR 事实 |

⚠️ **这是本流程最容易记反的一处。** 照 skill 的做法给 pack 写
`submitted_by_pr` 会被拒；反过来给 skill 省掉它，也会被拒（`skill.json 必填它`）。

### 发之前自己验（结构门只查形状）

```sh
node --no-warnings scripts/submission/run-gates.mjs
```
再自己核：**每个成员都在目标快照里**、`tree_digest` 逐个一致、
成员 `status` 全是 `published` —— 有 `yanked` / `degraded` 会把整个 pack 拖下水。

## namespace 是永久的

进 artifact id，**发布之后改不了**。保留清单里的名字（`anthropic` / `claude` /
`openai` / `geoly` 等）普通投稿不能用。

⚠️ **别拿真实品牌当 namespace** —— 在公开 registry 里占住 `plaud` 这种名字会
像官方发布。用「做什么的」而不是「是谁」的名字。
