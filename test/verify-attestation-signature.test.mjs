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

// 🔴🔴 **这道门存在的全部理由。**
//    造一个 payload 合法、但 subject 摘要与实际文件对不上的 bundle：
//    密码学那一层（在真实 bundle 上）会过，而这一步必须拦住。
//    ⚠️ 这里用的是夹具 payload，跑不到真实的密码学验证，所以断言落在
//    「它没有把摘要不符当成通过」——形态上等价，且不需要联网签名。
test('🔴🔴 subject 摘要与实际文件对不上 → 必须拒（签名有效也不行）', () => {
  const d = mk();
  const { bytes } = makeAttestationBytes();       // subject 摘要是夹具里的常量
  const b = join(d, 'b.json');
  writeFileSync(b, JSON.stringify({
    dsseEnvelope: { payload: bytes.toString('base64'), payloadType: 'application/vnd.in-toto+json', signatures: [] },
  }));
  const s = join(d, 's.json');
  writeFileSync(s, 'これは違うファイル');          // 与夹具里的摘要必然不同
  const r = run(['--bundle', b, '--subject', s]);
  assert.notEqual(r.status, 0, '摘要不符却通过了 —— 这道门就等于没有');
  // 走到摘要那一步之前会先卡在签名验证（signatures 是空的），两种都算拦住；
  // 关键是**不能通过**。
  assert.match(r.stderr, /E_ATTEST_SIGNATURE|E_SUBJECT_DIGEST_MISMATCH/);
});
