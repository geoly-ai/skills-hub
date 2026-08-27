#!/usr/bin/env node
// 签名身份门 —— 把 02-registry.md §8 的两个身份**钉成字面量**，并核对
// 它们指向的 workflow 文件真的存在、真的是**两个不同的文件**。
//
// 🔴 为什么必须有这一道：
//    `src/snapshot.mjs` 导出 RELEASE_IDENTITY / TIMESTAMP_IDENTITY，
//    而 `test/snapshot.test.mjs` 与 `scripts/release/verify-own-bundle.mjs`
//    **都是从那里导入常量**的。于是常量本身写错时：
//      · 单元测试仍然全绿（它们比的是「两个常量互不相等」，不是「常量等于规范值」）；
//      · 发布流水线的自验也仍然通过（签的和验的用的是同一个错值）。
//    一整套「验证」会在一个错误的身份上自洽 —— 这正是自证的教科书形状。
//    要打破它，判据必须是**规范正文里的那串字面量**，写在别处、独立比对。
//
// ⚠️ 所以下面这三个字符串**不许改成从 src 导入**。它们是这道门的全部意义。
//    改身份是一次规范变更（要改 02-registry.md §8、要重发所有签名对象），
//    不是改一行常量。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OIDC_ISSUER, RELEASE_IDENTITY, TIMESTAMP_IDENTITY } from '../src/snapshot.mjs';

const root = new URL('..', import.meta.url).pathname;

// ── 02-registry.md §8 逐字复制 ──────────────────────────────────────────
const SPEC = {
  issuer: 'https://token.actions.githubusercontent.com',
  release: 'https://github.com/geoly-ai/skills-hub/.github/workflows/release.yml@refs/heads/main',
  timestamp: 'https://github.com/geoly-ai/skills-hub/.github/workflows/timestamp.yml@refs/heads/main',
};

const errors = [];

if (OIDC_ISSUER !== SPEC.issuer) {
  errors.push(`OIDC_ISSUER 与 §8 不符：\n      得到 ${OIDC_ISSUER}\n      期望 ${SPEC.issuer}`);
}
if (RELEASE_IDENTITY !== SPEC.release) {
  errors.push(`RELEASE_IDENTITY 与 §8 不符：\n      得到 ${RELEASE_IDENTITY}\n      期望 ${SPEC.release}`);
}
if (TIMESTAMP_IDENTITY !== SPEC.timestamp) {
  errors.push(`TIMESTAMP_IDENTITY 与 §8 不符：\n      得到 ${TIMESTAMP_IDENTITY}\n      期望 ${SPEC.timestamp}`);
}

// 🔴 两个身份不可互换 —— 最基本的前提是它们真的不是同一个。
if (RELEASE_IDENTITY === TIMESTAMP_IDENTITY) {
  errors.push('RELEASE_IDENTITY 与 TIMESTAMP_IDENTITY 相同：两个身份必须可区分（§8）');
}

// ── 身份里写的 workflow 文件必须真的存在，而且是两个不同的文件 ──────────
//
// keyless 证书的 SAN 里带的就是 **workflow 文件路径**。
// 把 timestamp 的 job 并进 release.yml「省一个文件」，签出来的 timestamp
// 会带上 release.yml 的身份 —— CLI 会（正确地）拒绝它，而症状看起来像验签器有 bug。
// 所以「两个文件」这件事要机械地守住，不能靠人记得。
const paths = {};
for (const [role, identity] of [['release', RELEASE_IDENTITY], ['timestamp', TIMESTAMP_IDENTITY]]) {
  const m = /\/(\.github\/workflows\/[^@]+)@/.exec(identity);
  if (!m) {
    errors.push(`${role} 身份里解析不出 workflow 路径：${identity}`);
    continue;
  }
  paths[role] = m[1];
  if (!existsSync(join(root, m[1]))) {
    errors.push(
      `${role} 身份指向 ${m[1]}，但仓库里没有这个文件 —— ` +
        '身份是靠文件路径成立的，文件不在就永远签不出这个身份',
    );
  }
}
if (paths.release && paths.release === paths.timestamp) {
  errors.push(
    `两个身份指向同一个 workflow 文件（${paths.release}）：` +
      '🔴 §8 要求 timestamp 单独身份、单独最小权限。合并即等于让一个身份同时拥有两种权力',
  );
}

// ── workflow 内部也要各自守住 ref ────────────────────────────────────────
// 身份里钉的是 @refs/heads/main。从 tag 或别的分支触发，SAN 就变了。
for (const [role, p] of Object.entries(paths)) {
  if (!p || !existsSync(join(root, p))) continue;
  const text = readFileSync(join(root, p), 'utf8');
  if (!text.includes('refs/heads/main')) {
    errors.push(
      `${p} 里没有对 refs/heads/main 的断言：` +
        '从别的 ref 触发会签出不同的 SAN，而那种失败在事后看起来像验签器坏了',
    );
  }
}

if (errors.length > 0) {
  console.error('check-signing-identities 失败：\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('check-signing-identities ok');
console.log(`  release   ${RELEASE_IDENTITY}`);
console.log(`  timestamp ${TIMESTAMP_IDENTITY}`);
console.log(`  issuer    ${OIDC_ISSUER}`);
