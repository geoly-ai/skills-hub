#!/usr/bin/env node
// 反漂移门：Node 版本清单只能有**一个**源 —— scripts/node-versions.json。
//
// 🔴 为什么需要这道门：CI 与 scripts/test-matrix.sh 是两个消费者。
//    只要有人在 workflow 里手写一次版本号，两份清单就会各走各的，
//    而漂移**不会让任何测试变红** —— 它只会让「22.13 上跑过」变成一句假话
//    （docs/m1/01-residual-risks.md R-5 正是靠这条矩阵在复验）。
//
// ⚠️ 断言本身放在 scripts/ 而不是 workflow 里：写在 workflow 里的 grep 会匹配到
//    它自己那一行，变成一道永远红的假门。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const wfDir = join(root, '.github/workflows');

const versions = JSON.parse(readFileSync(join(root, 'scripts/node-versions.json'), 'utf8'));
const errors = [];

// ── 形状：test-matrix.sh 用 tr 解析，所以必须是扁平字符串数组 ────────────────
if (!Array.isArray(versions) || versions.length === 0) {
  errors.push('node-versions.json 必须是非空数组');
}
for (const v of versions) {
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) {
    errors.push(`node-versions.json 里的 ${JSON.stringify(v)} 不是 x.y.z 形式的字符串`);
  }
}

let files = [];
try {
  files = readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
} catch {
  errors.push(`读不到 ${wfDir}`);
}
if (files.length === 0) errors.push('.github/workflows 下一个 workflow 都没有');

for (const f of files) {
  const text = readFileSync(join(wfDir, f), 'utf8');
  const lines = text.split('\n');

  // ① 任何一个受管版本号都不得作为字面量出现在 workflow 里
  lines.forEach((line, i) => {
    for (const v of versions) {
      if (typeof v === 'string' && line.includes(v)) {
        errors.push(
          `.github/workflows/${f}:${i + 1} 硬编码了受管的 Node 版本 ${v}：` +
            '版本清单只能来自 scripts/node-versions.json（用 fromJSON 喂 strategy.matrix）',
        );
      }
    }
  });

  // ② `node-version:` 只允许表达式或 lts/*，堵住「换个写法绕过 ①」
  lines.forEach((line, i) => {
    const m = /^\s*node-version:\s*(.+?)\s*$/.exec(line);
    if (!m) return;
    const val = m[1].replace(/^['"]|['"]$/g, '');
    const ok = val.startsWith('${{') || val === 'lts/*';
    if (!ok) {
      errors.push(
        `.github/workflows/${f}:${i + 1} 的 node-version 是字面量 ${JSON.stringify(val)}：` +
          '只允许 ${{ … }} 表达式或 lts/*',
      );
    }
  });
}

if (errors.length > 0) {
  console.error('check-node-matrix 失败：\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log(`check-node-matrix ok（受管版本：${versions.join(', ')}；扫了 ${files.length} 个 workflow）`);
