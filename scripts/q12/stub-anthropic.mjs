// 本地 stub：假装是 Anthropic API，返回一段最小的 SSE 成功响应。
//
// 为什么要它：claude 的读数取自 `--output-format stream-json` 的首条 system/init
// 事件。要拿到**真实的退出码 0** 与真实 stderr，客户端就必须真的跑完一轮；
// 而我们既不想发外网请求，也不想花钱。stub 同时把客户端**真正发出去的请求体**
// 落盘 —— 那是 catalog 之外的**第二件产物**，用来核对 canary 有没有混进
// 模型真正看到的内容里（docs/m1/00-gates.md 里 claude 两格靠的就是这一条）。
//
// 🔴 只落**请求体**，不落任何请求头。头里带着 x-api-key / authorization，
//    落盘就等于把凭据写进了报告可能引用的文件。这里只记录出现过哪些头**名字**。
//
// 🔴 **这个 stub 必须跑在独立进程里。** 别把它挪回测量进程内。
//
//    `spawnSync` 会**阻塞 Node 的事件循环**。stub 若与测量代码同进程，
//    客户端能完成 TCP 握手（内核 accept 队列受理）、能把请求字节写进缓冲区，
//    但那个 HTTP server **永远不会被调度去读它** —— 事件循环正卡在 spawnSync 上。
//    于是客户端等响应等到超时被我们 SIGTERM 掉（退出码 128+15 = 143），
//    而 stub 的 handler 一次都没跑，`requestBodies` 是 0。
//
//    ⚠️ 这个形状极具误导性，我在它上面栽过一次：
//       「客户端被杀 + 服务端没收到请求」看起来**完全像**网络不通，
//       而且「外部 HTTPS 能通、所有本地 bind 都不通」这个对照会**加强**那个错误结论 ——
//       因为外部服务不在我们的事件循环里，本地 stub 在。
//       更糟的是：如果你用 `spawnSync` 起 curl 去做那个对照，
//       对照本身也会被同一个 bug 打死，于是它「证实」了一个不存在的网络问题。
//
//    🔴 一般化的判据：**「进程被杀 + 服务端没收到请求」推不出「网络不通」。**
//       至少要分开三种：连不上（ECONNREFUSED）、**连上了但没人读**（本例）、读了但没回。
//       本例的辨别特征是 —— 客户端**已经产出了正常输出**（init 事件、完整的 skill 清单），
//       说明它跑起来了，卡的是「等回复」，不是「连不上」。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_q12","type":"message","role":"assistant","model":"q12-stub","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

/**
 * 进程**内**启动。只给独立进程入口（本文件末尾）用 ——
 * 测量代码不要直接调它，见文件头那段。
 *
 * @param {string} bodyLogPath 请求体逐条追加到这个文件（JSONL）
 * @returns {Promise<{url:string, close:()=>Promise<void>}>}
 */
export function startStub(bodyLogPath) {
  writeFileSync(bodyLogPath, '');
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      appendFileSync(
        bodyLogPath,
        JSON.stringify({
          method: req.method,
          path: req.url,
          headerNames: Object.keys(req.headers).sort(), // 🔴 只记名字，不记值
          body,
        }) + '\n',
      );
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(SSE);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 🔴 只监听回环口。stub 会把请求体落盘，绝不能被机器外的东西喂数据。
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}


// ── 独立进程入口 ────────────────────────────────────────────────────────────

/**
 * 把 stub 起在**独立进程**里，返回它的 URL。
 * 测量代码用这个，不要用 `startStub()`。
 *
 * @param {string} bodyLogPath 请求体 JSONL 落盘位置（父进程直接读这个文件）
 * @returns {Promise<{url:string, close:()=>Promise<void>}>}
 */
export function startStubProcess(bodyLogPath) {
  const portFile = `${bodyLogPath}.port`;
  if (existsSync(portFile)) unlinkSync(portFile);
  const child = spawn(
    process.execPath,
    ['--no-warnings', new URL(import.meta.url).pathname, bodyLogPath, portFile],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    let exited = false;
    child.on('exit', (code) => { exited = true; reject(new Error(`stub 进程提前退出（code=${code}）：${stderr}`)); });
    const poll = () => {
      if (exited) return;
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, 'utf8').trim();
        if (port) {
          resolve({
            url: `http://127.0.0.1:${port}`,
            close: () => new Promise((r) => {
              child.removeAllListeners('exit');
              child.on('exit', () => r());
              child.kill('SIGTERM');
              setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } r(); }, 2000).unref?.();
            }),
          });
          return;
        }
      }
      if (Date.now() > deadline) { child.kill('SIGKILL'); reject(new Error(`stub 15s 内没有报出端口：${stderr}`)); return; }
      setTimeout(poll, 25);
    };
    poll();
  });
}

// 被当作脚本直接执行时：起 server，把端口写进 portFile，然后一直活着。
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [, , bodyLogPath, portFile] = process.argv;
  if (!bodyLogPath || !portFile) {
    console.error('用法：node stub-anthropic.mjs <bodyLogPath> <portFile>');
    process.exit(2);
  }
  const s = await startStub(bodyLogPath);
  writeFileSync(portFile, new URL(s.url).port);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30); // 保活
}
