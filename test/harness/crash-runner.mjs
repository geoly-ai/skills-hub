// 崩溃驱动 —— 「对这个事务的每一个注入点，各跑一遍崩溃恢复」。
//
// 两趟（外加一趟可选的双故障）：
//   第 0 趟  无故障 + TRACE  → 得到有序的 (name, nth) 命中序列。
//            🔴 这一趟是**枚举**的来源：注入点是被发现的，不是手写死的。
//   第 N 趟  对序列里的每一项，各起一个子进程、在该点崩、然后恢复、断言不变式。
//   双故障   在第 N 趟的基础上，恢复过程中再崩一次（抽样，不做全组合 —— O(n²)）。
//
// 交叉核对（漏点可发现）见 test/fault-matrix.test.mjs。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, 'child.mjs');

export function freshTarget(tag) {
  return join(mkdtempSync(join(tmpdir(), `fx-${tag}-`)), 'skills');
}

function spawnChild(env, timeoutMs = 60_000) {
  const r = spawnSync(process.execPath, [CHILD], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    status: r.status,
    signal: r.signal,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

/** 第 0 趟：无故障跑一遍，收集 trace。返回 [{name, nth}, …]（有序、去重后仍保留次数） */
export function traceScenario(scenario, phase = 'run') {
  const target = freshTarget(`trace-${scenario}`);
  const tracePath = join(tmpdir(), `fx-trace-${process.pid}-${Math.random().toString(36).slice(2)}.tsv`);
  const r = spawnChild({
    FX_TARGET: target,
    FX_SCENARIO: scenario,
    FX_PHASE: phase,
    GEOLY_FAULT_ENABLE: '1',
    GEOLY_FAULT_TRACE: tracePath,
    GEOLY_FAULT: '',
    FX_ARM_NAME: '',
  });
  if (r.status !== 0) {
    throw new Error(`trace 趟本身就失败了（${scenario}/${phase}）：status=${r.status} ${r.stderr}`);
  }
  const lines = existsSync(tracePath) ? readFileSync(tracePath, 'utf8').split('\n').filter(Boolean) : [];
  try { unlinkSync(tracePath); } catch { /* 无所谓 */ }
  rmSync(dirname(target), { recursive: true, force: true });
  return lines.map((l) => {
    const [name, nth] = l.split('\t');
    return { name, nth: Number(nth) };
  });
}

export function cleanupTarget(target) {
  rmSync(dirname(target), { recursive: true, force: true });
}

// ── 异步并行版（子进程 tier 用）───────────────────────────────────────────
// spawnSync 一次约 200 ms；120 个点串行要 48 s。并行 8 路压到 ~8 s。

function spawnChildAsync(env, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stderr, stdout: '', timedOut });
    });
  });
}

export async function crashAndRecoverAsync(scenario, point, mode, opts = {}) {
  const target = freshTarget(`c-${scenario}`);
  const base = {
    FX_TARGET: target,
    FX_SCENARIO: scenario,
    GEOLY_FAULT_ENABLE: '1',
    GEOLY_FAULT_POWERFAIL_STYLE: opts.powerfailStyle ?? 'drop',
  };
  const crash = await spawnChildAsync({
    ...base, FX_PHASE: 'run',
    FX_ARM_NAME: point.name, FX_ARM_NTH: String(point.nth), FX_ARM_MODE: mode,
  });
  const recoverRun = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
  const recoverTwice = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
  return { crash, recoverRun, recoverTwice, target };
}

/** 并发池：跑完全部任务，保留顺序 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** 抽样：在 n 个点里挑 k 个，确定性（不用随机 —— 失败要能复现） */
export function sample(list, k) {
  if (list.length <= k) return [...list];
  const step = list.length / k;
  return Array.from({ length: k }, (_, i) => list[Math.floor(i * step)]);
}

