"""Graphviz：DOT 注入品牌默认属性 → WASM 渲染 → SVG 后处理（字号还原、字体栈、去 DOCTYPE、单位统一为 px）。

中文宽度：WASM 版 Graphviz 没有 PingFang 字体度量，按估算宽度排版，实测中文偏窄约 23%，标签会压到节点边。
做法：排版时所有 fontsize 乘 LAYOUT_SCALE（1.3），输出后 SVG 里的 font-size 除回去——节点与标签留出的空间按放大字号算，显示仍是原字号。
"""
import json
import os
import re
import subprocess
import tempfile

import svgkit as k

LAYOUT_SCALE = 1.3
HERE = k.HERE


def brand_defaults():
    P, F, T = k.PALETTE, k.FPX, k.TEXT
    fam = k.FONT_FAMILY.split(',')[0].strip()
    s = LAYOUT_SCALE
    return (f'graph [fontname="{fam}", fontsize={F["group_title"] * s:.1f}, fontcolor="{T["title"]}", bgcolor="white", pad="0.3", nodesep="0.45", ranksep="0.6"];\n'
            f'node [fontname="{fam}", fontsize={F["node_body"] * s:.1f}, shape=box, style="rounded,filled", fillcolor="{P["purple"]["fill"]}", color="{P["purple"]["stroke"]}", '
            f'fontcolor="{T["title"]}", penwidth=1.8, margin="0.22,0.1"];\n'
            f'edge [fontname="{fam}", fontsize={F["edge_label"] * s:.1f}, color="{P["gray"]["stroke"]}", fontcolor="{T["body"]}", penwidth=1.6, arrowsize=0.8];\n')


CLUSTER_RE = re.compile(r'(subgraph\s+"?cluster[\w-]*"?\s*\{)')
FONTSIZE_RE = re.compile(r'(fontsize\s*=\s*)"?([\d.]+)"?')


def prepare(dot):
    """注入品牌默认属性（用户自己写的属性在后面，优先级更高）；用户的 fontsize 同样按 LAYOUT_SCALE 放大。"""
    body = FONTSIZE_RE.sub(lambda m: f'{m.group(1)}{float(m.group(2)) * LAYOUT_SCALE:.1f}', dot)
    m = re.search(r'^\s*(strict\s+)?(di)?graph\b[^{]*\{', body, re.M | re.I)
    if not m:
        raise ValueError('不是合法的 DOT：找不到 graph / digraph 开头')
    cl = (f'style="rounded,filled"; fillcolor="{k.FIG["group"]["fill"]}"; color="{k.FIG["group"]["stroke"]}"; penwidth=1.5; '
          f'labeljust="l"; fontsize={k.FPX["group_title"] * LAYOUT_SCALE:.1f};')
    body = body[:m.end()] + '\n' + brand_defaults() + body[m.end():]
    body = CLUSTER_RE.sub(lambda mm: mm.group(1) + ' ' + cl, body)
    return body


def postprocess(svg):
    svg = re.sub(r'<\?xml[^>]*\?>\s*', '', svg)
    svg = re.sub(r'<!DOCTYPE[^>]*>\s*', '', svg, flags=re.S)
    svg = re.sub(r'<!--.*?-->\s*', '', svg, flags=re.S)
    svg = re.sub(r'font-size="([\d.]+)"', lambda m: f'font-size="{float(m.group(1)) / LAYOUT_SCALE:.2f}"', svg)
    fam = k.FONT_FAMILY.split(',')[0].strip()
    svg = svg.replace(f'font-family="{fam}"', f'font-family="{k.esc(k.FONT_FAMILY)}"')
    m = re.search(r'viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"', svg)
    if m:
        w, h = float(m.group(3)), float(m.group(4))
        svg = re.sub(r'<svg width="[^"]*" height="[^"]*"', f'<svg width="{w:g}" height="{h:g}"', svg, count=1)
    return svg


def render(dot_path, svg_path):
    """返回 {"ok": bool, "error": str|None, "graphviz": 版本}。"""
    with open(dot_path, encoding='utf-8') as f:
        dot = f.read()
    try:
        prepared = prepare(dot)
    except ValueError as e:
        return {'ok': False, 'error': str(e)}
    with tempfile.TemporaryDirectory() as td:
        pin, pout = os.path.join(td, 'in.dot'), os.path.join(td, 'out.svg')
        open(pin, 'w', encoding='utf-8').write(prepared)
        r = subprocess.run(['node', os.path.join(HERE, 'graphviz.mjs'), pin, pout], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            err = r.stderr.strip()
            try:
                err = json.loads(err.splitlines()[-1])['error']
            except Exception:
                pass
            return {'ok': False, 'error': err}
        svg = postprocess(open(pout, encoding='utf-8').read())
    with open(svg_path, 'w', encoding='utf-8') as f:
        f.write(svg)
    info = json.loads(r.stdout.strip().splitlines()[-1])
    return {'ok': True, 'error': None, 'graphviz': info.get('graphviz')}
