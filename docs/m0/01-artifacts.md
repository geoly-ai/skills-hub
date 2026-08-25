# M0 · 制品：布局、标识、路径 grammar、树摘要

## 1. 不可变

`artifacts/**/<version>/` 下任何文件的任何字节变更都是违规，CI 硬拒。
要改内容 → 发新版本。要撤内容 → yank（不删文件）。

## 2. 仓库布局

```
skills-hub/
  artifacts/
    skills/<namespace>/<name>/<version>/
    packs/<namespace>/<name>/<version>/
  registry/
    snapshots/hub-<N>.json                # 只增不改，签名对象
    timestamp-archive/hub-ts-<V>.json     # 历史副本；**当前值不进仓库**，见 02 §3.2
    owners.json  reserved.json
    schema/*.schema.json
  submissions/<namespace>/<name>@<version>/
  advisories/GSA-*.md
  cli/  scripts/  docs/  .github/
```

`main` 是工作线，**不是分发源**。

🔴 **快照里不含生成/承载它自己的 release commit SHA**（那会自引用）。
`review.head_sha`、`provenance.origin_commit`、attestation 的 `sourceCommit` 都**允许存在** ——
它们指向别的东西，不自引用。见 [`02-registry.md`](02-registry.md) §2.1。

## 3. ArtifactId

```
<kind>:<namespace>/<name>@<version>
```

- `kind` ∈ `skill` | `pack`
- `namespace`：`[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?`
- `name`：`[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?`
- `version`：semver 2.0.0，**禁止 `+build` metadata**（D7）。
  预发布（`-rc.1`）允许存在，默认不解析，需 `--pre`

**唯一性规则（消除 v1 的自相矛盾）**：

- `name` 在**同一个 namespace 内**唯一。
- 不同 namespace 下**允许**同名（`a/foo` 与 `b/foo` 可以并存于 registry）。
- 但磁盘目录名 = `name`（四端 skills 目录是平铺的，没有 namespace 层），
  所以同一个 target 上同名即**硬冲突**，安装时报错并要求用户选一个。
  这不是缺陷，是如实反映客户端的限制。

## 4. 路径 grammar

制品内的路径定义为**规范化 segment 序列**，不是自由字符串。

```
path    := segment ( "/" segment )*
segment := 1*( 合法字节 )
```

### 4.1 🔴 ASCII-only（D9）

**segment 的合法字节只有 `[A-Za-z0-9._-]`。**

一刀切掉三类问题，代价是文件名必须用英文（`SKILL.md` 正文仍可用任何语言；
matrix 现有 10 个 skill 全部符合）：

| 切掉的问题 | 若允许 Unicode 会怎样 |
|---|---|
| **macOS 归一化** | APFS 枚举目录名时返回的归一形式可能与写入时不同，**安装后重算树摘要会对不上归档里的 NFC 路径** |
| **USTAR 编码** | 非 ASCII 会挤占 `name`/`prefix` 的字节预算，且 ustar 无字符集声明 |
| **同形字混淆** | 审查只能靠人眼，注定漏 |

### 4.2 其余拒绝规则

- 空 segment（含 `//`、首 `/`、尾 `/`）
- segment 为 `.` 或 `..`
- segment 以 `.` 或 `-` 开头，或以 `.` 结尾
- segment（去扩展名后，忽略大小写）是保留设备名：
  `CON PRN AUX NUL COM1..COM9 LPT1..LPT9`
- 与已有条目**大小写折叠后**重名（macOS 上会互相覆盖）
- 重复路径

### 4.3 🔴 USTAR 可编码性

canonical 归档是 `ustar` 且**禁用扩展头**（[`02-registry.md`](02-registry.md) §4.1），
而 ustar 的 `name` 字段只有 **100 字节**、`prefix` 只有 **155 字节**。
v2 允许 200 字节路径，一部分合法制品**根本打不出包**。

规则：路径必须能被 ustar 切分 ——

```
存在一个 '/' 分割点，使得：
    prefix 部分 ≤ 155 字节  且  name 部分 ≤ 100 字节
（路径本身 ≤ 100 字节时无需 prefix）
```

CI 与 CLI 都在结构门里直接判这个条件，**不是**判「总长 ≤ 200」。

## 5. 载荷规则

| 允许 | 条件 |
|---|---|
| 普通文件 | mode 只允许 `0644` 或 `0755`；`0755` 仅当 capability 声明了 `shell` |
| 目录 | 只作为中间层。**空目录不可表示**，因此禁止 |

**一律拒绝**：symlink、hardlink、FIFO、socket、设备、稀疏文件，
以及归档里的 **xattr / ACL / PAX 扩展头 / GNU 扩展记录**（见 §6.2）。

**上限**：单文件 2 MiB；解压后总计 16 MiB；文件数 2000；路径深度 12；
路径按 §4.3 的 USTAR 可编码性判定（不是简单的长度上限）；压缩比 200:1。

### 5.1 skill 载荷

根必须有 `SKILL.md`（YAML frontmatter 含 `name`、`description`）与 `skill.json`：

```json
{
  "schema": "geoly.skills.skill/1",
  "kind": "skill",
  "namespace": "geoly",
  "name": "plaud-theme-dev",
  "version": "0.3.6",
  "description": "…",
  "license": "MIT",
  "clients": ["claude", "cursor", "codex", "agents"],
  "capabilities": ["none"],
  "replaces": [], "conflicts": [],
  "provenance": { "…": "见 05-lifecycle §6" }
}
```

🔴 **`skill.json` 里没有 `digest` 字段，永远不会有。** 摘要只存在于 registry snapshot，
由发布器计算；投稿者声明的一律不读。

**版本只放 `skill.json`。** `SKILL.md` frontmatter 只承担运行时语义。

### 5.2 pack 载荷

根必须有 `pack.json`，格式见 [`03-packs.md`](03-packs.md)。pack 不含成员内容。

### 5.3 manifest ↔ ArtifactId 完整绑定（结构门）

以下六项必须**全部相等**，任一不符即拒绝：

1. 仓库路径 `artifacts/<kind>s/<ns>/<name>/<version>/`（或投稿期的 `submissions/<ns>/<name>@<version>/`）
2. `skill.json` / `pack.json` 的 `kind`
3. `…json` 的 `namespace`
4. `…json` 的 `name`
5. `…json` 的 `version`
6. snapshot record 的 `id` / `namespace` / `name` / `version` / `kind`

外加 skill 的第七项：`SKILL.md` frontmatter 的 `name`。

（v1 只强制了「三处 name 一致」，能发布出「路径 `x@1.0.0`、载荷声明 `x@2.0.0`」的制品。）

## 6. 树摘要

### 6.1 算法 `geoly-tree-v1`

对制品载荷的**全部文件**计算，不做任何排除。

```
leaf   = SHA256( "blob\0" || u64be(byte_length) || content_bytes )
mode   = "0644" | "0755"（4 字节 ASCII）
path   = §4 定义的规范化路径，UTF-8，NFC
entry  = path_bytes || 0x00 || mode || 0x00 || lower_hex(leaf)

entries 按 path_bytes 逐字节升序
digest_hex = SHA256( "geoly-tree-v1\n" || Σ (entry || "\n") )
```

**摘要值的书写形式**（🔴 v2 变更）：

```
geoly-tree-v1:sha256:<64 hex>
```

算法标识**进入每一个摘要值本身**，不再只放在 snapshot 顶层。
理由：pack 的 `pack.json` 不可变、锁的是它当时算出的摘要；若算法标识只在顶层，
一旦升到 v2，历史 pack 永远校验不过。CLI 遇到不认识的算法前缀 → **拒绝安装**，不降级。

`u64be(length)` + 域分离前缀 → 无编码歧义、无延展性、无 length-extension。
路径禁 NUL 与 LF，故 `0x00` 与 `\n` 作分隔符边界明确 ——
**前提是实现按原始 UTF-8 字节判定，不是做模糊的字符串过滤。**

`mode` 必须进摘要：`0644` 与 `0755` 内容相同但执行语义不同，且直接关联 `shell` capability。

### 6.2 摘要不覆盖的东西 → 必须在别处消灭

树摘要只覆盖「文件路径 / 文件 mode / 文件字节」。以下不在摘要里，
因此**规范强制其取值**，而不是放任：

| 对象 | 规则 |
|---|---|
| 目录 mode | 解包时一律置 `0755`。归档里若含目录条目且 mode 不是 `0755` → 拒绝 |
| mtime / atime | 解包时一律置 0（epoch）。归档里的时间戳不参与、也不保留 |
| uid / gid / uname / gname | 归档里必须是 `0 / 0 / "" / ""`，否则拒绝 |
| xattr / ACL | 归档含任何 xattr 或 ACL 记录 → 拒绝 |
| PAX / GNU 扩展头 | 除 `path` 超长以外的任何扩展记录 → 拒绝。超长路径本就被 §4.3 的 USTAR 可编码性挡掉，故实际上**任何扩展头都拒绝** |

否则两个运行语义不同的树可以有同一个摘要。

### 6.2.1 🔴 `geoly-tree-v1` 的适用边界

它**只证明制品的文件叶子** —— 因为制品**禁止空目录**（§5），目录结构由文件路径隐含。

🔴 **不得用它给 `tx-<gen>/` 成像**：tx 的 `stage/` 与 `retired/` **可以是空目录**，
空目录被删掉摘要不变，「精确匹配」就不成立。
那里用 **`geoly-tx-v1`**（[`04-install.md`](04-install.md) §5.10）——
它复用本节的 path 规范化与 leaf 编码、复用同一个实现模块，
但**有独立的域分离前缀**并**把目录项也纳入覆盖**。

### 6.3 一份实现

`scripts/tree-digest.mjs` 是 CLI 与 CI **共用的同一份**。
两份实现必然分叉，而分叉点正好是绕过点。

## 7. 不可变性的 CI 强制

1. `artifacts/**` 与 `registry/snapshots/**` 只允许 `A`（新增）。出现 `M`/`D`（含重命名）→ 失败。
2. 新制品版本在该 `<ns>/<name>` 下必须**从未存在过**，含已 yank 的。
3. 版本号一旦用过永久占用。
