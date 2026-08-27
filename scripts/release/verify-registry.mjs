#!/usr/bin/env node
// 发布后回查：**registry 真的在供这个版本**。
//
// 判据不是「npm publish 的退出码是 0」—— 那只说明请求被接受了。
// 形状抄自 social-ops-hub 的 scripts/publish-packages.mjs（同一套判据、同样的重试）。
//
// 🔴 只读。不跑 `npm whoami`、不碰任何本地凭据文件。
import { spawnSync } from 'node:child_process';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (dflt !== undefined) return dflt;
    console.error(`缺参数 --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const name = arg('name');
const version = arg('version');
const attempts = Number(arg('attempts', '5'));
const delayMs = Number(arg('delay-ms', '3000'));

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let i = 1; i <= attempts; i += 1) {
  const r = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', '--registry=https://registry.npmjs.org'],
    { encoding: 'utf8' },
  );
  if (r.status === 0 && r.stdout.trim() === version) {
    console.log(`✔ ${name}@${version} 已在 registry 上可见`);
    process.exit(0);
  }
  if (i < attempts) {
    console.log(`… 第 ${i}/${attempts} 次还看不到，${delayMs}ms 后重试`);
    sleepSync(delayMs);
  }
}
console.error(
  `✖ ${name}@${version} 没能在 registry 上确认。` +
    'publish 的退出码为 0 不等于 registry 在供这个版本 —— 去 npmjs.com 上核对。',
);
process.exit(1);
