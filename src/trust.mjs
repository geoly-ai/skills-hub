// trust floor（抗回滚下限）与 wire 通用校验
// 规范：02-registry.md §5（写入规则 / 单调提交）、§6（验证链第 3、6 步）、
//       11-wire-contract.md §2（解析规则）、§3（canonical）、§5（原子写）
//
// 本模块是「信任与制品链」这一簇的地基：snapshot.mjs / attestation.mjs /
// artifact.mjs 都从这里拿 wire 校验器与错误类型，避免各写一份而分叉
// （分叉点就是绕过点 —— 01-artifacts.md §6.3 同理）。
import { createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { writeAtomic } from './atomic-fs.mjs';
import { stringify } from './canonical-json.mjs';
import { acquire } from './lock.mjs';
import { assertNoSymlinkInChain } from './safe-fs.mjs';

// ── 错误类型 ────────────────────────────────────────────────────────────────
// 退出码见 09-cli.md §6。每个错误都带 `violation`：🔴 报出**具体违规项**，
// 不是笼统「验证失败」——排障时「哪一条」比「失败了」有用得多。

export class WireError extends Error {
  constructor(violation, msg) {
    super(`[${violation}] ${msg}`);
    this.name = 'WireError';
    this.violation = violation;
    this.code = 1; // 解析失败
  }
}

/** 完整性失败：验签失败、摘要不符、算法不认识、回滚攻击（退出码 2） */
export class IntegrityError extends Error {
  constructor(violation, msg) {
    super(`[${violation}] ${msg}`);
    this.name = 'IntegrityError';
    this.violation = violation;
    this.code = 2;
  }
}

/** timestamp 过期且未给 --allow-stale（退出码 8） */
export class StaleError extends Error {
  constructor(msg) {
    super(`[E_STALE] ${msg}`);
    this.name = 'StaleError';
    this.violation = 'E_STALE';
    this.code = 8;
  }
}

/** CLI 版本低于 timestamp 的 min_cli_version（退出码 11） */
export class MinCliVersionError extends Error {
  constructor(msg) {
    super(`[E_MIN_CLI_VERSION] ${msg}`);
    this.name = 'MinCliVersionError';
    this.violation = 'E_MIN_CLI_VERSION';
    this.code = 11;
  }
}

// ── wire JSON 严格解析（11-wire-contract.md §2） ────────────────────────────

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const REPO = 'geoly-ai/skills-hub';
export const CLOCK_SKEW_SECONDS = 300; // §3：SKEW = 5 分钟
export const TIMESTAMP_MAX_VALIDITY_SECONDS = 7 * 24 * 3600;

export const RE_ASSET_SHA256 = /^sha256:[0-9a-f]{64}$/;
export const RE_TREE_DIGEST = /^geoly-tree-v1:sha256:[0-9a-f]{64}$/;
export const RE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** 🔴 摘要值必须自带算法标识（01-artifacts.md §6.1）。裸 hex 一律不认。 */
export const RE_ANY_DIGEST = /^([A-Za-z0-9-]+):([A-Za-z0-9-]+):([0-9a-f]+)$/;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * 🔴 自带的严格 JSON 解析器，**不用** `canonical-json.mjs` 的 `parseStrict`。
 *
 * 为什么不复用：那一份的重复 key 扫描比较的是**转义前的原文**，于是
 *
 *     {"a":1,"a":2}
 *
 * 会被静默接受成 `{a: 2}` —— 既绕过「拒绝重复 key」，也能绕过
 * `additionalProperties: false`（把一个安全字段用转义形式写第二遍，
 * 旧值被后一个悄悄覆盖）。已实测复现，详见交付汇报。
 *
 * 这里一次遍历同时落实 §2 的全部解析规则：
 *   - 只接受 `(0|[1-9][0-9]*)` 形状的数字字面量（拒浮点、指数、前导零、负数、`-0`）；
 *   - 重复 key 按**解码后**的 key 判定；
 *   - 字符串禁 C0/C1（**key 也判**）、禁未配对代理、禁非法转义、禁裸控制符；
 *   - 只接受 JSON 允许的四种空白，拒绝尾随内容。
 */
export function parseWireText(text, where = 'document') {
  let i = 0;
  const n = text.length;

  const fail = (v, m) => { throw new WireError(v, `${where} @${i}：${m}`); };

  function ws() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  }

  function checkNoControl(s, kind) {
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
        fail('E_WIRE_CONTROL_CHAR', `${kind} 含 C0/C1 控制符 U+${c.toString(16).padStart(4, '0')}`);
      }
    }
  }

  function hex4() {
    if (i + 4 > n) fail('E_WIRE_PARSE', '\\u 转义被截断');
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('E_WIRE_PARSE', `非法 \\u 转义 \\u${h}`);
    i += 4;
    return parseInt(h, 16);
  }

  function str(kind) {
    if (text[i] !== '"') fail('E_WIRE_PARSE', '期待字符串');
    i++;
    let out = '';
    for (;;) {
      if (i >= n) fail('E_WIRE_PARSE', '字符串未闭合');
      const ch = text[i];
      const cc = text.charCodeAt(i);
      if (ch === '"') { i++; break; }
      if (cc < 0x20) fail('E_WIRE_CONTROL_CHAR', `${kind} 含裸控制符 U+${cc.toString(16).padStart(4, '0')}`);
      if (ch !== '\\') {
        // 🔴 未转义的孤立代理。`parseWireJson` 那条路上严格 UTF-8 解码已经挡掉了，
        //    但 `parseWireText` 直接吃 JS 字符串时不会 —— 导出的契约得自己完整。
        if (cc >= 0xd800 && cc <= 0xdbff) {
          const lo = text.charCodeAt(i + 1);
          if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail('E_WIRE_LONE_SURROGATE', `${kind} 含未转义的孤立高位代理`);
          out += text[i] + text[i + 1]; i += 2; continue;
        }
        if (cc >= 0xdc00 && cc <= 0xdfff) fail('E_WIRE_LONE_SURROGATE', `${kind} 含未转义的孤立低位代理`);
        out += ch; i++; continue;
      }
      i++;
      const e = text[i];
      i++;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const u = hex4();
          if (u >= 0xd800 && u <= 0xdbff) {
            // 🔴 BMP 外必须写成完整代理对；lone surrogate → 拒绝整个文档（§3.4）
            if (text[i] !== '\\' || text[i + 1] !== 'u') fail('E_WIRE_LONE_SURROGATE', '高位代理后没有跟低位代理');
            i += 2;
            const lo = hex4();
            if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail('E_WIRE_LONE_SURROGATE', '高位代理后不是低位代理');
            out += String.fromCharCode(u, lo);
          } else if (u >= 0xdc00 && u <= 0xdfff) {
            fail('E_WIRE_LONE_SURROGATE', '出现孤立的低位代理');
          } else {
            out += String.fromCharCode(u);
          }
          break;
        }
        default: fail('E_WIRE_PARSE', `非法转义 \\${e ?? '<EOF>'}`);
      }
    }
    checkNoControl(out, kind);
    return out;
  }

  function num() {
    const start = i;
    while (i < n && /[-+0-9.eExX]/.test(text[i])) i++;
    const tok = text.slice(start, i);
    if (!/^(0|[1-9][0-9]*)$/.test(tok)) {
      fail('E_WIRE_NUMBER', `只允许 [0, 2^53-1] 的非负整数字面量，得到 ${tok}`);
    }
    const v = Number(tok);
    if (!Number.isSafeInteger(v)) fail('E_WIRE_NUMBER', `数字超出 2^53-1：${tok}`);
    return v;
  }

  function value(depth) {
    if (depth > 64) fail('E_WIRE_DEPTH', 'JSON 嵌套过深');
    ws();
    if (i >= n) fail('E_WIRE_PARSE', '文档意外结束');
    const ch = text[i];
    if (ch === '{') {
      i++;
      // 🔴 `Object.create(null)`：用字面量 `{}` 时，`obj["__proto__"] = v` 走的是
      //    setter，**不会**产生自有属性 —— 于是 `Object.keys()` 看不到它，
      //    `additionalProperties: false` 就被绕过了，同时还污染了原型。
      //    Codex 实测：`parseWireText('{"__proto__":{"pwn":1}}')` 曾能通过
      //    `assertExactKeys(o, {required: [], optional: []})`。
      const obj = Object.create(null);
      const seen = new Set();
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        const k = str('key');
        // 🔴 按**解码后**的 key 判重复 —— 这正是上游 parseStrict 漏掉的那一步
        if (seen.has(k)) fail('E_WIRE_DUP_KEY', `重复 key ${JSON.stringify(k)}`);
        seen.add(k);
        ws();
        if (text[i] !== ':') fail('E_WIRE_PARSE', '期待 :');
        i++;
        obj[k] = value(depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('E_WIRE_PARSE', '期待 , 或 }');
      }
    }
    if (ch === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('E_WIRE_PARSE', '期待 , 或 ]');
      }
    }
    if (ch === '"') return str('string');
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return num();
    fail('E_WIRE_PARSE', `意外字符 ${JSON.stringify(ch)}`);
  }

  const out = value(0);
  ws();
  if (i !== n) fail('E_WIRE_TRAILING', '文档末尾有多余内容');
  return out;
}

/** 大小上限 → 严格 UTF-8 → 严格解析。🔴 先查大小再解码，别为 500 MB 的「JSON」分配内存。 */
export function parseWireJson(bytes, where = 'document') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > MAX_JSON_BYTES) {
    throw new WireError('E_WIRE_TOO_LARGE', `${where} 为 ${buf.length} 字节，超过 ${MAX_JSON_BYTES}`);
  }
  // 🔴 按**原始字节**判 BOM：TextDecoder('utf-8') 默认会把 BOM 吃掉，
  //    解码后再判 U+FEFF 是判不到的。
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new WireError('E_WIRE_BOM', `${where} 含 UTF-8 BOM`);
  }
  let text;
  try {
    text = utf8Strict.decode(buf);
  } catch {
    throw new WireError('E_WIRE_UTF8', `${where} 不是有效 UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff) throw new WireError('E_WIRE_BOM', `${where} 含 BOM`);
  const doc = parseWireText(text, where);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new WireError('E_WIRE_NOT_OBJECT', `${where} 顶层必须是对象`);
  }
  return doc;
}

/**
 * 🔴 canonical 往返：需要逐字节复现的对象（snapshot / timestamp，§3）
 * 重新 canonical 序列化后必须与原字节完全相同。
 *
 * 这一条比任何字段级检查都强：它同时挡掉 key 顺序被打乱、缩进被改、
 * 非 ASCII 未转义、多余空白等一切「语义相同但字节不同」的变体 ——
 * 而字节正是签名与 sha256 所绑定的东西。
 */
export function assertCanonicalBytes(bytes, doc, where) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const re = Buffer.from(stringify(doc), 'utf8');
  if (!buf.equals(re)) {
    throw new WireError('E_NOT_CANONICAL', `${where} 不是 canonical 形式（11-wire-contract.md §3）`);
  }
}

/**
 * 🔴 `additionalProperties: false` + 必填齐全（§2）。
 * 「宁可让旧 CLI 拒绝新字段，也不要让它忽略一个它不理解的安全相关字段」。
 */
export function assertExactKeys(obj, { required = [], optional = [] }, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new WireError('E_WIRE_TYPE', `${where} 必须是对象`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new WireError('E_WIRE_UNKNOWN_FIELD', `${where} 出现未知字段 ${k}`);
  }
  for (const k of required) {
    if (!Object.hasOwn(obj, k)) throw new WireError('E_WIRE_MISSING_FIELD', `${where} 缺少必填字段 ${k}`);
  }
  return obj;
}

export function assertUint(v, where) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new WireError('E_WIRE_NUMBER', `${where} 必须是 [0, 2^53-1] 的非负整数`);
  }
  return v;
}

export function assertString(v, where) {
  if (typeof v !== 'string') throw new WireError('E_WIRE_TYPE', `${where} 必须是字符串`);
  return v;
}

export function assertStringArray(v, where) {
  if (!Array.isArray(v)) throw new WireError('E_WIRE_TYPE', `${where} 必须是数组`);
  v.forEach((x, k) => assertString(x, `${where}[${k}]`));
  return v;
}

/**
 * 严格时间：`YYYY-MM-DDTHH:MM:SSZ`，且必须能**往返** ——
 * `2026-02-30T00:00:00Z` 形状合法但不是真日期，正则挡不住。
 */
export function parseWireTime(s, where) {
  assertString(s, where);
  if (!RE_TIME.test(s)) throw new WireError('E_WIRE_TIME', `${where} 必须是 YYYY-MM-DDTHH:MM:SSZ，得到 ${s}`);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new WireError('E_WIRE_TIME', `${where} 不是有效时间：${s}`);
  const back = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (back !== s) throw new WireError('E_WIRE_TIME', `${where} 不是真实日期：${s}`);
  return Math.floor(ms / 1000);
}

export function assertAssetDigest(v, where) {
  assertString(v, where);
  if (!RE_ASSET_SHA256.test(v)) throw new WireError('E_WIRE_DIGEST', `${where} 必须形如 sha256:<64 小写 hex>，得到 ${v}`);
  return v;
}

/**
 * 🔴 树摘要必须带算法标识；**遇到不认识的算法前缀 → 拒绝，不降级**
 * （01-artifacts.md §6.1 末段）。
 */
export function assertTreeDigest(v, where) {
  assertString(v, where);
  if (RE_TREE_DIGEST.test(v)) return v;
  const m = RE_ANY_DIGEST.exec(v);
  if (m) {
    throw new IntegrityError('E_UNKNOWN_DIGEST_ALGO', `${where} 用了不认识的摘要算法 ${m[1]}:${m[2]}，拒绝安装（不降级）`);
  }
  throw new WireError('E_WIRE_DIGEST', `${where} 必须形如 geoly-tree-v1:sha256:<64 hex>，得到 ${v}`);
}

export function sha256Of(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

// ── trust floor ─────────────────────────────────────────────────────────────

export const TRUST_SCHEMA = 'geoly.skills.trust/1';
export const TRUST_FILE = 'trust.json';
export const METADATA_LOCK = 'metadata.lock.db';

const TRUST_KEYS = {
  required: ['schema', 'timestamp_version', 'timestamp_sha256', 'latest_snapshot', 'snapshot_sha256', 'last_verified_at'],
};

export function validateTrustFloor(doc) {
  assertExactKeys(doc, TRUST_KEYS, 'trust.json');
  if (doc.schema !== TRUST_SCHEMA) {
    // §4：主版本不同 → 拒绝，不做「尽力而为地解析」
    throw new WireError('E_SCHEMA', `trust.json 的 schema 必须是 ${TRUST_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  assertUint(doc.timestamp_version, 'trust.timestamp_version');
  assertUint(doc.latest_snapshot, 'trust.latest_snapshot');
  assertAssetDigest(doc.timestamp_sha256, 'trust.timestamp_sha256');
  assertAssetDigest(doc.snapshot_sha256, 'trust.snapshot_sha256');
  parseWireTime(doc.last_verified_at, 'trust.last_verified_at');
  return doc;
}

/**
 * 🔴 固定 state 目录：先 realpath，再拒绝其下的 symlink。
 *
 * 不做这一步的后果：`trust.json` 或 `metadata.lock.db` 被换成指向别处的软链时，
 * 两个进程会**锁住不同的对象**，排他锁形同虚设。
 * （对手 E 拥有完全控制时本地任何检查都不可信 —— 07-threat-model.md §5 已承认；
 *  这里挡的是「同权限进程顺手做的替换」，不是完全控制。）
 */
export function resolveStateDir(stateDir) {
  if (!isAbsolute(stateDir)) throw new WireError('E_STATE_DIR', `stateDir 需要绝对路径：${stateDir}`);
  const real = realpathSync(stateDir);
  for (const f of [TRUST_FILE, METADATA_LOCK]) assertNoSymlinkInChain(real, f);
  return real;
}

/**
 * 读 floor。文件不存在 → `null`（bootstrap，残余风险见 07-threat-model.md 6c）。
 * 🔴 文件存在但非法 → **抛错停机**，绝不当成 null。
 * 「读到非法内容则 fail-closed，绝不因为上次报错了就重置」——11-wire-contract.md §5。
 */
export function readTrustFloor(stateDir) {
  const dir = resolveStateDir(stateDir);
  const path = join(dir, TRUST_FILE);
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (!st.isFile()) throw new WireError('E_TRUST_NOT_FILE', `${path} 不是普通文件`);
  const bytes = readFileSync(path);
  const doc = validateTrustFloor(parseWireJson(bytes, 'trust.json'));
  // 自己写出去的东西必须是 canonical；不是就说明被人动过或版本不匹配 → 停机
  assertCanonicalBytes(bytes, doc, 'trust.json');
  return doc;
}

/**
 * 🔴 抗回滚比较核心（02-registry.md §6 第 3 步 + snapshot 单调性）。
 *
 * 纯函数，无 IO —— 让并发测试与单元测试都能直打这段逻辑。
 * 两个调用点共用它，避免「网络那条路」与「落盘那条路」分叉：
 *   - `checkAntiReplay`：候选 vs **启动时读到的** floor，用于接受/拒绝；
 *   - `advanceTrustFloor`：候选 vs **锁内重读的** floor，用于提交。
 * 两处的差别只在「磁盘更新」怎么处理（拒绝 vs 重做），由 `onDiskNewer` 区分。
 *
 * @param {object|null} floor 磁盘上的 floor
 * @param {{timestamp_version:number,timestamp_sha256:string,latest_snapshot:number,snapshot_sha256:string}} cand
 * @param {'reject'|'redo'} onDiskNewer
 */
export function compareFloor(floor, cand, onDiskNewer = 'reject') {
  if (floor === null) return { action: 'write', reason: 'bootstrap' };

  // ① version 更低
  if (cand.timestamp_version < floor.timestamp_version) {
    if (onDiskNewer === 'redo') {
      // 🔴 不是「沿用磁盘值继续」，而是要求调用方**从磁盘 floor 重做完整绑定比较**。
      // 沿用自己已验的旧 timestamp 继续下载 → floor 虽未回退，本进程仍按旧快照装东西。
      return { action: 'redo', reason: 'disk-newer', diskFloor: floor };
    }
    throw new IntegrityError(
      'E_ROLLBACK',
      `timestamp.version=${cand.timestamp_version} 低于本地 floor ${floor.timestamp_version}：回滚攻击`,
    );
  }

  // ② version 相同 → 🔴 三元组必须完全一致（v6 漏了 timestamp_sha256）
  if (cand.timestamp_version === floor.timestamp_version) {
    const diffs = [];
    if (cand.latest_snapshot !== floor.latest_snapshot) diffs.push('latest_snapshot');
    if (cand.snapshot_sha256 !== floor.snapshot_sha256) diffs.push('snapshot_sha256');
    if (cand.timestamp_sha256 !== floor.timestamp_sha256) diffs.push('timestamp_sha256');
    if (diffs.length) {
      throw new IntegrityError(
        'E_FLOOR_MISMATCH',
        `同一 timestamp.version=${cand.timestamp_version} 却有不同的 ${diffs.join(' / ')}：完整性事件`,
      );
    }
    return { action: 'unchanged', reason: 'same-version' };
  }

  // ③ version 更高 → 还要过 snapshot 单调性
  if (cand.latest_snapshot < floor.latest_snapshot) {
    throw new IntegrityError(
      'E_SNAPSHOT_ROLLBACK',
      `timestamp 更新（${floor.timestamp_version} → ${cand.timestamp_version}）却把 latest_snapshot ` +
        `从 ${floor.latest_snapshot} 退回 ${cand.latest_snapshot}：旧 yank 状态会重新生效`,
    );
  }
  if (cand.latest_snapshot === floor.latest_snapshot && cand.snapshot_sha256 !== floor.snapshot_sha256) {
    throw new IntegrityError(
      'E_SNAPSHOT_SWAP',
      `latest_snapshot=${cand.latest_snapshot} 未变，snapshot_sha256 却变了：完整性事件`,
    );
  }
  return { action: 'write', reason: 'advance' };
}

/** 候选 timestamp vs 本地 floor（§6 第 3 步）。通过则返回，否则抛 IntegrityError。 */
export function checkAntiReplay(floor, candidate) {
  return compareFloor(floor, candidate, 'reject');
}

export function makeFloor({ timestamp_version, timestamp_sha256, latest_snapshot, snapshot_sha256, now = new Date() }) {
  return validateTrustFloor({
    schema: TRUST_SCHEMA,
    timestamp_version,
    timestamp_sha256,
    latest_snapshot,
    snapshot_sha256,
    last_verified_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
}

/**
 * 🔴 在 metadata 排他锁下原子推进 floor（02-registry.md §5）。
 *
 * 「写前重读」本身不是 CAS —— 没有真锁时 P1、P2 都重读 floor=10，P2 写 12、
 * P1 写 11，仍会回退。所以**真锁是必需的，重读只是额外的防御层**，两者都要。
 *
 * 🔴 临界区内不得 COMMIT（COMMIT 会释放 SQLite 的排他锁）；写盘走 writeAtomic，
 * 释放锁在 finally 里做。
 *
 * 返回 `{action}`：
 *   - `written`   已推进
 *   - `unchanged` 同版本且三元组一致，无需写
 *   - `redo`      磁盘 floor 更新，🔴 调用方必须用 `result.diskFloor` 重做 §6 第 3–5 步，
 *                 **不得**沿用自己已验的旧 timestamp/旧 snapshot 继续下载
 */
export function advanceTrustFloor(stateDir, candidate, { cli = 'skills-hub' } = {}) {
  validateTrustFloor(candidate);
  const dir = resolveStateDir(stateDir);
  const release = acquire(join(dir, METADATA_LOCK), { cli });
  try {
    const disk = readTrustFloor(dir); // 🔴 锁内重读磁盘，不用内存里那份
    const verdict = compareFloor(disk, candidate, 'redo');
    if (verdict.action === 'write') {
      writeAtomic(join(dir, TRUST_FILE), stringify(candidate));
      return { action: 'written', reason: verdict.reason, floor: candidate };
    }
    if (verdict.action === 'unchanged') return { action: 'unchanged', reason: verdict.reason, floor: disk };
    return { action: 'redo', reason: verdict.reason, diskFloor: verdict.diskFloor };
  } finally {
    release();
  }
}

/**
 * 🔴 提交前的再核对（Codex 评审提出的第二个竞态）。
 *
 * `advanceTrustFloor` 释放锁之后，另一个进程可以立刻把 floor 推得更高；
 * 本进程若继续按旧 snapshot 下载安装，就等于「新 yank 没能阻止并发中的旧安装」。
 * 规格没有明确这一点（见交付汇报的「规格缺口」一节），
 * 这里提供判据，由安装事务在**提交前**调用：不一致就放弃，而不是装完再说。
 *
 * ⚠️ **它本身不是提交屏障**：本函数不持锁，检查完到真正提交之间 floor 仍可能被推进。
 * 要让它成为屏障，安装事务必须在**自己持有 metadata 锁的那段临界区内**调用它，
 * 并在同一段临界区里完成提交。单独调用只是把窗口从「整个安装过程」收窄到
 * 「检查到提交之间」，不是消除。
 */
export function assertFloorUnchanged(stateDir, expected) {
  const disk = readTrustFloor(stateDir);
  if (disk === null) {
    throw new IntegrityError('E_FLOOR_VANISHED', 'trust floor 在本次安装期间消失了');
  }
  for (const k of ['timestamp_version', 'timestamp_sha256', 'latest_snapshot', 'snapshot_sha256']) {
    if (disk[k] !== expected[k]) {
      throw new IntegrityError(
        'E_FLOOR_MOVED',
        `安装期间 trust floor 的 ${k} 变了（${expected[k]} → ${disk[k]}）：放弃本次安装并重跑`,
      );
    }
  }
  return disk;
}
