# 埋点面板

零依赖静态页。**不发任何网络请求**，聚合全在浏览器里算。

## 看自己的数据

```sh
skills-hub stats --export docs/dashboard/data.json
```

然后用任意静态服务器打开（`python3 -m http.server --directory docs/dashboard`），
或者直接双击 `index.html` 再把导出的 JSON 拖进去（`file://` 下 fetch 会被 CORS 拦，
所以自动读取只在 http 下生效，拖拽任何时候都能用）。

`data.json` 已被 gitignore —— **不要把自己的埋点数据提交上来**。
仓库里的 `data.sample.json` 是**造的示例数据**，页面会把它标成橙色以示区分。

## 数字对不上？

页面把聚合逻辑重写了一遍（它不能 import ESM 模块）。
`test/dashboard-parity.test.mjs` 会断言它与 `src/stats.mjs` 逐字节一致，两边漂移就会红。
