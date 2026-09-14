import { SOURCE, SOURCE_COPY, VIEW, VIEW_COPY } from '../lib/state.mjs';
import { Icon } from './icons.jsx';

/*
 * 「没有」的告示条（DESIGN.md §8.9 / §9）。
 *
 * 🔴 **十一种「没有」长得都不一样**：三通道叠加 —— 图标（族内两两不同）+ 左轨墨 + 纸样。
 *    五个故障态同色同轨同纸（余光里先分清「是不是故障」），族内靠图标 + 标题 + 下一步分开。
 * 🔴 标题、正文、下一步三段**都常显**，不塞进抽屉 —— 它们就是「链路哪一环还没通」本身。
 * 🔴 role="group" + aria-labelledby，**不是** role="status"/"alert"：
 *    告示条是页面既有的静态事实，live region 会在加载时被朗读成「刚刚发生的事」。
 * 🔴 抑制两态在 .hd 里放真实文本「未发布」：斜纹是 background-image，读屏读不到。
 * 🔴 **禁止**：「暂无数据」、骨架屏、shimmer、假数据占位、空盒插画。
 */

const LOOK = {
  [SOURCE.UNCONFIGURED]: ['n-fault', 's-unconfigured'],
  [SOURCE.UNREACHABLE]: ['n-fault', 's-unreachable'],
  [SOURCE.DENIED]: ['n-fault', 's-denied'],
  [SOURCE.INVALID]: ['n-fault', 's-invalid'],
  [VIEW.UNRECOGNIZED_ROWS]: ['n-fault', 's-unrecognized'],
  [VIEW.NO_EVENTS]: ['n-zero', 's-zero'],
  [VIEW.NO_ROWS]: ['n-zero', 's-empty-dim'],
  [VIEW.DIMENSION_MISSING]: ['n-pending', 's-not-computed'],
  [VIEW.FILTERED_EMPTY]: ['n-quiet', 's-filtered'],
  [VIEW.SUPPRESSED]: ['n-withheld', 's-withheld'],
  [VIEW.SUPPRESSED_QUANTILE]: ['n-withheld', 's-withheld-q'],
};

/** 只有数据源四态带 `.where`（掩码 URL + 短原因码）。🔴 `unrecognized-rows` 不带：那一格里不许有计数。 */
const HAS_WHERE = new Set([SOURCE.UNCONFIGURED, SOURCE.UNREACHABLE, SOURCE.DENIED, SOURCE.INVALID]);

/**
 * 告示条的形态本身。供十一态与少数几处固定文案（缺口清单算不出来、登录失败）共用，
 * 让「拒绝」「故障」在每一页上是同一种视觉语言。
 */
export function Notice({ look, icon, id, title, level = 4, wide = false, withheldWord = false, children }) {
  const H = `h${level}`;
  return (
    <div className={`nothing ${look}${wide ? ' wide' : ''}`} role="group" aria-labelledby={id}>
      <div className="hd">
        <Icon name={icon} size={wide ? 18 : 16} />
        {withheldWord ? <span className="withheld">未发布</span> : null}
        <H id={id}>{title}</H>
      </div>
      {children}
    </div>
  );
}

/**
 * @param {{ state: string, id: string, where?: string|null, why?: string|null, wide?: boolean, level?: number }} props
 * `where` 必须是 lib/summary-source.mjs 的 maskUrl() 结果；`why` 是短原因码。
 * ⚠️ 两者都不许带 token，也不许带异常消息（栈与消息里可能有内网主机名）。
 */
export function Nothing({ state, id, where = null, why = null, wide = false, level = 4 }) {
  const copy = SOURCE_COPY[state] ?? VIEW_COPY[state];
  const look = LOOK[state];
  if (!copy || !look) return null;
  const showWhere = HAS_WHERE.has(state) && (where || why);
  return (
    <Notice
      look={look[0]} icon={look[1]} id={id} title={copy.title} level={level} wide={wide}
      withheldWord={look[0] === 'n-withheld'}
    >
      {/* 🔴 文案是纯文本，不为 `**` 做任何解析（§5.4） */}
      <p>{copy.body}</p>
      <p className="next">{copy.next}</p>
      {showWhere ? (
        <p className="where">
          {where ? <>问的是 {where}</> : null}
          {where && why ? ' · ' : null}
          {why ? <>原因码 {why}</> : null}
        </p>
      ) : null}
    </Notice>
  );
}
