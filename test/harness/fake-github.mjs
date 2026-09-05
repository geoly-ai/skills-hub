// `publish` 测试用的 GitHub API 替身。
//
// 🔴🔴 **默认会抛。** 没有被显式登记的请求一律当场炸，而不是返回 404 / 空对象。
//    理由：这条命令会建 fork、建分支、开 PR。一个"没匹配上就悄悄返回 404"的桩
//    会让「我们发了一个没预期的写请求」变成一次**通过**的测试 ——
//    而那正是我们要防的事故。
//
// 🔴 同样地，`createClient` 不接受隐式回退到 `globalThis.fetch`：
//    测试忘了注入时是 `ApiNetworkError`，不是一次真出网。

/** 一次调用的记录。 */
export class Recorder {
  constructor() { this.calls = []; }

  /** 精确统计某个方法 + 路径前缀被调了几次 —— 「出现过」不是判据，个数才是。 */
  count(method, pathPrefix) {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
  }

  /** 所有写请求（POST / PATCH / PUT / DELETE）。 */
  writes() {
    return this.calls.filter((c) => !['GET', 'HEAD'].includes(c.method));
  }

  paths(method) { return this.calls.filter((c) => c.method === method).map((c) => c.path); }
}

/**
 * @param {Array<[string, RegExp|string, object|function]>} routes
 *   `[method, 路径（字符串精确匹配或正则）, 响应或响应工厂]`
 *   响应形如 `{ status?, json?, headers? }`；工厂拿到 `{method, path, body}`。
 *   同一条路由可以被登记多次 —— 按登记顺序**逐次消费**（用来模拟"第一次 404、
 *   第二次 200"这种异步 fork 的形状）。
 */
export function fakeFetch(routes, recorder = new Recorder()) {
  const queue = routes.map(([m, p, r]) => ({ m, p, r, used: false }));

  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    const path = u.pathname + u.search;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    recorder.calls.push({ method, path, body, headers: init.headers, redirect: init.redirect });

    const hit = queue.find((q) => !q.used && q.m === method
      && (typeof q.p === 'string' ? q.p === path : q.p.test(path)));
    if (hit === undefined) {
      // 🔴 **抛，不是返回 404。** 见文件头。
      throw new Error(`fake-github: 没预期到的请求 ${method} ${path}`);
    }
    hit.used = true;
    const res = typeof hit.r === 'function' ? await hit.r({ method, path, body }) : hit.r;
    if (res instanceof Error) throw res;
    // 🔴 `{ abort: true }` = 模拟**真的超时**：挂住直到调用方的 AbortController 触发。
    //    不能用"直接抛一个自造的错"来冒充 —— 客户端判「这次是不是超时」看的是
    //    `signal.aborted`，而写路径的「先查再说」正是靠那一位决定的。
    //    用假错去测，测到的就不是真正会跑的那条分支。
    if (res.abort === true) {
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    const status = res.status ?? 200;
    const payload = res.json === undefined ? '' : JSON.stringify(res.json);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Map(Object.entries(res.headers ?? {})),
      text: async () => payload,
    };
  };
  // Map 没有 get 的大小写不敏感语义，补一个够用的 headers.get
  const wrap = async (...a) => {
    const r = await impl(...a);
    const m = r.headers;
    r.headers = { get: (k) => m.get(k) ?? m.get(k.toLowerCase()) ?? null };
    return r;
  };
  wrap.recorder = recorder;
  wrap.unused = () => queue.filter((q) => !q.used).map((q) => `${q.m} ${q.p}`);
  return wrap;
}

/** 🔴 任何调用都抛 —— 用在"这一段绝不该出网"的用例上。 */
export const explodingFetch = () => { throw new Error('测试没预期到会出网'); };
