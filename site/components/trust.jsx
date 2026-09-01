// 信任链条（验证轴）与信任台账。规格：DESIGN.md §7.2、§7.3。
//
// ══ 本站点在这里做了一个和设计规格不同的决定，理由必须留在代码里 ══
//
// DESIGN.md 假设页面拿得到一次**真实的验证结果**（Sigstore bundle、Rekor 条目、
// timestamp），于是四格会呈现 ok / warn / bad。**本站点一格都拿不到**：
//   · `timestamp.json` 只作为 Release 资产分发，仓库里根本不存（02-registry.md §3.2）；
//   · `.sigstore.json` bundle 与内置 TUF 根同理；
//   · 于是 `resolveCurrent()` 的六步验证链，本站点**一步都没跑**。
//
// 🔴 所以四格恒为 `none`（虚线圈、`--c-text-dim`），并在下方写明"这不是加载中"。
//    §7.2 那句「默认状态是 none，不是 ok」在这里不是默认值，是**终值**。
//    §7.11 让空状态的四格全 ok 来"演示信任链跑得通"—— 那条**不采纳**：
//    我们没跑，画成 ok 就是撒谎，而这个站点整套设计的前提就是不撒谎。
//
// 🔴 四格**不许合并成一个綜合勾**。一个综合勾会掩盖到底哪一环成立，
//    而"哪一环没成立"正是这个站点存在的理由 —— 对我们来说答案是"一环都没跑"。

import { Icon } from './icons';
import { Digest, DigestShort } from './digest';
import { formatBytes } from '../lib/format';

/** 验证轴的四态。🔴 与生命周期轴（badges.jsx 的 STATUS）刻意不共用任何东西。 */
const VERDICT = {
  ok: { icon: 'check', word: 'verified' },
  warn: { icon: 'bang', word: 'stale' },
  bad: { icon: 'fail', word: 'failed' },        // 圈叉，不是裸叉
  none: { icon: 'unverified', word: 'unverified' },
};

function ChainCell({ verdict, name, children }) {
  const v = VERDICT[verdict];
  return (
    <div>
      <span className={`st ${verdict}`}><Icon name={v.icon} />{v.word}</span>
      <div className="cellname">{name}</div>
      <div className="v">{children}</div>
    </div>
  );
}

/**
 * @param {object} p
 * @param {object} p.data     站点数据（含 source）
 * @param {object} [p.artifact] 给了就在第 3 格显示这条 record 的树摘要
 */
export function TrustChain({ data, artifact, n = '01' }) {
  return (
    <section className="section" aria-labelledby="chain-heading">
      <div className="sechead">
        <span className="label">{n}</span>
        <h2 id="chain-heading">验证链</h2>
        <span className="label">verification axis</span>
      </div>
      <div className="chain">
        <ChainCell verdict="none" name="签名身份">本站点没有读取 Sigstore bundle</ChainCell>
        <ChainCell verdict="none" name="Rekor 条目">没有查询透明日志</ChainCell>
        <ChainCell verdict="none" name="树摘要">
          {artifact ? <DigestShort value={artifact.tree_digest} /> : '逐条 record 各自记录'}
        </ChainCell>
        <ChainCell verdict="none" name="快照时效">
          {data.empty ? '没有快照' : `hub-${data.source.internal_number}`} · 没有 timestamp
        </ChainCell>
      </div>
      <p className="note">
        四格<strong>全部是「未验证」，这不是加载中，也不会变</strong>：本站点是构建期渲染的静态页，
        它没有 timestamp、没有 Sigstore bundle、没有内置 TUF 根，
        因此 02-registry.md §6 的验证链<strong>一步都没跑</strong>。
        虚线圈的意思是「我们没验」，不是「验了没过」——
        后者是圈叉，两个图形在本站点刻意不同形。
        要真的验，用 CLI（它没有 <code className="mono">--no-verify</code>，也没有 <code className="mono">--insecure</code>）。
      </p>
    </section>
  );
}

/** 台账里那些「本站点根本没读」的行 —— 缺席要**看得见**，不是省略。 */
function NotRead({ what }) {
  return (
    <>
      <span className="dim">本站点未读取</span>
      <span className="sub">{what}</span>
    </>
  );
}

/**
 * 信任台账。🔴 **值永远原样给**，不缩写、不美化：
 * `refs/heads/main` 不显示成「main 分支」，完整 URL 不缩成「GitHub Actions」。
 */
export function TrustLedger({ data, artifact, n = '02' }) {
  const s = data.empty ? null : data.source;
  return (
    <section className="section" aria-labelledby="ledger-heading">
      <div className="sechead">
        <span className="label">{n}</span>
        <h2 id="ledger-heading">信任台账</h2>
        <span className="label">provenance of this page</span>
      </div>
      <div className="panel">
        <header>
          <h3>这一页的每个值是谁说的</h3>
          <span className="spacer" />
          <span className="label">source of record</span>
        </header>
        <dl className="ledger">
          <dt className="cn">签名身份</dt>
          <dd><NotRead what="真验签时这里是 release.yml 的完整 identity 字符串；它与 timestamp.yml 是两个身份，精确比对、不可互换、不做前缀匹配。" /></dd>

          <dt className="cn">OIDC issuer</dt>
          <dd><NotRead what="真验签时这里是 https://token.actions.githubusercontent.com 的完整字符串。" /></dd>

          <dt className="cn">Rekor 条目</dt>
          <dd><NotRead what="透明日志是公开的：任何人都能独立取回同一条条目，不需要经过本站 —— 而本站确实没去取。" /></dd>

          {artifact ? (
            <>
              <dt className="cn">树摘要</dt>
              <dd>
                <Digest value={artifact.tree_digest} label="树摘要" />
                <span className="sub">
                  覆盖载荷全部文件的 路径 + mode + 字节。本页只是把快照里的这个值转述一遍。
                </span>
                <div className="recheck"><span className="prompt">$</span>skills-hub verify {artifact.id} --print-tree-digest</div>
              </dd>

              <dt className="cn">资产摘要</dt>
              <dd>
                <Digest value={artifact.asset.sha256} label="资产摘要" dim />
                <span className="sub">
                  <code className="mono">{artifact.asset.file}</code> · {formatBytes(artifact.asset.size)}
                </span>
                <div className="recheck"><span className="prompt">$</span>shasum -a 256 {artifact.asset.file}</div>
              </dd>
            </>
          ) : null}

          <dt className="cn">快照来源</dt>
          <dd>
            {s === null
              ? <span className="dim">还没有任何一张快照</span>
              : (
                <>
                  <code className="mono">{s.file_name}</code>
                  （previous <code className="mono">hub-{data.snapshot.previous}</code>）
                  · created_at <code className="mono">{data.snapshot.created_at}</code>
                  <span className="sub">
                    文件字节 <code className="mono">{s.sha256}</code> · {formatBytes(s.bytes)}。
                    文件名里的编号是 {s.file_number}，快照内部声明的是 {s.internal_number}
                    {s.number_agrees ? '（一致，但没有 timestamp 能说最新是第几张，一致只表示文件自洽）' : '（不一致 —— 本站点不替你判哪个对）'}。
                  </span>
                  <span className="sub">
                    快照里<strong>不含</strong>生成它自己的 commit SHA（那会自引用）。
                  </span>
                </>
              )}
          </dd>

          <dt className="cn">Attestation</dt>
          <dd><NotRead what="hub-<N>.intoto.jsonl（DSSE）是取证输入，安装链路本来就不读它；本站点也没读。它的 workflowRef 必须钉到 40 位 commit，与上面「签名身份」用的 @refs/heads/main 不是一回事，不要「统一」它们。" /></dd>

          {artifact ? (
            <>
              <dt className="cn">审批</dt>
              <dd>
                PR <code className="mono">#{artifact.review.pr}</code>
                {' · '}批准人 <code className="mono">{artifact.review.approved_by.join(' · ') || '（空）'}</code>
                <div style={{ marginTop: 'var(--sp-2)' }}>
                  <Digest value={artifact.review.head_sha} label="head_sha" dim />
                </div>
                <span className="sub">
                  head_sha 指向投稿 PR 的 head，早于本快照存在，因此允许出现，不构成自引用。
                  这一栏只是快照里记下的 login 串：它证明不了「该人是维护者」「该 approve 针对的是这个 head_sha」
                  「approve 当前仍有效」—— 那三件事只有 GitHub 答得了。
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}
