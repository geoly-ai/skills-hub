// pack 成员表 + 「被谁拖累」。规格：DESIGN.md §7.9。
//
// 🔴 **成员列表不在快照里。** record 的键集里没有 `members` / `bundled` —— 它们在
//    载荷的 `pack.json` 里。所以这一整节只有在载荷核对通过时才画，且始终标明来源。
//
// 🔴 **拖累关系不做成表里的一列**，它是一句因果，用一条横贯表宽的 `.blameline`
//    单独占一行：`<被 yank 的成员> ⟶ <它是必装成员> ⟶ <所以本 pack degraded>`。
//    做成一列会让读者以为那是每个成员各自的属性，而它其实是**整个 pack 的结论**。

import { Notice } from './primitives';
import { DigestShort } from './digest';
import { PayloadNotice } from './payload-notice';

export function PackDetails({ artifact: a }) {
  const p = a.pack;
  return (
    <section className="section" aria-labelledby="pack-heading">
      <div className="sechead">
        <span className="label">06</span>
        <h2 id="pack-heading">pack 成员</h2>
        <span className="label">not in snapshot record</span>
      </div>

      <PackDerivationRules />

      {/* 🔴 成员来源用**本地比对轴**的表皮（等号），不是验证轴的勾 ——
             成员表能不能信，取决于载荷字节和 record 是不是同一串，与验签无关。 */}
      {!p.members_available
        ? <Notice tone="compare-none" icon="nodata" id="pack-nomembers" title="拿不到成员列表"><p>{p.note}</p></Notice>
        : (
          <>
            <PayloadNotice payload={{ state: a.payload.state, note: p.note }} id="pack-source" />
            <MemberTable pack={p} artifact={a} />
            <DerivedCheck artifact={a} derived={p.derived} />
          </>
        )}
    </section>
  );
}

/** 🔴 两个口径**不一样**，是 §11 点名最容易抄错的一处，所以直接印在页面上。 */
function PackDerivationRules() {
  return (
    <div className="panel">
      <header><h3>pack 的三条派生口径</h3></header>
      <dl className="ledger">
        <dt className="cn">成员锁定</dt>
        <dd>精确版本 + 精确树摘要，<strong>不接受 semver range</strong>（range 意味着装的时候才知道装到什么）。</dd>
        <dt className="cn">clients</dt>
        <dd>全体 <code className="mono">members</code> 的<strong>交集</strong>。
          <span className="sub"><code className="mono">bundled</code> 不参与 —— 它可以被 <code className="mono">--no-bundled</code> 跳过。</span></dd>
        <dt className="cn">capabilities</dt>
        <dd><code className="mono">members</code> + <code className="mono">bundled</code> 的<strong>并集</strong>；pack 的 Tier 取该并集对应的最高档。
          <span className="sub">与 clients 口径不同：一个含 bundled，一个不含。</span></dd>
      </dl>
    </div>
  );
}

function MemberTable({ pack, artifact }) {
  const rows = [
    ...pack.members.map((m) => ({ ...m, required: true })),
    ...pack.bundled.map((m) => ({ ...m, required: false })),
  ];
  // 🔴 **整行染红的判据是「这个成员被 yank 了」，不是「它拖累了本 pack」。**
  //    按 degraded_by 判会漏掉 bundled 里被 yank 的成员 —— 它不进 degraded_by
  //    （bundled 不拖垮 pack），但它确实被撤回了，§7.9 要求整行 --t-revoked。
  //    两件事分开：染红 = 成员自身状态；`.blameline` = 它对本 pack 的因果影响。
  return (
    <>
      <div className="tablescroll">
        <table className="members">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col" className="cn">成员</th>
              <th scope="col">role</th>
              <th scope="col" className="cn">tree_digest（pack.json 锁定）</th>
              <th scope="col" className="cn">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={m.id} className={m.status === 'yanked' ? 'blame' : (m.required ? undefined : 'skipped')}>
                <td className="mono dim">{i + 1}</td>
                <th scope="row" className="mono" style={{ fontWeight: 400, textAlign: 'left' }}>{m.id}</th>
                <td className="role">
                  {m.required ? `${m.role} · 必装` : `${m.role} · --no-bundled 可跳过`}
                </td>
                <td>
                  <DigestShort value={m.locked_tree_digest} />
                  {m.digest_matches === false
                    ? <div className="sub" style={{ color: 'var(--c-revoked)' }}>与快照 record 不一致 —— 完整性事件</div>
                    : null}
                </td>
                <td>{m.in_snapshot ? m.status : <span style={{ color: 'var(--c-revoked)' }}>不在快照里</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Blame pack={pack} artifact={artifact} />
    </>
  );
}

/** degraded 归因：用与 promotion **同一个**闭包算法复算（pack.mjs 的 computePackStatusClosure）。 */
function Blame({ pack, artifact }) {
  const b = pack.blame;
  if (!b) return null;
  if (b.error) {
    return <Notice tone="deprecated" icon="bang" id="blame-error" title="成员图复算失败"><p>{b.error}</p></Notice>;
  }
  const reasonText = (r) => ({
    yanked: '已被 yank',
    missing: '不在快照里',
    degraded: '它自己是个 degraded 的 pack',
  }[r] ?? r);

  return (
    <>
      {b.degraded_by.map((d) => (
        <div className="blameline" key={d.id}>
          <span className="mono">{d.id}</span>
          <span className="arrow" aria-hidden="true">⟶</span>
          <span>{reasonText(d.reason)}，且它是 role <span className="mono">{d.role}</span> 的必装成员</span>
          <span className="arrow" aria-hidden="true">⟶</span>
          <span>所以 <span className="mono">{artifact.id}</span> 这一版是 degraded</span>
        </div>
      ))}
      {b.skipped_bundled.map((d) => (
        <div className="blameline" key={d.id}>
          <span className="mono">{d.id}</span>
          <span className="arrow" aria-hidden="true">⟶</span>
          <span>{reasonText(d.reason)}，但它是 bundled</span>
          <span className="arrow" aria-hidden="true">⟶</span>
          <span>只会被跳过并告警，<strong>不拖垮本 pack</strong></span>
        </div>
      ))}

      <p className="note">
        用与 promotion <strong>同一个</strong>闭包算法在本次构建拿到的成员图上复算：
        结果 <strong>{b.recomputed_status ?? '未知'}</strong>，快照写的是 <strong>{artifact.status}</strong>
        {b.matches_snapshot === true ? '（一致）' : b.matches_snapshot === false ? '（不一致）' : ''}。
        {' '}degraded 只对<strong>本版本锁定的必装成员</strong>成立：pack 不可变，每个版本锁的成员不同，
        不能从这一版推出别的版本也 degraded。
      </p>

      {b.matches_snapshot === false
        ? (
          <Notice tone="compare-bad" icon="unequal" id="blame-mismatch" title="复算结果与快照的 status 不一致">
            <p>
              快照那一侧是被签名分发的对象（<strong>本页没有验它的签</strong>）；
              复算这一侧的输入是工作树载荷，谁都能改，担保更弱。
              两个结论都摆在这里，本站点不下「谁错了」的判断。
            </p>
          </Notice>
        )
        : null}

      {b.complete
        ? null
        : (
          <Notice tone="deprecated" icon="bang" id="blame-partial" title="这只是部分归因，不是完整原因">
            <p>
              下面这些嵌套 pack 的载荷本次拿不到，成员图没走全，所以上面的清单<strong>可能不完整</strong>：
              {' '}<span className="mono">{b.opaque_packs.join(' · ')}</span>
            </p>
          </Notice>
        )}
    </>
  );
}

/**
 * clients 交集 / capabilities 并集的**独立复算**。
 * 展示的始终是 record 里那两个（promotion 算的、写在被签名分发的快照里，本页未验签）；
 * 复算只回答「按同一条规则还能不能算出同一个答案」，对不上时两个都摆出来，不静默择一。
 */
function DerivedCheck({ artifact: a, derived }) {
  if (!derived || derived.available !== true) {
    return (
      <Notice tone="compare-none" icon="nodata" id="derived-na" title="派生字段无法复算">
        <p>{derived?.reason ?? '缺少复算所需的成员 record。'}</p>
      </Notice>
    );
  }
  return (
    <div className="tablescroll">
      <table className="members">
        <thead>
          <tr>
            <th scope="col" className="cn">字段</th>
            <th scope="col" className="cn">快照 record（promotion 算的）</th>
            <th scope="col" className="cn">本站点按同一规则复算</th>
            <th scope="col" className="cn">一致</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" style={{ textAlign: 'left' }}>clients<div className="sub">members 的交集</div></th>
            <td className="mono">{a.clients.join(' · ') || '（空）'}</td>
            <td className="mono">{derived.clients.join(' · ') || '（空）'}</td>
            <td>{derived.clients_match ? '是' : <strong style={{ color: 'var(--c-revoked)' }}>否</strong>}</td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: 'left' }}>capabilities<div className="sub">members + bundled 的并集</div></th>
            <td className="mono">{a.capabilities.map((c) => c.name).join(' · ') || '（空）'}</td>
            <td className="mono">{derived.capabilities.join(' · ') || '（空）'}</td>
            <td>{derived.capabilities_match ? '是' : <strong style={{ color: 'var(--c-revoked)' }}>否</strong>}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
