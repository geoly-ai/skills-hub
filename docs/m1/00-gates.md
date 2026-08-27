# M1 前置 gate 实测记录

> 2026-08-26。M0 已封版在 `docs/m0/`，本文**不修改**它，只记录 M1 开工前两项 P0 gate 的实测结论。
> 结论若与 M0 正文冲突，以 M0 为准并在这里注明。

---

## Gate 1 —— Q12：`.geoly` 状态目录会不会被客户端误当成 skill

**问题**：我们要在 target 目录里放 `.geoly/`（含 ledger、journal、WAL/SHM、`stage/`、`attic/`）。
如果客户端把它扫成一个 skill，或者因为它报错，整套方案就不成立。

Q12 要求的是**四端 × 全局/项目级**共八格，且门要**绑定具体客户端版本**。
本节按格记录：测了什么、怎么证明测量是有效的、以及**哪些格子没测**。

### 🔴 逐格结论（2026-08-26）

| client × scope | 测了吗 | 客户端版本 | 结论 |
|---|---|---|---|
| **claude × global**（`$HOME/.claude/skills`） | ✅ 实测 | `claude-code 2.1.246` | **通过**〔加载 + 路由输入〕 |
| **claude × project**（`<repo>/.claude/skills`） | ✅ 实测 | `claude-code 2.1.246` | **通过**〔加载 + 路由输入〕 |
| **codex × global**（`$CODEX_HOME/skills`） | ✅ 实测 | `codex-cli 0.147.0` | **通过**〔加载 + 路由输入〕 |
| **codex × project**（`<repo>/.codex/skills`） | ✅ 实测 | `codex-cli 0.147.0` | **通过**〔加载 + 路由输入〕 |
| **agents × global**（`$HOME/.agents/skills`） | ✅ 实测（读者＝codex） | `codex-cli 0.147.0` | 通过，但**卡范围决策** |
| **agents × project**（`<repo>/.agents/skills`） | ✅ 实测（读者＝codex） | `codex-cli 0.147.0` | 通过，但**卡范围决策** |
| **cursor × global** | ❌ **本机无法测量** | — | 无运行时证据；**静态分析预判失败** |
| **cursor × project** | ❌ **本机无法测量** | — | 同上 |

`enabledCombos()` 因此是 **claude/global、claude/project、codex/global、codex/project** 四格。
`agents` 两格证据完整但等人拍板；`cursor` 两格缺的是证据，不是决策。

🔴 **〔加载 + 路由输入〕这个限定词是认真的，别读成无条件通过。** Q12 的原文要求是
「不被当作 skill 加载、不报错、**不影响其它 skill 的加载与路由**」。这里证到的是：
① 不被当作 skill 加载；② 不报错（退出码 + stderr）；③ 其余 skill 的**加载**结果逐名不变，
且**路由的输入**（模型可见的那份 skill 清单）逐条不变、canary 从未进入其中。
**没有**真的调用一个 skill 去看它路由到哪 —— 路由**行为**本身没有端到端验证。
（Codex 复核时坚持这一点还不够格叫 passed；四格翻绿是派活人明确要求的，
这里如实标出覆盖边界，不把它写成无条件通过。）

### 测法：读数、正对照、判据

**读数必须是客户端自己报的 skill 清单**，不能是我们去猜它扫了什么。

- **codex**：`codex debug prompt-input`，取它渲染的**模型可见 prompt** 里
  `<skills_instructions>` 块的条目数与条目名。完全离线，不发任何请求。
- **claude**：`claude -p --output-format stream-json --verbose`，取首条
  `system/init` 事件的 `skills` 数组。`ANTHROPIC_BASE_URL` 指向一个**本地 stub**，
  它返回一段最小的 SSE 成功响应 —— 于是拿得到**真实的退出码 0** 与真实 stderr，
  且不产生任何外网请求、不花钱。stub 还会把客户端**真正发出的请求体**落盘，
  用来核对 canary 有没有混进模型可见的内容里。

沙箱一律 `env -i` + 临时 `HOME` + 临时 project 目录。
🔴 **claude 那一格特意不设 `CLAUDE_CONFIG_DIR`** —— adapter 里 claude 的 global target 是
`$HOME/.claude/skills`，用 `CLAUDE_CONFIG_DIR` 指到别处就等于测了一个 adapter 根本不会去装的路径。
（Codex 评审时指出的，原版测量犯过这个错。）

**每一格四步**，缺一步该格作废：

| 步 | 动作 | 期望 |
|---|---|---|
| S0 | 目标目录为空 | 读数 `N0` |
| S1 | 放一个**有效且唯一**的 skill（深度 1） | `N1 = N0+1`，且该名字**恰好出现 1 次** |
| S2 | 再放一个**同深度**的 skill：`<target>/probe3/tx-1/stage/<n>/SKILL.md` | `N2` —— 回答「扫描够不够深，能不能到达 `.geoly` 里 staged skill 那一层」 |
| S3 | 放入**完整** `.geoly` fixture | `N3 = N2`、canary 命中 0、其余条目逐名一致、退出码与 stderr 与基线相同 |

**S1 不成立（读数不动）时该格判 `VOID-MEASUREMENT-INSENSITIVE`，不判通过。**
🔴 这是上一轮栽跟头的地方，所以做进了脚本的判定里 —— 不靠人记得去看。

⚠️ **上一轮那次无效测量，原样留在这里免得重犯**：当时 `catalog_entries` 在加了正对照之后
**仍然是 5**，说明测量根本不敏感。两个原因叠在一起：① 传了 `--ignore-user-config`，
客户端不读用户配置，也就不去扫那个目录；② skill 放错了根，压根不在被扫描的路径下。
修法是去掉 `--ignore-user-config`、把 skill 放进 `$CODEX_HOME/skills`，正对照随即 5 → 6。
**一个不动的读数不等于「没影响」，先证明测量本身会动；没有正对照的负结果没有意义。**

⚠️ 本轮的沙箱用 `env -i` + 临时 `HOME`/`CODEX_HOME` 做隔离，**没有**用
`--ignore-user-config` 这类「让客户端少读点东西」的开关 —— 那正是上一轮把测量搞死的原因。
隔离要靠换根，不靠让客户端别去看。

**这一轮的负结果之所以可信，全靠 S1/S2 这两个正对照都动过。** 六格里每一格都动了；
codex 读不到的那几个根（`.claude` / `.cursor`）S1 纹丝不动，被脚本判成 VOID ——
那几次**没有**被当成「codex 对这些目录也安全」的证据。

`.geoly` fixture 是**完整形态**，不是空壳：真的 `node:sqlite` 建的 `lock.db` + `-wal` + `-shm`、
`generation`、`ledger.json`、`audit-seq`、`journal/1.json`、`tx-1/stage/<n>/SKILL.md`、
`tx-1/retired/`、`attic/1/<n>.tar`、`quarantine/1/`、`audit-archive/`。
其中 `stage` 与 `attic` 里放的都是**有效、唯一、可识别**的 canary skill —— 否则测不出（Q12 明文要求）。

### 实测读数

`codex-cli 0.147.0`（读数＝模型可见 prompt 里的 skill 条目数）：

| target | S0 | S1 深度1正对照 | S2 同深度正对照 | S3 加 `.geoly` | canary 命中 | 退出码 | stderr |
|---|---|---|---|---|---|---|---|
| `$CODEX_HOME/skills` | 5 | **6** | **7** | **7** | 0 | 0 | 0 B |
| `<repo>/.codex/skills` | 5 | **6** | **7** | **7** | 0 | 0 | 0 B |
| `$HOME/.agents/skills` | 5 | **6** | **7** | **7** | 0 | 0 | 0 B |
| `<repo>/.agents/skills` | 5 | **6** | **7** | **7** | 0 | 0 | 0 B |

⚠️ **codex 这几格没有「请求体」这一项，别去找。** `codex debug prompt-input` 是离线渲染，
根本不发请求；它输出的**就是**模型可见的 prompt，catalog 与「模型看到的内容」是**同一份产物**。
所以这里只有一个 canary 命中数，不是两个 —— 报成两个等于把同一件事数了两遍。

`claude-code 2.1.246`（读数＝`init` 事件 `skills[]` 长度）：

| target | S0 | S1 深度1正对照 | S2 同深度正对照 | S3 加 `.geoly` | canary(catalog / 真实请求体) | 退出码 | stderr |
|---|---|---|---|---|---|---|---|
| `$HOME/.claude/skills` | 15 | **16** | 16 | **16** | 0 / 0 | 0 | 与基线逐字节相同 |
| `<repo>/.claude/skills` | 15 | **16** | 16 | **16** | 0 / 0 | 0 | 与基线逐字节相同 |

claude 这两格**确实有**独立的第二个判据：stub 把客户端真正发出去的 HTTP 请求体落了盘，
canary 在那份 84 KB 的 payload 里命中数为 0。这是 catalog 之外的另一件产物，不是同一个数。

四步之外还核对了：S3 的条目**逐名**与 S2 相同（不只是个数相同）。
canary 命中数：**codex 四格**查的是渲染出来的模型可见 prompt（离线，无请求体）；
**claude 两格**除 catalog 外**另查了真实请求体**。⚠️ claude 的请求体证据**不外推到 codex** ——
codex 那几格压根没有这件产物。

### 🔴 通过靠的是什么：两端各只有**一道**保护，而且不是同一道

这一节比「通过」二字重要得多 —— 它决定了什么情况下要复测。

| | 扫描递归吗 | 过滤点目录吗 | 于是挡住 `.geoly` 的是 |
|---|---|---|---|
| `codex-cli 0.147.0` | **是**（同深度正对照 6 → 7 证明它能到那一层） | **是**（`<target>/.geoly/SKILL.md` 不被加载） | **点目录过滤** |
| `claude-code 2.1.246` | **否**（同深度正对照 16 → 16，纹丝不动） | **否** | **扫描不递归** |

⚠️ **两端都只有一道保护，且互补** —— 任何一端改了扫描策略，这一格就得重测。

🔴 **由 claude 那一格推出一条硬约束**：claude **不过滤点目录**，
实测把 `<target>/.geoly/SKILL.md` 当成了一个**名为 `.geoly` 的 skill 加载**（15 → 16）。
所以 §3.2 的布局**永远不得**在 `<target>/.geoly/SKILL.md` 放任何文件。
现在的布局没有这个文件，这一格才通过 —— 这不是巧合带来的安全，是一条必须守住的不变量。

### 🔴 推翻：`~/.agents/skills` **有**读者

早先本文写着「用固定串核对（`grep -F '.agents/skills'`）两个二进制，命中数为 0
⇒ 该路径没有读者」，adapter 据此把 `agents` 两格标成 `unsupported / no-reader`。**那是错的。**

实测：`codex-cli 0.147.0` 把 `$HOME/.agents/skills` 与 `<cwd>/.agents/skills`
**都当作 skill root 加载**（正对照 5 → 6，且它渲染的 prompt 里直接列出了这两个 root）。

⚠️ **「二进制里搜不到这个字符串」证明不了「没有读者」。**
那条路径是运行时 `join` 拼出来的，二进制里根本不存在这个连续子串。
固定串 grep 只能**证存在**，不能**证不存在**；要证不存在得把客户端跑起来做正对照 ——
这正是 Q12 要求的做法。**上一轮用 `-F` 修掉了正则假阳性，却没意识到假阴性一直都在。**

`agents` 现在的状态是 `pending / scope-decision-pending`（不是 `unsupported`）：
证据完整，卡的是范围决策 —— `.agents` 没有自己的客户端，它是一条**共享约定路径**，
读者是 codex；同时启用 `codex` 与 `agents` 会让同一批 skill 在 catalog 里出现两次。
要不要把它纳入发车范围，得由人拍。

### 🔴 cursor：本机无法测量，且静态分析**预判失败**

**测不了的原因**（不是「懒得测」）：

- `cursor-agent 2026.02.27-e7d2ef6` 已安装（`~/.local/bin/cursor-agent`），
  但**未认证** —— 跑任何命令都直接 `Authentication required`，
  登录需要**交互式浏览器 OAuth**（`cursor-agent login`）。
- Cursor IDE **没装**（`/Applications/Cursor.app` 不存在）。
- 因此**没有任何运行时读数**，一个正对照都做不了。

**要闭合这两格需要**：登录 `cursor-agent`（交互式浏览器 OAuth），或安装 Cursor IDE；
然后按上面同一套四步协议重跑。

⚠️ **但这一格不是中性的「还没测」——静态分析指向失败。**
读它的 bundle（只读）看到的机制是**两道保护都没有**：

- Agent Skills 加载器逐级 `readdir` **递归**，深度上限 **10**，
  遇到任何名为 `SKILL.md` 的文件就收；
- 目录排除集只有
  `{node_modules, .git, .svn, .hg, __pycache__, .cache, dist, build, .next, .nuxt}`
  —— **不含 `.geoly`，也没有任何点目录过滤**；
- 而 `<target>/.geoly/tx-1/stage/<n>/SKILL.md` 在 target 下只有 **3 层**，远在 10 以内。

**预判：cursor 一旦能跑，很可能会把 `.geoly` 里 staged 的 canary 当成真 skill 收进去。**

🔴 **即便如此也没标 `unsupported`** —— Q12 要的是运行时验收，静态阅读不是实测。
标 `unsupported` 会把一个**预判**写成一个**结论**，跟把没测过写成测过是同一类错误，
只是方向相反。它留在 `pending / runtime-evidence-unavailable`，
并在 evidence 里写死了「预判失败」，防止下一个人把它当成大概率能过而顺手翻绿。

### ⚠️ 新发现的隐患：同一个物理目录会被**多个**客户端读

Q12 的验收单位是「client × scope」，但实际决定安全性的是**目录**：

- `$HOME/.agents/skills` 与 `<cwd>/.agents/skills`：读者是 **codex**（实测）。
- cursor 的监听目录集合（静态读到）是 workspace 与 home 各自的
  `.cursor/rules`、`.cursor/skills`、**`.agents/skills`**，
  并且在第三方扩展开关打开时**再加 `.claude/skills` 与 `.codex/skills`**。

含义：**cursor 一旦装上并启用第三方扩展，它可能会去扫 claude/codex/agents 的 target**，
而它恰好是唯一一个两道保护都没有的。本机 cursor 跑不起来，所以这条现在不咬人；
但它意味着「codex 那一格过了」不等于「装在 `.codex/skills` 里的 `.geoly` 在任何机器上都安全」。

**这条没有实测**（cursor 跑不起来，第三方扩展开关也没法开关对比），如实记为隐患，未纳入任何一格的结论。

### 🔴 实际测了什么（以及**没**测什么）

**测到了**：
- 八格中的六格有运行时读数（claude ×2、codex ×2、agents ×2）。
- 每一格都有**有效的正对照**（S1 读数动了，且 canary 名恰好 1 次）。
- 每一格都有**同深度正对照**，回答了「扫描能不能到达 staged skill 那一层」。
- `.geoly` fixture 是完整形态，canary 是有效且唯一的 skill。
- 判据包含：条目数、**逐名一致**、canary 在 catalog 与**真实请求体**里的命中数、
  退出码、stderr 与基线的逐字节比对。

**没测到**（不要当成已知）：
- **cursor 两格**：零运行时证据，见上。
- **端到端的路由/调用**：证明的是「模型看到的 skill 清单没变」——
  即路由的**输入**逐条一致、canary 从未进入请求体。
  **没有**真的去调用一个 skill 看它路由到哪。Q12 原文要的是「不影响其它 skill 的加载与路由」，
  这里覆盖的是**加载**与**路由输入**，不是路由行为本身。
- **客户端升级后的复测**：门绑定的是上面那两个版本号，升级即失效。
- **第三方扩展开关开/关两种情况下的 cursor 行为**。
- **项目级 `.gitignore` 是否真的覆盖到 adapter 派生的实际路径**：
  adapter 里 `gitignorePattern()` 会生成 `/.claude/skills/.geoly/` 这种模式并有单测，
  但**没有**在真仓库里用 `git check-ignore` 验过实际生效。

⚠️ **一个通过的正对照只证明「这一次测量有效」，不证明「所有客户端都安全」。**
六格通过不等于 Q12 全部闭合 —— 八格里还有两格是空的。

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
- adapter 与 target 预检（只启用 Q12 已通过的 client/scope 组合 ——
  2026-08-26 起这个集合**不再是空的**：claude 与 codex 的 global/project 四格）
- ledger/journal 与事务内核
- M1 命令面端到端

已完成的基础模块：`runtime/bin`、`canonical-json`、`atomic-fs`、`tree-digest`/`tx-digest`、`lock`。
埋点子系统见 `docs/telemetry/00-spec.md`（P1 增量，不阻塞上面这些）。

### Gate 1 留下的待办

- 🔴 **cursor 两格**：本机跑不起客户端（未认证 + IDE 没装），静态分析**预判失败**。
  要么补上运行环境重跑四步协议，要么按「某一端不通过 → 只把那一端标为不支持」处理 ——
  但后者需要先有实测，现在还没有。
- 🔴 **agents 两格等范围决策**：证据完整（读者是 codex，实测通过），
  但 `.agents` 与 `codex` 读的是同一个客户端，两个都启用会让 skill 在 catalog 里重复。
- 客户端升级即复测：门绑定的是 `claude-code 2.1.246` 与 `codex-cli 0.147.0`。
- 项目级 `.gitignore` 只验了生成的模式，没在真仓库里用 `git check-ignore` 验实际生效。
- Q12 还要求 README 说明 🔴 `git clean -xfd` 会删掉整个 `.geoly/`
  （既包括进行中的事务状态，也包括本地 audit 历史）—— 文案未落地。
  （adapter 里 `postInstallHint` / gitignore 那几条单测覆盖了提示文案，
  但 README 本身没有这一段。）
- 🔴 **本轮的实测 harness 没有进仓库。** 四步协议、`.geoly` fixture 生成、
  `VOID-MEASUREMENT-INSENSITIVE` 判定、请求体核对，目前都只存在于一次性脚本里；
  `test/adapters.test.mjs` 只能核对 evidence 文案**说了什么**，核对不了那些读数**是不是真的**。
  ⚠️ 也就是说：现在把 evidence 里的数字改成任意值，测试照样全绿。
  要让这道门可复现（以及客户端升级后能一键复测），需要把 harness 落到
  `scripts/` 或 `test/` 下 —— **本次改动的文件边界不含新文件，留给接线的人**。
  （Codex 复核时把这条列为 P2。）
