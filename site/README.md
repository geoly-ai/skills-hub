# registry 浏览站点

把 `registry/snapshots/hub-<N>.json` 渲染成可浏览的页面。**构建时**把快照读成数据，
**运行时不查任何后端、不发任何请求** —— 页面上写的每个字都能追回到那一次构建读的那张快照。

## 现在它长什么样

`registry/snapshots/` 与 `artifacts/` **都还不存在**，一个制品都没有发布过。
所以现在整个站点就是空状态：首页如实说「registry 还没有任何制品」，
并列出 `docs/m3/02-decisions.md` 里那三件上线前置（维护者团队 node id、release bot 的
GitHub App、分支保护）。**这不是故障** —— 那三件做完之前仓库是 fail-closed 的。

## 跑起来

```sh
cd site
npm install
npm run build          # = node build.mjs && next build
npm run dev            # 本地预览（也会先跑 build.mjs）
npm test               # 数据管道 + 产物扫描（不动仓库根的 npm test）
```

拿造出来的 fixture 快照预览（现在 registry 是空的，想看非空状态就用它）：

```sh
node -e "import('./test/fixture.mjs').then(m=>{const f=m.makeFixtureRegistry();console.log(f.snapshotsDir,f.artifactsRoot)})"
rm -rf .next out          # ⚠️ 换状态之前一定要清
node build.mjs --snapshots <上面第一个路径> --artifacts <上面第二个路径>
npx next dev
```

⚠️ **本地在"有制品"与"空 registry"之间来回切时，先 `rm -rf .next out`。**
`next build` 不会删掉上一次生成的页面目录，于是切回空状态之后 `.next/server/app/artifact/**`
还留着一堆旧页面 —— 看起来像"空 registry 却有制品页"。Vercel 每次都是全新目录，不受影响。

## 数据是怎么来的

`build.mjs` → `site/.generated/site-data.json`（不进版本库），页面 `import` 它。

1. **挑最新的快照**：直接用 `scripts/release/build-timestamp.mjs` 的 `newestSnapshot()`。
   不另写一份 —— 两份"挑最新"的实现迟早会取到不同的两张快照，而 timestamp 是签名对象。
2. **解析**：只走 `src/snapshot.mjs` 的 `parseSnapshot()`，不 `JSON.parse` 之后自己信。
3. **快照不存在 / 没有可识别的快照文件** → 正常构建、产出空状态，退出码 0。
   ⚠️ 只有这两种情况算空；`newestSnapshot()` 报的别的错（快照号超出安全整数、
   快照号出现在两个文件里）是**真故障**，照抛不误 —— 吞掉它，页面会平静地宣布
   registry 是空的，而实际上磁盘上有一张读不对的快照。
4. **载荷**：`description` 与 pack 的 `members` / `bundled` **不在快照 record 里**
   （`RECORD_KEYS` 没有它们）。只有当 `artifacts/<path>/` 重新打包出的 `tree_digest`
   与 record 里那个相等时才展示，并在页面上标成"来自工作树载荷"。对不上就什么都不展示。

## 🔴 站点不做验签

验 Sigstore 签名要 `timestamp.json`、`.sigstore.json` bundle、内置 TUF 根 —— 本站点一样都没有
（timestamp 只作为 Release 资产分发，仓库里不存，02-registry.md §3.2）。
所以它只能证明"仓库工作树里这个文件长这样、严格解析得开、sha256 是这个"，
证明不了这张快照是真的、是当前的。**这句话印在每一页上**，`test/export.test.mjs` 会验它在。

## 🔴 页面上没有使用情况指标

装机量、调用量、下载量 —— 这类数字我们**根本没有**：埋点是纯本地的，
没有内置默认上报端点（`docs/telemetry/00-spec.md` §4）。
所以模型里连字段都不留，页面上也不留"即将上线"的占位。
`test/export.test.mjs` 扫全部产物 HTML/JS，一整批表示使用情况的词出现即红。

## 部署到 Vercel

| 项 | 值 |
|---|---|
| Root Directory | `site` |
| Framework Preset | Next.js |
| Build Command | `npm run build`（= `node build.mjs && next build`） |
| Install Command | `npm install` |
| Output Directory | **留空，用预设的** |
| Node.js Version | 与仓库 `engines` 一致：`>=22.13`。本地实测过 Node 25.2；Vercel 上建议选 22 或 24 这两个 LTS，别用最新的奇数版 |

⚠️ **Root Directory 只能在 Vercel 面板里设**，`vercel.json` 表达不了它。

🔴 **不要写死 Output Directory。** 站点有两种构建形态：

- **有制品**：`output: 'export'` → 纯静态目录 `out/`；
- **registry 为空**：不能开 `export`（Next 要求每个动态路由的 `generateStaticParams()`
  至少产出一个页面，而现在制品详情页本就该是 0 个；造一个占位路由等于凭空发明一个
  不存在的制品 URL）→ 退回默认构建，产物在 `.next/`。页面同样全部在构建期预渲染。

Vercel 的 Next 预设两种都认。写死了 `out`，**第一个制品发布的那天**（或反过来，
最后一个制品被撤下的那天）就会挂。

`build.mjs` 用 `import.meta.url` 往上找仓库根来定位 `registry/`，不依赖 `cwd` ——
Root Directory 设成 `site` 之后 cwd 是 `site/`，但 checkout 仍是整个仓库。

## 设计

规格在 [`DESIGN.md`](DESIGN.md)，可视证据在 [`design-preview.html`](design-preview.html)
（单文件，浏览器直接打开）。token 名与那两份一一对应。

- **视觉隐喻是台账，不是仪表盘**：行而非卡片、2px 栏线、圆角只有 2px/3px 两档、
  零渐变、零阴影（仅弹出层一处保留）。
- **颜色**：greenbar 台账纸中性色 + 六个语义色，全部集中在 `app/tokens.css`；
  组件 CSS 里不写字面量色值与像素间距。亮/暗跟随 `prefers-color-scheme`，
  另有三态主题按钮（跟随系统 / 亮 / 暗）写进 `data-theme`。
- **字体**：Archivo（标题，用 `wdth` 轴拉宽）+ IBM Plex Sans（正文）+ IBM Plex Mono（主力）。
  🔴 用 `next/font/google` **构建期自托管**，不是 `<link>` —— 见下面「与规格的出入」。
  中文一律走系统栈，不 web 加载任何 CJK 字体。
- **键盘与可访问性**：`:focus-visible` 描边、跳到主内容、滚动容器可聚焦、
  状态与 Tier 永远同时有文字（颜色不是唯一通道，Tier 另有计量条形状通道）；
  警示条用 `role="group"` 而非 `role="alert"`（它们是静态事实，不是刚发生的通知）。

### 🔴 三条轴永远分开

| 轴 | 取值 | 来自 | 在哪 | 图形 |
|---|---|---|---|---|
| 生命周期 | `published` / `deprecated` / `yanked` / `degraded` | 快照 record 的 `status` | `components/badges.jsx` 的 `StatusMark` | 勾 / 竖线点 / **裸叉** / 方框斜线 |
| 验证 | `verified` / `stale` / `failed` / `unverified` | 我们这一次到底验没验签 | `components/trust.jsx` 的 `TrustChain` | 勾 / 竖线点 / **圈叉** / **虚线圈** |
| 本地比对 | 相同 / 不同 / 取不到 | 工作树载荷重打包出的 `tree_digest` 与 record 里那串是不是同一串字节 | `components/payload-notice.jsx` | **等号** / **带斜杠的等号** / 虚线短横 |

三者**刻意不共用任何组件、图标或颜色映射函数** —— 共用一个 `statusColor()`
就是它们被合并回去的第一步。

第三条轴是 Codex 第三轮评审揪出来的（P1）：它原本借用了验证轴的 check / fail /
unverified，于是页面顶部四格写着「未验证」、下面却出现一个勾，**第一眼读成
「验证通过」**。现在它只说「相同 / 不同 / 取不到」，标题里永远带着「本地比对，未验签」，
表皮也是中性无底色的 —— 因为「两串字节相同」既不是好消息也不是坏消息，给它一个绿底
就会被读成验证通过。

`test/export.test.mjs` 里有 9 条用例钉住这三条轴不许合并。

### 与规格的出入（都是实现时发现、并有理由的）

1. **信任链条四格恒为「未验证」**，包括空状态。DESIGN.md §7.2 说默认是 `none`、
   §7.11 让空状态四格全 `ok` 演示信任链跑得通 —— 本站点**一步都没跑**
   （没有 timestamp、没有 bundle、没有 TUF 根），画成 `ok` 就是撒谎。
   于是 `none` 在这里不是默认值，是终值，页面上写明「这不是加载中，也不会变」。
2. **空状态主句改了**。规格是「这张快照是空的，而它是被签过名的空」，前提是存在
   `hub-0.json`。现实是**连一张快照都还没有**，所以主句改成如实的那一句。
   零计数块、两栏结构、流水线都照规格。
3. **字体用 `next/font/google` 而不是 `<link>`**。`<link>` 会让每个访客在运行时向
   Google 发请求，而页脚印着「不发任何请求」。§4.2 自己也写了 Next 项目走这条路。
4. **搜索少一个排序项**。§7.10 列了「最近进入快照」，但快照 record 里**没有**
   「何时加入」这个字段 —— 页面上如实说明做不了，而不是拿 `created_at` 冒充。
5. **`--c-text-dim` 在亮色下调深了**（`#6E776F` → `#5F6861`）。实测它对 `--c-surface`
   只有 4.42:1、对 `--c-sunken` 只有 3.76:1，低于 §10 自己要求的 4.5:1；
   调整后 5.50 / 4.69 / 5.06 全部达标。
6. **页面正文里不出现 🔴 等 emoji**（§1.8 的自检清单）。它们只留在源码注释里。
7. **空状态的信任链条也是四格未验证**，不是 §7.11 说的四格 `ok`（同第 1 条）。

### 实际渲染发现并修掉的三处

设计师与 Codex 都没在浏览器里跑过，这三处是真渲染才暴露的：

- **flex 子项的 `min-width: auto`** 让 `.tablescroll` 在 360px 视口下不收缩，
  `.members` 的 `min-width: 640px` 把整页顶宽到 638px；而 `body` 有 `overflow-x: hidden`，
  表现不是「能横滑」而是**右半张表被裁掉且滑不到**。修法：`.page > *, .section > * { min-width: 0 }`。
- **警示条正文里嵌的整串 `geoly-tree-v1:sha256:<64hex>`** 没有断行机会，
  把 `.notice → .section → .page → .wrap` 一路顶宽。`minmax(0,1fr)` 只管住列轨道，
  管不住列里那个默认 `min-width: auto` 的块。修法：`.notice > div { min-width: 0 }` + `overflow-wrap: anywhere`。
- **中文被塞进了大写小标签**（provenance 轨迹的字段名、表头），`letter-spacing: .09em`
  把中文拉散。修法：`.cn` 修饰类，集中在 base.css 一处。

还有两处也是真渲染才发现的：

- **`.members th` 把表格里的数据也大写了** —— 版本号 `1.1.0-rc.1` 被渲染成 `1.1.0-RC.1`。
  semver 是区分大小写的字面值，这不是排版问题，是**把值改了**：读者照着抄回终端
  就是一个不存在的版本。修法：大写只给 `thead th`。
- **同一页出现两个「01」区段编号**（`TrustChain` 把序号写死了）。改成参数由各页传。

已验证：摘要 `.hex` 在 DOM 里长度正好 64、**无任何空白字符**（复制出去是可用的值）；
7 个页面在 375px、3 个页面在 768px 下 `body.scrollWidth === clientWidth`；
64-hex 反查命中并正确标出匹配的是 `tree_digest` 还是 `asset.sha256`；
Archivo 的 `wdth 118` 真的生效、中文没有掉进宋体；
亮/暗两套配色的语义色对比度全部 ≥4.5:1。

## 文件

| 文件 | 职责 |
|---|---|
| `build.mjs` | 数据管道入口；`--snapshots` / `--artifacts` 只给本地预览与测试用 |
| `lib/paths.mjs` | 仓库路径（从 `import.meta.url` 推，不用 cwd） |
| `lib/snapshot-source.mjs` | 挑最新快照 + 严格解析 + 空状态判定 |
| `lib/payload.mjs` | 工作树载荷的 tree_digest 核对与 manifest 提取 |
| `lib/model.mjs` | 快照 → 视图模型（Tier 标注、分布、版本历史、pack 派生与归因） |
| `lib/site-data.js` | 页面读数据的唯一入口 |
| `app/` | 路由与页面（App Router） |
| `components/badges.jsx` | 生命周期轴：状态标记、Tier 徽章、ArtifactId |
| `components/trust.jsx` | **验证轴**：信任链条四格 + 信任台账 |
| `components/payload-notice.jsx` | **本地比对轴**：载荷字节与 record 是否同一串 |
| `components/global-search.jsx` | 站头全局搜索（每一页都能粘 64 hex 反查） |
| `components/digest.jsx` | 摘要串 8×8 分组（靠 margin，DOM 里零空格） |
| `components/provenance.jsx` | original 两行 / vendored 搬运轨迹 |
| `components/status-notice.jsx` | yank / degraded / deprecated 警示条 |
| `components/pack-details.jsx` | 成员表 + 因果句式的拖累关系 |
| `DESIGN.md` · `design-preview.html` | 设计规格与它的可视证据 |
| `test/fixture.mjs` | 用 `scripts/build-snapshot.mjs` 造**真**快照，不手写假 JSON |
