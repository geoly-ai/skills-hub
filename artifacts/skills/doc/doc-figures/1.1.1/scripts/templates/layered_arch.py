"""layered-arch：分层架构图（以 architecture.svg 为视觉基准）。

层 = 分组容器（frame: group 灰底 / emphasis 淡紫强调 / none 无框），层内卡片横排（direction: row）或竖排（column）；
beside 把一层放到前面某层右侧同一行；edges 可连节点或层，正交折线自动避让，标签放线旁空白处；底部图例。
"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C
from templates._common import new_canvas, as_lines, need, wrap_lines, draw_legend, fs

SCHEMA = {
    'template': '"layered-arch"',
    'title / subtitle': '可选；放进文档且有图题时建议不写 title',
    'display': '可选 {"width_ratio": 0.6, "landscape": false}，反推画布宽，保证最小字号等效 ≥ 7pt',
    'layers[]': {
        'id': '必填，唯一',
        'label': '层标题，建议「这一层是什么：包含什么」；frame 为 none 时可省',
        'frame': 'group（默认）| emphasis | none',
        'direction': 'row（默认）| column',
        'beside': '可选，前面某层的 id：本层放在该层右侧同一行',
        'weight': '可选，同一行多层时的宽度权重（默认按内容自然宽度）',
        'columns': '可选，每行最多卡片数（默认自动：放不下就折行）',
        'nodes[]': {'id': '必填，全图唯一', 'label': '卡片标题', 'body': '说明，字符串或字符串数组（每项一段，自动换行）',
                    'role': 'generic_layer | business_line | category | deliverable | neutral | placeholder，或调色板色名',
                    'dashed': '虚线边（保留原样 / 待扩展）', 'emphasis': '强调（标题 22px、2px 边）', 'compact': '紧凑（标题 17px）',
                    'fill': '"white" 时白底', 'weight': 'frame 为 none 的行里按权重分宽'},
    },
    'edges[]': {'from': '节点或层 id', 'to': '节点或层 id', 'label': '可选', 'dashed': '参考 / 只读关系', 'role': '可选，连线颜色（默认取起点颜色）'},
    'legend': '"auto"（按用到的角色生成）| false | [{"role" 或 "color", "label", "dashed", "kind": "box|line"}]',
    'legend_style': 'swatch（默认，色块 + 文字）| text（一行文字，同 architecture.svg）',
}

PAD = 16
CARD_PAD = 10
GAP = 12
TITLE_BAND = 50
MAX_NODE_W = 360


def _node_style(s, n):
    color = k.role_color(n.get('role') or n.get('color') or 'generic_layer')
    if n.get('emphasis'):
        ts = fs(s, 'node_title_emphasis')
    elif n.get('compact'):
        ts = FPX['legend'] * s.font_scale
    elif not as_lines(n.get('body')):
        ts = fs(s, 'group_title')  # 无说明的标签卡片用 18px（与 architecture.svg 的类型包卡片一致）
    else:
        ts = fs(s, 'node_title')
    return color, ts, fs(s, 'node_body')


def _natural_w(s, n):
    color, ts, bs = _node_style(s, n)
    w = k.text_width(n.get('label', ''), ts, True)
    for b in as_lines(n.get('body')):
        w = max(w, min(k.text_width(b, bs), 320))
    return w + 2 * CARD_PAD


def _min_w(s, n):
    color, ts, bs = _node_style(s, n)
    words = max([k.longest_word(n.get('label', ''), ts, True)] + [k.longest_word(b, bs) for b in as_lines(n.get('body'))])
    return max(words + 2 * CARD_PAD, 96)


def render(spec):
    layers = need(spec, 'layers', list)
    if not layers:
        raise SpecError('layers 不能为空')
    s = new_canvas(spec)
    W = s.w
    ids, lids = {}, {}
    for L in layers:
        lid = need(L, 'id', str, 'layers[]')
        if lid in lids or lid in ids:
            raise SpecError(f'id 重复：{lid}')
        lids[lid] = L
        for n in L.get('nodes', []):
            nid = need(n, 'id', str, f'layers[{lid}].nodes[]')
            if nid in ids or nid in lids:
                raise SpecError(f'id 重复：{nid}')
            ids[nid] = (n, L)
    edges = spec.get('edges', [])
    for e in edges:
        for key in ('from', 'to'):
            if e.get(key) not in ids and e.get(key) not in lids:
                raise SpecError(f'edges: {key}={e.get(key)!r} 不是任何节点或层的 id')

    # 1) 分行（band）
    bands = []
    where = {}
    for L in layers:
        b = L.get('beside')
        if b:
            if b not in where:
                raise SpecError(f'layers[{L["id"]}].beside={b!r} 必须指向前面已出现的层')
            bands[where[b]].append(L)
            where[L['id']] = where[b]
        else:
            bands.append([L])
            where[L['id']] = len(bands) - 1

    def band_of(x):
        return where[ids[x][1]['id']] if x in ids else where[x]

    def layer_of(x):
        return ids[x][1]['id'] if x in ids else x

    # 2) 每行内各层宽度
    inner = W - 2 * MARGIN
    geo = {}
    for bi, band in enumerate(bands):
        hgap = []
        for a, b in zip(band, band[1:]):
            linked = any({layer_of(e['from']), layer_of(e['to'])} == {a['id'], b['id']} for e in edges)
            hgap.append(40 if linked else 24)
        nat = []
        for L in band:
            nodes = L.get('nodes', [])
            frame = L.get('frame', 'group')
            pad = 0 if frame == 'none' else PAD
            if L.get('direction', 'row') == 'column':
                w = max([_natural_w(s, n) for n in nodes] + [0]) + 2 * pad
            else:
                w = sum(_natural_w(s, n) for n in nodes) + GAP * max(len(nodes) - 1, 0) + 2 * pad
            if L.get('label') and frame != 'none':
                w = max(w, min(k.text_width(L['label'], FPX['group_title'], True) + 40, inner * 0.6))
            nat.append(float(L.get('weight') or w))
        avail = inner - sum(hgap)
        tot = sum(nat)
        widths = [avail * v / tot for v in nat]
        x = MARGIN
        for L, w, g in zip(band, widths, hgap + [0]):
            geo[L['id']] = {'x': x, 'w': w}
            x += w + g

    # 3) 每层内部排版（算高度）
    layouts = {}
    for L in layers:
        g = geo[L['id']]
        frame = L.get('frame', 'group')
        pad = 0 if frame == 'none' else PAD
        nodes = L.get('nodes', [])
        title_lines = []
        if L.get('label') and frame != 'none':
            title_lines = wrap_lines(s, [L['label']], FPX['group_title'], g['w'] - 40, True, f'层 {L["id"]} 标题')
        top_pad = (TITLE_BAND + (len(title_lines) - 1) * 26) if title_lines else (pad if frame != 'none' else 0)
        cw = g['w'] - 2 * pad
        rows = []
        if L.get('direction', 'row') == 'column':
            rows = [[n] for n in nodes]
        elif nodes:
            maxc = int(L.get('columns') or len(nodes))
            # 放不下就折行：每张卡片不窄于其最长词
            while maxc > 1:
                wn = (cw - GAP * (maxc - 1)) / maxc
                if all(_min_w(s, n) <= wn for n in nodes):
                    break
                maxc -= 1
            rows = [nodes[i:i + maxc] for i in range(0, len(nodes), maxc)]
        placed = []
        y_cursor = 0
        base_gap = GAP * 3 if frame == 'none' else GAP
        for row in rows:
            gaps = []
            for a, b in zip(row, row[1:]):
                link = [e for e in edges if {e['from'], e['to']} == {a['id'], b['id']}]
                if link:
                    lw = max(k.text_width(e.get('label') or '', FPX['edge_label']) for e in link)
                    gaps.append(max(base_gap, 44, lw + 28 if lw else 0))
                else:
                    gaps.append(base_gap)
            if L.get('direction', 'row') == 'column':
                ws = [cw]
            elif frame == 'none':
                nw = [float(n.get('weight') or _natural_w(s, n)) for n in row]
                avail = cw - sum(gaps)
                ws = [avail * v / sum(nw) for v in nw]
            else:
                ncols = max(len(r) for r in rows)
                wn = min((cw - sum(gaps) - GAP * (ncols - len(row))) / ncols, MAX_NODE_W)
                ws = [wn] * len(row)
            wrapped = []
            for n, w in zip(row, ws):
                color, ts, bs = _node_style(s, n)
                tl = wrap_lines(s, [n.get('label', '')], ts, w - 2 * CARD_PAD, True, f'节点 {n["id"]} ')
                bl = wrap_lines(s, as_lines(n.get('body')), bs, w - 2 * CARD_PAD, False, f'节点 {n["id"]} ')
                wrapped.append((n, w, tl, bl, color, ts, bs))
            h = max(s.card_height(len(tl), len(bl), ts, bs) for (_, _, tl, bl, _, ts, bs) in wrapped)
            h = max(h, 48)
            placed.append((wrapped, h, y_cursor, gaps))
            y_cursor += h + (10 if L.get('direction', 'row') == 'column' else GAP)
        content_h = y_cursor - (10 if L.get('direction', 'row') == 'column' else GAP) if placed else 0
        layouts[L['id']] = {'frame': frame, 'pad': pad, 'title': title_lines, 'top': top_pad, 'rows': placed, 'content_h': content_h}

    # 4) 纵向：行间距（有连线穿过的行间留 44，否则 28）
    def gap_after(bi):
        for e in edges:
            a, b = sorted((band_of(e['from']), band_of(e['to'])))
            if a <= bi < b:
                return 46
        return 28

    y = s.top
    band_y = []
    for bi, band in enumerate(bands):
        hs = []
        for L in band:
            lay = layouts[L['id']]
            h = lay['top'] + lay['content_h'] + (lay['pad'] if lay['frame'] != 'none' else 0)
            hs.append(h)
        bh = max(hs)
        band_y.append((y, bh))
        y += bh + (gap_after(bi) if bi < len(bands) - 1 else 0)
    bottom = y
    s.h = int(bottom + 200)  # 暂定，图例后收紧

    # 5) 绘制层与卡片
    used = []
    rects = {}
    for bi, band in enumerate(bands):
        by, bh = band_y[bi]
        for L in band:
            g, lay = geo[L['id']], layouts[L['id']]
            x, w = g['x'], g['w']
            rects[L['id']] = (x, by, w, bh)
            if lay['frame'] == 'emphasis':
                s.rect(x, by, w, bh, FIG['layer_emphasis']['fill'], FIG['layer_emphasis']['stroke'], rx=FIG['radius_px']['group'],
                       sw=FIG['stroke_px']['emphasis'], frame_id=L['id'], title_h=lay['top'] - 6 if lay['title'] else 0)
                tcolor = C['purple'][2]
            elif lay['frame'] == 'group':
                s.rect(x, by, w, bh, FIG['group']['fill'], FIG['group']['stroke'], rx=FIG['radius_px']['group'],
                       sw=FIG['stroke_px']['group'], frame_id=L['id'], title_h=lay['top'] - 6 if lay['title'] else 0)
                tcolor = k.TEXT['title']
            for i, ln in enumerate(lay['title']):
                s.t(x + 20, by + 30 + i * 26, ln, FPX['group_title'], tcolor, bold=True, container=(x, by, w, bh))
            pad = lay['pad']
            area_top = by + lay['top']
            area_h = bh - lay['top'] - (pad if lay['frame'] != 'none' else 0)
            off = max(0, (area_h - lay['content_h']) / 2) if L.get('direction') == 'column' or len(band) > 1 else 0
            for wrapped, h, ry, gaps in lay['rows']:
                tot_w = sum(w_ for (_, w_, *_r) in wrapped) + sum(gaps)
                cx = x + pad + max(0, (w - 2 * pad - tot_w) / 2) if lay['frame'] != 'none' else x
                if lay['frame'] == 'none':
                    cx = x + (w - tot_w) / 2
                for j, (n, nw, tl, bl, color, ts, bs) in enumerate(wrapped):
                    ny = area_top + off + ry
                    s.card(cx, ny, nw, h, tl, bl, color, dash=bool(n.get('dashed')), emphasis=bool(n.get('emphasis')),
                           fill='#FFFFFF' if n.get('fill') == 'white' else None, node_id=n['id'], group=L['id'], title_size=ts, body_size=bs,
                           dasharray=(FIG['dash']['retained'] if n.get('dashed') and color != 'white' else None),
                           title_color=(k.TEXT['subtitle'] if color == 'white' else None), title_bold=(color != 'white'))
                    rects[n['id']] = (cx, ny, nw, h)
                    used.append((color, bool(n.get('dashed')), n.get('role')))
                    cx += nw + (gaps[j] if j < len(gaps) else 0)

    # 6) 连线
    router = k.Router(s, grid=4, margin=8)
    for n in s.nodes:
        router.add_obstacle(n['x'], n['y'], n['w'], n['h'])
    for t in s.texts:
        router.add_obstacle(t['x'], t['y'], t['w'], t['h'], margin=4)
    for f in s.frames:
        router.add_frame(f['x'], f['y'], f['w'], f['h'])
        if f.get('title_h'):
            router.add_band(f['x'], f['y'], f['w'], f['title_h'])
    pending_labels = []
    labeled = set()

    def order(e):
        a, b = rects[e['from']], rects[e['to']]
        return abs(a[1] - b[1]) + abs(a[0] - b[0])

    for e in sorted(edges, key=order):
        a, b = e['from'], e['to']
        if e.get('role') or e.get('color'):
            color = k.role_color(e.get('role') or e.get('color'))
        elif a in ids:
            color = k.role_color(ids[a][0].get('role') or ids[a][0].get('color') or 'generic_layer')
        else:
            color = k.role_color(lids[a].get('role') or 'neutral')
        ba, bb = band_of(a), band_of(b)
        # 跨行连线只走上下边（分层图的阅读方向）；同一行内才允许左右边
        sides = None
        if ba < bb:
            sides = ({1}, {3})
        elif ba > bb:
            sides = ({3}, {1})
        pts = router.route(rects[a], rects[b], 'node' if a in ids else 'frame', 'node' if b in ids else 'frame', allow_sides=sides)
        if not pts and sides:
            pts = router.route(rects[a], rects[b], 'node' if a in ids else 'frame', 'node' if b in ids else 'frame')
        if not pts:
            s.issues.append(k.issue('edge_unroutable', f'连线 {a} → {b} 找不到不穿过节点的路径', f'{a}->{b}'))
            continue
        s.line(pts, color, dash=bool(e.get('dashed')), edge_id=f'{a}->{b}')
        if e.get('label'):
            key = (e['to'], e['label'])
            if key in labeled:
                continue  # 同一目标的同名标签只标一次
            labeled.add(key)
            pending_labels.append((pts, e['label'], C[color][2] if e.get('dashed') else k.TEXT['subtitle']))
    s.h = int(bottom + 24)
    for pts, label, lc in pending_labels:
        if not k.place_label(s, pts, label, color=lc):
            pass  # 自检 check() 报 label_collision

    # 7) 图例与收高
    ly = bottom + 24
    s.h = 10 ** 5
    lh = draw_legend(s, spec, used, ly)
    s.h = int(ly + lh + 16) if lh else int(bottom + MARGIN)
    return s
