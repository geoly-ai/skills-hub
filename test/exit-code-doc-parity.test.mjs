// 🔴 退出码是**最外层的契约** —— 脚本、CI、别的 agent 都按它分支。
//    而 `09-cli.md` 的码表与 `exit-codes.mjs` 之间此前没有任何同步检查。
//
// 📌 加这条是因为我自己栽过：2026-09-05 派活时把 `UNSUPPORTED` 说成 5，
//    实际是 9（5 是 `NEEDS_RECOVER`）。子代理与 Codex 各自独立纠正了我。
//    **有这张表的同步检查，那个错当场就会被抓** —— 而它当时只存在于我脑子里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXIT } from '../src/exit-codes.mjs';

const DOC = readFileSync(new URL('../docs/m0/09-cli.md', import.meta.url), 'utf8');

/** 从「| 码 | 含义 |」那张表里取出所有码。🔴 只认那一张表，不满文件抓数字。 */
function documentedCodes() {
  const head = DOC.indexOf('| 码 | 含义 |');
  assert.notEqual(head, -1, '09-cli.md 里找不到退出码表 —— 表本身没了');
  const rest = DOC.slice(head);
  const end = rest.indexOf('\n\n');
  const body = end === -1 ? rest : rest.slice(0, end);
  return new Map(
    [...body.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/gm)].map((m) => [Number(m[1]), m[2]]),
  );
}

test('🔴 代码里的每个退出码都必须在 09-cli.md 的码表里', () => {
  const doc = documentedCodes();
  const missing = Object.entries(EXIT)
    .filter(([, v]) => !doc.has(v))
    .map(([k, v]) => `${v} (${k})`);
  assert.deepEqual(missing, [],
    `这些退出码程序会返回，但文档没写 —— 调用方无从判断该怎么处理：\n  ${missing.join('\n  ')}`);
});

test('🔴 码表里的每个码都必须真的存在于 EXIT', () => {
  const codes = new Set(Object.values(EXIT));
  const ghosts = [...documentedCodes().keys()].filter((c) => !codes.has(c));
  assert.deepEqual(ghosts, [],
    `文档承诺了这些退出码，但程序永远不会返回它们：\n  ${ghosts.join('\n  ')}`);
});

test('🔴 码值必须连续无洞 —— 有洞说明删过一个而文档没跟上', () => {
  // ⚠️ 这不是洁癖：退出码一旦发布就是契约，删掉一个会让老脚本的分支
  //    静默走到 else。有洞时至少要有人**主动**决定「这个洞是有意的」。
  const vals = Object.values(EXIT).sort((a, b) => a - b);
  const holes = [];
  for (let i = vals[0]; i < vals[vals.length - 1]; i += 1) {
    if (!vals.includes(i)) holes.push(i);
  }
  assert.deepEqual(holes, [], `退出码序列有洞：${holes.join(', ')}`);
});

test('🔴 名字与码一一对应 —— 不许两个名字共用一个码', () => {
  // 共用的话，`classify` 把两种完全不同的失败映到同一个码上，
  // 而调用方分不开「完整性失败」和「网络失败」这种需要不同处置的事。
  const seen = new Map();
  const dup = [];
  for (const [k, v] of Object.entries(EXIT)) {
    if (seen.has(v)) dup.push(`${v}: ${seen.get(v)} 与 ${k}`);
    seen.set(v, k);
  }
  assert.deepEqual(dup, [], `这些码被多个名字共用：\n  ${dup.join('\n  ')}`);
});
