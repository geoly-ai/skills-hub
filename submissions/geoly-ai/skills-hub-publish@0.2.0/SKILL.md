---
name: skills-hub-publish
description: 把 skill 投稿进 geoly skills-hub —— 投稿目录长什么样、skill.json 怎么写、capability 怎么定、要过哪几道门、被拒了怎么改。当用户要发布/投稿一个 skill 到 hub、或者投稿 PR 被门拒掉需要排查时使用。
---

# 把 skill 投稿进 skills-hub

> 本文针对 `@geoly-ai/skills-hub@0.2.x` 的投稿流程。
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
├── PROMOTION.json    首次注册 namespace 时需要
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

## namespace 是永久的

进 artifact id，**发布之后改不了**。保留清单里的名字（`anthropic` / `claude` /
`openai` / `geoly` 等）普通投稿不能用。

⚠️ **别拿真实品牌当 namespace** —— 在公开 registry 里占住 `plaud` 这种名字会
像官方发布。用「做什么的」而不是「是谁」的名字。
