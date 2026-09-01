// provenance 块。规格：DESIGN.md §7.8。
//
// 🔴 **两种形态刻意长得不一样。** `validateProvenance()` 里 original 与 vendored 是
//    两套**完全不同的键集**（3 个字段 vs 10 个字段），视觉上不该伪装成同一张表：
//      · original —— 两个节点，两行完事。**不为了"对称"补空行或占位符**；
//      · vendored —— 一条带节点的搬运轨迹，顺序即因果。
//    `kindtag` 用 `--c-ink` 而不是警告色：vendored 不是坏事，只是来源不同。

import { Digest, DigestPair } from './digest';

export function Provenance({ provenance: p, treeDigest }) {
  return p.kind === 'original' ? <Original p={p} /> : <Vendored p={p} treeDigest={treeDigest} />;
}

function Original({ p }) {
  return (
    <div className="prov prov-original">
      <header><h3>出处</h3><span className="kindtag">original</span></header>
      <div className="trace">
        <span className="node end" />
        <div className="body">
          <div className="t">author_github_id</div>
          <div className="m">{p.author_github_id}</div>
          <div className="n">原生投稿，没有上游仓库。</div>
        </div>
        <span className="node end" />
        <div className="body">
          <div className="t">submitted_by_pr</div>
          <div className="m">#{p.submitted_by_pr}</div>
        </div>
      </div>
    </div>
  );
}

function Vendored({ p, treeDigest }) {
  return (
    <div className="prov prov-vendored">
      <header><h3>出处</h3><span className="kindtag">vendored</span></header>
      <div className="trace railed">
        <span className="node" />
        <div className="body">
          <div className="t">origin_repo · origin_ref</div>
          <div className="m">{p.origin_repo} · {p.origin_ref}</div>
        </div>

        <span className="node" />
        <div className="body">
          <div className="t">origin_commit</div>
          <div className="m">{p.origin_commit}</div>
          <div className="n">40 位，不接受 tag —— tag 可以被移动，那正是「审核后换内容」的攻击路径。</div>
        </div>

        <span className="node" />
        <div className="body">
          <div className="t">origin_subpath</div>
          <div className="m">{p.origin_subpath}</div>
        </div>

        <span className="node" />
        <div className="body">
          <div className="t">origin_tree_digest</div>
          {/* 🔴 **pair 形态**：两串上下并列、同宽同分组、**都用常规色**。
              不给任何一串染警告色，也不做字符级 diff —— 见下面那段为什么它们本就不该相等。 */}
          <div className="m">
            <DigestPair
              rows={[
                { label: '上游那棵树（origin_tree_digest）', value: p.origin_tree_digest },
                { label: '本制品这棵树（tree_digest）', value: treeDigest },
              ]}
            />
          </div>
        </div>

        <span className="node" />
        <div className="body">
          <div className="t">added_files</div>
          <div className="m">{p.added_files.join(' · ') || '（空）'}</div>
          {/* 🔴 用 --c-caution 说「预期内的不相等」，**不许用 --c-revoked** —— 它不是故障。
              也不做字符级 diff：哈希是雪崩的，染色会暗示差异定位在某几段，那是假的。 */}
          <div className="n" style={{ color: 'var(--c-caution)' }}>
            上面这个 <code className="mono">origin_tree_digest</code> 与本制品的
            <code className="mono"> tree_digest </code>
            <strong>本来就不相等，这是预期，不是故障</strong>：
            导入时必然新增了上面这些文件（至少一个 <code className="mono">skill.json</code>），
            两棵树不是同一棵。正确的核对方式是「去掉 added_files 之后重算 hub 侧载荷的树摘要，
            结果应与 origin_tree_digest 相等」。
          </div>
        </div>

        <span className="node end" />
        <div className="body">
          <div className="t">license_evidence · imported_at · imported_by_pr</div>
          <div className="m">{p.license_evidence}</div>
          <div className="n">{p.imported_at} · PR #{p.imported_by_pr}</div>
        </div>
      </div>
      <footer>
        <p className="note">
          git 坐标一律是<strong>定位提示，不是信任输入</strong>（01-artifacts.md §2）：
          判内容是否被改过要看 <code className="mono">tree_digest</code>，
          而那个判据要在快照<strong>经 CLI 验过签之后</strong>才成立 —— 本页没有验签。
        </p>
      </footer>
    </div>
  );
}
