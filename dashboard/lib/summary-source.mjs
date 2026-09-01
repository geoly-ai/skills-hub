/*
 * 🔴🔴 **这个文件只能在服务端跑。**
 *
 * 它是全项目唯一读 `GEOLY_TELEMETRY_SUMMARY_TOKEN` 的地方。那把 token 是
 * 规格 §5.3 里「读出面默认关闭」的钥匙 —— 漏进客户端 bundle 就等于
 * **把全量聚合面对全世界打开**，而且是静默地打开：没有任何东西会变红。
 *
 * 三道防线：
 *   ① 本文件不带 'use client'，且**任何带 'use client' 的文件都不许 import 它**
 *      —— 由 test/no-client-secrets.test.mjs 递归查 import 图断言；
 *   ② 下面这个运行时护栏：万一哪天被打进了浏览器包，它会立刻抛，
 *      而不是「悄悄工作、顺便把 token 印进 HTML」；
 *   ③ token 只出现在 `Authorization` 头里，**从不进入返回值**。
 *      返回值里连端点 URL 都是掩码过的（maskUrl）—— URL 里可能有人手滑塞了
 *      `?token=`，而它会被渲染到页面上。
 */
import { SOURCE, sourceStateOf } from './state.mjs';
import { normalizeSummary } from './normalize.mjs';

if (typeof window !== 'undefined') {
  // 🔴 不要「降级成不读 token」—— 那会让一次打包事故变成一个能用但不该用的页面。
  throw new Error('dashboard: summary-source.mjs 被打进了客户端 bundle，这是安全事故，拒绝运行');
}

/** 请求超时。⚠️ 覆盖到**读完 body 为止**，不只是握手 —— 规格 T-5 在客户端那侧吃过这个亏。 */
export const FETCH_TIMEOUT_MS = 5000;

/**
 * 掩码 URL：只留 origin + pathname，丢掉 query 与 hash，并拒绝内嵌凭据。
 * 页面上要显示「我们在问谁」，但不能把凭据一起显示出去（规格 §5.1 / T-9 同源理由）。
 */
export function maskUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return `${u.protocol}//<凭据已掩码>@${u.host}${u.pathname}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<不是一个合法的 URL>';
  }
}

/**
 * 读一次汇总。
 *
 * @returns {{source:string, url:string|null, status:number|null, why:string|null, data:object|null}}
 *   `data` 只在 source === 'ok' 时非 null。**永远不含 token，也不含原始 body。**
 */
export async function fetchSummary({ fetchImpl = fetch, env = process.env } = {}) {
  const url = (env.GEOLY_SUMMARY_URL ?? '').trim();
  const token = (env.GEOLY_TELEMETRY_SUMMARY_TOKEN ?? '').trim();
  const masked = url ? maskUrl(url) : null;

  // 🔴 空串是**没配**，不是「配了个空的」。规格 §4.2 在客户端端点那侧定过同一条：
  //    部署模板漏填变量最常见的形态就是空串。
  if (!url || !token) {
    return { source: SOURCE.UNCONFIGURED, url: masked, status: null, why: null, data: null };
  }
  // 只允许 https —— 与规格 §5.1 同一条理由，且不用 startsWith 判（`https:/\evil` 骗得过前缀）
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:') {
    // localhost 上开发时允许 http，别的一律拒 —— 否则 token 会明文过网
    const localDev = parsed && parsed.protocol === 'http:'
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (!localDev) {
      return {
        source: SOURCE.UNCONFIGURED, url: masked, status: null,
        why: 'GEOLY_SUMMARY_URL 必须是 https（仅 localhost 允许 http）', data: null,
      };
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let status = null;
  let body = null;
  let transportError = null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      // 🔴 redirect: 'error' —— 跟随重定向会把 Authorization 头带到别的主机去。
      redirect: 'error',
      // 🔴 no-store：这是内部运营数据，任何一层缓存都是一次泄漏面
      cache: 'no-store',
      signal: ac.signal,
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = null; }
  } catch (e) {
    // ⚠️ 不把 e.message 带出去：它可能含 URL（含 query），也可能含内网主机名
    transportError = e?.name === 'AbortError' ? 'timeout' : 'network';
  } finally {
    clearTimeout(timer);
  }

  const normalized = body === null ? { ok: false, why: 'body 不是合法 JSON' } : normalizeSummary(body);
  const source = sourceStateOf({
    configured: true, transportError, status: status ?? 0, bodyOk: normalized.ok,
  });
  return {
    source,
    url: masked,
    status,
    why: source === SOURCE.INVALID ? (normalized.why ?? null) : (transportError ?? null),
    data: source === SOURCE.OK ? normalized : null,
  };
}
