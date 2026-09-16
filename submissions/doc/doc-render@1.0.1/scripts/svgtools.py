"""SVG 内联前处理：id / class / url(#) / href 加命名空间前缀；计算图内最小字号（layout.md §7 等效字号的输入）。纯标准库。"""
import re
import xml.etree.ElementTree as ET

DEFAULT_FONT_PX = 16.0


def _strip_prolog(s):
    s = re.sub(r'<\?xml[^>]*\?>', '', s)
    s = re.sub(r'<!DOCTYPE[^>]*>', '', s, flags=re.I)
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    s = re.sub(r'<script\b.*?</script>', '', s, flags=re.S | re.I)
    return s.strip()


def _local(tag):
    return tag.rsplit('}', 1)[-1] if '}' in tag else tag


def _len_px(v, inherited):
    if v is None: return None
    v = str(v).strip().lower()
    m = re.match(r'^(-?[\d.]+)\s*(px|pt|em|rem|%)?$', v)
    if not m: return None
    x = float(m.group(1)); u = m.group(2) or 'px'
    return {'px': x, 'pt': x * 96 / 72, 'em': x * inherited, 'rem': x * DEFAULT_FONT_PX, '%': x / 100 * inherited}[u]


def _decl_font(decls, inherited):
    fs = None
    for d in decls.split(';'):
        k, _, val = d.partition(':')
        k = k.strip().lower(); val = val.strip()
        if k == 'font-size':
            fs = _len_px(val.replace('!important', ''), inherited) or fs
        elif k == 'font':
            m = re.search(r'(-?[\d.]+(?:px|pt|em|rem|%))', val)
            if m: fs = _len_px(m.group(1), inherited) or fs
    return fs


def _css_rules(css):
    rules = []
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    for m in re.finditer(r'([^{}@]+)\{([^{}]*)\}', css):
        if 'font' not in m.group(2): continue
        for sel in m.group(1).split(','):
            sel = sel.strip()
            if not sel: continue
            last = re.split(r'[\s>+~]+', sel)[-1]
            cm = re.fullmatch(r'([A-Za-z*][\w-]*)?((?:[.#][\w-]+)*)(?::[\w-]+(?:\([^)]*\))?)*', last)
            if not cm: continue
            tag = cm.group(1)
            classes = re.findall(r'\.([\w-]+)', cm.group(2) or '')
            ids = re.findall(r'#([\w-]+)', cm.group(2) or '')
            rules.append((tag, classes, ids, m.group(2)))
    return rules


def analyze(svg_text):
    """返回 {viewbox_width, viewbox_height, min_font_px, text_nodes, has_foreign_object, error}。"""
    info = {'viewbox_width': None, 'viewbox_height': None, 'min_font_px': None, 'text_nodes': 0, 'has_foreign_object': False, 'error': None}
    try:
        root = ET.fromstring(_strip_prolog(svg_text))
    except ET.ParseError as ex:
        info['error'] = f'SVG 解析失败：{ex}'
        return info
    vb = root.get('viewBox')
    if vb:
        parts = re.split(r'[\s,]+', vb.strip())
        if len(parts) == 4:
            try: info['viewbox_width'], info['viewbox_height'] = float(parts[2]), float(parts[3])
            except ValueError: pass
    if info['viewbox_width'] is None:
        w, h = _len_px(root.get('width'), DEFAULT_FONT_PX), _len_px(root.get('height'), DEFAULT_FONT_PX)
        info['viewbox_width'], info['viewbox_height'] = w, h
    rules = []
    for el in root.iter():
        if _local(el.tag) == 'style' and el.text:
            rules += _css_rules(el.text)
    sizes = []

    def walk(el, inherited):
        tag = _local(el.tag)
        if tag == 'foreignObject':
            info['has_foreign_object'] = True
        fs = inherited
        a = _len_px(el.get('font-size'), inherited)
        if a: fs = a
        classes = (el.get('class') or '').split()
        eid = el.get('id')
        for rtag, rcls, rids, decls in rules:
            if rtag and rtag != '*' and rtag != tag: continue
            if rcls and not set(rcls) <= set(classes): continue
            if rids and eid not in rids: continue
            if not rtag and not rcls and not rids: continue
            v = _decl_font(decls, inherited)
            if v: fs = v
        st = el.get('style')
        if st:
            v = _decl_font(st, inherited)
            if v: fs = v
        if tag in ('text', 'tspan', 'textPath') and (el.text or '').strip():
            sizes.append(fs)
        for ch in el:
            walk(ch, fs)
    walk(root, DEFAULT_FONT_PX)
    info['text_nodes'] = len(sizes)
    info['min_font_px'] = round(min(sizes), 2) if sizes else None
    return info


def namespace(svg_text, prefix):
    """给 id、class、url(#…)、href="#…"、<style> 里的 #id 与 .class 加前缀；根 svg 改为随容器宽度缩放。"""
    s = _strip_prolog(svg_text)
    ids = set(re.findall(r'\sid="([^"]+)"', s))
    classes = set()
    for m in re.finditer(r'\sclass="([^"]*)"', s):
        classes.update(m.group(1).split())
    s = re.sub(r'(\sid=")([^"]+)(")', lambda m: m.group(1) + prefix + m.group(2) + m.group(3), s)
    s = re.sub(r'url\(\s*([\'"]?)#([^)\'"\s]+)\1\s*\)', lambda m: f'url(#{prefix}{m.group(2)})' if m.group(2) in ids else m.group(0), s)
    s = re.sub(r'((?:xlink:)?href=")#([^"]+)"', lambda m: f'{m.group(1)}#{prefix}{m.group(2)}"' if m.group(2) in ids else m.group(0), s)
    s = re.sub(r'(\sclass=")([^"]*)(")', lambda m: m.group(1) + ' '.join(prefix + c for c in m.group(2).split()) + m.group(3), s)

    def fix_css(css):
        css = re.sub(r'#([A-Za-z_][\w-]*)', lambda x: '#' + prefix + x.group(1) if x.group(1) in ids else x.group(0), css)
        css = re.sub(r'(?<![\w-])\.([A-Za-z_][\w-]*)', lambda x: '.' + prefix + x.group(1) if x.group(1) in classes else x.group(0), css)
        return css
    s = re.sub(r'(<style[^>]*>)(.*?)(</style>)', lambda m: m.group(1) + fix_css(m.group(2)) + m.group(3), s, flags=re.S)

    def root_fix(m):
        attrs = m.group(1)
        w = re.search(r'\swidth="([^"]*)"', attrs); h = re.search(r'\sheight="([^"]*)"', attrs)
        if 'viewBox=' not in attrs and w and h:
            wv, hv = _len_px(w.group(1), 16), _len_px(h.group(1), 16)
            if wv and hv: attrs += f' viewBox="0 0 {wv:g} {hv:g}"'
        attrs = re.sub(r'\s(width|height)="[^"]*"', '', attrs)
        attrs = re.sub(r'\sstyle="[^"]*"', '', attrs)
        return f'<svg{attrs} role="img">'
    s = re.sub(r'<svg\b([^>]*)>', root_fix, s, count=1)
    return s
