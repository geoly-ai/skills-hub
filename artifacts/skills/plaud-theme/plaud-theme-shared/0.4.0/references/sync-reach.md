# Sync Reach — 改动能不能到店

**何时读我**：本次改动会写入任何 `templates/` `locales/` `sections/*.json` `config/` `snippets/` 下的文件时；
做 Assess（`plaud-theme-impact` 的 `SyncReach` 字段）时；组提测包（`SyncReachStatus`）时；推站前复核（`SyncReachCheck`）时。
**选修改入口之前就要读** —— 它会改变入口排序（§8）。

> 🔴 **本文件是 15 条保护规则、匹配语法与判定算法的唯一事实源。** 其它 skill 只引用、不复制
> （复制 = 第二个事实源，规则一改必然漂移）。**per-site 的自研代码清单不在本文件里**，它是项目运行时状态，见 §7。

---

## 1. 分发模型（矩阵此前完全不知道的那件事）

PLAUD 不是「一个主题仓库 = 一个店」。它是：

```
一套基线核心代码（git 分支 origin/main）
        │  sync（共享同步引擎）
        ▼
17 个独立 Shopify 店：AU CA DE ES EU FR GLOBAL HK IT JP LATAM NL SEA TW UAE UK US
```

矩阵原有的 `TargetSites` / `ExcludedSites` 回答的是「**要推哪几个店**」。
本文件回答的是一个**正交**的、此前没人回答的问题：**「这次改的这些文件，sync 到底会不会覆盖各店？」**

两类文件 **sync 不覆盖各店版本**：

| 类 | 基线里 | 各店 | 后果 |
|---|---|---|---|
| **① 保护清单**（§2，15 条全局 glob） | **有**默认版 | 留自己的版本 | 改基线里的这些文件 → **各店收不到** |
| **② 站点自研代码**（§7） | **没有** | 各店自己写的 `.liquid` / `.js` / `.css` | 引擎**结构性避让、永不碰**；基线侧看不见它们的演进 |

🔴 **这就是那个静默失败**：改动进了基线、CI 绿、QA 过、release-ops 推站成功、
`RemoteVerifyResult: Matched`——而 17 个店一个都没看到这次改动。
**没有任何一道现存的门会报错**，因为每一道门验的都是「基线这棵树对不对」，没有一道验「这棵树到不到店」。

### 1.1 基线锚点必须可复算

判定必须钉在一个具体的 baseline 上，否则同一条规则在不同时间对不同基线判出不同结果、事后无法复算。
Assess 的 `SyncReach` 用 §4 `BaseHeadSha` 那个 commit-ish 作为「基线现状」的锚点
（`templates/**/*.json` 的「新增 vs 修改」判定直接依赖它，见 §5.2）；拿不到可解析的 commit-ish → `Undetermined`。

---

## 2. 保护清单（全局规则，共 15 条）

> 来源：《PLAUD DTC 保护与站点自研代码报告》，导出于 **2026-09-03 11:18:01**。
> 「来源」列的 `默认` / `手动` 是规则本身的登记方式，**不改变判定**——两者一样受保护。

| # | 文件 / 模式 | 范围 | 来源 | 原因（sync 行为） |
|---|---|---|---|---|
| 1 | `**/matycube*` | 全站 | 默认 | Matycube app 相关文件：各店独立，保留各店版本 |
| 2 | `**/pagefly*` | 全站 | 默认 | PageFly app 相关文件：各店独立，保留各店版本 |
| 3 | `**/pf-*` | 全站 | 默认 | PageFly 编辑器生成的页面/资源：各店独立，保留各店版本 |
| 4 | `config/*.json` | 全站 | 默认 | 店铺配置（`settings_data` / `markets` 等）：各店专属，保留各店版本 |
| 5 | `locales/*.json` | 全站 | 默认 | 各店语言包：**只同步基线新增/删除的字段，不覆盖各店已本地化的键值** |
| 6 | `sections/*.json` | 全站 | 默认 | section group（页头/页脚等）配置：各店排布专属，保留各店版本 |
| 7 | `snippets/cmp.liquid` | 全站 | 默认 | 同意管理（CMP）埋点：各店有自己的配置 |
| 8 | `snippets/decagon-chat.liquid` | 全站 | 手动 | 各店埋点文件 |
| 9 | `snippets/ga4-push.liquid` | 全站 | 默认 | GA4 数据层埋点：各店有自己的追踪 ID |
| 10 | `snippets/ptengine-tag.liquid` | 全站 | 默认 | Ptengine 埋点：各店有自己的追踪 ID |
| 11 | `snippets/rtibid_tag.liquid` | 全站 | 默认 | rtibid 追踪：各店有自己的配置 |
| 12 | `snippets/site_boby_tracking.liquid` | 全站 | 默认 | 站点 body 追踪脚本：各店定制 |
| 13 | `snippets/site_tracking.liquid` | 全站 | 默认 | 站点追踪脚本：各店定制 |
| 14 | `snippets/trpx.liquid` | 全站 | 默认 | trpx 追踪：各店有自己的配置 |
| 15 | `templates/**/*.json` | 全站 | 默认 | OS2.0 页面/产品模板 JSON：**只同步基线新增的模板，各店已本地化的不覆盖** |

### 2.1 例外：被 glob 圈住但**仍走共享同步、不受保护**

| 路径 | 被哪条圈住 | 实际行为 |
|---|---|---|
| `config/settings_schema.json` | #4 `config/*.json` | **仍走共享同步** → `Reachable` |
| `locales/*.schema.json` | #5 `locales/*.json` | **仍走共享同步** → `Reachable` |

🔴 **例外优先于广义规则**（§5.1 的判定顺序）。但**审计记录里 `MatchedRules` 仍要如实写上被命中的广义规则**，
再用 `ExceptionApplied` 说明为什么最终生效的不是它——只写「不受保护」而不写命中了什么，事后无法复核判得对不对。

🔴 `locales/*.schema.json` 的例外**只覆盖一层目录**（`locales/` 直属）。`locales/xx/yy.schema.json` 不在例外内，
且 `locales/*.json` 的 `*` 是单层、本来也匹配不到它——这种路径请按 `Undetermined` 处理并问用户，不要自行外推。

---

## 3. 匹配语法（matcher grammar）

🔴 **区分「报告明示的事实」与「本文件的解释约定」。** 后者是为了让判定可执行而写死的约定，
**不是报告证实过的引擎行为**；踩到解释约定的边界时，取 `Undetermined` 并问用户，**不要当成已经判过了**。

| 元素 | 语义 | 性质 |
|---|---|---|
| `*` | **单层**：匹配一个路径段内的任意字符，**不跨 `/`** | 报告明示 |
| `**` | **跨目录**：匹配任意多个路径段 | 报告明示 |
| `pf-*` | **文件名前缀**（basename 以 `pf-` 开头），不是 substring | 报告明示 |
| `matycube*` / `pagefly*` | 同样按**文件名前缀**处理 | 🟠 **解释约定**——报告只点名了 `pf-*` 是前缀。含 `matycube` / `pagefly` 但不以其开头的 basename（如 `my-pagefly-shim.liquid`）→ **`Undetermined`，问用户** |
| `**/` 前导 | 匹配**任意深度，含零层**（即仓库根下的同名文件也命中） | 🟠 **解释约定**。零层这一档若成为判定的分水岭（路径正好在仓库根） → **`Undetermined`，问用户** |

其余一律写死，不留解释空间：

- 路径一律用 `/` 分隔，**不带前导 `./`**，与 §4 `ModifiedFiles` 的逐字路径同一串（不 trim、不改写大小写）。
- 匹配的是**文件**。目录本身不参与匹配；目录下的文件各自逐条判。
- **大小写敏感**。`Templates/x.json` 不等于 `templates/x.json`；出现只有大小写不同的路径 → `Undetermined`，问用户
  （各店的文件系统是否大小写敏感不在报告覆盖范围内）。
- **重命名**按 `Deleted`（旧路径）+ `Added`（新路径）**两条**判，两条都要出现在 `SyncReach` 里。
  只写一条 `Renamed` 会漏掉「旧路径在各店留了个孤儿」这一半。
- **symlink / gitlink**：§2 的字节保真门本来就会在取证阶段停机，这里不重复判定，直接 `Undetermined`。

---

## 4. 分类取值（`Classification`）

| 取值 | 含义 | 触发 |
|---|---|---|
| `Reachable` | 走共享同步，改了各店就会收到 | 不命中任何保护规则；或命中但落在 §2.1 例外内 |
| `NotReachable` | sync 保留各店版本，改了各店**收不到** | 命中 #1–#4、#6–#14 中任一条 |
| `NewTemplateOnly` | **只有新增能过，修改过不去** | 命中 #15 `templates/**/*.json` |
| `LocaleFieldLevel` | 粒度是**字段级**：新增/删除字段能过，改已本地化的键值过不去 | 命中 #5 `locales/*.json` |
| `SiteOverridden` | glob 判它可达，但**某些店有同名自研文件**，那些店永远用自己的版本 | 路径与 §7.2 清单里某个站点的自研文件**同名**（§5.1 第 6/7 步） |
| `Undetermined` | 判不了 | 见 §4.1 |

🔴 **`NewTemplateOnly` 与 `LocaleFieldLevel` 不是「大概能过」的委婉说法，它们是两种不同粒度的判定，别互相套用：**

- `templates/**/*.json` 的粒度是**文件级**：这个店里**没有**这个模板文件 → 新增会同步过去；
  这个店里**已经有**（哪怕内容和基线一模一样） → 基线对它的任何修改**都不覆盖**。
- `locales/*.json` 的粒度是**字段级**：同一个文件里，基线**新增的 key** 会同步进各店、基线**删除的 key** 会从各店删掉，
  但**已经存在于各店的 key，它的 value 不被覆盖**。所以「改一句英文文案」这种改动，即使文件整体"同步了"，**那句文案也不会变**。

### 4.1 `Undetermined` —— 必须存在的诚实出口

以下情形**不得**硬填 `Reachable` 或 `NotReachable`：

- 命中 §3 里标 🟠 的解释约定边界（前缀 vs substring、`**/` 零层、大小写）；
- 拿不到可解析的 `BaseHeadSha`，因而判不了 `templates/**/*.json` 的「新增 vs 修改」（§5.2）；
- `templates/**/*.json` 的 `ChangeKind` 是 **`Deleted`** —— 报告只规定了「新增」，**没规定删除传不传播**（§5.2）；
- `templates/**/*.json` 的 `ChangeKind` 是 **`Added`**，但**拿不到逐店存在性确认**（该店有没有同名模板）——
  基线仓库结构性查不到这件事（§5.2），拿不到就是 `Undetermined`，**不得**默认「基线是新增所以每个店都收得到」；
- 项目侧 `memory/站点自研代码清单.md` 缺失、或其 `AsOf` 日期早于本次判定需要的事实（§7.2）；
- 出现报告未覆盖的形态（`blocks/`、`layout/` 下的 json、多层 `locales/`、symlink 等）。

🔴 **`SyncReach` 里出现任一条 `Undetermined` → §3 工件的 `ReadyForImplement` 必须为 `No`，且 `BlockingGaps` 非空并写明缺什么。**
「先按能到店做，回头再确认」是本文件最想拦掉的失败模式——它和完全没判过的区别，只是多了一行看起来判过的记录。

---

### 4.2 🔴 「要不要落地方案」看的是**到不到店**，不是 `Classification`

`NewTemplateOnly` 与 `LocaleFieldLevel` 是**路径级的规则形态**，它们本身**不回答**这一项到不到店 ——
那要再看 `ChangeKind`。把「非 `Reachable` 就要方案」当成判据会两头错：
既给「基线新增的 locale key」这种本来就到得了店的项强要一份方案，
又让人误以为「反正 `Classification` 一样，写一份笼统的就够了」。

**逐项判据（下游三处共用这一张表）**：

| `Classification` | `ChangeKind` | 到不到店 | 要不要逐店落地方案 |
|---|---|---|---|
| `Reachable` | 任意 | 到 | 不要 |
| `NotReachable` | 任意 | **不到**（所有店） | **要** |
| `NewTemplateOnly` | `Added` **且已确认该店无同名模板** | 到 | 不要（对该店） |
| `NewTemplateOnly` | `Added` **且已确认该店已有同名模板** | **不到**（对该店） | **要**（对该店） |
| `NewTemplateOnly` | `Added` **但逐店存在性未确认** | ❓ `Undetermined` | 见下方 🔴 —— 不得放行 |
| `NewTemplateOnly` | `Modified` | **不到** | **要** |
| `NewTemplateOnly` | `Deleted` | 🟠 报告未覆盖（§5.2）→ `Undetermined` | 先拿裁决，不得放行 |
| `LocaleFieldLevel` | `Added` / `Deleted` | 到 | 不要 |
| `LocaleFieldLevel` | `Modified` | **不到** | **要** |
| `SiteOverridden` | 任意 | 对 `OverriddenAtSites` 里的店**不到** | **要**（至少覆盖那几个店） |

🔴 **`Undetermined` 那几行不是「要方案」也不是「不要方案」**：它们是**还没判**，
按 §4.1 一律 `ReadyForImplement: No`，方案不能代替事实（§5.2）。
`NewTemplateOnly` + `Added` 的三行是同一个 `Classification` + 同一个 `ChangeKind` 分成三种**事实状态**，
判据是「逐店存在性确认拿到没有、拿到的是哪个答案」——这正是 §5.2 说的那件基线仓库查不到的事。

🔴 **末行铁律（与 `Classification` 无关，独立叠加）**：
**`OverriddenAtSites` 非空 → 对 `OverriddenAtSites ∩ TargetSites` 里的每个店都必须有落地方案**，
哪怕本行的 `Classification` + `ChangeKind` 组合在表里是「不要方案」。
碰撞是**站点维度**的事实，glob 维度的结论盖不住它（§5.1 第 7 步）。

> 🔴 **取交集而不是取全集**：`OverriddenAtSites` 可能含本次根本不推的店。
> 对不在 `TargetSites` 里的店要方案 = 拿一个本轮不发生的问题阻塞提测。
> 交集为空时本条不触发。

## 5. 判定算法

对本次**每一个改动项**（不是每个文件，见 §5.3）执行：

### 5.1 顺序（写死，不得调换）

```
1. 归一化路径（§3：/ 分隔、无前导 ./、大小写原样）
2. 逐条比对 §2 的 15 条规则 → 记 MatchedRules[]（可能多于一条，全部列出）
3. 比对 §2.1 例外表 → 记 ExceptionApplied（无则 None）
4. EffectiveRule = 例外存在 ? 例外 : MatchedRules 中最先命中的那一条（按 §2 表的 # 顺序）
                   MatchedRules 为 [] 时 EffectiveRule = None
5. glob 侧结论 GlobClass = 由 EffectiveRule 查 §4 得出（EffectiveRule 为 None 时 = Reachable）
6. 🔴 比对 §7.2 的站点自研代码清单 → 记 OverriddenAtSites（同名的店；无则 N/A）
7. Classification =
     OverriddenAtSites 非空 且 GlobClass == Reachable  → SiteOverridden
     OverriddenAtSites 非空 且 GlobClass != Reachable  → 保留 GlobClass
                                                        （但 OverriddenAtSites 照记，见下方 🔴）
     其余                                              → GlobClass
   🔴 OverriddenAtSites 非空**永远**对那几个店触发方案要求，与最终 Classification 是什么无关（§4.2 末行）
8. 命中 §3 的 🟠 解释约定边界 → 直接 Undetermined（覆盖上面所有结论）
```

🔴 **第 6/7 步的位置是这套顺序里唯一容易写错的地方。** 早期草稿把它放在第 3.5 步（算 `EffectiveRule` 之前），
结果对一个「不命中任何 glob、但存在同名自研文件」的路径：`MatchedRules=[]` → `EffectiveRule=None` →
第 5 步算出 `Reachable`，**把第 3.5 步的 `SiteOverridden` 直接覆盖掉**——那正好是这一整步要拦的那类路径。
所以站点碰撞必须在 glob 侧结论**算完之后**才叠加。

🔴 **两者同时命中时保留 glob 结论**（第 7 步第二行），因为 `NotReachable` 这类结论**可能**比碰撞覆盖面更广，
降级成 `SiteOverridden` 会让另外那些店的不可达性凭空消失。

🔴 **但绝不能因此说「glob 结论对所有店成立、所以碰撞被它包住了」——那句话是错的**（v0.4.0 第三轮评审纠正）。
只有 `NotReachable` 是无条件对所有店不可达；另外两个**取决于 `ChangeKind`**：

| 组合 | glob 侧 | 碰撞店 |
|---|---|---|
| `LocaleFieldLevel` + `Added` / `Deleted` | **到得了店** | 碰撞店**仍然到不了** |
| `NewTemplateOnly` + `Added` | 取决于该店有没有同名模板 | 碰撞店**仍然到不了** |
| `NotReachable` + 任意 | 所有店都到不了 | 同样到不了（被包住） |

前两行里，若只看 `Classification` 就会按 §4.2 判「不需要方案」，
而**碰撞店实际上收不到这次更新** —— 这正是把两件事混成一件的代价。

**所以判据写死为**：`OverriddenAtSites` 非空 → **对那几个店**（与 `TargetSites` 取交集，§4.2 末行）
**永远**要有落地方案，**与最终 `Classification` 是什么无关**。
`OverriddenAtSites` 因此**不是只在 `SiteOverridden` 时才填**（见 handoff-schema §3 该字段说明）。

🔴 **第 6/7 步不是可选项。** §2 的 15 条 glob 只覆盖「保护清单」这一类，**覆盖不到第二类**
（站点自研代码，§1 表格第 ② 行）。`sections/us-form-contact-sales-2.liquid` 与 `assets/affirmShopify.js`
**一条 glob 都不命中** —— 只跑 glob 就会给它们 `Reachable`，而 LATAM 与 US 各有一个同名自研文件、
引擎结构性避让，那两个店永远拿不到基线版。随后 `SyncReachStatus` 只对非 `Reachable` 要方案、
`SyncReachCheck` 只对非 `Reachable` 判失败 —— **已知碰撞就这样一路绿灯到线上**。

🔴 **`SiteOverridden` 在下游与 `NotReachable` 同等对待**：它属于「非 `Reachable`」，
必须有覆盖那几个店的落地方案；`SyncReachStatus` / `SyncReachCheck` 都按非 `Reachable` 处理。
拿不到 §7.2 清单、或它的 `AsOf` 过旧 → `Undetermined`（§4.1），
**不得**默认「没查到同名 = 没有碰撞」——那是拿「没查」当「查过了」。

🔴 **不要为「同时命中多条」造组合枚举值**（`NotReachableAndFieldLevel` 之类）。
多重命中如实记在 `MatchedRules[]` 里，结论只有一个 `EffectiveRule` + 一个 `Classification`。

### 5.2 `templates/**/*.json` 的「新增 vs 修改」怎么判

`Classification: NewTemplateOnly` 只说明规则形态，**还没回答这次到底过不过得去**。必须再判 `ChangeKind`：

| `ChangeKind` | 到店结论 |
|---|---|
| `Added`（该路径在 `BaseHeadSha` 那棵可发布树里**不存在**） | 基线新增的模板 → **能到店**……🔴 **但仅限该店本地也没有这个文件时**。任何一个店里已存在同名模板，对那个店就是「不覆盖」 |
| `Modified` | **过不去**。各店已本地化的模板不被覆盖（报告明示） |
| `Deleted` | 🟠 **解释约定，报告没说** → 取 `Undetermined`，问用户。见下 |

🔴 **「基线是新增」不等于「每个店都会收到」。** 判定的是 **path × site**，不是 path：
基线侧的 `Added` 只排除了「基线自己已有」这一种情况，排除不了「某个店自己早就建过同名模板」。
**基线仓库里查不到各店有没有这个文件**——这是结构性的信息缺口，不是查得不够仔细。
所以 `ChangeKind: Added` 的模板，**逐店结论只有两个合法落点**：

1. **拿到逐店存在性确认**（运营/各店侧给出「这个店有没有这个文件」的答复，有出处）→ 按答复逐店判；
2. **拿不到** → `Undetermined`，`ReadyForImplement: No`。

🔴 **落地方案不能代替第 1 条。** 方案回答的是「到不了的话怎么补」，它证明不了「这个店到底有没有同名文件」——
那是一个**事实**，不是一个安排。允许用方案顶替，等于让 `Undetermined` 这个诚实出口（§4.1）
和 `handoff-schema.md` §3「任一 `Undetermined` → `ReadyForImplement: No`」被一份写得很齐整的文档绕过去。

唯一的例外写法：方案里**明确包含「先逐店核验存在性、再执行」这一步**，并把核验结果的回填点写清楚。
此时它仍是 `Undetermined`（事实还没拿到），只是 `BlockingGaps` 里指明了拿到它的路径 ——
**不得**因为「方案里提到会去核验」就提前判成 `Passed`。

🟠 **`Deleted` 是报告没有覆盖的形态，不要替它补一个结论。**
报告对 #15 的原话只说「**只同步基线新增的模板**，各店已本地化的不覆盖」——它回答了「新增」和「已有」，
**没有**回答「基线删掉一个模板时各店会不会跟着删」。
对照 #5 `locales/*.json` 那条原话是「只同步基线新增**/删除**的字段」——**删除在那里被明写了，在这里没有**。
两条规则措辞上的这个差别是实打实的，不能当成笔误抹平。

因此：`templates/**/*.json` 的 `ChangeKind: Deleted` 一律 `Undetermined`，`BlockingGaps` 写明需要向运营/平台侧确认
删除是否传播。**不要**按「大概和 locales 一样」或「大概不覆盖所以安全」自行取一边 ——
两个方向的错法各有代价：判成「传播」会让各店页面意外 404；判成「不传播」会让各店留下一个引用已删 section 的孤儿模板。

### 5.3 `locales/*.json` 必须细到 key

一个 locale 文件的一次改动通常同时含**新增 key**、**改已有 key 的 value**、**删 key** 三种。
路径级一个 `LocaleFieldLevel` 表达不了「哪些到得了店」，因此：

**`locales/*.json` 的每一条 `SyncReach` 项，必须逐 JSON key（点分全路径，如 `sections.hero.cta_label`）展开**，各自带 `ChangeKind`：

| key 的 `ChangeKind` | 到店结论 |
|---|---|
| `Added`（基线新增的 key） | **能到店** |
| `Deleted`（基线删掉的 key） | **能到店**（各店会跟着删） |
| `Modified`（改已存在 key 的 value） | **过不去**——各店已本地化的键值不被覆盖 |

🔴 **最容易踩的一脚**：「改一句英文文案」在 git diff 里只是一行，看起来无害，实际上 **17 个店一个都不会变**。
而这恰恰是 `plaud-theme-section-build` 与 `plaud-theme-ux-migration` 的日常动作。

🔴 **key 重命名** = `Deleted`(旧) + `Added`(新) 两条，且必须核对 Liquid 侧引用已同步改名；
否则各店会短暂拿到「新 key 有值、旧 key 已删、模板还引用旧 key」的组合。

### 5.3.1 🔴 覆盖等式（v0.4.0 收口，否则空/部分 `SyncReach` 可以伪装成全绿）

`SyncReach` 是**逐改动项**的，因此它与本次改动集合之间有一条**可机械核对的等式**，三个阶段都要核：

| 阶段 | 等式 |
|---|---|
| Assess（`plaud-theme-impact`） | `SyncReach` 里出现的**可发布路径集合** == 本次**计划写入集**的可发布路径集合 |
| 提测（`plaud-theme-qa-intake`） | `SyncReach` 的路径集合 == §4 `ModifiedFiles` 里的可发布路径集合 |
| 发版（`plaud-theme-release-ops`） | **`IncludedInThisPush: Yes` 的块**各自 `SyncReach` 的路径并集 == 那些块的声明路径并集 |

🔴 **发版那一行两侧都只取 `IncludedInThisPush: Yes` 的块**，`No` 块两侧都不参与——否则它会与 §2.14 打架：
`No` 块的改动本来就不该留在发布源树里（留了会被 `ReleaseDeclaredDiffCheck` 判 `DECLARED_DIFF_ORPHAN`），
把它的 `SyncReach` 算进左边，等式会恒不成立；只算进左边不算右边，则会把一个已被撤掉的块的到店结论
当成本次发布的一部分。两侧同源取 `Yes` 块，这条等式才与 `ReleaseDeclaredDiffCheck` 用的是同一个集合。

**少一条** = 有路径没判过（而不是判成了 `Reachable`）→ `Incomplete` / `Blocked`，不是 `Passed`。
**多一条** = 判了本次没改的东西，说明拿的是上一轮的 `SyncReach` → 同样阻断。

两条附加的完整性要求，同样机械可核：

- `locales/*.json` 的每一条路径，其展开的 key 集合必须**覆盖该文件本次全部变更的 key**（§5.3）。
  只列了新增 key、没列被改值的 key，等于把「过不去的那一半」整个藏起来。
- 重命名必须是 **`Deleted`(旧) + `Added`(新) 两条**（§3）。只有一条即视为未覆盖。

> 🔴 **为什么这条必须写成等式而不是"逐路径处理"**：没有等式时，交一份**空的**或只含可达路径的 `SyncReach`，
> 下游看到的就是「所有项都 `Reachable`」→ `SyncReachStatus: NotApplicable` → `SyncReachCheck: Passed`。
> 三道门全绿，而真正会出事的那些路径**从来没有出现在任何一份工件里**。
> 这是本文件全部机制里最容易被绕过去的一处，因为绕过它不需要说任何一句假话，只需要少写几行。

### 5.4 零命中也要留证据

本次改动一条保护规则都没命中时，`SyncReach` 仍要逐路径列出并全部标 `Reachable`，
`MatchedRules: []`，`Evidence` 写明比对过 §2 全部 15 条。
**不得**用一句「本次不涉及受保护路径」代替——那句话与「没查过」不可区分。

---

## 6. 命中保护清单的路径不得走 `InlineLite`

`InlineLite`（handoff-schema §3）允许实现 skill 内联完成评估、跳过 Assess。
🔴 **本次改动只要有任一路径命中 §2 的 15 条（例外除外），一律不得走 `InlineLite`，必须过 `plaud-theme-impact`。**
理由：`InlineLite` 的豁免条件全是「这个文件没有别的引用方」这一类**仓库内**判据，
而到店与否是**仓库外**的分发事实，仓库内怎么查都查不出来。

---

## 7. 站点自研代码

### 7.1 它是什么、它意味着什么

各店在基线之外自己写的 `.liquid` / `.js` / `.css`。同步引擎对它们**结构性避让、永不碰**。

它**不是**「另一批受保护的文件」，两者的风险方向相反，别混：

| | 保护清单 | 站点自研代码 |
|---|---|---|
| 基线里 | 有 | **没有** |
| 风险 | 你改了，各店**收不到** | 你在基线做的改动，与它**在同一渲染路径上冲突**，而你在基线仓库里**看不见它** |

具体会怎么出事：

- 基线新建一个 `sections/us-form-contact-sales-2.liquid` → LATAM / US 已经各有一个**同名**自研文件。
  引擎避让 = 那两个店永远用它们自己的版本，基线版永远不生效，而基线侧的 QA 一切正常。
- 基线改了某个共享 snippet / 全局 CSS / token → TW 的 13 个自研文件（10 个 `ai_gen_block_*` + 2 个 section + 1 个 SDK snippet）
  可能正依赖旧值。它们**不在** `plaud-theme-impact` 的依赖树里，因为依赖树只扫基线仓库。
- 基线删除或重命名一个 snippet → 某店的自研文件仍在 `render` 它 → 只有那个店 500。

🔴 **所以 `AssessmentRef` 的 `TheoreticalReferences` / `ActualAffectedInstances` 在多店场景下是有系统性下界偏差的**：
它们只覆盖基线仓库。有自研代码的店（§7.2 清单里非空的那几个），实际影响面 **≥** 评估值。
这一点必须写进 `SharedPropagation` 的说明文字，**不得**默认「基线里没引用 = 没人用」。

### 7.2 清单在项目侧，不在包里

per-site 清单是**项目运行时状态**（会随各店演进变化），与 `memory/模板清单.md` / `memory/模块清单.md` 同类。

| | 位置 |
|---|---|
| 运行时事实源 | 项目侧 **`memory/站点自研代码清单.md`** |
| 缺失时的初始化种子 | `plaud-theme-shared/references/memory-seed/site-custom-code-inventory.seed.md`（快照 **2026-09-03**） |
| 缺失时的规则 | 与其它 memory 文件同一条：**默认停机**，仅当用户明确确认「首次接入」后才可从种子复制（shared SKILL.md「缺失时的唯一初始化规则」） |

🔴 **种子是 2026-09-03 的一次性快照，会过时。** 判定时读的必须是项目侧那份、且必须核它的 `AsOf`：
`AsOf` 早于本次改动所依赖的事实（如「这个店有没有同名文件」）时 → `Undetermined`，要求重新导出，
**不要拿一份旧快照当现状**。种子文件本身**永远不是**运行时事实源。

---

## 8. 与 §8.1 #8「三层入口」的冲突消解

handoff-schema §8.1 第 8 条要求：**优先改模板存值，其次 schema，最后模块代码**。

🔴 **在多店基线场景下，这个顺序的第一档正好是同步过不去的那一档**：
「模板存值」= `templates/**/*.json`（#15，`NewTemplateOnly`）与 `config/*.json`（#4，`NotReachable`）。
照原顺序做，改动完成、验收通过、推站成功，**而 17 个店的页面一个都没变**。

**新的排序（两级，不是在原顺序上加一句注）**：

```
第一级：先按「能不能到目标店」筛掉不可达入口
第二级：在剩下的可达入口里，才按 模板存值 → schema → 模块代码 排序
```

- 三层入口里**没有**任何一个可达时 → **停机**，交给运营决定走「逐店手工落地」还是改需求，
  **不得**自行选一个不可达入口做完然后宣布交付。
- 选了较低一层（schema / 模块代码）**只是因为上层不可达**时，`OptionsConsidered`（§4）里写明并引用本文件 §5 的判定，
  这构成 #8 `EvidenceBased` 的完整论证，**不需要**额外审批。
- 反过来：明明模板存值可达（例如该模板是本次基线**新增**、且各店都没有同名文件）却跳到模块代码，
  #8 照旧适用，仍要论证。

---

## 9. 三个接入点（本文件不重复定义字段，只索引）

| 阶段 | skill | 字段 | 语义 |
|---|---|---|---|
| Assess | `plaud-theme-impact` | `SyncReach`（§3） | **事实**：逐改动项的规则命中与分类。不推断站点清单 |
| 提测准入 | `plaud-theme-qa-intake` | `SyncReachStatus`（§9.1.2） | **材料完整性**：每条**需要方案**的项（判据 §4.2，不是「非 `Reachable`」）有没有逐店落地方案 + 出处 |
| 发版 | `plaud-theme-release-ops` | `SyncReachCheck`（§9.1.4） | **推站前重判**：用本次实际 `TargetSites` 与当前快照再判一次 |

字段的规范定义只在 `handoff-schema.md`，本表只做索引。

---

## 10. 数据时效

> 🔴 §2 的 15 条规则、§2.1 的例外、§7 的站点清单，全部来自 **2026-09-03 11:18:01** 导出的
> 《PLAUD DTC 保护与站点自研代码报告》，**是快照，不是实时读数**。
>
> 各店 `develop` 分支当时的版本是 **2.9.1.3**；报告自己声明「若某站标 develop 落后基线 = 本轮未 sync，其数据可能过时」。
>
> **规则表变了（增删保护规则、改例外）→ 必须切新版本快照**（`version-manifest.md` §1.1 的同一条规则：
> 只改包外文档不算数，四端读到的只有包内文本）。
> **站点清单变了 → 更新项目侧 `memory/站点自研代码清单.md`，不动本包。**
>
> 判定时如果本文件的日期距今已久、而结论又是分水岭级的，取 `Undetermined` 并要求重新导出，不要凭旧快照放行。
