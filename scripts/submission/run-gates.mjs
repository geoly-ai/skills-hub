#!/usr/bin/env node
// 把 §6 的结构门跑在 `submissions/**` 上 —— 06-submission.md §6。
//
// 🔴 **不执行载荷**（§5）：这里只读文件、算摘要、比字符串。
//    没有任何一步会跑投稿带来的脚本。
//
// 布局（01-artifacts.md §2）：`submissions/<namespace>/<name>@<version>/`
//
// 🔴 **一次跑完全部投稿、把所有失败一起报出来**，不是遇到第一个就退出。
//    投稿者要能一次看到所有问题 —— 让人来回改三轮的门，人会绕着走。

import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseStrict } from '../../src/canonical-json.mjs';
import { collectTree } from '../../src/packer.mjs';
import {
  readReserved, assertReservedNamespaceAllowed, assertNoNormalizedCollision,
  assertVersionUnused, assertCapabilityConsistency,
} from './structural-gates.mjs';
import { readPromotionFile } from './promotion-file.mjs';
import { assertSkillFrontmatter } from '../../src/artifact.mjs';

const RE_SUBMISSION_DIR = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@(.+)$/;

class RunError extends Error {
  constructor(msg) { super(msg); this.name = 'RunError'; }
}

/** 枚举 `submissions/<ns>/<name>@<ver>/`。 */
export function scanSubmissions(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const ns of readdirSync(root).sort()) {
    for (const entry of readdirSync(join(root, ns)).sort()) {
      const m = RE_SUBMISSION_DIR.exec(entry);
      if (m === null) {
        throw new RunError(
          `submissions/${ns}/${entry} 不合布局 —— 必须是 <name>@<version>/`
          + '（01-artifacts.md §2）。目录名本身就是投稿在声明它是什么，不该靠猜。',
        );
      }
      out.push({ namespace: ns, name: m[1], version: m[2], dir: join(root, ns, entry) });
    }
  }
  return out;
}

/**
 * @param {object} a
 * @param {string} a.submissionsRoot
 * @param {object} a.reserved
 * @param {string[]} a.existingIds     已有的全部 ArtifactId（**含已 yank**）
 * @param {Map<string,string[]>} a.existingNamesByNs  同 namespace 内已有的 name
 * @param {boolean} a.byMaintainer
 * @returns {{checked:number, problems:string[]}}
 */
export function runGates({
  submissionsRoot, reserved, existingIds = [], existingNamesByNs = new Map(),
  byMaintainer = false, registeredNamespaces = new Set(),
}) {
  const problems = [];
  const subs = scanSubmissions(submissionsRoot);

  for (const s of subs) {
    const where = `submissions/${s.namespace}/${s.name}@${s.version}`;
    const push = (e) => problems.push(`${where}：${e.message.split('\n')[0]}`);

    // ① 保留 namespace
    try {
      assertReservedNamespaceAllowed({ namespace: s.namespace, reserved, byMaintainer });
    } catch (e) { push(e); }

    // ② 归一化重名（同 namespace 内）
    try {
      assertNoNormalizedCollision({
        name: s.name, existing: existingNamesByNs.get(s.namespace) ?? [],
      });
    } catch (e) { push(e); }

    // ③ 版本未占用（含已 yank）
    //    kind 由载荷里有 skill.json 还是 pack.json 决定 —— 目录名不带 kind。
    const isPack = existsSync(join(s.dir, 'pack.json'));
    const isSkill = existsSync(join(s.dir, 'skill.json'));
    if (isPack === isSkill) {
      problems.push(
        `${where}：载荷根必须**恰好**有 skill.json 或 pack.json 其中一个`
        + `（现在 skill.json=${isSkill}、pack.json=${isPack}）——`
        + '两个都在时「这是什么制品」有两个答案。',
      );
      continue;                      // kind 都定不下来，后面的门无从谈起
    }
    const kind = isPack ? 'pack' : 'skill';
    try {
      assertVersionUnused({ id: `${kind}:${s.namespace}/${s.name}@${s.version}`, existingIds });
    } catch (e) { push(e); }

    // ④ PROMOTION.json：形状 + **必需性**
    //    🔴 在**投稿 PR** 上就检，而不是等到 promote —— 那时投稿已经合并进 main，
    //    再报「你的 PROMOTION.json 写错了」，改起来要走一整轮。
    //    🔴 「有就检」不够：一个没有 provenance 的 pack、或一个未注册 namespace
    //    下没有 claim_owner 的首投，会**通过投稿 CI、合并进 main、然后卡住
    //    promote** —— 那时它已经在 main 上了（Codex 2026-08-31）。
    let declared = null;
    try {
      declared = readPromotionFile(s.dir);
    } catch (e) { push(e); }
    if (declared === null && !existsSync(join(s.dir, 'PROMOTION.json'))) {
      if (isPack) {
        problems.push(`${where}：pack 必须有 PROMOTION.json —— `
          + 'pack.json 的键集里没有 provenance（03-packs §2），它只能由投稿声明。');
      }
      if (!registeredNamespaces.has(s.namespace)) {
        problems.push(`${where}：namespace ${s.namespace} 尚未注册，`
          + '必须在 PROMOTION.json 里给出 claim_owner（首次注册）。');
      }
    } else if (declared !== null) {
      if (isPack && declared.provenance === null) {
        problems.push(`${where}：pack 的 PROMOTION.json 必须声明 provenance`);
      }
      if (!registeredNamespaces.has(s.namespace) && declared.owner === null) {
        problems.push(`${where}：namespace ${s.namespace} 尚未注册，`
          + 'PROMOTION.json 必须声明 claim_owner');
      }
    }

    // ⑤ˢ SKILL.md frontmatter —— 调**建快照将来要调的同一个函数**
    //    🔴 2026-09-02 补上：这道门以前根本不解析 frontmatter，于是 11 个投稿
    //    全绿合并进 main，promote 建快照时才红在 E_FRONTMATTER（10 个用了 YAML
    //    折叠标量 `>`，而解析器是刻意最小化的、只认单行 key: value）。
    //    那正是本文件④处注释里写的那件事：等到 promote 才报，投稿已经在 main 上了。
    //    ⚠️ 共用 `assertSkillFrontmatter`，不在这里另写一份 —— 另写就是又一处会分叉的实现。
    if (kind === 'skill') {
      try {
        assertSkillFrontmatter({
          payloadDir: s.dir,
          name: s.name,
          viol: (code, msg) => { throw new Error(`[${code}] ${msg}`); },
        });
      } catch (e) { push(e); }
    }

    // ⑤ capability 一致性（只对 skill —— pack.json 里没有 capabilities）
    if (kind === 'skill') {
      try {
        const manifest = parseStrict(readFileSync(join(s.dir, 'skill.json'), 'utf8'));
        assertCapabilityConsistency({
          capabilities: manifest.capabilities, entries: collectTree(s.dir),
        });
      } catch (e) { push(e); }
    }
  }

  return { checked: subs.length, problems };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new RunError(`不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) throw new RunError(`${name} 需要一个值`);
    o[name.slice(2)] = val;
  }
  return o;
}

/** `owners.json` 里已注册的 namespace 集合。文件不存在 = 一个都还没注册。 */
function readRegistered(path) {
  if (!existsSync(path)) return new Set();
  try {
    return new Set(Object.keys(parseStrict(readFileSync(path, 'utf8')).namespaces ?? {}));
  } catch {
    // 🔴 读不出来时**当成空的**是危险的：那会让每个 namespace 都被判成
    //    「首次注册」，于是任何人都能声明 claim_owner。宁可整个门失败。
    throw new RunError(`${path} 读不出来 —— 拒绝在「不知道谁注册过」的情况下判首次注册`);
  }
}

export function main(argv) {
  const o = parseArgs(argv);
  const submissionsRoot = o.submissions ?? 'submissions';

  // 已有制品：从 artifacts/ 树里数（快照可能还不存在）
  const existingIds = [];
  const existingNamesByNs = new Map();
  const artifactsRoot = o.artifacts ?? 'artifacts';
  if (existsSync(artifactsRoot)) {
    for (const kindDir of readdirSync(artifactsRoot)) {
      const kind = kindDir === 'skills' ? 'skill' : kindDir === 'packs' ? 'pack' : null;
      if (kind === null) continue;
      for (const ns of readdirSync(join(artifactsRoot, kindDir))) {
        for (const name of readdirSync(join(artifactsRoot, kindDir, ns))) {
          if (!existingNamesByNs.has(ns)) existingNamesByNs.set(ns, []);
          existingNamesByNs.get(ns).push(name);
          for (const v of readdirSync(join(artifactsRoot, kindDir, ns, name))) {
            existingIds.push(`${kind}:${ns}/${name}@${v}`);
          }
        }
      }
    }
  }

  const { checked, problems } = runGates({
    submissionsRoot,
    reserved: readReserved(o.reserved ?? 'registry/reserved.json'),
    existingIds,
    existingNamesByNs,
    // 🔴 「是不是维护者」是 PR 侧的事实，默认 **false**（fail-closed）：
    //    没传就按「不是维护者」处理，保留 namespace 因此会被拒。
    byMaintainer: o['by-maintainer'] === 'true',
    // 已注册的 namespace —— 用来判「这次是不是首次注册」
    registeredNamespaces: readRegistered(o.owners ?? 'registry/owners.json'),
  });

  if (checked === 0) {
    process.stderr.write('没有待检的投稿（submissions/ 为空）。\n');
    return 0;
  }
  if (problems.length) {
    process.stderr.write(`🔴 ${checked} 个投稿里有 ${problems.length} 处不合规：\n`);
    for (const p of problems) process.stderr.write(`  · ${p}\n`);
    return 1;
  }
  process.stderr.write(`✔ ${checked} 个投稿全部通过结构门。\n`);
  return 0;
}

export { RunError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
