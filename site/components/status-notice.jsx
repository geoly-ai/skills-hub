
import { Notice } from './primitives';

// 状态警示条。规格：DESIGN.md §7.6。
//
// 🔴 **三种条的标题主语不同**，因为它们说的是三件不同的事：
//      yanked     —— 「这个版本被撤了」（维护者对**它**的处置）
//      degraded   —— 「它被别人拖累了」（它自己没问题，是锁定的成员出事了）
//      deprecated —— 「不推荐了，但仍可安装」
//    把 degraded 写成 yanked 的同义句，是 §11 点名的第 3 号常见错误。

export function StatusNotice({ artifact: a }) {
  if (a.yank) return <YankNotice a={a} />;
  if (a.status === 'degraded') return <DegradedNotice a={a} />;
  if (a.status === 'deprecated') return <DeprecatedNotice />;
  return null;
}

function YankNotice({ a }) {
  const y = a.yank;
  return (
    <Notice
      tone="yank"
      icon="x"
      id="notice-yanked"
      title={`此版本已于 ${y.at} 被 yank，默认拒绝新装`}
      actions={
        // 🔴 advisory 与 superseded_by 是**可选字段**。缺席时不要渲染一个点不开的按钮，
        //    也不要自作主张推荐一个更高版本 —— 那等于替维护者做了他没做的声明。
        y.superseded_by
          ? <span className="btn btn-mono">替代版本：{y.superseded_by}</span>
          : null
      }
    >
      <p><strong>reason</strong>：{y.reason}</p>
      {y.advisory
        ? <p>advisory：<code className="mono">{y.advisory}</code></p>
        : <p className="dim">快照没有给 advisory（这是可选字段）。</p>}
      {y.superseded_by
        ? null
        : <p className="dim">快照<strong>未声明替代版本</strong>（superseded_by 缺席）。本站点不替它挑一个。</p>}
      <p>
        yank <strong>不删文件</strong>：资产还在，已装的实例也不强制卸载，
        <code className="mono">check</code> 会报告它。
        而且 yanked 是「<strong>默认</strong>拒绝新装」，不是「绝对不可安装」——
        显式 <code className="mono">--allow-yanked</code> 仍可继续，
        但这次跳过会写进安装账本。
      </p>
    </Notice>
  );
}

function DegradedNotice({ a }) {
  const blame = a.pack?.blame;
  const named = blame?.degraded_by?.length ? blame.degraded_by.map((d) => d.id).join('、') : null;
  return (
    <Notice
      tone="degraded"
      icon="block"
      id="notice-degraded"
      title="此 pack 被标记为 degraded：它锁定的一个必装成员出了问题"
    >
      <p>
        degraded 是 promotion <strong>每次重算</strong>并写进快照的派生状态，
        不是运行时算的 —— 状态必须在签名覆盖范围内。
        {named
          ? <> 本次构建拿到的成员图指向：<code className="mono">{named}</code>。</>
          : <> 快照里<strong>没有</strong> <code className="mono">degraded_by</code> 字段，
            要点名是谁得先拿到载荷里的 pack.json；本次构建拿不到，所以下面只说到这里。</>}
      </p>
      <p>
        <code className="mono">--allow-yanked</code> <strong>不放行 degraded</strong> ——
        这是它和 yanked 最大的行为差别。
      </p>
      <p className="dim">被谁拖累的完整推导见下面的「pack 成员」一节。</p>
    </Notice>
  );
}

function DeprecatedNotice() {
  return (
    <Notice tone="deprecated" icon="bang" id="notice-deprecated" title="此版本已弃用，但仍可安装">
      <p>
        快照的 schema 里没有「弃用理由」这个字段，所以本站点也给不出理由。
        <strong>deprecated 仍然可以进入 <code className="mono">latest</code></strong>：
        latest 投影排除的是 yanked、degraded 与预发布，不排除 deprecated。
      </p>
    </Notice>
  );
}

/** 版本历史页上的 latest 说明 —— 把完整投影规则写全，不只写一半。 */
export function LatestNotice({ group }) {
  return group.latest
    ? (
      <Notice tone="ink" icon="check" id="notice-latest" title={`latest → ${group.latest}`}>
        <p>
          快照的 <code className="mono">latest</code> 投影指向 {group.latest}。
          完整规则：该 <code className="mono">kind:ns/name</code> 下
          <strong>非 yanked、非 degraded、非预发布</strong>的最高 semver。
          <strong>deprecated 可以进入 latest</strong>。
        </p>
        <p className="dim">
          措辞一律是「截至 hub-N」：本站点没有 timestamp，说不了「现在」。
        </p>
      </Notice>
    )
    : (
      <Notice tone="degraded" icon="block" id="notice-latest" title="该制品当前没有可安装版本">
        <p>{group.latest_absent_reason}</p>
        <p className="dim">
          全部版本都被排除时，<code className="mono">latest</code> 里<strong>没有这个键</strong> ——
          这是有意义的信号，不是数据缺失。下面逐版本列出各自被排除的原因。
        </p>
      </Notice>
    );
}

