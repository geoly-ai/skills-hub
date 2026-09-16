#!/usr/bin/env python3
"""doc-figures 图检查（库 + CLI）。

库函数（供 build.py 与 doc-render / doc-qa 调用）：
- board_lint(svg_text) -> [issue]              飞书画板约束（references/feishu.md §3、figures-policy.md §4.3）
- whiteboard_check(path, timeout=180) -> dict  npx @larksuite/whiteboard-cli --check（text-overflow、node-overlap）；不可用时 {"skipped": 原因}
- font_stats(svg_text) -> dict                 最小字号（含继承、style 属性、<style> 规则保守估计）与 viewBox 宽
- equiv_pt(px, viewbox_width, width_ratio=1.0, landscape=False) -> float   layout.md §7 公式
- aspect_check(svg_text, lo=0.35, hi=0.7) -> issue|None                   流程类图宽高比（高 ÷ 宽）
- namespace_ids(svg_text, prefix) -> str       所有 id 及其引用加前缀（1b 内联多张 SVG 时防 id 冲突）

issue = {"rule", "severity": 必改|建议|提示, "message", "target"}

CLI：lint.py <文件.svg|.mmd> [--width-ratio 1.0] [--landscape] [--no-wb] [--flow] [--json]
"""
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgkit as k  # noqa: E402

WB_PKG = '@larksuite/whiteboard-cli@0.2.13'
FORBIDDEN = ('clipPath', 'mask', 'pattern', 'foreignObject', 'style', 'script')
SVGNS = '{http://www.w3.org/2000/svg}'


def _issue(rule, severity, message, target=''):
    return {'rule': rule, 'severity': severity, 'message': message, 'target': str(target)[:80]}


def _local(tag):
    return tag.split('}', 1)[1] if '}' in tag else tag


def _parse(svg_text):
    txt = re.sub(r'<!DOCTYPE[^>]*>', '', svg_text, flags=re.S)
    return ET.fromstring(txt.encode('utf-8'))


def _num(v):
    m = re.match(r'\s*(-?[\d.]+)\s*(px|pt)?\s*$', str(v or ''))
    if not m:
        return None
    x = float(m.group(1))
    return x * 4 / 3 if m.group(2) == 'pt' else x


# ------------------------------------------------------------------ 画板约束

def board_lint(svg_text):
    issues = []
    try:
        root = _parse(svg_text)
    except ET.ParseError as e:
        return [_issue('BL0_parse', '必改', f'SVG 不是合法 XML：{e}')]
    if _local(root.tag) != 'svg':
        issues.append(_issue('BL0_parse', '必改', '根元素不是 svg'))
    if not root.get('viewBox'):
        issues.append(_issue('BL5_viewbox', '必改', '缺少 viewBox'))
    counts = {}
    n_text = n_path = 0
    for el in root.iter():
        tag = _local(el.tag)
        if tag in FORBIDDEN:
            counts[tag] = counts.get(tag, 0) + 1
        if tag == 'filter':
            kids = [_local(c.tag) for c in el]
            if kids != ['feDropShadow']:
                issues.append(_issue('BL2_filter', '必改', f'filter 只允许单个 feDropShadow 阴影，实际为 {"+".join(kids) or "空"}', el.get('id', '')))
        if tag == 'rect':
            h = _num(el.get('height'))
            if h is not None and h < 2:
                issues.append(_issue('BL3_thin_rect', '必改', f'rect 高度 {h:g} < 2（飞书画板解析失败，分隔线用 line）', el.get('id', '')))
        if tag in ('text', 'tspan'):
            n_text += 1
        if tag == 'path':
            n_path += 1
            if re.match(r'glyph|font', el.get('id', ''), re.I):
                issues.append(_issue('BL4_text_as_path', '必改', '文字被转成了 path（glyph），画板无法编辑', el.get('id', '')))
        for key, v in el.attrib.items():
            if _local(key) == 'href' and v and not v.strip().startswith('#') and not v.strip().startswith('data:'):
                issues.append(_issue('BL6_external', '必改', f'{tag} 引用外部资源：{v[:60]}'))
        for key, v in el.attrib.items():
            if 'url(' in v and re.search(r'url\(\s*["\']?(https?:|file:|//)', v):
                issues.append(_issue('BL6_external', '必改', f'属性 {_local(key)} 引用外部资源'))
    for tag, c in counts.items():
        issues.append(_issue('BL1_forbidden', '必改', f'含 {c} 个 {tag} 元素（飞书画板不支持）', tag))
    if n_text == 0 and n_path > 20:
        issues.append(_issue('BL4_text_as_path', '建议', f'没有 text 元素却有 {n_path} 个 path：文字可能被转成了轮廓'))
    return issues


# ------------------------------------------------------------------ whiteboard-cli

def whiteboard_check(path, timeout=180):
    """返回 {"errors", "warnings", "summary", "issues"} 或 {"skipped": 原因}。"""
    if not shutil.which('npx'):
        return {'skipped': 'npx 不可用'}
    try:
        r = subprocess.run(['npx', '-y', WB_PKG, '--check', '-i', os.path.abspath(path)], capture_output=True, text=True, timeout=timeout,
                           cwd=os.path.dirname(os.path.abspath(path)))
    except subprocess.TimeoutExpired:
        return {'skipped': f'whiteboard-cli 超时（{timeout}s，可能是网络或 npx 缓存问题）'}
    except OSError as e:
        return {'skipped': f'whiteboard-cli 无法启动：{e}'}
    m = re.search(r'\{.*\}', r.stdout, re.S)
    if not m:
        return {'skipped': f'whiteboard-cli 无输出（退出码 {r.returncode}）：{(r.stderr or "").strip()[-200:]}'}
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {'skipped': 'whiteboard-cli 输出不是 JSON'}
    ck = (d.get('data') or {}).get('check')
    if ck is None:
        if d.get('code') != 0:
            return {'errors': 1, 'warnings': 0, 'summary': {}, 'issues': [{'type': 'parse_error', 'severity': 'error', 'message': d.get('error') or str(d)[:200]}]}
        ck = {}
    return {'errors': ck.get('errors', 0), 'warnings': ck.get('warnings', 0), 'summary': ck.get('summary', {}), 'issues': ck.get('issues', [])}


# ------------------------------------------------------------------ 字号

def _style_decls(style):
    out = {}
    for part in (style or '').split(';'):
        if ':' in part:
            a, b = part.split(':', 1)
            out[a.strip()] = b.strip()
    return out


def _size(v, inherited):
    if v is None:
        return inherited
    v = str(v).strip().replace('!important', '').strip()
    m = re.match(r'^(-?[\d.]+)\s*(px|pt|em|rem|%)?$', v)
    if not m:
        return inherited
    x, u = float(m.group(1)), m.group(2)
    if u == 'pt':
        return x * 4 / 3
    if u == 'em':
        return x * inherited
    if u == 'rem':
        return x * 16
    if u == '%':
        return x / 100 * inherited
    return x


def font_stats(svg_text):
    """返回 {"viewbox_width", "viewbox_height", "min_font_px", "texts", "notes"}。
    继承链：svg / g 的 font-size 属性与 style → text → tspan；未声明时按浏览器默认 16px。
    含 <style> 元素（未内联的 Mermaid 等）时，把样式表里出现的最小 font-size 也计入（保守），并在 notes 说明。"""
    root = _parse(svg_text)
    vb = [float(x) for x in re.split(r'[\s,]+', root.get('viewBox', '').strip())] if root.get('viewBox') else None
    notes = []
    sizes = []

    def walk(el, inherited):
        tag = _local(el.tag)
        st = _style_decls(el.get('style'))
        cur = _size(st.get('font-size', el.get('font-size')), inherited)
        if tag in ('text', 'tspan', 'textPath'):
            # 只算本元素直接包含的文字（自身 text + 子元素 tail）；子 tspan 的文字按子 tspan 自己的字号计
            own = ((el.text or '') + ''.join(c.tail or '' for c in el)).strip()
            if own and el.get('display') != 'none' and st.get('display') != 'none':
                sizes.append((cur, own[:30]))
        for c in el:
            if _local(c.tag) in ('defs', 'marker', 'symbol'):
                continue
            walk(c, cur)

    walk(root, 16.0)
    css_min = None
    for el in root.iter():
        if _local(el.tag) == 'style' and el.text:
            vals = [_size(v, 16.0) for v in re.findall(r'font-size\s*:\s*([\d.]+\s*(?:px|pt|em|rem|%)?)', el.text)]
            if vals:
                css_min = min(vals)
    if css_min is not None:
        notes.append(f'含 <style> 元素，样式表最小 font-size {css_min:g}px 计入（保守估计）')
    all_px = [x for x, _ in sizes] + ([css_min] if css_min is not None else [])
    mn = min(all_px) if all_px else None
    return {'viewbox_width': vb[2] if vb else None, 'viewbox_height': vb[3] if vb else None, 'min_font_px': round(mn, 2) if mn is not None else None,
            'min_font_text': next((t for x, t in sizes if x == mn), None), 'texts': len(sizes), 'notes': notes}


def equiv_pt(px, viewbox_width, width_ratio=1.0, landscape=False):
    mm = k.LANDSCAPE_MM if landscape else k.CONTENT_MM
    return k.equiv_pt(px, viewbox_width, mm, width_ratio)


def font_issue(stats, width_ratio=1.0, landscape=False):
    if not stats.get('min_font_px') or not stats.get('viewbox_width'):
        return None, None
    pt = equiv_pt(stats['min_font_px'], stats['viewbox_width'], width_ratio, landscape)
    if pt < k.MIN_PT - 1e-9:
        need = k.min_px_for(stats['viewbox_width'], k.LANDSCAPE_MM if landscape else k.CONTENT_MM, width_ratio)
        return round(pt, 2), _issue('LY4_font', '必改', f'等效最小字号 {pt:.2f}pt < {k.MIN_PT}pt（最小 {stats["min_font_px"]:g}px，viewBox 宽 {stats["viewbox_width"]:g}，'
                                    f'显示宽 {width_ratio:g}×版心）；该宽度下最小应为 {need}px，或缩小画布 / 拆图 / 用横向页', stats.get('min_font_text') or '')
    return round(pt, 2), None


def suggested_width_ratio(viewbox_width):
    """让本图与 1200 宽品牌图的字号观感一致的显示宽比例（窄图不必撑满版心）。"""
    return round(min(1.0, viewbox_width / k.BASE_W), 2)


# ------------------------------------------------------------------ 宽高比

def aspect_check(svg_text, lo=0.35, hi=0.7):
    root = _parse(svg_text)
    vb = root.get('viewBox')
    if not vb:
        return None
    _, _, w, h = [float(x) for x in re.split(r'[\s,]+', vb.strip())]
    r = h / w if w else 0
    if lo <= r <= hi:
        return None
    hint = '超过 4 个节点的线性流程改两行阶梯式（Mermaid 加 `%% doc-figures: stairs`，svgkit phases 设 rows）' if r > hi else '图过扁：减少每行节点数或改成多行'
    return _issue('FA1_aspect', '建议', f'宽高比 1:{r:.2f} 不在 1:{lo}–{hi}（流程类图）；{hint}')


# ------------------------------------------------------------------ id 命名空间

ID_ATTR = re.compile(r'(\sid\s*=\s*)(["\'])([^"\']+)(\2)')


def namespace_ids(svg_text, prefix):
    """给 SVG 内所有 id 加前缀，并同步改写引用：url(#id)、href / xlink:href="#id"（单双引号均可）、aria-labelledby / aria-describedby、
    <style> 里选择器中的 #id（声明块内的颜色值如 #fff 不动）。只改写本 SVG 里真实存在的 id。已全部带前缀时原样返回（幂等）。

    参数：svg_text 为 SVG 字符串；prefix 为前缀，建议 f"f{序号}-"（需以字母开头，只含字母、数字、-、_）。
    返回：改写后的 SVG 字符串。"""
    if not re.match(r'^[A-Za-z][\w-]*$', prefix):
        raise ValueError(f'前缀不合法：{prefix!r}')
    ids = {m[2] for m in ID_ATTR.findall(svg_text)}
    if not ids or all(i.startswith(prefix) for i in ids):
        return svg_text
    alt = '|'.join(sorted((re.escape(i) for i in ids), key=len, reverse=True))
    out = ID_ATTR.sub(lambda m: m.group(1) + m.group(2) + (prefix + m.group(3) if m.group(3) in ids else m.group(3)) + m.group(4), svg_text)
    out = re.sub(r'url\(\s*(["\']?)#(' + alt + r')\1\s*\)', lambda m: f'url({m.group(1)}#{prefix}{m.group(2)}{m.group(1)})', out)
    out = re.sub(r'((?:xlink:)?href\s*=\s*)(["\'])#(' + alt + r')\2', lambda m: f'{m.group(1)}{m.group(2)}#{prefix}{m.group(3)}{m.group(2)}', out)

    def aria(m):
        toks = [(prefix + t if t in ids else t) for t in m.group(3).split()]
        return m.group(1) + m.group(2) + ' '.join(toks) + m.group(2)
    out = re.sub(r'(aria-(?:labelledby|describedby)\s*=\s*)(["\'])(.*?)\2', aria, out)

    def selectors(css):
        # 只改选择器部分（花括号外）；声明块里的 #fff 等颜色值保持不变（url(#id) 已在上面统一处理）
        parts = re.split(r'(\{[^{}]*\})', css)
        return ''.join(p if p.startswith('{') else re.sub(r'#(' + alt + r')(?![\w-])', lambda mm: '#' + prefix + mm.group(1), p) for p in parts)

    out = re.sub(r'(<style[^>]*>)(.*?)(</style>)', lambda m: m.group(1) + selectors(m.group(2)) + m.group(3), out, flags=re.S)
    return out


# ------------------------------------------------------------------ CLI

def lint_file(path, width_ratio=1.0, landscape=False, wb=True, flow=False):
    res = {'file': path}
    if path.endswith('.mmd'):
        import mermaid
        src = open(path, encoding='utf-8').read()
        res['source_lint'] = mermaid.lint_source(src)
        res['whiteboard_check'] = whiteboard_check(path) if wb else {'skipped': '--no-wb'}
        return res
    svg = open(path, encoding='utf-8').read()
    res['board_lint'] = board_lint(svg)
    st = font_stats(svg)
    pt, fi = font_issue(st, width_ratio, landscape)
    res.update({'viewbox_width': st['viewbox_width'], 'min_font_px': st['min_font_px'], 'min_font_pt': pt, 'font_issue': fi, 'notes': st['notes']})
    if flow:
        res['aspect'] = aspect_check(svg)
    res['whiteboard_check'] = whiteboard_check(path) if wb else {'skipped': '--no-wb'}
    return res


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    path = argv[0]
    wr = float(argv[argv.index('--width-ratio') + 1]) if '--width-ratio' in argv else 1.0
    res = lint_file(path, wr, '--landscape' in argv, '--no-wb' not in argv, '--flow' in argv)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    bad = res.get('board_lint') or []
    must = [i for i in bad if i['severity'] == '必改'] + ([res['font_issue']] if res.get('font_issue') else []) + \
           [i for i in res.get('source_lint', []) if i['severity'] == '必改']
    wbc = res.get('whiteboard_check') or {}
    return 1 if must or wbc.get('errors') else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
