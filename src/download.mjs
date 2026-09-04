// 取字节的**唯一**出网口 —— preheat 用它，别的地方不许自己开 fetch。
//
// 🔴 这一层**一个校验都不做**（除了下面这几条纯粹的传输上限）。
//    签名、摘要、新鲜度、trust floor 全在 `snapshot.resolveCurrent()` 与
//    `artifact.*` 里。理由与 `commands/registry.mjs` 顶部那条相同：把校验
//    放进取字节层，会诱使人写「这次是我自己下的、可以信」。
//    **下载器不认识「可信」这个概念。**
//
// 出网规矩与 `upload.mjs` 保持一套（那边已经踩过一遍）：
//   · https-only，且用 URL 解析判断而不是 `startsWith`
//   · 禁止重定向
//   · 超时必须覆盖到**读完 body**，不能 fetch 一返回就 clear
//
// ⚠️ 与 upload 不同的一条：那边是**发**数据，这边是**收**。
//    收的一侧多一个上限问题 —— 见 `readCapped` 的注释。

import { NetworkError } from './exit-codes.mjs';

/** 单次下载的硬上限。资产另有更大的上限，由调用方按快照记录的 size 传入。 */
export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/**
 * 默认超时。🔴 覆盖全程：DNS、连接、TLS、响应头、**整条重定向链**、读完 body。
 *
 * ⚠️ 这一行原本是单行注释，里面的 `**整条重定向链**` 紧跟一个斜杠 ——
 *    `*` + `/` 当场把块注释关掉了，报的却是「Unexpected identifier 'body'」。
 *    在块注释里写 Markdown 粗体时，**别让星号紧挨着斜杠**。
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 允许被重定向到的 host。
 *
 * 🔴 **不能只允许 0 次重定向** —— 2026-09-03 实测，GitHub Release 资产必然 302：
 *
 *     github.com/<repo>/releases/download/<tag>/<file>
 *       → 302 → release-assets.githubusercontent.com/…?sp=r&sig=…&jwt=…
 *
 *    所以「一次都不跟随」等于一个字节都下不来。我第一版正是这么写的。
 *
 * ⚠️ 注意跳转目标**带查询串**（那是它的签名参数）——
 *    因此「禁止 query/fragment」只能管**初始 URL**，不能一并套到跳转目标上，
 *    否则同样是全部下载失败。
 */
export const REDIRECT_HOSTS = Object.freeze(['release-assets.githubusercontent.com']);

/** 重定向跳数上限。实测只需 1 跳；给 3 是留余量，不是没有上限。 */
export const MAX_REDIRECTS = 3;

/**
 * 校验下载地址。
 *
 * 🔴 host 必须由调用方钉死，**不接受来自被下载内容的地址**。
 *    locator 契约（02-registry.md §4.0）要求推导链上不出现未验签输入 ——
 *    一个「服务端告诉你去哪儿取下一段」的下载器，正好破坏那条契约。
 */
export function assertDownloadUrl(raw, expectHost, { isRedirect = false } = {}) {
  if (!expectHost) {
    // 🔴 不给 host 就不许下载。默认放行等于把这道闸留在「注释里」——
    //    我第一版正是只写了注释、没写代码（见下面那条实测）。
    throw new NetworkError('assertDownloadUrl 必须传 expectHost —— 下载地址的 host 由调用方钉死');
  }
  const allowed = Array.isArray(expectHost) ? expectHost : [expectHost];
  let u;
  try { u = new URL(raw); } catch { throw new NetworkError(`下载地址不是合法 URL：${raw}`); }
  if (u.protocol !== 'https:') throw new NetworkError(`下载地址必须是 https：${raw}`);
  if (u.username || u.password) throw new NetworkError('下载地址不得内嵌凭据');
  // 🔴 **真正拦住改道的是 host 这一条，不是上面的 protocol 检查。**
  //    实测：`https:/\evil.test/a`（一条反斜杠）被 WHATWG URL 规范化成
  //    `https://evil.test/a` —— protocol 是 https、凭据也没有，
  //    上面两条**全部放行**，字节从 evil.test 来。
  //    ⚠️ 所以「用 URL 解析而不是 startsWith」只解决了协议混淆，
  //    没解决 host 混淆；host 必须单独比，且比的是解析后的 `u.host`。
  if (!allowed.includes(u.host)) {
    throw new NetworkError(
      `下载地址的 host 是 ${u.host}，不在允许列表 [${allowed.join(', ')}] 里：${raw}`,
    );
  }
  // 初始 URL 由 locator 契约推导，**必须是干净路径**：带 query/fragment 说明
  // 它不是我们自己拼出来的。跳转目标反过来——GitHub 的签名参数就在 query 里，
  // 对它套同一条会让所有下载失败（实测）。
  if (!isRedirect && (u.search || u.hash)) {
    throw new NetworkError(`初始下载地址不得带查询串或片段：${raw}`);
  }
  return u;
}

/**
 * 读 body，并在**读的过程中**记账。
 *
 * 🔴 不能只信 `Content-Length`：它是服务端自己说的。声称 1 KiB 却发 10 GiB
 *    是一行代码的事，而 `res.arrayBuffer()` 会**先把它全收下来**再让你发现超限 ——
 *    那时候内存已经没了。所以：Content-Length 先做一次早筛（能省则省），
 *    真正的上限在流式读取里逐块累计，超了当场断开。
 */
async function readCapped(res, cap, what) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new NetworkError(`${what} 声称 ${declared} 字节，超过上限 ${cap}`);
  }
  if (!res.body?.getReader) {
    // 测试替身可能只给 arrayBuffer()。生产路径（undici）一定有 body。
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw new NetworkError(`${what} 有 ${buf.length} 字节，超过上限 ${cap}`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new NetworkError(`${what} 超过上限 ${cap} 字节（读到 ${total} 就断开了）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * 下载一个 URL，返回 Buffer。
 *
 * @param {string} url
 * @param {object} [o]
 * @param {number} [o.cap]        字节上限，默认 MAX_DOWNLOAD_BYTES
 * @param {function} [o.fetchImpl] 注入用
 * @param {number} [o.timeoutMs]
 * @param {string} [o.what]       出错信息里怎么称呼它
 */
export async function download(url, {
  host,
  redirectHosts = REDIRECT_HOSTS,
  maxRedirects = MAX_REDIRECTS,
  cap = MAX_DOWNLOAD_BYTES,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  what = url,
} = {}) {
  assertDownloadUrl(url, host);
  // 🔴 用 `??` 而不是默认参数：**默认参数只对 `undefined` 生效**。
  //    `commands/context.mjs` 里 `fetchImpl` 的缺省值是 **`null`**（与 verifier
  //    等注入点一致），null 会原样穿过默认参数，于是生产路径上拿到的是 null。
  //    ⚠️ 单元测试**永远抓不到这一条** —— 它们每次都注入替身，走不到缺省分支。
  //    2026-09-03 干净 home 端到端首次安装时才炸出来：
  //    「当前 Node 没有内建 fetch」 —— 而 Node 25 明明有。
  fetchImpl = fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new NetworkError('当前 Node 没有内建 fetch，且调用方没有注入 fetchImpl');
  }
  const ac = new AbortController();
  // 🔴 计时器覆盖**整条重定向链 + 读完 body**，只在最后 clear。
  //    在 fetch 返回时就 clear 的话，一个慢慢滴字节的服务端可以让这次下载
  //    永远挂着（upload.mjs 同款教训）；每跳各起一个计时器的话，
  //    N 跳就等于把超时放大 N 倍。
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      let res;
      try {
        res = await fetchImpl(current, {
          method: 'GET',
          // 🔴 'manual' 而不是 'follow'：跳到哪儿由**我们**决定，
          //    每一跳都重新过一遍 https + host allowlist。
          //    交给 fetch 的 follow 就没有这道复核了。
          redirect: 'manual',
          signal: ac.signal,
        });
      } catch (e) {
        if (ac.signal.aborted) throw new NetworkError(`${what} 下载超时（${timeoutMs} ms）`);
        // 🔴 **必须带上 `e.cause`。** undici 抛的永远是 `TypeError: fetch failed`，
        //    真因（ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT / ENOTFOUND / 证书错误…）
        //    全在 `cause` 里。只报 message 的话用户看到的就是一句
        //    「fetch failed」—— 什么都定位不了。
        //    2026-09-03 我自己被这句话挡了两轮，最后是手写探针才挖出
        //    UND_ERR_CONNECT_TIMEOUT，进而发现是代理没被认。
        const why = e.cause?.code ?? e.cause?.message ?? e.code ?? '';
        // 🔴 提示要**按当前环境分情形**，不能一句话套所有人。
        //    我第一版无论如何都说「需要 Node ≥ 24」，而在 Node 25 上读者会
        //    合理地认为「我满足了，那问题在别处」—— 一句正确但不适用的话，
        //    比不说更能把人带偏。
        // 🔴 **不按错误码枚举**。2026-09-04 实测：真实现场返回的是 `UND_ERR_SOCKET`，
        //    而我当时枚举的是 TIMEOUT/ECONNREFUSED/ENOTFOUND/EAI_AGAIN —— 提示一个字没打。
        //    undici 的错误码谱系又长又会变（UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT /
        //    ECONNRESET / EPIPE / 证书类…），**枚举注定漏**。
        //    判据换成：**走到这里就是取不到字节**，那时告诉用户「怎么走网络」总是有用的。
        let hint = '';
        {
          const major = Number(process.versions.node.split('.')[0]);
          const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
            .some((k) => process.env[k]);
          if (hasProxyEnv && major < 24) {
            hint = `\n  你配了代理，但代理支持需要 Node ≥ 24（当前 ${process.version}）。`
              + '\n  可以先在能直连的网络里跑一次把缓存热起来，之后 --offline 可用。';
          } else if (hasProxyEnv && process.env.NODE_USE_ENV_PROXY === '0') {
            hint = '\n  你配了代理，但显式设了 NODE_USE_ENV_PROXY=0 —— CLI 因此没走代理。';
          } else if (!hasProxyEnv) {
            // 🔴 **系统代理不等于环境变量。** Clash / Surge / 公司 VPN 客户端
            //    通常只写 macOS 的系统代理设置，而 **Node 的内建 fetch 不读它**
            //    （curl 和浏览器读，所以「浏览器能开 github」不能证明 CLI 能）。
            //    2026-09-04 用户就是这么撞上的：一句「设置 HTTPS_PROXY」
            //    对一个「我明明挂着代理」的人来说，读起来像是答非所问。
            hint = '\n  连不上 —— 无法访问 github.com。'
              + '\n  ⚠️ 如果你在用 Clash / Surge / VPN 客户端：它们通常只设**系统代理**，'
              + '\n     而 Node 不读系统代理（curl 和浏览器读，所以浏览器能打开不算数）。'
              + '\n     要显式导出环境变量：'
              + (process.platform === 'darwin'
                ? '\n       scutil --proxy | grep -iE "HTTPSProxy|HTTPSPort"   # 看端口'
                  + '\n       export HTTPS_PROXY=http://127.0.0.1:<端口>'
                : '\n       export HTTPS_PROXY=http://<host>:<port>')
              + '\n  （NO_PROXY 也会被尊重。代理支持需要 Node ≥ 24，当前 '
              + process.version + '。）';
          } else {
            hint = '\n  代理已配置且已启用，但仍然连不上 —— 请检查代理本身是否可达。';
          }
        }
        throw new NetworkError(`${what} 下载失败：${e.message}${why ? `（${why}）` : ''}${hint}`);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.('location');
        if (!loc) throw new NetworkError(`${what} 回了 HTTP ${res.status} 却没给 location`);
        if (hop >= maxRedirects) {
          throw new NetworkError(`${what} 重定向超过 ${maxRedirects} 跳，放弃`);
        }
        // 相对 location 也要能处理；解析基准是当前这一跳的地址
        const next = new URL(loc, current).toString();
        // 🔴 每一跳都复核。跳转目标允许带 query（GitHub 的签名参数在那里），
        //    但 https 与 host allowlist 一步都不能少。
        assertDownloadUrl(next, redirectHosts, { isRedirect: true });
        current = next;
        continue;
      }

      if (!res.ok) throw new NetworkError(`${what} 下载失败：HTTP ${res.status}`);
      return await readCapped(res, cap, what);
    }
  } finally {
    clearTimeout(timer);
  }
}
