// 图标：全部 inline SVG，`stroke: currentColor`。**不用 emoji，不用图标字体。**
// 规格：DESIGN.md §6。
//
// 🔴 **`x` 与 `fail` 必须是两个不同图形，`unverified` 是第三个。** 这不是审美偏好，
//    是 §0.1 那两条轴的可视化落点：
//      · `x`（裸叉）      = 生命周期轴的 `yanked` —— 维护者把它撤了；
//      · `fail`（圈叉）   = 验证轴的 `failed`   —— 我们验了，没过；
//      · `unverified`（虚线圈）= 验证轴的 `unverified` —— 我们**根本没验**。
//    三者共用一个形状的话，「被撤回」「验签失败」「还没验」在界面上就成了同一件事，
//    而它们的处置完全不同。

export function IconSprite() {
  return (
    <svg style={{ display: 'none' }} aria-hidden="true">
      <symbol id="i-check" viewBox="0 0 16 16">
        <path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 16 16">
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" strokeWidth="2" />
      </symbol>
      <symbol id="i-bang" viewBox="0 0 16 16">
        <path d="M8 2v7.5M8 12.2v1.6" fill="none" stroke="currentColor" strokeWidth="2" />
      </symbol>
      <symbol id="i-block" viewBox="0 0 16 16">
        <rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M2.6 10.6L10.6 2.6M5.4 13.4L13.4 5.4" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="i-fail" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.6" />
      </symbol>
      <symbol id="i-unverified" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 2.2" />
      </symbol>
      {/*
        🔴 **第三套图形：本地比对轴。**（Codex 2026-09-01 P1）
        「工作树载荷重新打包出的 tree_digest 与 record 里那个相等」既不是生命周期，
        也不是验证链 —— 它是**本地拿两串字节比了一下**。早先它借用了 check / fail /
        unverified，于是页面顶部四格全是「未验证」、下面却出现一个勾，
        第一眼读成"验证通过了"。
        所以给它两个**只表达"两者相同 / 不同"**的图形：等号与带斜杠的等号。
        它们不含任何"通过 / 失败"的意味 —— 相等本身不构成担保。
      */}
      <symbol id="i-equal" viewBox="0 0 16 16">
        <path d="M3 6.2h10M3 9.8h10" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </symbol>
      <symbol id="i-unequal" viewBox="0 0 16 16">
        <path d="M3 6.2h10M3 9.8h10" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M10.8 2.6L5.2 13.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </symbol>
      <symbol id="i-nodata" viewBox="0 0 16 16">
        <path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.4 2.4" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 16 16">
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.4 10.4L14 14" stroke="currentColor" strokeWidth="1.6" />
      </symbol>
    </svg>
  );
}

/** 图标本身不承载语义，语义由旁边的词给 —— 所以一律 aria-hidden。 */
export function Icon({ name }) {
  return <svg aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}
