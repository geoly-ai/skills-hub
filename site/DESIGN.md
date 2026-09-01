# skills-hub registry 站点 · 设计规格

本文写给实现者，具体到能照着写 CSS。可视证据在同目录的 [`design-preview.html`](design-preview.html)
（单文件自包含，浏览器直接打开，右上角可切亮/暗）。**token 名与该页一一对应**，实现时直接抄那份
`:root` 块即可。

> 快照 record 的字段形状以 `src/snapshot.mjs` 的 `parseSnapshot()` / `validateRecord()` /
> `validateProvenance()` 为准。**但页面上的数据不止来自快照**，见 §0.2 的来源表——
> 别把「快照里有的」和「页面要显示的」当成同一件事。

---

## 0. 一句话主张

**别的 registry 展示的是「有多少人在用」，我们展示的是「这东西是谁签的、谁审的、从哪来的、现在还能不能用」。**

由此推出三条不可让步的规则：

1. 🔴 **页面上不出现任何使用量数字。** 下载量、装机量、调用量、star、评分、趋势图——我们没有这些数据
   （埋点是纯本地的），编出来就是撒谎。**布局里也不给它们留位置**：不要画一个"以后放下载量"的角落。
2. 🔴 **信任信息是主角。** 详情页里信任面板紧贴标题、位于描述之上、占满正文宽度。它不是右栏的一格。
3. 🔴 **每一个断言都要写清"谁说的"和"怎么自己再验一遍"。** 页面不是信任的来源，它只是把
   Rekor / 快照里已经存在的事实转述一遍，并给出复算命令。

### 0.1 🔴 两条轴，永远不许混

这是本设计最容易被实现者做错、且做错代价最大的一点。

| 轴 | 取值 | 来自哪 | 表达什么 |
|---|---|---|---|
| **生命周期** | `published` / `deprecated` / `yanked` / `degraded` | 快照 record 的 `status` 字段（已被签名覆盖） | 维护者对这个制品的处置 |
| **验证** | `verified` / `stale` / `unverified` / `failed` | `resolveCurrent()` 本次运行的结果，**不在快照里** | 我们这一次到底验没验、验过没过 |

两轴正交：一个 `published` 的制品完全可能**验签失败**；一个 `yanked` 的制品签名照样有效。

- 制品卡片与详情页标题上的 `.status` 标记 = **生命周期轴**。
- 信任链条 `.chain` = **验证轴**。
- 🔴 **验证失败绝不能渲染成 `yanked`。** 图形上刻意区分：
  yanked 用**裸叉** `i-x`，验证失败用**圈叉** `i-fail`，未验证用**虚线圈** `i-unverified`（`--c-text-dim`）。
- 🔴 **未验证的数据不得显示成「已验证」。** 页面在拿到验证结果之前，链条四格全是虚线圈，
  且不得用绿色。宁可显示「尚未验证」，也不要默认乐观。

### 0.2 页面数据与验证来源

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
不要和快照里的字段混在同一张表里不加区分。快照 record 里**没有** `description`、
**没有** `members`——它们来自载荷。

---

## 1. 调研：借鉴与否掉

调研对象与结论。**每条都写了为什么**，实现时如果要偏离，先反驳这里的理由。

### 1.1 crates.io（Rust 包注册表）

- ✅ **借鉴**：版本历史与当前版本并列、`Owners` 明确列人、右栏「metadata 事实」与左栏「叙述」分离。
  这套「事实/叙述」二分我们保留，但**把事实搬到左栏上方**（见 §7.1）。
- ✅ **借鉴**：2024 年加的三态主题（system / light / dark）。我们照做，默认跟随系统。
- ❌ **否掉**：首页与详情页最显眼的是 "All-Time Downloads / Recent Downloads" 与下载曲线。
  这正是我们没有、也不该假装有的东西。
- ❌ **否掉**：卡片式圆角容器 + 阴影堆叠。我们用「台账行」（见 §5.3）。

### 1.2 pkg.go.dev（Go 模块文档）

- ✅ **借鉴（关键）**：**用一组带勾/叉的"质量事实"代替一个综合评分** —— 它列
  `valid go.mod / redistributable license / tagged version / stable version`，每项独立成立或不成立。
  我们的信任链条（§7.2）是同一个思路：**四个独立结论，不合并成一个绿勾**。
- ✅ **借鉴**：`Version: v0.40.0` 旁边直说「not in the latest version of its module」——
  用一句陈述句说清状态，而不是一个需要解读的图标。我们的 `deprecated` / `degraded` 提示照此写法。
- ❌ **否掉**：Main / Versions / Licenses / Imports / Imported By 的顶部 tab。
  tab 会把信息藏起来；我们的信任信息**不允许在 tab 后面**（那等于承认它是次要的）。
  长内容用同页锚点侧栏，不用 tab。

### 1.3 npm（含 provenance UI）

- ✅ **借鉴（灵感来源）**：npm 的 provenance 面板列出「source commit / build file / public ledger」，
  并明说「published with provenance, signed by Sigstore public good servers and logged in a public
  transparency ledger」。**「公开账本」这个措辞值得抄** —— 强调的是「不用信我，去看账本」。
- ❌ **否掉（最重要的一条反面教材）**：npm 把 provenance 做成**版本号旁的一个绿勾 + 右侧栏的一小节**。
  这是把最有价值的信息降级成脚注。我们反着来：**信任面板在正文顶部，描述在它下面**。
- ❌ **否掉**：周下载量图表、`Weekly Downloads` 大字号数字。见 §0 规则 1。

### 1.4 PyPI（含 attestations / Trusted Publisher）

- ✅ **借鉴**：每个分发文件下面展开 attestation：statement type、predicate type、subject digest（SHA256）、
  Sigstore 透明日志条目、源仓库 commit 永久链接、发布 workflow、token issuer。
  **字段清单几乎就是我们要展示的东西**，我们再加上「树摘要」与「快照来源」。
- ✅ **借鉴**：`Uploaded using Trusted Publishing? Yes` —— 用**问句 + 答案**的形式表达一个布尔事实，
  比一个图标好懂。我们的 `--allow-yanked 不放行 degraded` 之类的规则也用陈述句直说。
- ❌ **否掉**：把 attestation 折进 "Download files" tab 的深处，默认收起。我们默认展开。
- ❌ **否掉**：左侧长目录 + 中间超长 README 的比例。我们的 `SKILL.md` 正文重要，但排在信任之后。

### 1.5 Homebrew formula 页

- ✅ **借鉴**：**极高的信息密度、几乎没有装饰**：一串 `key: value` 行 + 平台支持表 + 依赖清单，
  一屏看完一个 formula 的全部事实。我们的信任台账（§7.3）就是这种密度。
- ✅ **借鉴**：平台支持用**表格 + 勾**，一眼看出「哪些 target 能装」。我们的 `clients`
  （claude / cursor / codex / agents）用同一种表达；pack 的 `clients` 是成员**交集**，要标注出来。
- ❌ **否掉**：页面底部的 "Analytics: installs 30/90/365 days"。见 §0 规则 1。

### 1.6 Sigstore Rekor 搜索（search.sigstore.dev）与 rekor-search-ui

- ✅ **借鉴**：按 **Attribute / Email / hash** 搜索的心智 —— 一个查询框能接受**多种形态的标识符**，
  包括直接粘一串 hash。我们的搜索框照做：接受 name、ArtifactId、**以及整串 64 hex 摘要**（§10）。
- ✅ **借鉴**：结果以「日志条目」形式呈现：logIndex、时间、证书内容原样列出，不做美化改写。
  我们展示 identity / issuer 时也**原样给完整 URL 字符串**，不缩写成「GitHub Actions」。
- ❌ **否掉**：它整体是个开发者调试工具，视觉几乎没有层级（大段 JSON 直接铺开）。
  我们要给 JSON 一个可读的版式（台账 dl），但保留「点一下能看原文」的入口。

### 1.7 lib.rs（对照组）

- ✅ **借鉴**：`680KB, 14K SLoC` 这种把**体量当事实**放在元数据带里的做法。
  我们展示 `asset.size` 时给**精确字节数**（`48,213 B`），KiB 作次要括注 —— 供应链界面里不该四舍五入。
- ❌ **否掉**：`#19 in Encoding` 排名、月下载量。见 §0 规则 1。

### 1.8 主动回避的"AI 生成设计"套路（自检清单）

写代码时对照这张表；命中任何一条就换掉：

| 套路 | 本设计的替代 |
|---|---|
| 暖米色 `#F4F1EA` + 衬线标题 + 陶土强调 | greenbar 台账纸中性（绿偏，非暖偏）+ 宽体无衬线标题 + 墨蓝强调 |
| 近黑底 + 一个荧光点缀 | 暗色是**蓝灰岩板** `#111519`，语义色是五个成体系的中明度色，没有荧光单点 |
| 紫蓝渐变 hero | 全站**零渐变**。唯一的"面"是纯色与 1px 线 |
| Inter / Space Grotesk 当安全牌 | Archivo（宽体标牌感）+ IBM Plex Sans + IBM Plex Mono |
| emoji 当小节标记 | 全部 inline SVG 图标 + 两位数字编号 |
| 什么都居中 | **全部左对齐**，包括空状态 |
| 到处 `rounded-lg` | 圆角只有 2px / 3px 两档，表格与列表行 0px |
| 卡片左边一根强调色竖条 | 状态用**顶边 3px + 极淡底色**表达，从不用左竖条 |

---

## 2. 视觉隐喻：台账（ledger），不是仪表盘

透明日志就是一本**只增不改的账本**：单调递增的编号、逐字节可复现的记录、排序本身参与确定性。
版式因此应该像账本，而不是像 SaaS dashboard：

- **行，不是卡片。** 列表是连续的 1px 分隔行，`background: --c-surface`，无阴影、无外边距间隙。
  区段之间用 2px 的 `--c-rule` 划线，像账簿的栏线。
- **一切都是量化的。** 4px 网格；摘要按 8 字符分组；数字用 `font-variant-numeric: tabular-nums`。
- **等宽字是结构，不是装饰。** 所有字段名、所有标识符、所有摘要、所有命令行都是 mono。
  正文比例字只承担散文（description、说明段落）。
- **纸的颜色来自 greenbar 连页打印纸**（会计用的淡绿横条纸），不是 AI 套路里的暖米色。

---

## 3. 配色

### 3.1 亮色（`:root`）

```css
/* 中性：greenbar 台账纸。色相 ≈110°，饱和度 ≈6% —— 有偏，但不到"这是绿色"的程度 */
--c-bg:        #EEF1EC;   /* 页面底 */
--c-surface:   #F8FAF7;   /* 面板 / 列表行 */
--c-sunken:    #E4E9E2;   /* 表头 / 摘要底 / 命令行底 */
--c-hairline:  #D3D9CF;   /* 1px 行分隔 */
--c-rule:      #B5BFB1;   /* 2px 区段界线、面板外框 */
--c-text:      #171B18;
--c-text-mid:  #4A524C;
--c-text-dim:  #6E776F;

/* 语义。六个命名色，全部与 --c-ink 分离 */
--c-ink:          #2B4A9B;  /* 主强调：铁胆墨蓝。只用于 可点/当前/聚焦 */
--c-verified:     #2C6B45;  /* published、验证通过 */
--c-caution:      #8A5A0B;  /* deprecated、Tier 1、stale、预期内的不相等 */
--c-revoked:      #A2352E;  /* yanked、Tier 2 */
--c-degraded:     #6E3D7A;  /* degraded：被成员拖累 */
--c-neutralbadge: #5E6862;  /* Tier 0：不值得给颜色 */
```

### 3.2 暗色

同时定义在 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`
与 `:root[data-theme="dark"]` 两处（手动切换要能双向覆盖系统偏好）：

```css
--c-bg: #111519;  --c-surface: #171C21;  --c-sunken: #0C1013;
--c-hairline: #29323A;  --c-rule: #3B4650;
--c-text: #E3E9E5;  --c-text-mid: #A8B2AB;  --c-text-dim: #7E8880;

--c-ink: #8FB0FF;  --c-verified: #6FCB8F;  --c-caution: #E0A64A;
--c-revoked: #F08C82;  --c-degraded: #C79BD6;  --c-neutralbadge: #939E97;
```

暗色底不是 `#0A0A0A` 近黑，是**带蓝绿岩板感的 `#111519`**；`--c-sunken` 比 `--c-surface` **更暗**
（亮色下则是更暗于 surface 但亮于 bg），保持"凹陷"语义在两套里方向一致。

### 3.3 语义底色

底色一律由 `color-mix` 从语义色调出来，不另起 hex：

```css
--t-verified: color-mix(in oklab, var(--c-verified) 10%, var(--c-surface)); /* 暗色 14% */
--t-caution:  color-mix(in oklab, var(--c-caution)  12%, var(--c-surface)); /* 暗色 15% */
--t-revoked:  color-mix(in oklab, var(--c-revoked)  11%, var(--c-surface)); /* 暗色 14% */
--t-degraded: color-mix(in oklab, var(--c-degraded) 11%, var(--c-surface)); /* 暗色 14% */
--t-ink:      color-mix(in oklab, var(--c-ink)      10%, var(--c-surface)); /* 暗色 14% */
```

### 3.4 使用纪律

- 🔴 **`--c-ink` 不表达任何状态。** 它只说"这里可点 / 这是当前项 / 这里有焦点"。
  一个 published 的制品**不是蓝色的**。
- 🔴 **`--c-verified` 有两个不同含义，措辞必须分开**：在 `.status` 上它是生命周期的
  `published`；在 `.chain` 上它是验证轴的「本次验过了」。两处都必须带词，不能只给绿色（见 §0.1）。
- 🔴 **状态永远同时给词。** 颜色是第二通道，`published` / `yanked` / `degraded` / `deprecated`
  这几个词必须原样出现在界面上（用英文原词，因为它们是 `status` 字段的字面值，用户会在 CLI 输出里再见到）。
- **`--c-caution` 有一个非警告用途**：表示「**预期内的不相等**」，例如 vendored 的
  `origin_tree_digest ≠ tree_digest`（多了 `skill.json`，本就不该相等）。这种情况**不许用 `--c-revoked`**，
  否则会把正常现象报成故障。
- 灰度可读性：五个语义色的明度分别落在不同档（verified 最深、degraded 次之、ink、revoked、caution 最浅），
  黑白打印下靠明度也能分开。

---

## 4. 字体

### 4.1 三个角色

| 角色 | 字体 | 用途 | 关键设置 |
|---|---|---|---|
| Display | **Archivo**（可变，`wdth` 轴） | h1–h4、区段标题、空状态大字 | `font-variation-settings: "wdth" 118`（区段标题）/ `112`（大标题）；600 |
| Body | **IBM Plex Sans** | description、说明段落、按钮 | 400 / 500 / 600；15px / 1.65 |
| Mono | **IBM Plex Mono** | 🔴 **主力**：ArtifactId、摘要、命令、字段名、输入框、徽章 | 400 / 500 / 600 |

理由：Archivo 的宽体大写像标牌与钢印，与「盖章 / 备案」的题材同构，且明确不是 Inter / Space Grotesk；
Plex Sans 与 Plex Mono 同族设计、混排不打架；Plex Mono 的斜杠零与窄字身让 64 hex 能单行排下。

### 4.2 `<link>`（实现方直接抄）

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
```

Next.js 项目用 `next/font/google` 等价加载（`Archivo` 需 `axes: ['wdth']`），并把返回的
CSS 变量映射到 `--f-display` / `--f-body` / `--f-mono`。

### 4.3 🔴 中文 fallback

Google Fonts 的这三个拉丁字体**都不含 CJK**。正文有中文，必须显式给中文栈，否则会掉进宋体。

```css
--f-display: "Archivo", "Helvetica Neue",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
             "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
--f-body:    "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
             "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
--f-mono:    "IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
             "PingFang SC", "Microsoft YaHei", monospace;
```

规则：

- 🔴 **不 web 加载任何 CJK 字体**（Noto Sans SC 全量 5–10 MB，子集化后仍不可控）。中文一律走系统栈。
  `"Noto Sans CJK SC"` 写在末尾是给已装该字体的 Linux 用，不是网络加载。
- CJK 字形比拉丁字形视觉上更大：**中文为主的标题按拉丁标题字号 × 0.94 设置**，或给中文块加
  `font-feature-settings: normal; letter-spacing: 0`（拉丁大写标签的字距不要带到中文上）。
- `--f-mono` 里也要挂中文，否则 mono 段落里夹的中文会 fallback 到默认字体，行高会跳。
- 🔴 **`.label`（大写小标签）永远只放拉丁/数字**，不要塞中文——`text-transform: uppercase` 对中文无效，
  `letter-spacing: .10em` 会把中文拉散。中文标签用 `--f-body` 13px，不加字距。

---

## 5. 排版尺度、间距、圆角、边框

### 5.1 字号阶梯

| token | px | line-height | 用途 |
|---|---|---|---|
| `--fs-display` | 30 | 1.15 | 详情页 h1、空状态主句 |
| `--fs-h2` | 21 | 1.2 | 区段标题 |
| `--fs-h3` | 14 | 1.3 | 面板 header（配 `wdth 118` + 600，靠宽度而不是字号取得分量） |
| `--fs-lg` | 16 | 1.6 | 详情页首段 |
| `--fs-base` | 15 | 1.65 | 正文 |
| `--fs-sm` | 13.5 | 1.55 | 说明、表格单元、卡片描述 |
| `--fs-mono` | 12.5 | 1.5 | 摘要、命令 |
| `--fs-xs` | 12 | 1.4 | 次要事实值 |
| `--fs-label` | 11 | 1 | 大写小标签，`letter-spacing: .10em`、`font-weight: 500`、mono |

字距：只有 `--fs-label` 与状态/Tier 徽章加字距（`.06em`–`.10em`）；`--fs-display` 用 `-0.005em` 微收；
正文与 mono **不改字距**（改 mono 字距会让 hex 分组对不齐）。

### 5.2 间距尺度（4 的倍数）

`--sp-1: 4 / --sp-2: 8 / --sp-3: 12 / --sp-4: 16 / --sp-5: 24 / --sp-6: 32 / --sp-7: 48 / --sp-8: 64`

- 行内元素间隙 `--sp-2`；卡片内边距 `--sp-4`；面板内边距 `--sp-4`；区段之间 `--sp-7`。
- 台账行（`dt`/`dd`）纵向 `10px`（不在尺度上，是刻意的紧凑值：台账要密）。

### 5.3 圆角

**只有两档：`--r-chip: 2px`、`--r-panel: 3px`。**
列表行、表格、台账行 **0px**。全站不出现 ≥6px 的圆角，不出现 `border-radius: 999px` 的胶囊。

### 5.4 边框与分隔线

| 用法 | 值 |
|---|---|
| 行分隔 | `1px solid var(--c-hairline)` |
| 面板外框、表头下边、区段界线 | `1px`（面板）/ `2px`（区段）`solid var(--c-rule)` |
| 状态强调 | `border-top: 3px solid <语义色>` —— 🔴 **只在顶边，绝不用左竖条** |
| 信任链条顶边 | `border-top-width: 3px`（用 `--c-rule` 中性色，因为链条内部各格自己有状态） |
| 可复核命令块 | `1px dashed var(--c-hairline)` —— 虚线表示「这是可以拿走执行的东西」 |

阴影：全站仅一处 `--shadow-pop`，用于弹出层（下拉、tooltip）。列表与面板**无阴影**。

---

## 6. 图标

全部 inline SVG，`stroke: currentColor`，`stroke-width: 1.6–2`，16×16 视口。**不用 emoji，不用图标字体。**
必需的七个（🔴 `x` 与 `fail` 必须是两个不同图形，见 §0.1）：

| id | 图形 | 用途 |
|---|---|---|
| `check` | 勾 | 生命周期 `published` / 验证轴 `verified` |
| `x` | **裸叉** | 生命周期 `yanked` —— **只用于这个** |
| `fail` | **圈叉**（圆 + 叉） | 验证轴 `failed`：验签失败、摘要不符 |
| `unverified` | **虚线圆** | 验证轴 `unverified`：还没验 / 前一环没过所以不继续。用 `--c-text-dim` |
| `bang` | 竖线 + 点 | `deprecated`、Tier 1、caution |
| `block` | 外框 + 双斜划线 | `degraded`：被挡住，不是错了 |
| `search` | 放大镜 | 搜索框 |

---

## 7. 组件规格

### 7.1 页面骨架

```
桌面（≥1024px）
┌ header 56px：logo/名称 · 全局搜索 · 主题切换（sticky，底边 2px --c-rule）
├ wrap: max-width 1160px, padding 0 24px
│
│  详情页纵向顺序（🔴 顺序即优先级，不许调）
│   1. ArtifactId（h1，mono，可换行）+ status 标记 + Tier 徽章
│   2. 【状态警示条】（yanked / degraded / deprecated 才出现）
│   3. 【信任链条】4 格横排，占满正文宽
│   4. 【信任台账】panel，占满正文宽
│   5. 【provenance】panel
│   6. 安装命令
│   7. description / SKILL.md 正文
│   8. 版本列表 · pack 成员表 · 冲突与替代
└
```

**不设右侧 metadata 栏。** 一旦有右栏，信任信息就会被塞进去，然后它就变成脚注了（npm 的教训）。
需要目录时用**左侧粘性锚点列表**（宽 180px，仅 ≥1200px 出现），正文仍是主列。

### 7.2 信任链条 `.chain`

四格等宽 grid，每格：状态行（图标 + 大写词）+ 值行（mono 12px，两行）。

| 格 | 词 | 值 | 数据来源 |
|---|---|---|---|
| 1 | 签名 | `release.yml@refs/heads/main` + issuer | 验签 identity / OIDC issuer |
| 2 | Rekor 条目 | `logIndex` + 上链时间 | Rekor |
| 3 | 树摘要 | 算法名 + 短摘要 | `tree_digest` |
| 4 | 快照时效 | `hub-<N>` · `timestamp v<V>` + 剩余有效期 | timestamp |

状态四态（🔴 **验证轴**，与 `status` 无关）：

| 类 | 颜色 | 图标 | 含义 |
|---|---|---|---|
| `ok` | `--c-verified` | `check` | 这一环验过了 |
| `warn` | `--c-caution` | `bang` | 成立但有保留（典型：timestamp 已过期 → stale） |
| `bad` | `--c-revoked` | **`fail`（圈叉）** | 这一环失败了。整页必须同时提示「本页数据未通过验证，不要据此安装」 |
| `none` | `--c-text-dim` | `unverified`（虚线圆） | 还没验，或前一环已失败所以不再继续 |

🔴 **默认状态是 `none`，不是 `ok`。** 页面拿到验证结果之前，四格全是虚线圈。

🔴 **不要把四格合并成一个"已验证"绿勾。** 一个综合勾会掩盖到底哪一环成立——
而"哪一环没成立"正是这个站点存在的理由。第 4 格是唯一常见的非 ok 状态（timestamp 过期），
它必须能单独变黄而不影响前三格。

响应式：`<780px` 变成单列纵向堆叠，格间用 1px 上边框。

### 7.3 信任台账 `.panel > .ledger`

`dl` + `grid-template-columns: 168px minmax(0,1fr)`。行：

| dt（mono 大写标签） | dd 内容 |
|---|---|
| 签名身份 | **完整 URL 字符串**，mono。副行说明「精确比对，不做前缀匹配；timestamp 是另一个身份，两者不可互换」 |
| OIDC issuer | 完整 URL |
| Rekor 条目 | `logIndex` 链接 + 上链时间。副行：「透明日志是公开的，任何人都能独立取回，不需要经过本站」 |
| 树摘要 | 全形态摘要（§7.7）+ 可复核命令块 |
| 资产摘要 | 全形态摘要 + `asset.file` + **精确字节数** `48,213 B（47.1 KiB）` |
| 快照来源 | `hub-<N>.json`（previous `hub-<N-1>`）+ `created_at`。副行：「快照里不含生成它自己的 commit SHA」 |
| Attestation | `hub-<N>.intoto.jsonl`（DSSE）：`subject[].digest.sha256` / `sourceRepo` / `sourceCommit` / `workflowRef` / `promotionPr`。🔴 `workflowRef` 必须是钉到 **40 位 commit** 的形态（`…release.yml@<40hex>`），**不接受 `@refs/heads/main`**；而上面「签名身份」那行用的 `@refs/heads/main` 是 signer identity，规范就是那样定的——**两者不是一回事，不要"统一"它们**。副行注明「取证输入，安装链路不读」 |
| 审批 | `review.pr` 链接 + `approved_by[]` + `head_sha`（40 hex）。副行解释为什么 head_sha 允许出现 |
| capability 分级 | Tier 徽章 |

- **值永远原样给**，不缩写、不美化。`refs/heads/main` 不要显示成「main 分支」。
- 每个可复算的值下方给 `.recheck` 命令块（虚线框、`$` 提示符不可选中、横向可滚）。
- `<620px`：`grid-template-columns: 1fr`，dt 变成 dd 上方的小标签。

### 7.4 制品卡片 `.card`

一条列表行，**四行结构**：

1. **身份行**：`.aid`（mono 15px，`kind:` 与 `@version` 用 `--c-text-dim`/`--c-text-mid` 降噪，
   `namespace/` 中灰，`name` 全黑——让名字在一串标识符里跳出来）+ 状态标记 + 右端 `latest` 之类的角标。
2. **描述行**：`--fs-sm`，`--c-text-mid`，`max-width: 76ch`，**最多 2 行**（`-webkit-line-clamp: 2`）。
3. **事实行**：出处 / 审批 / 树摘要（短形态）/ 资产字节数。每项是 `小写大写标签 + mono 值`。
4. **徽章行**：Tier 徽章 + `clients` + `license`。

状态染底：`.is-yanked { background: --t-revoked }`、`.is-degraded { background: --t-degraded }`。
`deprecated` **不染底**（它仍可安装，染底会过度报警），只在状态标记上着色。

hover：只改背景（`color-mix(ink 4%, surface)`），**不位移、不加阴影、不变边框宽度**。

🔴 卡片里没有任何位置放下载量。事实行的四项就是四项。

### 7.5 capability 徽章 `.tier`

**双通道编码**：分段计量条（3 格，亮起 1/2/3 格）+ 色相。

| Tier | capability | 颜色 | 计量条 |
|---|---|---|---|
| 0 | `none` | `--c-neutralbadge` | ▮▯▯ |
| 1 | `network` / `external-tool` | `--c-caution` | ▮▮▯ |
| 2 | `shell` / `credentials` / `writes-repo` | `--c-revoked` + 内描边加重 | ▮▮▮ |

形态：**描边 + 透明底**，`border: 1px solid currentColor`，`--r-chip`。
状态标记 `.status` 反过来：**无边框 + 着色底**。
🔴 这个形态差异是刻意的：Tier 2 与 yanked 共用 `--c-revoked`，靠形态区分——
一个是「这东西能力很大」，一个是「这东西被撤了」，不能长得一样。

徽章右侧**永远直接跟真实 capability 名**（`shell · credentials · writes-repo`），
不要只写 "TIER 2" 让人去查表。pack 的 Tier 标注为「并集取最高」。

非 `geoly` namespace 的 Tier 1/2 制品：卡片与详情页都要出现一句
「安装时会强制展示 capability 并要求确认；`--yes` 可跳过，但跳过会写进账本」。

### 7.6 状态警示条 `.notice`

统一形态：`border-top: 3px <语义色>` + `--t-*` 极淡底 + 18px 图标 + 标题（Display 14.5px）+
说明段 + 可执行按钮组。**没有大图标、没有满色实心条、没有惊叹号轰炸——这些是事实，不是错误。**

| 类型 | 顶边 | 图标 | 标题主语（🔴 主语不同） | 按钮 |
|---|---|---|---|---|
| yanked | `--c-revoked` | `x` | 「此版本已于 &lt;date&gt; 被 yank，不可新装」 | 查看公告 / 跳到替代版本 / 仍要查看内容 |
| degraded | `--c-degraded` | `block` | 「此 pack 被标记为 degraded：**它锁定的一个必装成员已被 yank**」 | 看是哪个成员 / 找可安装的版本 |
| deprecated | `--c-caution` | `bang` | 「此版本已弃用，**但仍可安装**」 | （通常无按钮） |

🔴 **`advisory` 与 `superseded_by` 是可选字段**（`YANK_KEYS.optional`）。缺席时：
不要渲染点不开的「查看公告」按钮，只展示必填的 `reason`；`superseded_by` 缺席时明写
「未声明替代版本」，不要自作主张推荐一个更高版本。

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
- 若某 pack 全部版本都 degraded → 明说「该 pack 当前没有可安装版本」并列出各版本被哪个成员拖累。

### 7.7 摘要串（64 hex）

三种形态：

**full**（详情页）：`geoly-tree-v1:sha256:` 前缀用 `--c-text-dim` 单独一段，其后 64 hex 按 **8 组 × 8 字符**排。

```html
<span class="digest">
  <span class="algo">geoly-tree-v1:sha256:</span>
  <span class="hex"><b>9f2c4a71</b><b>3e05b8d2</b>…</span>
  <button class="copy" data-copy="9f2c4a71…">复制</button>
</span>
```

```css
.digest .hex { user-select: all; word-break: break-all; }
.digest .hex > b { font-weight: 400; }
.digest .hex > b + b { margin-left: 5px; }         /* 🔴 分组靠 margin */
.digest .hex > b:nth-of-type(1),
.digest .hex > b:nth-of-type(8) { font-weight: 600; color: var(--c-text); }
```

🔴 **最容易做错的地方**：分组间距**必须**靠 `margin`，DOM 里**不能有空格**（不要 `9f2c4a71 3e05b8d2`）。
插了空格，用户复制粘到终端里就是一个坏值。同理，复制按钮从 `data-copy` 取原始串，不从 `textContent` 取。
`user-select: all` 让点一下就全选整串。首尾两组加粗，因为人核对摘要时看的就是首尾。

**short**（列表/表格）：`首8…尾8`，mono 12px，中间 `…` 用 `--c-text-dim`。hover 出 title 全串，点击展开为 full。
🔴 短形态**只用于导航，不用于核对**；任何要求用户比对的场景必须给 full。

**pair**（vendored 双摘要并列）：两行上下对齐，同宽同分组，**都用常规色**。

🔴 **绝不做字符级 diff、绝不给某几组染色。** 哈希是雪崩的——两串本来就一个字符都对不上，
染色会暗示「差异定位在这几段」，那是假的。正确表达是一句**可复算的事实**：

> 去掉 `added_files = ["skill.json"]` 之后重算 hub 载荷的树摘要 → 与 `origin_tree_digest` 相等 ✓

下方补一句「两值不相等是**预期**：hub 侧多了一个 `skill.json`」，用 `--c-caution` 说明，
**不许用 `--c-revoked`**（它不是故障）。

### 7.8 provenance 块 `.prov`

两种形态**刻意长得不一样**——这是 `parseSnapshot` 里两套完全不同的键集，视觉上不该伪装成同一张表。

**original**（`kind` / `author_github_id` / `submitted_by_pr`）：只有两个节点，两行完事，
`kindtag` 用 `--c-verified` 底。**不要为了"对称"给它补空行或占位符。**

**vendored**（10 个字段）：做成一条**带节点的搬运轨迹**（虚线竖轨 + 圆点），顺序即因果：

1. `origin_repo` · `origin_ref`
2. `origin_commit`（40 hex）—— 副行必须写「tag 可以被移动，那正是审核后换内容的攻击路径」
3. `origin_subpath`
4. `origin_tree_digest`（带 `geoly-tree-v1:sha256:` 前缀，短形态或 full）
5. `added_files`（白名单）—— 副行解释**双摘要为什么本就不相等**
6. `license_evidence` · `imported_at` · `imported_by_pr`

`kindtag` 用 `--c-ink` 底（vendored 不是坏事，只是来源不同，**不给它警告色**）。

### 7.9 pack 成员表 + 「被谁拖累」

表格 `.members`：`# / 成员 / role / tree_digest / 状态`。
`role` 显示为 `matrix · 必装` 或 `bundled · --no-bundled 可跳过`；bundled 行整行 `--c-text-dim` 降调。
被 yank 的成员整行 `--t-revoked` 底。

**拖累关系不做成表里的一列。** 它是一句因果，用一条横贯表宽的 `.blameline` 单独占一行，
三段式：`<被 yank 的成员> ⟶ <它是 matrix 必装成员> ⟶ <所以本 pack 的 N 个版本全是 degraded>`。
mono 12.5px，`--c-sunken` 底，箭头用 `--c-degraded`。

pack 头部要标注三条派生口径（🔴 两个口径不一样，最容易抄错）：

- 「精确版本 + 摘要锁定，不接受 semver range」
- `clients` = **全体 `members` 的交集**，🔴 **`bundled` 不参与**（它可被 `--no-bundled` 跳过）
- `capabilities` = **`members` + `bundled` 的并集**；pack 的 Tier 取该并集对应的最高 Tier

pack 卡片的 Tier 徽章后面必须给**真实的 capability 并集**（如 `shell · credentials · network`），
不能只写一句「并集取最高」——那等于把最该看的信息藏起来。

🔴 **`degraded` 只能对「本版本锁定的必装 `members`」推导**：pack 不可变，每个版本锁的成员不同。
不要从一个版本的成员表推出「所有版本都 degraded」。要表达跨版本结论，就**逐版本列出**
各自被哪个被 yank 的成员拖累（见演示页 §08 的「逐版本」行），并据此说明 `latest` 落在哪一版。

### 7.10 搜索与筛选

**搜索框**：输入框用 **mono**（这里输入的一半是标识符）。placeholder 直接示范可接受的三种形态：
`name / skill:ns/name@ver / 64 hex 摘要`。右端 `/` 快捷键 kbd。
`:focus-within` 时边框变 `--c-ink` + 2px 半透明外环。

🔴 **粘一整串 64 hex 必须能反查制品**（借鉴 Rekor 搜索）。这是这个站点最有辨识度的搜索能力，
不要做成只搜名字。命中时结果行要标明匹配的是 `tree_digest` 还是 `asset.sha256`。

**筛选**：chip 按钮（mono 12px，`--r-chip`，`aria-pressed` 控制按下态 → `--t-ink` 底 + `--c-ink` 边框）。
分组顺序按**信任维度**，不按流行度：

`kind` → `tier` → `status` → `provenance` → `client` → `license` → `namespace`

每个 chip 右侧带计数（`--c-text-dim`）。**没有 "sort by downloads"**；排序项只有
`id 字节序`（默认，与快照一致）/ `最近进入快照` / `capability tier`。

### 7.11 🔴 空状态：registry 一个制品都没有

**这是首页本身，不是缺省页。**这个状态会被看很久，必须能独立成立。

设计思路：**把「0 个制品」当成一条已签名的事实来排版。**
`hub-0.json` 是真实存在、真实被签过、真实进了 Rekor 的对象——它此刻的内容恰好是空的。
于是空状态变成整套信任链的**活演示**：读者现在就能自己验一遍。

结构（全部左对齐，**不居中**、**没有插画**）：

1. **标签**：`geoly-ai/skills-hub · snapshot hub-0`
2. **主句**（Display 26px）：**「这张快照是空的，而它是被签过名的空。」**
3. **引言**：说清 0 不是加载失败——`hub-0.json` 由 `release.yml` 签署、进了透明日志、
   被一张 7 天有效期的 timestamp 指向；这条链现在就成立，第一个 skill 进来时也不会变。
4. **零计数块**：`0` 用 Display 64px（`wdth 100`，收窄），右侧小字
   `artifacts · 0 yanked · latest 映射为空对象`，再下一行 `previous: — / created_at: …`。
   🔴 这是全站唯一的大号数字，而它是 0——恰好和"我们不展示使用量"的立场自洽。
5. **信任链条**（§7.2 同一组件，四格全 ok）：证明链在空 registry 上照样跑得通。
6. **两栏**：
   - 左「现在就能做的事」：两条可复制命令（`snapshot --verify --explain`、`search '' --json`），
     外加一句「没有 `--no-verify`，也没有 `--insecure`：验签器没接上，CLI 直接拒绝运行」。
   - 右「第一个制品会这样进来」：4 步流水线（投稿结构门 → 人工门与 Tier 分级 → promotion 与树摘要
     → 双身份签名），每步一句实话。底部三个按钮：投稿指南 / 看 hub-0.json 原文 / 命名空间与保留名。

**禁止**：「暂无数据」「敬请期待」「Coming soon」、居中的空盒插画、灰色占位骨架屏、
一个大号加号按钮。

**空搜索结果**是另一个状态（`.emptyrow`，虚线框）。🔴 **必须区分两种「空」，不要用同一句文案**：

- **筛选筛没了**：说清是哪几个条件把结果筛空的（原样列出生效的 chip），出口是「清空筛选」。
- **registry 本身是空的**：明说「这张快照收录 0 个制品，任何查询都不会有结果，不是筛选条件写错了」，
  出口是「看 registry 现在是什么状态」（跳到 §7.11 的空状态）。

---

## 8. 布局与响应式

| 断点 | 行为 |
|---|---|
| ≥1200px | 可选左侧锚点栏 180px；正文 max-width 1160px |
| 1024–1199 | 单列，正文 1160px（实际由 padding 收） |
| 768–1023 | 单列；信任链条仍 4 格；卡片事实行开始换行 |
| <780px | 信任链条 → 纵向 4 段；`.empty .cols` → 单列 |
| <620px | 台账 `dl` → 单列（dt 变小标签）；筛选 chip 横向可滚（`overflow-x:auto`，隐藏滚动条） |
| <420px | ArtifactId 允许 `word-break: break-all` 换行，字号降到 13.5px |

**宽内容处理（摘要、表格）**：

- 🔴 **表格永远包一层 `overflow-x: auto` 的容器**，容器带边框圆角，表格 `min-width: 640px`。
  绝不让页面 body 横向滚动。
- 摘要 full 形态用 `flex-wrap: wrap` + `word-break: break-all`，窄屏时按分组换行——
  因为分组是 8 字符，换行点不会落在组中间（`<b>` 是不可分的原子）。
- 命令块 `.recheck` 单行 `overflow-x: auto`，**不换行**（命令换行会被误复制成两行）。
- `.ledger > dd` 必须有 `min-width: 0` + `overflow-wrap: anywhere`，否则长 URL 会撑爆 grid。

---

## 9. 动效

**全部动效就下面这几条，多一条都是错。**

| 场景 | 规格 | 为什么 |
|---|---|---|
| hover / press | `background`、`border-color` `120ms linear` | 只改颜色。列表行 hover 时**不许位移**——位移会让密集台账抖动 |
| 复制反馈 | 文案「复制」→「已复制」，颜色切 `--c-verified`，1200ms 复位 | 无缩放、无弹跳；复制是确认，不是庆祝 |
| 折叠展开 | `grid-template-rows: 0fr → 1fr`，`160ms ease-out` | 摘要短→全、成员表展开 |
| 焦点 | `outline: 2px solid var(--c-ink); outline-offset: 2px`，无过渡 | 键盘导航必须立刻可见 |
| 加载中 | **静态**占位横线（`--c-sunken`），无 shimmer | 🔴 扫光会让「还没验证完」看起来像已经有内容了。这个站点里"未验证"必须看起来是空的 |

**禁止**：入场动画、滚动触发动画、视差、数字滚动（我们也没有数字可滚）、渐变流动、页面切换过渡、
骨架屏 shimmer、任何 >200ms 的过渡。

`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }`

---

## 10. 可访问性

- 状态与 Tier **永远同时有文字**，颜色不是唯一通道；Tier 另有计量条形状通道。
- 语义色对 `--c-surface` 的对比度：正文级用途 ≥4.5:1，大字/图标级 ≥3:1。暗色色值已按此上调。
- 筛选 chip 用 `<button aria-pressed>`，不是 `<div>`。
- 摘要块用 `role="group" aria-label="树摘要 geoly-tree-v1，64 位十六进制"`，
  避免屏幕阅读器逐字念 64 个字符时毫无上下文。
- 🔴 **警示条是页面既有的静态事实，不是实时通知**：用带标题的
  `<div class="notice" role="group" aria-labelledby="<h4 的 id>">`。
  **不要用 `role="alert"`，也不要用 `role="status"`** —— 那两个是 live region，
  会在页面加载时被朗读成"刚刚发生的事"。
- live region 只留给**真正动态**的两件事：验证完成（链条从 `none` 变成 ok/bad）与"已复制"。
  各用一个独立的 `aria-live="polite"` 容器，不要把 `aria-live` 挂在按钮本身。
- 主题切换是三态按钮（跟随系统 / 亮 / 暗），状态写进 `data-theme`，
  按钮文字直接给出当前值（"主题：跟随系统 / 亮 / 暗"）。

---

## 11. 实现者最容易做错的六处（照这个自查）

1. **把信任面板放进右栏。** 这是 npm 的做法，也是本设计明确反对的第一条。信任在正文顶部。
2. **摘要分组插了空格。** 复制出来就是坏值。分组必须靠 `margin`，DOM 里零空格。
3. **把 `degraded` 当 `yanked` 渲染。** 两者颜色、图标、文案主语、可用性都不同：
   yanked 是「它被撤了」，degraded 是「它被别人拖累了，且 `--allow-yanked` 不放行」。
4. **给 vendored 的双摘要不相等报红。** 那是预期行为（多一个 `skill.json`），用 `--c-caution` 并写明原因。
5. **顺手加一个下载量/热度位。** 没有这个数据。列表排序、筛选、卡片里都不留位置。
6. **中文掉进宋体 / 大写标签塞中文。** 见 §4.3：不 web 加载 CJK、mono 栈也要挂中文、
   `.label` 只放拉丁。
7. **把「验签失败」渲染成 `yanked`，或把「还没验」渲染成绿勾。** 见 §0.1 的两条轴与 §6 的图标表。
   默认态是虚线圈，不是绿勾。
8. **把载荷里的东西（description、pack 成员表）当成快照字段。** 见 §0.2：它们在
   `asset.sha256` / `tree_digest` 核对通过之前是未验证数据。
9. **`latest` 规则只写了排除 degraded。** 完整规则是排除 yanked + degraded + prerelease，
   而 `deprecated` **可以**进入 latest。
10. **pack 的 `clients` 与 `capabilities` 用了同一个口径。** 交集不含 bundled，并集含 bundled。
11. **给摘要做字符级 diff。** 哈希雪崩，分组没有定位语义。见 §7.7。
12. **把 attestation 的 `workflowRef` 和 signer identity 混为一谈。** 前者必须钉 40 位 commit，
    后者就是 `@refs/heads/main`。见 §7.3。
