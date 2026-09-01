// 渲染期的小格式化函数。

/**
 * 字节数：**精确值在前**，KiB 只做括注。
 *
 * 🔴 供应链界面里不该四舍五入。「47.1 KiB」读起来舒服，但它对不上任何一次
 *    `wc -c` 的输出；而这个站点的全部价值就是页面上的值能拿去和本地复算的值比对。
 */
export function formatBytes(n) {
  const exact = `${n.toLocaleString('en-US')} B`;
  if (n < 1024) return exact;
  return `${exact}（${(n / 1024).toFixed(1)} KiB）`;
}
