# 站点自研代码清单（种子）

> 🔴 **这是种子，不是运行时事实源。** 运行时事实源是项目侧 `memory/站点自研代码清单.md`。
> 只有在用户明确确认「首次接入、本项目没有历史状态」后，才可把本文件复制过去作为起点
> （规则见 `plaud-theme-shared/SKILL.md`「缺失时的唯一初始化规则」）。
> 复制过去之后**它就归项目维护**，不再随包更新；下次 install 覆盖的是包内这份种子，不是项目侧那份。

```yaml
AsOf: 2026-09-03
SourceDoc: PLAUD DTC 保护与站点自研代码报告
SourceExportedAt: 2026-09-03 11:18:01
SourceBranchPerSite: <站>/develop（sync 后最新组装态）
DevelopVersionAllSites: 2.9.1.3
SiteCount: 17
CustomFileCount: 20
```

🔴 **快照会过时。** 报告自己声明：若某站标「⚠ develop 落后基线」= 本轮未 sync、其数据可能过时。
判定依赖「某个店有没有某个文件」这类事实时，先核 `AsOf`；不够新就按 `sync-reach.md` §4.1 取 `Undetermined`，
要求重新导出，**不要拿旧快照当现状**。

---

## 逐站清单（canonical，17 站全列，不按区域汇总）

「自研代码」= 基线里**没有**、各店自己写的 `.liquid` / `.js` / `.css`，同步引擎结构性避让、永不碰。
「配置类原创」= PageFly / 模板 JSON / section-group JSON / 店铺配置 / 语言 / matycube 等，
与保护清单同理（`sync-reach.md` §2），报告只给汇总计数、不逐列——**计数不能当成文件清单用**。

| 站点 | 自研代码 | 配置类原创（计数，非清单） |
|---|---|---|
| **AU** | 无 | PageFly 56 · 模板 JSON 56 |
| **CA** | 无 | 模板 JSON 45 · PageFly 16 |
| **DE** | 无 | 模板 JSON 35 · PageFly 8 · section-group JSON 3 · 店铺配置 2 |
| **ES** | 无 | 模板 JSON 47 · PageFly 8 · section-group JSON 3 · 店铺配置 2 |
| **EU** | 无 | 模板 JSON 47 · PageFly 9 · section-group JSON 3 · 店铺配置 2 |
| **FR** | 无 | 模板 JSON 43 · PageFly 8 · section-group JSON 3 · 店铺配置 2 |
| **GLOBAL** | **1 个**（下表） | 模板 JSON 7 · 店铺配置 1 · section-group JSON 1 |
| **HK** | 无 | 模板 JSON 32 |
| **IT** | 无 | 模板 JSON 38 · PageFly 10 · section-group JSON 3 · 店铺配置 2 |
| **JP** | **2 个**（下表） | PageFly 84 · 模板 JSON 77 · 店铺配置 1 |
| **LATAM** | **2 个**（下表） | 模板 JSON 57 · PageFly 14 · 店铺配置 1 · 语言 1 · matycube 1 |
| **NL** | 无 | 模板 JSON 28 · PageFly 9 · section-group JSON 3 · 店铺配置 1 |
| **SEA** | 无 | 模板 JSON 110 · PageFly 24 · section-group JSON 6 · 店铺配置 4 · 语言 2 |
| **TW** | **13 个**（下表） | 模板 JSON 45 · PageFly 18 |
| **UAE** | 无 | 模板 JSON 31 · PageFly 24 |
| **UK** | 无 | 模板 JSON 47 · PageFly 11 · section-group JSON 3 · 店铺配置 2 |
| **US** | **2 个**（下表） | PageFly 124 · 模板 JSON 111 · 店铺配置 1 · matycube 1 |

> 🔴 **`GLOBAL` 是一个站点，不是「全部站点」。** 它在报告里与 AU / CA / JP 平级，有自己的 develop、
> 自己的模板计数、自己的 1 个自研文件。看到 `GLOBAL` 就理解成「全站生效」会把逐店判定整个搞错。

---

## 自研文件逐条（site → file，共 20 条）

| 站点 | 文件 |
|---|---|
| GLOBAL | `sections/voc-global-meeting-path-20260820.liquid` |
| JP | `snippets/omega_twitter_multi_pixel.liquid` |
| JP | `snippets/rewind_menu_backup_do_not_delete.liquid` |
| LATAM | `assets/affirmShopify.js` |
| LATAM | `sections/us-form-contact-sales-2.liquid` |
| TW | `blocks/ai_gen_block_1fa05f9.liquid` |
| TW | `blocks/ai_gen_block_27d2837.liquid` |
| TW | `blocks/ai_gen_block_372c232.liquid` |
| TW | `blocks/ai_gen_block_43b7d1b.liquid` |
| TW | `blocks/ai_gen_block_44789fb.liquid` |
| TW | `blocks/ai_gen_block_539bedc.liquid` |
| TW | `blocks/ai_gen_block_6e073b6.liquid` |
| TW | `blocks/ai_gen_block_87dabe4.liquid` |
| TW | `blocks/ai_gen_block_a3edcc1.liquid` |
| TW | `blocks/ai_gen_block_d9185ce.liquid` |
| TW | `sections/product-tab-kk.liquid` |
| TW | `sections/smile-landing-page.liquid` |
| TW | `snippets/visually_io_sdk.liquid` |
| US | `assets/affirmShopify.js` |
| US | `sections/us-form-contact-sales-2.liquid` |

### 两条同名碰撞（判定时必看）

`assets/affirmShopify.js` 与 `sections/us-form-contact-sales-2.liquid` **同时**存在于 **LATAM 与 US**。

🔴 基线一旦新增同名文件，这两个店**永远拿不到基线版**（引擎避让），而基线侧的一切检查都会正常通过。
新建 `sections/` / `assets/` 文件前，先对着本清单核一遍有没有重名——这是**免费**的一次 grep，
而漏掉的代价是两个店静默跑着另一份代码。

### 依赖方向也要看

TW 的 13 个自研文件（10 个 `ai_gen_block_*` + `product-tab-kk` + `smile-landing-page` + `visually_io_sdk`）
**不在基线仓库里**，因此**不会出现在 `plaud-theme-impact` 的依赖树/引用计数里**。
改共享 snippet / 全局 CSS / token / 删除或重命名 snippet 时，TW 的实际影响面 **≥** 评估值。
按 `sync-reach.md` §7.1 写进 `SharedPropagation`，不要默认「基线里没引用 = 没人用」。

---

## 项目侧该怎么维护这份文件

1. 每次重新导出报告 → 更新 `AsOf` / `SourceExportedAt` / 逐站表 / 逐条表，**整份替换**，不要逐行 patch
   （逐行 patch 会留下上一次快照的残行，而残行与新行在文本上不可区分）。
2. 站点增删 → 同步更新 `SiteCount`，并在 `plaud-theme-qa-intake` 的 `TargetSites` 取值范围里体现。
3. **不要**把它写回包里。包里那份是种子，运行时读项目侧这份（`sync-reach.md` §7.2）。
