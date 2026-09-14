import { DISPLAYABLE_FIELDS } from '../lib/whitelist.mjs';
import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { Icon } from './icons.jsx';

/**
 * 采集面契约条（DESIGN.md §3.2 / §8.3）—— 状态层 ① 的一半。
 *
 * 🔴 **常驻、不可折叠、不可关闭、不做成 tooltip。**
 *    这个平台是少数几个非工程同事也会看的界面，隐私契约要在每一页上被反复看见。
 *    长论证搬去了「口径与边界」页，但**那一页只能承接长文，不能取代这一条**：
 *    一个只看了首页、一次都没点进去的人，必须仍然知道三件事，各占一句 ——
 *      ① 这一页上的数只来自这 13 个字段（从白名单渲染，不许手抄）
 *      ② install_id 只拿来去重计数，不显示
 *      ③ 有小样本抑制
 *
 * ⚠️ 文案写「这一页上的数只来自」，不写「我们只收」：采集面还有 schema / eid / install_id
 *    与默认关闭的身份字段，说「只收这 13 个」是一句假话。
 */
export function CollectionBar() {
  return (
    <div className="collectionbar" role="region" aria-label="这一页只能有哪些字段">
      <Icon name="u-info" />
      <span>这一页上的数只来自这 {DISPLAYABLE_FIELDS.length} 个字段</span>
      <span className="fields">
        {DISPLAYABLE_FIELDS.map((f) => <span key={f} className="f">{f}</span>)}
      </span>
      <span className="sep" aria-hidden="true">·</span>
      <span>install_id 只拿来去重计数，不显示</span>
      <span className="sep" aria-hidden="true">·</span>
      <span>装了它的机器不到 {MIN_INSTALLS} 台的细分不展示</span>
      <span className="sep" aria-hidden="true">·</span>
      <a href="/boundary">口径与边界 ›</a>
    </div>
  );
}
