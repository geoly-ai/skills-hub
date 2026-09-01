// 上报通道。🔴 硬约束：
//   1. 只发已过 assertValidEvent 的事件，出网前**再校验一遍**（纵深防御）
//   2. 端点必须是 https。**有内置默认端点**（2026-09-01 用户拍板：上报默认开），
//      默认值与用户配的值走**同一套**校验，见 DEFAULT_ENDPOINT
//   3. 失败不影响主命令：任何异常都吞掉，事件留在本地等下次
//   4. `--offline` 一票否决，连请求都不构造
import {
  existsSync, readFileSync, appendFileSync, openSync, closeSync,
  mkdirSync, renameSync, unlinkSync, linkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  stateDir,
  readAll,
  uploadEnabled,
  offline,
  assertValidEvent,
  isValidEvent,
  serializeEvent,
  lockPath,
  appendDurable,
  noticeShown,
  claimAutoUploadSlot,
} from './telemetry.mjs';
import { acquire, LockBusyError } from './lock.mjs';
// parseStrict 而非内建 parse：重复 key 会被静默取最后一个
import { writeAtomic } from './atomic-fs.mjs';
import { parseStrict } from './canonical-json.mjs';

const sendingPath = () => join(stateDir(), 'telemetry', 'sending.ndjson');
const queuePath = () => join(stateDir(), 'telemetry', 'queue.ndjson');
const prevQueuePath = () => join(stateDir(), 'telemetry', 'queue.1.ndjson');
/** 已发出、等下一轮再删的墓碑；readAll 也读它，晚到的 append 不会丢 */
const tombPath = () => join(stateDir(), 'telemetry', 'sending.tomb.ndjson');
/** 墓碑在 retire 结束时的字节长度。之后再长出来的都是晚到的、没发过的。 */
const tombMarkPath = () => join(stateDir(), 'telemetry', 'sending.tomb.mark');

/**
 * 🔴 内置默认端点 —— **2026-09-01 用户拍板：上报默认开。**
 *
 * 这一条直接推翻了规格 v4 §4 那句「没有内置默认端点」（原文称它是"本规格最强的
 * 一条保证"）。规格已同步改成实话，见 00-spec.md §4 与变更记录 v5。
 *
 * 换来的：数据真的会回来 —— 「哪些 skill 在被用、装失败集中在哪」这三个问题
 * （§1）在「默认不发」下的实际答案是"没有数据"。
 * 代价：默认值就是"没人配也会出网"，T-11（源 IP + install_id 时间线）从
 * "配端点的人自负其责"变成**我们替所有人默认承担**。
 * 因此默认开与两件事捆死，缺一不可：
 *   ① 首次运行显眼告知（telemetry.mjs 的 maybeNoticeUpload）
 *   ② 端点侧不记 IP / UA，且这条约束要落到前置代理（server/index.mjs 的部署约束）
 *
 * 🔴 **这个值 2026-09-01 由用户确认**（此前是占位 `telemetry.geoly.ai`）。
 *    端点走 Vercel 项目 `skills-hub-telemetry`（与 registry 浏览站是**两个**项目 ——
 *    站点在有制品时会切到 `output: 'export'`，而静态导出不支持 API 路由，
 *    共用的话端点会在第一个制品发布那天消失）。
 *
 * ⚠️ **域名在端点真正部署之前是解析不到的。** 那时每次自动上报都会静默失败，
 *    事件留在本地队列等下次 —— 这正是设计要的那一侧（失败不打扰用户），
 *    但也意味着**没人会注意到端点没上线**。上线后请用
 *    `skills-hub telemetry flush` 手动验一次通路。
 */
export const DEFAULT_ENDPOINT = 'https://skills-hub-telemetry.vercel.app/v1/events';

export function endpoint() {
  const raw = process.env.GEOLY_TELEMETRY_ENDPOINT;
  // 🔴 空串**不是**"关掉上报"，是配置错误：
  //    部署模板漏填变量最常见的形态就是空串，把它当"静默关闭"会让整片机器
  //    悄无声息地不上报，而没有任何人会注意到。要关上报有明确的开关
  //    （GEOLY_TELEMETRY_UPLOAD=0），不要给同一件事第二个隐式入口。
  if (raw !== undefined && raw.trim() === '') {
    throw new Error('telemetry: GEOLY_TELEMETRY_ENDPOINT 被设成空值 —— 要关上报请用 GEOLY_TELEMETRY_UPLOAD=0');
  }
  // 未配置 = 用内置默认（默认开）。**默认值走同一套校验**，不给它开后门。
  const eff = raw ?? DEFAULT_ENDPOINT;
  let u;
  try { u = new URL(eff); } catch { throw new Error('telemetry: 上报端点不是合法 URL'); }
  // 用 URL 解析而不是 startsWith：`https:/\evil` 之类的写法能骗过前缀判断
  if (u.protocol !== 'https:') throw new Error('telemetry: 上报端点必须是 https');
  // URL 里的凭据会随重定向和日志一起泄漏
  if (u.username || u.password) throw new Error('telemetry: 上报端点不得内嵌凭据');
  return u.toString();
}

/** 端点是不是内置默认值（`telemetry status` 要把这件事显式说出来） */
export const isDefaultEndpoint = () => process.env.GEOLY_TELEMETRY_ENDPOINT === undefined;

/**
 * 校验服务端的 ACK。
 *
 * 🔴 「HTTP 2xx」不足以证明**服务端收下了这一批**。中间的代理、登录墙、
 *    错误页都可能回 200 + 一段 HTML；照着 2xx 就 retire，等于把本地队列
 *    消费掉换来一个没人收到的批次 —— 静默丢事件。
 *
 * 判据：body 能解析成 ack 信封，且 `accepted + duplicate + rejected` 恰好等于
 * 这一批的条数。`rejected > 0` **仍然 retire**：那是服务端**永久**拒收的事件，
 * 重发一万次也是同一个结果，留着只会让这批永远卡住（§5.2.3）。
 *
 * ⚠️ 拿不到 body（`res.text` 不是函数）时退回「2xx 即成功」。
 *    **任何真实的 HTTP 栈返回的 Response 都有 `text()`**，所以走到这条退路
 *    只可能是调用方注入了一个测试替身 —— 生产路径（`globalThis.fetch`）到不了这里。
 *    ⚠️ 这条退路仍然是个**已知的宽口**：写出来是因为默认沉默地放行比说清楚糟。
 *
 * 🔴 body 的读取也在同一个 `AbortController` 的超时里（调用方在 ackOk 之后才
 *    clearTimeout）：一个端点可以只回 header 然后**永远不发 body**，
 *    那会让 flush 无限挂着、并且一直**持有上报锁**——违反 T-5。
 */
const MAX_ACK_BYTES = 64 * 1024;

async function ackOk(res, n) {
  if (typeof res.text !== 'function') return true;
  // ACK 只有几十个字节；声明得比这大得多的一律不读
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ACK_BYTES) return false;
  let body;
  try { body = await res.text(); } catch { return false; }
  if (body.length > MAX_ACK_BYTES) return false;
  let ack;
  try { ack = parseStrict(body); } catch { return false; }
  if (!ack || typeof ack !== 'object' || ack.schema !== 'geoly.skills.telemetry-ack/1') return false;
  const nums = [ack.accepted, ack.duplicate, ack.rejected];
  if (!nums.every((v) => Number.isInteger(v) && v >= 0)) return false;
  return ack.accepted + ack.duplicate + ack.rejected === n;
}

/**
 * 把一代队列提升为 sending。**只有一次 rename，没有复制、没有 unlink。**
 *
 * 🔴 早先这里是「rename 成 *.staged → 读出来 → append 进 sending → unlink staged」。
 *    Codex 2026-08-26 第三轮指出它有两个 P0：
 *      · 旧 queue fd 在我们读完 `.staged` 之后才 append，随后的 unlink 把那行
 *        连同 inode 一起带走 —— 既不在 sending 也不在任何队列文件里
 *      · 残留的 `queue.1.ndjson.staged` 与新生成的 `queue.1.ndjson` 同时存在时，
 *        下一轮 rename 会**原子覆盖**掉旧的 `.staged`，直接丢掉整批旧事件
 *
 *    两个问题都源自那个中间文件。去掉它：直接 rename 成 sending。
 *    rename 不会让任何 inode 失去目录项，晚到的 append 落进 sending，
 *    retire 按 eid 判就能把它退回队列。
 *
 * 代价：同一时刻只允许一个批次在途。sending 还在（上一轮没发成功）时，
 * 这一轮就只发 sending，不再往里并新数据 —— 更简单，也更容易讲清楚。
 */
function stage() {
  // 旧墓碑收割不掉就不能往下走：后面的 rename(sending → tomb) 会覆盖它。
  // 宁可这一轮不发，也不要覆盖一个还没收割干净的文件。
  if (!reapTomb()) return false;

  if (existsSync(sendingPath())) return true; // 上一轮的残留，先把它发完
  // 先老后新：queue.1 是上一代
  for (const p of [prevQueuePath(), queuePath()]) {
    if (!existsSync(p)) continue;
    // 🔴 用 link + unlink 而不是 rename：rename 会**静默覆盖**已存在的 sending，
    // 一旦覆盖就是整批消失。link 在目标已存在时报 EEXIST，是原子的 no-replace。
    // 崩在 link 与 unlink 之间只会让同一批同时出现在 queue 和 sending，
    // 下一轮按 eid 去重即可 —— 又是「宁可重复，不可丢失」。
    try {
      linkSync(p, sendingPath());
    } catch { continue; }
    try { unlinkSync(p); } catch { /* 下一轮 readAll 会按 eid 去重 */ }
    return true;
  }
  return false;
}

/** 读某个队列文件里合规的事件 */
function readEvents(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = parseStrict(line); } catch { continue; }
    if (!isValidEvent(ev) || seen.has(ev.eid)) continue;
    seen.add(ev.eid);
    out.push(ev);
  }
  return out;
}

/**
 * 发成功后清理 sending。
 *
 * 🔴 不能无脑 unlink：可能有 record 拿着 stage 之前打开的 fd，在我们读完之后
 * 才把一行追加进这个 inode。所以重读一遍，**只丢已发出去的那些 eid**，
 * 剩下的追加回 queue，最后才删 sending。
 */
function retire(sentEids) {
  // 顺序要紧：**先**把未发出的 append 回 queue，**再**动 sending。
  // 崩在中间只会留下重复（下轮按 eid 去重），倒过来则会丢。
  sweepBackToQueue(sendingPath(), sentEids);

  // 🔴 **不 unlink**，改成改名成墓碑，下一轮 flush 开头才真删。
  //
  // 为什么：`record` 的 nlink 检查是 TOCTOU 的 —— 它能发现「已经被删了」，
  // 但发现不了「fstat 之后、close 之前才被删」（Codex 2026-08-26 第四轮指出）：
  //     retire: 读完 sending
  //     record: 往 stage 之前打开的旧 fd 追加（nlink 仍是 1）
  //     record: fstat 看到 nlink = 1，认为安全
  //     retire: unlink(sending)          ← 那一行随 inode 一起消失
  //
  // rename 不会让 inode 失去目录项，所以晚到的 append 仍落在墓碑里。
  let renamed = false;
  try { renameSync(sendingPath(), tombPath()); renamed = true; } catch { /* 没了就算了 */ }

  // 改名之后再扫一次：读 sending 与改名之间落进来的那些，现在能在墓碑里看到。
  // 这一遍把窗口从「每次 flush 都有的微秒级」压到「fd 要跨越一整个 flush 周期」。
  // ⚠️ 是**压缩**不是消灭 —— 见规格 §6 的 T-15。
  if (renamed) {
    sweepBackToQueue(tombPath(), sentEids);
    // 记下此刻的长度：之后再长出来的都是晚到的，由下一轮的 reapTomb 捞回
    try { writeAtomic(tombMarkPath(), String(statSync(tombPath()).size) + '\n'); } catch { /* 下轮从 0 起算 */ }
  }
  return renamed;
}

/**
 * 处理上一轮的墓碑，然后删掉它。
 *
 * 🔴 **不能直接 unlink。** 墓碑在 retire 扫完之后还可能长出新行（旧 fd 晚到的
 * append），直接删就把它们带走了 —— 这和早先 `*.staged` 被同名 rename 覆盖
 * 是同一类错误：**任何要删除的文件，先问一句「它自这次记账以来长过吗」。**
 *
 * 靠 `sending.tomb.mark` 里记的字节长度区分：mark 之前的是已发出的，
 * 之后的是晚到的。墓碑是**只追加、从不重写**的，所以字节偏移在这里是稳定的
 * ——「位置游标不可靠」那条教训针对的是会被重写的文件，不适用于此。
 */
function reapTomb() {
  let text;
  try {
    text = readFileSync(tombPath(), 'utf8');
  } catch (err) {
    // 🔴 「读不了」不等于「不存在」。只有 ENOENT 才是真的没有墓碑；
    // 其它错误（EISDIR、EACCES…）说明那里有个我们收割不了的东西 —— fail-closed。
    return err?.code === 'ENOENT';
  }
  let mark = 0;
  try { mark = Number(readFileSync(tombMarkPath(), 'utf8').trim()) || 0; } catch { /* 当作 0 */ }
  // mark 读不到就从 0 起算：整批重发（服务端按 eid 去重），比漏掉晚到的安全
  const late = Buffer.from(text, 'utf8').subarray(mark).toString('utf8');
  const events = [];
  for (const line of late.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = parseStrict(line); } catch { continue; }
    if (isValidEvent(ev)) events.push(ev);
  }
  if (events.length) appendToQueue(events);
  // 删不掉就 fail-closed：调用方会因此跳过这一轮 retire。
  // 否则后面的 rename(sending → tomb) 会覆盖掉这个还没收割干净的墓碑。
  try { unlinkSync(tombPath()); } catch { return false; }
  try { unlinkSync(tombMarkPath()); } catch { /* mark 残留无害：下轮从 0 起算 */ }
  return true;
}

/**
 * 🔴 必须走 `appendDurable`，不能裸 `openSync` + append。
 *
 * `record()` 的追加一直有 nlink 守卫（写完查 inode 是否已被删、中招就换新 fd 重写），
 * 而这条「把 leftover 扫回队列」的补偿路径原先没有 ——
 * **同一个不变量，两条路径两种强度**。
 *
 * 它偏偏跑在 flush 的收尾阶段：此时另一个进程的 record 完全可能正在触发换代，
 * 把队列 inode 改名或删掉，于是扫回去的事件写进一个没有目录项的 inode，**静默消失**。
 *
 * CI 的 Linux runner 在压力测试里抓到过一条丢失（本机 macOS 六轮不复现）。
 * ⚠️ 判据：**同一个不变量的所有写入路径必须用同一种强度的保证**，
 * 不能主路径有守卫、补偿路径没有 —— 补偿路径往往正好跑在最危险的时刻。
 */
function appendToQueue(events) {
  appendDurable(queuePath(), events.map((e) => serializeEvent(e) + '\n').join(''));
}

/** 把 path 里不属于 sentEids 的事件追加回 queue */
function sweepBackToQueue(path, sentEids) {
  const leftover = readEvents(path).filter((e) => !sentEids.has(e.eid));
  if (leftover.length) appendToQueue(leftover);
}

/**
 * 返回 {sent, skipped, reason?}；绝不抛错到调用方之外。
 *
 * 交付语义是 **at-least-once**：POST 成功、retire 之前崩溃会重发，
 * 服务端按 eid 去重。反过来（先清 sending 再发）会**丢事件**，那更糟。
 */
export async function flush({ fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  let release = null;
  try {
    if (offline()) return { sent: 0, skipped: true, reason: 'offline' };
    if (!uploadEnabled()) return { sent: 0, skipped: true, reason: 'upload-disabled' };
    // 🔴 顺序要紧：offline / upload-disabled 在**取端点之前**判完，
    //    所以两个开关任一置位时连端点都不解析，更不构造请求。
    let url;
    try {
      url = endpoint();
    } catch (e) {
      // 端点配错了要说出来，不能静默不发（默认开之后，"不发"必须是有人明确要求的）
      return { sent: 0, skipped: true, reason: 'bad-endpoint', detail: e.message };
    }

    // 🔴 stage 与 retire 必须在同一把锁下，否则两个 flush 会各 stage 一半、重复上报。
    // 锁是内核释放的，进程猝死也不留死锁。
    mkdirSync(join(stateDir(), 'telemetry'), { recursive: true });
    try {
      release = acquire(lockPath());
    } catch (e) {
      if (e instanceof LockBusyError) return { sent: 0, skipped: true, reason: 'busy' };
      throw e;
    }

    if (!stage()) return { sent: 0, skipped: true, reason: 'empty' };
    const pending = readEvents(sendingPath());
    if (!pending.length) {
      try { unlinkSync(sendingPath()); } catch { /* 空文件，删掉就好 */ }
      return { sent: 0, skipped: true, reason: 'empty' };
    }
    // 纵深防御：readSending 已经滤过一遍，这里在真正出网前再确认一次
    for (const e of pending) assertValidEvent(e);

    const ac = new AbortController();
    // 🔴 这个超时要覆盖到**读完 ACK 为止**，不能在 fetch 一返回就 clear：
    //    header 回来了、body 永不到达的端点会让 flush 无限挂着，而且它这时
    //    **正持有上报锁** —— 后面每一次 flush 都会 busy。（T-5）
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        signal: ac.signal,
        // 🔴 默认的 redirect:'follow' 会让恶意 https 端点用 307/308 把带事件的
        // POST 转到 http:// —— 那就绕过了「只允许 https」。禁止重定向。
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        // 手写序列化，理由同 serializeEvent：不给 toJSON 污染留口子
        body: `{"schema":"geoly.skills.telemetry-batch/1","events":[${pending.map(serializeEvent).join(',')}]}`,
      });

      // 发失败：sending 原样留着，下一轮接着发，一条都不丢
      if (res.redirected) return { sent: 0, skipped: true, reason: 'redirect-refused' };
      if (!res.ok) return { sent: 0, skipped: true, reason: `http-${res.status}` };
      // 2xx 还不够 —— 必须是我们认识的 ACK，且条数对得上（见 ackOk）。
      // 🔴 在 clearTimeout **之前**读，否则读 body 这一步没有超时可言。
      if (!await ackOk(res, pending.length)) return { sent: 0, skipped: true, reason: 'bad-ack' };
    } finally { clearTimeout(t); }

    // 清理失败要说出来：sending 删不掉会导致同一批被无限重发
    const cleaned = retire(new Set(pending.map((e) => e.eid)));
    return cleaned
      ? { sent: pending.length, skipped: false }
      : { sent: pending.length, skipped: false, reason: 'sending-not-cleaned' };
  } catch (err) {
    return { sent: 0, skipped: true, reason: `error:${err?.name ?? 'unknown'}` };
  } finally {
    try { release?.(); } catch { /* 释放失败不该盖掉上面的返回值 */ }
  }
}

/** 诊断用：还有多少条没发出去 */
export const pendingCount = () => readAll().length;

// ─────────────────────────────────────────────────────────────────────────────
// 自动上报（规格 §5.1.1；2026-09-01 用户拍板）
//
// 🔴 为什么要有它：上报默认开（§4.2），但**只在显式 `telemetry flush` 时才发** ——
//    而没有普通用户会去跑那条命令。于是我们承担了「默认出网」的全部隐私代价，
//    却一条数据都拿不到。这是两头都不占的形态，比「默认关」还差。
//
// 🔴 为什么是这个形状（而不是「每条命令都发」）：出网时机从「用户主动」变成
//    「用户无感」，所以每一处都往最保守的一侧压 ——
//      · 只有 install，且**成功收尾**（失败的安装不该再替用户付一次网络代价）
//      · 24 小时最多一次（§5.1.1 说明为什么是 24）
//      · 超时 1 秒，不是 flush 的 3 秒
//      · 完全静默：不打印、不改退出码、不抛错
//      · 两个否决（`--offline` / `GEOLY_TELEMETRY_UPLOAD=0`）照旧一票否决
//      · **首次告知没打过就不发**（noticeShown 这道门）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 自动上报的超时：**1 秒**，不是 flush 默认的 3 秒。
 *
 * 显式 flush 是用户主动等的，3 秒可以；自动上报挂在 install 的收尾上，
 * 那 3 秒是**用户没要求、也不知道自己在等**的 3 秒。1 秒是「慢网也够一个
 * 几 KB 的 POST 走完一趟」与「安装最坏被拖多久」之间的取舍。
 *
 * ⚠️ **它是「网络那一段」的上界，不是「install 多花多久」的上界**
 *    （Codex 2026-09-01 指出，原先这里写成了后者 —— 那是夸大）。
 *    计时器只在 `fetch` 之前才起、ACK 读完就 clear；在它之前还有一串**同步 I/O**：
 *    认领节流戳（`writeAtomic` 会 fsync 文件与父目录）、取上报锁（SQLite）、
 *    `stage()` / `reapTomb()` 的读写与 rename。正常盘上这些是毫秒级，
 *    但慢盘、NFS（T-16）、或一个收割不掉的墓碑都能让它更久，**没有硬上界**。
 *    要给 install 一个真正的时延上界，得给这串本地 I/O 也加超时 —— 那是另一件事，
 *    这里不假装已经做了。
 *
 * ⚠️ 1 秒**不产生新的丢事件面**，只是把结果从「发出去了」挪到「没发出去、下次再发」：
 *    超时触发 abort → fetch 抛 / ackOk 返回 false → `sending` 原样留在盘上
 *    → 下一轮接着发。哪怕服务端**已经 durable 了**只是 ACK 没赶回来，也只是
 *    重发一次、服务端按 `eid` 判成 duplicate（§5.2.2 的 at-least-once）。
 *    真正的代价见规格 §5.1.1「代价」第 4 条：端点**持续**慢到发不出去时，
 *    卡住的批次不动，而新事件会随换代被淘汰（§5.2.3）—— 那一格本来就存在，
 *    1 秒只是让它更容易被触发。
 */
export const AUTO_UPLOAD_TIMEOUT_MS = 1000;

/**
 * install 成功收尾后调用。**绝不抛错、绝不打印、绝不影响退出码。**
 *
 * 🔴 一次成功的 install 不能因为埋点而看起来像失败了 —— 所以这里没有任何
 *    输出通道，返回值只给测试和诊断用，调用方（cli.mjs）拿到之后什么都不做。
 *
 * @returns {Promise<{ran: boolean, reason?: string, result?: object}>}
 */
export async function maybeAutoUpload({ fetchImpl, timeoutMs = AUTO_UPLOAD_TIMEOUT_MS, now } = {}) {
  try {
    // 🔴 顺序要紧，三道门都在**认领名额之前**：
    //    ① 两个否决置位时连节流戳都不该写（`GEOLY_TELEMETRY=0` 承诺的是
    //       「本地一个字节都不写」，写个戳就是违约）；
    //    ② 告知没打过就一律不发 —— 见下。
    if (!uploadEnabled()) return { ran: false, reason: 'upload-disabled' };

    // 🔴 **首次告知必须先于任何一次自动上报。** 顺序反了就是「先发了再告诉你」，
    //    那比不告知更糟。cli.mjs 里 noticeOnce 排在命令分发之前，本来就先于这里；
    //    但那只是**调用顺序**，挪一行代码就能悄悄反过来。这道门是本地判据，
    //    不依赖谁在什么位置调我。
    if (!noticeShown()) return { ran: false, reason: 'notice-not-shown' };

    if (!claimAutoUploadSlot(now ?? Date.now())) return { ran: false, reason: 'throttled' };

    const result = await flush({ fetchImpl: fetchImpl ?? globalThis.fetch, timeoutMs });
    return { ran: true, result };
  } catch (err) {
    // flush 自己已经吞掉一切异常，走到这里只可能是三道门自身出了岔子。
    // 静默的含义就是这个：埋点的任何问题都不许冒泡到主命令（T-5）。
    return { ran: false, reason: `error:${err?.name ?? 'unknown'}` };
  }
}
