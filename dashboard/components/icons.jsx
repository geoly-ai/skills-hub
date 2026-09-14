/*
 * 图标：四个族（DESIGN.md §7）。
 *
 * 🔴 全部内联 SVG，不引任何图标库、图标字体、外部 CSS。
 * 🔴 族 = 语义类别：
 *    n-* 导航（只在 .nav / .panel .head / 登录卡品牌行）
 *    s-* 状态（只在 .nothing 告示条 / .statechip 徽章 / 抑制横条）—— 十一个图形两两不同
 *    m-* 量度形态（只在 KPI 与表格数值旁；🔴 精确值不带图标）
 *    u-* 中性（随处可用，但不得表达任何状态）
 * 🔴 每个图标都 aria-hidden，且必须与一个可见的词同现 —— 图标不单独承载语义。
 *    `data-i` 记下族名，给浏览器里的不变量检查用。
 */

const P = {
  'n-overview': <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z" />,
  'n-usage': <path d="M3 13.5V8M8 13.5V3M13 13.5V10M1.5 13.5h13" />,
  'n-failures': <><path d="M2 11l3.5-3.5L8 10l2.5-4.5" /><path d="M11.5 11.5l3-3M14.5 11.5l-3-3" /></>,
  'n-latency': <><circle cx="8" cy="9.2" r="5.3" /><path d="M8 9.2V6.2M6.2 1.8h3.6M8 1.8v1.9" /></>,
  'n-gaps': <><rect x="2.5" y="2.5" width="11" height="11" strokeDasharray="3 2.4" /><path d="M8 6v4M6 8h4" /></>,
  'n-boundary': <path d="M8 1.8l5.2 2v4.3c0 3.3-2.3 5.2-5.2 6.4C5.1 13.3 2.8 11.4 2.8 8.1V3.8z" />,

  's-unconfigured': <><path d="M1.5 8h3.6" /><path d="M6.4 5.2h3v5.6h-3z" /><path d="M12 5.2h2.5v5.6H12" /></>,
  's-unreachable': <path d="M1.5 8h4.4M10.1 8h4.4M7.2 5.2l1.6 5.6" />,
  's-denied': <><rect x="3.2" y="7.4" width="9.6" height="6.4" rx="1" /><path d="M5.6 7.4V5.2a2.4 2.4 0 014.8 0v2.2M8 10v1.6" /></>,
  's-invalid': <><rect x="1.6" y="1.6" width="8.4" height="8.4" /><circle cx="10.6" cy="10.6" r="3.4" /></>,
  's-unrecognized': <><path d="M2 4h12M2 8h12M2 12h12" /><path d="M13 2.6L3 13.4" /></>,
  's-zero': <><path d="M3.4 2.4v7.2a4.6 4.6 0 009.2 0V2.4" /><path d="M2 2.4h12" /></>,
  's-not-computed': <><rect x="2.4" y="2.4" width="11.2" height="11.2" strokeDasharray="3 2.4" /><path d="M8 5.8v4.4M5.8 8h4.4" /></>,
  's-empty-dim': <><rect x="1.6" y="2.6" width="12.8" height="10.8" /><path d="M1.6 6.2h12.8" /></>,
  's-filtered': <path d="M2 3.2h12l-4.6 5.4v4.6l-2.8 1.4V8.6z" />,
  's-withheld': <><rect x="2" y="3.4" width="12" height="9.2" /><path d="M4.2 12.2l3.6-5.6M7.6 12.2l3.6-5.6" /></>,
  's-withheld-q': <><rect x="1.6" y="3.4" width="9.6" height="9.2" /><path d="M3.4 12.2l2.8-5.6M6.4 12.2l2.8-5.6" /><path d="M14 3.4v9.2M12.6 6.2h1.8M12.6 10.2h1.8" /></>,

  'm-bucket': <path d="M3 8h10M3 5.6v4.8M13 5.6v4.8" />,
  'm-floored': <path d="M11 3.4L4.6 8l6.4 4.6" />,
  'm-unknown': <path d="M2.4 8h3M6.6 8h3M12.2 8h1.4" />,
  'm-withheld': <><rect x="2.4" y="4.4" width="11.2" height="7.2" /><path d="M4.6 11l2.6-4.4M8 11l2.6-4.4" /></>,

  'u-info': <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.4v3.6M8 5.2v.2" /></>,
  'u-chevron': <path d="M6 3.5L10.5 8 6 12.5" />,
  'u-theme': <><circle cx="8" cy="8" r="5.6" /><path d="M8 2.4a5.6 5.6 0 010 11.2z" fill="currentColor" stroke="none" /></>,
  'u-external': <><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" /><path d="M12 9.5v3.5a.5.5 0 01-.5.5h-8a.5.5 0 01-.5-.5v-8a.5.5 0 01.5-.5H7" /></>,
};

/** @param {{ name: keyof typeof P, size?: 12|14|16|18 }} props */
export function Icon({ name, size = 14 }) {
  const body = P[name];
  if (!body) throw new Error(`dashboard: 未知图标 ${name}`);
  const cls = size === 14 ? 'i' : `i i-${size}`;
  return (
    <svg
      className={cls} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-i={name}
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    >
      {body}
    </svg>
  );
}

export const ICON_NAMES = Object.freeze(Object.keys(P));
