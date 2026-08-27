#!/usr/bin/env node
// 用**我们自己的验签器**验我们自己刚签出来的 bundle。
//
// 🔴 这是签发侧唯一有意义的验收：签名工具说「签好了」证明不了任何事，
//    要证明的是「CLI 装用户机器上那份代码，能把这份 bundle 验过」。
//    所以这里走的就是 src/sigstore.mjs 的 createSigstoreVerifier() +
//    loadBuiltinTrustedRoot()，与安装链路同一条代码路径、同一份内置 TUF 根。
//
// 身份从 src/snapshot.mjs 导入，**不在这里重打一遍字符串** ——
// 02-registry.md §8 要求精确比对，而「两处各写一份常量」正是让它慢慢分叉的做法。
//
// 用法：
//   node scripts/release/verify-own-bundle.mjs --artifact <file> --bundle <file.sigstore.json> \
//        --identity release|timestamp [--expect-failure <ERRCODE>]
//
// `--expect-failure` 用于**交叉证伪**：拿另一个身份去验同一份 bundle，
// 要求它以**指定的错误码**失败。
// 🔴 只判「非零退出」是不够的 —— 文件不存在、JSON 解析炸了、网络挂了，
//    统统也是非零。那样的「证伪」在验签器整个坏掉的时候同样会「通过」。
import { readFileSync } from 'node:fs';
import { createSigstoreVerifier, loadBuiltinTrustedRoot } from '../../src/sigstore.mjs';
import { OIDC_ISSUER, RELEASE_IDENTITY, TIMESTAMP_IDENTITY } from '../../src/snapshot.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error(`缺参数 --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const artifactPath = arg('artifact');
const bundlePath = arg('bundle');
const which = arg('identity');

function optArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? null : process.argv[i + 1];
}
const expectFailure = optArg('expect-failure');

const IDENTITIES = { release: RELEASE_IDENTITY, timestamp: TIMESTAMP_IDENTITY };
const expectIdentity = IDENTITIES[which];
if (!expectIdentity) {
  console.error(`--identity 只能是 release 或 timestamp，得到 ${JSON.stringify(which)}`);
  process.exit(2);
}

const bytes = readFileSync(artifactPath);
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

const verify = createSigstoreVerifier({ trustedRoot: loadBuiltinTrustedRoot() });

let result;
try {
  result = verify({ bytes, bundle, expectIdentity, expectIssuer: OIDC_ISSUER });
} catch (e) {
  // 🔴 判据是 `violation`，不是 `code`。
  //    src/trust.mjs 里 `code` 是**退出码**（IntegrityError 一律是 2），
  //    真正区分「为什么失败」的是 `violation`（E_IDENTITY_MISMATCH 等）。
  //    拿 code 当判据的话，所有 IntegrityError 都长得一模一样 ——
  //    「身份不匹配」和「bundle 形态不对」会被当成同一件事。
  const code = e?.violation ?? e?.code ?? 'E_UNKNOWN';
  if (expectFailure) {
    if (code === expectFailure) {
      console.log(`✔ 按预期以 ${code} 失败：${e?.message ?? e}`);
      process.exit(0);
    }
    console.error(
      `✖ 失败了，但错误码是 ${code}，期望 ${expectFailure}。\n` +
        '这不算证伪成功 —— 换个理由失败说明我们没有测到想测的那件事。\n' +
        `原始信息：${e?.message ?? e}`,
    );
    process.exit(1);
  }
  console.error(`✖ 自验失败（${code}）：${e?.message ?? e}`);
  console.error(
    '\n⚠️ 这条失败不要当成「验签器有 bug」就绕过去。常见的真实原因：\n' +
      '  · 工作流不是从 refs/heads/main 触发的 —— keyless 证书的 SAN 会变成 @refs/tags/xxx，\n' +
      '    与 02-registry.md §8 钉死的身份不同，必然拒绝；\n' +
      '  · Rekor v2：条目变成 hashedRekordV002，被 assertTLogBodyShape() 拒\n' +
      '    （docs/m1/01-residual-risks.md R-6，这是已知的运维阻断点，要先改验签器，不是改签发）；\n' +
      '  · 签的字节与验的字节不是同一份（比如 npm publish 又重新打了一次包）。',
  );
  process.exit(1);
}

if (expectFailure) {
  console.error(
    `✖ 期望以 ${expectFailure} 失败，结果**验过了**（身份 ${result.identity}）。\n` +
      '🔴 两个身份没有真的分开，或者身份判定已经退化成恒真 —— 02-registry.md §8 被破坏。',
  );
  process.exit(1);
}

console.log('✔ 自验通过');
console.log(`  身份   ${result.identity}`);
console.log(`  issuer ${result.issuer}`);
console.log(`  摘要   ${result.sha256}`);
console.log(`  制品   ${artifactPath}`);
