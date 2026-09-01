// 上报端点的 HTTP 面 —— 规格 docs/telemetry/00-spec.md §5。
//
// 🔴 三条贯穿全文的硬约束：
//   1. **输入一律当敌意的。** 端点公开可访问且按 §5.3 不做鉴权，
//      body、header、method、路径全部由攻击者控制。
//   2. **不记 IP、不记 User-Agent 原文**（§5.3）。这里连读都不读它们 ——
//      读了就迟早会有人顺手写进日志。
//   3. **响应不回显任何输入。** 回显是最省事的调试手段，也是最省事的反射型注入面。
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ACK_SCHEMA, BadBatchError, MAX_BODY_BYTES, parseBatch } from './validate.mjs';
import { StoreFullError } from './store.mjs';
import { summarize } from './aggregate.mjs';

/** 事件接收路径。查询路径是 `/v1/summary`。 */
export const INGEST_PATH = '/v1/events';
export const SUMMARY_PATH = '/v1/summary';

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 端点不给浏览器用，也不该被别的站点从页面里 POST
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * 读请求体，**带两道字节闸**。
 *
 * 🔴 只看 `Content-Length` 是不够的：它可以撒谎，chunked 编码下根本没有这个头。
 *    所以① 有 Content-Length 且超限就立刻拒（省掉白读几 MB），
 *    ② 无论如何都边读边累计真实字节数，超了就 destroy 掉连接。
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // 声明就超限的，一个字节都不往内存里放；但**照样把连接读完再回 413** ——
    // 提前 destroy 会让客户端拿到网络错误而不是 413（实测：ECONNRESET），
    // 它于是不知道「这批永远发不出去」，只会一直重试同一批。
    let over = Number.isFinite(Number(req.headers['content-length']))
      && Number(req.headers['content-length']) > maxBytes;
    req.on('data', (c) => {
      if (over) return;                      // 已经判超限：只丢弃，不缓冲
      size += c.length;
      if (size > maxBytes) {
        // 🔴 超限之后**停止缓冲**（内存上界就在这里），但**不 destroy**：
        //    连接一断，客户端拿到的是网络错误而不是 413，它无从知道
        //    「这批永远发不出去」，只会一直重试同一批。先把话说清楚。
        //    ⚠️ 早先这里在 8 倍处 destroy，于是最该收到 413 的那种请求
        //    反而收不到 —— 两条路径给同一个输入两种结果，是个不该有的分叉。
        //    灌流量由别的闸兜：内存有上界（这里）、单连接时长有 requestTimeout、
        //    并发有 maxInFlight。
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) { reject(new BadBatchError('too-large')); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => reject(e));
    req.on('aborted', () => reject(new BadBatchError('aborted')));
  });
}

/**
 * 定长比较 Bearer token。
 * `===` 是短路的，逐字节的耗时差足以把 token 猜出来；长度不等时也要走一次
 * 比较，否则「长度对不对」本身就是一个可测的信号。
 */
function bearerMatches(header, token) {
  const want = Buffer.from(`Bearer ${token}`, 'utf8');
  const got = Buffer.from(typeof header === 'string' ? header : '', 'utf8');
  const padded = Buffer.alloc(want.length);
  got.copy(padded, 0, 0, Math.min(got.length, want.length));
  return timingSafeEqual(want, padded) && got.length === want.length;
}

/** `application/json`，允许带参数（`; charset=utf-8`），别的一律 415。 */
function jsonContentType(raw) {
  if (typeof raw !== 'string') return false;
  return raw.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * 造一个 node `http` 的请求处理器。
 *
 * @param {object} opts
 * @param {object} opts.store        TelemetryStore（见 store.mjs）
 * @param {number} [opts.maxBodyBytes]
 * @param {number} [opts.maxInFlight] 并发上限；超了回 503，客户端会把这批留在本地
 * @param {number} [opts.ratePerSec]  全局速率上限；超了回 429
 * @param {() => number} [opts.now]
 * @param {string|null} [opts.summaryToken] 设了它，`/v1/summary` 才需要 Bearer；
 *        默认 null = 关闭聚合查询（**默认不对外暴露聚合面**）
 */
export function createHandler({
  store,
  maxBodyBytes = MAX_BODY_BYTES,
  maxInFlight = 64,
  ratePerSec = 200,
  now = () => Date.now(),
  summaryToken = null,
} = {}) {
  let inFlight = 0;
  // 🔴 令牌桶。**无鉴权 ≠ 接受被打满**（§5.3 接受的是「数据可被污染」，
  //    不是「资源可被耗尽」）。这是应用层的最后一道；前置代理还应各有一道。
  let tokens = ratePerSec;
  let refilledAt = now();

  function takeToken() {
    const t = now();
    tokens = Math.min(ratePerSec, tokens + ((t - refilledAt) / 1000) * ratePerSec);
    refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  return async function handle(req, res) {
    // 🔴 这里**故意不读** req.socket.remoteAddress 与 req.headers['user-agent']：
    //    §5.3 不允许记录它们，而「先读进变量、以后再说」正是它们进日志的方式。
    const path = (req.url ?? '').split('?')[0];

    if (path === SUMMARY_PATH) return handleSummary(req, res);
    if (path !== INGEST_PATH) return send(res, 404, { error: 'not-found' });
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method-not-allowed' }, { allow: 'POST' });
    }
    if (!jsonContentType(req.headers['content-type'])) {
      return send(res, 415, { error: 'unsupported-media-type' });
    }
    if (!takeToken()) return send(res, 429, { error: 'rate-limited' }, { 'retry-after': '10' });
    if (inFlight >= maxInFlight) {
      return send(res, 503, { error: 'busy' }, { 'retry-after': '10' });
    }

    inFlight++;
    try {
      const text = await readBody(req, maxBodyBytes);
      const { events, rejected } = parseBatch(text);
      // put 先落盘 fsync 再返回 —— ACK 出去就意味着「收下了」，见 store.mjs
      const { accepted, duplicate } = await store.put(events, now());
      // 🔴 只回计数，不回显任何输入（连被拒事件的 eid 都不回）
      return send(res, 200, {
        schema: ACK_SCHEMA, accepted, duplicate, rejected,
      });
    } catch (err) {
      if (err instanceof BadBatchError) {
        // code 是我们自己的有限代码表，不含任何用户输入。
        // 超限时带 `connection: close`：后面还可能有没读完的 body，
        // 复用这条连接会让下一个请求读到上一个的残余字节。
        return send(res, err.code === 'too-large' ? 413 : 400, { error: err.code });
      }
      if (err instanceof StoreFullError) {
        return send(res, 503, { error: 'store-full' }, { 'retry-after': '3600' });
      }
      // 🔴 内部错误**不带出任何细节**（栈里有路径，消息里可能有输入片段）。
      //    给一个随机 id，运维在自己的日志里对得上就够了。
      const ref = randomUUID();
      console.error(`[telemetry-server] ${ref}`, err);
      return send(res, 500, { error: 'internal', ref });
    } finally {
      inFlight--;
    }
  };

  async function handleSummary(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' }, { allow: 'GET' });
    // 摄入面无鉴权是 §5.3 明示接受的；**读出面不是**。
    // 没配 token 就直接关掉，别让「忘了配」变成「谁都能拉走全量聚合」。
    if (!summaryToken) return send(res, 404, { error: 'not-found' });
    if (!bearerMatches(req.headers.authorization, summaryToken)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    const rollup = await store.rollup();
    const records = await store.all();
    // 🔴 只 fold 水位**之后**的记录。`prune` 是「先写 rollup、再重写日志」，
    //    崩在中间时日志里会留着一批**已经折算过**的记录；不按水位过滤就会双计。
    const cutoff = Number.isFinite(rollup?.cutoff) ? rollup.cutoff : 0;
    const live = records.filter((r) => r.received_at >= cutoff).map((r) => r.event);
    return send(res, 200, summarize(live, rollup));
  }
}
