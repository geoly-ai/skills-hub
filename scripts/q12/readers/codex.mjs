// codex 读数 —— `codex debug prompt-input` 渲染出来的**模型可见 prompt** 里
// <skills_instructions> 块的条目。
//
// ⚠️ codex 这一路是**离线渲染**，不发任何请求。也就是说它**没有「请求体」这件产物**：
//    catalog 与「模型看到的内容」是同一份东西。报成两个独立判据等于把同一件事数了两遍
//    （docs/m1/00-gates.md 明确点了这一条）。
//
// 🔴 **不传 `--ignore-user-config`。** 那正是上一轮把测量搞死的原因：客户端不读用户配置，
//    也就不去扫那个目录，正对照纹丝不动，负结果毫无意义。隔离靠换根，不靠让客户端别去看。
import { spawnSync } from 'node:child_process';

export const CLIENT = 'codex';

/** 这一端能测的 target（scope → 相对哪个根）。 */
export function targetFor({ scope, home, project, dirName = '.codex' }) {
  return scope === 'global'
    ? `${home}/${dirName}/skills`
    : `${project}/${dirName}/skills`;
}

export function version() {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * @returns {{names:string[], count:number, exitCode:number|null, stderr:string,
 *            haystack:string, requestBodies:string[]|null}}
 *   `requestBodies` 为 null 表示**这一端不存在这件产物**，不是「查了但是空的」。
 */
export function read({ env, cwd, timeoutMs = 120_000 }) {
  const r = spawnSync('codex', ['debug', 'prompt-input'], {
    env, cwd, encoding: 'utf8', timeout: timeoutMs,
    // 🔴 同 claude reader：stdin 不显式关掉的话会阻塞、被 timeout SIGTERM 杀成 143。
    // codex 这条命令目前不读 stdin，但别依赖这一点 —— 依赖它就是等着哪天客户端改行为。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';

  // 渲染出来的是一个 JSON 数组，skills 那块在某条 input_text 的 text 字段里。
  // 直接在整段 stdout 上定位标签，避免依赖数组的内部结构（那是客户端实现细节）。
  const names = [];
  const open = stdout.indexOf('<skills_instructions>');
  const close = stdout.indexOf('</skills_instructions>');
  if (open !== -1 && close > open) {
    const block = stdout.slice(open, close);
    // 条目形如：`- <name>: <description> (file: <path>)`，在 JSON 里 \n 是转义的。
    for (const m of block.matchAll(/\\n- ([^:\\]+):/g)) names.push(m[1].trim());
  }

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
    // canary 定点搜索的干草堆：整份模型可见 prompt。
    haystack: stdout,
    requestBodies: null,
  };
}
