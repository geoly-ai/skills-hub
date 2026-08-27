// 🔴 测量之前的自检：**这台机器上，这个客户端能不能跑完一轮？**
//
// 为什么必须有这一步（这是一次真实的、代价不小的返工）：
//
//   第一版没有它。claude 那两格每次测量都在 `spawnSync` 的超时上被 SIGTERM，
//   客户端捕获信号后以 128+15 = **143** 退出。报告里于是出现八个一模一样的 143，
//   而我据此写下的归因是「客户端连不上网络」—— **那是猜的，而且是错的**。
//   真正的原因是 stub 与测量代码跑在同一个进程里，被 `spawnSync` 阻塞了事件循环：
//   客户端连上了、请求也发出去了，但**没有人去读**。
//
//   ⚠️ 更要命的是我为了「验证」那个猜想做的对照实验：
//      我用 `spawnSync` 起 curl 去连本地 stub，而 stub 还是同进程 ——
//      **对照本身被同一个 bug 打死了**，于是它「证实」了一个不存在的网络问题。
//      外网 HTTPS 能通、所有本地 bind 都不通，这个反差看起来铁证如山，
//      实际只是因为外部服务不在我们的事件循环里，而本地 stub 在。
//
// 🔴 由此得到本模块的两条硬性设计约束：
//   ① **探针必须用与真实测量完全相同的进程结构**（stub 独立进程 + spawnSync 客户端）。
//      结构不同的探针，测的就不是同一件事。
//   ② **探针只报现象，不报结论**：「客户端超时了」「stub 没收到请求」是现象；
//      「网络不通」是结论。现象可以直接照着查，错误的结论会让人去修不存在的问题。
//
// 一般化的判据（值得记住）：
//   **「进程被杀 + 服务端没收到请求」推不出「网络不通」。** 至少要分开三种：
//   连不上（ECONNREFUSED）、**连上了但没人读**（本例）、读了但没回。
//   本例的辨别特征是 —— 客户端**已经产出了正常输出**（init 事件、完整 skill 清单），
//   说明它跑起来了，卡的是「等回复」。

/**
 * 客户端能不能真的跑完一轮。
 *
 * 🔴 调用方必须用**真实测量那一套**来构造 `run`（同样的 stub 进程、同样的 spawnSync），
 *    否则这个探针没有意义。
 *
 * @param {object} a
 * @param {string} a.label
 * @param {() => object} a.run           跑一次真实读数，返回 reader 的结果
 * @param {boolean} a.expectRequest      这一端是否应当产生请求体（claude 是，codex 不是）
 * @returns {{ok:boolean, reason:string|null, detail:object}}
 */
export function probeClientCompletesRound({ label, run, expectRequest }) {
  const t0 = Date.now();
  const r = run();
  const elapsedMs = Date.now() - t0;

  const detail = {
    label,
    elapsedMs,
    exitCode: r.exitCode ?? null,
    signal: r.signal ?? null,
    spawnError: r.spawnError ?? null,
    stdoutBytes: (r.haystack ?? '').length,
    stderr: (r.stderr ?? '').slice(0, 1000),
    namesRead: r.names?.length ?? 0,
    requests: r.requestBodies === null ? null : r.requestBodies.length,
  };

  // ── 现象一：我们自己的超时把它杀了 ──────────────────────────────────
  if (r.spawnError === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
    return {
      ok: false,
      reason:
        `${label}：客户端没在超时内跑完一轮（${elapsedMs}ms 后被**我们自己的超时** SIGTERM 掉）。\n` +
        `      🔴 退出码 ${detail.exitCode} 多半就是 128+15 —— 那是我们杀的，不是客户端崩的。\n` +
        `      现场：读到 ${detail.namesRead} 个 skill 名、stdout ${detail.stdoutBytes} 字节、` +
        `stub 收到 ${detail.requests ?? '（本端不产生请求体）'} 个请求。\n` +
        '      👉 客户端已经产出正常输出却收不到回复，最常见的原因是 **stub 与测量代码同进程**，\n' +
        '         事件循环被 spawnSync 阻塞（stub 必须起在独立进程里，见 stub-anthropic.mjs 文件头）。\n' +
        '         ⚠️ 先照这条查，不要直接下「网络不通」的结论。',
      detail,
    };
  }

  // ── 现象二：退出码看着像「被信号杀的」──────────────────────────────
  //
  // 🔴 128+N 这个形状必须单独认出来。`spawnSync` 在某些情况下**不会**把
  //    `signal` / `error` 填上（比如客户端自己装了 SIGTERM handler、
  //    优雅退出并返回 128+15），于是现象一那条判据抓不住它，
  //    而 143 会被读成「客户端自己崩了」—— 那正是我上一轮走错的那一步。
  if (r.exitCode > 128 && r.exitCode < 165) {
    const sig = r.exitCode - 128;
    return {
      ok: false,
      reason:
        `${label}：客户端以退出码 ${r.exitCode} 结束 —— 这是 128+${sig} 的形状，` +
        `**多半是被信号 ${sig === 15 ? 'SIGTERM' : sig === 9 ? 'SIGKILL' : sig} 杀掉后优雅退出的**，不是它自己崩了。\n` +
        `      现场：${elapsedMs}ms、读到 ${detail.namesRead} 个 skill 名、stdout ${detail.stdoutBytes} 字节、` +
        `stub 收到 ${detail.requests ?? '（本端不产生请求体）'} 个请求。\n` +
        '      👉 客户端已经产出正常输出却收不到回复，最常见的原因是 **stub 与测量代码同进程**，\n' +
        '         事件循环被 spawnSync 阻塞（stub 必须起在独立进程里，见 stub-anthropic.mjs 文件头）。\n' +
        '         ⚠️ 先照这条查，不要直接下「网络不通」的结论。',
      detail,
    };
  }

  // ── 现象三：客户端自己以非零码退出 ─────────────────────────────────
  if (r.exitCode !== 0) {
    return {
      ok: false,
      reason: `${label}：客户端以退出码 ${r.exitCode} 结束（既不是我们的超时，也不像被信号杀）。stderr：${detail.stderr || '(空)'}`,
      detail,
    };
  }

  // ── 现象四：跑完了，但没有请求体这件产物 ───────────────────────────
  if (expectRequest && (r.requestBodies?.length ?? 0) === 0) {
    return {
      ok: false,
      reason:
        `${label}：客户端退出码 0，但 **stub 一个请求都没收到**。\n` +
        '      「canary 有没有混进真实发往模型的请求体」这件证据因此**不存在** —— 不是查过是 0。\n' +
        '      👉 检查 ANTHROPIC_BASE_URL 是否指向了 stub，以及 stub 进程是否还活着。',
      detail,
    };
  }

  // ── 现象五：跑完了，但一个 skill 都没读到 ──────────────────────────
  if (detail.namesRead === 0) {
    return {
      ok: false,
      reason:
        `${label}：客户端退出码 0，但读到 **0 个 skill 名** —— 读数解析多半没对上客户端的输出格式。\n` +
        '      这种情况下所有正对照都会「纹丝不动」，进而被判成 VOID；先修解析，别去改判定。',
      detail,
    };
  }

  return { ok: true, reason: null, detail };
}
