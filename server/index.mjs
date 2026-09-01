#!/usr/bin/env node
// 上报端点的可执行入口。`node server/index.mjs`
//
// 环境变量：
//   GEOLY_TELEMETRY_SERVER_DIR    数据目录（默认 ./telemetry-data）
//   GEOLY_TELEMETRY_SERVER_PORT   监听端口（默认 8787）
//   GEOLY_TELEMETRY_SERVER_HOST   监听地址（默认 127.0.0.1 —— 故意不是 0.0.0.0）
//   GEOLY_TELEMETRY_SUMMARY_TOKEN 设了才开 /v1/summary（不设 = 聚合面关闭）
//   GEOLY_TELEMETRY_RETENTION_DAYS 保留期，默认 180（§5.3）
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 部署约束（**代码保证不了，必须在部署配置里落实，否则隐私契约是假的**）
//
// 本进程只讲 http，TLS 由前置代理终结 —— 而**前置代理默认会记访问日志，
// 里面有源 IP、时间戳、URL**。规格 §5.3 写的是「不得记录 IP」「不得记录
// User-Agent 原文」，那句话约束的是**整条链路**，不只是这个 Node 进程。
// 只关掉应用层的 IP 记录、让代理照记，等于把 T-11 说的那件事原样做了一遍：
// **源 IP + 稳定的 install_id + 时间线 = 机器级追踪。**
//
// 所以上线前必须逐项确认：
//   · 反向代理 / 负载均衡 / CDN 的 access log：关掉，或至少不记 remote_addr 与 UA
//   · 云平台自带的请求日志与 APM：同上（这类通常默认开，且不在你的配置文件里）
//   · 崩溃上报 / 监控：不得把请求头带走
//   · 真需要留量级统计时，只留到 /24 且 7 天内丢弃（§5.3）
// 做不到就**不要上线**这个端点 —— 上线一个会记 IP 的埋点端点，比不做埋点糟得多。
//
// 另外：默认只听 127.0.0.1。要对外就显式设 HOST，让「暴露出去」是一个有意的动作。
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { createHandler } from './app.mjs';
import { openFileStore } from './store.mjs';

// 🔴 环境变量一律当**可能填错的**来读，空串尤其要挡：
//    · `HOST=` 空串会让 Node 绑到 `0.0.0.0` —— 「显式设了才对外」的意图被一个
//      漏填的部署模板悄悄绕过，正是最不该静默的那一类错。
//    · `RETENTION_DAYS=` 空串 / 非数字会让 `prune(NaN)` 走进
//      `records.filter(r => r.received_at >= NaN)` —— 全 false，**全量原始事件被删光**，
//      而且因为 `NaN > prev` 也是 false，连 rollup 都不会折算。一个手滑清空所有数据。
const need = (name, fallback, parse) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = parse(raw.trim());
  if (v === null) throw new Error(`telemetry-server: ${name}=${JSON.stringify(raw)} 不是合法取值`);
  return v;
};
const posInt = (s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null);

const dir = need('GEOLY_TELEMETRY_SERVER_DIR', './telemetry-data', (s) => s);
const port = need('GEOLY_TELEMETRY_SERVER_PORT', 8787, (s) => (posInt(s) && Number(s) <= 65535 ? Number(s) : null));
const host = need('GEOLY_TELEMETRY_SERVER_HOST', '127.0.0.1', (s) => s);
const retentionDays = need('GEOLY_TELEMETRY_RETENTION_DAYS', 180, posInt);

const store = openFileStore(dir);
const handler = createHandler({
  store,
  summaryToken: process.env.GEOLY_TELEMETRY_SUMMARY_TOKEN ?? null,
});

const server = createServer((req, res) => {
  handler(req, res).catch(() => { try { res.destroy(); } catch { /* 已断开 */ } });
});
// 慢速读攻击（Slowloris）：不设超时时一个连接可以永远占着一个 in-flight 名额
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

// 保留期清理。跑在进程里而不是靠外部 cron：忘了配 cron 的后果是**原始事件永久留着**，
// 那正是 §5.3 不允许的。`unref()` 让它不阻止进程退出。
const prune = () => {
  try { store.prune(Date.now() - retentionDays * 86_400_000); } catch (e) { console.error(e); }
};
prune();
setInterval(prune, 6 * 3600_000).unref();

server.listen(port, host, () => {
  console.log(`telemetry endpoint: http://${host}:${port}/v1/events  data=${dir}  retention=${retentionDays}d`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); store.close(); process.exit(0); });
}
