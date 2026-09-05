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

/**
 * `scripts/` 下**唯一**允许进包的那几个 —— 精确文件名，不是前缀。
 *
 * 🔴 为什么必须让它们进包：`skills-hub publish` 的本地预检跑的是**服务端 PR gate
 *    跑的同一批校验器**（`validate-pr.yml` 从 base 那棵树调 `run-gates.mjs` /
 *    `scan-text.mjs`）。为 CLI 另写一套路径 / mode / 字符 / manifest 的校验，
 *    结局只有两个：「本地绿、CI 红」，或者两套规则各自演化然后分叉 ——
 *    而分叉点正好是绕过点（R-11 反复出现的形状）。
 *
 * 🔴 为什么是**精确文件白名单**而不是把 `scripts/submission/` 整个放开：
 *    同目录下的 `tier-gate.mjs` / `approval-policy.mjs` 依赖 `scripts/promote/*`，
 *    整目录放行会把一个 **import 就抛** 的模块塞进用户的包里。
 *    它们也确实不该分发 —— 审批策略是仓库侧的事，不是 CLI 的事。
 *
 * ⚠️ 这几个同时进 `REQUIRED`：漏掉任何一个，`publish` 在用户机器上会
 *    `ERR_MODULE_NOT_FOUND`，而那是**装完之后才会发现**的失效。
 */
const SCRIPTS_ALLOWED = [
  'scripts/submission/structural-gates.mjs',
  'scripts/submission/run-gates.mjs',
  'scripts/submission/promotion-file.mjs',
  'scripts/submission/scan-text.mjs',
];

/** 必须在包里的路径（精确匹配）。 */
const REQUIRED = [
  'package.json',
  'bin/skills-hub.mjs',
  'src/sigstore.mjs',
  'src/trust-roots/sigstore-public-good.json',
  'src/commands/publish.mjs',
  ...SCRIPTS_ALLOWED,
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
    // 🔴 `scripts/` 仍然整体禁止 —— 只有 SCRIPTS_ALLOWED 里**逐个点名**的那几个例外。
    //    白名单写成精确文件名（不是前缀）：多混进任何一个 scripts/ 文件都会在这里红。
    if (f.startsWith(p) && !SCRIPTS_ALLOWED.includes(f)) {
      errors.push(`不该进包的路径：${f}（前缀 ${p}）`);
    }
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
