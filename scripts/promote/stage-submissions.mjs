#!/usr/bin/env node
// 把已合并的 `submissions/**` 搬进 `artifacts/**` —— 06-submission.md §1 / §3。
//
// 这是 promotion 阶段 A 里**唯一改动工作树**的一步，后面的 `build-inputs` /
// `build-snapshot` 都只读。所以它必须把「能不能搬」全部判完再动第一个文件。
//
// 布局转换（01-artifacts.md §2）：
//   submissions/<ns>/<name>@<ver>/           →  artifacts/<kind>s/<ns>/<name>/<ver>/
// `kind` 不在目录名里，由载荷根有 `skill.json` 还是 `pack.json` 决定 ——
// 与 `run-gates.mjs` 判 kind 的方式**必须是同一条**，否则结构门检的和搬的不是一个东西。
//
// ── 🔴 三条不肯让步的 ────────────────────────────────────────────────────
// ① **目标目录已存在 → 直接拒，绝不覆盖。** 版本号不可重用（含已 yank）。
//    §3 第 4 项在 promote 侧要求重判一次，这里是它的**执行点**：
//    `verify-merged-pr.assertVersionsStillFree` 判的是「名单」，
//    这一步判的是「盘上真实的目录」—— 后者才是最终事实。
// ② **先全判后全搬。** 一半搬完再失败会留下一棵半新半旧的树，
//    而 CI 的下一步（build-snapshot）会把它当成完整事实照单全收。
// ③ **搬完之后 `submissions/` 里那几个目录要删掉。** 留着的话下一次 push
//    会把同一批投稿再 promote 一遍 —— 那时目标目录已存在，于是 ① 报错，
//    表现为「莫名其妙的版本冲突」，而真因在这里。

import {
  readdirSync, existsSync, mkdirSync, cpSync, rmSync, realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { scanSubmissions } from '../submission/run-gates.mjs';

class StageError extends Error {
  constructor(code, msg) { super(msg); this.name = 'StageError'; this.code = code; }
}
const bad = (code, msg) => { throw new StageError(code, msg); };

/** 载荷根有 skill.json 还是 pack.json —— 与 run-gates 同一条判据。 */
function kindOf(dir) {
  const isPack = existsSync(join(dir, 'pack.json'));
  const isSkill = existsSync(join(dir, 'skill.json'));
  if (isPack === isSkill) {
    bad('E_KIND_AMBIGUOUS',
      `${dir} 的载荷根必须**恰好**有 skill.json 或 pack.json 其中一个`
      + `（skill.json=${isSkill}、pack.json=${isPack}）。`);
  }
  return isPack ? 'pack' : 'skill';
}

/**
 * 只算，不动盘。
 * @returns {Array<{id:string, from:string, to:string}>} 按 id 字节序
 */
export function planStaging({ submissionsRoot, artifactsRoot }) {
  const subs = scanSubmissions(submissionsRoot);
  const plan = [];
  const seen = new Set();
  for (const s of subs) {
    const kind = kindOf(s.dir);
    const id = `${kind}:${s.namespace}/${s.name}@${s.version}`;
    // 同一批里出现两次：`skill:` 与 `pack:` 前缀不同就不是重复，所以按 id 判
    if (seen.has(id)) bad('E_DUPLICATE', `本批里有两个 ${id}`);
    seen.add(id);

    const to = join(artifactsRoot, `${kind}s`, s.namespace, s.name, s.version);
    // 🔴 ① 已存在就拒 —— 制品不可变，版本号不可重用（含已 yank）
    if (existsSync(to)) {
      bad('E_VERSION_TAKEN',
        `${id} 已经存在于 ${to} —— 制品不可变，版本号不可重用（含已 yank）。\n`
        + '  🔴 投稿 PR 上判过一次「没占用」，但那是在**它自己的 base** 上做的；\n'
        + '     两次之间可能有别的 PR 先合并。请发新版本。');
    }
    plan.push({ id, from: s.dir, to });
  }
  plan.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  return plan;
}

/**
 * 执行搬运。**先全判后全搬**（planStaging 已经判完）。
 * @returns {string[]} 本次新增的 ArtifactId
 */
export function stageSubmissions({ submissionsRoot, artifactsRoot, dryRun = false }) {
  const plan = planStaging({ submissionsRoot, artifactsRoot });
  if (plan.length === 0) return [];
  if (dryRun) return plan.map((p) => p.id);

  for (const p of plan) {
    mkdirSync(dirname(p.to), { recursive: true });
    // 🔴 `cpSync` 不是 `renameSync`：跨设备时 rename 会 EXDEV，
    //    而 GitHub runner 上 /home/runner/work 与 tmp 未必同一个设备。
    //    另外 dereference:false —— 载荷里本来就不许有 symlink（01-artifacts §5），
    //    真混进来一个的话，跟着解开等于把仓库外的文件搬进制品。
    cpSync(p.from, p.to, { recursive: true, dereference: false, errorOnExist: true, force: false });
  }
  // 🔴 ③ 搬完删源 —— 留着会让下一次 push 重跑同一批
  for (const p of plan) rmSync(p.from, { recursive: true, force: true });
  cleanEmptyNamespaces(submissionsRoot);

  return plan.map((p) => p.id);
}

/** `submissions/<ns>/` 空了就删掉它自己（空目录留着会让 diff 里出现噪音）。 */
function cleanEmptyNamespaces(root) {
  if (!existsSync(root)) return;
  for (const ns of readdirSync(root)) {
    const dir = join(root, ns);
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch { /* 不是目录，或已经没了 —— 都不影响结果 */ }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

// 白名单 + 拒重复（同 verify-promotion.mjs：拼错的选项被静默忽略最危险）
const KNOWN = ['submissions', 'artifacts', 'dry-run'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_STAGE_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.slice(2);
    if (!KNOWN.includes(key)) {
      bad('E_STAGE_INPUT', `不认识的选项 ${name}（只接受 ${KNOWN.map((k) => `--${k}`).join(' ')}）`);
    }
    if (key in o) bad('E_STAGE_INPUT', `${name} 给了不止一次`);
    if (key === 'dry-run') { o[key] = 'true'; continue; }
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_STAGE_INPUT', `${name} 需要一个值`);
    o[key] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  const ids = stageSubmissions({
    submissionsRoot: o.submissions ?? 'submissions',
    artifactsRoot: o.artifacts ?? 'artifacts',
    dryRun: o['dry-run'] === 'true',
  });
  if (ids.length === 0) {
    // 🔴 **不是 0**：promote.yml 是由「push 到 main 且动了 submissions/」触发的，
    //    到这里一个都没有说明触发条件与实际内容对不上（比如投稿被同一个 push
    //    删掉了）—— 静默产出一张空 promotion PR 比报错糟得多。
    bad('E_NOTHING_TO_STAGE',
      'submissions/ 里没有可搬的投稿。promote 是由「push 到 main 且动了 submissions/」'
      + '触发的，走到这里说明触发条件与实际内容对不上。');
  }
  // stdout 只放 id 列表 —— 它要被 promote.yml 直接喂给 build-inputs 的 --new-ids
  process.stdout.write(`${ids.join(',')}\n`);
  process.stderr.write(`✔ ${ids.length} 个投稿已搬进 artifacts/：\n${ids.map((i) => `  · ${i}`).join('\n')}\n`);
  return 0;
}

export { StageError };

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
