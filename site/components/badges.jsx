// 状态标记（生命周期轴）与 capability 徽章（Tier）。规格：DESIGN.md §0.1、§7.5。
//
// 🔴 **这个文件里只有生命周期轴。** 验证轴在 components/trust.jsx 的 `TrustChain` 里，
//    两者刻意不共用任何组件、任何图标、任何颜色映射函数 ——
//    共用一个 `statusColor()` 就是它们被合并回去的第一步。
//    一个 `published` 的制品完全可能验签失败；一个 `yanked` 的制品签名照样有效。

import { Icon } from './icons';

/** 快照 §2.3 的四种 status。词用英文原字面值，因为用户会在 CLI 输出里再见到它。 */
const STATUS = {
  published: { icon: 'check', label: 'published', title: '维护者的处置：可安装' },
  deprecated: { icon: 'bang', label: 'deprecated', title: '维护者的处置：仍可安装，但已不推荐' },
  // 🔴 yanked 用**裸叉**；验证失败用圈叉（i-fail）。两者绝不能互换。
  yanked: { icon: 'x', label: 'yanked', title: '维护者的处置：默认拒绝新装' },
  degraded: { icon: 'block', label: 'degraded', title: '派生状态：被必装成员拖累，不可新装' },
};

export function StatusMark({ status }) {
  const s = STATUS[status];
  if (s === undefined) {
    return <span className="status st-unknown" title="快照里出现了未知 status">{status}</span>;
  }
  return (
    <span className={`status st-${status}`} title={s.title}>
      <Icon name={s.icon} />{s.label}
    </span>
  );
}

/**
 * capability 徽章：**双通道编码** —— 分段计量条（形状）+ 色相。
 * 灰度打印或色觉障碍下靠计量条也能读出档位。
 *
 * 🔴 徽章右侧**永远直接跟真实 capability 名**，不要只写 "TIER 2" 让人去查表。
 */
export function TierBadge({ tier, capabilities, note }) {
  const cls = tier === 0 || tier === 1 || tier === 2 ? `tier-${tier}` : 'tier-unknown';
  const caps = capabilities.join(' · ');
  return (
    <span className={`tier ${cls}`} title={note ?? undefined}>
      <span className="meter" aria-hidden="true">
        {[0, 1, 2].map((i) => <i key={i} className={tier !== null && i <= tier ? 'on' : undefined} />)}
      </span>
      TIER {tier === null ? '?' : tier}
      {caps ? <span className="caps">{caps}</span> : null}
    </span>
  );
}

/** 中性角标（latest / 预发布）。**不着语义色** —— 它们不是状态。 */
export function Tag({ children, current = false }) {
  return <span className={current ? 'tag tag-current' : 'tag'}>{children}</span>;
}

/** ArtifactId：让 name 在一串标识符里跳出来。 */
export function Aid({ artifact }) {
  return (
    <span className="aid">
      <span className="kind">{artifact.kind}:</span>
      <span className="ns">{artifact.namespace}/</span>
      <span className="nm">{artifact.name}</span>
      <span className="ver">@{artifact.version}</span>
    </span>
  );
}
