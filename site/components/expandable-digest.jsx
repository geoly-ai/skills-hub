'use client';

// 短摘要旁的「展开为完整形态」。
//
// 🔴 存在的理由只有一条：**short 形态只能用来导航，不能用来核对**（DESIGN.md §7.7）。
//    `title` 属性给不了这个能力 —— 它不能选中、不能复制、手机上根本出不来。
//    读者一旦真要比对，必须能就地拿到可选中、可复制的 full 形态。
//
// 展开用 `grid-template-rows: 0fr → 1fr`（§9 允许的三种动效之一），160ms。

import { useState, useId } from 'react';

export function ExpandableDigest({ value, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="expandable">
      {children}
      <button
        type="button"
        className="copy"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '收起' : '展开'}
      </button>
      <span className="expandable__panel" data-open={open ? '1' : undefined} id={id}>
        <span>
          {/* 展开后才是可核对的那一份：可选中、可复制、原样 64 hex */}
          <code className="digest-full mono">{value}</code>
        </span>
      </span>
    </span>
  );
}
