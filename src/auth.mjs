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
export function writeTokenFile(token, {
  path = authFilePath(), now = () => new Date(), warn = null,
} = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 🔴 目录已存在时 mkdir 的 mode 不生效，所以要显式 chmod。
  //    ⚠️ 但**不能因为 chmod 失败就不存 token**：目录可能不归我们所有
  //    （用户把路径指到了一个共享目录），那时 chmod 抛 EPERM。
  //    文件本身的 0600 才是保护内容的那一道 —— 目录权限管的是能不能列目录。
  //    所以这里降级成告警。
  try {
    chmodSync(dir, 0o700);
  } catch (e) {
    if (warn !== null) {
      warn(`⚠️ 收紧 ${dir} 的权限失败（${e.code}）—— 它可能不归你所有。\n`
        + '   token 文件本身仍然是 0600，别人读不到内容，但能看到这个文件存在。');
    }
  }
  const body = `${JSON.stringify({
    schema: 'geoly.skills.auth/1',
    token,
    scope: REQUIRED_SCOPE,
    created_at: now().toISOString(),
  }, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  // 🔴 文件已存在时 writeFileSync 的 mode 不生效 —— 这一处**不降级**：
  //    收紧不了文件权限就等于把明文 token 摊开，宁可失败。
  chmodSync(path, 0o600);
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

// ── OS keychain（§9：**优先** keychain，不可用才落文件）────────────────────

/**
 * 每个平台的 keychain 命令。
 *
 * 🔴 **token 一律走 stdin，不进 argv。** 进程的命令行参数在同机器上是可见的
 *    （Linux 的 `/proc/<pid>/cmdline` 全用户可读；macOS 上同用户可见），
 *    把 token 写进 argv 等于让它出现在任何一次 `ps` 里，
 *    还会进 shell 历史。这是「用 keychain 存」这件事的第一个前提 ——
 *    存得再安全，取的路上漏了也白搭。
 *
 * ⚠️ macOS 的 `security add-generic-password` **没有**从 stdin 读密码的选项，
 *    只有 `-w <value>`。所以那一条只能走 argv —— 这是平台限制，不是选择。
 *    缓解：macOS 上非 root 用户看不到**别的用户**的进程参数；
 *    同用户的进程本来就能直接读 keychain。**如实记在这里，不假装没有。**
 */
const KEYCHAIN = {
  darwin: {
    // -U：已存在就更新，否则 add 会以 45 号错误失败
    set: (service, account, token) =>
      ({ cmd: 'security', args: ['add-generic-password', '-U', '-s', service, '-a', account, '-w', token] }),
    get: (service, account) =>
      ({ cmd: 'security', args: ['find-generic-password', '-s', service, '-a', account, '-w'] }),
    del: (service, account) =>
      ({ cmd: 'security', args: ['delete-generic-password', '-s', service, '-a', account] }),
  },
  linux: {
    // secret-tool 从 stdin 读值 —— token 不进 argv
    set: (service, account) =>
      ({ cmd: 'secret-tool', args: ['store', '--label', service, 'service', service, 'account', account], stdin: true }),
    get: (service, account) =>
      ({ cmd: 'secret-tool', args: ['lookup', 'service', service, 'account', account] }),
    del: (service, account) =>
      ({ cmd: 'secret-tool', args: ['clear', 'service', service, 'account', account] }),
  },
};

export const KEYCHAIN_SERVICE = 'geoly-skills';
export const KEYCHAIN_ACCOUNT = 'github-token';

/**
 * 统一的存取。**keychain 优先，失败就落文件** —— 两条路都要能用：
 * CI、容器、没有 keyring 的服务器上 keychain 根本不存在。
 *
 * 🔴 **keychain 不可用是「换一条路」，不是「报错」。** 但要**说出来** ——
 *    用户有权知道自己的 token 是躺在 keychain 里还是躺在一个文件里。
 *
 * @param {object} deps
 * @param {(cmd:string, args:string[], input:string|null) => {status:number, stdout:string, stderr:string}} deps.run
 */
export function makeAuthStore({ run, platform = process.platform, path = null, warn = null } = {}) {
  const kc = KEYCHAIN[platform] ?? null;
  const file = path ?? authFilePath();
  const note = (s) => { if (warn !== null) warn(s); };

  const tryKeychain = (make, input = null) => {
    if (kc === null || typeof run !== 'function') return null;
    const spec = make(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, input);
    let r;
    try { r = run(spec.cmd, spec.args, spec.stdin ? input : null); } catch { return null; }
    // 命令不存在 / 没有 keyring daemon：status 非 0 或抛错，一律当「不可用」
    if (r === null || r === undefined || r.status !== 0) return null;
    return r;
  };

  return {
    /** @returns {'keychain'|'file'} 实际存到了哪儿 */
    save(token) {
      if (tryKeychain((s, a) => kc.set(s, a, token), token) !== null) return 'keychain';
      note(`⚠️ 系统 keychain 不可用，token 落在 ${file}（0600）。`
        + '\n   它是一个明文文件 —— 这台机器上能读它的人就能用你的身份投稿。');
      writeTokenFile(token, { path: file, warn });
      return 'file';
    },
    /** @returns {{token:string, from:'keychain'|'file'}|null} */
    load() {
      const r = tryKeychain((s, a) => kc.get(s, a));
      if (r !== null) {
        const token = r.stdout.replace(/\n$/, '');
        if (token !== '') return { token, from: 'keychain' };
      }
      const d = readTokenFile({ path: file, warn });
      return d === null ? null : { token: d.token, from: 'file' };
    },
    /**
     * 🔴 **两处都要清。** 只清 keychain 的话，一个早先落过盘的 auth.json
     *    会留在原地 —— 用户以为 logout 了，token 还躺在那儿。
     * @returns {string[]} 实际清掉了哪几处
     */
    clear() {
      const cleared = [];
      if (tryKeychain((s, a) => kc.del(s, a)) !== null) cleared.push('keychain');
      if (deleteTokenFile({ path: file })) cleared.push('file');
      return cleared;
    },
  };
}
