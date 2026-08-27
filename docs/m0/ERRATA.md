# M0 勘误

> **M0 正文（`00-decisions.md` … `11-wire-contract.md`）已于 v45 封版，一个字都不改。**
> 实现过程中发现的规格问题记在这里。**冲突时以本文为准。**
>
> 为什么不解封出 v46：「已通过评审的 v45」是一个可信的基准点，
> 解封一次，之后每次改都要重新论证封版。勘误单独成文的代价只是多读一份。
>
> 每条都要写：**在哪发现的**、**为什么原文不够**、**改成什么**。
> 只写「原文有误」的条目会在下一轮被人当成笔误改回去。

---

## E-1 · `05-lifecycle.md` §6 —— provenance 示例漏了必填字段

**原文**：§6.1 规定 `provenance` 的 `added_files` 为必填，但 §6 的 vendored 示例里没有这个字段。

**为什么不够**：照示例实现的解析器会漏掉必填校验；照 §6.1 实现的会拒掉示例。两者必有一个错。

**以此为准**：`added_files` **必填**。示例是错的。实现按 §6.1。

---

## E-2 · `02-registry.md` §1.1 —— `workflowRef` 与 `sourceCommit` 的关系没写明

**原文**：给了一个 `workflowRef` 里固定 SHA 与 `sourceCommit` 相等的示例，但没有把这条写成规则。

**为什么不够**：不写死的话，attestation 可以声称由 A 提交构建、而 workflow 固定在 B 提交——
签名照样有效，但「这个制品是由哪份 workflow 从哪份源码构建的」就断链了。

**以此为准**：`workflowRef` 里固定的 40 位 SHA **必须等于** `sourceCommit`。不等即拒。

---

## E-3 · `01-artifacts.md` §4.3 —— 「存在一个合法 ustar 切分」不够

**原文**：要求路径「存在一个合法的 `name`/`prefix` 切分」。

**为什么不够**：**「存在」不足以定义字节。** 同一条路径可以有多种合法切分，
每种产出的 header 字节不同，而 `asset.sha256` 绑的正是字节。
于是同一个逻辑制品可以有多个都「合法」但摘要不同的编码——摘要就不再是身份。

**以此为准**：切分必须**唯一且规范**——取**最长的合法 `prefix`**。
实现见 `src/untar.mjs`，并有测试断言多种切分中只接受规范的那个。

---

## E-4 · `01-artifacts.md` —— `min_cli_version` 没定义预发布版本的比较

**原文**：只说按 semver 比较，没说 `1.0.0-rc.1` 与 `1.0.0` 谁大。

**以此为准**：标准 SemVer 优先级——预发布版本**低于**同数字的正式版本，
预发布标识按点分段逐段比较（数字段按数值、其余按 ASCII，数字段小于非数字段）。

---

## E-5 · `01-artifacts.md` §6.2 —— 归档的尾部块数没有定义

**发现于**：实现受限 tar 解析器时，必须决定「读到几个零块算结束」。

**为什么不够**：不定义就没法判「尾部多出来的字节」是合法填充还是夹带。
但定得太紧会拒掉真实工具的产出。

**实测（2026-08-26，本机）**：

| 打包方式 | 尾部连续零块 | 备注 |
|---|---|---|
| `bsdtar 3.5.3`（macOS 系统 tar） | **恰好 2 块** | 与「恰好两块」兼容 |
| GNU tar | 补到 10240 字节（20 块） | ⚠️ 会被「恰好两块」全量拒收 |

**以此为准**：**恰好两个零块**，尾部不接受任何额外填充。

理由：制品由**我们自己的 packer**产出（M2），可以保证规范形式；
外部投稿（M3）走 `skills-hub pack`，不走用户的系统 tar。
把编码定死成唯一形式，摘要才等于身份（同 E-3 的理由）。

🔴 **推论：packer 必须自己写字节，不得 shell out 到系统 `tar`。** 见 E-6。

---

## E-6 · 🔴 macOS 的系统 tar 会注入 AppleDouble 条目

**发现于**：为 E-5 做实测时。

**实测**：同一份输入，`tar -cf` 产出 4096 字节，加 `COPYFILE_DISABLE=1` 后只有 3072 字节。
多出来的是 macOS 为携带 xattr 而注入的 **AppleDouble（`._*`）成员**，
而且 `tar -tvf` **不会把它列出来**——肉眼看归档内容是「只有一个文件」。

**为什么要紧**：`01-artifacts.md` §5 明确拒绝 xattr。也就是说，
**在 macOS 上用系统 tar 打的包，会被我们自己的校验器拒掉**，
而打包的人从 `tar -tvf` 看不出任何异常，只会觉得校验器有 bug。

**以此为准**：
- packer 自己写 tar 字节，**不 shell out**（同 E-5 的推论）；
- 解析器遇到 `._` 开头的成员，要报**专门的违规码**并说明这是 macOS xattr 注入、
  提示 `COPYFILE_DISABLE=1`——报「未知成员」帮不到人。

⚠️ 一般化的教训：**「工具列出来的内容」不等于「文件里的字节」。**
校验必须针对字节，诊断信息也要针对字节。

---

## E-7 · 🔴 npm 包名改为 `@geoly-ai/skills-hub`

**M0 正文里写的**：`@geoly/skills-hub`（`00-decisions.md` 决策 ③A、`09-cli.md` §开头、
`03-packs.md` §150 的 `npx` 示例、`07-threat-model.md` §94、`08-matrix-migration.md` §92）。

**为什么错**：决策 ③A 拍板时**没有核实 org 实际叫什么**。实测（2026-08-27）：

| 名字 | registry 状态 |
|---|---|
| `@geoly-ai/social-hub-cli` | **200** —— 这个 org 真实存在且在用 |
| `@geoly/skills-hub` | 404 |
| `@geoly-ai/skills-hub` | 404（可用） |

GitHub org 是 `geoly-ai`，npm org 是 `@geoly-ai`，本机 `~/.config/geoly/npm-publish.env`
里的发布 token 也是给 `@geoly-ai` 配的。`@geoly` 这个 scope 我们未必拥有。

**以此为准**：包名是 **`@geoly-ai/skills-hub`**，bin 仍是 `skills-hub`。
M0 正文里出现的 `@geoly/skills-hub` 一律按此读。

⚠️ **这条必须在首次 `npm publish` 之前落实。** 发布之后改名只能 deprecate 旧名，
旧名会永远留在 registry 上，而且 `npx @geoly/skills-hub` 这类文档链接会指向一个空壳。

⚠️ 一般化的教训：**「我们叫什么」这种事，拍板时要去外部系统核实一次，不能凭记忆。**
这条错在规格里躺了 45 个版本没被发现，因为整个 M0 阶段没有任何一步需要真的去连 registry。

---

## E-8 · 🔴 `origin_tree_digest` 必须带 `geoly-tree-v1:` 前缀

**规格自相矛盾**：

| 出处 | 写的形式 |
|---|---|
| `01-artifacts.md` / `02-registry.md` / `03-packs.md` / `04-install.md` 里的 `tree_digest` | `geoly-tree-v1:sha256:…` |
| `treeDigest()` 的实际返回值 | `geoly-tree-v1:sha256:…` |
| **`05-lifecycle.md:118` 的 `origin_tree_digest` 示例** | **`sha256:…`（裸）** |

实现跟了错的那一边：`src/snapshot.mjs` 对该字段用 `assertAssetDigest`，只接受 `sha256:<64hex>`。

**为什么前缀不能省**：系统里有**两种**树摘要算法 ——
`geoly-tree-v1`（只算文件）与 `geoly-tx-v1`（还算目录项，含根与空目录）。
裸 `sha256:` **分不出是哪一种**。而 `origin_tree_digest` 的用途正是拿去与
`treeDigest()` 的输出比对（`05-lifecycle.md` §6.1 的 CI 门），
两边形式不同就只能靠静默截前缀 —— 那正是 E-3 要消灭的「一个逻辑值多种写法」。

**以此为准**：`origin_tree_digest` 的形式是 **`geoly-tree-v1:sha256:<64hex>`**。
`05-lifecycle.md:118` 的示例是错的（同 E-1：示例与规则矛盾时以规则为准）。
`src/snapshot.mjs` 改用树摘要校验器，不再用 `assertAssetDigest`。

🔴 **不做静默兼容**：不接受裸 `sha256:` 再补前缀。宽进严出在这里等于把歧义留在系统里。

⚠️ **这条卡住 matrix 导入**：不定死形式，`provenance.origin_tree_digest` 就写不出来
（`08-matrix-migration.md` §3.1 的双摘要是导入的必填项）。
