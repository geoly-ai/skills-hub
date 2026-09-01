'use client';

// 复制按钮。
//
// 🔴 **从 `value` 复制，绝不从 `textContent` 取。** 摘要在 DOM 里是 8 个 `<b>` 分组，
//    视觉间距靠 CSS margin —— `textContent` 拿到的是连续 64 hex 没错，但只要哪天有人
//    "顺手"在模板里加了空格或换行，从 DOM 取值就会悄悄复制出一个坏值。
//    从数据取值让这个错误不可能发生。
//
// 反馈只改文案与颜色，1200ms 复位：复制是一次确认，不是一次庆祝（§9 禁缩放/弹跳）。

import { useState, useRef, useEffect } from 'react';

export function CopyButton({ value, label = '复制' }) {
  const [done, setDone] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;   // 没有剪贴板权限就什么都不发生 —— 不要谎报"已复制"
    }
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1200);
  };

  return (
    <button type="button" className="copy" data-done={done ? '1' : undefined} onClick={copy}>
      {done ? '已复制' : label}
      {/* 复制完成是真正的动态事件，用独立的 live region 播报；不要把 aria-live 挂按钮上 */}
      <span aria-live="polite" className="sr-only">{done ? '已复制' : ''}</span>
    </button>
  );
}
