"""coverage-heatmap：覆盖矩阵热图。行 × 列，格内显示覆盖率与数量；颜色分档（tokens 调色板浅底），缺格为灰「—」；底部色阶图例。"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, need, wrap_lines

SCHEMA = {
    'template': '"coverage-heatmap"（兼容草案 "kind"）',
    'rows': '行名数组（如模块）',
    'cols': '列名数组（如优先级）',
    'cells[]': {'row': '行名', 'col': '列名', 'value': '覆盖率 0–1', 'count': '可选，数量（显示为 count_format）'},
    'row_title / col_title': '可选，左上角表头文字',
    'count_format': '数量显示格式，默认「n={count}」',
    'scale': '可选分档 [{"min": 1.0, "role": "deliverable", "label": "100%"}, …]（按 min 从大到小匹配）',
    'note': '忽略（草案说明字段）',
}

DEFAULT_SCALE = [
    {'min': 1.0, 'color': 'green', 'label': '100%'},
    {'min': 0.8, 'color': 'teal', 'label': '80–99%'},
    {'min': 0.5, 'color': 'orange', 'label': '50–79%'},
    {'min': 0.0, 'color': 'red', 'label': '< 50%'},
]


def _bucket(scale, v):
    for b in scale:
        if v >= b['min'] - 1e-9:
            return b
    return scale[-1]


def render(spec):
    rows = need(spec, 'rows', list)
    cols = need(spec, 'cols', list)
    if not rows or not cols:
        raise SpecError('rows 与 cols 都不能为空')
    cells = {}
    for i, c in enumerate(spec.get('cells', [])):
        if c.get('row') not in rows or c.get('col') not in cols:
            raise SpecError(f'cells[{i}] 的 row / col 不在 rows / cols 中：{c.get("row")!r} / {c.get("col")!r}')
        v = c.get('value')
        if not isinstance(v, (int, float)) or not 0 <= v <= 1:
            raise SpecError(f'cells[{i}].value 必须是 0–1 的数字')
        if (c['row'], c['col']) in cells:
            raise SpecError(f'cells[{i}] 重复：{c["row"]} × {c["col"]}')
        cells[(c['row'], c['col'])] = c
    scale = []
    for b in spec.get('scale') or DEFAULT_SCALE:
        scale.append({'min': float(b['min']), 'color': k.role_color(b.get('role') or b.get('color')), 'label': b.get('label', '')})
    scale.sort(key=lambda b: -b['min'])
    fmt_count = spec.get('count_format', 'n={count}')
    s = new_canvas(spec)
    W = s.w
    bs, hs = FPX['node_body'], FPX['legend']
    avail = W - 2 * MARGIN
    rl = min(max(max(k.text_width(r, bs, True) for r in rows) + 28, 150), avail * 0.3)
    cw = (avail - rl) / len(cols)
    if cw < 88:
        s.issues.append(k.issue('out_of_canvas', f'列数 {len(cols)} 太多：每格只剩 {cw:.0f}px（最少 88px），请拆图或用数据表'))
    y = s.top + 6
    s.h = 10 ** 5
    head = [wrap_lines(s, [c], hs, cw - 16, True, '列名 ') for c in cols]
    hh = max(len(h) for h in head) * round(hs * 1.35) + 22
    lh = round(hs * 1.35)
    corner = ' \\ '.join(v for v in (spec.get('row_title'), spec.get('col_title')) if v)
    if corner:
        s.t(MARGIN + 12, y + hh / 2 + (k.ascent(hs) - k.descent(hs)) / 2, corner, hs, TEXT['subtitle'], bold=True, container=(MARGIN, y, rl, hh))
    for j, c in enumerate(cols):
        x = MARGIN + rl + j * cw
        ty = y + (hh - len(head[j]) * lh) / 2
        for m, ln in enumerate(head[j]):
            s.t(x + cw / 2, ty + m * lh + (lh + k.ascent(hs) - k.descent(hs)) / 2, ln, hs, TEXT['title'], 'middle', True, container=(x, y, cw, hh))
    yy = y + hh
    ch = 64
    for r in rows:
        rlines = wrap_lines(s, [r], bs, rl - 24, True, '行名 ')
        h = max(ch, len(rlines) * round(bs * 1.35) + 20)
        ty = yy + (h - len(rlines) * round(bs * 1.35)) / 2
        for m, ln in enumerate(rlines):
            s.t(MARGIN + 12, ty + m * round(bs * 1.35) + (round(bs * 1.35) + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['title'], bold=True,
                container=(MARGIN, yy, rl, h))
        for j, c in enumerate(cols):
            x = MARGIN + rl + j * cw
            cell = cells.get((r, c))
            bx, by, bw, bh = x + 3, yy + 3, cw - 6, h - 6
            if not cell:
                s.rect(bx, by, bw, bh, '#FFFFFF', '#DADCE0', rx=6, sw=1, dasharray='4 3', node_id=f'{r}|{c}')
                s.t(x + cw / 2, yy + h / 2 + (k.ascent(bs) - k.descent(bs)) / 2, '—', bs, '#9AA0A6', 'middle', container=(bx, by, bw, bh))
                continue
            b = _bucket(scale, cell['value'])
            st, bg, tc = C[b['color']]
            s.rect(bx, by, bw, bh, bg, st, rx=6, sw=1.2, node_id=f'{r}|{c}')
            pct = f'{round(cell["value"] * 100)}%'
            if 'count' in cell and cell['count'] is not None:
                l1, l2 = pct, fmt_count.format(count=cell['count'])
                blh = round(bs * 1.3)
                top = yy + (h - 2 * blh) / 2
                s.t(x + cw / 2, top + (blh + k.ascent(bs) - k.descent(bs)) / 2, l1, bs, tc, 'middle', True, container=(bx, by, bw, bh))
                s.t(x + cw / 2, top + blh + (blh + k.ascent(bs) - k.descent(bs)) / 2, l2, bs, TEXT['body'], 'middle', container=(bx, by, bw, bh))
            else:
                s.t(x + cw / 2, yy + h / 2 + (k.ascent(bs) - k.descent(bs)) / 2, pct, bs, tc, 'middle', True, container=(bx, by, bw, bh))
        yy += h
    # 图例
    ly = yy + 26
    x = MARGIN
    s.t(x, ly + 12 + (k.ascent(hs) - k.descent(hs)) / 2 - 1, spec.get('legend_title', '覆盖率'), hs, TEXT['legend'])
    x += k.text_width(spec.get('legend_title', '覆盖率'), hs) + 16
    for b in scale:
        st, bg, tc = C[b['color']]
        s.rect(x, ly + 2, 30, 20, bg, st, rx=4, sw=1.2)
        s.t(x + 38, ly + 12 + (k.ascent(hs) - k.descent(hs)) / 2 - 1, b['label'], hs, TEXT['legend'])
        x += 38 + k.text_width(b['label'], hs) + 28
    s.rect(x, ly + 2, 30, 20, '#FFFFFF', '#DADCE0', rx=4, sw=1, dasharray='4 3')
    s.t(x + 38, ly + 12 + (k.ascent(hs) - k.descent(hs)) / 2 - 1, spec.get('missing_label', '无数据'), hs, TEXT['legend'])
    s.h = int(ly + 24 + 24)
    return s
