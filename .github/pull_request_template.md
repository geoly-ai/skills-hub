<!--
06-submission.md §8「人工门：审什么」。

🔴 这份清单**不是安全保证**（§8 末尾的原话，见 07-threat-model.md §4）。
   它是给审的人用的备忘录，不是一份做完就能签字的表格。
-->

## 这次投稿是什么

<!-- 一两句话：做什么用的、给谁用的。 -->

## 声明

- [ ] 我读过 `docs/m0/01-artifacts.md` 的布局与命名规则
- [ ] `skill.json` / `pack.json` 里声明的 capability 与正文一致
- [ ] 载荷里没有我不打算让人看见的东西

---

<!-- ─────────────  以下由**维护者**填  ───────────── -->

## 审查清单（§8）

自动门只能证明结构对。以下八条要**人读** `SKILL.md` 与 `references/`：

- [ ] 1. 没有指示 agent 读环境变量 / 凭据 / `~/.ssh` / `~/.aws` / 浏览器 profile
- [ ] 2. 没有把数据发到外部（URL、webhook、邮件、剪贴板）
- [ ] 3. 没有试图覆盖或忽略系统指令 / 其他 skill 的约束
- [ ] 4. `description` 不会抢已有 skill 的路由
- [ ] 5. 没有 Unicode 混淆、零宽字符、双向控制符、同形字
      <br>🔴 **这一条不要靠肉眼** —— `scan-text.mjs` 已经在 CI 里跑：
      bidi 与零宽**直接拒**，同形字出现在 PR 注解里。**看注解，不要盯屏幕。**
- [ ] 6. 没有间接指令（引用外部文档，「按那里说的做」）
- [ ] 7. capability 声明与正文一致
      <br>⚠️ 声明不实视为**恶意投稿**，namespace 进观察名单（§7）
- [ ] 8. license 与 provenance 可信

### Tier（§7）

- [ ] `none` → **Tier 0**：一名维护者 approve
- [ ] `network` / `external-tool` → **Tier 1**：一名 approve + **逐条回答**外部依赖
- [ ] `shell` / `credentials` / `writes-repo` → **Tier 2**：**两名**维护者 approve
- [ ] `contract_paths` 有变更 → 强制 **Tier 2**（D8）

pack 的 Tier = 成员 capability 并集对应的最高 Tier。

> 🔴 Tier 2 的第二名 approve 由 `build-inputs.mjs` 在 **promote 时**强制，
> 不是分支保护 —— 原因见 `docs/m3/00-branch-protection.md`。
> 少一名的后果是**产不出 promotion PR**，制品进不了 registry。
