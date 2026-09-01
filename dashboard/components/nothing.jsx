import { SOURCE, SOURCE_COPY, VIEW, VIEW_COPY } from '../lib/state.mjs';

/*
 * 「没有」的告示条。
 *
 * 🔴 **这是本平台的第一等公民。** 上线后每个数字都会是 0，而且会持续一段时间 ——
 *    这段时间里页面唯一的职责就是说清**是链路的哪一环还没通**。
 *
 * 🔴 **禁止**：「暂无数据」四个字、骨架屏、假数据占位、居中的空盒插画、
 *    一个大号加号按钮。骨架屏尤其糟：它说的是「马上就来」，而实际情况是
 *    「端点还没部署，这一格半年内都不会有数」。
 *
 * 🔴 五种「没有」用**不同的纸样**（见 components.css 的 .n-*）：
 *    余光里就能分开「服务挂了」和「没人用」。
 */

const CLASS = {
  [SOURCE.UNCONFIGURED]: 'n-source',
  [SOURCE.UNREACHABLE]: 'n-source',
  [SOURCE.DENIED]: 'n-source',
  [SOURCE.INVALID]: 'n-source',
  [VIEW.NO_EVENTS]: 'n-zero',
  [VIEW.DIMENSION_MISSING]: 'n-todo',
  [VIEW.NO_ROWS]: 'n-norows',
  [VIEW.UNRECOGNIZED_ROWS]: 'n-source',
  [VIEW.FILTERED_EMPTY]: 'n-filtered',
  [VIEW.SUPPRESSED]: 'n-suppressed',
  [VIEW.SUPPRESSED_QUANTILE]: 'n-suppressed',
};

/**
 * @param {{ state: string, where?: string|null, why?: string|null }} props
 * `where` 是「我们在问谁」（掩码过的端点 URL）；`why` 是一个短原因码。
 * ⚠️ 两者都不许带 token，也不许带异常消息（栈与消息里可能有内网主机名）。
 */
export function Nothing({ state, where = null, why = null }) {
  const copy = SOURCE_COPY[state] ?? VIEW_COPY[state];
  if (!copy) return null;
  return (
    <div className={`nothing ${CLASS[state] ?? ''}`} role="status">
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      <p className="next">{copy.next}</p>
      {(where || why) && (
        <p className="where">
          {where ? <>问的是 {where}</> : null}
          {where && why ? ' · ' : null}
          {why ? <>原因码 {why}</> : null}
        </p>
      )}
    </div>
  );
}
