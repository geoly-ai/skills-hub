'use client';

// 三态主题按钮：跟随系统 / 亮 / 暗（DESIGN.md §1.1、§10）。
//
// 🔴 **按钮文字直接给出当前值**，不用一个需要解读的图标 —— 这和整个站点
//    「用陈述句说清状态」的写法一致。
//
// ⚠️ 状态写进 `<html data-theme>`，"跟随系统"时**删掉这个属性**而不是写 `system` ——
//    tokens.css 的暗色规则是 `:root:not([data-theme="light"])` 配 `prefers-color-scheme`，
//    留一个陌生值在上面会让那条规则的行为变得要靠读 CSS 才能推断。

import { useEffect, useState } from 'react';

const ORDER = ['system', 'light', 'dark'];
const LABEL = { system: '跟随系统', light: '亮', dark: '暗' };
const KEY = 'skills-hub-theme';

export function ThemeToggle() {
  // 🔴 首渲染必须与服务端产物一致（'system'），否则静态导出的 HTML 与首次
  //    客户端渲染对不上，React 会报 hydration 不匹配。真实值在 effect 里补。
  const [theme, setTheme] = useState('system');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved && ORDER.includes(saved)) setTheme(saved);
    } catch { /* 隐私模式下 localStorage 会抛，主题跟随系统即可，不是错误 */ }
  }, []);

  const apply = (next) => {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch { /* 同上 */ }
  };

  return (
    <button
      type="button"
      className="btn btn-mono"
      onClick={() => apply(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length])}
    >
      主题：{LABEL[theme]}
    </button>
  );
}

/**
 * 在 `<head>` 里同步跑的一小段：把上次的选择贴回 `<html>`，避免先闪一下系统主题。
 * 🔴 必须**同步**、必须在 body 之前 —— 放到 effect 里就来不及了（那正是"闪一下"的成因）。
 */
export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('${KEY}');`
  + `if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
