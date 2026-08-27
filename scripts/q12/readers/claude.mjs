// claude 读数 —— `claude -p --output-format stream-json --verbose` 首条
// system/init 事件里的 `skills` 数组。
//
// 🔴 **故意不设 CLAUDE_CONFIG_DIR**（sandbox.mjs 里也写了这条）：adapter 里 claude 的
//    global target 是 `$HOME/.claude/skills`，用 CLAUDE_CONFIG_DIR 指到别处，
//    测的就是一个 adapter 根本不会去装的路径 —— 门白测。隔离只靠换 HOME。
//
// 第二件产物：stub 落盘的**真实请求体**。它与 catalog 是两件不同的东西，
// 所以 canary 要在两处各查一次。⚠️ 但如果一个请求都没到达 stub，
// 那就是**没有这件证据**，不是「查过是 0」—— 见 requestBodyEvidence。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export const CLIENT = 'claude';

export function targetFor({ scope, home, project, dirName = '.claude' }) {
  return scope === 'global'
    ? `${home}/${dirName}/skills`
    : `${project}/${dirName}/skills`;
}

export function version() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * 新 HOME 里 claude 会走首次引导。写一份最小配置把引导跳过 ——
 * 这与 `--ignore-user-config` **不是**一回事：那个是让客户端少扫目录（会毁掉测量），
 * 这个只是把交互式提示关掉，扫描行为一点没动。
 */
export function prepareHome({ home, project }) {
  const proj = realpathSync(project);
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [proj]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } },
    }),
  );
}

export function read({ env, cwd, bodyLogPath, timeoutMs = 180_000 }) {
  const r = spawnSync(
    'claude',
    ['-p', 'q12 probe', '--output-format', 'stream-json', '--verbose'],
    {
      env, cwd, encoding: 'utf8', timeout: timeoutMs,
      // 🔴 stdin 必须显式关掉。不关的话客户端会阻塞在 stdin 上等输入，
      // 然后被 timeout 用 SIGTERM 杀掉 —— 退出码 143、一个请求都没发出去。
      // 那看起来像「网络不通」，实际是「卡在 stdin」。与 `codex exec` 必须加
      // `< /dev/null` 是同一个坑（那次卡了 2 小时 50 分）。
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';

  let names = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'system' && ev?.subtype === 'init') {
      names = Array.isArray(ev.skills) ? ev.skills.slice() : [];
      break;
    }
  }

  let requestBodies = [];
  try {
    requestBodies = readFileSync(bodyLogPath, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l).body ?? ''; } catch { return l; } });
  } catch { requestBodies = []; }

  return {
    names,
    count: names.length,
    exitCode: r.status,
    // 🔴 这两个字段是**归因**用的，别省。
    //    只有 exitCode 的话，「客户端自己退出 143」与「我们的超时把它 SIGTERM 了」
    //    长得一模一样 —— 而这两件事要修的地方完全不同。
    //    （踩过：把后者读成前者，进而误判成网络问题。）
    signal: r.signal ?? null,
    spawnError: r.error?.code ?? null,
    stderr,
    haystack: stdout,
    requestBodies,
  };
}
