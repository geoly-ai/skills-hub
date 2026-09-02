// 🔴 这道门的**全部理由**是：DSSE 的签名只覆盖 envelope 自己，
//    「签名验过了」不等于「它说的是我手上这个文件」。
//    所以下面最要紧的一条是「摘要对不上必须拒」——少了它这道门等于没有。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAttestationBytes } from './fixtures/trustchain-objects.mjs';
import { assertSubjectBinding } from '../scripts/release/verify-attestation-signature.mjs';

/** 夹具给的是 envelope 的 JSON 字节；这里还原成 bundle 里 dsseEnvelope 的形状。 */
const envelopeFrom = (bytes) => JSON.parse(bytes.toString('utf8'));

const R = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SCRIPT = join(R, 'scripts/release/verify-attestation-signature.mjs');
const roots = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'att-')); roots.push(d); return d; };
process.on('exit', () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } } });

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('🔴 用法错误要说清楚，不能默默成功', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /用法/);
});

// 🔴 与安装路径**正好相反**的断言：这里必须**是** DSSE。
//    若签发命令被改成 sign-blob，产出的就是 messageSignature —— 那不是 attestation。
test('🔴 bundle 不是 dsseEnvelope（比如被改成 sign-blob 的产物）→ 拒', () => {
  const d = mk();
  const b = join(d, 'b.json');
  writeFileSync(b, JSON.stringify({ messageSignature: { signature: 'x' } }));
  writeFileSync(join(d, 's.json'), '{}');
  const r = run(['--bundle', b, '--subject', join(d, 's.json')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_NOT_DSSE/);
});

test('bundle 不是合法 JSON → 拒', () => {
  const d = mk();
  const b = join(d, 'b.json');
  writeFileSync(b, '{ 不是 json');
  writeFileSync(join(d, 's.json'), '{}');
  const r = run(['--bundle', b, '--subject', join(d, 's.json')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不是合法 JSON/);
});

// 🔴🔴 **这道门存在的全部理由 —— 第 ④ 步：签名 ≠ 它说的是这个文件。**
//
// ⚠️ 我的第一版测试**从没跑到这一步**：那时 ④ 写在主流程里，要先过密码学
//    验证才走得到，于是断言写成 `E_ATTEST_SIGNATURE|E_SUBJECT_DIGEST_MISMATCH`
//    —— 它每次都停在签名那一关，两者都算过，测试是绿的，而这一步一次都没执行。
//    「看起来被守住了」的又一个形状。现在 ④ 抽成纯函数，直接打它。
test('🔴🔴 subject 摘要与实际文件对不上 → 必须拒（签名再有效也不行）', () => {
  const { bytes } = makeAttestationBytes();
  const bundleJson = { dsseEnvelope: envelopeFrom(bytes) };
  assert.throws(
    () => assertSubjectBinding({
      bundleJson,
      subjectSha: 'f'.repeat(64),        // 与夹具里的摘要必然不同
      subjectPath: '/tmp/whatever.json',
    }),
    (e) => e.violation === 'E_SUBJECT_DIGEST_MISMATCH',
    '摘要不符却通过了 —— 这道门就等于没有',
  );
});

test('subject 摘要对得上 → 放行', () => {
  const { bytes } = makeAttestationBytes();
  const stmt = JSON.parse(Buffer.from(JSON.parse(bytes.toString('utf8')).payload, 'base64').toString('utf8'));
  const real = stmt.subject[0].digest.sha256;
  const att = assertSubjectBinding({
    bundleJson: { dsseEnvelope: envelopeFrom(bytes) },
    subjectSha: real,
    subjectPath: '/tmp/x.json',
  });
  assert.equal(att.subject.digest.sha256, real);
});
