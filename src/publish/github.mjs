// `publish` 的 GitHub API 客户端 —— **这是 publish 唯一的出网口**。
//
// ── 🔴 为什么全走 API，一次 `git` 都不用 ────────────────────────────────────
//
// 带 token 的 `git push` 会让**本地** `pre-push` hook 拿到那个 token。
// hook 是仓库里的普通可执行文件，`git` 无条件运行它 —— 于是「投稿一个 skill」
// 变成了「把你的 GitHub 凭据交给一段任意代码」。
// 这不是理论风险：投稿者的载荷目录常常就在某个 git 仓库里。
//
// ── 🔴 为什么是 Git Data API，不是 Contents API ───────────────────────────
//
// Contents API **没有设置 mode 的字段** —— 一个 `0755` 的文件会被写成 `0644`。
// 而 mode **进 `tree_digest`**（`src/tree-digest.mjs`：mode 是每个叶子的编码的一部分，
// 同字节不同 mode 算出来是两个不同摘要），也进 capability 语义
// （`structural-gates.executableEvidence` 看的就是可执行位）。
// 所以用 Contents API 投稿，等于**静默地改掉制品身份**。
//
// 另外 Contents API 每个文件一次 commit：中途失败会在 fork 上留下**半棵可见的
// 投稿树**，而我们的策略是「同名分支只读、不自动改写」—— 那棵半成品就没人能收拾了。
// Git Data API 的顺序是 blob → tree → commit → **最后一次性建 ref**：
// 失败只留下不可见的 orphan object，仓库上什么都看不见。

import { TokenError, scrub } from './token.mjs';

/** 🔴 API host 固定。不从任何输入取，不支持 GHE。 */
export const API_ORIGIN = 'https://api.github.com';
/** 🔴 上游固定。不是参数。 */
export const UPSTREAM_OWNER = 'geoly-ai';
export const UPSTREAM_REPO = 'skills-hub';
export const UPSTREAM_FULL = `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`;
/** 🔴 base 分支固定。 */
export const BASE_BRANCH = 'main';

/** 网络类错误 → EXIT.NETWORK(6)。 */
export class ApiNetworkError extends Error {
  constructor(message, extra = {}) {
    super(message); this.name = 'ApiNetworkError'; this.exitCode = 6; Object.assign(this, extra);
  }
}

/**
 * HTTP 层的失败。`status` 一定有；401/403 映射到 EXIT.AUTH(7)，其余到 EXIT.NETWORK(6)。
 *
 * 🔴 **401/403 绝不静默换下一个 token 来源重试**（见 `commands/publish.mjs`）：
 *    那会让用户看到的身份与实际投稿身份不同 —— 而这条命令的全部风险都在身份上。
 */
export class ApiHttpError extends Error {
  constructor(message, { status, method, path, docUrl = null } = {}) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.docUrl = docUrl;
    this.exitCode = (status === 401 || status === 403) ? 7 : 6;
  }
}

/**
 * 路径参数的转义。**每一段都转**，然后 URL 里绝不出现未转义的用户输入。
 *
 * ⚠️ `encodeURIComponent` 会把 `/` 转成 `%2F` —— 这正是我们要的：
 *    一个叫 `a/b` 的分支名不该变成两层路径。调用方把**不该转义的**斜杠
 *    写在模板字面量里，把**每一个变量**用这个函数包起来。
 */
export const seg = (s) => encodeURIComponent(String(s));

/**
 * 建客户端。
 *
 * @param {object} a
 * @param {string} a.token
 * @param {function} a.fetchImpl  🔴 **必填**。不给就抛 —— 见下。
 * @param {string} a.userAgent
 * @param {number} [a.timeoutMs]
 */
export function createClient({ token, fetchImpl, userAgent, timeoutMs = 30000 }) {
  // 🔴 `fetchImpl` 必填、且**没有隐式回退到 globalThis.fetch**。
  //    测试忘了注入时，回退版本会**真的出网**，而那次出网看起来像一次通过的测试。
  //    这条命令会创建 fork、建分支、开 PR —— 一次意外出网就是一次真实的写操作。
  //    调用方（`commands/publish.mjs`）显式传 `ctx.fetchImpl ?? globalThis.fetch`，
  //    于是"用了真 fetch"是一个**写得出来的动作**，不是一个默认值。
  if (typeof fetchImpl !== 'function') {
    throw new ApiNetworkError('publish 的 GitHub 客户端必须显式拿到 fetch 实现（不接受隐式回退）');
  }
  if (typeof token !== 'string' || token === '') throw new TokenError('内部错误：客户端拿到空 token');

  /**
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} path  以 `/` 开头；**变量段必须已经过 `seg()`**
   * @param {object} [o]
   * @param {object} [o.body]
   * @param {number[]} [o.okStatus]  允许的状态码；默认 2xx
   * @param {number[]} [o.softStatus] 不抛错、原样返回的状态码（如 404 探测）
   */
  async function request(method, path, { body = undefined, softStatus = [] } = {}) {
    const url = new URL(path, API_ORIGIN);
    // 🔴 **构造完之后**再断言 origin。在拼接之前断言等于没断言：
    //    `path` 若是 `https://evil.example/x`，`new URL` 会**整个换掉** origin。
    //    这一条不是理论上的 —— 分支名、login 都进路径，而它们来自远端响应。
    if (url.origin !== API_ORIGIN) {
      throw new ApiNetworkError(`拒绝向 ${url.origin} 发请求 —— publish 的 API host 固定为 ${API_ORIGIN}`);
    }

    const headers = {
      // 🔴 Authorization 只在这里出现一次，且这个对象**绝不进任何错误/日志**。
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // 🔴 `manual`，且下面对任何 3xx 都抛 —— **不跟随，一步都不跟**。
        //    跟随会把 `Authorization` 带去一个我们没有断言过的 host。
        //    `redirect:'error'` 也行，但 `manual` 让我们能把状态码报出来。
        redirect: 'manual',
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) {
        // 🔴 超时是**特殊的**：POST 可能已经在服务端生效了。
        //    调用方必须先查询结果再决定是否重试 —— 所以这里把 `timedOut` 标出来。
        throw new ApiNetworkError(
          `${method} ${path} 超时（${timeoutMs} ms）—— 🔴 若这是一次写操作，`
          + '它**可能已经生效**；请先查询结果再决定是否重试。',
          { timedOut: true, method, path },
        );
      }
      // undici 抛的永远是 `TypeError: fetch failed`，真因在 cause 上。
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? '未知';
      throw new ApiNetworkError(scrub(`${method} ${path} 失败：${cause}`, token), { method, path });
    } finally {
      clearTimeout(t);
    }

    // 🔴 3xx 一律抛。**同 host 的重定向也抛** —— GitHub 会对改过名的仓库发 301，
    //    而"上游改名了"是一件必须让人看见的事，不是可以静默跟随的细节。
    if (res.status >= 300 && res.status < 400) {
      throw new ApiNetworkError(
        `${method} ${path} 返回了 ${res.status} 重定向 —— 拒绝跟随。\n`
        + '  🔴 跟随重定向会把 Authorization 头带去一个没被断言过的 host。\n'
        + '  常见成因：上游仓库改过名。请核对 `geoly-ai/skills-hub` 是否仍然有效。',
        { method, path },
      );
    }

    const text = await res.text().catch(() => '');
    let json = null;
    if (text !== '') { try { json = JSON.parse(text); } catch { json = null; } }

    if (res.ok || softStatus.includes(res.status)) {
      return { status: res.status, json, headers: res.headers, ok: res.ok };
    }

    // 🔴 错误文案里**只**放 status / method / path / 响应体的 `message` 与 `documentation_url`。
    //    不放 request headers，不放整个响应体（它可能回显了我们发过去的内容）。
    //    再过一遍 `scrub` —— 那是最后一道，不是第一道。
    const apiMsg = typeof json?.message === 'string' ? json.message : `HTTP ${res.status}`;
    const errs = Array.isArray(json?.errors)
      ? json.errors.map((x) => (typeof x?.message === 'string' ? x.message : x?.code)).filter(Boolean)
      : [];
    throw new ApiHttpError(
      scrub(`${method} ${path} → ${res.status}：${apiMsg}${errs.length ? `（${errs.join('；')}）` : ''}`, token),
      {
        status: res.status,
        method,
        path,
        docUrl: typeof json?.documentation_url === 'string' ? json.documentation_url : null,
      },
    );
  }

  return {
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body }),
  };
}

/**
 * 分页取全部页。
 *
 * 🔴 `maxPages` 到顶时**不静默截断**：抛 `TruncatedError`，由调用方决定怎么说。
 *    一个"取了前 3 页就当作全部"的重复检测，正是那种「看起来在查、其实查不全」的门。
 */
export class TruncatedError extends Error {
  constructor(message, extra = {}) {
    super(message); this.name = 'TruncatedError'; this.exitCode = 6; Object.assign(this, extra);
  }
}

export async function getAllPages(client, pathWithoutPage, { perPage = 100, maxPages = 10 } = {}) {
  const out = [];
  const sepChar = pathWithoutPage.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page += 1) {
    const r = await client.get(`${pathWithoutPage}${sepChar}per_page=${perPage}&page=${page}`);
    // 🔴 200 但不是数组 → **抛**。把它当成空数组，等于把「响应形状不对」
    //    翻译成「这一页什么都没有」，而后者会让"没有重复投稿"这个结论成立。
    if (!Array.isArray(r.json)) {
      throw new TruncatedError(
        `${pathWithoutPage} 第 ${page} 页返回的不是数组 —— 拒绝把它当成"这一页是空的"`,
        { path: pathWithoutPage, page },
      );
    }
    const arr = r.json;
    out.push(...arr);
    if (arr.length < perPage) return out;
  }
  throw new TruncatedError(
    `${pathWithoutPage} 的分页超过 ${maxPages} 页（每页 ${perPage}）—— 拒绝把"取了前 ${maxPages} 页"`
    + '当成"全部"。',
    { path: pathWithoutPage, maxPages, perPage, got: out.length },
  );
}
