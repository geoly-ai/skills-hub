# M0 · 决策台账与范围

> 本目录是 **M0 规格**。按 ④A，M0 通过之前不写第一行 CLI 代码。
> ## ✅ **M0 已通过（v45，2026-08-25）**
>
> Codex 第四十五轮评审结论：**「可以通过。M0 可以封版，允许开始写 M1。」**
> 两个原始 P0（回放、唯一旧副本）均已关闭；CLI 与规范正文逐格一致；
> 未见新的状态机、人工恢复或命令分流问题。
>
> 🔴 **M1 开工前仍有两道硬门**，见本文件 §6。
>
> **当前版本：v45**（2026-08-25，按 Codex 第六轮评审重写）
> 变更台账：[`CHANGES-v2.md`](CHANGES-v2.md) · [`CHANGES-v3.md`](CHANGES-v3.md) · [`CHANGES-v4.md`](CHANGES-v4.md) · [`CHANGES-v5.md`](CHANGES-v5.md) · [`CHANGES-v6.md`](CHANGES-v6.md) · [`CHANGES-v7.md`](CHANGES-v7.md) · [`CHANGES-v8.md`](CHANGES-v8.md) · [`CHANGES-v9.md`](CHANGES-v9.md) · [`CHANGES-v10.md`](CHANGES-v10.md) · [`CHANGES-v11.md`](CHANGES-v11.md) · [`CHANGES-v12.md`](CHANGES-v12.md) · [`CHANGES-v13.md`](CHANGES-v13.md) · [`CHANGES-v14.md`](CHANGES-v14.md) · [`CHANGES-v15.md`](CHANGES-v15.md) · [`CHANGES-v16.md`](CHANGES-v16.md) · [`CHANGES-v17.md`](CHANGES-v17.md) · [`CHANGES-v18.md`](CHANGES-v18.md) · [`CHANGES-v19.md`](CHANGES-v19.md) · [`CHANGES-v20.md`](CHANGES-v20.md) · [`CHANGES-v21.md`](CHANGES-v21.md) · [`CHANGES-v22.md`](CHANGES-v22.md) · [`CHANGES-v23.md`](CHANGES-v23.md) · [`CHANGES-v24.md`](CHANGES-v24.md) · [`CHANGES-v25.md`](CHANGES-v25.md) · [`CHANGES-v26.md`](CHANGES-v26.md) · [`CHANGES-v27.md`](CHANGES-v27.md) · [`CHANGES-v28.md`](CHANGES-v28.md) · [`CHANGES-v29.md`](CHANGES-v29.md) · [`CHANGES-v30.md`](CHANGES-v30.md) · [`CHANGES-v31.md`](CHANGES-v31.md) · [`CHANGES-v32.md`](CHANGES-v32.md) · [`CHANGES-v33.md`](CHANGES-v33.md) · [`CHANGES-v34.md`](CHANGES-v34.md) · [`CHANGES-v35.md`](CHANGES-v35.md) · [`CHANGES-v36.md`](CHANGES-v36.md) · [`CHANGES-v37.md`](CHANGES-v37.md) · [`CHANGES-v38.md`](CHANGES-v38.md) · [`CHANGES-v39.md`](CHANGES-v39.md) · [`CHANGES-v40.md`](CHANGES-v40.md) · [`CHANGES-v41.md`](CHANGES-v41.md) · [`CHANGES-v42.md`](CHANGES-v42.md) · [`CHANGES-v43.md`](CHANGES-v43.md) · [`CHANGES-v44.md`](CHANGES-v44.md) · [`CHANGES-v45.md`](CHANGES-v45.md)

## 1. 用户已拍板（2026-08-24）

| # | 决策 | 选定 |
|---:|---|---|
| ① | matrix 与 hub 的关系 | **1C** 归档 `chovizzz/plaud-theme-matrix`，内容整体搬进 hub 作唯一源 |
| ② | 谁能投稿 / 谁审 | **2A** 对外开放投稿，fork + PR，CODEOWNERS 审 |
| ③ | CLI 分发 | **3A** 占 npm `@geoly/skills-hub` |
| ④ | 节奏 | **4A** 先出 M0 规格，review 通过再写码 |
| ⑤ | 信任根 | **5A** v1 就上 Sigstore keyless + npm provenance |
| ⑥ | `--all` | **6A** 保留，强确认 |
| ⑦ | 客户端 | **7A** 四端 + `--project` |
| ⑧ | 私有通道 | **8A** v1 不做 |

## 2. v2 里我替你做的决定（需要你确认，尤其 D1）

Codex 指出这些不能留给 M1，M0 必须定死。我按「哪个选择**不依赖未经验证的假设**」来定：

| # | 决定 | 理由 | 代价 |
|---:|---|---|---|
| **D1** | 🔴 **v1 只支持 macOS / Linux / WSL，明确不支持 Windows 原生** | POSIX mode 与路径 grammar 直接进树摘要，Windows 上 `0755` 存不住、`\` 与保留设备名会让不同逻辑路径落到同一物理路径。先例的 `install.ps1` 自己在 `RELEASING.md` 里注明**从未在 Windows 实跑过** | Windows 原生用户装不了（WSL 可用）。若你要 Windows，M0 得先补一套跨平台 mode/path 契约 |
| ~~D2~~ → **D2′** | 🔴 **反转**：全部 per-target 状态回到 `<target>/.geoly/`（锁、账本、journal、tx、attic） | bind-alias 反例证明「相邻位置」躲不掉：同一棵树可以有任意多个 parent，于是锁不是同一把、journal 也互相看不见，崩溃恢复直接失效。**正确性要求状态跟着物理目录走** | 依赖「客户端忽略 `<target>/.geoly/`」——但这条**升级为 M1 的阻塞验收门**（Q12），某端不过就只标该端不支持。副作用是简化：`target-id`、stage-parent、面包屑、`adopt` 全部删除 |
| D3 | attic 里的旧目录**归档成单个 tar**，不展开 | 展开的 attic 里有 `SKILL.md`，客户端可能把旧版当成一个 skill 加载 | 回滚要解包（非热路径）。D2′ 之后它在 `<target>/.geoly/attic/` 下，更需要这条 |
| D4 | 项目级安装：全局已有同名时**默认拒绝**，需 `--shadow-global` | 遮蔽规则四端未知；这条承诺无论哪端怎么实现都成立 | 多一次确认 |
| D5 | **不做「正在运行的 agent」检测**，改为交互确认 + README 明写「本工具无法检测」 | 检出率与误报率都未知，做不可靠的检测等于给假保证 | 用户可能在 agent 读 skill 时替换它 |
| D6 | lockfile 改名 `geoly-skills.lock.json` | 避免踩本机已存在的 `~/workspace/skills-lock.json`（另一套工具的产物） | 无 |
| D7 | 禁止 semver 的 `+build` metadata | `1.0.0+a` 与 `1.0.0+b` precedence 相同，`latest` 无法唯一 | 无 |
| D8 | `contract_paths` 变更触发 Tier 2 审查，且**与上一版取并集** | 否则 pack 作者清空清单即可绕过兼容性门 | 无 |
| **D9** | **路径 ASCII-only**（`[A-Za-z0-9._-]`）—— 用户 2026-08-25 拍板 | 一刀切掉 macOS 归一化（APFS 枚举出的形式可能与写入不同，导致装完重算摘要对不上）、USTAR 编码、同形字混淆 | 文件名必须英文（`SKILL.md` 正文不限）。matrix 现有 10 个 skill 全部符合 |
| **D10** | 交换承诺改为「**不会读到半棵树，但可能短暂读不到**」—— 用户 2026-08-25 拍板 | 「先归档→删旧→rename 新」中间必然有目录不存在的窗口，v2 却承诺「要么旧要么新」，自相矛盾 | 做到「要么旧要么新」需 Linux `renameat2` / macOS `renamex_np`，Node 无内建绑定 —— 会给「少依赖、npx 冷启动要快」加一个编译依赖且两平台各写一套 |
| **D11′** | 锁改用 **`node:sqlite` 的 `BEGIN EXCLUSIVE`**（Node 内建，无原生依赖，进程退出由内核释放，**协议里没有任何 unlink**）—— 2026-08-25 实测后定 | 只要协议里存在任何一次对锁路径的 `unlink`，「A 读 nonce → R 清锁 → B 建新锁 → A 删掉 B 的锁」这类竞态就消不掉；换成内核释放的真锁才根治 | **Node 门槛 20 → 22.13**；`node:sqlite` 仍打 ExperimentalWarning，需抑制并封在适配层；SQLite 在网络文件系统上不可靠（与已有的拒绝 NFS/SMB/FUSE 对齐）。冷启动实测无差异 |
| **D5′** | 在 D5 基础上**再收紧**：不检测、**也不加确认前置**，`--assume-idle` 删除 —— 用户 2026-08-25 拍板 | 后果是一次困惑的 agent 回合，不是数据损坏；磁盘字节始终由事务保证完整 | 热路径少一个提示；风险由 README 的已知限制承担 |

## 3. M0 交付物

| 文件 | 定死什么 |
|---|---|
| [`01-artifacts.md`](01-artifacts.md) | 不可变布局、ArtifactId、路径 grammar、树摘要算法 |
| [`02-registry.md`](02-registry.md) | 快照 schema、**timestamp 角色与防回放**、分发、签名与验证链 |
| [`03-packs.md`](03-packs.md) | pack lock、yank 闭包、兼容性门 |
| [`04-install.md`](04-install.md) | 账本、**崩溃安全的事务**、adapter、项目级与 lockfile |
| [`05-lifecycle.md`](05-lifecycle.md) | 命名空间、所有权、replaces/conflicts、yank 状态机 |
| [`06-submission.md`](06-submission.md) | **三阶段发布**、两个验证入口、capability 分级 |
| [`07-threat-model.md`](07-threat-model.md) | 资产、对手、攻击路径、**承认的信任锚** |
| [`08-matrix-migration.md`](08-matrix-migration.md) | 1C 切换：墓碑的真实边界、双摘要、不可逆点 |
| [`09-cli.md`](09-cli.md) | 命令面、退出码、平台契约 |
| [`10-open-questions.md`](10-open-questions.md) | 只剩真正能留到 M1 的问题 |
| [`11-wire-contract.md`](11-wire-contract.md) | 所有 JSON 对象的通用规则：拒绝重复 key / 未知字段、canonical 形式、原子写、版本演进 |
| [`CHANGES-v2.md`](CHANGES-v2.md) | v1 → v2 逐条变更与对应的评审意见 |

## 4. 明确不在 M0 范围内

CLI 实现代码、workflow 实现、私有 skill（⑧A）、多 registry / 联邦、
skill 内容质量的 eval 体系、Web UI / 搜索服务 / 下载统计、**Windows 原生支持（D1）**。

## 5. 术语

| 词 | 含义 |
|---|---|
| **artifact（制品）** | 不可变、已定版的分发单元。kind ∈ `skill` \| `pack` |
| **payload（载荷）** | 制品目录下全部文件，逐字节参与树摘要 |
| **snapshot（快照）** | 某次发布后全部已发布制品的完整清单；签名对象之一 |
| **timestamp（时间戳元数据）** | 短期有效、单独签名的小文件，声明「当前最新快照是哪一个」；防回放的核心 |
| **target（目标）** | 一个物理 skills 目录 |
| **ledger（账本）** | 一个 target 的所有权记录，存在 `<target>/.geoly/` 下（D2′） |
| **root（请求根）** | 一次安装的发起单位：`direct`、某 pack、或 `--all` |


## 6. 🔴 M1 开工清单（Codex 第四十五轮给出）

### P0 —— 必须先做，未过不得写实现

| # | 事项 |
|---:|---|
| 1 | **Q12 验收**：按**具体客户端版本**完成四端 × 全局/项目级测试 —— 验证 `.geoly`（含 WAL/SHM、`stage`、`attic`）不被发现为 skill、不报错、不影响路由。🔴 **未通过的客户端不得合入 adapter，直接标为不支持**；同步补项目 `.gitignore` 与 `git clean -xfd` 提示 |
| 2 | **Node / SQLite 实测**：Node **22.13** 与执行时 **current LTS** 上验证竞争写锁、`SIGKILL` 后释放、`busy_timeout=0`、诊断读不阻塞 checkpoint、无手工 unlink、崩溃后的锁与事务恢复；并在**干净 `npx` 启动**中确定「只抑制 `ExperimentalWarning`」的方案 |
| 3 | **先建故障注入测试框架**：覆盖原子写、每次 rename/fsync、journal/ledger 单边落盘、cleanup A/B/C、rollback 子段、repair intent/child、audit archive intent |

### P1 —— 实现顺序

```
4. 基础模块： runtime/bin → canonical-json + schema → atomic-fs + safe-fs
              → tree-digest + tx-digest → lock
5. 信任与制品链： metadata/trust-floor → timestamp/snapshot 验签与缓存
              → 受限 tar 解包与制品结构校验
6. adapter 与 target 预检（仅启用已通过 Q12 的 client/scope 组合）
7. 状态与事务内核： ledger/journal → 直接 skill 规划 → 交换与清理
              → rollback / continue / reinstall / repair → project lockfile 投影
8. 命令面端到端： direct install、recover、check、list/search/why、sync-lock；
              全局与项目级的输出 / 退出码 / JSON 契约
9. 收尾： CI 固化 Node 矩阵、Q12 结果与崩溃注入回归
```

**范围边界**：pack 留 M2，投稿留 M3，`update` / `remove` 留 M4。
