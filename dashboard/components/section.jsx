/**
 * 一个问题一段（DESIGN.md §8.1 / §8.5）。
 *
 * 🔴 段号就是 docs/telemetry/00-spec.md §1 的问题号；每段都带 deck，
 *    一句话说清这一段拿来做什么决策。一个没有问题意识的后台，读的人会开始按
 *    「哪张表好看」而不是「哪个问题该答」去用它。
 * `id` 是导航锚点（`/#s01`），`scroll-margin-top` 让 sticky 顶栏不盖住标题。
 */
export function Section({ id, num, title, en, deck, children }) {
  return (
    <section className="section" id={id} aria-labelledby={`${id}-h`}>
      <div className="sechead">
        <span className="num">{num}</span>
        <h2 id={`${id}-h`}>{title}</h2>
        {en ? <span className="label">{en}</span> : null}
      </div>
      {deck ? <p className="deck">{deck}</p> : null}
      {children}
    </section>
  );
}
