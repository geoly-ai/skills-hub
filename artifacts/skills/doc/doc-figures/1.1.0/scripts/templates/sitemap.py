"""sitemap：站点 / 信息结构。顶部根节点，下方若干泳道（每道一个主题色胶囊名），道内分组卡片 + 子页列表；
分组太多时道内自动折行，文字自动换行不截断。兼容旧 spec：root、lanes[].name / color / groups[].name / children。"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, need, wrap_lines

SCHEMA = {
    'template': '"sitemap"',
    'root': '根节点名，默认「首页」',
    'lanes[]': {'name': '泳道名（如转化主线）', 'color': '调色板色名或角色', 'groups[]': {'name': '分组名', 'children': '子页数组'}},
}

GGAP = 14
MIN_G = 170


def render(spec):
    lanes = need(spec, 'lanes', list)
    if not lanes:
        raise SpecError('lanes 不能为空')
    s = new_canvas(spec)
    W = s.w
    bs, ts, hs = FPX['node_body'], FPX['node_title'], FPX['legend']
    avail = W - 2 * MARGIN - 32
    root = spec.get('root', '首页')
    rw = max(220, k.text_width(root, FPX['node_title_emphasis'], True) + 48)
    y = s.top + 6
    s.h = 10 ** 5
    s.card(W / 2 - rw / 2, y, rw, 56, root, [], 'purple', emphasis=True, node_id='root')
    root_bottom = y + 56
    y += 56 + 36
    blh = round(bs * 1.35)
    for li, ln in enumerate(lanes):
        color = k.role_color(ln.get('color') or ln.get('role') or 'blue')
        stc, bg, tc = C[color]
        groups = need(ln, 'groups', list, f'lanes[{li}]')
        per = max(1, min(len(groups), int((avail + GGAP) // (MIN_G + GGAP))))
        grows = [groups[i:i + per] for i in range(0, len(groups), per)]
        gw = (avail - GGAP * (per - 1)) / per
        prepared = []
        for gr in grows:
            items = []
            for g in gr:
                nl = wrap_lines(s, [g['name']], ts, gw - 24, True, '分组名 ')
                ch = [wrap_lines(s, [c], bs, gw - 46, False, '子页 ') for c in g.get('children', [])]
                items.append((g, nl, ch))
            hh = max(len(nl) * round(ts * 1.4) + 20 for _, nl, _ in items)
            ch_h = max(sum(len(c) * blh + 12 for c in ch) for _, _, ch in items)
            prepared.append((items, hh, ch_h))
        pill_h = 30
        lane_h = 16 + pill_h + 14 + sum(hh + 10 + ch_h + 16 for _, hh, ch_h in prepared) + 6
        if li == 0:
            s.vline(W / 2, root_bottom, y - 2, '#BDC1C6', 1.5)
        s.rect(MARGIN, y, W - 2 * MARGIN, lane_h, FIG['group']['fill'], FIG['group']['stroke'], rx=FIG['radius_px']['group'], sw=FIG['stroke_px']['group'], frame_id=f'lane-{li}')
        pw = k.text_width(ln['name'], hs, True) + 28
        s.pill(MARGIN + 16, y + 16, pw, pill_h, ln['name'], color, True)
        gy = y + 16 + pill_h + 14
        for items, hh, ch_h in prepared:
            for gi, (g, nl, ch) in enumerate(items):
                x = MARGIN + 16 + gi * (gw + GGAP)
                s.card(x, gy, gw, hh, nl, [], color, node_id=f'{li}-{g["name"]}')
                cy = gy + hh + 10
                for c in ch:
                    h = len(c) * blh + 8
                    s.o.append(f'<polyline points="{k.fmt(x + 14)},{k.fmt(cy - 10 if c is ch[0] else cy - 4 - 8)} {k.fmt(x + 14)},{k.fmt(cy + h / 2)} {k.fmt(x + 24)},{k.fmt(cy + h / 2)}" fill="none" stroke="{stc}" stroke-width="1.2"/>')
                    s.rect(x + 24, cy, gw - 24, h, '#FFFFFF', stc, rx=6, sw=1, node_id=f'{li}-{g["name"]}-{c[0]}')
                    for m, t in enumerate(c):
                        s.t(x + 34, cy + 4 + m * blh + (blh + k.ascent(bs) - k.descent(bs)) / 2, t, bs, TEXT['body'], container=(x + 24, cy, gw - 24, h))
                    cy += h + 4
            gy += hh + 10 + ch_h + 16
        y += lane_h + 20
    s.h = int(y - 20 + MARGIN)
    return s
