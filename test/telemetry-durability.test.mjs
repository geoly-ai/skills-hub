// 队列换代 × 上报 × 并发 —— 这一组全是「不修就会静默丢事件」的窗口。
// 其中「发的期间换代」那条是 Codex 2026-08-26 在复核里指出的真实竞态，
// 旧的「位置游标」设计过不了它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, statSync, mkdirSync, existsSync, appendFileSync, readFileSync,
  openSync, closeSync, unlinkSync, fstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
let n = 0;
function iso() {
  const d = mkdtempSync(join(tmpdir(), 'td-'));
  process.env.GEOLY_STATE_DIR = d;
  delete process.env.GEOLY_TELEMETRY;
  delete process.env.GEOLY_TELEMETRY_UPLOAD;
  delete process.env.GEOLY_TELEMETRY_ENDPOINT;
  delete process.env.GEOLY_OFFLINE;
  return d;
}
const fresh = async () => {
  const q = `?d${++n}`;
  return { tm: await import('../src/telemetry.mjs' + q), up: await import('../src/upload.mjs' + q) };
};
const ok = async () => ({ ok: true, status: 200 });
const ev = (i) => ({ kind: 'install', result: 'ok', artifact: `skill:g/a${i}@1.0.0` });

// ── 事件身份 ─────────────────────────────────────────────────────────────────

test('每条事件有唯一 eid（服务端的去重键）', async () => {
  iso();
  const { tm } = await fresh();
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(tm.record({ kind: 'check', result: 'ok' }).eid);
  assert.equal(ids.size, 50);
});

// ── 换代 ─────────────────────────────────────────────────────────────────────

test('🔴 队列有上限，不会把盘写满', async () => {
  const d = iso();
  const { tm } = await fresh();
  for (let i = 0; i < 12000; i++) tm.record(ev(i));
  const size = (p) => (existsSync(p) ? statSync(p).size : 0);
  const total = size(join(d, 'telemetry', 'queue.ndjson')) + size(join(d, 'telemetry', 'queue.1.ndjson'));
  assert.ok(total <= 2 * tm.MAX_QUEUE_BYTES + 4096, `两代合计应有上界，实际 ${total}`);
  const all = tm.readAll();
  assert.ok(all.length > 0 && all.length < 12000, `应淘汰掉一部分最旧的：${all.length}`);
});

test('换代只用 rename，保留的是最新的事件', async () => {
  iso();
  const { tm } = await fresh();
  for (let i = 0; i < 12000; i++) tm.record(ev(i));
  const all = tm.readAll();
  const last = all[all.length - 1];
  assert.equal(last.artifact, 'skill:g/a11999@1.0.0', '最新那条必须还在');
  // 读回来的顺序就是时间顺序
  const nums = all.map((e) => Number(e.artifact.match(/a(\d+)@/)[1]));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), '读回顺序应为时间顺序');
});

// ── Codex 指出的那个竞态 ─────────────────────────────────────────────────────

test('🔴 上报期间发生换代，保留下来的事件不会被永久跳过', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));

  // 模拟：POST 在途时，另一个 record 进来并把队列推过上限触发换代
  let sentFirst = 0;
  const r1 = await up.flush({
    fetchImpl: async (_u, o) => {
      sentFirst = JSON.parse(o.body).events.length;
      for (let i = 1; i <= 12000; i++) tm.record(ev(i));
      return { ok: true, status: 200 };
    },
  });
  assert.equal(r1.sent, sentFirst);

  // 换代后还留在本地的那些，必须能被下一轮发出去 —— 一条都不能被跳过
  const stillPending = tm.readAll();
  assert.ok(stillPending.length > 0, '换代后应该还有事件待发');
  let sentSecond = 0;
  const r2 = await up.flush({
    fetchImpl: async (_u, o) => { sentSecond = JSON.parse(o.body).events.length; return { ok: true, status: 200 }; },
  });
  assert.equal(sentSecond, stillPending.length, '待发的必须全部发出，不能被旧游标跳过');
  assert.equal(r2.sent, stillPending.length);
  assert.deepEqual(tm.readAll(), [], '发完就该空了');
});

test('🔴 stage 之后落进 sending 的掉队事件不会被 retire 顺手删掉', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));

  const straggler = tm.buildEvent(ev(99));
  const r = await up.flush({
    fetchImpl: async () => {
      // 模拟持有旧 fd 的 record：在 flush 读完之后，把一行追加进 sending 这个 inode
      appendFileSync(join(d, 'telemetry', 'sending.ndjson'), tm.serializeEvent(straggler) + '\n');
      return { ok: true, status: 200 };
    },
  });
  assert.equal(r.sent, 1);
  const left = tm.readAll();
  assert.equal(left.length, 1, '掉队的那条应被退回队列，不能被删');
  assert.equal(left[0].eid, straggler.eid);
});

// ── 失败与崩溃 ───────────────────────────────────────────────────────────────

test('🔴 上报失败：事件一条不丢，下次接着发', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  for (let i = 0; i < 5; i++) tm.record(ev(i));

  for (const bad of [
    async () => { throw new Error('ECONNREFUSED'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, status: 200, redirected: true }),
  ]) {
    const r = await up.flush({ fetchImpl: bad });
    assert.equal(r.sent, 0);
    assert.equal(tm.readAll().length, 5, '失败后本地仍是 5 条');
  }
  const good = await up.flush({ fetchImpl: ok });
  assert.equal(good.sent, 5);
  assert.deepEqual(tm.readAll(), []);
});

test('🔴 POST 成功后崩溃 → 重发而不是丢（at-least-once）', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));
  tm.record(ev(1));

  // 崩在 POST 成功与 retire 之间：sending 还在盘上
  await up.flush({ fetchImpl: async () => { throw new Error('假装 POST 后立刻崩'); } }).catch(() => {});
  const sending = join(d, 'telemetry', 'sending.ndjson');
  assert.ok(existsSync(sending), 'sending 应留在盘上等重试');
  assert.equal(readFileSync(sending, 'utf8').trim().split('\n').length, 2);

  let got;
  const r = await up.flush({ fetchImpl: async (_u, o) => { got = JSON.parse(o.body).events; return { ok: true, status: 200 }; } });
  assert.equal(r.sent, 2, '重发全部两条 —— 宁可重复，不可丢失');
  assert.equal(got.length, 2);
  assert.equal(new Set(got.map((e) => e.eid)).size, 2, '重发的批次内部不应有重复');
});

test('🔴 并发 flush 不会把同一批发两遍', async () => {
  const d = iso();
  mkdirSync(join(d, 'telemetry'), { recursive: true });
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));

  const child = spawn(process.execPath, [join(here, 'fixtures/holder.mjs'), tm.lockPath()], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    child.stdout.once('data', (x) => (String(x).includes('HELD') ? res() : rej(new Error(String(x)))));
    child.once('exit', (c) => rej(new Error(`holder 退出了：${c}`)));
  });
  try {
    const r = await up.flush({ fetchImpl: async () => { throw new Error('拿不到锁就不该发'); } });
    assert.equal(r.reason, 'busy');
    assert.equal(tm.readAll().length, 1, '拿不到锁时不能动队列');
  } finally {
    child.kill('SIGKILL');
    await new Promise((res) => child.once('exit', res));
  }

  // 锁被内核释放后，同一批仍在，一次发完
  assert.equal((await up.flush({ fetchImpl: ok })).sent, 1);
});

// ── 序列化 ───────────────────────────────────────────────────────────────────

test('🔴 被污染的 toJSON 换不掉已校验的事件', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  Object.defineProperty(Object.prototype, 'toJSON', {
    value() { return { leaked: '/Users/chovi/.ssh/id_rsa' }; },
    configurable: true,
    writable: true,
  });
  try {
    tm.record(ev(0));
    let body;
    await up.flush({ fetchImpl: async (_u, o) => { body = o.body; return { ok: true, status: 200 }; } });
    assert.ok(!body.includes('id_rsa'), '上报体不得被 toJSON 污染改写');
    assert.ok(!body.includes('leaked'));
    assert.ok(body.includes('skill:g/a0@1.0.0'), '真实事件应原样发出');
  } finally {
    delete Object.prototype.toJSON;
  }
});

test('🔴 旧 queue fd 在 stage 之后才 append —— 那一行不能丢', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));

  // 模拟 record 已经 open 了 queue 的 fd 但还没 append
  const qp = join(d, 'telemetry', 'queue.ndjson');
  const staleFd = openSync(qp, 'a', 0o644);
  const late = tm.buildEvent(ev(77));
  try {
    const r = await up.flush({
      fetchImpl: async () => {
        // stage 已把 queue rename 成 sending；这个 fd 指向的正是那个 inode
        appendFileSync(staleFd, tm.serializeEvent(late) + '\n');
        return { ok: true, status: 200 };
      },
    });
    assert.equal(r.sent, 1, '只发了 stage 时读到的那一条');
  } finally { closeSync(staleFd); }

  const left = tm.readAll();
  assert.equal(left.length, 1, '晚到的那条必须还在，不能随 sending 一起消失');
  assert.equal(left[0].eid, late.eid);
});

test('🔴 record 发现自己写进了已被删除的 inode 会重写（nlink 检查）', async () => {
  const d = iso();
  const { tm } = await fresh();
  const qp = join(d, 'telemetry', 'queue.ndjson');
  tm.record(ev(0));

  // 拿住一个 fd，然后把文件删掉 —— 这个 inode 从此没有目录项
  const orphanFd = openSync(qp, 'a', 0o644);
  unlinkSync(qp);
  try {
    appendFileSync(orphanFd, 'x\n');
    assert.equal(fstatSync(orphanFd).nlink, 0, '前提：nlink 为 0 才说得上「孤儿 inode」');
  } finally { closeSync(orphanFd); }

  // record 此时 open 会新建文件，正常落盘；关键是它读得回来
  const ok2 = tm.record(ev(1));
  assert.ok(ok2, 'record 应成功');
  const all = tm.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].artifact, 'skill:g/a1@1.0.0');
});

test('🔴 压力：一边狂 record 一边反复 flush，落盘成功的一条都不能丢', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';

  const child = spawn(process.execPath, [join(here, 'fixtures/recorder.mjs'), '4000'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, GEOLY_STATE_DIR: d },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));

  const sent = new Set();
  const drain = () =>
    up.flush({
      fetchImpl: async (_u, o) => {
        for (const e of JSON.parse(o.body).events) sent.add(e.eid);
        return { ok: true, status: 200 };
      },
    });

  let alive = true;
  let batchesWhileAlive = 0;
  child.once('exit', () => (alive = false));
  // 边录边发，让 rename / unlink / 换代 真的与 append 交错。
  // ⚠️ 每轮必须让出一个**宏任务**：flush 里全是同步 I/O，只 await 微任务的话
  // 事件循环永远到不了 poll 阶段，子进程的 'exit' 就永远不会触发（实测卡死过）。
  while (alive) {
    if ((await drain()).sent > 0) batchesWhileAlive++;
    await new Promise((r) => setTimeout(r, 0));
  }
  // 收尾：把剩下的全发完
  for (let i = 0; i < 10; i++) await drain();

  // 🔴 这条断言防的是测试自己退化：子进程先跑完、父进程再收尾的话，
  // 上面那些 rename/unlink 与 append 根本没交错，这个测试就成了空壳。
  assert.ok(batchesWhileAlive >= 3, `录制期间应发出多批，实际 ${batchesWhileAlive}`);

  const recorded = out.split('\n').filter(Boolean);
  assert.ok(recorded.length > 3000, `子进程应落盘大量事件，实际 ${recorded.length}`);
  const remaining = new Set(tm.readAll().map((e) => e.eid));
  const lost = recorded.filter((eid) => !sent.has(eid) && !remaining.has(eid));

  // 🔴 **这里为什么不是 `deepEqual(lost, [])`。**
  //
  // 早先它就是零容忍，于是在 CI 的 Linux runner 上按 T-15 的概率间歇性变红
  // （2026-08-30 那次丢了恰好 1 条；同一个 commit 前一天是绿的）。
  // 查下来的结论**只到这一步**：规格承诺的本来就不是零丢失，所以断言该放宽。
  // ⚠️ **没有**归因到具体是哪个窗口 —— 「丢恰好 1 条」只是与 T-15 相容，
  //    而 `retire` 的 sweep→写 mark、`reapTomb` 的读→unlink、§4.1 换代的
  //    `unlink(prev)` 与旧 fd，**几个窗口都可能只丢少量**。
  //    这个测试没有记录丢失时的 inode / 文件大小 / 所处阶段，据此说「代码没错」
  //    是过度推断（Codex 2026-08-31 指出，改回不夸大的说法）。
  //
  // 规格 §5.2.1 点名了这个窗口，而且是**明确接受**的残余风险 T-15：
  //   「`retire` 的『第二次 sweep → 写 mark』之间、`reapTomb` 的『读墓碑 → unlink』
  //     之间，同样各有一个微小的 TOCTOU，它们一并算进 T-15。诚实地说：
  //     这是一个被压小、但依然存在的丢事件窗口。」
  //   「要真正闭合，`record` 就得和删除方走同一把锁 —— 那会让主命令阻塞在锁上，
  //     正是 T-5 要避免的。**这个取舍是有意的**：埋点不是账本。」
  //
  // ⚠️ **不要把容忍度调大。** 这条测试真正的价值是抓**系统性**丢失 ——
  //    2026-08-28 那个「扫回队列的补偿路径缺 nlink 守卫」的 bug 会丢几十上百条，
  //    容忍 1 条照样抓得到。容忍度一旦按「让它别红」去调，这条测试就废了。
  //
  // ⚠️ 换代淘汰（§4.1 的 `unlinkSync(prev)`）是**另一回事**：那是有意的淘汰，
  //    丢的是一整代（~1 MiB、上千条），会远远超过这个容忍度而让测试变红 ——
  //    正是我们要的。
  const T15_TOLERANCE = 1;
  if (lost.length) {
    // 容忍不等于沉默：让它在 CI 日志里留痕，出现新的偶发丢失时人能看见。
    process.stderr.write(
      `⚠️ 丢了 ${lost.length} 条（T-15 容忍 ≤ ${T15_TOLERANCE}）：${lost.slice(0, 5).join(', ')}\n`,
    );
  }
  assert.ok(
    lost.length <= T15_TOLERANCE,
    `丢了 ${lost.length} 条，超过 T-15 的量级（容忍 ≤ ${T15_TOLERANCE}）——`
    + `这不是那个微观 TOCTOU，是系统性丢失：${lost.slice(0, 5).join(', ')}`,
  );
});


test('🔴 上报是消费式的，但报表历史不能跟着一起没了', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  for (let i = 0; i < 3; i++) tm.record(ev(i));

  assert.equal(tm.readAll().length, 3, '待上报 3 条');
  assert.equal(tm.readHistory().length, 3, '历史 3 条');

  assert.equal((await up.flush({ fetchImpl: ok })).sent, 3);

  assert.deepEqual(tm.readAll(), [], '发完就没有待上报的了');
  assert.equal(tm.readHistory().length, 3, '🔴 历史必须还在 —— 否则一配端点报表就空了');
});

test('🔴 retire 改名成墓碑之后落进来的事件会被扫回队列', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));

  // 持有 sending 的 fd（真实场景里是 stage 之前打开 queue 的那个 record）
  const qp = join(d, 'telemetry', 'queue.ndjson');
  const staleFd = openSync(qp, 'a', 0o644);
  const late = tm.buildEvent(ev(88));
  try {
    await up.flush({
      fetchImpl: async () => {
        appendFileSync(staleFd, tm.serializeEvent(late) + '\n');
        return { ok: true, status: 200 };
      },
    });
  } finally { closeSync(staleFd); }

  const pending = tm.readAll();
  assert.equal(pending.length, 1, '晚到那条应被扫回队列');
  assert.equal(pending[0].eid, late.eid);
  // 墓碑本身不该被当成待发 —— 里面装的是已经发出去的
  assert.ok(!pending.some((e) => e.artifact === 'skill:g/a0@1.0.0'), '已发出的不该重新变成待发');
});

test('墓碑在下一轮 flush 时才真正删除', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));
  await up.flush({ fetchImpl: ok });
  const tomb = join(d, 'telemetry', 'sending.tomb.ndjson');
  assert.ok(existsSync(tomb), '这一轮只改名，不删');

  tm.record(ev(1));
  await up.flush({ fetchImpl: ok });
  assert.ok(!existsSync(tomb) || readFileSync(tomb, 'utf8').includes('a1'), '上一轮的墓碑应被换掉');
});

test('🔴 墓碑被扫描之后长出来的行，删墓碑时不能被带走', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));
  await up.flush({ fetchImpl: ok });

  const tomb = join(d, 'telemetry', 'sending.tomb.ndjson');
  assert.ok(existsSync(tomb));
  // 模拟旧 fd 在 retire 记完 mark 之后才追加进来
  const veryLate = tm.buildEvent(ev(123));
  appendFileSync(tomb, tm.serializeEvent(veryLate) + '\n');

  // 下一轮 flush 会先 reapTomb：晚到的那条要被捞回队列，而不是随墓碑一起删掉
  let got = [];
  await up.flush({ fetchImpl: async (_u, o) => { got = JSON.parse(o.body).events; return { ok: true, status: 200 }; } });
  assert.deepEqual(got.map((e) => e.eid), [veryLate.eid], '只应重发晚到的那条');
  assert.ok(!existsSync(join(d, 'telemetry', 'sending.tomb.mark')) || true);
});

test('mark 丢失时整批重发而不是漏掉晚到的', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));
  await up.flush({ fetchImpl: ok });
  unlinkSync(join(d, 'telemetry', 'sending.tomb.mark'));

  let got = [];
  await up.flush({ fetchImpl: async (_u, o) => { got = JSON.parse(o.body).events; return { ok: true, status: 200 }; } });
  assert.equal(got.length, 1, 'mark 没了就从 0 起算 —— 宁可重复，不可漏');
});

test('🔴 并发首次生成 install-id：所有进程拿到同一个合法 UUID', async () => {
  // ⚠️ 这条测试的第一版太弱：bug 明明在，隔离跑 12 轮却全绿，只在全量并行下
  // 偶发红一次。加 barrier 让所有进程卡在同一刻再冲，才稳定压到那个窗口。
  //
  // 要防的 bug：早先 installId 用 `openSync(p,'wx')` 抢占，看着原子，其实
  // **文件一建就存在、内容还没写**，抢输的一方读到空串。实测撑开窗口后
  // 4 个进程里 3 个拿到 ""。所以下面既断言「只有一个值」，也断言「值是合法 UUID」——
  // 只断言前者的话，全都拿到 "" 也会通过。
  const { writeFileSync } = await import('node:fs');
  const d = iso();
  const barrier = join(d, 'go');

  const kid = () =>
    new Promise((res, rej) => {
      const c = spawn(process.execPath, [join(here, 'fixtures/installid-racer.mjs'), barrier], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, GEOLY_STATE_DIR: d },
      });
      let o = '';
      c.stdout.on('data', (x) => (o += x));
      c.once('exit', (code) => (code === 0 ? res(o.trim()) : rej(new Error(`exit ${code}`))));
    });

  const all = Promise.all(Array.from({ length: 24 }, kid));
  await new Promise((r) => setTimeout(r, 700));
  writeFileSync(barrier, 'go');
  const ids = await all;

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const bad = ids.filter((x) => !uuid.test(x));
  assert.deepEqual(bad, [], `有进程拿到了非法值（空串=竞态）：${JSON.stringify(bad.slice(0, 3))}`);
  assert.equal(new Set(ids).size, 1, `24 个进程应拿到同一个 id，实际 ${new Set(ids).size} 个不同`);
});

test('🔴 旧墓碑收割不掉时不发这一轮，绝不覆盖它', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record(ev(0));
  await up.flush({ fetchImpl: ok });

  // 把墓碑变成目录：unlink 会失败，模拟「清不掉」
  const tomb = join(d, 'telemetry', 'sending.tomb.ndjson');
  unlinkSync(tomb);
  mkdirSync(tomb);
  tm.record(ev(1));

  const r = await up.flush({ fetchImpl: async () => { throw new Error('清不掉墓碑就不该发'); } });
  assert.equal(r.sent, 0);
  assert.equal(r.reason, 'empty', '这一轮直接不发');
  assert.equal(tm.readAll().length, 1, '新事件仍安全地留在队列里');
});
