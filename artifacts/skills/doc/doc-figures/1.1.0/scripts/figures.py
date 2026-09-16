#!/usr/bin/env python3
"""单张 svgkit 图。
用法：
  figures.py <spec.fig.json> <out.svg> [--png]            spec 里 "template" 选模板
  figures.py <模板名> <spec.json> <out.svg> [--png]         兼容旧用法（旧 figures.py 的 funnel / phases / sitemap 三个模板）
输出前自检（越界、重叠、字号不足等）有问题时打印并以退出码 1 结束；SVG 仍会写出便于查看。"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from templates import get, template_name, NAMES  # noqa: E402


def main(argv):
    args = [a for a in argv if a != '--png']
    if len(args) == 3 and args[0] in NAMES:
        name, spec_path, out = args
        spec = json.load(open(spec_path, encoding='utf-8'))
    elif len(args) == 2:
        spec_path, out = args
        spec = json.load(open(spec_path, encoding='utf-8'))
        name = template_name(spec)
    else:
        print(__doc__)
        return 2
    canvas = get(name).render(spec)
    canvas.save(out)
    print(out)
    issues = canvas.check()
    for it in issues:
        print(f'  [{it["severity"]}] {it["rule"]}: {it["message"]}')
    if '--png' in argv:
        here = os.path.dirname(os.path.abspath(__file__))
        png = os.path.splitext(out)[0] + '.png'
        job = out + '.job.json'
        json.dump({'mermaid_js': '', 'tasks': [{'kind': 'screenshot', 'id': 'x', 'svg_path': os.path.abspath(out), 'png_path': os.path.abspath(png), 'scale': 2}]}, open(job, 'w'))
        subprocess.run(['node', os.path.join(here, 'chrome.mjs'), job, job + '.res'], capture_output=True)
        for f in (job, job + '.res'):
            if os.path.exists(f):
                os.remove(f)
        print(png)
    return 1 if issues else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
