# 被门拒了怎么改

下面每一条都**真的发生过**，不是假想。

## `[E_PATH_LEADING] segment 以 . 开头：".DS_Store"`

macOS 的目录元数据混进了源仓库。删掉，并给**源仓库**加 `.gitignore` ——
否则每次发版都要重清一遍。

## `空目录不可表示，制品禁止空目录`

常见于删掉 `.DS_Store` 之后目录就空了。删掉那个目录。

空目录不会进树摘要、也不会进归档 —— 静默丢掉会让**制品与源目录不是同一棵树**，
而整条信任链建立在「快照能被字节一致地复算出来」上。

## `[E_PATH_CHARSET] segment 不是 ASCII-only`

文件名有中文 / emoji。**必须改成 ASCII。**

🔴 不是洁癖：**macOS 把非 ASCII 文件名存成 NFD、Linux 存成 NFC**，同一个文件
在两台机器上算出的**树摘要不一样** —— 直接打断确定性复算。

📌 改名时**同时写清对应关系**（比如在 README 加一张映射表）。只改名不说明就是
纯损失 —— 那些名字往往是有意义的。

## `有 U+200B / U+FEFF / bidi 控制符`

正文里有零宽字符或双向文本控制符。**拒绝**，因为它们能让
**人读到的与 agent 读到的不是同一段文字**。

⚠️ 合法用法也会被拒：文档里一段正则要匹配 NBSP/ZWSP/BOM，字面量写在了正则里。
改成 `\u00A0|\u200B|\uFEFF` 转义写法 —— 语义完全一致，而且**读的人才看得见
它匹配什么**。正则里放字面不可见字符本来就是坏写法。

📌 告警（不是拒绝）的那类：`①②③`、`z²` —— NFKC 折叠后会变形，但是正常排版。
门把这两类分开，看到「待人确认」不用改。

## `[E_FRONTMATTER] 只支持单行 key: value`

用了 YAML 折叠标量 `>` 或 `|`。折成单行 ——
`>` 的语义就是「换行折成空格」，折叠**不改变解析后的值**。

⚠️ 动手前确认块里**没有空行**：空行在 `>` 里表示一个真换行，单行形式表达不了，
那种情况需要引号包裹。

## `[E_MANIFEST_BINDING] frontmatter 的 name 是 X，应为 Y`

`SKILL.md` frontmatter 里的 `name` 必须等于**目录名里的那个 name**。

## `namespace X 尚未注册，必须在 PROMOTION.json 里给出 claim_owner`

首次使用一个 namespace 要声明归属：

```json
{
  "schema": "geoly.skills.promotion-file/1",
  "claim_owner": { "kind": "org", "login": "your-org" }
}
```

⚠️ **只写「只有你知道的事」**。`owner.id` / `author_github_id` /
`submitted_by_pr` 由 promote 填 —— 投稿者写了会被**拒绝**，不是被覆盖。
（skill 的 `provenance` 在 `skill.json` 里，**不要**在这里重复声明。）

## `Tier 2 需要 2 名维护者 approve`

载荷里有可执行迹象，或 capability 声明了 `shell` / `credentials` / `writes-repo`。
需要两名**不同的**维护者 approve。

## promote 那边报 `submissions/ 的内容与本次 PR 带来的那几个对不上`

盘上有**上一次 promote 没跑完留下的积压**。一起搬走的话，积压那批会被错误标成
「本次 PR 审过的」，而复算门抓不到（它只比「快照 ↔ 树」，两边都写错仍然自洽）。

解法：先把积压那几个**单独** promote 掉。
