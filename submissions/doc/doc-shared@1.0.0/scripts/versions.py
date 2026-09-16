#!/usr/bin/env python3
"""版本号规范化与比较（doc-* 共用，唯一实现）。
写法：主.次 或 主.次.修订，可带 v 前缀；比较前补齐到三段，所以 1.0 = 1.0.0 = v1.0。
  parse(v)            -> (主, 次, 修订)；不合法抛 ValueError
  same_version(a, b)  -> bool；任一方无法解析时退回「去掉 v 后字符串相等」
  compare(a, b)       -> -1 / 0 / 1；无法解析抛 ValueError"""
import re

_RE = re.compile(r'^v?(\d+)\.(\d+)(?:\.(\d+))?$')


def parse(v):
    m = _RE.match(str(v).strip()) if v is not None else None
    if not m:
        raise ValueError(f'版本号不合法：{v!r}（写 1.0 或 1.0.1，可带 v）')
    return int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)


def same_version(a, b):
    try:
        return parse(a) == parse(b)
    except ValueError:
        return str(a or '').strip().lstrip('v') == str(b or '').strip().lstrip('v')


def compare(a, b):
    pa, pb = parse(a), parse(b)
    return (pa > pb) - (pa < pb)
