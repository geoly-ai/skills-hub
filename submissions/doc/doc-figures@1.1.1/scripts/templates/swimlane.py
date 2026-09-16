"""swimlane：泳道流程图。泳道横向分带（左侧泳道名），步骤按连线拓扑自动分列（可用 col 指定），
判断为菱形、起止为胶囊；连线正交自动避让，标签放线旁。"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, as_lines, need, wrap_lines, draw_legend

SCHEMA = {
    'template': '"swimlane"',
    'lanes[]': {'id': '必填', 'label': '泳道名（角色 / 系统）', 'role': '可选，泳道内步骤默认颜色'},
    'steps[]': {'id': '必填', 'lane': '所属泳道 id', 'label': '步骤名', 'body': '可选说明',
                'kind': 'task（默认）| decision | start | end', 'col': '可选，显式列号（从 0 起；不指定则按连线拓扑自动分列）', 'role': '可选颜色'},
    'edges[]': {'from': '步骤 id', 'to': '步骤 id', 'label': '可选（判断分支写「是 / 否」）', 'dashed': '可选'},
    'legend': '默认 false；或 [{"role", "label"}]',
}

LANE_LABEL_W = 132
LANE_PAD = 26
COL_GAP = 48


def _columns(steps, edges):
    ids = [st['id'] for st in steps]
    out = {i: [] for i in ids}
    for e in edges:
        out[e['from']].append(e['to'])
    # 深度优先找回边（回边不参与分列）
    state, back = {}, set()

    def dfs(u):
        state[u] = 1
        for v in out[u]:
            if state.get(v) == 1:
                back.add((u, v))
            elif v not in state:
                dfs(v)
        state[u] = 2

    for i in ids:
        if i not in state:
            dfs(i)
    col = {i: 0 for i in ids}
    order = []
    indeg = {i: 0 for i in ids}
    for u in ids:
        for v in out[u]:
            if (u, v) not in back:
                indeg[v] += 1
    q = [i for i in ids if indeg[i] == 0]
    while q:
        u = q.pop(0)
        order.append(u)
        for v in out[u]:
            if (u, v) in back:
                continue
            col[v] = max(col[v], col[u] + 1)
            indeg[v] -= 1
            if indeg[v] == 0:
                q.append(v)
    return col


def render(spec):
    lanes = need(spec, 'lanes', list)
    steps = need(spec, 'steps', list)
    edges = spec.get('edges', [])
    lane_ids = [need(l, 'id', str, 'lanes[]') for l in lanes]
    if len(set(lane_ids)) != len(lane_ids):
        raise SpecError('lanes id 重复')
    sid = {}
    for st in steps:
        i = need(st, 'id', str, 'steps[]')
        if i in sid:
            raise SpecError(f'steps id 重复：{i}')
        if st.get('lane') not in lane_ids:
            raise SpecError(f'steps[{i}].lane={st.get("lane")!r} 不是泳道 id')
        if st.get('kind', 'task') not in ('task', 'decision', 'start', 'end'):
            raise SpecError(f'steps[{i}].kind 只能是 task / decision / start / end')
        sid[i] = st
    for e in edges:
        if e.get('from') not in sid or e.get('to') not in sid:
            raise SpecError(f'edges 引用了不存在的步骤：{e.get("from")!r} → {e.get("to")!r}')
    auto = _columns(steps, edges)
    col = {i: (int(st['col']) if 'col' in st else auto[i]) for i, st in sid.items()}
    ncols = max(col.values()) + 1
    s = new_canvas(spec)
    W = s.w
    x0 = MARGIN + LANE_LABEL_W
    cw = (W - MARGIN - x0) / ncols
    nw = cw - COL_GAP
    if nw < 96:
        s.issues.append(k.issue('out_of_canvas', f'列数 {ncols} 太多：每列步骤宽只剩 {nw:.0f}px，请拆图或用横向页（display.landscape）'))
    ts, bs = FPX['node_title'], FPX['node_body']
    wrapped = {}
    for i, st in sid.items():
        kind = st.get('kind', 'task')
        inner = nw * 0.7 - 12 if kind == 'decision' else nw - 24
        tl = wrap_lines(s, [st['label']], ts if kind != 'decision' else FPX['node_body'], inner, kind != 'decision', f'步骤 {i} ')
        bl = wrap_lines(s, as_lines(st.get('body')), bs, inner, False, f'步骤 {i} ')
        h = s.card_height(len(tl), len(bl), ts if kind != 'decision' else FPX['node_body'], bs, pad=12)
        if kind == 'decision':
            h = max(h * 1.9, 92)
        wrapped[i] = (tl, bl, max(h, 52))
    lane_h = {}
    for lid in lane_ids:
        hs = [wrapped[i][2] for i, st in sid.items() if st['lane'] == lid]
        lane_h[lid] = max(hs + [52]) + 2 * LANE_PAD
    y = s.top + 6
    lane_y = {}
    for lid in lane_ids:
        lane_y[lid] = y
        y += lane_h[lid]
    bottom = y
    s.h = int(bottom + 300)
    # 泳道底与分隔
    s.rect(MARGIN, s.top + 6, W - 2 * MARGIN, bottom - s.top - 6, 'none', FIG['group']['stroke'], rx=FIG['radius_px']['group'], sw=FIG['stroke_px']['group'])
    for n, l in enumerate(lanes):
        ly, lh = lane_y[l['id']], lane_h[l['id']]
        color = k.role_color(l.get('role') or 'neutral')
        st_, bg, tc = C[color]
        if n % 2 == 1:
            s.rect(x0, ly + 0.75, W - MARGIN - x0 - 0.75, lh - 1.5, FIG['group']['fill'], 'none', sw=0)
        if n > 0:
            s.hline(MARGIN, W - MARGIN, ly, FIG['group']['stroke'], 1.5)
        lines = wrap_lines(s, [l['label']], FPX['group_title'], LANE_LABEL_W - 24, True, '泳道名 ')
        lhh = round(FPX['group_title'] * 1.4)
        ty = ly + (lh - len(lines) * lhh) / 2
        for j, ln in enumerate(lines):
            s.t(MARGIN + LANE_LABEL_W / 2, ty + j * lhh + (lhh + k.ascent(FPX['group_title']) - k.descent(FPX['group_title'])) / 2, ln,
                FPX['group_title'], tc if color != 'gray' else TEXT['title'], 'middle', True, container=(MARGIN, ly, LANE_LABEL_W, lh))
    s.vline(x0, s.top + 6, bottom, FIG['group']['stroke'], 1.5)
    rects = {}
    used = []
    for i, st in sid.items():
        l = next(l for l in lanes if l['id'] == st['lane'])
        color = k.role_color(st.get('role') or l.get('role') or 'generic_layer')
        used.append((color, False, st.get('role') or l.get('role')))
        tl, bl, h = wrapped[i]
        x = x0 + col[i] * cw + COL_GAP / 2
        yy = lane_y[st['lane']] + (lane_h[st['lane']] - h) / 2
        kind = st.get('kind', 'task')
        stc, bg, tc = C[color]
        rects[i] = (x, yy, nw, h)
        if kind == 'decision':
            cx, cy = x + nw / 2, yy + h / 2
            s.polygon([(cx, yy), (x + nw, cy), (cx, yy + h), (x, cy)], bg, stc, FIG['stroke_px']['node'])
            s.nodes.append({'id': i, 'x': x, 'y': yy, 'w': nw, 'h': h, 'group': st['lane']})
            inner = (x + nw * 0.15, yy + h * 0.25, nw * 0.7, h * 0.5)
            lh_ = round(FPX['node_body'] * 1.35)
            ty = cy - len(tl) * lh_ / 2
            for j, ln in enumerate(tl):
                s.t(cx, ty + j * lh_ + (lh_ + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, tc, 'middle', True, container=inner)
        elif kind in ('start', 'end'):
            s.rect(x, yy, nw, h, bg if kind == 'start' else '#FFFFFF', stc, rx=h / 2, sw=FIG['stroke_px']['node'], node_id=i, group=st['lane'])
            s.card(x, yy, nw, h, tl, bl, color, fill='none', sw=0.01)
            s.o.pop(-1 - len(tl) - len(bl))  # 去掉 card 自带的矩形，保留文字（起止节点仍登记在 s.nodes，参与避障与重叠自检）
        else:
            s.card(x, yy, nw, h, tl, bl, color, node_id=i, group=st['lane'])
    router = k.Router(s, grid=4, margin=10)
    for n in s.nodes:
        router.add_obstacle(n['x'], n['y'], n['w'], n['h'])
    for t in s.texts:
        router.add_obstacle(t['x'], t['y'], t['w'], t['h'], margin=3)
    labels = []
    for e in sorted(edges, key=lambda e: abs(col[e['from']] - col[e['to']]) + abs(lane_ids.index(sid[e['from']]['lane']) - lane_ids.index(sid[e['to']]['lane']))):
        kf = 'center' if sid[e['from']].get('kind') == 'decision' else 'node'
        kt = 'center' if sid[e['to']].get('kind') == 'decision' else 'node'
        pts = router.route(rects[e['from']], rects[e['to']], kf, kt)
        if not pts:
            s.issues.append(k.issue('edge_unroutable', f'连线 {e["from"]} → {e["to"]} 找不到路径', f'{e["from"]}->{e["to"]}'))
            continue
        s.line(pts, 'gray', dash=bool(e.get('dashed')), edge_id=f'{e["from"]}->{e["to"]}')
        if e.get('label'):
            labels.append((pts, e['label']))
    s.h = int(bottom + 4)
    for pts, label in labels:
        k.place_label(s, pts, label)
    lg = spec.get('legend', False)
    lh = 0
    if lg:
        s.h = 10 ** 5
        lh = draw_legend(s, spec, used, bottom + 24)
    s.h = int(bottom + (24 + lh + 16 if lh else MARGIN))
    return s
