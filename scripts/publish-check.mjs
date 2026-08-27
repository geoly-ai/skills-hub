#!/usr/bin/env node
// 发布元数据门 —— 只在 release.yml 里跑，**不在 CI 里跑**。
//
// 为什么不在 CI 跑：这道门检的是「现在这份 package.json 能不能发」。
// 仓库长期处于 private: true 的开发态，放进 CI 会让主干长红，
// 长红的门几周之内就会被人加 continue-on-error —— 那才是真正危险的结果。
// 放在 release 路径上：**要发的时候必须先绿**。
//
// 形状参考 social-ops-hub 的 scripts/packages-publish-check.mjs，但多了三条本仓库特有的：
//   · files 必须含 src（否则 src/trust-roots/ 不进包，验签器没根可用 —— 见 check-pack-contents.mjs）
//   · dependencies 必须钉精确版本（docs/m1/01-residual-risks.md R-5：
//     浮动版本会静默破掉我们比依赖声明更低的 Node 下限）
//   · publishConfig.provenance 必须为 true（00-decisions.md D5）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/**
 * 🔴 包身份只在这**一处**写死。用户 2026-08-27 拍板：`@geoly-ai/skills-hub`
 *    （与 `@geoly-ai/social-hub-cli` 同一个 org；`@geoly` 那个 scope 作废）。
 *    记在 docs/m0/ERRATA.md E-7。
 *
 * ⚠️ 这里连**完整包名**一起校验，不只校验 scope 前缀：
 *    首次发布前改名是免费的，**发布后就只能 deprecate** —— 旧名会永远留在 registry 上。
 *    所以「名字对不对」这道门必须在第一次 publish 之前就能拦住。
 */
const EXPECTED_NAME = process.env.SKILLS_HUB_NPM_NAME ?? '@geoly-ai/skills-hub';
const EXPECTED_SCOPE = EXPECTED_NAME.split('/')[0];

/** bin 映射的命令名 —— 换 scope **不**改命令名。 */
const EXPECTED_BIN = 'skills-hub';

/** files 里必须出现的顶层条目。 */
const REQUIRED_FILES_ENTRIES = ['bin', 'src'];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const errors = [];

if (pkg.name !== EXPECTED_NAME) {
  errors.push(
    `name 必须恰好是 ${EXPECTED_NAME}，得到 ${JSON.stringify(pkg.name)}` +
      '（要换名就改 SKILLS_HUB_NPM_NAME 这一个常量，别在多处硬写；' +
      '发布之后改名只能靠 deprecate，旧名永远留在 registry 上）',
  );
}
void EXPECTED_SCOPE;

// 换 scope 不该顺手把命令名也改了 —— 用户装完之后敲的是这个词。
const binNames = typeof pkg.bin === 'string' ? [EXPECTED_BIN] : Object.keys(pkg.bin ?? {});
if (binNames.length !== 1 || binNames[0] !== EXPECTED_BIN) {
  errors.push(`bin 必须恰好映射一个命令 ${EXPECTED_BIN}，得到 ${JSON.stringify(pkg.bin)}`);
}

if (pkg.private) {
  errors.push(
    'package.json 里 private 为真：npm publish 会直接拒绝。' +
      '要发布就删掉这个字段（这是一个需要人拍板的动作，不是脚本该自己做的）',
  );
}

if (pkg.publishConfig?.access !== 'public') {
  errors.push('publishConfig.access 必须是 "public"（scoped 包默认是 restricted）');
}

// D5：Sigstore keyless + npm provenance。写进 publishConfig 之后，
// 即使有人手跑 `npm publish` 漏了 --provenance，也仍然会带上。
if (pkg.publishConfig?.provenance !== true) {
  errors.push(
    'publishConfig.provenance 必须是 true（00-decisions.md D5）：' +
      '只靠命令行 --provenance 的话，任何一次手动发布漏了这个参数都会静默丢掉 provenance',
  );
}

if (!Array.isArray(pkg.files)) {
  errors.push('files 必须是数组');
} else {
  for (const need of REQUIRED_FILES_ENTRIES) {
    if (!pkg.files.includes(need)) {
      errors.push(
        `files 必须包含 ${JSON.stringify(need)}` +
          (need === 'src'
            ? '（src/trust-roots/ 是内置 TUF 根，不进包 = 验签器没根可用）'
            : ''),
      );
    }
  }
}

if (typeof pkg.version !== 'string' || /^0\.0\.0(-|$)/.test(pkg.version)) {
  errors.push(`version ${JSON.stringify(pkg.version)} 是占位版本，不能发布`);
}

// R-5：依赖钉精确版本。`^` / `~` / 范围一律拒。
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range)) {
      errors.push(
        `${field}.${dep} = ${JSON.stringify(range)} 不是精确版本：` +
          'R-5 要求钉死 —— 浮动版本可能悄悄用上 22.22 才有的 API，静默破掉我们的 Node 下限',
      );
    }
  }
}

if (!pkg.license) errors.push('缺 license 字段');
if (pkg.license && !existsSync(join(root, 'LICENSE'))) {
  errors.push(
    `package.json 声明 license: ${pkg.license}，但仓库根**没有 LICENSE 文件** —— ` +
      '声明不等于授权文本，发出去的包里也就没有许可证正文',
  );
}

if (!pkg.repository) {
  errors.push('缺 repository 字段：npm provenance 要靠它把包与源仓库对上');
}

if (!existsSync(join(root, 'package-lock.json'))) {
  errors.push('缺 package-lock.json（R-5 要求提交 lockfile）');
}

if (errors.length > 0) {
  console.error('publish-check 失败：\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log(`publish-check ok（${pkg.name}@${pkg.version}）`);
