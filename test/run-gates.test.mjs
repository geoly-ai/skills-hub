// §6 结构门跑在 submissions/** 上 —— run-gates.mjs。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 🔴 用相对本文件的路径，不写死绝对路径 —— 否则换台机器就红
const R = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { runGates, scanSubmissions } = await import(`${R}/scripts/submission/run-gates.mjs`);
const { readReserved } = await import(`${R}/scripts/submission/structural-gates.mjs`);
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
  const r=mk(); sub(r,'mine','alpha','1.0.0',{'SKILL.md':'---\nname: a\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES});
  assert.deepEqual(g.problems,[]); assert.equal(g.checked,1);
});
test('🔴 保留 namespace 被拒（非维护者）', () => {
  const r=mk(); sub(r,'geoly','alpha','1.0.0',{'SKILL.md':'---\nname: a\ndescription: d\n---\n\n正文\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES});
  assert.equal(g.problems.length,1); assert.match(g.problems[0],/保留清单/);
  const ok=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,byMaintainer:true});
  assert.deepEqual(ok.problems,[]);
});
test('🔴 skill.json 与 pack.json 都在 → 拒（这是什么制品有两个答案）', () => {
  const r=mk(); sub(r,'mine','alpha','1.0.0',{'SKILL.md':'x\n','skill.json':'{}','pack.json':'{}'});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES});
  assert.match(g.problems[0],/恰好.*一个/);
});
test('🔴 一次报出全部问题，不是遇到第一个就退', () => {
  const r=mk();
  sub(r,'geoly','alpha','1.0.0',{'SKILL.md':'x\n','skill.json':SKILL(['none'])});
  sub(r,'admin','beta','1.0.0',{'SKILL.md':'x\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES});
  assert.equal(g.problems.length,2,'两个投稿各一条，让人一次看全');
});
test('🔴 版本已占用（含已 yank）→ 拒', () => {
  const r=mk(); sub(r,'mine','alpha','1.0.0',{'SKILL.md':'x\n','skill.json':SKILL(['none'])});
  const g=runGates({submissionsRoot:join(r,'submissions'),reserved:RES,existingIds:['skill:mine/alpha@1.0.0']});
  assert.match(g.problems[0],/不可重用/);
});
test('目录名不合布局 → 抛错，不猜', () => {
  const r=mk(); mkdirSync(join(r,'submissions','mine','没有at号'),{recursive:true});
  assert.throws(()=>scanSubmissions(join(r,'submissions')),/不合布局/);
});
test('🔴 CLI 真调用：有问题时非零退出', () => {
  const r=mk(); sub(r,'geoly','alpha','1.0.0',{'SKILL.md':'x\n','skill.json':SKILL(['none'])});
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
