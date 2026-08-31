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
  submissionsRoot, reserved, existingIds = [], existingNamesByNs = new Map(), byMaintainer = false,
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

    // ④ capability 一致性（只对 skill —— pack.json 里没有 capabilities）
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
