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
// 🔴 认 HTTP_PROXY / HTTPS_PROXY / NO_PROXY —— **只认这个，不去猜别的**。
//
// Node 的内建 fetch（undici）默认不认代理环境变量，而 npm / git / curl 都认。
// 后果不是「慢一点」：在代理后面 `install` 报 `UND_ERR_CONNECT_TIMEOUT`，
// 而同一台机器上 `curl` 同一个地址是通的 —— 看起来像我们的 registry 挂了。
// 我们做的只是**把用户已经表达过的意图变成生效的**。
//
// 🔴 **不读系统代理，不替用户决定他的网络怎么走。**（2026-09-04 用户拍板。）
//    我一度加了「没有环境变量就去读 macOS 的 scutil --proxy」——
//    它确实能让「什么都不设也能装」，但那是**替用户选了一条他没选的路**：
//    设了环境变量 = 他说「这次走这儿」；系统设置只是「这台机器平时怎样」，
//    不等于他要让这个工具走那儿。
//    ⚠️ 更实际的一层：静默把请求送进一个代理，是**改变了流量的去向**，
//    而用户没有要求过。要用代理就设变量，不要就不设 —— 他说了算。
//    连不上的时候**明确告诉他怎么设**（见 `src/download.mjs` 的错误提示），
//    这是帮忙；替他设上，是越界。
//
// ⚠️ **`process.env.NODE_USE_ENV_PROXY = '1'` 在进程内设置是无效的**（实测）。
//    Node 在**启动时**读它，之后再改不算数。
//    📌 我第一版正是那么写的，而且「验证」过它有效 —— 那是**假阳性**：
//    当时网络恰好能直连，设不设都通。三个对照才把它钉死：
//      ① 什么都不设        → UND_ERR_CONNECT_TIMEOUT
//      ② 进程内设置        → UND_ERR_CONNECT_TIMEOUT   ← 无效
//      ③ 启动前外部设置    → 302
//    **在一个本来就会过的窗口里验证一道闸，等于没验。**
//    所以只能**带着变量把自己重启一次**。

// 🔴 **只有会出网的命令才值得为代理重启一次进程。**
//    `list` / `why` / `stats` 这些是纯本地的 —— 给它们重启等于每次多起一个进程。
//    出网的只有两处：`install`（preheat + 收尾的自动上报）与 `telemetry flush`。
//    ⚠️ 判据取**第一个非 flag 参数**，不是 `argv[2]` —— 全局 flag 可以写在命令前面。
//    ⚠️ 这里故意**不做真正的参数解析**：解析是 `cli.mjs` 的事，
//    在两个地方各写一套 argv 语义，迟早会分叉。这里只要一个保守的近似：
//    多重启一次不算错，漏了才算 —— 所以拿不准（比如 `--help`）就当作要出网。
const firstArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const mayGoOnline = firstArg === undefined || firstArg === 'install' || firstArg === 'telemetry';

// 三个前提缺一不可，否则不重启：
//   · 用户没有显式表态（`NODE_USE_ENV_PROXY` 已设 —— 哪怕设成 '0' —— 一律尊重）
//   · 环境里确实配了代理（没配就重启纯属白费一个进程）
//   · 不是已经重启过的那一次（防无限自我重启）
if (
  mayGoOnline
  && process.env.NODE_USE_ENV_PROXY === undefined
  && process.env.GEOLY_PROXY_REEXEC === undefined
  && ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => process.env[k])
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
