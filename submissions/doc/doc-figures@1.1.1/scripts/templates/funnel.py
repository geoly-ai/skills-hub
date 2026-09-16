"""funnel：转化漏斗。左侧逐级收窄的梯形（步骤名），右侧对应说明卡片（动作 + 参考来源 + 解决的问题），文字自动换行不截断。
兼容旧 spec：steps[].name / action / source / problem。"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, need, wrap_lines

SCHEMA = {
    'template': '"funnel"',
    'steps[]': {'name': '步骤名', 'action': '动作说明（右侧卡片主文）', 'source': '可选，参考来源（显示为 source_prefix + 值）',
                'problem': '可选，解决的问题（显示为 problem_prefix + 值）', 'role': '可选颜色'},
    'source_prefix': '默认「参考：」', 'problem_prefix': '默认「解决：」',
}

COLORS = ['purple', 'blue', 'teal', 'green', 'orange', 'red', 'pink', 'gray']
BADGES = '①②③④⑤⑥⑦⑧'


def render(spec):
    steps = need(spec, 'steps', list)
    n = len(steps)
    if not 2 <= n <= 8:
        raise SpecError('funnel 的 steps 需要 2–8 个')
    s = new_canvas(spec)
    W = s.w
    bs, ts = FPX['node_body'], FPX['node_title']
    fw = min(520, (W - 2 * MARGIN) * 0.44)
    cx = MARGIN + fw / 2
    card_x = MARGIN + fw + 48
    card_w = W - MARGIN - card_x
    sp, pp = spec.get('source_prefix', '参考：'), spec.get('problem_prefix', '解决：')
    rows = []
    for i, st in enumerate(steps):
        name = need(st, 'name', str, f'steps[{i}]')
        al = wrap_lines(s, [st.get('action', '')], bs, card_w - 32, False, f'steps[{i}] ') if st.get('action') else []
        pl = wrap_lines(s, [pp + st['problem']], bs, card_w - 32, False, f'steps[{i}] ') if st.get('problem') else []
        # 漏斗里的文字宽度取该级梯形下底的 80%
        wbot = fw - (fw * 0.5) * ((i + 1) / n)
        nl = wrap_lines(s, [f'{BADGES[i]} {name}'], ts, wbot * 0.8, True, f'steps[{i}] ')
        sl = wrap_lines(s, [sp + st['source']], bs, wbot * 0.8, False, f'steps[{i}] ') if st.get('source') else []
        blh = round(bs * 1.4)
        h = max(len(al) * blh + len(pl) * blh + (6 if al and pl else 0) + 28, len(nl) * round(ts * 1.4) + len(sl) * blh + 28, 76)
        rows.append((st, nl, sl, al, pl, h))
    y = s.top + 6
    s.h = 10 ** 5
    blh = round(bs * 1.4)
    tlh = round(ts * 1.4)
    for i, (st, nl, sl, al, pl, h) in enumerate(rows):
        color = k.role_color(st.get('role') or COLORS[i % len(COLORS)])
        stc, bg, tc = C[color]
        wt = fw - (fw * 0.5) * (i / n)
        wb = fw - (fw * 0.5) * ((i + 1) / n)
        s.polygon([(cx - wt / 2, y), (cx + wt / 2, y), (cx + wb / 2, y + h), (cx - wb / 2, y + h)], bg, stc, FIG['stroke_px']['node'])
        s.nodes.append({'id': f'step-{i}', 'x': cx - wt / 2, 'y': y, 'w': wt, 'h': h, 'group': 'funnel'})
        inner = (cx - wb / 2 + 4, y + 2, wb - 8, h - 4)
        block = len(nl) * tlh + len(sl) * blh
        ty = y + (h - block) / 2
        for ln in nl:
            s.t(cx, ty + (tlh + k.ascent(ts) - k.descent(ts)) / 2, ln, ts, tc, 'middle', True, container=inner)
            ty += tlh
        for ln in sl:
            s.t(cx, ty + (blh + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['subtitle'], 'middle', container=inner)
            ty += blh
        cy = y + h / 2
        s.line([(cx + (wt + wb) / 4 + 10, cy), (card_x - 2, cy)], color, head=False, sw=1.5)
        s.circle(card_x - 2, cy, 4, stc)
        s.rect(card_x, y + 4, card_w, h - 8, '#FFFFFF', stc, rx=FIG['radius_px']['node'], sw=FIG['stroke_px']['node'], node_id=f'card-{i}')
        box = (card_x, y + 4, card_w, h - 8)
        block = len(al) * blh + len(pl) * blh + (6 if al and pl else 0)
        ty = y + (h - block) / 2
        for ln in al:
            s.t(card_x + 16, ty + (blh + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['title'], container=box)
            ty += blh
        if al and pl:
            ty += 6
        for ln in pl:
            s.t(card_x + 16, ty + (blh + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, tc, container=box)
            ty += blh
        y += h + 10
    s.h = int(y - 10 + MARGIN)
    return s
