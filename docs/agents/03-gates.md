# 改这个仓库之前 —— 门的清单与教训

> 这个仓库里**大量代码是门（gate）而不是功能**。很多门看起来多余，
> 但每一条都对应一次真实的失败。
>
> 这份文档不是规格（规格在 `docs/m0/`），是**给要动这些代码的 agent 的警告清单**。

---

## 门在哪

| 阶段 | 文件 | 管什么 |
|---|---|---|
| PR 分流 | `scripts/submission/pr-classify.mjs` | promotion / maintainer / submission 三选一 + 路径白名单 |
| 投稿结构 | `scripts/submission/run-gates.mjs`、`structural-gates.mjs` | 目录形状、manifest 一致性、路径字符集、capability↔载荷 |
| 不可见字符 | `scripts/submission/scan-text.mjs` | bidi / 零宽 / 同形字 |
| 审批人数 | `scripts/submission/tier-gate.mjs`、`approval-policy.mjs` | Tier 决定要几个人 |
| promote 复核 | `scripts/promote/verify-merged-pr.mjs` | 合并后再验一次审批未失效 |
| 确定性复算 | `scripts/promote/verify-promotion.mjs` | 快照能不能被字节一致地重算出来 + 制品不可变 |
| 快照组装 | `scripts/build-snapshot.mjs` | 编号连续、latest、yank 继承 |
| workflow 自检 | `test/workflow-invariants.test.mjs` | workflow 里几条不该出现的东西 |

---

## 🔴 七条教训，全部来自真实事故

### ① 一道门必须检查**全部**输入，或者明说它不查什么

`scan-text` 早先有扩展名白名单，于是 `.sh` / `.py` 被跳过；后来 NUL 字节能让
整个文件被跳过（`NUL` + `U+202E` 放进 `.md` 就能关掉这道门）。

**判据里的"看起来是文本/看起来正常"，往往由被检查的东西自己控制。**

### ② 不要拿被测对象自己当证据

- 制品不可变门的证据必须来自**上一张快照**，不能来自本次的树
- 复算门比的是"快照 ↔ 树"，所以**两个一起改**仍然自洽 —— 门抓不到
- promote 里 `collect` 把首次注册写回 `registry/owners.json`，下一步 `build-inputs`
  读**同一个文件**，于是"已注册"是本次运行三行之前自己写的

**证据必须来自别处。**

### ③ 「有几处」不能靠读注释确认，要靠搜实现形状

作者排除的逻辑当时有**三处**（`tier-gate` / `verify-merged-pr` / `build-inputs`），
三份实现互不知道对方存在。而为此写的防分叉不变式**写死了两个文件名** ——
于是它证明的是"我知道的那两处没分叉"，不是"没有分叉"。

同样的形状第二次：`--present-paths` 设成必填后只接了 `validate-pr.yml`，
**漏了 `promote.yml` 这个第二调用点**。

📌 **不变式不要维护"已知清单"**，要全仓搜实现形状。

### ④ 只问「存不存在」的断言，会自己失效

`assert.match(body, /--diff-filter=d/)` 只查整个文件里有没有。
后来同一个文件里加了**第二处** `--diff-filter=d`，改坏一处、另一处还在,
断言就永远绿了 —— **而且不会有任何迹象**。

📌 断言要**钉在它真正关心的那一行**上（`only=$(git diff …--diff-filter=d`），
不是"文件里出现过"。

### ⑤ 白名单，不是黑名单

`promote.yml` 的 `on:` 块被要求**恰好**是三行。理由不是洁癖：
黑名单列不全（`repository_dispatch`、`issues`…），而且在既有 `push:` 下加一行
`tags: ['*']` 就能绕开 `paths` 过滤 —— **tag push 不受 paths filter 限制**。

### ⑥ 特权 workflow 不能执行不可信的代码

曾想给 `promote.yml` 加 `workflow_dispatch` 做重跑入口，两次都被否。
第二次连 checkout 也用同一个 sha，看起来"证据与内容同源"了，但仍不安全：

> 同一个 SHA 只修复了"证据和内容不是同一棵树"，没有修复
> **特权 workflow 执行了谁的代码**。

只有 Write、**不能合并**的协作者，推一个改了 `pr-classify.mjs` 的分支、开一张
**未合并**的 PR、dispatch 它的 SHA —— 流程会先执行那份脚本，**之后**才检查
`merged_at`。恶意代码在"PR 未合并"被发现之前就跑完了。

📌 正确形状是 `validate-pr.yml` 已经在用的那个：**`base-tools/`（可信代码）
× `pr/`（不可信数据）** —— 只执行 base 那棵树里的脚本。

### ⑦ 静默的放行和坏掉的门，事后看起来一模一样

所以：**豁免必须出声**。审批豁免生效时两处都往 stderr 打一行，并写明
"只跳过审批人数 —— 别的门都跑过了"，否则读日志的人会以为这条投稿什么都没检查。

---

## 改门之前的自查

1. **这道门当初是为了挡什么？** 答不上来就别改。
2. **我的改动会不会让它在更小的集合上判定？**（少一个输入、少一个调用点、
   少一个文件）
3. **有没有第二处实现？** 搜实现形状，别搜注释。
4. **改完之后，变异自检还抓得到对应的改坏吗？**

`test/workflow-invariants.test.mjs` 末尾有一轮**变异自检**：把 workflow 复制到
临时目录、改坏一处、再把测试当子进程跑一遍，断言必须红，**而且必须是你指定的
那一条断言红**。加门就加一条变异 —— 否则"看起来被守住了"。

---

## 跑测试

```sh
npm run check:all                    # node 版本矩阵 / 签名身份 / pack 内容
node --test test/*.test.mjs          # 全量
node --test --test-reporter=spec test/<某个>.test.mjs
```

⚠️ **子进程的 reporter 必须钉死**（`--test-reporter=spec`）：`node --test` 的默认
reporter 随 **Node 版本**与**是不是 TTY** 变，实测同一份代码 Node 24 绿、Node 22 红。

## 提交约定

- commit 信息用 **heredoc**，别用双引号 —— 里面的反引号会被 shell 当命令替换执行
- `git push` **不要加 `2>/dev/null`** —— 会把"推送被拒绝"一起吞掉，
  然后你会在一个错误的前提上继续操作好几步
- 子代理**不 commit / 不 push**，交给主代理验收
