#!/usr/bin/env python3
"""doc-figures build：把运行目录 figures/ 下的图源渲染成 PDF 用 SVG 与 PNG 预览，做机器检查，写 figures/review.json。

用法：
  python3 build.py <运行目录> [--only 名称[,名称]] [--no-png] [--no-wb] [--jobs 4]
  python3 build.py --regen-metrics            重新实测字体度量（scripts/font_metrics.json）

路由（按扩展名）：
  x.mmd       Mermaid（Chrome + mermaid.min.js：首次联网拉取并校验 sha256，之后走 ~/.cache/doc-figures 离线复用）→ x.svg、x.png；预处理改动写 x.resolved.mmd（飞书端用它）
  x.dot       Graphviz WASM → x.svg、x.png
  x.fig.json  svgkit 模板（"template" 字段）→ x.svg、x.png
  x.svg       成品：原样校验 → x.png
  x.png/jpg   位图：只登记尺寸

图源内选项（Mermaid 用 `%% doc-figures: …`，DOT 用 `// doc-figures: …`，.fig.json 用 "display" 与 "aspect_check"）：
  width=0.6        显示宽比例（算等效字号）
  landscape        横向页段
  aspect=flow|off  是否按流程类图检查宽高比 1:0.35–0.7（flowchart、phases、swimlane、milestone 默认 flow）
  stairs [rows=N]  （Mermaid）线性 flowchart 改写为阶梯式

退出码：0 全部无必改；1 有必改；2 参数或环境错误。
"""
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import svgkit as k  # noqa: E402
import lint  # noqa: E402
import mermaid  # noqa: E402
import graphviz  # noqa: E402
from templates import get as get_template, template_name  # noqa: E402

VERSION = '1.1.0'
CHROME_JS = os.path.join(HERE, 'chrome.mjs')
FLOW_TEMPLATES = {'phases', 'swimlane', 'milestone'}
FLOW_MERMAID = {'flowchart'}
OPT_RE = re.compile(r'^\s*(?:%%|//)\s*doc-figures:\s*(.*)$', re.M)


def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def parse_opts(text):
    opts = {}
    for m in OPT_RE.finditer(text):
        for tok in m.group(1).split():
            if '=' in tok:
                a, b = tok.split('=', 1)
                opts[a] = b
            else:
                opts[tok] = True
    return opts


def collect(fig_dir, only=None):
    names = sorted(os.listdir(fig_dir))
    stems = {}
    for fn in names:
        p = os.path.join(fig_dir, fn)
        if not os.path.isfile(p) or fn.startswith('.'):
            continue
        if fn.endswith('.resolved.mmd') or fn == 'review.json':
            continue
        for ext, kind in (('.fig.json', 'svgkit'), ('.mmd', 'mermaid'), ('.dot', 'graphviz')):
            if fn.endswith(ext):
                stems[fn[:-len(ext)]] = (kind, fn)
                break
    out = []
    for stem, (kind, fn) in stems.items():
        out.append({'stem': stem, 'engine': kind, 'source': fn})
    for fn in names:
        stem, ext = os.path.splitext(fn)
        if ext.lower() == '.svg' and stem not in stems:
            out.append({'stem': stem, 'engine': 'svg', 'source': fn})
        elif ext.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.gif') and stem not in stems and not os.path.exists(os.path.join(fig_dir, stem + '.svg')):
            out.append({'stem': stem, 'engine': 'bitmap', 'source': fn})
    if only:
        want = set(only)
        out = [f for f in out if f['stem'] in want or f['source'] in want]
    return sorted(out, key=lambda f: f['stem'])


def run_chrome(tasks, mermaid_js=''):
    if not tasks:
        return {'results': []}
    with tempfile.TemporaryDirectory() as td:
        jp, rp = os.path.join(td, 'jobs.json'), os.path.join(td, 'res.json')
        json.dump({'mermaid_js': mermaid_js, 'tasks': tasks}, open(jp, 'w', encoding='utf-8'))
        r = subprocess.run(['node', CHROME_JS, jp, rp], capture_output=True, text=True, timeout=900)
        if not os.path.exists(rp):
            return {'error': f'chrome.mjs 失败（退出码 {r.returncode}）：{r.stderr.strip()[-300:]}', 'results': []}
        return json.load(open(rp, encoding='utf-8'))


def chrome_available():
    r = subprocess.run(['node', CHROME_JS, '--which'], capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip()


def sev_issue(rule, severity, message, target=''):
    return {'rule': rule, 'severity': severity, 'message': message, 'target': str(target)[:80]}


def slug(stem):
    s = re.sub(r'[^A-Za-z0-9_-]+', '-', stem).strip('-')
    return s or 'x'


def build(run_dir, only=None, png=True, wb=True, jobs=4):
    fig_dir = os.path.join(run_dir, 'figures')
    if not os.path.isdir(fig_dir):
        print(f'找不到 {fig_dir}', file=sys.stderr)
        return 2
    figs = collect(fig_dir, only)
    if not figs:
        print('figures/ 下没有图源')
        return 0
    has_chrome = bool(chrome_available())
    records = {}
    mermaid_tasks = []
    for f in figs:
        stem, src = f['stem'], os.path.join(fig_dir, f['source'])
        rec = {'file': f'figures/{stem}.svg' if f['engine'] != 'bitmap' else f'figures/{f["source"]}', 'source': f'figures/{f["source"]}',
               'engine': f['engine'], 'png': None, 'feishu': None, 'issues': [], 'notes': [], 'opts': {}, 'measure_boxes': None, 'group_selector': None}
        records[stem] = rec
        out_svg = os.path.join(fig_dir, stem + '.svg')
        try:
            if f['engine'] == 'svgkit':
                spec = json.load(open(src, encoding='utf-8'))
                name = template_name(spec)
                if not name:
                    raise k.SpecError('缺少 "template" 字段')
                rec['template'] = name
                disp = spec.get('display') or {}
                rec['opts'] = {'width': disp.get('width_ratio', 1.0), 'landscape': bool(disp.get('landscape')),
                               'aspect': spec.get('aspect_check', 'flow' if name in FLOW_TEMPLATES else 'off')}
                canvas = get_template(name).render(spec)
                for it in canvas.check():
                    rec['issues'].append(it)
                canvas.save(out_svg)
                rec['measure_boxes'] = canvas.measure_boxes()
                rec['feishu'] = {'type': 'svg', 'path': rec['file']}
            elif f['engine'] == 'graphviz':
                text = open(src, encoding='utf-8').read()
                o = parse_opts(text)
                rec['opts'] = {'width': float(o.get('width', 1.0)), 'landscape': 'landscape' in o, 'aspect': o.get('aspect', 'off')}
                r = graphviz.render(src, out_svg)
                if not r['ok']:
                    raise RuntimeError('Graphviz 渲染失败：' + r['error'])
                rec['graphviz'] = r.get('graphviz')
                rec['group_selector'] = 'g.node'
                rec['feishu'] = {'type': 'svg', 'path': rec['file']}
            elif f['engine'] == 'mermaid':
                text = open(src, encoding='utf-8').read()
                o = parse_opts(text)
                kind = mermaid.diagram_kind(text)
                rec['diagram'] = kind
                rec['opts'] = {'width': float(o.get('width', 1.0)), 'landscape': 'landscape' in o,
                               'aspect': o.get('aspect', 'flow' if kind in FLOW_MERMAID else 'off')}
                for it in mermaid.lint_source(text):
                    rec['issues'].append(it)
                resolved, notes = mermaid.preprocess(text)
                rec['notes'] += notes
                rpath = os.path.join(fig_dir, stem + '.resolved.mmd')
                if resolved != text:
                    open(rpath, 'w', encoding='utf-8').write(resolved)
                    rec['feishu'] = {'type': 'mermaid', 'path': f'figures/{stem}.resolved.mmd'}
                else:
                    if os.path.exists(rpath):
                        os.remove(rpath)
                    rec['feishu'] = {'type': 'mermaid', 'path': rec['source']}
                if any(i['rule'] == 'mmd_linear_long' for i in rec['issues']):
                    pass
                cfg = mermaid.theme_config()
                intervals = None
                if kind == 'gantt':
                    base = cfg.get('gantt', {}).get('tickInterval', '1week')
                    m = re.search(r'^\s*tickInterval\s+(\S+)', resolved, re.M)
                    if m:
                        intervals = [m.group(1)]
                    else:
                        start = mermaid.GANTT_INTERVALS.index(base) if base in mermaid.GANTT_INTERVALS else 2
                        intervals = mermaid.GANTT_INTERVALS[start:]
                if not has_chrome:
                    raise RuntimeError('找不到 Chrome（设 CHROME_PATH），Mermaid 无法渲染')
                mermaid_tasks.append({'kind': 'mermaid', 'id': stem, 'source': resolved, 'config': cfg, 'gantt_intervals': intervals})
            elif f['engine'] == 'svg':
                rec['feishu'] = {'type': 'svg', 'path': rec['file']}
                rec['opts'] = {'width': 1.0, 'landscape': False, 'aspect': 'off'}
            elif f['engine'] == 'bitmap':
                rec['feishu'] = {'type': 'img', 'path': rec['file']}
                rec['opts'] = {}
        except (k.SpecError, ValueError, KeyError, RuntimeError, json.JSONDecodeError) as e:
            rec['issues'].append(sev_issue('render_error', '必改', f'{type(e).__name__}: {e}'))
            rec['failed'] = True

    # Mermaid 一次 Chrome 批量渲染
    if mermaid_tasks:
        try:
            mermaid_js = mermaid.mermaid_js()
        except RuntimeError as e:
            mermaid_js = ''
            res = {'error': f'mermaid.min.js 不可用：{e}', 'results': []}
        else:
            res = run_chrome(mermaid_tasks, mermaid_js)
        if res.get('error'):
            for t in mermaid_tasks:
                records[t['id']]['issues'].append(sev_issue('render_error', '必改', res['error']))
                records[t['id']]['failed'] = True
        for r in res.get('results', []):
            rec = records[r['id']]
            rec['chrome'] = res.get('chrome_version')
            if r.get('error'):
                rec['issues'].append(sev_issue('render_error', '必改', 'Mermaid 渲染失败：' + r['error'][:300]))
                rec['failed'] = True
                continue
            svg = r['svg']
            if not svg.startswith('<svg') or 'xmlns=' not in svg[:200]:
                svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"', 1)
            open(os.path.join(fig_dir, r['id'] + '.svg'), 'w', encoding='utf-8').write(svg + '\n')
            rec['mermaid'] = {'diagram_type': r.get('diagram_type'), 'foreign_objects': r.get('foreign_objects'), 'removed_styles': r.get('removed_styles'),
                              'removed_filters': r.get('removed_filters'), 'text_overlaps': r.get('text_overlaps')}
            if r.get('foreign_objects'):
                rec['notes'].append(f'PDF 用 SVG 含 {r["foreign_objects"]} 个 foreignObject（htmlLabels=false 仍未消除）：该图飞书端走 mermaid 源，PDF 端 SVG 含 foreignObject')
                rec['issues'].append(sev_issue('mmd_foreign_object', '提示', '该图飞书端走 mermaid 源，PDF 端 SVG 含 foreignObject'))
            if r.get('is_gantt'):
                rec['gantt'] = {'attempts': r.get('attempts'), 'tick_overlaps': r.get('tick_overlaps'), 'ticks': r.get('ticks')}
                chosen = next((a['tick_interval'] for a in r.get('attempts', []) if a.get('tick_overlaps') == 0), None)
                rec['gantt']['tick_interval'] = chosen
                if r.get('tick_overlaps'):
                    rec['issues'].append(sev_issue('mmd_gantt_ticks', '必改', f'甘特刻度仍有 {r["tick_overlaps"]} 处重叠（已试 {[a["tick_interval"] for a in r.get("attempts", [])]}）'))
                elif chosen and len(r.get('attempts', [])) > 1:
                    rec['notes'].append(f'甘特刻度默认间隔重叠，已自动改为 tickInterval {chosen}')
                    rp = os.path.join(fig_dir, r['id'] + '.resolved.mmd')
                    base_src = open(rp, encoding='utf-8').read() if os.path.exists(rp) else open(os.path.join(fig_dir, rec['source'].split('/', 1)[1]), encoding='utf-8').read()
                    new = re.sub(r'^(\s*gantt\s*)$', r'\1\n    tickInterval ' + chosen, base_src, count=1, flags=re.M)
                    open(rp, 'w', encoding='utf-8').write(new)
                    rec['feishu'] = {'type': 'mermaid', 'path': f'figures/{r["id"]}.resolved.mmd'}
            for pair in (r.get('text_overlaps') or [])[:5]:
                rec['issues'].append(sev_issue('text_overlap', '建议', f'Mermaid 文字重叠：「{pair[0]}」与「{pair[1]}」'))

    # id 命名空间（写回 SVG）
    for stem, rec in records.items():
        if rec.get('failed') or rec['engine'] == 'bitmap':
            continue
        p = os.path.join(fig_dir, stem + '.svg')
        if rec['engine'] == 'svg':
            continue  # 成品不改写，1b 内联时自行调用 lint.namespace_ids
        txt = open(p, encoding='utf-8').read()
        new = lint.namespace_ids(txt, f'fig-{slug(stem)}-')
        if new != txt:
            open(p, 'w', encoding='utf-8').write(new)

    # Chrome 第二遍：实测越界 + PNG
    tasks = []
    for stem, rec in records.items():
        if rec.get('failed') or rec['engine'] == 'bitmap':
            continue
        p = os.path.abspath(os.path.join(fig_dir, stem + '.svg'))
        if rec['engine'] in ('svgkit', 'graphviz', 'svg', 'mermaid'):
            tasks.append({'kind': 'measure', 'id': stem, 'svg_path': p, 'boxes': rec['measure_boxes'] or [], 'group_selector': rec['group_selector']})
        if png:
            tasks.append({'kind': 'screenshot', 'id': stem, 'svg_path': p, 'png_path': os.path.abspath(os.path.join(fig_dir, stem + '.png')), 'scale': 2})
    chrome_ver = None
    if has_chrome and tasks:
        res = run_chrome(tasks)
        chrome_ver = res.get('chrome_version')
        for r in res.get('results', []):
            rec = records[r['id']]
            if r.get('error'):
                rec['notes'].append(f'Chrome {r["kind"]} 失败：{r["error"][:200]}')
                continue
            if r['kind'] == 'measure':
                rec['render_check'] = {'text_overflow': r['text_overflow'], 'text_overlaps': r['text_overlaps'], 'outside_canvas': r['outside_canvas']}
                for o in r['text_overflow']:
                    rec['issues'].append(sev_issue('render_text_overflow', '必改', f'Chrome 实测文字越出所属框：{o["text"]}', o['text']))
                for t in r['outside_canvas']:
                    rec['issues'].append(sev_issue('render_outside_canvas', '必改', f'Chrome 实测文字越出画布：{t}', t))
                if rec['engine'] in ('svgkit', 'graphviz'):
                    for a, b in r['text_overlaps'][:10]:
                        rec['issues'].append(sev_issue('render_text_overlap', '必改', f'Chrome 实测文字重叠：「{a}」与「{b}」', a))
            elif r['kind'] == 'screenshot':
                rec['png'] = f'figures/{r["id"]}.png'
    elif png and tasks:
        for stem, rec in records.items():
            if rec.get('failed') or rec['engine'] in ('bitmap', 'mermaid'):
                continue
            if shutil.which('rsvg-convert'):
                subprocess.run(['rsvg-convert', '-z', '2', os.path.join(fig_dir, stem + '.svg'), '-o', os.path.join(fig_dir, stem + '.png')])
                rec['png'] = f'figures/{stem}.png'
                rec['notes'].append('无 Chrome：PNG 用 rsvg-convert 生成，未做实测越界检查')

    # 静态检查：画板约束、字号、宽高比
    for stem, rec in records.items():
        if rec.get('failed') or rec['engine'] == 'bitmap':
            continue
        svg = open(os.path.join(fig_dir, stem + '.svg'), encoding='utf-8').read()
        applies = rec['feishu'] and rec['feishu']['type'] == 'svg'
        bl = lint.board_lint(svg)
        rec['board_lint_applies'] = bool(applies)
        rec['board_lint'] = bl
        if applies:
            rec['issues'] += bl
        st = lint.font_stats(svg)
        rec['viewbox'] = [st['viewbox_width'], st['viewbox_height']]
        rec['min_font_px'] = st['min_font_px']
        pt, fi = lint.font_issue(st, float(rec['opts'].get('width', 1.0)), rec['opts'].get('landscape', False))
        rec['min_font_pt'] = pt
        rec['notes'] += st['notes']
        if fi:
            rec['issues'].append(fi)
        if st['viewbox_width']:
            rec['suggested_width_ratio'] = lint.suggested_width_ratio(st['viewbox_width'])
            rec['aspect_ratio'] = round(st['viewbox_height'] / st['viewbox_width'], 3)
        if rec['opts'].get('aspect') == 'flow':
            a = lint.aspect_check(svg)
            if a:
                rec['issues'].append(a)

    # whiteboard-cli（并行；Mermaid 检查飞书端实际拿到的源）
    if wb:
        def wbjob(stem):
            rec = records[stem]
            if rec.get('failed') or rec['engine'] == 'bitmap':
                return stem, None
            path = os.path.join(run_dir, rec['feishu']['path'])
            return stem, lint.whiteboard_check(path)
        with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
            for stem, res in ex.map(wbjob, list(records)):
                if res is None:
                    continue
                rec = records[stem]
                rec['whiteboard_check'] = res
                if res.get('skipped'):
                    rec['notes'].append('whiteboard-cli 跳过：' + res['skipped'])
                if res.get('errors') and not any(str(it.get('severity', 'error')).lower() == 'error' for it in res.get('issues', [])):
                    rec['issues'].append(sev_issue('wb_errors', '必改', f'whiteboard-cli 报 {res["errors"]} 个错误（未给出明细）'))
                for it in res.get('issues', [])[:20]:
                    sev = '必改' if str(it.get('severity', 'error')).lower() == 'error' else '建议'
                    rec['issues'].append(sev_issue('wb_' + str(it.get('type', 'issue')), sev, f'whiteboard-cli：{it.get("message") or json.dumps(it, ensure_ascii=False)[:160]}'))
    else:
        for rec in records.values():
            rec['whiteboard_check'] = {'skipped': '--no-wb'}

    # review.json
    rpath = os.path.join(fig_dir, 'review.json')
    old = {}
    if os.path.exists(rpath):
        try:
            for f in json.load(open(rpath, encoding='utf-8')).get('figures', []):
                old[f.get('file')] = f
        except (json.JSONDecodeError, AttributeError):
            pass
    out_figs = []
    must_total = 0
    for stem in sorted(records):
        rec = records[stem]
        must = [i for i in rec['issues'] if i['severity'] == '必改']
        must_total += len(must)
        prev = old.get(rec['file'], {})
        human = prev.get('human') or ({'checked_at': prev.get('checked_at', ''), 'checked_by': '', 'issues': prev.get('issues', '')} if 'issues' in prev and 'machine' not in prev else
                                      {'checked_at': '', 'checked_by': '', 'issues': ''})
        machine = {
            'checked_at': now(), 'engine_version': VERSION, 'template': rec.get('template'), 'diagram': rec.get('diagram'),
            'board_lint_applies': rec.get('board_lint_applies'), 'board_lint': rec.get('board_lint', []),
            'whiteboard_check': rec.get('whiteboard_check'), 'render_check': rec.get('render_check'),
            'viewbox_width': (rec.get('viewbox') or [None])[0], 'viewbox_height': (rec.get('viewbox') or [None, None])[1],
            'min_font_px': rec.get('min_font_px'), 'min_font_pt': rec.get('min_font_pt'), 'display_width_ratio': rec['opts'].get('width'),
            'suggested_width_ratio': rec.get('suggested_width_ratio'), 'aspect_ratio': rec.get('aspect_ratio'),
            'mermaid': rec.get('mermaid'), 'gantt': rec.get('gantt'), 'notes': rec['notes'], 'issues': rec['issues'],
            'must_fix': len(must), 'ok': not must and not rec.get('failed'),
        }
        out_figs.append({'file': rec['file'], 'source': rec['source'], 'engine': rec['engine'], 'png': rec.get('png'), 'feishu': rec.get('feishu'),
                         'machine': machine, 'human': human})
    for f, prev in old.items():
        if not any(x['file'] == f for x in out_figs) and only:
            out_figs.append(prev)
    out_figs.sort(key=lambda x: x['file'])
    # 退出码按最终写入的全部图计算（--only 时保留的旧记录也算）
    must_total = sum((x.get('machine') or {}).get('must_fix') or 0 for x in out_figs)
    review = {'generated_at': now(), 'engine': {'name': 'doc-figures', 'version': VERSION, 'mermaid': '11.17.2', 'graphviz': '16.1.0 (@hpcc-js/wasm-graphviz 1.29.1)',
                                                'chrome': chrome_ver}, 'figures': out_figs}
    json.dump(review, open(rpath, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    for x in out_figs:
        m = x.get('machine') or {}
        print(f'{"OK  " if m.get("ok") else "FAIL"} {x["file"]:<42} {x["engine"]:<9} 最小 {m.get("min_font_px")}px ≈ {m.get("min_font_pt")}pt  必改 {m.get("must_fix")}  ' +
              ('; '.join(i['message'] for i in m.get('issues', []) if i['severity'] == '必改')[:200]))
    print(f'review.json → {rpath}（必改合计 {must_total}）')
    return 1 if must_total else 0


def regen_metrics():
    chars = [chr(c) for c in range(0x20, 0x7f)] + list('·…–—●◐○◆◇■□▲△→←↑↓✓✗①②③④⑤⑥⑦⑧⑨⑩⑪⑫（）【】「」《》，。、；：！？“”‘’％＋－／')
    fam = ', '.join(f'"{x.strip()}"' if ' ' in x.strip() else x.strip() for x in k.FONT_FAMILY.split(','))
    res = run_chrome([{'kind': 'metrics', 'id': 'm', 'chars': chars, 'family': fam}])
    m = res['results'][0]['metrics']
    out = {'_note': '由 chrome.mjs metrics 任务在 Chrome 内用 canvas.measureText 实测生成（1em 前进宽度）；未列出的全角字按 cjk 宽度计。重新生成：python3 build.py --regen-metrics',
           'family': fam, 'chrome': res.get('chrome_version'), 'regular': m['normal']['widths'], 'bold': m['bold']['widths'], 'cjk': m['normal']['cjk'], 'cjk_bold': m['bold']['cjk'],
           'font_ascent': m['normal']['font_ascent'], 'font_descent': m['normal']['font_descent']}
    json.dump(out, open(k.METRICS_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print(k.METRICS_PATH)
    return 0


def main(argv):
    if '--regen-metrics' in argv:
        return regen_metrics()
    args = [a for a in argv if not a.startswith('--')]
    if not args:
        print(__doc__)
        return 2
    only = None
    if '--only' in argv:
        only = argv[argv.index('--only') + 1].split(',')
        args = [a for a in args if a != argv[argv.index('--only') + 1]]
    jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 4
    if '--jobs' in argv:
        args = [a for a in args if a != argv[argv.index('--jobs') + 1]]
    return build(os.path.abspath(os.path.expanduser(args[0])), only, '--no-png' not in argv, '--no-wb' not in argv, jobs)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
