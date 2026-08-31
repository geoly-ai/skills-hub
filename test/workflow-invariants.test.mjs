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
// ⚠️ **本文件证明不了 workflow 能跑通** —— YAML 的事件语义、token 的实际权限、
//    GitHub 的行为，三样本机都无从证明（见 docs/m3/01-delivery.md §3.6）。
//    这里只证明「几条不该出现的东西没有出现」，以及「引用的脚本真的存在」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(new URL('.', import.meta.url).href)).replace(/\/test$/, '');
const WF_DIR = join(REPO, '.github', 'workflows');
const read = (f) => readFileSync(join(WF_DIR, f), 'utf8');
const ALL = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml')).sort();

// ════════════════════════════════════════════════════════════════════════════
// §5：禁止 pull_request_target
// ════════════════════════════════════════════════════════════════════════════

test('🔴 没有任何 workflow 用 pull_request_target（§5 明令禁止）', () => {
  // 它用 base 分支的 workflow 定义跑、且能拿到 secrets，而我们要 checkout 的是
  // fork 的 head —— 那是把写权限交给不可信内容的经典形状
  for (const f of ALL) {
    const body = read(f).replace(/^\s*#.*$/gm, '');     // 注释里提到它是可以的
    assert.ok(!/^\s*pull_request_target\s*:/m.test(body), `${f} 用了 pull_request_target`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// validate-pr.yml：它 checkout fork 的 head，所以只读 + 无 secret
// ════════════════════════════════════════════════════════════════════════════

test('🔴🔴 validate-pr.yml 一个 secret 都不能引用', () => {
  // 它检出的是 fork 的 head。给它任何 secret，`pull_request_review` 这条触发
  // （跑在 base 上下文）就会把它变成一个真正的 pull_request_target。
  const body = read('validate-pr.yml');
  assert.ok(!/secrets\./.test(body),
    'validate-pr.yml 引用了 secrets —— 它检出 fork 的 head，§5 不允许');
});

test('🔴 validate-pr.yml 的权限全是 read', () => {
  const body = read('validate-pr.yml');
  const perms = [...body.matchAll(/^\s*(contents|pull-requests|id-token|packages|actions|checks|issues|deployments|statuses):\s*(\S+)/gm)];
  assert.ok(perms.length > 0, '没找到任何 permissions —— 是不是改结构了？');
  for (const [, key, val] of perms) {
    assert.ok(val === 'read' || val === 'none',
      `validate-pr.yml 里 ${key}: ${val} —— 这个 workflow 只能是只读的`);
  }
});

test('🔴 validate-pr.yml 顶层显式声明了 permissions（不能吃仓库默认值）', () => {
  // 仓库默认可能是「读写」。不显式收紧的话，这个 workflow 会跟着默认走
  assert.match(read('validate-pr.yml'), /^permissions:\s*\n\s+contents:\s*read/m);
});

test('🔴 校验器一律从 base 检出，PR 内容只当数据', () => {
  const body = read('validate-pr.yml');
  // 每一处 `node …` 跑的脚本都必须在 base-tools/ 下
  const runs = [...body.matchAll(/node\s+--no-warnings\s+(\S+)/g)].map((m) => m[1]);
  assert.ok(runs.length >= 4, `只找到 ${runs.length} 处 node 调用，是不是改结构了？`);
  for (const r of runs) {
    assert.ok(r.startsWith('base-tools/'),
      `validate-pr.yml 跑了 ${r} —— 校验器必须来自 base，否则 PR 能改自己的检查器`);
  }
  // npm ci 只在 base-tools 里
  assert.ok(!/working-directory:\s*pr\b/.test(body),
    '不能在 PR 那棵树里跑任何东西');
});

test('🔴 「已有事实」的输入一律指向 base，不能让被检的 PR 自己提供', () => {
  const body = read('validate-pr.yml');
  for (const flag of ['--artifacts', '--reserved']) {
    for (const m of body.matchAll(new RegExp(`${flag}\\s+(\\S+)`, 'g'))) {
      const v = m[1];
      if (v.startsWith('pr/')) {
        // `--artifacts pr/artifacts` 只在 promotion 那条路径上合法：
        // 那里验的就是 PR 带来的那棵树本身
        assert.ok(/--pr\s+pr\b/.test(body) || v === 'pr/artifacts',
          `${flag} 指向了 ${v}`);
      }
    }
  }
  assert.match(body, /--reserved\s+base-tools\//,
    '保留 namespace 列表必须来自 base —— 否则 PR 能宣布自己不在保留名单里');
  assert.match(body, /maintainers\.json/,
    '维护者名单必须参与判定');
  assert.ok(!/pr\/registry\/maintainers\.json/.test(body),
    '🔴 维护者名单不能从 PR 里读 —— 那等于让投稿者宣布谁是维护者');
});

test('🔴 分支保护要钉的聚合门存在，且两条路径互斥', () => {
  const body = read('validate-pr.yml');
  assert.match(body, /^\s{2}pr-gate:/m, '固定名的聚合 job 不能改名 —— 分支保护钉的就是它');
  assert.match(body, /needs:\s*\[route,\s*submission-gates,\s*promotion-gates\]/);
  // 判据必须是「router 挑中的那一条」，不能是「有一条 success」
  assert.match(body, /"\$SUB"\s*=\s*"skipped"/);
  assert.match(body, /"\$PROMO"\s*=\s*"skipped"/);
});

test('🔴 审批被撤回时要重跑（否则过期的绿会留在那里）', () => {
  const body = read('validate-pr.yml');
  assert.match(body, /^\s{2}pull_request_review:/m);
  assert.match(body, /types:\s*\[submitted,\s*dismissed,\s*edited\]/);
});

// ════════════════════════════════════════════════════════════════════════════
// promote.yml：它有写权限，所以绝不能碰 fork 的内容
// ════════════════════════════════════════════════════════════════════════════

test('🔴🔴 promote.yml 绝不 checkout fork —— 它有 contents: write', () => {
  const body = read('promote.yml');
  const checkouts = [...body.matchAll(/actions\/checkout@[^\n]*\n((?:\s+[^\n]*\n)*)/g)];
  for (const [, block] of checkouts) {
    const ref = /ref:\s*(\S+)/.exec(block);
    assert.ok(ref === null || !/pull_request\.head/.test(ref[1]),
      `promote.yml 检出了 ${ref?.[1]} —— §5：它只读已经合并到 main 的内容`);
  }
});

test('🔴 promote.yml 触发条件只有 push 到 main 的 submissions/**', () => {
  const body = read('promote.yml');
  assert.match(body, /^on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]\s*\n\s+paths:\s*\['submissions\/\*\*'\]/m);
});

test('🔴 promote 串行且不许取消 —— 并发会让两张 promotion 双双通过版本检查', () => {
  const body = read('promote.yml');
  assert.match(body, /concurrency:\s*\n\s+group:\s*promote\s*\n\s+cancel-in-progress:\s*false/);
});

test('🔴 promote 的分流用的是 router 那一份代码，不是 shell 复述', () => {
  const body = read('promote.yml');
  assert.match(body, /pr-classify\.mjs/,
    '自己写 case promotion/hub-* 会漏掉「作者必须是 release bot」这一条');
  assert.ok(!/case\s+"\$ref/.test(body), '不要在 shell 里复述 router 的判据');
});

// ════════════════════════════════════════════════════════════════════════════
// 引用的脚本必须真的存在
// ════════════════════════════════════════════════════════════════════════════

test('🔴 workflow 里引用的每个 .mjs 都存在', () => {
  // 路径写错只在 CI 跑到那一步时才发现 —— 而那可能是发布当天
  const missing = [];
  for (const f of ALL) {
    for (const m of read(f).matchAll(/(?:^|\s)((?:base-tools\/)?scripts\/[\w./-]+\.mjs)/g)) {
      const rel = m[1].replace(/^base-tools\//, '');
      if (!existsSync(join(REPO, rel))) missing.push(`${f} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `这些脚本不存在：\n${missing.join('\n')}`);
});

test('🔴 workflow 里引用的每个 registry/*.json 都存在', () => {
  const missing = [];
  for (const f of ALL) {
    for (const m of read(f).matchAll(/(?:^|\s)((?:base-tools\/)?registry\/[\w./-]+\.json)/g)) {
      const rel = m[1].replace(/^base-tools\//, '');
      if (!existsSync(join(REPO, rel))) missing.push(`${f} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `这些文件不存在：\n${missing.join('\n')}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 占位值：填上之前必须是 fail-closed 的
// ════════════════════════════════════════════════════════════════════════════

test('🔴 RELEASE_BOT_ID 还是占位时，两个 workflow 里的值必须一致', () => {
  // 两处不一致的话，一张 PR 在 validate 侧判成 submission、在 promote 侧判成
  // promotion（或反过来）—— 那是最难查的一类分叉
  const ids = ['validate-pr.yml', 'promote.yml'].map((f) => {
    const m = /RELEASE_BOT_ID:\s*"([^"]*)"/.exec(read(f));
    assert.ok(m !== null, `${f} 里没有 RELEASE_BOT_ID`);
    return m[1];
  });
  assert.equal(ids[0], ids[1], 'validate-pr 与 promote 的 RELEASE_BOT_ID 不一致');
});

test('⚠️ maintainers.json 是空的 —— 这是有意的 fail-closed，不是待办', () => {
  // 填成占位值会让审批门「看起来在跑」而实际上谁都能过。
  // 这条测试红了，说明有人填了东西 —— 那时请确认填的是真的 node id，
  // 并把这条测试改掉（见 docs/m3/00-branch-protection.md 的上线顺序）。
  const doc = JSON.parse(readFileSync(join(REPO, 'registry', 'maintainers.json'), 'utf8'));
  assert.equal(doc.schema, 'geoly.skills.maintainers/1');
  assert.ok(Array.isArray(doc.maintainers));
  for (const m of doc.maintainers) {
    assert.ok(typeof m?.id === 'string' && m.id !== '' && !/PLACEHOLDER/i.test(m.id),
      `维护者 ${JSON.stringify(m)} 的 id 看起来是占位 —— 那比空名单更危险`);
  }
});
