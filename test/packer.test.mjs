// packer —— 断言的是**具体那一项**（违规码 / PackError.code），不是「抛了错」。
//
// 三类测试，缺一不可：
//   ① 往返属性：packer 接受的每一个输入，parser 都必须接受（不是喂几个合法样例）。
//   ② 独立 golden 字节向量：不依赖往返 —— 往返对「writer 与 parser 同错」是瞎的。
//   ③ 逐字节突变：产出的任意一个字节被改，parser 必须拒绝。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import {
  packEntries, packDirectory, packArtifact, collectTree, gzipCanonical,
} from '../src/packer.mjs';
import { parseTar, gunzipCanonical, untarGz, TarViolation } from '../src/untar.mjs';
import { treeDigest } from '../src/tree-digest.mjs';
import { makeTree, cleanupTrees, MIN_SKILL, MIN_PACK, makeSkillArtifact, packRecord } from './fixtures/pack-tree.mjs';

after(cleanupTrees);

const e = (path, data, mode = 0o644) => ({ path, mode, data: Buffer.from(data) });

function expectCode(want, fn) {
  try { fn(); } catch (err) {
    const got = err.code ?? err.violation;
    assert.equal(got, want, `期望 ${want}，实际 ${got}：${err.message}`);
    return err;
  }
  assert.fail(`期望 ${want}，但没有抛错`);
}
function expectViolation(want, fn) {
  try { fn(); } catch (err) {
    assert.ok(err instanceof TarViolation, `期望 TarViolation，得到 ${err.name}: ${err.message}`);
    assert.equal(err.violation, want, `期望违规 ${want}，实际 ${err.violation}：${err.message}`);
    return err;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

// ── ① 往返属性 ─────────────────────────────────────────────────────────────

test('往返：packEntries 的产出必须能被 parseTar / gunzipCanonical 无条件解回来', () => {
  const input = [
    e('SKILL.md', '# hi\n'),
    e('bin/run.sh', '#!/bin/sh\necho\n', 0o755),
    e('a/b/c/d/e/f/g/h/i/j/k.md', 'deep'),
    e('zzz.txt', ''),                       // 零字节文件
    e('bin.md', 'x'),                       // 与目录 bin/ 同前缀但不同名
  ];
  const r = packEntries(input);
  const back = untarGz(r.bytes);
  assert.deepEqual(back.entries.map(x => x.path).sort(), input.map(x => x.path).sort());
  for (const x of back.entries) {
    const want = input.find(i => i.path === x.path);
    assert.equal(x.mode, want.mode);
    assert.ok(x.data.equals(want.data));
  }
  assert.equal(r.sha256, 'sha256:' + createHash('sha256').update(r.bytes).digest('hex'));
  assert.equal(r.size, r.bytes.length);
});

test('往返属性（生成式）：随机合法输入，packer 接受 ⟺ parser 接受产出', () => {
  // 判据是**双向蕴含**，不是「喂几个合法样例」：
  //   · packer 成功 → parseTar 必须成功（自反解已保证，这里再独立验一次）
  //   · packer 失败 → 不该有产出（拿不到字节，天然成立）
  const alphabet = 'abABzZ09._-';
  const rnd = (n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  let accepted = 0, rejected = 0;
  for (let iter = 0; iter < 400; iter++) {
    const n = 1 + Math.floor(Math.random() * 6);
    const entries = [];
    for (let i = 0; i < n; i++) {
      const depth = 1 + Math.floor(Math.random() * 3);
      const path = Array.from({ length: depth }, () => rnd(1 + Math.floor(Math.random() * 6))).join('/');
      entries.push(e(path, rnd(Math.floor(Math.random() * 40)), Math.random() < 0.2 ? 0o755 : 0o644));
    }
    let out = null;
    try { out = packEntries(entries); } catch { rejected++; continue; }
    accepted++;
    // 🔴 无条件成功 —— 任何一次抛错都是「写出自己读不回来的东西」
    const back = untarGz(out.bytes);
    assert.equal(back.entries.length, new Set(entries.map(x => x.path)).size);
  }
  assert.ok(accepted > 50, `合法样例太少（${accepted}），这条测试没有覆盖到正路`);
  assert.ok(rejected > 0, `一个都没被拒（${rejected}），随机输入没有触到边界`);
});

// 🔴 这一组是**存在性证明**：writeCanonicalTar 的接受集合确实比 parseTar 大。
//    packer 的自反解是唯一挡住它们的东西。任何一条变绿（= 被接受）都说明保护没了。
test('writer 比 parser 宽的那几处，packer 必须替我们挡住', () => {
  // 大小写折叠后同名的目录
  expectViolation('E_CASE_COLLIDE', () => packEntries([e('A/x.md', '1'), e('a/y.md', '2')]));
  // 同一个名字既是文件又是目录
  expectViolation('E_PATH_FILE_DIR_COLLIDE', () => packEntries([e('a', '1'), e('a/b.md', '2')]));
  // 大小写折叠后同名的文件
  expectViolation('E_CASE_COLLIDE', () => packEntries([e('X.md', '1'), e('x.md', '2')]));
});

test('writeCanonicalTar 单独用确实会写出 parseTar 读不回来的归档（证明上一条不是空转）', async () => {
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const tar = writeCanonicalTar([e('A/x.md', '1'), e('a/y.md', '2')]);
  // 写入端**成功了** —— 这就是 R-11 说的「读侧与写侧接受集合不对称」
  assert.ok(tar.length > 0);
  expectViolation('E_CASE_COLLIDE', () => parseTar(tar));
});

// ── 输入校验 ───────────────────────────────────────────────────────────────

test('路径 grammar 的每一项都报出具体违规码', () => {
  expectViolation('E_PATH_DOTDOT', () => packEntries([e('../escape.md', 'x')]));
  expectViolation('E_PATH_ABS', () => packEntries([e('/abs.md', 'x')]));
  expectViolation('E_PATH_CHARSET', () => packEntries([e('中文.md', 'x')]));
  expectViolation('E_PATH_LEADING', () => packEntries([e('.hidden', 'x')]));
  expectViolation('E_PATH_RESERVED', () => packEntries([e('CON.md', 'x')]));
  // ERRATA E-6：AppleDouble 要有专门的码 + 处方，不能笼统报「segment 以 . 开头」
  const err = expectViolation('E_APPLEDOUBLE', () => packEntries([e('._SKILL.md', 'x')]));
  assert.match(err.message, /COPYFILE_DISABLE=1/);
});

test('mode 白名单：0600 / 04755 都拒', () => {
  expectCode('E_PACK_MODE', () => packEntries([e('a.md', 'x', 0o600)]));
  expectCode('E_PACK_MODE', () => packEntries([e('a.md', 'x', 0o4755)]));
});

test('空载荷拒绝', () => {
  expectCode('E_PACK_EMPTY', () => packEntries([]));
});

test('单文件超过 2 MiB 拒绝', () => {
  expectCode('E_PACK_FILE_SIZE', () => packEntries([e('big.md', Buffer.alloc(2 * 1024 * 1024 + 1))]));
});

// ── ② 独立 golden 字节向量（不依赖往返） ───────────────────────────────────

test('golden：单文件归档的 tar 字节逐字段固定', () => {
  const r = packEntries([e('SKILL.md', 'hi\n')]);
  const h = r.tar.subarray(0, 512);
  assert.equal(r.tar.length, 512 * 4, 'header + 1 数据块 + 2 个零块');
  assert.equal(h.subarray(0, 8).toString('latin1'), 'SKILL.md');
  assert.equal(h.subarray(100, 108).toString('latin1'), '0000644\0', 'mode');
  assert.equal(h.subarray(108, 116).toString('latin1'), '0000000\0', 'uid');
  assert.equal(h.subarray(116, 124).toString('latin1'), '0000000\0', 'gid');
  assert.equal(h.subarray(124, 136).toString('latin1'), '00000000003\0', 'size = 3');
  assert.equal(h.subarray(136, 148).toString('latin1'), '00000000000\0', 'mtime = 0');
  assert.equal(h[156], 0x30, 'typeflag ASCII 0');
  assert.equal(h.subarray(257, 265).toString('latin1'), 'ustar\x0000');
  // 🔴 ERRATA E-3 的具体形态：devmajor/devminor 必须是八进制零，**不是全 NUL**
  assert.equal(h.subarray(329, 337).toString('latin1'), '0000000\0', 'devmajor');
  assert.equal(h.subarray(337, 345).toString('latin1'), '0000000\0', 'devminor');
  assert.ok(h.subarray(265, 297).every(b => b === 0), 'uname 全零');
  assert.ok(h.subarray(297, 329).every(b => b === 0), 'gname 全零');
  // 🔴 ERRATA E-5：尾部**恰好**两个零块
  assert.ok(r.tar.subarray(512 + 3).every(b => b === 0), '数据填充 + 恰好两个零块，之后什么都没有');
});

test('golden：gzip 封套逐字节固定（E-5/E-6 的 canonical 形式）', () => {
  const gz = gzipCanonical(Buffer.from('hello'));
  assert.deepEqual([...gz.subarray(0, 10)], [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);
  assert.equal(gz.readUInt32LE(gz.length - 4), 5, 'ISIZE');
  assert.ok(gunzipCanonical(gz).equals(Buffer.from('hello')));
});

test('golden：同一份内容的 sha256 稳定（asset.sha256 就是身份）', () => {
  const a = packEntries([e('SKILL.md', 'hi\n'), e('skill.json', '{}\n')]);
  const b = packEntries([e('skill.json', '{}\n'), e('SKILL.md', 'hi\n')]); // 顺序不同
  assert.equal(a.sha256, b.sha256, '编码必须唯一：输入顺序不得影响字节');
  assert.ok(a.tar.equals(b.tar));
});

// ── ③ 逐字节突变 ───────────────────────────────────────────────────────────

test('突变：tar 的任意一个字节被改，parseTar 都必须拒绝（或解出不同内容）', () => {
  const r = packEntries([e('SKILL.md', 'hi\n')]);
  let survived = [];
  for (let i = 0; i < r.tar.length; i++) {
    const m = Buffer.from(r.tar);
    m[i] = m[i] ^ 0xff;
    let ok = false;
    try {
      const out = parseTar(m);
      // 没抛错也可以接受，只要解出来的东西**不等于**原件（说明改动没被静默吞掉）
      ok = out.entries.length === 1
        && out.entries[0].path === 'SKILL.md'
        && out.entries[0].data.equals(Buffer.from('hi\n'))
        && out.entries[0].mode === 0o644;
    } catch { ok = false; }
    if (ok) survived.push(i);
  }
  assert.deepEqual(survived, [], `这些字节改了之后仍然解出完全相同的制品：${survived.join(',')}`);
});

test('突变：gzip 的任意一个字节被改，gunzipCanonical 都必须拒绝或解出不同字节', () => {
  const r = packEntries([e('SKILL.md', 'hi\n')]);
  const survived = [];
  for (let i = 0; i < r.bytes.length; i++) {
    const m = Buffer.from(r.bytes);
    m[i] = m[i] ^ 0xff;
    let ok = false;
    try { ok = gunzipCanonical(m).equals(r.tar); } catch { ok = false; }
    if (ok) survived.push(i);
  }
  assert.deepEqual(survived, [], `这些字节改了之后仍然解出完全相同的 tar：${survived.join(',')}`);
});

// ── 目录树 ─────────────────────────────────────────────────────────────────

test('packDirectory：tree_digest 等于把归档解出来之后重算的值', () => {
  const root = makeTree({ ...MIN_SKILL, 'refs/a.md': 'A', 'bin/x.sh': { data: '#!/bin/sh\n', mode: 0o755 } });
  const r = packDirectory(root);
  assert.equal(r.tree_digest, treeDigest(root), '源树与归档树必须是同一棵');
  assert.match(r.tree_digest, /^geoly-tree-v1:sha256:[0-9a-f]{64}$/);
  // 独立复算：把归档解出来
  const back = untarGz(r.bytes);
  assert.deepEqual(back.entries.map(x => x.path).sort(), ['SKILL.md', 'bin/x.sh', 'refs/a.md', 'skill.json']);
});

test('collectTree 拒绝 symlink / 空目录 / hardlink / 根是 symlink', () => {
  expectCode('E_PACK_SYMLINK', () => collectTree(makeTree(MIN_SKILL, { links: { 'evil.md': '/etc/passwd' } })));
  expectCode('E_PACK_EMPTY_DIR', () => collectTree(makeTree(MIN_SKILL, { dirs: ['empty'] })));
  // 只含空目录的目录同样是空的
  expectCode('E_PACK_EMPTY_DIR', () => collectTree(makeTree(MIN_SKILL, { dirs: ['outer/inner'] })));
  const root = makeTree(MIN_SKILL);
  linkSync(join(root, 'SKILL.md'), join(root, 'hard.md'));
  expectCode('E_PACK_HARDLINK', () => collectTree(root));
  const holder = makeTree(MIN_SKILL);
  const linked = makeTree({}, { links: { 'toroot': holder } });
  expectCode('E_PACK_SYMLINK', () => collectTree(join(linked, 'toroot')));
});

test('collectTree 拒绝非 0644/0755 的文件 mode', () => {
  const root = makeTree(MIN_SKILL);
  chmodSync(join(root, 'SKILL.md'), 0o600);
  expectCode('E_PACK_MODE', () => collectTree(root));
});

test('packArtifact 强制 manifest（tar 合法不等于制品合法）', () => {
  // 这棵树打成 tar 完全合法，但它不是一个 skill 制品
  const noManifest = makeTree({ 'README.md': 'x' });
  assert.ok(packDirectory(noManifest).bytes.length > 0, 'packDirectory 这一层照样通过 —— 所以那一层不能当制品入口');
  expectCode('E_PACK_MANIFEST_MISSING', () => packArtifact({ root: noManifest, kind: 'skill' }));

  const skill = makeTree(MIN_SKILL);
  assert.equal(packArtifact({ root: skill, kind: 'skill' }).kind, 'skill');
  const pack = makeTree(MIN_PACK);
  assert.equal(packArtifact({ root: pack, kind: 'pack' }).kind, 'pack');
  // 两个 manifest 并存 → 「这是什么制品」有两个答案
  expectCode('E_PACK_MANIFEST_MISSING',
    () => packArtifact({ root: makeTree({ ...MIN_SKILL, ...MIN_PACK }), kind: 'skill' }));
});

test('🔴 setuid/setgid/sticky 位必须被拒绝，不能被 & 0o777 静默抹掉', () => {
  for (const m of [0o4755, 0o2755, 0o1755, 0o4644]) {
    const root = makeTree(MIN_SKILL);
    chmodSync(join(root, 'SKILL.md'), m);
    // macOS 上非 root 设 setgid 可能被内核拒掉；只在真的设上了才断言
    if ((lstatSync(join(root, 'SKILL.md')).mode & 0o7000) === 0) continue;
    const err = expectCode('E_PACK_MODE', () => collectTree(root));
    assert.match(err.message, /setuid\/setgid\/sticky/);
  }
});

test('🔴 packArtifact 给了 record 就跑真正的 §5.3 绑定校验，不只查文件在不在', () => {
  const bogus = makeTree({
    'SKILL.md': '---\nname: demo\ndescription: d\n---\n',
    'skill.json': '{}\n',                    // 存在，但内容是空的
  });
  // 不给 record：只有存在性检查 → 过（底层 API 的声明行为）
  assert.ok(packArtifact({ root: bogus, kind: 'skill' }).bytes.length > 0);
  // 给了 record：走 assertManifestBinding → 必须被拒
  const rec = { ...packRecord(), kind: 'skill', namespace: 'geoly', name: 'demo', version: '0.3.6',
    id: 'skill:geoly/demo@0.3.6', path: 'artifacts/skills/geoly/demo/0.3.6' };
  assert.throws(() => packArtifact({ root: bogus, kind: 'skill', record: rec }),
    (e) => /E_WIRE|E_MANIFEST|E_SCHEMA/.test(e.violation ?? e.code ?? ''),
    '空的 skill.json 必须在打包端就被拒，而不是等到安装端');

  // 正路：fixtures 造的那份是自洽的
  const good = makeSkillArtifact({ name: 'demo' });
  assert.equal(packArtifact({ root: good.root, kind: 'skill', record: good.record }).boundTo,
    'skill:geoly/demo@0.3.6');
});

test('packDirectory 不在源目录留下任何东西，也不返回临时目录', () => {
  const root = makeTree(MIN_SKILL);
  const before = collectTree(root).map(x => x.path);
  packDirectory(root);
  assert.deepEqual(collectTree(root).map(x => x.path), before);
});
