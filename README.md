# skills-hub

`geoly-ai` 的 skill 分发中心：一条命令装单个 skill、装矩阵包，
并支持外部投稿与过审。

> ⚠️ **当前只有 M0 规格，还没有任何实现代码。**

## 现在在哪一步

| 阶段 | 状态 |
|---|---|
| **M0 · 制品与信任模型** | ✅ **已通过**（v45，2026-08-25） |
| M1 · 只读分发（单 skill 的 resolve / install / list / check） | 未开工 |
| M2 · pack 与受控 catalog | — |
| M3 · 投稿与审核 | — |
| M4 · update / remove / 正式发包 | — |

## 从哪读起

- **[`docs/m0/00-decisions.md`](docs/m0/00-decisions.md)** —— 决策台账、术语、
  以及 🔴 **M1 开工前的两道硬门**（§6）
- [`docs/m0/01-artifacts.md`](docs/m0/01-artifacts.md) 起是规范正文，共 12 份
- `docs/m0/CHANGES-v*.md` 是 v2 → v45 的逐轮变更台账
  （**变更台账不是现行规范**，以正文为准 —— 见
  [`11-wire-contract.md`](docs/m0/11-wire-contract.md)）

## M0 定了什么

不可变制品布局与树摘要、签名快照 + timestamp 防回放、pack lock 与 yank 闭包、
崩溃安全的安装事务（幂等前向恢复 / retirement rename / repair intent）、
投稿与三阶段发布、威胁模型、CLI 命令面与退出码、JSON wire contract。

平台：**macOS / Linux / WSL**，**Node ≥ 22.13**（锁用内建 `node:sqlite`）。
