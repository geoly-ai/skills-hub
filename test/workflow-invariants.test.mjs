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
  assert.ok(jobs.size >= 5, `只找到 job：${[...jobs.keys()].join(', ')}`);
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
  assert.ok(total >= 8, `只找到 ${total} 处 checkout，是不是改结构了？`);
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

/**
 * 三条路径与它们在 `pr-gate` 里对应的 shell 变量。
 * 🔴 有意写成一张表：加第四条路径时，下面每一条断言都会自动跟着扩，
 *    而不是「有人记得去改三处正则」。
 */
const ROUTES = Object.freeze([
  ['submission', 'SUB'], ['promotion', 'PROMO'], ['maintainer', 'MAINT'],
]);

test('🔴 三条路径的 gate job 各自只由 router 的判定触发', () => {
  // 🔴 `if` 一旦松成 `always()` 或别的表达式，那条路径就会**跟着别的 kind 一起跑**，
  //    于是 pr-gate 里「另外两条必须 skipped」当场变成永远失败 —— 或者更糟：
  //    有人为了让它绿，把那几条 skipped 判据一并删掉。守在源头。
  const jobs = jobBlocks(VALIDATE());
  for (const [kind] of ROUTES) {
    const b = jobs.get(`${kind}-gates`);
    assert.ok(b !== undefined, `${kind}-gates 这个 job 不见了`);
    assert.match(b, new RegExp(`if:\\s*\\$\\{\\{\\s*needs\\.route\\.outputs\\.kind\\s*==\\s*'${kind}'\\s*\\}\\}`),
      `${kind}-gates 的 if 不是「router 判定为 ${kind}」`);
    assert.match(b, /^\s+needs:\s*route\s*$/m, `${kind}-gates 必须 needs: route`);
  }
});

test('🔴 分支保护要钉的聚合门存在，且三条路径互斥', () => {
  const body = VALIDATE();
  assert.match(body, /^ {2}pr-gate:/m, '固定名的聚合 job 不能改名 —— 分支保护钉的就是它');
  assert.match(body, /needs:\s*\[route,\s*submission-gates,\s*promotion-gates,\s*maintainer-gates\]/,
    'pr-gate 必须 needs 全部三条路径 —— 漏一条，那条的结果就进不了判据，等于没门');
  assert.match(body, /if:\s*\$\{\{\s*always\(\)\s*\}\}/, 'pr-gate 必须 always() —— 否则前面失败它就被跳过');

  // 每条路径的结果都要真的被读进来
  for (const [kind, v] of ROUTES) {
    assert.match(body, new RegExp(`^\\s+${v}:\\s*\\$\\{\\{\\s*needs\\.${kind}-gates\\.result\\s*\\}\\}`, 'm'),
      `pr-gate 没有把 ${kind}-gates 的结果读进 $${v}`);
  }

  // 🔴🔴 **判据必须是「router 挑中的那一条 success，另外两条全部 skipped」**，
  //    不是「有一条 success」。§4 担心的正是后者。
  //    从两条扩到三条时最容易写松的地方就在这里：两条的时候「我这条 + 另一条」
  //    已经穷尽了，三条的时候只点名另**一**条会漏掉第三条 —— 那条于是可以
  //    跟着一起跑并通过，而聚合门照样绿，router 的判定形同虚设。
  //    所以逐个 case 分支解析，一条都不许省。
  const caseBody = /case "\$KIND" in\n([\s\S]*?)\n\s*esac/.exec(body);
  assert.ok(caseBody !== null, 'pr-gate 里找不到 case "$KIND" 块 —— 是不是改结构了？');
  // 🔴 按**行**切分支，不用一条跨行正则：`;;` 的缩进、分支里多一个空行，
  //    都会让那条正则「匹配不到」，而匹配不到在这里等于「没有这条断言」。
  const arms = new Map();
  let cur = null;
  for (const ln of caseBody[1].split('\n')) {
    const m = /^\s*([\w*]+)\)\s*$/.exec(ln);
    if (m !== null) { cur = m[1]; arms.set(cur, []); continue; }
    if (cur !== null) arms.get(cur).push(ln);
    if (/;;\s*$/.test(ln)) cur = null;
  }
  arms.delete('*');
  for (const [k, v] of arms) arms.set(k, v.join('\n'));
  assert.deepEqual([...arms.keys()].sort(), ROUTES.map(([k]) => k).sort(),
    `case 的分支与三条路径对不上：${[...arms.keys()].join(', ')}`);
  for (const [kind, self] of ROUTES) {
    const arm = arms.get(kind);
    assert.match(arm, new RegExp(`\\[ "\\$${self}" = "success" \\]`),
      `${kind} 分支没有要求 $${self} 必须 success`);
    for (const [other, v] of ROUTES) {
      if (other === kind) continue;
      assert.match(arm, new RegExp(`\\[ "\\$${v}" = "skipped" \\]`),
        `🔴 ${kind} 分支没有要求 $${v} 必须 skipped —— 那条路径可以跟着一起跑并通过，`
        + '而聚合门照样绿。三条互斥漏掉任意一格，就退化成「任一通过即可」。');
    }
  }
  // 未知 kind 必须硬失败，不能落进一个宽松的默认
  assert.match(caseBody[1], /\*\)\n[\s\S]*?exit 1/, 'case 缺少 `*)` 兜底 —— 未知 kind 必须红');
});

test('🔴 维护者判据是不可变 node id，不是 login', () => {
  // login 可以改名、也可以被别人重新认领：维护者改名之后，攻击者认领那个旧
  // login 就直接成了维护者，而 maintainer 路径没有投稿白名单。
  // 这条洞只要在 workflow 里把 `.id` 写成 `.login` 就成立 —— 一个字符的 diff。
  const body = VALIDATE();
  const picks = [...body.matchAll(/\.maintainers\s*\|\s*map\(\.(\w+)\)/g)].map((m) => m[1]);
  assert.ok(picks.length >= 1, '没找到从 maintainers.json 取名单的地方 —— 是不是改结构了？');
  for (const p of picks) {
    assert.equal(p, 'id', `维护者名单取的是 .${p} —— 判据必须是不可变 node id`);
  }
  // 🔴 **按 job 判，不按全文判。** `--maintainer-ids` 在这个文件里出现两次
  //    （route 的分流、submission-gates 的 §7 审批人数门）—— 全文匹配的话，
  //    把 route 那一处删掉，另一处还在，断言照样绿。这正是这份文件反复踩的
  //    「看起来被守住了」：一条断言匹配到的不是它以为的那一处。
  assert.match(jobBlocks(body).get('route'), /--maintainer-ids/,
    'router 没拿到维护者名单 —— 那么维护者的 PR 会全部落进 submission，仓库锁死');
});

test('🔴 maintainer 路径必须扫不可见字符 / bidi', () => {
  // 维护者也会被钓鱼，而 bidi（Trojan Source）恰恰是「评审时看着没问题」的那类。
  // 维护者 PR 改的正是 scripts/ 与 .github/，也就是**门自己** ——
  // 这条对它比对投稿更要紧，不是更不要紧。
  const body = VALIDATE();
  const b = jobBlocks(body).get('maintainer-gates');
  assert.ok(b !== undefined, 'maintainer-gates 不见了');
  // 🔴 **绑到它真正扫的那个目录上**，不只是「文件里出现过 scan-text.mjs」。
  //    后者是伪绿：把 `--submissions` 指到一个空目录，扫描照样"跑了"、
  //    照样绿，而一个文件都没看过（Codex 2026-09-01）。
  const scanStep = stepBlocks(b).find((s) => /scan-text\.mjs/.test(s));
  assert.ok(scanStep !== undefined, 'maintainer-gates 没有跑 scan-text.mjs');
  assert.match(scanStep, /node\s+--no-warnings\s+base-tools\/scripts\/submission\/scan-text\.mjs/,
    '扫描器必须来自 base-tools');
  assert.match(scanStep, /--submissions\s+scan-src\b/,
    'scan-text 没有扫 scan-src —— 那是上一步从 PR 树摘出来的改动文件');
  // 🔴 扫的是**本 PR 改动的文件**，不是全仓。全仓扫在本仓库上就是红的
  //    （src/pack.mjs 里有一个故意的 U+200B 用来顶开 `*/`），那等于换一种方式
  //    把维护者的 PR 全部锁死 —— 正是这个 job 要消除的失败模式。
  assert.match(b, /needs\.route\.outputs\.present/,
    'maintainer-gates 必须按 router 给的「改动后仍存在的路径」清单扫');
  // 🔴 那份清单必须排除被删除的路径，否则「清单里有、树里找不到 → 硬失败」
  //    会把每一次删文件都判成异常，于是这条守卫迟早会被人删掉。
  assert.match(jobBlocks(body).get('route'), /--diff-filter=d/,
    'route 的 present 清单没有排除删除，maintainer-gates 的「找不到就硬失败」会误伤');
});

test('🔴🔴 maintainer PR 夹带投稿时，§6 结构门与 §7 Tier 门照跑', () => {
  // 没有这两道的话，维护者只要把一份畸形投稿塞进自己那张「改 CI」的 PR，
  // 两道门一道都不跑，内容直接进 main（main 上的东西会被 clone、被 fork），
  // 随后在 promote 阶段才炸并堵死整条流水线。
  // 「后面还有一道门」不等于「这里可以没有门」。
  const b = jobBlocks(VALIDATE()).get('maintainer-gates');
  const steps = stepBlocks(b);
  const GUARD = /if:\s*\$\{\{\s*steps\.touched\.outputs\.sub\s*==\s*'yes'\s*\}\}/;

  // 🔴🔴 **条件必须挂在那两个 step 自己身上。**（Codex 2026-09-01）
  //    只数「job 里出现了两次 `sub == 'yes'`」是**伪绿**：把条件搬到两个不相干的
  //    step 上，断言照样过，而两道门变成无条件跑（或更糟，被别的条件挡掉）。
  //    所以按 step 切块，逐个绑定「这个跑门的 step 上有没有这个守卫」。
  for (const [script, what] of [['run-gates', '§6 结构门'], ['tier-gate', '§7 Tier 审批人数门']]) {
    const s = steps.find((x) => new RegExp(`base-tools/scripts/submission/${script}\\.mjs`).test(x));
    assert.ok(s !== undefined, `maintainer-gates 没跑 ${what}（${script}.mjs）`);
    assert.match(s, GUARD, `跑 ${what} 的那个 step 上没有 touched 守卫 —— 条件跑到别处去了`);
  }
  // 反过来：守卫**只能**出现在那两个 step 上，多一个就说明有人拿它挡别的门
  assert.equal(steps.filter((s) => GUARD.test(s)).length, 2,
    'touched 守卫出现在了别的 step 上 —— 它只该守 §6 与 §7 那两步');

  // 🔴 判定本身必须 fail-closed，而且**不能用管道**：
  //    `printf … | grep -q` 命中后 grep 先退出、printf 吃 SIGPIPE 返回 141，
  //    `pipefail` 把它变成整条管道失败 —— 于是「命中」被读成「没命中」，
  //    默认值写成 yes 也救不回来（实测：清单 ~300KB 时必现）。
  const touched = steps.find((s) => /id:\s*touched/.test(s));
  assert.ok(touched !== undefined, '找不到 id: touched 那个 step');
  // 🔴 `sub` 只能在 case 的两个具体分支里被赋值，别处一个都不许有 ——
  //    多一句「兜底默认」就等于给这道门加了一条 fail-open 的路。
  //    未知退出码走 `*)` 硬失败，那才是这里的 fail-closed。
  assert.match(touched, /0\) sub=yes/, '命中时必须置 yes');
  assert.match(touched, /1\) sub=no/, '只有「确实没命中」(rc=1) 才允许置 no');
  assert.equal((touched.match(/\bsub=/g) ?? []).length, 3,
    'sub 的赋值不是恰好两处（外加一处写 $GITHUB_OUTPUT）—— 多出来的那处多半是兜底默认');
  assert.ok(!/\|\s*grep\b/.test(touched),
    '🔴 判定用了管道喂 grep —— pipefail + grep 提前退出会把「命中」读成「没命中」');
  assert.match(touched, /rc=\$\?/, '没有取 grep 的退出码 —— 「没命中」与「出错」必须分开');
  assert.match(touched, /case "\$rc" in[\s\S]*\*\)[\s\S]*exit 1/,
    'grep 出错（rc≥2）时必须硬失败，不能当成「没命中」');
});

test('🔴 job output 的 heredoc 分隔符必须是随机的 —— 文件名是攻击者可控的', () => {
  // 仓库根下放一个名叫 `PATHS_EOF` 的文件，写死分隔符的 heredoc 就在那一行
  // 提前闭合：后面的路径不再属于这个 output，于是路径白名单**根本没看见**
  // 排在它后面的 `artifacts/x.json`（Codex 2026-09-01）。
  const body = VALIDATE();
  const delims = [...body.matchAll(/^\s*echo "?(\w+)<<([^"\s]+)"?\s*$/gm)].map((m) => m[2]);
  assert.ok(delims.length >= 1, '没找到 heredoc 形式的 job output —— 是不是改结构了？');
  for (const d of delims) {
    assert.match(d, /^\$/, `分隔符 ${d} 是写死的字面量 —— 同名文件就能把清单截断`);
  }
  // 🔴 **要绑到 `delim` 这个变量的赋值上**：只断言「文件里有 /dev/urandom」
  //    是伪绿 —— 随机数可以算出来却拿去干别的，而 `delim` 仍是字面量
  //    （Codex 2026-09-01）。
  const names = [...new Set(delims.map((d) => d.replace(/^\$\{?|\}$/g, '')))];
  for (const n of names) {
    assert.match(body, new RegExp(`${n}="?[^"\\n]*\\$\\((?=[^)\\n]*/dev/urandom)`),
      `${n} 不是由 /dev/urandom 赋值的 —— 分隔符没有真的随机化`);
  }
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

// 🔴 **collect 的输出不能就地写回 build-inputs 的输入。**
//
// 2026-09-01 第一次真跑 promote 时红在这里：`collect-promotion-inputs` 把首次
// 注册写进 `registry/owners.json`，下一步 `build-inputs` 再读**同一个文件**，
// 于是看到「geoly-ai 已注册却还声明了 claim_owner」，判成「换 owner 要走 §7
// 转让流程」—— 而那个「已注册」正是本次运行三行之前自己写的。
//
// ⚠️ 形状是：**第一步的输出污染了第二步的输入**。两步对「现在注册了什么」的
//    判断因此分叉，而两边各自的日志看起来都对。与「不要拿被测对象自己当证据」
//    是同一条教训（docs/m3/01-delivery.md）。
test('🔴 promote 的 --owners-out 不许写回 registry/owners.json（会污染下一步的输入）', () => {
  const body = PROMOTE();
  const m = body.match(/--owners-out\s+(\S+)/);
  assert.ok(m, 'promote.yml 里找不到 --owners-out —— 这条断言正在空跑');
  assert.notEqual(m[1], 'registry/owners.json',
    '--owners-out 写回了 build-inputs 要读的那个文件：collect 记下的首次注册会被\n'
    + '  build-inputs 当成「早就注册过了」，于是本次的 claim_owner 被判成非法转让。');
  // 落盘必须发生在提交那一步，而且必须真的发生 —— 否则首次注册永远不进仓库。
  assert.match(body, /cp\s+\/tmp\/owners-merged\.json\s+registry\/owners\.json/,
    '合并后的 owners 从来没被落盘 —— 首次注册不会进仓库，下一次投稿又要重新 claim');
});

// 🔴 **pr-classify 有两个调用点，两个都必须把必填参数传全。**
//
// 2026-09-02：把 `--present-paths` 设成必填之后，我只接了 validate-pr.yml、
// **漏了 promote.yml**，promote 当场红在「缺少 --present-paths」。
// ⚠️ 这已经是同一个形状第二次咬人了（第一次是审批判定其实有三处）。
// 判据是**全仓搜调用点**，不是维护一份「我知道的调用者」清单 ——
// 后者只能守住你已经知道的东西。
test('🔴 每个 pr-classify.mjs 调用点都必须传全必填参数', () => {
  const REQUIRED = ['--head-ref', '--head-repo', '--this-repo', '--author-id',
    '--release-bot-id', '--maintainer-ids', '--changed-paths', '--present-paths'];
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
  const callers = [];
  for (const f of files) {
    const body = read(f);
    if (!body.includes('pr-classify.mjs')) continue;
    callers.push(f);
    // 取从 `pr-classify.mjs` 到该 shell 命令结束（以 `)` 或空行收尾）之间的文本
    const i = body.indexOf('pr-classify.mjs');
    const chunk = body.slice(i, i + 900);
    for (const flag of REQUIRED) {
      assert.ok(chunk.includes(flag),
        `${f} 里的 pr-classify 调用缺少 ${flag} —— 它是必填的，缺了会直接报错。`);
    }
  }
  // 🔴 一个调用点都没找到，说明这条断言在空跑（比如文件被改名了）。
  assert.ok(callers.length >= 2,
    `只找到 ${callers.length} 个 pr-classify 调用点（${callers.join('、')}）——`
    + '预期至少两个（validate-pr 与 promote）。少了就说明这条断言正在一个'
    + '不完整的集合上判定。');
});

// 🔴 **CLI 的 Release 与 registry 的 Release 不许合并。**
//
// 客户端手上只有**已验签快照**里的 `asset.file` 与 `sha256`，位置靠
// `hub-v<N>` 这个约定推导（02-registry.md §4.0）。合并到 CLI 版本号上的话，
// 「快照号 N → 哪个 tag」这个映射**不在任何签名对象里**，客户端推不出去哪儿下载。
//
// ⚠️ 2026-09-03 之前的实现正是把两者挂在同一个 `v<CLI版本>` 上，结果是
//    **「已发布但没人能装」** —— registry 里 23 个制品、快照签好了、站点能浏览，
//    而任何一次 install 都取不到字节。这条不变式就是为了不让它被合回去。
test('🔴 release.yml 必须建两个 Release：v<x.y.z> 与 hub-v<N>', () => {
  const body = read('release.yml');
  const creates = [...body.matchAll(/gh release create\s+("?)([^"\s]+)\1/g)].map((m) => m[2]);
  assert.ok(creates.length >= 2,
    `只找到 ${creates.length} 处 gh release create —— CLI 与 registry 必须各建各的`);
  assert.ok(creates.some((t) => t.includes('hub-v')),
    `没有 hub-v<N> 这个 Release —— 客户端就推不出资产地址。实际：${creates.join(', ')}`);
  assert.ok(creates.some((t) => t.includes('TAG') || /^v/.test(t)),
    `没有 CLI 自己的 v<x.y.z> Release。实际：${creates.join(', ')}`);
  // 🔴 两者必须是**不同**的 tag —— 同一个就等于合并了。
  assert.notEqual(creates[0], creates[1], '两个 Release 用了同一个 tag');
});

// 🔴 快照里记了几个制品，就必须挂几个资产。
//    少挂一个的话，客户端按 locator 取到 404，而它手上的快照是**验过签的** ——
//    它会以为是分发被人动了手脚，而不是我们自己漏发了。
test('🔴 hub-v<N> 必须校验「资产数 == 快照记的制品数」', () => {
  const body = read('release.yml');
  assert.match(body, /artifacts\.length/,
    'hub-v<N> 那一步没有按快照里的制品数校验资产数 —— 取不全的 Release 会被当成投毒');
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
  // 🔴 **按用途定位，不是「整个文件里存在就算」。**
  //    这条原本是 `assert.match(body, /--diff-filter=d/)` —— 2026-09-02 我在
  //    同一个文件里加了**第二处** `--diff-filter=d`（算 present 清单用的），
  //    于是「去掉 --diff-filter=d」那条变异改坏一处、另一处还在，断言照样绿。
  //    ⚠️ 一个只问「存不存在」的断言，会随着同名东西变多而**自己失效**，
  //    而且不会有任何迹象。判据要钉在它真正关心的那一行上。
  assert.match(body, /only=\$\(git diff[^\n]*--diff-filter=d/,
    '算「本次 PR 带来哪些投稿」（only=…）时要排掉删除');
  assert.match(body, /present=\$\(git diff[^\n]*--diff-filter=d/,
    'present 清单就是「排掉删除的 changed」——两者必须来自同一次 diff');
  // 🔴 `--maintainer-ids` 在 pr-classify 里是**必填**（「名单没取到」不能与
  //    「显式空名单」长得一样）。promote 是第二个调用方 —— 不传的话，
  //    **每一次 promote 都会因为缺参直接失败**，而这个文件是本机唯一能提前
  //    发现它的地方（Codex 2026-09-01 点名的遗漏）。
  // 🔴 **按 run 块判，不按全文判**：`--maintainer-ids` 在 promote.yml 里出现两次
  //    （分流、以及 §3 第 1 项的 approve 门）。全文匹配的话，把分流那一处删掉
  //    另一处还在，断言照样绿 —— 同 validate-pr 里踩过的那一格。
  const classifyBlock = runBlocks(body).find((b) => /pr-classify\.mjs/.test(b));
  assert.ok(classifyBlock !== undefined, '找不到调 pr-classify 的那个 run 块');
  assert.match(classifyBlock, /--maintainer-ids/,
    'promote 调 pr-classify 时漏了 --maintainer-ids —— 它是必填参数，promote 会全线失败');
  assert.match(classifyBlock, /\.maintainers\s*\|\s*map\(\.id\)/, '同 validate-pr：取不可变 node id，不取 login');
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
    // 🔴 钉**真正那条命令**，不是「npm publish」这个词。
    //    2026-09-03 实测：我在文件顶部的 `registry_only` 输入描述里写了
    //    「跳过 npm publish 与 CLI Release」，`/npm publish /` 当场匹配到**注释**，
    //    位置在阶段 C 之前，于是这条不变式**假红**了。
    //    反过来更危险：某天有人在文件末尾的注释里提一句 npm publish，
    //    这条断言就会**假绿**——因为它匹配到的位置排在 C 之后。
    ['npm publish', /npm publish "\$TGZ"/],
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

// ── ci.yml：ci-gate 的两份清单必须一致 ─────────────────────────────────────
//
// 🔴 `ci-gate` 自己带了一道「needs 里缺少 X」的运行时检查，但**它的检查清单是
//    手维护的第二份**：`needs: [...]` 一份，`for want in ...` 一份。
//    两份不一致的方向决定了后果，而危险的那个方向是**静默的**：
//      · `want` 里有、`needs` 里没有 → 运行时直接报错（那道门自己抓得住）；
//      · `needs` 里有、`want` 里没有 → **新 job 的结果根本不被核验**，
//        它红了 `ci-gate` 照样绿。没有任何东西会报错。
//    2026-09-01 加 `dashboard` job 时正是手改的这两处 —— 会出错的操作要有门。
test('🔴 ci-gate 的 needs 清单与它自查的 want 清单必须逐项一致', () => {
  const body = read('ci.yml');

  // 🔴 按**下标**切 job 块，不用一条正则一把梭。
  //    第一版写的 `(?=^  [a-z-]*:\n|\Z)` 在 JS 里是坏的：JS 正则**没有** `\Z`,
  //    那两个字符被当成字面量 `Z`，于是「到文件末尾」这一路根本匹配不上,
  //    ci-gate 是最后一个 job 时整块切不出来。变异自检当场把它抓住了
  //    （control 副本就红了）—— 正是它存在的理由。
  const HEAD = '\n  ci-gate:\n';
  const at = body.indexOf(HEAD);
  assert.notEqual(at, -1, 'ci.yml 里找不到 ci-gate job —— 这条断言正在空跑');
  const rest = body.slice(at + HEAD.length);
  const nextJob = rest.search(/\n {2}[a-z][\w-]*:\n/);
  const block = nextJob === -1 ? rest : rest.slice(0, nextJob);

  const needsLine = block.match(/^\s*needs:\s*\[([^\]]+)\]/m);
  assert.ok(needsLine, 'ci-gate 的 needs 不是 `[a, b, c]` 这种能读懂的写法');
  const needs = needsLine[1].split(',').map((x) => x.trim()).filter(Boolean);

  const wantLine = block.match(/for want in ([^;]+); do/);
  assert.ok(wantLine, 'ci-gate 里找不到 `for want in ...; do` 自查清单');
  const wants = wantLine[1].trim().split(/\s+/).filter(Boolean);

  assert.ok(needs.length > 0, 'needs 清单是空的');
  assert.deepEqual(
    [...wants].sort(), [...needs].sort(),
    `ci-gate 的两份清单不一致：needs=[${needs.join(', ')}] want=[${wants.join(', ')}]。`
    + ' 只在 needs 里出现的 job，它红了 ci-gate 照样绿。',
  );
});

/**
 * 每个变异都写明**该由哪一条断言抓住**（`expect` 是那条 test 名字的一段）。
 *
 * 🔴 只判「子进程红了」是不够的：一个变异可能被**另一条**断言顺手抓到
 *    （比如写法子集门），于是我真正关心的那条其实已经失效了，而自检看起来是绿的。
 *    这正是这份文件反复踩的那个坑的另一个形状 —— 「看起来被守住了」。
 */
const MUTATIONS = [
  ['release.yml', 'gh release create "hub-v$N"', 'gh release create "$TAG-hub"',
    'hub-v<N> 改成派生自 CLI 版本号', '必须建两个 Release'],
  ['release.yml', 'JSON.parse(require(\'fs\').readFileSync(\'$snap\',\'utf8\')).artifacts.length',
    '0',
    '去掉「资产数 == 快照制品数」的校验', '资产数 == 快照记的制品数'],
  ['promote.yml', '--changed-paths "$paths" --present-paths "$present")',
    '--changed-paths "$paths")',
    'promote 调 pr-classify 时漏传 --present-paths', '必须传全必填参数'],
  ['promote.yml', '--owners-out /tmp/owners-merged.json',
    '--owners-out registry/owners.json',
    'owners 合并结果就地写回（污染下一步输入）', '不许写回 registry/owners.json'],
  ['promote.yml', 'cp /tmp/owners-merged.json registry/owners.json', '',
    '合并后的 owners 从不落盘', '不许写回 registry/owners.json'],
  ['ci.yml', 'for want in versions test fault-exhaustive pack dashboard; do',
    'for want in versions test fault-exhaustive pack; do',
    'ci-gate 的 want 清单少一项（needs 里仍有）', 'want 清单必须逐项一致'],
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
  ['promote.yml', 'only=$(git diff --no-renames --diff-filter=d --name-only',
    'only=$(git diff --no-renames --name-only',
    'only= 那一处去掉 --diff-filter=d', '分流用的是 router'],
  ['promote.yml', 'present=$(git diff --no-renames --name-only --diff-filter=d',
    'present=$(git diff --no-renames --name-only',
    'present 那一处去掉 --diff-filter=d', '分流用的是 router'],
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

  // ── 第三类路径 `maintainer`（2026-09-01 补的那条）────────────────────────
  // 🔴 加一条路径最危险的不是"新代码有 bug"，是**旧断言默默地不再覆盖全部**：
  //    原来的互斥判据是为**两条**写的，扩到三条时漏掉任意一格就退化成
  //    「任一通过即可」—— 而那正是 §4 点名禁止的形状。下面每一条都对着一个
  //    具体的退化方向。
  ['validate-pr.yml', 'map(.id)', 'map(.login)', '维护者名单改用可变的 login', '不可变 node id'],
  ['validate-pr.yml', '--maintainer-ids "$ids" \\', '', 'router 拿不到维护者名单', '不可变 node id'],
  ['validate-pr.yml', 'needs: [route, submission-gates, promotion-gates, maintainer-gates]',
    'needs: [route, submission-gates, promotion-gates]', 'pr-gate 漏掉 maintainer 那条', '三条路径互斥'],
  ['validate-pr.yml', "if: ${{ needs.route.outputs.kind == 'maintainer' }}", 'if: ${{ always() }}',
    'maintainer 路径无条件跑', 'router 的判定触发'],
  ['validate-pr.yml', '--diff-filter=d ', '', 'present 清单不再排除删除', 'maintainer 路径必须扫'],

  // ── Codex 2026-09-01 第一轮点名的形状 ────────────────────────────────
  ['validate-pr.yml', 'base-tools/scripts/submission/tier-gate.mjs', 'true #',
    'maintainer 夹带投稿时不跑 Tier 门', '§7 Tier 门照跑'],
  ['validate-pr.yml', '0) sub=yes ;;', '0) sub=no ;;',
    '命中了 submissions/ 却判成没夹带', '§7 Tier 门照跑'],
  ['validate-pr.yml', '          set +e', '          sub=no\n          set +e',
    '给判定加一条 fail-open 的兜底默认', '§7 Tier 门照跑'],
  ['validate-pr.yml', 'delim="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d \' \\n\')"',
    'delim=PATHS_EOF', 'heredoc 分隔符改回写死的字面量', 'heredoc 分隔符必须是随机的'],
  ['promote.yml', '--maintainer-ids "$ids" ', '',
    'promote 调 router 时漏传维护者名单', '分流用的是 router'],

  // ── Codex 2026-09-01 第二轮：伪绿与 SIGPIPE ──────────────────────────
  // 🔴 P1 是一个**实测复现过**的绕过：`printf … | grep -q` 在清单 ~300KB 时
  //    把「命中」读成「没命中」，§6 与 §7 双双被跳过而全绿。
  ['validate-pr.yml', "grep -q '^submissions\\(/\\|$\\)' paths.txt",
    "printf '%s\\n' \"$PATHS\" | grep -q '^submissions\\(/\\|$\\)'",
    '判定改回管道喂 grep（SIGPIPE 绕过）', '§7 Tier 门照跑'],
  ['validate-pr.yml', '            1) sub=no ;;', '            1|2) sub=no ;;',
    'grep 出错也当成「没命中」', '§7 Tier 门照跑'],
  ['validate-pr.yml', '--submissions scan-src --annotate', '--submissions base-tools --annotate',
    '扫描指向别的目录（跑了但没看 PR 的文件）', 'maintainer 路径必须扫'],
  ['validate-pr.yml', 'delim="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d \' \\n\')"',
    'rnd=$(head -c 16 /dev/urandom); delim=PATHS_EOF',
    '算了随机数却没用在分隔符上', 'heredoc 分隔符必须是随机的'],
];

/**
 * 这几条要改**最后**一处：那一处正是 maintainer 那条路径上的，
 * 而同样的文本在前面的 job 里也有 —— 改第一处证明不了新路径受保护。
 */
MUTATIONS.push(
  ['validate-pr.yml', 'node --no-warnings base-tools/scripts/submission/scan-text.mjs', 'true #',
    'maintainer 路径不再扫不可见字符', 'maintainer 路径必须扫'],
  ['validate-pr.yml', '[ "$PROMO" = "skipped" ]', 'true',
    '三路互斥漏掉 maintainer 分支里的 promotion 那格', '三条路径互斥'],
);

/** 需要改**最后**一处而不是第一处的变异（证明每一处 checkout 都还受保护）。 */
const LAST_OCCURRENCE = new Set([
  '末处 checkout 去掉凭据守卫',
  'maintainer 路径不再扫不可见字符',
  '三路互斥漏掉 maintainer 分支里的 promotion 那格',
  // tier-gate.mjs 在 submission-gates 里也有一处，改第一处证明不了
  // maintainer 那条路径上的那道门还在。
  'maintainer 夹带投稿时不跑 Tier 门',
]);
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
