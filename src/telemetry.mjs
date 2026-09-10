// skill 埋点 —— 规范见 docs/telemetry/00-spec.md
// 🔴 隐私契约（硬约束，实现不得放宽）：
//   · 只收「哪个制品、什么结果」，不收路径、不收内容、不收用户名、不收目录清单
//   · 事件先落本地，上报是**独立**动作；关掉上报不影响本地统计
//   · install_id 是随机 UUID，与账号/机器名/用户名**无任何映射**
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, mkdirSync, openSync, closeSync, statSync, unlinkSync, renameSync, rmSync, fstatSync, linkSync, fsyncSync, chmodSync, fchmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, platform, arch, userInfo, hostname } from 'node:os';
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

let _lastError = null;
export const lastError = () => _lastError;

/**
 * 权限收紧失败的告警。**与 `_lastError` 分开存**。
 *
 * 🔴 `record()` 成功一次就把 `_lastError` 清成 null（那是对的：它说的是
 *    「上一次记录出没出错」）。把 chmod 失败塞进同一个变量，等于**下一条事件
 *    就把它擦掉了** —— 于是「记进 lastError 供诊断」这句话在实际运行里从来不成立
 *    （Codex 2026-09-09 指出）。权限是一个**持续状态**，不是一次操作的结果，
 *    所以它要自己的变量，而且只增不清。
 */
let _permWarn = null;
export const permWarning = () => _permWarn;

export function stateDir() {
  return process.env.GEOLY_STATE_DIR ?? join(homedir(), '.local', 'state', 'geoly-skills');
}
/**
 * 埋点状态目录 —— **0700，并且每次都把已存在的目录纠正回 0700**。
 *
 * 🔴 判据不能是「建的时候给了 mode」：`mkdirSync(…, { mode })` 只对**这次真的创建**
 *    生效，而且还要减去 umask；目录早就存在（老版本按默认 0755 建的）时它一声不吭。
 *    所以这里无条件 chmod 一次 —— 幂等、便宜，且能把老机器上的目录迁移过来。
 *
 * 🔴 为什么是 0700 而不是 0755：这里面是 queue / history / sending / install-id。
 *    同机的**其他账户**本来就能读它们；一旦事件里出现自报的用户名与主机名，
 *    那就是把身份信息摊在一个所有人可读的目录里。目录一收紧，里面所有文件
 *    （包括 writeAtomic 的临时文件）一起被保护，不用逐个文件去追。
 */
export function telemetryDir() {
  const d = join(stateDir(), 'telemetry');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    chmodSync(d, 0o700);
  } catch (err) {
    // 🔴 **吞掉但要留痕。** 收不紧权限时继续写是有意的（T-5：埋点不得让主命令挂），
    //    但「悄悄地继续写」意味着没人知道这台机器上的埋点目录是所有人可读的。
    //    `telemetry status` 会把它显示出来。
    _permWarn = `目录 ${d} 收不到 0700：${err?.message ?? err}`;
  }
  return d;
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

/**
 * 是否采集**身份三项**（`os_user` / `host`，以及服务端观测的 `ip`）。
 *
 * 🔴 **默认关，而且必须显式打开。** 2026-09-09 用户拍板要采身份字段，但 Codex 在
 *    方案评审里把三件事列为阻断项：服务端还没把身份与事件分表（现在会直接写进
 *    `telemetry_events.ev`）、dashboard 还是共享口令没有按人审计、删除通道还没有。
 *    在那三件事落地之前把默认打开，等于先把身份数据灌进一个管不住它的库。
 *    ⚠️ **翻这个默认值是一次独立的、要过评审的动作**，不要顺手改掉。
 *
 * 🔴 **先告知、后采集,由代码强制,不只是文档里的一句话。** 即使显式打开，
 *    没展示过身份告知（`identity-notice.v2` 标记不在）也一律不采 —— 与 §4.3
 *    「先打印、后落标记」是同一个取向：漏掉一次告知比多看一次严重得多。
 *
 * 关的两条路：`GEOLY_TELEMETRY_IDENTITY=off`（环境变量），或 `telemetry off`
 * 落下的本地标记。**关掉身份不影响匿名计数**（用户 2026-09-09 拍板）——
 * 想连计数一起停是 `GEOLY_TELEMETRY=0`（`enabled()`）。
 */
const OFFISH = new Set(['0', 'off', 'false']);
const ONISH = new Set(['1', 'on', 'true']);
const identityOffPath = () => join(stateDir(), 'telemetry', 'identity-off');
const identityNoticePath = () => join(stateDir(), 'telemetry', 'identity-notice.v2');

/** 当前身份告知的版本号。改采集面就要发新版本并重新告知（规格 §4.3）。 */
export const IDENTITY_NOTICE = 'v2';

export function identityEnabled() {
  if (!enabled()) return false;
  const v = process.env.GEOLY_TELEMETRY_IDENTITY;
  if (typeof v === 'string' && OFFISH.has(v)) return false;
  try { if (existsSync(identityOffPath())) return false; } catch { return false; }
  if (!(typeof v === 'string' && ONISH.has(v))) return false;   // 默认关，见上
  return identityNoticeShown();
}

/**
 * 身份告知是不是**真的展示过**。
 *
 * 🔴 判据不能是「这个名字存在」（Codex 2026-09-09 指出）：预先建一个同名**目录**
 *    或者一个指向别处的 symlink，就能在没看过告知的情况下把身份采集打开。
 *    这正是 §5.2.4 那条 —— 「文件在不在」永远不是判据 —— 的又一个实例，
 *    而且这次它守的是「先告知后采集」，比队列那次更贵。
 *    ⚠️ 上报告知那个标记是另一回事：它的内容确实没人读，存在性就是全部语义。
 *    这里不同，这里的存在性要用来**放行一件事**，所以必须验到内容。
 */
export function identityNoticeShown() {
  try {
    const st = statSync(identityNoticePath());   // 不跟随不存在的目标，坏 symlink 直接抛
    if (!st.isFile()) return false;
    return /^shown-at=\d{4}-/m.test(readFileSync(identityNoticePath(), 'utf8'));
  } catch { return false; }
}

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
  if (existing) {
    // 🔴 **提前返回这条路径也要迁移权限。** 老机器上 install-id 早就存在、
    //    而且是 0644 建的；只在「新建」那条路径上给 0600，等于**永远迁移不到**
    //    那些真正需要迁移的机器（Codex 2026-09-09 指出）。
    //    ⚠️ 目录本身由 telemetryDir() 收到 0700，这里是第二道。
    try {
      telemetryDir();
      if ((statSync(p).mode & 0o777) !== 0o600) chmodSync(p, 0o600);
    } catch (err) {
      _permWarn = `install-id 收不到 0600：${err?.message ?? err}`;
    }
    return existing;
  }

  telemetryDir();

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
      const fd = openSync(tmp, 'w', 0o600);
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

/**
 * 身份字段的清洗。**它同时是校验器和构造器** —— 两边用同一个函数，
 * 「能构造出来的」与「能通过校验的」按定义相等，不会有一边宽一边窄。
 *
 * 🔴 不用一条宽正则。用户名与主机名是**操作系统给的**，不是我们能约束的输入：
 *    Windows 的用户名可以带空格与中文，容器里的主机名可以是 64 位十六进制，
 *    被改过的环境里它可以是任意字节。所以这里逐条收：
 *      · NFC 归一 —— 同一个名字的两种 Unicode 写法必须折成同一个值，
 *        否则「同一个人」会在聚合里被数成两个
 *      · 拒绝所有控制字符与行分隔符（`\p{C}`）—— 换行会把一条 NDJSON 撕成两条，
 *        那是注入，不是脏数据
 *      · 长度上限 —— 一个超长的名字既是存储放大，也是指纹
 *    清洗不过就**整个字段不发**（返回 null），绝不发一个截断过的名字：
 *    截断后的名字看起来仍然像一个真名，但它谁都不是。
 */
const MAX_OS_USER = 64;
const MAX_HOST = 128;
const RE_UNSAFE_IDENTITY = /[\p{C}\p{Zl}\p{Zp}]/u;

export function sanitizeIdentity(raw, max) {
  if (typeof raw !== 'string') return null;
  let v;
  try { v = raw.normalize('NFC'); } catch { return null; }
  v = v.trim();
  if (v === '' || v.length > max) return null;
  if (RE_UNSAFE_IDENTITY.test(v)) return null;
  return v;
}
const identityOk = (max) => (v) => typeof v === 'string' && sanitizeIdentity(v, max) === v;

/** 告知版本是**有限代码表**，与 `reason` 同理：一个自由字符串迟早会被拿来塞信息。 */
export const NOTICES = new Set(['v2']);

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

  // ── 身份三项中的两项（第三项 `ip` 由服务端观测，客户端不采：见规格 §5.3）──
  //
  // 🔴 三个都是 `required: false`，而且**必须**是可选的：队列里躺着的老事件
  //    （身份开关打开之前记的、以及关掉身份之后记的）没有这些键，
  //    设成必填会让它们在下一次 flush 时**整批**校验不过，永久卡在队列里。
  //
  // 🔴 `os_user` / `host` 是**客户端自报**的，服务端无从核实。任何把它们叫做
  //    「真实归属」的措辞都是错的 —— 页面上只能说「自报归属」。
  // 🔴 `identity: true` 是**唯一**的身份标记来源。早先身份字段名是另写的一个
  //    手写数组，加字段时忘了同步那边，正向 pick 就会把新字段当匿名字段放出去
  //    —— 而且不报错（Codex 2026-09-09 的硬化建议）。现在两张名单都从这里派生。
  os_user: { required: false, identity: true, ok: identityOk(MAX_OS_USER) },
  host: { required: false, identity: true, ok: identityOk(MAX_HOST) },
  notice: { required: false, identity: true, ok: oneOf(NOTICES) },
};

/**
 * 白名单键名，**只读**。给服务端用：它按这张表 pick 已知键、丢弃多余字段
 * （规格 §5.3「多余字段服务端丢弃，不要信客户端」）。
 * 🔴 导出的是键名不是 FIELDS 本身 —— 校验器不该被外面拿去改。
 */
export const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

/**
 * 身份字段的键名。**这是唯一的定义处**，服务端摄入层按它把一条事件拆成
 * 「匿名事件」与「身份行」两半（`server/validate.mjs` 的 splitIdentity）。
 *
 * 🔴 为什么不让服务端自己列一份：那就成了第二张表，两张表迟早分叉，
 *    而分叉的方向一定是**服务端那份漏掉新字段**，于是新身份字段直接落进
 *    匿名事件的 jsonb 里 —— 不报错、没迹象，只有在某天导出的时候才看见。
 *    与「事件校验器只有 assertValidEvent 一个」是同一条纪律。
 *
 * ⚠️ `ip` 不在这里：它由服务端观测，从来不是客户端事件的一个键。
 */
export const IDENTITY_FIELD_NAMES = Object.freeze(
  FIELD_NAMES.filter((k) => FIELDS[k].identity === true),
);

/** 匿名事件的键名 = 全部键减去身份键。存进 `telemetry_events.ev` 的只能是这些。 */
export const ANONYMOUS_FIELD_NAMES = Object.freeze(
  FIELD_NAMES.filter((k) => FIELDS[k].identity !== true),
);

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
  // 🔴 身份三项只在 identityEnabled() 为真时才**存在**，不是「填一个空值」。
  //    缺席就是缺席 —— 一个 `os_user: ''` 会让服务端以为「这台机器开了身份、
  //    只是名字为空」，那是两件不同的事。
  //    ⚠️ `userInfo()` 在没有 passwd 条目的容器里会抛（uid 不在 /etc/passwd）；
  //    hostname() 在极端环境里也可能失败。**取不到就不发那一项，绝不让主命令挂**。
  if (identityEnabled()) {
    let u = null, h = null;
    try { u = sanitizeIdentity(userInfo().username, MAX_OS_USER); } catch { /* 无 passwd 条目 */ }
    try { h = sanitizeIdentity(hostname(), MAX_HOST); } catch { /* 拿不到主机名 */ }
    if (u !== null) ev.os_user = u;
    if (h !== null) ev.host = h;
    ev.notice = IDENTITY_NOTICE;
  }
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
function serializeKeys(ev, keys) {
  const parts = [];
  for (const k of keys) {
    if (!Object.hasOwn(ev, k)) continue;
    const v = ev[k];
    parts.push(`${encodeString(k)}:${typeof v === 'number' ? String(v) : encodeString(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 🔴 **保持一元。** 早先这里图省事写成 `serializeEvent(ev, keys = …)`，
 *    结果 `pending.map(serializeEvent)` 把**数组下标**当成 keys 传了进来
 *    （`Array.prototype.map` 给回调三个参数），`for…of` 一个数字直接 TypeError，
 *    上报整个静默失败 —— flush 只回一个 `error:TypeError`，没人看得出发生了什么。
 *    ⚠️ 一个「有默认值的可选第二参数」在 map / forEach 回调里从来不是可选的。
 *    要另一种键集就另开一个函数名，不要加位置参数。
 */
export function serializeEvent(ev) {
  return serializeKeys(ev, Object.keys(FIELDS));
}

/** 只输出匿名字段 —— 服务端摄入层用它，保证身份字段进不了事件存储。 */
export function serializeAnonymousEvent(ev) {
  return serializeKeys(ev, ANONYMOUS_FIELD_NAMES);
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
export function record(input) {
  if (!enabled()) return null;
  try {
    const ev = buildEvent(input);
    telemetryDir();
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
    const fd = openSync(path, 'a', 0o600);
    let orphaned;
    try {
      appendFileSync(fd, line);
      // 这一次 fstat 本来就是为了查 nlink（见上面那段注释），顺带把老版本用 0644
      // 建出来的队列/历史迁移成 0600 —— 走 fd 而不是路径，避免 TOCTOU 换靶。
      const st = fstatSync(fd);
      if ((st.mode & 0o777) !== 0o600) {
        try {
          fchmodSync(fd, 0o600);
        } catch (err) {
          _permWarn = `${path} 收不到 0600：${err?.message ?? err}`;
        }
      }
      orphaned = st.nlink === 0;
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
  不收什么    路径、目录清单、文件内容、命令行原文、异常栈
              —— 采集面是穷举白名单，整张表见 docs/telemetry/00-spec.md §2
  身份三项    登录名 / 主机名 / 来源 IP —— **默认不采**。
              要开的话会**单独再告知一次**，并且可以只关它、匿名计数照发
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
 * 身份采集的告知文案（notice v2）。
 *
 * 🔴 **与上报告知是两段，不是一段。** 上报告知回答「会不会出网」，
 *    这一段回答「出网的东西里有没有你是谁」。把它们合成一段的话，
 *    早就看过上报告知的老用户在身份开启时**一个字都不会再看到**。
 */
export function identityNoticeText(url) {
  const bar = '─'.repeat(74);
  return `${bar}
skills-hub 从这次起会上报**身份信息**（只显示这一次）

  新增采集    你的登录名、主机名，以及服务端看到的来源 IP
  仍然不收    路径、目录清单、文件内容、命令行原文、异常栈
  发到哪      ${url}
  留多久      身份三项 90 天后清除；匿名计数保留 180 天
  怎么只关它  skills-hub telemetry off        身份不发了，匿名计数照发
              GEOLY_TELEMETRY_IDENTITY=off    同上，环境变量写法
  怎么全关    skills-hub telemetry off --all  什么都不发
              GEOLY_TELEMETRY=0               同上，环境变量写法

  关掉之后功能完全不受影响。当前状态：skills-hub telemetry status
${bar}
`;
}

/**
 * 身份采集的首次告知。与上报告知同一套纪律：**先打印、后落标记**。
 *
 * 🔴 这段告知是 `identityEnabled()` 的**硬前置**：标记不在就一项都不采
 *    （见那个函数的注释）。所以这里不是「顺手提示一下」，
 *    它是那条开关能打开的唯一途径。
 * 🔴 只有在**有人显式打开身份采集**时才打 —— 默认关的时候打这段，
 *    等于吓唬一个我们根本没在采的用户。
 */
export function maybeNoticeIdentity(write, url) {
  try {
    if (!enabled() || !uploadEnabled() || !url) return false;
    const v = process.env.GEOLY_TELEMETRY_IDENTITY;
    if (!(typeof v === 'string' && ONISH.has(v))) return false;
    if (existsSync(identityOffPath())) return false;      // 用户关过就是关过
    const p = identityNoticePath();
    if (existsSync(p)) return false;
    telemetryDir();
    write(identityNoticeText(url));
    try {
      const fd = openSync(p, 'wx', 0o600);
      try { appendFileSync(fd, `shown-at=${new Date().toISOString()}\nendpoint=${url}\n`); } finally { closeSync(fd); }
    } catch { /* 别人抢先建了 —— 告知已经打过，不影响主命令 */ }
    return true;
  } catch (err) {
    _lastError = err;
    return false;
  }
}

/**
 * 只关身份（第一档退出）。匿名计数照发。
 *
 * 🔴 落的是一个**标记文件**而不是改环境变量：环境变量只对当前进程有效，
 *    而用户说的「关掉」是一个持久的决定。标记优先级高于 `GEOLY_TELEMETRY_IDENTITY=on`
 *    （见 identityEnabled）—— 用户关过就是关过，配置不该把它掀回来。
 */
export function identityOff() {
  telemetryDir();
  try {
    const fd = openSync(identityOffPath(), 'wx', 0o600);
    try { appendFileSync(fd, `off-at=${new Date().toISOString()}\n`); } finally { closeSync(fd); }
  } catch { /* 已经关过了 */ }
  return true;
}

/** 撤销上面那个决定。**不会**自动打开身份采集 —— 还要过环境变量与告知两道门。 */
export function identityOn() {
  try { unlinkSync(identityOffPath()); } catch { /* 本来就没关过 */ }
  return true;
}

/**
 * 清空本机所有埋点数据。
 *
 * 🔴 **在上报锁下做**，否则正在 flush 的那个进程会把 sending 里的事件发出去，
 *    「删掉了」变成「删掉了但还是发出去了」。
 * 🔴 `install-id` 也一起删：留着它，下一条事件仍然接得回同一条时间线，
 *    那样「删除」只是删了一半（Codex 2026-09-09 指出）。
 * 🔴 **只管本机。** 已经发出去的记录要服务端删，而那条通道还没建 ——
 *    所以这里如实说「本机已清空、服务端另说」，不假装自己能远程删。
 */
export function purgeLocal() {
  const dir = join(stateDir(), 'telemetry');
  // 目录都不在 = 本来就没有数据。**不为了删而先建目录**（那会在
  // `GEOLY_TELEMETRY=0` 的机器上凭空写出东西来）。
  if (!existsSync(dir)) return { removed: 0, remaining: [] };

  const release = acquire(lockPath());
  try {
    // 🔴 **删的是目录里除锁以外的全部文件，不是一张手写清单。**
    //    手写清单漏过 `sending.tomb.ndjson` 与 `sending.tomb.mark`
    //    （Codex 2026-09-09 指出）—— 墓碑里没被 mark 覆盖的尾部，
    //    下一次 flush 会**扫回队列并发出去**：用户以为删干净了，
    //    结果删完还发了一批。告知里还写着「删除」，那就是一句假话。
    //    清单式删除的问题不是这次漏了哪个，是**它会一直漏**：
    //    每加一个新的状态文件都要有人记得回来改这里。
    //    ⚠️ 例外只有锁本身：它此刻正被我们持有，且里面没有任何埋点数据。
    const lock = lockPath();
    let removed = 0;
    const remaining = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p === lock || name.startsWith(basename(lock))) { remaining.push(name); continue; }
      try {
        rmSync(p, { recursive: true, force: true });
        removed++;
      } catch {
        remaining.push(name);   // 删不掉要说出来，不能算「已清空」
      }
    }
    return { removed, remaining };
  } finally { release(); }
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
    telemetryDir();
    write(uploadNoticeText(url));
    // 'wx' = 原子 no-replace：并发首跑只有一个能建成，别的走 catch，
    // 但那时告知已经打过了，重复的只是打印，不是漏打。
    // 不 fsync：丢了标记的后果只是多打一次告知，为它在**每个用户的第一条命令**上
    // 加一次同步 fsync 不划算（T-5：埋点不得让主命令变慢）。
    try {
      const fd = openSync(p, 'wx', 0o600);
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
    telemetryDir();
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
  // 🔴 **导出一律剥掉身份三项。**（Codex 2026-09-09 在 diff 复查里揪出来的 P0）
  //    `stats --export data.json` 出来的文件正是拖进 `docs/dashboard/index.html`
  //    那个匿名页面的东西，而那个页面把整个 events 数组交给浏览器。
  //    「页面不渲染这几个字段」挡不住任何事：文件里有、devtools 里就有。
  //    ⚠️ 摄入端有 serializeAnonymousEvent，**那是另一条路径**，
  //    覆盖不到本地导出 —— 出口不止一个，每一个都要自己剥。
  const clean = events.filter(isValidEvent).map(anonymize);
  return stringify({ schema: 'geoly.skills.telemetry-export/1', count: clean.length, events: clean });
}

/** 只保留匿名字段的一份拷贝。正向 pick，不是「删掉那三个」—— 加字段时不会漏。 */
function anonymize(ev) {
  const out = {};
  for (const k of ANONYMOUS_FIELD_NAMES) {
    if (Object.hasOwn(ev, k)) out[k] = ev[k];
  }
  return out;
}
