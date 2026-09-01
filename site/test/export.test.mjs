// 端到端：拿 fixture 快照跑 `build.mjs + next build`，然后**扫产物**。
//
// 🔴 为什么要扫产物而不是只测模型：本站点最重要的两条约束
//    （"不出现使用量数字"、"敌意文本必须被转义"）都只有在**最终 HTML 上**才成立或不成立。
//    模型层干净、模板里手滑写一句"下载量：—"，测试照样全绿。
//
// ⚠️ 这个用例会重跑 `next build`，比较慢（十几秒），并且会覆盖 `.generated/site-data.json`
//    与 `out/`。收尾时用真实目录重新生成一次数据，免得把工作树留在 fixture 状态。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixtureRegistry } from './fixture.mjs';
import { walk, assertNoBannedWords } from './banned-words.mjs';

const SITE = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(SITE, 'out');

const run = (cmd, args) => execFileSync(cmd, args, { cwd: SITE, stdio: 'pipe', encoding: 'utf8' });

const fixture = makeFixtureRegistry();
// 上一次构建的产物必须先清掉：`next build` 不删旧页面，跨状态复用会让断言看到陈旧文件。
for (const d of ['out', '.next']) rmSync(join(SITE, d), { recursive: true, force: true });
run(process.execPath, ['build.mjs', '--snapshots', fixture.snapshotsDir, '--artifacts', fixture.artifactsRoot]);
run(process.execPath, [join(SITE, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build']);

after(() => {
  // 把工作树的数据恢复成"仓库里真实的那张快照"（现在是空 registry）。
  run(process.execPath, ['build.mjs']);
});

const files = walk(OUT);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const textFiles = files.filter((f) => f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.txt'));

test('静态导出：每个制品都有详情页，每个 name 都有版本历史页', () => {
  const want = [
    'artifact/skill/geoly/plaud-theme-dev/0.3.5/index.html',
    'artifact/skill/geoly/plaud-theme-dev/0.3.6/index.html',
    'artifact/skill/geoly/plaud-theme-dev/index.html',
    'artifact/skill/geoly/legacy-runner/1.1.0-rc.1/index.html',
    'artifact/pack/geoly/legacy-matrix/0.1.0/index.html',
    'artifacts/index.html',
    'index.html',
  ];
  for (const w of want) assert.ok(existsSync(join(OUT, w)), `缺页面 ${w}`);
});

test('🔴 产物里不出现任何使用情况指标（有制品的那种构建）', () => {
  assertNoBannedWords(textFiles, assert, OUT);
});

test('🔴 每一页都带"这份数据没验签"的说明', () => {
  for (const f of htmlFiles) {
    if (f.endsWith('404.html') || f.includes('_not-found')) continue;
    const s = readFileSync(f, 'utf8');
    assert.ok(s.includes('没有执行任何验签'), `${f.slice(OUT.length)} 没有说明验签边界`);
  }
});

test('🔴 敌意 description 在 HTML 正文与序列化数据里都被转义', () => {
  const detail = readFileSync(join(OUT, 'artifact/skill/acme/tricky-text/0.1.0/index.html'), 'utf8');
  const list = readFileSync(join(OUT, 'artifacts/index.html'), 'utf8');
  for (const [name, html] of [['详情页', detail], ['列表页', list]]) {
    assert.ok(html.includes('alert(1)'), `${name}：应当出现在页面上（转义后）`);
    // 一个真正被闭合的 </script> 会把后面的字节交回给 HTML 解析器 —— 那就是注入。
    assert.ok(!/<\/script><script>alert\(1\)/.test(html), `${name}：</script> 没有被转义`);
    assert.ok(!html.includes('<img src=x onerror='), `${name}：属性没有被转义`);
  }
});

// ══ 两条轴不许合并（DESIGN.md §0.1 / §11 第 7 条）══════════════════════════
//
// 🔴 这几条是本设计最容易被后来人做丢的地方，所以用测试钉住，而不是靠注释提醒：
//    生命周期（published/deprecated/yanked/degraded，来自快照 status 字段）与
//    验证（verified/stale/unverified/failed，来自我们这一次到底验没验）是**正交**的。

/** 取一页里信任链条（.chain）那一段 HTML —— 只在这一段里判验证轴。 */
function chainOf(file) {
  const html = readFileSync(join(OUT, file), 'utf8');
  const i = html.indexOf('class="chain"');
  assert.ok(i > -1, `${file} 里没有信任链条`);
  const j = html.indexOf('</section>', i);
  return html.slice(i, j);
}

test('🔴 验证轴默认是「未验证」，不是绿勾 —— 本站点确实没验', () => {
  for (const f of ['index.html', 'artifacts/index.html',
    'artifact/skill/geoly/plaud-theme-shared/0.3.6/index.html',
    'artifact/pack/geoly/legacy-matrix/0.1.0/index.html']) {
    const chain = chainOf(f);
    const unverified = chain.split('#i-unverified').length - 1;
    assert.equal(unverified, 4, `${f}：四格都该是虚线圈（未验证），实际 ${unverified} 格`);
    assert.ok(!chain.includes('#i-check'), `${f}：验证链里出现了勾 —— 我们一步都没验`);
    assert.ok(!chain.includes('#i-fail'), `${f}：验证链里出现了圈叉（验了没过）—— 我们没验过`);
  }
});

test('🔴 生命周期是 published 的制品，验证轴照样是未验证（两轴正交）', () => {
  const f = 'artifact/skill/geoly/plaud-theme-shared/0.3.6/index.html';
  const html = readFileSync(join(OUT, f), 'utf8');
  assert.ok(html.includes('st-published'), '生命周期轴：published');
  assert.equal(chainOf(f).split('#i-unverified').length - 1, 4, '验证轴：仍然四格未验证');
});

test('🔴 yanked 用裸叉，验证失败用圈叉，未验证用虚线圈 —— 三个图形不许混用', () => {
  const f = 'artifact/skill/geoly/legacy-runner/1.0.0/index.html';
  const html = readFileSync(join(OUT, f), 'utf8');
  // 生命周期轴的 yanked：裸叉
  assert.ok(/class="status st-yanked"[^>]*>\s*<svg[^>]*><use href="#i-x"/.test(html.replace(/\n/g, '')),
    'yanked 的状态标记必须用裸叉 i-x');
  // 验证轴：这一页没验过，四格仍是虚线圈 —— 绝不能因为它 yanked 就画成叉
  const chain = chainOf(f);
  assert.equal(chain.split('#i-unverified').length - 1, 4);
  assert.ok(!chain.includes('#i-x'), '验证链里不许出现裸叉 —— 那是生命周期轴的符号');
});

test('🔴 不给一个综合绿勾：四格各自独立，且页面写明一步都没跑', () => {
  const html = readFileSync(join(OUT, 'artifact/pack/geoly/plaud-theme-matrix/0.3.6/index.html'), 'utf8');
  for (const cell of ['签名身份', 'Rekor 条目', '树摘要', '快照时效']) {
    assert.ok(html.includes(cell), `信任链条缺格：${cell}`);
  }
  assert.ok(html.includes('一步都没跑'));
  assert.ok(html.includes('这不是加载中'), '未验证必须说明它不会变成已验证');
});

test('🔴 第三条轴（本地比对）不许借用验证轴的图形与措辞', () => {
  // Codex 2026-09-01 P1：早先「载荷已核对」用了 check + 蓝底，
  // 于是页面顶部四格写着「未验证」、下面却出现一个勾，第一眼读成"验证通过"。
  const html = readFileSync(join(OUT, 'artifact/skill/acme/report-writer/2.0.0/index.html'), 'utf8');
  const i = html.indexOf('n-compare');
  assert.ok(i > -1, '本地比对必须用它自己那套表皮（n-compare*）');
  const block = html.slice(i - 400, i + 1200);
  assert.ok(block.includes('#i-equal'), '相同用等号，不是勾');
  assert.ok(!block.includes('#i-check'), '本地比对区里不许出现勾');
  assert.ok(html.includes('本地比对，未验签'), '标题必须自己声明它不是验签');
  // 措辞里不许出现验证轴的词
  const title = html.slice(i, html.indexOf('</h4>', i));
  for (const w of ['verified', '验证通过', '已验证']) {
    assert.ok(!title.includes(w), `本地比对的标题里出现了验证轴的词：${w}`);
  }
});

test('🔴 vendored 的双摘要用 pair 形态并列，且都是常规色（不报红、不做 diff）', () => {
  const html = readFileSync(join(OUT, 'artifact/skill/acme/report-writer/2.0.0/index.html'), 'utf8');
  assert.ok(html.includes('digest-pair'), '必须是 pair 形态');
  assert.ok(html.includes('上游那棵树'), '两行都要有标签');
  assert.ok(html.includes('本制品这棵树'));
  assert.ok(html.includes('本来就不相等，这是预期'), '必须写明不相等是预期');
  assert.ok(html.includes('去掉 added_files'), '必须给出可复算的核对方式');
  // 🔴 不许用 --c-revoked 报红（§11 第 4 条）
  const i = html.indexOf('digest-pair');
  assert.ok(!html.slice(i, i + 2500).includes('--c-revoked'), 'vendored 双摘要不相等不许报红');
});

test('🔴 yanked 的成员整行染红 —— 判据是成员自身状态，不是它拖累了谁', () => {
  const html = readFileSync(join(OUT, 'artifact/pack/geoly/legacy-matrix/0.1.0/index.html'), 'utf8');
  const rows = html.split('<tr').filter((r) => r.includes('legacy-runner@1.0.0'));
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.includes('class="blame"')), '被 yank 的成员整行要染红');
});

test('全局搜索在每一页都在（详情页也能粘 64 hex 反查）', () => {
  for (const f of ['index.html', 'artifacts/index.html',
    'artifact/skill/acme/report-writer/2.0.0/index.html',
    'artifact/skill/geoly/legacy-runner/index.html']) {
    assert.ok(readFileSync(join(OUT, f), 'utf8').includes('gsearch'), `${f} 缺全局搜索`);
  }
});

test('🔴 信任面板紧贴标题、在描述之上，且全站没有右侧 metadata 栏', () => {
  const html = readFileSync(join(OUT, 'artifact/skill/acme/report-writer/2.0.0/index.html'), 'utf8');
  const chain = html.indexOf('class="chain"');
  const ledger = html.indexOf('信任台账');
  const desc = html.indexOf('来自载荷 manifest');
  assert.ok(chain > -1 && ledger > -1 && desc > -1);
  assert.ok(chain < ledger, '验证链要在信任台账之前');
  assert.ok(ledger < desc, '🔴 信任信息必须在描述之上 —— npm 把 provenance 塞脚注是反面教材');
  assert.ok(!/class="[^"]*sidebar/.test(html), '不许有侧栏');
});

test('列表页把全部数据随页面发下来（运行时不查后端）', () => {
  const list = readFileSync(join(OUT, 'artifacts/index.html'), 'utf8');
  for (const id of ['plaud-theme-dev', 'legacy-runner', 'report-writer', 'legacy-matrix']) {
    assert.ok(list.includes(id), `列表页里没有 ${id}`);
  }
});

test('pack 详情页写清 degraded 被谁拖累（因果句，不是表里的一列）', () => {
  const html = readFileSync(join(OUT, 'artifact/pack/geoly/legacy-matrix/0.1.0/index.html'), 'utf8');
  assert.ok(html.includes('skill:geoly/legacy-runner@1.0.0'), '必须点名是哪个成员');
  assert.ok(html.includes('blameline'), '拖累关系要自成一行的因果句');
  assert.ok(html.includes('所以'), '因果句要说到「所以本 pack 这一版是 degraded」');
  assert.ok(html.includes('成员来自载荷的 pack.json'), '成员的来源必须标出来');
  // 🔴 --allow-yanked 不放行 degraded 是两者最大的行为差别，必须写在页面上
  assert.ok(html.includes('不放行 degraded'));
});

test('yank 的 advisory 出现在详情页，且措辞是「默认拒绝」而不是「绝对不可安装」', () => {
  const html = readFileSync(join(OUT, 'artifact/skill/geoly/legacy-runner/1.0.0/index.html'), 'utf8');
  assert.ok(html.includes('GSA-2026-0001'));
  assert.ok(html.includes('被 yank'));
  // 🔴 yanked 是「默认拒绝新装」，不是「绝对不可安装」—— 写死后者会让用户觉得页面在骗他
  assert.ok(html.includes('--allow-yanked'), '必须写明显式 --allow-yanked 仍可继续');
  assert.ok(html.includes('不删文件'), '必须写明 yank 不删文件、不强制卸载');
});
