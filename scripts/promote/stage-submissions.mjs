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
  readdirSync, existsSync, mkdirSync, cpSync, rmSync, rmdirSync, realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';

import { scanSubmissions } from '../submission/run-gates.mjs';
import { PROMOTION_FILE } from '../submission/promotion-file.mjs';

class StageError extends Error {
  constructor(code, msg) { super(msg); this.name = 'StageError'; this.code = code; }
}
const bad = (code, msg) => { throw new StageError(code, msg); };

/**
 * 目录名里的一段要能安全地拼进路径。
 * 🔴 `.` / `..` / 空 / 含 `/` 或 `\\` 全拒 —— `alpha@.` 与 `alpha@..` 在预检时
 *    会映射到同一个目标目录，于是「先全判后全搬」被绕过（Codex 2026-08-31）。
 */
function assertSafeSegment(seg, where) {
  if (typeof seg !== 'string' || seg === '' || seg === '.' || seg === '..'
      || seg.includes('/') || seg.includes('\\') || seg.includes('\u0000')) {
    bad('E_BAD_SEGMENT', `${where} 不是合法的路径片段：${JSON.stringify(seg)}`);
  }
}

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
export function planStaging({ submissionsRoot, artifactsRoot, only = null }) {
  const subs = scanSubmissions(submissionsRoot);

  // 🔴 **只搬这一次 PR 带来的那几个。** promote 是「push 到 main 且动了
  //    submissions/」触发的，但扫的是**整个** submissions/ —— 如果上一次
  //    promote 没跑完、留下了积压，它们会被这一次一并搬走，并且在
  //    build-inputs 那里被标成「本次 PR 审过的」。复算门对新增 review 是自举的，
  //    抓不到这种错误归属（Codex 2026-08-31）。
  if (only !== null) {
    const want = new Set(only);
    const got = new Set(subs.map((x) => `${x.namespace}/${x.name}@${x.version}`));
    const extra = [...got].filter((x) => !want.has(x)).sort();
    const missing = [...want].filter((x) => !got.has(x)).sort();
    if (extra.length || missing.length) {
      bad('E_SUBMISSIONS_MISMATCH',
        'submissions/ 的内容与本次 PR 带来的那几个对不上：\n'
        + (extra.length ? `  多出来（很可能是上一次 promote 没跑完的积压）：${extra.join('、')}\n` : '')
        + (missing.length ? `  少了：${missing.join('、')}\n` : '')
        + '  🔴 积压会被这一次一并搬走，并被错误标成本次 PR 审过的 —— 复算门抓不到。\n'
        + '     请先把积压的那几个单独 promote 掉。');
    }
  }

  const plan = [];
  const seen = new Set();
  const byNsName = new Map();
  const targets = new Set();
  for (const s of subs) {
    // 🔴 `version` 来自目录名，会直接拼进路径。`.` / `..` / 含分隔符的
    //    在预检时映射到同一个目标，第一个搬完第二个才失败。
    assertSafeSegment(s.version, `${s.namespace}/${s.name} 的版本`);
    assertSafeSegment(s.name, `${s.namespace} 下的 name`);
    assertSafeSegment(s.namespace, 'namespace');

    const kind = kindOf(s.dir);
    const id = `${kind}:${s.namespace}/${s.name}@${s.version}`;
    if (seen.has(id)) bad('E_DUPLICATE', `本批里有两个 ${id}`);
    seen.add(id);

    // 🔴 **`name` 在同一个 namespace 内唯一，跨 kind 也唯一**（01-artifacts §2）。
    //    按完整 ArtifactId 去重的话，`skill:a/foo` 与 `pack:a/foo` 会同时放行。
    const nsName = `${s.namespace}/${s.name}`;
    const prevKind = byNsName.get(nsName);
    if (prevKind !== undefined && prevKind !== kind) {
      bad('E_NAME_TAKEN',
        `${nsName} 同时以 ${prevKind} 和 ${kind} 出现 —— name 在同一个 namespace 内唯一（01-artifacts §2）。`);
    }
    byNsName.set(nsName, kind);
    const otherDir = join(artifactsRoot, `${kind === 'pack' ? 'skills' : 'packs'}`, s.namespace, s.name);
    if (existsSync(otherDir)) {
      bad('E_NAME_TAKEN',
        `${nsName} 已经作为另一种 kind 存在于 ${otherDir} —— name 在同一个 namespace 内唯一。`);
    }

    const to = join(artifactsRoot, `${kind}s`, s.namespace, s.name, s.version);
    if (targets.has(to)) bad('E_DUPLICATE', `本批里有两个投稿映射到同一个目标 ${to}`);
    targets.add(to);
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
export function stageSubmissions({ submissionsRoot, artifactsRoot, dryRun = false, only = null }) {
  const plan = planStaging({ submissionsRoot, artifactsRoot, only });
  if (plan.length === 0) return [];
  if (dryRun) return plan.map((p) => p.id);

  // 🔴 **预检通过 ≠ 搬得动。** 任何一个 mkdir / cp 失败（盘满、权限、
  //    载荷里混了个 FIFO）都会把前面已经搬好的留在盘上，而下一步
  //    build-snapshot 会把那棵半新半旧的树当成完整事实（Codex 2026-08-31）。
  //    所以出错要把本次**已经创建的目标**全部撤掉。
  const done = [];
  try {
    for (const p of plan) {
      mkdirSync(dirname(p.to), { recursive: true });
      // 🔴 `cpSync` 不是 `renameSync`：跨设备时 rename 会 EXDEV，
      //    而 GitHub runner 上 /home/runner/work 与 tmp 未必同一个设备。
      //    ⚠️ `dereference:false` 是**保留**链接、不是拒绝链接 ——
      //    「不许有 symlink」由结构门（collectTree）判，不是这里。
      cpSync(p.from, p.to, {
        recursive: true, dereference: false, errorOnExist: true, force: false,
        // 🔴 `PROMOTION.json` 是**投稿描述符，不是载荷**：它带的是 owner 与
        //    provenance 的声明，promote 读完就该丢。跟着搬进 artifacts/ 的话：
        //      · 它会进制品的 tree_digest 与资产字节 —— 用户装到一份内部材料；
        //      · vendored 的 origin_tree_digest 永远对不上（多了一个上游没有的文件）。
        //    （Codex 2026-08-31）
        filter: (src) => basename(src) !== PROMOTION_FILE,
      });
      done.push(p.to);
    }
  } catch (e) {
    // ⚠️ 撤的时候连**本次新建的空父目录**一起撤：`mkdirSync(dirname(to))` 会
    //    造出 `artifacts/skills/<ns>/<name>/`，只删版本目录会留下一个空壳，
    //    下一次扫 artifacts/ 时它是个「没有任何版本的制品」。
    for (const to of done.reverse()) {
      try { rmSync(to, { recursive: true, force: true }); } catch { /* 尽力回滚 */ }
      removeEmptyAncestors(dirname(to), artifactsRoot);
    }
    throw e;
  }
  // 🔴 ③ 搬完删源 —— 留着会让下一次 push 重跑同一批
  for (const p of plan) rmSync(p.from, { recursive: true, force: true });
  cleanEmptyNamespaces(submissionsRoot);

  return plan.map((p) => p.id);
}

/** 逐层往上删空目录，到 `stopAt` 为止（不含）。 */
function removeEmptyAncestors(dir, stopAt) {
  let cur = dir;
  while (cur !== stopAt && cur.startsWith(stopAt) && cur !== dirname(cur)) {
    try {
      if (readdirSync(cur).length !== 0) return;
      // 🔴 `rmSync` 不带 recursive 删目录会 ERR_FS_EISDIR —— 那会被下面的
      //    catch 吞掉，表现为「回滚看起来跑了，空壳还在」。用 rmdirSync。
      rmdirSync(cur);
    } catch { return; }
    cur = dirname(cur);
  }
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
const KNOWN = ['submissions', 'artifacts', 'dry-run', 'only'];

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
    // `--only ns/name@ver,…`：本次 PR 真正带来的那几个（见 planStaging 里的说明）
    only: o.only === undefined ? null : o.only.split(',').map((x) => x.trim()).filter(Boolean),
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
