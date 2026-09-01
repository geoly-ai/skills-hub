import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="page">
      <header className="titleblock">
        <h1>这里没有页面</h1>
      </header>
      <div className="emptyrow">
        <p>
          页面只在构建时生成：只有快照里真有的制品才会有自己的页面。
          地址里的 id 不在当前快照里，或者 registry 现在是空的。
        </p>
        <div><Link className="btn btn-mono" href="/">回 registry 台账</Link></div>
      </div>
    </div>
  );
}
