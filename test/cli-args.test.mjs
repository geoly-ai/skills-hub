// 命令面：全局 flag 解析、退出码分类、输出契约。
// 这一份**不碰磁盘、不造制品** —— 端到端在 test/commands-e2e.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlobals, uintArg, assertPlatformSupported, ownVersion, makeContext } from '../src/commands/context.mjs';
import { readFileSync } from 'node:fs';
import { parseRecoverArgs, assertModeAllowed } from '../src/commands/recover.mjs';
import {
  EXIT, classify, exitForViolations, VIOLATION_EXIT, UsageError, ConflictError,
} from '../src/exit-codes.mjs';
import { V } from '../src/target.mjs';
import { Output, annotations, annotationSuffix } from '../src/commands/output.mjs';
import { parseStrict } from '../src/canonical-json.mjs';
import { main } from '../src/cli.mjs';

/** assert.throws 不返回错误对象；要断言 exitCode / 文案就得自己接。 */
const grab = (fn) => {
  try { fn(); } catch (e) { return e; }
  return assert.fail('期望抛错，但没有抛');
};

const cap = () => {
  const o = { s: '', write(x) { o.s += x; return true; } };
  return o;
};

// ── 全局 flag（09-cli.md §2） ────────────────────────────────────────────────

test('§2 全局 flag 的每一项都认得，且 --flag=value 与 --flag value 等价', () => {
  const a = parseGlobals(['install', 'x', '--clients', 'claude,codex', '--keep-generations', '7']).globals;
  const b = parseGlobals(['install', 'x', '--clients=claude,codex', '--keep-generations=7']).globals;
  assert.deepEqual(a, b);
  assert.deepEqual(a.clients, ['claude', 'codex']);
  assert.equal(a.keepGenerations, 7);
});

test('--project 的可选参数：给了用给的，没给用 cwd（空串占位）', () => {
  assert.equal(parseGlobals(['install', '--project']).globals.project, '');
  assert.equal(parseGlobals(['install', '--project', 'sub']).globals.project, 'sub');
  // 后面跟着另一个 flag 时不能把它吃掉
  const g = parseGlobals(['install', '--project', '--json']).globals;
  assert.equal(g.project, '');
  assert.equal(g.json, true);
});

test('🔴 被删除的开关要点名拒绝并说明为什么没有，不能当成「未知 flag」', () => {
  for (const f of ['--no-verify', '--insecure', '--force', '--force-unlock', '--clear-lock', '--assume-idle']) {
    const e = grab(() => parseGlobals(['install', 'x', f]));
    assert.equal(e.exitCode, EXIT.USAGE, f);
    assert.match(e.message, new RegExp(`没有 \`${f.replace(/-/g, '\\-')}\``), f);
    // 说明里必须有理由，不能只说「不认识」
    assert.ok(e.message.length > f.length + 20, `${f} 的拒绝文案没有给理由`);
  }
});

test('🔴 --allow-pending 也不存在（它会把 Q12 阻塞门降级成建议）', () => {
  const e = grab(() => parseGlobals(['install', 'x', '--allow-pending']));
  assert.match(e.message, /阻塞门/);
});

test('数字参数按 11-wire-contract §2：拒绝前导零 / 浮点 / 负号 / 指数', () => {
  assert.equal(uintArg('--x', '0'), 0);
  assert.equal(uintArg('--x', '42'), 42);
  for (const bad of ['01', '1.0', '-1', '1e3', '', ' 1', '0x10']) {
    assert.throws(() => uintArg('--x', bad), /非负整数/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('--clients 里有空项是错，不静默丢', () => {
  assert.throws(() => parseGlobals(['install', 'x', '--clients', 'claude,']), /空项/);
});

test('§0 平台契约：win32 非 WSL 直接拒绝并给 WSL 指引（退出码 9）', () => {
  const e = grab(() => assertPlatformSupported({}, 'win32'));
  assert.equal(e.exitCode, EXIT.UNSUPPORTED);
  assert.match(e.message, /WSL/);
  assert.match(e.message, /wsl --install/);
  // 非 win32 一律放行
  assert.equal(assertPlatformSupported({}, 'linux').platform, 'linux');
});

// ── 退出码（09-cli.md §6） ──────────────────────────────────────────────────

test('§6 那张表的 12 个码一个不多一个不少', () => {
  assert.deepEqual(Object.values(EXIT).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('🔴 target.V 的每一个违规码都在退出码映射表里（两边漂了就红）', () => {
  for (const code of Object.values(V)) {
    assert.ok(
      Object.hasOwn(VIOLATION_EXIT, code),
      `V 里的 ${code} 没有对应的退出码 —— exit-codes.mjs 与 target.mjs 漂了`,
    );
  }
});

test('多条预检违规同时命中时，取「最根本的死路」而不是第一条或码最大的那条', () => {
  // fstype 不支持（9）+ 不可写（10）：报 10 会把用户送去 chmod，而 chmod 完照样装不上
  const code = exitForViolations([
    { code: V.NOT_WRITABLE }, { code: V.UNSUPPORTED_FSTYPE },
  ]);
  assert.equal(code, EXIT.UNSUPPORTED);
  // 只有不可写时才是 10
  assert.equal(exitForViolations([{ code: V.NOT_WRITABLE }]), EXIT.NOT_WRITABLE);
  assert.equal(exitForViolations([]), null);
});

test('classify：内核错误按 name 落格', () => {
  const mk = (name, extra = {}) => Object.assign(new Error('x'), { name }, extra);
  assert.equal(classify(mk('IntegrityError')).code, EXIT.INTEGRITY);
  // 🔴 WireError 是「解析失败」（§6 第 1 条），不是完整性失败 —— 内核自己写的 code = 1
  assert.equal(classify(mk('WireError')).code, EXIT.USAGE);
  assert.equal(classify(mk('TarViolation')).code, EXIT.INTEGRITY);
  assert.equal(classify(mk('StaleError')).code, EXIT.STALE);
  assert.equal(classify(mk('MinCliVersionError')).code, EXIT.MIN_CLI);
  assert.equal(classify(mk('LockBusyError', { code: 5 })).code, EXIT.NEEDS_RECOVER);
  assert.equal(classify(mk('NeedsRecover', { needsRecover: true })).code, EXIT.NEEDS_RECOVER);
});

test('🔴 分类必须与内核自己声明的 code 一致（漂了就红）', async () => {
  const { Corrupt } = await import('../src/journal.mjs');
  const { WireError, IntegrityError, StaleError, MinCliVersionError } = await import('../src/trust.mjs');
  const { LockBusyError } = await import('../src/lock.mjs');
  // 内核在自己的错误类里写死了 code；命令面的映射必须逐个对上，
  // 否则「内核说 1、CLI 报 2」这种漂移不会有任何东西发现。
  const cases = [
    [new Corrupt('x'), 5],
    [new WireError('E_X', 'x'), 1],
    [new IntegrityError('E_X', 'x'), 2],
    [new StaleError('x'), 8],
    [new MinCliVersionError('x'), 11],
    [new LockBusyError('/tmp/x', null), 5],
  ];
  for (const [err, want] of cases) {
    assert.equal(err.code, want, `前提：内核的 ${err.name}.code === ${want}`);
    assert.equal(classify(err).code, want, `${err.name} 的退出码映射与内核声明的 code 不一致`);
  }
});

test('🔴 认不出来的错**绝不给 0**，且标 unclassified', () => {
  const r = classify(new Error('谁也不认识我'));
  assert.notEqual(r.code, EXIT.OK);
  assert.equal(r.unclassified, true);
  // 我们自己的错则一定认得出来
  assert.equal(classify(new UsageError('x')).unclassified, false);
  assert.equal(classify(new ConflictError('x')).code, EXIT.CONFLICT);
});

test('埋点 reason 只从 REASONS 有限代码表里挑，绝不塞错误文案', async () => {
  const { REASONS } = await import('../src/telemetry.mjs');
  const samples = [
    new UsageError('x'), new ConflictError('x'),
    Object.assign(new Error('x'), { name: 'LockBusyError', code: 5, holder: null }),
    Object.assign(new Error('x'), { name: 'IntegrityError' }),
    Object.assign(new Error('x'), { name: 'StaleError' }),
    new Error('陌生错误'),
  ];
  for (const s of samples) {
    const { reason } = classify(s);
    assert.ok(REASONS.has(reason), `reason=${reason} 不在 REASONS 里（来自 ${s.name}）`);
  }
});

// ── recover 的 flag 互斥（09-cli.md §1.1） ──────────────────────────────────

test('🔴 --continue / --rollback / --reinstall 三者互斥', () => {
  assert.equal(parseRecoverArgs(['--continue']).mode, '--continue');
  const e = grab(() => parseRecoverArgs(['--continue', '--rollback']));
  assert.match(e.message, /互斥/);
  assert.equal(e.exitCode, EXIT.USAGE);
});

test('🔴 --from-generation / --reset-generation / --resume-cleanup 与三条主 flag 也互斥', () => {
  assert.throws(() => parseRecoverArgs(['--continue', '--from-generation', '3']), /互斥/);
  assert.throws(() => parseRecoverArgs(['--reset-generation', '3', '--resume-cleanup']), /互斥/);
});

test('--only 可重复且去重；离开 --from-generation 无意义', () => {
  const o = parseRecoverArgs(['--from-generation', '3', '--only', 'a', '--only', 'b', '--only', 'a']);
  assert.deepEqual(o.only, ['a', 'b']);
  assert.throws(() => parseRecoverArgs(['--only', 'a']), /--from-generation/);
});

test('🔴 --reinstall 在没有物理 corrupt 的现场必须被拒（内核会误当成 cleanup 续做）', () => {
  const survey = {
    present: true, repairIntent: false, physCorrupt: [], adoptBad: [], unadoptBad: [],
    live: [{ generation: 3, phase: 'cleanup_pending' }],
  };
  const e = grab(() => assertModeAllowed('reinstall', survey));
  assert.match(e.message, /仅物理 corrupt 可用/);
  // 有物理 corrupt（且不是 cleanup_pending）时放行
  const prepared = { ...survey, physCorrupt: ['a'], live: [{ generation: 3, phase: 'prepared' }] };
  assert.equal(assertModeAllowed('reinstall', prepared), undefined);
  // 存在 repair intent 时放行（2b-1 本来就该走 --reinstall）
  assert.equal(assertModeAllowed('reinstall', { ...survey, repairIntent: true }), undefined);
  // 别的 mode 不受这条守卫影响
  assert.equal(assertModeAllowed('continue', survey), undefined);
  assert.equal(assertModeAllowed('rollback', survey), undefined);
});

test('🔴 cleanup_pending + 物理 corrupt：三条 flag 全部拒绝（内核会把这一格整个吃掉）', () => {
  // 内核 driveLive() 把 cleanup_pending 的清理续做排在读 items[*].state 之前，
  // 于是 §1.1 为这一格规定的「拒绝 / 拒绝 / 唯一出路」一条都不会生效。
  const s2 = {
    present: true, repairIntent: false, physCorrupt: ['a'], adoptBad: [], unadoptBad: [],
    live: [{ generation: 3, phase: 'cleanup_pending' }],
  };
  for (const mode of ['continue', 'rollback', 'reinstall']) {
    const err = grab(() => assertModeAllowed(mode, s2));
    assert.match(err.message, /转人工/, mode);
    assert.match(err.message, /内核缺口/, mode);
  }
  // 同样的 corrupt 但 phase 是 prepared 时，交回内核自己判（它那一格是对的）
  const s3 = { ...s2, live: [{ generation: 3, phase: 'prepared' }] };
  assert.equal(assertModeAllowed('continue', s3), undefined);
  assert.equal(assertModeAllowed('rollback', s3), undefined);
});

test('🔴 --rollback --from-generation <N> 是 §5.8 写明的组合，不算冲突', () => {
  const o = parseRecoverArgs(['--rollback', '--from-generation', '7', '--only', 'a']);
  assert.equal(o.mode, '--rollback');
  assert.equal(o.fromGeneration, 7);
  // 但它跟别的开关仍然互斥
  assert.throws(() => parseRecoverArgs(['--rollback', '--from-generation', '7', '--resume-cleanup']), /互斥/);
  assert.throws(() => parseRecoverArgs(['--continue', '--from-generation', '7']), /互斥/);
});

// ── 输出契约（09-cli.md §7） ────────────────────────────────────────────────

test('🔴 --json 时 stdout 只有一个 JSON 对象；告警走 stderr', () => {
  const so = cap(); const se = cap();
  const out = new Output({ json: true, stdout: so, stderr: se });
  out.warn({ kind: 'duplicate-catalog', message: '重复 catalog' });
  out.note('进度');
  out.line('这一行在 --json 下不该出现在 stdout');
  out.emit('install', { targets: [] }, 0);
  const doc = parseStrict(so.s);            // 只有一个对象，且能严格解析
  assert.equal(doc.schema, 'geoly.skills.cli.install/1');
  assert.equal(doc.exit_code, 0);
  assert.equal(doc.warnings[0].kind, 'duplicate-catalog');
  assert.ok(!so.s.includes('这一行'));
  assert.match(se.s, /重复 catalog/);
  assert.match(se.s, /进度/);
});

test('🔴 canonical 规则：schema 首位、其余按字节序、结尾恰好一个 \\n、非 ASCII 转义', () => {
  const so = cap();
  new Output({ json: true, stdout: so, stderr: cap() }).emit('check', { zeta: 1, alpha: 2 }, 0);
  const keys = [...so.s.matchAll(/^  "([a-z_]+)":/gm)].map((m) => m[1]);
  assert.equal(keys[0], 'schema');
  const rest = keys.slice(1);
  assert.deepEqual(rest, [...rest].sort(), '除 schema 外必须按字节序');
  assert.ok(so.s.endsWith('}\n') && !so.s.endsWith('}\n\n'));
  assert.ok(!/[^\x00-\x7f]/.test(so.s), '非 ASCII 必须被转义');
});

test('🔴 emit 只允许一次 —— 两次就破了「stdout 只有一个对象」', () => {
  const out = new Output({ json: true, stdout: cap(), stderr: cap() });
  out.emit('why', {}, 0);
  assert.throws(() => out.emit('why', {}, 0), /只能 emit 一个/);
});

test('🔴 失败路径的 --json 也是一个对象（用法错误 / 未知命令 / 内部错误）', async () => {
  for (const argv of [['nope', '--json'], ['install', '--json', '--no-verify'], ['install', '--json']]) {
    const so = cap(); const se = cap();
    const code = await main(argv, { stdout: so, stderr: se, record: () => {} });
    assert.notEqual(code, 0, argv.join(' '));
    const doc = parseStrict(so.s);
    assert.equal(doc.ok, false);
    assert.equal(doc.exit_code, code);
    assert.equal(typeof doc.error.message, 'string');
    assert.equal(doc.error.unclassified, false);
  }
});

test('标注在每一行上重复出现，值一律是布尔（缺席会被读成「查过了没事」）', () => {
  const a = annotations({ stale: true, offline: true });
  assert.deepEqual(Object.keys(a).sort(), ['degraded', 'offline', 'shadowed', 'stale', 'yanked']);
  for (const v of Object.values(a)) assert.equal(typeof v, 'boolean');
  assert.equal(annotationSuffix(a), ' [stale] [offline]');
  assert.equal(annotationSuffix(annotations()), '');
});

test('🔴 CLI 自报版本必须等于 package.json —— 不许是硬编码的字面量', () => {
  // 2026-09-03 首次端到端安装撞到：这里原本硬编码 '0.0.0-m1'，
  // 而 `bin/skills-hub.mjs` 一个 dep 都不传 —— 于是**发布出去的 CLI
  // 自报 0.0.0-m1，被自己的 timestamp.min_cli_version 当场挡死**。
  // ⚠️ 这不是显示问题：min_cli_version 是按真实版本号比对的策略门。
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(ownVersion(), pkg.version);
  // 且它必须真的进到 context 里（不是只有这个函数对）
  const g = parseGlobals([]);
  const ctx = makeContext(g.globals ?? g, { env: {}, home: '/tmp/x', cwd: '/tmp/x' });
  assert.equal(ctx.cliVersion, pkg.version, 'makeContext 没把真实版本号带进去');
});
