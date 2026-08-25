# M0 v18 → v19 变更台账

Codex 第十九轮：P0-2、P0-3 维持关闭。剩 4 项收口，全在 audit plane。
评审原话：「完成以上最小修订后，审计平面的不变量才闭合；届时可以再判定 M0 通过。」

## ① 直接矛盾：一处仍写 audit 进 `pre/post`

§5.4.2 还留着 v15 的措辞「audit 追加要显式进入 `ledger_image.pre/post`」，
与 §4 audit plane 的「只进 `post`」**直接打架**。

v19 改为：**只进 `post.audit_append`；`pre` 与 attic manifest 的
`ledger_delta` / `postimage` 一律不得含 audit 相关字段。**

## ② 去重必须 fail-closed

v18 只说了「按 `event_id` 去重」。评审指出：正常路径（target 锁 + 先持久化 `audit-seq`）
不会产生同 id 的不同事件，journal 重放也应是同一事件 —— **但规范不能只写「去重」**。

v19 定死三分支：

- 同 id 且 **canonical 字节完全相同** → no-op（journal 重放的正常情形）；
- 同 id 但**内容不同** → **`corrupt` 停机**；
- live 流内部重复 id，或与 `audit-archive/` 已归档的 id 冲突 → 同样 **`corrupt` 停机**。

🔴 **绝不静默保留其中一条。**

## ③ bootstrap 例外账本的精确写法

v18 说「改写一份合法空账本」，但没写清它跟 bootstrap 骨架的区别 ——
照骨架的 `audit: [] / audit_archived_until: 0` 理解，**会把 audit plane 重置掉**。

v19：**例外账本只清空 `entries`、`roots`、`transaction`；
audit plane（live `audit` 与 `audit_archived_until`）一律原样保留。**

评审同时确认 `ledger_existed = false` 的语义不冲突：它始终指「**本次事务起点**」的状态；
后续事务看到这份例外账本时它已经存在，其 rollback 只 patch 非审计字段。

## ④ 三处边界

| 边界 | v19 |
|---|---|
| `audit-seq` 缺失时「存在 audit 状态」的判据 | 🔴 补上 **`audit_archived_until > 0`** —— 事件全部归档后 live 流是空的，但游标 > 0 就证明历史存在过（v18 只看 live/archive/intent） |
| `audit_max_entries` 阈值 | 🔴 `== max` **不**归档，`>` 才归档；归档前缀**必须非空**，空前缀不写任何文件、不动 cursor |
| 归档与安装事务的顺序 | 🔴 两者**不得交错**：安装事务进行中不触发归档；归档 intent 未清完不开始新安装事务。<br>🔴 **`audit_archived_until` 只能在「已验证的 archive 文件存在」时前进，绝不因 `audit_append` 而前进** —— 否则容量预检、append 与 cursor 会互相覆盖 |

## ⑤ 三处措辞收口

- 09 的 `--reinstall`「丢弃当前两份」→ 明确**不含 audit plane**（live audit / archive / seq / cursor 全保留）。
- `audit-seq` 拒绝初始化后的「完整状态集」→ 明确列出包含 `audit-seq`、live `audit`、
  `audit-archive/`、intent、`audit_archived_until` 游标与 ledger 本身；
  并写明 🔴 **`--reset-generation` 解决不了这个问题**（它管的是 generation 水位，不是 audit 序号）。
- 10 的 README 提示 → 同步为「`git clean -xfd` 删掉整个 `.geoly/`，
  **既包括进行中的事务状态，也包括本地 audit 历史**」。

## 评审已确认无需再动的

- `--rollback`、`--reinstall`、attic 清理本身已不再删除 audit。
- `audit-archive/` 不受 `--keep-generations` 清理是正确的。
- `git clean -xfd` 与「移走整个 target」仍会毁掉本地审计历史 ——
  这是**接受且已提示**的显式破坏路径。
- `audit-seq` 拒绝初始化后的两条出路在安全性上够。
