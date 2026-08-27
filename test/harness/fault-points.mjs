// 注入点目录（CATALOG）—— 故障注入框架的「应该有哪些点」的权威清单。
//
// 为什么要有一份静态目录，而不是只靠运行时 trace：
//   · trace 只能告诉你「跑到了哪些点」，**告诉不了你漏了哪些点**；
//   · 注入点改名之后，按 trace 驱动的测试会照样绿（它只是少测了一个点）。
// 有目录之后，test/fault-matrix.test.mjs 做三向交叉核对：
//   a) trace 里出现、CATALOG 里没有       → 失败（防拼错、防偷偷加点）
//   b) CATALOG 标了 scenario、trace 里没有 → 失败（防改名/失联/被优化掉）
//   c) CATALOG 里 status='declared' 的     → 打印成 pending 清单（事务内核落地时转 live）
//
// covers 字段对应 docs/m0/00-decisions.md §6 P0 第 3 项点名要覆盖的七类：
//   atomic-write | rename-fsync | one-sided | cleanup-abc | rollback | repair | audit

/**
 * @typedef {object} FaultPoint
 * @property {string[]} covers   M0 §6 的哪一类
 * @property {string}   owner    埋点所在模块
 * @property {'live'|'declared'} status  live = 现在就有生产/假事务代码在打它
 * @property {string[]} [scenario] 哪些场景**必须**打到它（用于反向核对）
 * @property {string}   why      这个点为什么值得单独崩一次
 */

/** @type {Record<string, FaultPoint>} */
export const CATALOG = {
  // ── atomic-fs：原子写与每一次 rename/fsync（§11 §5、§5.2.1）────────────────
  'atomic-write:post-open-tmp': {
    covers: ['atomic-write'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '.tmp 已建、内容为空。恢复必须把它当「未提交」忽略并删除（§5.4 I/O 规则）。',
  },
  'atomic-write:pre-write': {
    covers: ['atomic-write'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: 'write() 失败且无副作用：.tmp 是空的，目标文件必须原封不动。',
  },
  'atomic-write:pre-fsync-file': {
    covers: ['atomic-write'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 文件 fsync 失败那一格（Codex 第二轮 #9 指出原来缺了它）。'
       + '数据只在页缓存里，§5.4 要求 fsync 失败立即停机、不得当成功。',
  },
  'atomic-write:post-write': {
    covers: ['atomic-write'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '.tmp 有内容但未 fsync —— powerfail 下它应当整个消失。',
  },
  'atomic-write:post-fsync-file': {
    covers: ['atomic-write'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '数据持久、目录项还没落。目标文件仍是**旧版本**，绝不能是半新半旧。',
  },
  'atomic-write:pre-rename': {
    covers: ['atomic-write', 'rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '提交点之前一格：目标文件必须还是旧内容。',
  },
  'atomic-write:post-rename': {
    covers: ['atomic-write', 'rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 §11 §5 的核心：rename 已生效、父目录 fsync 还没做。'
       + '规范明令此时**不得声称「磁盘未变」**。',
  },
  'atomic-write:post-fsync-dir': {
    covers: ['atomic-write', 'rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '写已完全持久，但调用方的下一步还没跑。',
  },
  'fsync-dir:pre': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '每一次目录 fsync 之前 —— §5.2.1「两棵都丢」反例的注入位。',
  },
  'fsync-dir:post': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '每一次目录 fsync 之后 —— 目录项已落盘，调用方的下一步还没跑。',
  },
  'mkdir-chain:post-mkdir': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 整条链已 mkdir、一层都没 fsync。powerfail 下整条链应当消失，'
       + '而不是「叶子在、根不在」。',
  },
  'mkdir-chain:mid-fsync': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 只 fsync 了叶子、还没 fsync 上层 —— 正是 §5.2.1 那个反例本身。',
  },
  'mkdir-chain:post-fsync': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '整条链（含最近的已存在祖先）都已持久之后 —— 这一格证明 §5.2.1 的目录链 fsync 走完了。',
  },
  'rename-dir:pre': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '§5.3 的 ②/④ 之前：源在、目标不在。',
  },
  'rename-dir:post-rename': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '整棵树刚换位、两侧目录都没 fsync。powerfail=duplicate 时会造出'
       + '§5.4 幂等表分支 ②（Y 正确但 X 也在）→ 必须判 corrupt。',
  },
  'rename-dir:post-fsync-dst': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 只 fsync 了目标侧 —— 源侧目录项的删除还可能丢。',
  },
  'rename-dir:post-fsync-src': {
    covers: ['rename-fsync'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: 'rename 两侧目录都已 fsync，整个换位完全持久之后。',
  },
  'rmtree:pre': {
    covers: ['cleanup-abc'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '递归删除之前：被删对象还完整，此时崩溃必须仍能重新进入删除段。',
  },
  'rmtree:mid': {
    covers: ['cleanup-abc'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 **递归删到一半**。§5.4 明说「`retired/<name>` 的递归删除本身是多次操作」，'
       + '所以 rmtreeFsync 自己写递归而不是一句 rmSync({recursive:true})——'
       + '否则这个窗口根本注入不进去（Codex 第一轮指出）。',
  },
  'rmtree:post': {
    covers: ['cleanup-abc'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '已删干净、父目录还没 fsync —— 掉电后目录项可能复活，恢复必须能再删一次。',
  },
  'rmtree:post-fsync-parent': {
    covers: ['cleanup-abc'], owner: 'src/atomic-fs.mjs', status: 'live',
    scenario: ['fake-tx'],
    why: '§5.4 要求 rmtree 成功后必须 fsync 父目录 —— 这一格证明它做了。',
  },

  // ── 十步事务（§5.2 / §5.3）─────────────────────────────────────────────────
  'tx:step6:pre-ledger': {
    covers: ['one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '提交点之前：ledger 与 journal 都没写，target 未被改动，tx 目录可直接丢弃。',
  },
  'tx:step6:between-ledger-journal': {
    covers: ['one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 **journal/ledger 单边落盘** —— ledger 写了、journal 没写。'
       + '§5.4.2 的双文件规则专治这一格。',
  },
  'tx:step6:post-journal': {
    covers: ['one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '提交点已过：此后必须前向恢复，不得当成「什么都没发生」。',
  },
  'tx:item:pre-retire-rename': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '§5.3 ② 之前。🔴 注意 state 仍是 planned —— §5.4.1 铁律：'
       + '不得从 planned 推断「什么都没发生」。',
  },
  'tx:item:post-retire-rename': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 旧树已在 retired/、journal 还写着 planned。丢这一格就会丢旧树。',
  },
  'tx:item:post-state-retired': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'planned→retired 段已推进并落盘，下一段（④ rename）还没开始。',
  },
  'tx:item:pre-swap-rename': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 §5.3「两次 rename 之间」：target 上暂时没有该目录（D10 的短暂读不到），'
       + '旧树在 retired/、新树在 stage/，**两份都在**。',
  },
  'tx:item:post-swap-rename': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '新树已落位、journal 还写着 retired。',
  },
  'tx:item:post-state-swapped': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'retired→swapped 段已推进并落盘，第 8 步校验还没做。',
  },
  'tx:step8:post-state-verified': {
    covers: ['rename-fsync'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '第 8 步校验通过并持久化 verified 之后，账本还没更新。',
  },
  'tx:step9:pre-ledger': {
    covers: ['one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '第 9 步之前：全部 item 已 verified，账本还是提交前的样子。',
  },
  'tx:step9:between-ledger-journal': {
    covers: ['one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 第 9 步的**单边落盘**：entries 已更新、journal 还是 prepared。',
  },
  'tx:step9:post-journal': {
    covers: ['one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'phase=cleanup_pending 已落盘 —— 下一次运行必须自动续做清理。',
  },

  // ── 清理三阶段（§5.6）──────────────────────────────────────────────────────
  'cleanup:A:post-tar-tmp': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'A① 之后：.tar.tmp 在、还没三方比对。恢复必须先删残留再重写。',
  },
  'cleanup:A:post-compare': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'A② 三方比对已过、tar 还没 rename 到位 —— 此时只有 .tar.tmp，恢复要先删残留再重写。',
  },
  'cleanup:A:post-tar-rename': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 tar 已 durable、journal 还没记 tar_durable。'
       + '恢复必须**从磁盘重验 A**，不能只信 journal（§5.6 前提 1）。',
  },
  'cleanup:A:post-state-tar-durable': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'A 段对该项已完成。',
  },
  'cleanup:B:pre-manifest': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '全部 tar 都 durable、manifest 还没写。🔴 此刻**不允许删任何 retired**。',
  },
  'cleanup:B:post-manifest': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'manifest 在盘上、journal 还没记 durable。',
  },
  'cleanup:B:post-state-manifest-durable': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 B⑥ 落盘 —— 这一格之后才准进 C。不变式 I6 就是钉它。',
  },
  'cleanup:C:pre-rmtree': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'C⑦ 之前：retired 与 tar 两份都在。',
  },
  'cleanup:C:post-rmtree': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '🔴 retired 已删、journal 还没记 done。此时 **tar 是唯一副本**，'
       + '恢复只能前进不能回头（§5.4「幂等 ≠ 回滚安全」）。',
  },
  'cleanup:C:post-state-done': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '该项 cleanup=done 已落盘，下一项还没开始 —— 逐项推进必须可中断。',
  },
  'cleanup:post-tx-rm': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '空 tx 目录已删、phase 还没置 completed —— 恢复要能认出这是「清理已做完」。',
  },
  'cleanup:post-phase-completed': {
    covers: ['cleanup-abc'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: 'phase=completed 已落盘、ledger.transaction 可能还没置 null。',
  },
  'cleanup:post-clear-transaction': {
    covers: ['cleanup-abc', 'one-sided'], owner: 'src/install.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx'],
    why: '事务彻底收尾：ledger.transaction 已置 null，此后不该再有任何残留。',
  },

  // ── rollback 子段（§5.4.1）─────────────────────────────────────────────────
  'rollback:pre-direction': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '入场分类已实测、还没落盘。🔴 此时崩了必须重新实测，不得沿用正向 state。',
  },
  'rollback:post-direction': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '🔴 direction=rollback 已持久 —— 恢复**只能续做 rollback，不得转回正向**。'
       + '这正是 v10 修掉的那个「把刚回滚掉的又装回去」。',
  },
  'rollback:item:pre-park-t': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '把 T 上的新树 park 回 stage/ 之前：T 还是新树，R 还是旧树。',
  },
  'rollback:item:post-park-t': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '🔴 T=∅、R=old、S=new —— 与正向的 retired 段物理同形。'
       + '靠 direction 字段区分，不靠物理状态。',
  },
  'rollback:item:pre-restore': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '旧树从 retired/（或 attic tar）搬回 T 之前 —— T 此刻是空的。',
  },
  'rollback:item:post-restore': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '旧树已回位、rstate 还没记 restored —— 重跑必须靠幂等 rename 的分支①跳过。',
  },
  'rollback:item:post-rstate': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '该项 rstate=restored 已落盘，下一项的反向段还没开始。',
  },
  'rollback:post-finalize': {
    covers: ['rollback'], owner: 'src/recover.mjs（fake-tx 仍打同名点）', status: 'live',
    scenario: ['fake-tx-rollback'],
    why: '🔴 §5.4.1 终结：direction 与 rollback 两个字段必须**同一次原子写**删掉。',
  },

  // ── repair intent / child（§5.10）—— 事务内核落地后 wire ────────────────────
  'repair:step2:post-intent': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ②；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'intent state=planned 已落盘、还没开始隔离。'
       + '🔴 恢复不得据 state 断言「tx 还在原处」。',
  },
  'repair:step3:pre-isolate-tx': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ③；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: '四项隔离的第一项之前：tx / journal / target / ledger.transaction 都还在原处。',
  },
  'repair:step3:post-isolate-tx': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ③；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'tx 已进 quarantine、journal 还在原处 —— 半隔离态。',
  },
  'repair:step3:post-isolate-journal': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ③；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: '🔴 tx 与 journal 都进了隔离 —— 「有 tx 无 journal」的伪装态就是这里生成的。',
  },
  'repair:step3:post-isolate-target': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ③；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: '被隔离的 target 树已搬进 quarantine，ledger.transaction 还没清空。',
  },
  'repair:step3:post-clear-ledger-transaction': {
    covers: ['repair', 'one-sided'], owner: 'src/recover.mjs（§5.10 ③；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: '第四项（非 rename）已完成、state 还没推进到 isolated。',
  },
  'repair:step4:post-isolated': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ④；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'state=isolated 与 cur/child_op/restore_from 同一次原子写落盘之后。',
  },
  'repair:step5:post-child-register': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ⑤；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: '🔴 child 已登记（committed:false）、那个新事务还没创建 —— '
       + '恢复只允许恢复 child.generation 那一个事务（§5.2 步骤 2b-1）。',
  },
  'repair:step5:pre-child-create': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ⑤；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'child 已登记而那个新事务还没建 —— 恢复只能认 child.generation 这一个。',
  },
  'repair:step6:post-child-done': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ⑥；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'child 完成并通过最终重验，intent 还停在 child_done。',
  },
  'repair:step6:post-state-done': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ⑥；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'state=done 已落盘、intent 文件还没删 —— 恢复必须认得这是「已完成待清理」。',
  },
  'repair:step6:post-intent-removed': {
    covers: ['repair'], owner: 'src/recover.mjs（§5.10 ⑥；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-repair'],
    why: 'intent 已删、父目录 fsync 之前 —— 掉电后 intent 可能复活，收尾必须幂等。',
  },

  // ── audit archive intent（§4 audit plane）───────────────────────────────────
  'audit-archive:step1:post-intent': {
    covers: ['audit'], owner: 'src/ledger.mjs（audit plane ①；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-audit'],
    why: 'intent 已落盘、archive 文件还没写。恢复必须重跑 ②③④，绝不跳过、绝不删 intent。',
  },
  'audit-archive:step2:post-archive': {
    covers: ['audit'], owner: 'src/ledger.mjs（audit plane ②；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-audit'],
    why: '🔴 <seq>.json 已存在 —— 恢复必须**重验全部内容与 batch_digest**，'
       + '不符即 fail-closed，**绝不覆盖**。',
  },
  'audit-archive:step2:post-reverify': {
    covers: ['audit'], owner: 'src/ledger.mjs（audit plane ②′；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-audit'],
    why: '正常路径的重验也必须做（v21 补的那一格）。',
  },
  'audit-archive:step3:post-ledger-patch': {
    covers: ['audit'], owner: 'src/ledger.mjs（audit plane ③；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-audit'],
    why: '账本已移除前缀、cursor 已前进、intent 还在 —— ③ 必须幂等。',
  },
  'audit-archive:step4:post-intent-removed': {
    covers: ['audit'], owner: 'src/ledger.mjs（audit plane ④；fake-intents 仍打同名点）', status: 'live', scenario: ['fake-audit'],
    why: '归档事务收尾：intent 已删，live 与 archive 的并集必须仍等于全部事件。',
  },
};

/** M0 §6 点名的七类，用于覆盖率报告 */
export const M0_S6_CATEGORIES = [
  'atomic-write', 'rename-fsync', 'one-sided', 'cleanup-abc', 'rollback', 'repair', 'audit',
];

export function pointsFor(scenario) {
  return Object.entries(CATALOG)
    .filter(([, v]) => v.scenario?.includes(scenario))
    .map(([k]) => k);
}

export function declaredPoints() {
  return Object.entries(CATALOG).filter(([, v]) => v.status === 'declared').map(([k]) => k);
}

export function livePoints() {
  return Object.entries(CATALOG).filter(([, v]) => v.status === 'live').map(([k]) => k);
}

/** 每一类 M0 §6 项各有多少 live / declared 点 */
export function coverageByCategory() {
  const out = {};
  for (const c of M0_S6_CATEGORIES) out[c] = { live: 0, declared: 0 };
  for (const v of Object.values(CATALOG)) {
    for (const c of v.covers) {
      if (!out[c]) throw new Error(`fault-points: 未知 covers 分类 ${c}`);
      out[c][v.status]++;
    }
  }
  return out;
}
