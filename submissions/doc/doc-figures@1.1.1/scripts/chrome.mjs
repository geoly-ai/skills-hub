#!/usr/bin/env node
// doc-figures 的 Chrome 工人：一个 headless Chrome 进程（CDP）批量完成三类任务。
// 用法：node chrome.mjs <jobs.json> <results.json>
//   jobs = {"mermaid_js": 绝对路径, "tasks": [
//     {"kind": "mermaid", "id": "x", "source": "...", "config": {...}, "gantt_intervals": ["1week", "2week", ...]},
//     {"kind": "measure", "id": "x", "svg_path": "...", "boxes": [[text序号, x, y, w, h], ...]},
//     {"kind": "screenshot", "id": "x", "svg_path": "...", "png_path": "...", "scale": 2}
//   ]}
// Chrome 路径：环境变量 CHROME_PATH → macOS 常见安装位置 → PATH 里的 google-chrome / chromium。
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findChrome() {
  const c = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'].filter(Boolean);
  for (const p of c) if (existsSync(p)) return p;
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { const p = execFileSync('which', [n], { encoding: 'utf8' }).trim(); if (p) return p; } catch {}
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const [,, jobsPath, resultsPath] = process.argv;
  if (process.argv.includes('--which')) { console.log(findChrome() || ''); process.exit(findChrome() ? 0 : 1); }
  if (!jobsPath || !resultsPath) { console.error('用法：node chrome.mjs <jobs.json> <results.json>'); process.exit(2); }
  const jobs = JSON.parse(readFileSync(jobsPath, 'utf8'));
  const chromePath = findChrome();
  if (!chromePath) { writeFileSync(resultsPath, JSON.stringify({ error: 'chrome_not_found', results: [] })); process.exit(3); }
  const launch = () => {
    const profile = mkdtempSync(join(tmpdir(), 'doc-figures-chrome-'));
    const port = 9800 + Math.floor(Math.random() * 1000);
    const proc = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--allow-file-access-from-files', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    return { profile, port, proc };
  };
  const tempDirs = [];
  let { profile, port, proc: chrome } = launch();
  // build 超时或被中断时也要带走 Chrome 子进程
  const onSignal = sig => { try { chrome.kill('SIGKILL'); } catch {} for (const d of [profile, ...tempDirs]) { try { rmSync(d, { recursive: true, force: true }); } catch {} } process.exit(130); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal); process.on('SIGHUP', onSignal);
  const out = { chrome: chromePath, chrome_version: null, results: [] };
  let ws;
  try {
    let targets = [];
    // 机器繁忙时 Chrome 起得慢：等 40 秒；仍没有页面就换端口重启一次
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let i = 0; i < 160; i++) {
        try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {}
        await sleep(250);
      }
      if (targets.some(t => t.type === 'page')) break;
      chrome.kill('SIGTERM'); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch {}
      ({ profile, port, proc: chrome } = launch());
    }
    if (!targets.some(t => t.type === 'page')) throw new Error('Chrome 启动后 40 秒内没有可用页面（已重试一次）');
    try { out.chrome_version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser; } catch {}
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0; const pending = new Map(); const events = [];
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) events.push(d.method); };
    const send = (method, params = {}) => new Promise(res => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.error) throw new Error(JSON.stringify(r.error));
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result.result.value;
    };
    const navigate = async (url) => {
      events.length = 0;
      await send('Page.navigate', { url });
      for (let i = 0; i < 160 && !events.includes('Page.loadEventFired'); i++) await sleep(50);
      await evaluate('document.fonts.ready.then(() => true)');
    };
    await send('Page.enable');
    await send('Runtime.enable');

    // ---------- 字体度量（生成 font_metrics.json 用） ----------
    for (const t of jobs.tasks.filter(t => t.kind === 'metrics')) {
      await navigate('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>'));
      const m = await evaluate(`(async (chars, family) => {
        const c = document.createElement('canvas').getContext('2d'); const out = {};
        for (const w of ['normal', 'bold']) {
          const spec = w + ' 100px ' + family; await document.fonts.load(spec, chars.join(''));
          c.font = spec; const tab = {}; for (const ch of chars) tab[ch] = Math.round(c.measureText(ch).width * 100) / 10000;
          const mm = c.measureText('中Hg');
          out[w] = { widths: tab, font_ascent: mm.fontBoundingBoxAscent / 100, font_descent: mm.fontBoundingBoxDescent / 100, cjk: c.measureText('中').width / 100 };
        }
        return out; })(${JSON.stringify(t.chars)}, ${JSON.stringify(t.family)})`);
      out.results.push({ id: t.id, kind: 'metrics', family: t.family, metrics: m });
    }

    // ---------- Mermaid ----------
    const mmdTasks = jobs.tasks.filter(t => t.kind === 'mermaid');
    if (mmdTasks.length) {
      const dir = mkdtempSync(join(tmpdir(), 'doc-figures-mmd-'));
      tempDirs.push(dir);
      const htmlPath = join(dir, 'host.html');
      writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}#host{width:1200px}</style>
<script src="${pathToFileURL(resolve(jobs.mermaid_js)).href}"></script></head><body><div id="host"></div></body></html>`);
      await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
      await navigate(pathToFileURL(htmlPath).href);
      const ok = await evaluate('typeof mermaid !== "undefined"');
      if (!ok) throw new Error('mermaid.min.js 未加载');
      for (const t of mmdTasks) {
        const intervals = t.gantt_intervals && t.gantt_intervals.length ? t.gantt_intervals : [null];
        let res = null; const attempts = [];
        for (const iv of intervals) {
          const cfg = JSON.parse(JSON.stringify(t.config));
          if (iv) { cfg.gantt = Object.assign({}, cfg.gantt || {}, { tickInterval: iv }); }
          try {
            res = await evaluate(`(${renderInPage.toString()})(${JSON.stringify(t.source)}, ${JSON.stringify(cfg)}, ${JSON.stringify('m' + Math.random().toString(36).slice(2, 8))})`);
          } catch (e) { res = { error: String(e.message || e) }; }
          attempts.push({ tick_interval: iv, error: res.error || null, tick_overlaps: res.tick_overlaps ?? null, ticks: res.ticks ?? null });
          if (res.error || !res.is_gantt || res.tick_overlaps === 0) break;
        }
        out.results.push(Object.assign({ id: t.id, kind: 'mermaid', attempts }, res));
      }
    }

    // ---------- 实测：文字框越界与文字互相重叠 ----------
    for (const t of jobs.tasks.filter(t => t.kind === 'measure' || t.kind === 'screenshot')) {
      try {
        await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: t.scale || 1, mobile: false });
        await navigate(pathToFileURL(resolve(t.svg_path)).href);
        const size = await evaluate(`(() => { const r = document.documentElement.getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)]; })()`);
        if (t.kind === 'measure') {
          const m = await evaluate(`(${measureInPage.toString()})(${JSON.stringify(t.boxes || [])}, ${JSON.stringify(t.group_selector || null)})`);
          out.results.push(Object.assign({ id: t.id, kind: 'measure', size }, m));
        } else {
          await send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: t.scale || 2, mobile: false });
          await navigate(pathToFileURL(resolve(t.svg_path)).href);
          const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 1 }, captureBeyondViewport: true });
          if (shot.error) throw new Error(JSON.stringify(shot.error));
          writeFileSync(t.png_path, Buffer.from(shot.result.data, 'base64'));
          out.results.push({ id: t.id, kind: 'screenshot', png_path: t.png_path, size });
        }
      } catch (e) { out.results.push({ id: t.id, kind: t.kind, error: String(e.message || e) }); }
    }
  } catch (e) {
    out.error = String(e.message || e);
  } finally {
    try { ws && ws.close(); } catch {}
    const exited = new Promise(res => { if (chrome.exitCode !== null) res(); else chrome.once('exit', res); });
    chrome.kill('SIGTERM');
    const t = await Promise.race([exited.then(() => 'exit'), sleep(3000).then(() => 'timeout')]);
    if (t === 'timeout') { try { chrome.kill('SIGKILL'); } catch {} await Promise.race([exited, sleep(2000)]); }
    for (const d of [profile, ...tempDirs]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  writeFileSync(resultsPath, JSON.stringify(out));
  process.exit(out.error ? 1 : 0);
}

// 在页面内执行：渲染 Mermaid，把 CSS 计算样式写回属性并删掉 style 元素，统计 foreignObject、滤镜与甘特刻度重叠。
async function renderInPage(source, config, rid) {
  const host = document.getElementById('host');
  host.innerHTML = '';
  mermaid.initialize(config);
  let svgText;
  try { ({ svg: svgText } = await mermaid.render(rid, source)); }
  catch (e) { document.querySelectorAll('[id^="d' + rid + '"],#' + rid).forEach(n => n.remove()); return { error: String(e.message || e) }; }
  host.innerHTML = svgText;
  const svg = host.querySelector('svg');
  const isGantt = svg.getAttribute('aria-roledescription') === 'gantt';
  const diagramType = svg.getAttribute('aria-roledescription') || '';
  // 甘特刻度重叠
  let tickOverlaps = null, ticks = null;
  if (isGantt) {
    const rects = [...svg.querySelectorAll('.tick text')].map(n => n.getBoundingClientRect()).filter(r => r.width > 0).sort((a, b) => a.left - b.left);
    ticks = rects.length; tickOverlaps = 0;
    for (let i = 1; i < rects.length; i++) if (rects[i - 1].right + 6 > rects[i].left) tickOverlaps++;
  }
  const foreignObjects = svg.querySelectorAll('foreignObject').length;
  // Mermaid 自动连字符断行（长中文串被切成「…-」+ 下一行）：记录下来，build 报必改
  const hyphenated = [...svg.querySelectorAll('text, tspan')].filter(n => !n.querySelector('tspan')).map(n => (n.textContent || '').trim()).filter(t => /[\u3400-\u9fff][-‐–]$/.test(t)).map(t => t.slice(0, 60));
  // 时序图：消息文字、分支条件、段标题后面加与背景同色的衬底矩形，生命线不再穿过文字（高度 ≥ 2，无 filter / clipPath）
  let backed = 0;
  if (diagramType === 'sequence') {
    for (const n of svg.querySelectorAll('text.messageText, text.loopText, text.sectionTitle, text.labelText')) {
      if (!(n.textContent || '').trim()) continue;
      const b = n.getBBox(); if (b.width < 1 || b.height < 2) continue;
      if (n.classList.contains('labelText')) continue;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', b.x - 4); r.setAttribute('y', b.y - 1); r.setAttribute('width', b.width + 8); r.setAttribute('height', Math.max(b.height + 2, 2));
      r.setAttribute('rx', 3); r.setAttribute('fill', '#FFFFFF'); r.setAttribute('class', 'doc-figures-text-bg');
      if (n.getAttribute('transform')) r.setAttribute('transform', n.getAttribute('transform'));
      n.parentNode.insertBefore(r, n); backed++;
    }
  }
  // 计算样式写回属性
  const LEAF = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use', 'textPath']);
  const SHAPE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'stroke-linecap', 'stroke-linejoin'];
  const TEXT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline'];
  const all = [...svg.querySelectorAll('*')];
  for (const el of all) {
    const tag = el.localName;
    if (!LEAF.has(tag) || (el.classList && el.classList.contains('doc-figures-text-bg'))) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') el.setAttribute('display', 'none');
    if (cs.visibility === 'hidden') el.setAttribute('visibility', 'hidden');
    for (const p of SHAPE_PROPS) { const v = cs.getPropertyValue(p); if (v) el.setAttribute(p, v); }
    if (tag === 'text' || tag === 'tspan' || tag === 'textPath') for (const p of TEXT_PROPS) { const v = cs.getPropertyValue(p); if (v) el.setAttribute(p, v); }
  }
  for (const el of all) if (el.hasAttribute && el.hasAttribute('style') && LEAF.has(el.localName)) el.removeAttribute('style');
  const styles = svg.querySelectorAll('style');
  styles.forEach(s => s.remove());
  // 滤镜：Mermaid 的阴影滤镜对 PDF 无意义，统一去掉（画板约束也只允许单个阴影）
  const filters = [...svg.querySelectorAll('filter')];
  const filterInfo = filters.map(f => [...f.children].map(c => c.localName).join('+'));
  filters.forEach(f => f.remove());
  svg.querySelectorAll('[filter]').forEach(n => n.removeAttribute('filter'));
  // 字号：取所有可见 text / tspan 的计算字号
  const sizes = [...svg.querySelectorAll('text, tspan')].filter(n => (n.textContent || '').trim() && getComputedStyle(n).display !== 'none').map(n => parseFloat(getComputedStyle(n).fontSize));
  // 文字互相重叠（不同 text 元素的外接框交叠面积 > 30%）
  const texts = [...svg.querySelectorAll('text')].filter(n => (n.textContent || '').trim()).map(n => ({ t: n.textContent.trim().slice(0, 30), r: n.getBoundingClientRect() })).filter(o => o.r.width > 0);
  const overlaps = [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i].r, b = texts[j].r;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 0 && h > 0 && w * h > 0.3 * Math.min(a.width * a.height, b.width * b.height)) overlaps.push([texts[i].t, texts[j].t]);
  }
  // 内容越出 viewBox（如 xychart 图例在字号抬高后超出右边界）：把 viewBox 扩到内容外接框 + 8px
  let expanded = null;
  if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) {
    const v = svg.viewBox.baseVal; let bx;
    host.innerHTML = ''; host.appendChild(svg); bx = svg.getBBox();
    const x0 = Math.min(v.x, bx.x - 8), y0 = Math.min(v.y, bx.y - 8), x1 = Math.max(v.x + v.width, bx.x + bx.width + 8), y1 = Math.max(v.y + v.height, bx.y + bx.height + 8);
    if (x0 < v.x - 0.5 || y0 < v.y - 0.5 || x1 > v.x + v.width + 0.5 || y1 > v.y + v.height + 0.5) {
      expanded = [v.x, v.y, v.width, v.height].map(n => Math.round(n * 10) / 10);
      svg.setAttribute('viewBox', [x0, y0, x1 - x0, y1 - y0].map(n => Math.round(n * 10) / 10).join(' '));
      const bg = svg.querySelector('rect.background'); if (bg) { bg.setAttribute('x', x0); bg.setAttribute('y', y0); bg.setAttribute('width', x1 - x0); bg.setAttribute('height', y1 - y0); }
    }
  }
  const vb = svg.viewBox && svg.viewBox.baseVal ? [svg.viewBox.baseVal.width, svg.viewBox.baseVal.height] : null;
  svg.removeAttribute('style');
  if (vb && vb[0] > 0) { svg.setAttribute('width', String(Math.ceil(vb[0]))); svg.setAttribute('height', String(Math.ceil(vb[1]))); }
  const outText = new XMLSerializer().serializeToString(svg);
  host.innerHTML = '';
  return { svg: outText, diagram_type: diagramType, is_gantt: isGantt, tick_overlaps: tickOverlaps, ticks, foreign_objects: foreignObjects,
    removed_styles: styles.length, removed_filters: filterInfo, viewbox_expanded_from: expanded, hyphenated, text_backgrounds: backed, min_font_px: sizes.length ? Math.min(...sizes) : null, text_overlaps: overlaps.slice(0, 20), viewbox: vb };
}

// 在页面内执行：按 boxes 检查第 i 个 text 的实际外接框是否落在给定框内；再查文字互相重叠与越出画布。
function measureInPage(boxes, groupSelector) {
  const svg = document.documentElement;
  const vb = svg.viewBox.baseVal; const rect = svg.getBoundingClientRect();
  const k = vb && vb.width ? rect.width / vb.width : 1;
  const texts = [...svg.querySelectorAll('text')];
  const bb = n => { const r = n.getBoundingClientRect(); return { x: (r.left - rect.left) / k, y: (r.top - rect.top) / k, w: r.width / k, h: r.height / k }; };
  const overflow = [];
  for (const [i, x, y, w, h] of boxes) {
    const n = texts[i]; if (!n) continue; const b = bb(n); const tol = 1;
    if (b.x < x - tol || b.y < y - tol || b.x + b.w > x + w + tol || b.y + b.h > y + h + tol)
      overflow.push({ text: n.textContent.slice(0, 40), text_box: [b.x, b.y, b.w, b.h].map(v => Math.round(v * 10) / 10), container: [x, y, w, h] });
  }
  if (groupSelector) {
    for (const g of svg.querySelectorAll(groupSelector)) {
      const shape = g.querySelector('path, polygon, ellipse, rect, circle'); if (!shape) continue;
      const sb = bb(shape);
      for (const n of g.querySelectorAll('text')) {
        const b = bb(n); const tol = 1;
        if (b.x < sb.x - tol || b.x + b.w > sb.x + sb.w + tol || b.y < sb.y - tol || b.y + b.h > sb.y + sb.h + tol)
          overflow.push({ text: n.textContent.slice(0, 40), text_box: [b.x, b.y, b.w, b.h].map(v => Math.round(v * 10) / 10), container: [sb.x, sb.y, sb.w, sb.h].map(v => Math.round(v * 10) / 10) });
      }
    }
  }
  const tb = texts.filter(n => n.textContent.trim()).map(n => ({ t: n.textContent.trim().slice(0, 30), b: bb(n) }));
  const overlaps = [];
  for (let i = 0; i < tb.length; i++) for (let j = i + 1; j < tb.length; j++) {
    const a = tb[i].b, c = tb[j].b;
    const w = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x), h = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
    if (w > 1 && h > 3) overlaps.push([tb[i].t, tb[j].t]);
  }
  const W = vb.width, H = vb.height;
  const outside = tb.filter(o => o.b.x < -0.5 || o.b.y < -0.5 || o.b.x + o.b.w > W + 0.5 || o.b.y + o.b.h > H + 0.5).map(o => o.t);
  return { text_overflow: overflow, text_overlaps: overlaps.slice(0, 50), outside_canvas: outside };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
