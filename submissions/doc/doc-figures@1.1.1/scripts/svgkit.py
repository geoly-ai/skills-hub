"""svgkit：品牌 SVG 画布、文本测宽与换行、正交连线路由、版面自检。

数值只从 doc-shared 读取：brand/generated/svg-palette.json（调色板、图风格）与 brand/tokens.json（最小字号、版心宽）。
输出 SVG 满足飞书画板约束：无 clipPath / mask / pattern / foreignObject / style，文字为 text，无高度 < 2 的 rect。

兼容：保留旧 API（S(w, h, title, sub)、S.t、S.box、S.pill、S.line、S.rect、S.save、S.o、调色板 C）。
"""
import heapq
import html
import json
import math
import os
import re
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.dirname(os.path.dirname(HERE))
SHARED = os.environ.get('DOC_SHARED_DIR') or os.path.join(SKILLS, 'doc-shared')
PALETTE_PATH = os.path.join(SHARED, 'brand', 'generated', 'svg-palette.json')
TOKENS_PATH = os.path.join(SHARED, 'brand', 'tokens.json')
METRICS_PATH = os.path.join(HERE, 'font_metrics.json')
PT_PER_MM = 72 / 25.4


def _load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


P = _load(PALETTE_PATH)
TOKENS = _load(TOKENS_PATH)
FIG = P['figure']
PALETTE = P['palette']
C = {k: (v['stroke'], v['fill'], v['text']) for k, v in PALETTE.items()}
FPX = FIG['font_px']
FONT_FAMILY = FIG['font_family']
TEXT = FIG['text']
MIN_PT = TOKENS['size']['figure_min']
CONTENT_MM = TOKENS['page']['content_width_mm']
LANDSCAPE_MM = TOKENS['page']['landscape_content_width_mm']
BASE_W = FIG['canvas_width_px']
MARGIN = FIG['margin_px']
_M = _load(METRICS_PATH)


class SpecError(ValueError):
    """图源 spec 不合法（字段缺失、引用不存在等）。"""


# ---------------------------------------------------------------- 尺寸与字号

def equiv_pt(px, viewbox_width, content_mm=CONTENT_MM, width_ratio=1.0):
    """layout.md §7：等效 pt = px × 显示宽 mm ÷ viewBox 宽 × 72 ÷ 25.4。"""
    return px * content_mm * width_ratio / viewbox_width * PT_PER_MM


def min_px_for(viewbox_width, content_mm=CONTENT_MM, width_ratio=1.0, pt=MIN_PT):
    return math.ceil(round(pt / PT_PER_MM * viewbox_width / (content_mm * width_ratio), 6))


def canvas_width_for(display=None):
    """按显示方式反推画布宽：保持品牌字号（最小 17 px）时等效字号不低于 7 pt。
    display = {"width_ratio": 0.6, "landscape": false}；缺省为版心全宽 → 1200。"""
    d = display or {}
    ratio = float(d.get('width_ratio', 1.0))
    mm = LANDSCAPE_MM if d.get('landscape') else CONTENT_MM
    return int(round(BASE_W * ratio * mm / CONTENT_MM))


def role_color(role):
    """角色名（tokens figure.role_colors）或调色板色名 → 调色板色名。"""
    if role is None:
        return 'purple'
    if role in FIG['role_colors']:
        return FIG['role_colors'][role]
    if role in PALETTE:
        return role
    raise SpecError(f'未知角色或颜色：{role}（可用角色 {sorted(FIG["role_colors"])}，色名 {sorted(PALETTE)}）')


# ---------------------------------------------------------------- 文本

_CLOSE = set('，。、；：！？）】」』》〉…”’%％,.;:!?)]}·')
_OPEN = set('（【「『《〈“‘([{')
_TOKEN = re.compile(r"[A-Za-z0-9_\-./:@#%&+'’=<>~^|\\$]+|[ \t\n]+|.", re.S)
NBSP = '\u00a0'  # 不断行空格：编号与名称之间用它绑定
_BREAK_AFTER = set(' ·/、，,：:；;-–—|）)」』》+＋→')
_NO_START = _CLOSE | set('/·-–—|')
_FUNC = set('与和及的并或、')
_CJK = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')


def cjk_space(text):
    """中文与拉丁字母、数字之间补一个空格（typography T1）。幂等。"""
    t = re.sub(r'([\u3400-\u4dbf\u4e00-\u9fff])([A-Za-z0-9])', r'\1 \2', str(text))
    return re.sub(r'([A-Za-z0-9%])([\u3400-\u4dbf\u4e00-\u9fff])', r'\1 \2', t)


WJ = '\u2060'  # 零宽连接符：标签与正文之间用它禁止断行，不占宽度


def char_w(ch, bold=False):
    if ch == WJ:
        return 0
    tab = _M['bold' if bold else 'regular']
    if ch in tab:
        return tab[ch]
    if unicodedata.east_asian_width(ch) in ('W', 'F'):
        return _M['cjk_bold' if bold else 'cjk']
    return 0.6


def text_width(s, size, bold=False):
    return sum(char_w(ch, bold) for ch in s) * size


def ascent(size):
    return _M['font_ascent'] * size


def descent(size):
    return _M['font_descent'] * size


def _is_word_char(ch):
    return bool(re.match(r"[A-Za-z0-9_\-./:@#%&+'’=<>~^|\\$]", ch))


BAD_BREAK = 40  # 罚分 ≥ 此值表示断在中文词中间


def _break_penalty(tokens, i):
    """在 tokens[i] 与 tokens[i+1] 之间断行的罚分；None 表示不允许。"""
    a, b = tokens[i], tokens[i + 1]
    if a in (NBSP, WJ) or b in (NBSP, WJ):
        return 900
    if a.isspace() or b.isspace():
        # 断在空格处：看空格两侧的实际字符
        pi = i if not a.isspace() else i - 1
        ni = i + 1 if not b.isspace() else i + 2
        prev = tokens[pi] if pi >= 0 else ''
        nxt = tokens[ni] if ni < len(tokens) else ''
        if nxt and nxt[0] in _NO_START:
            return 500
        if prev and prev[-1] in _OPEN:
            return 500
        if prev and prev[-1] in _BREAK_AFTER:
            return 0
        if (prev and _CJK.match(prev[-1])) or (nxt and _CJK.match(nxt[0])):
            return 10  # 中英文之间的 T1 空格：可以断，但不如标点
        return 2
    if b[0] in _NO_START:
        return 500
    if a[-1] in _OPEN:
        return 500
    if a[-1] in _BREAK_AFTER:
        return 0
    if b[0] in _OPEN:
        return 2
    if a in _FUNC:
        return 6
    ca, cb = bool(_CJK.match(a[-1])), bool(_CJK.match(b[0]))
    if ca and cb:
        # 所在中文串（被分隔符截断的连续汉字）内的位置：避免留下单字碎片，偏好两字一断
        j = i
        while j >= 0 and len(tokens[j]) == 1 and (_CJK.match(tokens[j]) or tokens[j] == WJ):
            j -= 1
        left = sum(1 for t in tokens[j + 1:i + 1] if t != WJ)
        m = i + 1
        while m < len(tokens) and len(tokens[m]) == 1 and (_CJK.match(tokens[m]) or tokens[m] == WJ):
            m += 1
        right = sum(1 for t in tokens[i + 1:m] if t != WJ)
        pen = BAD_BREAK
        if left == 1 or right == 1:
            pen += 80
        if left % 2 == 1:
            pen += 12
        return pen
    return 5


def _layout(tokens, size, width, bold):
    """动态规划断行：总代价 = 行数×60 + 断点罚分 + 参差（非末行未填满比例²×20）+ 末行过短惩罚。
    返回 (lines, overflow, cost, worst_break)。"""
    n = len(tokens)
    if n == 0:
        return [''], False, 0, 0
    widths = [text_width(t, size, bold) for t in tokens]
    INF = float('inf')
    best = [INF] * (n + 1)
    back = [0] * (n + 1)
    worst = [0] * (n + 1)
    best[0] = 0
    for j in range(1, n + 1):  # 行 = tokens[i:j]
        w = 0.0
        for i in range(j - 1, -1, -1):
            w += widths[i]
            seg = ''.join(tokens[i:j]).strip()
            if not seg:
                if best[i] < best[j]:
                    best[j], back[j], worst[j] = best[i], i, worst[i]
                continue
            lw = text_width(seg, size, bold)
            limit = width + (0.5 * size if seg[-1] in _NO_START else 0)  # 行尾标点可悬挂半个字宽
            single = (j - i == 1) or all(t.isspace() for t in tokens[i:j - 1])
            if lw > limit + 0.01 and not single:
                if lw > width + size:
                    break
                continue
            if best[i] == INF:
                continue
            pen = 0 if i == 0 else _break_penalty(tokens, i - 1)
            cost = best[i] + 60 + pen
            if lw > limit + 0.01:
                cost += 10000
            if j < n:
                cost += ((max(width - lw, 0)) / width) ** 2 * 20 if width > 0 else 0
            elif i > 0:
                if lw < width * 0.5:
                    cost += ((width * 0.5 - lw) / width) ** 2 * 60
                if lw < width * 0.2 and len(seg) <= 2:
                    cost += 30
            if cost < best[j]:
                best[j], back[j], worst[j] = cost, i, max(worst[i], pen)
    lines, j = [], n
    while j > 0:
        i = back[j]
        seg = ''.join(tokens[i:j]).strip()
        if seg:
            lines.append(seg)
        j = i
    lines.reverse()
    overflow = any(text_width(ln, size, bold) > width + (0.5 * size if ln and ln[-1] in _NO_START else 0) + 0.01 for ln in lines)
    return lines or [''], overflow, best[n], worst[n]


def wrap_info(text, size, width, bold=False, balance=True, max_lines=None, slack=0):
    """换行：优先在空格、标点、/ · + 等分隔处断；中文词尽量不从中间断（不留单字碎片）；拉丁词与数字串不拆。
    slack > 0 时：若按 width 只能断在中文词中间，允许把行宽放宽到 width + slack（调用方用卡片内边距兜底）。
    返回 (lines, overflow)；overflow=True 表示有单个词比可用宽度还宽（不截断，由自检报越界）。"""
    text = cjk_space('' if text is None else str(text))
    out, overflow = [], False
    for para in text.split('\n'):
        tokens = _TOKEN.findall(para)
        lines, ov, cost, worst = _layout(tokens, size, width, bold)
        if slack and (worst >= BAD_BREAK or ov):
            l2, ov2, c2, w2 = _layout(tokens, size, width + slack, bold)
            if (w2, ov2, c2) < (worst, ov, cost):
                lines, ov = l2, ov2
        out += lines
        overflow = overflow or ov
    if max_lines and len(out) > max_lines:
        overflow = True
    return out, overflow


def break_quality(lines):
    """断在中文词中间的次数（测试与自检用）。"""
    bad = 0
    for a, b in zip(lines, lines[1:]):
        if a and b and _CJK.match(a[-1]) and _CJK.match(b[0]):
            bad += 1
    return bad


def wrap(text, size, width, bold=False, balance=True, slack=0):
    return wrap_info(text, size, width, bold, balance, slack=slack)[0]


def longest_word(text, size, bold=False):
    toks = [t for t in _TOKEN.findall(cjk_space(text or '')) if not t.isspace()]
    return max((text_width(t, size, bold) for t in toks), default=0)


def esc(s):
    return html.escape(str(s), quote=True)


def fmt(v):
    if isinstance(v, float):
        v = round(v, 2)
        return str(int(v)) if v == int(v) else str(v)
    return str(v)


# ---------------------------------------------------------------- 画布

class S:
    """画布。所有绘制方法都登记几何信息，供 check() 自检与 build 的 Chrome 实测。"""

    def __init__(s, w, h=None, title='', sub='', min_px=None, width_ratio=1.0, content_mm=CONTENT_MM):
        s.w, s.h = w, h
        s.o = []
        s.texts = []      # {i, x, y, w, h, size, text, container, label}
        s.nodes = []      # {id, x, y, w, h, group}
        s.frames = []     # {id, x, y, w, h}
        s.segments = []   # (x1, y1, x2, y2, edge_id)
        s.arrows = []     # (x, y, edge_id) 箭头尖端
        s.issues = []
        s.width_ratio, s.content_mm = width_ratio, content_mm
        s.min_px = min_px or min_px_for(w, content_mm, width_ratio)
        s.top = MARGIN
        if title:
            s.t(MARGIN, 50, title, FPX['title'], TEXT['title'], bold=True)
            s.top = 70
        if sub:
            s.t(MARGIN, 84 if title else 58, sub, FPX['subtitle'], TEXT['subtitle'])
            s.top = 108 if title else 82

    # --- 基础元素
    def t(s, x, y, txt, size=None, color=None, anchor='start', bold=False, container=None, label=False, dash=False):
        size = size or FPX['node_body']
        color = color or TEXT['body']
        txt = cjk_space(txt)
        w = text_width(txt, size, bold)
        x0 = x - w / 2 if anchor == 'middle' else (x - w if anchor == 'end' else x)
        rec = {'i': len(s.texts), 'x': x0, 'y': y - ascent(size), 'w': w, 'h': ascent(size) + descent(size),
               'size': size, 'text': txt, 'container': container, 'label': label}
        s.texts.append(rec)
        attrs = f' font-weight="bold"' if bold else ''
        anchor_attr = f' text-anchor="{anchor}"' if anchor != 'start' else ''
        s.o.append(f'<text x="{fmt(x)}" y="{fmt(y)}" font-size="{fmt(size)}"{attrs} fill="{color}"{anchor_attr}>{esc(txt)}</text>')
        return rec

    def rect(s, x, y, w, h, fill='#F8F9FA', stroke='#DADCE0', rx=0, dash=False, sw=1, node_id=None, frame_id=None, group=None, dasharray=None, title_h=0):
        if h < 2:
            s.issues.append(issue('board_thin_rect', f'矩形高度 {h} < 2（飞书画板解析失败，分隔线改用 line）'))
        da = dasharray or (FIG['dash']['placeholder'] if dash else None)
        s.o.append(f'<rect x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}"' + (f' rx="{fmt(rx)}"' if rx else '')
                   + f' fill="{fill}" stroke="{stroke}" stroke-width="{fmt(sw)}"' + (f' stroke-dasharray="{da}"' if da else '') + '/>')
        if node_id is not None:
            s.nodes.append({'id': node_id, 'x': x, 'y': y, 'w': w, 'h': h, 'group': group})
        if frame_id is not None:
            s.frames.append({'id': frame_id, 'x': x, 'y': y, 'w': w, 'h': h, 'fill': fill, 'title_h': title_h})

    def hline(s, x1, x2, y, color='#DADCE0', sw=1):
        s.o.append(f'<line x1="{fmt(x1)}" y1="{fmt(y)}" x2="{fmt(x2)}" y2="{fmt(y)}" stroke="{color}" stroke-width="{fmt(sw)}"/>')

    def vline(s, x, y1, y2, color='#DADCE0', sw=1, dasharray=None):
        s.o.append(f'<line x1="{fmt(x)}" y1="{fmt(y1)}" x2="{fmt(x)}" y2="{fmt(y2)}" stroke="{color}" stroke-width="{fmt(sw)}"'
                   + (f' stroke-dasharray="{dasharray}"' if dasharray else '') + '/>')

    def circle(s, cx, cy, r, fill, stroke=None, sw=1.5):
        s.o.append(f'<circle cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r)}" fill="{fill}"' + (f' stroke="{stroke}" stroke-width="{fmt(sw)}"' if stroke else '') + '/>')

    def path(s, d, fill='none', stroke=None, sw=1.5):
        s.o.append(f'<path d="{d}" fill="{fill}"' + (f' stroke="{stroke}" stroke-width="{fmt(sw)}"' if stroke else '') + '/>')

    def polygon(s, pts, fill, stroke=None, sw=1.5):
        s.o.append(f'<polygon points="{" ".join(f"{fmt(x)},{fmt(y)}" for x, y in pts)}" fill="{fill}"'
                   + (f' stroke="{stroke}" stroke-width="{fmt(sw)}"' if stroke else '') + '/>')

    def line(s, pts, color='gray', dash=False, head=True, sw=None, edge_id=None, dasharray=None):
        c = C[color][0] if color in C else color
        sw = sw or FIG['stroke_px']['edge']
        da = dasharray or (FIG['dash']['reference_edge'] if dash else None)
        pts = [(float(x), float(y)) for x, y in pts]
        body = list(pts)
        ah = FIG['arrowhead_px']
        if head and len(pts) >= 2:
            (x1, y1), (x2, y2) = pts[-2], pts[-1]
            dx, dy = (x2 > x1) - (x2 < x1), (y2 > y1) - (y2 < y1)
            body[-1] = (x2 - dx * ah, y2 - dy * ah)
        s.o.append(f'<polyline points="{" ".join(f"{fmt(x)},{fmt(y)}" for x, y in body)}" fill="none" stroke="{c}" stroke-width="{fmt(sw)}"'
                   + (f' stroke-dasharray="{da}"' if da else '') + '/>')
        if head and len(pts) >= 2:
            (x1, y1), (x2, y2) = pts[-2], pts[-1]
            hw = ah * 6 / 11
            if abs(x2 - x1) >= abs(y2 - y1):
                d = 1 if x2 > x1 else -1
                tri = [(x2 - d * ah, y2 - hw), (x2 - d * ah, y2 + hw), (x2, y2)]
            else:
                d = 1 if y2 > y1 else -1
                tri = [(x2 - hw, y2 - d * ah), (x2 + hw, y2 - d * ah), (x2, y2)]
            s.polygon(tri, c)
        for (a, b) in zip(pts, pts[1:]):
            s.segments.append((a[0], a[1], b[0], b[1], edge_id))
        if head and len(pts) >= 2:
            s.arrows.append((pts[-1][0], pts[-1][1], edge_id))

    # --- 复合元素
    def card(s, x, y, w, h, title, body=(), color='purple', dash=False, emphasis=False, fill=None, node_id=None, group=None,
             title_size=None, body_size=None, align='middle', title_color=None, sw=None, dasharray=None, title_bold=True):
        """圆角卡片：标题（粗体）+ 说明行，整体垂直居中。title / body 已换好行（list）。"""
        st, bg, tc = C[color]
        rx = FIG['radius_px']['node']
        sw = sw or (FIG['stroke_px']['emphasis'] if emphasis else FIG['stroke_px']['node'])
        s.rect(x, y, w, h, fill or bg, st, rx=rx, sw=sw, dash=dash, node_id=node_id, group=group,
               dasharray=dasharray or (FIG['dash']['placeholder'] if dash else None))
        ts = title_size or (FPX['node_title_emphasis'] if emphasis else FPX['node_title'])
        bs = body_size or FPX['node_body']
        tl = title if isinstance(title, list) else ([title] if title else [])
        bl = list(body)
        tlh, blh = round(ts * 1.4), round(bs * 1.35)
        gap = 6 if tl and bl else 0
        block = len(tl) * tlh + gap + len(bl) * blh
        cy = y + (h - block) / 2
        box = (x + 1, y + 1, w - 2, h - 2)
        tx = x + w / 2 if align == 'middle' else x + 14
        for i, ln in enumerate(tl):
            base = cy + i * tlh + (tlh + ascent(ts) - descent(ts)) / 2
            s.t(tx, base, ln, ts, title_color or tc, align if align == 'middle' else 'start', title_bold, container=box)
        by = cy + len(tl) * tlh + gap
        for i, ln in enumerate(bl):
            base = by + i * blh + (blh + ascent(bs) - descent(bs)) / 2
            s.t(tx, base, ln, bs, TEXT['body'], align if align == 'middle' else 'start', False, container=box)

    def card_height(s, title_lines, body_lines, title_size=None, body_size=None, pad=14, emphasis=False):
        ts = title_size or (FPX['node_title_emphasis'] if emphasis else FPX['node_title'])
        bs = body_size or FPX['node_body']
        gap = 6 if title_lines and body_lines else 0
        return 2 * pad + title_lines * round(ts * 1.4) + gap + body_lines * round(bs * 1.35)

    def box(s, x, y, w, h, title, lines=(), color='blue', rx=10, dash=False, tsize=None, lsize=None, sw=1.8):
        """旧 API：标题 + 说明行卡片。"""
        s.card(x, y, w, h, title, list(lines), color, dash=dash, title_size=tsize, body_size=lsize, sw=sw)

    def pill(s, x, y, w, h, txt, color='orange', solid=True, size=None, container=True):
        st, bg, tc = C[color]
        size = size or FPX['legend']
        s.o.append(f'<rect x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" rx="{fmt(h / 2)}" fill="{st if solid else "#FFFFFF"}" stroke="{st}" stroke-width="1.5"/>')
        base = y + (h + ascent(size) - descent(size)) / 2
        s.t(x + w / 2, base, txt, size, '#FFFFFF' if solid else tc, 'middle', solid, container=(x, y, w, h) if container else None)

    def legend(s, items, y, x=None, max_w=None, style='swatch'):
        """图例：items = [{"color": 色名, "dashed": bool, "label": "…", "kind": "box|line"}]；返回占用高度。"""
        x0 = MARGIN if x is None else x
        max_w = max_w or (s.w - 2 * MARGIN)
        size = FPX['legend']
        if style == 'text':
            txt = '　'.join(it['label'] for it in items)
            lines = wrap(txt, size, max_w, balance=False)
            for i, ln in enumerate(lines):
                s.t(x0, y + ascent(size) + i * round(size * 1.5), ln, size, TEXT['legend'])
            return len(lines) * round(size * 1.5)
        cx, cy, row_h = x0, y, round(size * 1.8)
        for it in items:
            lw = 26 + 8 + text_width(it['label'], size) + 28
            if cx + lw > x0 + max_w and cx > x0:
                cx, cy = x0, cy + row_h
            st, bg, tc = C[it.get('color', 'gray')]
            if it.get('kind') == 'line':
                s.o.append(f'<line x1="{fmt(cx)}" y1="{fmt(cy + size * 0.55)}" x2="{fmt(cx + 26)}" y2="{fmt(cy + size * 0.55)}" stroke="{st}" stroke-width="2"'
                           + (f' stroke-dasharray="{FIG["dash"]["reference_edge"]}"' if it.get('dashed') else '') + '/>')
            else:
                s.o.append(f'<rect x="{fmt(cx)}" y="{fmt(cy + 1)}" width="26" height="16" rx="4" fill="{"#FFFFFF" if it.get("dashed") and it.get("color") == "white" else bg}" stroke="{st}" stroke-width="1.5"'
                           + (f' stroke-dasharray="{FIG["dash"]["placeholder"]}"' if it.get('dashed') else '') + '/>')
            s.t(cx + 34, cy + ascent(size) - 1, it['label'], size, TEXT['legend'])
            cx += lw
        return cy - y + row_h

    # --- 输出
    def svg(s):
        h = s.h
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(s.w)} {fmt(h)}" width="{fmt(s.w)}" height="{fmt(h)}" '
                f'font-family="{esc(FONT_FAMILY)}">')
        return '\n'.join([head, f'<rect x="0" y="0" width="{fmt(s.w)}" height="{fmt(h)}" fill="{FIG["background"]}"/>'] + s.o + ['</svg>']) + '\n'

    def save(s, fn):
        if s.h is None:
            raise SpecError('画布高度未定')
        with open(fn, 'w', encoding='utf-8') as f:
            f.write(s.svg())
        return fn

    # --- 自检
    def check(s):
        """输出前自检：文字越出所属框、节点重叠、文字互相重叠、越出画布、连线标签压线、字号不足。返回问题列表（均为必改）。"""
        out = list(s.issues)
        tol = 0.6
        for t in s.texts:
            if t['size'] < s.min_px:
                out.append(issue('font_too_small', f'字号 {t["size"]}px < 最小 {s.min_px}px（画布宽 {s.w}，等效 {equiv_pt(t["size"], s.w, s.content_mm, s.width_ratio):.2f}pt）', t['text']))
            if t['container']:
                x, y, w, h = t['container']
                if t['x'] < x - tol or t['x'] + t['w'] > x + w + tol or t['y'] < y - tol - 2 or t['y'] + t['h'] > y + h + tol + 2:
                    out.append(issue('text_overflow', f'文字越出所属框：文字 [{t["x"]:.0f},{t["y"]:.0f},{t["w"]:.0f}×{t["h"]:.0f}] 框 [{x:.0f},{y:.0f},{w:.0f}×{h:.0f}]', t['text']))
            if t['x'] < -tol or t['y'] < -tol or t['x'] + t['w'] > s.w + tol or t['y'] + t['h'] > s.h + tol:
                out.append(issue('out_of_canvas', '文字越出画布', t['text']))
        for i, a in enumerate(s.texts):
            for b in s.texts[i + 1:]:
                ov = _ov(a, b)
                if ov[0] > 1 and ov[1] > max(3, 0.25 * min(a['h'], b['h'])):
                    out.append(issue('text_overlap', f'文字互相重叠：「{a["text"][:20]}」与「{b["text"][:20]}」', a['text']))
        for i, a in enumerate(s.nodes):
            if a['x'] < -tol or a['y'] < -tol or a['x'] + a['w'] > s.w + tol or a['y'] + a['h'] > s.h + tol:
                out.append(issue('out_of_canvas', f'节点 {a["id"]} 越出画布', a['id']))
            for b in s.nodes[i + 1:]:
                ov = _ov(a, b)
                if ov[0] > 0.5 and ov[1] > 0.5:
                    out.append(issue('node_overlap', f'节点重叠：{a["id"]} 与 {b["id"]}', a['id']))
        for t in s.texts:
            if not t['label']:
                continue
            for (x1, y1, x2, y2, _) in s.segments:
                if _seg_hits_rect(x1, y1, x2, y2, (t['x'] - 2, t['y'] - 1, t['w'] + 4, t['h'] + 2)):
                    out.append(issue('label_collision', '连线标签压在连线上', t['text']))
                    break
            for n in s.nodes:
                ov = _ov(t, n)
                if ov[0] > 0.5 and ov[1] > 0.5:
                    out.append(issue('label_collision', f'连线标签压在节点 {n["id"]} 上', t['text']))
        # 连线：不同连线的平行段重叠
        segs = [(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2), e, x1 == x2) for (x1, y1, x2, y2, e) in s.segments if (x1 == x2) != (y1 == y2)]
        for i, a in enumerate(segs):
            for b in segs[i + 1:]:
                if a[4] == b[4] or a[4] is None or b[4] is None or a[5] != b[5]:
                    continue
                if a[5] and abs(a[0] - b[0]) < 3 and min(a[3], b[3]) - max(a[1], b[1]) > 6:
                    out.append(issue('edge_overlap', f'连线 {a[4]} 与 {b[4]} 的竖直段重叠', a[4]))
                if not a[5] and abs(a[1] - b[1]) < 3 and min(a[2], b[2]) - max(a[0], b[0]) > 6:
                    out.append(issue('edge_overlap', f'连线 {a[4]} 与 {b[4]} 的水平段重叠', a[4]))
        # 连线：水平穿过分组标题带
        for f in s.frames:
            th = f.get('title_h') or 0
            if not th:
                continue
            for (x1, y1, x2, y2, e) in s.segments:
                if y1 == y2 and f['y'] + 2 < y1 < f['y'] + th and min(max(x1, x2), f['x'] + f['w']) - max(min(x1, x2), f['x']) > 10:
                    out.append(issue('edge_through_title', f'连线 {e} 水平穿过分组 {f["id"]} 的标题带', e))
        # 箭头落在卡片角上（离角点小于 圆角 + 6px）
        cr = FIG['radius_px']['node'] + 6
        for (ax, ay, e) in s.arrows:
            for n in s.nodes:
                on_v = (abs(ax - n['x']) < 1.5 or abs(ax - n['x'] - n['w']) < 1.5) and n['y'] - 1 <= ay <= n['y'] + n['h'] + 1
                on_h = (abs(ay - n['y']) < 1.5 or abs(ay - n['y'] - n['h']) < 1.5) and n['x'] - 1 <= ax <= n['x'] + n['w'] + 1
                if on_v and min(ay - n['y'], n['y'] + n['h'] - ay) < cr or on_h and min(ax - n['x'], n['x'] + n['w'] - ax) < cr:
                    out.append(issue('arrow_on_corner', f'连线 {e} 的箭头落在节点 {n["id"]} 的角上', e))
        seen, uniq = set(), []
        for it in out:
            k = (it['rule'], it['message'])
            if k not in seen:
                seen.add(k)
                uniq.append(it)
        return uniq

    def measure_boxes(s):
        """供 Chrome 实测：[[text 序号, x, y, w, h]]（只含声明了所属框的文字）。"""
        return [[t['i']] + [round(v, 2) for v in t['container']] for t in s.texts if t['container']]


def issue(rule, message, target=''):
    return {'rule': rule, 'severity': '必改', 'message': message, 'target': str(target)[:60]}


def _ov(a, b):
    w = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
    h = min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
    return w, h


def _seg_hits_rect(x1, y1, x2, y2, r):
    rx, ry, rw, rh = r
    if x1 == x2:
        return rx < x1 < rx + rw and max(min(y1, y2), ry) < min(max(y1, y2), ry + rh)
    if y1 == y2:
        return ry < y1 < ry + rh and max(min(x1, x2), rx) < min(max(x1, x2), rx + rw)
    return False


# ---------------------------------------------------------------- 正交连线路由

class Router:
    """网格 A* 正交路由。障碍 = 节点（外扩 margin）与文字；穿越分组框边、与已有连线重叠、拐弯都有代价；
    偏好走通道中线。端口：节点四边中部、分组框四边任意位置（靠近对方投影处代价低）。"""

    def __init__(s, canvas, grid=4, margin=10):
        s.c, s.g, s.m = canvas, grid, margin
        s.nx, s.ny = int(canvas.w // grid) + 1, int(canvas.h // grid) + 1
        s.block = bytearray(s.nx * s.ny)
        s.border = bytearray(s.nx * s.ny)
        s.used_h = bytearray(s.nx * s.ny)
        s.used_v = bytearray(s.nx * s.ny)
        s.band = bytearray(s.nx * s.ny)
        s.dist = None
        s.used_ports = []

    def _cells(s, x, y, w, h):
        g = s.g
        return (max(0, int(math.ceil(x / g))), max(0, int(math.ceil(y / g))),
                min(s.nx - 1, int(math.floor((x + w) / g))), min(s.ny - 1, int(math.floor((y + h) / g))))

    def add_obstacle(s, x, y, w, h, margin=None):
        m = s.m if margin is None else margin
        x0, y0, x1, y1 = s._cells(x - m, y - m, w + 2 * m, h + 2 * m)
        for cy in range(y0, y1 + 1):
            row = cy * s.nx
            for cx in range(x0, x1 + 1):
                s.block[row + cx] = 1
        s.dist = None

    def add_band(s, x, y, w, h):
        """标题带：允许竖直穿过，水平走线代价很高。"""
        x0, y0, x1, y1 = s._cells(x, y, w, h)
        for cy in range(y0, y1 + 1):
            for cx in range(x0, x1 + 1):
                s.band[cy * s.nx + cx] = 1

    def add_frame(s, x, y, w, h):
        g = s.g
        for cx in range(int(x // g), int((x + w) // g) + 2):
            for yy in (y, y + h):
                cy = int(round(yy / g))
                for d in (-1, 0, 1):
                    if 0 <= cx < s.nx and 0 <= cy + d < s.ny:
                        s.border[(cy + d) * s.nx + cx] = 1
        for cy in range(int(y // g), int((y + h) // g) + 2):
            for xx in (x, x + w):
                cx = int(round(xx / g))
                for d in (-1, 0, 1):
                    if 0 <= cx + d < s.nx and 0 <= cy < s.ny:
                        s.border[cy * s.nx + cx + d] = 1

    def _distance(s):
        nx, ny = s.nx, s.ny
        INF = 255
        dist = bytearray([INF]) * (nx * ny)
        q = []
        for i in range(nx * ny):
            if s.block[i]:
                dist[i] = 0
                q.append(i)
        head = 0
        while head < len(q):
            i = q[head]; head += 1
            d = dist[i]
            if d >= 8:
                continue
            cx, cy = i % nx, i // nx
            for ddx, ddy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                x2, y2 = cx + ddx, cy + ddy
                if 0 <= x2 < nx and 0 <= y2 < ny:
                    j = y2 * nx + x2
                    if dist[j] > d + 1:
                        dist[j] = d + 1
                        q.append(j)
        s.dist = dist

    def ports(s, rect, kind, other_center, stub):
        """端口候选：[(边上点, 起始格, 方向, 代价)]。方向 0 右 1 下 2 左 3 上。
        node：边中点代价 0，其次中点 ±24、±48（代价 30、60）；center：只有边中点；frame：整条边（靠近对方投影处代价低）。
        已被其他连线占用的端口附近 +60，使多条线分开落点。"""
        x, y, w, h = rect
        g = s.g
        ox, oy = other_center
        out = []
        for d in (0, 1, 2, 3):
            horiz_side = d in (0, 2)
            lo_all, hi_all = (y, y + h) if horiz_side else (x, x + w)
            mid = (lo_all + hi_all) / 2
            span = hi_all - lo_all
            if kind == 'frame':
                lo, hi = lo_all + 16, hi_all - 16
                c0 = min(max(oy if horiz_side else ox, lo), hi)
                cands = [(v, abs(v - c0) * 0.02) for v in _frange(lo, hi, g)]
                cands.append((round(c0 / g) * g if lo <= round(c0 / g) * g <= hi else c0, 0))
            elif kind == 'center':
                cands = [(mid, 0)]
            else:
                cands = [(mid, 0)]
                for k_, off in ((1, 24), (2, 48)):
                    for sgn in (-1, 1):
                        v = mid + sgn * off
                        if abs(v - mid) <= span / 2 - (FIG['radius_px']['node'] + 8):
                            cands.append((v, 30 * k_))
            for v, cost in cands:
                if horiz_side:
                    px, py = (x + w if d == 0 else x), v
                    cell = (int(round((px + (stub if d == 0 else -stub)) / g)), int(round(py / g)))
                else:
                    px, py = v, (y + h if d == 1 else y)
                    cell = (int(round(px / g)), int(round((py + (stub if d == 1 else -stub)) / g)))
                if not (0 <= cell[0] < s.nx and 0 <= cell[1] < s.ny):
                    continue
                near = any(abs(px - ux) + abs(py - uy) < 20 for ux, uy in s.used_ports)
                out.append(((px, py), cell, d, cost + (60 if near else 0)))
        return out

    def route(s, src, dst, src_kind='node', dst_kind='node', bend=14, allow_sides=None):
        """src / dst 为矩形 (x, y, w, h)。返回折线点列（含首尾边上点），找不到返回 None。"""
        if s.dist is None:
            s._distance()
        g, nx, ny = s.g, s.nx, s.ny
        scx, scy = src[0] + src[2] / 2, src[1] + src[3] / 2
        dcx, dcy = dst[0] + dst[2] / 2, dst[1] + dst[3] / 2
        sp = s.ports(src, src_kind, (dcx, dcy), 12)
        tp = s.ports(dst, dst_kind, (scx, scy), 16)
        if allow_sides:
            sp = [p for p in sp if p[2] in allow_sides[0]]
            tp = [p for p in tp if p[2] in allow_sides[1]]
        targets = {}
        for (pt, cell, d, cost) in tp:
            inward = (d + 2) % 4
            key = (cell, inward)
            if key not in targets or targets[key][1] > cost:
                targets[key] = (pt, cost)
        tcells = {}
        for (cell, inward), (pt, cost) in targets.items():
            tcells.setdefault(cell, []).append((inward, pt, cost))
        tx0 = min(c[0] for c in tcells) if tcells else 0
        tx1 = max(c[0] for c in tcells) if tcells else 0
        ty0 = min(c[1] for c in tcells) if tcells else 0
        ty1 = max(c[1] for c in tcells) if tcells else 0

        def hfun(cx, cy):
            dx = 0 if tx0 <= cx <= tx1 else min(abs(cx - tx0), abs(cx - tx1))
            dy = 0 if ty0 <= cy <= ty1 else min(abs(cy - ty0), abs(cy - ty1))
            return dx + dy

        DX = ((1, 0), (0, 1), (-1, 0), (0, -1))
        best = {}
        prev = {}
        heap = []
        # 源、目标矩形内部的格子临时解除阻挡
        free = set()
        for r in (src, dst):
            x0, y0, x1, y1 = s._cells(r[0] - s.m - g, r[1] - s.m - g, r[2] + 2 * s.m + 2 * g, r[3] + 2 * s.m + 2 * g)
            for cy in range(y0, y1 + 1):
                for cx in range(x0, x1 + 1):
                    free.add((cx, cy))
        for (pt, cell, d, cost) in sp:
            st = (cell[0], cell[1], d)
            if st not in best or best[st] > cost:
                best[st] = cost
                prev[st] = ('start', pt)
                heapq.heappush(heap, (cost + hfun(*cell), cost, st))
        found = None
        dist, block, border = s.dist, s.block, s.border
        while heap:
            f, cst, st = heapq.heappop(heap)
            if best.get(st, 1e18) < cst:
                continue
            cx, cy, d = st
            if (cx, cy) in tcells:
                for inward, pt, tcost in tcells[(cx, cy)]:
                    extra = 0 if inward == d else (bend if (inward - d) % 2 else 1e9)
                    tot = cst + tcost + extra
                    if found is None or tot < found[0]:
                        found = (tot, st, pt)
                if found and found[0] <= cst:
                    break
            for nd, (ddx, ddy) in enumerate(DX):
                if nd == (d + 2) % 4:
                    continue
                x2, y2 = cx + ddx, cy + ddy
                if not (0 <= x2 < nx and 0 <= y2 < ny):
                    continue
                i = y2 * nx + x2
                if block[i] and (x2, y2) not in free:
                    continue
                c = 1.0
                if nd != d:
                    c += bend
                if border[i]:
                    c += 6
                if nd % 2 == 0 and s.band[i]:
                    c += 150
                par = s.used_h[i] if nd % 2 == 0 else s.used_v[i]
                if par >= 2:
                    c += 400
                elif par == 1:
                    c += 60
                elif s.used_h[i] >= 2 or s.used_v[i] >= 2:
                    c += 10
                dd = dist[i]
                if dd < 6 and (x2, y2) not in free:
                    c += (6 - dd) * 0.35
                ns = (x2, y2, nd)
                nc = cst + c
                if nc < best.get(ns, 1e18):
                    best[ns] = nc
                    prev[ns] = st
                    heapq.heappush(heap, (nc + hfun(x2, y2), nc, ns))
        if not found:
            return None
        _, st, end_pt = found
        cells = []
        cur = st
        while True:
            p = prev[cur]
            cells.append((cur[0] * g, cur[1] * g))
            if isinstance(p, tuple) and len(p) == 2 and p[0] == 'start':
                start_pt = p[1]
                break
            cur = p
        cells.reverse()
        pts = [start_pt] + cells + [end_pt]
        pts = _snap_ends(pts)
        pts = _orthogonal(_simplify(_remove_jogs(_simplify(pts))))
        s.used_ports += [tuple(pts[0]), tuple(pts[-1])]
        s.mark(pts)
        return pts

    def mark(s, pts):
        """登记已占用的格子：线上 = 2，垂直方向 ±2 格（8px）= 1，后续平行线据此保持间距。"""
        g = s.g
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            if abs(y1 - y2) < 1e-6:
                cy = int(round(y1 / g))
                for x in _frange(min(x1, x2), max(x1, x2), g):
                    cx = int(round(x / g))
                    for dy in (-2, -1, 0, 1, 2):
                        if 0 <= cx < s.nx and 0 <= cy + dy < s.ny:
                            i = (cy + dy) * s.nx + cx
                            s.used_h[i] = max(s.used_h[i], 2 if dy == 0 else 1)
            else:
                cx = int(round(x1 / g))
                for y in _frange(min(y1, y2), max(y1, y2), g):
                    cy = int(round(y / g))
                    for dx in (-2, -1, 0, 1, 2):
                        if 0 <= cx + dx < s.nx and 0 <= cy < s.ny:
                            i = cy * s.nx + cx + dx
                            s.used_v[i] = max(s.used_v[i], 2 if dx == 0 else 1)


def _frange(a, b, step):
    v = a
    while v <= b + 1e-6:
        yield v
        v += step


def _snap_ends(pts):
    """首段与末段对齐到端口的精确坐标，保证进出节点的线段与边垂直。"""
    pts = [list(p) for p in pts]
    n = len(pts)
    if n < 3:
        return [tuple(p) for p in pts]
    # 首段：pts[0] → pts[1] 方向由起始边决定；把与之共线的格点对齐
    sx, sy = pts[0]
    vertical = abs(pts[1][0] - sx) < abs(pts[1][1] - sy)
    ref0 = list(pts[1])
    i = 1
    if vertical:
        while i < n - 1 and abs(pts[i][0] - ref0[0]) < 1e-6:
            pts[i][0] = sx; i += 1
    else:
        while i < n - 1 and abs(pts[i][1] - ref0[1]) < 1e-6:
            pts[i][1] = sy; i += 1
    ex, ey = pts[-1]
    vertical = abs(pts[-2][0] - ex) < abs(pts[-2][1] - ey)
    j = n - 2
    ref = list(pts[-2])
    if vertical:
        while j > 0 and abs(pts[j][0] - ref[0]) < 1e-6:
            pts[j][0] = ex; j -= 1
    else:
        while j > 0 and abs(pts[j][1] - ref[1]) < 1e-6:
            pts[j][1] = ey; j -= 1
    return [tuple(p) for p in pts]


def _remove_jogs(pts, tol=8):
    """去掉端口对齐后残留的小台阶（< tol px 的短线段夹在两段同向线段之间）：挪动非端口一侧的线段。"""
    pts = [list(p) for p in pts]
    for _ in range(20):
        hit = False
        for i in range(1, len(pts) - 2):
            a, b = pts[i], pts[i + 1]
            L = abs(a[0] - b[0]) + abs(a[1] - b[1])
            if 0 < L < tol:
                axis = 0 if abs(a[1] - b[1]) < 1e-6 else 1
                # 端口点 pts[0]、pts[-1] 永远不动：两侧都连着端口时保留这个小台阶
                if i + 2 < len(pts) - 1:
                    pts[i + 1][axis] = a[axis]; pts[i + 2][axis] = a[axis]
                elif i - 1 > 0:
                    pts[i][axis] = b[axis]; pts[i - 1][axis] = b[axis]
                else:
                    continue
                hit = True
                break
        if not hit:
            break
    return [tuple(p) for p in pts]


def _orthogonal(pts):
    """兜底：任何斜线段拆成两段正交线，保证输出只有正交折线。"""
    out = [pts[0]]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        if abs(x1 - x2) > 1e-6 and abs(y1 - y2) > 1e-6:
            out.append((x2, y1))
        out.append((x2, y2))
    return _simplify(out)


def _simplify(pts):
    out = []
    for p in pts:
        if out and abs(out[-1][0] - p[0]) < 1e-6 and abs(out[-1][1] - p[1]) < 1e-6:
            continue
        out.append(p)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            (x0, y0), (x1, y1), (x2, y2) = out[i - 1], out[i], out[i + 1]
            if (abs(x0 - x1) < 1e-6 and abs(x1 - x2) < 1e-6) or (abs(y0 - y1) < 1e-6 and abs(y1 - y2) < 1e-6):
                del out[i]
                changed = True
                break
    return out  # 不做「拉直」：端口点必须保持在节点边上（Codex 复核指出拉直会让起点脱离节点）


def place_label(canvas, pts, text, size=None, color=None, avoid_rects=()):
    """把连线标签放在线旁空白处：候选 = 各线段中点两侧，按线段长度优先；检查与节点、文字、其他连线、画布边界的碰撞。
    成功返回 True；全部候选都冲突时仍放在最长线段旁并返回 False（自检会报 label_collision）。"""
    size = size or FPX['edge_label']
    color = color or TEXT['subtitle']
    w = text_width(text, size)
    h = ascent(size) + descent(size)
    segs = sorted(zip(pts, pts[1:]), key=lambda ab: -(abs(ab[0][0] - ab[1][0]) + abs(ab[0][1] - ab[1][1])))
    cands = []
    for (a, b) in segs:
        L = abs(a[0] - b[0]) + abs(a[1] - b[1])
        for frac in (0.5, 0.35, 0.65, 0.2, 0.8):
            mx, my = a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac
            if a[0] == b[0]:
                cands.append((mx + 12, my - h / 2, 'start'))
                cands.append((mx - 12 - w, my - h / 2, 'start'))
            else:
                if L < w + 16:
                    continue
                cands.append((mx - w / 2, my - 8 - h, 'start'))
                cands.append((mx - w / 2, my + 8, 'start'))
    rects = [(n['x'], n['y'], n['w'], n['h']) for n in canvas.nodes] + [(t['x'], t['y'], t['w'], t['h']) for t in canvas.texts] + list(avoid_rects)
    frames = [(f['x'], f['y'], f['w'], f['h']) for f in canvas.frames]

    def ok(x, y):
        if x < 4 or y < 4 or x + w > canvas.w - 4 or y + h > canvas.h - 4:
            return False
        r = (x - 3, y - 2, w + 6, h + 4)
        for q in rects:
            if r[0] < q[0] + q[2] and q[0] < r[0] + r[2] and r[1] < q[1] + q[3] and q[1] < r[1] + r[3]:
                return False
        for (x1, y1, x2, y2, _) in canvas.segments:
            if _seg_hits_rect(x1, y1, x2, y2, r):
                return False
        for fx, fy, fw, fh in frames:
            for seg in ((fx, fy, fx + fw, fy), (fx, fy + fh, fx + fw, fy + fh), (fx, fy, fx, fy + fh), (fx + fw, fy, fx + fw, fy + fh)):
                if _seg_hits_rect(*seg, r):
                    return False
        return True

    def put(x, y):
        # 衬底：与所在区域同色系的白底，线即使靠近也不会穿过文字（高度 ≥ 2，无滤镜）
        cx, cy = x + w / 2, y + h / 2
        inside = [f for f in canvas.frames if f['x'] < cx < f['x'] + f['w'] and f['y'] < cy < f['y'] + f['h']]
        fill = '#FFFFFF' if inside else '#FEFEFE'
        canvas.o.append(f'<rect x="{fmt(x - 4)}" y="{fmt(y - 1)}" width="{fmt(w + 8)}" height="{fmt(h + 2)}" rx="4" fill="{fill}"/>')
        canvas.t(x, y + ascent(size), text, size, color, label=True)

    for (x, y, _) in cands:
        if ok(x, y):
            put(x, y)
            return True
    if cands:
        x, y, _ = cands[0]
        put(x, y)
    return False
