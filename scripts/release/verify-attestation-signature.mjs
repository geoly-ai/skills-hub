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
import { createHash } from 'node:crypto';
import { Verifier, toSignedEntity } from '@sigstore/verify';
import { bundleFromJSON } from '@sigstore/bundle';
import { loadBuiltinTrustedRoot, trustMaterialFrom } from '../../src/sigstore.mjs';
import { OIDC_ISSUER, RELEASE_IDENTITY } from '../../src/snapshot.mjs';
import { parseAttestationForForensics } from '../../src/attestation.mjs';

const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

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
const att = parseAttestationForForensics(
  Buffer.from(bundleJson.dsseEnvelope.payload, 'base64'),
  expectCommit ? { expectSourceCommit: expectCommit } : {},
);
const declared = att.subject?.digest?.sha256;
if (declared !== subjectSha) {
  die(`[E_SUBJECT_DIGEST_MISMATCH] attestation 说的 subject 摘要是 ${declared}，\n`
    + `  但 ${subjectPath} 的实际摘要是 ${subjectSha}。\n`
    + '  🔴 签名有效**不代表**它说的是这个文件 —— DSSE 的签名只覆盖 envelope 自己。');
}

console.error('✔ attestation 密码学自验通过');
console.error(`  身份     ${identity}`);
console.error(`  subject  ${att.subject?.name} sha256:${subjectSha.slice(0, 16)}…`);
console.error(`  ✅ 摘要与 ${subjectPath} 的实际内容一致 —— 签名与文件真的绑上了`);
