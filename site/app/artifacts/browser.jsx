'use client';

// 列表的搜索与筛选。规格：DESIGN.md §7.10。**纯前端、纯内存**：全部数据在构建时就随页面
// 发下来了，这里不发任何请求，也没有任何后端可查。
//
// 🔴 **粘一整串 64 hex 必须能反查制品**（借鉴 Rekor 搜索）。这是本站点最有辨识度的搜索
//    能力：命中时要标明匹配的是 `tree_digest` 还是 `asset.sha256` —— 不说清匹配的是哪个，
//    用户就无法判断他手上那串是从哪来的。
//
// 🔴 **筛选分组顺序按信任维度，不按流行度**：kind → tier → status → provenance →
//    client → license → namespace。
//
// 🔴 **没有 "sort by downloads"**，也没有任何按热度排序的入口 —— 那类数字我们没有。

import { Fragment, useMemo, useState, useId, useRef, useEffect } from 'react';

import { ArtifactCard } from '../../components/artifact-card';
import { Icon } from '../../components/icons';

const RE_HEX64 = /^[0-9a-f]{64}$/;

/** 一组筛选维度：取值 + 每个取值命中多少条 record。 */
function facet(artifacts, pick) {
  const m = new Map();
  for (const a of artifacts) for (const v of new Set(pick(a))) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([value, count]) => ({ value, count }));
}

function ChipGroup({ name, options, selected, onToggle }) {
  if (options.length === 0) return null;
  return (
    <div className="fgroup">
      <span className="label">{name}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="chip"
          aria-pressed={selected.has(o.value)}
          onClick={() => onToggle(o.value)}
        >
          {o.value}<span className="n">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

/** 同一维度内多选取并集，维度之间取交集 —— 这是筛选器的常规语义，但要说出来。 */
function useFacet() {
  const [sel, setSel] = useState(() => new Set());
  const toggle = (v) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(v)) next.delete(v); else next.add(v);
    return next;
  });
  return [sel, toggle, () => setSel(new Set())];
}

export function ArtifactBrowser({ artifacts }) {
  const [kind, toggleKind, clearKind] = useFacet();
  const [tier, toggleTier, clearTier] = useFacet();
  const [status, toggleStatus, clearStatus] = useFacet();
  const [prov, toggleProv, clearProv] = useFacet();
  const [client, toggleClient, clearClient] = useFacet();
  const [license, toggleLicense, clearLicense] = useFacet();
  const [ns, toggleNs, clearNs] = useFacet();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('id');
  const ids = useId();
  const input = useRef(null);

  // `/` 聚焦搜索框（§7.10 的 kbd 提示要真的能用）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const facets = useMemo(() => ({
    kind: facet(artifacts, (a) => [a.kind]),
    tier: facet(artifacts, (a) => (a.declared_tier === null ? [] : [`tier ${a.declared_tier}`])),
    status: facet(artifacts, (a) => [a.status]),
    prov: facet(artifacts, (a) => [a.provenance.kind]),
    client: facet(artifacts, (a) => a.clients),
    license: facet(artifacts, (a) => [a.license]),
    ns: facet(artifacts, (a) => [a.namespace]),
  }), [artifacts]);

  const withDescription = useMemo(() => artifacts.filter((a) => a.description !== null).length, [artifacts]);

  const needle = q.trim().toLowerCase();
  const isHex = RE_HEX64.test(needle);

  const shown = useMemo(() => {
    const pass = (set, value) => set.size === 0 || set.has(value);
    const passAny = (set, values) => set.size === 0 || values.some((v) => set.has(v));
    const rows = artifacts.filter((a) => {
      if (!pass(kind, a.kind)) return false;
      if (!pass(tier, `tier ${a.declared_tier}`)) return false;
      if (!pass(status, a.status)) return false;
      if (!pass(prov, a.provenance.kind)) return false;
      if (!pass(license, a.license)) return false;
      if (!pass(ns, a.namespace)) return false;
      if (!passAny(client, a.clients)) return false;
      if (needle === '') return true;
      if (isHex) {
        return a.tree_digest.endsWith(needle) || a.asset.sha256.endsWith(needle);
      }
      return [a.id, a.name, a.description ?? ''].join('\n').toLowerCase().includes(needle);
    });
    if (sort === 'tier') {
      // 只是重排展示顺序，不改变任何一条 record 的内容
      return [...rows].sort((x, y) => (y.declared_tier ?? -1) - (x.declared_tier ?? -1)
        || (x.id < y.id ? -1 : 1));
    }
    return rows;   // 默认：id 字节序 —— 与快照里 artifacts[] 的排序一致
  }, [artifacts, kind, tier, status, prov, client, license, ns, needle, isHex, sort]);

  const active = [
    ...[...kind].map((v) => `kind=${v}`), ...[...tier].map((v) => v),
    ...[...status].map((v) => `status=${v}`), ...[...prov].map((v) => `provenance=${v}`),
    ...[...client].map((v) => `client=${v}`), ...[...license].map((v) => `license=${v}`),
    ...[...ns].map((v) => `namespace=${v}`),
  ];
  const clearAll = () => {
    clearKind(); clearTier(); clearStatus(); clearProv(); clearClient(); clearLicense(); clearNs();
  };

  /** 一串 hex 命中时，说清匹配的是哪一个字段 —— 不说清用户判断不了它是从哪来的。 */
  const hexHit = (a) => (a.tree_digest.endsWith(needle) ? 'tree_digest' : 'asset.sha256');

  return (
    <>
      <div className="search">
        <Icon name="search" />
        <input
          ref={input}
          id={`${ids}-q`}
          type="search"
          value={q}
          aria-label="搜索制品"
          placeholder="name / skill:ns/name@ver / 64 hex 摘要"
          onChange={(e) => setQ(e.target.value)}
        />
        <kbd>/</kbd>
      </div>

      <div className="filters filterbar" role="group" aria-label="筛选">
        <ChipGroup name="kind" options={facets.kind} selected={kind} onToggle={toggleKind} />
        <span className="divider-v" />
        <ChipGroup name="tier" options={facets.tier} selected={tier} onToggle={toggleTier} />
        <span className="divider-v" />
        <ChipGroup name="status" options={facets.status} selected={status} onToggle={toggleStatus} />
        <span className="divider-v" />
        <ChipGroup name="provenance" options={facets.prov} selected={prov} onToggle={toggleProv} />
      </div>
      <div className="filters filterbar" role="group" aria-label="筛选（续）">
        <ChipGroup name="client" options={facets.client} selected={client} onToggle={toggleClient} />
        <span className="divider-v" />
        <ChipGroup name="license" options={facets.license} selected={license} onToggle={toggleLicense} />
        <span className="divider-v" />
        <ChipGroup name="namespace" options={facets.ns} selected={ns} onToggle={toggleNs} />
      </div>

      <div className="filters">
        <span className="label">sort</span>
        <button type="button" className="chip" aria-pressed={sort === 'id'} onClick={() => setSort('id')}>
          id 字节序
        </button>
        <button type="button" className="chip" aria-pressed={sort === 'tier'} onClick={() => setSort('tier')}>
          capability tier
        </button>
        {active.length > 0
          ? <button type="button" className="chip" onClick={clearAll}>清空筛选</button>
          : null}
      </div>

      <p className="note" role="status">
        {shown.length} / {artifacts.length} 条。
        {isHex ? ' 按 64 位摘要反查。' : ''}
        {' '}默认按 <strong>id 字节序</strong>排 —— 与快照 <code className="mono">artifacts[]</code> 的排序一致。
        {' '}没有按使用情况排序的入口：那类数字我们没有。
        {' '}<span className="dim">
          「最近进入快照」这个排序也做不了：快照 record 里没有「何时加入」这个字段。
        </span>
        {' '}<span className="dim">
          {withDescription === artifacts.length
            ? 'description 来自载荷 manifest（全部条目的载荷都已按 tree_digest 核对），也参与搜索。'
            : `快照 record 不含 description；其中 ${withDescription} 条拿到了已核对的载荷，只有这些参与 description 搜索。`}
        </span>
      </p>

      {shown.length === 0
        ? (
          // 🔴 两种「空」要用不同的话说。这里的列表页只在非空 registry 才渲染，
          //    所以这一条一定是「筛没了」，出口是清空筛选。
          <div className="emptyrow">
            <p><strong>没有制品同时满足当前条件。</strong></p>
            {active.length > 0
              ? <p className="note">生效的条件：<span className="mono">{active.join(' · ')}</span></p>
              : null}
            {needle ? <p className="note">搜索串：<span className="mono">{q.trim()}</span>{isHex ? '（按 64 hex 摘要匹配）' : ''}</p> : null}
            <p className="note dim">
              这张快照本身收录了 {artifacts.length} 条 record，所以不是「registry 是空的」，
              是这几个条件把结果筛空了。
            </p>
            <div>
              <button type="button" className="btn btn-mono" onClick={() => { clearAll(); setQ(''); }}>
                清空筛选与搜索
              </button>
            </div>
          </div>
        )
        : (
          <ul className="list">
            {shown.map((a) => (
              <Fragment key={a.id}>
                <ArtifactCard artifact={a} />
                {/* 命中一串 hex 时，说清匹配的是哪个字段 —— 否则用户判断不了它是从哪来的 */}
                {isHex ? <li className="blameline">匹配字段：<span className="mono">{hexHit(a)}</span></li> : null}
              </Fragment>
            ))}
          </ul>
        )}
    </>
  );
}
