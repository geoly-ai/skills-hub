#!/usr/bin/env node
// doc-render 打印器：Chrome DevTools Protocol → PDF。参数化，不含任何业务文案。
// 用法：
//   node print_pdf.mjs <job.json>            单个任务（job 字段见下）
//   node print_pdf.mjs --stdio               常驻：stdin 每行一个 job JSON，stdout 每行一个结果 JSON（同一个 Chrome 进程）
// job：{id, html, pdf, displayHeaderFooter, headerTemplate, footerTemplate, outline, measure, timeoutMs}
//   html          输入 HTML 绝对路径（file://）
//   pdf           输出 PDF 路径
//   outline       true 时传 generateDocumentOutline（生成书签）
//   measure       true 时在 print 媒体下量表格单元格与图的溢出，结果放 result.overflow
// 结果：{id, ok, error, chrome, overflow}
// Chrome 路径：环境变量 DOC_RENDER_CHROME / CHROME_PATH / CHROME_BIN → 常见安装路径 → PATH 里的 google-chrome、chromium。
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function findChrome() {
  for (const k of ['DOC_RENDER_CHROME', 'CHROME_PATH', 'CHROME_BIN']) {
    if (process.env[k] && existsSync(process.env[k])) return process.env[k];
  }
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  for (const c of cands) if (existsSync(c)) return c;
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

class Browser {
  async start() {
    const bin = findChrome();
    if (!bin) throw new Error('找不到 Chrome：设置 DOC_RENDER_CHROME 或安装 Google Chrome');
    this.profile = mkdtempSync(join(tmpdir(), 'doc-render-chrome-'));
    this.port = 9300 + Math.floor(Math.random() * 600);
    this.proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, 'about:blank'], { stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 80; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {}
      await sleep(250);
    }
    const page = (targets || []).find(t => t.type === 'page');
    if (!page) throw new Error('Chrome 调试端口未就绪');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.id = 0; this.pending = new Map(); this.events = [];
    this.ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) { this.pending.get(d.id)(d); this.pending.delete(d.id); }
      else if (d.method) this.events.push(d.method);
    };
    await this.send('Page.enable');
    const v = await this.send('Browser.getVersion');
    this.version = v.result ? v.result.product : 'unknown';
  }
  send(method, params = {}) {
    return new Promise(res => { const i = ++this.id; this.pending.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async print(job) {
    this.events = [];
    await this.send('Emulation.setEmulatedMedia', { media: '' });
    await this.send('Page.navigate', { url: 'file://' + resolve(job.html) });
    const limit = Math.ceil((job.timeoutMs || 60000) / 100);
    for (let i = 0; i < limit && !this.events.includes('Page.loadEventFired'); i++) await sleep(100);
    await this.eval(`(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode ? i.decode().catch(() => 0) : 0)); return true; })()`);
    await sleep(150);
    let overflow;
    if (job.measure) {
      await this.send('Emulation.setEmulatedMedia', { media: 'print' });
      overflow = await this.eval(`(() => {
        const out = [];
        const st = document.createElement('style');
        st.textContent = 'body{width:' + ${JSON.stringify(job.contentMm || 182)} + 'mm !important}.dm-landscape{width:' + ${JSON.stringify(job.landscapeMm || 269)} + 'mm !important}';
        document.head.appendChild(st);
        const px = mm => mm * 96 / 25.4;
        document.querySelectorAll('[data-dm-measure]').forEach(el => {
          const limit = px(Number(el.getAttribute('data-dm-measure')));
          const w = el.getBoundingClientRect().width;
          let cell = false;
          el.querySelectorAll('th,td,pre').forEach(c => { if (c.scrollWidth > c.clientWidth + 2) cell = true; });
          if (w > limit + 2 || el.scrollWidth > el.clientWidth + 2 || cell) out.push({ id: el.id, width_mm: Math.round(w * 25.4 / 96 * 10) / 10, limit_mm: Number(el.getAttribute('data-dm-measure')), cell });
        });
        st.remove();
        return out;
      })()`);
      await this.send('Emulation.setEmulatedMedia', { media: '' });
    }
    const r = await this.send('Page.printToPDF', {
      printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: !!job.displayHeaderFooter,
      headerTemplate: job.headerTemplate || '<div></div>', footerTemplate: job.footerTemplate || '<div></div>',
      generateDocumentOutline: !!job.outline, generateTaggedPDF: !!job.outline,
      transferMode: 'ReturnAsBase64',
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    writeFileSync(job.pdf, Buffer.from(r.result.data, 'base64'));
    return { overflow };
  }
  async stop() {
    try { this.ws && this.ws.close(); } catch {}
    try { this.proc && this.proc.kill('SIGTERM'); } catch {}
    await sleep(300);
    try { rmSync(this.profile, { recursive: true, force: true }); } catch {}
  }
}

async function runJob(b, job) {
  try {
    const { overflow } = await b.print(job);
    return { id: job.id, ok: true, chrome: b.version, overflow };
  } catch (e) {
    return { id: job.id, ok: false, chrome: b.version, error: String(e && e.message || e) };
  }
}

const args = process.argv.slice(2);
if (!args.length) { console.error('用法：node print_pdf.mjs <job.json> | --stdio'); process.exit(2); }
const b = new Browser();
let code = 0;
try {
  await b.start();
  if (args[0] === '--stdio') {
    process.stdout.write(JSON.stringify({ ready: true, chrome: b.version }) + '\n');
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let job;
      try { job = JSON.parse(line); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: 'job 不是合法 JSON' }) + '\n'); continue; }
      if (job.quit) break;
      process.stdout.write(JSON.stringify(await runJob(b, job)) + '\n');
    }
  } else {
    const job = JSON.parse(readFileSync(args[0], 'utf8'));
    const r = await runJob(b, job);
    console.log(JSON.stringify(r));
    code = r.ok ? 0 : 1;
  }
} catch (e) {
  console.log(JSON.stringify({ ready: false, ok: false, error: String(e && e.message || e) }));
  code = 1;
} finally {
  await b.stop();
  process.exit(code);
}
