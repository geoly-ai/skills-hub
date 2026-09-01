# M3 决策记录（2026-08-31 用户拍板：**全部按推荐**）

> 台账原件：投稿链决策台账（Artifact）。这里是落到仓库里的那一份，
> 防止「下一轮又被当成待办提出来」。
>
> 🔴 每条都写**当时的理由**与**代价**。一条不知道为什么这么定的决定，
> 下次有人嫌它碍事就改了。

---

## 第一梯队

| # | 决定 | 取 | 落到哪 |
|---|---|---|---|
| ① | release bot | **GitHub App** | 要你在 GitHub 侧建；见下面「等你的三件事」 |
| ② | `claim-owner` / pack `provenance` 从哪来 | **投稿目录里放 `PROMOTION.json`** | 已实现，见 §2 |
| ③ | R-17 剩下那一半 | **单资产：bundle 内联进 `timestamp.json`** | 已实现，见 §3 |
| ④ | 维护者团队与名单 | **现在就建、填真 node id** | 要你在 GitHub 侧建；见下面 |
| ⑤ | 27 个 commit 推不推 | **推** | ✅ 已推（`f30eeeb..2aa412b`） |

## 第二梯队

| # | 决定 | 取 | 状态 |
|---|---|---|---|
| ⑥ | Tier 信任模型 | **维持 §7 的声明驱动 + 载荷下限** | 现状即是。⚠️ 虚报 Tier 这条路仍开着，只靠 §8 人工门第 1、3、7 条挡 —— **不要因为「现在有自动门了」就把人工门读松**（R-21 保留在案，不再是待办） |
| ⑦ | D-1 单一 `pr-gate` 代替两个 workflow | **接受偏离** | 已实现 |
| ⑧ | D-2 外部 URL 降为告警 | **接受** | 已实现 |
| ⑨ | D-3 保留 namespace 归一化匹配 | **接受** | 已实现 |
| ⑩ | D-4 pack 在 Tier 门里一律 Tier 2 | **接受**（fail-safe） | 已实现 |
| ⑪ | §9 `login` / `publish` | **先不做** | fork + 手动开 PR 走**完全一样**的门；`publish` 是省事，不是唯一入口 |

---

## 🔴 等你的三件事（代码做不到的）

按 `00-branch-protection.md` 的上线顺序：

1. **建 `@geoly-ai/maintainers` 团队**，把人加进去，把他们的**不可变 node id**
   给我 → 我填进 `registry/maintainers.json` 并把 `state` 改成 `active`。
   ⚠️ 至少两个人：Tier 2 要两名**且排除投稿者本人**，一个人永远满足不了。
   拿 id：`gh api users/<login> --jq .node_id`
2. **建 release bot 的 GitHub App**，装到本仓库，把它的 **node id** 给我
   → 我填进两个 workflow 的 `RELEASE_BOT_ID`；
   再把 App id + 私钥放进仓库 secret → 我改 `promote.yml` 用它换 installation token。
   🔴 **顺序不能反**：id 没填之前不要让 bot 去开 PR ——
   那些 PR 会被 router 判成 submission，而那条路径只检 `submissions/**`，
   对 `artifacts/**` 与 `registry/**` 的改动一个字都不看。
3. **配分支保护**（`00-branch-protection.md` §1、§2），并用**一张真 PR**
   验一次 CODEOWNERS 确实生效 —— 那一条我只能推断，不能证明。

在 1–3 做完之前，仓库仍是 fail-closed：`maintainers.json` 是 `bootstrap`
且名单为空 → 审批门直接拒 → promote 跑不起来。**这是有意的。**
