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
  BLOCKED_ON_SCOPE_DECISION,
  BLOCKED_ON_NO_RUNTIME,
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

test('🔴 agents 的 no-reader 结论已被实测推翻 —— 不能再标 unsupported', () => {
  // 早先的判据是「固定串 grep 命中 0 ⇒ 没有读者」。那是**假阴性**：路径是运行时
  // join 拼出来的，二进制里没有这个连续子串。实测 codex-cli 0.147.0 确实读
  // `$HOME/.agents/skills` 与 `<cwd>/.agents/skills`（正对照 5 → 6）。
  //
  // 🔴 这条测试盯的是**不许倒退**：谁要是再把它改回 unsupported/no-reader，
  //    就得先解释怎么绕过那次正对照 —— 而不是把一次搜不到当成不存在。
  for (const scope of SCOPES) {
    const g = getAdapter('agents').gate(scope);
    assert.notEqual(g.status, GATE_UNSUPPORTED, `agents/${scope} 的 no-reader 是假阴性，不能再标不支持`);
    assert.equal(g.status, GATE_PENDING);
    // 证据完整（跑过客户端、有读者版本号），卡的是范围决策
    assert.equal(g.blockedOn, BLOCKED_ON_SCOPE_DECISION);
    assert.match(g.clientVersion ?? '', /^codex-cli \d+\.\d+\.\d+$/);
    // 🔴 evidence 必须写明读者是谁 —— .agents 没有自己的客户端，
    //    版本号记的是 codex 的版本，不写清楚下一个人会以为存在 agents 客户端
    assert.match(g.evidence, /读者是 codex-cli|读者同为 codex-cli/);
    assert.match(g.evidence, /推翻|假阴性|证明不了没有读者|范围决策同 global/);
    // 还没拍板，所以仍然装不了
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
  const g = getAdapter('cursor').gate('global');
  assert.throws(() => { g.status = GATE_PASSED; }, TypeError);
  assert.equal(getAdapter('cursor').gate('global').status, GATE_PENDING);
  assert.equal(getAdapter('cursor').supports('global'), false);
  assert.throws(() => resolveTarget({ client: 'cursor', scope: 'global', home: '/h' }), /阻塞门未闭合/);
});

test('🔴 Q12 要求门绑定客户端版本：passed 必须带 clientVersion', () => {
  for (const row of gateMatrix()) {
    if (row.status === GATE_PASSED) {
      assert.ok(row.clientVersion, `${row.client}/${row.scope} 标 passed 却没有 clientVersion`);
    }
  }
});

test('🔴 实测通过的四格：必须带版本号，且 evidence 要能自证测量是敏感的', () => {
  // 🔴 Q12 的历史教训是「读数不动 ≠ 没影响」。所以一条 passed 的 evidence 里
  //    **必须能读到正对照动过**；只写「放进去没事」的证据是不可复核的。
  for (const [client, scope, ver] of [
    ['claude', 'global', /^claude-code \d+\.\d+\.\d+$/],
    ['claude', 'project', /^claude-code \d+\.\d+\.\d+$/],
    ['codex', 'global', /^codex-cli \d+\.\d+\.\d+$/],
    ['codex', 'project', /^codex-cli \d+\.\d+\.\d+$/],
  ]) {
    const g = getAdapter(client).gate(scope);
    assert.equal(g.status, GATE_PASSED, `${client}/${scope}`);
    assert.match(g.clientVersion ?? '', ver, `${client}/${scope} passed 必须绑定版本`);
    assert.equal(g.blockedOn, undefined, `${client}/${scope} 过了的门不该还有 blocker`);
    // 正对照的读数变化必须写在证据里（形如 5 → 6 / 15 → 16）
    assert.match(g.evidence, /正对照/, `${client}/${scope} evidence 里没有正对照`);
    assert.match(g.evidence, /\d+\s*→\s*\d+/, `${client}/${scope} evidence 里没有前后读数`);
    assert.match(g.evidence, /canary/, `${client}/${scope} evidence 里没有 canary 判据`);
    assert.equal(getAdapter(client).supports(scope), true);
  }
});

test('🔴 codex 与 claude 靠的不是同一道保护 —— 证据里要写清是哪一道', () => {
  // codex：扫描**递归**，挡住 .geoly 的是点目录过滤。
  // claude：**不过滤点目录**，挡住 .geoly 的是扫描不递归。
  // 两端各只有一道保护，且不是同一道 —— 任一端改扫描策略都要复测，
  // 所以这个事实必须留在证据里，不能只留一个「通过」。
  assert.match(getAdapter('codex').gate('global').evidence, /同深度正对照/);
  assert.match(getAdapter('claude').gate('global').evidence, /深度 1 正对照/);
});

test('🔴 缺证据的格子不能冒充「只是没拍板」', () => {
  // cursor 两格是真的没有任何运行时读数（本机跑不起客户端），
  // 它们的 blockedOn 不能是 scope-decision —— 那会让人以为拍个板就能开。
  for (const [client, scope] of [['cursor', 'global'], ['cursor', 'project']]) {
    const g = getAdapter(client).gate(scope);
    assert.equal(g.status, GATE_PENDING, `${client}/${scope}`);
    assert.equal(g.blockedOn, BLOCKED_ON_NO_RUNTIME, `${client}/${scope}`);
    assert.notEqual(g.blockedOn, BLOCKED_ON_SCOPE_DECISION, `${client}/${scope} 是真缺证据，不是缺决策`);
    assert.equal(g.clientVersion, null, `${client}/${scope} 没跑过客户端就不该有版本号`);
  }
});

test('🔴 cursor 不是中性的「还没测」—— 静态分析预判失败，证据里必须留着这句', () => {
  // ⚠️ 这一格最危险的失误不是漏测，而是**被当成大概率能过**然后顺手翻绿。
  //    实际读到的机制是两道保护都没有：递归扫描 + 不过滤点目录。
  for (const scope of SCOPES) {
    const g = getAdapter('cursor').gate(scope);
    assert.match(g.evidence, /本机无法测量|本机跑不起/, `cursor/${scope} 要写清为什么测不了`);
    assert.match(g.evidence, /预判失败/, `cursor/${scope} 必须写明静态分析指向失败`);
    assert.match(g.evidence, /递归/, `cursor/${scope} 要写清预判失败的机制`);
  }
  // 要闭合它得写清缺什么，否则「本机测不了」会变成永久借口
  assert.match(getAdapter('cursor').gate('global').evidence, /登录 cursor-agent|装 Cursor IDE/);
});

test('🔴 unsupported 与 pending 的报错必须分得出来', () => {
  // ⚠️ 真门表里**已经没有 unsupported 的格子**（agents 的 no-reader 被推翻）。
  //    所以 unsupported 这一支只能用 classifyGate 非空地验，
  //    拿真表验等于测空集 —— 那正是这套测试一直在防的事。
  const uns = classifyGate({ status: GATE_UNSUPPORTED, reason: 'no-reader', evidence: 'e' });
  assert.equal(uns.decision, 'deny-unsupported');
  assert.match(uns.detail, /标为不支持.*no-reader/s);
  assert.match(uns.detail, /没有开关能放行/);

  // pending 走真门表：cursor 两格确实还没闭合
  assert.throws(
    () => resolveTarget({ client: 'cursor', scope: 'global', home: '/h' }),
    /阻塞门未闭合/,
  );
  // 🔴 传 allowPending 也没用 —— 那会把阻塞门降级成建议
  assert.throws(
    () => resolveTarget({ client: 'cursor', scope: 'global', home: '/h', allowPending: true }),
    /没有 --allow-pending 这种开关/,
  );
  // blockedOn 要出现在报错里，用户才分得清是去跑门还是去拍板
  assert.throws(
    () => resolveTarget({ client: 'agents', scope: 'global', home: '/h' }),
    /scope-decision-pending/,
  );
});

// 🔴 合成门表：真门表里 unsupported 这一档现在**一个格子都没有**（agents 的
// no-reader 结论已被实测推翻），拿真表去测 `deny-unsupported` 分支等于测空集。
// 合成表同时还证明这三个函数**确实是从门状态推出来的**，而不是碰巧返回了对的东西。
const SYNTH = buildAdapters([
  {
    client: 'alpha',
    dirName: '.alpha',
    envHome: null,
    postInstallHint: 'x',
    gates: {
      global: { status: GATE_PASSED, clientVersion: '1.2.3', evidence: 'synthetic evidence for test' },
      project: {
        status: GATE_PENDING,
        blockedOn: BLOCKED_ON_NO_RUNTIME,
        clientVersion: null, // 🔴 缺证据的格子必须显式写 null，缺席都不行
        evidence: 'synthetic evidence for test',
      },
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

test('🔴 enabledCombos 恰好是实测通过的那四格 —— 不多不少', () => {
  // 2026-08-26 逐格实测：claude 与 codex 的两个 scope 都过了。
  // cursor 两格没有运行时证据、agents 两格等范围决策，一个都不许混进来。
  assert.deepEqual(
    enabledCombos().map((r) => `${r.client}/${r.scope}`).sort(),
    ['claude/global', 'claude/project', 'codex/global', 'codex/project'],
  );
  // 🔴 每一格都得带版本号：没有版本就没法在客户端升级后复测
  for (const r of enabledCombos()) assert.ok(r.clientVersion, `${r.client}/${r.scope}`);
  // 没测过 / 没拍板的一格都不许进
  for (const c of ['cursor', 'agents']) {
    assert.ok(
      !enabledCombos().some((r) => r.client === c),
      `${c} 还没闭合，不该出现在 enabledCombos 里`,
    );
  }
  // 合成门表证明这个集合是从门状态推出来的，不是写死的
  assert.equal(enabledCombos(SYNTH.list).length, 2);
});

test('🔴 blockedOn 的两类与 clientVersion 死死绑住 —— 缺证据的格子伪装不了缺决策', () => {
  // 这是模块加载期不变量，用合成 def 非空地验两个方向
  const mk = (gates) => () => buildAdapters([
    { client: 'z', dirName: '.z', envHome: null, postInstallHint: null, gates },
  ]);
  const ok = { status: GATE_PASSED, clientVersion: '1.0.0', evidence: 'synthetic evidence for test' };
  // 缺决策却没有版本号 = 其实没跑过门
  assert.throws(mk({
    global: ok,
    project: { status: GATE_PENDING, blockedOn: BLOCKED_ON_SCOPE_DECISION, evidence: 'synthetic evidence for test' },
  }), /必须带 clientVersion/);
  // 缺证据却带版本号 = 冒充测过
  assert.throws(mk({
    global: ok,
    project: { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, clientVersion: '9.9.9', evidence: 'synthetic evidence for test' },
  }), /冒充测过/);
  // 🔴 缺证据的格子**必须显式写 null** —— 把那一行删掉（字段缺席）也不行。
  //    只查真假的话，删一行就能悄悄绕过去，而删一行正是 review 最容易滑过的改动。
  assert.throws(mk({
    global: ok,
    project: { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, evidence: 'synthetic evidence for test' },
  }), /必须显式写成 null/);
  // 真门表里 cursor 两格就得满足这条
  for (const scope of SCOPES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(getAdapter('cursor').gate(scope), 'clientVersion'),
      `cursor/${scope} 必须显式带 clientVersion 字段`,
    );
    assert.strictEqual(getAdapter('cursor').gate(scope).clientVersion, null);
  }
  // 自由文本的 blocker 不认
  assert.throws(mk({
    global: ok,
    project: { status: GATE_PENDING, blockedOn: 'almost-there', evidence: 'synthetic evidence for test' },
  }), /没有已知的 blockedOn/);
  // passed 不得带 blocker
  assert.throws(mk({
    global: { ...ok, blockedOn: BLOCKED_ON_SCOPE_DECISION },
    project: ok,
  }), /既是 passed 又带 blockedOn/);
  // unsupported 必须给 reason
  assert.throws(mk({
    global: ok,
    project: { status: GATE_UNSUPPORTED, evidence: 'synthetic evidence for test' },
  }), /没有 reason/);
});

test('🔴 门字段查的是类型不只是真假 —— `clientVersion: true` 骗不过「证据完整」那一档', () => {
  // ⚠️ Codex 复核时用这几个值挨个探过：所有判据都写成 `!g.clientVersion` 的话，
  //    一个 `true` 就能冒充版本号进 scope-decision 档，一个 `''` 又会被静默当成「没填」。
  //    约定是：这几个字段要么缺席，要么是非空字符串。
  const mk = (gates) => () => buildAdapters([
    { client: 'z', dirName: '.z', envHome: null, postInstallHint: null, gates },
  ]);
  const ok = { status: GATE_PASSED, clientVersion: '1.0.0', evidence: 'synthetic evidence for test' };
  const bad = [
    ['clientVersion 是 true', { status: GATE_PENDING, blockedOn: BLOCKED_ON_SCOPE_DECISION, clientVersion: true, evidence: 'synthetic evidence for test' }],
    ['clientVersion 是空串', { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, clientVersion: '', evidence: 'synthetic evidence for test' }],
    ['reason 是 true', { status: GATE_UNSUPPORTED, reason: true, evidence: 'synthetic evidence for test' }],
    ['reason 是空串', { status: GATE_UNSUPPORTED, reason: '   ', evidence: 'synthetic evidence for test' }],
    ['blockedOn 是空串', { status: GATE_PASSED, clientVersion: '1', blockedOn: '', evidence: 'synthetic evidence for test' }],
  ];
  for (const [why, g] of bad) {
    assert.throws(mk({ global: ok, project: g }), /必须是非空字符串或缺席/, why);
  }
  // 缺席（null / undefined）仍然合法 —— 那是「这一格没有这个字段」的正常表达
  assert.doesNotThrow(mk({
    global: ok,
    project: { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, clientVersion: null, evidence: 'synthetic evidence for test' },
  }));
});

test('resolveTarget 对已过门的组合返回完整描述（无组合过门时走 layout 验路径）', () => {
  // 这里验的是路径/base 的派生本身（它们不判门，门本身的 fixture 就得靠它们）
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

test('postInstallHint：每个可能被装的端都要有提示', () => {
  // agents 原先是 unsupported 所以没提示；现在它有读者了（codex），
  // 一旦范围拍板就会被装，提示必须存在 —— 而且要写明读者是 codex，
  // 否则用户会去重启一个根本不存在的 agents 客户端。
  assert.match(getAdapter('agents').postInstallHint() ?? '', /codex/);
  for (const c of CLIENTS) {
    assert.ok((getAdapter(c).postInstallHint() ?? '').length > 0, `${c} 缺 postInstallHint`);
  }
});

test('adapter 表冻结，调用方改不了（门不能被就地篡改）', () => {
  const a = getAdapter('claude');
  assert.throws(() => { a.client = 'x'; }, TypeError);
});

// ── §2.3 默认目标 vs 显式 --clients ──────────────────────────────────────────

/** 假装某个组合已闭合门，用来测「门过了之后」的分支（真门表现在一个都没闭合）。 */
// 🔴 **八格全部写死**。早先这里只覆盖 codex 两格，其余落回真门表 ——
// 于是真门表一闭合（2026-08-26 claude 两格转 passed），这些本该稳定的
// 「门没过会怎样」用例就跟着变了行为。注入的场景要自足，不能一半靠真表。
const PASSED_CODEX = {
  'codex/global': { status: GATE_PASSED, clientVersion: '0.0.0-test', evidence: 'test' },
  'codex/project': { status: GATE_PASSED, clientVersion: '0.0.0-test', evidence: 'test' },
  'claude/global': { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, evidence: 'test' },
  'claude/project': { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, evidence: 'test' },
  'cursor/global': { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, evidence: 'test' },
  'cursor/project': { status: GATE_PENDING, blockedOn: BLOCKED_ON_NO_RUNTIME, evidence: 'test' },
  'agents/global': { status: GATE_UNSUPPORTED, reason: 'no-reader', evidence: 'test' },
  'agents/project': { status: GATE_UNSUPPORTED, reason: 'no-reader', evidence: 'test' },
};

test('🔴 真门表下的默认目标：只选闭合了的那几格，没闭合的如实 skipped', () => {
  // 2026-08-26 之后 claude/codex 两个 scope 都闭合了，所以这里**不再是空集**。
  // 但「没闭合的照样进不来」这条不变 —— cursor 两格没有运行时证据、
  // agents 两格等范围决策，即使它们的目录存在也只能是 skipped。
  const home = tmp();
  for (const d of ['.claude', '.codex', '.cursor', '.agents']) {
    mkdirSync(join(home, d, 'skills'), { recursive: true });
  }
  const p = planTargets({ home, env: {}, scope: 'global' });
  assert.equal(p.ok, true, '默认目标下「跳过一部分」不是失败');
  assert.deepEqual(p.selected.map((t) => t.client).sort(), ['claude', 'codex']);
  // 🔴 目录明明在，仍然只能被门挡在外面
  assert.ok(p.skipped.some((s) => s.client === 'cursor' && s.reason === 'gate-pending'));
  assert.ok(p.skipped.some((s) => s.client === 'agents' && s.reason === 'gate-pending'));
  // skipped 的理由要能读出是缺证据还是缺决策
  assert.match(p.skipped.find((s) => s.client === 'cursor').message, /本机无法测量|本机跑不起/);
  assert.match(p.skipped.find((s) => s.client === 'agents').message, /范围决策|读者是 codex-cli|读者同为 codex-cli/);
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

test('🔴 classifyGate 不是授权函数 —— 它对伪造的字面量照样说 allow', () => {
  // 它对一个字面量当然说 allow：那只是分类，不是批准。
  assert.equal(classifyGate({ status: GATE_PASSED }).decision, 'allow');
  assert.equal(
    classifyGate({ status: GATE_PASSED, clientVersion: '9', evidence: 'forged' }).decision,
    'allow',
  );

  // 🔴 而 resolveTarget 只认**自己门表里**的那条记录：它内部用 client 名重新 getAdapter，
  //    入参里根本没有「adapter」或「gate」这个口子可以塞。
  //    必须挑一个**还没闭合**的组合来验，否则「没被拦住」与「本来就允许」分不开。
  assert.equal(getAdapter('cursor').gate('global').status, GATE_PENDING, '前提：这一格确实没闭合');
  assert.throws(
    () => resolveTarget({ client: 'cursor', scope: 'global', home: '/h' }),
    /阻塞门未闭合/,
  );
  assert.throws(
    () => resolveTarget({
      client: 'cursor',
      scope: 'global',
      home: '/h',
      adapter: { gate: () => ({ status: GATE_PASSED, clientVersion: '9', evidence: 'forged' }) },
      gate: { status: GATE_PASSED, clientVersion: '9', evidence: 'forged' },
    }),
    /阻塞门未闭合/,
    '伪造的 adapter/gate 入参必须被无视',
  );
});

test('🔴 REAL_GATES 身份检查：不在门表里的门记录授权不了安装（非空断言）', () => {
  // ⚠️ 上一版这条测试造了个 fake adapter 却从没注入过 —— resolveTarget 内部
  //    重新 getAdapter 拿真表，于是**把 WeakSet 检查整个删掉它照样绿**，
  //    是一条空断言（Codex 复核时指出）。
  //    真正能非空覆盖身份保护的是 planTargets 这条路径：TEST_GATES 注入的门记录
  //    不在 REAL_GATES 里，计划即使「过了门」也必须被 assertPlanOk 拒绝。
  const home = tmp();
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  const p = planTargets({ home, env: {}, scope: 'global', [TEST_GATES]: PASSED_CODEX });
  // 前提：注入的门确实放行了 codex，所以下面拒绝的是一个**非空**的计划
  assert.ok(p.selected.some((t) => t.client === 'codex'), '前提：注入的门确实放行了 codex');
  assert.throws(() => assertPlanOk(p), /不得用来放行安装/);
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

// ── .gitignore 要用真 git 验，不能只验生成的字符串 ──────────────────────────

test('🔴 生成的 pattern 在真 git 仓库里确实忽略了 .geoly，且不误伤 skill 本体', async () => {
  // 之前只断言「生成了什么字符串」。字符串对不等于 git 真的会忽略 ——
  // gitignore 的匹配规则（前导 /、尾随 /、目录 vs 文件）有足够多的坑。
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { gitignorePatternsFor } = await import('../src/adapters/index.mjs');

  const repo = mkdtempSync(join(tmpdir(), 'gi-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), gitignorePatternsFor(['claude', 'codex']).join('\n') + '\n');

  // 真的把目录造出来 —— check-ignore 对目录与文件的判定不同
  for (const p of ['.claude/skills/.geoly/tx-1/stage/demo', '.claude/skills/demo',
    '.codex/skills/.geoly/attic/1', '.codex/skills/demo']) {
    mkdirSync(join(repo, p), { recursive: true });
    writeFileSync(join(repo, p, 'SKILL.md'), 'x');
  }

  const ignored = (rel) => {
    try { git('check-ignore', '-q', rel); return true; } catch { return false; }
  };

  // 状态目录必须被忽略
  for (const rel of ['.claude/skills/.geoly/tx-1/stage/demo/SKILL.md',
    '.codex/skills/.geoly/attic/1/SKILL.md']) {
    assert.equal(ignored(rel), true, `应被忽略：${rel}`);
  }
  // 🔴 反向：skill 本体绝不能被误伤，否则用户装的 skill 提交不上去
  for (const rel of ['.claude/skills/demo/SKILL.md', '.codex/skills/demo/SKILL.md']) {
    assert.equal(ignored(rel), false, `不该被忽略：${rel}`);
  }
  // 🔴 根上的 /.geoly/ 不是我们要的 pattern（规格注明 v8 曾写错）
  assert.ok(!gitignorePatternsFor(['claude']).includes('/.geoly/'), '不得退回成根上的 /.geoly/');
});
