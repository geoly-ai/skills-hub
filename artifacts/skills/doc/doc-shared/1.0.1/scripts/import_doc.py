#!/usr/bin/env python3
"""把已有文档导入为正文底稿（revision / import 模式的起点，任何类型通用）。
来源：飞书文档（URL 或 token，经 lark-cli 读取）、lark-cli fetch 的 JSON、飞书 XML 文件、PDF。
产出：<运行目录>/base/<--name，默认 base-doc.md> 与 base/base-summary.json（章节、表格数、顶部版本号，及 --count 追加的计数）。
用法：import_doc.py <来源> <运行目录> [--profile account1|account2] [--name base-doc.md] [--count 名称=正则]...
导入稿只作参考底稿：类型包声明由脚本生成的片段（数据块、生成章节）仍须重新生成。
来源与改动记录见 doc-shared/SKILL.md「脚本来源」。"""
import argparse, glob, json, os, re, subprocess, sys
from html.parser import HTMLParser


class X2MD(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.buf, self.stack = [], [], []
        self.table = None; self.row = None; self.cell = None; self.list_kind = []; self.title = ''

    def flush(self, prefix=''):
        t = ''.join(self.buf).strip(); self.buf = []
        if t: self.out.append(prefix + t)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title', 'li', 'callout') and self.cell is None: self.flush()
        if tag == 'table': self.table = []
        elif tag == 'tr': self.row = []
        elif tag in ('td', 'th'): self.cell = []
        elif tag in ('ul', 'ol'): self.list_kind.append(tag)
        elif tag in ('b', 'strong'): (self.cell if self.cell is not None else self.buf).append('**')
        elif tag == 'br': (self.cell if self.cell is not None else self.buf).append(' ')
        elif tag == 'whiteboard': self.out.append('[原文画板：需用 doc-figures 重画]')
        elif tag == 'img': self.out.append(f"[原文图片：{a.get('caption') or a.get('name') or '无图注'}]")
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag: self.stack.pop()
        if tag in ('b', 'strong'): (self.cell if self.cell is not None else self.buf).append('**')
        elif tag == 'title': self.title = ''.join(self.buf).strip(); self.flush('# ')
        elif re.match(r'h[1-6]$', tag) and self.cell is None:
            lv = int(tag[1]); self.flush('#' * min(lv + 1, 4) + ' ')
        elif tag == 'li' and self.cell is None: self.flush('- ' if (self.list_kind and self.list_kind[-1] == 'ul') else '1. ')
        elif tag in ('ul', 'ol') and self.list_kind: self.list_kind.pop()
        elif tag in ('p', 'callout') and self.cell is None: self.flush()
        elif tag in ('td', 'th') and self.cell is not None:
            self.row.append(re.sub(r'\s+', ' ', ''.join(self.cell)).strip().replace('|', '/')); self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.table.append(self.row); self.row = None
        elif tag == 'table' and self.table is not None:
            rows = [r for r in self.table if any(c for c in r)]
            if rows:
                n = max(len(r) for r in rows); rows = [r + [''] * (n - len(r)) for r in rows]
                block = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * n] + ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
                self.out.append('\n'.join(block))
            self.table = None

    def handle_data(self, d):
        (self.cell if self.cell is not None else self.buf).append(d)


def lark_env(profile):
    env = dict(os.environ)
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'): env.pop(k, None)
    nvm = sorted(glob.glob(os.path.expanduser('~/.nvm/versions/node/v*/bin')), key=lambda x: [int(n) for n in re.findall(r'\d+', x)])
    if nvm: env['PATH'] = nvm[-1] + ':' + env['PATH']
    if profile == 'account2': env['LARKSUITE_CLI_CONFIG_DIR'] = os.path.expanduser('~/.lark-cli-account2')
    else: env.pop('LARKSUITE_CLI_CONFIG_DIR', None)
    return env


def lark_fetch(src, profile):
    r = subprocess.run(['lark-cli', 'docs', '+fetch', '--as', 'user', '--doc', src, '--format', 'json'], capture_output=True, text=True, env=lark_env(profile))
    d = json.loads(r.stdout or '{}')
    if not d.get('ok'): raise SystemExit('飞书读取失败：' + json.dumps(d.get('error'), ensure_ascii=False)[:300])
    return d['data']['document'].get('content', '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('root'); ap.add_argument('--profile', default='account1')
    ap.add_argument('--name', default='base-doc.md')
    ap.add_argument('--count', action='append', default=[], help='名称=正则，统计底稿中匹配的去重片段，写入 base-summary.json 的 counts')
    a = ap.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+\.md', a.name): raise SystemExit('--name 只能是文件名，如 base-doc.md')
    counts_spec = []
    for c in a.count:
        if '=' not in c: raise SystemExit(f'--count 格式为 名称=正则：{c}')
        name, pat = c.split('=', 1)
        try: counts_spec.append((name, re.compile(pat)))
        except re.error as ex: raise SystemExit(f'--count 正则无效：{c}（{ex}）')
    base = os.path.join(a.root, 'base'); os.makedirs(base, exist_ok=True)
    src = a.src
    if src.lower().endswith(('.md', '.markdown')):
        if not os.path.isfile(src): raise SystemExit(f'本地 markdown 不存在：{src}')
        md = open(src, encoding='utf-8').read().rstrip('\n')
        kind = 'markdown'
    elif src.lower().endswith('.pdf'):
        subprocess.run(['pdftotext', '-layout', src, os.path.join(base, 'base.txt')], check=True)
        text = open(os.path.join(base, 'base.txt')).read()
        md = '\n\n'.join(p.strip() for p in re.split(r'\n\s*\n', text) if p.strip())
        kind = 'pdf（仅文本，表格结构需人工整理）'
    else:
        if src.endswith('.json'): content = json.load(open(src))['data']['document']['content']
        elif src.endswith('.xml'): content = open(src).read()
        else: content = lark_fetch(src, a.profile)
        open(os.path.join(base, 'base.xml'), 'w').write(content)
        p = X2MD(); p.feed(content); p.flush()
        md = '\n\n'.join(p.out)
        kind = 'feishu'
    if kind != 'markdown': md = md.replace('`', '')   # 飞书与 PDF 底稿去掉行内 code 标记；本地 markdown 保留原文（含代码块）
    open(os.path.join(base, a.name), 'w').write(md + '\n')
    heads = re.findall(r'(?m)^(#{1,4}) (.+)$', md)
    ver = re.findall(r'v(\d+\.\d+)', md[:3000])
    summary = {'source': src, 'kind': kind, 'out': f'base/{a.name}', 'headings': [f"{h[0]} {h[1]}" for h in heads], 'tables': md.count('\n|---'),
               'versions_near_top': sorted(set(ver)),
               'counts': {name: sorted(set(m.group(0) for m in pat.finditer(md)))[:100] for name, pat in counts_spec},
               'note': '导入稿仅作底稿；由脚本生成的片段须重新生成'}
    json.dump(summary, open(os.path.join(base, 'base-summary.json'), 'w'), ensure_ascii=False, indent=2)
    print(json.dumps({'ok': True, 'kind': kind, 'headings': len(heads), 'tables': summary['tables'], 'counts': {k: len(v) for k, v in summary['counts'].items()}, 'out': f'base/{a.name}'}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
