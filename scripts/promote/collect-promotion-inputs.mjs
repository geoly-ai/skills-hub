#!/usr/bin/env node
// 把每个投稿的 `PROMOTION.json` 收成 `build-inputs.mjs` 要的两个入参 ——
// 决策 ②（2026-08-31）。
//
// 🔴 **必须在 stage-submissions 之前跑**：那一步会把 `submissions/` 搬空。
//
// 输出三个文件：
//   · `--claim-owner-out`   → `{namespace: {kind, login, id}}`
//   · `--provenance-out`    → `{ArtifactId: provenance}`
//   · `--owners-out`        → 合并后的 `owners.json`（首次注册要**落表**）
//
// 🔴🔴 **claim 必须按 namespace 索引。** 第一版输出的是**单个** owner 对象，
//    而 `build-inputs` 会把它套到**每一个**未注册 namespace 上 —— 于是
//    「`a/foo` 没声明 + `b/bar` 声明了 b 的 owner」会把两个 namespace 都
//    注册到 b 名下，一次静默的所有权错配（Codex 2026-08-31）。
//
// 🔴 **每一个未注册的 namespace 都必须有 claim**，缺一个就拒 ——
//    「记一条 note 然后放过」等于把问题推到 build-inputs，而那时报的是
//    另一个错，人要绕一圈才找得到真因。
//
// 🔴 **首次注册要写进 `registry/owners.json`。** 不落表的话，下一次同 namespace
//    的投稿会走「尚未注册」那条路，可以被**另一个人**认领 —— 05-lifecycle §1
//    的绑定形同虚设。

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { stringify } from '../../src/canonical-json.mjs';
import { scanSubmissions } from '../submission/run-gates.mjs';
import { readPromotionFile, fillFromPr } from '../submission/promotion-file.mjs';

class CollectError extends Error {
  constructor(code, msg) { super(msg); this.name = 'CollectError'; this.code = code; }
}
const bad = (code, msg) => { throw new CollectError(code, msg); };

/**
 * @param {object} a
 * @param {string} a.submissionsRoot
 * @param {object} a.pr  `{number, authorId, authorLogin, createdAt}`
 * @param {Set<string>} a.registeredNamespaces  `owners.json` 里已有的
 * @returns {{claimOwner:object|null, provenanceOf:object, notes:string[]}}
 */
export function collectPromotionInputs({
  submissionsRoot, pr, registeredNamespaces, orgIds = {},
}) {
  const notes = [];
  const problems = [];
  const provenanceOf = {};
  const claims = new Map();                    // namespace → owner
  const seenNamespaces = new Set();

  for (const s of scanSubmissions(submissionsRoot)) {
    const where = `${s.namespace}/${s.name}@${s.version}`;
    // kind 与 stage-submissions / run-gates 同一条判据：载荷根有哪个 manifest
    const kind = existsSync(join(s.dir, 'pack.json')) ? 'pack' : 'skill';
    const declared = readPromotionFile(s.dir);
    seenNamespaces.add(s.namespace);

    if (declared === null) {
      // 没有这个文件是**正常**的：已注册 namespace 下的 skill 续版本不需要它。
      if (kind === 'pack') {
        problems.push(`${where}：pack 必须有 ${'PROMOTION.json'}（pack.json 的键集里没有 provenance）`);
      }
      continue;
    }

    const filled = fillFromPr({ declared, kind, pr, orgIds });
    if (filled.owner) {
      const prev = claims.get(s.namespace);
      if (prev !== undefined && stringify(prev) !== stringify(filled.owner)) {
        bad('E_CLAIM_CONFLICT',
          `namespace ${s.namespace} 在同一次 promote 里被声明了两个不同的 owner。`);
      }
      claims.set(s.namespace, filled.owner);
    }
    if (filled.provenance) provenanceOf[`${kind}:${where}`] = filled.provenance;
  }

  // 🔴 **每一个未注册的 namespace 都要有 claim** —— 判据取自「本批出现过的
  //    全部 namespace」，不是「声明过 claim 的那些」。后者会让一个没声明的
  //    namespace 悄悄溜过去，然后在 build-inputs 那里套上别人的 owner。
  const missing = [...seenNamespaces]
    .filter((ns) => !registeredNamespaces.has(ns) && !claims.has(ns))
    .sort();
  for (const ns of missing) {
    problems.push(`namespace ${ns} 尚未注册，本批里却没有任何投稿声明它的 claim_owner`);
  }
  if (problems.length) {
    bad('E_PROMO_MISSING',
      `${problems.length} 处缺少 promotion 必需材料：\n`
      + problems.map((x) => `  · ${x}`).join('\n')
      + '\n  🔴 这些该在**投稿 PR** 上就拦下 —— 走到 promote 才报，'
      + '说明结构门漏了一条。');
  }

  const claimOwner = Object.fromEntries([...claims].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { claimOwner, provenanceOf, notes };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const KNOWN = ['submissions', 'owners', 'pr', 'author-id', 'author-login', 'created-at',
  'org-ids', 'claim-owner-out', 'provenance-out', 'owners-out'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_COLLECT_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.slice(2);
    if (!KNOWN.includes(key)) bad('E_COLLECT_INPUT', `不认识的选项 ${name}`);
    if (key in o) bad('E_COLLECT_INPUT', `${name} 给了不止一次`);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_COLLECT_INPUT', `${name} 需要一个值`);
    o[key] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['submissions', 'pr', 'author-id', 'author-login', 'created-at']) {
    if (o[k] === undefined) bad('E_COLLECT_INPUT', `缺少 --${k}`);
  }
  const ownersPath = o.owners ?? 'registry/owners.json';
  const ownersDoc = existsSync(ownersPath)
    ? JSON.parse(readFileSync(ownersPath, 'utf8'))
    : { schema: 'geoly.skills.owners/1', namespaces: {} };
  const registered = new Set(Object.keys(ownersDoc.namespaces ?? {}));

  const r = collectPromotionInputs({
    submissionsRoot: o.submissions,
    registeredNamespaces: registered,
    orgIds: o['org-ids'] === undefined ? {} : JSON.parse(readFileSync(o['org-ids'], 'utf8')),
    pr: {
      number: Number(o.pr),
      authorId: o['author-id'],
      authorLogin: o['author-login'],
      createdAt: o['created-at'],
    },
  });
  for (const n of r.notes) process.stderr.write(`⚠️ ${n}\n`);
  const claimCount = Object.keys(r.claimOwner).length;
  if (o['claim-owner-out'] !== undefined) {
    writeFileSync(o['claim-owner-out'], stringify(r.claimOwner));
  }
  if (o['provenance-out'] !== undefined) {
    writeFileSync(o['provenance-out'], stringify(r.provenanceOf));
  }
  // 🔴 首次注册要**落表**：不写进 owners.json 的话，下一次同 namespace 的投稿
  //    会走「尚未注册」那条路、可以被另一个人认领。
  if (o['owners-out'] !== undefined) {
    const merged = {
      ...ownersDoc,
      namespaces: Object.fromEntries(
        [...Object.entries(ownersDoc.namespaces ?? {}), ...Object.entries(r.claimOwner)]
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    };
    writeFileSync(o['owners-out'], `${JSON.stringify(merged, null, 2)}\n`);
  }
  process.stdout.write(`claim_count=${claimCount}\n`);
  process.stdout.write(`provenance_count=${Object.keys(r.provenanceOf).length}\n`);
  process.stderr.write(`✔ ${claimCount} 个首次注册，${Object.keys(r.provenanceOf).length} 条 provenance。\n`);
  return 0;
}

export { CollectError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.code ? `[${e.code}] ` : ''}${e.message}\n`);
    process.exit(1);
  }
}
