#!/usr/bin/env node
// `submissions/<ns>/<name>@<ver>/PROMOTION.json` —— 06-submission.md §6，
// 以及 2026-08-31 的决策 ②（R-19 的闭合方式）。
//
// ── 🔴 这个文件解决什么 ────────────────────────────────────────────────────
// `build-inputs.mjs` 要两份**只有 PR 侧才有**的事实：
//   · `--claim-owner` —— 首次注册 namespace 时的 owner（不在 manifest 的键集里）；
//   · `--provenance-of` —— pack 的 provenance（`pack.json` 的键集里没有这个字段）。
// 在它们有来处之前，registry 只收得了「已注册 namespace 下的 skill 续版本」。
//
// ── 🔴🔴 分工：投稿者声明什么，promote 填什么 ─────────────────────────────
// **投稿者只能声明「只有他知道」的事**，凡是「只有 promote 能证明」的字段
// 一律由 promote 自己填 —— 让投稿者写它们，等于让他自称是谁。
//
// | 字段 | 谁给 | 为什么 |
// |---|---|---|
// | `owner.kind`（user/org） | 投稿者 | 意图，只有他知道 |
// | `owner.login` | 投稿者 | `user` 时必须等于 PR 作者，promote 会核 |
// | `owner.id` | **promote** | 不可变 node id 是身份本身；投稿者写它 = 冒名 |
// | `provenance.kind` | 投稿者 | 原创还是搬运，只有他知道 |
// | `author_github_id` | **promote** | 同上 |
// | `submitted_by_pr` / `imported_by_pr` | **promote** | 开 PR 之前根本不存在 |
// | `imported_at` | **promote** | 用**投稿 PR 的 created_at** —— 见下面的说明 |
// | `origin_*` / `license_evidence` | 投稿者 | 关于上游的事实，promote 无从得知 |
//
// 🔴 **投稿者写了 promote 该填的字段 → 直接拒**，不是「忽略它」。
//    忽略的话，一个想冒名的投稿看起来会像被接受了；而拒掉是一次沟通。
//
// ⚠️ 这份文件**不是**信任来源，是**待审材料**：`origin_*` 与 `license_evidence`
//    没有任何自动门能证实，它们归 §8 人工门第 8 条（license 与 provenance 是否可信）。

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseStrict } from '../../src/canonical-json.mjs';

export const PROMOTION_SCHEMA = 'geoly.skills.promotion-file/1';
export const PROMOTION_FILE = 'PROMOTION.json';

class PromotionFileError extends Error {
  constructor(code, msg) { super(msg); this.name = 'PromotionFileError'; this.code = code; }
}
const bad = (code, msg) => { throw new PromotionFileError(code, msg); };

/** promote 自己填的字段 —— 投稿者写了任何一个都拒。 */
const FILLED_BY_PROMOTE = [
  'id', 'author_github_id', 'submitted_by_pr', 'imported_by_pr', 'imported_at',
];

const OWNER_KEYS = ['kind', 'login'];
const PROV_ORIGINAL_KEYS = ['kind'];
const PROV_VENDORED_KEYS = [
  'kind', 'origin_repo', 'origin_ref', 'origin_commit', 'origin_subpath',
  'origin_tree_digest', 'license_evidence', 'added_files',
];

const RE_COMMIT = /^[0-9a-f]{40}$/;
const RE_TREE = /^geoly-tree-v1:sha256:[0-9a-f]{64}$/;

function assertExact(obj, keys, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    bad('E_PROMO_SHAPE', `${where} 必须是对象`);
  }
  const got = Object.keys(obj).sort();
  for (const k of got) {
    if (FILLED_BY_PROMOTE.includes(k)) {
      bad('E_PROMO_FORBIDDEN',
        `${where}.${k} 由 promote 自己填，投稿里不能写它。\n`
        + '  🔴 这一类字段是**身份与时间**（node id、PR 号、导入时刻）——\n'
        + '     让投稿声明它们，等于让投稿者自称是谁、自称什么时候来的。');
    }
  }
  const want = [...keys].sort();
  if (got.join(',') !== want.join(',')) {
    bad('E_PROMO_SHAPE', `${where} 的键集必须正好是 {${want.join(', ')}}，得到 {${got.join(', ')}}`);
  }
}

const str = (v, where) => {
  if (typeof v !== 'string' || v === '') bad('E_PROMO_SHAPE', `${where} 必须是非空字符串`);
  return v;
};

/**
 * 读并校验一个投稿目录里的 `PROMOTION.json`。
 * @returns {{owner:object|null, provenance:object|null}|null} 没有这个文件时返回 null
 */
export function readPromotionFile(submissionDir) {
  const p = join(submissionDir, PROMOTION_FILE);
  if (!existsSync(p)) return null;

  let doc;
  try {
    doc = parseStrict(readFileSync(p, 'utf8'));
  } catch (e) {
    bad('E_PROMO_PARSE', `${PROMOTION_FILE} 读不出来：${e.message.split('\n')[0]}`);
  }
  if (doc.schema !== PROMOTION_SCHEMA) {
    bad('E_PROMO_SHAPE', `${PROMOTION_FILE}.schema 应为 ${PROMOTION_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  const keys = Object.keys(doc).sort().filter((k) => k !== 'schema');
  for (const k of keys) {
    if (!['claim_owner', 'provenance'].includes(k)) {
      bad('E_PROMO_SHAPE', `${PROMOTION_FILE} 里不认识的键：${k}（只能有 schema / claim_owner / provenance）`);
    }
  }

  let owner = null;
  if (doc.claim_owner !== undefined) {
    assertExact(doc.claim_owner, OWNER_KEYS, 'claim_owner');
    const kind = str(doc.claim_owner.kind, 'claim_owner.kind');
    if (kind !== 'user' && kind !== 'org') {
      bad('E_PROMO_SHAPE', `claim_owner.kind 只能是 user / org，得到 ${JSON.stringify(kind)}`);
    }
    str(doc.claim_owner.login, 'claim_owner.login');
    owner = { kind, login: doc.claim_owner.login };
  }

  let provenance = null;
  if (doc.provenance !== undefined) {
    const kind = doc.provenance?.kind;
    if (kind === 'original') {
      assertExact(doc.provenance, PROV_ORIGINAL_KEYS, 'provenance');
      provenance = { kind: 'original' };
    } else if (kind === 'vendored') {
      assertExact(doc.provenance, PROV_VENDORED_KEYS, 'provenance');
      const v = doc.provenance;
      for (const k of ['origin_repo', 'origin_ref', 'origin_subpath', 'license_evidence']) {
        str(v[k], `provenance.${k}`);
      }
      // 🔴 只记 tag 不行 —— tag 可以被移动，那正是「审核后换内容」的路径
      //    （05-lifecycle.md §6）。与 snapshot.mjs 的 E_PROV_COMMIT 同一条判据。
      if (!RE_COMMIT.test(v.origin_commit ?? '')) {
        bad('E_PROMO_SHAPE', `provenance.origin_commit 必须是 40 位小写 hex，得到 ${JSON.stringify(v.origin_commit)}`);
      }
      // 🔴 是**树**摘要，要带 geoly-tree-v1: 前缀（ERRATA E-8）——
      //    系统里有两种树算法，裸 sha256 分不出是哪一种。
      if (!RE_TREE.test(v.origin_tree_digest ?? '')) {
        bad('E_PROMO_SHAPE',
          `provenance.origin_tree_digest 必须形如 geoly-tree-v1:sha256:<64hex>，`
          + `得到 ${JSON.stringify(v.origin_tree_digest)}`);
      }
      if (!Array.isArray(v.added_files) || v.added_files.some((x) => typeof x !== 'string' || x === '')) {
        bad('E_PROMO_SHAPE', 'provenance.added_files 必须是非空字符串数组（没有新增就写 []）');
      }
      // 🔴 重复项要拒：它进快照、且是「相对上游多了哪些文件」的权威列表 ——
      //    列两遍会让读它的人以为有两个文件。
      const dup = v.added_files.filter((x, i) => v.added_files.indexOf(x) !== i);
      if (dup.length) bad('E_PROMO_SHAPE', `provenance.added_files 有重复项：${[...new Set(dup)].join('、')}`);
      provenance = { ...v };
    } else {
      bad('E_PROMO_SHAPE', `provenance.kind 只能是 original / vendored，得到 ${JSON.stringify(kind)}`);
    }
  }
  return { owner, provenance };
}

/**
 * 把投稿声明的那一半，与 promote 才知道的那一半合起来。
 *
 * @param {object} a
 * @param {object|null} a.declared      `readPromotionFile` 的结果
 * @param {string} a.kind               skill / pack
 * @param {object} a.pr                 `{number, authorId, authorLogin, createdAt}`
 * @param {object} [a.orgIds]           `login → node id`，**由 promote 从 API 解析**
 * @returns {{owner:object|undefined, provenance:object|undefined}}
 */
export function fillFromPr({ declared, kind, pr, orgIds = {} }) {
  const out = {};
  if (declared?.owner) {
    // 🔴 `user` 的 owner 必须**就是** PR 作者。允许写别人的 login，
    //    等于让 A 用一次投稿把 namespace 注册到 B 名下。
    //    `org` 走不了这条自动判据 —— 归 §8 人工门（维护者要确认这个 org 真是他的）。
    if (declared.owner.kind === 'user' && declared.owner.login !== pr.authorLogin) {
      bad('E_PROMO_OWNER',
        `claim_owner.login 是 ${declared.owner.login}，而 PR 作者是 ${pr.authorLogin}。\n`
        + '  🔴 kind: user 的首次注册只能注册到**投稿者自己**名下。\n'
        + '  要注册到别人 / 组织名下，用 kind: org，并由维护者人工确认。');
    }
    // 🔴 **`org` 的 id 必须是那个 org 的 node id，不是投稿者的。**
    //    早先这里两种 kind 都写 `pr.authorId` —— 于是记录里是
    //    「login: 某组织 + id: 某个人」，而 05-lifecycle §1 说 id 才是身份本身：
    //    那条绑定实际上把 namespace 给了这个人，却显示成组织的（Codex 2026-08-31）。
    //    ⚠️ 「这个人是不是该组织的成员 / 有没有权代表它」**没有自动判据**，
    //       归 §8 人工门 —— 维护者必须确认。
    let id;
    if (declared.owner.kind === 'org') {
      id = orgIds[declared.owner.login];
      if (typeof id !== 'string' || id === '') {
        bad('E_PROMO_ORG_ID',
          `claim_owner 是 org ${declared.owner.login}，但没有拿到它的 node id。\n`
          + '  🔴 org 的绑定必须记**组织自己**的不可变 id —— 记成投稿者的 id，\n'
          + '     等于把 namespace 给了这个人却显示成组织的。\n'
          + '  promote 应当用 `gh api orgs/<login> --jq .node_id` 解析后传进来。');
      }
    } else {
      id = pr.authorId;
    }
    out.owner = { kind: declared.owner.kind, login: declared.owner.login, id };
  }
  if (declared?.provenance) {
    const p = declared.provenance;
    out.provenance = p.kind === 'original'
      ? { kind: 'original', author_github_id: pr.authorId, submitted_by_pr: pr.number }
      : { ...p, imported_at: pr.createdAt, imported_by_pr: pr.number };
  }
  // skill 的 provenance 在 manifest 里，不该由这个文件提供
  if (kind === 'skill' && declared?.provenance) {
    bad('E_PROMO_SHAPE',
      'skill 的 provenance 在 skill.json 里（它的键集有这个字段），'
      + `${PROMOTION_FILE} 不要重复声明 —— 两个来源就会有两个真值。`);
  }
  return out;
}

export { PromotionFileError };

// ── CLI（只校验，给结构门用）────────────────────────────────────────────────

export function main(argv) {
  if (argv.length !== 1) bad('E_PROMO_INPUT', '用法：promotion-file.mjs <投稿目录>');
  const r = readPromotionFile(argv[0]);
  process.stderr.write(r === null
    ? `${argv[0]} 没有 ${PROMOTION_FILE}（已注册 namespace 下的 skill 续版本不需要它）。\n`
    : `✔ ${PROMOTION_FILE} 形状合规（owner=${r.owner ? r.owner.kind : '无'}，`
      + `provenance=${r.provenance ? r.provenance.kind : '无'}）。\n`
      + '⚠️ 形状合规 ≠ 内容可信：origin_* 与 license_evidence 没有自动门能证实，\n'
      + '   它们归 §8 人工门第 8 条。\n');
  return 0;
}

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
