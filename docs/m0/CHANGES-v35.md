# M0 v35 变更台账

Codex 第三十四轮：3 项。评审同时确认**两步制方向正确**（状态限定候选、实测摘要决定接受，
没有新增「摘要放宽」）、**身份等价类三分法正确**。

## ① 🔴 数据丢失 bug：回滚从正向 `planned` 推断物理位置

> 回滚把 `planned` 错当成「首次 rename 尚未发生」。但正向 `planned` 段**本就覆盖 `T→R`**；
> 断电可留下 `state=planned, T=∅, R=old, S=new`。
> 现回滚会直接标 `restored`，收尾删除 tx，**旧树随 `R` 丢失**。

成因很典型：**同一个错误换了个位置。**
我在正向侧早就定过「状态字段落后于物理动作、恢复必须按物理实况」，
却在**回滚入场**时又拿正向的 `state` 去推断物理位置。

v35：

- 🔴 立一条铁律：**回滚入场绝不从正向 `item.state` 推断物理位置**；
- 入场时对每项**先实测 T / R / S**，据此归类，并把归类结果作为
  `rollback.items[*]` 的**严格 schema 字段持久化**
  （`rstate ∈ {pending, t_parked, restored}` + `entry_class ∈ {noop, as-retired, as-swapped}`），
  **写完再动手**；
- 🔴 恢复时**正向 `state` 与 rollback 子状态必须同时可判定**，任一缺失即 `corrupt`；
- 三种 op 的 `planned` 各拆成两行（实测 `T` 在原位 / 已被移走），
  后者一律**按 `retired` 等价处理**，先把旧树移回去。

## ② slot 表仍漏一格合法介质

`rollback × swap × pending` 时 `retired/<name>` 可含 `old_digest`，
而**回滚的目标恰是 `old_digest`** —— v34 只列 `stage(new)`，
于是**把唯一可用的 `retired` 拒掉了**。已补为 `stage(new) + retired(old)`。

另按建议：`rollback × install-new` 的两行**标注为「不适用」** ——
回滚它的目标是「无树」，没有需要恢复的介质；那两行只作**物理位置说明**，
避免实现者误当成 `quarantine-tx` 的候选。

## ③ ③/④ 校验漏了「拒绝类元数据」

v34 的结构校验只写了目录、空目录、类型、mode，而 xattr/ACL 与普通文件 `nlink != 1`
**已被定义为拒绝条件** —— 复制后被注入 ACL/xattr 或外部 hardlink 仍能通过。
而 ①b/② 验的是**源 tx** 的指纹，**替代不了目标树检查**。

v35：③、④ 明确都要查 **无 xattr / 无 ACL / 普通文件 `nlink == 1`**，
外加原有的目录、空目录、类型、mode、路径约束；
并写明 ⚠️ **不比较、不规范化**时间戳 / inode / 属主属组（它们不参与等价类）。

## ④ 措辞：目录 `0755` 是判据不是动作

按评审澄清：它意味着「**必须已经满足**，否则无法成像」，
🔴 **绝不对隔离证据执行 chmod**。两处措辞已改。

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
