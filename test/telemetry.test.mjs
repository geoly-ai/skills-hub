import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

let n = 0;
function iso() {
  const d = mkdtempSync(join(tmpdir(), 'tm-'));
  process.env.GEOLY_STATE_DIR = d;
  delete process.env.GEOLY_TELEMETRY;
  delete process.env.GEOLY_CLI_VERSION;
  return d;
}
const fresh = () => import('../src/telemetry.mjs?t' + ++n);

// ── 构造面 ───────────────────────────────────────────────────────────────────

test('白名单：未知字段进不去', async () => {
  iso();
  const { buildEvent } = await fresh();
  const ev = buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', secret: 'nope' });
  assert.equal(ev.secret, undefined);
  assert.equal(ev.artifact, 'skill:geoly/a@1.0.0');
});

test('kind / result 受枚举约束', async () => {
  iso();
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'nope', result: 'ok' }), /kind/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'maybe' }), /result/);
});

// ── 隐私契约：值必须受控，不只是「不含路径」 ────────────────────────────────

test('🔴 值不是字符串就拒绝 —— 对象/数组不能借值的类型溜过校验', async () => {
  iso();
  const { buildEvent } = await fresh();
  // 这是最早那版「只扫字符串」的漏洞：client 是对象时扫描直接 continue，整个漏出去
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', client: { path: '/Users/a' } }), /对象|不合规/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', reason: ['/Users/a'] }), /对象|不合规/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', ms: NaN }), /ms/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', ms: Infinity }), /ms/);
});

test('🔴 client / scope 是枚举，不是自由文本', async () => {
  iso();
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', client: 'chovi@example.com' }), /client/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', scope: '/Users/chovi/proj' }), /scope/);
  assert.ok(buildEvent({ kind: 'install', result: 'ok', client: 'claude', scope: 'project' }));
});

test('🔴 reason 是有限代码表，挡住用户名/邮箱/token/路径', async () => {
  iso();
  const { buildEvent } = await fresh();
  const bad = [
    '/Users/x/.claude/skills 写失败', // 路径
    'C:\\Users\\x\\skills', // Windows 路径
    '\\\\server\\share', // UNC
    '~ 下没有 skills', // ~ 展开前
    'chovi@example.com', // 邮箱
    'sk-ant-api03-AbCdEf0123456789', // token
    'signature mismatch', // 带空格的自由文本
    homedir(), // 家目录字面量
    'alice', // 🔴 形状合法但不在代码表里 —— 自由字段就是这么变成侧信道的
    'signature-mismatchh', // 拼错也拒绝，不做模糊匹配
  ];
  for (const r of bad) {
    assert.throws(() => buildEvent({ kind: 'install', result: 'failed', reason: r }), /reason/, `应拒绝：${r}`);
  }
  assert.equal(
    buildEvent({ kind: 'install', result: 'failed', reason: 'signature-mismatch' }).reason,
    'signature-mismatch',
  );
});

test('🔴 artifact 必须是制品坐标，塞路径进去照样被拒', async () => {
  iso();
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', artifact: '/Users/x/secret' }), /artifact/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:g/a@1.0.0/../../etc' }), /artifact/);
  assert.ok(buildEvent({ kind: 'install', result: 'ok', artifact: 'pack:geoly/theme-matrix@0.3.1' }));
});

test('🔴 GEOLY_CLI_VERSION 是可注入的环境变量，也要过校验', async () => {
  iso();
  process.env.GEOLY_CLI_VERSION = '/Users/chovi/leak';
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok' }), /cli/);
  delete process.env.GEOLY_CLI_VERSION;
});

test('🔴 缺必填字段的事件被拒（防手改队列删字段）', async () => {
  iso();
  const { assertValidEvent, buildEvent } = await fresh();
  const ev = buildEvent({ kind: 'install', result: 'ok' });
  for (const k of ['schema', 'eid', 'at', 'install_id', 'cli', 'os', 'arch', 'node', 'kind', 'result']) {
    const copy = { ...ev };
    delete copy[k];
    assert.throws(() => assertValidEvent(copy), new RegExp(k), `删掉 ${k} 应被拒`);
  }
});

// ── 落盘 / 读回 ──────────────────────────────────────────────────────────────

test('关掉埋点后一个字节都不写', async () => {
  iso();
  process.env.GEOLY_TELEMETRY = '0';
  const { record, readAll } = await fresh();
  assert.equal(record({ kind: 'install', result: 'ok' }), null);
  assert.deepEqual(readAll(), []);
  delete process.env.GEOLY_TELEMETRY;
});

test('install_id 稳定且是随机 UUID（与身份无关）', async () => {
  iso();
  const { installId } = await fresh();
  const a = installId();
  assert.equal(a, installId());
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.ok(!a.includes(process.env.USER ?? 'nobody'));
});

test('记录后可读回', async () => {
  iso();
  const { record, readAll } = await fresh();
  record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', client: 'claude', scope: 'global', ms: 12 });
  const all = readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].client, 'claude');
});

test('🔴 record 绝不向主命令抛错（威胁模型 T-5）', async () => {
  iso();
  const { record, lastError } = await fresh();
  // 非法输入不该炸掉安装事务，只该拒绝落盘
  assert.equal(record({ kind: 'install', result: 'ok', client: { evil: '/Users/a' } }), null);
  assert.match(String(lastError()), /client|对象/);
  assert.equal(record({ kind: 'bogus', result: 'ok' }), null);
});

test('🔴 手改队列塞进去的脏行，读回时被丢弃', async () => {
  const d = iso();
  const { record, readAll, exportJson } = await fresh();
  record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
  const qp = join(d, 'telemetry', 'queue.ndjson');
  const good = readFileSync(qp, 'utf8');
  const base = JSON.parse(good.trim());
  const tampered =
    [
      JSON.stringify({ ...base, leaked: '/Users/chovi/.ssh/id_rsa' }), // 未知字段
      JSON.stringify({ ...base, client: { path: '/Users/a' } }), // 嵌套对象
      '{不是合法 JSON',
    ].join('\n') + '\n';
  writeFileSync(qp, good + tampered);

  const all = readAll();
  assert.equal(all.length, 1, '只应剩那条干净的');
  const dumped = exportJson();
  assert.ok(!dumped.includes('id_rsa'));
  assert.ok(!dumped.includes('leaked'));
});

test('🔴 原型污染键不能借 Object.prototype 混进去', async () => {
  iso();
  const { assertValidEvent, buildEvent, isValidEvent } = await fresh();
  const base = buildEvent({ kind: 'install', result: 'ok' });
  // JSON.parse 会把 __proto__ 建成**自有属性**，Object.keys 看得见它
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const ev = JSON.parse(JSON.stringify(base));
    Object.defineProperty(ev, key, { value: '/Users/chovi/.ssh/id_rsa', enumerable: true, configurable: true });
    assert.throws(() => assertValidEvent(ev), /未知字段/, `${key} 应被当成未知字段拒绝`);
    assert.equal(isValidEvent(ev), false);
  }
  // 反过来：原型上有 toString 不代表事件「有」这个必填字段
  assert.equal(isValidEvent(base), true);
});

test('🔴 空对象 / 数组 / null 不是事件', async () => {
  iso();
  const { assertValidEvent } = await fresh();
  for (const v of [null, [], 'x', 42, undefined]) {
    assert.throws(() => assertValidEvent(v), /普通对象/);
  }
});

// ── 本地文件权限 ─────────────────────────────────────────────────────────────
//
// 🔴 埋点状态目录里是 queue / history / sending / install-id。目录按 0755 建的话，
//    **同机其他账户直接可读**。事件里一旦出现自报的用户名与主机名（2026-09-09
//    用户拍板要采身份字段），那就是把身份信息摊在一个所有人可读的目录里。
//    Codex 在那次评审里把这一条列为阻断项。
test('🔴 埋点目录 0700、文件 0600', async () => {
  const d = iso();
  const { record } = await fresh();
  record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
  const { statSync } = await import('node:fs');
  const mode = (p) => statSync(p).mode & 0o777;
  assert.equal(mode(join(d, 'telemetry')), 0o700, '目录必须是 0700');
  assert.equal(mode(join(d, 'telemetry', 'queue.ndjson')), 0o600, 'queue 必须是 0600');
  assert.equal(mode(join(d, 'telemetry', 'history.ndjson')), 0o600, 'history 必须是 0600');
  assert.equal(mode(join(d, 'telemetry', 'install-id')), 0o600, 'install-id 必须是 0600');
});

// 🔴 光在创建时给 mode 是不够的：`mkdirSync(…, { mode })` 只对**真的新建**生效，
//    老版本按 0755 建下来的目录会一声不吭地留着。判据必须是「跑完之后是 0700」，
//    不是「创建时传了 0700」—— 这正是本仓库反复栽的那种「看起来守住了」。
test('🔴 老版本留下的 0755 目录与 0644 文件会被迁移', async () => {
  const d = iso();
  const { mkdirSync, chmodSync, writeFileSync: wf, statSync } = await import('node:fs');
  mkdirSync(join(d, 'telemetry'), { recursive: true });
  chmodSync(join(d, 'telemetry'), 0o755);
  wf(join(d, 'telemetry', 'queue.ndjson'), '', { mode: 0o644 });
  chmodSync(join(d, 'telemetry', 'queue.ndjson'), 0o644);

  const { record } = await fresh();
  record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });

  const mode = (p) => statSync(p).mode & 0o777;
  assert.equal(mode(join(d, 'telemetry')), 0o700, '已存在的目录没被纠正回 0700');
  assert.equal(mode(join(d, 'telemetry', 'queue.ndjson')), 0o600, '已存在的队列没被迁移成 0600');
});


// ── 身份三项（2026-09-09 用户拍板加采）─────────────────────────────────────
//
// 🔴 这一组钉的是**默认与顺序**，不是「能不能采到」：
//    默认关、没告知不采、关掉身份不影响匿名计数、自报值必须清洗。

test('🔴 身份字段默认不采 —— 什么都不配的时候一项都没有', async () => {
  iso();
  const { buildEvent } = await fresh();
  const ev = buildEvent({ kind: 'install', result: 'ok' });
  assert.equal(ev.os_user, undefined);
  assert.equal(ev.host, undefined);
  assert.equal(ev.notice, undefined);
});

test('🔴 显式打开但没展示过告知 —— 仍然一项都不采', async () => {
  iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { buildEvent, identityEnabled } = await fresh();
    assert.equal(identityEnabled(), false, '没告知就采 = 先发了再告诉你');
    const ev = buildEvent({ kind: 'install', result: 'ok' });
    assert.equal(ev.os_user, undefined);
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('打开 + 告知过 → 采；此时 notice 一定在', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    const { buildEvent, IDENTITY_NOTICE } = await fresh();
    const ev = buildEvent({ kind: 'install', result: 'ok' });
    assert.equal(typeof ev.os_user, 'string');
    assert.equal(typeof ev.host, 'string');
    assert.equal(ev.notice, IDENTITY_NOTICE);
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('🔴 关掉身份不影响匿名计数（两档退出的第一档）', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'off';
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    const { buildEvent, record, identityEnabled } = await fresh();
    assert.equal(identityEnabled(), false);
    const ev = buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
    assert.equal(ev.os_user, undefined, '关了身份还在采用户名');
    assert.equal(ev.artifact, 'skill:geoly/a@1.0.0', '关身份不该影响匿名字段');
    assert.ok(record({ kind: 'install', result: 'ok' }), '关身份之后计数必须照常记');
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('🔴 本地 identity-off 标记优先于「打开」的环境变量', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    wf(join(d, 'telemetry', 'identity-off'), '');
    const { identityEnabled } = await fresh();
    assert.equal(identityEnabled(), false, '用户关过就是关过，环境变量不该把它掀回来');
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('🔴 GEOLY_TELEMETRY=0 时身份也一定是关的', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY = '0';
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    const { identityEnabled } = await fresh();
    assert.equal(identityEnabled(), false);
  } finally {
    delete process.env.GEOLY_TELEMETRY;
    delete process.env.GEOLY_TELEMETRY_IDENTITY;
  }
});

// ⚠️ 坏值一律写成 \uXXXX 转义，源码里不放字面的控制字符 ——
//    写这条测试的时候我自己就往命令行贴过一个真的零宽字符，被工具挡了两次。
//    「讲某个坑的那句话，最容易掉进那个坑」。
test('🔴 自报值的清洗：控制字符、超长、空白一律不发，且不发截断值', async () => {
  iso();
  const { sanitizeIdentity, assertValidEvent } = await fresh();
  assert.equal(sanitizeIdentity('zhang.wei', 64), 'zhang.wei');
  assert.equal(sanitizeIdentity('  li na  ', 64), 'li na', '两端空白要削掉');
  assert.equal(sanitizeIdentity('张伟', 64), '张伟', '中文用户名是合法的');
  assert.equal(sanitizeIdentity('a\nb', 64), null, '换行会把一条 NDJSON 撕成两条');
  assert.equal(sanitizeIdentity('a\u0000b', 64), null, 'NUL 必须拒');
  assert.equal(sanitizeIdentity('a\u200Bb', 64), null, '零宽字符属于 \\p{C}，必须拒');
  assert.equal(sanitizeIdentity('a\u2028b', 64), null, '行分隔符必须拒');
  assert.equal(sanitizeIdentity('a\u001Bb', 64), null, 'ESC 必须拒 —— 终端里它是控制序列');
  assert.equal(sanitizeIdentity('   ', 64), null);
  assert.equal(sanitizeIdentity('x'.repeat(65), 64), null, '超长整个不发，不许截断');
  assert.equal(sanitizeIdentity(123, 64), null);
  // NFC：同一个名字的两种 Unicode 写法必须折成同一个值，否则同一个人会被数成两个
  assert.equal(sanitizeIdentity('e\u0301', 64), '\u00E9', '组合字符要折成预组合形式');

  // 校验器与构造器是同一个函数 —— 手改队列塞脏值进不来
  assert.throws(() => assertValidEvent({
    schema: 'geoly.skills.telemetry/1', eid: '00000000-0000-4000-8000-000000000000',
    at: '2026-01-01T00:00:00Z', install_id: '00000000-0000-4000-8000-000000000000',
    cli: '0.1.0', os: 'darwin', arch: 'arm64', node: '22.13.0',
    kind: 'install', result: 'ok', os_user: 'bad\nname',
  }), /os_user/);
});

test('🔴 notice 是有限代码表，不是自由字符串', async () => {
  iso();
  const { assertValidEvent } = await fresh();
  const base = {
    schema: 'geoly.skills.telemetry/1', eid: '00000000-0000-4000-8000-000000000000',
    at: '2026-01-01T00:00:00Z', install_id: '00000000-0000-4000-8000-000000000000',
    cli: '0.1.0', os: 'darwin', arch: 'arm64', node: '22.13.0', kind: 'install', result: 'ok',
  };
  assert.throws(() => assertValidEvent({ ...base, notice: 'v99' }), /notice/);
  assert.throws(() => assertValidEvent({ ...base, notice: 'alice@example.com' }), /notice/);
});

// 🔴 **serializeEvent 必须保持一元。** 2026-09-09 我给它加过一个「可选的第二参数」，
//    结果 `pending.map(serializeEvent)` 把数组下标当成那个参数传了进来
//    （map 给回调三个参数），上报整条链路静默失败，flush 只回一个 error:TypeError。
//    这条测试钉的就是那个形态 —— 判据是**在 map 里能用**，不是「多传一个参数会怎样」。
test('🔴 serializeEvent 在 map 回调里必须能直接用（一元）', async () => {
  iso();
  const { buildEvent, serializeEvent, serializeAnonymousEvent } = await fresh();
  const evs = [
    buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' }),
    buildEvent({ kind: 'check', result: 'ok' }),
  ];
  const lines = evs.map(serializeEvent);      // ← 不加箭头函数，这就是真实调用点的写法
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(l.startsWith('{') && l.endsWith('}'), `序列化结果不是对象字面量：${l}`);
    assert.ok(JSON.parse(l).schema === 'geoly.skills.telemetry/1');
  }
  assert.equal(serializeEvent.length, 1, 'serializeEvent 不许有第二个位置参数');
  // 匿名序列化是**另一个函数名**，不是同一个函数的第二个参数
  assert.equal(typeof serializeAnonymousEvent, 'function');
  assert.equal(serializeAnonymousEvent.length, 1);
});

// 🔴 导出是身份数据的**第二个出口**，与摄入那条路径互相覆盖不到。
//    `stats --export data.json` 出来的文件会被拖进 docs/dashboard/index.html，
//    那个页面把整个 events 数组交给浏览器 —— 文件里有，devtools 里就有。
test('🔴 stats --export 的产物里没有身份字段', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    const { record, exportJson, readHistory } = await fresh();
    record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });

    // 前提自查：历史里**确实**记了身份字段，否则这条断言是空转的
    const hist = readHistory();
    assert.equal(hist.length, 1);
    assert.equal(typeof hist[0].os_user, 'string', '历史里没有身份字段 —— 这条测试正在空转');

    const text = exportJson();
    const doc = JSON.parse(text);
    assert.equal(doc.count, 1);
    for (const k of ['os_user', 'host', 'notice']) {
      assert.ok(!Object.hasOwn(doc.events[0], k), `导出里混进了 ${k}`);
    }
    assert.ok(!text.includes(hist[0].os_user), '导出的字节里出现了用户名');
    assert.equal(doc.events[0].artifact, 'skill:geoly/a@1.0.0', '匿名字段不该被一起剥掉');
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

// 🔴 权限保证的三个漏点（Codex 2026-09-09 的 P1）：
//    ① upload.mjs 裸 mkdirSync —— 先跑 flush 的机器目录就是 0755
//    ② install-id 已存在时提前返回，永远迁移不到真正需要迁移的那些机器
test('🔴 先跑 flush 的机器，目录也必须是 0700', async () => {
  const d = iso();
  const { statSync } = await import('node:fs');
  const up = await import('../src/upload.mjs?p1');
  // 队列是空的，flush 会早退 —— 但建目录那一步已经发生了
  await up.flush({ fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(statSync(join(d, 'telemetry')).mode & 0o777, 0o700);
});

test('🔴 已存在的 0644 install-id 会被迁移，不是只在新建时给 0600', async () => {
  const d = iso();
  const { mkdirSync, writeFileSync: wf, chmodSync, statSync } = await import('node:fs');
  mkdirSync(join(d, 'telemetry'), { recursive: true });
  const p = join(d, 'telemetry', 'install-id');
  wf(p, '63adb62d-e85a-404a-ab2b-cec69a9ff581\n');
  chmodSync(p, 0o644);

  const { installId } = await fresh();
  const id = installId();          // 走的是「已存在，提前返回」那条路径
  assert.equal(id, '63adb62d-e85a-404a-ab2b-cec69a9ff581', '不该换掉已有的 id');
  assert.equal(statSync(p).mode & 0o777, 0o600, '提前返回那条路径没迁移权限');
});

// ── 告知与两档退出的闭合（Codex 2026-09-09 的最后一条 P1）──────────────────
//
// 🔴 上一版的洞：`identityEnabled()` 要求一个标记文件，但**没有任何代码写它**，
//    `telemetry off` 也不存在。开关看起来有，实际打不开也关不掉。

test('🔴 身份告知是 identityEnabled 的唯一入口：打过之后才采', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const tm = await fresh();
    assert.equal(tm.identityEnabled(), false, '还没告知过就采了');
    let out = '';
    const shown = tm.maybeNoticeIdentity((s) => { out += s; }, 'https://x.example/v1/events');
    assert.equal(shown, true);
    assert.match(out, /身份信息/);
    assert.match(out, /登录名/);
    assert.match(out, /telemetry off/, '告知里必须写清怎么关');
    assert.match(out, /90 天/, '告知里必须写清留多久');

    const tm2 = await fresh();
    assert.equal(tm2.identityEnabled(), true, '告知打过之后应该能采了');
    // 只打一次
    assert.equal(tm2.maybeNoticeIdentity(() => {}, 'https://x.example/v1/events'), false);
    void d;
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('🔴 默认关的时候不打身份告知（不吓唬没在采的用户）', async () => {
  iso();
  const tm = await fresh();
  let out = '';
  assert.equal(tm.maybeNoticeIdentity((s) => { out += s; }, 'https://x.example/v1/events'), false);
  assert.equal(out, '');
});

test('🔴 上报告知不再声称「不收用户名」', async () => {
  iso();
  const { uploadNoticeText } = await fresh();
  const t = uploadNoticeText('https://x.example/v1/events');
  const never = t.slice(t.indexOf('不收什么'), t.indexOf('发到哪'));
  assert.ok(!never.includes('用户名'), '「不收什么」里还写着用户名 —— 开了身份之后这句是假的');
  assert.match(t, /身份三项/, '必须提到身份三项及其默认状态');
  assert.match(t, /默认不采/);
});

test('🔴 telemetry off 只关身份，匿名计数照记', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const tm = await fresh();
    tm.maybeNoticeIdentity(() => {}, 'https://x.example/v1/events');
    const tm2 = await fresh();
    assert.equal(tm2.identityEnabled(), true);

    tm2.identityOff();
    const tm3 = await fresh();
    assert.equal(tm3.identityEnabled(), false, 'off 之后还在采身份');
    const ev = tm3.buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
    assert.equal(ev.os_user, undefined);
    assert.ok(tm3.record({ kind: 'install', result: 'ok' }), '匿名计数必须照记');
    void d;
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('telemetry on 撤销标记，但不等于打开采集', async () => {
  iso();
  const tm = await fresh();
  tm.identityOff();
  const tm2 = await fresh();
  assert.equal(tm2.identityEnabled(), false);
  tm2.identityOn();
  const tm3 = await fresh();
  // 环境变量没开、告知没打过 —— 两道门都还在
  assert.equal(tm3.identityEnabled(), false, 'on 不该越过环境变量与告知两道门');
});

test('🔴 telemetry delete 连 install-id 一起删（否则只删了一半）', async () => {
  const d = iso();
  const { existsSync } = await import('node:fs');
  const tm = await fresh();
  tm.record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
  const idFile = join(d, 'telemetry', 'install-id');
  assert.ok(existsSync(idFile), '前提自查：install-id 应该已经生成');
  assert.ok(tm.readHistory().length > 0);

  const r = tm.purgeLocal();
  assert.ok(r.removed >= 2);
  assert.equal(existsSync(idFile), false, 'install-id 还在 —— 下一条事件仍接得回同一条时间线');
  assert.equal(tm.readAll().length, 0);
  assert.equal(tm.readHistory().length, 0);
});

// 🔴 「文件在不在」永远不是判据（规格 §5.2.4）。这里守的是「先告知后采集」，
//    比队列那次更贵：预先建一个同名目录或坏 symlink 就能在没看过告知的情况下开采。
test('🔴 身份告知标记必须是普通文件且内容有效 —— 目录/空文件都不算', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf, rmSync, symlinkSync } = await import('node:fs');
    const mark = join(d, 'telemetry', 'identity-notice.v2');
    mkdirSync(join(d, 'telemetry'), { recursive: true });

    // ① 同名目录
    mkdirSync(mark);
    assert.equal((await fresh()).identityEnabled(), false, '一个同名目录就把身份采集打开了');
    rmSync(mark, { recursive: true });

    // ② 空文件（没有 shown-at）
    wf(mark, '');
    assert.equal((await fresh()).identityEnabled(), false, '空标记不算告知过');
    rmSync(mark);

    // ③ 指向不存在目标的 symlink
    symlinkSync(join(d, 'nope'), mark);
    assert.equal((await fresh()).identityEnabled(), false, '坏 symlink 不算告知过');
    rmSync(mark);

    // ④ 真正的标记
    wf(mark, `shown-at=${new Date().toISOString()}\nendpoint=https://x.example/v1/events\n`);
    assert.equal((await fresh()).identityEnabled(), true, '真的告知过之后应该能采');
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

// 🔴 删除必须把**墓碑**也删掉（Codex 2026-09-09 的 P1）。
//    `sending.tomb.ndjson` 里没被 mark 覆盖的尾部，下一次 flush 会扫回队列并发出去 ——
//    用户以为删干净了，结果删完还发了一批。
test('🔴 telemetry delete 删掉目录里的一切（墓碑、戳、标记），只留锁', async () => {
  const d = iso();
  const { mkdirSync, writeFileSync: wf, readdirSync, existsSync } = await import('node:fs');
  const dir = join(d, 'telemetry');
  mkdirSync(dir, { recursive: true });
  // 造出一整套状态文件，包括那两个曾被漏掉的
  for (const f of ['queue.ndjson', 'queue.1.ndjson', 'sending.ndjson',
    'sending.tomb.ndjson', 'sending.tomb.mark', 'history.ndjson', 'history.1.ndjson',
    'install-id', 'auto-upload.last', 'upload-notice.v1', 'identity-notice.v2',
    'identity-off']) {
    wf(join(dir, f), 'x\n');
  }
  const tm = await fresh();
  const r = tm.purgeLocal();
  assert.ok(r.removed >= 12, `只删了 ${r.removed} 个`);
  assert.deepEqual(r.remaining.filter((n) => !n.startsWith('upload.lock')), []);
  assert.equal(existsSync(join(dir, 'sending.tomb.ndjson')), false, '墓碑还在 —— 下次 flush 会把它扫回队列发出去');
  assert.equal(existsSync(join(dir, 'sending.tomb.mark')), false, '墓碑水位还在');
  assert.equal(existsSync(join(dir, 'install-id')), false);
  // 剩下的只能是锁
  for (const n of readdirSync(dir)) {
    assert.ok(n.startsWith('upload.lock'), `删完还剩一个非锁文件：${n}`);
  }
});

test('状态目录不存在时 delete 什么都不建', async () => {
  const d = iso();
  const { existsSync } = await import('node:fs');
  const tm = await fresh();
  const r = tm.purgeLocal();
  assert.deepEqual(r, { removed: 0, remaining: [] });
  assert.equal(existsSync(join(d, 'telemetry')), false, '为了删而先把目录建出来了');
});

// ── 删除所有权密钥（2026-09-10）──────────────────────────────────────────────

test('🔴 默认不生成密钥 —— 身份没开就没有可删的东西，也就不需要它', async () => {
  const d = iso();
  const { existsSync } = await import('node:fs');
  const tm = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  assert.equal(existsSync(join(d, 'telemetry', 'delete-key')), false);
  assert.equal(tm.deleteKey(), null, '没有密钥时必须返回 null');
});

test('身份开启后第一条事件就带公钥，且密钥落盘 0600', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf, statSync } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    const tm = await fresh();
    const ev = tm.buildEvent({ kind: 'install', result: 'ok' });
    assert.match(ev.pubkey, /^[A-Za-z0-9_-]{43}$/, '公钥不是 43 字符 base64url');
    assert.equal(statSync(join(d, 'telemetry', 'delete-key')).mode & 0o777, 0o600);
    // 同一台机器上必须稳定，否则旧数据会被孤立
    const again = tm.buildEvent({ kind: 'check', result: 'ok' });
    assert.equal(again.pubkey, ev.pubkey, '公钥换了 —— 之前发出去的数据就删不掉了');
    assert.equal(tm.deleteKey().pubkey, ev.pubkey);
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('🔴 密钥读不出来时返回 null，绝不「再生成一把」', async () => {
  const d = iso();
  const { mkdirSync, writeFileSync: wf } = await import('node:fs');
  mkdirSync(join(d, 'telemetry'), { recursive: true });
  wf(join(d, 'telemetry', 'delete-key'), '这不是一把密钥\n');
  const tm = await fresh();
  // create:true 也不许覆盖 —— 覆盖等于把旧公钥对应的那批数据永久孤立
  assert.equal(tm.deleteKey({ create: true }), null);
  const { readFileSync: rf } = await import('node:fs');
  assert.equal(rf(join(d, 'telemetry', 'delete-key'), 'utf8'), '这不是一把密钥\n',
    '损坏的密钥文件被覆盖了');
});

test('🔴 公钥是身份类字段：不进匿名事件，也不进导出', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY_IDENTITY = 'on';
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(d, 'telemetry'), { recursive: true });
    wf(join(d, 'telemetry', 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
    const tm = await fresh();
    tm.record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
    const pub = tm.deleteKey().pubkey;
    const text = tm.exportJson();
    assert.ok(!text.includes(pub), '导出的字节里出现了公钥');
    assert.ok(!Object.hasOwn(JSON.parse(text).events[0], 'pubkey'));
    assert.ok(tm.IDENTITY_FIELD_NAMES.includes('pubkey'), 'pubkey 没被标成身份字段');
    assert.ok(!tm.ANONYMOUS_FIELD_NAMES.includes('pubkey'));
  } finally { delete process.env.GEOLY_TELEMETRY_IDENTITY; }
});

test('🔴 pubkey 是定长的：长一位短一位都不许过', async () => {
  iso();
  const { assertValidEvent } = await fresh();
  const base = {
    schema: 'geoly.skills.telemetry/1', eid: '00000000-0000-4000-8000-000000000000',
    at: '2026-01-01T00:00:00Z', install_id: '00000000-0000-4000-8000-000000000000',
    cli: '0.1.0', os: 'darwin', arch: 'arm64', node: '22.13.0', kind: 'install', result: 'ok',
  };
  const ok43 = 'a'.repeat(43);
  assert.ok(assertValidEvent({ ...base, pubkey: ok43 }));
  assert.throws(() => assertValidEvent({ ...base, pubkey: 'a'.repeat(42) }), /pubkey/);
  assert.throws(() => assertValidEvent({ ...base, pubkey: 'a'.repeat(44) }), /pubkey/);
  assert.throws(() => assertValidEvent({ ...base, pubkey: `${'a'.repeat(42)}+` }), /pubkey/,
    'base64（含 + /）不是 base64url');
});
