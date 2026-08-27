// journal 的**负测试**：规范说「未定义即拒绝」（§11 §7），那就得逐条证明它真的拒。
//
// 🔴 这些 case 的价值全在「拒绝」上 —— 一条都不能写成「宽容地接受」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from '../src/canonical-json.mjs';
import {
  CONSISTENCY, assertConsistent, journalCrc, listJournalGenerations, readJournal,
  validateJournal, writeJournal, JOURNAL_SCHEMA,
} from '../src/journal.mjs';

const D = (c) => `geoly-tree-v1:sha256:${String(c).repeat(64).slice(0, 64)}`;
const D1 = D('1'), D2 = D('2'), D3 = D('3');

function base(over = {}) {
  return {
    schema: JOURNAL_SCHEMA,
    generation: 7,
    items: { alpha: { op: 'swap', had_old: true, state: 'planned', old_digest: D1, new_digest: D2 } },
    ledger_image: {
      ledger_existed: true,
      post: { entries: { alpha: null }, last_applied_generation: 7, roots: {} },
      pre: { entries: { alpha: null }, last_applied_generation: 6, roots: {} },
    },
    phase: 'prepared',
    tx_dir: 'tx-7',
    ...over,
  };
}

const rejects = (obj, re) => assert.throws(() => validateJournal(obj), re);

test('基本形状能过', () => { assert.ok(validateJournal(base())); });

test('🔴 未知字段一律拒绝（§11 §2 additionalProperties: false）', () => {
  rejects(base({ 未来字段: 1 }), /未知字段/);
  const j = base();
  j.items.alpha.extra = 1;
  rejects(j, /未知字段/);
});

test('🔴 schema 主版本不同即拒绝，不做尽力而为的解析', () => {
  rejects(base({ schema: 'geoly.skills.journal/2' }), /schema/);
});

test('🔴 tx_dir 必须与 generation 一致（同事务绑定的最小一环）', () => {
  rejects(base({ tx_dir: 'tx-8' }), /tx_dir/);
});

test('🔴 old_digest / new_digest 按 op 定义必填/缺席，不补裸 null', () => {
  rejects(base({ items: { a: { op: 'swap', had_old: true, state: 'planned', new_digest: D2 } } }), /old_digest/);
  rejects(base({ items: { a: { op: 'install-new', had_old: false, state: 'planned', new_digest: D2, old_digest: D1 } } }), /old_digest/);
  rejects(base({ items: { a: { op: 'retire-only', had_old: true, state: 'planned', old_digest: D1, new_digest: D2 } } }), /new_digest/);
  rejects(base({ items: { a: { op: 'install-new', had_old: true, state: 'planned', new_digest: D2 } } }), /had_old/);
});

test('🔴 没有 `retiring` 这个 state —— v10 的段模型取消了它', () => {
  rejects(base({ items: { a: { op: 'swap', had_old: true, state: 'retiring', old_digest: D1, new_digest: D2 } } }), /state/);
});

test('🔴 结构门：禁止 swap 的 old_digest == new_digest', () => {
  rejects(base({ items: { a: { op: 'swap', had_old: true, state: 'planned', old_digest: D1, new_digest: D1 } } }),
    /old_digest == new_digest/);
});

test('🔴 direction 与 rollback 必须同时存在或同时缺席', () => {
  rejects(base({ direction: 'rollback' }), /同时存在/);
  rejects(base({ rollback: { items: {} } }), /同时存在/);
});

test('🔴 rollback.items 的键集必须严格等于 items ∪ adopt ∪ unadopt', () => {
  rejects(base({ direction: 'rollback', rollback: { items: {} } }), /缺少 alpha/);
  rejects(base({
    direction: 'rollback',
    rollback: { items: { alpha: { entry_class: 'noop', rstate: 'restored' }, ghost: { entry_class: 'noop', rstate: 'restored' } } },
  }), /多出 ghost/);
});

test('🔴 entry_class × rstate 的合法迁移：as-installed 没有 t_parked', () => {
  const j = base({
    items: { a: { op: 'install-new', had_old: false, state: 'swapped', new_digest: D2 } },
    direction: 'rollback',
    rollback: { items: { a: { entry_class: 'as-installed', rstate: 't_parked' } } },
  });
  rejects(j, /不允许 rstate=t_parked/);
});

test('🔴 (op,state,cleanup,entry_class) 闭合一致性矩阵：未列组合即 corrupt', () => {
  // swap + done + cleanup=done 只允许 as-swapped-cleaned
  const j = base({
    items: { alpha: { op: 'swap', had_old: true, state: 'done', cleanup: 'done', old_digest: D1, new_digest: D2 } },
    direction: 'rollback',
    rollback: { items: { alpha: { entry_class: 'as-swapped', rstate: 'pending' } } },
  });
  rejects(j, /不允许 entry_class=as-swapped/);
  // 而 as-swapped-cleaned 是允许的
  j.rollback.items.alpha = { entry_class: 'as-swapped-cleaned', rstate: 'pending' };
  assert.ok(validateJournal(j));
});

test('🔴 `done` + `tar_durable` 时 as-swapped 与 as-swapped-cleaned **都**合法（v38 的错已修）', () => {
  const it = { op: 'swap', had_old: true, state: 'done', cleanup: 'tar_durable', old_digest: D1, new_digest: D2 };
  assert.doesNotThrow(() => assertConsistent('a', it, 'as-swapped'));
  assert.doesNotThrow(() => assertConsistent('a', it, 'as-swapped-cleaned'));
});

test('🔴 install-new 也有 cleanup 维度（缺席 / tar_durable / done 三种都要显式列出）', () => {
  for (const c of [undefined, 'tar_durable', 'done']) {
    const key = `install-new|done|${c ?? '-'}`;
    assert.ok(CONSISTENCY[key], `矩阵缺少 ${key}`);
  }
  // 非 done 的 state 只允许 cleanup 缺席
  assert.equal(CONSISTENCY['install-new|swapped|tar_durable'], undefined);
});

test('🔴 unadopt 的 assertion-corrupt 不允许进 rollback；adopt 的允许且不检查 T', () => {
  const j1 = base({
    items: {},
    unadopt_assertions: { u: { artifact: 'skill:g/u@1', state: 'assertion-corrupt', tree_digest: D3 } },
    direction: 'rollback',
    rollback: { items: { u: { entry_class: 'noop', rstate: 'restored' } } },
  });
  rejects(j1, /不允许 rollback/);
  const j2 = base({
    items: {},
    adopt_assertions: { a: { artifact: 'skill:g/a@1', state: 'assertion-corrupt', tree_digest: D3 } },
    direction: 'rollback',
    rollback: { items: { a: { entry_class: 'noop', rstate: 'restored' } } },
  });
  assert.ok(validateJournal(j2));
});

test('🔴 三个键集互不相交', () => {
  rejects(base({
    adopt_assertions: { alpha: { artifact: 'skill:g/a@1', state: 'ok', tree_digest: D3 } },
  }), /互不相交/);
});

test('🔴 adopt_assertions 为空时必须整个字段缺席，不得写 {}', () => {
  rejects(base({ adopt_assertions: {} }), /整个字段缺席/);
});

test('🔴 crc32c：8 位定宽小写 hex，覆盖范围是去掉 crc32c 之后的 canonical 字节', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-'));
  try {
    const p = join(dir, '7.json');
    const J = writeJournal(p, base());
    assert.match(J.crc32c, /^[0-9a-f]{8}$/);
    assert.equal(J.crc32c, journalCrc(base()));
    assert.ok(readJournal(p));

    // 改一个字节 → 校验必须失败
    const text = readFileSync(p, 'utf8').replace('"prepared"', '"completed"');
    writeFileSync(p, text);
    assert.throws(() => readJournal(p), /crc32c 不符/);

    // 缺 crc32c
    writeFileSync(p, stringify(base()));
    assert.throws(() => readJournal(p), /缺 crc32c/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 重复 key 必须被拒（JSON.parse 会静默取最后一个）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj2-'));
  try {
    const p = join(dir, '7.json');
    writeFileSync(p, '{"schema":"geoly.skills.journal/1","phase":"prepared","phase":"completed"}\n');
    assert.throws(() => readJournal(p), /重复 key|解析失败/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 journal 文件名扫描只认 `<generation>.json`，且 .tmp 一律忽略并删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj3-'));
  try {
    writeFileSync(join(dir, '7.json'), '{}');
    writeFileSync(join(dir, '9.json'), '{}');
    writeFileSync(join(dir, '.abc.tmp'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    assert.deepEqual(listJournalGenerations(dir), [7, 9]);
    assert.throws(() => { writeFileSync(join(dir, '07.json'), '{}'); listJournalGenerations(dir); }, /前导零/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('🔴 ledger_image：安装事务的 post 只允许 audit_append 一个 audit 相关字段', () => {
  const j = base();
  j.ledger_image.post.audit_archived_until = 3;
  rejects(j, /未知字段 audit_archived_until/);
  j.ledger_image.pre.audit_append = [];
  rejects(j, /未知字段 audit_append/);
});
