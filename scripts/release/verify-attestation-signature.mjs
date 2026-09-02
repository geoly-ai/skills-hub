#!/usr/bin/env node
// attestation 的**密码学**自验 —— 与语义解析（check-attestation-bundle.mjs）分开。
//
//   node scripts/release/verify-attestation-signature.mjs \
//     --bundle attestation.sigstore.json --subject registry/snapshots/hub-1.json
//
// ══════════════════════════════════════════════════════════════════════════
// 🔴 **为什么需要这一份，而不是复用安装路径的验签器**
//
// `src/sigstore.mjs` 显式**拒绝** `dsseEnvelope`，只收 `messageSignature`，
// 理由写在那里：messageSignature 的签名是对**我们传进去的字节**验的，
// 签名与手上的字节真的绑定；而 DSSE 的签名是对 envelope 自己的 PAE 验的，
// **跟我们手上的文件一点关系都没有**。
//
// 那条设计对安装路径是对的，不能改。但后果是：attestation 恰恰是 DSSE 形态，
// 于是**我们自己发出去的 attestation，自己的工具从来没验过它的签名** ——
// 之前只做了语义解析（Codex 2026-09-02 指出）。对一个立论是「我们的工具能验
// 我们签的东西」的项目，这是个说不过去的缺口。
//
// 🔴 **这份脚本最容易做错的地方，正是上面那句话**：
//    「DSSE 签名验过了」**不等于**「它说的是我手上这个文件」。
//    拿一个身份正确、签名有效的 DSSE bundle 配任意快照，密码学那一层照样过。
//    所以第 ④ 步（subject digest ↔ 真实文件摘要）不是锦上添花，
//    **它才是把签名和文件绑起来的那一步**。少了它，这道门等于没有。
//
// ⚠️ 放在 `scripts/release/` 而不是 `src/`：`package.json` 的 `files` 只有
//    `["bin","src"]`，所以这份代码**不进发布包**，也就不可能被安装路径误用。
// ══════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Verifier, toSignedEntity } from '@sigstore/verify';
import { bundleFromJSON } from '@sigstore/bundle';
import { loadBuiltinTrustedRoot, trustMaterialFrom } from '../../src/sigstore.mjs';
import { OIDC_ISSUER, RELEASE_IDENTITY } from '../../src/snapshot.mjs';
import { parseAttestationForForensics } from '../../src/attestation.mjs';
import { dsseEnvelopeOf } from './dsse-envelope.mjs';

const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

/**
 * 🔴 **第 ④ 步：把签名与「我手上这个文件」绑起来。**
 *
 * 抽成独立导出的纯函数，是为了让它**能被单测直接打到**：
 * ⚠️ 2026-09-02 我第一版把它写在主流程里，测试要走到这里得先过密码学验证，
 *    于是那条「最要紧的测试」实际上卡在签名验证就返回了 ——
 *    断言写成 `E_ATTEST_SIGNATURE|E_SUBJECT_DIGEST_MISMATCH`，两者都算过，
 *    **第 ④ 步一次都没被执行过**。测试是绿的，而它想守的那件事没被守住。
 *
 * @param {object} a
 * @param {object} a.bundleJson
 * @param {string} a.subjectSha    真实文件的 sha256（hex）
 * @param {string} a.subjectPath   仅用于报错信息
 * @param {string} [a.expectCommit]
 */
export function assertSubjectBinding({ bundleJson, subjectSha, subjectPath, expectCommit }) {
  // ⚠️ `parseAttestationForForensics` 收的是 **DSSE envelope**，不是解出来的
  //    statement。第一版传了 base64 解开的 payload，于是它拿 statement 当
  //    envelope 解，报 `未知字段 _type`。
  const att = parseAttestationForForensics(
    Buffer.from(JSON.stringify(dsseEnvelopeOf(bundleJson)), 'utf8'),
    expectCommit ? { expectSourceCommit: expectCommit } : {},
  );
  const declared = att.subject?.digest?.sha256;
  if (declared !== subjectSha) {
    const err = new Error(
      `attestation 说的 subject 摘要是 ${declared}，但 ${subjectPath} 的实际摘要是 ${subjectSha}。`
      + ' 🔴 签名有效**不代表**它说的是这个文件 —— DSSE 的签名只覆盖 envelope 自己。');
    err.violation = 'E_SUBJECT_DIGEST_MISMATCH';
    throw err;
  }
  return att;
}

// ⚠️ CLI 逻辑必须包在 main() 里、且只在**直接执行**时跑 ——
//    否则测试一 import 这个模块就会因为缺参数 process.exit(1)，
//    上面那个 assertSubjectBinding 根本没法被单测打到。
function main() {
  const bundlePath = arg('bundle');
  const subjectPath = arg('subject');
  const expectCommit = arg('expect-source-commit');
  if (!bundlePath || !subjectPath) die('用法：--bundle <file> --subject <file> [--expect-source-commit <sha>]');
  
  const bundleRaw = readFileSync(bundlePath, 'utf8');
  const subjectBytes = readFileSync(subjectPath);
  const subjectSha = createHash('sha256').update(subjectBytes).digest('hex');
  
  // ── ① 必须**是** DSSE —— 与安装路径正好相反的断言 ────────────────────────
  //    写成显式断言而不是「碰巧走到 DSSE 分支」：形态不对要立刻说清楚。
  let bundleJson;
  try { bundleJson = JSON.parse(bundleRaw); } catch (e) { die(`bundle 不是合法 JSON：${e.message}`); }
  const kind = bundleJson?.dsseEnvelope ? 'dsseEnvelope'
    : bundleJson?.messageSignature ? 'messageSignature' : '(缺失)';
  if (kind !== 'dsseEnvelope') {
    die(`[E_NOT_DSSE] attestation bundle 必须是 dsseEnvelope，实际是 ${kind}。\n`
      + '  🔴 若它变成了 messageSignature，说明签发命令被改成了 sign-blob ——\n'
      + '     那签的是 blob 原始字节，产出的不是 in-toto attestation。');
  }
  
  // ── ② 密码学验证（库负责，身份归我们判 —— 与 src/sigstore.mjs 同一分工） ──
  const verifier = new Verifier(trustMaterialFrom(loadBuiltinTrustedRoot()), {
    tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1,
  });
  let signer;
  try {
    signer = verifier.verify(toSignedEntity(bundleFromJSON(bundleJson)), undefined);
  } catch (e) {
    die(`[E_ATTEST_SIGNATURE] attestation 的签名验不过：${e.message}`);
  }
  
  // ── ③ 身份必须是 **release**（不是 timestamp，两个身份不可互换） ──────────
  const identity = signer?.identity?.subjectAlternativeName;
  const issuer = signer?.identity?.extensions?.issuer;
  if (identity !== RELEASE_IDENTITY) {
    die(`[E_IDENTITY_MISMATCH] 签名身份是 ${JSON.stringify(identity)}，`
      + `期望 ${JSON.stringify(RELEASE_IDENTITY)}（精确比对）`);
  }
  if (issuer !== OIDC_ISSUER) {
    die(`[E_ISSUER_MISMATCH] issuer 是 ${JSON.stringify(issuer)}，期望 ${JSON.stringify(OIDC_ISSUER)}`);
  }
  
  // ── ④ 🔴 把签名与**我手上这个文件**绑起来 ─────────────────────────────────
  //    这一步库不做，而它是这道门存在的全部理由。见文件头的长注释。
  // ⚠️ `parseAttestationForForensics` 收的是 **DSSE envelope**，不是解出来的
  //    statement。2026-09-02 我第一版把 base64 解开的 payload 传了进去，
  //    于是它拿 statement 当 envelope 解，报 `未知字段 _type`。
  //    投影逻辑与 check-attestation-bundle.mjs 共用一份（见 dsseEnvelopeOf），
  //    两份各写一遍就是分叉的种子。
  let att;
  try {
    att = assertSubjectBinding({ bundleJson, subjectSha, subjectPath, expectCommit });
  } catch (e) {
    die(`[${e.violation ?? 'E_UNKNOWN'}] ${e.message}`);
  }
  
  console.error('✔ attestation 密码学自验通过');
  console.error(`  身份     ${identity}`);
  console.error(`  subject  ${att.subject?.name} sha256:${subjectSha.slice(0, 16)}…`);
  console.error(`  ✅ 摘要与 ${subjectPath} 的实际内容一致 —— 签名与文件真的绑上了`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
