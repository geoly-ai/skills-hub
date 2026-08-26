// skill 埋点 —— 规范见 docs/telemetry/00-spec.md
// 🔴 隐私契约（硬约束，实现不得放宽）：
//   · 只收「哪个制品、什么结果」，不收路径、不收内容、不收用户名、不收目录清单
//   · 事件先落本地，上报是**独立**动作；关掉上报不影响本地统计
//   · install_id 是随机 UUID，与账号/机器名/用户名**无任何映射**
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync, renameSync, fstatSync, linkSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { writeAtomic, fsyncParentAfter } from './atomic-fs.mjs';
import { stringify, encodeString, parseStrict } from './canonical-json.mjs';
import { acquire } from './lock.mjs';

export const KINDS = new Set([
  'install', 'update', 'remove', 'check', 'rollback', 'recover', 'sync-lock',
]);
export const RESULTS = new Set(['ok', 'skipped', 'failed', 'corrupt']);

export function stateDir() {
  return process.env.GEOLY_STATE_DIR ?? join(homedir(), '.local', 'state', 'geoly-skills');
}
const queuePath = () => join(stateDir(), 'telemetry', 'queue.ndjson');
const idPath = () => join(stateDir(), 'telemetry', 'install-id');

/** 是否启用埋点：默认开，`GEOLY_TELEMETRY=0` 关。关掉后**一个字节都不写** */
export function enabled() {
  const v = process.env.GEOLY_TELEMETRY;
  return !(v === '0' || v === 'off' || v === 'false');
}
/** M0 的全局 `--offline`：置位后本 CLI 不得有任何网络出口，埋点也不例外 */
export const offline = () => process.env.GEOLY_OFFLINE === '1';

/** 是否上报：默认开；`GEOLY_TELEMETRY_UPLOAD=0` 或 `--offline` 只留本地 */
export function uploadEnabled() {
  const v = process.env.GEOLY_TELEMETRY_UPLOAD;
  return enabled() && !offline() && !(v === '0' || v === 'off' || v === 'false');
}

/** 随机 install_id，只存本地；与身份无映射 */
export function installId() {
  const p = idPath();
  const readValid = () => {
    try {
      const v = readFileSync(p, 'utf8').trim();
      return RE_UUID.test(v) ? v : null;
    } catch { return null; }
  };

  const existing = readValid();
  if (existing) return existing;

  mkdirSync(join(stateDir(), 'telemetry'), { recursive: true });

  // 🔴 **先写满，再让名字出现。**
  //
  // 早先这里是 `openSync(p, 'wx')` 然后往 fd 里写 —— 看着像原子抢占，其实不是：
  // `wx` 一成功文件就存在了，但**内容还没写**。抢输的进程走 EEXIST 分支去读，
  // 读到的是空串。实测（在 open 与 write 之间插 0.4s）：4 个进程里 3 个拿到 ""。
  //
  // ⚠️ 又是「存在 ≠ 完整」。今天已经在墓碑、rmtree、这里各栽一次：
  // **判据永远不能是「文件在不在」，要么是内容有效性，要么是只在完整后才出现的名字。**
  //
  // 所以：内容写进临时文件 → fsync → `link` 到正式名（原子 no-replace，
  // 目标已存在就 EEXIST）→ 删临时文件。名字一出现，内容就一定是全的。
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomUUID();
    const tmp = `${p}.${process.pid}.${attempt}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o644);
      try { appendFileSync(fd, id + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        linkSync(tmp, p);          // 抢到了
        return id;
      } catch {
        const winner = readValid(); // 别人抢先，且此刻内容必然是完整的
        if (winner) return winner;
      }
    } catch {
      const winner = readValid();
      if (winner) return winner;
    } finally {
      try { unlinkSync(tmp); } catch { /* 没建成 */ }
    }
  }
  // 反复抢不到又读不出有效值：不落盘，本次用一个临时身份，不要让埋点拖垮主命令
  return randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// 严格 schema：这是隐私契约的**唯一**执行点
//
// 🔴 早先这里只做「扫字符串里有没有路径」，那是不够的（Codex 2026-08-26 指出）：
//    · `client: { path: '/Users/a' }` —— 值不是字符串，扫描直接 continue，整个对象漏出去
//    · 用户名、邮箱、token、base64 过的路径都不含 `/`，扫描一律放行
//    · 手改队列文件可以塞任意未知键，上报时原样 JSON.stringify 发走
//    正确做法是**穷举键 + 每个键一个值校验器**，而不是黑名单式地找坏东西。
// ─────────────────────────────────────────────────────────────────────────────

// randomUUID() 产出的就是 v4；正则收窄到 v4，别写成 [1-5] 那样比规格宽
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RE_SEMVERISH = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const RE_ARTIFACT = /^(skill|pack):[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9A-Za-z.+-]{1,32}$/;

export const CLIENTS = new Set(['claude', 'cursor', 'codex', 'agents']);
export const SCOPES = new Set(['global', 'project']);
// `os`/`arch` 只收已知取值 —— 未知值本身就是一种指纹
const OSES = new Set(['darwin', 'linux']);
const ARCHES = new Set(['x64', 'arm64']);

// 🔴 `reason` 是**有限代码表**，不是"符合某个形状的字符串"。
// 形状约束（小写 kebab）已经挡掉路径、邮箱、token，但挡不住 `reason: "alice"`
// 这种侧信道 —— 一个形状合法的自由字段迟早会被人拿来塞信息（Codex 2026-08-26 指出）。
// 加新原因就往这张表里加，**过评审**；不要退回成正则。
export const REASONS = new Set([
  'signature-mismatch', 'digest-mismatch', 'trust-floor-violation', 'attestation-missing',
  'target-busy', 'target-missing', 'target-not-writable', 'unsupported-client',
  'not-found', 'already-installed', 'version-conflict', 'yanked',
  'network-error', 'timeout', 'offline', 'lock-busy',
  'journal-corrupt', 'ledger-corrupt', 'assertion-corrupt', 'user-abort',
  'unknown',
]);

const str = (re) => (v) => typeof v === 'string' && re.test(v);
const oneOf = (set) => (v) => typeof v === 'string' && set.has(v);

// 用 __proto__: null 建表：否则 `FIELDS['__proto__']` 会命中 Object.prototype（真值），
// `FIELDS['constructor']` 会命中 Object —— 靠「取出来的东西没有 .ok 所以抛 TypeError」
// 挡住是巧合，不是设计。下面的 hasOwn 才是真正的判据。
/** 键的穷举表。**不在这张表里的键一律拒绝。** */
const FIELDS = {
  __proto__: null,
  schema: { required: true, ok: (v) => v === 'geoly.skills.telemetry/1' },
  eid: { required: true, ok: str(RE_UUID) },
  at: { required: true, ok: str(RE_AT) },
  install_id: { required: true, ok: str(RE_UUID) },
  cli: { required: true, ok: str(RE_SEMVERISH) },
  os: { required: true, ok: oneOf(OSES) },
  arch: { required: true, ok: oneOf(ARCHES) },
  node: { required: true, ok: str(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/) },
  kind: { required: true, ok: (v) => KINDS.has(v) },
  result: { required: true, ok: (v) => RESULTS.has(v) },
  artifact: { required: false, ok: str(RE_ARTIFACT) },
  version: { required: false, ok: str(RE_SEMVERISH) },
  client: { required: false, ok: oneOf(CLIENTS) },
  scope: { required: false, ok: oneOf(SCOPES) },
  ms: { required: false, ok: (v) => Number.isInteger(v) && v >= 0 && v <= 86_400_000 },
  reason: { required: false, ok: oneOf(REASONS) },
};

/**
 * 🔴 隐私契约的执行点。落盘、读队列、上报、导出 —— 四个边界都走这一个函数。
 * 任何不合规的事件都**不得**离开本机。
 */
export function assertValidEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new Error('telemetry: 事件必须是普通对象');
  }
  for (const k of Object.keys(ev)) {
    if (!Object.hasOwn(FIELDS, k)) throw new Error(`telemetry: 未知字段 ${k}，拒绝`);
    const f = FIELDS[k];
    const v = ev[k];
    if (v !== null && typeof v === 'object') throw new Error(`telemetry: 字段 ${k} 是对象/数组，拒绝`);
    if (!f.ok(v)) throw new Error(`telemetry: 字段 ${k} 的值不合规，拒绝`);
  }
  for (const [k, f] of Object.entries(FIELDS)) {
    // Object.hasOwn 而非 `k in ev`：`in` 会走原型链，`{}` 也会「有」toString
    if (f.required && !Object.hasOwn(ev, k)) throw new Error(`telemetry: 缺少必填字段 ${k}`);
  }
  return ev;
}

/** 校验但不抛：用于过滤被手改过的队列 */
export function isValidEvent(ev) {
  try { assertValidEvent(ev); return true; } catch { return false; }
}

/** 兼容旧名字；语义已并入 assertValidEvent */
export const assertNoPaths = assertValidEvent;

/** 🔴 白名单式构造：只有这些字段能进事件，别的一律丢弃 */
export function buildEvent({ kind, artifact, version, client, scope, result, ms, reason }) {
  const ev = {
    schema: 'geoly.skills.telemetry/1',
    // 🔴 上报是 at-least-once（POST 成功后、游标落盘前崩溃会重发）。
    // eid 是服务端唯一的去重依据 —— 随机 UUID，不含任何可反推的信息。
    eid: randomUUID(),
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    install_id: installId(),
    // 环境变量可被任意注入，所以它也要过 RE_SEMVERISH
    cli: process.env.GEOLY_CLI_VERSION ?? '0.0.0-m1',
    os: platform(), arch: arch(), node: process.versions.node,
    kind, result,
  };
  if (artifact !== undefined) ev.artifact = artifact;
  if (version !== undefined) ev.version = version;
  if (client !== undefined) ev.client = client;
  if (scope !== undefined) ev.scope = scope;
  if (ms !== undefined) ev.ms = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : ms;
  if (reason !== undefined) ev.reason = reason;
  return assertValidEvent(ev);
}

// ─────────────────────────────────────────────────────────────────────────────
// 本地队列
//
// 🔴 早先这里是「NDJSON 追加 + 已上报行数游标 + 超限就重写文件截半」。
//    Codex 2026-08-26 指出这组合有**静默丢事件**的窗口，而且不止一个：
//      · flush 在锁内读到快照后开始发；发的期间别的进程触发截断、行号含义变了；
//        flush 成功后按旧快照写回一个偏大的游标 → 截断后保留的新事件被永久跳过
//      · 截断写盘成功、删游标前崩溃 → 旧游标继续跳过保留下来的事件
//      · 截断是「读全文再重写」，与另一个进程的 O_APPEND 相撞会吞掉刚追加的行
//
//    病根是**用位置去索引一个会被重写的文件**：位置的含义会变。
//    加 generation 只是给错误设计打补丁。这里改成：
//      · 游标这个概念**整个删掉**
//      · 淘汰旧数据只用 rename + unlink，**从不重写队列文件**（不会吞掉并发追加）
//      · flush 是**消费式**的：把整代改名进 sending，发成功就删掉
//
//    队列是「两代环」：queue.ndjson（当前代）+ queue.1.ndjson（上一代）。
//    超过上限就 unlink 上一代、把当前代 rename 成上一代、开一个空的当前代。
//    「丢最旧的」= 那次 unlink，是有意的淘汰，不是意外丢失。
// ─────────────────────────────────────────────────────────────────────────────

/** 单代上限；磁盘占用上界约为 2 倍（当前代 + 上一代） */
export const MAX_QUEUE_BYTES = 1024 * 1024;

const prevQueuePath = () => join(stateDir(), 'telemetry', 'queue.1.ndjson');
// 报表用的历史：与上报队列**分开**。上报是消费式的，发完队列就空了；
// 报表不能因为"上报成功"就没数据看，所以另存一份，flush 从不碰它。
const historyPath = () => join(stateDir(), 'telemetry', 'history.ndjson');
const prevHistoryPath = () => join(stateDir(), 'telemetry', 'history.1.ndjson');
export const historyFiles = () => [prevHistoryPath(), historyPath()];
const sendingPath = () => join(stateDir(), 'telemetry', 'sending.ndjson');
/** 已发出但推迟删除的墓碑 —— 必须被读到，见 upload.mjs 的 retire() */
const tombPath = () => join(stateDir(), 'telemetry', 'sending.tomb.ndjson');

/**
 * 读的顺序 = 时间顺序：在途 → 上一代 → 当前代。
 *
 * 🔴 这里**没有**中间文件（早先有过一个 `*.staged`，见 upload.mjs 里的说明）。
 * 每多一个中间文件名，就多一个「崩在这一步谁来读它」和「同名覆盖」的问题。
 */
export const queueFiles = () => [sendingPath(), prevQueuePath(), queuePath()];

/**
 * 🔴 手写序列化，不走 JSON.stringify。
 * JSON.stringify 会在每个值上查 `toJSON`（原语也会，经 GetV 走到原型），
 * 于是被污染的 `Object.prototype.toJSON` / `String.prototype.toJSON`
 * 能把**已经通过校验的对象**换成别的东西再写盘/上报。
 * 事件的值只有受限字符集的字符串和整数，手写既安全又不复杂。
 */
export function serializeEvent(ev) {
  const parts = [];
  for (const k of Object.keys(FIELDS)) {
    if (!Object.hasOwn(ev, k)) continue;
    const v = ev[k];
    parts.push(`${encodeString(k)}:${typeof v === 'number' ? String(v) : encodeString(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 追加到本地队列（NDJSON，一行一事件）。
 *
 * 🔴 **绝不向调用方抛错**（威胁模型 T-5：埋点不得让主命令变脆）。
 * 校验失败、磁盘满、目录不可写 —— 一律返回 null，错误留在 `lastError()` 供诊断。
 * 校验本身要严格，但"严格"体现在**不写出去**，不是体现在炸掉安装事务。
 *
 * 不 fsync：丢掉最后几条埋点无所谓，让主命令等一次 fsync 才是真的有害。
 * 追加走 O_APPEND，单行远小于 PIPE_BUF，并发追加不会交错。
 */
let _lastError = null;
export const lastError = () => _lastError;

export function record(input) {
  if (!enabled()) return null;
  try {
    const ev = buildEvent(input);
    mkdirSync(join(stateDir(), 'telemetry'), { recursive: true });
    const line = serializeEvent(ev) + '\n';
    // 🔴 open 与 append 之间，别的进程可能把这个文件 unlink 掉（换代删上一代、
    // retire 删 sending）。那样这一行就写进了一个没有目录项的 inode —— 谁都读不到，
    // 静默丢事件。写完用 fstat 查 nlink：为 0 就说明中招了，换一个新 fd 重写一遍。
    // 重试有限次，避免在病态并发下打转。
    appendDurable(queuePath(), line);
    appendDurable(historyPath(), line);
    rotateIfNeeded(queuePath(), prevQueuePath());
    rotateIfNeeded(historyPath(), prevHistoryPath());
    _lastError = null;
    return ev;
  } catch (err) {
    _lastError = err;
    return null;
  }
}

/**
 * 追加一行，并确认它落进了一个**还有目录项**的 inode。
 *
 * open 与 append 之间，别的进程可能把这个文件删了（换代删上一代、retire 删墓碑）。
 * 那样这一行就写进了孤儿 inode，谁都读不到。写完 fstat 查 nlink，中招就换 fd 重来。
 *
 * ⚠️ **这个检查是 TOCTOU 的**：它发现不了「fstat 之后、close 之前才被删」。
 * 那个窗口靠上报侧的"延迟一个周期再删"来压缩，见 upload.mjs 的 retire()
 * 与规格 §6 的 T-15 —— 那是**已知且接受**的残余风险，不是被闭合了。
 */
function appendDurable(path, line) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const fd = openSync(path, 'a', 0o644);
    let orphaned;
    try {
      appendFileSync(fd, line);
      orphaned = fstatSync(fd).nlink === 0;
    } finally { closeSync(fd); }
    if (!orphaned) return;
  }
  throw new Error('telemetry: 文件反复被并发删除，放弃这条事件');
}

/**
 * 换代。只做 unlink + rename，**不重写任何文件**，所以与并发追加无冲突：
 * 别的进程用已打开的 fd 追加时，数据落进被改名后的那个 inode，仍在上一代里被读到。
 *
 * 拿不到锁就跳过 —— 换代晚一次完全无害（下次追加还会再判一遍），
 * 而让 record 阻塞在锁上是有害的。
 */
function rotateIfNeeded(cur, prev) {
  let size;
  try { size = statSync(cur).size; } catch { return; }
  if (size <= MAX_QUEUE_BYTES) return;
  let release;
  try { release = acquire(lockPath()); } catch { return; }  // busy：下次再说
  try {
    // 再判一次：等锁的期间别的进程可能已经换过代了
    try { if (statSync(cur).size <= MAX_QUEUE_BYTES) return; } catch { return; }
    try { unlinkSync(prev); } catch { /* 本来就没有上一代 */ }
    renameSync(cur, prev);
    fsyncParentAfter(cur);
  } finally {
    release();
  }
}

export const lockPath = () => join(stateDir(), 'telemetry', 'upload.lock.db');

/**
 * 读本地全部事件（在途 → 上一代 → 当前代，即时间顺序）。
 * 🔴 队列文件是可被手改的，所以**读回来也要过一遍严格校验**：
 * 解析失败或不合规的行一律丢弃，绝不让它们流到上报或导出。
 * 同一 eid 只留第一次出现的那条（flush 失败重入时可能有重叠）。
 */
function readFiles(paths) {
  const out = [];
  const byEid = new Map();
  for (const p of paths) {
    let text;
    // 不拿锁读，所以可能撞上 rename 的中间态：existsSync 与读之间文件就没了。
    // 读不到就跳过这一个文件，不要把诊断命令炸掉。
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let ev;
      // parseStrict 而非 JSON.parse：重复 key 会被 JSON.parse 静默取最后一个
      try { ev = parseStrict(line); } catch { continue; }
      if (!isValidEvent(ev)) continue;
      const prior = byEid.get(ev.eid);
      if (prior) {
        // 崩溃重发产生的是**同 eid 同内容**的副本，去重即可。
        // 同 eid 不同内容说明有人改过文件或实现有 bug —— 不静默吞掉。
        if (serializeEvent(prior) !== serializeEvent(ev)) {
          _lastError = new Error(`telemetry: eid ${ev.eid} 出现内容不同的副本，已丢弃后者`);
        }
        continue;
      }
      byEid.set(ev.eid, ev);
      out.push(ev);
    }
  }
  return out;
}

/** 待上报的事件（上报会消费掉它们） */
export function readAll() { return readFiles(queueFiles()); }

/** 报表用的历史。上报**不**消费它，所以发完了报表照样有数据看。 */
export function readHistory() { return readFiles(historyFiles()); }

/** 导出 canonical JSON（给静态页读）。导出也是一个出口，同样过校验。 */
export function exportJson(events = readHistory()) {
  const clean = events.filter(isValidEvent);
  return stringify({ schema: 'geoly.skills.telemetry-export/1', count: clean.length, events: clean });
}
