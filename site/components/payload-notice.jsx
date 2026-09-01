// 🔴 **第三条轴：本地比对（local byte comparison）。**
//
// 页面上有三件互不相同的事，它们**必须有三套视觉语言**：
//
//   1. 生命周期轴（badges.jsx）—— 维护者对这个制品的处置：published/deprecated/yanked/degraded；
//   2. 验证轴（trust.jsx）—— 我们这一次到底验没验签：verified/stale/failed/unverified；
//   3. **本地比对轴（本文件）** —— 工作树里那棵载荷树重新打包出来，和 record 里写的
//      `tree_digest` 是不是同一串字节。
//
// 🔴 早先第 3 条借用了第 2 条的图形（check / fail / unverified）与色，结果是：
//    页面顶部四格全写着「未验证」，下面却出现一个勾说「载荷已核对」——
//    第一眼读成「验证通过了」（Codex 2026-09-01 P1）。
//    现在它用**等号 / 不等号 / 虚线短横**，措辞也只说「相同 / 不同 / 取不到」，
//    一个"通过""成功""verified"都不出现。
//
// 🔴 措辞纪律：**相等不构成担保**。这一比对能证明的只有「工作树里那棵树，就是这条
//    record 描述的那棵树」；它证明不了这张快照是真的（要验签），也证明不了它是当前的
//    （要 timestamp）。标题里因此永远带着「本地比对，未验签」。

import { Notice } from './primitives';

const STATE = {
  verified: {
    tone: 'compare',
    icon: 'equal',
    title: '工作树载荷与快照 record 的 tree_digest 相同（本地比对，未验签）',
  },
  mismatch: {
    tone: 'compare-bad',
    icon: 'unequal',
    title: '工作树载荷与快照 record 的 tree_digest 不同（本地比对，未验签）',
  },
  error: {
    tone: 'compare-none',
    icon: 'nodata',
    title: '没能完成本地比对：载荷读取或绑定校验失败',
  },
  absent: {
    tone: 'compare-none',
    icon: 'nodata',
    title: '没有可比对的载荷：本次构建的工作树里没有这个制品的目录',
  },
};

/** @param {{state:string, note:string}} payload */
export function PayloadNotice({ payload, id = 'payload-state' }) {
  const s = STATE[payload.state] ?? STATE.absent;
  const matched = payload.state === 'verified';
  return (
    <Notice tone={s.tone} icon={s.icon} id={id} title={s.title}>
      <p>{payload.note}</p>
      {matched
        ? (
          <p>
            这只说明<strong>两串字节相同</strong>。它<strong>不是</strong>一次验签：
            本页没有读 Sigstore bundle，也没有读 timestamp，
            所以它证明不了这张快照是真的、也证明不了它是当前的。
            上面那四格「未验证」并没有因为这一行而改变。
          </p>
        )
        : (
          <p>
            因此本页<strong>不展示</strong>任何依赖载荷的内容
            （<code className="mono">description</code>、pack 的成员列表）。
            快照 record 里没有这些字段，编一个出来比留白更糟。
          </p>
        )}
    </Notice>
  );
}
