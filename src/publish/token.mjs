// `publish` 的 token 来源解析 —— 06-submission.md §9 的**偏离版**
// （10-open-questions.md Q4，2026-09-05 用户拍板）。
//
// ── 🔴 这个模块的**唯一**产品承诺：CLI 不持有 token ──────────────────────
//
// 我们不注册 OAuth App / GitHub App，不做 device flow，不做 login / logout，
// **也不存任何东西**。token 只在一次 `publish` 的进程生命周期里存在于内存，
// 用完即随进程消失。`src/auth.mjs` 的 keychain 存储在这个模型下**不再被使用** ——
// 它没有被删掉（别的东西可能还引用它），但 publish 这条路径一个字节都不写。
//
// ⚠️ **不要把它描述成「token 权限很小」。** 恰恰相反：用户已有的 token
//    很可能是 classic `repo` PAT，权限面比 `public_repo` 还大，而**我们无法收窄它**。
//    「CLI 不持有」与「权限很小」是两件完全不同的事，只有前者是我们能保证的。
//    权限面必须在任何写操作之前如实披露 —— 那是 `commands/publish.mjs` 的事。
//
// ── 🔴 token 的六条禁令（每一条都有测试） ────────────────────────────────
//   ① 不落盘        ② 不进 argv        ③ 不进子进程环境
//   ④ 不进日志       ⑤ 不进错误文案      ⑥ 不进 telemetry
// 前三条靠**控制流**保证（本模块从不 write、从不把 token 放进 args/env）；
// 后三条靠 `scrub()` 兜底 —— 它是最后一道，不是第一道。

import { spawnSync as nodeSpawnSync } from 'node:child_process';

/**
 * 来源顺序。**顺序本身是判据的一部分**，不是实现细节：
 * 用户看到的身份必须与实际投稿身份一致，所以「用了哪一个」要能说得出来。
 *
 * ⚠️ `GITHUB_TOKEN` 在 GitHub Actions 里**会自动存在**（每个 job 都注入）。
 *    它排在最后，但仍然排在 `gh` 前面 —— 于是在 CI 里，一个以为自己在用
 *    `gh` 身份的用户实际会用上 Actions 的 job token。这不是可以静默处理的事：
 *    披露里必须把「用的是哪一个变量」写在脸上（见 `describeSource`）。
 */
export const TOKEN_ENV_ORDER = Object.freeze([
  'GEOLY_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
]);

/**
 * 跑 `gh` 之前要从继承环境里**删掉**的变量。
 *
 * 🔴 `GH_HOST` 必须删 + 显式覆盖成 `github.com`：留着继承值的话，
 *    一个配了 GHE 的用户会拿到**另一台主机**的 token，而我们接下来把它发去
 *    `api.github.com` —— 那是一次真正的凭据泄漏，不是配置错误。
 * 🔴 token 类变量也要删：`gh auth token` 在 `GH_TOKEN` 存在时会**原样回显它**。
 *    我们只有在三个变量都不存在时才走到这里，所以这一条在今天是冗余的 ——
 *    留着是因为它防的是「将来有人改了上面的顺序」，而那种改动不会让任何测试变红。
 */
const GH_ENV_STRIP = Object.freeze([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST', 'GH_REPO',
]);

export class TokenError extends Error {
  /** 认证/权限类一律 EXIT.AUTH(7) —— 见 09-cli.md §6。 */
  constructor(message) { super(message); this.name = 'TokenError'; this.exitCode = 7; }
}

/**
 * token 的形状门。**不是**在验证它有效（那要出网），是在拒绝明显不是 token 的东西。
 *
 * 🔴 存在的理由很具体：`gh auth token` 失败时也可能往 stdout 写东西，
 *    多行输出 / 带空白的输出被当成 token 塞进 `Authorization` header，
 *    会造成一次**带着垃圾内容的请求**，而且那段垃圾可能被服务端记进日志。
 *    宁可在这里失败。
 */
export function assertTokenShape(raw, where) {
  if (typeof raw !== 'string') throw new TokenError(`${where} 给出的不是字符串`);
  // 🔴 这里**不能**把值放进错误文案 —— 哪怕它"看起来不像 token"。
  if (raw.length < 8 || raw.length > 512) {
    throw new TokenError(`${where} 给出的 token 长度不合理（应在 8–512 之间）—— 已忽略，不予使用。`);
  }
  if (!/^[\x21-\x7e]+$/.test(raw)) {
    throw new TokenError(
      `${where} 给出的 token 含空白或不可见字符 —— 拒绝使用。\n`
      + '  🔴 常见成因：把整段命令输出（含换行/提示语）塞进了环境变量。',
    );
  }
  return raw;
}

/**
 * 遮蔽器 —— **最后一道，不是第一道**。
 *
 * 🔴 两条规则缺一不可：
 *   ① 替换掉**这次实际用的** token 原文（最准，但只覆盖我们知道的那一个）；
 *   ② 按**形态**替换任何看起来像 GitHub 凭据的串 —— 覆盖「响应体里回显了另一个
 *      token」「用户把 token 写进了 PR body」这类我们不知道的情况。
 * 只做 ① 的话，一次 `422` 响应体里回显的**别的**凭据会被原样打出来。
 *
 * ⚠️ **诚实边界**：`②` 认的是今天 GitHub 在用的前缀（`ghp_`/`gho_`/`ghu_`/`ghs_`/
 *    `ghr_`/`github_pat_`）。老式的 40 位 hex PAT **不在其中** —— 那个形态与
 *    commit sha 完全一样，按形态替换会把每一个 sha 都打成 `***`，而 sha 正是
 *    本命令要给用户看的关键事实。老式 PAT 只由 ① 兜住。
 */
export function scrub(text, token = null) {
  let s = String(text);
  if (typeof token === 'string' && token.length >= 8) {
    s = s.split(token).join('***');
  }
  return s
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '***');
}

/**
 * 环境变量这一层。返回**存在**的那些（trim 后非空才算存在）。
 * 🔴 空串视为"不存在"而不是"存在但为空"：CI 里把一个变量置空是常见的
 *    "关掉它"写法，把它当成一个候选会让后面的冲突检测报出无意义的红。
 */
export function collectEnvTokens(env) {
  const found = [];
  for (const name of TOKEN_ENV_ORDER) {
    const raw = env?.[name];
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (v === '') continue;
    found.push({ name, value: v });
  }
  return found;
}

/**
 * 🔴 多个来源同时存在**且值不同** → 直接拒，不静默挑一个。
 *
 * 为什么不"按顺序挑第一个就好"：用户看到的身份与实际投稿身份必须一致。
 * 一台机器上同时有 `GH_TOKEN`（个人账号）与 `GITHUB_TOKEN`（CI job token）
 * 是**常态**，两者是不同的身份 —— 静默挑一个的话，投稿会以他没预期的身份提交，
 * 而他要到 PR 页面上才看得出来。
 *
 * ⚠️ 值**相同**时不拒：那只是同一个 token 被写进了多个变量，身份没有歧义。
 *    但披露里仍然要把其余变量名列出来（`others`）。
 *
 * 🔴 错误文案里**只有变量名**。不列值、不列长度、不列前缀 ——
 *    长度和前缀足以区分 classic PAT / fine-grained / Actions token，
 *    那已经是在泄漏「这台机器上有什么凭据」了。
 */
export function resolveEnvToken(env) {
  const found = collectEnvTokens(env);
  if (found.length === 0) return null;
  const distinct = new Set(found.map((f) => f.value));
  if (distinct.size > 1) {
    throw new TokenError(
      `检测到多个 GitHub token 环境变量，且它们的值**不同**：${found.map((f) => f.name).join('、')}。\n`
      + '  🔴 拒绝替你挑一个 —— 它们是不同的身份，挑错了你会以没预期的账号投稿，\n'
      + '     而要到 PR 页面上才看得出来。\n'
      + `  ⚠️ 如果你在 GitHub Actions 里：\`GITHUB_TOKEN\` 是 runner 自动注入的 job token，\n`
      + '     它多半不是你想用的那个身份。\n'
      + '  怎么办：只留一个，或显式设 `GEOLY_GITHUB_TOKEN` 指定你要用的那一个\n'
      + '  （它的优先级最高，但**值不同时本命令仍然拒绝** —— 请把其余的 unset）。',
    );
  }
  const chosen = found[0];
  assertTokenShape(chosen.value, `环境变量 ${chosen.name}`);
  return {
    token: chosen.value,
    source: `env:${chosen.name}`,
    sourceLabel: `环境变量 ${chosen.name}`,
    others: found.slice(1).map((f) => f.name),
  };
}

/**
 * `gh auth token` 这一层。
 *
 * 🔴 `shell: false`（`spawnSync` 的默认，这里显式写出来）：绝不经过 shell。
 * 🔴 `--hostname github.com` 固定，并且**同时**把继承来的 `GH_HOST` 删掉再显式设回
 *    —— 两条都要：`--hostname` 决定它去哪个 host 取凭据，删 `GH_HOST` 防的是
 *    将来有人去掉那个参数时静默退回继承值。
 * 🔴 **stdout / stderr 一律不原样输出。** gh 的输出里可能带 token
 *    （`gh auth token` 的正常输出**就是** token），把它拼进错误文案是最容易犯的错。
 *    这里按 exit code 分档给固定文案。
 */
export function resolveGhToken(env, spawnSync = nodeSpawnSync) {
  const childEnv = { ...env };
  for (const k of GH_ENV_STRIP) delete childEnv[k];
  childEnv.GH_HOST = 'github.com';
  // 🔴 `GH_PROMPT_DISABLED` / `NO_COLOR`：不让它试图交互，也不要 ANSI 转义进 stdout。
  childEnv.GH_PROMPT_DISABLED = '1';
  childEnv.NO_COLOR = '1';

  let r;
  try {
    r = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      shell: false,
      encoding: 'utf8',
      env: childEnv,
      timeout: 15000,
      // 🔴 很小的 maxBuffer：`gh auth token` 的正常输出是**一行**。
      //    留一个大缓冲区，等于愿意把一大坨我们不打算读的东西收进内存。
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    // spawn 本身抛（极少见）——**不带 e.message**，它可能含路径等环境信息。
    throw new TokenError(`调用 \`gh\` 失败（${e?.code ?? 'spawn 错误'}）。${GH_HINT}`);
  }
  if (r.error) {
    const code = r.error.code;
    if (code === 'ENOENT') {
      throw new TokenError(`找不到 \`gh\`（GitHub CLI 未安装或不在 PATH 上）。${GH_HINT}`);
    }
    throw new TokenError(`调用 \`gh\` 失败（${code ?? 'spawn 错误'}）。${GH_HINT}`);
  }
  // 🔴 超时被 kill 时 `status` 是 null、`signal` 有值 —— 单看 exit code 会漏。
  if (r.signal !== null && r.signal !== undefined) {
    throw new TokenError(`\`gh auth token\` 被信号 ${r.signal} 中止（多半是 15 秒超时）。${GH_HINT}`);
  }
  if (r.status !== 0) {
    // 🔴 **不透传 gh 的 stderr。** gh 未登录时 exit 1、stderr 是人类文案，
    //    看着无害 —— 但「看着无害」不是判据：没有任何机制保证它下一个版本不会
    //    把 token 打进 stderr（比如某个 debug 开关从环境里被继承进去）。
    //    ⚠️ 也**不靠 exit code 分辨"没装"与"没登录"** —— 它分辨不了。
    //    「没装」由上面的 `ENOENT` 分支认（那个判据是可靠的）；
    //    到这里就统一给"两条出路"的固定文案。
    throw new TokenError(
      `\`gh auth token --hostname github.com\` 以 exit ${r.status} 失败`
      + '（最常见的原因是**没有登录 github.com**）。' + GH_HINT,
    );
  }
  const out = typeof r.stdout === 'string' ? r.stdout.trim() : '';
  if (out === '') throw new TokenError(`\`gh auth token\` 没有输出任何 token。${GH_HINT}`);
  assertTokenShape(out, '`gh auth token`');
  return { token: out, source: 'gh', sourceLabel: '`gh auth token`（GitHub CLI 的已登录身份）', others: [] };
}

const GH_HINT =
  '\n  怎么办（二选一）：\n'
  + '    · `gh auth login --hostname github.com`（推荐：本命令不持有、也不存储任何 token）\n'
  + '    · 或设 `GEOLY_GITHUB_TOKEN=<你的 token>` 后重跑\n'
  + '  🔴 本命令**不做** login，也**不会**把 token 存到任何地方 —— 撤销请去\n'
  + '     GitHub 的 Settings → Developer settings，或 `gh auth logout`。';

/**
 * 完整的来源解析：环境变量 → `gh`。
 *
 * @param {object} a
 * @param {Record<string,string>} a.env
 * @param {function} [a.spawnSync]  注入点（测试用）。生产走 node:child_process。
 * @returns {{token:string, source:string, sourceLabel:string, others:string[]}}
 */
export function resolveToken({ env, spawnSync = nodeSpawnSync }) {
  const fromEnv = resolveEnvToken(env);
  if (fromEnv !== null) return fromEnv;
  return resolveGhToken(env, spawnSync);
}
