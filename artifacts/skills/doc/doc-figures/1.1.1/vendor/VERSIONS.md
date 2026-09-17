# doc-figures vendor（decisions ⑤A：固定版本、离线可用）

放置日期：2026-09-15（阶段 0）。获取方式：`npm pack <包>@<版本>`（只下载 tarball，不装进任何 node_modules，不改全局环境），解包后只拷下表文件。升级：换版本重新 npm pack，更新本表所有哈希，并重跑 doc-figures 自测（1c 建）。

| 包 | 版本 | tarball | npm integrity | tarball sha256 |
|---|---|---|---|---|
| mermaid | 11.17.2 | https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz | sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg== | 6ad2f42c3fc26bbf9e45cbb6d11898972573ea52b33a5f4ff51952899f950ffd |
| @hpcc-js/wasm-graphviz | 1.29.1 | https://registry.npmjs.org/@hpcc-js/wasm-graphviz/-/wasm-graphviz-1.29.1.tgz | sha512-koAQL0wlryEMeBs4/cQC3GB5ziITv66gR9DU/SWYjjup+iQ+Nbjcqxeaef+sffN4F4cBYZ3P31B5z7+cbSABbw== | 02c0f29c05cf583e783e03afcbc305b90926ec33b8ca859079081dcf6f7f6c89 |

## 文件

| 文件 | 来源（tarball 内路径） | 字节 | sha256 |
|---|---|---|---|
| ~~mermaid-11.17.2/mermaid.min.js~~（2026-09-16 起不随 skill 分发，改运行时拉取到缓存，见下节） | package/dist/mermaid.min.js | 3572661 | 581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8 |
| mermaid-11.17.2/LICENSE | package/LICENSE | — | ec9fb67dcb25eccc416ed56e1aab819222c805a2a4bfe4cb19e7556bf2ffde80 |
| wasm-graphviz-1.29.1/index.js | package/dist/index.js（ESM，WASM 以内嵌方式打包，无外部 .wasm 文件） | 819284 | b541d7de92d53b2d86f01e4c5fecadb61ee071ad889309171ce9b9383d6cafb6 |
| wasm-graphviz-1.29.1/package.json | package/package.json（保留 "type": "module"，让 node 按 ESM 加载 index.js） | — | 4a9975ca213bb66dbaefd3bea7b479374fd838671af793f97270284de3e68d31 |
| wasm-graphviz-1.29.1/LICENSE | package/LICENSE | — | 1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6 |

未拷：source map（mermaid.min.js.map 13 MB）、ESM 分包、types/、src/。

## 已做的最小验证（事实）

- wasm-graphviz：node v25.2.0 直接 `import { Graphviz } from ".../wasm-graphviz-1.29.1/index.js"`，离线 `Graphviz.load()` 后 `dot('digraph { 需求 -> 设计 -> 实现 }')` 输出含 `<svg`，不含 clipPath / mask / foreignObject；`version()` 返回 16.1.0（内嵌 Graphviz 版本）。
- mermaid.min.js：Google Chrome 152.0.7977.83 headless 直接加载本 vendored 文件（file://，无网络依赖），mermaid.initialize({theme: base, htmlLabels: false}) 后 mermaid.render：
  - `xychart-beta`（title、x-axis 分类、y-axis 范围、bar + line 组合，中文标题）渲染成功：SVG 7266 字节，含 rect、path、15 个 text，无 foreignObject。
  - 不带 -beta 的 `xychart` 写法同样成功（6960 字节）。两种写法都可用；类型包模板沿用 xychart-beta（test-report 缺陷趋势图）即可。
  - mermaid.version 在 min 构建里读不到（返回 unknown），版本以 tarball 为准。
  - 时序、状态、甘特、ER 四类本次未重测（assessment §6 已用同版本验证过）；飞书画板端 xychart 能否解析未验证。

## mermaid.min.js：运行时拉取 + 缓存（2026-09-16）

该文件 3.4 MB，超出分发渠道单文件 2 MiB 上限，已从本目录删除（同目录 LICENSE 保留）。
`scripts/mermaid.py` 的 `mermaid_js()` 在首次渲染 Mermaid 时按上表的 tarball 地址拉取，
**先校验 tarball sha256，再校验取出的 mermaid.min.js sha256**（上两表的值即校验基准），
只按名取 `package/dist/mermaid.min.js` 与 `package/LICENSE`，不做 extractall；
原子写入 `${XDG_CACHE_HOME:-~/.cache}/doc-figures/mermaid-11.17.2/`，之后离线复用。

- 预拉取：`python3 ../scripts/mermaid.py --ensure-js`
- 覆盖成本地文件（离线 / 测试）：`DOC_FIGURES_MERMAID_JS=<路径>`
- 改缓存目录：`DOC_FIGURES_CACHE_DIR=<目录>`

**升级 mermaid 版本时**：改 `scripts/mermaid.py` 里的 `MERMAID_VERSION` / `MERMAID_TARBALL_URL` /
`MERMAID_TARBALL_SHA256` / `MERMAID_JS_SHA256` / `MERMAID_JS_BYTES`，同步更新本表，再重跑 doc-figures 自测。

## 校验命令

```sh
cd <doc-figures>/vendor && shasum -a 256 wasm-graphviz-1.29.1/index.js
shasum -a 256 "$(python3 <doc-figures>/scripts/mermaid.py --cache-path)"
```
