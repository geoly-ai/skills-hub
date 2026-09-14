import { DISPLAYABLE_FIELDS, EVENT_FIELDS, IDENTITY_FIELDS } from '../lib/whitelist.mjs';
import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { MIN_EVENTS_FOR_QUANTILE } from '../lib/publish.mjs';
import { Icon } from './icons.jsx';
import { Section } from './section.jsx';

/*
 * 「口径与边界」页的正文（DESIGN.md §8.10）—— 三个解释落点里的第三个。
 *
 * 🔴 **这一页只能承接长文，不能取代采集面契约条**（components/collection-bar.jsx）：
 *    契约条常驻每一页，这里放的是它三句话背后的完整论证。
 * 🔴 **整页只有叙述，没有数字**：这里不读上游，也不渲染任何计数。
 * 🔴 字段清单一律**从白名单推导**，不许手抄 —— 加字段不改这里，test/privacy-copy.test.mjs 会红。
 */

function BoundaryPanel({ title, children }) {
  return (
    <div className="panel">
      <div className="head"><Icon name="n-boundary" /><h3>{title}</h3></div>
      <div className="body prose">{children}</div>
    </div>
  );
}

export function Boundary() {
  // 采集了但不上这一页的，分两类，理由完全不同：
  //   · 结构类（schema / eid / install_id）—— 展示它们就是给再识别递抓手
  //   · 身份类 —— 它们归另一条通道，不是「藏起来」，而是**这一页根本不接那条线**
  const identityHidden = [...EVENT_FIELDS, 'ip'].filter((f) => IDENTITY_FIELDS.includes(f));
  const hidden = EVENT_FIELDS.filter(
    (f) => !DISPLAYABLE_FIELDS.includes(f) && !IDENTITY_FIELDS.includes(f),
  );

  return (
    <>
      <Section
        id="b1" num="一" title="采集面" en="collection surface"
        deck="这一页上的每个数字，都只能来自下面这张表。表外的东西根本没有被采集 —— 所以「加一个指标」从来不是前端的事，而是先去改采集面并过评审。"
      >
        <BoundaryPanel title="可以出现在这一页上的字段">
          <p>
            采集面是一张<strong>穷举白名单</strong>（docs/telemetry/00-spec.md §2）：一个事件只能有这些字段，
            每个字段的值都有校验器。没有路径、没有项目名、没有地理位置、没有 referrer、没有命令行原文、没有异常栈。
          </p>
          <div className="fieldgrid">
            {DISPLAYABLE_FIELDS.map((f) => <code key={f}>{f}</code>)}
          </div>
        </BoundaryPanel>

        <BoundaryPanel title="采集了，但永远不出现在这一页上">
          <div className="fieldgrid">
            {hidden.map((f) => <code key={f}>{f}</code>)}
          </div>
          <p>
            <code className="mono">schema</code> 是常量，对读者零信息量。
            <code className="mono"> eid</code> 把「同一条事件」钉死，是再识别的抓手。
            <code className="mono"> install_id</code> 只用来<strong>去重计数</strong>：
            界面上不出现具体值、不提供按它筛选或下钻（理由见下一节）。
          </p>
        </BoundaryPanel>

        <BoundaryPanel title="身份字段：采集面里有，这一页一个都不接">
          <div className="fieldgrid">
            {identityHidden.map((f) => <code key={f}>{f}</code>)}
          </div>
          <p>
            <strong>默认关闭。</strong>打开前会在首次运行时告知，用户可以随时只关掉这几项 —— 匿名计数照发。
            用户名与主机名是<strong>客户端自报</strong>的，服务端无从核实，所以任何地方都不能把它们叫做
            「真实归属」，只能叫<strong>自报归属</strong>。
          </p>
          <p>
            <strong>它们走的是另一条通道</strong>：另一个 API、另一套 normalizer、按人登录、单独授权、
            每一次查看（包括被拒绝的）都写审计。这一页与那条通道<strong>不共用 token、不在同一个响应里返回数据</strong>。
            给同一个归一化函数加一个「要不要剥身份」的开关，迟早会被错误地调用一次，而那一次不会有任何迹象。
          </p>
        </BoundaryPanel>
      </Section>

      <Section id="b2" num="二" title="为什么这个平台永远不提供「按 install_id 下钻」" en="no drill-down">
        <BoundaryPanel title="时间线本身就是再识别工具">
          <p>
            <code className="mono">install_id</code> 是本机生成的随机 UUID，跟账号、机器名、用户名都对不上，
            <strong>单看它确实指不到人</strong>。但只要有一个界面能把某个 install_id 的事件
            <strong>按时间排开，它本身就成了一件再识别工具</strong>：排出来的是
            「这台机器哪天装了什么、什么时候卸的、用的哪个系统和哪版 CLI」的完整轨迹。
          </p>
          <p>
            规格 §6 的 T-11 说的正是它：源 IP 加上一个稳定的 install_id 再加上时间线，就等于盯住了一台机器。
            IP 那一半，端点侧已经用「不记 IP、不记 UA」掐掉了；<strong>时间线这一半，在我们手里</strong>。
            所以顶栏的「本次读取」只是我们自己发请求的时刻，这一页上不会出现任何从事件时间派生出来的时间。
          </p>
          <p>
            拦它的办法是<strong>结构上的</strong>，不靠自觉：字段按白名单正向取、归一化时把任何像标识符的键都递归剥掉、
            样本太少就不发布、整个项目没有一个客户端组件。想加下钻，先去改规格。
          </p>
        </BoundaryPanel>
      </Section>

      <Section id="b3" num="三" title="小样本抑制" en="small-sample suppression">
        <BoundaryPanel title={`门槛是 ${MIN_INSTALLS} 台机器，不是 ${MIN_INSTALLS} 条事件`}>
          <p>
            一台机器一天就能产生几十条事件，按事件数算等于把 1 台当成 40 台。
            {MIN_INSTALLS} 是统计披露控制里的惯用起点，不是一个被证明过的安全边界 —— 它是一个必须被显式选择的数。
          </p>
          <div className="tablewrap">
            <table className="rules">
              <thead><tr><th scope="col">rule</th><th scope="col">what happens</th></tr></thead>
              <tbody>
                <tr><td>S1</td><td>全局标量：没有任何抑制时精确发布；装机数不到 {MIN_INSTALLS} 压成「&lt;{MIN_INSTALLS}」；服务端没给就写「未提供」，不写零也不写「&lt;{MIN_INSTALLS}」</td></tr>
                <tr><td>S2</td><td>细分行必须装机数达到 {MIN_INSTALLS} 才发布，否则并进一条只报行数的「未发布」</td></tr>
                <tr><td>S3</td><td>装机数缺失 = 无法证明达标 = 按不达标处理</td></tr>
                <tr><td>S4</td><td>恰好只藏一行时，再把事件数最小的可见行也收掉 —— 只藏一行，减一下就算回来了</td></tr>
                <tr><td>S5</td><td>表内没有总计行；被收掉的那一组不报事件合计；任何一张表有抑制，顶层数字就只给区间</td></tr>
                <tr><td>S6</td><td>不发布嵌套分布（artifact × result 这类交叉子组），连读都不读</td></tr>
                <tr><td>S7</td><td>耗时分位数还要样本至少 {MIN_EVENTS_FOR_QUANTILE} 条 —— 样本少时 p95 就等于某一条原始耗时</td></tr>
              </tbody>
            </table>
          </div>
          <p>
            <strong>「机器太少」与「不知道有几台」是两句话，不许合并。</strong>
            前者是服务端给了台数、确实不够；后者是服务端没给台数，我们按不够处理。
            把后者说成「太少」，是在断言一件我们并不知道的事，读的人会以为「服务端算过了，就是没人用」。
          </p>
          <p>
            <strong>这一切都发生在服务端</strong>：先把未抑制的聚合发给浏览器再隐藏，等于把它公开了 ——
            打开 devtools 就能看见。所以这一页没有「展开更多」，也没有前端筛选。
          </p>
        </BoundaryPanel>
      </Section>

      <Section id="b4" num="四" title="已知的残余风险：跨表相减" en="residual risk">
        <BoundaryPanel title="我们做到了什么，没做到什么">
          <p>
            首页这几张表切的是<strong>同一批事件</strong>。再配上一点外部知识，
            理论上可以拿几张表互相相减，把某一张里没发布的行推出来。
          </p>
          <p>
            <strong>我们做到的</strong>：每张表都不给总计行；没发布的那一组不报合计；
            只要有哪张表没发全，顶上那个总数就只给区间 —— 减出来的也只是一个区间。
          </p>
          <p>
            <strong>我们做不到的</strong>：一个绝对的保证。行数、枚举里缺了哪个取值、两张表行数的差，都还是线索。
            要真正堵死，得把这一整套表放在一起算能不能被解出来，那只能在服务端做（列在首页第 99 段）。
          </p>
          <p className="cap">这一条写在页面上而不是藏起来 —— 看这个后台的人有权知道它的保证到哪为止。</p>
        </BoundaryPanel>
      </Section>
    </>
  );
}
