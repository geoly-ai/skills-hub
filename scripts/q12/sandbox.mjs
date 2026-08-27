// Q12 沙箱 —— 🔴 **绝不碰用户真实的 ~/.claude ~/.codex ~/.cursor ~/.agents。**
//
// 隔离靠**换根**，不靠让客户端少读东西。
// ⚠️ docs/m1/00-gates.md 记着上一轮的教训：用 `--ignore-user-config` 这类开关
//    把客户端「关小」，结果它连该扫的目录都不扫了，测量整个失效。
//    所以这里只做两件事：① 把每一个「家」指进临时目录；② 跑完核对真实目录没被动过。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** 真实用户目录里 Q12 会碰到的那几个「家」。 */
export const PROTECTED = ['.claude', '.codex', '.cursor', '.agents'];

/**
 * 🔴 真正要守的东西：**skill 根**。夹具一旦落到这里，就是我们把 canary
 *    装进了用户的真实技能列表。
 */
export const PROTECTED_SKILL_DIRS = PROTECTED.map((d) => join(d, 'skills'));

/**
 * ⚠️ 这几个子目录是客户端自己的**易变草稿区**（会话、历史、git 临时仓库、日志）。
 *    机器上只要还有别的 codex / claude 会话在跑，它们每秒都在变 ——
 *    把它们算进判据会让守卫变成一个「随机报警的假门」，而假门的下场是被人关掉。
 *    它们**不是** skill 根，落在这里的东西不会被当成 skill 加载。
 *    代价如实写在这里：本守卫**不覆盖**这些目录下的写入。
 */
const VOLATILE = new Set(['.tmp', 'sessions', 'history', 'projects', 'logs', 'log', 'statsig', 'shell-snapshots', 'todos', 'file-history', 'downloads', 'ide', 'plugins', 'debug']);

/** canary 名字的固定前缀（fixture.mjs 里 newCanary 生成的都是这个开头）。 */
export const CANARY_PREFIX = 'q12-';

function isInside(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function listRecursive(path, depth, skipVolatile) {
  if (depth <= 0) return ['…'];
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return ['<unreadable>']; }
  const out = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (skipVolatile && VOLATILE.has(e.name)) { out.push(`${e.name}/<volatile:skipped>`); continue; }
    out.push(e.isDirectory()
      ? `${e.name}/[${listRecursive(join(path, e.name), depth - 1, skipVolatile).join(',')}]`
      : e.name);
  }
  return out;
}

function fingerprintOne(path, { depth, skipVolatile }) {
  if (!existsSync(path)) return { exists: false };
  const st = statSync(path);
  if (!st.isDirectory()) return { exists: true, kind: 'file', size: st.size, mtime: st.mtimeMs };
  return { exists: true, kind: 'dir', entries: listRecursive(path, depth, skipVolatile) };
}

/**
 * 指纹分两层，各自回答一个问题：
 *   · `skillDirs` —— 真正的 skill 根，**逐条目**比对（这是硬判据）
 *   · `homes`     —— 四个「家」的顶层构成，跳过易变草稿区（这是软判据，抓「多了个新目录」）
 *
 * ⚠️ 故意**不比 mtime**：并发的别的会话会改它，而 mtime 变化本身说明不了
 *    我们写了什么。判据是「条目集合变没变」。
 */
export function fingerprintRealHome(home = homedir()) {
  const skillDirs = {};
  for (const d of PROTECTED_SKILL_DIRS) {
    skillDirs[d] = fingerprintOne(join(home, d), { depth: 6, skipVolatile: false });
  }
  const homes = {};
  for (const d of PROTECTED) {
    homes[d] = fingerprintOne(join(home, d), { depth: 1, skipVolatile: true });
  }
  return { skillDirs, homes };
}

/**
 * 在真实目录里定点搜「只可能是我们写的」东西：
 *   · canary 前缀 `q12-`（fixture 生成的每一个 skill 都叫这个）
 *   · `.geoly/`（夹具的状态目录）
 * 这两样在用户的真实目录里出现，只有一个解释：沙箱漏了。
 */
function sweepOurArtifacts(home) {
  const found = [];
  const walk = (path, depth) => {
    if (depth <= 0) return;
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (VOLATILE.has(e.name)) continue;
      if (e.name.startsWith(CANARY_PREFIX) || e.name === '.geoly') found.push(join(path, e.name));
      if (e.isDirectory()) walk(join(path, e.name), depth - 1);
    }
  };
  for (const d of PROTECTED) walk(join(home, d), 5);
  return found;
}

/**
 * 🔴 跑完必须调这个。
 *
 * 判据分**硬**、**软**两级，理由写在这里免得后来人把软的那级也改成 throw：
 *
 * · **硬（throw）**：真实目录里搜到了 `q12-*` 或 `.geoly/`。
 *   这两样只可能由本夹具产生，出现即证明沙箱漏了，没有别的解释。
 *
 * · **软（返回 warnings，不 throw）**：四个「家」的条目集合发生了变化。
 *   机器上只要还有别的 codex / claude 会话在跑，它们随时会写自己的目录 ——
 *   实测过一次两秒之内 `~/.codex/skills` 自己就变了。
 *   把它做成 throw 会让守卫变成随机报警的假门，而假门的下场是被人关掉。
 *   ⚠️ 代价如实记在这里：**本守卫不能证明「我们一个字节都没写」**，
 *   它证明的是「我们**已知会写的那些名字**没有出现在真实目录里」。
 *
 * @returns {{warnings: string[]}}
 */
export function assertRealHomeUntouched(before, home = homedir()) {
  const leaked = sweepOurArtifacts(home);
  if (leaked.length > 0) {
    throw new Error(
      '🔴 沙箱泄漏：我们的夹具出现在真实用户目录里 —— 这一轮的所有读数作废。\n' +
        leaked.map((p) => `    ${p}`).join('\n'),
    );
  }

  const after = fingerprintRealHome(home);
  const warnings = [];
  for (const d of PROTECTED_SKILL_DIRS) {
    if (JSON.stringify(before.skillDirs[d]) !== JSON.stringify(after.skillDirs[d])) {
      warnings.push(`~/${d} 的条目集合在本轮期间变了（未搜到我们的夹具，多半是别的会话在写）`);
    }
  }
  for (const d of PROTECTED) {
    if (JSON.stringify(before.homes[d]) !== JSON.stringify(after.homes[d])) {
      warnings.push(`~/${d} 顶层构成在本轮期间变了（同上）`);
    }
  }
  return { warnings };
}

/**
 * 建一个隔离根。返回的 `env` 是**从零构造**的，不继承调用者的环境
 * （凭据、agent socket、云 token 一个都不带过去）。
 */
export function makeSandbox({ label = 'q12' } = {}) {
  const real = homedir();
  const root = mkdtempSync(join(tmpdir(), `${label}-`));

  // ① 沙箱必须在 tmpdir 下；② 绝不能落在真实家目录里面。
  if (!isInside(root, tmpdir())) throw new Error(`沙箱根 ${root} 不在 os.tmpdir() 下`);
  if (isInside(root, real)) throw new Error(`沙箱根 ${root} 落在真实家目录里，拒绝继续`);

  const home = join(root, 'home');
  const project = join(root, 'project');
  const tmp = join(root, 'tmp');
  // codex 在 $CODEX_HOME 不存在时直接报错退出 —— 它必须先存在，
  // 但里面的 skills/ 由协议按步骤建（S0 要的是「target 存在且为空」）。
  for (const d of [home, project, tmp, join(home, '.codex')]) mkdirSync(d, { recursive: true });

  if (resolve(home) === resolve(real)) throw new Error('沙箱 HOME 等于真实 HOME，拒绝继续');

  // git 在这些客户端里会被调用（读仓库根、判 dirty）。system/global 配置一并隔离，
  // 否则 credential.helper 之类的东西会把真实凭据带进来（Codex 评审指出的）。
  const gitconfig = join(root, 'gitconfig');

  /**
   * 🔴 白名单式环境，不是「继承再删几个」。
   *    黑名单迟早漏（下一个云厂商的新变量名没人记得加）。
   */
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    // 🔴 **故意不设 CLAUDE_CONFIG_DIR** —— adapter 里 claude 的 global target 是
    //    $HOME/.claude/skills；指到别处就等于测了一个 adapter 根本不会去装的路径。
    //    （docs/m1/00-gates.md 明确记了原版测量犯过这个错。）
  };

  return {
    root, home, project, env,
    /** 让 project 是个真 git 仓库 —— 客户端的 project 级扫描要靠仓库根定位。 */
    initGitRepo() {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });
      execFileSync('git', ['config', 'user.email', 'q12@example.invalid'], { cwd: project, env });
      execFileSync('git', ['config', 'user.name', 'q12'], { cwd: project, env });
      return project;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
