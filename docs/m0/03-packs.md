# M0 · pack：锁定、yank 闭包、兼容性门

## 1. pack 是引用，不是容器

pack 载荷里没有成员 skill 的任何内容，只有 `pack.json` 与说明文档。
代价是装 pack 要多解析 N 次；收益是同一份 skill 的字节在 hub 里**只有一处**。

## 2. `pack.json` — schema `geoly.skills.pack/1`

```json
{
  "schema": "geoly.skills.pack/1",
  "kind": "pack",
  "namespace": "geoly",
  "name": "plaud-theme-matrix",
  "version": "0.3.6",
  "description": "Plaud 品牌 Shopify 主题开发的 10 个 skill 矩阵",
  "license": "MIT",

  "members": [
    { "id": "skill:geoly/plaud-theme-shared@0.3.6",
      "tree_digest": "geoly-tree-v1:sha256:…", "role": "matrix", "order": 0 }
  ],
  "bundled": [
    { "id": "skill:geoly/yidian-draft-pr@0.3.6",
      "tree_digest": "geoly-tree-v1:sha256:…", "role": "tool" }
  ],

  "conflicts": ["skill:*/plaud-shopify-theme"],

  "contract_paths": [
    "plaud-theme-shared/references/handoff-schema.md",
    "*/matrix-contract.md"
  ],

  "compatibility": { "previous": "0.3.5", "kind": "compatible", "breaking_reasons": [] }
}
```

**成员锁定：精确版本 + 摘要，不接受 semver range。** range 意味着「装的时候才知道装到什么」，
那样 pack 的树摘要就不代表一次可复现的安装。

`tree_digest` 在 pack 里冗余记一份（且**自带算法前缀**，见 [`01-artifacts.md`](01-artifacts.md) §6.1），
与快照里那份必须一致（CI 校验）。CLI 发现两处不一致 → **终止**并报告为完整性事件。

### 2.1 pack 不声明 `clients` / `capabilities`（消除 v1 未定义项）

registry 对 pack 记录的这两个字段由 promotion **计算**并写入快照：

| 字段 | 推导 |
|---|---|
| `clients` | 全体 `members` 的 `clients` **交集**（`bundled` 不参与——它可被 `--no-bundled` 跳过） |
| `capabilities` | 全体 `members` + `bundled` 的 `capabilities` **并集** |

交集为空 → 该 pack 不可安装，promotion 阶段直接拒绝。
capability 并集决定 pack 自身的审查 Tier（取最高）。

### 2.2 `role`

| role | 安装行为 |
|---|---|
| `matrix` | 必装。缺一个成员的矩阵不是矩阵 |
| `tool` | 默认装，`--no-bundled` 可跳过（该 flag 已补进 [`09-cli.md`](09-cli.md)） |

`order` 仅用于展示，不影响安装顺序。

### 2.3 `conflicts` 形态

只支持三种：精确 ArtifactId、`skill:<ns>/<name>`（任意版本）、`skill:*/<name>`（任意 namespace）。
**不支持正则。**

## 3. 兼容性门

`kind` ∈ `compatible` | `breaking`，是**人下的判断**（沿用先例 `check_release_meta.py` 的教训）。

声明 `compatible` 时，`scripts/check-pack-compat.mjs` 比对本版与 `previous` 版
在 `contract_paths` 命中的全部文件；除版本戳与日期外只要有差异 → **拒绝** `compatible`。

### 3.1 🔴 `contract_paths` 的绕过面（D8）

v1 让 pack 作者自报 `contract_paths` —— 作者清空清单即可让门形同虚设。

v2 两条护栏：

1. **实际生效的清单 = 本版声明 ∪ 上一版声明**。只能加，不能减。
2. `contract_paths` 本身发生变更（无论增减）→ 该 PR 自动升为 **Tier 2**（两名维护者 approve）。

## 4. 安装语义

**「原子」的准确含义**：

- ✅ 承诺：每个 target 上是一个可恢复事务（[`04-install.md`](04-install.md) §5）。
- ❌ 不承诺：跨四客户端 ACID。

**解析顺序**：

1. 解析 pack 制品（验签 → 验摘要）。
2. 解析全部成员：任何一个不存在 / 摘要不符 / 所属 pack 为 `degraded`（§5）→ **整个安装终止**。
3. 客户端兼容性：pack 的 `clients`（成员交集）不含该 target → 硬错误 / `skipped: unsupported`。
4. 冲突检查 → 需要 `--replace <name>` 点名。
5. 全部成员下载、验摘要、暂存完毕，才进入交换阶段。

### 4.1 refcount

每个成员在账本里的 `requested_by` 数组追加一个 **root key 字符串**
（`"pack:geoly/plaud-theme-matrix@0.3.6"`），root 的详情记在账本顶层 `roots`
（[`04-install.md`](04-install.md) §4）。v5 这里写成对象，与 04 的字符串数组冲突，已统一。
`remove <skill>` 只在移除请求方后 `requested_by` 为空时才真正删目录。

### 4.2 升级

`update pack:<name>` 解析新 pack → 成员差集：版本变化则同事务替换；
新增则安装；移除则减引用，空了才删。

🔴 绝不因「成员集合变了」就整体拒绝更新（那是先例 `update.py` 为矩阵一致性做的规则）。

## 5. 🔴 yank 闭包（v1 未定义）

**yank 一个 skill 不会自动 yank 引用它的 pack** —— pack 不可变，改不了它锁定的成员。

规则：

| 情形 | 快照里的 pack `status` | 能否新装 |
|---|---|---|
| 全部成员 `published` / `deprecated` | `published` | 能 |
| 任一 `members`（必装）被 yank | **`degraded`** | ❌ 不能。报错时点名是哪个成员、引用哪条 advisory |
| 只有 `bundled` 成员被 yank | `published` | 能，但 `bundled` 那项被跳过并告警 |
| pack 自身被 yank | `yanked` | ❌ |

`degraded` 是 promotion **每次重算**并写入快照的派生状态（不是运行时算的——快照是签名对象，
状态必须在签名覆盖范围内）。

**CI 的 pack lock 门只校验新增 pack**（要求其成员当时未 yank）。
历史 pack 不重新校验，否则不可变的旧 pack 会让每一张新快照都构建失败。

已装的 `degraded` pack：`check` 报告并指向 advisory；不强制卸载。
🔴 **`--allow-yanked` 不放行 `degraded`**，理由见 [`04-install.md`](04-install.md) §8.1.1。

🔴 **`latest` 排除 `degraded`**（[`02-registry.md`](02-registry.md) §2.3）。
否则 `install pack:x`（不带版本）会选中最高版、而它恰好 `degraded`，**安装必然失败**。
排除后 `latest` 指向最高的**可安装**版本；若全部版本都 `degraded`，
则 `latest` 缺席，解析时明确报「该 pack 当前没有可安装版本」并列出各版本被哪个成员拖累。

## 6. `vendor` 子命令（补 v1 的缺口）

[`08-matrix-migration.md`](08-matrix-migration.md) 要把主题仓的 vendored 目录改为「从 hub 取」，
但 pack 只是引用，单独取 pack 得不到完整的目录树。因此需要一个**物化器**：

```
npx @geoly/skills-hub vendor pack:geoly/plaud-theme-matrix@0.3.6 \
    --out .github/codex/plaud-theme-matrix --layout flat
```

- 下载 pack + 全部成员，逐个验签 / 验摘要；
- 按 `--layout flat` 物化为 `<out>/<member-name>/…`（= 先例 vendored 目录的契约）；
- 同时写 `<out>/VENDORED.json`：pack id、snapshot、每个成员的 id 与 `tree_digest`，
  供 CI 复核与后续重取；
- **整目录替换**，与安装同样的事务纪律。

`vendor` 不走安装账本（它写的是用户仓库里的目录，不是 client skills 目录）。
