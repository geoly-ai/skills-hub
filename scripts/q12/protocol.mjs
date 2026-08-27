// Q12 的四步测量协议（docs/m1/00-gates.md「测法：读数、正对照、判据」）。
//
// | 步 | 动作 | 期望 |
// |----|------|------|
// | S0 | target 为空 | 读数 N0 |
// | S1 | 放一个**有效且唯一**的 skill（深度 1） | N1 = N0+1，该名恰好出现 1 次 |
// | S2 | 再放一个**同深度**的 skill（probe3/tx-1/stage/<n>） | N2 —— 扫描够不够深 |
// | S3 | 放入**完整** .geoly fixture | N3 = N2、canary 命中 0、逐名一致、退出码/stderr 与基线相同 |
//
// 🔴 **S1 读数不动 ⇒ VOID-MEASUREMENT-INSENSITIVE，不判通过。**
//    这是上一轮栽跟头的地方：一个不动的读数被当成了「没影响」。
//    没有正对照的负结果没有意义 —— 所以判定写进代码，不靠人记得去看。
import { mkdirSync, rmSync } from 'node:fs';
import { writeDepth1Probe, writeGeolyFixture, writeSameDepthProbe } from './fixture.mjs';

export const PASS = 'PASS';
/**
 * 🔴 测量本身有效、`.geoly` 也没被收进去，但 Q12 原文要求的判据**没有全部证到**。
 *    典型情形：基线退出码不是 0，或者根本没拿到请求体这件产物。
 *    ⚠️ 碰到这种情况**先看 preflight 报的现象再归因** ——
 *       退出码 143 是 128+15，通常意味着**它是被信号杀的**，不是自己崩的。
 *
 *    这**不是** PASS。把它并进 PASS 是这个项目反复栽的那个跟头的另一种形态：
 *    「我们查了的那几项都过了」被写成「这一格过了」。
 */
export const INCOMPLETE = 'PASS-INCOMPLETE';
export const VOID = 'VOID-MEASUREMENT-INSENSITIVE';
export const FAIL = 'FAIL';

/** canary 名在一段文本里出现几次（定点计数，不用正则以免名字里的字符被当元字符）。 */
function hits(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * 跑完一格。
 *
 * @param {object} a
 * @param {string} a.target        被测的 skills 目录
 * @param {() => object} a.measure 一次读数：返回 reader 的 {names,count,exitCode,stderr,haystack,requestBodies}
 */
export function runCell({ target, measure }) {
  const steps = {};

  // ── S0：target 存在且为空 ──────────────────────────────────────────────
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const s0 = measure();
  steps.S0 = summarize(s0);

  // ── S1：深度 1 正对照 ─────────────────────────────────────────────────
  const p1 = writeDepth1Probe(target);
  const s1 = measure();
  const p1Hits = countName(s1, p1);
  steps.S1 = { ...summarize(s1), probe: p1, probeHits: p1Hits };

  // 🔴 敏感性判定。两条都要：读数要动，且那个名字**恰好**出现一次。
  //    只看条数会被「刚好少了一个别的 skill」这种巧合骗过去。
  const sensitive = s1.count === s0.count + 1 && p1Hits.inNames === 1;
  if (!sensitive) {
    return {
      verdict: VOID,
      why:
        `S1 正对照无效：S0=${s0.count} → S1=${s1.count}（期望 ${s0.count + 1}），` +
        `canary 名在读数里出现 ${p1Hits.inNames} 次（期望恰好 1）。` +
        '测量本身不敏感 —— 这一格的任何负结果都不成立，不得据此判通过',
      steps,
    };
  }

  // ── S2：同深度正对照 ──────────────────────────────────────────────────
  const p3 = writeSameDepthProbe(target);
  const s2 = measure();
  const recursive = s2.count > s1.count;
  steps.S2 = { ...summarize(s2), probe: p3, probeHits: countName(s2, p3), recursive };

  // ── S3：完整 .geoly ───────────────────────────────────────────────────
  const { canaries } = writeGeolyFixture(target);
  const s3 = measure();
  steps.S3 = summarize(s3);

  const catalogHits = {};
  for (const c of canaries) catalogHits[c] = countName(s3, c);

  // 请求体：**有没有这件产物**与「查了是 0」是两回事，分开记。
  let requestBodyEvidence;
  if (s3.requestBodies === null) {
    requestBodyEvidence = {
      status: 'not-applicable',
      note: '这一端是离线渲染，根本不产生请求体 —— catalog 就是模型看到的内容，不存在第二件产物',
    };
  } else if (s3.requestBodies.length === 0) {
    requestBodyEvidence = {
      status: 'absent',
      note:
        '🔴 一个请求都没到达 stub —— 这是**没有这件证据**，不是「查过命中 0」。' +
        '不得把它当成第二个独立判据。' +
        '⚠️ 不要顺手把它归因成「网络不通」：最常见的原因是 stub 与测量代码跑在同一个进程里，' +
        '被 spawnSync 阻塞了事件循环（客户端发得出请求，但没人去读）。见 stub-anthropic.mjs 文件头',
    };
  } else {
    const joined = s3.requestBodies.join('\n');
    const perCanary = {};
    for (const c of canaries) perCanary[c] = hits(joined, c);
    requestBodyEvidence = {
      status: 'collected',
      requests: s3.requestBodies.length,
      bytes: joined.length,
      hits: perCanary,
    };
  }

  const problems = [];
  if (s3.count !== s2.count) {
    problems.push(`S3 读数 ${s3.count} ≠ S2 读数 ${s2.count}：.geoly 改变了 skill 数`);
  }
  if (JSON.stringify(s3.names) !== JSON.stringify(s2.names)) {
    problems.push('S3 与 S2 的条目**逐名**不一致（只比个数会漏掉「换了一个」这种情况）');
  }
  for (const [c, h] of Object.entries(catalogHits)) {
    if (h.inNames !== 0) {
      problems.push(`.geoly 里的 canary ${c} 出现在 skill 清单里 ${h.inNames} 次 —— 它被当成 skill 收了`);
    }
    if (h.inHaystack !== 0) {
      problems.push(`.geoly 里的 canary ${c} 出现在模型可见内容里 ${h.inHaystack} 次`);
    }
  }
  if (requestBodyEvidence.status === 'collected') {
    for (const [c, n] of Object.entries(requestBodyEvidence.hits)) {
      if (n !== 0) problems.push(`canary ${c} 出现在**真实发往模型的请求体**里 ${n} 次`);
    }
  }
  if (s3.exitCode !== s0.exitCode) {
    problems.push(`退出码从基线的 ${s0.exitCode} 变成 ${s3.exitCode}`);
  }
  // 🔴 判据是「与基线相同」，不是「等于 0」—— 加了 .geoly 之后有没有变坏，
  //    要拿同一台机器上的基线来比。但基线本身不为 0 这件事必须**显式说出来**：
  //    Q12 原文要求的是「不报错」，而一个稳定的非零退出码只能证明「没变得更糟」。
  const exitNote = s0.exitCode === 0
    ? null
    : `⚠️ 基线退出码本身就是 ${s0.exitCode}（不是 0）。S3 与基线一致，` +
      '所以「.geoly 没有让它变坏」成立；但 Q12 原文要的「不报错」在这台机器上**没有**被证到。' +
      '⚠️ 归因之前先看 preflight 的结论：一个 143 很可能是 128+15，也就是**我们自己的超时把它 SIGTERM 了**，' +
      '不是客户端崩了。';
  if (s3.stderr !== s0.stderr) {
    problems.push('stderr 与基线不再逐字节相同');
  }

  // 🔴 「查了的都过了」与「该查的都查了」是两件事。
  //    gaps 收的是**没能证到**的判据 —— 有 gap 就不是 PASS。
  const gaps = [];
  if (s0.exitCode !== 0) {
    gaps.push(
      `基线退出码是 ${s0.exitCode} 而不是 0 —— Q12 原文要求的「不报错」在这台机器上没有证到` +
        '（S3 与基线一致只证明 .geoly 没让它变坏）',
    );
  }
  if (requestBodyEvidence.status === 'absent') {
    gaps.push(
      '一个请求都没到达 stub —— 「canary 有没有混进真实发往模型的请求体」这件证据**不存在**，' +
        '不是查过是 0',
    );
  }

  return {
    verdict: problems.length > 0 ? FAIL : (gaps.length > 0 ? INCOMPLETE : PASS),
    gaps,
    why: problems.length > 0
      ? problems.join('；')
      : '正对照有效（S1 动了、canary 名恰好 1 次）；加入完整 .geoly 后读数与条目名不变、canary 未被收录'
        + (gaps.length > 0 ? `。⚠️ 但以下判据**没有证到**：${gaps.join('；')}` : ''),
    // 🔴 覆盖边界照实写，别让它被读成无条件通过。
    coverage:
      '〔加载 + 路由输入〕—— 证到的是：① .geoly 不被当作 skill 加载；' +
      '② 不报错（退出码 + stderr 与基线一致）；③ 其余 skill 逐名不变、canary 从未进入模型可见清单。' +
      '**没有**真的调用一个 skill 去看它路由到哪 —— 路由**行为**本身未做端到端验证',
    protection: recursive
      ? '扫描**是递归**的（同深度正对照动了）⇒ 挡住 .geoly 的只能是**点目录过滤**'
      : '扫描**不递归**（同深度正对照纹丝不动）⇒ 挡住 .geoly 的是**深度**，与点目录无关。'
        + '⚠️ 这一端不过滤点目录：`.geoly/` 顶层一旦出现 SKILL.md 就会被当成一个 skill 加载（R-7）',
    exitNote,
    canaries,
    catalogHits,
    requestBodyEvidence,
    steps,
  };
}

function summarize(r) {
  return {
    count: r.count,
    names: r.names,
    exitCode: r.exitCode,
    stderrBytes: Buffer.byteLength(r.stderr ?? '', 'utf8'),
  };
}

/**
 * 名字要在**两处**各数一遍，因为它们回答的是两个不同的问题：
 *   · `names`   —— 「它被当成一个 skill 加载了吗」（Q12 的主判据）
 *   · `haystack`—— 「它有没有从别的缝漏进模型看得见的那份内容里」
 * 合成一个数会把两个问题搅在一起，正是 docs/m1/00-gates.md 反复警告的那种记账方式。
 */
function countName(r, name) {
  return {
    inNames: r.names.filter((n) => n === name).length,
    inHaystack: hits(r.haystack ?? '', name),
  };
}
