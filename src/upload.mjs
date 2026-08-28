// 上报通道。🔴 硬约束：
//   1. 只发已过 assertValidEvent 的事件，出网前**再校验一遍**（纵深防御）
//   2. 端点必须是 https，且必须由 GEOLY_TELEMETRY_ENDPOINT 显式给出 —— 没配就是纯本地
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

export function endpoint() {
  const raw = process.env.GEOLY_TELEMETRY_ENDPOINT;
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { throw new Error('telemetry: 上报端点不是合法 URL'); }
  // 用 URL 解析而不是 startsWith：`https:/\evil` 之类的写法能骗过前缀判断
  if (u.protocol !== 'https:') throw new Error('telemetry: 上报端点必须是 https');
  // URL 里的凭据会随重定向和日志一起泄漏
  if (u.username || u.password) throw new Error('telemetry: 上报端点不得内嵌凭据');
  return u.toString();
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
    const url = endpoint();
    if (!url) return { sent: 0, skipped: true, reason: 'no-endpoint' };

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
    } finally { clearTimeout(t); }

    // 发失败：sending 原样留着，下一轮接着发，一条都不丢
    if (res.redirected) return { sent: 0, skipped: true, reason: 'redirect-refused' };
    if (!res.ok) return { sent: 0, skipped: true, reason: `http-${res.status}` };

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
