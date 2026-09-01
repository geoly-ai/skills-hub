import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getSiteData, getGroups, findGroup } from '../../../../../lib/site-data';
import { TrustChain } from '../../../../../components/trust';
import { ArtifactCard } from '../../../../../components/artifact-card';
import { LatestNotice } from '../../../../../components/status-notice';

export const dynamicParams = false;

export function generateStaticParams() {
  return getGroups().map((g) => ({ kind: g.kind, namespace: g.namespace, name: g.name }));
}

/**
 * 同名制品的版本历史。快照的 `artifacts` 里带着**全部版本**，所以这一页不需要别的数据源。
 *
 * 🔴 pack 的 degraded **逐版本列出**各自被哪个成员拖累（DESIGN.md §7.9 末段）：
 *    pack 不可变，每个版本锁的成员不同，不能从一版推出全部版本。
 */
export default async function GroupPage({ params }) {
  const { kind, namespace, name } = await params;
  const data = getSiteData();
  const group = findGroup({ kind, namespace, name });
  if (group === undefined) notFound();

  const excluded = group.versions.filter(
    (v) => v.status === 'yanked' || v.status === 'degraded' || v.is_prerelease,
  );

  return (
    <div className="page">
      <nav className="breadcrumb" aria-label="面包屑">
        <Link href="/">ledger</Link>
        <span className="sep">/</span>
        <Link href="/artifacts/">artifacts</Link>
        <span className="sep">/</span>
        <span>{group.key}</span>
      </nav>

      <header className="titleblock">
        <h1>{group.key}</h1>
        <p className="note">
          快照 hub-{data.source.internal_number} 里的 {group.versions.length} 个版本，按 semver 从新到旧。
        </p>
      </header>

      <LatestNotice group={group} />

      <section className="section" aria-labelledby="versions-heading">
        <div className="sechead">
          <span className="label">01</span>
          <h2 id="versions-heading">版本</h2>
          <span className="label">{group.versions.length} records</span>
        </div>
        <ul className="list">
          {group.versions.map((a) => <ArtifactCard key={a.id} artifact={a} />)}
        </ul>
      </section>

      {excluded.length > 0 ? (
        <section className="section" aria-labelledby="excl-heading">
          <div className="sechead">
            <span className="label">02</span>
            <h2 id="excl-heading">逐版本：谁被 latest 排除，为什么</h2>
          </div>
          <div className="tablescroll">
            <table className="members">
              <thead>
                <tr>
                  <th scope="col" className="cn">版本</th>
                  <th scope="col">status</th>
                  <th scope="col" className="cn">被排除的原因</th>
                </tr>
              </thead>
              <tbody>
                {excluded.map((v) => (
                  <tr key={v.id}>
                    <th scope="row" className="mono" style={{ fontWeight: 400, textAlign: 'left' }}>
                      <Link href={v.href}>{v.version}</Link>
                    </th>
                    <td className="mono">{v.status}</td>
                    <td>{exclusionReason(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note dim">
            <strong>deprecated 不在这张表里</strong>：它可以进入 latest。
            latest 排除的是 yanked、degraded 与预发布三类。
          </p>
        </section>
      ) : null}

      <TrustChain data={data} n={excluded.length > 0 ? "03" : "02"} />
    </div>
  );
}

function exclusionReason(v) {
  if (v.status === 'yanked') {
    return <>被 yank：{v.yank?.reason ?? '（快照未给 reason）'}</>;
  }
  if (v.status === 'degraded') {
    const by = v.pack?.blame?.degraded_by ?? [];
    return by.length > 0
      ? <>degraded —— 本版本锁定的必装成员 <span className="mono">{by.map((d) => d.id).join('、')}</span> 出了问题</>
      : <>degraded —— 快照没有 degraded_by 字段，本次构建也拿不到载荷，说不出是哪个成员</>;
  }
  return <>预发布版本，默认不解析（需 <code className="mono">--pre</code>）</>;
}
