#!/usr/bin/env node
// 从快照生成**给 agent 读的可安装清单** —— registry/catalog.md。
//
// 🔴 **数据源只有快照 + artifacts 树，没有第二个真相。**
//    快照是已签名对象里那份权威清单；清单只是把它渲染成 agent 能直接读的形状。
//    另起一份手工维护的列表必然与快照分叉，而分叉的方向一定是「清单忘了更新」——
//    那时 agent 会去装一个不存在的东西，或者不知道有个能用的东西。
//
// 🔴 **必须是确定性的**：同样的快照 + 同样的 artifacts 树 → 同样的字节。
//    所以这里不取当前时间、不读环境、不按 Map 的插入序输出，一律按 id 排序。
//    `test/agents-catalog.test.mjs` 会重新生成一遍并**逐字节比对**，
//    于是「改了快照忘了改清单」必然变红。
//
// 🔴 **输出落在 `registry/`，不是 `docs/`。** 不是随手选的：promotion PR 的路径
//    白名单只有 `artifacts/ registry/ advisories/` 三个前缀
//    （`scripts/submission/pr-classify.mjs` 的 PROMOTION_PATHS）。写进 `docs/`
//    的话，**promote 自己产出的 PR 会过不了它自己的门** —— 这个仓库 2026-09-01
//    就栽过一次，注释还留在那个常量旁边。
//    放宽白名单是安全相关的动作（那道门防的是构建器写到不该写的地方），
//    而清单本身就是 registry 数据，放进 registry/ 是它本来的位置。
//    给 agent 的入口用 `docs/agents/01-install.md` 里的一行静态指针 —— 那一行
//    不随发布变化，永远不需要重新生成。
//
// 用法：
//   node scripts/promote/build-catalog.mjs \
//     --snapshot registry/snapshots/hub-6.json --out registry/catalog.md
//   不给 --snapshot 就取 registry/snapshots 里编号最大的那张。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseStrict } from '../../src/canonical-json.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 取编号最大的快照。**按数字比，不按字符串** —— hub-10 要排在 hub-9 后面。 */
export function newestSnapshotPath(dir = join(REPO, 'registry', 'snapshots')) {
  if (!existsSync(dir)) return null;
  const nums = readdirSync(dir)
    .map((f) => /^hub-(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return nums.length === 0 ? null : join(dir, `hub-${nums[nums.length - 1]}.json`);
}

/**
 * 一行描述。
 *
 * 🔴 **折叠空白并截断，而且截断点是确定的。** 描述来自投稿者，里面可能有换行、
 *    竖线、极长的段落 —— 换行会把表格撕开，竖线会多切出一列。
 * 🔴 `|` 用转义而不是删除：删掉是**改了别人的文案**，转义只是让它在表格里显示。
 */
export function oneLine(s, max = 110) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  if (flat.length <= max) return flat;
  // 截断点固定在 max，不去找词边界 —— 找词边界会让同一段文案在不同语言下
  // 截出不同长度，那就不是确定性输出了
  return `${flat.slice(0, max)}…`;
}

/** 从 artifacts 树里读这个制品的描述。读不到就留空 —— **不编一个**。 */
function describe(rec, artifactsRoot) {
  for (const f of ['skill.json', 'pack.json']) {
    const p = join(artifactsRoot, '..', rec.path, f);
    try {
      if (existsSync(p)) {
        const doc = parseStrict(readFileSync(p, 'utf8'));
        if (typeof doc.description === 'string') return oneLine(doc.description);
      }
    } catch { /* 读不了就当没有 */ }
  }
  return '';
}

const TIER_OF = { none: 0, network: 1, 'external-tool': 1, shell: 2, credentials: 2, 'writes-repo': 2 };
/** 与 build-inputs 的 capabilityTier 同一套判据：认不出来的一律按最高档。 */
export function tierOf(capabilities) {
  let t = 0;
  for (const c of capabilities ?? []) t = Math.max(t, TIER_OF[c] ?? 2);
  return t;
}

export function renderCatalog({ snapshot, artifactsRoot }) {
  const recs = [...(snapshot.artifacts ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const live = recs.filter((r) => r.status === 'published');
  const dead = recs.filter((r) => r.status !== 'published');
  const latest = snapshot.latest ?? {};

  const L = [];
  L.push('# 可安装清单 —— agent 直接读这一份');
  L.push('');
  L.push('> 🔴 **本文件由 `scripts/promote/build-catalog.mjs` 从快照生成，不要手改。**');
  L.push('> 手改会被 `test/agents-catalog.test.mjs` 逐字节比对挡下来。');
  L.push('> 权威源是 `registry/snapshots/hub-<N>.json`（已签名对象里的那份清单），');
  L.push('> 这里只是把它渲染成人和 agent 都能直接读的形状。');
  L.push('');
  L.push(`快照 **${snapshot.snapshot}** · 生成于 \`${snapshot.created_at}\` · 仓库 \`${snapshot.repo}\``);
  L.push('');
  L.push('## 怎么装');
  L.push('');
  L.push('```sh');
  L.push('# 装一个 skill（不用先装 CLI）');
  L.push('npx @geoly-ai/skills-hub install skill:<ns>/<name> --clients claude');
  L.push('# 装一整套 pack（成员一次装完）');
  L.push('npx @geoly-ai/skills-hub install pack:<ns>/<name> --clients claude');
  L.push('```');
  L.push('');
  L.push('**版本可以省略** —— 省略即取快照的 `latest`（非 yank、非 prerelease、非 degraded）。');
  L.push('写版本就要写全：`@0.7.0`，没有 `@latest` 这个写法。');
  L.push('首次装到某个 client 时目录可能不存在，加 `--create-missing <client>`。');
  L.push('细节见 [`docs/agents/01-install.md`](../docs/agents/01-install.md)，'
    + '投稿见 [`docs/agents/02-publish.md`](../docs/agents/02-publish.md)。');
  L.push('');
  L.push('⚠️ **Tier 2 的制品能执行 shell、读凭据或写仓库。** 装之前先看它的 `SKILL.md`；');
  L.push('agent 不要在没有用户明确同意的情况下装 Tier 2。');
  L.push('');

  const section = (title, kind) => {
    const rows = live.filter((r) => r.kind === kind);
    if (rows.length === 0) return;
    L.push(`## ${title}（${rows.length}）`);
    L.push('');
    L.push('| id | latest | tier | clients | 说明 |');
    L.push('|---|---|---|---|---|');
    for (const r of rows) {
      const key = `${r.kind}:${r.namespace}/${r.name}`;
      const isLatest = latest[key] === r.version ? '✓' : '';
      L.push(`| \`${r.id}\` | ${isLatest} | ${tierOf(r.capabilities)} | ${(r.clients ?? []).join(' ')} `
        + `| ${describe(r, artifactsRoot)} |`);
    }
    L.push('');
  };
  section('Pack', 'pack');
  section('Skill', 'skill');

  if (dead.length > 0) {
    L.push(`## 不要装（${dead.length}）`);
    L.push('');
    L.push('🔴 这些制品**仍然在快照里**（历史不可变），但 `status` 不是 `published`。');
    L.push('agent 不得安装它们，也不要把它们当成"旧版本还能用"。');
    L.push('');
    L.push('| id | status |');
    L.push('|---|---|');
    for (const r of dead) L.push(`| \`${r.id}\` | ${r.status} |`);
    L.push('');
  }
  return `${L.join('\n')}`;
}

function main(argv) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const snapPath = arg('--snapshot') ?? newestSnapshotPath();
  if (!snapPath) {
    process.stderr.write('✖ 没有找到任何 registry/snapshots/hub-<N>.json\n');
    process.exit(1);
  }
  const snapshot = parseStrict(readFileSync(snapPath, 'utf8'));
  const out = arg('--out') ?? join(REPO, 'registry', 'catalog.md');
  const text = renderCatalog({ snapshot, artifactsRoot: join(REPO, 'artifacts') });
  writeFileSync(out, `${text}\n`);
  process.stderr.write(`✔ 清单已生成：${out}（快照 ${snapshot.snapshot}，${snapshot.artifacts.length} 个制品）\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
