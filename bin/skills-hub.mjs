#!/usr/bin/env node
// 🔴 必须在任何 import 之前抑制 node:sqlite 的 ExperimentalWarning。
// 依据：04-install.md §5.1「代价」第 2 条 —— 警告在模块导入时发出，
// 放在适配层里抑制来不及。此处是进程内最早的可执行位置。
const origEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data?.name === 'ExperimentalWarning' &&
    /SQLite/i.test(data?.message ?? '')
  ) return false;
  return origEmit.call(this, name, data, ...rest);
};

// 🔴 生产 CLI 里绝不允许故障注入被环境变量武装起来。
// 注入器支持 throw / exit / SIGKILL / powerfail —— 用户环境里一个残留的
// GEOLY_FAULT_ENABLE=1 就能让正经安装在半路被杀。先清环境，再上锁，
// 两道都在**任何 import 之前**，因为模块求值时就可能读这些变量。
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GEOLY_FAULT')) delete process.env[k];
}
const { lockdown } = await import('../src/fault-inject.mjs');
lockdown();

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
