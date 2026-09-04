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
// 🔴 认 HTTP_PROXY / HTTPS_PROXY / NO_PROXY —— **必须在第一次 fetch 之前**。
//
// Node 的内建 fetch（undici）**默认不认代理环境变量**，而 curl / npm / git 都认。
// 后果不是「慢一点」：在企业代理后面，`install` 会以 `UND_ERR_CONNECT_TIMEOUT`
// 直接失败，而同一台机器上 `curl` 同一个地址是通的 —— 于是看起来像我们的
// registry 挂了。2026-09-03 在开发机上实测到，绕了两圈才找到。
//
// ⚠️ `NODE_USE_ENV_PROXY` 是 Node **24** 引入的；22.x 上这一行**无效**，
//    代理后面的 22.x 用户仍然连不上。这是已知缺口，不要写成已解决。
//
// 📌 代理不削弱安全性：HTTPS 走 CONNECT 隧道，TLS 仍是端到端；
//    而且我们对取回的字节做的是**签名验证**，一个恶意代理改了字节只会验签失败。
//
// 🔴 只在**用户没有显式表态**时设置：已经设过（哪怕设成 '0'）就尊重用户的选择。
if (process.env.NODE_USE_ENV_PROXY === undefined) {
  process.env.NODE_USE_ENV_PROXY = '1';
}

const { lockdown } = await import('../src/fault-inject.mjs');
lockdown();

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
