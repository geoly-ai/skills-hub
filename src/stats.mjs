// 本地聚合 + 文本报表。纯函数，不碰网络。
import { readHistory } from './telemetry.mjs';

export function aggregate(events) {
  const byArtifact = new Map(), byClient = new Map(), byKind = new Map();
  let ok = 0, failed = 0, msTotal = 0, msCount = 0;
  let first = null, last = null;
  for (const e of events) {
    if (!first || e.at < first) first = e.at;
    if (!last || e.at > last) last = e.at;
    if (e.result === 'ok') ok++; else if (e.result === 'failed') failed++;
    if (typeof e.ms === 'number') { msTotal += e.ms; msCount++; }
    bump(byKind, e.kind, e.result);
    if (e.artifact) bump(byArtifact, e.artifact, e.result);
    if (e.client) bump(byClient, e.client, e.result);
  }
  return {
    total: events.length, ok, failed,
    successRate: events.length ? ok / events.length : 0,
    avgMs: msCount ? Math.round(msTotal / msCount) : null,
    window: { first, last },
    byArtifact: sorted(byArtifact), byClient: sorted(byClient), byKind: sorted(byKind),
  };
}
function bump(m, k, result) {
  const r = m.get(k) ?? { key: k, n: 0, ok: 0, failed: 0 };
  r.n++; if (result === 'ok') r.ok++; else if (result === 'failed') r.failed++;
  m.set(k, r);
}
const sorted = m => [...m.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));

const pct = x => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** 纯 ASCII 文本报表 —— 没有事件时说清楚原因，不要输出一张空表 */
export function textReport(agg) {
  if (agg.total === 0) {
    return '还没有埋点事件。\n跑几次 install/check 之后再看；若设了 GEOLY_TELEMETRY=0 则本地不会记录任何东西。\n';
  }
  const L = [];
  L.push('skills-hub 本地埋点报表');
  L.push('='.repeat(46));
  L.push(`事件总数  ${agg.total}    成功 ${agg.ok}    失败 ${agg.failed}    成功率 ${pct(agg.successRate)}`);
  if (agg.avgMs !== null) L.push(`平均耗时  ${agg.avgMs} ms`);
  L.push(`时间窗口  ${agg.window.first} -> ${agg.window.last}`);
  for (const [title, rows, w] of [['按制品', agg.byArtifact, 40], ['按客户端', agg.byClient, 12], ['按操作', agg.byKind, 12]]) {
    if (!rows.length) continue;
    L.push('', title, '-'.repeat(46));
    // 表头用 ASCII：中文是双宽字符，padEnd 按码点数算会让整列错位
    L.push(`${pad('', w)} ${padL('N', 6)} ${padL('OK', 6)} ${padL('FAIL', 6)}`);
    for (const r of rows) L.push(`${pad(r.key.slice(0, w), w)} ${padL(r.n, 6)} ${padL(r.ok, 6)} ${padL(r.failed, 6)}`);
  }
  return L.join('\n') + '\n';
}

export function stats({ events = readHistory() } = {}) {
  return { agg: aggregate(events), events };
}
