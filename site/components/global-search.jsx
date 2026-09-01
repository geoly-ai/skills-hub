'use client';

// 站头的全局搜索（DESIGN.md §7.1、§7.10）。
//
// 🔴 **它必须能出现在每一页**，因为它最有辨识度的能力是「粘一整串 64 hex 反查制品」——
//    而人拿到一串摘要的时刻，往往正停在某个详情页上，不该被迫先跳回列表页。
//
// 数据是构建期就编译进每页的一份**极小索引**（id / href / 两个摘要），不是全量 record：
// 全局搜索只需要回答「这串东西对应哪个制品」，把整份视图模型塞进每一页没有必要。
// 仍然是纯前端、零请求。

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';

import { Icon } from './icons';

const RE_HEX64 = /^[0-9a-f]{64}$/;

export function GlobalSearch({ index }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  const box = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      input.current?.focus();
    };
    const onClick = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', onClick); };
  }, []);

  const needle = q.trim().toLowerCase();
  const isHex = RE_HEX64.test(needle);
  const hits = needle === '' ? [] : index.filter((a) => (isHex
    ? a.tree.endsWith(needle) || a.asset.endsWith(needle)
    : a.id.toLowerCase().includes(needle))).slice(0, 8);

  return (
    <div className="gsearch" ref={box}>
      <div className="search">
        <Icon name="search" />
        <input
          ref={input}
          type="search"
          value={q}
          aria-label="全局搜索：name、ArtifactId 或 64 位摘要"
          placeholder="name / skill:ns/name@ver / 64 hex"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
        <kbd>/</kbd>
      </div>
      {open && needle !== '' ? (
        <div className="gsearch__pop">
          {hits.length === 0
            ? (
              <p className="note dim">
                没有匹配。{isHex
                  ? '这串 64 hex 不在当前快照的任何 tree_digest 或 asset.sha256 里。'
                  : '搜的是 ArtifactId；摘要请粘完整的 64 位。'}
              </p>
            )
            : hits.map((a) => (
              <Link className="gsearch__hit" key={a.id} href={a.href} onClick={() => setOpen(false)}>
                <span className="mono">{a.id}</span>
                {/* 命中摘要时说清匹配的是哪个字段 —— 不说清，用户判断不了它是从哪来的 */}
                {isHex
                  ? <span className="label">{a.tree.endsWith(needle) ? 'tree_digest' : 'asset.sha256'}</span>
                  : null}
              </Link>
            ))}
        </div>
      ) : null}
    </div>
  );
}
