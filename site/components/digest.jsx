// 摘要串（64 hex）。规格：DESIGN.md §7.7。
//
// 🔴 **分组间距必须靠 CSS margin，DOM 里零空格。** 插了空格，用户复制粘到终端里
//    就是一个坏值 —— 而这个站点存在的理由就是让人能把摘要拿去自己复算。
// 🔴 **绝不做字符级 diff、绝不给某几组染色。** 哈希是雪崩的：两串不同的摘要本来就
//    一个字符都对不上，染色会暗示"差异定位在这几段"，那是假的。

import { CopyButton } from './copy-button';
import { ExpandableDigest } from './expandable-digest';

/** 把 `geoly-tree-v1:sha256:<hex>` / `sha256:<hex>` 拆成算法前缀与 hex 两段。 */
export function splitDigest(value) {
  const i = value.lastIndexOf(':');
  return i === -1
    ? { algo: '', hex: value }
    : { algo: value.slice(0, i + 1), hex: value.slice(i + 1) };
}

function groups(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 8) out.push(hex.slice(i, i + 8));
  return out;
}

/**
 * full 形态：算法前缀单独一段，其后按 8 组 × 8 字符排，首尾组加粗
 *（人核对摘要时看的就是首尾）。
 */
export function Digest({ value, label = '摘要', dim = false, copy = true }) {
  const { algo, hex } = splitDigest(value);
  return (
    <span className={`digest${dim ? ' dim' : ''}`} role="group" aria-label={`${label}，${hex.length} 位十六进制`}>
      {algo ? <span className="algo">{algo}</span> : null}
      {/* 这一段刻意写成没有任何空白字符的 JSX：换行会被 JSX 折成空格，进而进 DOM */}
      <span className="hex">{groups(hex).map((g, i) => <b key={i}>{g}</b>)}</span>
      {copy ? <CopyButton value={hex} /> : null}
    </span>
  );
}

/**
 * short 形态：`首8…尾8`。
 * 🔴 **只用于导航，不用于核对** —— 任何要求用户比对的场景必须给 full。
 *    所以它旁边总带一个展开按钮：读者一旦真的要比对，能就地拿到 full 形态。
 */
export function DigestShort({ value, expandable = true }) {
  const { hex } = splitDigest(value);
  const short = (
    <span className="digest-short" title={value}>
      {hex.slice(0, 8)}<span className="mid">…</span>{hex.slice(-8)}
    </span>
  );
  if (!expandable) return short;
  return <ExpandableDigest value={value}>{short}</ExpandableDigest>;
}

/**
 * pair 形态：两串**上下并列、同宽同分组、都用常规色**。
 *
 * 🔴 **绝不做字符级 diff、绝不给某几组染色。** 哈希是雪崩的 —— 两串不同的摘要本来就
 *    一个字符都对不上，染色会暗示「差异定位在这几段」，那是假的。
 *    正确的表达是把「为什么它们本就不该相等」写成一句**可复算的事实**（见调用方）。
 */
export function DigestPair({ rows }) {
  return (
    <div className="digest-pair">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="t cn">{r.label}</div>
          <Digest value={r.value} label={r.label} />
        </div>
      ))}
    </div>
  );
}

export { ExpandableDigest };
