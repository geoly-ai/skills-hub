// bin 入口的两条硬约束：警告抑制要早于任何 import，故障注入在生产里必须被锁死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skills-hub.mjs');
const run = (args, env = {}) =>
  execFileSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

test('🔴 环境里残留的 GEOLY_FAULT_* 不能武装生产 CLI', () => {
  // 注入器支持 throw / exit / SIGKILL / powerfail。一个残留的 GEOLY_FAULT_ENABLE=1
  // 若能生效，正经安装就会在半路被杀 —— 所以 bin 先清环境再 lockdown。
  //
  // ⚠️ 这条测试的第一版是**假的**：它设的是 GEOLY_FAULT_NAME，而实现读的是
  // GEOLY_FAULT，于是把 bin 里的防护整个删掉它照样绿（Codex 2026-08-26 指出）。
  // 现在用 --fault-probe 直接断言注入器的**实际状态**，并已实测证伪：
  // 去掉防护后探针输出 `armed=true active=true`。
  const out = run(['--fault-probe'], {
    GEOLY_FAULT_ENABLE: '1',
    GEOLY_FAULT: 'atomic-write:pre-rename',   // 🔴 变量名必须与 armFromEnv 一致
    GEOLY_FAULT_MODE: 'exit',
    GEOLY_FAULT_NTH: '1',
    GEOLY_FAULT_TRACE: '/tmp/should-never-be-written',
  }).trim();

  assert.match(out, /(^|\s)leaked=(\s|$)/, `环境里不该残留 GEOLY_FAULT*：${out}`);
  assert.match(out, /locked=true/, `必须已 lockdown：${out}`);
  assert.match(out, /armed=false/, `绝不能被武装：${out}`);
  assert.match(out, /active=false/, `注入器必须完全静默：${out}`);
});

test('ExperimentalWarning 被抑制（且抑制发生在任何 import 之前）', () => {
  const out = execFileSync(process.execPath, [bin, '--warn-probe'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /PROBE_OK/);
  assert.ok(!/ExperimentalWarning/.test(out), '不该出现实验特性警告');
});

test('未知命令退出码为 1（用法错误）', () => {
  // 🔴 我这条原先断言 2，而 09-cli.md §6 写的是「1 = 用法错误 / 解析失败 / 候选歧义」。
  // 测试和当时的实现一起错的 —— 一致的错误不会互相暴露，正是这类断言最危险的地方。
  // 命令面那块按规格实现成 1，Codex 独立复核也判「返回 1 正确，应改测试」。
  assert.throws(
    () => run(['definitely-not-a-command']),
    (e) => e.status === 1,
  );
});

test('🔴 rmtreeFsync 遇到「看不见」不能当成「不存在」', async () => {
  // existsSync 对 broken symlink 与 EACCES 都返回 false。把它当判据，
  // 清理会在目标还在的情况下被标记完成 —— 与墓碑那次是同一个错误：
  // **读不了 ≠ 不存在**。判据必须是 lstat 的 errno。
  const { mkdtempSync, symlinkSync, existsSync, lstatSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmtreeFsync } = await import('../src/atomic-fs.mjs');

  const d = mkdtempSync(join(tmpdir(), 'rmt-'));
  const dangling = join(d, 'dangling');
  symlinkSync(join(d, 'nope'), dangling);
  assert.equal(existsSync(dangling), false, '前提：existsSync 对断链返回 false');
  assert.ok(lstatSync(dangling), '前提：但它确实存在');

  rmtreeFsync(dangling);
  assert.throws(() => lstatSync(dangling), /ENOENT/, '断链必须被真的删掉，而不是被当成不存在跳过');
});
