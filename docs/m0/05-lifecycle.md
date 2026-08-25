# M0 · 命名、所有权、冲突、撤回

## 1. 命名空间

ArtifactId 里的 `namespace` 是**所有权单位**。

- 一个 namespace 绑定一个 GitHub 身份（user 或 org），记 `login` **与不可变的 node id**。
  只记 login 会在改名 / 账号被删后重注册时把所有权交给陌生人。
- 首次发布某 namespace 下的第一个制品时建立绑定，写进 `registry/owners.json`（也进快照）。
- 之后该 namespace 下的投稿，PR 作者必须匹配绑定身份，否则需 owner 在 PR 里明确同意。

### 1.1 保留名

以下 namespace 只能由 hub 维护者使用：
`geoly`、`hub`、`official`、`skills`、`registry`、`anthropic`、`claude`、`cursor`、`codex`、`openai`、
`github`、`npm`、`system`、`admin`、`security`、`test`、`example`、`local`。

保留名清单在 `registry/reserved.json`，改它需要维护者 PR。

### 1.2 不做 typosquatting 的自动判定

编辑距离阈值会同时误伤（`plaud-theme-qa` vs `plaud-theme-qa-intake` 是合法的近名）
和漏放（同形 Unicode）。做法：

- **硬拒**：name 归一化（NFKC + 去连字符 + 小写）后与已有 name 相同 → 拒绝，除非同 owner。
- **软标**：编辑距离 ≤ 2 的近名进 PR 的审查清单，由人判断。这是排优先级，不是安全门。

## 2. 名字冲突 ≠ 语义冲突

唯一性规则以 [`01-artifacts.md`](01-artifacts.md) §3 为准，一句话复述：
**`name` 只在同一个 namespace 内唯一；跨 namespace 允许同名，但在同一个 target 上是硬冲突。**
（v1 在这里写「全局唯一（在 namespace 内）」，与 01 自相矛盾，已消除。）

即使名字不撞，两个 skill 也可以有几乎一样的 `description`，从而在 agent 的路由判定里互抢。
这个问题**没有自动解**。

M0 只定两条：

1. 制品可以声明 `conflicts`，安装时命中即阻断（见 [`04-install.md`](04-install.md) §4.2）。
2. 审查清单里必须有一项：**「这个 description 会不会抢已有 skill 的路由？」**
   由人回答，理由写进 PR。

## 3. `replaces` 与 `conflicts`

```json
"replaces":  ["skill:geoly/plaud-shopify-theme"],
"conflicts": ["skill:*/plaud-shopify-theme"]
```

| 字段 | 含义 | 安装行为 |
|---|---|---|
| `replaces` | 本制品是那个东西的后继 | 若 target 上存在且**归 hub 所有** → 同一事务里以 `retire-only` 项退役（[`04-install.md`](04-install.md) §5.3），并在结果里说明 |
| `conflicts` | 两者不能共存 | 阻断，要求 `--replace <name>` 点名 |

`replaces` 只对**账本认领的**目录自动生效。未被认领的同名目录永远走 [`04-install.md`](04-install.md) §4.2 的阻断路径——
自动删掉一个来路不明的目录，是先例最不该被泛化的一条。

## 4. 状态机

```
                 ┌──────────┐
   npx publish → │ submitted│
                 └────┬─────┘
                      │ 结构门通过
                 ┌────▼─────┐        改动 →  回到 submitted
                 │ in_review│───────────────┐
                 └────┬─────┘               │
          维护者 approve │        rejected ◄─┘（终止态）
                 ┌────▼─────┐
                 │ approved │  merge 进 submissions/
                 └────┬─────┘
      promotion PR 合并 │
                 ┌────▼─────┐
                 │published │  ← 进快照，可安装
                 └──┬────┬──┘
        deprecate │      │ yank
           ┌──────▼─┐  ┌─▼──────┐
           │deprecat│  │ yanked │
           │  ed    │  └────────┘
           └────────┘
```

- `submitted` / `in_review` / `approved` / `rejected` **都不进快照**，因此**装不到**。
- `deprecated`：仍可安装，解析时告警，`latest` 仍可指向它（若无后继）。
- `yanked`：**阻断新装与更新**；已装的仍能 `check`、`rollback`、取证。
  `--allow-yanked` 仅用于事故调查，必须大声告警并写进账本条目。

🔴 **yank 不删文件。** 制品目录与快照都留着——否则事故之后没有任何东西可以取证，
且已装用户的 `check` 会全部变成「找不到期望值」。

## 5. yank 的执行

维护者 PR：往新快照的 `yanked[]` 追加一条（含 `reason`、可选 `advisory`、可选 `superseded_by`），
并把该制品 `status` 改为 `yanked`。

⚠️ 这是**唯一**一处允许「新快照里同一 ArtifactId 的 status 与旧快照不同」的情形。
制品的**内容**仍然不可变（[`01-artifacts.md`](01-artifacts.md) §1、§7），变的只是快照里的状态记录。

安全公告编号 `GSA-<年>-<四位序号>`，正文放 `advisories/GSA-….md`。

### 5.1 pack 的连带影响

yank 一个 skill **不会**自动 yank 引用它的 pack（pack 不可变，改不了锁定的成员）。
受影响的 pack 在下一张快照里被重算为 `degraded`，不可新装。
完整规则见 [`03-packs.md`](03-packs.md) §5。

## 6. 出处（provenance）

任何**从外部搬进来的**制品（1C 的 matrix 迁移就是第一批）必须带：

```json
"provenance": {
  "kind": "vendored",
  "origin_repo": "https://github.com/chovizzz/plaud-theme-matrix",
  "origin_ref": "v0.3.6",
  "origin_commit": "0aa7711707bcc3a7856a558e6cb9ca28b79555bf",
  "origin_subpath": "plaud-theme-dev",
  "origin_tree_digest": "sha256:…",
  "license_evidence": "LICENSE @ origin_commit",
  "imported_at": "2026-08-24T…Z",
  "imported_by_pr": 3
}
```

原生投稿则是 `{"kind": "original", "author_github_id": "…", "submitted_by_pr": 118}`。

`provenance` 参与快照、被签名覆盖。
🔴 `origin_commit` 必须是 **40 位 commit SHA，不能只记 tag** —— tag 可以被移动，
这正是「审核后换内容」的攻击路径。

### 6.1 🔴 双摘要：`origin_tree_digest` ≠ `tree_digest`

vendored 制品在导入时**必然要新增 `skill.json`**（hub 的强制要求），
因此它的 `tree_digest` 与上游 tag 的树摘要**不可能相等**。

v1 承诺「任何人算出的上游摘要应与 hub 快照里的 `tree_digest` 一致」——**那是错的**。

v2 分开记两个值：

| 字段 | 覆盖范围 | 用途 |
|---|---|---|
| `provenance.origin_tree_digest` | 上游 `origin_commit` 下 `origin_subpath` 的**原始**文件集合 | 证明「导入的内容确实来自那个 commit」 |
| `tree_digest`（制品级） | hub 包装后的全部文件（原始文件 + 新增的 `skill.json`） | 安装时的完整性判定 |

CI 门 `scripts/verify-vendored.mjs` 校验的是：
hub 制品的载荷**去掉 `skill.json` 之后**，逐字节等于上游那棵树，且其摘要 == `origin_tree_digest`。
`provenance` 里必须同时列出 `added_files: ["skill.json"]` —— 允许新增的文件是白名单，
不在白名单里的新增 / 任何修改 / 任何删除，都让这道门失败。

## 7. 所有权转让与失联

- **转让**：现 owner 与新 owner 都在同一张 PR 里签字（各自评论确认），维护者合并。
- **失联**（账号删除 / 长期无响应且有安全问题）：维护者可以接管 namespace，
  但**只能发新版本，不能改已发布制品的字节**（受 §01-6 约束）。
  接管必须留公开记录 `advisories/` 或 `registry/owners.json` 的变更历史。

## 8. 保留期

- 制品与快照：**永久保留**。
- release 资产：永久（GitHub 侧）；若丢失，git 树是回退通道（[`02-registry.md`](02-registry.md) §3）。
- `attic`（本机被替换的旧目录）：默认保留 3 代，`--keep-generations N` 可调。
