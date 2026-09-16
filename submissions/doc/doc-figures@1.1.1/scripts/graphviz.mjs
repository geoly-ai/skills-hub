#!/usr/bin/env node
// 用 vendored @hpcc-js/wasm-graphviz（离线 WASM）把 DOT 渲染成 SVG。
// 用法：node graphviz.mjs <in.dot> <out.svg> [--engine dot]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'vendor', 'wasm-graphviz-1.29.1', 'index.js');
const args = process.argv.slice(2);
const engine = args.includes('--engine') ? args[args.indexOf('--engine') + 1] : 'dot';
const [input, output] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--engine');
if (!input || !output) { console.error('用法：node graphviz.mjs <in.dot> <out.svg> [--engine dot]'); process.exit(2); }
try {
  const { Graphviz } = await import(pathToFileURL(lib).href);
  const gv = await Graphviz.load();
  const svg = gv.layout(readFileSync(input, 'utf8'), 'svg', engine);
  writeFileSync(output, svg);
  console.log(JSON.stringify({ ok: true, output, graphviz: gv.version() }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
}
