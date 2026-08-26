import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENTS,
  SCOPES,
  STATE_DIR,
  listAdapters,
  getAdapter,
  gateMatrix,
  enabledCombos,
  resolveTarget,
  planTargets,
  assertPlanOk,
  classifyGate,
  assertGateInvariants,
  buildAdapters,
  TEST_GATES,
  gitignorePatternsFor,
  GIT_CLEAN_WARNING,
  GATE_PASSED,
  GATE_PENDING,
  GATE_UNSUPPORTED,
} from '../src/adapters/index.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'adp-'));

// ── §2.3 路径表 ──────────────────────────────────────────────────────────────

test('§2.3 四端 × 全局/项目级的 config root 与 target 路径', () => {
  const home = '/home/u';
  const projectRoot = '/repo';
  const env = {};
  const expected = {
    claude: ['/home/u/.claude', '/home/u/.claude/skills', '/repo/.claude/skills'],
    cursor: ['/home/u/.cursor', '/home/u/.cursor/skills', '/repo/.cursor/skills'],
    codex: ['/home/u/.codex', '/home/u/.codex/skills', '/repo/.codex/skills'],
    agents: ['/home/u/.agents', '/home/u/.agents/skills', '/repo/.agents/skills'],
  };
  assert.deepEqual(CLIENTS.slice(), ['claude', 'cursor', 'codex', 'agents']);
  for (const a of listAdapters()) {
    const [cr, g, p] = expected[a.client];
    assert.equal(a.configRoot({ home, env }), cr, `${a.client} configRoot`);
    assert.equal(a.root({ scope: 'global', home, env }), g, `${a.client} global`);
    assert.equal(a.root({ scope: 'project', home, env, projectRoot }), p, `${a.client} project`);
  }
});

test('codex 认 $CODEX_HOME —— 门就是在那个路径上测的，adapter 必须指同一处', () => {
  const codex = getAdapter('codex');
  const env = { CODEX_HOME: '/opt/cx' };
  assert.equal(codex.configRoot({ home: '/home/u', env }), '/opt/cx');
  assert.equal(codex.root({ scope: 'global', home: '/home/u', env }), '/opt/cx/skills');
  // 🔴 项目级不看 CODEX_HOME：那是用户的家目录，不是这个仓库里的 codex 目录
  assert.equal(
    codex.root({ scope: 'project', home: '/home/u', env, projectRoot: '/repo' }),
    '/repo/.codex/skills',
  );
  assert.throws(() => codex.configRoot({ home: '/home/u', env: { CODEX_HOME: 'rel' } }), /绝对路径/);
});

test('别的 client 不受 $CODEX_HOME 影响', () => {
  const env = { CODEX_HOME: '/opt/cx' };
  for (const c of ['claude', 'cursor', 'agents']) {
    assert.equal(getAdapter(c).root({ scope: 'global', home: '/home/u', env }), `/home/u/.${c}/skills`);
  }
});

test('scope / client 校验', () => {
  assert.throws(() => getAdapter('vscode'), /未知 client/);
  assert.throws(() => getAdapter('claude').root({ scope: 'system', home: '/h' }), /未知 scope/);
  assert.throws(() => getAdapter('claude').root({ scope: 'project', home: '/h' }), /需要 projectRoot/);
  assert.throws(
    () => getAdapter('claude').root({ scope: 'project', home: '/h', projectRoot: 'rel' }),
    /绝对路径/,
  );
});

// ── §3.2 layout ──────────────────────────────────────────────────────────────

test('layout 枚举出全部状态路径（预检要遍历它）', () => {
  const l = getAdapter('claude').layout({ scope: 'global', home: '/home/u', env: {} });
  assert.equal(l.target, '/home/u/.claude/skills');
  assert.equal(l.state, `/home/u/.claude/skills/${STATE_DIR}`);
  for (const k of ['lockDb', 'lockWal', 'lockShm', 'generation', 'ledger', 'auditSeq',
    'journalDir', 'atticDir', 'quarantineDir', 'auditArchiveDir', 'repairIntent',
    'auditArchiveIntent']) {
    assert.ok(l[k].startsWith(l.state + '/'), `${k} 必须在 .geoly 之下：${l[k]}`);
  }
});

// ── exists 不是失败 ──────────────────────────────────────────────────────────

test('§2.3 config root 不存在 = skipped，不是失败', () => {
  const home = tmp();
  const a = getAdapter('claude');
  assert.equal(a.exists({ home, env: {} }), false);
  mkdirSync(join(home, '.claude'), { recursive: true });
  assert.equal(a.exists({ home, env: {} }), true);
  assert.equal(a.targetExists({ scope: 'global', home, env: {} }), false);
  mkdirSync(join(home, '.claude', 'skills'));
  assert.equal(a.targetExists({ scope: 'global', home, env: {} }), true);
});

// ── Q12 门 ───────────────────────────────────────────────────────────────────

test('Q12 门矩阵：八个组合齐全，每条都有 evidence', () => {
  const m = gateMatrix();
  assert.equal(m.length, CLIENTS.length * SCOPES.length);
  for (const row of m) {
    assert.ok([GATE_PASSED, GATE_PENDING, GATE_UNSUPPORTED].includes(row.status), row.status);
    // 🔴 没有证据的 passed 就是伪造证据
    assert.ok(row.evidence && row.evidence.length > 20, `${row.client}/${row.scope} 缺 evidence`);
    if (row.status === GATE_PASSED) assert.ok(/00-gates\.md/.test(row.evidence));
    // enabled 必须与 status 一致，不能各说各话
    assert.equal(row.enabled, row.status === GATE_PASSED, `${row.client}/${row.scope} enabled 不一致`);
    // enabledCombos 必须是 gateMatrix 里 enabled 的那一批，不能是另算一遍
    assert.equal(
      enabledCombos().some((r) => r.client === row.client && r.scope === row.scope),
      row.enabled,
    );
  }
});

test('🔴 agents 两个 scope 都是 unsupported，理由是 no-reader（不是「.geoly 被误认」）', () => {
  for (const scope of SCOPES) {
    const g = getAdapter('agents').gate(scope);
    assert.equal(g.status, GATE_UNSUPPORTED);
    assert.equal(g.reason, 'no-reader');
    if (scope === 'global') assert.match(g.evidence, /grep -F/);
    assert.match(g.evidence, /无读者|命中数为 0/);
    assert.equal(getAdapter('agents').supports(scope), false);
  }
});

test('🔴 supports() 只认 passed —— 没有任何参数能放行 pending/unsupported', () => {
  for (const c of CLIENTS) {
    for (const s of SCOPES) {
      const expected = getAdapter(c).gate(s).status === GATE_PASSED;
      assert.equal(getAdapter(c).supports(s), expected, `${c}/${s}`);
      // 传什么参数都一样：门不是建议
      assert.equal(getAdapter(c).supports(s, { allowPending: true, force: true }), expected);
    }
  }
});

test('🔴 门记录深冻结 —— 调用方改不了 status 来放行', () => {
  const g = getAdapter('claude').gate('global');
  assert.throws(() => { g.status = GATE_PASSED; }, TypeError);
  assert.equal(getAdapter('claude').gate('global').status, GATE_PENDING);
  assert.equal(getAdapter('claude').supports('global'), false);
  assert.throws(() => resolveTarget({ client: 'claude', scope: 'global', home: '/h' }), /阻塞门未闭合/);
});

test('🔴 Q12 要求门绑定客户端版本：passed 必须带 clientVersion', () => {
  for (const row of gateMatrix()) {
    if (row.status === GATE_PASSED) {
      assert.ok(row.clientVersion, `${row.client}/${row.scope} 标 passed 却没有 clientVersion`);
    }
  }
});

test('🔴 codex/global 证据完整，卡的是范围决策而不是证据', () => {
  // ⚠️ 这两种 pending 不能混：`scope-decision-pending` 拍个板就能开，
  // `client-version-unrecorded` 要重新做实验。早先这一格标成后者，
  // 而文档里已经记了版本号 —— 两者矛盾（Codex 2026-08-26 验收时指出）。
  const g = getAdapter('codex').gate('global');
  assert.equal(g.status, GATE_PENDING);
  assert.equal(g.blockedOn, 'scope-decision-pending');
  assert.match(g.clientVersion ?? '', /^codex-cli \d+\.\d+\.\d+$/, '证据完整就必须带版本号');
  // evidence 必须说清测量为什么有效，否则下一轮会被当成没测过
  assert.match(g.evidence, /catalog_entries 仍为 6|未被识别为 skill/);
  assert.match(g.evidence, /正对照 5→6/);
});

test('🔴 缺证据的格子不能冒充「只是没拍板」', () => {
  // claude / cursor / 各项目级是真的没测过，它们的 blockedOn 不能是 scope-decision
  for (const [client, scope] of [
    ['claude', 'global'], ['claude', 'project'],
    ['cursor', 'global'], ['cursor', 'project'],
    ['codex', 'project'],
  ]) {
    const g = getAdapter(client).gate(scope);
    assert.equal(g.status, GATE_PENDING, `${client}/${scope}`);
    assert.notEqual(g.blockedOn, 'scope-decision-pending', `${client}/${scope} 是真缺证据，不是缺决策`);
    assert.equal(g.clientVersion, null, `${client}/${scope} 没测过就不该有版本号`);
  }
});

test('🔴 unsupported 与 pending 的报错必须分得出来', () => {
  assert.throws(
    () => resolveTarget({ client: 'agents', scope: 'global', home: '/h' }),
    /标为不支持.*no-reader/s,
  );
  assert.throws(
    () => resolveTarget({ client: 'agents', scope: 'global', home: '/h', allowPending: true }),
    /没有开关能放行/,
  );
  assert.throws(
    () => resolveTarget({ client: 'claude', scope: 'global', home: '/h' }),
    /阻塞门未闭合/,
  );
  // 🔴 传 allowPending 也没用 —— 那会把阻塞门降级成建议
  assert.throws(
    () => resolveTarget({ client: 'claude', scope: 'global', home: '/h', allowPending: true }),
    /没有 --allow-pending 这种开关/,
  );
});

// 🔴 合成门表：真门表现在一个组合都没闭合，拿它测 supports()/enabledCombos()
// 等于在空集上断言 —— 实现恒返回 false / [] 也会全绿。用一套自造的 def 来证明
// 这三个函数**确实是从门状态推出来的**。
const SYNTH = buildAdapters([
  {
    client: 'alpha',
    dirName: '.alpha',
    envHome: null,
    postInstallHint: 'x',
    gates: {
      global: { status: GATE_PASSED, clientVersion: '1.2.3', evidence: 'synthetic evidence for test' },
      project: { status: GATE_PENDING, evidence: 'synthetic evidence for test' },
    },
  },
  {
    client: 'beta',
    dirName: '.beta',
    envHome: null,
    postInstallHint: null,
    gates: {
      global: { status: GATE_UNSUPPORTED, reason: 'no-reader', evidence: 'synthetic evidence for test' },
      project: { status: GATE_PASSED, clientVersion: '4.5.6', evidence: 'synthetic evidence for test' },
    },
  },
]);

test('🔴 supports() / gateMatrix() / enabledCombos() 确实由门状态推出（合成门表，非空）', () => {
  const [alpha, beta] = SYNTH.list;
  assert.equal(alpha.supports('global'), true, 'passed 必须 true —— 否则就是恒 false');
  assert.equal(alpha.supports('project'), false);
  assert.equal(beta.supports('global'), false);
  assert.equal(beta.supports('project'), true);

  const m = gateMatrix(SYNTH.list);
  assert.deepEqual(
    m.map((r) => `${r.client}/${r.scope}=${r.status}`),
    ['alpha/global=passed', 'alpha/project=pending',
      'beta/global=unsupported', 'beta/project=passed'],
  );
  // 每一行都要能对回真正的 gate 记录
  for (const r of m) {
    const a = SYNTH.list.find((x) => x.client === r.client);
    assert.equal(r.status, a.gate(r.scope).status);
    assert.equal(r.clientVersion, a.gate(r.scope).clientVersion ?? null);
  }

  const enabled = enabledCombos(SYNTH.list);
  assert.deepEqual(enabled.map((r) => `${r.client}/${r.scope}`), ['alpha/global', 'beta/project']);
  assert.throws(() => { enabled[0].status = GATE_PENDING; }, TypeError); // 元素也冻结
});

test('🔴 合成门表授权不了安装 —— 它的门记录不在 REAL_GATES 里', () => {
  const [alpha] = SYNTH.list;
  // 它自己说 supports=true
  assert.equal(alpha.supports('global'), true);
  // 但 resolveTarget 只认自己门表里的 client，合成的根本不存在
  assert.throws(() => resolveTarget({ client: 'alpha', scope: 'global', home: '/h' }), /未知 client/);
});

test('🔴 目前没有任何组合闭合了 Q12 —— enabledCombos 为空，且没有开关能扩大它', () => {
  // gates 只记录了 codex 全局那一次读数，且没记客户端版本；
  // 版本没记 = 门没绑定版本 = Q12 没闭合。这是**当前证据的如实反映**，
  // 不是实现缺陷：补上版本号，codex/global 立刻进这个集合。
  assert.deepEqual(enabledCombos(), []);
  // 上面的合成门表证明了「非空时它会非空」，所以这里的空不是恒空
  assert.equal(enabledCombos(SYNTH.list).length, 2);
});

test('resolveTarget 对已过门的组合返回完整描述（无组合过门时走 layout 验路径）', () => {
  // 目前一个组合都没闭合，所以这里验的是路径/base 的派生本身
  const codex = getAdapter('codex');
  const o = { scope: 'global', home: '/home/u', env: {} };
  const t = { ...codex.layout(o), base: codex.trustedBase(o) };
  assert.equal(t.target, '/home/u/.codex/skills');
  assert.equal(t.state, '/home/u/.codex/skills/.geoly');
  assert.equal(t.base, '/home/u'); // 可信 base = $HOME
  // 项目级同理：路径与可信 base 要算得出来（门本身的 fixture 就得靠它），
  // 走不判门的 adapter.layout / trustedBase
  const po = { scope: 'project', home: '/home/u', env: {}, projectRoot: '/repo' };
  assert.equal(codex.layout(po).target, '/repo/.codex/skills');
  assert.equal(codex.trustedBase(po), '/repo'); // 项目级的可信 base = repo 根
});

test('🔴 $CODEX_HOME 下的可信 base 是它的父，不是它自己', () => {
  const codex = getAdapter('codex');
  const o = { scope: 'global', home: '/home/u', env: { CODEX_HOME: '/opt/cx' } };
  // 取 CODEX_HOME 自己当 base 等于先 realpath 掉它，把「CODEX_HOME 本身是 symlink」放过去
  assert.equal(codex.trustedBase(o), '/opt');
  assert.equal(codex.layout(o).target, '/opt/cx/skills');
});

// ── §3.3 gitignore ──────────────────────────────────────────────────────────

test('🔴 gitignore 忽略的是 adapter 派生的实际路径，不是根上的 /.geoly/', () => {
  const pats = gitignorePatternsFor(['claude', 'cursor']);
  assert.deepEqual(pats, ['/.claude/skills/.geoly/', '/.cursor/skills/.geoly/']);
  assert.ok(!pats.includes('/.geoly/'), 'v8 在这里写错过：根上的 /.geoly/ 是错的');
  assert.deepEqual(gitignorePatternsFor(), [
    '/.claude/skills/.geoly/',
    '/.cursor/skills/.geoly/',
    '/.codex/skills/.geoly/',
    '/.agents/skills/.geoly/',
  ]);
});

test('git clean -xfd 的提示必须点明审计历史也会被删', () => {
  assert.match(GIT_CLEAN_WARNING, /git clean -xfd/);
  assert.match(GIT_CLEAN_WARNING, /审计历史/);
  assert.match(GIT_CLEAN_WARNING, /audit-archive/);
});

test('postInstallHint：unsupported 端没有提示', () => {
  assert.equal(getAdapter('agents').postInstallHint(), null);
  for (const c of ['claude', 'cursor', 'codex']) {
    assert.ok(getAdapter(c).postInstallHint().length > 0);
  }
});

test('adapter 表冻结，调用方改不了（门不能被就地篡改）', () => {
  const a = getAdapter('claude');
  assert.throws(() => { a.client = 'x'; }, TypeError);
});

// ── §2.3 默认目标 vs 显式 --clients ──────────────────────────────────────────

/** 假装某个组合已闭合门，用来测「门过了之后」的分支（真门表现在一个都没闭合）。 */
const PASSED_CODEX = {
  'codex/global': { status: GATE_PASSED, clientVersion: '0.0.0-test', evidence: 'test' },
  'codex/project': { status: GATE_PASSED, clientVersion: '0.0.0-test', evidence: 'test' },
};

test('🔴 门一个都没闭合时，默认目标全部 skipped —— 不是失败，也没有 selected', () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  const p = planTargets({ home, env: {}, scope: 'global' });
  assert.equal(p.ok, true, '默认目标下「都跳过」不是失败');
  assert.deepEqual(p.selected, []);
  assert.ok(p.skipped.some((s) => s.client === 'claude' && s.reason === 'gate-pending'));
  assert.ok(p.skipped.some((s) => s.client === 'codex' && s.reason === 'gate-pending'));
  assert.ok(p.skipped.some((s) => s.client === 'agents' && s.reason === 'gate-unsupported'));
});

test('§2.3 默认目标：门过了但目录不存在 → skipped: missing-dir', () => {
  const home = tmp(); // 什么都没建
  const p = planTargets({ home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX });
  assert.deepEqual(p.selected, []);
  const s = p.skipped.find((x) => x.client === 'codex');
  assert.equal(s.reason, 'missing-dir');
  assert.match(s.message, /不存在/);
});

test('§2.3 默认目标：门过了且目录在 → selected', () => {
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  const p = planTargets({ home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX });
  assert.deepEqual(p.selected.map((t) => t.client), ['codex']);
  assert.equal(p.selected[0].target, join(home, '.codex', 'skills'));
  assert.equal(p.selected[0].willCreate, false);
});

test('🔴 §2.3 显式 --clients 里含装不了的端 = 硬错误，且整批不执行', () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  const p = planTargets({
    clients: ['claude', 'codex'], home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX,
  });
  assert.equal(p.explicit, true);
  assert.equal(p.ok, false);
  assert.equal(p.skipped.length, 0, '显式点名不该出现 skipped');
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /claude\/global 的 Q12 门是 pending/);
  // 🔴 「兼容性不是部分失败」：调用方忘了看 errors，最坏也只是什么都没装
  assert.deepEqual(p.selected, []);
  assert.deepEqual(p.wouldSelect.map((t) => t.client), ['codex']);
});

test('🔴 --create-missing 只管目录，管不了门', () => {
  const home = tmp();
  const p = planTargets({
    home, env: {}, scope: 'global', createMissing: true, [TEST_GATES]: PASSED_CODEX,
  });
  assert.deepEqual(p.selected.map((t) => t.client), ['codex']);
  assert.equal(p.selected[0].willCreate, true);
  // claude 仍然因为门被跳过，不因 createMissing 进来
  assert.ok(p.skipped.some((s) => s.client === 'claude' && s.reason === 'gate-pending'));
});

test('🔴 项目级判的是 <repo>/.codex，不是 $HOME/.codex', () => {
  const home = tmp();
  const projectRoot = tmp();
  mkdirSync(join(home, '.codex')); // 全局有，项目里没有
  const p = planTargets({
    scope: 'project', home, env: {}, projectRoot, [TEST_GATES]: PASSED_CODEX,
  });
  assert.deepEqual(p.selected, [], '不该拿 $HOME/.codex 当项目里有');
  assert.equal(p.skipped.find((s) => s.client === 'codex').reason, 'missing-dir');

  mkdirSync(join(projectRoot, '.codex'));
  const p2 = planTargets({
    scope: 'project', home, env: {}, projectRoot, [TEST_GATES]: PASSED_CODEX,
  });
  assert.equal(p2.selected[0].target, join(projectRoot, '.codex', 'skills'));
  assert.equal(p2.selected[0].base, projectRoot);
});

test('🔴 注入过门表的计划不得用来放行安装', () => {
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  const p = planTargets({ home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX });
  assert.equal(p.gatesOverridden, true);
  assert.throws(() => assertPlanOk(p), /不得用来放行安装/);
  // 没注入的计划正常放行
  assert.equal(assertPlanOk(planTargets({ home, env: {}, scope: 'global' })).ok, true);
});

test('🔴 篡改 gatesOverridden 不能放行 —— 判据不在对象字段里', () => {
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  const p = planTargets({ home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX });
  // 计划已冻结，改不了
  assert.throws(() => { p.gatesOverridden = false; }, TypeError);
  // 就算另造一个一模一样的对象，也进不了白名单
  const forged = { ...p, gatesOverridden: false, ok: true };
  assert.throws(() => assertPlanOk(forged), /不得用来放行安装/);
  assert.throws(() => assertPlanOk({ ok: true, gatesOverridden: false }), /不得用来放行安装/);
});

test('🔴 selected 元素与门快照都冻结，改不了 target/status', () => {
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  const p = planTargets({ home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX });
  assert.throws(() => { p.selected[0].target = '/etc'; }, TypeError);
  assert.throws(() => { p.selected.push({}); }, TypeError);
  assert.throws(() => { p.wouldSelect[0].client = 'x'; }, TypeError);
  assert.throws(() => { p.wouldSelect.push({}); }, TypeError);
  assert.throws(() => { p.skipped.push({}); }, TypeError);
  const m = gateMatrix();
  assert.throws(() => { m[0].status = GATE_PASSED; }, TypeError);
  assert.throws(() => { m.push({}); }, TypeError);
  assert.throws(() => { enabledCombos().push({}); }, TypeError);
});

test('🔴 目录读不了（EACCES）不能被当成「不存在」去创建', () => {
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  chmodSync(home, 0o000); // 对 $HOME/.codex 的 stat 吃 EACCES
  try {
    const p = planTargets({
      home, env: {}, scope: 'global', createMissing: true, [TEST_GATES]: PASSED_CODEX,
    });
    const sel = p.selected.find((t) => t.client === 'codex');
    assert.ok(sel, '存在但读不了 → 仍然算存在');
    assert.equal(sel.willCreate, false, '🔴 不能去「创建」一个已经在那儿的目录');
  } finally {
    chmodSync(home, 0o755);
  }
});

// ── 门放行判据（纯函数，可用合成门记录非空地测每一支） ──────────────────────

test('classifyGate：只有 passed 是 allow，未知 status 走默认拒绝', () => {
  assert.equal(classifyGate({ status: GATE_PASSED, clientVersion: '1.0', evidence: 'e' }).decision,
    'allow');
  const pend = classifyGate({ status: GATE_PENDING, blockedOn: 'b', evidence: 'e' });
  assert.equal(pend.decision, 'deny-gate-open');
  assert.match(pend.detail, /blockedOn=b/);
  const uns = classifyGate({ status: GATE_UNSUPPORTED, reason: 'no-reader', evidence: 'e' });
  assert.equal(uns.decision, 'deny-unsupported');
  assert.match(uns.detail, /no-reader/);
  // 🔴 拼错的字面量必须落到拒绝，不能静默放行
  for (const bad of ['passsed', undefined, null, 0, 'PASSED']) {
    assert.equal(classifyGate({ status: bad, evidence: 'e' }).decision, 'deny-gate-open', String(bad));
  }
  assert.equal(classifyGate(undefined).decision, 'deny-gate-open');
});

test('🔴 classifyGate 不是授权函数 —— 伪造的门记录进不了 resolveTarget', () => {
  // 它对一个字面量当然说 allow：那只是分类
  assert.equal(classifyGate({ status: GATE_PASSED }).decision, 'allow');
  // 但真正的放行还要求门记录来自本模块的门表，伪造的进不去
  const forged = { status: GATE_PASSED, clientVersion: '9', evidence: 'forged' };
  const fake = { ...getAdapter('claude'), gate: () => forged };
  assert.throws(
    () => resolveTarget({ client: 'claude', scope: 'global', home: '/h' }),
    /阻塞门未闭合/,
    'resolveTarget 只查自己门表里的那条记录',
  );
  assert.equal(fake.gate('global'), forged); // 伪造对象存在，但 resolveTarget 不会去读它
});

test('🔴 门不变量：passed 必须带 clientVersion（用合成门表非空地测）', () => {
  const mk = (g) => [{ client: 'x', gates: { global: g, project: g } }];
  assert.throws(
    () => assertGateInvariants(mk({ status: GATE_PASSED, evidence: 'e' })),
    /没有 clientVersion/,
  );
  assert.throws(
    () => assertGateInvariants(mk({ status: 'typo', evidence: 'e', clientVersion: '1' })),
    /门状态非法/,
  );
  assert.throws(() => assertGateInvariants(mk({ status: GATE_PENDING })), /缺 evidence/);
  assert.throws(() => assertGateInvariants([{ client: 'x', gates: {} }]), /缺 global 的门记录/);
  assert.doesNotThrow(() =>
    assertGateInvariants(mk({ status: GATE_PASSED, evidence: 'e', clientVersion: '1.2.3' })));
});

test('🔴 client 目录被普通文件占了 → dir-conflict，不是 missing（--create-missing 解决不了）', () => {
  const home = tmp();
  writeFileSync(join(home, '.codex'), 'x'); // 普通文件占了位
  const p = planTargets({
    home, env: {}, scope: 'global', createMissing: true, [TEST_GATES]: PASSED_CODEX,
  });
  assert.deepEqual(p.selected, [], '不能去「创建」一个已经被占的路径');
  const s = p.skipped.find((x) => x.client === 'codex');
  assert.equal(s.reason, 'dir-conflict');
  assert.match(s.message, /非目录占用/);
  // 显式点名时是硬错误
  const e = planTargets({
    clients: ['codex'], home, env: {}, scope: 'global', createMissing: true,
    [TEST_GATES]: PASSED_CODEX,
  });
  assert.equal(e.ok, false);
  assert.match(e.errors[0], /非目录占用/);
});

test('planTargets 遇到未知 client 直接抛', () => {
  assert.throws(() => planTargets({ clients: ['vscode'], home: '/h' }), /未知 client/);
});

// ── $CODEX_HOME 的 base 语义 ────────────────────────────────────────────────

test('🔴 $CODEX_HOME 尚未创建时，预检不该把 ENOENT 说成路径链有 symlink', () => {
  const parent = tmp();
  const cx = join(parent, 'new-codex'); // 故意不创建
  const codex = getAdapter('codex');
  const o = { scope: 'global', home: '/home/u', env: { CODEX_HOME: cx } };
  // base 取的是 CODEX_HOME 的**父**（存在），于是 realpath(base) 不会 ENOENT，
  // 同时 CODEX_HOME 这一层本身是不是 symlink 也进了检查范围
  assert.equal(codex.trustedBase(o), parent);
  assert.equal(codex.layout(o).target, join(cx, 'skills'));
});
