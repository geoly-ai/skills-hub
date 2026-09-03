// 图标：全部 inline SVG，16×16 viewBox，`stroke: currentColor`。
// **不用 emoji，不用图标字体。** 规格：DESIGN.md §7。
//
// 🔴 **形状族 = 轴，族内形态 = 取值。** 这不是审美偏好，是三条轴的可视化落点：
//
//   · **方族 `l-*`** = A 生命周期（快照 record 的 `status`，维护者的处置）。
//     用**填充度**表达档位。🔴 全族**没有勾** —— 所以 `published` 不会被读成「验过了」。
//   · **圆族 `v-*`** = B 验证（我们这一次到底验没验、验过没过）。
//     🔴 **全站唯一的勾在这里，而且被圆圈住** —— 界面上任何一个勾都只可能是
//     「我们这一次验过了」，不可能是别的意思。
//   · **等号族 `c-*`** = C 本地比对（本机拿两串字节比了一下）。
//     🔴 **没有外框** —— 相不相同既不是处置，也不是判断。
//
// 🔴 **三条轴一律不使用感叹号图形。** 上一版 `deprecated` 与 `stale` 共用一个 `i-bang`，
//    于是「维护者不推荐了」和「我们的验证结论有保留」在界面上成了同一件事。
//    这一版 `deprecated` 用半填充方、`stale` 用圈内钟。
//    中性图标 `u-note` 仍是三角感叹，但它**不属于任何一条轴**，只用于「这是一句提示」。

export function IconSprite() {
  return (
    <svg style={{ display: 'none' }} aria-hidden="true">
      {/* ── A 生命周期：方族。填充度表达处置。全族没有勾。 ── */}
      <symbol id="l-published" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" />
      </symbol>
      <symbol id="l-deprecated" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 3.3h4.2a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1H8z" fill="currentColor" />
      </symbol>
      <symbol id="l-yanked" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M1.4 14.6L14.6 1.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </symbol>
      <symbol id="l-degraded" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.4 9.6L9.6 3.4M6.4 12.6L12.6 6.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>

      {/* ── B 验证：圆族。🔴 全站唯一的勾在这里，且被圆圈住。 ── */}
      <symbol id="v-verified" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M4.9 8.2l2.2 2.2 4-4.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      </symbol>
      <symbol id="v-stale" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.4V8l2.7 1.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </symbol>
      <symbol id="v-failed" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </symbol>
      <symbol id="v-unverified" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.3" />
      </symbol>

      {/* ── C 本地比对：等号族。无外框 —— 它既不是处置，也不是担保。 ── */}
      <symbol id="c-equal" viewBox="0 0 16 16">
        <path d="M2.6 6.1h10.8M2.6 9.9h10.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      </symbol>
      <symbol id="c-unequal" viewBox="0 0 16 16">
        <path d="M2.6 6.1h10.8M2.6 9.9h10.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M10.9 2.2L5.1 13.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      </symbol>
      <symbol id="c-nodata" viewBox="0 0 16 16">
        <path d="M2.6 8h10.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray="2.2 2.3" />
      </symbol>

      {/* ── 中性：不属于任何一条轴，因此可以在别处自由使用。 ── */}
      <symbol id="u-note" viewBox="0 0 16 16">
        <path d="M8 1.6l6.2 12.8H1.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 6.6v3.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="12" r=".9" fill="currentColor" />
      </symbol>
      <symbol id="u-search" viewBox="0 0 16 16">
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.4 10.4L14 14" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </symbol>
    </svg>
  );
}

/**
 * 图标本身不承载语义，语义由旁边的词给 —— 所以一律 `aria-hidden`。
 * `name` 必须带族前缀（`l-` / `v-` / `c-` / `u-`），调用点因此一眼看得出它属于哪条轴。
 */
export function Icon({ name }) {
  return <svg className="ic" aria-hidden="true"><use href={`#${name}`} /></svg>;
}
