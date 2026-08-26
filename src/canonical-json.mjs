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
  const seen = [];
  const result = JSON.parse(text, function (key, value, ctx) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // reviver 无法直接看到重复 key，改用下方的独立扫描
    }
    return value;
  });
  detectDuplicateKeys(text);
  return result;
}

/** 独立扫描原文，发现同一对象内的重复 key */
export function detectDuplicateKeys(text) {
  const stack = [];
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1, buf = '';
      while (j < n) {
        if (text[j] === '\\') { buf += text[j] + text[j + 1]; j += 2; continue; }
        if (text[j] === '"') break;
        buf += text[j]; j++;
      }
      const raw = buf;
      i = j + 1;
      // 跳过空白，看是不是 key（后面跟冒号）
      let k = i; while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === ':' && stack.length && stack[stack.length - 1].type === 'obj') {
        const top = stack[stack.length - 1];
        if (top.keys.has(raw)) throw new Error(`canonical-json: 重复 key "${raw}"`);
        top.keys.add(raw);
      }
      continue;
    }
    if (c === '{') { stack.push({ type: 'obj', keys: new Set() }); i++; continue; }
    if (c === '[') { stack.push({ type: 'arr' }); i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    i++;
  }
}
