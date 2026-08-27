#!/usr/bin/env node
// 打包内容门：核对 `npm pack` **实际**会打进去什么。
//
// 🔴 这道门存在的理由是一条具体的失效：`src/trust-roots/sigstore-public-good.json`
//    是内置 TUF 根（02-registry.md §8.1）。它一旦漏出包外，
//    `loadBuiltinTrustedRoot()` 在用户机器上会直接抛错 —— 验签器没根可用。
//    而 package.json 的 `files` 只是**声明**：真正决定字节的是 npm 自己的
//    files/ignore 合成结果。所以判据必须是 `npm pack` 的真实清单，不是读 package.json。
//    （同 ERRATA E-6 的教训：工具列出来的内容不等于文件里的字节。）
import { spawnSync } from 'node:child_process';

/** 必须在包里的路径（精确匹配）。 */
const REQUIRED = [
  'package.json',
  'bin/skills-hub.mjs',
  'src/sigstore.mjs',
  'src/trust-roots/sigstore-public-good.json',
];

/** 必须**不**在包里的路径前缀 —— 测试与规格文档不该分发给用户。 */
const FORBIDDEN_PREFIXES = ['test/', 'docs/', '.github/', 'scripts/', 'node_modules/'];

/** 必须不在包里的具体文件（凭据/本地状态类，出现即视为泄漏）。 */
const FORBIDDEN_EXACT = ['.npmrc', '.env', 'package-lock.json'];

const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`npm pack --dry-run 失败（exit ${r.status}）：\n${r.stderr}`);
  process.exit(1);
}

let parsed;
try {
  // npm 会把 notice 打到 stderr，stdout 是纯 JSON。
  parsed = JSON.parse(r.stdout);
} catch (e) {
  console.error(`解析 npm pack --json 输出失败：${e.message}\n--- stdout ---\n${r.stdout}`);
  process.exit(1);
}

const entry = Array.isArray(parsed) ? parsed[0] : parsed;
const files = (entry?.files ?? []).map((f) => f.path);
if (files.length === 0) {
  console.error('npm pack 报告了 0 个文件 —— 输出形状不对，拒绝据此下结论');
  process.exit(1);
}

const errors = [];
for (const need of REQUIRED) {
  if (!files.includes(need)) errors.push(`缺少必需文件：${need}`);
}
for (const f of files) {
  for (const p of FORBIDDEN_PREFIXES) {
    if (f.startsWith(p)) errors.push(`不该进包的路径：${f}（前缀 ${p}）`);
  }
  if (FORBIDDEN_EXACT.includes(f)) errors.push(`不该进包的文件：${f}`);
}

console.log(`包名 ${entry.name}@${entry.version}，共 ${files.length} 个文件，${entry.size} 字节`);
for (const f of files) console.log(`  ${f}`);

if (errors.length > 0) {
  console.error('\ncheck-pack-contents 失败：\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('\ncheck-pack-contents ok');
