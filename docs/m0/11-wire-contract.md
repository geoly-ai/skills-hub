# M0 · Wire contract：JSON 的通用规则

v2 的 schema 只是名字和示例，不是可实现的契约。本文件定死**所有** JSON 对象的通用规则；
各对象的字段表在各自文档里。

## 1. 适用对象

`snapshot`、`timestamp`、`attestation` 的 payload、`trust`、`ledger`、`journal`、
`skill.json`、`pack.json`、`geoly-skills.lock.json`、`attic-manifest`、**`audit-archive`**、**`audit-archive-intent`**、**`repair-intent`**、`VENDORED.json`、
`registry/owners.json`、`registry/reserved.json`、`registry/index.json`。

**不适用**：`<target>/.geoly/generation` 与 `<target>/.geoly/audit-seq`（纯十进制整数，不是 JSON）；三把锁的 `*.db`（物理 target 锁、`metadata.lock.db`、
`<repo>/.geoly-skills.lock.db`）。它们是 SQLite 数据库，不是 JSON，
其 `holder` 表只是**可能陈旧的诊断信息**，不参与任何跨版本契约
（[`04-install.md`](04-install.md) §5.1）。

## 2. 解析规则（读）

| 规则 | 说明 |
|---|---|
| **拒绝重复 key** | 标准 `JSON.parse` 会静默取最后一个 —— 必须换成会报错的解析器或先扫描 |
| **拒绝未知字段** | 顶层与所有嵌套对象一律 `additionalProperties: false`。宁可让旧 CLI 拒绝新字段，也不要让它**忽略**一个它不理解的安全相关字段 |
| **`null` 只在 schema 明确声明处允许** | 默认：可选字段用「缺席」表达，不用 `null`。<br>🔴 **明确允许 `null` 作为语义哨兵的位置**（schema 里逐个标注，别处一律拒绝）：<br>　`ledger.transaction` —— 「无事务」<br>　`journal.ledger_image.{pre,post}.entries[k]` / `.roots[k]` —— 「该键复位后应不存在 / 本次删除它」<br>　🔴 `journal.ledger_image.{pre,post}.frozen_attic` —— 「原本不存在」<br>　`attic-manifest.items[k].tar` / `.old_digest` —— `install-new` 无旧树<br>　🔴 `attic-manifest.ledger_delta.entries[k]` / `.roots[k]` / `.frozen_attic` —— 逐项列出，不用 `.*` 模糊覆盖<br>　🔴 `attic-manifest.postimage.entries[k]` / `.roots[k]` / **`.frozen_attic`** —— 「该键当时**应不存在**」（没有它，`retire-only` 之后无法比对 absence）<br>　🔴 `attic-manifest.postimage.digests[name]` —— 见下。<br><br>**明确采用「缺席」而不是 `null` 的地方**（避免白名单无节制膨胀）：

- `ledger.audit[].advisory`、`audit-archive.events[].advisory` —— 没有就**不写这个字段**；
- 🔴 `repair-intent.child`、`repair-intent.plan.repair_ledger_image.{pre,post}.{entries,roots}[k]`
  —— **一律用「字段缺席」**，不用 `null`（v23 在这三处用了 `null` 而白名单里没有，
  等于**规范会拒绝自己的 repair-intent**）；
- 🔴 `journal.adopt_assertions` / `journal.unadopt_assertions` —— 没有对应逻辑项时**整个字段缺席**（不写 `{}`，也不写 `null`）；
- 🔴 `attic-manifest.items[*]` 的 `op` 与 `reverse_op` **枚举相同**，均为
  **`swap` / `install-new` / `retire-only` / `adopt` / `unadopt`**
  （v42 两侧枚举不一致，会让规范自己生成的 manifest 被自身解析器拒绝）；
  `op ∈ {install-new, adopt, unadopt}` 时 `tar` 与 `old_digest` 允许为 `null`；
- 🔴 `journal.items[*].old_digest` / `new_digest` —— **按 `op` 定义必填/缺席**，不补裸 `null`：

  | `op` | `old_digest` | `new_digest` |
  |---|---|---|
  | `swap` | 必填 | 必填 |
  | `install-new` | **缺席** | 必填 |
  | `retire-only` | 必填 | **缺席** |

**`postimage.digests` 的取值**：不用裸 `null`，改为显式 tagged 形式
`{"present": true, "digest": "geoly-tree-v1:sha256:…"}` 或 `{"present": false}` ——
「目标应缺席」是一个**正面断言**，不该和「字段忘了填」共用同一个表示。

⚠️ **不把所有 absence 都改成 tagged**：`entries` / `roots` / `frozen_attic` 是
「**已枚举 key** 的状态值」，允许 `null` 就够；只有**物理目录摘要**用 tagged。
真正的要求是**每个 map 的 key 集必须可定义**（§5.8.1 的 `E_N` / `R_N` 就是这么定的）。<br><br>⚠️ v12 的规则是「一律拒绝 `null`」，而 `ledger_image` 与 manifest 都在用它 ——
**正常事务会被自己的解析器拒掉**。这是 v13 修掉的一个自噬矛盾 |
| 数字 | 只允许非负整数，范围 `[0, 2^53-1]`。**不允许**浮点、指数、前导零、`-0` |
| 字符串 | 有效 UTF-8；除非字段另有说明，禁止 C0/C1 控制符 |
| 时间 | 严格 `YYYY-MM-DDTHH:MM:SSZ`。无偏移、无小数秒、无 `+00:00` |
| 摘要 | `<algo>:<hashname>:<lowerhex>`，例如 `geoly-tree-v1:sha256:…`；`asset.sha256` 写作 `sha256:<hex>` |
| 数组顺序 | 凡文档指明排序的（如 `snapshot.artifacts` 按 `id` 字节序），**顺序不符即拒绝**——它参与确定性 |
| 大小上限 | 单个 JSON 文档 ≤ 8 MiB；解析前先查文件大小 |

## 3. 生成规则（写）—— canonical JSON

需要逐字节复现的对象（`snapshot`、`timestamp`）必须用 canonical 形式：

1. 🔴 `schema` **强制置于首位**，其余 key 按 **UTF-8 字节序**升序。
   （v3 同时要求「全字节序排序」与「`schema` 是第一个字段」，两者矛盾；此处定死优先级。）
2. 缩进 2 空格，`": "` 分隔，数组每元素一行；
3. 结尾恰好一个 `\n`；
4. 非 ASCII 一律转义。🔴 D9 只约束**路径**，`description` / `provenance` / `reason` 等
   自由文本仍可含非 ASCII，因此必须定死：
   - 转义用 `\uXXXX`，**hex 小写**；
   - BMP 外字符写成**代理对**（两个 `\uXXXX`）；
   - **未配对的代理**（lone surrogate）→ 拒绝整个文档；
   - `"` `\` 与 C0 控制符用最短转义（`\n` `\t` 等优先于 `\u000a`）；
5. 不输出缺席的可选字段。

`scripts/canonical-json.mjs` 是 CLI 与 CI 共用的**同一份**实现。

## 4. `schema` 字段与版本演进

每个对象的第一个字段是 `schema`，形如 `geoly.skills.<对象>/<主版本>`。

- **主版本不同 → 拒绝**，提示升级 CLI。不做「尽力而为地解析」。
- 加字段 = 升主版本（因为 `additionalProperties: false`）。
- 本地状态（`trust` / `ledger` / `journal`）的主版本升级由 CLI 做**显式迁移**：
  读旧版 → 备份原文件 → 写新版 → 记一条迁移日志。迁移失败即停机，不带病继续。

## 5. 原子写

一切本地状态文件（`trust.json`、`ledger.json`、`journal/*.json`、`geoly-skills.lock.json`、
`attic/<gen>/manifest.json`、`audit-archive/<seq>.json`、`audit-archive-intent.json`、`repair-intent.json`、`generation`、`audit-seq`）：

```
写 <file>.tmp → fsync(tmp) → rename(tmp, file) → fsync(父目录)
```

🔴 **禁止原地覆写。** 崩溃会留下无法解析的文件，而这些文件正是崩溃恢复的依据。

🔴 **原子写「失败」的准确语义**（v22 更正）：**不等于「磁盘未变」** ——
`rename` 已经生效、而随后的父目录 `fsync` 报错时，目标文件**可能已经存在**。
因此规范里任何一处都不得写「写失败 → 磁盘未变」。统一口径：

> **失败即停机（fail-closed）；下次启动按磁盘上的实际内容判定 ——
> 读到合法内容则沿用，读到非法内容则 fail-closed，绝不「因为上次报错了」就重置。**

🔴 **本条覆盖全部历史台账**：`CHANGES-v*.md` 是变更记录、不是现行规范；
其中任何「写失败 → 磁盘未变 / 什么都没发生」的旧表述**一律以本条为准**（已就地标注）。

🔴 **canonical 形式适用于全部对象**（v3 只强制 snapshot/timestamp），
因为 journal 的自校验依赖它。

`journal/*.json` 额外带 `crc32c` 字段：小写 hex，**8 个字符，固定宽度补零**；
覆盖范围 = **去掉 `crc32c` 这一个 key 之后**该对象的 canonical 字节（含结尾换行）。
校验失败 → 停机，报告为需要人工介入，**不猜**。

## 6. 文档里的示例不是 canonical

各文档中的 JSON 示例为**可读性**按逻辑分组书写，**没有**按 §3 的 canonical 规则排序。
它们说明字段，不说明字节。

🔴 **实际写出的文件必须 canonical**，由 `scripts/canonical-json.mjs` 保证；
CI 有一道门校验仓库内所有受管 JSON 是 canonical 形式。

## 7. 未定义即拒绝

规范没有明确允许的组合，实现一律**拒绝**而不是取一个「合理默认」。
默认值是分叉的温床，而分叉点就是绕过点。
