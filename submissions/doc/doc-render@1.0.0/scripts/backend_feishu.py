"""飞书 XML 后端（references/feishu.md 与 lark-doc XML 规范）。
不输出行内 code；callout 子块只放 p / ul / ol；表格一律 thead；.mmd 给 whiteboard type="mermaid" 源，其余图给 build 后的 SVG。"""
import html, os, re, shutil
from common import heading_label, tilde, table_widths, reviewer_text, STATUS_CN, fill, hl_callout_kind

FEISHU_WIDTH_PX = 820


def xesc(s):
    return html.escape(str(s), quote=False)


def xattr(s):
    return html.escape(str(s), quote=True)


class FeishuBuilder:
    def __init__(self, ctx):
        self.c = ctx; self.doc = ctx.doc
        self.stats = {'whiteboards': 0, 'whiteboards_mermaid': 0, 'images': 0, 'code_blocks': 0}
        fm = ctx.feishu_map
        self.callouts = fm.get('callouts', {})
        self.th_bg = fm.get('table_header_bg') or ctx.tokens['feishu'].get('table_header_bg', 'light-gray')
        # 高亮底色复用 callout 映射（generated/feishu-callouts.json），不另定义一份

    def hl_bg(self, n):
        return (self.callouts.get(hl_callout_kind(n)) or {}).get('background-color', 'light-purple')

    def text(self, s):
        return re.sub(r'\r?\n', '<br/>', xesc(tilde(self.c, s)))

    def inline(self, nodes):
        out = []
        for n in nodes:
            t = n['t']
            if t == 'text': out.append(self.text(n['v']))
            elif t == 'bold': out.append('<b>' + self.inline(n['c']) + '</b>')
            elif t == 'highlight': out.append(f'<b><span background-color="{self.hl_bg(n)}">' + self.inline(n['c']) + '</span></b>')
            elif t == 'link':
                inner = self.inline(n['c']) or xesc(n['url'])
                out.append(f'<a href="{xattr(n["url"])}">{inner}</a>' if re.match(r'^https?://', n['url']) else inner)
            elif t == 'ref': out.append(xesc(n.get('label') or '@' + n['target']) if n.get('resolved') else xesc('@' + n['target']))
            elif t == 'fnref':
                num = self.c.fn_num.get(n['id'])
                if num: out.append(f'[{num}]')
        return ''.join(out)

    def p(self, inner, align=None):
        return f'<p align="{align}">{inner}</p>' if align else f'<p>{inner}</p>'

    def lst(self, b):
        items = b['items']; out = [f'<{b["kind"]}>']; i = 0
        while i < len(items):
            it = items[i]; j = i + 1; sub = []
            while j < len(items) and items[j]['level'] == 2:
                sub.append(items[j]); j += 1
            subx = ''
            if sub:
                sk = sub[0]['kind']
                subx = f'<{sk}>' + ''.join(f'<li>{self.inline(s["inline"])}</li>' for s in sub) + f'</{sk}>'
            out.append(f'<li>{self.inline(it["inline"])}{subx}</li>')
            i = j
        out.append(f'</{b["kind"]}>')
        return ''.join(out)

    def colgroup(self, b):
        from common import feishu_col_widths
        ws = feishu_col_widths(self.c, b, FEISHU_WIDTH_PX)
        return '<colgroup>' + ''.join(f'<col width="{w}"/>' for w in ws) + '</colgroup>'

    def table(self, b):
        if b.get('error'):
            return ''
        out = []
        if b.get('number') or b.get('caption'):
            out.append(self.p(xesc(' '.join(x for x in (b.get('number'), tilde(self.c, b.get('caption') or '')) if x))))
        ncol = len(b['header'])
        starts = {g['start']: g for g in (b.get('groups') or [])}
        rows = []
        for ri, r in enumerate(b['rows_inline']):
            if ri in starts:
                g = starts[ri]
                rows.append(f'<tr><td colspan="{ncol}" background-color="{self.th_bg}"><p><b>{self.text(g["value"] or "（空）")}</b>（{g["count"]} 行）</p></td></tr>')
            rows.append('<tr>' + ''.join(f'<td><p>{self.inline(x)}</p></td>' for x in r) + '</tr>')
        out.append('<table>' + self.colgroup(b) + '<thead><tr>' + ''.join(f'<th background-color="{self.th_bg}"><p>{self.inline(x)}</p></th>' for x in b['header_inline'])
                   + '</tr></thead><tbody>' + ''.join(rows) + '</tbody></table>')
        return '\n'.join(out)

    def caption_text(self, b):
        return ' '.join(x for x in (b.get('number'), self.inline(b['caption_inline'])) if x)

    def media(self, b):
        from common import dp
        rd = self.c.run_dir   # 二次校验：图文件（含 build 后的 .svg、.png）经符号链接越出运行目录时不写 path，避免发布端上传外部文件
        if not dp.path_safe(b['src']) or any(os.path.lexists(os.path.join(rd, f)) and not dp.within(rd, os.path.join(rd, f)) for f in dp.figure_files(b['src'])):
            return self.p(xesc(f'图文件越出运行目录，已拒绝：{b["src"]}'))
        if b['kind'] == 'image':
            self.stats['images'] += 1
            return f'<img path="@./{xattr(b["src"])}" caption="{xattr(" ".join(x for x in (b.get("number"), b.get("caption")) if x))}"/>'
        if b['engine'] == 'mermaid':
            self.stats['whiteboards'] += 1; self.stats['whiteboards_mermaid'] += 1
            wb = f'<whiteboard type="mermaid" path="@./{xattr(b["src"])}"></whiteboard>'
        else:
            self.stats['whiteboards'] += 1
            wb = f'<whiteboard type="svg" path="@./{xattr(b.get("svg") or b["src"])}"></whiteboard>'
        cap = self.caption_text(b)
        return wb + (self.p(cap, 'center') if cap else '')

    def callout_x(self, kind, blocks_x):
        m = self.callouts.get(kind) or self.callouts.get('note') or {}
        return f'<callout emoji="{m.get("emoji", "💡")}" background-color="{m.get("background-color", "light-purple")}" border-color="{m.get("border-color", "purple")}">{"".join(blocks_x)}</callout>'

    def block(self, b):
        k = b['kind']
        if k == 'p': return self.p(self.inline(b['inline']))
        if k in ('ul', 'ol'): return self.lst(b)
        if k in ('table', 'data'): return self.table(b)
        if k in ('figure', 'image'): return self.media(b)
        if k == 'callout':
            return self.callout_x(b['callout'], [self.p(self.inline(sb['inline'])) if sb['kind'] == 'p' else self.lst(sb) for sb in b['blocks']])
        if k == 'code':
            self.stats['code_blocks'] += 1
            code = html.escape(b['text'], quote=True).replace('\n', '<br/>')
            return f'<pre lang="{xattr(b["lang"] or "plaintext")}"><code>{code}</code></pre>'
        return ''

    def front(self):
        c = self.c; X = []
        if c.cover == 'marketing':
            if c.logo_data_uri:
                rel = os.path.join('out', 'brand', os.path.basename(c.logo_path))
                os.makedirs(os.path.join(c.run_dir, 'out', 'brand'), exist_ok=True)
                shutil.copy(c.logo_path, os.path.join(c.run_dir, rel))
                lw, lh = c.feishu_map.get('logo', {}).get('width', 360), c.feishu_map.get('logo', {}).get('height', 52)
                X.append(f'<img path="@./{rel}" width="{lw}" height="{lh}" align="center"/>')
                self.stats['images'] += 1
            if c.subtitle: X.append(self.p('<b>' + self.text(c.subtitle) + '</b>'))
            line = ' · '.join(x for x in (c.party, f'版本 v{c.version}', c.date, fill(c.cover_badge, c.vals) if c.cover_badge else '') if x)
            X.append(self.p(xesc(line)))
            from docmark_parse import parse_inline, Diag
            for mline in c.cover_meta: X.append(self.p(self.inline(parse_inline(mline, 0, Diag()))))
        else:
            if c.subtitle: X.append(self.p('<b>' + self.text(c.subtitle) + '</b>'))
            rows = []
            if c.meta.get('doc_no'): rows.append(('文档编号', c.meta['doc_no']))
            rows.append(('版本', 'v' + c.version))
            if c.status: rows.append(('状态', STATUS_CN.get(c.status, c.status)))
            if c.owner: rows.append(('负责人', c.owner))
            if c.reviewers: rows.append(('评审人', '；'.join(reviewer_text(r) for r in c.reviewers)))
            rows.append(('日期', c.date))
            if c.profile.get('classification'): rows.append(('密级', c.profile['classification']))
            X.append('<table><colgroup><col width="160"/><col width="660"/></colgroup><thead><tr>'
                     f'<th background-color="{self.th_bg}"><p>项</p></th><th background-color="{self.th_bg}"><p>内容</p></th></tr></thead><tbody>'
                     + ''.join(f'<tr><td><p>{xesc(k)}</p></td><td><p>{xesc(v)}</p></td></tr>' for k, v in rows) + '</tbody></table>')
            if c.profile.get('revision_page') and c.revisions:
                X.append(self.p('<b>修订记录</b>'))
                X.append('<table><colgroup><col width="100"/><col width="130"/><col width="110"/><col width="480"/></colgroup><thead><tr>'
                         + ''.join(f'<th background-color="{self.th_bg}"><p>{h}</p></th>' for h in ('版本', '日期', '作者', '变更摘要')) + '</tr></thead><tbody>'
                         + ''.join(f'<tr><td><p>{xesc(_v(r.get("version")))}</p></td><td><p>{xesc(r.get("date", ""))}</p></td><td><p>{xesc(r.get("author", ""))}</p></td><td><p>{self.text(r.get("summary", ""))}</p></td></tr>' for r in c.revisions)
                         + '</tbody></table>')
        return X

    def document(self):
        c = self.c; doc = self.doc
        X = [f'<title>{xesc(c.title)}</title>']
        X += self.front()
        # 摘要：文首高亮块，子块只能是 p / ul / ol，其余块放在高亮块之后
        if c.features.get('summary_block') is not False:
            sb = [b for b in doc.blocks if b.get('in_summary') and b['kind'] != 'summary']
            if sb:
                inside = [self.block(b) for b in sb if b['kind'] in ('p', 'ul', 'ol')]
                if inside: X.append(self.callout_x('note', inside))
                X += [self.block(b) for b in sb if b['kind'] not in ('p', 'ul', 'ol')]
        numbered = (c.doc.numbering.get('section') or 'decimal') != 'none'
        grid = None
        for b in doc.blocks:
            if b.get('in_summary') or b['kind'] == 'summary':
                continue
            k = b['kind']
            if k == 'heading':
                h = doc.headings[b['heading']]; lv = h['level']
                if h['appendix'] or not numbered:
                    lab = heading_label(h)
                    X.append(f'<h{lv}>{xesc(lab + " ") if lab and h["appendix"] else ""}{self.inline(h["inline"])}</h{lv}>')
                else:
                    X.append(f'<h{lv} seq="auto">{self.inline(h["inline"])}</h{lv}>')
                continue
            if k == 'grid':
                if b['edge'] == 'start': grid = {'cols': b['cols'], 'items': []}
                elif grid is not None:
                    X += self.grid_x(grid); grid = None
                continue
            if grid is not None and k in ('figure', 'image'):
                grid['items'].append(b); continue
            x = self.block(b)
            if x: X.append(x)
        if grid is not None: X += self.grid_x(grid)
        if c.fn_num:
            X.append(self.p('<b>注释</b>'))
            for fid, num in sorted(c.fn_num.items(), key=lambda kv: kv[1]):
                X.append(self.p(f'[{num}] ' + self.inline(doc.footnotes[fid]['inline'])))
        return '\n'.join(X)

    def grid_x(self, grid):
        out = []; n = grid['cols']; items = grid['items']
        for r0 in range(0, len(items), n):
            row = items[r0:r0 + n]
            ratios = [round(1 / len(row), 2)] * len(row); ratios[-1] = round(1 - sum(ratios[:-1]), 2)
            out.append('<grid>' + ''.join(f'<column width-ratio="{ratios[j]}">{self.media(it)}</column>' for j, it in enumerate(row)) + '</grid>')
        return out


def _v(v):
    s = str(v or '')
    return s if s.lower().startswith('v') else 'v' + s


def build_feishu(ctx):
    b = FeishuBuilder(ctx)
    return b.document(), b.stats
