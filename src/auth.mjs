// `publish` 的 token 存储与来源判定 —— 06-submission.md §9。
//
// §9 的四条：
//   · `login`：GitHub device flow，scope 只要 `public_repo`；
//   · 存储：**优先 OS keychain**；不可用时落 `~/.local/state/geoly-skills/auth.json`，
//     `0600`，父目录 `0700`；
//   · token 只在 `publish` / `logout` / `status` 三条命令里读；
//   · 🔴 CLI 以 `npx github:` 运行时，`login` / `publish` **拒绝执行**。
//
// ── 🔴 最后那一条挡的是什么 ─────────────────────────────────────────────
// `npx github:<owner>/<repo>` 从**一个 git ref** 装并直接跑，没有版本号、
// 没有 registry 的不可变性、也没有签名 —— ref 指向的内容随时可以被换掉。
// 让这种形态的进程拿到用户的 GitHub token，等于把「谁能改那个 ref」
// 变成「谁能拿到 token」。装 skill（只读）容忍这种形态，
// **发凭据不容忍**。
//
// ⚠️ 这是一条**尽力**的门，不是安全边界：能改 ref 的人也能改这段判定。
//    它挡的是「用户自己图省事用 npx github: 跑 publish」，
//    不是「攻击者已经控制了代码」——后者早就赢了。

import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';

export class AuthError extends Error {
  constructor(code, msg) { super(msg); this.name = 'AuthError'; this.code = code; }
}
const bad = (code, msg) => { throw new AuthError(code, msg); };

/** §9：`login` 只要这一个 scope。 */
export const REQUIRED_SCOPE = 'public_repo';

/**
 * 🔴 **`login` 时必须把权限面说清楚**（10-open-questions Q4 的落点）：
 *    `public_repo` 能改用户**所有**公开仓，远大于「给 skills-hub 投稿」所需。
 *    Q4 的收窄方案（GitHub App）没赶上 M3，按 Q4 自己写的兜底走：
 *    用 `public_repo` 上线，但**说清楚**，并列为已知残余风险。
 */
export const SCOPE_DISCLOSURE = `⚠️ 这次授权的 scope 是 \`${REQUIRED_SCOPE}\`。

它的权限面**大于**你要做的事：
  你要做的：往 geoly-ai/skills-hub 开一张投稿 PR。
  它实际能做的：读写你**所有**公开仓库。

之所以还是它：GitHub 的 device flow 没有更细的 scope 可选；
收窄方案（GitHub App，权限细到单仓）还没做完 —— 见 10-open-questions.md Q4。

不想给这个权限的话，**不用 \`login\`**：
fork + 手动开 PR 走的是同一条流水线，一模一样的门，只是要你自己点几下。`;

// ── 存放位置 ───────────────────────────────────────────────────────────────

/**
 * `~/.local/state/geoly-skills/auth.json`。
 * 🔴 认 `XDG_STATE_HOME`：用户把 state 挪到别处（加密卷、tmpfs）是常见做法，
 *    忽略它等于把凭据写回一个用户以为不会有凭据的地方。
 */
export function authFilePath({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith('/')
    ? env.XDG_STATE_HOME
    : join(home, '.local', 'state');
  return join(base, 'geoly-skills', 'auth.json');
}

/**
 * 落盘：文件 `0600`、父目录 `0700`（§9 明写）。
 *
 * 🔴 **先建目录并 chmod，再写文件**。反过来的话，文件在一个 `0755` 的目录里
 *    短暂存在过 —— 同机器上的其他用户在那个窗口内能读到它。
 * 🔴 **写之前先 chmod 到 0600**：`writeFileSync` 的 mode 参数只在**新建**时生效，
 *    文件已存在时它一声不吭地沿用旧权限。一个之前被 chmod 成 0644 的
 *    auth.json 会一直是 0644。
 */
export function writeTokenFile(token, { path = authFilePath(), now = () => new Date() } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);                       // 目录已存在时 mkdir 的 mode 不生效
  const body = `${JSON.stringify({
    schema: 'geoly.skills.auth/1',
    token,
    scope: REQUIRED_SCOPE,
    created_at: now().toISOString(),
  }, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);                      // 文件已存在时 writeFileSync 的 mode 不生效
  return path;
}

/** @returns {{token:string, scope:string, created_at:string}|null} */
export function readTokenFile({ path = authFilePath(), warn = null } = {}) {
  if (!existsSync(path)) return null;
  // 🔴 权限变宽了要**说出来**，但不要因此拒绝读 —— 用户此刻多半正在
  //    `logout`，而拒绝读会让他连撤销都做不了。
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600 && warn !== null) {
    warn(`⚠️ ${path} 的权限是 ${mode.toString(8)}，应为 600 —— 同机器上的其他用户可能读得到。`
      + '\n   建议 `geoly-skills logout` 之后重新 login。');
  }
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    bad('E_AUTH_CORRUPT', `${path} 读不出来：${e.message}\n  删掉它再 login。`);
  }
  if (doc === null || typeof doc !== 'object' || typeof doc.token !== 'string' || doc.token === '') {
    bad('E_AUTH_CORRUPT', `${path} 里没有 token —— 删掉它再 login。`);
  }
  return doc;
}

export function deleteTokenFile({ path = authFilePath() } = {}) {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// ── npx github: 判定 ───────────────────────────────────────────────────────

// npm ≥ 7 的 npx 把包装进 `~/.npm/_npx/<hash>/node_modules/<name>`，
// 并在 `~/.npm/_npx/<hash>/package.json` 里记下**用户当初写的那个 spec**。
// 那份 spec 才是判据 —— 装完之后的目录长得都一样。
const NPX_DIR = `${sep}_npx${sep}`;

/** 一个依赖 spec 是不是「从 git ref 装」。 */
export function isGitSpec(spec) {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  return /^(github|gitlab|bitbucket|gist):/i.test(s)
    || /^git(\+(ssh|https?|file))?:/i.test(s)
    || /^(https?:\/\/|git@)[^\s]*\.git($|#)/i.test(s)
    // `npx owner/repo` 这种裸写法 npm 也当 GitHub 处理
    || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s);
}

/**
 * 本进程是不是「`npx <git spec>` 跑起来的」。
 *
 * @param {string} moduleDir  本模块所在目录（生产上传 `import.meta.dirname`）
 * @returns {{isNpxGit:boolean, spec:string|null, manifest:string|null}}
 */
export function detectNpxGit(moduleDir) {
  const idx = moduleDir.indexOf(NPX_DIR);
  if (idx === -1) return { isNpxGit: false, spec: null, manifest: null };
  // `<...>/_npx/<hash>/` —— hash 那一层就是 npx 的临时安装根
  const rest = moduleDir.slice(idx + NPX_DIR.length);
  const hash = rest.split(sep)[0];
  if (!hash) return { isNpxGit: false, spec: null, manifest: null };
  const manifest = join(moduleDir.slice(0, idx), '_npx', hash, 'package.json');
  if (!existsSync(manifest)) return { isNpxGit: false, spec: null, manifest };
  let doc;
  try { doc = JSON.parse(readFileSync(manifest, 'utf8')); } catch {
    // 读不出来就**不**断言它是 git spec —— 这道门是尽力性质的，
    // 误拒一个正常的 `npx skills-hub` 比放过一个 `npx github:` 更常见。
    return { isNpxGit: false, spec: null, manifest };
  }
  for (const spec of Object.values(doc?.dependencies ?? {})) {
    if (isGitSpec(spec)) return { isNpxGit: true, spec, manifest };
  }
  return { isNpxGit: false, spec: null, manifest };
}

/**
 * §9 最后一条的断言形态。`login` / `publish` 开头就调它。
 * 退出码 7（认证），见 09-cli.md §6。
 */
export function assertNotNpxGit(moduleDir, command) {
  const d = detectNpxGit(moduleDir);
  if (!d.isNpxGit) return false;
  bad('E_NPX_GIT',
    `\`${command}\` 拒绝在 \`npx ${d.spec}\` 下运行（06-submission.md §9）。\n`
    + '  🔴 从一个 git ref 装并直接跑：没有版本号、没有 registry 的不可变性、\n'
    + '     也没有签名 —— ref 指向的内容随时可以被换掉。\n'
    + '  让这种形态的进程拿到你的 GitHub token，等于把「谁能改那个 ref」\n'
    + '  变成「谁能拿到你的 token」。装 skill（只读）容忍它，发凭据不容忍。\n'
    + `  改用装好的 CLI：\`npm i -g skills-hub && geoly-skills ${command}\`。`);
}
