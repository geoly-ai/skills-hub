// journal —— write-ahead 事务日志的读写与**严格**校验。
//
// 规格：04-install.md §5.2（第 6 步写什么）、§5.3（逐项段模型）、§5.4（合法取值与
// 持久化时点、只有这些情况判 corrupt）、§5.4.1（rollback 的正式 schema、入场分类
// 封闭表、(op,state,cleanup,entry_class) 一致性矩阵）、§5.4.2（ledger_image 契约）、
// §4.2（adopt_assertions / unadopt_assertions）、11-wire-contract.md §2/§3/§5/§7。
//
// 🔴 本模块只做「读写 + 校验」，**不做调度**。段的推进在 install.mjs，
//    反向段的调度在 recover.mjs。把调度混进来会让「正向 state 只用于一致性校验」
//    这条铁律（§5.4.1 v37）在实现层被悄悄破坏。
//
// 🔴 全部写入走 src/atomic-fs.mjs —— 绕过它的裸 fs 写对持久性影子不可见，
//    崩溃测试会**静默地测不到**。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrict, stringify } from './canonical-json.mjs';
import { writeAtomic, rmtreeFsync } from './atomic-fs.mjs';
import { crc32cHex } from './crc32c.mjs';
import { isSafeSegment } from './safe-fs.mjs';

export const JOURNAL_SCHEMA = 'geoly.skills.journal/1';

/** §11 §2：单个 JSON 文档 ≤ 8 MiB，**解析前先查文件大小** */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * fail-closed 停机。
 * 🔴 `corrupt = true` 是整个内核与测试框架共用的判据（子进程以 91 退出）。
 */
export class Corrupt extends Error {
  constructor(msg) {
    super(`corrupt: ${msg}`);
    this.name = 'Corrupt';
    this.corrupt = true;
    this.code = 5;
  }
}
export const bad = (msg) => { throw new Corrupt(msg); };

// ── 枚举（§5.4「合法取值」）──────────────────────────────────────────────────

/** 🔴 只有三种 item op。`logical-only` **不是**第四种（§5.10 v27）。 */
export const ITEM_OPS = ['swap', 'install-new', 'retire-only'];
/** 🔴 **没有 `retiring`** —— v10 的段模型取消了它（§5.3/§5.4）。 */
export const ITEM_STATES = ['planned', 'retired', 'swapped', 'verified', 'done', 'corrupt'];
/** `item.cleanup`：缺席 → tar_durable → done */
export const CLEANUP_STATES = ['tar_durable', 'done'];
export const PHASES = ['prepared', 'cleanup_pending', 'completed'];
export const ENTRY_CLASSES = [
  'noop', 'as-retired', 'as-retired-cleaned', 'as-swapped', 'as-swapped-cleaned', 'as-installed',
];
export const RSTATES = ['pending', 't_parked', 'restored'];
export const ASSERTION_STATES = ['ok', 'assertion-corrupt'];

/** §5.4.1「合法迁移」—— 其余一律 corrupt */
export const RSTATE_PATH = {
  noop: ['restored'],
  'as-retired': ['pending', 'restored'],
  'as-retired-cleaned': ['pending', 'restored'],
  'as-swapped': ['pending', 't_parked', 'restored'],
  'as-swapped-cleaned': ['pending', 't_parked', 'restored'],
  'as-installed': ['pending', 'restored'],
};

/**
 * §5.4.1 `(op, 正向 state, cleanup, entry_class)` 的**闭合一致性矩阵**。
 * 🔴 只做校验，不做调度；未列组合即 `corrupt`（§11 §7「未定义即拒绝」）。
 *
 * key = `${op}|${state}|${cleanup ?? '-'}`
 */
export const CONSISTENCY = {
  // op = swap
  'swap|planned|-': ['noop', 'as-retired'],
  'swap|retired|-': ['as-retired', 'as-swapped'],
  'swap|swapped|-': ['as-swapped'],
  'swap|verified|-': ['as-swapped'],
  'swap|done|-': ['as-swapped'],
  // 🔴 tar_durable 是 checkpoint，**递归删除发生在它之后** —— retired/ 可能完整、
  //    也可能已被删到部分或空。v38 只允许 cleaned，与清理协议矛盾。
  'swap|done|tar_durable': ['as-swapped', 'as-swapped-cleaned'],
  'swap|done|done': ['as-swapped-cleaned'],

  // op = retire-only
  'retire-only|planned|-': ['noop', 'as-retired'],
  'retire-only|retired|-': ['as-retired'],
  'retire-only|verified|-': ['as-retired'],
  'retire-only|done|-': ['as-retired'],
  'retire-only|done|tar_durable': ['as-retired', 'as-retired-cleaned'],
  'retire-only|done|done': ['as-retired-cleaned'],

  // op = install-new —— 🔴 它也有 cleanup 维度（v38 漏了）：§5.6 对它是空操作，
  // 但 cleanup 字段仍会依次经过 缺席 → tar_durable → done，三种都必须显式列出。
  'install-new|planned|-': ['noop', 'as-installed'],
  'install-new|swapped|-': ['as-installed'],
  'install-new|verified|-': ['as-installed'],
  'install-new|done|-': ['as-installed'],
  'install-new|done|tar_durable': ['as-installed'],
  'install-new|done|done': ['as-installed'],
};

/** §11 §2 的摘要形式 */
const RE_TREE_DIGEST = /^geoly-tree-v1:sha256:[0-9a-f]{64}$/;
const RE_TX_DIGEST = /^geoly-tx-v1:sha256:[0-9a-f]{64}$/;
const RE_SHA256 = /^sha256:[0-9a-f]{64}$/;
export const isTreeDigest = (s) => typeof s === 'string' && RE_TREE_DIGEST.test(s);
export const isTxDigest = (s) => typeof s === 'string' && RE_TX_DIGEST.test(s);
export const isSha256 = (s) => typeof s === 'string' && RE_SHA256.test(s);
export const isUint = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * 🔴 **持久化 map 的 key 也是不可信输入**（Codex 第三轮 P0）。
 *
 * `journal.items` / `adopt_assertions` / `rollback.items` / `ledger.entries` /
 * `manifest.items` / `repair-intent.plan.items` 的键随后都会进 `join()`、`rename`、
 * `rmtree` —— 一个 `../` 或绝对路径就能把清理动作导出 `.geoly` 之外。
 * schema 校验只看值不看键，正好漏掉这一类。
 *
 * 判据：**单个安全 segment**（同 §01-4 的路径 grammar），不是「一条相对路径」——
 * skill 的名字就是磁盘上的一级目录名，本来就不该带斜杠。
 */
export function assertSafeName(name, where) {
  if (!isSafeSegment(name)) bad(`${where}：${JSON.stringify(name)} 不是合法的单段目录名（路径穿越防线）`);
  // 🔴 `isSafeSegment` 的字符集 `[A-Za-z0-9._-]+` **本身允许 `.` 与 `..`** ——
  //    实测确认过。只调它就等于把路径穿越放进来了；`..` 必须在**分段之后**单独判
  //    （同 safe-fs 里那条注释：不能只做字符串 includes，也不能只做字符集匹配）。
  if (name === '.' || name === '..') bad(`${where}：${name} 是路径 segment，不得作为名字`);
  if (name === '.geoly') bad(`${where}：${name} 是状态目录名，不得作为 entry 名`);
  return name;
}

// ── 通用的「未知字段即拒绝」（§11 §2）───────────────────────────────────────

export function assertKeys(obj, required, optional, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    bad(`${where} 必须是对象`);
  }
  const keys = new Set(Object.keys(obj));
  for (const k of required) if (!keys.has(k)) bad(`${where} 缺必填字段 ${k}`);
  const allowed = new Set([...required, ...optional]);
  for (const k of keys) if (!allowed.has(k)) bad(`${where} 出现未知字段 ${k}`);
}

/** §11 §2：解析前先查文件大小；解析用 parseStrict（拒绝重复 key） */
export function readJsonStrict(path, where) {
  const size = statSync(path).size;
  if (size > MAX_JSON_BYTES) bad(`${where} ${path} 有 ${size} 字节，超过 8 MiB 上限`);
  const text = readFileSync(path, 'utf8');
  try {
    return parseStrict(text);
  } catch (e) {
    throw new Corrupt(`${where} ${path} 解析失败：${e.message}`);
  }
}

// ── ledger_image（§5.4.2）───────────────────────────────────────────────────

/**
 * 🔴 `entries` / `roots` 的值允许 `null` 哨兵（§11 §2 白名单里逐个列出的位置），
 *    语义是「该键复位后应不存在 / 本次删除它」。**不是**「不 patch」。
 */
function validateImageSide(side, where, { allowAuditAppend }) {
  assertKeys(side, ['entries', 'roots', 'last_applied_generation'],
    allowAuditAppend ? ['frozen_attic', 'audit_append'] : ['frozen_attic'], where);
  for (const k of ['entries', 'roots']) {
    const m = side[k];
    if (m === null || typeof m !== 'object' || Array.isArray(m)) bad(`${where}.${k} 必须是对象`);
    for (const [kk, vv] of Object.entries(m)) {
      if (vv !== null && (typeof vv !== 'object' || Array.isArray(vv))) {
        bad(`${where}.${k}[${kk}] 只允许对象或 null 哨兵`);
      }
    }
  }
  if (!isUint(side.last_applied_generation)) bad(`${where}.last_applied_generation 必须是非负整数`);
  if ('frozen_attic' in side && side.frozen_attic !== null
      && (typeof side.frozen_attic !== 'object' || Array.isArray(side.frozen_attic))) {
    bad(`${where}.frozen_attic 只允许对象或 null 哨兵`);
  }
  if ('audit_append' in side) {
    if (!Array.isArray(side.audit_append)) bad(`${where}.audit_append 必须是数组`);
    for (const e of side.audit_append) validateAuditEvent(e, `${where}.audit_append[]`);
  }
}

/** §4 的 audit 事件里 `kind` 的**封闭枚举** —— §11 §7「未定义即拒绝」 */
export const AUDIT_KINDS = [
  'installed-yanked', 'restored-yanked', 'restored-degraded', 'restored-state-unknown',
];

/** §4 的 audit 事件。🔴 `advisory` 一律「没有就缺席」，不是 `null`。 */
export function validateAuditEvent(e, where) {
  assertKeys(e, ['event_id', 'kind', 'subject', 'at'], ['artifact', 'advisory', 'note'], where);
  if (!isUint(e.event_id)) bad(`${where}.event_id 必须是非负整数`);
  if (e.event_id > Number.MAX_SAFE_INTEGER) bad(`${where}.event_id 超过 2^53-1`);
  if (!AUDIT_KINDS.includes(e.kind)) bad(`${where}.kind 未知取值 ${JSON.stringify(e.kind)}`);
  for (const k of ['artifact', 'advisory', 'note']) {
    if (k in e && (typeof e[k] !== 'string' || e[k] === '')) bad(`${where}.${k} 必须是非空字符串`);
  }
  if ('advisory' in e && !/^GSA-/.test(e.advisory)) bad(`${where}.advisory 必须形如 GSA-…`);
  assertKeys(e.subject, ['kind'], ['name'], `${where}.subject`);
  if (!['entry', 'target'].includes(e.subject.kind)) bad(`${where}.subject.kind 只能是 entry/target`);
  if (e.subject.kind === 'entry' && typeof e.subject.name !== 'string') {
    bad(`${where}.subject.name 在 kind=entry 时必填`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.at)) bad(`${where}.at 必须是严格 UTC 时间`);
}

export function validateLedgerImage(img, where = 'ledger_image') {
  assertKeys(img, ['ledger_existed', 'pre', 'post'], [], where);
  if (typeof img.ledger_existed !== 'boolean') bad(`${where}.ledger_existed 必须是布尔`);
  validateImageSide(img.pre, `${where}.pre`, { allowAuditAppend: false });
  // 🔴 安装事务的 post 里**只有** audit_append 一个 audit 相关字段；
  //    audit_archived_until 不在此处（§4「cursor 的唯一前进点」）。
  validateImageSide(img.post, `${where}.post`, { allowAuditAppend: true });
}

// ── 逐项校验 ─────────────────────────────────────────────────────────────────

/** §11 §2：`old_digest` / `new_digest` **按 `op` 定义必填/缺席**，不补裸 `null` */
function validateItem(name, it) {
  const where = `journal.items[${name}]`;
  assertSafeName(name, 'journal.items 的键');
  assertKeys(it, ['op', 'had_old', 'state'], ['old_digest', 'new_digest', 'cleanup'], where);
  if (!ITEM_OPS.includes(it.op)) bad(`${where}.op 未知取值 ${it.op}`);
  if (typeof it.had_old !== 'boolean') bad(`${where}.had_old 必须是布尔`);
  if (it.had_old !== (it.op !== 'install-new')) bad(`${where}.had_old 与 op 不一致`);
  if (!ITEM_STATES.includes(it.state)) bad(`${where}.state 未知取值 ${it.state}`);
  if ('cleanup' in it && !CLEANUP_STATES.includes(it.cleanup)) {
    bad(`${where}.cleanup 未知取值 ${it.cleanup}`);
  }
  const needOld = it.op !== 'install-new';
  const needNew = it.op !== 'retire-only';
  if (needOld && !isTreeDigest(it.old_digest)) bad(`${where}.old_digest 在 op=${it.op} 时必填且须是树摘要`);
  if (!needOld && 'old_digest' in it) bad(`${where}.old_digest 在 op=install-new 时必须缺席`);
  if (needNew && !isTreeDigest(it.new_digest)) bad(`${where}.new_digest 在 op=${it.op} 时必填且须是树摘要`);
  if (!needNew && 'new_digest' in it) bad(`${where}.new_digest 在 op=retire-only 时必须缺席`);
  // 🔴 §5.4.1 入场预检：禁止 swap 的 old_digest == new_digest —— 否则「T==new 要 park」
  //    与「T==old 不 park」两条规则无优先级、判不出来。结构门在生成 plan 时就该拒，
  //    这里是运行时的第二道（改一处就去看它的镜像）。
  if (it.op === 'swap' && it.old_digest === it.new_digest) {
    bad(`${where}：swap 的 old_digest == new_digest，物理 swap 不可判定（出路见 §4.2 的逐字节相同分支）`);
  }
}

function validateAssertionMap(m, key, obj) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) bad(`journal.${key} 必须是对象`);
  // 🔴 §11：没有对应逻辑项时**整个字段缺席**（不写 {}，也不写 null）
  if (Object.keys(m).length === 0) bad(`journal.${key} 为空时必须整个字段缺席，不得写 {}`);
  for (const [name, a] of Object.entries(m)) {
    const where = `journal.${key}[${name}]`;
    assertSafeName(name, `journal.${key} 的键`);
    assertKeys(a, ['artifact', 'tree_digest', 'state'], [], where);
    if (typeof a.artifact !== 'string' || a.artifact === '') bad(`${where}.artifact 必填`);
    if (!isTreeDigest(a.tree_digest)) bad(`${where}.tree_digest 必须是树摘要`);
    if (!ASSERTION_STATES.includes(a.state)) bad(`${where}.state 未知取值 ${a.state}`);
  }
  void obj;
}

/** 🔴 §4.2：`items` / `adopt_assertions` / `unadopt_assertions` **三者互不相交** */
export function allItemKeys(J) {
  const phys = Object.keys(J.items);
  const ad = Object.keys(J.adopt_assertions ?? {});
  const un = Object.keys(J.unadopt_assertions ?? {});
  const seen = new Set();
  for (const [label, list] of [['items', phys], ['adopt_assertions', ad], ['unadopt_assertions', un]]) {
    for (const n of list) {
      if (seen.has(n)) bad(`journal：${n} 同时出现在多个键集里（${label}），三者必须互不相交`);
      seen.add(n);
    }
  }
  return { phys, ad, un, all: [...seen] };
}

/**
 * §5.4.1 rollback 的正式 schema + 入场分类的合法组合。
 * 🔴 `direction` 与 `rollback` **同时存在或同时缺席**；只有其一 → corrupt。
 */
function validateRollback(J) {
  const hasDir = 'direction' in J;
  const hasRb = 'rollback' in J;
  if (hasDir !== hasRb) bad('journal：direction 与 rollback 必须同时存在或同时缺席');
  if (!hasDir) return;
  if (J.direction !== 'rollback') bad(`journal.direction 未知取值 ${J.direction}`);
  assertKeys(J.rollback, ['items'], [], 'journal.rollback');
  const rb = J.rollback.items;
  if (rb === null || typeof rb !== 'object' || Array.isArray(rb)) bad('journal.rollback.items 必须是对象');

  // 🔴 键集严格等于 items ∪ adopt_assertions ∪ unadopt_assertions，多一个少一个都 corrupt。
  //    （可以为空 {} —— logical-only 的空 items 事务。）
  const { phys, ad, un, all } = allItemKeys(J);
  const want = new Set(all);
  const got = new Set(Object.keys(rb));
  for (const k of want) if (!got.has(k)) bad(`journal.rollback.items 缺少 ${k}`);
  for (const k of got) if (!want.has(k)) bad(`journal.rollback.items 多出 ${k}`);

  for (const [name, r] of Object.entries(rb)) {
    const where = `journal.rollback.items[${name}]`;
    assertSafeName(name, 'journal.rollback.items 的键');
    assertKeys(r, ['entry_class', 'rstate'], [], where);
    if (!ENTRY_CLASSES.includes(r.entry_class)) bad(`${where}.entry_class 未知取值 ${r.entry_class}`);
    if (!RSTATES.includes(r.rstate)) bad(`${where}.rstate 未知取值 ${r.rstate}`);
    if (!RSTATE_PATH[r.entry_class].includes(r.rstate)) {
      bad(`${where}：entry_class=${r.entry_class} 不允许 rstate=${r.rstate}`);
    }
    if (phys.includes(name)) {
      const it = J.items[name];
      assertConsistent(name, it, r.entry_class);
    } else if (ad.includes(name)) {
      // adopt：state=ok 或 assertion-corrupt，两者都只允许 noop
      if (r.entry_class !== 'noop') bad(`${where}：adopt 项只允许 entry_class=noop`);
    } else if (un.includes(name)) {
      if (J.unadopt_assertions[name].state === 'assertion-corrupt') {
        // 🔴 §5.4 通用规则：unadopt 的 assertion-corrupt **不进入 rollback**
        bad(`${where}：unadopt 的 assertion-corrupt 不允许 rollback（唯一自动出路是 --continue）`);
      }
      if (r.entry_class !== 'noop') bad(`${where}：unadopt 项只允许 entry_class=noop`);
    }
  }
}

/** 查一致性矩阵。🔴 未列组合即 corrupt。 */
export function assertConsistent(name, it, entryClass) {
  const key = `${it.op}|${it.state}|${it.cleanup ?? '-'}`;
  const allowed = CONSISTENCY[key];
  if (!allowed) bad(`journal.items[${name}]：(op,state,cleanup)=${key} 不在闭合一致性矩阵内`);
  if (!allowed.includes(entryClass)) {
    bad(`journal.items[${name}]：${key} 不允许 entry_class=${entryClass}（允许 ${allowed.join('/')}）`);
  }
}

/** 只校验 (op,state,cleanup) 本身是否是矩阵里的一个合法行 —— 正向路径也要用 */
export function assertStateCombo(name, it) {
  const key = `${it.op}|${it.state}|${it.cleanup ?? '-'}`;
  if (it.state === 'corrupt') {
    // corrupt 是终态，不进矩阵（§5.4.1 已规定任一项 corrupt 则整个事务不允许 rollback）
    if ('cleanup' in it) bad(`journal.items[${name}]：corrupt 项不应有 cleanup`);
    return;
  }
  if (!CONSISTENCY[key]) bad(`journal.items[${name}]：(op,state,cleanup)=${key} 不是合法组合`);
}

// ── 整体校验 ─────────────────────────────────────────────────────────────────

export function validateJournal(J) {
  assertKeys(J,
    ['schema', 'generation', 'tx_dir', 'phase', 'items', 'ledger_image'],
    ['adopt_assertions', 'unadopt_assertions', 'manifest', 'direction', 'rollback', 'repair_id', 'crc32c'],
    'journal');
  if (J.schema !== JOURNAL_SCHEMA) bad(`journal.schema 必须是 ${JOURNAL_SCHEMA}，得到 ${J.schema}`);
  if (!isUint(J.generation)) bad('journal.generation 必须是非负整数');
  if (J.tx_dir !== `tx-${J.generation}`) bad(`journal.tx_dir 必须是 tx-${J.generation}，得到 ${J.tx_dir}`);
  if (!PHASES.includes(J.phase)) bad(`journal.phase 未知取值 ${J.phase}`);
  if (J.items === null || typeof J.items !== 'object' || Array.isArray(J.items)) {
    bad('journal.items 必须是对象');
  }
  for (const [name, it] of Object.entries(J.items)) {
    validateItem(name, it);
    assertStateCombo(name, it);
  }
  if ('adopt_assertions' in J) validateAssertionMap(J.adopt_assertions, 'adopt_assertions', J);
  if ('unadopt_assertions' in J) validateAssertionMap(J.unadopt_assertions, 'unadopt_assertions', J);
  allItemKeys(J);                                   // 三者互不相交
  if ('manifest' in J && J.manifest !== 'durable') bad(`journal.manifest 只允许 "durable"`);
  if ('repair_id' in J && (typeof J.repair_id !== 'string' || J.repair_id === '')) {
    bad('journal.repair_id 必须是非空字符串');
  }
  validateLedgerImage(J.ledger_image);
  validateRollback(J);
  return J;
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

/**
 * §11 §5：`crc32c` 覆盖范围 = **去掉 `crc32c` 这一个 key 之后**该对象的 canonical
 * 字节（含结尾换行）。
 */
export function journalCrc(obj) {
  const { crc32c: _drop, ...rest } = obj;
  return crc32cHex(Buffer.from(stringify(rest), 'utf8'));
}

export function writeJournal(path, obj) {
  validateJournal(obj);
  const { crc32c: _drop, ...rest } = obj;
  const withCrc = { ...rest, crc32c: journalCrc(rest) };
  writeAtomic(path, stringify(withCrc));
  return withCrc;
}

export function readJournal(path) {
  const obj = readJsonStrict(path, 'journal');
  const got = obj.crc32c;
  if (typeof got !== 'string') bad(`journal 缺 crc32c：${path}`);
  if (!/^[0-9a-f]{8}$/.test(got)) bad(`journal.crc32c 必须是 8 位定宽小写 hex：${got}`);
  const want = journalCrc(obj);
  if (got !== want) bad(`journal crc32c 不符：${path} 记 ${got}，实算 ${want}`);
  return validateJournal(obj);
}

// ── .tmp 残留（§5.4「I/O 失败的统一规则」）──────────────────────────────────

/**
 * 🔴 journal 原子写失败留下的 `.tmp`：恢复时一律**忽略并删除**。
 * 权威副本是那个已 rename 到位的文件；`.tmp` 按定义未提交。
 */
export function sweepTmp(dir) {
  if (!existsSync(dir)) return [];
  const gone = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) { rmtreeFsync(join(dir, name)); gone.push(name); }
  }
  return gone;
}

/**
 * 🔴 §5.10 守卫 0″ 的扫描口径：**只扫已提交的规范文件 `journal/<generation>.json`**。
 *
 * 🔴 **本函数是纯读的**（Codex 第三轮 #23）：`.tmp` 的清扫由 `recover()` 入口显式做。
 *    检查函数带副作用时，「不变式跑了一遍之后现场就变了」，I7 的结论也就不可信了。
 * @returns {number[]} 升序的 generation 列表
 */
export function listJournalGenerations(journalDir) {
  if (!existsSync(journalDir)) return [];
  const gens = [];
  for (const name of readdirSync(journalDir)) {
    const m = /^(\d+)\.json$/.exec(name);
    // 🔴 名字不是规范形状的一律忽略而不是猜 —— 但也不删（它可能是人留的证据）。
    if (!m) continue;
    if (m[1].length > 1 && m[1][0] === '0') bad(`journal 文件名有前导零：${name}`);
    gens.push(Number(m[1]));
  }
  return gens.sort((a, b) => a - b);
}
