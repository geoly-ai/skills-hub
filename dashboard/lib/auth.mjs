/*
 * 访问控制 —— 共享密钥 + 签名 cookie。
 *
 * 🔴 **为什么这个平台必须有门禁**：它展示的是内部运营数据。
 *    「哪些 skill 没人用」直接等于「哪些 skill 要下架」，那是还没对外说的话；
 *    「装失败集中在哪个版本」是一份现成的攻击面清单。
 *    `/v1/summary` 那一侧已经是 token 门禁 + 默认关闭（规格 §5.3），
 *    dashboard 这一侧不能把它重新开成公开页。
 *
 * ── 方案与取舍（为什么不用 Vercel 的 Password Protection）────────────────────
 * 两者**强度是同一档**：都是单一共享口令，都没有个人身份、没有按人吊销、
 * 没有「谁在什么时候看了什么」的审计。既然强度一样，取「在我们代码里」的那个：
 *   · 本地与 preview 环境能一模一样地复现（平台功能在本地根本不存在）；
 *   · 能写测试（test/auth.test.mjs 就在断言它）；
 *   · 不依赖某个套餐档位。
 *
 * ── 它挡得住什么 ─────────────────────────────────────────────────────────────
 *   · 搜索引擎收录（另配 X-Robots-Tag: noindex, nofollow）
 *   · 被转发出去的链接：拿到 URL 的人打不开
 *   · 没有凭据的爬虫与扫描器
 *   · 未登录时**一次上游请求都不会发出去**（门禁在 proxy（旧称 middleware），早于任何数据读取）
 *
 * ── 🔴 它挡不住什么（不要粉饰）───────────────────────────────────────────────
 *   · **拿到口令的人**。口令可转发、可重放，没有个人身份，**没法按人吊销** ——
 *     一个人离职就得换口令、所有人重登。
 *   · **审计**。我们不知道谁看了什么，也不打算知道（要知道就得记访问者身份）。
 *   · **能读环境变量的人**：Vercel 项目成员、有部署权限的人、CI。
 *   · **Cookie 被偷**：XSS（本站无用户输入渲染，但不等于零）、恶意扩展、
 *     被入侵的机器上的浏览器 profile。HttpOnly 挡脚本读，挡不住这些。
 *   · **Vercel 平台自身的访问日志**。它记不记、记多久，不在这份代码里。
 *     ⚠️ 这一条与规格 §5.3 对**埋点端点**的「不得记 IP」是两件事 ——
 *     那条约束的是采集链路，这里是我们自己人看报表，但仍要知道它存在。
 *   · **暴力猜口令**：只有一道全局限速（见下），没有按人锁定。
 *     真正的防线是口令熵 —— 用 `openssl rand -base64 32`，不要用一个词。
 *
 * ── 想要审计与按人吊销，正确的做法是 SSO（Vercel SSO / OIDC）。**本版没做。**
 *    这是已知的残余风险，不是遗漏。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 实现说明：用 Web Crypto（`crypto.subtle`）而不是 `node:crypto` ——
 * proxy（Next 16 之前叫 middleware）跑在 edge runtime 上，那里没有 `node:crypto`。
 */

/**
 * 🔴 `__Host-` 前缀不是装饰：它让浏览器强制这个 cookie 必须 Secure、Path=/、
 *    且**不带 Domain 属性** —— 于是同一个父域下的别的站点无法把一个伪造的
 *    同名 cookie「盖」到我们头上（cookie tossing）。
 */
export const COOKIE_NAME = '__Host-skillsdash';

/** 会话时长。短到「一台被借走的电脑不会一直开着门」，长到不至于每小时重登。 */
export const SESSION_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 签一张会话票。
 * 票面只有过期时间戳 —— **口令本身从不进 cookie**，所以偷到 cookie 也偷不到口令
 * （拿它去登别处不成立），且票会自己过期。
 */
export async function issueTicket(secret, now = Date.now()) {
  const exp = String(now + SESSION_MS);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(exp));
  return `${exp}.${toHex(sig)}`;
}

/**
 * 验一张会话票。
 * 🔴 用 `crypto.subtle.verify` 而不是字符串 `===`：`===` 是短路的，
 *    逐字节的耗时差足以把签名一位一位试出来（server/app.mjs 的
 *    `bearerMatches` 是同一条理由）。
 */
export async function verifyTicket(secret, ticket, now = Date.now()) {
  if (typeof ticket !== 'string') return false;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const exp = ticket.slice(0, dot);
  const sigHex = ticket.slice(dot + 1);
  if (!/^\d{1,15}$/.test(exp)) return false;
  const sig = fromHex(sigHex);
  if (!sig) return false;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(exp));
  // ⚠️ 先验签再看过期：反过来的话「过期与否」会先于签名泄漏一个可测的时间差。
  if (!ok) return false;
  return Number(exp) > now;
}

/**
 * 定长比较口令。
 * 直接 `===` 会在第一个不同的字节处返回，把口令一位一位试出来。
 * 这里先都 HMAC 一遍再比 —— 比较的是等长的摘要，长度差也不泄漏。
 */
export async function secretMatches(secret, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const key = await hmacKey(secret);
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(`pw:${secret}`)),
    crypto.subtle.sign('HMAC', key, enc.encode(`pw:${candidate}`)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * 登录限速 —— **全局一个桶，不按 IP 分**。
 *
 * 🔴 为什么不按 IP：按 IP 分桶要先**读**访问者 IP。这个仓库对「读了 IP 就迟早
 *    会有人写进日志」这件事有过明确判断（server/app.mjs 连读都不读）。
 *    这里遵循同一条纪律。
 * ⚠️ 代价说在明处：一个人狂试能把**所有人**都挡在门外一小会儿（可用性代价）。
 *    这个取舍成立的前提是**口令熵足够**（`openssl rand -base64 32`），
 *    限速只是给「口令被设成一个词」那种事故留一层薄兜底，不是主要防线。
 * ⚠️ 桶是**每个实例各一份**的进程内状态：Vercel 会起多个实例，所以真实速率是
 *    「实例数 × 这个值」。这是 best-effort，不是保证。
 */
export function createLimiter({ capacity = 5, refillPerSec = 0.5, now = () => Date.now() } = {}) {
  let tokens = capacity;
  let at = now();
  return function take() {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - at) / 1000) * refillPerSec);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
