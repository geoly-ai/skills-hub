import { DISPLAYABLE_FIELDS, EVENT_FIELDS } from '../lib/whitelist.mjs';
import { MIN_INSTALLS } from '../lib/suppress.mjs';

/**
 * 常驻隐私说明。
 *
 * 🔴 **必须常驻在页面顶部，不折叠、不做成 tooltip。**
 *    这个平台是少数几个非工程同事也会看的界面，隐私契约要在这里被反复看见。
 *    site/ 那边同样的说明有测试在防它被删（`test/dashboard-parity.test.mjs`），
 *    这里由 `test/privacy-copy.test.mjs` 断言字段表被全覆盖 ——
 *    **加字段不改文案就会红**。
 */
export function PrivacyNotice() {
  const hidden = EVENT_FIELDS.filter((f) => !DISPLAYABLE_FIELDS.includes(f));
  return (
    <section className="privacy" aria-labelledby="privacy-h">
      <p className="label">collection surface · docs/telemetry/00-spec.md §2</p>
      <h3 id="privacy-h">这一页上的每个数字，都只能来自下面这张表</h3>

      <p className="note">
        采集面是一张<strong>穷举白名单</strong>：一个事件只能有这些字段，每个字段的值都有校验器。
        表外的东西<strong>根本没有被采集</strong> —— 没有用户名、没有路径、没有项目名、
        没有地理位置、没有 referrer、没有命令行原文、没有异常栈。
        所以「加一个指标」在这里从来不是前端的事，而是先要去改采集面并过评审。
      </p>
      <div className="fieldlist">
        {DISPLAYABLE_FIELDS.map((f) => <code key={f} className="mono">{f}</code>)}
      </div>

      <div className="never">
        <p className="label-cn">这三个字段被采集了，但永远不出现在这一页上</p>
        <div className="fieldlist">
          {hidden.map((f) => <code key={f} className="mono">{f}</code>)}
        </div>
        <p className="note" style={{ marginTop: 'var(--sp-2)' }}>
          <code className="mono">schema</code> 是常量，对读者零信息量。
          <code className="mono"> eid</code> 把「同一条事件」钉死，是再识别的抓手。
          最要紧的是 <code className="mono">install_id</code>：
        </p>
      </div>

      <p className="note" style={{ marginTop: 'var(--sp-3)' }}>
        <strong>🔴 为什么这个平台永远不提供「按 install_id 下钻」</strong> ——
        它是本机随机 UUID，与账号、机器名、用户名都没有映射，
        <strong>单看它确实不指向人</strong>。
        但一个<strong>能把某个 install_id 的事件按时间排开的界面，本身就是再识别工具</strong>：
        排出来的是「这台机器哪天装了什么、什么时候卸的、跑的是哪个 OS 和 CLI 版本」的完整轨迹。
        规格 §6 的 T-11 说的正是它：源 IP + 稳定 install_id + 时间线 = 机器级追踪。
        端点侧已经用「不记 IP、不记 UA」掐掉了 IP 那一半；
        <strong>时间线那一半在这个平台手里</strong>。
      </p>
      <p className="note">
        所以：<code className="mono">install_id</code> 只用来<strong>去重计数</strong>，
        界面上不出现具体值、不提供按它筛选或下钻；
        并且任何细分维度下去重装机数低于 <strong>{MIN_INSTALLS}</strong> 时不展示明细
        —— 「某版本某 client 只有 1 台」本身就是识别信息。
        这三条在代码里是<strong>结构性</strong>的（白名单正向过滤 + 递归剥识别符键 + 抑制器），
        不是靠自觉。想加下钻，先去改规格。
      </p>
    </section>
  );
}
