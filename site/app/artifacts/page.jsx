import Link from 'next/link';

import { getSiteData, getArtifacts } from '../../lib/site-data';
import { TrustChain } from '../../components/trust';
import { ArtifactBrowser } from './browser';

export const metadata = { title: '制品列表 · skills-hub registry' };

export default function ArtifactsPage() {
  const data = getSiteData();
  const artifacts = getArtifacts();

  // 🔴 两种「空」必须用不同的话说：这一支是「registry 本身是空的」，
  //    出口是去看 registry 现在是什么状态；「筛选筛没了」在 browser.jsx 里，
  //    出口是清空筛选。用同一句文案会让人以为是自己条件写错了。
  if (data.empty) {
    return (
      <div className="page">
        <header className="titleblock">
          <h1>artifacts</h1>
        </header>
        <div className="emptyrow">
          <p><strong>这张 registry 收录 0 个制品，任何查询都不会有结果。</strong></p>
          <p className="note">不是筛选条件写错了 —— {data.empty_reason}。</p>
          <div><Link className="btn btn-mono" href="/">看 registry 现在是什么状态</Link></div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="titleblock">
        <h1>artifacts</h1>
        <p className="note">
          快照 <code className="mono">hub-{data.source.internal_number}</code> 里的全部
          {' '}{artifacts.length} 条 record。同一个制品的每个版本各占一条。
        </p>
      </header>

      <section className="section" aria-labelledby="browse-heading">
        <div className="sechead">
          <span className="label">01</span>
          <h2 id="browse-heading">检索</h2>
          <span className="label">name · artifactid · 64 hex</span>
        </div>
        <ArtifactBrowser artifacts={artifacts} />
      </section>

      <TrustChain data={data} n="02" />
    </div>
  );
}
