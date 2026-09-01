// 用来验「进程在 ACK 之前被杀掉」的子进程：record 两条，然后 flush 到父进程给的端点。
// 父进程那个端点**先 durable、然后永远不回复**，所以这个进程会一直挂在读 ACK 上
// —— 正好停在我们要验的那一格，父进程在那时把它 SIGKILL 掉。
import { record } from '../../src/telemetry.mjs';
import { flush } from '../../src/upload.mjs';

const url = process.argv[2];
record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/b@1.0.0' });

// 超时给得很大：这里要的是「被杀」，不是「超时自己退出来」
await flush({
  timeoutMs: 600_000,
  fetchImpl: (_u, o) => fetch(url, { method: o.method, headers: o.headers, body: o.body }),
});
