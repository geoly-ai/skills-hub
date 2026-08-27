#!/usr/bin/env node
// 构造 attestation 的 **predicate**（02-registry.md §1.1），并当场自检 ERRATA E-2。
//
// 🔴 E-2：`workflowRef` 里固定的 40 位 SHA **必须等于** `sourceCommit`。
//    不写死这条的话，attestation 可以声称由 A 提交构建、而 workflow 固定在 B 提交 ——
//    签名照样有效，但「这个制品是由哪份 workflow 从哪份源码构建的」就断链了。
//    `src/attestation.mjs` 的 `parseAttestationForForensics()` 已经强制这条；
//    这里在**签之前**就用同一个解析器过一遍，别等取证的时候才发现签错了。
//
// ⚠️ 本脚本只产 predicate。in-toto statement 的外壳（`_type` / `subject` /
//    `predicateType`）由 `cosign attest-blob` 按 `--type` 与被签文件生成。
//
// 用法：
//   node scripts/release/build-attestation.mjs \
//     --snapshot registry/snapshots/hub-42.json \
//     --source-commit <40 位 sha> [--promotion-pr <n>] --out predicate.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  BUILD_TYPE, DSSE_PAYLOAD_TYPE, PREDICATE_TYPE, STATEMENT_TYPE,
  parseAttestationForForensics,
} from '../../src/attestation.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (dflt !== undefined) return dflt;
    console.error(`缺参数 --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const snapshotPath = arg('snapshot');
const sourceCommit = arg('source-commit');
const promotionPr = Number(arg('promotion-pr', '0'));
const outPath = arg('out', 'predicate.json');

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  console.error(`--source-commit 必须是 40 位小写 hex，得到 ${JSON.stringify(sourceCommit)}`);
  process.exit(2);
}

const snapshotBytes = readFileSync(snapshotPath);
const snapshotSha = createHash('sha256').update(snapshotBytes).digest('hex');

const predicate = {
  buildType: BUILD_TYPE,
  sourceRepo: 'geoly-ai/skills-hub',
  sourceCommit,
  // 🔴 E-2 就落在这一行：钉的 sha 与 sourceCommit 用**同一个变量**。
  //    绝不写 `@refs/heads/main` —— 分支引用本身可变，写它等于没写。
  workflowRef: `.github/workflows/release.yml@${sourceCommit}`,
  promotionPr,
};

// ── 自检：拿真解析器过一遍完整 envelope 的形状 ─────────────────────────
// 这里造的是一个**签名占位**的 envelope，只为把 shape 送进 parseAttestationForForensics。
// 它检的是 statement / predicate 的形状与 E-2 的绑定，不检密码学签名
// （真签名由 cosign 出，验签是另一条路）。
const statement = {
  _type: STATEMENT_TYPE,
  subject: [{ name: basename(snapshotPath), digest: { sha256: snapshotSha } }],
  predicateType: PREDICATE_TYPE,
  predicate,
};
const envelope = {
  payloadType: DSSE_PAYLOAD_TYPE,
  payload: Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
  signatures: [{ sig: Buffer.from('placeholder').toString('base64') }],
};

try {
  parseAttestationForForensics(Buffer.from(JSON.stringify(envelope), 'utf8'));
} catch (e) {
  console.error(`✖ attestation 形状自检失败（${e?.code ?? 'E_UNKNOWN'}）：${e?.message ?? e}`);
  process.exit(1);
}

if (!Number.isInteger(promotionPr) || promotionPr <= 0) {
  console.error(
    `⚠️ promotionPr = ${promotionPr}。02-registry.md §1.1 把它当作取证线索，` +
      '填 0 的 attestation 在取证时指不到任何 PR —— 发布流程接上 promotion PR 之后要把真值传进来。',
  );
}

writeFileSync(outPath, JSON.stringify(predicate, null, 2) + '\n');
console.log(`✔ predicate 写到 ${outPath}`);
console.log(`  subject      ${basename(snapshotPath)} sha256:${snapshotSha}`);
console.log(`  sourceCommit ${sourceCommit}`);
console.log(`  workflowRef  ${predicate.workflowRef}`);
console.log('  E-2 绑定自检通过（workflowRef 钉的 sha === sourceCommit）');
