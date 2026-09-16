"""正文编号扫描与遮蔽的共享实现（2026-09-15 W3-H 收拢：doc-author authorlib、doc-orchestrator xref_check、doc-shared trace_matrix 共用）。
遮蔽口径与共享解析器 docmark_parse 一致：
  - 围栏代码块只认 ``` 开头的行（行首空白可有），任意一条 ``` 行切换进出；~~~ 不是代码块（解析器按正文渲染）。
  - HTML 注释 <!-- … --> 含行内起始、跨行、同行多段、未闭合遮到文末；注释内的 ``` 不切换代码块；代码块内的 <!-- 是代码。
编号匹配：类型包 numbering.entities 的 pattern 去掉首尾一个 ^ / $，前后不得粘连字母数字（前面也不得是 _ 或 -），
  简写续号 REQ-A-01/02 展开为 REQ-A-01、REQ-A-02（续号位宽须与原编号末段一致且整体匹配 pattern）。只读，不写文件。"""
import re


def masked_lines(lines):
    """把 HTML 注释（<!-- … -->，含行内起始、跨行、未闭合到文末）的内容替换为空格，行数与列位置不变。
    围栏代码块内不处理（代码里的 <!-- 是代码）。"""
    out, inside, fence = [], False, False
    for l in lines:
        if not inside and l.lstrip().startswith('```'):
            fence = not fence; out.append(l); continue
        if fence:
            out.append(l); continue
        buf, i = [], 0
        while i < len(l):
            if inside:
                j = l.find('-->', i)
                if j < 0:
                    buf.append(' ' * (len(l) - i)); i = len(l)
                else:
                    buf.append(' ' * (j + 3 - i)); i = j + 3; inside = False
            else:
                j = l.find('<!--', i)
                if j < 0:
                    buf.append(l[i:]); i = len(l)
                else:
                    buf.append(l[i:j]); i = j; inside = True
        out.append(''.join(buf))
    return out


def comment_mask(lines):
    """HTML 注释覆盖的行（1 起）集合，含跨行注释；与解析器一致：以 <!-- 开头的行到 --> 所在行。"""
    inside, out = False, set()
    for i, l in enumerate(lines, 1):
        s = l.strip()
        if inside:
            out.add(i)
            if '-->' in l: inside = False
            continue
        if s.startswith('<!--'):
            out.add(i)
            if '-->' not in s[4:]: inside = True
    return out


def code_mask(lines):
    """围栏代码块内的行（1 起）集合（含 ``` 行本身）。"""
    inside, out = False, set()
    for i, l in enumerate(lines, 1):
        if l.lstrip().startswith('```'):
            inside = not inside; out.add(i); continue
        if inside: out.add(i)
    return out


def visible_lines(lines):
    """[(行号 1 起, 可见文本)]：围栏代码块（含 ``` 行）为空串，HTML 注释内容替换为空格（同 masked_lines，列位置不变）。
    与 masked_lines 同一趟状态：注释内的 ``` 不切换代码块。"""
    out, inside, fence = [], False, False
    for i, (l, m) in enumerate(zip(lines, masked_lines(lines)), 1):
        if not inside and l.lstrip().startswith('```'):
            fence = not fence; out.append((i, '')); continue
        if fence:
            out.append((i, '')); continue
        out.append((i, m))
        # 与 masked_lines 同步注释状态：扫描本行原文里最后一个未闭合的 <!--
        j = 0
        while j < len(l):
            if inside:
                k = l.find('-->', j)
                if k < 0: break
                inside, j = False, k + 3
            else:
                k = l.find('<!--', j)
                if k < 0: break
                inside, j = True, k   # 与 masked_lines 一致：从 <!-- 本身开始找 -->（<!--> 视为闭合）
    return out


def code_regex(pattern):
    """(边界匹配正则, 整串匹配正则)：pattern 去掉首尾各一个 ^ / $。"""
    core = pattern.strip()
    core = core[1:] if core.startswith('^') else core
    core = core[:-1] if core.endswith('$') else core
    return re.compile(r'(?<![A-Za-z0-9_-])(' + core + r')(?![A-Za-z0-9_])'), re.compile('^(?:' + core + ')$')


def find_codes(text, rx, full):
    """返回文本里的编号（去重保序，含简写续号：REQ-RULE-01/02 → REQ-RULE-01、REQ-RULE-02；续号位宽须与原编号末段一致）。"""
    out = []
    for m in rx.finditer(text or ''):
        code = m.group(1)
        out.append(code)
        tail = re.match(r'((?:/\d+)+)(?![A-Za-z0-9_])', text[m.end():])
        last = re.match(r'^(.*?)(\d+)$', code)
        if tail and last:
            for n in tail.group(1).split('/')[1:]:
                c = last.group(1) + n
                if len(n) == len(last.group(2)) and full.match(c):
                    out.append(c)
    return list(dict.fromkeys(out))


def scan_codes(rows, pattern):
    """rows 为 [(行号, 文本)]（通常是 visible_lines 的结果加上数据块行），返回 {编号: 首次出现行号}。"""
    rx, full = code_regex(pattern)
    seen = {}
    for ln, text in rows:
        for code in find_codes(text, rx, full):
            seen.setdefault(code, ln)
    return seen
