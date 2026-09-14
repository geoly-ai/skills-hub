// `skills-hub telemetry delete` 端到端 —— 走 main()，fetch 走**缺省分支**。
//
// 🔴 为什么不注入 fetchImpl：cli.mjs 调 remoteDelete 时什么都不传，生产只走
//    `fetchImpl ?? globalThis.fetch` 那一支。单测每次都注入替身，那一支就从没被执行过
//    （记忆：缺省分支从来没被测过）。这里替换的是 globalThis.fetch 本身。
// 🔴 假服务端用真的 server/delete.mjs 验签：客户端签名消息漂了，这里会先红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { parseStrict } from '../src/canonical-json.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { deleteKey } from '../src/telemetry.mjs';
import {
  CHALLENGE_SCHEMA, DELETE_SCHEMA, checkNonce, mintNonce, pubkeyTag, verifyProof,
} from '../server/delete.mjs';

const SECRET = 'c'.repeat(32);
const AUD = 'https://skills-hub-telemetry.vercel.app/v1/delete';
const ENV_KEYS = ['GEOLY_STATE_DIR', 'GEOLY_OFFLINE', 'GEOLY_TELEMETRY', 'GEOLY_TELEMETRY_UPLOAD',
  'GEOLY_TELEMETRY_ENDPOINT', 'GEOLY_TELEMETRY_IDENTITY'];

const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

/**
 * 搭一台机器的状态，替换 globalThis.fetch，跑一次 `telemetry delete --json`。
 * @param {'ok'|'500'|'boom'} server boom = 任何出网都算失败
 */
async function scenario({ env = {}, key = false, notice = false, identityOff = false, server = 'ok' }, check) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const root = mkdtempSync(join(tmpdir(), 'tdel-cli-'));
  process.env.GEOLY_STATE_DIR = root;
  Object.assign(process.env, env);
  const dir = join(root, 'telemetry');
  if (key || notice || identityOff) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (notice) writeFileSync(join(dir, 'identity-notice.v2'), `shown-at=${new Date().toISOString()}\n`);
  if (identityOff) writeFileSync(join(dir, 'identity-off'), 'off-at=2026-09-13T00:00:00Z\n');
  if (key) assert.ok(deleteKey({ create: true }), '前提自查：私钥没建出来');

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (server === 'boom') throw new Error('这个用例不该出网');
    if (server === '500') return json({ error: 'internal' }, 500);
    const body = JSON.parse(init.body);
    const tag = pubkeyTag(body.pubkey, SECRET);
    if (String(url).endsWith('/delete/challenge')) {
      return json({ schema: CHALLENGE_SCHEMA, audience: AUD, nonce: mintNonce(tag, { secret: SECRET }), expires_in: 300 });
    }
    const ok = verifyProof({ audience: AUD, ...body }) && checkNonce(body.nonce, tag, { secret: SECRET }).ok;
    return ok ? json({ schema: DELETE_SCHEMA, deleted: true }) : json({ error: 'bad-proof' }, 400);
  };
  try {
    const so = cap(); const se = cap();
    const code = await main(['telemetry', 'delete', '--json'], { stdout: so, stderr: se, record: () => {} });
    let doc;
    try { doc = parseStrict(so.s); } catch { assert.fail(`--json 输出不是单个对象：${so.s}\nstderr: ${se.s}`); }
    await check({ code, doc, calls, dir });
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('从没发过身份的机器：不出网，退出 0', async () => {
  await scenario({ server: 'boom' }, ({ code, doc, calls }) => {
    assert.equal(calls.length, 0);
    assert.equal(doc.remote, 'nothing-remote');
    assert.equal(code, EXIT.OK);
  });
});

test('🔴 有私钥：先远程删除成功，再清本机（私钥一起删），退出 0', async () => {
  await scenario({ key: true, notice: true }, ({ code, doc, calls, dir }) => {
    assert.deepEqual(calls, [`${AUD}/challenge`, AUD], '走的不是缺省 fetch，或者请求顺序不对');
    assert.equal(doc.remote, 'deleted');
    assert.equal(doc.deleteKeyRemoved, true);
    assert.equal(existsSync(join(dir, 'delete-key')), false);
    assert.equal(code, EXIT.OK);
  });
});

test('🔴 off → delete：「关闭身份」的设置保留', async () => {
  await scenario({ key: true, notice: true, identityOff: true }, ({ doc, dir }) => {
    assert.equal(doc.remote, 'deleted');
    assert.ok(doc.kept.includes('identity-off'));
    assert.equal(existsSync(join(dir, 'identity-off')), true, 'delete 替用户把身份采集重新打开了');
  });
});

test('🔴 服务端失败：私钥保留、如实报告、退出码非零', async () => {
  await scenario({ key: true, notice: true, server: '500' }, ({ code, doc, dir }) => {
    assert.equal(doc.remote, 'remote-failed');
    assert.equal(doc.reason, 'http-500');
    assert.equal(doc.deleteKeyRemoved, false);
    assert.equal(existsSync(join(dir, 'delete-key')), true, '远程没删成还把私钥删了 —— 那批数据再也证明不了是谁的');
    assert.equal(code, EXIT.NETWORK);
  });
});

test('🔴 --offline：不出网、私钥保留、退出码 PARTIAL', async () => {
  await scenario({ key: true, notice: true, server: 'boom', env: { GEOLY_OFFLINE: '1' } }, ({ code, doc, calls, dir }) => {
    assert.equal(calls.length, 0);
    assert.equal(doc.remote, 'vetoed');
    assert.equal(existsSync(join(dir, 'delete-key')), true);
    assert.equal(code, EXIT.PARTIAL);
  });
});

test('🔴 看过身份告知却没有私钥：不能说「服务端没有数据」，退出码 PARTIAL', async () => {
  await scenario({ notice: true, server: 'boom' }, ({ code, doc, calls }) => {
    assert.equal(calls.length, 0);
    assert.equal(doc.remote, 'unprovable');
    assert.equal(code, EXIT.PARTIAL);
  });
});
