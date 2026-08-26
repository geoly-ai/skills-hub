// canonical JSON —— 规范见 docs/m0/11-wire-contract.md §3
// CLI 与 CI 共用同一份实现（§11 要求）。

const ESC = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** 字符串按 §3.4：非 ASCII 一律 \uXXXX 小写 hex；BMP 外用代理对；未配对代理 → 抛错 */
export function encodeString(str) {
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    if (ESC[ch]) { out += ESC[ch]; continue; }
    if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    if (code < 0x7f) { out += ch; continue; }
    // 代理对完整性
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`canonical-json: 未配对的高位代理 at ${i}`);
      }
      out += '\\u' + code.toString(16).padStart(4, '0');
      out += '\\u' + next.toString(16).padStart(4, '0');
      i++; continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`canonical-json: 未配对的低位代理 at ${i}`);
    }
    out += '\\u' + code.toString(16).padStart(4, '0');
  }
  return out + '"';
}

function keyOrder(a, b) {
  // §3.1：schema 强制置首，其余按 UTF-8 字节序
  if (a === 'schema') return -1;
  if (b === 'schema') return 1;
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

function enc(value, indent, path) {
  const pad = '  '.repeat(indent), padIn = '  '.repeat(indent + 1);
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`canonical-json: ${path} 只允许 [0, 2^53-1] 的非负整数，得到 ${value}`);
    }
    return String(value);
  }
  if (t === 'string') return encodeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v, i) => padIn + enc(v, indent + 1, `${path}[${i}]`));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort(keyOrder);
    if (keys.length === 0) return '{}';
    const items = keys.map(k => padIn + encodeString(k) + ': ' + enc(value[k], indent + 1, `${path}.${k}`));
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  throw new Error(`canonical-json: ${path} 不支持的类型 ${t}`);
}

/** canonical 序列化，结尾恰好一个 \n */
export function stringify(value) { return enc(value, 0, '$') + '\n'; }

/** canonical 字节 */
export function toBytes(value) { return Buffer.from(stringify(value), 'utf8'); }

/**
 * 严格解析：拒绝重复 key。
 * 标准 JSON.parse 会静默取最后一个 —— §3.2 要求报错。
 */
export function parseStrict(text) {
  const result = JSON.parse(text);   // 先让它做语法校验
  detectDuplicateKeys(text);
  return result;
}

/**
 * 🔴 把 JSON 字符串字面量解码成实际的 key。
 *
 * 重复 key 的判据必须是**解码后**的值：`{"a":1,"\u0061":2}` 里两个 key
 * 都是 `a`，是重复的，但它们的原文完全不同。早先直接比原文，于是这种写法
 * 被静默放行、JSON.parse 取最后一个 —— 一个可以用来绕过任何「按 key 校验」的口子。
 *
 * ⚠️ 这与埋点那次是同一类错误：**比较未归一化的形式**。
 * 凡是「同一个东西有多种写法」的地方，比之前先归一。
 */
function decodeJsonString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const c = raw[++i];
    switch (c) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u':
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
        break;
      default: out += c;   // JSON.parse 已经验过语法，走不到这里
    }
  }
  return out;
}

/** 独立扫描原文，发现同一对象内的重复 key（按**解码后**的 key 比对） */
export function detectDuplicateKeys(text) {
  const stack = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1, buf = '';
      while (j < n) {
        if (text[j] === '\\') { buf += text[j] + text[j + 1]; j += 2; continue; }
        if (text[j] === '"') break;
        buf += text[j]; j++;
      }
      i = j + 1;
      // 跳过空白，看是不是 key（后面跟冒号）
      let k = i; while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === ':' && stack.length && stack[stack.length - 1].type === 'obj') {
        const top = stack[stack.length - 1];
        const key = decodeJsonString(buf);
        if (top.keys.has(key)) throw new Error(`canonical-json: 重复 key ${JSON.stringify(key)}`);
        top.keys.add(key);
      }
      continue;
    }
    if (c === '{') { stack.push({ type: 'obj', keys: new Set() }); i++; continue; }
    if (c === '[') { stack.push({ type: 'arr' }); i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    i++;
  }
}
