# M0 · 安装：账本、崩溃安全的事务、解包、adapter、项目级

## 1. 为什么不用先例的 marker

先例 `.plaud-installed-ref` 记的是「一包、一版、一组固定 skill」。hub 下：
先装 skill A、再装含 A 的 pack B，后一次会抹掉前一次的所有权；
前缀扫描会把别人装的同名目录误判为陈旧项。

改为：**每个物理 target 一份账本**。

## 2. 平台、文件系统、客户端

### 2.1 平台（D1）

**支持 macOS / Linux / WSL。不支持 Windows 原生**（`win32` 且非 WSL → 拒绝运行，给 WSL 指引）。

🔴 **Node ≥ 22.13**（原为 ≥20）。锁依赖内建的 `node:sqlite`；`DatabaseSync` 自 22.5.0 存在，
但**到 22.12 为止仍需 `--experimental-sqlite` 启动开关**，22.13 起默认启用（§5.1）。

### 2.2 文件系统

安装前预检。**拒绝**在 NFS、SMB/CIFS、FUSE（含 sshfs）、跨设备 overlayfs 上安装 ——
它们不提供本规范依赖的 advisory lock 语义、`rename` 原子性或 `fsync` 崩溃持久性。
拒绝时报出检出的 fstype，不笼统报错。

同时预检 `st_dev`：**stage 目录与 target 必须同设备**（§3），否则 `rename` 会 `EXDEV`。

### 2.3 客户端 adapter（⑦A）

| client | config root | 全局 target | 项目 target |
|---|---|---|---|
| `claude` | `$HOME/.claude` | `$HOME/.claude/skills` | `.claude/skills` |
| `cursor` | `$HOME/.cursor` | `$HOME/.cursor/skills` | `.cursor/skills` |
| `codex` | `$HOME/.codex` | `$HOME/.codex/skills` | `.codex/skills` |
| `agents` | `$HOME/.agents` | `$HOME/.agents/skills` | `.agents/skills` |

adapter 是接口不是路径表：`configRoot()` / `root()` / `exists()` / `layout()` /
`supports()` / `postInstallHint()`。

默认目标 = 本机已存在的全部 client 目录；不存在 = 跳过并如实报告（不是失败），
`--create-missing <client|all>` 才创建。

**兼容性不是「部分失败」**：制品不支持某 client 时，若该 client 在显式 `--clients` 里 → 硬错误；
若只是默认目标之一 → `skipped: unsupported`。

🔴 不照搬先例的「四端必须同版」。

## 3. 状态位置（v8 反转 D2）

### 3.1 🔴 per-target 状态必须**跟着物理目录走**

v2–v7 一路把状态往 target 外面搬（D2/D3），理由是「不依赖『客户端忽略隐藏目录』这个未实测假设」。
**方向错了。** 评审给的反例：

```
A: /repo/.claude/skills                     → stage-parent = /repo/.claude
B: 把同一目录 bind-mount 到 /mnt/skills      → stage-parent = /mnt
```

**同一棵物理树，两个 parent。** 于是：

- 锁文件不是同一个 → 两边都能取到排他锁；
- 更糟：**A 崩在 retirement 之后，B 的 `target-id = hash(realpath)` 不同，
  看不到 A 的 journal 与 tx** —— 即使锁修好，B 也会把未完成事务当成「无事务」继续，
  于是踩烂 A 留下的中间态。

**崩溃恢复的正确性要求状态跟着物理目录走。** 换任何一个「相邻位置」都躲不掉别名问题，
因为 target 的任何祖先都可以被重新挂载。

### 3.2 v8 的布局

```
<target>/.geoly/                     ← 全部 per-target 状态，跟着目录走
    lock.db  (+ -wal / -shm)         # §5.1
    generation                       # 🔴 单调水位，独立于 ledger/tx/attic，永不删除（§4.1）
    ledger.json
    journal/<generation>.json
    tx-<generation>/
        stage/<name>/
        retired/<name>/
    quarantine/<generation>/          # §5.10：隔离的 tx / journal / target 树，人工确认后才清
    repair-intent.json                # §5.10（仅 repair 期间存在）
    attic/<generation>/<name>.tar

~/.local/state/geoly-skills/         ← 只剩**每用户**的东西
    trust.json
    metadata.lock.db
    cache/meta/<sha256>

<repo>/.geoly-skills.lock.db         ← repo 锁（项目级）
<repo>/geoly-skills.lock.json        ← lockfile
```

同设备问题一并消失：`stage` / `retired` / `attic` 与 target 天然同设备，`rename` 必然原子。
`<target-id>`、`<stage-parent>`、面包屑、`adopt --rebind/--discard` **全部删除** ——
状态跟着目录走，复制一个 target 就得到两个各自正确的安装，这是**对的语义**，不需要认领。

### 3.3 🔴 代价：这条依赖客户端忽略 `<target>/.geoly/`，因此它是**阻塞验收门**

v7 之前把这个当「未实测假设」而绕开。v8 承认躲不掉（v7 的面包屑本来就在 target 里，
tx 目录还落在用户的 git 仓库根上 —— 会被误提交，`git clean` 还会删掉正在用的锁），
于是把它收拢成**一条**假设，并升级为**必须通过的 adapter 验收用例**：

> **四端 + 项目级路径，各造一个 `<target>/.geoly/`（含 `lock.db`、
> `tx-1/stage/<name>/SKILL.md`、`attic/1/<name>.tar`），启动客户端，
> 确认不被当作 skill 加载、不报错、不影响其它 skill。**

- 这是 **M1 的阻塞门**：adapter 未过此用例不得合入（[`10-open-questions.md`](10-open-questions.md) Q12）。
- 某一端不通过 → **只把那一端标为不支持**，不改整体设计。
- 项目级还须在 `.gitignore` 里忽略 🔴 **adapter 派生的实际路径** ——
  `/.claude/skills/.geoly/`、`/.cursor/skills/.geoly/` 等，
  **不是**根上的 `/.geoly/`（v8 写错了）。
  并在 README 说明 🔴 **`git clean -xfd` 会删掉整个 `.geoly/`** ——
  那不只是「正在进行的事务状态」，**还包括本地审计历史（`audit` 与 `audit-archive/`）**。

### 3.4 🔴 `.geoly` 自身不得是挂载点（v9 补）

`<target>/.geoly/` 解决了「target 被 bind-mount 到别处」，
但**没有**解决「在某个别名的 `<target>/.geoly` 上再挂载一个独立目录」——
payload 仍是同一棵 target，锁和 journal 却分裂。
比 fstype / `st_dev` 不够：bind mount 的 `st_dev` 可以相同。

预检必须拒绝：

- `<target>/.geoly`（**含 `quarantine/`**）**本身是挂载点**（其 `st_dev` 与 `<target>` 不同，
  或在 `/proc/self/mountinfo` / `mount` 输出里出现）；
- `<target>/.geoly` **之下含任何挂载点**。

判据以 `mountinfo`（Linux）/ `getmntinfo`（macOS）为准，不只比 `st_dev`。

🔴 **`.geoly` 及其下全部状态路径（含 `quarantine/`、`repair-intent.json`）必须以 `lstat` / dirfd 无跟随方式打开，遇 symlink 即拒绝。**
§10 那句泛称的「拒绝路径链 symlink」只覆盖 target 本身，不足以覆盖状态目录。

### 3.5 🔴 嵌套 target（v9 补）

若一个 target 位于另一个 target 之内（例如某 skill 目录里又有 `.claude/skills`），
外层替换那个 skill 时会连内层的 `.geoly/` 一起搬走，两者的锁互不相识。

v1 的处置：**预检直接拒绝嵌套 target** ——
🔴 「另一个 target」的识别范围**必须收窄**，否则按名字扫任意后代 `.claude/skills`
会误伤普通目录：只算 ①**本次命令的目标集合**里的，或 ②**实际带有有效 `.geoly/` 状态**的目录。
命中即报错退出，不做联合锁协议。

### 3.6 只读 target

`<target>/.geoly/` 需要可写。target 不可写（只读挂载、只读仓库）→ **预检直接拒绝**，
报明「安装需要在 `<target>` 内创建 `.geoly/`」。
（v7 把 tx 放仓库根，同样需要仓库根可写，只是没写明预检。）

## 4. 账本 schema `geoly.skills.ledger/2`

```json
{
  "schema": "geoly.skills.ledger/2",
  "target": { "client": "claude", "scope": "global",
              "path": "/Users/chovi/.claude/skills",
              "realpath": "/Users/chovi/.claude/skills", "fstype": "apfs" },
  "last_applied_generation": 17, "cli_version": "1.4.2",

  "roots": {
    "pack:geoly/plaud-theme-matrix@0.3.6": {
      "kind": "pack",
      "artifact": "pack:geoly/plaud-theme-matrix@0.3.6",
      "tree_digest": "geoly-tree-v1:sha256:…",
      "snapshot": 42,
      "intent": { "no_bundled": false, "allow_yanked": false, "pre": false },
      "requested_at": "…"
    },
    "direct:skill:geoly/yidian-draft-pr@0.3.6": {
      "kind": "direct",
      "artifact": "skill:geoly/yidian-draft-pr@0.3.6",
      "tree_digest": "geoly-tree-v1:sha256:…",
      "snapshot": 42,
      "intent": { "no_bundled": false, "allow_yanked": false, "pre": false },
      "requested_at": "…"
    }
  },

  "entries": {
    "plaud-theme-dev": {
      "artifact": "skill:geoly/plaud-theme-dev@0.3.6",
      "tree_digest": "geoly-tree-v1:sha256:…",
      "snapshot": 42, "installed_at": "…", "generation": 17, "state": "ok",
      "requested_by": ["pack:geoly/plaud-theme-matrix@0.3.6"]
    }
  },
  "transaction": null
}
```

`entries` 的 key = 磁盘目录名（= `name`），这是所有权判定单位。`state` ∈ `ok` | `corrupt`。

🔴 **`audit` 是 target 顶层的事件流，不寄居在 entry 里（v17 修正）**

v16 把它放在 `entries[*].audit`。评审指出：**排除 manifest 救不了它** ——
`install-new` 的反向是 `retire-only`，`ledger_delta.entries[name] = null` 会把整个 entry
连同它的 audit 一起删掉。排除的是搬家清单，房子本身还是被拆了。
（而新写一条 `audit_target` 也补不回已经丢掉的旧事件。）

v17：**只有一个 target 级事件流** `ledger.audit`，事件自带 subject：

```json
{ "event_id": 137,
  "kind": "installed-yanked" | "restored-yanked" | "restored-degraded"
        | "restored-state-unknown",
  "subject": { "kind": "entry", "name": "plaud-theme-dev" }   // 或 { "kind": "target" }
             ,
  "at": "…", "artifact": "…", "advisory": "GSA-…",   // 无 advisory 就**不写这个字段**
  "note": "…" }
```

- entry 被删除**不影响**它的历史事件 —— 事件在顶层，只是 `subject.name` 指向一个已不存在的名字；
- 顶层 `audit_target` 一并取消（它当初只是为了兜「没有 entry 可挂」的情形，现在不需要了）；
- `install-new` 反向复位后没有 entry，事件照记，`subject.kind = "entry"`、`name` 照填。

🔴 **离线时当前状态未知**：`--from-generation` 在 `--offline` 下无法查当前快照 →
记 `restored-state-unknown` 并**大声告警**，不得假定「没被 yank」。

🔴 **`audit` 的追加走事务镜像，但只进 `post`**（v19 更正 —— v15 写的是 `pre/post`，
与 §4 的 audit plane 直接矛盾）：
**`pre` 与 attic manifest 的 `ledger_delta` / `postimage` 一律不得含 audit 相关字段。**
`--from-generation` 的顺序是：postimage 比对 → 构造「过滤后的 delta **+** audit 追加」作为 `post`
→ 正常事务提交。否则崩溃恢复会**丢掉审计记录**。

🔴 **复位结果没有 entry 的情形**：事件流在顶层，`subject.name` 照填即可 ——
v16 为此专设的 `audit_target` 已取消。

#### 🔴 audit plane（v16：独立平面，有自己的事务契约）

v15 的 audit 只有「只增不减 + 归档」一句话，评审指出三处不闭合。v16 定为一个**独立平面**：

| 项 | 规定 |
|---|---|
| **事件 id** | 每个事件带 `event_id`（整数），**target 级全局递增**，来源是独立文件 `<target>/.geoly/audit-seq`（原子写、只增、纯十进制）。<br>🔴 **分配顺序**：在 target 锁下 ① 读 seq → ② `+1` 原子写回并 fsync → ③ 才把该 id 用在事件上。<br>🔴 **写 seq 失败 → 不写事件、整体终止**；②成功而后续失败 → **允许烧号**（号可以有洞，不可以重复） |
| 🔴 **`audit-seq` 的生命周期** | v19 用「有没有 audit 证据」当判据，**在一条路径上判不出来**：先成功写出 `seq=1` → 后续事务失败**烧掉**该号 → 再丢失 seq 文件。此时 live、archive、intent、cursor **全都是空的**，下一次会**复用 1**。<br>🔴 v20 改为：**每次 ledger bootstrap 时一并持久化 `audit-seq = 0`，此后永不删除。**<br>于是「首次初始化」与「烧号后丢失」可区分：<br>· **没有 ledger 也没有 seq** → 连同骨架一起建 `audit-seq = 0`；<br>· 🔴 **没有 ledger 但 seq 存在** → **合法**（pre-commit 清理只删骨架、不删 seq），**沿用该 seq，绝不重置为 0**；<br>· 🔴 **已有 ledger 但 seq 缺失或格式非法 → 一律拒绝**（不再看 live/archive/intent/cursor —— 那组判据不完备）；<br>拒绝时的两条出路：① 恢复**完整且一致的 `.geoly` 状态集** —— 🔴 明确包括 `audit-seq`、live `audit`、`audit-archive/`、audit intent、`audit_archived_until` 游标、以及 ledger 本身；② 移走**整个 target** 后重装（**放弃本地 audit**）。<br>🔴 **`--reset-generation` 解决不了这个问题** —— 它管的是 generation 水位，不是 audit 序号。<br>🔴 **`event_id` 的作用域是「这一份 `.geoly` 状态谱系」，不是那个路径名** —— 「移走整个 target 后重装」与 `git clean -xfd` 都会开启**新的序列**，这是规范已承认的「放弃本地 audit」边界，不算复用 |
| 🔴 **上限** | `event_id` 达到 `2^53−1`（§11 的整数上限）→ **拒绝追加**，报明需要归档并人工处置 |
| 🔴 **空批次** | 待归档前缀为空 → **no-op**：不写 intent、不建 archive、不动 cursor |
| **落点** | live 部分在账本顶层 `audit`；归档在 `<target>/.geoly/audit-archive/<seq>.json` |
| **归档 schema** | `{ "schema": "geoly.skills.audit-archive/1", "seq": N, "from_event": …, "to_event": …, "events": [...], "batch_digest": "sha256:…" }`，canonical + 原子写 + fsync 父目录 |
| 🔴 **批次的确定性选择** | 归档的是 live `audit` 中**按 `event_id` 升序排序后的一个前缀**（不是任意子集）。`from_event` = 该前缀首个 id，`to_event` = 末个 id，🔴 **`seq = to_event`**（不再单独分配，天然唯一且单调） |
| 🔴 **`batch_digest` 覆盖范围** | 对 `events` 数组按 §11 canonical 序列化后的**原始字节**求 `sha256`（不含外层其它字段） |
| 🔴 **归档的事务契约** | 一次**独立的、有自己状态文件的**小事务。intent 落在 **`<target>/.geoly/audit-archive-intent.json`**（canonical、原子写，schema `geoly.skills.audit-archive-intent/1`）：<br>① 写 intent `{seq, from_event, to_event, batch_digest}` → fsync<br>② 写 `audit-archive/<seq>.json` → fsync → fsync 父目录<br>🔴 **②′ 正常路径也必须重验**（v21 补 —— v20 只在崩溃恢复里定义了重验，正常路径从「写完」直接跳到「patch 账本」）：**重新打开** `<seq>.json`，严格校验 schema、`seq`、`from_event` / `to_event` 范围、events 完整性与 `batch_digest`；**任一不符 → 停机，不 patch 账本**<br>③ 账本 patch：移除该前缀、置 `audit_archived_until = to_event` → 原子写<br>④ 删 intent → fsync 父目录 |
| 🔴 **恢复优先级** | **启动恢复时先处理 audit intent，再处理安装事务**（它不依赖安装事务，且会影响账本内容）。§5.2 第 2 步的「发现事务」一并扫描它 |
| 🔴 **逐崩溃点** | 崩在①后：重跑②③④。崩在②后：`<seq>.json` 已存在 → **必须重验其完整内容、`from/to_event` 范围与 `batch_digest`**；相符则跳过②继续③；**任一不符即 fail-closed 停机**（绝不覆盖）。崩在③后：账本已无该前缀，intent 仍在 → ②的重验会通过，③是幂等 patch（`audit_archived_until` 已是目标值），直接④。 |
| 🔴 **audit 永不回退**（v18 定死） | 「只增不减」与「回滚到事务前」**本来就是互斥的**。v17 让 audit 进 `ledger_image` 又按 `pre` 复位 —— 于是它不再随 entry 消失，却仍会被**回滚**或 **bootstrap 删库**抹掉。<br>v18：audit plane **不进 `pre`**，只在 `post` 里以 **`audit_append: [events]`** 的形式出现，语义是**追加**，按 `event_id` 去重。<br>🔴 **去重必须 fail-closed**（v19 补，v18 只说了「去重」）：<br>　· 同 `event_id` 且**canonical 字节完全相同** → no-op（这是 journal 重放的正常情形）；<br>　· 同 `event_id` 但**内容不同** → **`corrupt` 停机**；<br>　· live 流内部出现重复 `event_id`，或与 `audit-archive/` 里已归档的 id 冲突 → 同样 **`corrupt` 停机**。<br>　**绝不静默保留其中一条。**<br>🔴 **校验顺序**（v20 补，避免实现歧义）：① 先校验**已持久化的 live 流**自身唯一、且与 `audit-archive/` 不相交；② 再校验 `audit_append` **批内**唯一；③ 最后逐条合并。<br>　**不得把 replay 的候选先算成「live 内重复」** —— 正确顺序下，journal 重放只会撞到 live 里**同字节**的事件而 no-op；归档只发生在 journal 完成之后，因此 replay 不会正常地撞到 archive。<br>`--rollback` **不撤销任何已记录的 audit**；`--reinstall` 同样必须保留。<br>🔴 **`audit_archived_until` 不随 `audit_append` 前进** —— 它只在归档事务的第③步、且 archive 文件已验证之后更新（见下）。安装事务的 `post` **只允许 `audit_append` 一个 audit 相关字段** |
| 🔴 **bootstrap 不得删掉承载 audit 的账本** | §5.4.1 的收尾在 `ledger_existed = false` 时要「删除整个 ledger.json」。<br>**例外**：若此刻存在任何 live audit、`audit-archive/`、audit intent，或 `audit_archived_until > 0` → 🔴 **不删**，改为写出一份**例外账本**。<br>🔴 **例外账本只清空 `entries`、`roots`、`transaction`；audit plane（live `audit` 与 `audit_archived_until`）一律原样保留** —— **不是**照 bootstrap 骨架的 `audit: [] / 0` 来写，那会把 audit plane 重置掉（v18 没写清这一点）。<br>`ledger_existed = false` 的语义不受影响：它始终指「**本次事务起点**」的状态。后续事务看到这份例外账本时它已经存在，其 rollback 只 patch 非审计字段 |
| 🔴 **归档不受保留策略清理** | `--keep-generations` 只管 `attic/`。**`audit-archive/` 永不按代清理** —— 它是审计历史，不是可丢弃的备份 |
| 🔴 **manifest 排除 audit plane** | `ledger_delta` 与 `postimage` **一律不含 audit 相关字段**。<br>否则 delta 若写完整 entry，之后的 `--from-generation` 会**覆盖掉新增的 audit**，直接违反「只增」。<br>**复位永远保留审计历史。** |
| 容量与阈值 | 追加前做容量预检，预计超 §11 的 8 MiB 则**在提交点之前失败**。<br>🔴 **阈值边界**：live 事件数 `== audit_max_entries`（默认 1000）**不归档**；`>` 才归档。归档前缀**必须非空**，空前缀不写任何文件、不动 cursor（§ 空批次 no-op）|
| 🔴 **与安装事务的顺序** | 归档是**独立的小事务**，与安装事务**不得交错**：<br>· 安装事务进行中（`journal.phase != completed`）**不触发**归档；<br>· 归档 intent 未清完**不开始**新的安装事务（§5.2 步骤 2a）；<br>· 🔴 **有未完成安装事务时也不触发归档**（阈值归档在 2c，排在 2b 之后）。<br>🔴 **防饥饿**（v20 补，v21 更正位置）：**创建新安装事务之前**必须先过步骤 **2c** —— live 数 `> max` 就先归档到 `== max`。而 2c 排在「已确认无未完成安装事务」之后，因此不会与安装事务交错。<br>v19 只写了「intent 未清完不开始安装」，而 **intent 尚未创建时，连续安装可以一直越过阈值却永远不启动归档**。<br>不会死锁：三把锁都是 `busy_timeout=0`，冲突即失败退出 |
| 🔴 **cursor 的唯一前进点** | `audit_archived_until` **只在归档事务的第③步、且 archive 文件已通过第②′步的重验之后**更新（正常路径与崩溃恢复**走同一段重验**）。**绝不因 `audit_append` 而前进**，也**不出现在安装事务的 `post` 里** —— 否则容量预检、append 与 cursor 会互相覆盖 |
| `advisory` | 🔴 `audit[].advisory` 与归档事件里的 `advisory`，**一律「没有就缺席」，不是 `null`** |

> ⚠️ **账本**的 `intent` 里保留 `allow_yanked`（它如实记录「这次是带着该开关装的」，
> 是本机历史）；**lockfile** 的 `intent` 里**没有**它 —— 未签名文件不得授予该例外（§8.1）。

🔴 **`roots` 是 v5 新增**（[`04-install.md`](04-install.md) §8.1）：v4 的账本只在 entry 里记
「谁请求的」，缺 pack 制品本身的摘要、`direct` 请求的具体 artifact、每个 root 的解析快照
与解析意图 —— 因此 lockfile **推导不出来**。补上这些之后才谈得上投影。
`requested_by` 改为引用 `roots` 的 key。

🔴 账本只是定位信息，不是证明。`check` 不信任其中的 `tree_digest`：
从**验签过的**快照取期望值，对磁盘重算再比。

### 4.1 generation 单调水位

🔴 **账本里没有取号水位。** v15 的 `next_generation` 已删；
账本顶层那个字段改名为 **`last_applied_generation`** —— 顾名思义是「最后**已应用**的代」，
🔴 **它可以落后于独立水位文件，且永远不用于取号**。
（v16 叫 `generation`，与水位同名，很容易被实现成「从账本取号」。）

**取号水位只有一处**：

🔴 **独立的小文件 `<target>/.geoly/generation`**，
原子写、**永不删除**，内容就是一个十进制整数。

v11 让它靠「扫描 ledger / tx / attic」推算 —— **那在两种情况下会复用**：
① 纯 `install-new` 事务**没有 attic**；② 事务收尾后 tx 与 completed journal 都被清掉；
③ bootstrap rollback 会**删掉整个 ledger.json**。三个来源可以同时消失。

规则：

- 取新 generation = 读该文件 → `+1` → **先原子写回并 fsync，再使用**；
- 恢复时一律以该文件为准，**不再扫描目录**；
- 🔴 **该文件缺失**：扫描回填**不能维持单调性** —— 若 ledger / tx / attic 也都没了，
  扫描根本没有上界。因此定为**降级语义**：
  - target 内**没有任何 hub 管理的内容** → 从 `0` 开始，正常；
  - target 内**已有** hub 管理的内容（`ledger.json`、`attic/`、`journal/`、`tx-*`、`audit-archive/`、🔴 **`quarantine/`、`repair-intent.json`** 任一存在）
    而水位文件没了 →
    **拒绝初始化**，报「本地历史被重置」，要求人用 `--reset-generation <N>`（§5.9）。
    **不静默扫描猜一个**；
- 它不进 `ledger_image`，也不参与回滚 —— **水位只增不减**。

### 4.2 未被账本认领的同名目录

默认阻断。出路只有 `--replace <name>`（归档 → 验证 → 删除 → 安装）或用户自己移走。
🔴 不提供泛化 `--force`。

🔴 **`--replace` 的「逐字节相同」分支**（v38 补）：
若那个未认领目录**经严格验明**其树摘要 == 目标制品的 `tree_digest`
（走 §01-6 的同一套算法，且满足 §01-5 的载荷规则），
则**不构造物理 `swap`** —— 那会撞上 §5.10 的「禁止 `old_digest == new_digest`」而被拒。

改为建立一个 **`items: {}` 的 ledger-only 事务**把它**受管化**。

🔴 **分两种情形，不能一律用空 `items`**（v40 —— v39 无条件套用空 `items`，
但 `--replace` **也可能发生在 pack 的多成员安装里**：
一个成员可受管化、另一些仍需物理安装。那时若拆成两个事务，
会留下或崩溃在「root 已写、成员未全写」的半完成图，**违背 pack 的单事务语义**）：

| 情形 | 处理 |
|---|---|
| **该 target 的完整解析计划里一个物理项都没有** | 走下面的空 `items` ledger-only 事务 |
| 🔴 **混合计划**（既有可受管化的成员、又有需物理安装的成员） | **同一个 target 事务**里一起做：物理成员照常进 `journal.items`；可受管化的成员进新增的 **`journal.adopt_assertions`** |

#### 🔴 `adopt_assertions`（v40 新增，**不是** item op）

```json
"adopt_assertions": {
  "<name>": { "artifact": "skill:…@0.3.6",
              "tree_digest": "geoly-tree-v1:sha256:…",
              "state": "ok" }        // 🔴 必填，初值 ok
}
```

| 规则 | |
|---|---|
| 性质 | **不是** `journal.items[*].op` 的第四种取值（同 `logical-only` 的处理方式），不建 stage / retired / attic item |
| 共享 | 🔴 与其它物理 `items` **共用同一份 journal、同一次 ledger post、同一份 manifest** —— 于是 root→成员图在**一个事务内**闭合 |
| 复验 | 🔴 **每次 post / 重放之前**，按下表的严格规则**重新验明**该目录 |
| 🔴 断言失败的持久化（v41 补） | v40 说「不成立即 `corrupt`」，但 `corrupt` 只对 `journal.items[*].state` 有定义，而 adopt **明确不是 item** —— 于是失败**无处记录**。<br>v41：journal 增加 **`adopt_assertions[<name>].state ∈ { ok, assertion-corrupt }`**，失败时**原子持久化**为 `assertion-corrupt` |
| 🔴 `assertion-corrupt` 的处置 | 它是一种**非物理异常**，规则与物理 `corrupt` 不同：<br>　· **允许 `--rollback`** —— 撤回其它物理项与账本 patch；<br>　· 🔴 **始终保留那个用户目录**（`unadopt` 语义，不移动不删除）；<br>　· 🔴 **禁止 `--reinstall` 自动隔离或覆盖它** —— 那是用户自己的目录，不是我们的制品 |
| manifest | 该项在 manifest 的 `items` 里记为 `{"op":"adopt","tar":null,"reverse_op":"unadopt"}`（见下） |
| 🔴 清理 | adopt 项**不参与 §5.6 的 A / C 阶段**（它没有旧树可归档、也没有 `retired/` 可删）；**只在 B 阶段进 manifest** |
| 键集 | `items` / `adopt_assertions` / `unadopt_assertions` **三者互不相交**；`rollback.items` 的键集等于**三者之并** |

以下流程对**两种情形都适用**：

🔴 **它必须走完整的事务流程，不能「只原子写一次账本」**（v38 的措辞会被误实现）：

| 项 | 规定 |
|---|---|
| 流程 | 走 `prepared → 写 ledger post patch → cleanup_pending → completed`，带 `ledger_image`；🔴 **照常生成 manifest**（否则这一代不可 `--from-generation` 复位） |
| 🔴 manifest 的 `items` 到底写什么（v41 更正 —— v40 一处说「两种情形都生成 `items: {}`」，与「混合计划要含物理项与 adopt 项」**自相矛盾**） | **空 manifest 仅限**「既没有物理项、也没有逻辑受管化项」的**纯账本事务**；<br>**混合计划与纯 adopt** 都在 **Stage B** 写入 **物理项 ∪ adopt 项** |
| 🔴 `ledger_image` 的覆盖面 | 必须含**新增 entry、其对应 root、`requested_by` 边、generation** 等**全部实际变化**。<br>v38 只写了「entry 与 `requested_by`」，会留下**未定义或悬挂的 root 关系**（[`03-packs.md`](03-packs.md) §4.1） |
| 🔴 提交前复验 | 写 ledger post **之前**必须**再验一次**目标目录仍满足目标断言 —— 直接复用 `logical-only` 的复验规则。否则外部在初验之后改树，账本会**认领错误内容** |
| 🔴 「严格验明」的含义 | **不只是** `geoly-tree-v1` 摘要相等 —— 该摘要**不覆盖空目录与部分元数据**（[`01-artifacts.md`](01-artifacts.md) §6.2.1）。还必须过**最终落位的结构与元数据约束**：目录、空目录、类型、mode、无 xattr / 无 ACL、普通文件 `nlink == 1` |
| 物理动作 | **无** |

#### 🔴 `unadopt`：受管化的反向操作（v41 —— v40 用 `retire-only` 是错的）

评审指出：**用户原有目录在受管化前后都应留在 target**；
`retire-only` 会把它移进 `retired/`、最终只剩 attic，**使 target 缺席** ——
那不是「复位到该代之前的状态」，而是替用户删了一个他自己的目录。

根因：受管化**本来就没动过那个目录**，反向操作当然也不该动它。

`unadopt` 的语义（manifest 级，不是 journal item op）：

| 项 | 规定 |
|---|---|
| 前提 | 严格通过 §5.8.1 的 `postimage` 三方比对 |
| 动作 | 🔴 **只撤销账本认领** —— 移除 entry、对应 root、`requested_by` 边 |
| 🔴 绝不做 | **不移动、不归档、不删除**那个目录。它回到「未被账本认领的同名目录」这一初始状态 |
| 混合复位 | 与其它反向物理项**共享同一个新事务** |
| 🔴 账本改动的依据 | 一律以**过滤后的 `ledger_delta`** 为准。**不得笼统「删除对应 root」** —— 只删 entry、相关边，以及**仅当 delta 明确指定时**才删 root。否则混合 pack / 共享 root 的语义会被误实现 |

#### 🔴 `unadopt` 在新事务里的持久化与重放（v42 —— v41 只定义了语义，没定义怎么落盘）

与 `adopt` 完全对称，是新一代事务里的**逻辑项**：

```json
"unadopt_assertions": {
  "<name>": { "artifact": "skill:…@0.3.6",
              "tree_digest": "geoly-tree-v1:sha256:…",
              "state": "ok" | "assertion-corrupt" }
}
```

| 项 | 规定 |
|---|---|
| 性质 | 同 `adopt_assertions`：**不是** item op，不建 stage / retired / attic item |
| 共享 | 与该新事务的物理项**共用同一 journal、同一次 ledger post、同一份 manifest** |
| 复验 | 每次 post / 重放前验明该目录**仍在、且没变** —— `unadopt` 承诺不动它 |
| 重放 | 纯幂等（账本 patch 幂等，物理侧无动作） |
| manifest | 记为 `{"op":"unadopt","tar":null,"reverse_op":"adopt"}` —— 🔴 **`unadopt ↔ adopt` 互为逆映射**（v41 缺这一半） |
| 键集 | `items` / `adopt_assertions` / `unadopt_assertions` **三者互不相交** |
| 失败 | 同 `assertion-corrupt` 的分流规则 |

⚠️ 不加这一条，新禁令会**截断「`--replace` 是出口」这个既有承诺** ——
「旧目录恰好是目标制品的逐字节副本」是完全合法的场景。

## 5. 事务

### 5.1 锁：`node:sqlite` 的排他事务（v6 定死，已实测）

v5 把清锁交给人，以为这样就没有竞态。**错了** —— 病根不是「谁发起」，而是
**`unlink` 本身就是无条件按路径删除**：

- A 读到自己的 nonce → R 清掉 A 的锁 → B 用 `O_EXCL` 建新锁 → **A 的 unlink 删掉了 B 的锁**；
- 两个完全合法的 `--clear-lock` 也能触发：R1、R2 都读到遗留锁 L0 → R2 清掉、B 建 L1 →
  **R1 那一次 unlink 删掉 L1** → C 又能建 L2，B 与 C 从此并发。

只要协议里存在**任何一次对锁路径的 unlink**，这一类竞态就消不掉。

#### 结论：改用内核释放的真锁，且**永不 unlink**

纯 Node 里拿不到 `flock`/`fcntl`（未暴露），UDS 陷入同样的 unlink 问题，
Linux abstract namespace macOS 没有。但 **`node:sqlite` 是 Node 内建**，
而 SQLite 的锁就是 fcntl POSIX advisory lock —— **进程退出由内核释放**。

```js
const db = new DatabaseSync(lockPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('BEGIN EXCLUSIVE');     // ← 持锁；进程死亡内核自动释放
…整个事务…
db.exec('COMMIT'); db.close();  // ← 释放
```

**实测结论**（2026-08-25，Node v25.2.0 / macOS APFS）：

| 检验 | 结果 |
|---|---|
| 活持有者阻塞第二个写者 | ✓ |
| `SIGKILL` 持锁者后 | ✓ 内核自动释放，下一个立刻取到 |
| 持锁期间读持有者信息 | ✓ WAL 模式下读者不阻塞 |
| npx 冷启动开销 | ✓ 量不出差别（内建、惰性加载） |
| 取锁+提交+关闭 | ≈ 8.7 ms |

#### 协议

| 项 | 规定 |
|---|---|
| 三把锁 | **物理 target 锁**（§5.1.1）、`metadata.lock.db`、`<repo>/.geoly-skills.lock.db`，**同一套机制** |
| 单例连接 | 🔴 `src/lock.mjs` **独占**这些 db 路径：禁止任何其他代码用 `fs.open/close` 打开它们。SQLite 自己协调同进程的多个 SQLite 连接，但 POSIX「关闭任一 fd 释放该进程全部锁」对**绕过 SQLite 的 fd** 仍然成立 |
| 取锁 | `BEGIN EXCLUSIVE`；`PRAGMA busy_timeout=0`（不等待） |
| 已被占用 | 报出持有者信息并退出（码 5）。**不判活、不接管、不等待** |
| 持有者信息 | 🔴 取锁后、**在外层事务内**写 `holder` 表，**不中途提交**（`COMMIT` 会提交外层事务并**释放锁**；`SAVEPOINT/RELEASE` 又不会让写入对其他连接可见 —— v7 写的「COMMIT 一次子事务」**不可实现**）。holder 在最终 `COMMIT + close` 时才发布 |
| 读持有者 | 读到的必然是**上一次完成者**留下的，因此明定为「**诊断信息，必然陈旧**」。🔴 **锁被占用只证明「有一个活持有者」，holder 里的 pid 不保证就是它** —— CLI 的报错措辞不得声称「pid X 正在跑」，只能说「上一次持锁的是 pid X」。诊断读连接读完立即关闭 |
| 释放 | `COMMIT` + `close` |
| 崩溃 | 内核释放。**下一次运行直接就能取到，不需要任何人工干预** |
| 🔴 **unlink** | **协议里没有任何一处 unlink 锁文件。** `--clear-lock` 整个删除 |
| `-wal` / `-shm` | **CLI 不手动删除它们**（但不承诺「永不存在变化」——SQLite 自己会 checkpoint、重建，或在最后一个连接关闭后移除）。🔴 **不得长期持有诊断读连接**，否则会造成 checkpoint starvation 与 WAL 无限增长 |

#### 代价（如实记）

1. 🔴 **Node 门槛从 ≥20 抬到 ≥22.13**（不是 22.12）。`DatabaseSync` 自 22.5.0 存在，
   但**到 22.12 为止仍需 `--experimental-sqlite` 启动开关**；22.13 起默认启用。
   CI 的锁集成测试必须同时跑**最低版本（22.13）与当前 LTS**。
2. `node:sqlite` 仍打 `ExperimentalWarning`。⚠️ **在适配层里抑制来不及** ——
   警告在模块导入时就发出。抑制必须发生在**任何 import 之前**（bin 入口的第一行装
   `process.removeAllListeners('warning')` + 自己的过滤器），或由 launcher re-exec 带
   `--no-warnings=ExperimentalWarning`。**M1 必须实测确认哪种有效。**
   全部用法仍封在 `src/lock.mjs` 一个薄适配层后面，配集成测试钉住行为。
3. SQLite 的锁在网络文件系统上不可靠 —— 与 §2.2 已有的「拒绝 NFS/SMB/FUSE」**正好对齐**，
   不构成新增限制。

#### 5.1.1 target 锁在 `<target>/.geoly/lock.db`

v7 放在 `<stage-parent>/.geoly-lock-<st_dev>-<st_ino>.db`，被 bind-alias 反例推翻（§3.1）：
target 的任何祖先都可以被重新挂载，「相邻位置」躲不掉。

v8：锁在 **`<target>/.geoly/lock.db`** —— 它是 target 自身的一部分，
任何别名路径打开的都是**同一个 inode**，因此必然是**同一把锁**。
`st_dev` / `st_ino` 命名也不再需要（跨容器 `st_dev` 本就不保证一致，用它命名反而会分裂）。

#### 加锁顺序（全序，防死锁）

```
metadata 锁（仅验证与推进 trust floor，用完立即释放）
  → repo 锁（仅项目级；保护 lockfile 重算与写入）
    → target 锁（多个时按 (st_dev, st_ino) 字节序升序）
```

**target 锁的取法**（v9 写实 —— v8 只说了排序，**没写去重**）：

1. 对每个目标 target 取 `(st_dev, st_ino)`；
2. 🔴 **按 `(st_dev, st_ino)` 去重** —— bind-alias 会让两个不同路径指向同一棵树，
   不去重就会对同一个 `lock.db` 开两次（`remove` / `recover` 等多 target 命令必踩）；
3. 🔴 去重后**仍按 `(st_dev, st_ino)` 排序**取锁 —— **不是按 realpath**。
   bind alias 下 realpath 不稳定，两个进程可能算出相反顺序而互相卡死。
   （v9 前文说按 `(st_dev, st_ino)`、后文又说按 realpath，自相矛盾，v10 统一为物理身份。）

🔴 **不得存在任何「先 target 后 repo」的路径。**
`busy_timeout=0`，因此不会形成等待型死锁，只会失败退出 —— 但全序仍必须遵守，
否则会出现「双方各持一半、都失败」的活锁式反复。

**每个命令的取锁表**（v7 补；未列出的命令不取任何锁）：

| 命令 | metadata | repo | target |
|---|---|---|---|
| `install` / `update`（全局） | ✓ 用完即放 | — | ✓ 全部目标，排序 |
| `install` / `update`（`--project`） | ✓ 用完即放 | ✓ | ✓ 全部目标，排序 |
| `remove` | — | ✓（项目级时） | ✓ 全部目标，排序 |
| `recover` | — | ✓（项目级时） | ✓ 全部目标，排序 |
| `sync-lock` | — | ✓ | — |
| `check` / `list` / `search` / `why` | ✓ 用完即放（仅需验签时） | — | — |

🔴 **后续取锁失败时，必须对已持有的锁逐一 `ROLLBACK` + `close` 再退出**，
不得带着半套锁做任何事。

🔴 **`recover` 的任一子操作成功后，也必须在 repo 锁下重算项目 lockfile**
（v7 只列了 install / update / remove 会触发重算，漏了 recover ——
rollback 之后账本变了，lockfile 却还是旧的）。

### 5.2 十步

| # | 动作 | 崩溃后 |
|---:|---|---|
| 1 | 取锁（§5.1） | 活持有者 → 报 pid 并退出 |
| 2 | 🔴 **三小步，顺序不可调换**（v21 更正 —— v20 把阈值归档排在「发现安装事务」之前，正好重新打开了「归档不得与安装事务交错」这个刚关上的洞）：<br>　**2a · 先清 audit intent**：扫 `<target>/.geoly/audit-archive-intent.json`。存在 → 按 §4 的归档协议**完成它，或 fail-closed 停机**。**绝不跳过、绝不删除。**<br>　**2b · 🔴 先认 repair intent，再看普通残留**（v23 更正 —— v22 把通用分支排在了 repair 前面，与「2b 必须先认 repair intent」自相矛盾）：<br>　　**2b-1** 存在 `repair-intent.json` → 进 §5.10 的状态机。<br>　　　· `recover --reinstall` → 按物理实况续做；<br>　　　· 其它命令 → **停机**，提示先跑 `recover --reinstall`；<br>　　　· `state = child_registered` 时，🔴 **只允许恢复 `child.generation` 那一个事务**，<br>　　　　与 child 无关的任何残留 → **fail-closed**。<br>　　**2b-2** 没有 repair intent 时，才走通用分支（两条独立线索：`ledger.transaction`；扫 `journal/` 未 `completed` 的记录与 `tx-*`）：<br>　　　· `phase = cleanup_pending` → 自动续做清理到 `completed`（§5.6）；<br>　　　· `phase = prepared`（含任一项 `corrupt`）→ 普通命令**停机提示 `recover`**；`recover` 自己进 §5.4/§5.4.1；<br>　　　· 有 tx 无 journal → pre-commit，直接删（§5.4.2 的双文件规则）。<br>　**2c · 确认已无未完成安装事务之后**，才做阈值归档：live 数 `> audit_max_entries` → 归档到 `== max`。<br>　完成 2c 才允许创建新的安装事务 | |
| 3 | 预检：**target 与 state 目录**的 fstype（§2.2）、**target 可写**（§3.4）、磁盘余量 ≥ 新制品解压后 × 2。🔴 stage/retired/attic 都在 `<target>/.geoly/` 内，**同设备天然成立**，不再需要 `st_dev` 比对 | 磁盘未动 |
| 4 | 下载、验 `asset.sha256`、隔离临时目录解包（§7）、**校验载荷 manifest 与 snapshot record 的六项（skill 七项）绑定**，期间持续检查空间 | 磁盘未动 |
| 5 | 建 `<target>/.geoly/tx-<gen>/{stage,retired}/`，把已验证的树放入 `stage/`（跨设备则复制 + fsync），**重算树摘要**；🔴 **逐层 fsync 整条新建目录链**（§5.2.1） | 清 tx 目录；generation 不复用 |
| 6 | 🔴 **提交点**：把 transaction 写入账本与 journal（各自原子写）。journal 必须含：generation、tx 目录、逐项 `op` / `had_old` / **`old_digest`（实测；🔴 repair-child 例外，继承期望值，见 §5.10）** / `new_digest` / `state: planned`，以及 🔴 **`ledger_image`** —— `{pre, post}` 两份镜像 + `ledger_existed` 哨兵（§5.4.2） | 此前崩溃 = **target 未被改动**（但 ledger 骨架 / journal 各自原子写，可能已有一份落盘 —— 按 §5.4.2 的双文件规则与 §11 的原子写口径处置，**不得笼统说「什么也没发生」**）|
| 7 | 逐项交换，见 §5.3 | 每项自己的状态独立持久化 |
| 8 | 对落位目录重算树摘要。符 → **持久化 `item.state = verified`**（fsync）。不符 → 该项 `state: corrupt`，transaction 保持非 null，**`retired/` 一律不动**，非零退出 | 旧树完好 |
| 9 | 更新 entries、`last_applied_generation`、每项 `state: done`；journal 置 **`cleanup_pending`**（不是 `completed` —— 清理还没做）；`transaction` 保留至清理结束。原子写 | 见 §5.4 的双文件规则 |
| 10 | **清理阶段**，有自己的可恢复协议，见 §5.6。释放锁 | 未完成的清理由下一次运行**自动续做**（§5.6 证明这是安全的） |

### 5.2.1 🔴 新建目录链必须逐层 fsync（v5 补）

v4 只 fsync 了 `stage/`、`retired/` 和 tx 根，**没有 fsync 它们上层新建的目录**。

反例（Codex 给的「两棵都丢」）：断电时 `target/<name>` 的**删除**已持久，
而 tx 根目录在 `<target>/.geoly/` 里的**目录项**未持久 ——
旧树在 `retired/`、新树在 `stage/`，**随着未持久的 tx 一起消失**。

规则：**任何新建的目录，创建后必须 fsync 它自己和它的父目录，一路到已存在的祖先为止。**
适用于 `<target>/.geoly/` 本身、`tx-<gen>/{stage,retired}` 链、`attic/<gen>/` 链。

### 5.3 🔴 逐项状态机（v4：每项独立，不再有全局 phase）

v3 用一个全局 phase 描述整个事务 —— **多项时根本描述不了**「A 已换、B 还没」。
v4 每一项在 journal 里有自己的 `state`，每次变更都是一次原子写 + fsync。

每一项在 journal 里记录 `op`，共三种：

| `op` | 含义 | 有 `stage/<name>` | 有 `retired/<name>` |
|---|---|---|---|
| `swap` | 旧目录换成新目录 | ✓ | ✓ |
| `install-new` | 目标原本不存在 | ✓ | ✗ |
| **`retire-only`** | 只退役、不装新的（`replaces` 退役另一个名字、pack 更新移除成员、`remove`） | ✗ | ✓ |

（v4 只建模了 `swap`，`replaces` 与 pack 移除成员根本执行不了 —— Codex 指出的第 4 条。）

`swap` 严格按此顺序：

```
② rename(target/<name>  →  <tx>/retired/<name>)       → fsync(target 目录) + fsync(retired 目录)
③ journal: item.state = retired                       → fsync
④ rename(<tx>/stage/<name>  →  target/<name>)         → fsync(target 目录) + fsync(stage 目录)
⑤ journal: item.state = swapped                       → fsync
```

🔴 **没有 `retiring` 这个 checkpoint。** v9 有，v10 的段模型取消了它，但 §5.3 里忘了删 ——
崩在那个 checkpoint 之后会落进一个 v10 不承认的状态。v11 统一：
`planned` 段直接覆盖「② rename + 两次 fsync」，靠幂等重跑处理中途崩溃。

`install-new` 跳过 ①–③，直接 ④。
`retire-only` 执行 ①–③ 后**直接进入 `verified`**（没有新树要验），不执行 ④–⑤。
（v8 写它「置 `swapped`」，而 §5.4 的枚举又说 `retire-only` 没有 `swapped` —— 自相矛盾，v9 统一为 `verified`。）

🔴 **两次 rename 之间崩溃是安全的**：target 上暂时没有该目录（D10 承认的「短暂读不到」），
但旧树完整躺在 `retired/`，新树完整躺在 `stage/`，**两份都在**。

### 5.4 恢复：幂等前向恢复（v10 换掉了 v6–v9 的「物理状态穷尽表」路线）

v5 只看三个位置。评审指出漏了最关键的第四个 —— **attic 里的 tar**：
`T=new, R=缺席, S=缺席` 被直接判成「清理已完成」却没验 A，
attic 缺失或损坏时既不能宣告完成、也不能承诺可 rollback。

#### 恢复的依据（v10 定稿）

v7–v9 一路在做「按物理状态穷尽列表」，v10 证明那条路走不通（下），
改为**幂等前向恢复**：journal 给段，段自己幂等。

#### 合法取值与持久化时点

| 字段 | 取值 | 何时持久化 |
|---|---|---|
| `journal.phase` | `prepared` → `cleanup_pending` → `completed` | 第 6 步 / 第 9 步 / 清理全部结束 |
| `item.state` | `planned` → `retired` → `swapped` → `verified` → `done`，外加终态 **`corrupt`**（🔴 **没有 `retiring`** —— v10 的段模型取消了它） | §5.3 的 ③⑤ 与第 8、9 步 |
| `item.cleanup` | 缺席 → `tar_durable` → `done` | §5.6 的 ④⑥ |

（v8 漏了 `corrupt` —— 它由第 8 步写入却不在枚举里。）

`op = install-new` 无 `retired`；`op = retire-only` 无 `swapped`，
它从 `retired` **直接进 `verified`**。

#### 🔴 v9 那条不变式是错的，整个「枚举物理状态」的路子也是错的（v10）

v9 写「任意两次相邻 journal 写之间恰好只发生一个文件系统操作」，并据此宣称三张表可证穷尽。
**不成立**，评审逐条驳倒且我复核属实：

| 反例 | 出处 |
|---|---|
| 一次 rename 后紧跟**两个**目录 fsync | §5.3 的 ②④ |
| `swapped → verified` 之间**没有任何写操作**，只有校验读 | 第 8 步 |
| 一次 checkpoint 内依次写 `.tmp`、校验、rename tar、多级 fsync | §5.6 ①–③ |
| `retired/<name>` 的递归删除本身是**多次**操作 | §5.6 ⑤ |

而且我自己的表里就有 `R=部分` —— 那等于承认「一个 state 对应大量物理中间态」，
与「两格穷尽」自相矛盾。

**病根不是表列得不够全，是「靠枚举物理状态来恢复」这条路本身走不通。**
物理中间态的数量随步骤组合爆炸，任何手工或半形式化的枚举都会漏。

#### v10：改用**幂等前向恢复**

崩溃恢复的标准解法，不需要枚举物理状态：

> 每个已持久化的 `state` 界定一个**段**（segment）。
> `--continue` = **把该段从头到尾幂等地重跑一遍**。
> 段里的每一步都写成幂等的，因此「重跑」对任何中间态都安全。

每一步的幂等写法（**规范强制**，实现不得偷懒）：

| 操作 | 幂等形式 |
|---|---|
| `rename(X → Y)` | 🔴 **两端都要验**（v10 只验 `Y`）：<br>① `Y` 存在且摘要 == 期望 **且 `X` 缺席** → 已完成，跳过；<br>② `Y` 存在且摘要符，**但 `X` 也存在** → 说明外部重建/替换过源，**停机 `corrupt`**（v10 会继续 rename 从而覆盖已正确的 `Y`）；<br>③ `Y` 缺席、`X` 存在且摘要 == 期望 → 执行；<br>④ `Y` 缺席、`X` 存在但摘要不符 → **停机 `corrupt`**；<br>⑤ 两者都不存在 → **停机 `corrupt`** |
| `fsync(dir)` | 天然幂等，重做无害 |
| 写 `.tmp` + rename | `.tmp` 残留一律先删再重写；目标已存在且摘要符 → 跳过 |
| `rmtree(D)` | `D` 不存在 → 跳过；存在（完整或部分）→ 继续删。天然幂等。🔴 **成功后必须 `fsync(parent(D))`** —— 适用于 cleanup 的 `retired/<name>`、rollback 的 `R`、`unpack/`、tx 与 attic 的清理，全部一视同仁。<br>🔴 **但「幂等」不等于「回滚安全」**：一旦进入 `cleanup=tar_durable`，`R` 可能已是部分树，**不得再对 `R` 做三方比对**，只重验 `A == old_digest` 再续删（§5.6、§5.4.1） |
| 校验摘要 | 纯读，天然幂等 |

于是恢复流程简化为两步：

1. 读 journal 拿到 `(op, state, cleanup)` → 定位当前段；
2. 从该段第一步开始幂等重跑；每完成一个段就推进 journal。

**不再需要**「T/R/S/A 四位置的穷尽表」。三张表在 v10 里降级为
**段的定义与顺序**（下），不是物理状态的判定依据。

#### 段的定义

| `op` | 段序列 |
|---|---|
| `swap` | `planned` →〔② rename T→R；fsync ×2〕→ `retired` →〔④ rename S→T；fsync ×2〕→ `swapped` →〔第 8 步校验〕→ `verified` →〔第 9 步写账本〕→ `done` →〔§5.6 清理段〕→ cleanup `done` |
| `install-new` | `planned` →〔④ rename S→T；fsync ×2〕→ `swapped` →〔第 8 步〕→ `verified` →〔第 9 步〕→ `done` →〔清理段是空操作〕→ cleanup `done` |
| `retire-only` | `planned` →〔② rename T→R；fsync ×2〕→ `retired` → **`verified`**（无新树可验）→〔第 9 步〕→ `done` →〔清理段〕→ cleanup `done` |

（v9 的 `retiring` 中间态取消 —— 幂等重跑不需要它。`item.state` 枚举收为
`planned` / `retired` / `swapped` / `verified` / `done` / `corrupt`。）

#### 只有这些情况判 `corrupt`

- 五分支幂等规则里的 ②（`Y` 正确但 `X` 也在）、④（`X` 摘要不符）、⑤（两端都不存在）；
- 校验摘要与 journal 记录不符；
- journal 自身 CRC 失败或缺失（但**有 tx 无 journal** 是 pre-commit，允许直接删，见 §5.4.2）。

#### 🔴 I/O 失败的统一规则（v10 补）

- **任何 `fsync` 失败 → 立即停机，不推进 journal，不把它当成功。**
  重启后按当前段幂等重跑，`rename` 已生效的会被规则 ① 跳过。
- **journal 原子写失败留下的 `.tmp`**：恢复时一律**忽略并删除**
  （journal 的权威副本是那个已 rename 到位的文件；`.tmp` 按定义未提交）。
- 部分写：journal 有 `crc32c` 自校验，校验失败即 `corrupt` 停机（§11）。

#### 5.4.1 `--rollback`：**自己也是一个有 journal 的方向**（v10 重写）

v9 只做了「发现任何 `corrupt` 就拒绝」的入场检查，**没有把 rollback 自己做成可恢复事务**。

评审的反例：`swap` 停在 `swapped`（物理 `T=new, R=old, S=∅`）。
rollback 先做 `T→S` 然后崩溃，物理变成 `T=∅, R=old, S=new` ——
而 journal 仍写着 `swapped`。这个组合在**正向**语义里恰好是「`retired`、④ 未做」，
于是下一次会**按正向继续**，把刚回滚掉的又装回去。

v10：rollback 是 journal 里的一个**方向**，与正向共用同一套幂等纪律。

```
① journal: direction = "rollback"，记下逐项的反向段计划        → fsync
② 按 name 字节序逐项执行反向段，每完成一段推进该项子状态       → fsync
③ 收尾（顺序见本节末「终结顺序」）
```

- 🔴 **`direction = rollback` 一旦持久化，恢复只能续做 rollback，不得转回正向。**
- rollback 自身崩溃 → 下一次 `recover` 读到 `direction = rollback`，从当前项的反向段幂等重跑。
- 入场检查保留：任一项 `corrupt` → **整个事务不允许 rollback**，报告是哪一项。

🔴 **回滚入场的第一条铁律**（v35）：
**绝不从正向的 `item.state` 推断物理位置。**
正向 `planned` 段本身就覆盖了 `T→R`，断电完全可以留下
`state=planned, T=∅, R=old, S=new` —— 把它当成「什么都没发生」会**丢掉旧树**。

因此入场时对每一项**先实测 T / R / S**，据此归类，
并把归类结果作为 `rollback.items[*]` 的**严格 schema 字段持久化**
**写完再动手**。恢复时以持久化的这两个字段 + 实测物理为准。

#### 🔴 journal 的 `rollback` 正式 schema（v37 —— v36 只写进了台账，**没写进规范正文**）

```json
"direction": "rollback",
"rollback": {
  "items": {
    "<name>": {
      "entry_class": "noop" | "as-retired" | "as-retired-cleaned"
                   | "as-swapped" | "as-swapped-cleaned" | "as-installed",
      "rstate":      "pending" | "t_parked" | "restored"
    }
  }
}
```

| 规则 | |
|---|---|
| iff | 🔴 `direction` 与 `rollback` **同时存在或同时缺席**；只有其一 → `corrupt` |
| `rollback.items` | **必填**；**可以为空 `{}`**（`logical-only` 的空 items 事务）；🔴 **键集严格等于 `journal.items` ∪ `adopt_assertions` ∪ `unadopt_assertions` 的键集**，多一个少一个都 `corrupt` |
| 每项字段 | `entry_class`、`rstate` **都必填**，取值用上面的**全枚举**（v36 的正文还写着旧的三值枚举，漏了三个新值） |
| 组合与迁移 | 必须落在「入场分类封闭表」的合法组合与合法迁移内，否则 `corrupt` |
| 🔴 终结 | 完成时**同一次原子写删除 `direction` 与 `rollback` 两者** —— v36 的终结步骤只写了「清 `direction`」 |

#### 🔴 入场分类的封闭表（v36）

对每一项**实测 T / R / S / A**，查下表得到 `entry_class`、初始 `rstate`、是否 park `T`、恢复源。
🔴 **`direction = rollback` 与全部 `entry_class` / 初始 `rstate` 必须在同一次原子写里落盘**，
写完才允许动手。🔴 **正向 `item.state` 只用于一致性校验，不参与本表的判定。**

**`op = swap`**（回滚目标 = 旧树回到 `T`）：

| 实测 (T, R, S, A) | `entry_class` | 初始 `rstate` | park `T` | 恢复源 |
|---|---|---|---|---|
| `(old, ∅, new, *)` | `noop` | `restored` | 否 | — |
| `(∅, old, new, *)` | `as-retired` | `pending` | 否 | `R` |
| `(new, old, ∅, *)` | `as-swapped` | `pending` | **是** | `R` |
| `(new, 部分\|∅, ∅, old)` | `as-swapped-cleaned` | `pending` | **是** | `A` |
| 其它 | — | — | — | 🔴 `corrupt` |

**`op = retire-only`**（回滚目标 = 旧树回到 `T`）：

| 实测 (T, R, A) | `entry_class` | 初始 `rstate` | park `T` | 恢复源 |
|---|---|---|---|---|
| `(old, ∅, *)` | `noop` | `restored` | 否 | — |
| `(∅, old, *)` | `as-retired` | `pending` | 否 | `R` |
| `(∅, 部分\|∅, old)` | `as-retired-cleaned` | `pending` | 否 | `A` |
| 其它 | — | — | — | 🔴 `corrupt` |

**`op = install-new`**（回滚目标 = **无树**）：

| 实测 `T` | `entry_class` | 初始 `rstate` | park `T` | 恢复源 |
|---|---|---|---|---|
| `∅` | `noop` | `restored` | 否 | — |
| `new` | `as-installed` | `pending` | **是**（park 到 `undo/`） | — |
| 其它 | — | — | — | 🔴 `corrupt` |

**`adopt` 项**（v41 补入场分类，v42 补 `assertion-corrupt` 分支）：

| `adopt_assertions[*].state` | 实测 `T` | `entry_class` | 初始 `rstate` | park `T` | 恢复源 |
|---|---|---|---|---|---|
| `ok` | == 断言的 digest | `noop` | `restored` | 否 | — |
| `ok` | 其它 | — | — | — | 🔴 `corrupt` |
| 🔴 `assertion-corrupt` | **任意（不检查 `T`）** | `noop` | `restored` | 否 | — |

**`unadopt` 项**（v43 补 —— v42 只把它加进了 manifest 执行表，其余四处都漏了）：

| `unadopt_assertions[*].state` | 实测 `T` | `entry_class` | 初始 `rstate` | park `T` | 恢复源 |
|---|---|---|---|---|---|
| `ok` | == 断言的 digest | `noop` | `restored` | 否 | — |
| `ok` | 其它 | — | — | — | 🔴 `corrupt` |
| 🔴 `assertion-corrupt` | 任意 | — | — | — | 🔴 **不允许 rollback**（只能 `--continue` 或人工，见通用规则） |

🔴 **`assertion-corrupt` 时不检查 `T`**（v42 修）—— v41 一处承诺「`assertion-corrupt` 允许 rollback」，
而入场表只让 `T == digest` 走 `noop`，于是断言失败后回滚**恰好落进「其它 → `corrupt`」被拒**，
**自己承诺、自己堵死**。

它复用 `noop / restored`：**无 park、无恢复源、无物理动作** ——
回滚只按过滤后的 `ledger_delta` 撤销账本认领，目录原样留在 target。

**合法迁移**（其余一律 `corrupt`）：

```
noop                              : restored（终态）
as-retired / as-retired-cleaned   : pending → restored
as-swapped / as-swapped-cleaned   : pending → t_parked → restored
as-installed                      : pending → restored
```

🔴 **`rstate` 与 `entry_class` 不冗余**：前者是**回滚进度**，后者是**入场物理分类**。
但两者必须同时存在且落在上表的合法组合内 —— 任一缺失、或组合未列 → **`corrupt`**（§11「未定义即拒绝」）。

**入场预检**（在持久化 `direction=rollback` **之前**全部做完）：

对每一项判定「恢复源」是 `R` 还是 `A`，然后：

| 检查 | 规则 |
|---|---|
| 选 `A` 的项 | `A` 存在且 `A == old_digest` |
| 🔴 选 `R` 的项 | **`R` 存在且 `R == old_digest`**（v11 只验了 `A`，漏了这一支） |
| 🔴 `swap` 的两个摘要 | **禁止 `old_digest == new_digest`** —— 否则「`T==new` 要 park」与「`T==old` 不 park」两条规则无优先级、判不出来。结构门在生成 plan 时即拒绝这种物理 `swap`。<br>⚠️ **但普通规划必须留一条出口**，见 §4.2 的「逐字节相同」分支 —— 否则这条禁令会把合法的 `--replace` 截断 |
| 🔴 要被移走的 `T` | **按实测判定，不看正向 `state`**；🔴 **最终以「入场分类封闭表」的 `park T` 列为准**（v35 立了铁律却没改这一条 —— 它仍写「`state` 已越过首次 rename」，于是 `swap/planned` 实际已落到 `T=new` 时**会漏掉对 `T` 的入场校验**）：<br>　实测 `T` 存在且 == `new_digest` → 需要 park，校验通过；<br>　实测 `T` 存在但 == `old_digest` → 不需要 park（`T→R` 确未做）；<br>　实测 `T` 存在且**两者都不是** → `corrupt`；<br>　实测 `T` 缺席 → 不需要 park |
| 任一不满足 | **拒绝整个 rollback**，不写 `direction` —— 否则会把一个注定做不完的回滚**锁死在 rollback 方向** |

🔴 **预检不能保证「世界不会变」。** target 锁只约束遵守该锁的 CLI，不约束用户与其它进程。
预检只保证「写 `direction` 的那一刻不存在已知死路」；
**每一次真正的 rename、以及任何会毁掉恢复源的动作，都必须在动作点复验并 fail-closed。**

**逐项反向段：🔴 以 `entry_class` + `rstate` 调度，正向 `state` 不参与**（v37 落实铁律 ——
v36 的反向执行表仍在按 `state = planned` 分支，与「正向 state 只做一致性校验」自相矛盾）：

| `entry_class` | 子操作序列 |
|---|---|
| `noop` | 无动作（入场即 `restored`） |
| `as-retired` | ① `R → T`，置 `restored` |
| `as-retired-cleaned` | ① 验 `A` → 解到 `<tx>/unpack/<name>` 并验 → 替换 `R`；② `R → T`，置 `restored` |
| `as-swapped` | ① `T → <tx>/stage`，置 `t_parked`；② `R → T`，置 `restored` |
| `as-swapped-cleaned` | ① 验 `A` → 解到 `unpack` 并验 → 替换 `R`；② `T → <tx>/stage`，置 `t_parked`；③ `R → T`，置 `restored` |
| `as-installed` | ① `T → <tx>/undo/<name>`，置 `restored` |
| 🔴 **adopt 项**（`noop`） | 无物理动作；账本侧由 `unadopt` 撤销认领 |
| 🔴 **unadopt 项**（`noop`） | 无物理动作；账本侧重新认领（**仅 `state = ok` 时可进入**） |

🔴 **`(op, 正向 state, cleanup, entry_class)` 的闭合一致性矩阵**（只做校验，不做调度；
未列组合即 `corrupt`）—— v37 只给了 `op → entry_class`，**实现不了 fail-closed 校验**：

**`op = swap`**

| 正向 `state` | `cleanup` | 允许的 `entry_class` |
|---|---|---|
| `planned` | — | `noop`（`T→R` 未做）、`as-retired`（已做、journal 未跟上） |
| `retired` | — | `as-retired`、`as-swapped`（④ 已做、journal 未跟上） |
| `swapped` / `verified` | — | `as-swapped` |
| `done` | 缺席 | `as-swapped` |
| `done` | 🔴 `tar_durable` | **`as-swapped`** 或 **`as-swapped-cleaned`** —— `tar_durable` 是 checkpoint，**递归删除发生在它之后**，所以此刻 `retired/` 可能仍是完整旧树、也可能已被删到部分或空。v38 只允许 cleaned，**与清理协议矛盾** |
| `done` | `done` | `as-swapped-cleaned` |

**`op = retire-only`**

| 正向 `state` | `cleanup` | 允许的 `entry_class` |
|---|---|---|
| `planned` | — | `noop`、`as-retired` |
| `retired` / `verified` | — | `as-retired` |
| `done` | 缺席 | `as-retired` |
| `done` | 🔴 `tar_durable` | **`as-retired`** 或 **`as-retired-cleaned`**（同上：删除在 checkpoint 之后） |
| `done` | `done` | `as-retired-cleaned` |

**`op = install-new`**

| 正向 `state` | `cleanup` | 允许的 `entry_class` |
|---|---|---|
| `planned` | 缺席 | `noop`（④ 未做）、`as-installed`（已做、journal 未跟上） |
| `swapped` / `verified` | 缺席 | `as-installed` |
| `done` | 🔴 缺席 / `tar_durable` / `done` **三种都合法** | `as-installed` |

🔴 `install-new` **也要有 `cleanup` 维度**（v38 漏了）：它没有旧树，§5.6 对它是空操作，
但 `cleanup` 字段本身仍会依次经过缺席 → `tar_durable` → `done`。
既然规定「未列即 `corrupt`」，这三种就必须**显式列出**；
其余 state 只允许 `cleanup` 缺席。

**`adopt` / `unadopt` 项**（不在 `journal.items` 里，无正向 `state` / `cleanup`）

| 逻辑项 | `state` | 允许的 `entry_class` |
|---|---|---|
| `adopt` | `ok`（`T` == 断言 digest） | `noop` |
| `adopt` | `assertion-corrupt` | `noop`（不检查 `T`） |
| `unadopt` | `ok`（`T` == 断言 digest） | `noop` |
| 🔴 `unadopt` | `assertion-corrupt` | **无** —— 不进入 rollback（见通用规则） |

（`state = corrupt` 不在表内 —— 入场检查已规定**任一项 `corrupt` 则整个事务不允许 rollback**。）

正向 `state` 与 `entry_class` 的关系**只用于发现现场异常**，不得用来决定动作。

**恢复时按 `rstate` 定位**：`pending` → 从该 `entry_class` 的第一个子操作起幂等重跑；
`t_parked` → 从其 `R → T` 那一步起；`restored` → 跳过该项。
五分支的幂等规则在**每个子操作内部**仍然适用（每个子操作只有一次 rename）。

**终结顺序**（全部项 `restored` 之后，每步 fsync；本身也要可崩溃续做）：

```
① 🔴 删除**本代**的 attic/<gen>/ 与其 manifest
     —— 阶段 B 之后回滚时，manifest 已经写出来了；不删它就会留下一个
        看起来「已完成」的 generation，之后被 --from-generation 误用
② 分两种情况写账本：
     ledger_existed = true  → 按 ledger_image.pre 做 patch，并置 transaction = null
     ledger_existed = false → 🔴 删除整个 ledger.json
        **例外**：存在 live audit / `audit-archive/` / audit intent / `audit_archived_until > 0`
        时**不删**，改写一份例外账本 —— **只清空 entries/roots/transaction，
        audit plane 原样保留**（见 §4 的 audit plane）
③ 在 repo 锁下重算 lockfile（账本已删时 = 从投影里移除该 target）
④ 清理 <tx>/undo/、<tx>/unpack/ 与整个 tx 目录
⑤ journal: 🔴 **同一次原子写删除 `direction` 与 `rollback` 两者**，phase = completed；随后按常规清掉 completed journal
```

（generation 水位无需处理 —— 它在独立文件里、只增不减，见 §4.1。）

🔴 **`install-new` 的反向不得在 target 内递归删除。**
v9 写「删除 T」，**直接违反 §5.7 的「事务内无递归删除」**，还会留下半棵 target 树。

#### 5.4.2 🔴 `ledger_image` 契约（v10 统一）

```json
"ledger_image": {
  "ledger_existed": true,
  "pre":  { "entries": { "<name>": {…} | null }, "roots": { "<key>": {…} | null },
            "last_applied_generation": 17 },
  "post": { "entries": { "<name>": {…} | null }, "roots": { "<key>": {…} | null },
            "last_applied_generation": 18,
            "audit_append": [ {…事件…} ] }        // 🔴 安装事务的 post 里**只有**这一个 audit 字段；
                                                  //    audit_archived_until 不在此处（见 §4）
}
```

| 规则 | |
|---|---|
| 覆盖范围 | 本次会**增 / 改 / 删**的每一个 `entries` / `roots` 键。「原本不存在」或「本次删除」用 `null` 哨兵，与「值为空对象」区分 |
| 🔴 **patch 语义** | 「按 `post` 写」= 对这些键做**原子 patch**，**未列出的键一律保持不变**。不是整文件替换 —— 否则 journal 权威时重建不出完整账本 |
| 🔴 **bootstrap** | `ledger_existed: false` = 首次安装、账本文件原本**不存在**。rollback 按 `pre` 复位的动作是**删除整个 `ledger.json`**，不是写一个空账本（v9 只有字段级镜像，没有这个哨兵） |
| `transaction` | 🔴 **不进镜像**，由恢复流程按结果置。v9 的 `post` 示例里写了 `transaction: null`，与正文冲突，已删 |
| 🔴 取号水位 | 永不进镜像、永不取自镜像（进镜像的是 `last_applied_generation`，那是已应用值，不是水位）。（v11 那条「必须在删 tx/attic 之前扫描并持久化」已作废 —— v12 起水位在独立文件里，不再扫描目录，见 §4.1） |
| 🔴 **`frozen_attic`** | 在镜像覆盖范围内，且**按整张 map 存取**（不是逐 label patch）。`--freeze-attic` 与本次 attic 的产生必须**原子关联** —— 冻结记录进 `post`，回滚时随 `pre` 一并撤销。<br>⚠️ v15 的 delta 是整字段 patch、postimage 却只比「相关 label」：G1 改 alpha、G2 改 beta，复位 G1 能通过 alpha 比对，**却用 G1 的旧整图覆盖掉 beta**。定为**全量存、全量比**即可消除 |
| 🔴 **bootstrap 协议** | 首次安装必须**先成功写出 ledger 骨架，再写 journal**。骨架内容（🔴 **并在同一步持久化 `<target>/.geoly/audit-seq = 0`**，见 §4 的 audit-seq 生命周期）：`schema` / `target` / 空 `entries` / 空 `roots` / 🔴 **`last_applied_generation: 0`**（**不是** `generation` —— 与水位同名会被重新诱导成「从账本取号」，也与严格 schema 冲突）/ 空 `audit` / `audit_archived_until: 0` / 🔴 **`transaction: null`**。🔴 **ledger 骨架与 `audit-seq` 是两份各自原子的文件，不是一次跨文件原子操作**（v21 更正 —— v20 那句「骨架写失败时磁盘上什么都没发生」不精确）。写入顺序与部分成功的处置：<br>　① 先写 `audit-seq = 0`（若尚不存在）→ fsync。🔴 **失败即停机；不得声称「磁盘未变」** —— 原子写在 rename 之后、父目录 fsync 报错时，文件**可能已经存在**。下次若读到**合法** seq 则沿用、**绝不重置**；非法则 fail-closed；<br>　② 再写 ledger 骨架 → fsync。失败 → 停机（同样不得声称「磁盘未变」），此时至少**留下一个孤立的 `audit-seq`** —— 这是 §4 明确承认的**合法状态**（「无 ledger 但有 seq」），下次沿用、不重置、**不删除**。<br>🔴 **`ledger_existed` 表示的是「本次事务开始之前」的状态**，不因本次写出的骨架而改变 —— 否则 rollback 会把一个本该删掉的骨架当成「原本就有的账本」保留下来。<br>🔴 **「骨架已写、journal 尚未写」**：recover 时视为 **pre-commit** —— 骨架里 `entries` / `roots` 皆空且 `transaction: null`，删掉它与残留 tx 即可（也可保留为正式空账本，但规范选**删除**，以免留下语义含混的空壳）。<br>🔴 **但 `audit-seq` 不删** —— 它一旦建立就永不删除（§4）。因此「已有 audit-seq 而无 ledger」是一个**合法状态**，下次 bootstrap 直接沿用该 seq，不重置为 0 |

旧名 `ledger_preimage` 在 §5.2 与 09 里的残留已全部改为 `ledger_image`。

#### 通用规则

- 🔴 触发**物理 `item.state = corrupt`** 的只有「只有这些情况判 `corrupt`」一节列出的那几条；命中即停机，报告相关位置的实际摘要，交人处理。
- **物理 `corrupt`**（即 `journal.items[*].state = corrupt`）的处置：**只有 `--reinstall` 或人工介入**。
  🔴 本节及下文所有泛称的「`corrupt` 不可 rollback」**都只指物理 `corrupt`**；逻辑断言异常见下表。
- 🔴 **`assertion-corrupt` 不是物理 `corrupt`，两者分流**（v42）：

  | 情形 | `--rollback` | `--continue` | `--reinstall` | 处置 |
  |---|---|---|---|---|
  | `journal.items[*].state = corrupt`（物理） | 🔴 拒绝 | 🔴 **拒绝** | 可用 | `--reinstall` 或人工 |
  | `adopt_assertions[*].state = assertion-corrupt` | ✅ **允许** | 🔴 拒绝 | 🔴 拒绝整个自动 repair | 入场 `noop/restored`、不检查 `T`、不动目录；账本按过滤后的 `ledger_delta` **撤销**认领 |
  | 🔴 `unadopt_assertions[*].state = assertion-corrupt` | 🔴 拒绝 | ✅ **允许**（唯一自动出路） | 🔴 拒绝 | 严格复验成功后转回 `ok` 并继续，否则走人工出口 |

  🔴 **为什么 `unadopt` 的失败不能照抄 `adopt`（v43 —— v42 让两者共用一套规则是错的）**：
  `adopt` 的 rollback 是**撤销**认领，断言失效也安全；
  而 `unadopt` 的 rollback 是**恢复**受管 entry —— 目录此刻已经变了，
  照做会让**账本错误认领一棵非制品目录**。两者的安全性**方向相反**。

  🔴 **`unadopt` 的 `assertion-corrupt` 的人工出口**（v44 —— v43 只写了「否则人工」，
  那不是可执行的出路）：

  | 出路 | 做法 |
  |---|---|
  | ✅ **首选：自动** | 把该目录**严格恢复为断言的 `D`**（逐字节 + 结构与元数据约束），再跑 `recover --continue` —— 复验成功即把 `state` 转回 `ok` 并继续 |
  | 人工 A | 🔴 **保留现场**：存在时，**`repair-intent`、journal、tx、账本记录、`quarantine/`** 一律不动，打包留存后请人处理 |
  | 人工 B | 恢复**一份完整一致的 `.geoly` 状态集 + 目标树** |
  | 人工 C | **整体迁走该 target、新建空 target 重装** —— 🔴 明确**放弃本地 audit** |
  | 🔴 禁止 | **单独删除 `repair-intent`、journal、tx、账本记录或 `quarantine/` 中的任何一样来「解锁」** —— 那正好丢掉判断依据 |

  🔴 **混合异常的命令级优先级**（写死，消除 v42 的歧义）：

  | 命令 | 规则 |
  |---|---|
  | `--rollback` | 只要存在**物理 `corrupt`** → 直接拒绝；只存在 `adopt` 的 assertion-corrupt → 允许；存在 `unadopt` 的 assertion-corrupt → 拒绝 |
  | `--reinstall` | 只要存在**任一** assertion-corrupt → **不自动执行**；此时物理项也只能转人工 |

- 🔴 **`state` 的字段契约**：必填，初值 **`ok`**；合法迁移 **`ok → assertion-corrupt`**；
  **`assertion-corrupt → ok` 仅在严格复验成功时允许**（`--continue` 的唯一出路）。
  （v5 有一处又允许 `--rollback`，与本节冲突，已统一为不允许。）
- 🔴 `--rollback` 是**全事务**语义（§5.4.1）：任一项**物理 `item.state = corrupt`** → 整个事务不允许回滚。
  `--continue` 可以逐项推进，但只要有项停在**物理 `corrupt`**，整体退出码非零。
- **同一事务内计划项的 `name` 必须唯一**（结构门 + 运行时都查）。

#### ledger 与 journal 只写成功一个时（v6 补）

第 6 步与第 9 步都要写两个文件，可能只成功一个。**journal 是权威**：

| ledger | journal | 判定 |
|---|---|---|
| `transaction = null` | 未完成 | journal 权威 → 按表恢复 |
| `transaction ≠ null` | `completed` / `cleanup_pending` | journal 权威 → 按 journal 走；ledger 在收尾时被修正 |
| `transaction ≠ null` | **不存在** | 🔴 **pre-commit**：第 6 步之前崩溃，target 未动 → 允许直接删 tx 与该 transaction 记录 |
| `transaction = null` | 不存在，但磁盘有 `<target>/.geoly/tx-*` | pre-commit，允许直接删该 tx（结构上可证明未动 target）。<br>🔴 **例外**：若存在 `repair-intent.json` 且其 `tx_dir` 指向该 tx → **绝不按 pre-commit 处理**，改走 §5.10（`--reinstall` 会制造出「有 tx 无 journal」这个形状，但那个 tx 可能已经换过目标树） |

（v5 让「扫到 tx 就停机」，而第 5 步与第 6 步之间崩溃根本没有 journal 可判 —— 死路。）

### 5.5 `recover`

按 §5.4 逐项判定，给出 `--continue` / `--rollback` 两个明确选项。**不自动选、不猜。**
🔴 **物理 `corrupt`** 只能 `--reinstall` 或人工介入，不允许 `--rollback`（全文统一）。
逻辑断言异常（`assertion-corrupt`）另有分流规则，见 §5.4 的「通用规则」。
不同项可以处在不同 state，`recover` 会逐项报告并统一按用户选的方向处理。

### 5.6 🔴 清理是独立的、可恢复的协议（v5 补）

v4 的第 10 步「打 tar、删 retired、删 tx」没有任何顺序约束 —— 崩在打包或删除中
就可能丢掉唯一那份旧备份；而第 2 步又刻意忽略 `completed` 的 journal，
**没人负责续做未完成的清理**。

v5 给它一个自己的 phase 与顺序。journal 在事务第 9 步之后写 `phase: cleanup_pending`，
逐项按此执行：

🔴 **三阶段（v12 重写，v13 更正措辞）** —— v11 是逐项 ①…⑥，于是第一份 tar durable 之后就要写 manifest，
而 manifest 要记录整代所有 item，此时后续 tar 还不存在；等全部 tar 都有了再写，
又没有 checkpoint 阻止恢复逻辑先去删 retired。**这个两难只能靠分阶段解开。**

🔴 **adopt 与 unadopt 两类逻辑项都不参与 A / C**（没有旧树、也没有 `retired/`），**只在 B 阶段进 manifest**。

```
【阶段 A · 全部 tar 先落地，一棵 retired 都不删】
  逐项：
    ① 写 attic/<gen>/<name>.tar.tmp                  → fsync(tar 文件)
    ② 🔴 三方比对：tar 内容 == retired/<name>/ == journal 的 old_digest
       任一不符 → 停机，不删任何东西
    ③ rename(.tar.tmp → .tar)                        → fsync(attic/<gen>) → fsync 父链
    ④ journal: item.cleanup = tar_durable            → fsync
  （op = install-new 没有旧树，跳过 ①–④ 直接置 tar_durable，
    manifest 里记为 "tar": null）

【阶段 B · 全部 tar 都 durable 之后，写整代 manifest】
    ⑤ 写 attic/<gen>/manifest.json（覆盖**全部** op）  → fsync → fsync(attic/<gen>)
    ⑥ journal: manifest = durable                      → fsync
    🔴 **在 ⑥ 落盘之前，不允许删除任何 retired 树。**

【阶段 C · 才允许删】
  逐项：
    ⑦ 递归删除 retired/<name>/                        → fsync(retired 目录)
    ⑧ journal: item.cleanup = done                    → fsync
```

崩在 A/B → 重跑（tar 与 manifest 的写入都幂等）；崩在 C → 续删。
**任何时刻都不会出现「retired 已删而 manifest 未持久」的 generation**，
因此不会留下无法 `--from-generation` 的代。

全部项 `done` 后：删空的 tx 目录 → 按保留代数清理旧 attic → journal `phase: completed` → 释放锁。

**为什么可以由下一次运行自动续做**（逐段论证，v6 收紧）：

| 阶段 | 完整副本在哪 |
|---|---|
| 阶段 A 的 ①–③ 之间 | `retired/<name>/` 完整 |
| ③ 的 `fsync(attic 及父链)` 成功之后 | **A（tar）完整**，且已在 ② 逐文件验证过 |
| 阶段 C 的 ⑦ 递归删除期间 | **A 是唯一但完整的副本** |
| ⑧ 之后 | A |

因此「任何时刻旧树至少有一份完整副本」成立，续做只前进不毁东西。

🔴 **`old_digest` 的来源必须是「首次 rename 之前的实测值」**（v7 补）：

- 第 6 步写 transaction 时，对**即将退役的目录**实测摘要，作为 `old_digest` 持久化；
  🔴 **例外：repair 的 child 事务不实测，继承 `plan.items[*].old_digest`**（§5.10）；
- 🔴 **§5.3 的 ② 真正 rename 之前再实测一次并比对** —— 第 6 步与第 7 步之间用户可能改了 target。
  不符 → 停机（不是静默采用新值）；
- `--replace` 的**未被账本认领**的目录同样要实测（账本里没有它的期望值）；
- 清理前验 `R == old_digest`；tar 写完验 `A == old_digest`。

v6 的第 ② 步只验「tar == retired」——两者可能**一起是错的**（例如中途被外部改写），
自动续做就会把一个错误副本固化成唯一备份。

🔴 **三条前提，缺一不可**：

1. **崩在 checkpoint 之前，必须从磁盘重验 A 的摘要，不能只信 journal。**
   journal 说 `tar_durable` 而磁盘上 A 损坏 → 判 `corrupt` 停机。
2. **每一次 `fsync` 失败都必须 fail-closed**（不吞错、不继续）。
   §5.2.1 的目录链 fsync 同此要求。
3. **自动清理只在 `journal.phase = cleanup_pending` 之后进入**；更早的阶段必须先完成
   第 8 步的验证与第 9 步的账本更新，不得直接跳进清理。
4. 🔴 **`--replace` 的未认领旧目录**：它不受 artifact 的路径/文件类型规则约束
   （可能含 symlink、非白名单 mode、超长路径、非 ASCII 名）。规则：

   | 情况 | 动作 |
   |---|---|
   | 旧树满足 §01 的载荷规则 | 正常走 retirement + canonical tar |
   | 旧树**不满足** | 🔴 **预检直接拒绝 `--replace`**，报明违规项，要求用户自己移走 |

   不为它定义第二套 retired-tree 格式 —— 多一套格式就多一套要维护的解包与校验路径。

5. **保留代数清理或 `--keep-generations 0` 之后，不再承诺 old 仍存在** ——
   此时表一最后一行如实报「不可 rollback」。迁移期的 `--freeze-attic` 是例外
   （[`08-matrix-migration.md`](08-matrix-migration.md) §5.1）。

这与 §5.1 不冲突：那里说的是**不接管别的活进程的锁**，
而续做清理发生在已经合法取到 SQLite 排他锁之后，全程单一执行者。

第 2 步的规则相应改为：

| 发现 | 动作 |
|---|---|
| `journal.phase = prepared` 且尚有 item 未到 `done` | 停机，提示 `recover`（🔴 `planned…verified` 是 **item.state**，不是 journal phase —— v11 这里写错了） |
| 有 tx 目录但**没有 journal** | pre-commit，可直接删（§5.4 双文件规则） |
| **`phase = cleanup_pending`** | **自动续做清理到 `completed`**，然后继续本次安装 |
| `phase = completed` 的残留 | 直接清掉残留目录 |

清理全部完成后才写 `phase: completed` 并把 `ledger.transaction` 置 `null`。

### 5.7 交换语义的真实承诺（D10）

- ✅ **不会读到半棵树**：两次都是整棵目录的原子 `rename`，事务内无递归删除
  （递归删除只出现在 §5.6 的清理阶段，而那时删的是 `retired/`，不在 target 里）；
- ⚠️ **可能短暂读不到**：② 与 ④ 之间，通常毫秒级；
- ❌ 不承诺「要么旧要么新」。需 Linux `renameat2(RENAME_EXCHANGE)` /
  macOS `renamex_np(RENAME_SWAP)`，Node 无内建绑定，不值得为它加编译依赖。

### 5.8 事务已 `completed` 之后的复位（v10 补）

§5.4.1 的 rollback 只适用于**未 `completed`** 的事务。事务收尾之后要退回旧版，
走另一条路 —— 它不是回滚，是**一次新的正向事务**：

```
recover --rollback --from-generation <N>
```

🔴 **v10 的这条不可实现**：事务收尾后 tx 与 `completed` journal 都被清掉了，
「该 generation 记录」压根不存在 —— 光有一个 tar，既拿不到 `old_digest`，
更恢复不了对应的 `entries` / `roots` / `snapshot` / refcount。

v11 补一份**每代 manifest**，与 attic 同生共死：

```
<target>/.geoly/attic/<N>/manifest.json     ← 原子写 + fsync，与 tar 同一次清理协议
```

```json
{ "schema": "geoly.skills.attic-manifest/1",
  "generation": 17, "created_at": "…",
  "items": {
    "<name>": { "op": "swap" | "retire-only" | "install-new" | "adopt" | "unadopt",
                "tar": "<name>.tar" | null,          // install-new / adopt / unadopt → null
                "old_digest": "geoly-tree-v1:sha256:…" | null,
                "reverse_op": "swap" | "install-new" | "retire-only" | "unadopt" | "adopt" }
  },
  "ledger_delta": {                                   // 🔴 是 delta，不是完整账本
    "entries": { "<name>": {…复位后应有的值…} | null },
    "roots":   { "<key>":  {…} | null },
    "frozen_attic": {…全量 map…} | null
  },
  "postimage": {                                      // 🔴 复位前的三方比对基准
    "entries": {…本代收尾时这些键的值…},
    "roots":   {…},
    "in_edges": { "<name>": ["<root-key>", …] },
    "out_edges": { "<root-key>": ["<name>", …] },
    "digests": { "<name>": {"present": true, "digest": "geoly-tree-v1:sha256:…"} },
    "frozen_attic": {…全量 map…} | null
  } }
```

| 规则 | |
|---|---|
| 🔴 **`ledger_delta` 是增量不是全量** | v11 写「完整 entries/roots」—— 那样复位一个**较旧**的 generation 会把之后各代的无关变更一并抹掉。改为只记本代动过的键（`null` = 复位后应不存在） |
| 🔴 **同时记 `postimage`，复位时做三方冲突检查** | **光有 delta 不安全。** 反例：G1 装了 direct root `D → a`；G2 又新增 pack root `P → a`。复位 G1 时，delta 会把 `entries.a` 置空、删掉 `D`，却**保留 `P`** —— `P` 成了悬挂 root，而 `reverse_op = retire-only` 还会把 `a` 移走。`--only` 的「本代闭包」限制挡不住**后续代新增的共享 root**。<br>因此 manifest 还要记本代收尾时的 **`postimage`**，并按 §5.8.1 的形式化定义做三方比对。**绝不把 delta 盲 patch 到当前账本上。** |
| 🔴 `frozen_attic` | 纳入 delta（v11 漏了） |
| 🔴 **`reverse_op`** | 复位时该项要执行的**正向 op**，不是「一律按 swap」（v11 说「按普通 swap 走」不成立）：<br>原 `swap` → 复位仍是 `swap`（装回旧树）<br>原 `retire-only` → 复位是 **`install-new`**（把退役掉的装回来，target 上此刻没有它）<br>原 `install-new` → 复位是 **`retire-only`**（把当初新增的退役掉，**没有 tar 可用**，靠 retirement rename）<br>🔴 原 `adopt` → 复位是 **`unadopt`**（只撤销认领，**不动目录**）<br>🔴 原 `unadopt` → 复位是 **`adopt`**（重新认领，同样不动目录） |
| 清理 | manifest 与该代全部 tar **一起**删，不单独留 |

- manifest 在 §5.6 的 ③ 之后、⑤ 之前写入并 fsync（此时 tar 已持久且已验）；
- 保留代数清理时 manifest 与 tar **一起**删，不单独留；
- `recover --rollback --from-generation <N>` 的执行：
  ① 读 manifest → ② 按 §5.8.1 做 `postimage` 三方比对（不过即拒绝）→
  ③ 开一个**新的正向事务**，**逐项按各自的 `reverse_op`**（🔴 **不是「一律按普通 swap」** ——
  v13 同一页里一处这么写、一处又定义了 `reverse_op`，自相矛盾）：

  | 本代原 `op` | `reverse_op` | 这一项怎么做 |
  |---|---|---|
  | `adopt` | `unadopt` | 只按过滤后的 `ledger_delta` 撤销认领，**无物理动作** |
  | `unadopt` | `adopt` | 重新认领，**无物理动作**。字段来源见下 |

  🔴 **`unadopt → adopt` 的字段映射与等式**（v43 —— v42 只写「重新认领并复验」，不可实现）：

  | 项 | 规则 |
  |---|---|
  | 该 unadopt 代的 `postimage` | `entries[name]` **缺席**（表示当时应不存在）、相关边已撤销、但 🔴 `digests[name] = {"present":true,"digest":D}` |
  | 比对 | 先按该 `postimage` 做**完整三方比对**（§5.8.1） |
  | 新事务 | 建 `adopt_assertions[name]`：<br>　`artifact` 取自 🔴 **`ledger_delta.entries[name].artifact`**<br>　`tree_digest` 必须 **== 该 entry 的 digest**，且 **== `postimage` 的 `D`**<br>　🔴 **不得取 `old_digest`** —— 它在 unadopt manifest 里是 `null` |
  | 复验 | 写 post 前、每次重放前，都再验目录仍为 `D` |
  | 新一代 manifest 的 `postimage` | 记「entry 已恢复、目录仍为 `D`」 |
  | `swap` | `swap` | 解 `tar` 到 `stage/` 验 `== old_digest`，走 swap |
  | `retire-only` | **`install-new`** | 解 `tar` 到 `stage/` 验，target 上此刻没有它 → 走 install-new |
  | `install-new` | **`retire-only`** | 🔴 **`tar = null`，没有可解的东西** → 走 retirement rename 把它退役掉 |

  ④ 收尾时把 `ledger_delta` 作为该新事务 `ledger_image.post` 的一部分提交。

🔴 **空 `items` 的情形**（v30 补 —— v29 只说了 repair child 可以空）：
若某代 manifest 的 `items` 为空（纯账本变更那一代），`--from-generation` 同样
**创建一个普通的、`items: {}` 的 ledger-only 事务**：
没有物理动作，`reverse_op` 是**空的物理操作序列**（不是某个新取值）；
做完 postimage 校验后直接提交 `ledger_delta`，
🔴 **并照常写本代的 manifest**（否则这一代又变得不可复位）。

因此它同样受幂等纪律保护。**它不是回滚，是一次新的正向事务。**

`<N>` 不存在、manifest 缺失或 tar 已被保留代数清掉 → 如实报「不可复位」，并说明缺哪一样。

🔴 **`--from-generation` 豁免当前状态门。** 它复位的是**本机曾经装过、且有本地备份**的东西，
不是从 registry 新装 —— [`05-lifecycle.md`](05-lifecycle.md) §5 已承诺「已装的 yanked 制品仍能
rollback、取证」，若在这里再卡状态门就与那条冲突。
但**必须大声告警**，并按 §4 的 `audit` 字段把「复位到了一个当前已 yanked / degraded 的版本」
（离线时则是 `restored-state-unknown`）写进对应 entry。

🔴 **复位范围**：`--from-generation <N>` 影响该 manifest `items` 里的**全部**条目。

`--only <name>` 🔴 **只允许选出一个完整、且与未选项不共享 root 的闭包**：
若 `<name>` 属于某个 pack root，而该 root 的其它成员也在本代 items 里却没被选中，
**直接拒绝** —— 否则会写出一个 root 与成员不闭合的账本（`requested_by` 指向一个
成员集合已经不对的 root）。拒绝时列出「要一起选的还有哪些」。

#### 5.8.1 🔴 `postimage` 的形式化定义与比对（v14）

v13 只说「受影响闭包」，**没定义闭包，也没定义比较投影** —— 于是评审的反例仍会漏过去：
G1 的 `a` 若被**之后新增**的 root `P → a` 引用，只过滤「G1 当时记录的 root」是看不见 `P` 的。

🔴 **基线必须固定在「第 N 代收尾那一刻」，不能是「复位时算出来的集合」**（v15 修正）。

v14 把「当前账本里任何指向 touched_entries 的 root」写进 `touched_roots`，
然后要求 `postimage` 记录每个 touched root 的值 —— **时间上不可能**：
G1 收尾时 `P` 还不存在，manifest 没法预先存下 `postimage.roots.P = null`。

**第 N 代收尾时固定下来的基线**：

```
E_N = names(本代 items)  ∪  🔴 keys(本代 ledger_delta.entries)
R_N = keys(本代 ledger_delta.roots)  ∪  **当时**指向 E_N 的全部 root
```

🔴 **`E_N` 必须并上 `ledger_delta.entries` 的键**（v15 只取物理 items）——
有些变更**只改账本引用、不做物理交换**（pack 的 `requested_by` 增减就是，见
[`03-packs.md`](03-packs.md) §4.1）。漏掉它们的话：之后给那个 entry 加了 root，
再复位第 N 代，会**把后来的 root 抹掉而比对不报错**。

`in_edges`、`digests`、以及 §5.8 的 `--only` 选择域，**一律用这个 `E_N`**。

`postimage` 存：

| 项 | 内容 |
|---|---|
| `entries[k]`（k ∈ E_N） | 当时的账本值，或 `null` 表示「当时应不存在」 |
| `roots[k]`（k ∈ R_N） | 同上 |
| `in_edges[k]`（k ∈ E_N） | 🔴 该 entry **当时的完整入边集**（`requested_by` 的全部元素） |
| `out_edges[k]`（k ∈ R_N） | 该 root 当时的完整出边集 |
| `frozen_attic` | 🔴 **整张 map 的全量值**（不是「相关 label」）|
| `digests[name]`（name ∈ E_N） | `{"present":true,"digest":…}` 或 `{"present":false}` |

**复位时的比对**：把**当前**账本按同样的键集算一遍，逐项相等才放行。

后来新增的 `P → a` **不需要**预存 `roots.P` —— 它会以
「`a` 的当前入边集比 `in_edges[a]` 多了一条 `P`」的形式被抓住并拒绝。

🔴 **二部图约束（写进规范）**：当前账本的引用关系**只有 `root → entry`**
（引用只存在于 entry 的 `requested_by`，root 没有指向 root 的字段）。
因此不存在 root→root 的传递漏项。**若将来允许 root→root，本节必须改为不动点闭包。**

⚠️ **保守性说明**：全入边/出边比对不会因无关变更误报，
但会**保守拒绝**「某个原先引用 `a` 的 root 后来改去引用 `b`」这类后续图变更。
这是可接受的安全保守性 —— 有更近的 manifest 就先逆序复位，否则人工处理。

**比对不过**：报冲突并列出**具体的键 / 边**，以及仍有 manifest 的更近 generation（若有）。
🔴 「先复位更近的代」只是**条件提示，不是承诺**：更近的 manifest 可能已被保留策略删掉，
或冲突来自人工改动 —— 那时如实报告需要人工处理。

**提交方式**：比对通过后，把 **过滤后的** delta 作为这次新正向事务
`ledger_image.post` 的一部分提交（§5.4.2），走完整事务纪律 —— 不是模糊的「收尾 patch」。

🔴 **`--only` 必须同时过滤 delta**（v14 只过滤了 items，提交时却写「完整 `ledger_delta`」——
那会让 `--only a` 改到没被选中的条目）：

闭包定义在**第 N 代收尾时的 `E_N` / `R_N` 二部图**上（不是「当前」，也不是 `items`）：

```
seed        = 用户 --only 选中的 name（必须 ⊆ E_N）
closure     = 在 E_N/R_N 图上从 seed 出发的连通分量
              （entry ←→ 其 in_edges 里的 root ←→ 该 root 的 out_edges 里的 entry，取不动点）
selected_entries = closure ∩ E_N
selected_roots   = closure ∩ R_N
selected_items   = selected_entries 中**有物理项**的那些（即出现在本代 items 里的）
selected_delta   = ledger_delta 中键落在 selected_entries ∪ selected_roots 内的部分
```

🔴 若 `closure` 未把某个 `R_N` 里 root 的**全部** out_edges 纳入 —— 即闭包不完整 ——
**拒绝**，并列出「要一起选的还有哪些」。

**CLI 语义**（v17 澄清 —— v16 的单数 flag 与「列出还要一起选哪些」自相矛盾）：

- `--only` **可重复**：`--only a --only b …`；
- CLI **不自动扩张**到整个连通分量，而是**拒绝并把完整分量列出来**，
  由用户原样再提交一次。理由：部分复位是危险操作，「你以为只动 a、实际动了七个」不可接受；
- ⚠️ **允许的退化**：pack/root 连接密集时，连通分量可能**就是整代** ——
  那时 `--only` 等价于不加它。这是预期行为，如实提示；
- root 指向 `E_N` 之外的成员时**必然拒绝**（闭包无法在本代内闭合），同样如实说明。
（v15 以 `items` 为基础且没说 `unselected` 的全集是什么，会漏掉「仅 refcount 改动」的 pack 成员，
重新形成部分 root 图。）

🔴 **只要本代 `ledger_delta.frozen_attic` 有变化，就禁止部分复位** ——
`frozen_attic` 是 target 级的、切不开。此时要求选择整代，或拒绝。

`audit` 的追加同样进这次事务的 `ledger_image.post`（见 §4 的 `audit`）。

#### `--freeze-attic` 的表示（v10 补）

v8/v9 只有 flag 与迁移叙述，没定它存在哪。v10：

- 账本顶层 `frozen_attic: { "<label>": [<generation>, …] }`；
- 保留代数清理时**跳过**任何出现在其中的 generation；
- `recover --release-frozen <label>` 删除该 label 的条目，被释放的 generation
  在**下一次**清理时才按保留代数处理（不立即删，留一次反悔机会）。

### 5.9 `--reset-generation <N>`（v14 补 —— v13 提了这个开关却没定义）

只用于「水位文件缺失、而 target 里已有 hub 管理内容」这一种情形。契约：

| 规则 | |
|---|---|
| 前置 | 🔴 **仅当 `<target>/.geoly/generation` 缺失时可用**；存在即拒绝 |
| 锁 | 全程持 target 锁（§5.1） |
| 🔴 **前置：ledger 必须存在且可解析** | v16 要求把 `history_unproven` 写进 `ledger.json`，而 §4.1 又把 `attic/` / `audit-archive/` 也算作「已有 hub 状态」—— **ledger 已丢而这些证据仍在时，既无处写标记、也无法重建账本**。定为：**ledger 缺失或损坏 → 拒绝 reset**，且**不得自动重建**。两条出路必须在报错里写清楚：<br>　① **人工恢复** = 恢复**同一份一致的 `.geoly` 状态集**（ledger + journal + attic + audit 全套），
🔴 **不是**凭 archive 手工拼一个 ledger 出来；<br>　② **放弃恢复** = **移走整个 target 后重装**（不是只移走 ledger）——
🔴 这会**放弃本地 audit**，必须明示 |
| 拦截 | 存在 `journal/`、`tx-*`（未完成安装事务）、`audit-archive-intent.json`（未完成归档），或 🔴 **`repair-intent.json`**（未完成 repair）→ **先拒绝**，要求先 `recover` |
| `<N>` | 严格十进制整数，**必须高于当前所有可观察到的 generation**。🔴 **可观察集合是全部这些**（v14 只数了 attic 与账本，漏了三处）：<br>　`attic/<gen>/` 与 🔴 **`quarantine/<gen>/`** 的编号<br>　账本顶层 `last_applied_generation`<br>　🔴 每个 `entries[*].generation`<br>　🔴 `journal/<gen>.json` 的文件名与其内部 `generation`（**即使是 completed 的、不阻塞 reset，也要参与下界计算**）<br>　🔴 `tx-<gen>/` 的编号<br>　🔴 `frozen_attic` 里引用到的全部 generation<br>并且 `N + 1` 必须仍是 §11 允许的整数（≤ 2^53−1），否则拒绝 |
| 语义 | 写入的是**水位值**；下一次取号得到 `N+1` |
| 🔴 诚实边界 | 若磁盘上**没有任何状态证据**，只能承认「**历史已不可证明**」，让用户自己选一个足够大的 `N`。**不得声称此后仍然保持「不复用」** |
| 🔴 **持久标记与顺序** | 在账本里写 `history_unproven: true`，**只增不撤**。<br>🔴 **顺序不可颠倒：先原子写并 fsync 标记，再写 generation 水位。**<br>v15 没定顺序 —— 先写水位、崩在标记之前，后续运行会**看到水位却不知道历史不可证明**。<br>reset 本身设计为**可重试**：标记已在、水位未写 → 重跑即可 |
| `--from-generation` 是否还能用 | 🔴 **仍然可以**。只要目标 manifest、tar 与 postimage 都在，它们**自身**就足以证明那一次复位是可执行的 —— 不依赖 generation 编号的历史完整性。但输出必须带降级告警 |

### 5.10 🔴 `--reinstall` 的 repair intent（v22 补）

v21 只写了「消除/隔离 corrupt 安装事务」这句话，**背后没有任何持久状态**。

**致命路径**（评审给的）：`--reinstall` 先删/移走 corrupt journal，隔离尚未完成就崩溃 →
下次启动看到 `tx-*` **无 journal** → 按 §5.4.2 的「pre-commit、target 未动」**直接删掉**。
但那个 tx **可能已经交换过目标树**，而 `corrupt` 本来就包含 journal CRC 损坏的情形 ——
于是**「必须重装/清理哪些目录」这个事实被丢掉了**，后续命令还会以为可以创建新事务。

根因：**我那条「有 tx 无 journal = pre-commit」的规则本身没错，
但 `--reinstall` 自己会制造出这个形状**，把一个危险状态伪装成安全状态。

#### 协议（v23 重写为完整的外层事务）

`<target>/.geoly/repair-intent.json`（canonical、原子写，schema `geoly.skills.repair-intent/1`）：

```json
{ "schema": "geoly.skills.repair-intent/1",
  "repair_id": "0f3c…",                    // 🔴 不可变标识，child journal 要带它
  "generation": 17,

  "isolate": {                             // 🔴 四项各自带**可验证身份**
    "tx":      { "dir": "tx-17",           "fingerprint": "geoly-tx-v1:sha256:…" },
    "journal": { "path": "journal/17.json","digest": "sha256:…" },
    "ledger_transaction": { "digest": "sha256:…" },   // 旧 transaction 值的 canonical 摘要
    "targets": { "<name>": { "observed": "geoly-tree-v1:sha256:…" } }
  },

  "plan": {
    "snapshot": 42,
    "items": { "<name>": { "…": "字段定义见下方「plan 的正式字段」" } },
    "repair_ledger_image": {              // 🔴 v25：不是模糊的 baseline
      "closure_entries": ["<name>", …],   // 闭包的 key 集，显式列出
      "closure_roots":   ["<key>", …],
      "pre":  { "entries": { "<name>": {…} }, "roots": { "<key>": {…} } },
      "post": { "entries": { "<name>": {…} }, "roots": { "<key>": {…} } }
    }
  },

  "child": { "generation": 18, "tx_dir": "tx-18", "committed": true },
  "state": "planned" | "isolated" | "child_registered" | "child_done" | "done",
  "created_at": "…" }
```

🔴 **`child` 与 `repair_ledger_image` 内各 map 的缺席一律用「字段缺席」表达，不用 `null`**
（v23 用了 `null`，而它们不在 §11 的白名单里 —— **规范会拒绝自己的 repair-intent**）。

🔴 **`isolate.targets[*].observed` 记的是「实际观测到的指纹」，不是 plan 里的期望摘要** ——
被隔离的 corrupt target **本来就不该匹配期望值**，拿期望值去验它是逻辑错误（v23 的错）。

#### 🔴 `tx.fingerprint` 的定义（v30 —— v29 只给了字段名）

🔴 **不能直接复用 `geoly-tree-v1`**（v30 的做法）：那个算法**只覆盖文件叶子**，
而制品**禁止空目录**、tx 的 `stage/` 与 `retired/` **恰恰可以是空的** ——
空目录被删掉，摘要一模一样，「精确匹配」就不成立。

**定义 `geoly-tx-v1`**：在 `geoly-tree-v1` 的基础上**把规范化的目录项也纳入摘要**。

```
file-entry = "f" || 0x00 || path || 0x00 || mode || 0x00 || lower_hex(leaf)
dir-entry  = "d" || 0x00 || path || 0x00 || mode          ← 🔴 目录也进摘要（含空目录）

排序键 = (path_bytes, kind)，升序；kind 序 "d" < "f"
digest  = SHA256( "geoly-tx-v1\n" || Σ (entry || "\n") )
```

记为 `geoly-tx-v1:sha256:<hex>`。

| 项 | 规定 |
|---|---|
| 枚举范围 | 🔴 **tx 根目录本身 + 其下全部目录 + 全部普通文件**。根目录以 `path = ""` 的 `dir-entry` 计入 —— v32 把根排除在外，于是**改根目录的 mode 摘要不变** |
| 目录 mode | 必须**已经**是 `0755`；不符 → **无法成像**。⚠️ 这是**判据**，不是动作 —— **绝不对隔离证据执行 chmod** |
| 文件 mode | `0644` / `0755`，同 §01 |
| 🔴 **`nlink` 检查只针对普通文件** | 普通文件 `nlink != 1` → 拒绝（hardlink）。<br>⚠️ **绝不对目录做这个检查** —— Linux 上正常目录的 link count 本来就 > 1，v32 那句「一律拒绝 `nlink != 1`」会让**每一个正常的 tx 都无法成像** |
| 🔴 一律拒绝 | socket、FIFO、设备、symlink、其它任何类型 |
| 🔴 一律拒绝 | 重复路径；同一相对路径同时是文件与目录 |
| 🔴 **未覆盖的元数据** | xattr / ACL **不进摘要**，因此**一律拒绝**：任一条目（含根目录）带 xattr 或 ACL → **无法成像**。与 §01-6.2 同一原则 |
| 实现 | 与 `geoly-tree-v1` **复用同一个模块**（同一套 path 规范化与 leaf 编码），只是域分离前缀与覆盖面不同 |

🔴 **身份等价类**（v34 把结论也说准）：
`geoly-tx-v1` 唯一确定的是 **「路径 × 条目类型 × mode × 文件内容」** 这个等价类。
在该等价类内，除 SHA-256 碰撞外不存在两棵不同的树同摘要。

等价类**之外**的属性分两类，**不能笼统说「要么规范化、要么拒绝」**（v33 的说法不成立）：

| 属性 | 处置 |
|---|---|
| xattr、ACL | 🔴 **拒绝**（带它们即无法成像） |
| 目录 mode | 🔴 必须**已满足** `0755`，否则无法成像（**不是**对证据执行 chmod） |
| 普通文件的 hardlink | 🔴 **拒绝**（`nlink != 1`） |
| **时间戳、inode 号、所有者/属组、生成计数等** | ⚠️ **既不规范化、也不拒绝 —— 它们只是不参与这个等价类**，因此**摘要相同不代表这些属性相同** |

| 项 | 规定 |
|---|---|
| 覆盖范围 | `tx-<gen>/` 下**全部普通文件**，含 `stage/` 与 `retired/` 的整棵内容 |
| 路径规范化 | 相对 `tx-<gen>/` 的 POSIX 路径，其余同 §01-4 |
| 打开方式 | 🔴 **`lstat` / dirfd 无跟随**；遇 symlink、设备、FIFO 一律**无法成像** |
| 🔴 无法成像时 | **不写 intent、转人工** —— 成不了像就没有等价类可比，不得用「大概是它」继续 |
| 可重验 | 隔离前后各算一次，必须相等 |

#### 隔离的范围（四样，缺一不可）

| 对象 | 处置 |
|---|---|
| `tx-<gen>/` | rename 进 `quarantine/<gen>/tx/` |
| `journal/<gen>.json` | rename 进 `quarantine/<gen>/journal.json` |
| `ledger.transaction` | 置 `null`（🔴 只改这一个键，用 §11 的 patch 语义，保证 `entries` / `roots` / audit plane / `frozen_attic` / `last_applied_generation` 不被覆盖或漂移） |
| 🔴 因自身 corrupt 而不可信的 target 树 | rename 进 `quarantine/<gen>/targets/<name>/` —— 若 corrupt 的原因就是目标树本身，不隔离它就无从重建 |

#### 六步与逐崩溃点

```
① 枚举完整 plan（见下）        —— 枚举不出 → 拒绝，转人工
② 写 intent（`state=planned`，字段集见下方「两段式」表 —— `target` / `old_digest` /
   `plan.snapshot` / `repair_ledger_image` / `isolate.*` 四项身份）→ fsync
③ 隔离上表四项                 → 每次 rename 后 fsync 两侧父目录
   （创建 quarantine/<gen>/ 链同样逐层 fsync，见 §5.2.1）
④ 原子写：`state=isolated`，**同次**补入各项的 `cur`、`child_op`
   **以及条件必填的完整 `restore_from`** → fsync
⑤ 登记 child：先写 child{generation,tx_dir,committed:false} 与 state=child_registered
   → fsync，**然后**才创建那个新事务
⑥ child 完成并通过最终重验 → state=child_done → state=done → 删 intent → fsync 父目录
```

🔴 **恢复一律按「物理实况」定位，不按 `state` 断言** —— `state=planned` **不代表**
「tx 还在原处」（崩在 ③ 的 rename 之后、④ 之前时那句话就是错的）。

**三个 rename 项**（`tx` / `journal` / 每棵 `targets[*]`）按各自 intent 里记的身份验：

| 观测 | 处置 |
|---|---|
| 原位置**落入记录的等价类**（tx 用 `geoly-tx-v1`、journal 用其摘要、target 树用观测指纹）、隔离位置不存在 | 续做该项 rename |
| 隔离位置**落入记录的等价类**、原位置不存在 | 该项已完成，跳过 |
| 🔴 两边都在 / 两边都不在 / 任一处存在但**不落入记录的等价类** | `corrupt` 停机 |

**第四项 `ledger.transaction`** 不是 rename，单独定：

| 观测 | 处置 |
|---|---|
| 值的 canonical 摘要 == `isolate.ledger_transaction.digest` | 尚未清空 → 置 `null` |
| 已是 `null` | 已完成，跳过 |
| 🔴 既不匹配、也不是 `null` | `corrupt` 停机（有第三方改过账本） |

🔴 **进入 `isolated` 之前必须重验四项全部到位**（三处已在隔离位置且落入记录的等价类、
`transaction` 已为 `null`），缺一不可；并在同一次原子写里补入 `cur` / `child_op`（§时序）。

#### 🔴 同事务绑定

分别核验摘要**不够**，还必须验证这四项确实属于**同一个事务**：

- `tx` 目录名、`journal` 文件名、`ledger.transaction` 里记的 generation，
  三者**必须都等于 `intent.generation`**；
- `journal` 的内容必须与该 `tx` 对应（journal 里的 `tx_dir` == 实际隔离的那个）；
- 任一不一致 → **`corrupt` 停机**（现场混进了别的代的残留）。

#### `repair_ledger_image`（v26 定死计算时点、闭包与物化规则）

`closure_entries` / `closure_roots` **显式列出 key 集**，于是两种缺席可区分：
「不在闭包」= 不在数组里；「应不存在」= 在数组里但 `pre`/`post` 中该键缺席。

🔴 **但它与普通 `ledger_image` 不是同一套 patch 规则**（v25 说「同一套」是错的）：

| | 普通 `ledger_image` | `repair_ledger_image` |
|---|---|---|
| 键缺席 | 「**不 patch**」 | 「**应不存在**」（仅当该键在 closure 内） |
| 删键 | `null` 哨兵 | 靠「在 closure 内 + map 里缺席」表达 |

**物化规则**（消除两套语义的落差）：生成 child 的普通 `ledger_image` 时 ——

- closure 内、**`pre` 或 `post` 里缺席**的键 → 各自物化成普通 image 的 **`null` 哨兵**。
  🔴 v26 只规定了 `post` —— 但 closure 内 `pre` 缺席也必须物化为 `null`，
  否则 child 的 `ledger_image.pre` **表达不出「此键应不存在」**，
  与「`pre` 精确等于隔离后投影」自相矛盾；
- closure 内、存在的键 → 照值写；
- 🔴 **closure 外的键一律不出现在 child 的 image 里**（严格保持不变）；
- 🔴 **`repair-intent` 文件自身仍用「字段缺席」，不写 `null`** —— `null` 只出现在
  由它**物化出来的** child `ledger_image` 里。

**计算时点与图**：

- 🔴 **在 repair 第 ① 步、任何隔离动作之前**计算并持久化；
- 输入 = **原 journal 的 `ledger_image`（pre 与 post 的并集）+ 当前 ledger**；
- 在 **root ↔ entry 二部图**上，从受影响 seed 取**不动点闭包**；
- 🔴 与 §5.8.1 的 `E_N / R_N` **不冲突但要分清**：那是**某个已完成 generation 的历史基线**；
  repair closure 是**此刻**算出来的现场闭包。

**校验**：
🔴 **当前账本在 closure 上的投影必须精确等于 `repair_ledger_image.pre`**，否则 `corrupt` 停机。
child 的 `ledger_image.pre` **必须等于「隔离完成之后」的实际账本投影**（不是 repair 的 pre），
`post` 是**唯一的最终投影**。

🔴 **「投影」的正式定义**（v28 —— v27 只用了这个词）：

```
proj(ledger) = { "entries": { k: ledger.entries[k]  for k ∈ closure_entries },
                 "roots":   { k: ledger.roots[k]    for k ∈ closure_roots  } }
（键不存在时该项缺席；物化进普通 image 时缺席 → null 哨兵）
```

🔴 **普通 image 里那两个非 closure 字段另有来源，不属于 repair image**：
`last_applied_generation` 与**整张** `frozen_attic` **一律从「隔离后的账本」取值**。
不得笼统地说「整个 image 等于 repair image」。

#### 🔴 child 计划的键：「当前实况 × 目标断言」（v27 重写）

v25 用「原 op × 是否隔离」，v26 改成「`phys × ledg`」—— **两次都不够**。
根因：我一直在用「**原来发生了什么**」推「**现在该做什么**」，
而唯一能唯一决定动作的是「**现在是什么 × 应该变成什么**」。

评审的反例：原 `retire-only`、旧树已隔离、账本 `pre` ——
**目标终态应该是「无树」**，而 v26 的表给了 `install-new`。

**两个量，各自有权威来源**（v28 定死 —— v27 只给了名字）：

```
target ∈ { {"present":false}, {"present":true,"digest":D} }
cur    ∈ { absent, old_digest, target_digest, other }
```

🔴 **`target` 的导出**：repair 第 ① 步，从**有效的原 journal 意图 + 已验签的 snapshot** 导出，
并与 `repair_ledger_image.post.entries[name]` **严格对应** ——
该 entry 缺席 → `{present:false}`；存在 → `{present:true, digest: 其 tree_digest}`。
两者不一致即 `corrupt`。

🔴 **`cur` 的取值域是封闭的四个**，不是「任意 digest」（v27 的 `C` 是任意值，
而 `other` 又定义成「非旧非新」—— **实现根本分不出来**）：

- `old_digest` 取自**原 journal item 已验证的值**；
- `target_digest` 即上面的 `D`；
- 其余任何完整树、部分树、读不出摘要 → **`other` → `corrupt`**。

🔴 **`restore_from` 的精确定位与验法**（v30 写实）：

| `source` | 定位方式 | 验法 |
|---|---|---|
| `registry` | `plan.snapshot` 指向的**已验签快照**里的 record，其 `id == restore_from.artifact` | 走 §02-6 的完整验证链（验签 → 资产 sha256 → 解包重算树摘要） |
| `attic/<gen>` | 该代 manifest 的 `items[<name>].tar`，且 manifest 的 `old_digest` == `restore_from.tree_digest` | 解包后重算 == `tree_digest` |
| `quarantine` | `quarantine/<gen>/targets/<name>/`，其观测指纹 == `isolate.targets[<name>].observed` | 落位后重算 == `tree_digest` |
| 🔴 **`quarantine-tx`** | 见下方专段 | 见下方专段 |

四种来源共同要求：🔴 `restore_from.tree_digest` **必须 == `target.digest`**，
且**实际落位后重算摘要必须等于该值**；任一不符 → `corrupt`。

#### 🔴 `quarantine-tx` 是**只读恢复介质**，不是「重新启用被隔离的 tx」（v32 收紧）

v31 允许从隔离区取用，却没规定能不能**移动**它 ——
那会松动「quarantine 不自动删除、保留证据」这条语义。v32 定死：

| 项 | 规定 |
|---|---|
| 定位 | `restore_from.slot ∈ { "stage", "retired", "undo" }`，🔴 路径 = `quarantine/<repair-intent.generation>/tx/<slot>/<name>`。<br>⚠️ **用的是 `repair-intent.generation`，不是「当前 repair generation」，更不是 `child.generation`** —— 后两者与它不同（v32 的措辞含混） |
| 🔴 **slot 的候选与判定**（v34 重写） | 见下方「候选槽表」。<br>🔴 **两步制**：先由 journal 状态**枚举候选槽**，再**用实测摘要定生死** —— 候选槽的实测值必须 == `target.digest`，**不能只信状态** |
| 取用方式 | 🔴 **无跟随复制**到 child 的 `stage/`。**禁止 rename、禁止 hardlink、禁止以任何方式修改 quarantine 内容** |
| 🔴 校验（**五次，编号如下** —— v33 写「五次」却只给了四个编号） | **①a** 复制前：该候选 slot 的实测摘要 == `target.digest`；<br>**①b** 复制前：隔离 tx 的 `geoly-tx-v1` 指纹 == `isolate.tx.fingerprint`；<br>**②** 复制后：**再验一次**隔离 tx 的指纹（后验能发现持续性篡改）；<br>**③** stage 完成后：除摘要外 🔴 **重跑目标树的完整结构校验** —— 目录、**空目录**、类型、mode、路径约束，🔴 **外加「拒绝类元数据」：无 xattr / 无 ACL、普通文件 `nlink == 1`**（v34 漏了这三项：复制后被注入 ACL/xattr 或外部 hardlink 仍能通过；①b/② 验的是**源 tx** 的指纹，**替代不了目标树检查**）。<br>　⚠️ **不比较、不规范化**时间戳 / inode / 属主属组 —— 它们不参与等价类；<br>**④** 最终落位后：同 ③。<br>⚠️ **为什么摘要不够**：复制途中给源加一个**空目录**，`geoly-tree-v1` 不覆盖目录，stage 与最终 target 可能仍是同一摘要，**却已违反「制品禁止空目录」**。<br>⚠️ **瞬时改写无法由普通递归复制完全证明** —— 但 ③ 的结构校验足以阻止错误树落位 |

#### 候选槽表（v34 —— v33 的三行既不全、三元组也不足以判定）

v33 的表被评审驳了三处，都成立：

- 正向 `swap + state=retired` 时，**`stage` 里仍是新树、`retired` 里是旧树，两个槽同时有效**；
  v33 只允许后者，于是当 repair 的目标是**原事务 postimage** 时，
  **恰好把唯一需要的那个槽拒掉了**；
- 回滚中的 `swap`，`stage` 是否装着新树**取决于反向子状态**（`t_parked` / `restored` 时是），
  仅靠 `direction` / `op` / 原 `item.state` **区分不了**；
- 回滚 `install-new` 的 `restored` 行**过宽**：原项仍是 `planned` 时新树在 `stage`，**不在 `undo`**。

**先定 repair 的目标方向**（决定期望摘要取哪个）：

| 原 journal 的 `direction` | repair 的目标 | 期望摘要 |
|---|---|---|
| 缺席（正向） | 原事务的 **postimage** | 该项的 `new_digest`（`retire-only` 则为「无树」） |
| `rollback` | 回滚的 **preimage** | 该项的 `old_digest`（`install-new` 则为「无树」） |

🔴 **`slot` 的 `old/new_digest` 必须与上表选定的目标一致**，否则不允许用这个 source。

**候选槽**（按 `direction` × `op` × `item.state` / 反向子状态 × `cleanup`）：

| direction | op | state / 子状态 | cleanup | 候选槽 |
|---|---|---|---|---|
| 正向 | `swap` | `planned` | — | `stage`(new) |
| 正向 | `swap` | `retired` | — | 🔴 **`stage`(new) + `retired`(old)，两个都候选** |
| 正向 | `swap` | `swapped` / `verified` / `done` | 缺席 或 `tar_durable` | `retired`(old) |
| 正向 | `swap` | `done` | `done` | —（retired 已删，改用 `attic/<gen>`） |
| 正向 | `install-new` | `planned` | — | `stage`(new) |
| 正向 | `install-new` | `swapped` 及以后 | — | —（新树已在 target） |
| 正向 | `retire-only` | `retired` 及以后 | 缺席 或 `tar_durable` | `retired`(old) |
| `rollback` | 🔴 **以 `entry_class` + `rstate` 为键**，见下方专表 | | | |
| 其余组合 | | | | 🔴 **不允许用这个 source** |

**`direction = rollback` 的候选槽**（v36 改以 `entry_class` + `rstate` 为键 ——
v35 用「原项 `planned` / `restored`」当键，`install-new` 的两行区分不了 stage 与 undo，
`retire-only` 又把 `pending` 与 `restored` 合写却说 restored 后无候选，自相矛盾）：

| `entry_class` | `rstate` | 候选槽 |
|---|---|---|
| `noop`（任意 op） | `restored` | — （无需恢复介质） |
| `as-retired` | `pending` | `retired`(old) |
| `as-retired` | `restored` | — （旧树已移回 `T`） |
| 🔴 `as-retired-cleaned` | `pending` | **`retired`(old)** —— v36 写死「无」是错的：从 `attic` 重建 `R` 之后、`R→T` 之前崩溃时，`retired` **是合法候选**。重建之前该槽不存在，由摘要条件自然筛掉 |
| 🔴 `as-retired-cleaned` | `restored` | — （v36 **缺这一行**） |
| `as-swapped` | `pending` | `retired`(old) |
| `as-swapped` | `t_parked` | `stage`(new) + `retired`(old) |
| `as-swapped` | `restored` | — |
| 🔴 `as-swapped-cleaned` | `pending` | **`retired`(old)**（保守允许；重建前该槽不存在，摘要条件会筛掉） |
| 🔴 `as-swapped-cleaned` | `t_parked` | **`stage`(new) + `retired`(old)** —— v36 写死「无」是错的 |
| `as-swapped-cleaned` | `restored` | — |
| 🔴 **adopt 项**（`noop`） | `restored` | ⚠️ **不适用** —— 无物理动作，无需恢复介质 |
| 🔴 **unadopt 项**（`noop`） | `restored` | ⚠️ **不适用**（同上） |
| `as-installed` | `pending` / `restored` | ⚠️ **不适用** —— 回滚目标是「无树」，没有需要恢复的介质。<br>（v37 写「任意」过宽 —— 合法迁移里 `as-installed` **没有 `t_parked`**） |

🔴 **无论落在哪一格，最终仍以「该候选槽的实测摘要 == `target.digest`」为准** ——
状态只用来**缩小候选范围**，不用来断定内容。

隔离区因此始终保持**原样、只读、可取证**。

🔴 **`plan.snapshot` 的绑定**：它必须等于**原 journal 记录的解析快照**，
且该快照能按 §02-6.1 的历史读取路径**取回并验签**。不能是「随便挑一个当前快照」。

#### 🔴 时序：`cur` 隔离后才测得，intent 却要先于隔离落盘（v28）

这是一个真实的时序约束，v27 没处理：

| 阶段 | 持久化什么（🔴 **字段集定死，多一个少一个都算非法 intent**） |
|---|---|
| `planned` | `target`、`old_digest`（有旧树时）、`plan.snapshot`、`repair_ledger_image`、`isolate.*` 的四项身份。**没有** `cur` / `child_op` / `restore_from` |
| `planned → isolated` 的**同一次**原子写 | 🔴 `cur`、`child_op`，**以及条件必填的完整 `restore_from`**（v29 漏了它 —— `install-new` / `swap` 都必需它，没有持久化点会让 `isolated` 成为**合法性不成立、又无法恢复**的 intent） |
| 恢复时 | 见下方「重测范围」 |

（v29 一处写「`planned` 只写 `target`」、另一处的字段表又把 `old_digest` 也标成 planned 阶段 ——
口径已统一为上表。）

#### 🔴 `cur` 的重测范围（v30 修正 —— v29 的「每次重放前都重测」是错的）

child 一旦 `prepared`，`swap` / `install-new` 的物理起点**必然不再等于隔离时的 `cur`**；
而「每次重放前复验 `target` 断言」还会把**合法的** `install-new` 起点 `absent` 判死。

| 时机 | 规则 |
|---|---|
| `planned` / `isolated`，**创建 child 之前** | 🔴 重测 `cur`，与已持久化的值**必须一致**；不一致 → `corrupt` |
| 🔴 **child journal 已存在之后** | **只按 §5.4 的段模型恢复**，**不再重测 `cur`** |
| child 跑完、最终重验时 | 才校验 `target` 断言与 `postimage`（§child 子状态机） |

#### 🔴 「重测之后、child `prepared` 之前」那段窗口（v31 补）

评审指出的危险：外部可以在重测之后、child 提交之前改动 target；
而普通 child 会**把此刻实测到的值写成自己的 `old_digest`** ——
于是**把一棵外部的树当成旧树退役掉**。

修法**不是**在 child 提交后再重测，而是**让 child 继承期望值**：

🔴 **repair-child 是「`old_digest` 取实测值」这条通则的例外**
（§5.2 第 6 步与 §5.6 都写着「实测」—— v31 没同步，两处打架）：

```
expected_old = plan.items[<name>].old_digest      ← 来自原 journal 的已验证值
```

- 🔴 写 child `prepared` **之前**：实测值**必须等于** `expected_old`；不等 → `corrupt`；
- 🔴 **写进 child journal 的仍然是 `expected_old`**，不是此刻的实测值；
- 🔴 「首次 `T→R` 的动作点校验」**就是 §5.4 五分支里 `planned` 段的源端校验**，
  **不是**另加一次独立断言 —— 恢复重跑沿用同一分支即可。
  （因此 `logical-only` 仍是**唯一**的「提交账本前复验 `target`」例外。）

这样窗口被两个动作点夹住，child 提交之后不需要再重测 `cur`。

| `cur` | `target` | `child_op` | 说明 |
|---|---|---|---|
| `absent` | `absent` | **`logical-only`** | 只需账本对齐 |
| `absent` | `D` | **`install-new`** | 必须带 `restore_from` 指明 `D` 的来源 |
| `C` | `absent` | **`retire-only`** | 把现有树退役掉 |
| `C` | `D`，且 `C == D` | **`logical-only`** | 树已就位，只补账本 |
| `C` | `D`，且 `C != D` | **`swap`** | 必须带 `restore_from` |
| `other` | 任意 | — | 🔴 **`corrupt` 停机** |

🔴 **`ledg` 降级为「校验量」，不再参与决策**：
正常事务的 ledger 是**整份原子替换**，不存在可接受的「部分提交」。
因此 closure 内**混合 pre/post、或两者皆非** → **`corrupt`**（v26 把它当第三种取值是错的）。

#### plan 的正式字段（v27 —— v26 的示例漏了自己声称必填的项）

```json
"items": {
  "<name>": {
    // ── planned 阶段就写 ──
    "target":     { "present": true, "digest": "geoly-tree-v1:sha256:…" },  // 或 {"present":false}
    "old_digest": "geoly-tree-v1:sha256:…",     // 原 journal item 已验证的旧树摘要；无旧树则字段缺席

    // ── planned → isolated 那一次原子写才补上 ──
    "cur":      "absent" | "old" | "target" | "other",
    "child_op": "swap" | "install-new" | "retire-only" | "logical-only",
    "restore_from": {                    // 🔴 仅当 child_op ∈ {install-new, swap} 时必填
      "artifact": "skill:…@0.3.5",
      "tree_digest": "geoly-tree-v1:sha256:…",   // 🔴 必须 == target.digest
      "source": "registry" | "attic/<gen>" | "quarantine" | "quarantine-tx",
      "slot":   "stage" | "retired" | "undo" }   // 🔴 仅 source = quarantine-tx 时必填
      // 🔴 没有 snapshot 字段：它恒等于 plan.snapshot，冗余字段只会制造第二份真相
  }
}
```

（v27 的示例还留着旧的 `op` / `artifact` / `tree_digest` —— 在「严格拒绝未知字段」下
那会让一份合法 intent 被拒，v28 已统一。）

#### 🔴 `logical-only` **不是** journal 的 item op（v27）

§5.3 只承认三种 journal item op，§11 也只为那三种定义了 digest 组合 ——
**把 `logical-only` 写成第四种 item op 会破坏段模型**。

因此它**只是 repair plan 的编译分类**：

- 它**不建** stage / retired / attic item，**不出现在** `journal.items[*].op` 里；
- child journal 仍照常有 `repair_id` / `generation` / `tx_dir` / `crc32c` / 普通 `ledger_image`，
  🔴 **并明确允许 `items` 为空**；
- 恢复路径：`prepared → 写 ledger post patch → cleanup_pending → completed`；
- 🔴 **清理段不是「完全空操作」**（v27 的说法会造成真实缺口）：
  §5.6 的 **A / C 阶段为空**，但 **B 阶段仍必须写出 `attic/<gen>/manifest.json`** ——
  带 `items: {}`、以及本代的 `ledger_delta` 与 `postimage`。
  不写 manifest 的话，**该 generation 的账本变更永远无法被 `--from-generation` 复位**。
  「不建 attic item」≠「不建 manifest」。写完 manifest 才做 tx / transaction / journal 的正常收尾；
- 🔴 **`logical-only` 是「不再复验 `target`」这条规则的唯一例外**：
  它没有任何物理动作，因此**在提交账本之前**必须复验 `target` 断言，不成立即 `corrupt`。
  （其余三种 child op 在 journal 存在后一律按 §5.4 段模型恢复，不复验 —— 见「重测范围」。）

这样既表达了「只改账本」，又完全不动 §5.3 的段模型。

#### child 的子状态机（v24 重写）

🔴 **必须先持久化 `child`，再创建那个事务**；且 child journal **必须带 `repair_id`** ——
只靠目录名认领不够（v23 的做法）。

🔴 **双向校验**：认领一个 child 事务时，**四项**必须互相对得上 ——
journal 的 `repair_id` == intent 的 `repair_id`；journal 的 `generation` == `child.generation`；
tx 目录名 == `child.tx_dir`；🔴 **以及若 `ledger.transaction` 存在，它必须属于 `child.generation`**
（v25 的双向校验只覆盖了 journal）。任一不符 → **`corrupt` 停机**，不得认领。

🔴 **`committed: false` 的 pre-commit 清理**：除了清掉该 tx，还必须**按 §5.4.2 的双文件规则
清掉该 child 的 `ledger.transaction`** —— 否则重绑 generation 之后会留下一个旧 transaction。

#### 🔴 `child_registered` 的完整优先级矩阵（v30 重写为四观测量）

v28 的 12 行有两个硬伤，评审逐个指出：

- 🔴 **已列行误杀正常状态**：正常清理是**先删 tx、再写 `journal=completed`**，
  所以可以崩在 `journal=cleanup_pending, tx=无, transaction=本代, committed=true` ——
  而第 7 行「有 journal 无 tx → `corrupt`」把它一刀切了。**这不是兜底误杀，是我列的行杀的。**
- 🔴 **`committed` 其实是第四个观测量**：第 2 行与第 11 行的三元组完全相同，
  只靠动作文字区分，不满足「从上到下唯一匹配」。

v30/v31 把 `committed` 提为显式列，并把 `prepared` 与 `cleanup_pending` 拆开。

🔴 **`0` / `0′` / `1` 是「优先级前置守卫」，不是矩阵的行**（v30 把它们混在一张表里，
又宣称「逐行唯一匹配」—— 三者互相重叠，那句话不成立）：先跑守卫，全过再进矩阵。

**前置守卫**（任一命中即 `corrupt`；`1` 转人工、不嵌套 repair）：

| # | 条件 |
|---:|---|
| 0 | `tx` 属于**他代** |
| 0′ | `transaction` 属于**他代** |
| 🔴 0″ | **存在任何不属于 `child.generation` 的 journal 残留**（v31 没定 `journal` 的观测范围 —— 同时存在 child journal 与他代 journal 时，四元组根本没有唯一输入）。等价于 §5.2 的「无关残留 fail-closed」。<br>🔴 **扫描范围与顺序**（v33 补）：0″ **只扫已提交的规范文件 `journal/<generation>.json`**；**在此之前先按 §5.4 把未提交的 `journal/*.tmp` 忽略并删除**。否则它会与「`.tmp` 一律忽略并删除」产生解释歧义 |
| 1 | `journal` 为 `corrupt` |

🔴 **守卫 0″ 之后，矩阵里的 `journal` 专指 child 的那一份**，观测范围才唯一。

**与 §5.2 的 2b-1 是分层关系，不是重复**：
2b-1 是**外层总门**（只允许 child，其余残留 fail-closed）；
0″ 是**矩阵内**把 `journal` 收窄成 child journal，使四元组有唯一输入。

**矩阵**（守卫全过之后，逐行唯一匹配）：

观测量：`committed ∈ {false,true}`、
`journal ∈ {无, prepared, cleanup_pending, completed, corrupt}`、
`tx ∈ {无, 本代, 他代}`、`transaction ∈ {null, 本代, 他代}`。

| # | committed | journal | tx | transaction | 动作 |
|---:|---|---|---|---|---|
| 2 | false | 无 | 无 | null | 沿用 `child.generation` 建 tx |
| 3 | false | 无 | 无 | 本代 | 半提交 → 清 transaction，**重绑新 generation** |
| 4 | false | 无 | 本代 | null | pre-commit → 清 tx，重绑新 generation |
| 5 | false | 无 | 本代 | 本代 | 清 transaction 与 tx，重绑新 generation |
| 6 | false | `prepared` / `cleanup_pending` | 本代 | null 或本代 | **先补写 `committed = true`** → 转第 8/9 行 |
| 7 | false | `prepared` | **无** | 任意 | 🔴 `corrupt`（`prepared` 阶段 tx 必须在） |
| 8 | true | `prepared` | 本代 | null 或本代 | 按 §5.4 段模型恢复该 child |
| 9 | true | `cleanup_pending` | 本代 | null 或本代 | 续做 §5.6 的清理三阶段 |
| **10** | true | `cleanup_pending` | **无** | null 或本代 | ✅ **正常可达**（tx 已删、`completed` 未写）→ 🔴 先清 transaction（若为本代）→ 收尾写 `completed` → **转第 13 行**（transaction 此刻已是 null，不再走第 12 行）。**v28 在这里判 `corrupt`，是误杀** |
| 11 | true | `prepared` | **无** | 任意 | 🔴 `corrupt`（不对称） |
| 12 | true | `completed` | 无 | 本代 | 🔴 **先清 transaction** → 删 completed journal → 最终重验 |
| 13 | true | `completed` | 无 | null | 删 completed journal → 最终重验 |
| 14 | true | `completed` | 本代 | 任意 | 🔴 `corrupt`（已 completed 却留着 tx） |
| 15 | true | 无 | 无 | null | child 已跑完并清理干净 → **直接最终重验** |
| 16 | false | `completed` | 任意 | 任意 | 🔴 `corrupt`（不可能：`completed` 必然晚于 `prepared`） |
| — | 未列组合 | | | | 🔴 **fail-closed** |

🔴 **`child_done` / `done` 的三项前置断言，优先于整张矩阵判定** ——
先看 `state`：已是 `child_done` / `done` 就直接校验
`committed == true`、无 child tx 与 journal、`transaction == null`；
不满足即 `corrupt`。**不得让矩阵把一个非法的 done 状态「修好」。**

#### 🔴 `state` × `child` 的合法组合（其余一律 fail-closed）

| `state` | `child` | 合法性 |
|---|---|---|
| `planned` | 缺席 | ✅ |
| `isolated` | 缺席 | ✅ —— 🔴 此时**磁盘上不得有任何 child 残留**（child tx / journal / `ledger.transaction` 任一存在即 `corrupt`） |
| `child_registered` | 存在 | ✅ |
| `child_done` | 存在 | ✅ |
| `done` | 存在 | ✅（只等删 intent） |
| 其它任意组合 | | 🔴 **fail-closed 停机** |

| `state` / `child` | 含义 | 恢复动作 |
|---|---|---|
| `isolated`，无 `child` | 尚未登记 | 🔴 **先过 2c 的阈值归档**，再登记 child 并创建事务 |
| `child_registered`，`committed: false`，磁盘 **无 tx、无 journal**，且 **`ledger.transaction` 也不在** | 已登记但 tx 还没建 | 直接**沿用该 `child.generation` 创建 tx**（号已登记、水位已推进，不需重绑） |
| 🔴 `child_registered`，`committed: false`，磁盘 **无 tx、无 journal**，但 **`ledger.transaction` 仍在** | 半提交（可达） | **不得沿用该 generation**：先按双文件规则**清掉 transaction**，再**重绑一个新 generation**，才允许建 child |
| `child_registered`，`committed: false`，磁盘 **有 tx、无 journal** | pre-commit | 清掉该 tx，🔴 然后**先持久化重绑一个新 generation**（水位只增、旧号作废），才允许再建 child |
| 🔴 `child_registered`，`committed: false`，磁盘 **有有效 journal** | child journal 已提交，父 intent 还没来得及写 `committed: true` | v24 会**误归为 pre-commit 而清掉一个已提交的事务**。改为：**先把 `committed` 补写成 `true`**，再按下一行恢复 |
| `child_registered`，`committed: true` | child 事务已提交 | 🔴 **只恢复该 child**（`prepared` / `cleanup_pending` 作为 repair 的子步骤），**期间不做任何归档** |
| 🔴 `child_registered`，`committed: true`，磁盘 **tx 与 journal 都已不在** | child 已跑完并清理，崩在「最终重验 → `child_done`」之前 | **直接做最终重验**，通过就前进，不通过 `corrupt` |
| 🔴 `committed: true`，journal 是 **`completed` 残留**、tx 已清掉 | 正常清理末尾的可达状态 | 🔴 顺序：**先按双文件规则清掉 `ledger.transaction`**（它此刻仍可能指向 child generation）→ 再删该 completed journal → 再做最终重验（v26 漏了第一步） |
| 🔴 `committed: true`，**tx 仍在但 journal 不在** | 不对称残留 | **`corrupt` 停机** —— 不得落入「只恢复 child」那句泛化 |
| child 跑完 | — | 🔴 **重验最终 ledger 与目标树是否符合 `plan.repair_ledger_image.post`** → 通过才写 `state = child_done` |
| `child_done` | 验证已过 | 🔴 **先写 `state = done`，再删 intent** —— 不得直接删（v24 的「只重做删除」跳过了 `child_done → done` 这一跳） |
| `done` 而 intent 仍在 | — | 只重做删除 |

🔴 **`child_done` 与 `done` 的前置断言**（v27 补）：进入这两个状态**必须**同时满足
`child.committed == true`、**无 child tx 与 journal**、**`ledger.transaction == null`**。
任一不满足 → `corrupt` 停机。

🔴 **`committed` 的写入时点**（v27 定死）：
登记 child 时写 **`committed: false`**（与 `child.generation` / `tx_dir` 同一次原子写）；
**child journal 成功提交（`phase = prepared` 落盘）之后**，才翻成 `true`。
恢复时若发现「journal 已提交而 `committed` 仍为 `false`」，**先补写 `true`** 再继续。
| child 再次 `corrupt` | — | 🔴 **fail-closed 转人工，绝不再开一个 repair**（不做嵌套隔离） |
| 与 `child` 无关的任何残留事务 | — | **fail-closed** |

🔴 **消除 v23 的顺序矛盾**：v23 一处要求「2c 之前无未完成安装事务」，
另一处又要求「2c 之后启动/继续 child」—— child 已 `prepared` 时两者不能同时成立。

v24 定为：

```
无 child        → 2c 归档 → 才登记并创建 child
已提交的 child  → 直接恢复该 child，**跳过 2c**（归档与 child 不交错）
```

#### 拒绝条件与人工出路（v23 写具体）

**拒绝自动 `--reinstall`** 的情形：plan 枚举不全（journal CRC 损坏、journal 缺失）、
隔离观测落进上表的两个 `corrupt` 行、child 再次 corrupt。

此时**不猜测、不清扫 target**，并给出可执行的出路：

1. 🔴 **保留现场** —— 存在时，**`repair-intent`、journal、tx、账本记录、`quarantine/`**
   （v45 补齐：v43 的清单漏了**账本记录**，§5.4 那份漏了 **intent**，两处口径现已统一）
   一律不动，打包留存；
2. 恢复**一份完整一致的 target 状态**（整套 `.geoly` 加目标树），或
3. **整体迁走该 target、新建空 target 重装** —— 🔴 明确**放弃本地 audit**；
4. 🔴 **禁止**单独删除上述五样中的任何一样来「解锁」—— 那正好丢掉判断依据。

#### 其它

`quarantine/` **不自动删除**（可能是唯一残存证据），由人确认后清理。
🔴 **audit 边界的准确说法**（v25 更正 —— v24 笼统写「全程排除」，与 2c 本身就要归档相冲突）：

- **2c 是外层流程**在「`isolated` 且尚未登记 child」这一个边界上做的**一次独立 audit 操作**；
- **repair 的其它子步骤**（①–⑥、child 的恢复与重验）**一律不读、不写、不删任何 audit**。

## 6. 跨 target

不承诺跨四端 ACID。每 target 独立事务，任一非 ok → 整体非零退出。

```
claude   ok        3 installed, 0 skipped
cursor   ok        3 installed
codex    skipped   目录不存在（--create-missing codex）
agents   FAILED    plaud-theme-qa: 树摘要不符，事务停在 corrupt；跑 recover
```

## 7. 解包：不自己写 tar reader

（v2 重写时把这一节弄丢了，v3 补回。）

用成熟、锁版本、持续维护的库，并在其之上加**自己的**策略层：

1. 下载到临时文件，验 `asset.sha256`；
2. 解到**隔离临时目录**（不是 target，不是 stage）；
3. 策略层逐条 entry 检查：只接受普通文件；mode 白名单；路径 grammar
   （[`01-artifacts.md`](01-artifacts.md) §4）；条目数 / 总大小 / 深度 / 压缩比上限；
   🔴 **遇到任何 PAX / GNU 扩展头、xattr、ACL、symlink、hardlink、设备节点 → 报错终止**
   （不是静默忽略）；
4. 解完重算树摘要；
5. 通过后才移入 stage。

「零运行时依赖」不是安全收益：路径穿越、PAX longname、重复条目、稀疏文件、解压炸弹、
TOCTOU 这些边界，自己写一遍就是自己维护一份 CVE。
库能否满足「拒绝扩展头而非忽略」见 [`10-open-questions.md`](10-open-questions.md) Q6；
若没有库满足，则需在库之外先做一遍原始 tar 头扫描。

## 8. 项目级与 lockfile

`--project` 装到仓库内，并维护仓库根 **`geoly-skills.lock.json`**（D6）：

（格式见 §8.1 —— schema 为 `geoly.skills.lock/2`，按 target 分组）


- 有 lockfile 时 `install` **只按 lockfile 装**。
- `update` 是**受控地改 lockfile**：展示 diff、要求确认。
- lockfile 与当前快照冲突（已 yank / `degraded`）→ 报告并要求显式决定。

### 8.1 lockfile：**按 target 分组**的无损投影 + repo 锁（v6）

v5 给账本补了 `roots`，但 lockfile 仍是「各 target 的 roots **并集**」——
评审指出并集会丢掉四样东西：哪个 root 属于哪个 client target、
同一 root 在不同 target 的不同 `intent`、同名 skill 在不同 target 的不同已解析版本、
以及 root 与 `requested_by` 的 refcount 关系。**并集反推不出唯一的项目状态。**

v6 改为**按 target 分组**，target 用**可移植标识**（`client` + `scope` + 仓库内相对 `path`）：

```json
{
  "schema": "geoly.skills.lock/2",
  "registry": "geoly-ai/skills-hub",
  "targets": [
    {
      "client": "claude",
      "scope": "project",
      "path": ".claude/skills",
      "roots": [
        { "root": "pack:geoly/plaud-theme-matrix@0.3.6",
          "artifact": "pack:geoly/plaud-theme-matrix@0.3.6",
          "tree_digest": "geoly-tree-v1:sha256:…",
          "snapshot": 42,
          "intent": { "no_bundled": false, "pre": false } }
      ],
      "entries": [
        { "name": "plaud-theme-dev",
          "artifact": "skill:geoly/plaud-theme-dev@0.3.6",
          "tree_digest": "geoly-tree-v1:sha256:…",
          "asset_sha256": "sha256:…",
          "requested_by": ["pack:geoly/plaud-theme-matrix@0.3.6"] }
      ]
    }
  ]
}
```

| v5 的问题 | v6 |
|---|---|
| 顶层单一 `snapshot` | 已删除，改为 **per-root** `snapshot` |
| 各 target 的 roots 取并集 | **按 target 分组**，每组各自完整 |
| 用本机路径标识 | 改用 **`client` + `scope` + 仓库内相对 `path`**，跨机器可移植（且 §8.1 的闭合验证要求 `path` 只能由 adapter 推导） |
| 丢失 root → entry 关系 | 每个 entry 带自己的 `requested_by`（refcount 可无损还原） |
| 示例与正文不符 | 示例已同步（v5 的示例还留着已删掉的顶层 `snapshot`、roots 也缺 `snapshot` / `intent`） |

**repo 级锁** `<repo>/.geoly-skills.lock.db`，与 §5.1 **同一套 SQLite 机制**；
加锁顺序见 §5.1 末尾的全序。

**投影的时机与性质**：每次 `install` / `update` / `remove` 成功后在 repo 锁下幂等重算 + 原子写；
崩溃只让它过时；任一项目级 target 处于未恢复事务中 → **拒绝重算**并要求先 `recover`；
`check` 发现不符则报 `lockfile 过时`，提示 `sync-lock`。

#### root key grammar 与唯一性（v7 补）

```
root-key := "pack:" <ns> "/" <name> "@" <version>
          | "direct:" <kind> ":" <ns> "/" <name> "@" <version>
          | "all@snapshot:" <N>        ← `--all` 的表示
```

| 约束 | 规则 |
|---|---|
| target 唯一性 | `(client, scope, path)` 三元组在 `targets[]` 内唯一 |
| target 排序 | 按 `client` → `scope` → `path` 的字节序 |
| root 唯一性/排序 | 同一 target 内 `root` 唯一；按 root-key 字节序 |
| entry 唯一性/排序 | 同一 target 内 `name` 唯一；按 `name` 字节序 |
| `requested_by` | 元素必须**存在于同一 target 的 `roots` 里**；去重；按字节序 |

#### 🔴 「无损」的确切含义

指的是 **「可复现的期望安装图」无损**，不是「ledger 的逐字段无损投影」。

明确**不进** lockfile（因此不可从它还原）：`requested_at` / `installed_at` /
`generation` / entry 的 `state` / 本机绝对路径 / `fstype`。
这些是**本机运行历史**，跨机器没有意义。

#### 🔴 可验证闭包（v8 补 —— 没有这些它当不了权威输入）

lockfile 是**仓库里的未签名文件**，任何能改仓库的人都能改它。因此消费它时必须闭合验证：

| 约束 | 规则 |
|---|---|
| **target 路径** | `client` 必须是已知 adapter；`scope` 必须是 `project`；`path` **只能由 adapter 推导**并精确匹配（`claude` → `.claude/skills`）。🔴 **拒绝绝对路径、`..`、任何不由 adapter 产生的 path** —— 否则一个未签名的仓库文件就能把安装写到任意位置 |
| **snapshot 闭合** | 每个 root 的 `snapshot` 必须能取回**已验签**的历史快照（[`02-registry.md`](02-registry.md) §6.1）；root 的 `artifact` / `tree_digest` 必须与该快照里的 record 逐字段相符 |
| 🔴 **entry 名** | **`entries[].name` 必须精确等于其 `artifact` 的 `name`**，并再过一遍 §01-4 的路径 grammar。v8 没有这条 —— 未签名的 lockfile 可以写 `.geoly`、`..` 或任意目录名，而 `install` 又按 entries 物化，**这是比 target path 更直接的写入逃逸** |
| 🔴 **双向图闭合（边 + 顶点标签）** | 只做 entry → root 的单向检查不够：**恶意 lockfile 可以删掉 pack 的必装成员，剩下的 entries 仍然「个个闭合」**。必须从各 root 的**已验签历史快照**重新解析出期望图，然后要求：① `root → entry` 的**边集双向精确相等**（多一条少一条都拒绝）；② 🔴 **顶点标签也逐字段相等**。root 的标签关系**按三种 root 各自定义**（v10 笼统写成
「`root-key` == `artifact`」，与 `direct:` 的 grammar 直接冲突，会把项目级 direct 安装
自己拒掉）：<br>　`pack` → `root-key == artifact`<br>　`direct` → `root-key == "direct:" + artifact`<br>　`all` → 无 `artifact`，只校验其专有 record（`snapshot` + `intent`）；<br>每个 entry 的 `name` / `artifact` / `tree_digest` / `asset_sha256` / `requested_by` 都必须等于重解析出的期望值。否则恶意 lockfile 可以保留同名 entry 与相同边，却换成另一个 namespace/版本的**已签名** artifact，从而违背 pack 的锁定成员。③ 还要校验该 target 的 client 兼容性；`all@snapshot:<N>` 按该快照的全量兼容集合比对 |
| 🔴 **`--allow-yanked` 不放行 `degraded`** | 见 §8.1.1 |
| 🔴 **`allow_yanked`** | **lockfile 的 `intent` 里根本没有这个字段**（示例与 schema 均已移除）。它不接受由未签名文件授予；本次运行必须显式给 `--allow-yanked`，否则拒绝。（v10 一边删了字段、一边正文还写着「lockfile 里记着它」，自相矛盾，v11 统一为「没有」。） |
| 🔴 **当前状态门** | 闭包只证明「与某张已签名的历史快照一致」，**不代表现在还能装**。因此还必须过**当前** timestamp 所指快照的状态门 —— 🔴 **覆盖面不是「物化的制品」而是全部三类**（v11 只写了物化的，而 `degraded` 是 **pack** 的状态、pack 根本不作为目录物化，等于漏掉）：<br>　① 每个 **root artifact**（`pack` / `direct`）必须在当前快照中存在且通过状态门；<br>　② 每个 **entry** 同样；<br>　③ `all@snapshot` 则检查它重解析出的**全部** entry。 |
| 任一不闭合 | **拒绝安装**（退出码 2，完整性失败），不做任何「尽力而为」 |

#### 8.1.1 🔴 `--allow-yanked` 与 `degraded` 的关系（v12 定死）

v11 有跨文件冲突：02 说当前 `degraded` 可用 `--allow-yanked` 放行，
03 又明定 degraded pack 不能新装。

**定为：`--allow-yanked` 只放行 `yanked`，绝不放行 `degraded`。**

理由：`yanked` 是「这个制品本身有问题，我知道、我要装它做取证」——
是一个针对**具体制品**的知情豁免。而 `degraded` 是「这个 pack 的某个成员被 yank 了」，
装它等于**连带装一个已知被 yank 的成员**，而用户并没有对那个成员表达豁免意图。
要装就自己按成员逐个装（那时每个被 yank 的成员各自需要显式 `--allow-yanked`）。

02 §6.2 与 03 §5 已同步为这一口径。

#### `all@snapshot:<N>` 的 record 变体

`--all` 没有单一 artifact，因此它的 root record **不带** `artifact` / `tree_digest`：

```json
{ "root": "all@snapshot:42", "snapshot": 42,
  "intent": { "no_bundled": false, "pre": false } }
```

闭合验证对它只查 `snapshot` 可取回且已验签；成员的正确性由各 entry 自己闭合。

#### 🔴 `install` 是「物化已解析图」，不是「重新解析」

有 lockfile 时，`install` **按 `entries` 逐条物化**，
**不得**按 `roots` 里的 pack 重新解析成员 —— 否则同一个 lockfile 在不同时刻会装出不同东西，
那就不叫 lockfile 权威输入了。

`roots` 只用于闭合验证与 `requested_by` 的 refcount 语义。
要改变解析结果只能走 `update`（它会展示 diff 并重写 lockfile）。

在以上约束下，lockfile 足以让另一台机器装出**字节相同**的一套 skill，
因此**保留它作为 `install` 的权威输入**。

### 8.2 遮蔽（D4）

四端的项目级/全局优先级未知。承诺改为**默认避免歧义**：

🔴 全局已存在同名 skill 时，项目级安装**默认拒绝**，需 `--shadow-global`。
显式给了 flag 就是用户**明确接受歧义**（v2 措辞说加了 flag 仍「不制造歧义」，不准确）。

`check` 如实并列，不声称哪份生效：

```
plaud-theme-dev   项目级 0.3.6   全局 0.3.4   ⚠️ 两份并存，生效者取决于客户端
```

## 9. 正在运行的 agent：不设闸（D5，v3 收紧措辞）

- `rename` 保证不会读到半棵树；
- 但**不保证**一个已读了 `SKILL.md`、正要读 `references/x.md` 的 agent 读到同一版本；
  §5.6 的窗口里它甚至可能短暂读不到目录；
- 🔴 **本工具不检测正在运行的 agent，也不因此阻断或提示。**
  检出率与误报率都未知，做不可靠的检测等于给假保证。
- README 的「已知限制」必须写明这一条。
- （v2 的 `--assume-idle` 随之删除。）

后果是一次困惑的 agent 回合，不是数据损坏：磁盘上的字节始终由事务保证完整。

## 10. 从先例照搬 / 不照搬

| | 内容 |
|---|---|
| ✅ | 物理路径解析，拒绝路径链上任何 symlink / junction |
| ✅ | 整目录替换，不 merge |
| ✅ | 同设备暂存 + 交换前后各校验 + write-ahead journal + 遇残留事务停机 |
| ✅ | 归档 → 逐文件验证归档 → 删除，三步不可省 —— 但**移到事务之后的清理阶段**（§5.6），事务内改为 retirement rename |
| ✅ | 部分失败非零退出，如实列出 skipped |
| ✅ | 拒绝载荷里的 symlink / 设备 / FIFO / 不可读项 |
| ❌ | 单一全局 marker |
| ❌ | 按名字前缀判断陈旧 skill |
| ❌ | 固定 legacy allowlist 与 `--keep-legacy` |
| ❌ | 四端必须同版 |
| ❌ | 成员集合变化即拒绝更新 |
| ⚠️ | `install.ps1` 不当金标准（先例自述从未在 Windows 实跑；D1 已排除 Windows） |
