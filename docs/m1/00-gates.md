# M1 前置 gate 实测记录

> 2026-08-26。M0 已封版在 `docs/m0/`，本文**不修改**它，只记录 M1 开工前两项 P0 gate 的实测结论。
> 结论若与 M0 正文冲突，以 M0 为准并在这里注明。

---

## Gate 1 —— Q12：`.geoly` 状态目录会不会被客户端误当成 skill

**问题**：我们要在 target 目录里放 `.geoly/`（含 ledger、journal、WAL/SHM、`stage/`、`attic/`）。
如果客户端把它扫成一个 skill，或者因为它报错，整套方案就不成立。

### 测法（以及第一次测错在哪）

被测客户端：**`codex-cli 0.147.0`**。

⚠️ **这个版本号是事后补记的**——测量当时没记，是同一台机器、同一个未升级过的安装
事后从二进制读出来的。据此认为它就是被测版本；若哪天发现期间发生过升级，这一格要重测。

Q12 要求门与具体版本绑定：换版本要重测，`src/adapters/index.mjs` 的 gate 表
会在缺 `clientVersion` 时拒绝 `passed`。

🔴 **第一次的测量是无效的，记下来免得重犯**：`catalog_entries` 在加了正对照之后
**仍然是 5**，说明这个测量根本不敏感。两个原因叠在一起：

1. 传了 `--ignore-user-config`，客户端不读用户配置，也就不去扫那个目录；
2. skill 放错了根，压根不在被扫描的路径下。

修法：去掉 `--ignore-user-config`，把 skill 放进 `$CODEX_HOME/skills`。
**正对照随即从 5 变 6**——这时测量才是有效的。

⚠️ **一个不动的读数不等于"没影响"，先证明测量本身会动。** 没有正对照的负结果没有意义。

### 🔴 实际测了什么（以及**没**测什么）

早先这一节写成了一张通用结论表，读起来像「四端都验过了」。**那是夸大。**
实测只覆盖了**一个客户端、一个 scope**，而且当时没记客户端版本号——
Q12 明确要求「按**具体客户端版本**完成四端 × 全局/项目级」，所以这道门**没过**。

| client × scope | 实测了吗 | 结果 |
|---|---|---|
| **codex × global**（`codex-cli 0.147.0`，`$CODEX_HOME/skills`） | ✅ 测了 | 正对照 `catalog_entries` 5 → 6（证明测量有效）；放入完整 `.geoly` fixture（含 WAL/SHM、`stage`、`attic`）后仍为 6，**未被识别为 skill**、无报错、不影响路由 |
| codex × project | ❌ 没测 | — |
| claude × global / project | ❌ **完全没测** | 连 catalog 读取都没观测过 |
| cursor × global / project | ❌ **完全没测** | 同上 |
| agents × global / project | — | 见下：**没有读者**，直接标不支持 |

**当前 `enabledCombos()` 为空。**

⚠️ 注意区分两件事：`codex × global` 这一格的**证据是完整的**（测量有效 + 结论 + 版本号）；
它留在 `pending` 卡的是**范围决策**——「只启用一端就发车」是排期取舍，得由人拍，
不该由 gate 表自己决定。其余各格是真的缺证据。

`src/adapters/index.mjs` 里 `codex/global` 的 `blockedOn` 因此是 `scope-decision-pending`，
不是 `client-version-unrecorded`。**这两者不能混**：前者拍个板就能开，后者要重新做实验。

⚠️ **一个通过的正对照只证明「这一次测量有效」，不证明「所有客户端都安全」。**
把单点结论写成通用表，比不写更危险——它会让后面的人以为门已经过了。

### 附带发现：`~/.agents/skills` 没有读者

用固定串核对（`grep -F '.agents/skills'`）两个二进制，**命中数为 0**。

⚠️ **早先用 `grep '\.agents'` 得到过假阳性**——它匹配到的是 `.claude/agents`（子代理目录），
与 skill 路由无关。**正则里的 `.` 会匹配任意字符，核对路径一律用 `-F`。**

含义：`agents` 这个 client 在当前版本下**装了也没人读**。adapter 里保留它，
但 M1 不把它算作已验证的 client/scope 组合。

---

## Gate 2 —— Node / `node:sqlite` 锁原语

**问题**：M0 选了 `node:sqlite` 的 `BEGIN EXCLUSIVE` 做锁（内核释放、无原生依赖）。
需要证明它在支持的 Node 版本上真的可用，且不会往用户终端喷实验性警告。

### 结论

| 项 | v22.13.0 | v24.19.0 | v25.2.0 |
|---|---|---|---|
| `import('node:sqlite')` 需不需要 `--experimental-sqlite` | **不需要** ✅ | 不需要 | 不需要 |
| 裸跑会不会打 `ExperimentalWarning` | **会**（对照有效） | **不会** | **会**（对照有效） |
| 经 `bin/skills-hub.mjs` 跑，还有没有警告 | 无 ✅ | 无 | 无 ✅ |

- 第一项证实了 M0 把 Node 下限定在 **≥ 22.13** 是对的：22.12 及以前要开关，22.13 起默认启用。
- 抑制在**两个真会打警告的版本**上都验证有效；24.19 本身不打，所以那里的"无警告"不构成证据。

🔴 **抑制必须发生在任何 import 之前**。`bin/skills-hub.mjs` 先包 `process.emit`，
再 `await import('../src/cli.mjs')`。写成顶层静态 import 就晚了——模块求值时警告已经发出去了。

⚠️ **第一版的阴性对照是无效的**：只在 24.19 上跑了"不加抑制"，看到 0 条警告就以为对照成立。
实际是那个版本压根不打警告。**对照要逐版本做**。

### 测试矩阵

`scripts/test-matrix.sh` 在 22.13.0 与 24.19.0 上跑全量 `node --test test/*.test.mjs`。

⚠️ `node --test test/`（目录参数）在 22.13 上会报 `Cannot find module '.../test'`——
那个版本不支持目录参数。**用 glob**：`node --test test/*.test.mjs`。

---

## 尚未完成的 P0

按 `docs/m0/00-decisions.md` §6，M1 还欠：

- 故障注入测试框架（覆盖原子写、每次 rename/fsync、journal/ledger 单边落盘、cleanup A/B/C、
  rollback 子段、repair intent/child、audit archive intent）
- 信任与制品链：metadata/trust-floor → timestamp/snapshot 验签与缓存 → 受限 tar 解包
- adapter 与 target 预检（只启用 Q12 已通过的 client/scope 组合）
- ledger/journal 与事务内核
- M1 命令面端到端

已完成的基础模块：`runtime/bin`、`canonical-json`、`atomic-fs`、`tree-digest`/`tx-digest`、`lock`。
埋点子系统见 `docs/telemetry/00-spec.md`（P1 增量，不阻塞上面这些）。
