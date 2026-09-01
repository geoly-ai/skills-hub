import Link from 'next/link';

import { StatusMark, TierBadge, Tag, Aid } from './badges';
import { DigestShort } from './digest';
import { formatBytes } from '../lib/format';

/**
 * 列表里的一条制品 —— 一条**台账行**，不是卡片：无阴影、无外边距间隙、
 * 靠 1px 分隔线连成一片（DESIGN.md §2、§7.4）。
 *
 * 四行结构：身份行 / 描述行 / 事实行 / 徽章行。
 *
 * 🔴 **事实行的四项就是四项，没有第五项可放使用情况。** 排序也因此只有 id 字节序 ——
 *    没有"热门"可排，那类数字我们根本没有。
 */
export function ArtifactCard({ artifact: a }) {
  const cls = ['card'];
  if (a.status === 'yanked') cls.push('is-yanked');
  if (a.status === 'degraded') cls.push('is-degraded');

  return (
    <li>
      <div className={cls.join(' ')}>
        <div className="card-r1">
          <Link href={a.href} style={{ border: 0 }}><Aid artifact={a} /></Link>
          <StatusMark status={a.status} />
          {a.is_latest ? <Tag current>latest</Tag> : null}
          {a.is_prerelease ? <Tag>prerelease · 需 --pre</Tag> : null}
        </div>

        {a.description
          ? <p className="card-desc">{a.description}</p>
          : <p className="card-desc dim">快照 record 不含 description；本次构建也没有可核对的载荷。</p>}

        <div className="card-facts">
          <span className="fact">
            <span className="k cn">出处</span>
            <span className="v">{a.provenance.kind}</span>
          </span>
          <span className="fact">
            <span className="k cn">审批</span>
            <span className="v">PR #{a.review.pr} · {a.review.approved_by.length} 人</span>
          </span>
          <span className="fact">
            <span className="k">tree</span>
            <span className="v"><DigestShort value={a.tree_digest} /></span>
          </span>
          <span className="fact">
            <span className="k">asset</span>
            <span className="v">{formatBytes(a.asset.size)}</span>
          </span>
        </div>

        <div className="card-badges">
          <TierBadge
            tier={a.declared_tier}
            capabilities={a.capabilities.map((c) => c.name)}
            note="Tier 由本站点按 06-submission.md §7 的表算出；快照里另有 review.capability_tier"
          />
          <span className="fact">
            <span className="k">clients</span>
            <span className="v">{a.clients.join(' · ') || '（空）'}</span>
          </span>
          <span className="fact">
            <span className="k">license</span>
            <span className="v">{a.license}</span>
          </span>
        </div>

        {/* 非 geoly namespace 的 Tier 1/2：安装时会强制确认，这一条要在卡片上就说 */}
        {a.namespace !== 'geoly' && (a.declared_tier === 1 || a.declared_tier === 2)
          ? (
            <p className="card-desc dim" style={{ marginBottom: 0 }}>
              非 geoly namespace 的 Tier {a.declared_tier} 制品：安装时会强制展示 capability 并要求确认；
              <code className="mono">--yes</code> 可跳过，但跳过会写进账本。
            </p>
          )
          : null}
      </div>
    </li>
  );
}
