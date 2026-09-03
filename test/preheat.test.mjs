// preheat：出网 → staging → 验签（由 resolveCurrent 做）→ 提升。
// 这里测的是**闸**，不是快乐路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertAssetFile, assertSnapshotNumber, peekLatestSnapshot,
  preheatAssets, newBudget, discard,
  timestampUrl, snapshotUrl, assetUrl, REGISTRY_HOST,
} from '../src/preheat.mjs';
import { sha256Of } from '../src/trust.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'preheat-'));

const REC = (over = {}) => ({
  id: 'skill:ns/name@1.0.0', kind: 'skill', namespace: 'ns', name: 'name', version: '1.0.0',
  asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: 'sha256:' + 'a'.repeat(64), size: 5 },
  ...over,
});

// ── locator ────────────────────────────────────────────────────────────────

test('locator 全部落在内建 host 上，且不带查询串', () => {
  for (const u of [timestampUrl(), snapshotUrl(7), assetUrl(7, 'skill_a_b_1.0.0.tar.gz')]) {
    const p = new URL(u);
    assert.equal(p.protocol, 'https:');
    assert.equal(p.host, REGISTRY_HOST);
    assert.equal(p.search, '', u);
  }
});

test('🔴 N 只以数值形式进 URL —— 同一个 N 只有一种写法', () => {
  assert.equal(snapshotUrl(7), snapshotUrl(7.0));
  assert.match(snapshotUrl(7), /hub-v7\/hub-7\.json$/);
});

// ── 快照号 ─────────────────────────────────────────────────────────────────

test('🔴 快照号：拒浮点/负数/前导零字符串/指数/超安全整数', () => {
  assert.equal(assertSnapshotNumber(0), 0, 'N=0 是合法的（创世）');
  assert.equal(assertSnapshotNumber(42), 42);
  for (const bad of [-1, 1.5, NaN, Infinity, '7', '007', '1e3', Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.throws(() => assertSnapshotNumber(bad), /非负安全整数/, JSON.stringify(bad));
  }
});

test('🔴 窥探只认严格整数 —— "007" 与 "7" 不许映到同一个缓存文件名', () => {
  // Number('007') === 7、Number('1e3') === 1000。若用 Number() 容忍，
  // 两个不同的 timestamp 会写进同一个 snapshots/<N>.json —— 缓存投毒的入口。
  // 🔴 走**真的**单资产信封（payload 是 base64），不是我手搓的形状 ——
  //    否则测的是一个生产里不存在的输入。
  const ts = (v) => wrapTimestamp(Buffer.from(JSON.stringify({ latest_snapshot: v })), { x: 1 });
  assert.equal(peekLatestSnapshot(ts(7)), 7);
  assert.throws(() => peekLatestSnapshot(ts('007')), /非负安全整数/);
  assert.throws(() => peekLatestSnapshot(ts('1e3')), /非负安全整数/);
});

test('窥探拿到的不是 JSON 时报成网络问题，不是完整性问题', () => {
  // 取到一页 HTML（登录墙、错误页）是**网络/端点**问题；
  // 报成完整性会让人去查签名，方向全错。
  assert.throws(() => peekLatestSnapshot(Buffer.from('<html>404</html>')), /不像 registry 的响应/);
});

// ── 资产文件名 ─────────────────────────────────────────────────────────────

test('🔴 asset.file 是重算后逐字节比，不是黑名单', () => {
  assert.equal(assertAssetFile(REC()), 'skill_ns_name_1.0.0.tar.gz');
  // 路径穿越
  assert.throws(() => assertAssetFile(REC({ asset: { ...REC().asset, file: '../../etc/passwd' } })), /应为/);
  // 百分号编码（黑名单最容易漏的一类）
  assert.throws(() => assertAssetFile(REC({ asset: { ...REC().asset, file: '%2e%2e%2fx.tar.gz' } })), /应为/);
  // 🔴 完全合法的文件名，但指向**另一条记录**的资产 —— 黑名单查不出这种
  assert.throws(
    () => assertAssetFile(REC({ asset: { ...REC().asset, file: 'skill_ns_other_9.9.9.tar.gz' } })),
    /应为 "skill_ns_name_1\.0\.0\.tar\.gz"/,
  );
});

// ── 资产下载 ───────────────────────────────────────────────────────────────

function assetFetch(bytesById) {
  return async (url) => {
    const file = url.split('/').pop();
    const bytes = bytesById[file];
    if (bytes === undefined) return { ok: false, status: 404, headers: { get: () => null } };
    return {
      ok: true, status: 200, headers: { get: () => String(bytes.length) },
      body: { getReader: () => { let done = false; return {
        read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })),
        cancel: async () => {},
      }; } },
    };
  };
}

test('资产按摘要落盘；摘要对不上就拒，且不留文件', async () => {
  const cacheDir = tmp();
  const bytes = Buffer.from('hello');
  const hex = sha256Of(bytes).slice('sha256:'.length);
  const rec = REC({ asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: `sha256:${hex}`, size: 5 } });

  await preheatAssets({
    cacheDir, n: 3, records: [rec],
    fetchImpl: assetFetch({ 'skill_ns_name_1.0.0.tar.gz': bytes }),
  });
  assert.ok(existsSync(join(cacheDir, 'assets', hex)), '应按 sha256 hex 命名落盘');

  // 换一条：声称同样的摘要，但字节不是那个
  const cache2 = tmp();
  await assert.rejects(
    () => preheatAssets({
      cacheDir: cache2, n: 3, records: [rec],
      fetchImpl: assetFetch({ 'skill_ns_name_1.0.0.tar.gz': Buffer.from('EVIL!') }),
    }),
    /摘要是/,
  );
  assert.deepEqual(readdirSync(join(cache2, 'assets')), [], '验不过就不许留下任何字节');
});

test('🔴 已验证的资产留作孤儿 —— 整套矩阵下到一半断网，下次要能接着下', async () => {
  const cacheDir = tmp();
  const a = Buffer.from('aaaa'), b = Buffer.from('bbbb');
  const ha = sha256Of(a).slice(7), hb = sha256Of(b).slice(7);
  const recs = [
    REC({ id: 'skill:ns/a@1.0.0', name: 'a', asset: { file: 'skill_ns_a_1.0.0.tar.gz', sha256: `sha256:${ha}`, size: 4 } }),
    REC({ id: 'skill:ns/b@1.0.0', name: 'b', asset: { file: 'skill_ns_b_1.0.0.tar.gz', sha256: `sha256:${hb}`, size: 4 } }),
  ];
  // 第二个下不到 → 整批失败
  await assert.rejects(() => preheatAssets({
    cacheDir, n: 3, records: recs, fetchImpl: assetFetch({ 'skill_ns_a_1.0.0.tar.gz': a }),
  }));
  // 🔴 但第一个已经验过了，必须留下 —— 否则每次断网都从头再来
  assert.ok(existsSync(join(cacheDir, 'assets', ha)), '已验证的第一个资产应当留作孤儿');
  assert.equal(existsSync(join(cacheDir, 'assets', hb)), false);

  // 补上第二个，重跑：第一个走缓存不重下
  const hit = [];
  const out = await preheatAssets({
    cacheDir, n: 3, records: recs,
    fetchImpl: async (u) => { hit.push(u); return assetFetch({ 'skill_ns_b_1.0.0.tar.gz': b })(u); },
  });
  assert.equal(hit.length, 1, '第一个应当命中缓存、不再出网');
  assert.deepEqual(out.map((x) => x.cached), [true, false]);
});

test('🔴 截断的下载要报「大小」而不是「摘要」—— 指向真正的原因', async () => {
  const cacheDir = tmp();
  const full = Buffer.from('0123456789');
  const rec = REC({ asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: sha256Of(full), size: 10 } });
  await assert.rejects(
    () => preheatAssets({
      cacheDir, n: 3, records: [rec],
      fetchImpl: assetFetch({ 'skill_ns_name_1.0.0.tar.gz': full.subarray(0, 7) }),
    }),
    // 摘要当然也对不上，但先报出来的必须是「7 字节，应为 10」
    (e) => /下回来是 7 字节.*应为 10/.test(e.message),
  );
});

test('同一份字节被两条记录引用时只下一次', async () => {
  const cacheDir = tmp();
  const bytes = Buffer.from('same');
  const hex = sha256Of(bytes).slice(7);
  const recs = [
    REC({ id: 'skill:ns/a@1.0.0', name: 'a', asset: { file: 'skill_ns_a_1.0.0.tar.gz', sha256: `sha256:${hex}`, size: 4 } }),
    REC({ id: 'skill:ns/b@1.0.0', name: 'b', asset: { file: 'skill_ns_b_1.0.0.tar.gz', sha256: `sha256:${hex}`, size: 4 } }),
  ];
  let n = 0;
  await preheatAssets({
    cacheDir, n: 3, records: recs,
    fetchImpl: async (u) => { n += 1; return assetFetch({ 'skill_ns_a_1.0.0.tar.gz': bytes })(u); },
  });
  assert.equal(n, 1, '按摘要去重');
});

// ── 预算 ───────────────────────────────────────────────────────────────────

test('🔴 总量闸：单文件上限拦不住「很多个小文件」', async () => {
  const cacheDir = tmp();
  const bytes = Buffer.from('x');
  const hex = sha256Of(bytes).slice(7);
  const recs = Array.from({ length: 10 }, (_, i) => REC({
    id: `skill:ns/n${i}@1.0.0`, name: `n${i}`,
    asset: { file: `skill_ns_n${i}_1.0.0.tar.gz`, sha256: `sha256:${hex}`, size: 1 },
  }));
  // 摘要相同会被去重，所以给它们不同的字节
  const uniq = recs.map((r, i) => {
    const b = Buffer.from(String(i).padStart(4, '0'));
    return { rec: { ...r, asset: { ...r.asset, sha256: sha256Of(b), size: 4 } }, b };
  });
  const map = Object.fromEntries(uniq.map(({ rec, b }) => [rec.asset.file, b]));
  await assert.rejects(
    () => preheatAssets({
      cacheDir, n: 3, records: uniq.map((x) => x.rec),
      fetchImpl: assetFetch(map),
      budget: newBudget({ maxRequests: 3 }),
    }),
    /请求数超过上限 3/,
  );
});

// ── 提升（Codex P0：并发竞态 + 提升顺序）─────────────────────────────────

import { promoteMetadata } from '../src/preheat.mjs';
import { makeFloor, TRUST_FILE, resolveStateDir } from '../src/trust.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { mkdirChainFsync } from '../src/atomic-fs.mjs';
import { acquire } from '../src/lock.mjs';
import { METADATA_LOCK } from '../src/trust.mjs';

function setupPromote({ n = 3 } = {}) {
  const cacheDir = tmp();
  const stateDir = tmp();
  const stagingDir = join(cacheDir, '.staging', 'x');
  mkdirChainFsync(join(stagingDir, 'snapshots'));
  writeFileSync(join(stagingDir, 'timestamp.json'), 'TS');
  writeFileSync(join(stagingDir, 'snapshots', `${n}.json`), 'SNAP');
  writeFileSync(join(stagingDir, 'snapshots', `${n}.sigstore.json`), 'BUNDLE');
  const floor = makeFloor({
    timestamp_version: 2, timestamp_sha256: 'sha256:' + '1'.repeat(64),
    latest_snapshot: n, snapshot_sha256: 'sha256:' + '2'.repeat(64),
  });
  mkdirChainFsync(resolveStateDir(stateDir));
  writeFileSync(join(resolveStateDir(stateDir), TRUST_FILE), stringify(floor));
  return { cacheDir, stateDir, stagingDir, n, floor };
}

test('提升成功后三个文件都在缓存里', () => {
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor });
  assert.equal(readFileSync(join(cacheDir, 'timestamp.json'), 'utf8'), 'TS');
  assert.equal(readFileSync(join(cacheDir, 'snapshots', `${n}.json`), 'utf8'), 'SNAP');
  assert.equal(readFileSync(join(cacheDir, 'snapshots', `${n}.sigstore.json`), 'utf8'), 'BUNDLE');
});

test('🔴 floor 在 preheat 期间被别人推高 → 拒绝提升，且缓存不留半份', () => {
  // Codex 指出的真实竞态：
  //   ① preheat A 验过 v2、推进 floor 到 v2
  //   ② preheat B 推进到 v3 并落盘
  //   ③ A 这时才把自己的 v2 提升进 cache
  // 结果 cache/timestamp.json=v2 而 floor 已是 v3 —— 之后每次 install 都必然失败。
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  const newer = makeFloor({
    timestamp_version: 3, timestamp_sha256: 'sha256:' + '3'.repeat(64),
    latest_snapshot: n + 1, snapshot_sha256: 'sha256:' + '4'.repeat(64),
  });
  writeFileSync(join(resolveStateDir(stateDir), TRUST_FILE), stringify(newer));

  assert.throws(() => promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor }),
    /E_FLOOR_MOVED|floor 的/);
  // 🔴 一个字节都不许进缓存 —— 这才是这条闸的意义
  assert.equal(existsSync(join(cacheDir, 'timestamp.json')), false, 'timestamp 不许落地');
  assert.equal(existsSync(join(cacheDir, 'snapshots', `${n}.json`)), false, '快照也不许落地');
});

test('🔴 timestamp 必须最后提升 —— 断电也不许留下指向不存在快照的指针', () => {
  // 用 no-replace 冲突来在**中途**制造失败：让 bundle 那一步撞上一份不同的旧字节。
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  mkdirChainFsync(join(cacheDir, 'snapshots'));
  writeFileSync(join(cacheDir, 'snapshots', `${n}.sigstore.json`), 'DIFFERENT');

  assert.throws(() => promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor }),
    /已存在，且内容与刚下载的不一致/);

  // 顺序保证：快照正文已经进去了（孤儿，没人引用 —— 安全），
  // 而 timestamp **没有** —— 所以缓存里不存在「指向不存在的 N」的坏指针。
  assert.equal(readFileSync(join(cacheDir, 'snapshots', `${n}.json`), 'utf8'), 'SNAP', '孤儿快照可以留下');
  assert.equal(existsSync(join(cacheDir, 'timestamp.json')), false,
    '🔴 timestamp 是指针，必须排在最后 —— 它先落地就会留下坏指针');
});

test('🔴 timestamp 是滚动的 —— 第二次拿到不同内容必须替换，不能报冲突', () => {
  // Codex 2026-09-03 找出的 P0，我自己没看出来：
  //   no-replace 套在 timestamp 上 → 第二次 preheat 必然 E_CACHE_CONFLICT，
  //   而 floor 此前已推进 → 缓存永久卡在旧 timestamp，之后每次 install 都失败。
  //
  // ⚠️ 我原本那条「幂等」测试只覆盖**同内容**的情形，所以它永远绿 ——
  //    断言了错误的契约。这一条测的才是真契约。
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  mkdirChainFsync(join(cacheDir, 'snapshots'));
  writeFileSync(join(cacheDir, 'timestamp.json'), 'OLD-TS');   // 上一轮留下的

  promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor });
  assert.equal(readFileSync(join(cacheDir, 'timestamp.json'), 'utf8'), 'TS',
    'timestamp 必须被新的替换掉');
});

test('快照与 bundle 反过来：同名不同内容必须报冲突（它们不可变）', () => {
  // N 定了内容就定了。同一个 N 下出现两份不同的字节，
  // 至少有一份是错的 —— 静默覆盖会变成「今天能装、明天不能装」的幽灵故障。
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  mkdirChainFsync(join(cacheDir, 'snapshots'));
  writeFileSync(join(cacheDir, 'snapshots', `${n}.json`), 'DIFFERENT');
  assert.throws(() => promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor }),
    /已存在，且内容与刚下载的不一致/);
});

test('同名同内容的快照不算冲突 —— 重跑 preheat 要能幂等', () => {
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  mkdirChainFsync(join(cacheDir, 'snapshots'));
  writeFileSync(join(cacheDir, 'snapshots', `${n}.json`), 'SNAP');
  assert.doesNotThrow(() => promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor }));
});

// ── Codex 复查指出「测试没覆盖」的几条 ─────────────────────────────────────

test('🔴 字节闸必须事前预留 —— 不能等下完了才发现超限', async () => {
  // 事后记账的话，最后一个资产可以任意大：它已经进内存了才被拒。
  const cacheDir = tmp();
  const big = Buffer.alloc(1000, 7);
  const rec = REC({ asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: sha256Of(big), size: 1000 } });
  let fetched = false;
  await assert.rejects(
    () => preheatAssets({
      cacheDir, n: 3, records: [rec],
      fetchImpl: async (u) => { fetched = true; return assetFetch({ 'skill_ns_name_1.0.0.tar.gz': big })(u); },
      budget: newBudget({ maxBytes: 100 }),
    }),
    /会超过上限 100.*这一份还要 1000/s,
  );
  assert.equal(fetched, false, '🔴 超限的资产**根本不该被下载**，不是下完再拒');
});

test('🔴 总时限用尽后不再发请求；单次超时取剩余时限', async () => {
  const cacheDir = tmp();
  const b = Buffer.from('x');
  const rec = REC({ asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: sha256Of(b), size: 1 } });
  let t = 1000;
  await assert.rejects(
    () => preheatAssets({
      cacheDir, n: 3, records: [rec],
      fetchImpl: assetFetch({ 'skill_ns_name_1.0.0.tar.gz': b }),
      budget: newBudget({ maxMs: 10, now: () => (t += 1000) }),
    }),
    /超过总时限/,
  );
});

test('🔴 asset.file 的校验在缓存命中之前 —— 闸放在快路径后面等于没有闸', async () => {
  const cacheDir = tmp();
  const bytes = Buffer.from('cached');
  const hex = sha256Of(bytes).slice(7);
  // 先让缓存里已经有这份字节
  await preheatAssets({
    cacheDir, n: 3,
    records: [REC({ asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: `sha256:${hex}`, size: 6 } })],
    fetchImpl: assetFetch({ 'skill_ns_name_1.0.0.tar.gz': bytes }),
  });
  // 同摘要、但 asset.file 是错的 —— 命中缓存也必须拒
  await assert.rejects(
    () => preheatAssets({
      cacheDir, n: 3,
      records: [REC({ asset: { file: '../../evil.tar.gz', sha256: `sha256:${hex}`, size: 6 } })],
      fetchImpl: async () => { throw new Error('不该出网'); },
    }),
    /asset\.file/,
  );
});

test('🔴 n 在每个把它拼进路径的入口都要校验，不只是 peek', async () => {
  await assert.rejects(
    () => preheatAssets({ cacheDir: tmp(), n: '../../etc', records: [], fetchImpl: async () => {} }),
    /非负安全整数/,
  );
  const { cacheDir, stateDir, stagingDir, floor } = setupPromote();
  assert.throws(
    () => promoteMetadata({ cacheDir, stateDir, stagingDir, n: '3', expectedFloor: floor }),
    /非负安全整数/,
  );
});

test('🔴 floor 的重核必须在锁**内** —— 别人持锁时应先报锁忙', async () => {
  // Codex 指出我原来那条证明不了顺序：它在调用前就把 floor 改高，
  // 于是即使把 assertFloorUnchanged 错误地移到 acquire **之前**，测试照样绿。
  // 判据改成：别人持着 metadata 锁 **且** floor 也不匹配时，
  // 先报出来的必须是**锁忙**，而不是 E_FLOOR_MOVED。
  const { cacheDir, stateDir, stagingDir, n, floor } = setupPromote();
  const newer = makeFloor({
    timestamp_version: 9, timestamp_sha256: 'sha256:' + '9'.repeat(64),
    latest_snapshot: n + 5, snapshot_sha256: 'sha256:' + '8'.repeat(64),
  });
  writeFileSync(join(resolveStateDir(stateDir), TRUST_FILE), stringify(newer));

  const release = acquire(join(resolveStateDir(stateDir), METADATA_LOCK), { cli: 'test-holder' });
  try {
    assert.throws(
      () => promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor }),
      (e) => {
        assert.ok(!/E_FLOOR_MOVED/.test(String(e.code ?? '') + e.message),
          '🔴 报了 E_FLOOR_MOVED 说明 floor 是在取锁**之前**读的 —— 临界区没覆盖到它');
        return true;
      },
    );
  } finally { release(); }
});

test('🔴 缓存里的截断文件要删掉重下 —— 名字是摘要，坏文件看起来像验过了', async () => {
  const cacheDir = tmp();
  const bytes = Buffer.from('0123456789');
  const hex = sha256Of(bytes).slice(7);
  const rec = REC({ asset: { file: 'skill_ns_name_1.0.0.tar.gz', sha256: `sha256:${hex}`, size: 10 } });
  // 造一个崩溃留下的截断文件：名字对，字节少
  mkdirSync(join(cacheDir, 'assets'), { recursive: true });
  writeFileSync(join(cacheDir, 'assets', hex), '012');

  const out = await preheatAssets({
    cacheDir, n: 3, records: [rec],
    fetchImpl: assetFetch({ 'skill_ns_name_1.0.0.tar.gz': bytes }),
  });
  assert.deepEqual(out.map((x) => x.cached), [false], '不能当成命中');
  assert.equal(readFileSync(join(cacheDir, 'assets', hex), 'utf8'), '0123456789', '应当重下并补全');
});
