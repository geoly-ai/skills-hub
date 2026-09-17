"""milestone：里程碑时间轴。阶段条宽度按时长比例（放不下文字时保底宽度），轴上菱形里程碑带标签与徽标（如节点比例），
支持多行阶梯（行尾经通道连到下一行行首）。"""
import svgkit as k
from svgkit import SpecError, FIG, FPX, MARGIN, C, TEXT
from templates._common import new_canvas, as_lines, need, wrap_lines, draw_legend
from templates._stairs import split_rows

SCHEMA = {
    'template': '"milestone"',
    'unit': '时长单位文字，默认「周」',
    'rows': '"auto"（阶段数 ≤4 一行，5–8 两行…）| 1 | 2 | 3',
    'phases[]': {'id': '可选', 'name': '阶段名', 'duration': '时长（数字，单位 unit）', 'items': '可选要点', 'role': '可选颜色角色'},
    'milestones[]': {'after': '阶段 id 或下标：里程碑在该阶段结束处', 'at': '或：从起点起的时长位置（数字）',
                     'label': '里程碑名', 'tag': '可选徽标（如节点比例）', 'role': '可选颜色'},
    'start_label': '可选，轴起点文字，默认「启动」',
    'legend': '默认 false；或 [{"role", "label"}]',
}

PHASE_COLORS = ['purple', 'blue', 'green', 'orange']
ROW_GAP = 64


def _fmt_num(v):
    return str(int(v)) if float(v) == int(v) else f'{v:g}'


def render(spec):
    phases = need(spec, 'phases', list)
    n = len(phases)
    if not 1 <= n <= 16:
        raise SpecError('phases 需要 1–16 个')
    unit = spec.get('unit', '周')
    s = new_canvas(spec)
    W = s.w
    ids = {}
    starts, t = [], 0.0
    for i, p in enumerate(phases):
        d = need(p, 'duration', (int, float), f'phases[{i}]')
        if d <= 0:
            raise SpecError(f'phases[{i}].duration 必须 > 0')
        if p.get('id'):
            ids[p['id']] = i
        starts.append(t)
        t += d
    total = t
    rows = split_rows(n, spec.get('rows', 'auto'))
    bs, ts = FPX['node_body'], FPX['node_title']
    TLH, BLH = round(ts * 1.4), round(bs * 1.4)

    # 里程碑解析到 (时刻)
    ms = []
    for j, m in enumerate(spec.get('milestones') or []):
        if 'after' in m:
            a = m['after']
            i = a if isinstance(a, int) else ids.get(a)
            if i is None or not 0 <= i < n:
                raise SpecError(f'milestones[{j}].after 引用了不存在的阶段：{a!r}')
            tm = starts[i] + phases[i]['duration']
        elif 'at' in m:
            tm = float(m['at'])
            if not 0 <= tm <= total:
                raise SpecError(f'milestones[{j}].at 超出总时长 {total}')
        else:
            raise SpecError(f'milestones[{j}] 需要 after 或 at')
        ms.append((tm, m))

    avail = W - 2 * MARGIN
    rows_geo = []
    y = s.top + 8
    used = []
    for ri, row in enumerate(rows):
        dur = [phases[i]['duration'] for i in row]
        mins = [max(k.longest_word(phases[i]['name'], ts, True), k.text_width(f'{_fmt_num(phases[i]["duration"])} {unit}', bs)) + 28 for i in row]
        widths = [avail * d / sum(dur) for d in dur]
        # 保底宽度：不够的从富余的阶段里匀
        for _ in range(6):
            short = [idx for idx, (w, mn) in enumerate(zip(widths, mins)) if w < mn]
            if not short:
                break
            need_px = sum(mins[i] - widths[i] for i in short)
            rich = [idx for idx in range(len(widths)) if idx not in short]
            rich_extra = sum(widths[i] - mins[i] for i in rich)
            if rich_extra <= 0:
                break
            for i in short:
                widths[i] = mins[i]
            for i in rich:
                widths[i] -= need_px * (widths[i] - mins[i]) / rich_extra
        x = MARGIN
        segs = []
        for i, w in zip(row, widths):
            p = phases[i]
            color = k.role_color(p.get('role') or PHASE_COLORS[i % 4])
            tl = wrap_lines(s, [p['name']], ts, w - 28, True, f'phases[{i}] ')
            il = [wrap_lines(s, [it], bs, w - 28 - 12, False, f'phases[{i}] ') for it in as_lines(p.get('items'))]
            segs.append({'i': i, 'x': x, 'w': w, 'tl': tl, 'il': il, 'color': color})
            used.append((color, False, p.get('role')))
            x += w
        bar_h = max(12 + len(sg['tl']) * TLH + BLH + (8 + sum(len(l) for l in sg['il']) * BLH if sg['il'] else 0) + 12 for sg in segs)
        rows_geo.append({'y': y, 'bar_h': bar_h, 'segs': segs, 't0': starts[row[0]], 't1': starts[row[-1]] + phases[row[-1]]['duration']})
        # 轴与里程碑标签区高度（稍后按标签实际行数定）
        y += bar_h + 28 + 40  # 轴线 + 刻度文字
        rows_geo[-1]['axis_y'] = rows_geo[-1]['y'] + bar_h + 28
        # 里程碑标签：两道泳道避让
        row_ms = [(tm, m) for tm, m in ms if rows_geo[-1]['t0'] <= tm <= rows_geo[-1]['t1'] and not (ri > 0 and tm == rows_geo[-1]['t0'])]
        lanes = [[], []]
        placed = []

        def tx(tm, rg=rows_geo[-1]):
            for sg in rg['segs']:
                p = phases[sg['i']]
                st = starts[sg['i']]
                if st - 1e-9 <= tm <= st + p['duration'] + 1e-9:
                    return sg['x'] + sg['w'] * (tm - st) / p['duration']
            return rg['segs'][-1]['x'] + rg['segs'][-1]['w']

        for tm, m in row_ms:
            mx = tx(tm)
            lines = wrap_lines(s, [m['label']], FPX['legend'], 220, True, '里程碑 ')
            lw = max(k.text_width(l, FPX['legend'], True) for l in lines)
            tagw = k.text_width(m['tag'], FPX['legend'], True) + 20 if m.get('tag') else 0
            bw = max(lw, tagw)
            left = min(max(mx - bw / 2, MARGIN), W - MARGIN - bw)
            lane = 0
            for li in (0, 1):
                if all(left > r + 16 or left + bw < l - 16 for l, r in lanes[li]):
                    lane = li
                    break
            else:
                lane = 1
            lanes[lane].append((left, left + bw))
            placed.append((mx, left, bw, lines, m, lane))
        lane_h = max([len(p[3]) * 24 + (30 if p[4].get('tag') else 0) for p in placed] + [0])
        rows_geo[-1]['ms'] = placed
        rows_geo[-1]['lane_h'] = lane_h
        n_lanes = 2 if any(p[5] == 1 for p in placed) else (1 if placed else 0)
        y += n_lanes * (lane_h + 12) + ROW_GAP
    bottom = y - ROW_GAP
    s.h = int(bottom + 400)

    for ri, rg in enumerate(rows_geo):
        ay = rg['axis_y']
        for sg in rg['segs']:
            p = phases[sg['i']]
            st, bg, tc = C[sg['color']]
            x, w, yb, h = sg['x'] + 3, sg['w'] - 6, rg['y'], rg['bar_h']
            s.rect(x, yb, w, h, bg, st, rx=FIG['radius_px']['node'], sw=FIG['stroke_px']['node'], node_id=f'phase-{sg["i"]}')
            box = (x, yb, w, h)
            cy = yb + 12
            for ln in sg['tl']:
                s.t(x + 11, cy + (TLH + k.ascent(ts) - k.descent(ts)) / 2, ln, ts, tc, bold=True, container=box)
                cy += TLH
            s.t(x + 11, cy + (BLH + k.ascent(bs) - k.descent(bs)) / 2, f'{_fmt_num(p["duration"])} {unit}', bs, TEXT['subtitle'], container=box)
            cy += BLH
            if sg['il']:
                cy += 8
                for lines in sg['il']:
                    s.circle(x + 15, cy + BLH / 2, 3, st)
                    for ln in lines:
                        s.t(x + 23, cy + (BLH + k.ascent(bs) - k.descent(bs)) / 2, ln, bs, TEXT['body'], container=box)
                        cy += BLH
        x_end = rg['segs'][-1]['x'] + rg['segs'][-1]['w']
        s.hline(MARGIN, x_end, ay, '#9AA0A6', 2)
        # 刻度：阶段边界
        ticks = [(rg['segs'][0]['x'], starts[rg['segs'][0]['i']])] + [(sg['x'] + sg['w'], starts[sg['i']] + phases[sg['i']]['duration']) for sg in rg['segs']]
        for j, (x, tm) in enumerate(ticks):
            s.vline(x, ay - 6, ay + 6, '#9AA0A6', 2)
            label = (spec.get('start_label', '启动') if tm == 0 else f'第 {_fmt_num(tm)} {unit}')
            anchor = 'start' if j == 0 else ('end' if j == len(ticks) - 1 else 'middle')
            s.t(x + (4 if anchor == 'start' else (-4 if anchor == 'end' else 0)), ay + 36, label, FPX['legend'], TEXT['legend'], anchor)
        base = ay + 50
        for (mx, left, bw, lines, m, lane) in rg['ms']:
            color = k.role_color(m.get('role') or 'generic_layer')
            st, bg, tc = C[color]
            s.polygon([(mx, ay - 10), (mx + 10, ay), (mx, ay + 10), (mx - 10, ay)], st, '#FFFFFF', 1.5)
            ly = base + lane * (rg['lane_h'] + 12)
            if lane:
                s.vline(mx, ay + 12, ly - 4, st, 1, dasharray='3 3')
            for j, ln in enumerate(lines):
                s.t(left + bw / 2, ly + 18 + j * 24, ln, FPX['legend'], tc, 'middle', True)
            if m.get('tag'):
                tw = k.text_width(m['tag'], FPX['legend'], True) + 20
                s.pill(left + bw / 2 - tw / 2, ly + len(lines) * 24 + 2, tw, 26, m['tag'], 'orange', True)
        if ri < len(rows_geo) - 1:
            nxt = rows_geo[ri + 1]
            gy = bottom if False else (nxt['y'] - ROW_GAP / 2)
            s.line([(x_end, ay), (x_end + 0.1, ay)], 'gray', head=False)
            fx = nxt['segs'][0]['x'] + nxt['segs'][0]['w'] / 2
            s.line([(x_end - 1, ay + 7), (x_end - 1, gy), (fx, gy), (fx, nxt['y'] - 1)], 'gray', dash=True, edge_id=f'row{ri}->{ri + 1}')
    y = bottom
    lg = spec.get('legend', False)
    lh = 0
    if lg:
        s.h = 10 ** 5
        lh = draw_legend(s, spec, used, y + 24)
    s.h = int(y + (24 + lh + 16 if lh else MARGIN))
    return s
