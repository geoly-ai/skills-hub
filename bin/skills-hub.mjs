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

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
