import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getSiteData, getArtifacts, findArtifact } from '../../../../../../lib/site-data';
import { formatBytes } from '../../../../../../lib/format';
import { TrustChain, TrustLedger } from '../../../../../../components/trust';
import { StatusMark, TierBadge, Tag, Aid } from '../../../../../../components/badges';
import { Digest } from '../../../../../../components/digest';
import { Notice, Recheck, StringList } from '../../../../../../components/primitives';
import { StatusNotice } from '../../../../../../components/status-notice';
import { Provenance } from '../../../../../../components/provenance';
import { PackDetails } from '../../../../../../components/pack-details';
import { PayloadNotice } from '../../../../../../components/payload-notice';

export const dynamicParams = false;

export function generateStaticParams() {
  return getArtifacts().map((a) => ({
    kind: a.kind, namespace: a.namespace, name: a.name, version: a.version,
  }));
}

/**
 * 制品详情页。
 *
 * 🔴 **纵向顺序即优先级，不许调**（DESIGN.md §7.1）：
 *    标识 → 状态警示 → 验证链 → 信任台账 → 出处 → 安装 → 描述 → record 全字段 → 成员。
 * 🔴 **全站不设右侧 metadata 栏。** 一旦有右栏，信任信息就会被塞进去然后降级成脚注 ——
 *    那是 npm 的做法，本设计明确反对的第一条。
 */
export default async function ArtifactPage({ params }) {
  const { kind, namespace, name, version } = await params;
  const data = getSiteData();
  const a = findArtifact({ kind, namespace, name, version });
  if (a === undefined) notFound();

  return (
    <div className="page">
      <nav className="breadcrumb" aria-label="面包屑">
        <Link href="/">ledger</Link>
        <span className="sep">/</span>
        <Link href="/artifacts/">artifacts</Link>
        <span className="sep">/</span>
        <Link href={a.group_href}>{a.group_key}</Link>
        <span className="sep">/</span>
        <span>{a.version}</span>
      </nav>

      {/* 1 · 标识 + 生命周期轴 + Tier */}
      <header className="titleblock">
        <h1><Aid artifact={a} /></h1>
        <div className="marks">
          <StatusMark status={a.status} />
          {a.is_latest ? <Tag current>latest</Tag> : null}
          {a.is_prerelease ? <Tag>prerelease · 默认不解析，需 --pre</Tag> : null}
          <TierBadge tier={a.declared_tier} capabilities={a.capabilities.map((c) => c.name)} />
        </div>
      </header>

      {/* 2 · 状态警示条 */}
      <StatusNotice artifact={a} />

      {/* 3 · 验证链（🔴 验证轴，与上面的 status 正交）*/}
      <TrustChain data={data} artifact={a} />

      {/* 4 · 信任台账 */}
      <TrustLedger data={data} artifact={a} />

      {/* 5 · 出处 */}
      <section className="section" aria-labelledby="prov-heading">
        <div className="sechead">
          <span className="label">03</span>
          <h2 id="prov-heading">出处</h2>
          <span className="label">provenance</span>
        </div>
        <Provenance provenance={a.provenance} treeDigest={a.tree_digest} />
      </section>

      {/* 6 · 安装 */}
      <section className="section" aria-labelledby="install-heading">
        <div className="sechead">
          <span className="label">04</span>
          <h2 id="install-heading">安装</h2>
        </div>
        <Recheck>skills-hub install {a.id}</Recheck>
        {a.status === 'yanked' || a.status === 'degraded'
          ? (
            <p className="note">
              {a.status === 'yanked'
                ? <>这条命令<strong>默认会被拒绝</strong>（该版本已被 yank），显式 <code className="mono">--allow-yanked</code> 才能继续，且会写进安装账本。</>
                : <>这条命令<strong>装不了</strong>：该 pack 是 degraded，而 <code className="mono">--allow-yanked</code> 不放行 degraded。</>}
            </p>
          )
          : null}
        <p className="note dim">
          措辞一律是「截至 <code className="mono">hub-{data.source.internal_number}</code>」——
          本站点没有 timestamp，说不了「现在」。
        </p>
      </section>

      {/* 7 · 描述（🔴 来源标记贴着内容，不放到页面末尾）*/}
      <section className="section" aria-labelledby="desc-heading">
        <div className="sechead">
          <span className="label">05</span>
          <h2 id="desc-heading">描述与 record 全字段</h2>
        </div>
        <PayloadNotice payload={a.payload} />
        {a.description
          ? (
            <p className="prose">
              {a.description}
              {' '}
              <span className="dim">（来自载荷 manifest，<strong>不在快照 record 里</strong>）</span>
            </p>
          )
          : <p className="prose dim">快照 record 不含 description；本次构建也没有可核对的载荷。</p>}

        <div className="panel">
          <header><h3>快照 record 逐字段</h3><span className="spacer" /><span className="label">signed fields</span></header>
          <dl className="ledger">
            <dt>id</dt><dd className="mono">{a.id}</dd>
            <dt>kind</dt><dd className="mono">{a.kind}</dd>
            <dt>namespace</dt><dd className="mono">{a.namespace}</dd>
            <dt>name</dt><dd className="mono">{a.name}</dd>
            <dt>version</dt><dd className="mono">{a.version}</dd>
            <dt>path</dt><dd className="mono">{a.path}</dd>
            <dt>license</dt><dd className="mono">{a.license}</dd>
            <dt>status</dt><dd><StatusMark status={a.status} /></dd>
            <dt>tree_digest</dt><dd><Digest value={a.tree_digest} label="树摘要" /></dd>
            <dt>asset.file</dt><dd className="mono">{a.asset.file}</dd>
            <dt>asset.sha256</dt><dd><Digest value={a.asset.sha256} label="资产摘要" dim /></dd>
            <dt>asset.size</dt><dd className="mono">{formatBytes(a.asset.size)}</dd>
            <dt>clients</dt>
            <dd>
              <StringList values={a.clients} />
              <span className="sub">{a.kind === 'pack' ? '成员 clients 的交集，由 promotion 算（bundled 不参与）' : '载荷 manifest 声明'}</span>
            </dd>
            <dt>capabilities</dt><dd><CapabilityTable artifact={a} /></dd>
            <dt>replaces</dt><dd><StringList values={a.replaces} /></dd>
            <dt>conflicts</dt><dd><StringList values={a.conflicts} /></dd>
            <dt>owner</dt>
            <dd>
              <span className="mono">{a.owner.kind} · {a.owner.login}</span>
              <span className="sub">不可变 node id <code className="mono">{a.owner.id}</code></span>
            </dd>
          </dl>
        </div>
      </section>

      {/* 8 · pack 成员 */}
      {a.pack ? <PackDetails artifact={a} /> : null}
    </div>
  );
}

/**
 * capability 与 Tier。
 * 🔴 两个 Tier **并列摆出来，不合并成一个数** —— 它们回答的是不同的问题，
 *    合法地可以不相等（contract_paths 变更强制 Tier 2、pack 在自动门里一律按 Tier 2）。
 */
function CapabilityTable({ artifact: a }) {
  const same = a.declared_tier === a.review.capability_tier;
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', marginBottom: 'var(--sp-2)' }}>
        {a.capabilities.length === 0
          ? <span className="dim">空数组</span>
          : a.capabilities.map((c) => (
            <TierBadge key={c.name} tier={c.tier} capabilities={[c.name]} />
          ))}
      </div>
      <span className="sub">
        capabilities 按 §7 那张表算出：<strong>Tier {a.declared_tier ?? '?'}</strong>；
        快照 <code className="mono">review.capability_tier</code> 记的是 <strong>Tier {a.review.capability_tier}</strong>。
        {same
          ? ' 两者一致。'
          : ' 两者不相等 —— 这不一定是问题：contract_paths 变更强制 Tier 2（D8），pack 在自动门里一律按 Tier 2 处理（fail-safe）。本站点不判哪个对。'}
      </span>
      <span className="sub">
        §7 的表：<code className="mono">none</code> → Tier 0；
        <code className="mono">network</code> / <code className="mono">external-tool</code> → Tier 1；
        <code className="mono">shell</code> / <code className="mono">credentials</code> / <code className="mono">writes-repo</code> → Tier 2。
        表里没有的能力名一律按最高档处理。
      </span>
    </>
  );
}
