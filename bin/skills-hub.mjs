#!/usr/bin/env node
// 🔴 必须在任何 import 之前抑制 node:sqlite 的 ExperimentalWarning。
// 依据：04-install.md §5.1「代价」第 2 条 —— 警告在模块导入时发出，
// 放在适配层里抑制来不及。此处是进程内最早的可执行位置。
import os from 'node:os';

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
// 🔴 认 HTTP_PROXY / HTTPS_PROXY / NO_PROXY —— 只能靠**启动前**就带上变量。
//
// Node 的内建 fetch（undici）默认**不认**代理环境变量，而 npm / git / curl 都认。
// 后果不是「慢一点」：在企业代理后面 `install` 报 `UND_ERR_CONNECT_TIMEOUT`，
// 而同一台机器上 `curl` 同一个地址是通的 —— 看起来像我们的 registry 挂了。
//
// ⚠️ **`process.env.NODE_USE_ENV_PROXY = '1'` 在进程内设置是无效的**（实测）。
//    Node 在**启动时**读它，之后再改不算数。
//    📌 我第一版正是那么写的，而且「验证」过它有效 —— 那是**假阳性**：
//    当时网络恰好能直连，设不设都通。三个对照才把它钉死：
//      ① 什么都不设        → UND_ERR_CONNECT_TIMEOUT
//      ② 进程内设置        → UND_ERR_CONNECT_TIMEOUT   ← 无效
//      ③ 启动前外部设置    → 302
//    **在一个本来就会过的窗口里验证一道闸，等于没验。**
//
// 所以：检测到代理配置但变量没带上时，**带着变量把自己重启一次**。
// 🔴 三个前提缺一不可，否则不重启：
//    · 用户没有显式表态（`NODE_USE_ENV_PROXY` 未设 —— 设成 '0' 也是表态）
//    · 环境里确实配了代理（没配就重启纯属白费一个进程）
//    · 不是已经重启过的那一次（防无限自我重启）
if (
  process.env.NODE_USE_ENV_PROXY === undefined &&
  process.env.GEOLY_PROXY_REEXEC === undefined &&
  ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => process.env[k])
) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    // 🔴 `inherit`：stdin 必须原样传下去 —— `install --all` 的数量确认
    //    要读 TTY，管道化会让它变成非交互而**静默走另一条分支**。
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', GEOLY_PROXY_REEXEC: '1' },
  });
  // 被信号杀掉时用 128+signo 表示，别把它压成 0
  if (r.signal) process.exit(128 + (os.constants.signals[r.signal] ?? 0));
  process.exit(r.status ?? 1);
}

const { lockdown } = await import('../src/fault-inject.mjs');
lockdown();

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
