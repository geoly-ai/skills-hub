// M4 的公共零件 —— `update` 与 `remove` 都要在**账本的 root ↔ entry 二部图**上算，
// 而不是在「本次命令行说了什么」上算。
//
// 规格：04-install.md §4（`roots` / `entries[*].requested_by` 的 refcount 语义）、
// §4.1、§5.1 的取锁表、§8.1（lockfile 是这张图的无损投影）。
//
// 🔴 **消费一张图之前先证明它是闭合的。** `readLedger()` 的 `validateLedger` 只查
//    单条记录的形状，**不查** `requested_by` 指向的 root 存不存在（R-11 第二条，
//    `pack.assertRefGraphClosed` 就是那道补上的门）。不先过这道门，后面所有
//    「减引用 / 换引用」的计算都是在一张不可信的图上「自洽地」改写 ——
//    看起来每一步都对，结果是把一条悬挂边变成一条更难发现的悬挂边。

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readLedger, layout } from '../ledger.mjs';
import { parseRootKey, parseArtifactId, assertRefGraphClosed, WireError } from '../pack.mjs';
import { strictlyMatches } from '../plan.mjs';
import { stringify } from '../canonical-json.mjs';
import { UsageError, EXIT } from '../exit-codes.mjs';

/** 本模块内的闭合门失败 —— 由 `assertLedgerGraphUsable` 统一改档成 2。 */
function bad(msg) { throw new WireError('E_LEDGER_LABEL', msg); }

/** 读一个 target 的账本；没有就返回 `null`（不是错 —— 那个 target 只是没被管过）。 */
export function readTargetLedger(target) {
  const P = layout(target);
  if (!existsSync(P.ledger)) return null;
  return readLedger(P.ledger);
}

/**
 * 🔴 消费前的闭合门：每个 root key 过 grammar，每条 `requested_by` 指向的 root 必须存在。
 *
 * 🔴 **在调用点显式改档**，不靠 `classify()` 认 name：`pack.mjs` 抛的是 `WireError`，
 *    而 `WireError` 在 `exit-codes.mjs` 里写死落 **1（解析失败）** —— 那是给
 *    「用户给的字符串不合 grammar」用的。这里的输入不是用户敲的，是**我们自己
 *    写出来的账本**：它不自洽属于「磁盘上的字节对不对」，该落 **2（完整性失败）**。
 *    exit-codes.mjs 顶上那条纪律（「凡是这里抛的错其实是另一档，都在调用点显式包装，
 *    绝不对错误文案做正则」）说的就是这一格。
 */
export function assertLedgerGraphUsable(L, where) {
  try {
    // ① 边闭合 + root key grammar
    for (const key of Object.keys(L.roots ?? {})) parseRootKey(key, `${where}.roots[${key}]`);
    assertRefGraphClosed(L, where);
    // ② 🔴 **顶点标签也要闭合**（Codex 2026-09-04 P2-1）。只查「边指得到人」不够：
    //    一张「边个个闭合、标签却全错」的账本照样能被消费。这与 04-install.md §8.1
    //    对 lockfile 的「双向图闭合（边 + 顶点标签）」是同一条纪律。
    for (const [key, r] of Object.entries(L.roots ?? {})) {
      const rk = parseRootKey(key);
      // 🔴 记录里的 `kind` 必须与 key 的 grammar 推出来的 kind 一致 ——
      //    否则 `remove` / `update` 里所有按 `kind` 分流的判定都会走错分支。
      if (r.kind !== rk.kind) {
        bad(`${where}.roots[${key}]：记录的 kind=${r.kind} 与 key 推出的 ${rk.kind} 不一致`);
      }
      // 🔴 `all@snapshot:<N>` 的 N 就写在 key 里，记录里的 snapshot 必须等于它。
      if (rk.kind === 'all' && r.snapshot !== rk.snapshot) {
        bad(`${where}.roots[${key}]：记录的 snapshot=${r.snapshot} 与 key 里的 ${rk.snapshot} 不一致`);
      }
      if (rk.kind === 'pack' && r.artifact !== key) {
        bad(`${where}.roots[${key}]：pack root 的 key 必须等于它的 artifact，得到 ${r.artifact}`);
      }
      if (rk.kind === 'direct') {
        if (`direct:${r.artifact}` !== key) {
          bad(`${where}.roots[${key}]：direct root 的 key 必须是 "direct:" + artifact，得到 ${r.artifact}`);
        }
        // 🔴 `install` 从不为 pack 建 direct root（pack root 的 key 就是 ArtifactId
        //    本身）。出现了就说明这张图不是我们写的 —— 这是**完整性**问题（2），
        //    不是「两样东西不能共存」（3）。
        if (rk.artifact.kind !== 'skill') {
          bad(`${where}.roots[${key}]：direct root 只能指向 skill，得到 ${rk.artifact.kind}`);
        }
      }
    }
    for (const [name, e] of Object.entries(L.entries ?? {})) {
      const a = parseArtifactId(e.artifact, `${where}.entries[${name}].artifact`);
      if (a.name !== name) {
        bad(`${where}.entries[${name}]：目录名必须等于它 artifact 的 name（${a.name}）`);
      }
    }
  } catch (cause) {
    const e = new UsageError(
      `${where} 的引用图不自洽：${cause.message}\n`
      + '  账本是我们自己写出来的 —— 它不闭合说明这份状态已经被改坏或与本 CLI 的版本不符。\n'
      + '  🔴 拒绝在一张不可信的图上算「减引用 / 换引用」：那样每一步看起来都对，\n'
      + '     结果只是把一条悬挂边变成一条更难发现的悬挂边。',
      { telemetryReason: 'ledger-corrupt' },
    );
    e.exitCode = EXIT.INTEGRITY;
    e.cause = cause;
    throw e;
  }
  return L;
}

/**
 * `direct:` root 与 entry 的**精确**对应关系。
 *
 * 🔴 判据是「root key == `direct:` + entry 的 artifact」，**不是**「root 的 name
 *    等于目录名」。后者会把一张已经错了的账本（entry 记着 `x@1`，却挂着请求 `x@2`
 *    的 direct root）在 `remove` 时静默「修正」掉 —— 那是替坏账本圆谎，
 *    而不是如实拒绝。
 */
export function directRootKeyFor(entry) {
  return `direct:${entry.artifact}`;
}

/**
 * 事务后**没有任何 entry 指向**的 root。
 *
 * 与 `commands/install.mjs` 的 `orphanRootsAfter` 同一条判据（事务后的全景），
 * 但入参是「完整的 post 图」而不是「install 请求 + retire 名单」——
 * `update` 会同时改很多条边，用增量形状描述不了。
 *
 * @param {object} ledger        当前账本（提供 roots 的键集）
 * @param {Map<string,string[]>} postEdges  事务后 name → requested_by
 * @param {string[]} extraRootKeys          本次会**新写入**的 root（它们还不在账本里）
 */
export function orphanRootsOf(ledger, postEdges, extraRootKeys = []) {
  const live = new Set();
  for (const list of postEdges.values()) for (const k of list) live.add(k);
  const known = new Set([...Object.keys(ledger.roots ?? {}), ...extraRootKeys]);
  return [...known].filter((k) => !live.has(k)).sort();
}

/**
 * 一个 entry 在磁盘上是不是**仍然**是账本声称的那棵树。
 *
 * 🔴 用的是 `strictlyMatches`（摘要 + 结构与元数据），不是只比摘要 ——
 *    `geoly-tree-v1` 不覆盖空目录与部分元数据（01-artifacts.md §6.2.1），
 *    只比摘要的话「看起来验过了」而实际没有。这与 `derivePlan` 走 adopt 分支时
 *    以及 `reverifyAssertions` 用的是**同一个函数**，所以两处不会分叉。
 */
export function entryStillMatches(target, name, digest) {
  const notDir = rootIsNotAPlainDir(target, name);
  if (notDir) return { ok: false, why: notDir };
  return strictlyMatches(join(target, name), digest);
}

/**
 * 🔴 `strictPayloadCheck()` 是从 `readdirSync(dir)` **开始**递归的 —— 它查的是
 *    每一个**子项**是不是 symlink，**没有查那个根自己**（Codex 2026-09-04 复评）。
 *    于是 `target/<name>` 被换成一条指向外部、内容恰好相同的软链时，
 *    「严格验明」仍然会返回成功 —— 而我们接下来要么按它改账本、要么把它退役删掉。
 *
 * ⚠️ **诚实边界**：这是补在 M4 这一侧的门。`plan.strictlyMatches()` 本身仍有这个
 *    缺口，`install` 的 §4.2 adopt 分支照样会走进去 —— 那是既有实现的问题，
 *    不在本轮范围内，如实记进交付汇报，**不假装它被闭合了**。
 */
function rootIsNotAPlainDir(target, name) {
  const dir = join(target, name);
  let st;
  try { st = lstatSync(dir); } catch (e) {
    if (e?.code === 'ENOENT') return null;      // 「不存在」由调用方各自处置
    return `无法 lstat（${e.code}）—— 看不见就不能声称它是安全的`;
  }
  if (st.isSymbolicLink()) return ' 它是一条 symlink（不是我们放进去的目录）';
  if (!st.isDirectory()) return '它不是普通目录';
  return null;
}

/**
 * 一个**要被退役（删掉）**的 entry，必须**逐字节**还是账本声称的那棵树。
 *
 * 🔴 **只查「目录在不在」是不够的**（Codex 2026-09-04 P0）。`derivePlan` 的
 *    `retire-only` 分支会对**当前磁盘内容**重算 `old_digest` —— 于是一棵被外部
 *    改过的目录照样会被归档然后删除，而命令**返回 0**。
 *    ⚠️ 它确实进了 attic（数据不是永久丢失），但：
 *      ① 用户的改动在一次「成功」的命令里被无声移走；
 *      ② 与 keep 分支的判据自相矛盾 —— 那一边（adopt）是严格复验、不符就退 2。
 *    **同一个命令里两条分支用两套判据**，正是「看起来守住了、其实只守住一半」。
 *
 * 判据用 `strictlyMatches`（摘要 + 结构与元数据），与 adopt 分支、
 * `reverifyAssertions` 是**同一个函数** —— 三处不会分叉。
 */
export function assertEntryTreeIntact(target, name, digest, where) {
  const dir = join(target, name);
  const notDir = rootIsNotAPlainDir(target, name);
  if (notDir) throw integrityError(`${where}：${dir} ${notDir}。🔴 拒绝把它当成我们的制品处置。`);
  if (!existsSync(dir)) {
    throw integrityError(
      `${where}：账本里记着 ${name}，但 ${dir} 不存在。\n`
      + '  账本与磁盘不符 —— 这不是残留事务（没有 journal 可续做），`recover` 对它无事可做。\n'
      + '  `check` 能把不符之处报全（它只诊断、不修复）；要恢复那棵树请用\n'
      + '  `recover --from-generation <N>`，或重新 `install` 它。',
    );
  }
  const m = strictlyMatches(dir, digest);
  if (m.ok) return;
  throw integrityError(
    `${where}：${dir} 已经不是账本记录的那棵树（${m.why}）。\n`
    + '  本次操作会**删掉这个目录**，而它现在装着的不是我们放进去的东西 ——\n'
    + '  🔴 拒绝，不在一次「成功」的命令里无声移走你自己的改动。\n'
    + '  出路：把改动挪走（或提交到别处）后重跑；`check` 能把不符之处报全。',
  );
}

function integrityError(message) {
  const e = new UsageError(message, { telemetryReason: 'digest-mismatch' });
  e.exitCode = EXIT.INTEGRITY;
  return e;
}

/**
 * 「确认之后、取锁之前」这段窗口的**语义指纹**。
 *
 * 🔴 不能拿整份 plan 去比：`generation` / `installed_at` / stage 路径本来就会变
 *    （Codex 2026-09-04）。要比的是**语义**：事务后的图长什么样、哪些要退役、
 *    哪些 root 要写、哪些要删。指纹一致就说明「用户看到并同意的那件事」没有变。
 */
export function graphFingerprint({ postEdges, artifacts, retire, writeRoots, removeRoots }) {
  return stringify({
    artifacts: Object.fromEntries([...artifacts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    edges: Object.fromEntries([...postEdges.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, [...v].sort()])),
    remove_roots: [...removeRoots].sort(),
    retire: [...retire].sort(),
    write_roots: Object.fromEntries([...Object.entries(writeRoots)]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      // 🔴 `intent` **必须进指纹**（Codex 2026-09-04 P1-1）。少了它，
      //    「同一条 root、同一个制品、同一份成员图，只有 no_bundled / pre /
      //    allow_yanked 变了」这一格会指纹相等 —— 于是并发改掉的 intent
      //    会被旧计划覆盖，而账本记的是本机历史、历史必须是真的。
      .map(([k, r]) => [k, {
        artifact: r.artifact ?? null,
        intent: r.intent ?? null,
        kind: r.kind,
        snapshot: r.snapshot,
      }])),
  });
}

/**
 * 交互确认（**可跳过的**那一类，`--yes` 足够）。
 *
 * 🔴 与 09-cli.md §3 的全量确认**不是同一件事**：那一条要求输入数量数字、
 *    且非交互下只认 `--yes-i-really-want-everything`。这里是普通的破坏性确认。
 */
export async function confirmYes(ctx, out, { lines, question }) {
  for (const l of lines) out.line(l);
  if (ctx.yes) { out.note('--yes：跳过确认'); return; }
  const tty = ctx.stdin?.isTTY === true;
  if (!tty) {
    throw new UsageError(
      `${question}\n  非交互下必须显式给 --yes（09-cli.md §2：跳过可跳过的确认）。什么都没做。`,
      { telemetryReason: 'user-abort' },
    );
  }
  out.line(`${question} 输入 y 确认（回车不算确认）：`);
  const answer = (await readLine(ctx.stdin)).trim();
  if (answer !== 'y' && answer !== 'Y') {
    throw new UsageError(`未确认（得到 ${JSON.stringify(answer)}）。什么都没做。`,
      { telemetryReason: 'user-abort' });
  }
}

/**
 * 读一行。🔴 **先看它还能不能读** —— 已 end / 已 destroy 的 stdin 会让 Promise
 * 永远 pending，命令挂死且没有任何输出（与 `commands/install.mjs` 的 `readLine`
 * 是同一条教训、同一份判据）。
 */
function readLine(stdin) {
  return new Promise((resolve, reject) => {
    if (stdin === null || stdin === undefined) { resolve(''); return; }
    if (stdin.readableEnded === true || stdin.destroyed === true) { resolve(''); return; }
    let buf = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      stdin.removeListener('error', onErr);
      stdin.pause?.();
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      cleanup();
      resolve(buf.slice(0, nl));
    };
    const onEnd = () => { cleanup(); resolve(buf); };
    const onErr = (e) => { cleanup(); reject(e); };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    stdin.on('error', onErr);
    stdin.resume?.();
  });
}
