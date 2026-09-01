# skills-hub registry 站点 · 设计规格

本文写给实现者，具体到能照着写 CSS。可视证据在同目录的 [`design-preview.html`](design-preview.html)
（单文件自包含，浏览器直接打开，右上角三态切亮/暗）。**token 名与该页一一对应**，实现时直接抄那份
`:root` 块即可。

> 🔴 **这是 2026-09 的整份重写，不是补丁。** 上一版是「greenbar 会计台账」方向（淡绿中性色、
> Archivo + IBM Plex、2px 栏线、圆角 2–3px）。用户看过实物后判定方向要重做，**借鉴 Claude / Anthropic
> 的设计语言**。上一版 §1.8 那张「主动回避的 AI 套路」表里禁掉的「暖米色 + 衬线标题 + 陶土色强调」
> **对本版整体作废** —— 那恰恰就是 Anthropic 的设计语言，而它是用户指定的方向。
>
> **但视觉换了，信息决策一条都没换。** 本文里带 🔴 的条目全部是正确性问题（不是审美问题），
> 新视觉与它们冲突时**改视觉，不改它们**。

> 快照 record 的字段形状以 `src/snapshot.mjs` 的 `parseSnapshot()` / `validateRecord()` /
> `validateProvenance()` 为准。**但页面上的数据不止来自快照**，见 §1.2 的来源表——
> 别把「快照里有的」和「页面要显示的」当成同一件事。

---

## 0. 目录

| § | 内容 |
|---|---|
| 1 | 主张与三条轴（信息决策，不可让步） |
| 2 | 调研：真的 Claude / Anthropic 界面长什么样 |
| 3 | 核心解法：**两种纸** |
| 4 | 配色 |
| 5 | 字体（含 CJK 回落） |
| 6 | 排版尺度、间距、圆角、边框、阴影 |
| 7 | 图标：三个形状族 |
| 8 | 组件逐个规格 |
| 9 | 布局与响应式 |
| 10 | 动效 |
| 11 | 可访问性（含实测数值） |
| 12 | 实现者自查清单 |

---

## 1. 一句话主张与不可让步的信息决策

**别的 registry 展示的是「有多少人在用」，我们展示的是「这东西是谁签的、谁审的、从哪来的、现在还能不能用」。**

### 1.1 🔴 九条硬约束（全部是正确性，不是品味）

1. 🔴 **页面上不出现任何使用量数字。** 下载量、装机量、调用量、star、评分、趋势图——我们没有这些数据
   （埋点是纯本地的），编出来就是撒谎。**布局里也不给它们留位置**：不要画一个"以后放下载量"的角落。
2. 🔴 **信任信息是主角。** 详情页里信任面板紧贴标题、位于描述之上、占满正文宽度。
   **全站不设右侧 metadata 栏**（npm 把 provenance 塞右栏是明确的反面教材）。
3. 🔴 **不给一个综合绿勾。** 拆成四格独立结论：签名身份 / Rekor logIndex / 树摘要 / 快照时效。
4. 🔴 **三条状态轴刻意不共用图形**，默认态是「未验证」而不是绿勾。见 §1.3、§7。
5. 🔴 **摘要给全串**，8×8 分组**靠 margin 不靠空格**，首尾组加粗，`user-select: all`。见 §8.7。
6. 🔴 **capability Tier 0/1/2 要一眼分得出**，且 Tier 徽章与生命周期标记**形态不同**。见 §8.5。
7. 🔴 **空状态是第一等公民** —— registry 现在真的是 0 个制品。见 §8.11。
8. 🔴 **大写只给表头与我们自己造的标签，不给数据。** semver 区分大小写，
   `1.1.0-rc.1` 被 `text-transform:uppercase` 渲染成 `1.1.0-RC.1` 就是**把值改了**。
9. 🔴 **对比度 ≥ 4.5:1**（大字/图标级 ≥ 3:1）。上一版实测踩过 4.42:1 的坑，本版逐元素实测过，见 §11.1。

### 1.2 页面数据与验证来源

实现者必须知道每个值从哪来、在什么时点算「已验证」。

| 数据 | 来源 | 何时算已验证 |
|---|---|---|
| `id` / `kind` / `namespace` / `name` / `version` / `path` / `tree_digest` / `asset` / `clients` / `capabilities` / `replaces` / `conflicts` / `license` / `owner` / `provenance` / `status` / `review` | 快照 record | 快照签名（`release.yml` 身份）+ `sha256 == timestamp.snapshot_sha256` 都过之后 |
| `yanked[]`（`id` / `at` / `reason` / 可选 `advisory` / 可选 `superseded_by`）、`latest{}` | 快照顶层 | 同上 |
| `snapshot` / `previous` / `created_at` / `repo` | 快照顶层 | 同上 |
| timestamp 的 `version` / `latest_snapshot` / `min_cli_version` / `valid_until` | `timestamp.json` | 其自身签名（**`timestamp.yml` 身份**，与快照不是同一个）+ freshness |
| Rekor `logIndex`、上链时间、signer identity / issuer | Sigstore bundle / Rekor | 验签结果本身 |
| attestation 的 `sourceCommit` / `workflowRef` / `promotionPr` | `attestations/hub-<N>.intoto.jsonl`（DSSE） | 独立验签；**安装链路不读它，它只服务取证** |
| `description`、`SKILL.md` 正文、pack 的 `members[]` / `role` / `order` / `contract_paths` / `compatibility` | **制品载荷内部**的 `skill.json` / `pack.json` / `SKILL.md` | 🔴 只有在 `asset.sha256` 与 `tree_digest` 都核对通过之后才算已验证 |

🔴 **载荷里的东西（描述、pack 成员表）在摘要核对通过之前必须标为未验证**，
不要和快照里的字段混在同一张表里不加区分。快照 record 里**没有** `description`、**没有** `members`。

### 1.3 🔴 三条轴，永远不许混

这是本设计最容易被实现者做错、且做错代价最大的一点。

| 轴 | 取值 | 来自哪 | 表达什么 |
|---|---|---|---|
| **A 生命周期** | `published` / `deprecated` / `yanked` / `degraded` | 快照 record 的 `status` 字段（已被签名覆盖） | **维护者的处置** |
| **B 验证** | `verified` / `stale` / `unverified` / `failed` | `resolveCurrent()` 本次运行的结果，**不在快照里** | 我们这一次到底验没验、验过没过 |
| **C 本地比对** | 相同 / 不同 / 取不到 | 本机拿两串字节比了一下 | **既不是处置，也不是担保** |

三轴正交：一个 `published` 的制品完全可能**验签失败**；一个 `yanked` 的制品签名照样有效；
两串字节相同也**不构成任何担保**。

**新方案是这样彻底分开的（详见 §7）：**

- **形状族 = 轴，族内形态 = 取值。** A 是**方族**（用填充度表达处置），B 是**圆族**，C 是**等号族**。
- 🔴 **全族里只有圆族有勾，而且那个勾被圆圈住。** 所以界面上任何一个勾都只可能是
  「我们这一次验过了」，不可能是别的意思。
- 🔴 **三条状态轴一律不使用感叹号图形。** 上一版 `deprecated` 与 `stale` 共用 `i-bang`，
  这一版 `deprecated` 改用半填充方、`stale` 改用圈内钟。
  （中性图标 `u-note` 仍是三角感叹，但它**不属于任何一条轴**，只用于「这是一句提示」。）
- 🔴 **`published` 不给绿色**（给了会被读成「验过了」）；**「两串字节相等」也不给绿色**。
  **全站只有一处绿色**，就是验证轴的 `verified`。这一条颜色纪律本身就堵死了大半的混淆。

> **上一版的两个已知缺口，本版的堵法**
> 旧实现里生命周期的 `published` 与验证的 `verified` 共用 `i-check`，
> `deprecated` 与 `stale` 共用 `i-bang` —— 于是「维护者说可以装」和「我们验过了」
> 在界面上成了同一件事。本版通过「形状族分离 + 删掉 bang + 绿色唯一化」三条同时堵上。
> 实现方应加一条静态检查兜底，见 §7.3。

---

## 2. 调研：真的 Claude / Anthropic 界面长什么样

**这些不是印象，是从 Anthropic 自己的样式表里抓出来的。** 两个互相独立的代码库
（营销站的 `swatch-*` token 与 docs / 产品端的 `cds-*` token）取值几乎一致，可信度高。

来源：
- `anthropic.com` 引用的 `ant-brand.shared.*.min.css`
- `platform.claude.com/docs`（`docs.anthropic.com` / `docs.claude.com` 现重定向到这里）的
  Next.js CSS chunk

### 2.1 抓到的具体值

| 项 | 值 | 备注 |
|---|---|---|
| 主背景（暖白/象牙） | `--swatch--ivory-light: #FAF9F5` | **主**页面底。产品端对应 `#F9F9F7` |
| 次级背景 | `--swatch--ivory-medium: #F0EEE6` | 区块/次级面。网上常被误传成"主"底色 |
| 更暗的象牙 | `--swatch--ivory-dark: #E8E6DC` | 分隔线/边框 |
| **强调色（内部叫 clay）** | `--swatch--clay: #D97757` = `--cds-clay` | 品牌主强调，亮/暗**两套里都不变** |
| 强调 hover | `#C6613F`（`clay-emphasized`） | 网上流传的 `#CC785C` 与它不同；`#DA7756` 只是 `#D97757` 的抄错 |
| 主墨色 | `--swatch--slate-dark: #141413` | 产品端 `#131313`。**不是**流传的 `#191919` |
| 次级/三级文字 | `#3D3D3A` / `#5E5D59` | 产品端 `#383835` / `#6D6B67` |
| 暗色底 | 灰阶 `#20201F → #151515 → #111 → #0D0D0D` | 从卡片往下逐级变深 |
| 暗色文字 | `#F9F9F7` / 次级 `#C3C2B7` | 暗色发丝线来自 `#E1E0D9` 低透明度 |
| 圆角 | `0.25rem / 0.375rem / 0.5rem / 1rem` | 即 4 / 6 / 8 / 16px。**没有胶囊**（`100vw` 只用于个别按钮） |
| 阴影 | 多层极淡叠加，如 `0 2px 2px #00000003, 0 4px 4px #00000005, 0 16px 24px #0000000a` | 「纸被托起一点点」，不是 Material 的硬投影。UI 主要靠 1px 低透明度发丝线定形 |
| 次级色板 | `kraft #D4A27F` · `manilla #EBDBBC` · `heather #CBCADB` · `olive #788C5D` · `fig #C46686` · `oat #E3DACC` · `cloud #87867F/#B0AEA5/#D1CFC5` · `sky #6A9BCC` · `cactus #BCD1CA` | 编辑感、去饱和的一组，用于插图与色片，**不是 UI 主色** |

字体（全部自有/授权，拿不到）：
- `Anthropic Sans`（Styrene 一脉，Berton Hasebe / Commercial Type）
- `Anthropic Serif`（Tiempos 一脉，Klim）—— docs 的 bundle 里还留着 `Tiempos Text` 的字面量
- `Anthropic Mono` —— 同一个 bundle 里也出现了 `Jetbrains Mono` 的字面量
- **Anthropic 自己公布过替代品**：Sans → **Inter**，Tiempos/Serif → **Source Serif 4**。
  本设计直接采用这份官方替代表（见 §5），不自己猜。

### 2.2 🔴 最要紧的一条：他们的 docs 怎么处理密集技术信息

这是本次调研的核心，因为我们的密度远高于 `claude.ai`。`platform.claude.com/docs` 的做法：

- **行内 code**：`0.5px` 细边框 + `--cds-alpha-1` 底（约 5% 的 `currentColor` 混色）+
  `border-radius: .3rem` + `padding: 1px 4px` + `font-size: .9rem`。
  **不是**深色块，是一层几乎看不见的浅色薄片。
- **代码块 `pre`**：底色是 `color-mix(in oklab, currentColor 5%, transparent)`——
  **就是把周围文字色调出 5% 铺一层**，所以它在亮/暗两套里自动成立；
  `0.5px` 边框、`border-radius ≈ 0.56rem`、`padding: .875rem`、`white-space: pre`、`overflow-x: auto`。
- **表格**：`border-collapse: separate` + 外框 1px + 圆角；`th` 用同一个 5% 混色底 + `font-weight: 600`；
  单元格 padding `.4375em .75em`。
- **行距是分档的**，不是一个全局值：`--cds-leading-body / heading / caption / code / title / footnote`
  各自独立。
- **告警框**：danger / warning / success / info 各有 4 档 HSL 色阶（如亮色 `--danger-000: hsl(0 58.6% 34.1%)`
  ≈ `#8A2424`，`--warning-000: hsl(45 91.8% 19%)` ≈ `#5D4704`）——
  **深墨 + 极淡底**，不是饱和实心块。

**结论（直接决定了 §3 的解法）**：Anthropic 处理密集信息的手法，是**把密集内容放进一层
5% 的浅色凹陷薄片里**，用发丝线定形，让它与周围温暖的叙述版面**在材质上分开**，
而不是把温暖的皮套在表格上。这正好是我们需要的机制，我们只是用得更狠。

### 2.3 从别的 registry 借来、以及明确否掉的

| 来源 | ✅ 借鉴 | ❌ 否掉 |
|---|---|---|
| pkg.go.dev | **一组独立的质量事实代替一个综合评分**（我们的四格链条同源）；用陈述句而不是要解读的图标 | 顶部 tab —— 信任信息不允许藏在 tab 后面 |
| npm provenance | 「公开账本」这个措辞：强调「不用信我，去看账本」 | **把 provenance 做成版本号旁一个绿勾 + 右栏一小节** —— 本设计最重要的反面教材 |
| PyPI attestations | 字段清单（statement/predicate type、subject digest、日志条目、commit 永久链接、workflow、issuer）；`Uploaded using Trusted Publishing? Yes` 这种问句+答案的表达 | 折进 tab 深处、默认收起 |
| Homebrew formula | 极高密度、几乎零装饰的 `key: value` 行 + 平台支持表 | 底部的 installs 30/90/365 天分析 |
| Sigstore Rekor 搜索 | 一个查询框接受多种标识符形态，**包括直接粘一串 hash**；日志条目原样列出不美化 | 完全没有层级的大段 JSON |
| crates.io | 三态主题（system / light / dark），默认跟随系统 | 首页最显眼的下载曲线；卡片阴影堆叠 |
| lib.rs | 把**体量当事实**（我们给 `asset.size` 的**精确字节数**，KiB 只作括注） | `#19 in Encoding` 排名、月下载量 |

---

## 3. 🔴 核心解法：两种纸

**这是本次重做要解决的真问题**，也是整份规格里唯一需要设计判断的地方：
Claude 的语言是**温暖、编辑感、留白充裕**，而我们的页面是**高密度技术信息**
（64 位摘要、字段表、成员关系、四格验证）。两者天然有张力。

### 3.1 解法

**页面上有两种纸，它们材质不同、规则不同、量度不同。**

| | **叙述纸** narrative paper | **记录纸** record paper |
|---|---|---|
| 底色 | `--c-paper` `#FAF9F5`（象牙） | `--c-inset` `#EDEAE0`（凹陷的暖灰） |
| 谁在说话 | **页面在说话** | **机器在说话**，页面只负责逐字转述 |
| 字体 | 衬线标题 + sans 正文 | **只有 sans 与 mono，衬线字不许进入** |
| 量度 | `max-width: 68ch` | 占满正文列宽（表格需要宽度） |
| 行距 | 1.7（拉丁）/ 1.85（中文） | 1.5；台账行高 10px |
| 圆角 | 8px / 16px | 6px / 8px |
| 装什么 | 标题、lede、说明段、警示条文案 | 台账 `dl`、成员表、摘要、命令块、验证链条、卡片事实条 |

🔴 **「记录纸」是一个真实的背景色，不是一种排版氛围。**
台账 `dl`、成员表、验证链条、命令块、卡片事实条、provenance 轨迹的**容器**必须真的铺
`--c-inset`。最容易做错的形态是：把台账放进一个 `--c-paper` 的 `.panel` 里，
只把排版收紧——那造出的是规格里不存在的**第三种纸**（叙述纸底 + 记录排版），
两种纸的对比也就只剩说明文字。
实现上给 panel 一个修饰类：

```css
.panel > .body.record { background: var(--c-inset); border-radius: 0 0 var(--r-md) var(--r-md); }
```

面板 header 仍是叙述纸（那是页面在给这块记录起标题），body 才换纸。
同理，表格容器 `.tablescroll` 的 `--c-inset` 底**不许被内联样式洗成 transparent**。

### 3.2 三条派生规则（照着执行就不会走偏）

1. 🔴 **留白花在记录纸<u>之间</u>，不花在记录纸<u>里面</u>。**
   区段之间 64px、块之间 16–24px，而一条台账行只有 10px。
   结果是：**站远看是松的，凑近读是密的**——这正是编辑设计处理表格的一贯做法。
   不要因为「Claude 很松」就把 `dt`/`dd` 的行高撑到 16px，那会让一屏放不下一个制品的事实。
2. 🔴 **衬线字永不进入记录纸。** 记录纸里的小标题一律 sans、11.5px、`letter-spacing:.08em`、大写。
   衬线是页面**谈论**数据时的声音；进了记录纸就该由机器自己说话。
3. 🔴 **等宽字从「主力」降为「引文体」。**
   上一版所有字段名、标签、徽章都是 mono。本版：**字段名（`dt`、`.fact .k`）改用 sans**，
   **只有机器原文**（标识符、摘要、命令、`status` 字面值、字节数、时间戳）才是 mono。
   - 效果：mono 的字形覆盖率从约六成降到约三成，页面温度立刻上来；
     同时 mono 重新有了意义——「**这一段是可以逐字节拿走的引文**」。
   - 🔴 **复制保真度完全不变**：值仍然是 mono + `user-select:all` + 分组靠 margin。
     这条改的是**标签**的字体，不是**值**的字体。

### 3.3 警示怎么做到显眼而不惊悚

🔴 **换一张纸，而不是加饱和度。** 这是本设计对「温暖调子里的警示」的回答。

在一页全是暖象牙的版面里，**把暖色撤掉**比再加一点红更刺眼，而且它读起来像
「这条记录被划掉了」，不像「系统出错了」。强度由**三个通道叠加**得到，一个都不靠喊：

| 状态 | 纸样 | 顶边 | 附加通道 |
|---|---|---|---|
| `yanked` | `--p-grey` `#EDEDEB` —— 🔴 **全站唯一一处撤走暖色的纸** | **3px** `--c-revoked` | 🔴 卡片内链接的 clay 下划线一并撤掉，换成灰下划线 |
| `degraded` | `--p-heather` `#E8E7EF`（冷调淡紫，取自 Anthropic 的 heather） | **3px** `--c-degraded` | 仍带色相 —— 与 yanked 的中性灰一眼区分 |
| `deprecated` | `--p-manilla` `#F4EAD4`（发黄的旧纸，取自 manilla） | **2px** `--c-caution` | 🔴 **卡片上不换纸**（它仍可安装，换纸会过度报警），只在警示条上换 |

**禁止**：满色实心红条、大号警告图标、感叹号轰炸、闪烁。这些是**事实，不是错误**。

### 3.4 摘要串与字段表怎么在暖白+衬线的语境里不违和

- **摘要串**放进记录纸，**不放在叙述纸上裸奔**。前缀 `geoly-tree-v1:sha256:` 用 `--c-text-dim`，
  64 hex 用 `--c-text`，首尾组加粗——于是它在版面上读起来像一条**引文**，而不是一段乱码。
- **字段表**（台账 `dl`）左列 sans 12px `--c-text-mid`，右列值 mono。
  左列的 sans 把它拉回「这是一份文档」，右列的 mono 保证「这是原样的字节」。
- **命令块**沿用 Anthropic docs 的 `pre` 做法：5% 混色底 + 发丝线 + 8px 圆角 + `overflow-x:auto` +
  **不换行**（命令换行会被误复制成两行），`$` 提示符 `user-select:none` 且用 clay 着色。

---

## 4. 配色

### 4.1 亮色（`:root`）

```css
/* ── 中性：暖象牙。直接取自 Anthropic 的样式表 ── */
--c-page:      #F0EEE6;   /* 页面底（ivory-medium） */
--c-paper:     #FAF9F5;   /* 叙述纸：正文面板、卡片（ivory-light） */
--c-inset:     #EDEAE0;   /* 记录纸：台账、表格、命令、摘要的凹陷底 */
--c-hairline:  #DEDACB;   /* 1px 分隔 */
--c-rule:      #C9C3AF;   /* 面板外框、表格外框 */
--c-rule-hi:   #B3AB93;   /* 区段界线 */

--c-text:      #141413;   /* slate-dark */
--c-text-mid:  #4A473F;
--c-text-dim:  #605C51;   /* 🔴 见 §11.1：#6B675C 实测只有 4.19:1，压深过 */

/* ── 强调：clay。🔴 必须拆成两个 token ── */
--c-clay:      #D97757;   /* 品牌值。只用于**非文字**：下划线、计量条、焦点环、装饰线、节点圆点 */
--c-clay-ink:  #A34428;   /* 文字安全的 clay。链接 hover、小号强调字、`$` 提示符 */

/* ── 语义色：全部是「颜料」，不是霓虹 ── */
--c-ok:        #43632B;   /* 🔴 全站唯一的绿。只表示「验证轴：我们这一次验过了」 */
--c-caution:   #855313;   /* kraft ink：deprecated / stale / Tier 1 / 预期内的不相等 */
--c-revoked:   #93291E;   /* oxblood：yanked / Tier 2 */
--c-degraded:  #74304F;   /* mulberry：degraded —— 被成员拖累 */
--c-neutral:   #605C52;   /* Tier 0、published（🔴 published 不给绿色） */

/* ── 纸样 paper stocks：警示靠换纸，不靠加饱和度（§3.3） ── */
--p-manilla:   #F4EAD4;
--p-grey:      #EDEDEB;
--p-heather:   #E8E7EF;
--p-ok:        #E9EEDE;
--p-clay:      #F7E7DE;
```

### 4.2 暗色

同时定义在 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`
与 `:root[data-theme="dark"]` 两处（手动切换要能双向覆盖系统偏好）：

```css
--c-page: #1A1917; --c-paper: #22211E; --c-inset: #191816;
--c-hairline: #343329; --c-rule: #4A483E; --c-rule-hi: #5C5A4E;
--c-text: #F9F9F7; --c-text-mid: #C3C2B7; --c-text-dim: #A4A195;
--c-clay: #D97757;        /* 🔴 不变 —— Anthropic 亮/暗两套里 clay 都是同一个值 */
--c-clay-ink: #EE9873;
--c-ok: #A3C275; --c-caution: #E2B563; --c-revoked: #F2938A;
--c-degraded: #DB9FC5; --c-neutral: #ABA89B;
--p-manilla: #2E2820; --p-grey: #2B2B2E; --p-heather: #262533;
--p-ok: #232A1D; --p-clay: #35251E;
```

- 暗底不是纯黑，是**暖近黑** `#1A1917`（Anthropic 的暗色灰阶是暖的，不是蓝黑）。
- 🔴 **`--p-grey` 在暗色里必须偏冷**（`#2B2B2E` 对 `#22211E`）。
  「撤走暖色」这个机制在暗色里靠色温差成立；如果 grey 也是暖的，yanked 与普通卡片就分不开了。
  实测过：`#272726` 太近，改成 `#2B2B2E` 才拉开。
- 🔴 暗色的 `--c-text-dim` 是 `#A4A195` 而不是 `#9A978B` —— 后者在 `--p-grey` 上只有 4.37:1（§11.1）。

### 4.3 使用纪律

- 🔴 **`--c-clay` 不能当正文色。** 实测在 `--c-paper` 上只有 **2.96:1**（§11.1）。
  它只画线不写字；文字一律 `--c-clay-ink`（实测 5.84:1）。
  **暗色下 clay 是 5.08:1，可以写字**——但为了两套一致，仍统一走 `--c-clay-ink`。
- 🔴 **`--c-clay` 不表达任何状态。** 它只说「这里可点 / 这是当前项 / 这里有焦点」。
  一个 `published` 的制品**不是 clay 色的**。
- 🔴 **全站只有一处绿色**：验证轴的 `verified`（`--c-ok` 与 `--p-ok`）。
  `published` 用 `--c-neutral`，「两串字节相等」用 `--c-text-mid`。
- 🔴 **状态永远同时给词。** 颜色是第二通道，`published` / `yanked` / `degraded` / `deprecated`
  必须**原样小写**出现在界面上（它们是 `status` 字段的字面值，用户会在 CLI 输出里再见到）。
- **`--c-caution` 有一个非警告用途**：表示「**预期内的不相等**」，例如 vendored 的
  `origin_tree_digest ≠ tree_digest`（多了 `skill.json`，本就不该相等）。
  这种情况**不许用 `--c-revoked`**，否则会把正常现象报成故障。
- **链接**：`color: inherit` + `text-decoration-color: var(--c-clay)` + `text-underline-offset: 3px`；
  hover 时 `color: var(--c-clay-ink)` 且下划线转 `currentColor`。
  这样链接既有 clay 的暖意，又不受 clay 对比度不足的限制。

---

## 5. 字体

### 5.1 三个角色

| 角色 | 字体 | 用途 | 依据 |
|---|---|---|---|
| Serif | **Source Serif 4**（可变，`opsz` 轴） | 🔴 **只用于 ≥20px 的标题**：页面标题、区段标题、警示条标题、空状态主句、wordmark | Anthropic 自己公布的 Tiempos / Anthropic Serif 替代品 |
| Sans | **Inter** | 正文、说明段、全部 UI 字符串、**字段名与标签** | Anthropic 自己公布的 Anthropic Sans 替代品 |
| Mono | **JetBrains Mono** | 🔴 **引文体，不是主力**：ArtifactId、摘要、命令、`status` 字面值、时间戳、字节数、输入框 | 它的字面量直接出现在 Anthropic docs 的 CSS bundle 里 |

🔴 **衬线只用于 ≥20px。** 屏幕上小字号的宋体（中文回落，见 §5.3）过细；
`≤19px` 的标题一律 sans。警示条标题因此定在 **20px 衬线**——
它的分量来自字号与字形，不来自红色。

### 5.2 `<link>`（实现方直接抄）

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400..700;1,8..60,400..600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

Next.js 项目用 `next/font/google` 等价加载（`Source_Serif_4` 需 `axes: ['opsz']`），
并把返回的 CSS 变量映射到 `--f-serif` / `--f-sans` / `--f-mono`。

Inter 建议开 `font-feature-settings: "cv05" 1, "cv08" 1`（单层 `a`、有尾 `l`），
让它离「默认安全牌」的观感远一点，也让 `l` / `1` 更分得开。

### 5.3 🔴 中文回落（CJK fallback）

中文是正文主体，而三个网络字体**都不含 CJK**。

```css
--f-serif: "Source Serif 4", "Source Han Serif SC", "Noto Serif CJK SC",
           "Songti SC", STSong, SimSun, Georgia, serif;
--f-sans:  "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
           "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
           "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
--f-mono:  "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas,
           "PingFang SC", "Microsoft YaHei", monospace;
```

规则：

- 🔴 **一律不 web 加载任何 CJK 字体**（Noto Sans SC 全量 5–10 MB，子集化后仍不可控）。中文走系统栈。
  `"Noto Sans/Serif CJK SC"` 写在末尾是给已装该字体的 Linux 用，不是网络加载。
- ✅ **这一版里「中文标题掉进宋体」不再是 bug，而是设计意图。**
  上一版是无衬线方向，中文回落到宋体是走音；本版整套方向就是衬线，
  **思源宋体 / Songti SC 与 Source Serif 4 是同一种声音**，中西混排天然协调。
  这是选衬线方向白捡的一个好处，值得写进规格免得实现者「修」掉它。
- 🔴 **但只在 ≥20px 用衬线**（§5.1）。小字号宋体在屏幕上太细，`≤19px` 走 `--f-sans`。
- CJK 字形视觉上比拉丁大：**中文为主的标题按拉丁标题字号 × 0.94**，或给中文块
  `letter-spacing: 0`（拉丁大写标签的字距不要带到中文上）。
- 中文正文行距 **1.85**（拉丁 1.7）。用 `:lang(zh)` 或一个 `.cn` 类挂。
- `--f-mono` 里也要挂中文，否则 mono 段落里夹的中文会回落到默认字体，行高会跳。
- 🔴 **`.label`（大写小标签）永远只放拉丁与数字。**
  `text-transform: uppercase` 对中文无效，`letter-spacing: .08em` 会把中文拉散。
  **标签里只要出现一个汉字，就必须换成 `.label-cn`**（`--f-sans` 12px / 600 / 不大写 / 无字距 /
  `--c-text-dim`）—— 这是硬规则，不是建议。
  中英混排的小标签（`A · 生命周期 lifecycle`、`纸样 · paper stocks`）也算「出现了汉字」，
  一律走 `.label-cn`；为此损失的那点 small-caps 观感，换的是中文不被拉散。
  实现方应加一条检查：`.label` 元素的 `textContent` 不得匹配 `/[\u4e00-\u9fff]/`。

---

## 6. 排版尺度、间距、圆角、边框、阴影

### 6.1 字号阶梯

| token | px | line-height | 字体 | 用途 |
|---|---|---|---|---|
| `--fs-title` | 34 | 1.25 | serif | 空状态主句、页面级标题（窄屏降到 27） |
| `--fs-h2` | 22 | 1.25 | serif | 区段标题（窄屏 20） |
| `--fs-h3` | 15 | 1.3 | sans 600 | 面板 header |
| `--fs-aid` | 17 | 1.4 | mono 500 | 详情页 h1 的 ArtifactId、卡片身份行 |
| `--fs-lg` | 17 | 1.7 | sans | lede / 首段 |
| `--fs-base` | 15 | 1.7 / 1.85 | sans | 正文 |
| `--fs-sm` | 13.5 | 1.6 | sans | 说明、卡片描述、台账 `dd` |
| `--fs-mono` | 12.5 | 1.5 | mono | 摘要、命令 |
| `--fs-xs` | 12 | 1.5 | 混 | 次要事实值、字段名 |
| `--fs-label` | 11.5 | 1.4 | sans 600 | 大写小标签，`letter-spacing: .08em` |

字距：只有 `.label` 与 Tier 徽章加字距（`.06em`–`.08em`）；`--fs-title` / `--fs-h2` 用
`-.005em ~ -.008em` 微收；**正文与 mono 不改字距**（改 mono 字距会让 hex 分组对不齐）。

### 6.2 间距尺度（4 的倍数）

`--sp-1: 4 / --sp-2: 8 / --sp-3: 12 / --sp-4: 16 / --sp-5: 24 / --sp-6: 32 / --sp-7: 48 / --sp-8: 64 / --sp-9: 96`

- 区段之间 `--sp-8`；块之间 `--sp-4`；行内元素间隙 `--sp-2`；面板/卡片内边距 `--sp-4`。
- 🔴 **台账行（`dt`/`dd`）纵向 10px**，不在尺度上，是刻意的紧凑值：记录纸要密（§3.2 规则 1）。

### 6.3 圆角

Anthropic 的尺度：**`--r-xs: 4px` / `--r-sm: 6px` / `--r-md: 8px` / `--r-lg: 16px`。**

- 面板、卡片、记录纸块、验证链条、表格容器、警示条：`--r-md`
- chip、徽章、按钮、命令块、卡片内事实条：`--r-sm`
- kbd、`.tag`：`--r-xs`
- 空状态大容器：`--r-lg`
- 🔴 表格单元格与列表行 **0px**（由外层容器 `overflow: hidden` 裁圆角）。
- 🔴 **全站不出现 `border-radius: 999px` 的胶囊。**

### 6.4 边框与分隔线

| 用法 | 值 |
|---|---|
| 行分隔、块外框 | `1px solid var(--c-hairline)` |
| 面板/表格外框、输入框 | `1px solid var(--c-rule)` |
| 警示状态强调 | `border-top: 2px / 3px solid <语义色>` —— 🔴 **只在顶边，绝不用左竖条** |
| 可复核命令块 | `1px solid var(--c-hairline)` + `--c-inset` 底 |
| 搜索框聚焦 | `border-color: var(--c-clay)` + `box-shadow: 0 0 0 3px color-mix(in oklab, var(--c-clay) 25%, transparent)` |
| provenance 轨迹竖轨 | `1px dashed var(--c-rule)`，节点圆点 `--c-clay` |

### 6.5 阴影

**全站仅一处**，用于弹出层（下拉、tooltip）。抄 Anthropic 的多层极淡叠加：

```css
--shadow-pop: 0 2px 2px rgba(20,20,19,.012), 0 4px 4px rgba(20,20,19,.02),
              0 16px 24px rgba(20,20,19,.04), 0 0 0 1px var(--c-hairline);
```

🔴 **卡片、面板、记录纸块一律无阴影。** 记录纸是**凹陷**的，不是抬起的——
给它阴影会把「这是被引用的机器原文」读成「这是一张浮起来的卡片」。

---

## 7. 图标：三个形状族

全部 inline SVG，`16×16` viewBox，渲染 `13×13`（警示条 `16×16`），`stroke: currentColor`。
**不用 emoji，不用图标字体。**

### 7.1 族与成员

🔴 **形状族 = 轴，族内形态 = 取值。**

| 族 | 轴 | 成员 | 图形 |
|---|---|---|---|
| **方族** | A 生命周期 | `l-published` | 实心圆角方 |
| | | `l-deprecated` | 描边方 + **右半填充** |
| | | `l-yanked` | 描边方 + **一道贯穿的斜杠**（被划掉） |
| | | `l-degraded` | 描边方 + **内部双斜线**（被网格挡住） |
| **圆族** | B 验证 | `v-verified` | **圈内勾** —— 🔴 全站唯一的勾 |
| | | `v-stale` | **圈内钟**（两根指针） |
| | | `v-failed` | **圈内叉** |
| | | `v-unverified` | **虚线空圈** |
| **等号族** | C 本地比对 | `c-equal` | `=`（两横，无外框） |
| | | `c-unequal` | `≠`（两横 + 斜杠） |
| | | `c-nodata` | 一条虚线横 |
| 中性 | — | `u-search` / `u-note` | 放大镜 / 三角感叹（**只给演示页与信息提示用，不属于任何轴**） |

**为什么这样分**：
- 方族用**填充度**表达处置，是一个「档位」的心智；里面没有勾，所以
  `published` 不会被读成「验过了」。
- 圆族全部被圆圈住，**圆圈本身就是「这是我们这一次的判断」的标记**。
- 等号族**没有外框**，因为「相不相同」既不是处置也不是判断。

### 7.2 载体形态（图标之外的第二道保险）

| 轴 | 载体 | 大小写 | 出现位置 |
|---|---|---|---|
| A 生命周期 | **描边 chip**（1px 边框、透明底、6px 圆角） | 🔴 **小写字面值**（`published`），不许 uppercase | 标题旁、卡片身份行、成员表 `lifecycle` 列；以及 `.notice.n-yanked / .n-degraded / .n-deprecated` 的条首图标 |
| B 验证 | **没有 chip**，只是「图标 + 词」 | 小写 | 🔴 **只在 `.chain` 四格内**，以及唯一一处例外：`.notice.n-failed` 的条首图标 |
| C 本地比对 | 无框无底，纯「图标 + 词」 | 中文词 | 只在台账的「本地比对」行（`.cmp`） |

🔴 **`.notice.n-failed` 必须是独立的类，不许复用 `.n-yanked`。**
两者顶边同为 3px `--c-revoked`，但 `n-yanked` 还带着「灰纸 + 撤掉 clay 下划线」这套
**yanked 专属**的纸样规则；`n-failed` 复用它，等于图标把两条轴分开了、纸样又把它们粘回去，
而且在 CSS 身份上「验签失败」就成了 yanked 的一个别名。
`n-failed` 用 `--c-paper` 底（不换纸）+ 3px `--c-revoked` 顶边 + `v-failed` 圈内叉。

### 7.3 🔴 实现方应加的静态检查

形状族的分离靠人自觉是守不住的（上一版就是这么破的）。加一条构建期检查：

- `l-*` 只允许出现在 `.life` 与 `.notice.n-yanked / .n-degraded / .n-deprecated` 内
- `v-*` 只允许出现在 `.chain` 与 `.notice.n-failed` 内
- `c-*` 只允许出现在 `.cmp` 内
- `.notice.n-failed` 不得同时带 `.n-yanked`，且不得使用 `--p-grey`
- （`design-preview.html` §03 的图例区 `.axisrow` 要把三族并排展示，**只有它豁免**；
  生产页面里没有对应结构）
- 任何 `.life` 元素的计算样式 `text-transform` 必须是 `none`
- 全站计算颜色等于 `--c-ok` 的文本元素，其祖先必须匹配 `.chain`（即绿色唯一化）。
  🔴 **这一条要连动态类一起查**（`:hover` / `[data-done]` / `[aria-pressed]` 的状态样式）——
  上一版规格就是在「复制成功变绿」这个**动态**状态上破的功，静态扫 DOM 扫不到。

演示页 `design-preview.html` 已经通过这五条（实测结果见 §11.2）。

---

## 8. 组件规格

### 8.1 页面骨架

```
桌面（≥1024px）
┌ masthead 60px：wordmark（serif）· 全局搜索 · 主题三态键（sticky，底边 1px hairline）
├ wrap: max-width 1120px, padding 0 24px
│
│  详情页纵向顺序（🔴 顺序即优先级，不许调）
│   1. ArtifactId（h1，mono 17px，可换行）+ 生命周期 chip + Tier 徽章
│   2. 【状态警示条】（yanked / degraded / deprecated 才出现）
│   3. 【验证链条】4 格横排，占满正文宽
│   4. 【信任台账】panel，占满正文宽
│   5. 【provenance】panel
│   6. 安装命令
│   7. description / SKILL.md 正文（叙述纸，68ch）
│   8. 版本列表 · pack 成员表 · 冲突与替代
└
```

🔴 **不设右侧 metadata 栏。** 一旦有右栏，信任信息就会被塞进去，然后它就变成脚注了（npm 的教训）。
需要目录时用**左侧粘性锚点列表**（宽 180px，仅 ≥1240px 出现），正文仍是主列。

区段容器需要 `scroll-margin-top: 72px`，否则 sticky header 会挡住锚点目标。

### 8.2 验证链条 `.chain`

四格等宽 grid，整体是一块**记录纸**（`--c-inset` 底 + 1px hairline + 8px 圆角 + `overflow:hidden`），
格间 1px 竖线。每格：`验证态（图标 + 词）` → `格名（sans 12px 600）` → `值（mono 11.5px）`。

| 格 | 格名 | 值 | 数据来源 |
|---|---|---|---|
| 1 | 签名身份 | `release.yml@refs/heads/main` + issuer | 验签 identity / OIDC issuer |
| 2 | Rekor logIndex | `logIndex` + 上链时间 | Rekor |
| 3 | 树摘要 | 算法名 + 短摘要 | `tree_digest` |
| 4 | 快照时效 | `hub-<N>` · `timestamp v<V>` + 剩余有效期 | timestamp |

四态：

| 类 | 颜色 | 图标 | 格底 | 含义 |
|---|---|---|---|---|
| `ok` | `--c-ok` | `v-verified` | `--p-ok` | 这一环验过了 |
| `stale` | `--c-caution` | `v-stale` | 无 | 成立但有保留（典型：timestamp 已过期） |
| `fail` | `--c-revoked` | `v-failed` | 无 | 这一环失败了。整页必须同时给一条「本页数据未通过验证，不要据此安装」的警示条 |
| `none` | `--c-text-dim` | `v-unverified` | 无 | 还没验，或前一环已失败所以不再继续 |

- 🔴 **默认状态是 `none`，不是 `ok`。**
- 🔴 **不要把四格合并成一个"已验证"绿勾。** 第 4 格是唯一常见的非 ok 状态，
  它必须能**单独变黄而不影响前三格**。
- 🔴 **本站点的终值是四格全 `none`。** 站点是构建期渲染的静态页：仓库里没有 `timestamp.json`
  （它只作为 Release 资产分发）、没有 `.sigstore.json` bundle、没有内置 TUF 根，
  于是 `resolveCurrent()` 的验证链**一步都没跑**。
  必须在链条下方写明「**这不是加载中，也不会变**」，并说清「虚线圈 = 我们没验」
  ≠「圈内叉 = 验了没过」。
  🔴 **不许为了好看把它画成 ok** —— 画成 ok 就是撒谎，而这个站点整套设计的前提就是不撒谎。
  （若将来实现方真的接上了验证，才按真实结果渲染。）
- `<780px`：变成单列纵向堆叠，格间用 1px 上边框。

### 8.3 信任台账 `.panel > .ledger`

容器是 `.panel > .body.record`（🔴 **记录纸底 `--c-inset`**，见 §3.1）。
`dl` + `grid-template-columns: 172px minmax(0,1fr)`，行间 1px hairline，行高 10px。
`dt` 是 **sans 12px / 600 / `--c-text-mid`**（🔴 不是 mono —— §3.2 规则 3）；`dd` 里的值是 mono。

| dt | dd 内容 |
|---|---|
| 签名身份 | **完整 URL 字符串**。副行：「精确比对，不做前缀匹配；timestamp 是另一个身份，两者不可互换」 |
| OIDC issuer | 完整 URL |
| Rekor 条目 | `logIndex` 链接 + 上链时间。副行：「透明日志是公开的，任何人都能独立取回，不需要经过本站」 |
| 树摘要 | full 形态摘要（§8.7）+ 可复核命令块 |
| **本地比对** | 🔴 **等号族**（§7）。副行必须写明「这不是『验证通过』，它只说明两串字节相同」 |
| 资产摘要 | full 形态 + `asset.file` + **精确字节数** `48,213 B`（`47.1 KiB` 只作括注） |
| 快照来源 | `hub-<N>.json`（previous `hub-<N-1>`）+ `created_at`。副行：「快照里不含生成它自己的 commit SHA」 |
| Attestation | `hub-<N>.intoto.jsonl`（DSSE）：`predicateType` / `subject[].digest.sha256`（必须与 `timestamp.snapshot_sha256` 一致）/ `sourceRepo` / `sourceCommit` / `workflowRef` / `promotionPr`。🔴 `workflowRef` 必须钉到 **40 位 commit**，**不接受 `@refs/heads/main`**；而「签名身份」那行用的 `@refs/heads/main` 是 signer identity，规范就是那样定的——**两者不是一回事，不要"统一"它们**。副行注明「取证输入，安装链路不读」 |
| 审批 | `review.pr` 链接 + `approved_by[]` + `head_sha`（40 hex）。副行解释为什么 head_sha 允许出现 |
| capability 分级 | Tier 徽章 |

- **值永远原样给**，不缩写、不美化。`refs/heads/main` 不要显示成「main 分支」。
- 每个可复算的值下方给 `.recheck` 命令块。
- 🔴 `dd` 必须有 `min-width: 0` + `overflow-wrap: anywhere`，否则长 URL 会撑爆 grid。
- `<620px`：`grid-template-columns: 1fr`，`dt` 变成 `dd` 上方的小标签。

### 8.4 制品卡片 `.card`

叙述纸卡片（`--c-paper` + 1px hairline + 8px 圆角 + 16px padding），**四段结构**：

1. **身份行**：`.aid`（mono 17px；`kind:` 与 `@version` 用 dim/mid 降噪，`namespace/` 中灰，
   `name` 全黑且 700 —— 让名字在一串标识符里跳出来）+ **生命周期 chip** + 右端 `.tag` 角标。
2. **描述行**：13.5px，`--c-text-mid`，`max-width: 72ch`，**最多 2 行**（`-webkit-line-clamp: 2`）。
3. **事实条**：🔴 **卡片里唯一的记录纸** —— `--c-inset` 底 + 6px 圆角 + 8/12px padding。
   四项：出处 / 审批 / 树摘要（短形态）/ 资产字节数。每项是 `sans 小标签 + mono 值`。
4. **徽章行**：Tier 徽章 + `clients` + `license`。

- 换纸规则见 §3.3。`deprecated` **卡片上不换纸**。
- hover：只改 `background` 与 `border-color`（`120ms linear`），**不位移、不加阴影**。
- 🔴 卡片里没有任何位置放下载量。事实条的四项就是四项。

### 8.5 capability 徽章 `.tier`

**双通道编码**：分段计量条（3 格，亮起 1/2/3 格）+ 色相。

| Tier | capability | 颜色 | 底 | 计量条 |
|---|---|---|---|---|
| 0 | `none` | `--c-neutral` | 12% 混色 | ▮▯▯ |
| 1 | `network` / `external-tool` | `--c-caution` | `--p-manilla` | ▮▮▯ |
| 2 | `shell` / `credentials` / `writes-repo` | `--c-revoked` | 12% 混色 | ▮▮▮ |

🔴 **Tier 徽章与生命周期标记靠三处形态差区分**（Tier 2 与 yanked 共用牛血色，必须分得开）：

| | Tier 徽章 | 生命周期标记 |
|---|---|---|
| 形态 | **实底、无边框** | **描边、透明底** |
| 计量条 | **有** | 无 |
| 大小写 | **大写 `TIER 2`**（TIER 是我们造的标签，可以大写） | 🔴 **小写字面值 `yanked`**（status 是数据，不许改大小写） |

徽章右侧**永远直接跟真实 capability 名**（`shell · credentials · writes-repo`），
不要只写 "TIER 2" 让人去查表。pack 的 Tier 标注为「并集取最高」，且要给出真实的并集。

非 `geoly` namespace 的 Tier 1/2 制品：卡片与详情页都要出现一句
「安装时会强制展示 capability 并要求确认；`--yes` 可跳过，但跳过会写进账本」。

### 8.6 状态警示条 `.notice`

统一形态：`border-top: 2px|3px <语义色>` + 纸样底 + `20px` 图标 + **标题（serif 20px）** +
说明段 + 可执行按钮组。**没有大图标、没有满色实心条、没有感叹号轰炸——这些是事实，不是错误。**

| 类型 | 纸样 | 顶边 | 图标 | 标题主语（🔴 主语不同） | 按钮 |
|---|---|---|---|---|---|
| yanked | `--p-grey` | 3px `--c-revoked` | `l-yanked` | 「此版本已于 &lt;date&gt; 被 yank：默认拒绝新装」 | 查看公告 / 跳到替代版本 / 仍要查看内容 |
| degraded | `--p-heather` | 3px `--c-degraded` | `l-degraded` | 「此 pack 被标记为 degraded：**它锁定的一个必装成员已被 yank**」 | 看是哪个成员 / 找可安装的版本 |
| deprecated | `--p-manilla` | 2px `--c-caution` | `l-deprecated` | 「此版本已弃用，**但仍可安装**」 | （通常无按钮） |
| 验证失败 `.n-failed` | 🔴 **`--c-paper`（不换纸）** | 3px `--c-revoked` | 🔴 `v-failed`（**圈内叉，不是划掉方框**） | 「本页数据未通过验证，不要据此安装」 | — |
| 中性提示 | `--c-inset` | 2px `--c-clay` | `u-note` | 陈述句 | — |

🔴 **`advisory` 与 `superseded_by` 是可选字段**（`YANK_KEYS.optional`）。缺席时：
不要渲染点不开的「查看公告」按钮，只展示必填的 `reason`；`superseded_by` 缺席时明写
「未声明替代版本」，**不要自作主张推荐一个更高版本**。

必须写进文案的事实：
- yank **不删文件**；已装实例不强制卸载，`check` 会报告。
- 🔴 **yanked 是「默认拒绝新装」，不是「绝对不可安装」**：显式 `--allow-yanked` 仍可继续，
  且这次跳过会写进安装账本。文案必须这么写，否则用户会以为页面在骗他。
- 🔴 **`--allow-yanked` 不放行 `degraded`** —— 这是两者最大的行为差别，必须写在 degraded 条上。
- 🔴 **`latest` 投影规则要写全**：`latest` = 该 `kind:ns/name` 下**非 yanked、非 degraded、
  非 prerelease** 的最高 semver。**`deprecated` 可以进入 `latest`**（漏掉这条会让实现者以为
  deprecated 也被排除）。若某个 name 的全部版本都被排除，`latest` 里**没有这个键**——
  此时页面明说「该制品当前没有可安装版本」，并逐版本列出被哪个成员/原因排除。
- 🔴 **stale 或历史快照下不许断言"现在可安装"**：措辞一律是「截至 `hub-<N>`：…」。
  timestamp 过期时默认是拒绝的，只有 `--offline` + `--allow-stale` 才能继续。

### 8.7 摘要串（64 hex）

三种形态：

**full**（详情页）：`geoly-tree-v1:sha256:` 前缀用 `--c-text-dim` 单独一段，其后 64 hex 按
**8 组 × 8 字符**排。

```html
<span class="digest" role="group" aria-label="树摘要 geoly-tree-v1，64 位十六进制">
  <span class="algo">geoly-tree-v1:sha256:</span>
  <span class="hex"><b>9f2c4a71</b><b>3e05b8d2</b>…</span>
  <button class="copy" data-copy="9f2c4a71…">复制</button>
</span>
```

```css
.digest .hex { user-select: all; word-break: break-all; min-width: 0; }
.digest .hex > b { font-weight: 400; }
.digest .hex > b + b { margin-left: 6px; }          /* 🔴 分组靠 margin */
.digest .hex > b:nth-of-type(1),
.digest .hex > b:nth-of-type(8) { font-weight: 700; color: var(--c-text); }
```

🔴 **最容易做错的地方**：分组间距**必须**靠 `margin`，**DOM 里不能有空格**
（不要 `9f2c4a71 3e05b8d2`）。插了空格，用户复制粘到终端里就是一个坏值。
同理，复制按钮从 `data-copy` 取原始串，**不从 `textContent` 取**。
`user-select: all` 让点一下就全选整串。首尾两组加粗，因为人核对摘要时看的就是首尾。

**short**（列表/表格）：`首8…尾8`，mono 12px，中间 `…` 用 `--c-text-dim` + 3px 边距。
hover 出 `title` 全串，点击展开为 full。
🔴 短形态**只用于导航，不用于核对**；任何要求用户比对的场景必须给 full。

**pair**（vendored 双摘要并列）：两行上下对齐，同宽同分组，**都用常规色**。

🔴 **绝不做字符级 diff、绝不给某几组染色。** 哈希是雪崩的——两串本来就一个字符都对不上，
染色会暗示「差异定位在这几段」，那是假的。正确表达是一句**可复算的事实**：

> 去掉 `added_files = ["skill.json"]` 之后重算 hub 载荷的树摘要 → 与 `origin_tree_digest` 相等

配 `c-unequal` + `--c-caution`，并写明「两值不相等是**预期**」，
**不许用 `--c-revoked`**（它不是故障）。

### 8.8 provenance 块

两种形态**刻意长得不一样**——这是 `parseSnapshot` 里两套完全不同的键集，
视觉上不该伪装成同一张表。

**original**（`author_github_id` / `submitted_by_pr`）：只有两个节点，两行完事。
**不要为了"对称"给它补空行或占位符。** `kindtag` 用 `--c-neutral` 底。

**vendored**（10 个字段）：做成一条**带节点的搬运轨迹**（1px 虚线竖轨 + `--c-clay` 圆点），
顺序即因果：

1. `origin_repo` · `origin_ref`
2. `origin_commit`（40 hex）—— 副行必须写「tag 可以被移动，那正是审核后换内容的攻击路径」
3. `origin_subpath`
4. `origin_tree_digest`（带 `geoly-tree-v1:sha256:` 前缀）
5. `added_files`（白名单）—— 副行解释**双摘要为什么本就不相等**
6. `license_evidence` · `imported_at` · `imported_by_pr`

`kindtag` 用 `--p-clay` 底 + `--c-clay-ink` 字：
🔴 **vendored 不是坏事，只是来源不同，不给它警告色。**

### 8.9 pack 成员表 + 「被谁拖累」

表格 `.members`：`# / 成员 / role / tree_digest / lifecycle`。
🔴 **表格永远包一层 `overflow-x: auto` 的容器**，容器带边框圆角 + `overflow:hidden`，
表格 `min-width: 640px`。**绝不让页面 body 横向滚动。**

- 🔴 **`th` 才 `text-transform: uppercase`；`td` 必须显式 `text-transform: none`。**
  semver 区分大小写，`1.1.0-rc.1` 被大写成 `1.1.0-RC.1` 是把值改了。
  **写成显式声明，不要依赖"默认就是 none"** —— 一旦某个祖先加了 uppercase 就全线失守。
- `role` 显示为 `matrix · 必装` 或 `bundled · --no-bundled 可跳过`；bundled 行整行降调。
- 被 yank 的成员整行铺 `--p-grey`。

**拖累关系不做成表里的一列。** 它是一句因果，用一条横贯表宽的 `.blameline` 单独占一行，
三段式：`<被 yank 的成员> ⟶ <它是本版 matrix 必装成员> ⟶ <所以本 pack 的这一版是 degraded>`。
底用 `--p-heather`，箭头用 `--c-degraded`。

pack 头部要标注三条派生口径（🔴 两个口径不一样，最容易抄错）：

- 「精确版本 + 摘要锁定，不接受 semver range」
- `clients` = **全体 `members` 的交集**，🔴 **`bundled` 不参与**（它可被 `--no-bundled` 跳过）
- `capabilities` = **`members` + `bundled` 的并集**；pack 的 Tier 取该并集对应的最高 Tier

🔴 **`degraded` 只能对「本版本锁定的必装 `members`」推导**：pack 不可变，每个版本锁的成员不同。
不要从一个版本的成员表推出「所有版本都 degraded」。要表达跨版本结论，就**逐版本列出**
各自被哪个被 yank 的成员拖累，并据此说明 `latest` 落在哪一版。

### 8.10 搜索与筛选

**搜索框**：42px 高，`--c-paper` 底 + `--c-rule` 边 + 8px 圆角。
输入框用 **mono**（这里输入的一半是标识符）。placeholder 直接示范三种可接受形态：
`name / skill:ns/name@ver / 64 hex 摘要`。右端 `/` 快捷键 kbd。
`:focus-within` 时边框转 `--c-clay` + 3px 半透明外环。

🔴 **粘一整串 64 hex 必须能反查制品**（借鉴 Rekor 搜索）。这是这个站点最有辨识度的搜索能力，
不要做成只搜名字。命中时结果行要标明匹配的是 `tree_digest` 还是 `asset.sha256`。

**筛选**：chip 按钮（mono 12px，6px 圆角，`aria-pressed` 控制按下态 →
`--p-clay` 底 + `--c-clay` 边框）。分组顺序按**信任维度**，不按流行度：

`kind` → `tier` → `status` → `provenance` → `client` → `license` → `namespace`

每个 chip 右侧带计数。🔴 **没有 "sort by downloads"**；排序项只有
`id 字节序`（默认，与快照一致）/ `最近进入快照` / `capability tier`。

**空搜索结果** `.emptyrow`（虚线框）：🔴 **必须区分两种「空」，不要用同一句文案**：

- **筛选筛没了**：原样列出生效的条件，说清是哪几个把结果筛空的，出口是「清空筛选」
  或「只去掉某一个条件」。
- **registry 本身是空的**：明说「这张快照收录 0 个制品，**任何**查询都不会有结果，
  不是筛选条件写错了」，出口是「看 registry 现在是什么状态」。

### 8.11 🔴 空状态：registry 一个制品都没有

**这是首页本身，不是缺省页。** registry 现在真的是 0 个制品，这个状态会被看很久，必须能独立成立。

**设计思路：把「0 个制品」当成一条已签名的事实来排版。**
`hub-0.json` 是真实存在、真实被签过、真实进了 Rekor 的对象——它此刻的内容恰好是空的。

结构（全部**左对齐**，不居中、没有插画）：

1. **标签**：`geoly-ai/skills-hub · snapshot hub-0`
2. **主句**（serif 34px，`max-width: 20ch`）：**「这张快照是空的，而它是被签过名的空。」**
   中文在这里回落到思源宋体 / Songti SC —— 与 Source Serif 4 同一种声音，正是我们要的（§5.3）。
3. **引言**（17px，62ch）：说清 0 不是加载失败——`hub-0.json` 是一个真实存在的对象，
   它此刻的内容恰好是空的。
   🔴 **但「被签过名」这句必须写成转述，不能写成本页的结论。**
   主句是一句有力的标题，而下面四格是 `unverified`；如果引言接着断言
   「这条链现在就成立」，标题和链条就当场互相抵消，页面开始自相矛盾。
   正确写法：「**release 流水线声称**它由 `release.yml` 签署、进了 Rekor、被 timestamp 指向 ——
   **这句话本页只是转述，本站点自己一步都没验**；要确认它是真的，用下面的命令自己验一遍。」
   下方「现在就能做的事」那一栏也要再点一次：未验证 ≠ 验了没过（后者是圈内叉）。
4. **零计数块**：`0` 用 **serif 92px、`--c-clay`**（窄屏 68px），右侧小字
   `artifacts · 0 yanked · latest 映射为空对象`，下一行 `previous: — / created_at: …`。
   🔴 这是**全站唯一的大号数字，而它是 0**——恰好和「我们不展示使用量」的立场自洽。
5. **验证链条**：🔴 这是 §8.2 的**「空快照」变体**，不是同一份格位——
   registry 里没有制品，所以**第 3 格不是「树摘要」而是「snapshot sha256」**，其余三格同 §8.2。
   🔴 **四格全 `unverified`**，并在下方写明
   「上面四格是未验证，因为**这个站点**没验——不是因为验不了」。
   （上一版规格让这里四格全 ok 来"演示信任链跑得通"，**本版不采纳**：我们没跑，画成 ok 就是撒谎。）
6. **两栏**（`<900px` 单列）：
   - 左「现在就能做的事」：两条可复制命令（`snapshot --verify --explain`、`search '' --json`），
     外加一句「没有 `--no-verify`，也没有 `--insecure`：验签器没接上，CLI 直接拒绝运行」。
   - 右「第一个制品会这样进来」：4 步流水线（投稿结构门 → 人工门与 Tier 分级 →
     promotion 与树摘要 → 双身份签名与 timestamp），每步一句实话。
     底部三个按钮：投稿指南 / 看 hub-0.json 原文 / 命名空间与保留名。

🔴 **禁止**：「暂无数据」「敬请期待」「Coming soon」、居中的空盒插画、灰色占位骨架屏、
一个大号加号按钮。

---

## 9. 布局与响应式

| 断点 | 行为 |
|---|---|
| ≥1240px | 可选左侧锚点栏 180px；正文 max-width 1120px |
| 900–1239 | 单列，正文 1120px（实际由 padding 收） |
| ≤900 | `.grid2` / `.axisgrid` / 空状态两栏 → 单列 |
| ≤780 | 验证链条 → 纵向 4 段 |
| ≤620 | 台账 `dl` → 单列（`dt` 变小标签）；筛选 chip 横向可滚；`--fs-title` 34→27；`--fs-h2` 22→20；masthead 隐藏 wordmark 副标题；零计数 92→68px |
| ≤420 | ArtifactId 字号降到 14px；空状态主句 24px |

### 9.1 🔴 宽内容处理（实测踩过的坑）

- 🔴 **grid / flex 子项默认 `min-width: auto`**，里面一个 `white-space: pre` 的命令块
  就能把整条轨道撑开，于是 body 横向滚动。**实测在 375px 下把文档撑到 1377px。**
  每个容器都要显式归零：

  ```css
  .specimen > *, .grid2 > *, .axisgrid > *, .empty .cols > div,
  .chain > div, .panel, .inset, .card, .notice > div, .trace .body,
  .pipeline li > div, .ledger > dd, .fact, .tier { min-width: 0; }
  .recheck { max-width: 100%; }
  ```

- 表格包 `overflow-x: auto` 容器，表格 `min-width: 640px`。
- 摘要 full 形态用 `flex-wrap: wrap` + `word-break: break-all`，窄屏按分组换行——
  分组是 8 字符且 `<b>` 是不可分的原子，换行点不会落在组中间。
- 命令块 `.recheck` 单行 `overflow-x: auto`、`white-space: pre`，**不换行**
  （命令换行会被误复制成两行）。
- masthead：`.wordmark` 与 `.btn` 都要 `white-space: nowrap`，
  否则 60px 的 sticky 条会被撑成两行盖住正文（实测在 375px 下发生过）。

---

## 10. 动效

**全部动效就下面这几条，多一条都是错。**

| 场景 | 规格 | 为什么 |
|---|---|---|
| hover / press | `background`、`border-color` `120ms linear` | 只改颜色。列表行 hover 时**不许位移**——位移会让密集记录纸抖动 |
| 复制反馈 | 文案「复制」→「已复制」，颜色切 **`--c-clay-ink`**，1200ms 复位 | 无缩放、无弹跳；复制是确认，不是庆祝。🔴 **不许用 `--c-ok`** —— 绿在本站点只表示「验证轴验过了」，一个复制成功不是验证结论。这是「绿色唯一化」最容易被**动态状态**破掉的地方 |
| 折叠展开 | `grid-template-rows: 0fr → 1fr`，`160ms ease-out` | 摘要短→全、成员表展开 |
| 焦点 | `outline: 2px solid var(--c-clay); outline-offset: 2px`，无过渡 | 键盘导航必须立刻可见 |
| 加载中 | **静态**占位横线（`--c-inset`），无 shimmer | 🔴 扫光会让「还没验证完」看起来像已经有内容了。这个站点里"未验证"必须看起来是空的 |

**禁止**：入场动画、滚动触发动画、视差、数字滚动（我们也没有数字可滚）、渐变流动、
页面切换过渡、骨架屏 shimmer、任何 >200ms 的过渡。

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

---

## 11. 可访问性

- 状态与 Tier **永远同时有文字**，颜色不是唯一通道；三条轴另有独立形状族，Tier 另有计量条。
- 筛选 chip 用 `<button aria-pressed>`，不是 `<div>`。
- 摘要块用 `role="group" aria-label="树摘要 geoly-tree-v1，64 位十六进制"`，
  避免屏幕阅读器逐字念 64 个字符时毫无上下文。
- 图标一律 `aria-hidden`：语义由旁边的词给。
- 🔴 **警示条是页面既有的静态事实，不是实时通知**：用
  `<div class="notice" role="group" aria-labelledby="<h4 的 id>">`。
  **不要用 `role="alert"`，也不要用 `role="status"`** —— 那两个是 live region，
  会在页面加载时被朗读成"刚刚发生的事"。
- live region 只留给**真正动态**的两件事：验证完成（链条从 `none` 变成 ok/bad）与「已复制」。
  各用一个独立的 `aria-live="polite"` 容器，不要把 `aria-live` 挂在按钮本身。
- 主题切换是三态按钮（跟随系统 / 亮 / 暗），状态写进 `data-theme`，
  按钮文字直接给出当前值。同时定义 `@media (prefers-color-scheme: dark)` 与
  `:root[data-theme="dark"]` 两处，手动切换要能双向覆盖系统偏好。
- 区段 `scroll-margin-top: 72px`。

### 11.1 🔴 实测的对比度（不是估的）

在 Chrome 里对 `design-preview.html` 逐元素跑 WCAG 2.x 相对亮度，
**亮/暗两套各约 690 个文本节点（含单字符）、去重后各 86–88 组配色，最终 0 组不达标。**
过程中真抓到过四处，记在这里免得实现者踩回去：

| 问题 | 实测值 | 处置 |
|---|---|---|
| `--c-clay` `#D97757` 当正文色 | **2.96:1**（对 `--c-paper`） | 🔴 拆出 `--c-clay-ink` `#A34428`（**5.84:1**）。clay 只画线不写字 |
| 空状态那个 92px 的 `0` 用了 `--c-clay` | **2.96:1** —— 连大字级的 3:1 都不到 | 改用 `--c-clay-ink`（**5.84:1**）|
| 亮色 `--c-text-dim` `#6B675C` 落在 yanked 灰纸 / degraded 淡紫纸的事实条上 | **4.39 / 4.19:1** | 压深到 `#605C51` |
| 暗色 `--c-text-dim` `#9A978B` 落在冷化后的 `--p-grey` 上 | **4.37:1** | 提亮到 `#A4A195` |

其余关键值（亮色，对 `--c-paper`）：
`--c-text` 17.50 · `--c-text-mid` 8.80 · `--c-text-dim` 5.36 · `--c-clay-ink` 5.84 ·
`--c-ok` 6.52 · `--c-caution` 6.14 · `--c-revoked` 7.74 · `--c-degraded` 8.75 · `--c-neutral` 6.33。
（`--c-clay` 本身 2.96 —— 它不写字，只画线。）
每个语义色对全部五种纸样都 ≥5.2:1。

> ⚠️ 写自动化对比度检查时，两个坑：
> **① 不要把单字符文本排除在外。** 用 `length > 1` 过滤"有意义的文本节点"，
> 恰好会漏掉空状态那个孤零零的 `0` —— 而它正是全站字号最大、最容易配错色的一个字。
> 用 `length >= 1`。（这个 P0 就是这么漏过第一轮自测的。）
> **② 颜色解析不要用正则。**
> `color-mix()` / `oklab()` 的计算值不是 `rgb(a,b,c)` 形状，正则会抓错三个数字，
> 报出一堆假的「不达标」。用 canvas 2D 的 `fillStyle` + `getImageData` 解析
> （`design-preview.html` 底部的 `auditContrast()` 就是这么写的，可以直接抄）。

### 11.2 已在浏览器里实测通过的不变量

`design-preview.html` 里内建了一个「跑一遍对比度自测」按钮。此外以下几条已逐项验过：

| 不变量 | 结果 |
|---|---|
| 亮色 688 个文本节点 / 88 组配色（含单字符文本） | 0 组不达标 |
| 暗色 687 个文本节点 / 86–88 组配色（含单字符文本） | 0 组不达标 |
| 空状态 92px 的 `0` | **5.84:1** |
| `.n-failed` 与 `.n-yanked` 的计算背景 | `#FAF9F5` vs `#EDEDEB` —— 两个类、两张纸 |
| `.panel > .body.record` / `.tablescroll` 的计算背景 | `#EDEAE0`（记录纸），而 `.panel` 是 `#FAF9F5`（叙述纸） |
| 含中文的 `.label` 元素 | **0 个**（27 处已全部转为 `.label-cn`） |
| **375px** 下 `documentElement.scrollWidth` | **375**（零横向溢出；表格与命令块在各自的滚动容器内） |
| 8 处 `.digest .hex` 的文本 | 全部恰好 64 位、`/^[0-9a-f]{64}$/`、**无任何空白字符** |
| 3 个复制按钮的 `data-copy` 与 DOM 文本 | 全部一致 |
| `.members td` 的计算 `text-transform` | 全部 `none`；`th` 为 `uppercase`；`@1.1.0-rc.1` 原样渲染 |
| `.life` chip 的计算 `text-transform` | 全部 `none`（`published` / `deprecated` / `yanked` / `degraded` 全小写） |
| 跨轴图标越界（`l-*` / `v-*` / `c-*`） | 0 处 |
| 计算颜色 == `--c-ok` 的文本元素 | 只有 `.vd-ok`（绿色唯一化成立） |

---

## 12. 实现者最容易做错的地方（照这个自查）

1. **把信任面板放进右栏。** 这是 npm 的做法，也是本设计明确反对的第一条。信任在正文顶部。
2. **摘要分组插了空格。** 复制出来就是坏值。分组必须靠 `margin`，DOM 里零空格；
   复制取 `data-copy`，不取 `textContent`。
3. **把「验签失败」渲染成 `yanked`，或把「还没验」渲染成绿勾。**
   见 §1.3 三条轴与 §7 的形状族。默认态是虚线空圈，不是勾。
4. **把 `degraded` 当 `yanked` 渲染。** 两者纸样、顶边色、图标、文案主语、可用性都不同：
   yanked 是「它被撤了」，degraded 是「它被别人拖累了，且 `--allow-yanked` 不放行」。
5. **给 `published` 上绿色，或给「两串字节相等」上绿色。**
   🔴 全站只有一处绿：验证轴的 `verified`。
6. **给 vendored 的双摘要不相等报红。** 那是预期行为（多一个 `skill.json`），
   用 `--c-caution` 并写明原因；也**不许**做字符级 diff 或给某几组染色。
7. **顺手加一个下载量/热度位。** 没有这个数据。列表排序、筛选、卡片里都不留位置。
8. **`text-transform: uppercase` 泄漏到数据上。** `1.1.0-rc.1` → `1.1.0-RC.1` 是把值改了。
   大写只给 `th` 与我们自己造的标签（`.label`、`TIER 2`）。
9. **把 `--c-clay` 当正文色用。** 实测 2.96:1，连大字级的 3:1 都不到。文字一律 `--c-clay-ink`。
    空状态那个 92px 的 `0` 是最容易中招的地方。
10. **在动态状态上把绿漏出去。** 「复制成功」变绿、hover 变绿、按下态变绿——
    静态扫 DOM 扫不到，但它照样破坏「绿 = 验证通过」。复制反馈用 `--c-clay-ink`。
11. **让 `.notice.n-failed` 复用 `.n-yanked`。** 图标分开了、纸样又把两条轴粘回去了。
12. **台账 / 表格没有真的坐在 `--c-inset` 上。** 见 §3.1：两种纸是背景色，不是氛围。
13. **标签里混了中文还用 `.label`。** `.08em` 字距会把中文拉散，换 `.label-cn`。
14. **中文掉进宋体就想去"修"它。** 见 §5.3：本版这是**设计意图**，
    但 `≤19px` 的中文标题要走 sans。同时：不 web 加载 CJK、mono 栈也要挂中文、
    `.label` 只放拉丁。
15. **把 `dt` / 字段名也做成 mono。** 见 §3.2 规则 3：mono 是引文体，
    只给机器原文。字段名是 sans。
16. **在记录纸里用衬线字，或给记录纸加阴影。** 它是凹陷的，不是浮起的。
17. **忘了 `min-width: 0`。** 一个 `white-space: pre` 的命令块就能让 375px 下横向滚动到 1377px。
18. **把载荷里的东西（description、pack 成员表）当成快照字段。** 见 §1.2：
    它们在 `asset.sha256` / `tree_digest` 核对通过之前是未验证数据。
19. **`latest` 规则只写了排除 degraded。** 完整规则是排除 yanked + degraded + prerelease，
    而 `deprecated` **可以**进入 latest。
20. **pack 的 `clients` 与 `capabilities` 用了同一个口径。** 交集不含 bundled，并集含 bundled。
21. **把 attestation 的 `workflowRef` 和 signer identity 混为一谈。**
    前者必须钉 40 位 commit，后者就是 `@refs/heads/main`。见 §8.3。
22. **把空状态的验证链条画成四格全 ok。** 本站点一步都没验，画成 ok 就是撒谎。见 §8.11。
