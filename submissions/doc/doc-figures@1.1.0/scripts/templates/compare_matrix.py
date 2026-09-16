"""compare-matrix：对比矩阵（● 完全 / ◐ 部分 / ○ 不具备，或文字）。首列为比较项，可分组；高亮列（如「我方」）淡紫底。
列太多放不下时自动分成多块（每块重复首列），split=false 时不分块并由自检报越界。"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, as_lines, need, wrap_lines

SCHEMA = {
    'template': '"compare-matrix"',
    'columns[]': {'label': '列名（被比较对象）', 'highlight': '可选，高亮列'},
    'rows[]': {'label': '比较项', 'group': '可选，分组名（相同 group 连续的行归到一个分组标题下）',
               'cells': '与 columns 等长；值 full / half / none（或 ● ◐ ○ / true / false）、"-" 或 null 表示不适用、其他字符串原样显示'},
    'first_col_width': '可选，首列宽（px）',
    'legend_labels': '可选 {"full": "完全支持", "half": "部分支持", "none": "不支持"}',
    'split': '默认 true：列放不下时自动分块',
}

SYM = {'full': 'full', '●': 'full', True: 'full', 'half': 'half', '◐': 'half', 'none': 'none', '○': 'none', False: 'none'}
CELL_PAD = 12
MIN_COL = 84


def _cell_kind(v):
    if v is None or v == '-' or v == '—':
        return 'na'
    if isinstance(v, bool) or v in SYM:
        return SYM[v]
    return 'text'


def render(spec):
    cols = need(spec, 'columns', list)
    rows = need(spec, 'rows', list)
    if not cols or not rows:
        raise SpecError('columns 与 rows 都不能为空')
    for i, r in enumerate(rows):
        if len(r.get('cells', [])) != len(cols):
            raise SpecError(f'rows[{i}]（{r.get("label")}）cells 有 {len(r.get("cells", []))} 项，应为 {len(cols)}')
    s = new_canvas(spec)
    W = s.w
    bs, hs = FPX['node_body'], FPX['legend']
    avail = W - 2 * MARGIN
    fc = spec.get('first_col_width') or min(max(max(k.text_width(r['label'], bs, True) for r in rows) + 2 * CELL_PAD, 160), avail * 0.34)
    col_min = []
    for j, c in enumerate(cols):
        words = [k.longest_word(c['label'], hs, True)] + [k.longest_word(r['cells'][j], bs) for r in rows if _cell_kind(r['cells'][j]) == 'text']
        col_min.append(max(max(words) + 2 * CELL_PAD, MIN_COL))
    # 分块
    panels, cur, curw = [], [], fc
    for j, mn in enumerate(col_min):
        pref = max(mn, min(180, max(k.text_width(cols[j]['label'], hs, True) + 2 * CELL_PAD, mn)))
        if cur and curw + pref > avail and spec.get('split', True):
            panels.append(cur)
            cur, curw = [], fc
        cur.append(j)
        curw += pref
    panels.append(cur)
    y = s.top + 6
    s.h = 10 ** 5
    for pi, pcols in enumerate(panels):
        rest = avail - fc
        widths = [col_min[j] for j in pcols]
        if sum(widths) < rest:
            extra = (rest - sum(widths)) / len(widths)
            widths = [w + extra for w in widths]
        tw = fc + sum(widths)
        if tw > avail + 0.5:
            s.issues.append(k.issue('out_of_canvas', f'对比矩阵第 {pi + 1} 块宽 {tw:.0f}px 超出可用宽 {avail}px（split=false 或首列过宽）'))
        xs = [MARGIN + fc]
        for w in widths:
            xs.append(xs[-1] + w)
        head = [wrap_lines(s, [cols[j]['label']], hs, w - 2 * CELL_PAD, True, '列名 ') for j, w in zip(pcols, widths)]
        hh = max(len(h) for h in head) * round(hs * 1.35) + 24
        # 行高
        body = []
        last_group = None
        for r in rows:
            if r.get('group') and r['group'] != last_group:
                body.append(('group', r['group'], 40))
                last_group = r['group']
            ll = wrap_lines(s, [r['label']], bs, fc - 2 * CELL_PAD, False, '比较项 ')
            cells = []
            ch = len(ll)
            for j, w in zip(pcols, widths):
                v = r['cells'][j]
                if _cell_kind(v) == 'text':
                    cl = wrap_lines(s, [str(v)], bs, w - 2 * CELL_PAD, False, '单元格 ')
                    ch = max(ch, len(cl))
                    cells.append(cl)
                else:
                    cells.append(_cell_kind(v))
            body.append(('row', (ll, cells), max(ch * round(bs * 1.35) + 20, 44)))
        th = hh + sum(b[2] for b in body)
        # 外框不填白：与白色画布底同色的包含关系会被 whiteboard-cli 报 node-overlap
        s.rect(MARGIN, y, tw, th, 'none', FIG['group']['stroke'], rx=FIG['radius_px']['node'], sw=FIG['stroke_px']['group'])
        # 高亮列底色
        for n, j in enumerate(pcols):
            if cols[j].get('highlight'):
                s.rect(xs[n] + 0.75, y + 0.75, widths[n] - 1.5, th - 1.5, C['purple'][1], 'none', sw=0)
        # 表头
        s.hline(MARGIN, MARGIN + tw, y + hh, FIG['group']['stroke'], 1.5)
        lh = round(hs * 1.35)
        for n, j in enumerate(pcols):
            lines = head[n]
            ty = y + (hh - len(lines) * lh) / 2
            color = C['purple'][2] if cols[j].get('highlight') else TEXT['title']
            for m, ln in enumerate(lines):
                s.t(xs[n] + widths[n] / 2, ty + m * lh + (lh + k.ascent(hs) - k.descent(hs)) / 2, ln, hs, color, 'middle', True,
                    container=(xs[n], y, widths[n], hh))
        s.t(MARGIN + CELL_PAD, y + hh / 2 + (k.ascent(hs) - k.descent(hs)) / 2, spec.get('corner_label', ''), hs, TEXT['subtitle'], bold=True) if spec.get('corner_label') else None
        yy = y + hh
        blh = round(bs * 1.35)
        for kind, data, h in body:
            if kind == 'group':
                s.rect(MARGIN + 0.75, yy, tw - 1.5, h, FIG['group']['fill'], 'none', sw=0)
                s.t(MARGIN + CELL_PAD, yy + h / 2 + (k.ascent(hs) - k.descent(hs)) / 2, data, hs, TEXT['title'], bold=True,
                    container=(MARGIN, yy, tw, h))
            else:
                ll, cells = data
                ty = yy + (h - len(ll) * blh) / 2
                for m, ln in enumerate(ll):
                    s.t(MARGIN + CELL_PAD, ty + m * blh + (blh + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['body'], container=(MARGIN, yy, fc, h))
                for n, cell in enumerate(cells):
                    cx, cy = xs[n] + widths[n] / 2, yy + h / 2
                    if isinstance(cell, list):
                        ty = yy + (h - len(cell) * blh) / 2
                        for m, ln in enumerate(cell):
                            s.t(cx, ty + m * blh + (blh + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['body'], 'middle',
                                container=(xs[n], yy, widths[n], h))
                    else:
                        _symbol(s, cx, cy, cell)
            s.hline(MARGIN + 1, MARGIN + tw - 1, yy + h, '#E8EAED', 1) if yy + h < y + th - 1 else None
            yy += h
        s.vline(MARGIN + fc, y, y + th, FIG['group']['stroke'], 1)
        y += th + 28
    # 图例
    ll = {'full': '完全支持', 'half': '部分支持', 'none': '不支持'}
    ll.update(spec.get('legend_labels') or {})
    x = MARGIN
    ly = y + 2
    for key in ('full', 'half', 'none'):
        _symbol(s, x + 9, ly + 10, key)
        s.t(x + 26, ly + 10 + (k.ascent(FPX['legend']) - k.descent(FPX['legend'])) / 2, ll[key], FPX['legend'], TEXT['legend'])
        x += 26 + k.text_width(ll[key], FPX['legend']) + 32
    s.h = int(ly + 20 + 24)
    return s


def _symbol(s, cx, cy, kind, r=9):
    st = C['purple'][0]
    if kind == 'full':
        s.circle(cx, cy, r, st, st, 1.8)
    elif kind == 'half':
        s.circle(cx, cy, r, '#FFFFFF', st, 1.8)
        s.path(f'M{k.fmt(cx)},{k.fmt(cy - r)} A{r},{r} 0 0 0 {k.fmt(cx)},{k.fmt(cy + r)} Z', fill=st)
    elif kind == 'none':
        s.circle(cx, cy, r, '#FFFFFF', '#9AA0A6', 1.8)
    else:
        s.hline(cx - 8, cx + 8, cy, '#9AA0A6', 2)
