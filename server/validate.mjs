// 上报端点的输入校验 —— 规格 docs/telemetry/00-spec.md §5.1 / §5.3。
//
// 🔴 这个文件的前提是一句话：**输入一律当敌意的。**
//    端点将来公开可访问、且按 §5.3 明示不做鉴权，所以任何一个字段都可能是
//    攻击者构造的。「客户端已经校验过」不是理由 —— 客户端根本不在我们手里。
//
// 🔴 事件级校验**复用 src/telemetry.mjs 的 assertValidEvent**，不在这里另写一份。
//    两份校验器必然分叉：加一个字段时改了一边忘了另一边，隐私契约就从宽的那一边漏。
//    采集面的唯一定义在 §2 的那张表，执行点只有 assertValidEvent 一个。
import {
  assertValidEvent, FIELD_NAMES, IDENTITY_FIELD_NAMES, IDENTITY_NOTICE as CURRENT_NOTICE,
  MAX_QUEUE_BYTES, serializeAnonymousEvent,
} from '../src/telemetry.mjs';
import { parseStrict } from '../src/canonical-json.mjs';

export const BATCH_SCHEMA = 'geoly.skills.telemetry-batch/1';
export const ACK_SCHEMA = 'geoly.skills.telemetry-ack/1';

/**
 * 单次请求体上限。
 *
 * 🔴 **它与客户端的队列上限是绑死的，所以从那里推导，不要各写一个字面量。**
 * 客户端一次 flush 发的是**一整代队列**（§5.2 消费式上报），而一代的上限是
 * `MAX_QUEUE_BYTES`（1 MiB）。上限要是设得比它小，那批事件会被 413 顶回来、
 * `sending` 原样留着、下一轮接着发 —— **永久卡死**，而且卡的是老实客户端，
 * 不是攻击者。留 2 倍余量兜住换代边界上多出来的那一行与晚到的 append。
 */
export const MAX_BODY_BYTES = 2 * MAX_QUEUE_BYTES;

/**
 * 单批事件条数上限。按一条事件最短约 200 字节估，1 MiB 装不下 10000 条，
 * 所以这一条实际上不会先于 MAX_BODY_BYTES 触发 —— 它是**第二道**闸：
 * 防的是「几万个 `{}` 这样的极短对象」把解析后的对象数撑爆。
 */
export const MAX_EVENTS = 10_000;

/** 信封级拒绝。带一个稳定的短代码，方便端点侧统计，**不回显任何输入**。 */
export class BadBatchError extends Error {
  constructor(code) {
    super(`telemetry-server: 批次被拒（${code}）`);
    this.name = 'BadBatchError';
    this.code = code;
  }
}

/**
 * 只取白名单里的键，别的**丢弃**（§5.3「多余字段服务端丢弃，不要信客户端」）。
 *
 * 🔴 顺序是「先 pick 再校验」，不是「先校验再 pick」：
 *    assertValidEvent 见到未知键是**抛错**（那对客户端是编程错误，要立刻暴露），
 *    但服务端这一侧的契约是丢弃 —— 一个多塞了字段的客户端不该让整批 400。
 *
 * 🔴 用 `__proto__: null` 建结果对象：输入的键完全由攻击者控制，
 *    往一个带原型的对象上赋值 `__proto__` / `constructor` 会踩到原型链。
 *    这里只从 FIELD_NAMES（我们自己的常量）取键，已经安全；null 原型是第二道。
 *    ⚠️ `JSON.parse('{"__proto__":1}')` 产生的是**自有属性**，不会改原型，
 *    但它不在 FIELD_NAMES 里，走不到下面这个循环。
 */
function pickKnown(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { __proto__: null };
  for (const k of FIELD_NAMES) {
    if (Object.hasOwn(raw, k)) out[k] = raw[k];
  }
  return out;
}

/**
 * 解析并校验一个批次。
 *
 * 返回 `{ events, rejected }`：
 *   · `events` —— 通过 §2 白名单的事件（已按白名单裁过键）
 *   · `rejected` —— 被丢弃的条数
 *
 * 🔴 **单条不合规只丢那一条，不退回整批。** 整批 400 会让一条脏数据把某个客户端的
 *    队列**永久卡死**（`sending` 发不掉就一直重发同一批，§5.2.3）—— 惩罚的是老实
 *    客户端，挡不住攻击者。信封坏才 400：那说明发过来的根本不是我们的协议。
 *
 * @param {string} text 请求体原文
 */
export function parseBatch(text) {
  let body;
  try {
    // parseStrict 而非 JSON.parse：重复 key 会被 JSON.parse 静默取最后一个，
    // 那是一个可以绕过任何「按 key 校验」的口子（canonical-json.mjs 里有详述）。
    body = parseStrict(text);
  } catch {
    throw new BadBatchError('malformed-json');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadBatchError('envelope-not-object');
  }
  // 键穷举：信封只有两个键，多一个就是我们不认识的协议
  for (const k of Object.keys(body)) {
    if (k !== 'schema' && k !== 'events') throw new BadBatchError('envelope-unknown-key');
  }
  if (body.schema !== BATCH_SCHEMA) throw new BadBatchError('bad-schema');
  if (!Array.isArray(body.events)) throw new BadBatchError('events-not-array');
  if (body.events.length === 0) throw new BadBatchError('events-empty');
  if (body.events.length > MAX_EVENTS) throw new BadBatchError('too-many-events');

  const events = [];
  const identities = [];
  let rejected = 0;
  let identityDropped = 0;
  const ingest = identityIngestEnabled();
  for (const raw of body.events) {
    const picked = pickKnown(raw);
    if (picked === null) { rejected++; continue; }
    try {
      assertValidEvent(picked);
    } catch {
      rejected++;
      continue;
    }
    // 🔴 **拆成两半再存**，见下面 splitIdentity 的长注释。
    //    存的是**重新序列化**过的形式：serializeEvent 只输出给定的键、手写序列化，
    //    于是「进了 telemetry_events.ev 的字节」不可能包含任何身份字段。
    events.push(parseStrict(serializeAnonymousEvent(picked)));
    const id = splitIdentity(picked);
    if (id === null) continue;
    if (ingest) identities.push(id);
    else identityDropped++;
  }
  return { events, identities, rejected, identityDropped };
}

/**
 * 服务端的身份采集总开关。**默认关。**
 *
 * 🔴 这是 kill switch，不是配置项：在「身份表建好、按人登录与审计上线、
 *    删除通道能用」之前，收到身份字段的正确处理是**当场丢掉**，
 *    而不是先存下来等页面做好。存下来的那一刻它就已经是一份没人管的个人数据。
 * 🔴 丢掉的是身份三项，**匿名事件照收** —— 客户端不会因此重发，
 *    也不会知道我们没存（那不是它的事）。
 *
 * ⚠️ 打开它之前要同时具备：`telemetry_identity` 表、按人登录、审计写入、
 *    删除通道。少一样都不要打开。
 */
export function identityIngestEnabled() {
  const v = process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  return v === '1' || v === 'on' || v === 'true';
}

/**
 * 把身份三项从事件里摘出来，返回 `{ eid, os_user?, host?, notice? }`；
 * 一项都没有就返回 null。
 *
 * 🔴 **`eid` 是两张表之间唯一的连接**，身份行靠它挂在事件上（外键 + on delete
 *    cascade）。所以身份行里不重复存任何匿名字段 —— 重复存就等于把身份数据
 *    抄了第二份，删的时候必然漏掉一份。
 *
 * 🔴 **不要把身份字段留在 `picked` 里再指望下游不看**。下游是 `store.put()`，
 *    它把整个对象序列化进 jsonb；「下游不会用到」是一句关于当前实现的话，
 *    不是关于契约的话，而这种话在下一次重构时不成立。
 */
export function splitIdentity(ev) {
  // 🔴 **没有当前版本的 notice 就不留身份行。**（Codex 2026-09-09 指出的绕过）
  //    notice 是「客户端声称展示过哪一版告知」的见证。它是**自报**的、伪造零成本，
  //    所以它不是安全控制 —— 但既然整套设计把它当成协议见证，那就必须**真的检查**，
  //    否则手工构造一个不带 notice 的事件就能把身份存进来，而合规上我们
  //    连「它自称告知过」这句都拿不出来。
  //    ⚠️ 版本不匹配也丢：采集面变了要重新告知，旧版本的见证不作数。
  if (ev.notice !== CURRENT_NOTICE) return null;
  let has = false;
  const out = { __proto__: null, eid: ev.eid };
  for (const k of IDENTITY_FIELD_NAMES) {
    if (Object.hasOwn(ev, k)) { out[k] = ev[k]; has = true; }
  }
  // 只有 notice、没有真正的身份内容 —— 不算身份行
  return has && (Object.hasOwn(out, 'os_user') || Object.hasOwn(out, 'host')) ? out : null;
}
