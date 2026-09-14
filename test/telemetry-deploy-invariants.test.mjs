// 埋点服务端的部署不变式 —— 这些东西单测跑不到，只有部署出去才会显形。
//
// 🔴 判据来自**实现形状**，不是手写清单（记忆：别维护「已知调用点」清单）：
//    · 每一个 app.mjs 导出的路径常量，都要在 vercel.json 里有 rewrite、有对应 api 文件、有 function 配置
//      —— 只加了 api 文件没加 rewrite，公开路由就不存在，而本地测试全绿
//    · 每一个 api/*.js 都要关掉平台 body 解析（除了 prune：它不读 body，也关着）
//    · 迁移里「清 NULL tag → set not null」的顺序不能反（反了迁移在有历史行的库上直接失败）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as app from '../server/app.mjs';

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));
const vercel = JSON.parse(readFileSync(join(SERVER, 'vercel.json'), 'utf8'));
const apiFiles = readdirSync(join(SERVER, 'api')).filter((f) => f.endsWith('.js'));

test('🔴 app.mjs 的每个公开路径都有 rewrite → 存在的 api 文件 → function 配置', () => {
  const paths = Object.entries(app).filter(([k, v]) => k.endsWith('_PATH') && typeof v === 'string').map(([, v]) => v);
  assert.ok(paths.length >= 4, `只从 app.mjs 找到 ${paths.length} 个路径常量，扫描八成不对`);
  for (const p of paths) {
    const rw = vercel.rewrites.find((r) => r.source === p);
    assert.ok(rw, `${p} 没有 rewrite —— 部署后这个路由不存在`);
    const file = `${rw.destination.replace(/^\/api\//, '')}.js`;
    assert.ok(apiFiles.includes(file), `${p} 的 rewrite 指向 ${rw.destination}，但 api/${file} 不存在`);
    const fn = vercel.functions[`api/${file}`];
    assert.ok(fn, `api/${file} 没有 function 配置（maxDuration 走平台默认）`);
    // 只断言「有这个键」的话，`{}` 也能过
    assert.ok(Number.isInteger(fn.maxDuration) && fn.maxDuration > 0 && fn.maxDuration <= 300,
      `api/${file} 的 maxDuration 不是 1–300 的整数：${JSON.stringify(fn)}`);
    // 🔴 wrapper 把 req.url 改回的必须正是这个契约路径，而且**只赋值一次**，否则 app.mjs 分派到 404
    const src = readFileSync(join(SERVER, 'api', file), 'utf8');
    const assigns = [...src.matchAll(/^\s*req\.url\s*=\s*'([^']*)';\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(assigns, [p], `api/${file} 对 req.url 的赋值应当恰好是一次 '${p}'，实际：${JSON.stringify(assigns)}`);
  }
});

test('🔴 每个 api wrapper 都关掉平台 body 解析', () => {
  for (const f of apiFiles) {
    const src = readFileSync(join(SERVER, 'api', f), 'utf8');
    if (f === 'health.js') continue;   // 不读 body，也不走 app.mjs
    assert.match(src, /bodyParser:\s*false/, `api/${f} 没关 bodyParser —— app.mjs 的字节闸就不成立了`);
  }
});

test('🔴 迁移：先删 NULL tag 行，再 set not null，再加 hex CHECK；指纹不一致就中止', () => {
  const src = readFileSync(join(SERVER, 'migrate.mjs'), 'utf8');
  const iDel = src.indexOf('delete from telemetry_identity where pubkey_tag is null');
  const iNotNull = src.indexOf('alter column pubkey_tag set not null');
  const iCheck = src.indexOf("check (pubkey_tag ~ '^[0-9a-f]{64}$')");
  assert.ok(iDel > 0 && iNotNull > 0 && iCheck > 0, '缺了清理 / NOT NULL / CHECK 之一');
  assert.ok(iDel < iNotNull && iNotNull < iCheck, '顺序反了：有历史 NULL 行的库上 set not null 会直接失败');
  // 指纹只在库里是 NULL 时写，不一致时退出而不是覆盖
  assert.match(src, /tag_key_id is null/, '写指纹没有限定「库里还没有」—— 会覆盖掉旧指纹');
  const iMismatch = src.indexOf('km.tag_key_id !== envKeyId');
  assert.ok(iMismatch > 0 && /process\.exit\(1\)/.test(src.slice(iMismatch, iMismatch + 400)),
    '指纹不一致时没有中止迁移');
});

// 🔴 运行时必须优先连最小权限角色：owner 对自己的表有全部权限，「审计只增不改」约束不住它（§4.4）。
test('🔴 运行时优先用 GEOLY_TELEMETRY_DATABASE_URL（telemetry_app），owner 只是回落', () => {
  const src = readFileSync(join(SERVER, 'vercel-runtime.mjs'), 'utf8');
  const m = src.match(/const url = ([^;]+);/);
  assert.ok(m, 'vercel-runtime.mjs 里找不到连接串的取值 —— 断言在空跑');
  const order = [...m[1].matchAll(/process\.env\.([A-Z_]+)/g)].map((x) => x[1]);
  assert.equal(order[0], 'GEOLY_TELEMETRY_DATABASE_URL', `连接串取值顺序不对：${order.join(' → ')}`);
  // 迁移不走应用角色：它要建表、改列、写指纹，应用角色没有这些权限
  const mig = readFileSync(join(SERVER, 'migrate.mjs'), 'utf8');
  assert.ok(!/GEOLY_TELEMETRY_DATABASE_URL/.test(mig.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')),
    '迁移脚本读了应用角色的连接串 —— 它会因权限不足失败');
});

test('🔴 迁移授权之后反查：审计表对 telemetry_app 只许 INSERT，多一项就中止', () => {
  const src = readFileSync(join(SERVER, 'migrate.mjs'), 'utf8');
  assert.match(src, /grant insert on telemetry_audit to telemetry_app/);
  assert.match(src, /revoke select, update, delete, truncate on telemetry_audit from telemetry_app/);
  const i = src.indexOf("has_table_privilege('telemetry_app', 'telemetry_audit', 'UPDATE')");
  assert.ok(i > 0, '没有反查审计表的 UPDATE 权限');
  assert.match(src.slice(i, i + 800), /if \(!ap\.i \|\| ap\.s \|\| ap\.u \|\| ap\.d \|\| ap\.t\)[\s\S]{0,200}process\.exit\(1\)/,
    '反查出多余权限时没有中止迁移');
  // 授权块不许删「telemetry_audit 的 UPDATE/DELETE」之外的东西：矩阵里每张表都要出现
  for (const t of ['telemetry_events', 'telemetry_rollup', 'telemetry_meta', 'telemetry_identity',
    'telemetry_delete_nonce', 'telemetry_delete_tombstone']) {
    assert.match(src, new RegExp(`grant [a-z, ]+ on [a-z_, ]*${t}[a-z_, ]* to telemetry_app`), `权限矩阵漏了 ${t}`);
  }
});

test('prune 定时任务：清过期 nonce 的失败不许回 200', () => {
  const src = readFileSync(join(SERVER, 'api', 'prune.js'), 'utf8');
  assert.match(src, /pruneDeleteNonces\(\)/);
  // 墓碑与事件同一条保留期 —— 用 days，不是身份的 idDays
  assert.match(src, /pruneTombstones\(days\)/, '墓碑没有接到定时清理，或用错了保留期');
  assert.match(src, /if \(nonceError\) idError = /, 'nonce 清理失败没有并入最终的失败状态');
});
