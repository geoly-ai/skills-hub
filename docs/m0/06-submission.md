# M0 · 投稿、审核、三阶段发布

## 1. 全链

```
本地                    投稿者 fork              geoly-ai/skills-hub
────                    ──────────               ───────────────────
npx … publish
 ├ 本地结构校验
 ├ login（device flow）
 ├ fork（若无）      →  submit/<ns>/<name>@<ver>
 └ 开 PR                                     →  【投稿 PR】只动 submissions/**
                                                     │
                          validate-submission.yml（pull_request，无 secrets，只读 token）
                                                     │ 结构门
                                                     ▼
                                        人工审（CODEOWNERS，push 即 dismiss stale）
                                                     │ merge
                                                     ▼
                          promote.yml（受信任构建，只读已合并的 main，产出 PR）
                            ├ submissions/… → artifacts/…/<version>/
                            ├ 算树摘要
                            ├ 用 canonical 格式打包资产并算 sha256
                            ├ 重算全部 pack 的 clients/capabilities/degraded
                            └ 生成 hub-<N+1>.json（--created-at 固定值）
                                                     │
                                       【promotion PR】改 artifacts/** + registry/**
                                                     │
                          validate-promotion.yml（确定性复算 + 不可变性 + 绑定门）
                                                     │ 维护者再审、再 merge
                                                     ▼
                          release.yml（OIDC，身份 A）
                            ├ 用同一脚本重建资产，断言字节与 PR 里记录的 sha256 一致
                            ├ Sigstore 签 hub-<N+1>.json
                            ├ 生成并签 attestation（绑定快照 sha256 ↔ source commit）
                            ├ 建 Release hub-v<N+1>，挂全部资产 + bundle
                            └ cli/ 变了则 npm publish --provenance
                                                     │ 触发
                          timestamp.yml（OIDC，身份 B —— 与 A 不同）
                            └ 生成并签 timestamp.json，**更新滚动 release `timestamp` 的资产**
                               🔴 不 commit 进仓库（分支保护禁直推，v2 那样跑不起来）
```

## 2. 🔴 三阶段，且签名对象里没有 commit SHA

v1 把「本快照对应的 commit」写进快照，而快照本身参与那个 commit 的 hash 计算 ——
**不可构造**。同时 bundle 要由合并后的 release.yml 签出，却要求与快照一起 commit；
`created_at` 又说由 release 注入。三件事都在 merge 之后，写不进已审已合并的快照。

v2 的三阶段：

| 阶段 | 产出 | 何时定 |
|---|---|---|
| **A · promotion 构建** | 制品文件、资产字节 + sha256、快照 JSON（含 `created_at`） | promotion PR 里，**全部可被人复算** |
| **B · 人工审 + merge** | 上面这些进 main | 维护者 |
| **C · release** | Sigstore bundle、attestation、GitHub Release | merge 之后（身份 A） |
| **D · timestamp** | timestamp.json + bundle，作为滚动 release 资产 | 阶段 C 之后 + 每 3 天 cron（身份 B） |

关键：**快照的内容在阶段 A 就完全确定**，阶段 C 只是给它签名并分发。
签名 bundle **作为 release 资产**分发（归档副本走普通 PR，见 §5），
**不需要**写回快照文件本身，也**没有任何 bot 直推**。

**快照自己的** release commit SHA 从中删掉（[`02-registry.md`](02-registry.md) §2.1）——
它会自引用。指向别处的 commit（`review.head_sha`、`provenance.origin_commit`、
attestation 的 `sourceCommit`）都保留。git 坐标一律是定位提示，不是信任输入。

## 3. promote 不是自动发布

`promote.yml` **只产出一张 promotion PR，不直接写 main**。

promote 时必须**重新验证**（不能只信「已 merge」这个事实）：

1. 被合并的投稿 PR 的 head SHA 与 approve 时的 SHA 一致（approval 未失效）；
2. 该 PR 的变更路径只有 `submissions/**`；
3. 载荷重跑一遍全部结构门；
4. 版本号在该 `<ns>/<name>` 下从未被使用过（含已 yank）。

## 4. 🔴 两个验证入口（消除 v1 的自相矛盾）

v1 规定「投稿 PR 只许改 `submissions/**` 且 CI 硬拒」，
又规定「main 的 PR 都必须通过 `validate.yml`」——
而 promotion PR 必然改 `artifacts/**` 和 `registry/**`，永远过不了。

v2 拆成两个 workflow，由一个 router job 按 PR 来源选择必需的 check：

| workflow | 适用 | 允许路径 | 权限 |
|---|---|---|---|
| `validate-submission.yml` | 一切非 release-bot 分支的 PR | 仅 `submissions/**`（org 成员改基础设施时走单独的 `maintainer` 标签路径） | `contents: read`，**无 secrets** |
| `validate-promotion.yml` | **仅** head 分支形如 `promotion/hub-<N>` 且作者为 release bot 的 PR | `artifacts/**`、`registry/**`、`advisories/**` | `contents: read`，无 secrets |

`validate-promotion.yml` 独有的检查：

- **确定性复算**：用 PR 里记录的 `--created-at` 重跑 `build-snapshot.mjs`，断言字节一致；
- 重跑 `pack-artifact.mjs`，断言每个资产 sha256 与快照记录一致；
- 不可变性（[`01-artifacts.md`](01-artifacts.md) §7）；
- manifest ↔ ArtifactId 六项（skill 七项）绑定（§01-5.3）；
- pack 的 `clients` 交集 / `capabilities` 并集 / `degraded` 重算结果一致。

🔴 分支保护要求「两个 workflow 中**恰好一个**通过，且 router 判定的那个必须是它」——
不能配成「任一通过即可」，否则投稿 PR 可以伪装成 promotion 分支绕过路径白名单。
router 的判定依据是 **PR 作者身份 + 分支名**，不是 PR 标题或标签（那些投稿者可控）。

## 5. workflow 权限边界

🔴 **禁止 `pull_request_target`。** 不给任何能 checkout fork head 的 job 任何 secret 或可写 token。
结构门全部是对**文件**的检查，**不执行载荷**。

🔴 投稿 PR 不得修改 `.github/**`、`artifacts/**`、`registry/**`、`cli/**`、`scripts/**`、`docs/**`。
CI 硬拒 + CODEOWNERS 覆盖。改这些路径的 PR 必须来自 org 成员。

`promote.yml`：`push` to main（路径 `submissions/**`），`contents: write` + `pull-requests: write`，
**只读已合并到 main 的内容**，绝不 checkout fork。

`release.yml`（身份 A）：`id-token: write`（OIDC）、`contents: write`。

`timestamp.yml`（**身份 B，与 A 不同**）：`id-token: write`、`contents: write` 但
**仅限更新滚动 release `timestamp` 的资产**，不碰仓库内容、不打新 tag ——
因此 cron 重签**不会触发发布循环**。

🔴 分开两个身份的理由：timestamp 签名者拥有「指向哪张已签快照」的高权限，
与「决定快照内容」是两种不同的权力，不该共用一个可被同一次接管拿下的身份。
CLI 分别固定两个 identity，用错身份签出来的对象一律拒绝（[`02-registry.md`](02-registry.md) §8）。

🔴 **归档一律走普通 PR**（`registry/timestamp-archive/`、`registry/signatures/`），
由 `timestamp.yml` / `release.yml` 开 PR、走正常审批 —— **没有任何 bot 事后直推**
（分支保护禁直推，含管理员）。归档失败不影响分发，因为分发通道是 release 资产。

## 6. 结构门（自动）

| 门 | 内容 |
|---|---|
| 路径白名单 | 见 §4 |
| schema | `skill.json` / `pack.json` 通过 JSON Schema，**拒绝重复 key** |
| **六项（skill 七项）绑定** | 路径 / kind / namespace / name / version 与 manifest、snapshot record 全等（§01-5.3） |
| semver | 合法、未占用、**无 `+build`** |
| namespace 所有权 | 与 `registry/owners.json` 一致，或首次注册 |
| 保留名 | 不在 `reserved.json` |
| 归一化重名 | NFKC + 小写 + 去连字符后不与**同 namespace 内**已有 name 撞 |
| 路径 grammar | §01-4 全部规则 |
| 载荷规则 | 文件类型、mode、上限、**归档无 xattr/ACL/PAX 扩展头** |
| pack lock | 成员存在、已 published、**新增 pack 才校验未 yank**（§03-5） |
| pack 兼容性 | `contract_paths` 取本版 ∪ 上版；变更即升 Tier 2（§03-3.1） |
| capability 一致性 | 声明 `none` 却含 `0755` / 外部 URL / 脚本 → 拒绝 |

## 7. capability 分级

| capability | 审查等级 |
|---|---|
| `none` | Tier 0 · 一名维护者 approve |
| `network` / `external-tool` | Tier 1 · 一名 approve + 逐条回答外部依赖 |
| `shell` / `credentials` / `writes-repo` | Tier 2 · **两名**维护者 approve |

pack 的 Tier = 成员 capability 并集对应的最高 Tier。
`contract_paths` 变更同样强制 Tier 2（D8）。

非 `geoly` namespace 的 Tier 1/2 制品，**安装时展示 capability 并要求确认**
（`--yes` 可跳过，但写进账本）。

声明不实 → 视为恶意投稿，namespace 进观察名单。

## 8. 人工门：审什么

自动门只能证明结构对。要人读 `SKILL.md` 与 `references/`：

1. 有没有指示 agent 读环境变量 / 凭据 / `~/.ssh` / `~/.aws` / 浏览器 profile？
2. 有没有把数据发到外部（URL、webhook、邮件、剪贴板）？
3. 有没有试图覆盖或忽略系统指令 / 其他 skill 的约束？
4. `description` 会不会抢已有 skill 的路由？
5. 有没有 Unicode 混淆、零宽字符、双向控制符、同形字？
   （审查视图必须**高亮不可见字符与 bidi**，不能靠肉眼）
6. 有没有间接指令（引用外部文档，「按那里说的做」）？
7. capability 声明是否与正文一致？
8. license 与 provenance 是否可信？

清单**不是**安全保证。见 [`07-threat-model.md`](07-threat-model.md) §4。

## 9. `publish` 与 token

> 🔴 **2026-09-05 起本节的授权部分不适用**（用户拍板，见
> [`10-open-questions.md`](10-open-questions.md) Q4）：
> **不注册应用，`publish` 用用户已有的 GitHub token，不做 `login` / `logout`。**
>
> 因此下面这四条**当前不成立**：device flow 的 `login`、keychain 存储、
> 「token 只在 login/publish/logout 里读」、以及「`logout` 调 API 撤销授权」。
> ⚠️ 最后一条同时是一条**很可能做不到**的要求：撤销端点需要的认证方式
> 官方文档没写清，若必须 `client_secret`，公开 CLI 拿不住。
>
> **仍然成立的**：`npx github:` 下拒绝执行；以及**权限面必须如实告知** ——
> 用户已有的 token 往往是 `repo` 全权限，比 `public_repo` 还大，而我们无法收窄它。
>
> 📌 正文原样保留：它记录的是当时定的模型，改掉就看不出偏离在哪。

- `login`：GitHub device flow，scope 只要 `public_repo`。
- 存储：优先 OS keychain；不可用时落 `~/.local/state/geoly-skills/auth.json`，`0600`，父目录 `0700`。
- token 只在 `publish` / `logout` / `status` 三条命令里读。
- `logout` 调 API 撤销授权，不只删本地文件。
- 🔴 CLI 以 `npx github:` 运行时，`login` / `publish` 拒绝执行。

`public_repo` 的权限面远大于「给 skills-hub 投稿」。
**收窄方案（GitHub App）统一定在 M3 之前评估** ——
v1 一处写 M3、一处写 M4，已统一。见 [`10-open-questions.md`](10-open-questions.md) Q4。

## 10. 分支保护（M3 之前配好）

`main`：必须 PR，禁直推（含管理员）；Tier 0/1 需 1 名、Tier 2 需 2 名 CODEOWNERS approve；
push 后自动 dismiss stale approvals；必须解决全部 conversation；
必须通过 router 判定的那个 validate workflow；禁 force push；禁删分支。

`CODEOWNERS` 覆盖 `/.github/`、`/artifacts/`、`/registry/`、`/cli/`、`/scripts/`、`/docs/`。
