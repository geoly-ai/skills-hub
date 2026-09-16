"""phases：阶段 / 环节流程卡片，支持单行与多行阶梯（行尾连行首）、行内回环。

两种排布：
- row_style "label"（默认，无 row_labels 时也用它）：左侧行标签列 + 表头色带卡片（名称、meta、要点、准出条）。
- row_style "frame"：每行一个分组容器（同 architecture.svg 的层容器：灰底、左上角粗体标题），
  卡片用 card_style "plain" 严格三段：「编号 名称」粗体 / 关键活动 / ◆「准出标签：条件」（阶段色，细分隔线隔开）；
  所有行的卡片等宽等高、分隔线对齐；行尾卡片底边 → 行间通道 → 容器左侧内边距 → 下一行首卡片左边中点。

兼容旧 spec：phases[].weeks、days 拼成 meta；items 为要点；milestones（字符串数组）在单行时画底部里程碑轴。
"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, as_lines, need, wrap_lines, draw_legend
from templates._stairs import split_rows, check_loops

SCHEMA = {
    'template': '"phases"',
    'title / subtitle / display': '同其他模板',
    'rows': '"auto"（默认：≤4 一行，5–8 两行，9–12 三行）| 1 | 2 | 3 …',
    'row_labels': '可选，每行一个标签（阶段名）',
    'row_style': '"label"（左侧标签列，默认）| "frame"（分组容器，标题左对齐加粗）',
    'card_style': '"band"（表头色带，默认）| "plain"（三段式卡片，frame 时默认）',
    'row_roles': '可选，每行颜色角色；默认按行取 purple / blue / green / orange',
    'phases[]': {'id': '可选（回环引用）', 'name': '卡片标题', 'badge': '可选，编号如「①」，拼在标题前',
                 'meta': '可选，副标题行（如「4–5 周」「Kickoff」）；兼容 weeks + days', 'items': '要点数组（plain 卡片里作为「关键活动」）',
                 'gate': '可选，准出条件', 'tag': '可选，右上角徽标（如节点比例）', 'role': '可选，覆盖颜色'},
    'gate_label': '准出标签文字，默认「准出」',
    'loops[]': '{"from": id 或下标, "to": …, "label": …}，只允许同一行内',
    'milestones': '旧格式：字符串数组，单行时画底部里程碑轴',
    'legend': '默认 false；或 [{"role", "label", "dashed"}]；legend_style 同其他模板',
}

ROW_COLORS = ['purple', 'blue', 'green', 'orange']
CARD_GAP = 40
ROW_GAP = 56
PADX = 14
FRAME_PAD_X = 32
FRAME_TITLE = 50
FRAME_GAP = 48


def render(spec):
    phases = need(spec, 'phases', list)
    n = len(phases)
    if not 1 <= n <= 24:
        raise SpecError('phases 需要 1–24 个')
    rows = split_rows(n, spec.get('rows', 'auto'))
    ids = {p.get('id'): i for i, p in enumerate(phases) if p.get('id')}

    def resolve(v):
        if isinstance(v, int) and 0 <= v < n:
            return v
        if v in ids:
            return ids[v]
        raise SpecError(f'loops 引用了不存在的环节：{v!r}')

    loops = check_loops(rows, spec.get('loops'), resolve)
    row_labels = spec.get('row_labels') or []
    if row_labels and len(row_labels) != len(rows):
        raise SpecError(f'row_labels 有 {len(row_labels)} 项，但分成了 {len(rows)} 行')
    style = spec.get('row_style', 'label')
    if style not in ('label', 'frame'):
        raise SpecError('row_style 只能是 label 或 frame')
    card_style = spec.get('card_style', 'plain' if style == 'frame' else 'band')
    if card_style not in ('band', 'plain'):
        raise SpecError('card_style 只能是 band 或 plain')
    for i, p in enumerate(phases):
        need(p, 'name', str, f'phases[{i}]')
    if style == 'frame':
        return _render_frame(spec, phases, rows, loops, row_labels, card_style)
    return _render_label(spec, phases, rows, loops, row_labels, card_style)


def _color(spec, rows, ri, i, p):
    row_roles = spec.get('row_roles') or []
    return k.role_color(p.get('role') or p.get('color') or (row_roles[ri] if ri < len(row_roles) else (ROW_COLORS[ri % 4] if len(rows) > 1 else ROW_COLORS[i % 4])))


def _title(p):
    # 编号与名称用不断行空格绑定，避免编号单独占一行
    return ((p.get('badge') + '\u00a0') if p.get('badge') else '') + p['name']


def _meta(p):
    return p.get('meta') or ' · '.join(str(v) for v in (p.get('weeks'), p.get('days')) if v)


# ------------------------------------------------------------------ frame + plain（三段式）

def _render_frame(spec, phases, rows, loops, row_labels, card_style):
    s = new_canvas(spec)
    W = s.w
    per = max(len(r) for r in rows)
    inner_x = MARGIN + FRAME_PAD_X
    inner_w = W - 2 * MARGIN - 2 * FRAME_PAD_X
    cw = (inner_w - CARD_GAP * (per - 1)) / per
    ts, bs = FPX['node_title'], FPX['node_body']
    TLH, BLH = round(ts * 1.4), round(bs * 1.4)
    gate_label = spec.get('gate_label', '准出')
    inner = cw - 2 * PADX
    cards = []
    for i, p in enumerate(phases):
        ri = next(r for r, row in enumerate(rows) if i in row)
        color = _color(spec, rows, ri, i, p)
        tag = p.get('tag')
        tagw = k.text_width(tag, FPX['legend'], True) + 20 if tag else 0
        tl = wrap_lines(s, [_title(p)], ts, inner, True, f'phases[{i}] ')
        act = [x for x in ([_meta(p)] if _meta(p) else []) + as_lines(p.get('items')) if x]
        al = wrap_lines(s, act, bs, inner, False, f'phases[{i}] ') if act else []
        gl = []
        if p.get('gate'):
            gate = str(p['gate'])
            # 「质量门：」与正文首字之间放零宽连接符，标签不会单独占一行
            gl = wrap_lines(s, [f'{gate_label}：\u2060{gate}'], bs, inner - 18, False, f'phases[{i}] ')
            gl = [ln.replace('\u2060', '') for ln in gl]
        cards.append({'ri': ri, 'color': color, 'tl': tl, 'al': al, 'gl': gl, 'tag': tag, 'tagw': tagw})
    # 所有卡片等高：三段各自取全局最大行数，分隔线对齐
    nt = max(len(c['tl']) for c in cards)
    na = max(len(c['al']) for c in cards)
    ng = max(len(c['gl']) for c in cards)
    top_pad, sec_gap = 14, 10
    h_title = nt * TLH
    h_act = na * BLH
    h_gate = ng * BLH
    card_h = top_pad + h_title + (6 + h_act if na else 0) + (sec_gap * 2 + 1 + h_gate if ng else 0) + 14
    s.h = 10 ** 5
    y = s.top + 4
    geo = []
    for ri, row in enumerate(rows):
        has_loop = any(row[0] <= a <= row[-1] for a, b, _ in loops)
        title_lines = wrap_lines(s, [row_labels[ri]], FPX['group_title'], W - 2 * MARGIN - 40, True, '行标题 ') if ri < len(row_labels) and row_labels[ri] else []
        th = (FRAME_TITLE + (len(title_lines) - 1) * 26) if title_lines else 20
        if any(cards[i]['tag'] for i in row):
            th += 8
        extra = 40 if has_loop else 0
        fh = th + extra + card_h + 20
        geo.append({'fy': y, 'fh': fh, 'cy': y + th + extra, 'title': title_lines, 'th': th})
        y += fh + FRAME_GAP
    bottom = y - FRAME_GAP
    boxes = {}
    used = []
    for ri, row in enumerate(rows):
        g = geo[ri]
        s.rect(MARGIN, g['fy'], W - 2 * MARGIN, g['fh'], FIG['group']['fill'], FIG['group']['stroke'], rx=FIG['radius_px']['group'],
               sw=FIG['stroke_px']['group'], frame_id=f'row-{ri}', title_h=g['th'] - 6)
        for j, ln in enumerate(g['title']):
            s.t(inner_x - 12, g['fy'] + 30 + j * 26, ln, FPX['group_title'], TEXT['title'], bold=True, container=(MARGIN, g['fy'], W - 2 * MARGIN, g['fh']))
        for j, i in enumerate(row):
            c = cards[i]
            st, bg, tc = C[c['color']]
            x = inner_x + j * (cw + CARD_GAP)
            cy = g['cy']
            boxes[i] = (x, cy, cw, card_h)
            used.append((c['color'], False, None))
            s.rect(x, cy, cw, card_h, bg, st, rx=FIG['radius_px']['node'], sw=FIG['stroke_px']['node'], node_id=f'phase-{i}')
            box = (x + 1, cy + 1, cw - 2, card_h - 2)
            ty = cy + top_pad
            for ln in c['tl']:
                s.t(x + PADX, ty + (TLH + k.ascent(ts) - k.descent(ts)) / 2, ln, ts, tc, bold=True, container=box)
                ty += TLH
            if c['tag']:
                # 徽标骑在卡片右上边框上，不占标题宽度
                s.pill(x + cw - 12 - c['tagw'], cy - 13, c['tagw'], 26, c['tag'], 'orange', True)
            ay = cy + top_pad + h_title + 6
            for ln in c['al']:
                s.t(x + PADX, ay + (BLH + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['body'], container=box)
                ay += BLH
            if c['gl'] or ng:
                dy = cy + top_pad + h_title + (6 + h_act if na else 0) + sec_gap
                s.hline(x + PADX, x + cw - PADX, dy, st, 1)
                gy = dy + 1 + sec_gap
                if c['gl']:
                    iy = gy + BLH / 2
                    s.polygon([(x + PADX + 5, iy - 6), (x + PADX + 11, iy), (x + PADX + 5, iy + 6), (x + PADX - 1, iy)], st)
                    for m, ln in enumerate(c['gl']):
                        s.t(x + PADX + 18, gy + (BLH + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, tc if m == 0 else tc, bold=False, container=box)
                        gy += BLH
        # 行内箭头
        for a, b in zip(row, row[1:]):
            xa, ya, wa, ha = boxes[a]
            s.line([(xa + wa + 4, ya + ha / 2), (boxes[b][0] - 2, ya + ha / 2)], 'gray', edge_id=f'{a}->{b}')
    # 行尾 → 下一行行首：底边中点 → 行间通道 → 容器左内边距 → 首卡左边中点
    for ri in range(len(rows) - 1):
        a, b = rows[ri][-1], rows[ri + 1][0]
        xa, ya, wa, ha = boxes[a]
        xb, yb, wb, hb = boxes[b]
        mid = geo[ri]['fy'] + geo[ri]['fh'] + FRAME_GAP / 2
        lx = MARGIN + FRAME_PAD_X / 2 - 2
        s.line([(xa + wa / 2, ya + ha), (xa + wa / 2, mid), (lx, mid), (lx, yb + hb / 2), (xb - 1, yb + hb / 2)], 'gray', edge_id=f'row{ri}->{ri + 1}')
    for a, b, label in loops:
        xa, ya, wa, ha = boxes[a]
        xb, yb, wb, hb = boxes[b]
        top = ya - 22
        s.line([(xa + wa / 2, ya), (xa + wa / 2, top), (xb + wb / 2, top), (xb + wb / 2, yb - 1)], 'red', dash=True, edge_id=f'loop-{a}->{b}')
        if label:
            k.place_label(s, [(xa + wa / 2, top), (xb + wb / 2, top)], label, color=C['red'][2])
    ly = bottom + 24
    lh = draw_legend(s, spec, used, ly) if spec.get('legend') else 0
    s.h = int(ly + lh + 16) if lh else int(bottom + MARGIN)
    return s


# ------------------------------------------------------------------ label + band（原排布）

def _render_label(spec, phases, rows, loops, row_labels, card_style):
    s = new_canvas(spec)
    W = s.w
    n = len(phases)
    gate_label = spec.get('gate_label', '准出')
    per = max(len(r) for r in rows)
    label_w = 0
    if row_labels:
        label_w = min(max(k.longest_word(l, FPX['group_title'], True) for l in row_labels) + 32, 160)
        label_w = max(label_w, min(max(k.text_width(l, FPX['group_title'], True) for l in row_labels) / 2 + 32, 160))
    x0 = MARGIN + (label_w + 16 if row_labels else 0)
    avail = W - MARGIN - x0
    cw = (avail - CARD_GAP * (per - 1)) / per
    ts, bs = FPX['node_title'], FPX['node_body']
    cards = []
    for i, p in enumerate(phases):
        ri = next(r for r, row in enumerate(rows) if i in row)
        color = _color(spec, rows, ri, i, p)
        tag = p.get('tag')
        tagw = k.text_width(tag, FPX['legend'], True) + 20 if tag else 0
        tl = wrap_lines(s, [_title(p)], ts, cw - 2 * PADX - (tagw + 8 if tag else 0), True, f'phases[{i}] ')
        meta = _meta(p)
        ml = wrap_lines(s, [meta], bs, cw - 2 * PADX, False, f'phases[{i}] ') if meta else []
        il = [wrap_lines(s, [it], bs, cw - 2 * PADX - 14, False, f'phases[{i}] ') for it in as_lines(p.get('items'))]
        glw = k.text_width(gate_label, bs, True) + 16
        inline = (cw - 2 * PADX - glw - 8) >= 150
        gl = wrap_lines(s, [p['gate']], bs, (cw - 2 * PADX - glw - 8) if inline else (cw - 2 * PADX), False, f'phases[{i}] ') if p.get('gate') else []
        cards.append({'color': color, 'tl': tl, 'ml': ml, 'il': il, 'gl': gl, 'tag': tag, 'tagw': tagw, 'glw': glw, 'inline': inline})
    TLH, BLH = round(ts * 1.4), round(bs * 1.4)

    def head_h(c):
        return 12 + len(c['tl']) * TLH + len(c['ml']) * BLH + 10

    def body_h(c):
        h = 0
        if c['il']:
            h += 10 + sum(len(x) for x in c['il']) * BLH + 6
        if c['gl']:
            h += 10 + (len(c['gl']) + (0 if c['inline'] else 1)) * BLH + (0 if c['inline'] else 8) + 12
        return h if h else 10

    row_geo = []
    y = s.top + 4
    for ri, row in enumerate(rows):
        hh = max(head_h(cards[i]) for i in row)
        bh = max(body_h(cards[i]) for i in row)
        has_loop = any(row[0] <= a <= row[-1] for a, b, _ in loops)
        top_extra = 44 if has_loop else 0
        row_geo.append({'y': y + top_extra, 'hh': hh, 'bh': bh, 'h': hh + bh})
        y += top_extra + hh + bh + ROW_GAP
    bottom = y - ROW_GAP
    s.h = int(bottom + 400)
    for ri, row in enumerate(rows):
        g = row_geo[ri]
        if row_labels:
            st, bg, tc = C[cards[row[0]]['color']]
            lines = wrap_lines(s, [row_labels[ri]], FPX['group_title'], label_w - 24, True, '行标签 ')
            s.rect(MARGIN, g['y'], label_w, g['h'], bg, st, rx=FIG['radius_px']['group'], sw=FIG['stroke_px']['group'])
            lh = round(FPX['group_title'] * 1.45)
            ty = g['y'] + (g['h'] - len(lines) * lh) / 2
            for j, ln in enumerate(lines):
                s.t(MARGIN + label_w / 2, ty + j * lh + (lh + k.ascent(FPX['group_title']) - k.descent(FPX['group_title'])) / 2, ln,
                    FPX['group_title'], tc, 'middle', True, container=(MARGIN, g['y'], label_w, g['h']))
    boxes = {}
    for ri, row in enumerate(rows):
        g = row_geo[ri]
        for j, i in enumerate(row):
            c = cards[i]
            st, bg, tc = C[c['color']]
            x = x0 + j * (cw + CARD_GAP)
            y = g['y']
            boxes[i] = (x, y, cw, g['h'])
            s.rect(x, y, cw, g['h'], '#FFFFFF', st, rx=FIG['radius_px']['node'], sw=FIG['stroke_px']['node'], node_id=f'phase-{i}')
            r = FIG['radius_px']['node']
            hh = g['hh']
            s.path(f'M{k.fmt(x + 0.9)},{k.fmt(y + hh)} L{k.fmt(x + 0.9)},{k.fmt(y + r)} Q{k.fmt(x + 0.9)},{k.fmt(y + 0.9)} {k.fmt(x + r)},{k.fmt(y + 0.9)} '
                   f'L{k.fmt(x + cw - r)},{k.fmt(y + 0.9)} Q{k.fmt(x + cw - 0.9)},{k.fmt(y + 0.9)} {k.fmt(x + cw - 0.9)},{k.fmt(y + r)} L{k.fmt(x + cw - 0.9)},{k.fmt(y + hh)} Z', fill=bg)
            s.hline(x + 1, x + cw - 1, y + hh, st, 1)
            box = (x + 1, y + 1, cw - 2, g['h'] - 2)
            ty = y + 12
            for ln in c['tl']:
                s.t(x + PADX, ty + (TLH + k.ascent(ts) - k.descent(ts)) / 2, ln, ts, tc, bold=True, container=box)
                ty += TLH
            for ln in c['ml']:
                s.t(x + PADX, ty + (BLH + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['subtitle'], container=box)
                ty += BLH
            if c['tag']:
                s.pill(x + cw - PADX - c['tagw'], y + 12 + (TLH - 26) / 2, c['tagw'], 26, c['tag'], 'orange', True)
            by = y + hh
            if c['il']:
                by += 10
                for lines in c['il']:
                    s.circle(x + PADX + 4, by + BLH / 2, 3, st)
                    for ln in lines:
                        s.t(x + PADX + 14, by + (BLH + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['body'], container=box)
                        by += BLH
                by += 6
            if c['gl']:
                nlines = len(c['gl']) + (0 if c['inline'] else 1)
                gy = y + g['h'] - (10 + nlines * BLH + (0 if c['inline'] else 8) + 12) + 10
                s.hline(x + PADX, x + cw - PADX, gy - 6, '#DADCE0', 1)
                s.pill(x + PADX, gy + (BLH - 24) / 2, c['glw'], 24, gate_label, c['color'], True, size=bs)
                tx = x + PADX + c['glw'] + 8
                if not c['inline']:
                    gy += BLH + 8  # 与标签留出间距，避免被画板识别成标签框里的文字
                    tx = x + PADX
                for ln in c['gl']:
                    s.t(tx, gy + (BLH + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['body'], container=box)
                    gy += BLH
    for ri, row in enumerate(rows):
        for a, b in zip(row, row[1:]):
            xa, ya, wa, ha = boxes[a]
            cy = ya + row_geo[ri]['hh'] / 2
            s.line([(xa + wa + 4, cy), (boxes[b][0] - 3, cy)], 'gray', edge_id=f'{a}->{b}')
        if ri < len(rows) - 1:
            a, b = row[-1], rows[ri + 1][0]
            xa, ya, wa, ha = boxes[a]
            xb, yb, wb, hb = boxes[b]
            mid = ya + ha + ROW_GAP / 2
            s.line([(xa + wa / 2, ya + ha), (xa + wa / 2, mid), (xb + wb / 2, mid), (xb + wb / 2, yb - 1)], 'gray', edge_id=f'{a}->{b}')
    for a, b, label in loops:
        xa, ya, wa, ha = boxes[a]
        xb, yb, wb, hb = boxes[b]
        top = ya - 26
        s.line([(xa + wa / 2, ya), (xa + wa / 2, top), (xb + wb / 2, top), (xb + wb / 2, yb - 1)], 'red', dash=True, edge_id=f'loop-{a}->{b}')
        if label:
            s.t((min(xa, xb) + max(xa, xb) + wa) / 2, top - 8, label, FPX['edge_label'], C['red'][2], 'middle', label=True)
    y = bottom
    ms = spec.get('milestones') or []
    if ms and len(rows) == 1:
        y += 36
        s.hline(MARGIN, W - MARGIN, y, '#BDC1C6', 2)
        slot = (W - 2 * MARGIN) / len(ms)
        mlines = [wrap_lines(s, [m], FPX['legend'], slot - 16, True, '里程碑 ') for m in ms]
        for i, lines in enumerate(mlines):
            x = MARGIN + slot * (i + 0.5)
            s.circle(x, y, 7, C['purple'][0])
            for j, ln in enumerate(lines):
                s.t(x, y + 32 + j * 24, ln, FPX['legend'], C['purple'][2], 'middle', True)
        y += 32 + max(len(l) for l in mlines) * 24
    lh = 0
    if spec.get('legend'):
        s.h = 10 ** 5
        lh = draw_legend(s, spec, [], y + 24)
    s.h = int(y + (24 + lh + 16 if lh else MARGIN))
    return s
