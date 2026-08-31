#!/usr/bin/env node
// 生成 timestamp.json —— 02-registry.md §3 / §3.2。
//
// 用法：
//   node scripts/release/build-timestamp.mjs \
//     --snapshots registry/snapshots \
//     [--previous <上一份 timestamp.json>] \
//     [--min-cli-version 1.2.0] \
//     [--now 2026-08-25T12:00:00Z] [--valid-days 7] \
//     --out timestamp.json
//
// 🔴 **为什么这份文件不从仓库里读。**
//    §3.2 定死了 timestamp **只作为 Release 资产分发**，仓库里**不存当前值**。
//    理由不只是「分支保护禁止直推」—— 更根本的是 cron 每 3 天要刷新一次
//    `created_at` / `valid_until`，而滚动刷新读不了一份静态的仓库文件。
//    留着仓库那份就会出现「仓库里的过期、Release 上的新鲜」两个真值。
//
// 🔴 **`version` 与 `min_cli_version` 从上一份 timestamp 接力，不从新的配置文件来。**
//    多一个磁盘契约就多一处会漂的东西。上一份是**已签名对象**，它说的话有担保；
//    而一个新加的 `registry/min-cli-version.txt` 没有任何东西覆盖它。
//    · `version` 必须单调递增（§3）→ 取 `previous.version + 1`，没有上一份则从 1 起；
//    · `min_cli_version` 是**人定的策略值** → 沿用上一份；首次必须显式给
//      （不给就拒绝，而不是替它挑一个）。

import { readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { stringify } from '../../src/canonical-json.mjs';
import { parseTimestamp, parseSnapshot, parseSemver, TIMESTAMP_SCHEMA as READER_TS_SCHEMA } from '../../src/snapshot.mjs';

export const TIMESTAMP_SCHEMA = 'geoly.skills.timestamp/1';

/** §3：`YYYY-MM-DDTHH:MM:SSZ`，UTC、无偏移、无小数秒。 */
const RE_WIRE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RE_SEMVERISH = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

class TimestampError extends Error {
  constructor(msg) { super(msg); this.name = 'TimestampError'; }
}
const bad = (msg) => { throw new TimestampError(msg); };

const wireTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 选出**最新**的快照。
 *
 * 🔴 两处都不能靠 glob 的顺序：
 *   ① 目录序是**字典序**，`hub-10` 会排在 `hub-2` 前面 → 按**数字**取最大；
 *   ② `hub-<N>.json.sigstore.json` 自己也以 `.json` 结尾 → 必须剔掉，
 *      否则会把一份**签名**当成快照（release.yml 的 attestation 就踩过这个）。
 */
// 🔴 **文件名要严格匹配，不能用 `Number()` 兜底。**
//    `Number('1e3')` = 1000、`Number('0x10')` = 16、`Number('')` = 0 ——
//    `hub-1e3.json` 会被读成快照 1000，而磁盘上并没有 `hub-1000.json`；
//    于是 timestamp 指向一个不存在的快照号，**而它是签名对象**。
//    前导零同理：`hub-01.json` 与 `hub-1.json` 会算出同一个 N，谁赢取决于目录顺序。
const RE_SNAPSHOT_FILE = /^hub-(0|[1-9]\d*)\.json$/;

export function newestSnapshot(dir) {
  let best = null;
  const seen = new Map();
  for (const f of readdirSync(dir)) {
    const m = RE_SNAPSHOT_FILE.exec(f);
    if (m === null) continue;                 // 含 `hub-<N>.json.sigstore.json`
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n)) bad(`${f} 的快照号超出安全整数范围`);
    // 🔴 严格文件名之后本不该有重复，但 macOS 的大小写折叠等仍可能撞上 ——
    //    撞了就拒绝，不按目录顺序挑一个。
    if (seen.has(n)) bad(`快照号 ${n} 出现在两个文件里：${seen.get(n)} 与 ${f}`);
    seen.set(n, f);
    if (best === null || n > best.n) best = { n, file: join(dir, f) };
  }
  if (best === null) bad(`${dir} 下没有快照 —— timestamp 的语义是「当前最新快照是哪一个」，没有可指向的东西`);
  return best;
}

/**
 * @param {object} a
 * @param {string} a.snapshotsDir
 * @param {object|null} a.previous       上一份 timestamp（没有就 null）
 * @param {string|null} a.minCliVersion  显式覆盖；null 表示沿用上一份
 * @param {number} a.nowMs
 * @param {number} a.validDays
 * @param {string} a.repo
 */
function assertPreviousShape(prev) {
  if (prev === null || typeof prev !== 'object' || Array.isArray(prev)) bad('上一份 timestamp 必须是对象');
  if (prev.schema !== READER_TS_SCHEMA) {
    bad(`上一份 timestamp 的 schema 不认识：${JSON.stringify(prev.schema)}（应为 ${READER_TS_SCHEMA}）`);
  }
  for (const k of ['version', 'latest_snapshot']) {
    if (!Number.isSafeInteger(prev[k]) || prev[k] < 0) {
      bad(`上一份 timestamp 的 ${k} 必须是非负安全整数，得到 ${JSON.stringify(prev[k])}`);
    }
  }
  parseSemver(prev.min_cli_version, '上一份 timestamp 的 min_cli_version');
  return prev;
}

export function buildTimestamp({ snapshotsDir, previous = null, minCliVersion = null, nowMs, validDays = 7, repo }) {
  // §3 的完整时间规则：0 < (valid_until - created_at) ≤ 7 天
  if (!Number.isFinite(validDays) || validDays <= 0 || validDays > 7) {
    bad(`--valid-days 必须在 (0, 7] 之内，得到 ${validDays}（§3 的有效期上界是 7 天）`);
  }

  const snap = newestSnapshot(snapshotsDir);
  const bytes = readFileSync(snap.file);
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  // 🔴 交叉核对：文件名里的 N 必须等于快照内部声明的 `snapshot`。
  //    不核对的话，一个被改过名字的文件会让 timestamp 指向一个不存在的快照号 ——
  //    而 timestamp 是**签名对象**，签下去就成了有担保的谎话。
  // 🔴 先给出**精确**的诊断（文件名 vs 内部字段），再交给读取端做全量校验。
  //    顺序反过来的话，用户看到的是一句泛泛的 E_SNAPSHOT_N。
  let peek;
  try { peek = JSON.parse(bytes.toString('utf8')); } catch { peek = null; }
  if (peek !== null && peek.snapshot !== snap.n) {
    bad(`${snap.file} 的文件名说它是 ${snap.n}，内部却写着 snapshot=${peek.snapshot}`);
  }
  // 🔴 **快照本身也要过读取端的 `parseSnapshot()`。** 只查一个 `snapshot` 字段的话，
  //    `{"snapshot":42}` 就能让我们签出一份指向它的 timestamp —— 而客户端随后
  //    会拒绝那张快照。timestamp 是签名对象，它指向的东西必须真的可用。
  parseSnapshot(bytes, { expectSnapshot: snap.n });

  let version = 1;
  let minCli = minCliVersion;
  if (previous !== null) {
    // 🔴 **库层入口也要自己判。** `main()` 读文件时走的是 parseTimestamp，
    //    但 `buildTimestamp()` 是导出的 API，调用方给的是一个**已解析对象** ——
    //    「有个 version 字段的 JSON」不等于一份合法 timestamp。
    //    这里逐项判它接力时真正用到的那几个字段，判据用**读取端同一个** parseSemver。
    assertPreviousShape(previous);
    // 🔴 上一份是**已签名对象**，我们要在它上面接力 version 与策略值 ——
    //    那就必须先确认它真的是一份合法 timestamp，而不是「有个 version 字段的 JSON」。
    //    判据用**读取端自己的** parseTimestamp（键集、repo 常量、semver、时间规则、
    //    canonical 往返全在里面），不另写一个更松的校验器。
    if (!Number.isSafeInteger(previous.version + 1)) {
      bad(`上一份 timestamp 的 version 已到安全整数上限（${previous.version}），无法再递增`);
    }
    version = previous.version + 1;
    // 🔴 **不许倒退**：新快照号必须 ≥ 上一份指向的那个。倒退意味着有人把
    //    timestamp 指回一张更旧的快照 —— 那正是回滚攻击的形状（§9.2 的抗回滚）。
    if (snap.n < previous.latest_snapshot) {
      bad(`拒绝倒退：上一份 timestamp 指向快照 ${previous.latest_snapshot}，现在最新的却是 ${snap.n}`);
    }
    if (minCli === null) minCli = previous.min_cli_version;
  }
  if (minCli === null) {
    bad('第一次生成 timestamp 必须显式给 --min-cli-version —— 它是人定的策略值，不替你挑一个');
  }
  if (!RE_SEMVERISH.test(minCli)) bad(`--min-cli-version 不合 semver：${JSON.stringify(minCli)}`);

  const createdAt = wireTime(nowMs);
  const validUntil = wireTime(nowMs + validDays * 86400_000);
  for (const [k, v] of [['created_at', createdAt], ['valid_until', validUntil]]) {
    if (!RE_WIRE_TIME.test(v)) bad(`${k} 不合 §3 的时间形状：${v}`);
  }

  const doc = {
    schema: TIMESTAMP_SCHEMA,
    version,
    repo,
    latest_snapshot: snap.n,
    snapshot_sha256: sha256,
    min_cli_version: minCli,
    created_at: createdAt,
    valid_until: validUntil,
  };
  // 🔴 **产出物必须能被读取端接受。** 写入端接受的每一个输入，读取端都必须接受
  //    （R-11 的判据）。`parseTimestamp()` 在这里一次性兜住：键集、`repo` 等于内置
  //    常量、`min_cli_version` 走**客户端同一个** parseSemver（前导零、非法预发布
  //    都拒）、时间形状、`0 < span ≤ 7 天`（含「有效期被截断成 0 秒」那一格）、
  //    以及 canonical 字节往返。
  //    ⚠️ 它是**时间无关**的：`assertFresh` 是另一个函数，不在这里跑 ——
  //    生成器管不了「客户端消费它的那一刻还新不新鲜」。
  parseTimestamp(Buffer.from(stringify(doc), 'utf8'));
  return doc;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad(`不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad(`${name} 需要一个值`);
    o[name.slice(2)] = val;
  }
  return o;
}

function parseNowArg(v) {
  if (!RE_WIRE_TIME.test(v)) bad(`--now 必须是严格的 YYYY-MM-DDTHH:MM:SSZ（UTC、无偏移、无小数秒），得到 ${JSON.stringify(v)}`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) bad(`--now 解析不出时间：${JSON.stringify(v)}`);
  return ms;
}

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['snapshots', 'out', 'repo']) if (o[k] === undefined) bad(`缺少 --${k}`);

  let previous = null;
  if (o.previous !== undefined && o.previous !== '') {
    // 🔴 用读取端的 parseTimestamp，不用宽松的 parseStrict
    previous = parseTimestamp(readFileSync(o.previous));
  }
  const doc = buildTimestamp({
    snapshotsDir: o.snapshots,
    previous,
    minCliVersion: o['min-cli-version'] ?? null,
    // 🔴 `--now` 只接受严格的 `YYYY-MM-DDTHH:MM:SSZ`。放行带偏移或无时区的字符串，
    //    结果就会依赖跑它的那台机器的时区 —— 而这是个要逐字节复现的对象。
    nowMs: o.now === undefined ? Date.now() : parseNowArg(o.now),
    validDays: o['valid-days'] === undefined ? 7 : Number(o['valid-days']),
    repo: o.repo,
  });
  writeFileSync(o.out, stringify(doc));
  process.stderr.write(
    `已写出 ${o.out}：version=${doc.version} → 快照 ${doc.latest_snapshot}`
    + `（${doc.created_at} … ${doc.valid_until}）\n`,
  );
  return 0;
}

export { TimestampError };

// 🔴 **入口守卫必须比 realpath**。早先写的是
//    `import.meta.url === `file://${process.argv[1]}``，它在两种很常见的现场下
//    悄悄判假：① 路径上有符号链接（`import.meta.url` 用 realpath，`argv[1]` 不用）；
//    ② 路径里有需要 URL 转义的字符（空格、中文…）。
//    判假的后果不是报错，是 **`main()` 根本不跑、进程退出 0** ——
//    一个「跑完了、什么都没产出、还说自己成功」的发布脚本。本机实测踩过。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // 🔴 realpath 失败（文件被删、权限）时**按「是入口」处理**：
    //    宁可多跑一次也不要静默不跑。被 import 的场景 argv[1] 一定存在且解析得开。
    return true;
  }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
