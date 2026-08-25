# M0 v44 变更台账

Codex 第四十三轮：三项**已确认成立** ——

- 🔴 **五处已齐**：入场表、一致性矩阵、反向调度、候选槽表、manifest 执行表**均含 `unadopt`**，
  且 `op` / `reverse_op` 枚举**已统一**；
- `unadopt` 拒绝 rollback **不会自动造成永久死锁**（把目录严格恢复为 `D` 后 `--continue` 即可复验回 `ok`）；
- `unadopt → adopt` **现在可实现**（字段源、两处摘要等式、`old_digest` 禁用、重放前复验、
  新 manifest 的 postimage 都已定死）。

最小集合只剩两处。

## ① 🔴 CLI 与规范正文脱节

我改了 §5.4 的分流，**`09-cli.md` 那行还停在旧口径**：
「`corrupt` 不允许 `--rollback` 也不允许 `--continue`」+「`--reinstall` 仅 `corrupt` 可用」。
它会**错误拒绝**三种合法操作：

- `adopt` 的 `assertion-corrupt` 走 `--rollback`；
- `unadopt` 严格复验后的 `--continue`；
- 两类 `assertion-corrupt` 对 `--reinstall` 的拒绝分流。

v44 把 CLI 里所有泛称的 `corrupt` **限定为物理 `journal.items[*].state = corrupt`**，
并在 `--reinstall` / `--continue` / `--rollback` 三行分别写出例外分流。

## ② 「否则人工」不是可执行的出路

v43 对 `unadopt` 的 `assertion-corrupt` 只写了「否则人工」。v44 给出四条具体出路：

| 出路 | 做法 |
|---|---|
| ✅ 首选（自动） | 把目录**严格恢复为断言的 `D`**（逐字节 + 结构与元数据约束）→ `recover --continue` → 复验成功转回 `ok` |
| 人工 A | **保留现场**（journal / tx / 账本 / `quarantine/` 一律不动），打包留存 |
| 人工 B | 恢复**一份完整一致的 `.geoly` 状态集 + 目标树** |
| 人工 C | **整体迁走 target、新建空 target 重装** —— 🔴 明确放弃本地 audit |
| 🔴 禁止 | **单独删除 journal / tx / 账本记录来「解锁」** —— 那正好丢掉判断依据 |

## M1 开工清单

1. **Q12**：四端 × 全局/项目级的 `.geoly` discoverability 验收（绑定具体客户端版本）。
2. Node **22.13 与 current-LTS** 的 SQLite 锁行为、崩溃恢复实测，
   以及 `ExperimentalWarning` 抑制方式。
