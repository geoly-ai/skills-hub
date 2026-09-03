// download.mjs：取字节层。它**不做校验**，所以这里测的全是「传输本身的坏情形」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { download, assertDownloadUrl, MAX_DOWNLOAD_BYTES, REDIRECT_HOSTS } from '../src/download.mjs';

const HOST = 'example.test';
const OK = 'https://example.test/a.json';

/** 造一个只有 arrayBuffer 的响应（测试替身路径） */
const resBuf = (buf, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => buf,
});

/** 造一个流式响应，chunks 逐块吐 */
function resStream(chunks, { status = 200, headers = {} } = {}) {
  let i = 0;
  let cancelled = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    get cancelled() { return cancelled; },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => { cancelled = true; },
      }),
    },
  };
}

test('https 之外一律拒绝 —— 用 URL 解析而不是前缀判断', () => {
  for (const bad of ['http://example.test/a', 'file:///etc/passwd', 'ftp://x/y']) {
    assert.throws(() => assertDownloadUrl(bad, HOST), /必须是 https|不是合法 URL/, bad);
  }
});

test('🔴 反斜杠改道：protocol 查得过，host 查不过', () => {
  // 实测：`https:/\evil.test/a` 被 WHATWG 规范化成 `https://evil.test/a`。
  // protocol === 'https:'、无凭据 —— **只查协议的实现会当场放行**。
  const sneaky = 'https:/\\evil.test/a';
  assert.equal(new URL(sneaky).protocol, 'https:', '前提：它确实是合法 https URL');
  assert.equal(new URL(sneaky).host, 'evil.test', '前提：但 host 已经被换掉了');
  assert.throws(() => assertDownloadUrl(sneaky, HOST), /host 是 evil\.test.*不在允许列表/);
});

test('🔴 不传 expectHost 直接拒绝 —— 不给「忘了钉 host」留默认放行的路', () => {
  assert.throws(() => assertDownloadUrl(OK), /必须传 expectHost/);
});

test('地址里内嵌凭据要拒 —— 它会随日志与重定向泄漏', () => {
  assert.throws(() => assertDownloadUrl('https://u:p@example.test/a', HOST), /不得内嵌凭据/);
});

test('🔴 Content-Length 撒谎时，上限仍然按实际读到的字节数生效', async () => {
  // 声称 10 字节，实际吐 3 MiB。只信 Content-Length 的实现会把它全收下。
  const chunk = new Uint8Array(1024 * 1024);
  const res = resStream([chunk, chunk, chunk], { headers: { 'content-length': '10' } });
  await assert.rejects(
    () => download(OK, { host: HOST, cap: 2 * 1024 * 1024, fetchImpl: async () => res }),
    /超过上限/,
  );
  // 而且要**当场断开**，不是读完再抱怨
  assert.equal(res.cancelled, true, '超限后必须 cancel reader，否则字节还在继续流进来');
});

test('Content-Length 诚实且超限时，一个字节都不用读', async () => {
  let read = false;
  const res = {
    ok: true, status: 200,
    headers: { get: () => String(MAX_DOWNLOAD_BYTES + 1) },
    body: { getReader: () => { read = true; return { read: async () => ({ done: true }) }; } },
  };
  await assert.rejects(() => download(OK, { host: HOST, fetchImpl: async () => res }), /声称.*超过上限/);
  assert.equal(read, false, '早筛应该在读之前就拦下');
});

test('🔴 跟随重定向到 allowlist 内的 host —— GitHub Release 必然 302', async () => {
  // 2026-09-03 实测的真实形状：
  //   github.com/<repo>/releases/download/<tag>/<file>
  //     → 302 → release-assets.githubusercontent.com/…?sp=r&sig=…&jwt=…
  // ⚠️ 「一次都不跟随」= 一个字节都下不来。我第一版就是那样写的。
  const cdn = `https://${REDIRECT_HOSTS[0]}/blob/x?sp=r&sig=abc&jwt=def`;
  const seen = [];
  const got = await download(OK, {
    host: HOST,
    fetchImpl: async (u) => {
      seen.push(u);
      if (u === OK) return resBuf(Buffer.alloc(0), { status: 302, headers: { location: cdn } });
      return resStream([Buffer.from('bytes')]);
    },
  });
  assert.equal(got.toString('utf8'), 'bytes');
  assert.deepEqual(seen, [OK, cdn], '应当正好跳一次，且落到 CDN');
});

test('🔴 跳转目标允许带查询串，但初始地址不许', () => {
  // GitHub 的签名参数就在 query 里 —— 对跳转目标套「禁 query」会让下载全灭。
  const cdn = `https://${REDIRECT_HOSTS[0]}/blob/x?sig=abc`;
  assert.doesNotThrow(() => assertDownloadUrl(cdn, REDIRECT_HOSTS, { isRedirect: true }));
  assert.throws(() => assertDownloadUrl(`${OK}?a=1`, HOST), /不得带查询串/);
});

test('🔴 跳到 allowlist 之外一律拒绝 —— 包括 http 降级', async () => {
  for (const evil of ['https://evil.test/x', 'http://example.test/x']) {
    await assert.rejects(
      () => download(OK, {
        host: HOST,
        fetchImpl: async () => resBuf(Buffer.alloc(0), { status: 302, headers: { location: evil } }),
      }),
      /不在允许列表|必须是 https/,
      evil,
    );
  }
});

test('重定向跳数有上限 —— 不许被绕成无限循环', async () => {
  const cdn = `https://${REDIRECT_HOSTS[0]}/loop`;
  let n = 0;
  await assert.rejects(
    () => download(OK, {
      host: HOST, maxRedirects: 3,
      fetchImpl: async () => { n += 1; return resBuf(Buffer.alloc(0), { status: 302, headers: { location: cdn } }); },
    }),
    /重定向超过 3 跳/,
  );
  assert.equal(n, 4, '初始 1 次 + 3 跳，然后停');
});

test('3xx 没给 location 要报清楚，不能当成正常响应', async () => {
  await assert.rejects(
    () => download(OK, { host: HOST, fetchImpl: async () => resBuf(Buffer.alloc(0), { status: 302 }) }),
    /没给 location/,
  );
});

test('超时覆盖到读 body —— 慢慢滴字节不能让下载永远挂着', async () => {
  // 🔴 按**真实**流的行为建模：undici 的 body 读取是认 AbortSignal 的，
  //    signal 一 abort，挂起的 read() 就会 reject。
  //    ⚠️ 我第一版把 read() 写成「永不 settle」，结果**测试自己挂死了 2 分钟** ——
  //    那个替身不真实：abort 不会去 reject 一个已经挂起的 promise，
  //    真正让下载不卡死的是流自己认 signal。替身不认，就等于没测到这件事。
  let signal;
  const res = {
    ok: true, status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: () => new Promise((_, rej) => {
        signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
      cancel: async () => {},
    }) },
  };
  const t0 = Date.now();
  await assert.rejects(
    () => download(OK, { host: HOST, fetchImpl: async (_u, opts) => { signal = opts.signal; return res; }, timeoutMs: 50 }),
    (e) => e instanceof Error,
  );
  assert.ok(Date.now() - t0 < 5000, '必须在超时后很快返回，不能挂住');
});

test('正常路径：流式读回完整字节', async () => {
  const res = resStream([Buffer.from('he'), Buffer.from('llo')]);
  const got = await download(OK, { host: HOST, fetchImpl: async () => res });
  assert.equal(got.toString('utf8'), 'hello');
});

test('HTTP 4xx/5xx 报成 NetworkError 且带状态码', async () => {
  await assert.rejects(
    () => download(OK, { host: HOST, fetchImpl: async () => resBuf(Buffer.alloc(0), { status: 404 }) }),
    /HTTP 404/,
  );
});
