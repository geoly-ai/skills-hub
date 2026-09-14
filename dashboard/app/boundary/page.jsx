import { Shell } from '../../components/shell.jsx';
// 口径与边界的长文仍住在 components/privacy.jsx：它是身份字段清单的**定义处**，
// test/whitelist-drift.test.mjs 只豁免这一个组件引用身份字段常量。
import { Boundary } from '../../components/privacy.jsx';

/*
 * 「口径与边界」页（DESIGN.md §8.10）。
 *
 * 🔴 **仍然走 proxy 门禁**（matcher 盖住所有非静态路径，PUBLIC 里没有它），
 *    响应头同样是 `Cache-Control: private, no-store` + `X-Robots-Tag: noindex`。
 *    它不是一个可以公开的静态页 —— 所以也 force-dynamic，不预渲染。
 * 🔴 这一页**不读上游**，所以顶栏**不渲染数据源徽章与「本次读取」**：没问过就不说问过。
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BoundaryPage() {
  return (
    <Shell title="口径与边界" current="boundary" path="/boundary">
      <Boundary />
    </Shell>
  );
}
