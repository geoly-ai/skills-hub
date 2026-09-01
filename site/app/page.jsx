import Link from 'next/link';

import { getSiteData } from '../lib/site-data';
import { TrustChain, TrustLedger } from '../components/trust';
import { Distribution, Notice, Recheck } from '../components/primitives';
import { StatusMark } from '../components/badges';

/**
 * 首页。
 *
 * 🔴 **空状态就是首页本身，不是缺省页**（DESIGN.md §7.11）。registry 现在一个制品都没有，
 *    这个状态会被看很久，必须能独立成立：全部左对齐、不居中、没有插画、没有骨架屏。
 */
export default function OverviewPage() {
  const data = getSiteData();
  return data.empty ? <EmptyRegistry data={data} /> : <Overview data={data} />;
}

/**
 * ⚠️ **与 DESIGN.md §7.11 的一处实质偏离，理由留在这里。**
 *
 * 规格的空状态主句是「这张快照是空的，而它是被签过名的空」，并让信任链条四格全 ok，
 * 把空 registry 当成整条信任链的活演示。**这里做不到，也不能假装做得到**：
 *   · 仓库里**连一张快照都还没有**（`registry/snapshots/` 目录本身不存在），
 *     所以没有"被签过名的空"这个对象可指；
 *   · 本站点不验签（见 components/trust.jsx），四格画成 ok 就是撒谎。
 * 于是主句改成如实的那一句，链条照旧四格未验证。
 */
function EmptyRegistry({ data }) {
  return (
    <div className="page">
      <div className="empty">
        <div className="top">
          <p className="label">geoly-ai/skills-hub · registry</p>
          <h2>一个制品都没有，连一张快照都还没有。</h2>
          <p className="lede">
            这不是加载失败，也不是筛选筛空了：{data.empty_reason}。
            promotion 从来没有跑成功过一次，所以 <code className="mono">registry/snapshots/</code> 里
            没有任何 <code className="mono">hub-&lt;N&gt;.json</code> 可读。
          </p>
          <p className="lede">
            这是仓库<strong>有意</strong>的 fail-closed 状态，不是故障 —— 见右侧那三件还没做的事。
          </p>
          <div className="zerocount">
            <span className="num">0</span>
            <span className="cap">
              artifacts · 0 snapshots · 0 yanked · 没有 latest 映射
              <br />
              <span className="dim">这是全站唯一的大号数字，而它是 0 —— 恰好和「我们不展示使用情况指标」自洽。</span>
            </span>
          </div>
        </div>

        <div className="cols">
          <div>
            <p className="label-cn">现在就能做的事</p>
            <p className="note">
              CLI 里<strong>没有</strong> <code className="mono">--no-verify</code>，
              也<strong>没有</strong> <code className="mono">--insecure</code>：
              验签器没接上时它直接拒绝运行，而不是放行。
            </p>
            <Recheck>skills-hub snapshot --verify --explain</Recheck>
            <Recheck>skills-hub search &apos;&apos; --json</Recheck>
            <p className="note dim">
              这两条现在都会告诉你「没有可指向的快照」—— 那正是当前的真实状态。
            </p>
          </div>

          <div>
            <p className="label-cn">上线前置：还差三件事</p>
            <p className="note dim">出处：docs/m3/02-decisions.md「等你的三件事」</p>
            <ol className="pipeline">
              {data.prerequisites.map((p, i) => (
                <li key={p.title}>
                  <span className="dot" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <div className="s">{p.title}</div>
                    <div className="d">{p.body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <Notice tone="neutral" icon="block" id="failclosed" title="在这三件做完之前，什么都发布不出来">
        <p>{data.empty_note}</p>
      </Notice>

      <TrustChain data={data} n="01" />
      <TrustLedger data={data} n="02" />
    </div>
  );
}

function Overview({ data }) {
  const s = data.snapshot;
  const d = data.distributions;
  return (
    <div className="page">
      <header className="titleblock">
        <p className="label">geoly-ai/skills-hub · registry ledger</p>
        <h1>hub-{s.snapshot}</h1>
        <p className="note">
          上一张 <code className="mono">hub-{s.previous}</code> ·
          created_at <code className="mono">{s.created_at}</code> ·
          schema <code className="mono">{s.schema}</code>
        </p>
      </header>

      <TrustChain data={data} n="01" />

      <section className="section" aria-labelledby="counts-heading">
        <div className="sechead">
          <span className="label">02</span>
          <h2 id="counts-heading">数出来的</h2>
          <span className="label">counted, not measured</span>
        </div>
        <div className="panel">
          <dl className="ledger">
            <dt className="cn">制品条目</dt>
            <dd className="mono">{s.artifact_count}<span className="sub">每个版本各算一条</span></dd>
            <dt className="cn">不同的制品</dt>
            <dd className="mono">{data.groups.length}<span className="sub">按 kind:namespace/name 计</span></dd>
            <dt className="cn">有 latest 可指</dt>
            <dd className="mono">{s.latest_count}<span className="sub">latest 排除 yanked / degraded / 预发布；deprecated 可以进</span></dd>
            <dt className="cn">已 yank</dt>
            <dd className="mono">{s.yanked_count}</dd>
          </dl>
        </div>
        <p className="note dim">
          这一页上的每个数字都是从快照里数出来的 —— 数的是 record 条数，
          不是任何形式的使用情况。为什么没有使用情况，见页脚。
        </p>
      </section>

      <section className="section" aria-labelledby="dist-heading">
        <div className="sechead">
          <span className="label">03</span>
          <h2 id="dist-heading">分布</h2>
        </div>
        <div className="grid2">
          <DistPanel title="kind" rows={d.kind} />
          <DistPanel title="namespace" rows={d.namespace} />
          <DistPanel title="status" rows={d.status} hint="生命周期轴" />
          <DistPanel title="capability" rows={d.capability} hint="同一条 record 内先去重再计数" />
          <DistPanel title="client" rows={d.client} />
          <DistPanel title="declared tier" rows={d.declared_tier} hint="本站点按 §7 那张表算的，不是 review.capability_tier" />
        </div>
      </section>

      {data.yanked.length > 0 ? (
        <section className="section" aria-labelledby="yank-heading">
          <div className="sechead">
            <span className="label">04</span>
            <h2 id="yank-heading">已 yank</h2>
            <span className="label">{data.yanked.length} entries</span>
          </div>
          <div className="tablescroll">
            <table className="members">
              <thead>
                <tr>
                  <th scope="col">id</th>
                  <th scope="col">at</th>
                  <th scope="col">reason</th>
                  <th scope="col">advisory</th>
                  <th scope="col">superseded_by</th>
                </tr>
              </thead>
              <tbody>
                {data.yanked.map((y) => (
                  <tr key={y.id} className="blame">
                    <th scope="row" className="mono" style={{ fontWeight: 400, textAlign: 'left' }}>
                      {y.href ? <Link href={y.href}>{y.id}</Link> : y.id}
                    </th>
                    <td className="mono">{y.at}</td>
                    <td>{y.reason}</td>
                    <td className="mono">{y.advisory ?? <span className="dim">未给（可选字段）</span>}</td>
                    <td className="mono">{y.superseded_by ?? <span className="dim">未声明</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note dim">
            <StatusMark status="yanked" /> 不删文件、不强制卸载已装实例；
            它是「默认拒绝新装」，显式 <code className="mono">--allow-yanked</code> 仍可继续，
            但会写进安装账本。
          </p>
        </section>
      ) : null}

      <TrustLedger data={data} n="05" />

      <p><Link href="/artifacts/">检索全部 {s.artifact_count} 条 record →</Link></p>
    </div>
  );
}

function DistPanel({ title, rows, hint }) {
  return (
    <div className="panel">
      <header>
        <h3>{title}</h3>
        <span className="spacer" />
        {hint ? <span className="label-cn">{hint}</span> : null}
      </header>
      <div className="body"><Distribution rows={rows} caption={`按 ${title} 的分布`} /></div>
    </div>
  );
}
