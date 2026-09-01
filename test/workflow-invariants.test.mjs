// workflow 的安全不变量 —— 06-submission.md §5，以及各 workflow 自己写下的承诺。
//
// ── 🔴 这一份为什么存在 ────────────────────────────────────────────────────
// `.github/workflows/**` 里那些 🔴 注释是**给人看的**，而人会忘。这一份把其中
// 「违反了就是洞」的那几条变成会红的测试。
//
// 它挡的是一类很具体的事故：**某天有人为了让某一步跑起来，顺手加一行权限**。
// 那一行在 diff 里只有一行，评审时看起来无害，而它可能正好把
// `validate-pr.yml` 变成 §5 明令禁止的 `pull_request_target` 形态。
//
// ── 🔴🔴 为什么先有一道「写法子集」门 ──────────────────────────────────────
// 本仓库**零依赖**（`dependencies` 只有 `@sigstore/verify`，`devDependencies`
// 是空的），所以这里没有 YAML 解析器可用。而用正则读 YAML 有一个致命的失败模式：
// **换一种写法，正则就匹配不到，于是「没找到」被当成「没问题」。**
//   · `on: [pull_request_target]` / `on: {pull_request_target: {}}`
//   · `permissions: write-all`
//   · `permissions: {contents: write}`
// 三种都能绕过按行匹配的写法（Codex 2026-08-31 逐条列出来的）。
//
// 所以先跑 `assertCanonicalForm`：**只允许本测试真的能读懂的那个块式子集**，
// 其余写法一律**拒绝**（而不是放过）。这样「正则没匹配到」就永远不会静默通过 ——
// 要么是合规的块式写法、要么测试红。
//
// ⚠️ **本文件仍然证明不了 workflow 能跑通** —— YAML 的事件语义、token 的实际
//    权限、GitHub 的行为，三样本机都无从证明（见 docs/m3/01-delivery.md §3.6）。
//    它证明的是「几条不该出现的东西没有出现」和「引用的东西真的存在」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(new URL('.', import.meta.url).href)).replace(/\/test$/, '');

// 🔴 目录可被环境变量改写 —— **只为文件末尾那一轮变异自检**：
//    它把 workflows 复制到临时目录、改坏一处、再把本文件当子进程跑一遍，
//    断言必须红。仓库里的文件**一个字节都不动**。
const WF_DIR = process.env.GEOLY_WF_DIR ?? join(REPO, '.github', 'workflows');
// 🔴 跳过标记用**独立**的变量：与目录 override 复用同一个的话，
//    CI 上任何人设了 GEOLY_WF_DIR，变异自检就整个被跳过（Codex 2026-08-31）。
const IN_MUTATION_CHILD = process.env.GEOLY_WF_MUTATION_CHILD === '1';

// 🔴 `.yaml` 也要收。GitHub 两种扩展名都加载 —— 只扫 `.yml` 的话，
//    一个 `evil.yaml` 会对本文件**完全隐形**（Codex 2026-08-31）。
const ALL = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

/**
 * 🔴 **每一条断言都写成 `(files) => 问题[]` 的纯函数**，`files` 是
 *    `{文件名: 内容}`。这样变异测试可以在**内存里**把内容改坏、跑同一批断言，
 *    不用碰仓库里的文件（碰了就得考虑「跑到一半被打断怎么办」）。
 *
 *    这么做的理由是这一份自己的历史：上一版是我**手工**跑了一轮变异才发现
 *    有两条断言根本不生效。手工跑的东西不会再跑第二次 —— 于是断言会慢慢
 *    退化成永远为真，而没有人会注意到。现在这一轮变异是测试的一部分。
 */
const raw = (f) => readFileSync(join(WF_DIR, f), 'utf8');
/**
 * 🔴 **先去掉整行注释再匹配。** 否则「注释里提到 `pr-classify.mjs`」
 *    就能满足「用了 router」那条断言 —— 一条注释就能让门变绿。
 * ⚠️ 只去整行注释，不动行尾的 `#`：`run:` 块里的 shell 注释与字符串里的 `#`
 *    分不清，去多了会误伤。行尾注释造成的漏判由下面的写法子集门兜底。
 */
const read = (f) => raw(f).replace(/^[ \t]*#.*$/gm, '');

/**
 * 切出每一个 `run: |` 的块体。
 * 🔴 **按缩进切，不能用正则一把梭**：`(?:[ \t]{6,}[^\n]*\n|\n)*` 会让空行
 *    把相邻的两个 step 连成一块，于是「这个块里有没有 node」问的其实是
 *    「后面某个块里有没有」—— 第一版就是这么误报的。
 */
/**
 * 切出每一个 step（以 `- ` 开头的那一项）的整块文本。
 * 🔴 与 runBlocks 同一个理由：用正则去凑「后面缩进 ≥N 的连续行」会被空行、
 *    被注释被剥成的空行截断 —— 变异测试实测漏掉了一处 checkout（6 个只抓到 5 个），
 *    于是「有没有 persist-credentials」这条断言对那一处完全不生效。
 */
export function stepBlocks(body) {
  const lines = body.split('\n');
  const out = [];
  let cur = null;
  let need = 0;
  for (const ln of lines) {
    const m = /^(\s*)- /.exec(ln);
    if (m !== null) {
      if (cur !== null) out.push(cur.join('\n'));
      cur = [ln];
      need = m[1].length + 1;
      continue;
    }
    if (cur === null) continue;
    if (ln.trim() === '') { cur.push(ln); continue; }
    const indent = ln.length - ln.trimStart().length;
    if (indent < need) { out.push(cur.join('\n')); cur = null; continue; }
    cur.push(ln);
  }
  if (cur !== null) out.push(cur.join('\n'));
  return out;
}

function runBlocks(body) {
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|/.exec(lines[i]);
    if (m === null) continue;
    const need = m[1].length + 1;                 // 块体至少比 `run:` 多缩进一格
    const buf = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === '') { buf.push(ln); continue; }   // 空行属于块体
      const indent = ln.length - ln.trimStart().length;
      if (indent < need) break;                   // 缩进退回去了 —— 块结束
      buf.push(ln);
    }
    out.push(buf.join('\n'));
  }
  return out;
}

test('至少有一个 workflow —— 空目录会让下面每一条都空转', () => {
  assert.ok(ALL.length >= 4, `只找到 ${ALL.length} 个 workflow：${ALL.join(', ')}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 第 0 道：写法子集。超出的写法一律拒绝，不给「没匹配到 = 没问题」留口子
// ════════════════════════════════════════════════════════════════════════════

/**
 * 哪些行属于 `run:` 块的**块体**（那里是 shell，规则不一样）。
 * 🔴 只认 `run: |`、`run: |-`、`run: >`、`run: >-` —— 早先只认 `run: |`，
 *    于是 `run: |-` 的块体被当成普通 YAML 行，而块体里的 shell 注释、引号
 *    会把下面的规则全部搅乱（Codex 2026-08-31）。
 */
/** `jobs:` 下每个 job 的整块文本。 */
function jobBlocks(body) {
  const lines = body.split('\n');
  const jobs = new Map();
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return jobs;
  let name = null;
  let buf = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([\w-]+):\s*$/.exec(lines[i]);
    if (m !== null) {
      if (name !== null) jobs.set(name, buf.join('\n'));
      name = m[1]; buf = [];
      continue;
    }
    if (name !== null) buf.push(lines[i]);
  }
  if (name !== null) jobs.set(name, buf.join('\n'));
  return jobs;
}

/** `on:` 块里的每一行（去缩进、去空行）。 */
function onBlock(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start === -1) return ['(没有块式的 on:)'];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (!/^\s/.test(lines[i])) break;
    out.push(lines[i].trim());
  }
  return out;
}

function runBodyLines(lines) {
  const inRun = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*[|>][-+]?\s*$/.exec(lines[i]);
    if (m === null) continue;
    const need = m[1].length + 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { inRun.add(j); continue; }
      const indent = lines[j].length - lines[j].trimStart().length;
      if (indent < need) break;
      inRun.add(j);
    }
  }
  return inRun;
}

/** @returns {string[]} 违反子集的行（带行号） */
function nonCanonical(body) {
  const bad = [];
  const lines = body.split('\n');
  const inRun = runBodyLines(lines);
  lines.forEach((ln, i) => {
    const at = `第 ${i + 1} 行：${ln.trim().slice(0, 70)}`;
    if (/\t/.test(ln)) bad.push(`${at}  ← 有 TAB`);
    if (/\r/.test(ln)) bad.push(`${at}  ← 有 CR（CRLF 会让按行判的规则错位）`);
    if (/^(---|\.\.\.)\s*$/.test(ln)) bad.push(`${at}  ← 多文档标记，本测试只读单文档`);
    if (inRun.has(i)) return;                     // 块体是 shell，下面的规则不适用

    // 🔴🔴 **行尾注释一律拒**（run 块体除外）。
    //    `issues: write # temporary` 会让「权限全是 read」那条继续匹配到
    //    原有的三行，同时拿到写权限；
    //    `ref: main # ref: ${{ …base.sha }}` 会让 checkout 那条匹配到注释里的
    //    那一段 —— 注释成了绕过工具（Codex 2026-08-31）。
    const s2 = ln.replace(/^\s+/, '');
    // ⚠️ **只放行 `uses:` 行上的行尾注释** —— 那是钉死 SHA 之后标版本号的既定写法
    //    （`@<40hex> # v7.0.1`），而且 `uses:` 的值按 `\S+` 取，注释进不到值里。
    //    其余一律拒。
    if (s2 !== '' && !s2.startsWith('#') && /\s#/.test(ln) && !/^-?\s*uses\s*:/.test(s2)) {
      bad.push(`${at}  ← 行尾注释。YAML 注释请单独成行（只有 uses: 的版本号注释例外；`
        + 'run 块体里的 shell 注释不受此限）');
    }
    // 🔴 key 必须是**裸写**的。`"\x70ull_request_target":` 解码后就是
    //    `pull_request_target`，却既不命中字面禁令、也不命中顶层引号检查。
    // ⚠️ 缩进要在 dash **之外**：写成 `(\s*-\s*)?["']` 的话，
    //    没有 dash 时那一组匹配空串，引号就必须出现在第 0 列 —— 于是
    //    `  "\x70ull_request_target":` 这种（有缩进、无 dash）整个漏掉。
    const key = /^\s*(-\s*)?["']/.exec(ln);
    if (key !== null && /:\s*($|\S)/.test(ln)) {
      bad.push(`${at}  ← key 被引号包了（转义写法能表达出任何字面禁令都拦不住的 key）`);
    }
    if (/^\s*\?\s/.test(ln)) bad.push(`${at}  ← 显式 key 写法（问号开头），本测试读不懂`);
    if (/^\s*[\w.-]+:\s*\{/.test(ln)) bad.push(`${at}  ← 流式映射 {…}，请改块式`);
    if (/^\s*[\w.-]+:\s*[&*]/.test(ln)) bad.push(`${at}  ← YAML 锚点/别名`);
    if (/^\s*<<\s*:/.test(ln)) bad.push(`${at}  ← 合并键 <<`);
    if (/^\s*permissions\s*:\s*\S/.test(ln)) {
      bad.push(`${at}  ← permissions 必须写成块式，不接受 write-all / read-all / 流式`);
    }
    if (/^on\s*:\s*\S/.test(ln)) bad.push(`${at}  ← on: 必须写成块式`);
  });
  return bad;
}

test('🔴🔴 所有 workflow 都写在本测试能读懂的块式子集里', () => {
  // 这一条是下面全部断言的前提：超出子集的写法**拒绝**，
  // 而不是「正则没匹配到就当没问题」。
  for (const f of ALL) {
    const bad = nonCanonical(read(f));
    assert.deepEqual(bad, [],
      `${f} 用了本测试读不懂的 YAML 写法：\n${bad.join('\n')}\n`
      + '  🔴 要么改回块式，要么先扩展本测试 —— 不要绕过它。');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// §5：禁止 pull_request_target
// ════════════════════════════════════════════════════════════════════════════

test('🔴 没有任何 workflow 用 pull_request_target（§5 明令禁止）', () => {
  // 它用 base 分支的 workflow 定义跑、且能拿到 secrets，而我们要 checkout 的是
  // fork 的 head —— 那是把写权限交给不可信内容的经典形状。
  // ⚠️ 数组式与流式写法已被写法子集门拒掉，所以这里只需匹配块式。
  for (const f of ALL) {
    assert.ok(!/pull_request_target/.test(read(f)), `${f} 提到了 pull_request_target`);
  }
});

test('🔴 所有外部 action 都钉死 40 位 SHA', () => {
  // 钉 tag 的话，tag 可以被移动 —— 那是供应链里最便宜的一次接管
  for (const f of ALL) {
    for (const m of read(f).matchAll(/uses:\s*(\S+)/g)) {
      const u = m[1];
      if (u.startsWith('./')) continue;                 // 仓库内的复合 action
      assert.match(u, /@[0-9a-f]{40}$/, `${f} 里 ${u} 没有钉死 SHA`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// validate-pr.yml：它 checkout fork 的 head，所以只读 + 无 secret
// ════════════════════════════════════════════════════════════════════════════

const VALIDATE = () => read('validate-pr.yml');

test('🔴🔴 validate-pr.yml 一个 secret 都不能引用', () => {
  // 它检出的是 fork 的 head。给它任何 secret，`pull_request_review` 这条触发
  // （跑在 base 上下文）就会把它变成一个真正的 pull_request_target。
  // 🔴 `secrets.` 太窄：`${{ secrets['TOKEN'] }}` 与 `${{ toJSON(secrets) }}` 都能绕
  assert.ok(!/\bsecrets\b/.test(VALIDATE()),
    'validate-pr.yml 提到了 secrets —— 它检出 fork 的 head，§5 不允许');
});

test('🔴 validate-pr.yml 里没有任何一处 write 权限', () => {
  // 逐键看：加一个没列进白名单的新权限键、或把某一个改成 write，都要红
  const body = VALIDATE();
  const perms = [...body.matchAll(/^\s{2,}([a-z-]+):\s*(read|write|none)\s*$/gm)];
  assert.ok(perms.length >= 3, `只找到 ${perms.length} 条权限声明，是不是改结构了？`);
  for (const [, key, val] of perms) {
    assert.notEqual(val, 'write', `validate-pr.yml 里 ${key}: write —— 这个 workflow 只能是只读的`);
  }
});

test('🔴 每个 job 都显式声明 permissions —— 不能吃仓库默认值', () => {
  // 仓库默认可能是「读写」。job 不声明就跟着 workflow 顶层走，顶层不声明就跟着
  // 仓库默认走 —— 这条链上任何一环缺失，权限就不是我们说了算。
  // ⚠️ 这条原来只数了 job 名字、**根本没逐 job 检查**（Codex 2026-08-31）——
  //    标题说的和做的不是一回事，是另一种「看起来被守住了」。
  const body = VALIDATE();
  assert.match(body, /^permissions:\s*\n\s+contents:\s*read/m, '顶层 permissions 缺失');
  const jobs = jobBlocks(body);
  assert.ok(jobs.size >= 4, `只找到 job：${[...jobs.keys()].join(', ')}`);
  const naked = [...jobs].filter(([, b]) => !/^\s{4}permissions:\s*$/m.test(b)).map(([n]) => n);
  assert.deepEqual(naked, [],
    `这些 job 没有自己的 permissions 块：${naked.join(', ')}\n`
    + '  🔴 job 不声明就跟着 workflow 顶层走，顶层不声明就跟着仓库默认走 ——\n'
    + '     这条链上任何一环缺失，权限就不是我们说了算。');
});

test('🔴 三处 checkout 各自钉死 sha，且都不带凭据', () => {
  // 删掉 `ref:` 之后，`pull_request` 事件下 checkout 默认取的是**合并树** ——
  // 那里面就有 PR 自己对校验器的修改，整套「可信代码 × 不可信数据」当场失效。
  const body = VALIDATE();
  const checkouts = stepBlocks(body).filter((b) => /actions\/checkout@/.test(b));
  // 🔴 数量也要对上：少数一个就等于那一处完全没被检查（变异测试抓到过）
  const total = (body.match(/actions\/checkout@/g) ?? []).length;
  assert.equal(checkouts.length, total, `切出了 ${checkouts.length} 块，但文件里有 ${total} 处 checkout`);
  assert.ok(total >= 6, `只找到 ${total} 处 checkout，是不是改结构了？`);
  for (const b of checkouts) {
    assert.match(b, /ref:\s*\$\{\{\s*github\.event\.pull_request\.(base|head)\.sha\s*\}\}/,
      `checkout 没有钉死 base.sha / head.sha：\n${b}`);
    assert.match(b, /persist-credentials:\s*false/, `checkout 没有 persist-credentials: false：\n${b}`);
  }
  // 校验器那一份必须来自 base
  assert.match(body, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}\s*\n\s+path:\s*base-tools/);
});

test('🔴 校验器一律从 base-tools 跑，PR 那棵树只当数据', () => {
  const body = VALIDATE();
  const runs = [...body.matchAll(/\bnode\s+(?:--\S+\s+)*(\S+\.mjs)/g)].map((m) => m[1]);
  assert.ok(runs.length >= 4, `只找到 ${runs.length} 处 node 调用，是不是改结构了？`);
  for (const r of runs) {
    assert.ok(r.startsWith('base-tools/'),
      `validate-pr.yml 跑了 ${r} —— 校验器必须来自 base，否则 PR 能改自己的检查器`);
  }
  // 变量间接跑脚本会绕过上面的检查
  assert.ok(!/\bnode\s+["']?\$/.test(body), '不要用变量间接指定脚本路径 —— 那绕过了 base-tools 检查');
  assert.ok(!/\bnode\s+-e\b/.test(body), '不要用 node -e —— 同上');
  assert.ok(!/working-directory:\s*pr\b/.test(body), '不能在 PR 那棵树里跑任何东西');

  // 🔴🔴 **`pr/` 的每一次出现都要在白名单里。**
  //    点名去堵是堵不完的（Codex 2026-08-31 举了几个）：
  //      · `node --require=pr/evil.cjs … base-tools/scripts/…`
  //        —— 文本上「跑的是 base 脚本」，Node 却先执行了 PR 的代码；
  //      · `bash pr/x.sh`、`pushd pr`、`cd ./pr`；
  //      · `uses: ./pr/.github/actions/evil` —— 本地 action，我原先无条件放行。
  //    所以反过来：列出 `pr/` **允许**出现的形态，其余一律拒。
  // 一行里只要出现 `pr/` 或 `cd pr`，这一行就必须落在下面这张白名单里。
  const ALLOWED_PR_LINES = [
    /^- ?path: pr$/,                                  // checkout 的落点
    /^path: pr$/,
    /^--submissions pr\/submissions( --annotate)?$/,  // 当数据读
    /^--submissions pr\/submissions --reviews reviews\.json$/,
    /^--pr pr --base base-tools$/,                    // verify-promotion 的入参
    /^cd pr$/,                                        // 只为算 diff
  ];
  const offenders = [];
  for (const raw of body.split('\n')) {
    const t = raw.trim().replace(/\s*\\$/, '');       // 去掉续行的反斜杠
    if (!/(^|[\s"'=])\.?\/?pr\//.test(t) && !/^cd\s+\.?\/?pr$/.test(t)) continue;
    if (!ALLOWED_PR_LINES.some((re) => re.test(t))) offenders.push(t.slice(0, 90));
  }
  assert.deepEqual(offenders, [],
    `这些地方碰了 PR 那棵树，而它不在白名单里：\n${offenders.map((o) => `  · ${o}`).join('\n')}\n`
    + '  🔴 PR 的内容只能当**数据**读，永远不执行。白名单之外一律拒 ——\n'
    + '     点名去堵堵不完：--require=pr/x.cjs、bash pr/x.sh、pushd pr、\n'
    + '     uses: ./pr/.github/actions/evil 都是「文本上看着没问题」的形状。');

  // 本地 composite action 也不能来自 PR
  for (const m of body.matchAll(/uses:\s*(\S+)/g)) {
    assert.ok(!m[1].startsWith('./pr'), `uses: ${m[1]} —— 那是 PR 提供的 action`);
  }
  // 🔴 `cd pr` 之后再跑 node/npm 同样绕过上面那条 —— 逐个 run 块判。
  //    ⚠️ 我第一次把这条写成了 `assert.ok(… || true)`，那是**永远为真**的 ——
  //    同一个文件里我已经犯过一次（`|| v === 'pr/artifacts'`）。写完断言要问一句：
  //    「把被测的东西改坏，它会红吗？」
  for (const block of runBlocks(body)) {
    if (!/\bcd\s+pr\b/.test(block)) continue;
    assert.ok(!/\b(node|npm|npx)\s/.test(block),
      `有一个 run 块在 cd pr 之后跑了 node/npm：\n${block}`);
  }
});

test('🔴 「已有事实」的输入一律指向 base，不能让被检的 PR 自己提供', () => {
  const body = VALIDATE();
  // ⚠️ 第一版这里写了个 `|| v === 'pr/artifacts'` 的例外，结果**整条断言是空的**
  //    —— 那个值恰好是唯一会出现的值。一道永远为真的断言比没有更糟：
  //    它让人以为这件事被盯住了。现在的判据没有例外。
  for (const flag of ['--artifacts', '--reserved', '--maintainer-ids']) {
    for (const m of body.matchAll(new RegExp(`${flag}\\s+(\\S+)`, 'g'))) {
      assert.ok(!m[1].startsWith('pr/'),
        `${flag} 指向了 ${m[1]} —— 既有事实不能让被检的 PR 自己提供`);
    }
  }
  assert.match(body, /--reserved\s+base-tools\//, '保留 namespace 列表必须来自 base');
  assert.match(body, /base-tools\/registry\/maintainers\.json/, '维护者名单必须来自 base');
  assert.ok(!/pr\/registry\//.test(body),
    '🔴 registry/ 下的任何东西都不能从 PR 里读 —— 那等于让投稿者宣布规则');
});

test('🔴 diff 必须相对 merge-base 且禁用重命名检测', () => {
  // 两点式比的是两棵终态树（base 前进后会误报与漏报）；
  // 带重命名检测时 `.github/x.yml → submissions/x.yml` 只列出新路径，
  // 于是「把受保护文件删掉」会从投稿白名单溜过去。
  const body = VALIDATE();
  const diffs = [...body.matchAll(/git diff([^\n|]*)/g)].map((m) => m[1]);
  assert.ok(diffs.length >= 1);
  for (const d of diffs) {
    assert.match(d, /--no-renames/, `git diff 少了 --no-renames：${d}`);
    assert.match(d, /\$\{?BASE_SHA\}?\.\.\.\$\{?HEAD_SHA\}?|\$\w+\.\.\.\$\w+/,
      `git diff 不是三点式（相对 merge-base）：${d}`);
  }
});

test('🔴 分支保护要钉的聚合门存在，且两条路径互斥', () => {
  const body = VALIDATE();
  assert.match(body, /^ {2}pr-gate:/m, '固定名的聚合 job 不能改名 —— 分支保护钉的就是它');
  assert.match(body, /needs:\s*\[route,\s*submission-gates,\s*promotion-gates\]/);
  assert.match(body, /if:\s*\$\{\{\s*always\(\)\s*\}\}/, 'pr-gate 必须 always() —— 否则前面失败它就被跳过');
  // 判据必须是「router 挑中的那一条」，不能是「有一条 success」
  assert.match(body, /"\$SUB"\s*=\s*"skipped"/);
  assert.match(body, /"\$PROMO"\s*=\s*"skipped"/);
});

test('🔴 审批被撤回时要重跑（否则过期的绿会留在那里）', () => {
  const body = VALIDATE();
  assert.match(body, /^ {2}pull_request_review:/m);
  assert.match(body, /types:\s*\[submitted,\s*dismissed,\s*edited\]/);
});

// ════════════════════════════════════════════════════════════════════════════
// promote.yml：它有写权限，所以绝不能碰 fork 的内容
// ════════════════════════════════════════════════════════════════════════════

const PROMOTE = () => read('promote.yml');

test('🔴🔴 promote.yml 绝不 checkout fork —— 它有 contents: write', () => {
  const body = PROMOTE();
  assert.ok(!/pull_request\.head/.test(body),
    'promote.yml 提到了 pull_request.head —— §5：它只读已经合并到 main 的内容');
  // 🔴 只禁表达式不够：`repository: attacker/repo` 是字面量（Codex 2026-08-31）
  assert.ok(!/^\s*repository:/m.test(body),
    'checkout 带 repository: —— 那能把别的仓库（含 fork）检出来');
  assert.ok(!/refs\/pull\//.test(body), 'ref 指向 refs/pull/… 就是在检出 PR 的内容');
  assert.ok(!/\bgit\s+clone\b/.test(body), '不要用 git clone 绕过 actions/checkout 的约束');
});

test('🔴 promote.yml 只由 push 到 main 的 submissions/** 触发 —— 一个多余的触发就是洞', () => {
  // 🔴 **白名单**，不是黑名单。列举「不许出现的事件」必然漏
  //    （`repository_dispatch`、`issues`、`pull_request_review`…），
  //    而且在既有 `push:` 下加一行 `tags: ['*']` 就能绕开 paths 过滤
  //    —— tag push 不受 paths filter 限制（Codex 2026-08-31）。
  const body = PROMOTE();
  const on = onBlock(body);
  assert.deepEqual(on, [
    'push:',
    "branches: [main]",
    "paths: ['submissions/**']",
  ], `promote.yml 的 on: 块必须**恰好**是这三行，实际：\n  ${on.join('\n  ')}`);
});

test('🔴 promote 串行且不许取消，且没有 job 级 concurrency 覆盖它', () => {
  const body = PROMOTE();
  assert.match(body, /^concurrency:\s*\n\s+group:\s*promote\s*\n\s+cancel-in-progress:\s*false/m);
  const all = [...body.matchAll(/^\s*concurrency:/gm)];
  assert.equal(all.length, 1, 'job 级的 concurrency 会覆盖顶层的 cancel-in-progress: false');
});

test('🔴 PAT 只许给「开 PR」那一步 —— 铺到每一步只会扩大暴露面', () => {
  // 用 PAT 的**唯一**理由是：GITHUB_TOKEN 创建的 PR 不触发任何 workflow，
  // 而 promotion PR 正是复算门与不可变门跑的地方。其余步骤只读，
  // 用默认 token 就够 —— 多给一步就多一处能以那个身份行事的地方。
  const body = PROMOTE();
  const steps = stepBlocks(body).filter((b) => /RELEASE_BOT_TOKEN/.test(b));
  assert.equal(steps.length, 1, `${steps.length} 个 step 用了 PAT，应当只有一个`);
  assert.match(steps[0], /name: 开 promotion PR/, '用 PAT 的不是开 PR 那一步');
  assert.match(steps[0], /gh pr create/);
});

test('🔴 promote 不直推 main（§3：promote 只产出一张 PR）', () => {
  // 🔴 只看两个 token 拦不住 `git push --force origin main`，也拦不住
  //    `git push origin "$branch":refs/heads/main`（Codex 2026-08-31）。
  //    改成**只允许那一条**。
  const body = PROMOTE();
  const pushes = [...body.matchAll(/^\s*git push\b[^\n]*/gm)].map((m) => m[0].trim());
  assert.deepEqual(pushes, ['git push origin "$branch"'],
    `promote.yml 里的 git push 必须只有推分支那一条，实际：\n  ${pushes.join('\n  ')}`);
  assert.match(body, /gh pr create/, 'promote 必须开 PR');
});

test('🔴 promote 的分流用的是 router 那一份代码，不是 shell 复述', () => {
  const body = PROMOTE();
  assert.match(body, /node[^\n]*pr-classify\.mjs/,
    '自己写 case promotion/hub-* 会漏掉「作者必须是 release bot」这一条');
  assert.ok(!/case\s+"?\$\{?ref/.test(body), '不要在 shell 里复述 router 的判据');
  assert.match(body, /--diff-filter=d/, '算「本次 PR 带来哪些投稿」时要排掉删除');
});

// ════════════════════════════════════════════════════════════════════════════
// 引用的东西必须真的存在
// ════════════════════════════════════════════════════════════════════════════

for (const [what, re] of [
  ['.mjs 脚本', /(?:^|\s)((?:base-tools\/)?scripts\/[\w./-]+\.mjs)/g],
  ['registry/*.json', /(?:^|\s)((?:base-tools\/)?registry\/[\w./-]+\.json)/g],
]) {
  test(`🔴 workflow 里引用的每个${what}都存在`, () => {
    // 路径写错只在 CI 跑到那一步时才发现 —— 而那可能是发布当天
    const missing = [];
    for (const f of ALL) {
      for (const m of read(f).matchAll(re)) {
        const rel = m[1].replace(/^base-tools\//, '');
        if (!existsSync(join(REPO, rel))) missing.push(`${f} → ${m[1]}`);
      }
    }
    assert.deepEqual(missing, [], `这些不存在：\n${missing.join('\n')}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// release.yml：代码产什么名字，workflow 就得挂什么名字
// ════════════════════════════════════════════════════════════════════════════

test('🔴🔴 制品资产的扩展名：workflow 的 glob 必须与 assetFileName 产的一致', async () => {
  // 这是本轮抓到的一个 P0，而**单测结构上看不见它**：
  //   `assetFileName` 产 `.tar.gz`，两处 glob 却写的是 `*.tgz` ——
  //   于是资产建出来了、也比对通过了，然后**一个都没挂上去**；
  //   而 `if-no-files-found: error` 不会响，因为 npm 自己的 .tgz 在那儿。
  //   「检查全过，分发全缺」——单测只测脚本，测不到 workflow 的 glob（Codex 2026-08-31）。
  const { assetFileName } = await import('../scripts/build-snapshot.mjs');
  // ⚠️ 版本号里带点，所以这里**故意**用一个无点的版本来取扩展名 ——
  //    `indexOf('.')` 碰上 `1.0.0` 会截出 `.0.0.tar.gz`。
  const produced = assetFileName({ kind: 'skill', namespace: 'ns', name: 'n', version: '1' });
  const ext = produced.slice(produced.indexOf('.'));          // `.tar.gz`
  const body = read('release.yml');
  // ⚠️ `\S+` 会把 shell 的 `;`（`for f in …/*.tar.gz; do`）一起吃进来
  const globs = [...body.matchAll(/dist\/assets\/\*(\.[\w.]+)/g)].map((m) => m[1]);
  assert.ok(globs.length >= 2, `只找到 ${globs.length} 处 dist/assets 的 glob`);
  for (const g of globs) {
    assert.equal(g, ext, `workflow 挂的是 *${g}，而 assetFileName 产的是 ${produced}`);
  }
});

test('🔴 阶段 C 必须排在签名与 npm publish **之前**', () => {
  // 排在后面的话，失败时快照已被签、attestation 已生成、npm 已发出去 ——
  // 三样都撤不回来。这一步只读只算，放最前面没有代价。
  const body = read('release.yml');
  const at = (re) => body.search(re);
  const stageC = at(/name: 重建制品资产并比对/);
  assert.ok(stageC > 0, '找不到阶段 C 那一步');
  // ⚠️ 早先只断言了签快照与 npm publish —— 把 attestation 挪到 C 之前
  //    测试仍会绿（Codex 2026-08-31）。三样都是撤不回来的产物，一个都不能漏。
  for (const [what, re] of [
    ['签快照', /name: 签快照/],
    ['attestation', /name: attestation/],
    ['npm publish', /npm publish /],
  ]) {
    const p = at(re);
    assert.ok(p > stageC, `阶段 C 排在了「${what}」之后 —— 那一步的产物撤不回来`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 占位值：填上之前必须是 fail-closed 的
// ════════════════════════════════════════════════════════════════════════════

test('🔴 RELEASE_BOT_ID 两处一致，且没有 job/step 级的覆盖', () => {
  // 两处不一致的话，一张 PR 在 validate 侧判成 submission、在 promote 侧判成
  // promotion（或反过来）—— 那是最难查的一类分叉
  const vals = ['validate-pr.yml', 'promote.yml'].map((f) => {
    const all = [...read(f).matchAll(/RELEASE_BOT_ID:\s*"?([^"\n]*)"?/g)].map((m) => m[1].trim());
    assert.equal(all.length, 1, `${f} 里有 ${all.length} 处 RELEASE_BOT_ID —— 覆盖会让两侧判据分叉`);
    return all[0];
  });
  assert.equal(vals[0], vals[1], 'validate-pr 与 promote 的 RELEASE_BOT_ID 不一致');
  assert.ok(vals[0] !== '', 'RELEASE_BOT_ID 是空串 —— 那会让分流永远判成 submission');
});

test('🔴 维护者名单：state 与内容必须自洽', () => {
  // 🔴 早先这条测试写成「名单必须是空的」，意思是「等有人填了就让它红」——
  //    那要求填名单的人**顺手改测试**，而改测试的人多半只想让红变绿
  //    （Codex 2026-08-31）。改成显式状态：上线时必须在同一张 PR 里
  //    把 state 从 bootstrap 改成 active，那是一个看得见的动作。
  const doc = JSON.parse(readFileSync(join(REPO, 'registry', 'maintainers.json'), 'utf8'));
  assert.equal(doc.schema, 'geoly.skills.maintainers/1');
  assert.ok(['bootstrap', 'active'].includes(doc.state), `state 必须是 bootstrap / active，得到 ${doc.state}`);
  assert.ok(Array.isArray(doc.maintainers));

  if (doc.state === 'bootstrap') {
    assert.equal(doc.maintainers.length, 0,
      'state=bootstrap 但名单非空 —— 填了人就要把 state 改成 active，否则没人知道门已经活了');
  } else {
    assert.ok(doc.maintainers.length >= 2,
      'state=active 至少要两名 —— Tier 2 要两名且排除投稿者本人，一个人永远满足不了');
  }
  const ids = new Set();
  for (const m of doc.maintainers) {
    assert.ok(typeof m?.id === 'string' && m.id !== '' && !/PLACEHOLDER|TODO|xxx/i.test(m.id),
      `维护者 ${JSON.stringify(m)} 的 id 看起来是占位 —— 那比空名单更危险`);
    assert.ok(!ids.has(m.id), `维护者 id 重复：${m.id} —— 同一个人凑不出两票`);
    ids.add(m.id);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 变异自检：把被测的东西改坏，上面那些断言必须红
// ════════════════════════════════════════════════════════════════════════════
//
// 🔴 **这一节存在的理由是这份文件自己的历史。** 上一版是我手工跑了一轮变异，
//    才发现两条断言根本不生效（一处 checkout 压根没被切出来，
//    所以「有没有 persist-credentials」对它完全没作用）。
//    手工跑的东西不会再跑第二次 —— 断言会慢慢退化成永远为真，而没人注意到。
//
// ⚠️ 我在这份文件里写过两次 `assert.ok(… || true)`（永远为真）。
//    「写完断言把它守的东西改坏一次」这个习惯，靠自觉是不够的，所以写进测试。

/**
 * 🔴 **子进程的 reporter 必须钉死，不能用默认值。**
 *    `node --test` 的默认 reporter 随**Node 版本**与**是不是 TTY** 变
 *    （tap 的摘要是 `# fail N`，spec 的是 `\u2139 fail N`）。下面解析结果的
 *    两条正则原本按 spec 写，于是在 CI 的 Node 22 上整个匹配不到 ——
 *    表现成「14 个变异全部没产出测试结果」，而本机（单一 Node 版本）永远测不出来。
 *    实测：Node 24 绿、Node 22 红，同一份代码。
 *    ⚠️ 这正是这份文件反复在讲的那个形状：**判据依赖了一个会变的东西**。
 */
const CHILD_ARGS = (self) => ['--test', '--test-reporter=spec', self];

/** 只改**非注释行**上的第一处 —— 注释在匹配前已被剥掉，改它等于什么都没改。 */
function mutateRealLine(body, find, replace, { last = false } = {}) {
  const lines = body.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('#')) continue;
    if (lines[i].includes(find)) hits.push(i);
  }
  if (hits.length === 0) return null;
  // 🔴 `last` 是为了证明「**每一处** checkout 都还受保护」——
  //    永远只改第一处的话，后面几处退化了也看不出来（Codex 2026-08-31）。
  const i = last ? hits[hits.length - 1] : hits[0];
  lines[i] = lines[i].replace(find, replace);
  return lines.join('\n');
}

/**
 * 每个变异都写明**该由哪一条断言抓住**（`expect` 是那条 test 名字的一段）。
 *
 * 🔴 只判「子进程红了」是不够的：一个变异可能被**另一条**断言顺手抓到
 *    （比如写法子集门），于是我真正关心的那条其实已经失效了，而自检看起来是绿的。
 *    这正是这份文件反复踩的那个坑的另一个形状 —— 「看起来被守住了」。
 */
const MUTATIONS = [
  ['validate-pr.yml', '      contents: read', '      contents: write', 'job 权限改成 write', 'write 权限'],
  ['validate-pr.yml', '--reserved base-tools/', '--reserved pr/', '保留名单改成从 PR 读', '已有事实'],
  ['validate-pr.yml', 'base-tools/registry/maintainers.json', 'pr/registry/maintainers.json', '维护者名单从 PR 读', '已有事实'],
  ['validate-pr.yml', 'base-tools/scripts/submission/run-gates.mjs', 'pr/scripts/submission/run-gates.mjs', '校验器改成从 PR 跑', '校验器一律从 base-tools 跑'],
  ['validate-pr.yml', 'persist-credentials: false', 'persist-credentials: true', 'checkout 带上凭据', 'checkout'],
  ['validate-pr.yml', 'ref: ${{ github.event.pull_request.base.sha }}', 'ref: main', 'checkout 不钉 sha', 'checkout'],
  ['validate-pr.yml', '--no-renames ', '', '去掉 --no-renames', 'merge-base'],
  ['validate-pr.yml', '  pull_request:', '  pull_request_target:', '换成 pull_request_target', 'pull_request_target'],
  ['validate-pr.yml', 'permissions:', 'permissions: write-all #', 'permissions 写成 write-all', '块式子集'],
  ['promote.yml', "    paths: ['submissions/**']", "    paths: ['submissions/**']\n  workflow_dispatch:", 'promote 多一个触发', '只由 push'],
  ['promote.yml', 'cancel-in-progress: false', 'cancel-in-progress: true', 'promote 允许取消', '串行且不许取消'],
  ['promote.yml', 'git push origin "$branch"', 'git push origin main', 'promote 直推 main', '不直推 main'],
  ['promote.yml', '--diff-filter=d ', '', '去掉 --diff-filter=d', '分流用的是 router'],
  ['promote.yml', 'node --no-warnings scripts/submission/pr-classify.mjs', 'true #', 'promote 不再调 router', '分流用的是 router'],

  // ── Codex 2026-08-31 第二轮点名的形状 ────────────────────────────────
  ['validate-pr.yml', '      contents: read', '      contents: read\n      issues: write # temporary', '行尾注释掩护下加写权限', '块式子集'],
  ['validate-pr.yml', 'ref: ${{ github.event.pull_request.head.sha }}', 'ref: main # ref: ${{ github.event.pull_request.head.sha }}', '行尾注释伪装 ref', '块式子集'],
  ['validate-pr.yml', '  pull_request:', '  "\\x70ull_request_target":', '转义 key 表达出被禁事件', '块式子集'],
  ['validate-pr.yml', 'node --no-warnings base-tools/scripts/submission/scan-text.mjs', 'node --require=pr/evil.cjs base-tools/scripts/submission/scan-text.mjs', '--require 先跑 PR 的代码', 'PR 那棵树只当数据'],
  ['validate-pr.yml', '- uses: actions/setup-node@', '- uses: ./pr/.github/actions/evil # actions/setup-node@', 'uses 指向 PR 提供的 action', 'PR 那棵树只当数据'],
  ['validate-pr.yml', 'GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets[\'TOKEN\'] }}', 'secrets[…] 索引写法', '一个 secret 都不能引用'],
  ['promote.yml', '    branches: [main]', '    branches: [main]\n    tags: [\'*\']', 'push 加 tags（不受 paths 过滤）', '只由 push'],
  ['promote.yml', 'git push origin "$branch"', 'git push --force origin "$branch":refs/heads/main', '多 refspec 直推 main', '不直推 main'],
  ['promote.yml', '          persist-credentials: true', '          repository: attacker/repo', 'checkout 别的仓库', '绝不 checkout fork'],
];

/** 需要改**最后**一处而不是第一处的变异（证明每一处 checkout 都还受保护）。 */
const LAST_OCCURRENCE = new Set(['末处 checkout 去掉凭据守卫']);
MUTATIONS.push(['validate-pr.yml', 'persist-credentials: false', 'persist-credentials: true',
  '末处 checkout 去掉凭据守卫', 'checkout']);

test('🔴🔴 变异自检：每一处改坏都必须让上面的断言变红', { skip: IN_MUTATION_CHILD }, () => {
  const self = fileURLToPath(import.meta.url);
  const childEnv = (dir) => {
    const e = { ...process.env, GEOLY_WF_DIR: dir, GEOLY_WF_MUTATION_CHILD: '1' };
    delete e.NODE_TEST_CONTEXT;
    delete e.NODE_OPTIONS;
    return e;
  };

  // 🔴 **先跑一次没被改过的 control。** 子进程要是本来就红（环境不同、
  //    路径不同、别的什么），那么每个变异都会「被抓到」，而其实一条断言
  //    都没在起作用（Codex 2026-08-31）。
  {
    const dir = mkdtempSync(join(tmpdir(), 'geoly-wfctl-'));
    try {
      cpSync(WF_DIR, dir, { recursive: true });
      const c = spawnSync(process.execPath, CHILD_ARGS(self), { encoding: 'utf8', env: childEnv(dir) });
      assert.equal(c.status, 0,
        `control（没改过的副本）在子进程里就是红的 —— 那么下面每个变异都会被误判成「抓到了」。\n${
          (c.stdout ?? '').split('\n').filter((l) => l.startsWith('\u2716')).join('\n')}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const survivors = [];
  for (const [file, find, replace, label, expect] of MUTATIONS) {
    const dir = mkdtempSync(join(tmpdir(), 'geoly-wfmut-'));
    try {
      cpSync(WF_DIR, dir, { recursive: true });
      const mutated = mutateRealLine(readFileSync(join(dir, file), 'utf8'), find, replace,
        { last: LAST_OCCURRENCE.has(label) });
      if (mutated === null) { survivors.push(`${label}：非注释行里找不到 ${JSON.stringify(find)}`); continue; }
      writeFileSync(join(dir, file), mutated);

      // 🔴 必须清掉 node:test 自己的上下文变量，否则子进程会报
      //    「run() is being called recursively」**并直接跳过、退出 0** ——
      //    那会让每一个变异都「活下来」，而这个测试看起来只是失败得很整齐。
      const r = spawnSync(process.execPath, CHILD_ARGS(self), { encoding: 'utf8', env: childEnv(dir) });
      if (r.signal !== null || r.error !== undefined) {
        survivors.push(`${label}：子进程异常退出（signal=${r.signal}）`);
        continue;
      }
      const out = r.stdout ?? '';
      // 子进程「一个断言都没跑」也要算失败 —— 那和「全绿」看起来一样
      if (!/^\u2139 fail \d+/m.test(out)) {
        survivors.push(`${label}：子进程没有产出测试结果（${(r.stderr ?? '').slice(0, 120)}）`);
        continue;
      }
      if (r.status === 0) { survivors.push(`${label}：改坏了但测试仍然绿`); continue; }
      // 🔴 还要是**指定的那一条**红了，不能是别的断言顺手抓到的
      const failed = [...out.matchAll(/^\u2716 (.+?) \(\d/gm)].map((m) => m[1]);
      if (!failed.some((n) => n.includes(expect))) {
        survivors.push(`${label}：红的不是「${expect}」那一条，而是 ${failed.join(' / ') || '（没解析到）'}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(survivors, [],
    `这些改动没有被任何断言抓到：\n${survivors.map((s) => `  · ${s}`).join('\n')}\n`
    + '  🔴 一条抓不到对应改动的断言，等于没有这条断言。');
});
