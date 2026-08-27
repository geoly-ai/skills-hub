#!/usr/bin/env node
// Q12 门的**可重放**驱动。
//
// 用法：
//   node scripts/q12/run.mjs                      # 跑所有能跑的格子
//   node scripts/q12/run.mjs --client codex       # 只跑一端
//   node scripts/q12/run.mjs --scope global       # 只跑一个 scope
//   node scripts/q12/run.mjs --json out.json      # 报告落盘
//
// 为什么要它进仓库：docs/m1/00-gates.md 的读数原先只存在于一次性脚本里，
// `test/adapters.test.mjs` 只能核对 evidence 文案**说了什么**，核对不了那些数字
// **是不是真的** —— 把 evidence 里的数字改成任意值，测试照样全绿。
// 有了这个驱动，客户端升级后可以一键复测，负结果才有复现的依据。
//
// 🔴 全程在临时 HOME / CODEX_HOME 沙箱里跑，跑完核对真实的
//    ~/.claude ~/.codex ~/.cursor ~/.agents **一个字节都没变**（sandbox.mjs）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertRealHomeUntouched, fingerprintRealHome, makeSandbox } from './sandbox.mjs';
import { runCell, INCOMPLETE, PASS, VOID } from './protocol.mjs';
import { probeClientCompletesRound } from './preflight.mjs';
import { startStubProcess } from './stub-anthropic.mjs';
import * as codexReader from './readers/codex.mjs';
import * as claudeReader from './readers/claude.mjs';

/**
 * 八格里我们**能**测的那些。
 * · claude / codex：各自的客户端。
 * · agents：`.agents` 没有自己的客户端，它是一条**共享约定路径**，读者是 codex ——
 *   所以用 codex reader 测，但报告里必须写清读的是谁的版本，别让它看起来像
 *   有个叫 agents 的客户端通过了。
 * · cursor：本机跑不起来（未认证 + IDE 没装），不在这里假装能测（R-8）。
 */
const CELLS = [
  { client: 'claude', dirName: '.claude', reader: claudeReader, readerClient: 'claude' },
  { client: 'codex', dirName: '.codex', reader: codexReader, readerClient: 'codex' },
  { client: 'agents', dirName: '.agents', reader: codexReader, readerClient: 'codex',
    note: '.agents 没有自己的客户端，读者是 codex —— 这里记的版本号是**读者**的' },
];
const SCOPES = ['global', 'project'];

function flag(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (process.argv[i + 1] ?? true);
}

const onlyClient = flag('client');
const onlyScope = flag('scope');
const jsonOut = flag('json');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(new URL(import.meta.url).pathname);
  console.log('  --client <claude|codex|agents>  只跑一端');
  console.log('  --scope  <global|project>       只跑一个 scope');
  console.log('  --json   <file>                 报告落盘');
  process.exit(0);
}

const results = [];
const realBefore = fingerprintRealHome();

for (const cell of CELLS) {
  if (onlyClient && cell.client !== onlyClient) continue;
  const clientVersion = cell.reader.version();
  if (!clientVersion) {
    results.push({
      client: cell.client, scope: '*', verdict: 'SKIPPED',
      why: `本机跑不起读者（${cell.readerClient}） —— 没有运行时读数。` +
        '🔴 这不是「通过」也不是「不支持」，是缺证据',
    });
    continue;
  }

  for (const scope of SCOPES) {
    if (onlyScope && scope !== onlyScope) continue;

    const sb = makeSandbox({ label: `q12-${cell.client}-${scope}` });
    let stub = null;
    try {
      sb.initGitRepo();
      const target = scope === 'global'
        ? join(sb.home, cell.dirName, 'skills')
        : join(sb.project, cell.dirName, 'skills');
      mkdirSync(target, { recursive: true });

      let env = { ...sb.env };
      let bodyLogPath = null;

      if (cell.reader.prepareHome) cell.reader.prepareHome({ home: sb.home, project: sb.project });

      if (cell.readerClient === 'claude') {
        bodyLogPath = join(sb.root, 'request-bodies.jsonl');
        // 🔴 **独立进程**。stub 与测量代码同进程会被 spawnSync 阻塞事件循环，
        //    客户端发得出请求却永远等不到回复 —— 见 stub-anthropic.mjs 文件头。
        stub = await startStubProcess(bodyLogPath);
        env = {
          ...env,
          ANTHROPIC_BASE_URL: stub.url,
          // 🔴 一个**明显是假的**串。真凭据一律不进沙箱；stub 也只记录请求头的
          //    名字、不记录它们的值，所以就算客户端把它发出去也不会落盘。
          ANTHROPIC_API_KEY: 'q12-stub-not-a-real-key',
        };
      }

      const measure = () => cell.reader.read({ env, cwd: sb.project, bodyLogPath });

      // 🔴 先自检：这台机器上这个客户端能不能跑完一轮。
      //    结构与真实测量**完全一致**（同一个 measure 闭包、同一个独立进程 stub）——
      //    结构不同的探针测的不是同一件事，反而会给出误导性的「证实」。
      //    不通就**立刻报具体现象**，绝不接着跑四步然后交一堆退出码让人去猜。
      const pf = probeClientCompletesRound({
        label: `${cell.client}/${scope}`,
        run: measure,
        expectRequest: cell.readerClient === 'claude',
      });
      if (!pf.ok) {
        results.push({
          client: cell.client, scope, readerClient: cell.readerClient, clientVersion,
          verdict: 'PREFLIGHT-FAILED',
          why: pf.reason,
          preflight: pf.detail,
        });
        process.stderr.write(`${cell.client}/${scope}: PREFLIGHT-FAILED\n${pf.reason}\n`);
        continue;
      }

      const r = runCell({ target, measure });

      results.push({
        client: cell.client, scope, target: target.replace(sb.root, '<sandbox>'),
        readerClient: cell.readerClient, clientVersion,
        note: cell.note, ...r,
      });
      process.stderr.write(`${cell.client}/${scope}: ${r.verdict}\n`);
    } finally {
      if (stub) await stub.close();
      sb.cleanup();
    }
  }
}

// 🔴 最后一道闸。硬判据（搜到我们的夹具）会直接抛；软判据只回警告
//    —— 别的会话在写自己的目录，那不是我们漏了，见 sandbox.mjs 里的说明。
const { warnings: homeWarnings } = assertRealHomeUntouched(realBefore);
for (const w of homeWarnings) process.stderr.write(`⚠️  ${w}\n`);

const report = {
  ranAt: new Date().toISOString(),
  host: { platform: process.platform, node: process.version },
  // 🔴 措辞照实：证到的是「我们已知会写的那些名字（q12-* 与 .geoly/）
  //    没有出现在真实用户目录里」，不是「我们一个字节都没写」。
  ourArtifactsNotInRealHome: true,
  realHomeWarnings: homeWarnings,
  // 🔴 八格里这里最多覆盖六格。cursor 两格没有运行时证据（R-8），
  //    不出现在结果里 ≠ 通过。
  coverageNote:
    'Q12 的验收单位是四端 × 两 scope = 八格。本驱动能跑的最多六格' +
    '（claude ×2、codex ×2、agents ×2，其中 agents 的读者是 codex）。' +
    'cursor 两格本机没有运行时证据，**不在本报告里**，缺席不等于通过',
  results,
};

const text = JSON.stringify(report, null, 2);
if (typeof jsonOut === 'string') {
  writeFileSync(jsonOut, text + '\n');
  process.stderr.write(`报告写到 ${jsonOut}\n`);
} else {
  console.log(text);
}

// ── 退出码 ────────────────────────────────────────────────────────────────
// 🔴 「一格都没跑成」必须是失败，不能是成功。
//    过滤条件写错、客户端没装、参数拼错，都会让循环一格不跑 ——
//    而一个「零格通过」的 0 退出码，在 CI 里与「全绿」长得一模一样。
const ran = results.filter((r) => r.verdict !== 'SKIPPED' && r.verdict !== 'PREFLIGHT-FAILED');
if (ran.length === 0) {
  process.stderr.write(
    '\n❌ 一格都没有真的跑起来（客户端没装？--client/--scope 过滤把格子全滤掉了？）。\n' +
      '   零格通过不是通过。\n',
  );
  process.exit(1);
}

// 任何一格 VOID / FAIL / PASS-INCOMPLETE 都不算过。
// · VOID：测量本身不敏感 —— 那正是上一轮栽的跟头。
// · PASS-INCOMPLETE：查了的都过了，但**该查的没查全**。
const bad = results.filter((r) => r.verdict !== PASS && r.verdict !== 'SKIPPED');
if (bad.length > 0) {
  process.stderr.write(
    `\n❌ ${bad.length} 格未通过：\n` +
      bad.map((r) => `  ${r.client}/${r.scope} → ${r.verdict}：${r.why}`).join('\n') + '\n' +
      (bad.some((r) => r.verdict === VOID)
        ? '\n🔴 VOID = 测量本身不敏感。它**不是**负结果，据此判通过就是上一轮栽过的那个跟头。\n'
        : '') +
      (bad.some((r) => r.verdict === INCOMPLETE)
        ? '\n🔴 PASS-INCOMPLETE = 查了的都过了，但**该查的没查全**。\n' +
          '   要翻成 PASS，得在客户端能真的跑完一轮（拿到退出码 0、拿到真实请求体）的环境里重跑。\n'
        : ''),
  );
  process.exit(1);
}
process.stderr.write(`\n✅ ${results.filter((r) => r.verdict === PASS).length} 格通过\n`);
