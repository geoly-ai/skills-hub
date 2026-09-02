// §6 结构门跑在 submissions/** 上 —— run-gates.mjs。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 🔴 用相对本文件的路径，不写死绝对路径 —— 否则换台机器就红
const R = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { runGates, scanSubmissions } = await import(`${R}/scripts/submission/run-gates.mjs`);
const { readReserved } = await import(`${R}/scripts/submission/structural-gates.mjs`);
// 既有用例测的是别的门；它们的前提是 namespace 已经注册过
// ⚠️ 连 `admin` 也放进来：那几个用例测的是**保留名**那道门，
//    不把它算成已注册的话，它会同时触发「尚未注册」，用例就不再是单一变量了。
const REG = new Set(['geoly', 'ns', 'other', 'mine', 'a', 'b', 'admin']);
const roots=[]; const mk=()=>{const d=mkdtempSync(join(tmpdir(),'rg-'));roots.push(d);return d;};
after(()=>{for(const d of roots){try{rmSync(d,{recursive:true,force:true});}catch{}}});
const RES = readReserved(join(R,'registry/reserved.json'));
function sub(root, ns, name, ver, files){
  const d=join(root,'submissions',ns,`${name}@${ver}`); mkdirSync(d,{recursive:true});
  for(const [f,c] of Object.entries(files)) writeFileSync(join(d,f), c);
  return d;
}
const SKILL=(caps)=>JSON.stringify({schema:'geoly.skills.skill/1',kind:'skill',namespace:'x',name:'y',version:'1.0.0',description:'d',license:'MIT',clients:['claude'],capabilities:caps,replaces:[],conflicts:[],provenance:{kind:'original',author_github_id:'1',submitted_by_pr:1}});

test('干净的投稿通过', () => {
  const r=mk(); sub(r,'mine','alpha','1.0.0',{'SKILL.md':'---\nname: alpha\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,registeredNamespaces:REG});
  assert.deepEqual(g.problems,[]); assert.equal(g.checked,1);
});
test('🔴 保留 namespace 被拒（非维护者）', () => {
  const r=mk(); sub(r,'geoly','alpha','1.0.0',{'SKILL.md':'---\nname: alpha\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,registeredNamespaces:REG});
  assert.equal(g.problems.length,1); assert.match(g.problems[0],/保留清单/);
  const ok=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,byMaintainer:true,registeredNamespaces:REG});
  assert.deepEqual(ok.problems,[]);
});
test('🔴 skill.json 与 pack.json 都在 → 拒（这是什么制品有两个答案）', () => {
  const r=mk(); sub(r,'mine','alpha','1.0.0',{'SKILL.md':'---\nname: alpha\ndescription: d\n---\n\n正文\n','skill.json':'{}','pack.json':'{}'});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,registeredNamespaces:REG});
  assert.match(g.problems[0],/恰好.*一个/);
});
test('🔴 一次报出全部问题，不是遇到第一个就退', () => {
  const r=mk();
  sub(r,'geoly','alpha','1.0.0',{'SKILL.md':'---\nname: alpha\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  sub(r,'admin','beta','1.0.0',{'SKILL.md':'---\nname: beta\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,registeredNamespaces:REG});
  assert.equal(g.problems.length,2,'两个投稿各一条，让人一次看全');
});
test('🔴 版本已占用（含已 yank）→ 拒', () => {
  const r=mk(); sub(r,'mine','alpha','1.0.0',{'SKILL.md':'---\nname: alpha\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,existingIds:['skill:mine/alpha@1.0.0']});
  assert.match(g.problems[0],/不可重用/);
});
test('目录名不合布局 → 抛错，不猜', () => {
  const r=mk(); mkdirSync(join(r,'submissions','mine','没有at号'),{recursive:true});
  assert.throws(()=>scanSubmissions(join(r,'submissions')),/不合布局/);
});
test('🔴 CLI 真调用：有问题时非零退出', () => {
  const r=mk(); sub(r,'geoly','alpha','1.0.0',{'SKILL.md':'---\nname: alpha\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const p=spawnSync(process.execPath,[`${R}/scripts/submission/run-gates.mjs`,'--submissions',join(r,'submissions'),'--reserved',join(R,'registry/reserved.json'),'--artifacts',join(r,'nope')],{encoding:'utf8'});
  assert.equal(p.status,1,p.stderr); assert.match(p.stderr,/不合规/);
});

test('🔴 结构门只读投稿、从不 import 它 —— 载荷里放一个会爆炸的 .mjs 也不该被执行', () => {
  // §5：「结构门全部是对文件的检查，**不执行载荷**」。
  // workflow 那一侧靠「校验器从 base 检出、PR 内容只当数据」保证；
  // 这一侧保证的是：run-gates 自己不会去 import 被检目录里的东西。
  const r = mk();
  sub(r, 'mine', 'alpha', '1.0.0', {
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文\n',
    'skill.json': SKILL(['none']),
    // 如果 run-gates 去 import 它，这一句会让进程当场退出、测试必红
    'evil.mjs': 'process.exit(42);\n',
  });
  // evil.mjs 会被 capability 一致性门按「脚本扩展名」拒 —— 那是**读**出来的判断，
  // 不是执行它得出的。进程还活着本身就是证据。
  const g = runGates({ submissionsRoot: join(r, 'submissions'), reserved: RES });
  // 🔴 **进程还活着本身就是证据**：evil.mjs 里是 process.exit(42)，
  //    只要 run-gates 去 import 它，这个测试进程就当场没了。
  assert.equal(g.checked, 1);
  // 而 evil.mjs 确实被**读**出来并按「脚本扩展名」判掉了 —— 读，不是执行
  assert.match(g.problems.join('\n'), /capabilities: \["none"\]/);
});

test('🔴 PROMOTION.json 的形状在**投稿 PR** 上就检', () => {
  // 等到 promote 才报，那时投稿已经合并进 main，改起来要走一整轮
  const root = mk();
  const dir = join(root, 'geoly', 'alpha@1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n\n正文\n');
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({ name: 'alpha', capabilities: ['none'] }));
  writeFileSync(join(dir, 'PROMOTION.json'), JSON.stringify({
    schema: 'geoly.skills.promotion-file/1',
    claim_owner: { kind: 'user', login: 'alice', id: '别人的 id' },   // promote 才填的字段
  }));
  const { problems } = runGates({
    submissionsRoot: root, reserved: { schema: 'geoly.skills.reserved/1', namespaces: [] },
    registeredNamespaces: REG,
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /promote 自己填/);
});

test('🔴🔴 pack 没有 PROMOTION.json → **投稿 PR 上就拒**', () => {
  // 「有就检」不够：这样的投稿会通过 CI、合并进 main、然后卡住 promote ——
  // 那时它已经在 main 上了
  const r = mk();
  // 用非保留的 namespace，否则同时触发保留名那道门，用例就不是单一变量了
  sub(r, 'mine', 'matrix', '1.0.0', { 'SKILL.md': 'x\n', 'pack.json': '{}\n' });
  const g = runGates({ submissionsRoot: join(r, 'submissions'), reserved: RES, registeredNamespaces: REG });
  assert.equal(g.problems.length, 1, g.problems.join('\n'));
  assert.match(g.problems[0], /pack 必须有 PROMOTION\.json/);
});

test('🔴🔴 未注册 namespace 的首投没有 claim_owner → 投稿 PR 上就拒', () => {
  const r = mk();
  sub(r, 'brandnew', 'alpha', '1.0.0', { 'SKILL.md': '---\nname: alpha\ndescription: d\n---\n\n正文\n', 'skill.json': SKILL(['none']) });
  const g = runGates({ submissionsRoot: join(r, 'submissions'), reserved: RES, registeredNamespaces: REG });
  assert.equal(g.problems.length, 1, g.problems.join('\n'));
  assert.match(g.problems[0], /尚未注册/);
});

test('声明齐全就放行', () => {
  const r = mk();
  sub(r, 'brandnew', 'alpha', '1.0.0', {
    'SKILL.md': '---\nname: alpha\ndescription: d\n---\n\n正文\n',
    'skill.json': SKILL(['none']),
    'PROMOTION.json': JSON.stringify({
      schema: 'geoly.skills.promotion-file/1',
      claim_owner: { kind: 'user', login: 'alice' },
    }),
  });
  const g = runGates({ submissionsRoot: join(r, 'submissions'), reserved: RES, registeredNamespaces: REG });
  assert.deepEqual(g.problems, []);
});

// ── SKILL.md frontmatter 在**投稿 PR** 上就检 ──────────────────────────────
//
// 🔴 2026-09-02：这道门以前**根本不解析 frontmatter**。于是 11 个 plaud 投稿
//    全绿合并进 main，promote 建快照时才红在 E_FRONTMATTER —— 其中 10 个用了
//    YAML 折叠标量 `>`，而解析器是刻意最小化的、只认单行 `key: value`
//    （拒绝锚点/别名等能让同一份文本解出不同结构的写法）。
//    那正是本文件里反复写的那件事：**等到 promote 才报，投稿已经在 main 上了**。
test('🔴 折叠标量 `>` 在投稿 PR 上就被拒（不是等到 promote 建快照）', () => {
  const r = mk();
  sub(r, 'mine', 'alpha', '1.0.0', {
    'SKILL.md': '---\nname: alpha\ndescription: >\n  跨了\n  两行\n---\n\n正文\n',
    'skill.json': SKILL(['none']),
  });
  const g = runGates({ submissionsRoot: join(r, 'submissions'), reserved: RES, registeredNamespaces: REG });
  assert.equal(g.problems.length, 1);
  assert.match(g.problems[0], /E_FRONTMATTER/);
});

// 🔴 §5.3 第 ⑦ 项：SKILL.md frontmatter 的 name 必须等于制品名。
//    这条以前在投稿侧也没查 —— 本文件的夹具因此长期是**不自洽**的
//    （目录叫 alpha@1.0.0，frontmatter 里写 `name: a`），而没有任何东西会发现。
test('🔴 frontmatter 的 name 与目录名对不上 → 投稿 PR 上就拒', () => {
  const r = mk();
  sub(r, 'mine', 'alpha', '1.0.0', {
    'SKILL.md': '---\nname: 别的名字\ndescription: d\n---\n\n正文\n',
    'skill.json': SKILL(['none']),
  });
  const g = runGates({ submissionsRoot: join(r, 'submissions'), reserved: RES, registeredNamespaces: REG });
  assert.equal(g.problems.length, 1);
  assert.match(g.problems[0], /E_MANIFEST_BINDING/);
});

// 🔴 投稿门与建快照必须调**同一个**函数，不许各写一份。
test('🔴 投稿门用的就是 artifact.mjs 的 assertSkillFrontmatter', () => {
  const src = readFileSync(join(R, 'scripts/submission/run-gates.mjs'), 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(src, /assertSkillFrontmatter/,
    '投稿门没用共享的那个函数 —— 另写一份就是又一处会分叉的实现');
  assert.match(src, /from '\.\.\/\.\.\/src\/artifact\.mjs'/);
});
