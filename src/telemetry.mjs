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
  // 🔴 `vendor` 记的是「物化了哪个 pack」，**没有** client / scope ——
  //    它写的是用户仓库里的目录，不是某个 client 的 skills 目录（03-packs.md §6）。
  //    两个字段本来就是可选的，所以缺席是如实描述，不是漏填。
  'vendor',
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
 * 白名单键名，**只读**。给服务端用：它按这张表 pick 已知键、丢弃多余字段
 * （规格 §5.3「多余字段服务端丢弃，不要信客户端」）。
 * 🔴 导出的是键名不是 FIELDS 本身 —— 校验器不该被外面拿去改。
 */
export const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

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
export function appendDurable(path, line) {
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

// ─────────────────────────────────────────────────────────────────────────────
// 首次运行告知
//
// 🔴 2026-09-01 用户拍板：上报**默认开**（有内置默认端点，见 upload.mjs）。
//    默认出网而**不告知**是这件事最糟的形态 —— 那才是真正会被称作「偷偷上传」的
//    做法。所以默认开必须与「首次运行显眼告知」捆在一起，两者是同一个决定的两半，
//    不许只落地前一半。
// ─────────────────────────────────────────────────────────────────────────────

const noticeMarkPath = () => join(stateDir(), 'telemetry', 'upload-notice.v1');

/** 告知文案。抽成函数是为了让测试断言它、也让端点变了文案自动跟着变。 */
export function uploadNoticeText(url) {
  const bar = '─'.repeat(74);
  return `${bar}
skills-hub 会上报匿名使用埋点（首次运行提示，只显示这一次）

  收什么      装了哪个制品、哪个 client、成功还是失败、耗时，
              以及 CLI / OS / arch / Node 版本和一个「本机随机 ID」
              （随机 UUID，与账号、机器名、用户名、MAC 无任何映射，删了就换一个）
  不收什么    路径、目录清单、文件内容、用户名、命令行原文、异常栈
              —— 采集面是穷举白名单，整张表见 docs/telemetry/00-spec.md §2
  发到哪      ${url}
  什么时候发  一次 install 成功收尾之后，最多每 24 小时静默发一次
              （超时 1 秒；发不出去就算了，不会影响安装结果）；
              别的命令（check / list / stats…）只写本地，不出网。
              也可以随时手动 \`skills-hub telemetry flush\` 立刻发
  怎么关      GEOLY_TELEMETRY_UPLOAD=0   只留本地统计，不上报
              GEOLY_TELEMETRY=0          完全关闭，本地一个字节都不写
              --offline                  单次命令禁止一切网络出口

  本机记了什么：skills-hub stats      当前开关与端点：skills-hub telemetry status
${bar}
`;
}

/**
 * 首次运行时把告知打出来，并落一个标记，之后不再打。
 *
 * 🔴 **顺序是「先打印、后落标记」。** 反过来时，崩在两步之间的用户**永远看不到**
 *    这段告知 —— 而告知漏掉一次的代价（用户不知道默认在上报）比多看一次大得多。
 *    并发首跑会重复打印一次，那是可接受的一侧。
 *
 * ⚠️ 这里的判据是「标记文件在不在」，看着像 §5.2.4 禁止的那条，其实不是：
 *    标记的**内容从来没有人读**，空文件与写满的文件含义完全相同。
 *    §5.2.4 禁的是拿存在性去断言「内容完整/可用」。
 *
 * @param {(s: string) => void} write 写出口（必须是 stderr —— `--json` 下
 *        stdout 只能有一个 JSON 对象，见 09-cli.md §7）
 * @param {string|null} url 生效中的端点；null / 上报关掉时不打（没有出网就没什么可告知的）
 * @returns {boolean} 这次是否打了
 */
export function maybeNoticeUpload(write, url) {
  try {
    if (!enabled() || !uploadEnabled() || !url) return false;
    const p = noticeMarkPath();
    if (existsSync(p)) return false;
    mkdirSync(join(stateDir(), 'telemetry'), { recursive: true });
    write(uploadNoticeText(url));
    // 'wx' = 原子 no-replace：并发首跑只有一个能建成，别的走 catch，
    // 但那时告知已经打过了，重复的只是打印，不是漏打。
    // 不 fsync：丢了标记的后果只是多打一次告知，为它在**每个用户的第一条命令**上
    // 加一次同步 fsync 不划算（T-5：埋点不得让主命令变慢）。
    try {
      const fd = openSync(p, 'wx', 0o644);
      try { appendFileSync(fd, `shown-at=${new Date().toISOString()}\nendpoint=${url}\n`); } finally { closeSync(fd); }
    } catch { /* 别人抢先建了，或建不了 —— 都不影响主命令 */ }
    return true;
  } catch (err) {
    // 🔴 告知失败绝不能影响主命令（T-5）。留在 lastError 供 telemetry status 诊断。
    _lastError = err;
    return false;
  }
}

/**
 * 首次告知是否**已经打过**（标记文件在不在）。
 *
 * 🔴 这是自动上报的**硬前置门**，不只是一个查询函数：见 upload.mjs 的 maybeAutoUpload。
 *    「先发了再告诉你」比「不告知」更糟，所以自动上报不靠调用顺序去保证先后 ——
 *    调用顺序是**别人的代码**（cli.mjs 里 noticeOnce 排在命令分发之前），
 *    改一行就能悄悄反过来，而且不会有任何东西变红。这条门是本地判据，
 *    谁在什么位置调 maybeAutoUpload 都绕不过去。
 *
 * ⚠️ 判据仍是「标记文件在不在」，理由同 maybeNoticeUpload：标记的内容没有人读，
 *    空文件与写满的文件含义完全相同（§5.2.4 禁的是拿存在性断言「内容完整」）。
 *
 * ⚠️ 已知的一侧：告知**打印成功、标记落盘失败**（盘满、目录不可写）时，
 *    这台机器从此不会自动上报，同时每次运行都会重打一遍告知。
 *    这正是我们要的那一侧 —— 宁可不发，也不要在用户没看见告知的情况下发。
 */
export function noticeShown() {
  try { return existsSync(noticeMarkPath()); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自动上报的节流
//
// 🔴 2026-09-01 用户拍板（规格 §5.1.1）：install **成功收尾**后自动发一次。
//    没有普通用户会去跑 `telemetry flush` —— 「默认开」于是承担了默认出网的
//    全部隐私代价，却拿不到任何数据。自动上报是把这笔代价换成实际回流的那一步。
//
// 节流标记与首次告知的标记**分开两个文件**，故意的：
// 一个记「有没有告知过」（一辈子一次），一个记「上次尝试上报是什么时候」（会被反复重写）。
// 合成一个文件就得靠解析内容去区分两种语义，而且删掉其中一个含义就会连坐另一个 ——
// 用户删掉节流戳想「立刻再发一次」，不该顺带把首次告知重新触发一遍。
// ─────────────────────────────────────────────────────────────────────────────

/** 节流窗口：24 小时。取值理由见 docs/telemetry/00-spec.md §5.1.1。 */
export const AUTO_UPLOAD_INTERVAL_MS = 24 * 60 * 60 * 1000;

const autoUploadStampPath = () => join(stateDir(), 'telemetry', 'auto-upload.last');

/**
 * 认领这一次自动上报的名额：到点了就**先把戳写下去**，再返回 true。
 *
 * 🔴 **戳是在尝试之前写的，不是发成功之后写的。** 节流的判据是「距上次**尝试**」
 *    而不是「距上次**成功**」：端点挂了的时候，按「上次成功」算会让**每一次**
 *    install 都去撞一遍那个挂掉的端点、每次多付最多 1 秒 —— 恰恰是端点最不该
 *    被继续敲的时候敲得最凶。按「上次尝试」算，无论成败，24 小时内最多一次。
 *    代价写在明处：一次失败的尝试会把这批事件压后 24 小时（它们留在本地不丢，
 *    §5.2.2），用户想立刻发有 `telemetry flush` 这条明路。
 *
 * ⚠️ 崩在「写戳」与「真的发」之间 = 这一天不发了。事件留在队列里，无害。
 *    反过来（先发后写戳）在同样的崩溃下会让下一次 install 再发一遍 ——
 *    多一次出网比少一次出网糟，所以选前者。
 *
 * 🔴 **认领必须是原子的**（Codex 2026-09-01 指出，原先是 P1）。
 *    早先这里是「裸读戳 → 判断 → 裸写戳」，中间没有任何互斥：两个 install 同时
 *    收尾时会**双双读到旧戳、双双认领成功**，规格承诺的「24 小时最多一次」就不成立了。
 *    当时的理由是「flush 自己有跨进程锁，后到的会拿到 busy」—— 那个理由**不够**：
 *    busy 只在两次 flush 真的重叠时才发生；先跑完的那个一释放锁，后一个就照发不误。
 *    所以读—判断—写这三步一起放进上报锁里。
 *
 * ⚠️ 拿不到锁（`LockBusyError`）就**不认领**：那说明别的进程正在 flush 或换代，
 *    这一轮跳过完全无害（事件留在队列里，下次 install 再说）。
 *    ⚠️ 已知的一侧：`record()` 的换代也用这把锁，撞上它会让这一天不发。
 *    换代是罕见且短暂的，而「少发一次」正是我们要的那一侧。
 * ⚠️ 用的是**同一把**上报锁而不是新开一把：新开一把就有了两把锁与一个加锁顺序，
 *    而这里根本不需要——认领与发送本来就该互斥。锁在返回前释放，
 *    `flush()` 随后自己再取一次（`acquire` 禁止同进程重入）。
 *
 * @param {number} now 当前时刻（毫秒），测试可注入
 * @returns {boolean} 是否该在这一次运行里上报
 */
export function claimAutoUploadSlot(now = Date.now(), intervalMs = AUTO_UPLOAD_INTERVAL_MS) {
  const p = autoUploadStampPath();
  let release;
  try {
    mkdirSync(join(stateDir(), 'telemetry'), { recursive: true });
    release = acquire(lockPath());
  } catch (err) {
    // busy = 别人正在发；别的错（盘满、db 坏）也一样 —— 都按「这一轮不发」处理。
    // 🔴 fail-closed：拿不到互斥就不认领，绝不退回成「那就不加锁地写吧」。
    _lastError = err;
    return false;
  }
  try {
    try {
      // 🔴 判据是**内容**（一个能解析成毫秒时间戳的数），不是「文件在不在」（§5.2.4）。
      //    读不出有效值 = 当作从没发过 —— 但下面无论如何都会重写一个有效的戳，
      //    所以一个被写坏的戳只会多放行**一次**，不会变成「每次 install 都发」。
      const last = Number(readFileSync(p, 'utf8').trim());
      if (Number.isFinite(last)) {
        // 未来的戳（改过系统时间、或跨时钟回拨的机器）同样按「没到点」处理：
        // 时钟回拨时放行反而会连着发好几次，而它本来就是我们最不确定的输入。
        if (last > now) return false;
        if (now - last < intervalMs) return false;
      }
    } catch { /* 没有戳 / 读不了 —— 当作从没发过 */ }

    try {
      writeAtomic(p, String(now) + '\n');
    } catch (err) {
      // 🔴 戳写不下去就**不发**。否则节流形同虚设：每一次 install 都会出网，
      //    而「每条命令都出网」正是自动上报最不该退化成的样子。
      _lastError = err;
      return false;
    }
    return true;
  } finally {
    // 🔴 必须在返回前释放：`flush()` 马上要取同一把锁，而 `acquire` 禁止同进程重入。
    try { release(); } catch { /* 释放失败不该盖掉上面的返回值 */ }
  }
}

/** 导出 canonical JSON（给静态页读）。导出也是一个出口，同样过校验。 */
export function exportJson(events = readHistory()) {
  const clean = events.filter(isValidEvent);
  return stringify({ schema: 'geoly.skills.telemetry-export/1', count: clean.length, events: clean });
}
