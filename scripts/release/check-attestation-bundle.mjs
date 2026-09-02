#!/usr/bin/env node
// 解析 **cosign 真正写出来的那份** attestation bundle，用 src/attestation.mjs
// 的 `parseAttestationForForensics()` 过一遍 02-registry.md §1.1 的契约。
//
// 🔴 为什么 build-attestation.mjs 的自检不够：
//    那一步检的是**我们自己拼出来的占位 envelope**。它能证明
//    「我们打算签的东西形状对」，证明不了「cosign 最后落盘的东西形状也对」。
//    中间隔着 cosign 对 predicate 的包装 —— 它加什么、改什么，我们说了不算。
//    判据必须落在**最终产物**上。（同 ERRATA E-6 的教训：
//    工具列出来的内容不等于文件里的字节。）
//
// 用法：
//   node scripts/release/check-attestation-bundle.mjs --bundle attestation.sigstore.json \
//     [--expect-source-commit <40 位 sha>]
import { readFileSync } from 'node:fs';
import { parseAttestationForForensics } from '../../src/attestation.mjs';
import { dsseEnvelopeOf } from './dsse-envelope.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (dflt !== undefined) return dflt;
    console.error(`缺参数 --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const bundlePath = arg('bundle');
const expectSourceCommit = arg('expect-source-commit', null);

const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

// Sigstore bundle 里 DSSE envelope 在 `dsseEnvelope`；protobuf JSON 把
// payload/sig 编成 base64 字符串，与 DSSE 的 wire 形式一致。
const dsse = bundle?.dsseEnvelope;
if (!dsse) {
  console.error(
    `✖ ${bundlePath} 里没有 dsseEnvelope。attestation 必须是 DSSE（§1.1 的封装契约）；` +
      '拿到的是 ' + JSON.stringify(Object.keys(bundle ?? {})),
  );
  process.exit(1);
}

// 投影逻辑与 verify-attestation-signature.mjs 共用一份 —— 见 dsse-envelope.mjs
const envelope = dsseEnvelopeOf(bundle);

let parsed;
try {
  parsed = parseAttestationForForensics(Buffer.from(JSON.stringify(envelope), 'utf8'));
} catch (e) {
  console.error(`✖ 最终 envelope 不满足 §1.1 契约（${e?.violation ?? e?.code ?? 'E_UNKNOWN'}）：${e?.message ?? e}`);
  process.exit(1);
}

// 🔴 E-2 的第二半：parseAttestationForForensics 已经强制
//    「workflowRef 钉的 sha === sourceCommit」，但它不知道**这一次构建**
//    的 commit 是哪个。把它与 GITHUB_SHA 对上，才算把 attestation 绑在
//    真实的这一次流水线上，而不只是内部自洽。
if (expectSourceCommit && parsed.predicate.sourceCommit !== expectSourceCommit) {
  console.error(
    `✖ sourceCommit 是 ${parsed.predicate.sourceCommit}，但本次构建的 commit 是 ${expectSourceCommit}。\n` +
      '内部自洽（workflowRef === sourceCommit）不等于绑对了 commit。',
  );
  process.exit(1);
}

console.log('✔ 最终 attestation envelope 通过 §1.1 契约与 E-2 绑定');
console.log(`  subject      ${parsed.subject.name} sha256:${parsed.subject.digest.sha256}`);
console.log(`  sourceCommit ${parsed.predicate.sourceCommit}`);
console.log(`  workflowRef  ${parsed.predicate.workflowRef}`);
