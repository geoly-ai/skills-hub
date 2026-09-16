"""HTML 后端（PDF 由 pdf.py 打印本后端的 HTML）。
CSS = brand/generated/tokens.css 原文 + 本文件 ENGINE_CSS（只引用 var(--dm-*)，不写色值与字号数值）。
markers=True 时在标题、图、表、重点高亮处插入绝对定位的定位标记（不参与排版流），供 pdftotext -bbox 定位页码。"""
import os, re
from common import NOWRAP_CODE_MAX, RE_CODE_CELL, wbr_html, esc, esc_attr, fill, heading_label, heading_text, tilde, table_widths, is_dense, reviewer_text, STATUS_CN, image_data_uri

ENGINE_CSS = r'''
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:var(--dm-font-body);color:var(--dm-color-ink);font-size:var(--dm-size-body);line-height:var(--dm-line-height-body);orphans:2;widows:2}
@page dm-landscape{size:A4 landscape}
.dm-landscape{page:dm-landscape}
.dm-mk{position:absolute;left:0;top:0;font-size:4px;line-height:1;color:var(--dm-color-white);white-space:nowrap;pointer-events:none}
a{color:var(--dm-color-primary-dark);text-decoration:none}
p{margin:0 0 var(--dm-space-para)}
ul,ol{margin:0 0 var(--dm-space-para);padding-left:6mm}
li>ul,li>ol{margin:0;padding-left:6mm}
b{font-weight:600}
mark.dm-hl{position:relative;background:var(--dm-color-tint);color:inherit;padding:0 .15em;border-radius:.6mm;-webkit-box-decoration-break:clone;box-decoration-break:clone}
/* 颜色变体：底色与描边都取 tokens callout 表（--dm-callout-*），不另发明色值；无前缀的 dm-hl 保持原样 */
mark.dm-hl-risk{background:var(--dm-callout-risk-bg);box-shadow:inset 0 0 0 .2mm var(--dm-callout-risk-border)}
mark.dm-hl-tip{background:var(--dm-callout-tip-bg);box-shadow:inset 0 0 0 .2mm var(--dm-callout-tip-border)}
mark.dm-hl-warn{background:var(--dm-callout-warn-bg);box-shadow:inset 0 0 0 .2mm var(--dm-callout-warn-border)}
mark.dm-hl-decision{background:var(--dm-callout-decision-bg);box-shadow:inset 0 0 0 .2mm var(--dm-callout-decision-border)}
.dm-ref-missing{color:var(--dm-color-danger);font-weight:600}
sup.dm-fnref{font-size:70%;line-height:0}
/* 封面 */
.dm-cover{box-sizing:border-box;height:258mm;overflow:hidden;break-after:page;page-break-after:always;display:flex;flex-direction:column;position:relative}
.dm-cover-title{font-size:var(--dm-size-cover-title);font-weight:700;line-height:1.35;text-wrap:balance;margin:0 0 6mm}
.dm-cover-subtitle{font-size:var(--dm-size-cover-subtitle);color:var(--dm-color-primary-dark);margin:0 0 5mm;text-wrap:balance}
.dm-cover-meta{font-size:var(--dm-size-cover-meta);color:var(--dm-color-ink-2);line-height:2}
.dm-cover-foot{font-size:var(--dm-size-cover-meta);color:var(--dm-color-ink-2)}
.dm-cover-marketing{justify-content:space-between;padding:16mm 14mm;background:linear-gradient(160deg,var(--dm-color-cover-tint) 0%,var(--dm-color-white) 55%)}
.dm-cover-marketing .dm-cover-logo img{height:14mm;width:auto;display:block}
.dm-cover-badge{display:inline-block;margin-top:4mm;padding:1.5mm 4mm;border-radius:6mm;background:var(--dm-color-primary);color:var(--dm-color-white);font-size:var(--dm-size-body)}
.dm-cover-technical{border-top:2.5mm solid var(--dm-color-primary);padding-top:6mm}
.dm-cover-top{display:flex;justify-content:space-between;align-items:center}
.dm-cover-top img{height:9mm;width:auto;display:block}
.dm-cover-class{font-size:var(--dm-size-caption);color:var(--dm-color-danger);border:1px solid var(--dm-color-danger);padding:.4mm 2.5mm;border-radius:1mm}
.dm-cover-block{margin-top:46mm}
.dm-cover-type{font-size:var(--dm-size-cover-subtitle);color:var(--dm-color-primary);font-weight:600;margin:0 0 4mm}
.dm-cover-technical .dm-cover-title{margin-bottom:4mm}
.dm-cover-technical .dm-cover-subtitle{color:var(--dm-color-muted)}
.dm-cover-rule{width:28mm;height:0;border-top:1.2mm solid var(--dm-color-primary);margin:0 0 8mm}
.dm-control{margin-top:auto;width:100%;border-collapse:collapse;table-layout:fixed;font-size:var(--dm-size-table);line-height:var(--dm-line-height-table)}
.dm-control thead th{text-align:left;font-size:var(--dm-size-caption);color:var(--dm-color-muted);font-weight:600;border-bottom:1.5px solid var(--dm-color-primary);padding:1.2mm 2mm}
.dm-control tbody th{text-align:left;color:var(--dm-color-muted);font-weight:500;background:var(--dm-color-surface-2)}
.dm-control tbody th,.dm-control tbody td{border-bottom:1px solid var(--dm-color-border);padding:var(--dm-space-cell-y) var(--dm-space-cell-x);vertical-align:top}
.dm-cover-technical .dm-cover-foot{margin-top:6mm;font-size:var(--dm-size-caption);color:var(--dm-color-muted);display:flex;justify-content:space-between}
/* 前置页 */
.dm-front{break-after:page;page-break-after:always}
.dm-front-title{position:relative;font-size:var(--dm-size-h1);font-weight:700;border-bottom:2px solid var(--dm-color-primary);padding-bottom:2mm;margin:0 0 5mm}
.dm-toc-item a{display:flex;align-items:baseline;color:inherit}
.dm-toc-item{break-inside:avoid}
.dm-toc-l1{font-weight:600;margin-top:2.4mm}
.dm-toc-l2{padding-left:9mm;color:var(--dm-color-ink-2);margin-top:.6mm;font-size:var(--dm-size-table)}
.dm-toc-num{min-width:9mm;flex:none;padding-right:2mm;box-sizing:border-box}
.dm-toc-l2 .dm-toc-num{min-width:11mm}
.dm-toc-title{flex:none;max-width:140mm}
.dm-toc-dots{flex:1 1 auto;border-bottom:1px dotted var(--dm-color-subtle);margin:0 2mm;min-width:8mm;position:relative;top:-1mm}
.dm-toc-page{flex:none;min-width:7mm;text-align:right;font-variant-numeric:tabular-nums}
/* 正文 */
.dm-body h1,.dm-body h2,.dm-body h3,.dm-body h4{position:relative;break-after:avoid;page-break-after:avoid;text-wrap:balance}
.dm-num{margin-right:.55em}
h1.dm-h1{font-size:var(--dm-size-h1);border-bottom:2px solid var(--dm-color-primary);padding-bottom:2mm;margin:9mm 0 4mm}
h1.dm-newpage{break-before:page;page-break-before:always;margin-top:0}
h2.dm-h2{font-size:var(--dm-size-h2);color:var(--dm-color-primary-dark);margin:6mm 0 3mm}
h3.dm-h3{font-size:var(--dm-size-h3);margin:4mm 0 2mm}
h4.dm-h4{font-size:var(--dm-size-body);margin:3mm 0 1.5mm}
.dm-table-wrap{margin:2mm 0 var(--dm-space-table);position:relative}
.dm-table-wrap.dm-short{break-inside:avoid;page-break-inside:avoid}
.dm-caption{font-size:var(--dm-size-caption);color:var(--dm-color-ink-2);margin:0 0 1.5mm;break-after:avoid;page-break-after:avoid}
.dm-cap-num{font-weight:600;margin-right:.6em;color:var(--dm-color-primary-dark)}
table.dm-table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:var(--dm-size-table);line-height:var(--dm-line-height-table)}
table.dm-dense{font-size:var(--dm-size-table-dense)}
.dm-table thead{display:table-header-group}
.dm-table.dm-no-repeat thead{display:table-row-group}
.dm-table tr{break-inside:avoid;page-break-inside:avoid}
.dm-table th{background:var(--dm-color-surface);text-align:left;font-weight:600}
.dm-table th,.dm-table td{border:1px solid var(--dm-color-border);padding:var(--dm-space-cell-y) var(--dm-space-cell-x);vertical-align:top;word-break:normal;overflow-wrap:break-word}
.dm-table td.dm-nowrap{white-space:nowrap;overflow-wrap:normal}
.dm-table tr.dm-group td{background:var(--dm-color-tint);font-weight:600;color:var(--dm-color-primary-dark)}
figure.dm-figure{margin:4mm auto var(--dm-space-figure);break-inside:avoid;page-break-inside:avoid;text-align:center;position:relative}
figure.dm-figure svg{width:100%;height:auto;max-height:230mm;display:block;margin:0 auto}
.dm-landscape figure.dm-figure svg{max-height:150mm}
figure.dm-figure img{max-width:100%;max-height:155mm;border:1px solid var(--dm-color-border);border-radius:2mm}
figure.dm-figure figcaption{font-size:var(--dm-size-caption);color:var(--dm-color-muted);margin-top:2mm;text-wrap:balance}
.dm-grid{display:grid;gap:4mm;margin:4mm 0 6mm}
.dm-grid figure.dm-figure{margin:0;width:auto !important}
.dm-fig-missing{border:1px dashed var(--dm-color-danger);color:var(--dm-color-danger);padding:12mm 4mm;font-size:var(--dm-size-caption)}
.dm-callout{padding:3mm 4mm;margin:3mm 0 5mm;border-radius:var(--dm-space-callout-radius);border-left:4px solid;break-inside:avoid;page-break-inside:avoid}
.dm-callout>:last-child{margin-bottom:0}
.dm-callout-note{background:var(--dm-callout-note-bg);border-color:var(--dm-callout-note-border)}
.dm-callout-warn{background:var(--dm-callout-warn-bg);border-color:var(--dm-callout-warn-border)}
.dm-callout-tip{background:var(--dm-callout-tip-bg);border-color:var(--dm-callout-tip-border)}
.dm-callout-decision{background:var(--dm-callout-decision-bg);border-color:var(--dm-callout-decision-border)}
.dm-callout-risk{background:var(--dm-callout-risk-bg);border-color:var(--dm-callout-risk-border)}
.dm-code{position:relative;margin:2mm 0 5mm;background:var(--dm-color-surface);border-radius:var(--dm-space-callout-radius);break-inside:avoid;page-break-inside:avoid}
.dm-code.dm-code-long{break-inside:auto;page-break-inside:auto}
.dm-code-lang{position:absolute;right:2.5mm;top:1.2mm;font-size:var(--dm-size-header-footer);color:var(--dm-color-muted);font-family:var(--dm-font-latin);text-transform:uppercase;letter-spacing:.3pt}
.dm-code pre{margin:0;padding:3.5mm 4mm 3mm;font-family:var(--dm-font-mono);font-size:var(--dm-size-code);line-height:var(--dm-line-height-code);white-space:pre-wrap;overflow-wrap:anywhere}
.dm-footnotes{border-top:1px solid var(--dm-color-border);margin:4mm 0 5mm;padding-top:2mm;font-size:var(--dm-size-footnote);color:var(--dm-color-ink-2)}
.dm-footnotes ol{padding-left:5mm;margin:0}
.dm-pb{position:relative;break-after:page;page-break-after:always}
.dm-mk-flow{position:absolute;font-size:4px;line-height:1;color:var(--dm-color-white);white-space:nowrap;pointer-events:none}
.dm-disclaimer{margin-top:10mm;font-size:var(--dm-size-footnote);color:var(--dm-color-subtle);border-top:1px solid var(--dm-color-border);padding-top:2mm}
.dm-error{border:1px dashed var(--dm-color-danger);color:var(--dm-color-danger);padding:3mm;font-size:var(--dm-size-caption);margin:2mm 0 4mm}
'''


def hl_class(n):
    """高亮 mark 的 class：无前缀（neutral）保持原来的单个 dm-hl，其余按 kind 追加颜色变体。"""
    k = n.get('kind', 'neutral')
    return 'dm-hl' if k == 'neutral' else f'dm-hl dm-hl-{k}'


class HtmlBuilder:
    def __init__(self, ctx, markers=False, toc_pages=None, breaks=None):
        self.c = ctx; self.doc = ctx.doc; self.markers = markers; self.toc_pages = toc_pages or {}
        self.breaks = breaks
        self.in_table = False
        self.hl_seq = 0
        self.pb_seq = 0
        self.anchor_emitted = set()
        self.in_toc = False
        self.highlights = []   # [{key, line, length, text}] 按 HTML 生成顺序
        self.fn_emitted = set()
        self.cur_line = 0

    # ---------- 行内
    def mk(self, key):
        return f'<span class="dm-mk">QQ{key}QQ</span>' if self.markers else ''

    def text(self, s):
        s = tilde(self.c, s)
        h = wbr_html(esc, s) if self.in_table else esc(s)
        return re.sub(r'\r?\n', '<br/>', h)

    def inline(self, nodes, line=None):
        out = []
        for n in nodes:
            t = n['t']
            if t == 'text':
                out.append(self.text(n['v']))
            elif t == 'bold':
                out.append('<b>' + self.inline(n['c'], line) + '</b>')
            elif t == 'highlight' and self.in_toc:   # 目录条目是标题的副本：高亮不计数、不加定位标记
                out.append(f'<mark class="{hl_class(n)}"><b>' + self.inline(n['c'], line) + '</b></mark>')
            elif t == 'highlight':
                self.hl_seq += 1
                key = f'g{self.hl_seq}'
                from docmark_parse import inline_plain, char_count
                pt = inline_plain(n['c'])
                self.highlights.append({'key': key, 'line': line if line is not None else self.cur_line, 'length': char_count(pt), 'text': pt,
                                        'kind': n.get('kind', 'neutral')})
                out.append(f'<mark class="{hl_class(n)}">{self.mk(key)}<b>' + self.inline(n['c'], line) + '</b></mark>')
            elif t == 'anchor':   # 行内实体锚点：第一处发射 id，交叉引用据此跳转
                eid = self.c.anchor_elem.get(n['target'])
                if eid and eid.startswith('ent-') and eid not in self.anchor_emitted and not self.in_toc:
                    self.anchor_emitted.add(eid); out.append(f'<span id="{esc_attr(eid)}"></span>')
            elif t == 'link':
                url = n['url']
                inner = self.inline(n['c'], line) or esc(url)
                if re.match(r'^(https?:|mailto:)', url):
                    out.append(f'<a href="{esc_attr(url)}">{inner}</a>')
                elif url.startswith('#'):
                    out.append(f'<a href="{esc_attr(url)}">{inner}</a>')
                else:
                    out.append(f'<a href="{esc_attr("../" + url)}">{inner}</a>')
            elif t == 'ref':
                if not n.get('resolved'):
                    out.append(f'<span class="dm-ref-missing">@{esc(n["target"])}</span>')
                else:
                    eid = self.c.anchor_elem.get(n['target'])
                    lab = esc(n.get('label') or n['target'])
                    out.append(f'<a class="dm-ref" href="#{eid}">{lab}</a>' if eid else lab)
            elif t == 'fnref':
                num = self.c.fn_num.get(n['id'])
                out.append(f'<sup class="dm-fnref"><a href="#fn-{esc_attr(n["id"])}">{num}</a></sup>' if num else '')
        return ''.join(out)

    # ---------- 封面
    def cover(self):
        c = self.c
        logo = f'<img src="{c.logo_data_uri}" alt="{esc_attr(c.vals["brand"])}"/>' if c.logo_data_uri else f'<b>{esc(c.vals["brand"])}</b>'
        if c.cover == 'marketing':
            meta = []
            if c.party: meta.append(f'{esc(c.party_label)}：{esc(c.party)}')
            meta.append(f'版本：v{esc(c.version)}')
            meta.append(f'日期：{esc(c.date)}')
            meta += [self.inline(_inl(c, x)) for x in c.cover_meta]
            badge = f'<div class="dm-cover-badge">{esc(fill(c.cover_badge, c.vals))}</div>' if c.cover_badge else ''
            sub = f'<div class="dm-cover-subtitle">{self.text(c.subtitle)}</div>' if c.subtitle else ''
            return (f'<div class="dm-cover dm-cover-marketing"><div class="dm-cover-logo">{logo}</div>'
                    f'<div><div class="dm-cover-title">{balanced_title(c, c.title, c.content_mm - (28 if c.cover == 'marketing' else 0))}</div>{sub}<div class="dm-cover-meta">{"<br/>".join(meta)}</div>{badge}</div>'
                    f'<div class="dm-cover-foot">{esc(c.vals["website"])}</div></div>')
        cls = c.profile.get('classification')
        rows = []
        if c.meta.get('doc_no'): rows.append(('文档编号', esc(c.meta['doc_no'])))
        rows.append(('版本', 'v' + esc(c.version)))
        if c.status: rows.append(('状态', esc(STATUS_CN.get(c.status, c.status))))
        if c.owner: rows.append(('负责人', esc(c.owner)))
        if c.reviewers: rows.append(('评审人', '<br/>'.join(esc(reviewer_text(r)) for r in c.reviewers)))
        rows.append(('日期', esc(c.date)))
        if c.party and c.meta.get('client'): rows.append(('对象', esc(c.party)))
        if cls: rows.append(('密级', esc(cls)))
        table = ('<table class="dm-control"><colgroup><col style="width:32mm"/><col/></colgroup><thead><tr><th colspan="2">文档控制</th></tr></thead><tbody>'
                 + ''.join(f'<tr><th>{k}</th><td>{v}</td></tr>' for k, v in rows) + '</tbody></table>') if c.profile.get('doc_control_table', True) else ''
        sub = f'<div class="dm-cover-subtitle">{self.text(c.subtitle)}</div>' if c.subtitle else ''
        typ = f'<div class="dm-cover-type">{esc(c.type_name)}</div>' if c.type_name else ''
        badge = f'<span class="dm-cover-class">{esc(cls)}</span>' if cls else ''
        return (f'<div class="dm-cover dm-cover-technical"><div class="dm-cover-top">{logo}{badge}</div>'
                f'<div class="dm-cover-block">{typ}<div class="dm-cover-title">{balanced_title(c, c.title, c.content_mm - (28 if c.cover == 'marketing' else 0))}</div><div class="dm-cover-rule"></div>{sub}</div>'
                f'{table}<div class="dm-cover-foot"><span>{esc(c.vals["brand"])}</span><span>{esc(c.vals["website"])}</span></div></div>')

    # ---------- 前置页
    def revision_page(self):
        c = self.c
        if not c.profile.get('revision_page') or not c.revisions:
            return ''
        rows = ''.join(f'<tr><td>{esc(_v(r.get("version")))}</td><td>{esc(r.get("date", ""))}</td><td>{esc(r.get("author", ""))}</td><td>{self.text(r.get("summary", ""))}</td></tr>' for r in c.revisions)
        return (f'<section class="dm-front dm-revision"><div class="dm-front-title">{self.mk("r0")}修订记录</div><div class="dm-table-wrap">'
                '<table class="dm-table"><colgroup><col style="width:12%"/><col style="width:16%"/><col style="width:14%"/><col style="width:58%"/></colgroup>'
                f'<thead><tr><th>版本</th><th>日期</th><th>作者</th><th>变更摘要</th></tr></thead><tbody>{rows}</tbody></table></div></section>')

    def summary_page(self):
        if self.c.features.get('summary_block') is False:
            return ''
        blocks = [b for b in self.doc.blocks if b.get('in_summary') and b['kind'] not in ('summary',)]
        if not blocks:
            return ''
        return f'<section class="dm-front dm-summary"><div class="dm-front-title">{self.mk("s0")}摘要</div>' + ''.join(self.block(b) for b in blocks) + '</section>'

    def toc(self):
        c = self.c
        if not c.toc_headings:
            return ''
        items = []
        self.in_toc = True
        for i in c.toc_headings:
            h = self.doc.headings[i]
            pg = self.toc_pages.get(i)
            page = str(pg) if pg else '00'
            items.append(f'<div class="dm-toc-item dm-toc-l{h["level"]}"><a href="#{c.heading_ids[i]}"><span class="dm-toc-num">{esc(heading_label(h))}</span>'
                         f'<span class="dm-toc-title">{self.inline(h["inline"], h["line"])}</span><span class="dm-toc-dots"></span><span class="dm-toc-page">{page}</span></a></div>')
        self.in_toc = False
        return f'<nav class="dm-front dm-toc"><div class="dm-front-title">{self.mk("c0")}目录</div>' + ''.join(items) + '</nav>'

    # ---------- 块
    def block(self, b):
        k = b['kind']; self.cur_line = b['line']
        if k == 'p':
            return f'<p>{self.inline(b["inline"], b["line"])}</p>'
        if k in ('ul', 'ol'):
            return self.lst(b)
        if k in ('table', 'data'):
            return self.table(b)
        if k in ('figure', 'image'):
            return self.figure(b)
        if k == 'callout':
            inner = ''.join(f'<p>{self.inline(sb["inline"], sb["line"])}</p>' if sb['kind'] == 'p' else self.lst(sb) for sb in b['blocks'])
            return f'<div class="dm-callout dm-callout-{b["callout"]}">{inner}</div>'
        if k == 'code':
            long = b['text'].count('\n') + 1 > 45
            lang = f'<div class="dm-code-lang">{esc(b["lang"])}</div>' if b['lang'] else ''
            return f'<div class="dm-code{" dm-code-long" if long else ""}">{lang}<pre><code>{esc(b["text"])}</code></pre></div>'
        if k == 'pagebreak':   # 定位标记 p<n>：LY9 区分手工分页与自然章末
            self.pb_seq += 1
            return f'<div class="dm-pb">{self.mk("p" + str(self.pb_seq))}</div>'
        return ''

    def lst(self, b):
        items = b['items']; out = [f'<{b["kind"]}>']; i = 0
        while i < len(items):
            it = items[i]; j = i + 1; sub = []
            while j < len(items) and items[j]['level'] == 2:
                sub.append(items[j]); j += 1
            subhtml = ''
            if sub:
                sk = sub[0]['kind']
                subhtml = f'<{sk}>' + ''.join(f'<li>{self.inline(s["inline"], s["line"])}</li>' for s in sub) + f'</{sk}>'
            out.append(f'<li>{self.inline(it["inline"], it["line"])}{subhtml}</li>')
            i = j
        out.append(f'</{b["kind"]}>')
        return ''.join(out)

    def table(self, b):
        c = self.c
        if b.get('error'):
            return f'<div class="dm-error">数据块无法渲染：{esc(b.get("data_file") or "")}</div>'
        ti = c.tbl_index.get(id(b))
        eid = c.tbl_ids[ti] if ti is not None else ''
        widths, _ = table_widths(c, b)
        ncol = len(b['header'])
        cls = 'dm-table' + (' dm-dense' if is_dense(c, b) else '') + ('' if c.features.get('thead_repeat') is not False else ' dm-no-repeat')
        limit = c.landscape_mm if b.get('landscape') else c.content_mm
        cap = ''
        if b.get('number') or b.get('caption'):
            num = f'<span class="dm-cap-num">{esc(b["number"])}</span>' if b.get('number') else ''
            cap = f'<div class="dm-caption dm-tcaption">{num}{self.text(b.get("caption") or "")}</div>'
        self.in_table = True
        colgroup = '<colgroup>' + ''.join(f'<col style="width:{w:.2f}%"/>' for w in widths) + '</colgroup>'
        thead = '<thead><tr>' + ''.join(f'<th>{self.inline(x, b["line"])}</th>' for x in b['header_inline']) + '</tr></thead>'
        starts = {g['start']: g for g in (b.get('groups') or [])}
        rows = []
        for ri, r in enumerate(b['rows_inline']):
            rl = b['row_lines'][ri] if ri < len(b['row_lines']) else b['line']
            if ri in starts:
                g = starts[ri]
                rows.append(f'<tr class="dm-group"><td colspan="{ncol}">{self.text(g["value"] or "（空）")}（{g["count"]} 行）</td></tr>')
            rows.append('<tr>' + ''.join(self.td(b, ri, ci, x, rl) for ci, x in enumerate(r)) + '</tr>')
        self.in_table = False
        short = ' dm-short' if len(b['rows']) <= 8 else ''
        return (f'<div class="dm-table-wrap{short}" id="{eid}" data-dm-measure="{limit:g}">{self.mk("t" + str(ti))}{cap}'
                f'<table class="{cls}">{colgroup}{thead}<tbody>{"".join(rows)}</tbody></table></div>')

    def td(self, b, ri, ci, nodes, line):
        raw = b['rows'][ri][ci].strip() if ri < len(b['rows']) and ci < len(b['rows'][ri]) else ''
        nowrap = raw and len(raw) <= NOWRAP_CODE_MAX and RE_CODE_CELL.match(raw)
        return f'<td class="dm-nowrap">{self.inline(nodes, line)}</td>' if nowrap else f'<td>{self.inline(nodes, line)}</td>'

    def figure(self, b):
        c = self.c
        fi = c.fig_index.get(id(b)); info = c.fig_info[fi]; eid = c.fig_ids[fi]
        cap_num = f'<span class="dm-cap-num">{esc(b["number"])}</span>' if b.get('number') else ''
        cap = f'<figcaption>{cap_num}{self.inline(b["caption_inline"], b["line"])}</figcaption>' if (b.get('caption') or b.get('number')) else ''
        style = '' if b.get('grid') else f' style="width:{b["width_pct"]:g}%"'
        if b['kind'] == 'image':
            uri = info.get('data_uri')
            body = f'<img src="{uri}" alt="{esc_attr(b["caption"])}"/>' if uri else f'<div class="dm-fig-missing">图片不存在：{esc(b["src"])}</div>'
        elif info.get('markup'):
            body = info['markup']
        else:
            body = f'<div class="dm-fig-missing">图未构建：{esc(b.get("svg") or b["src"])}（先运行 doc-figures build）</div>'
        limit = info.get('limit_mm') or c.content_mm
        return f'<figure class="dm-figure" id="{eid}" data-dm-measure="{limit:g}"{style}>{self.mk("f" + str(fi))}{body}{cap}</figure>'

    def footnotes(self, chapter_ids):
        ids = [i for i in chapter_ids if i not in self.fn_emitted and i in self.c.fn_num]
        if not ids:
            return ''
        self.fn_emitted.update(ids)
        ids.sort(key=lambda i: self.c.fn_num[i])
        lis = ''.join(f'<li id="fn-{esc_attr(i)}" value="{self.c.fn_num[i]}">{self.inline(self.doc.footnotes[i]["inline"], self.doc.footnotes[i]["line"])}</li>' for i in ids)
        return f'<section class="dm-footnotes"><ol>{lis}</ol></section>'

    # ---------- 正文
    def body(self):
        c = self.c; doc = self.doc
        out = ['<main class="dm-body">']
        h1_lines = [h['line'] for h in doc.headings if h['level'] == 1]
        chapter_fn = {}
        for r in doc.footnote_refs:
            ch = sum(1 for ln in h1_lines if ln <= r['line'])
            chapter_fn.setdefault(ch, []).append(r['id'])
        chapter = 0; first_h1 = True
        grid_cols = None
        for b in doc.blocks:
            if b.get('in_summary') or b['kind'] == 'summary':
                continue
            k = b['kind']
            if k == 'heading':
                hi = b['heading']; h = doc.headings[hi]
                if h['level'] == 1:
                    out.append(self.footnotes(chapter_fn.get(chapter, [])))
                    chapter += 1
                    if self.markers:   # 定位标记 e<i>：上一章内容结束处，auto 分页据此判断（不受本标题是否换页影响）。
                        # 绝对定位且不设 top/left：印在静态位置、不占版面，不会像零高块那样在分页或命名页切换处多出一页
                        out.append(f'<span class="dm-mk-flow">QQe{hi}QQ</span>')
                lv = h['level']
                cls = f'dm-h{lv}'
                if lv == 1:
                    brk = (hi in self.breaks) if self.breaks is not None else (c.h1_mode == 'always')
                    if brk and not first_h1: cls += ' dm-newpage'
                    first_h1 = False
                lab = heading_label(h)
                num = f'<span class="dm-num">{esc(lab)}</span>' if lab else ''
                out.append(f'<h{lv} id="{c.heading_ids[hi]}" class="{cls}">{self.mk("h" + str(hi))}{num}{self.inline(h["inline"], h["line"])}</h{lv}>')
                continue
            if k == 'landscape':
                if c.features.get('landscape') is False: continue
                out.append('<section class="dm-landscape">' if b['edge'] == 'start' else '</section>')
                continue
            if k == 'grid':
                # 与飞书后端、旧渲染器一致：grid 只收图，结束标记处整体输出；grid 内的其他块按出现位置输出在 grid 之前
                if b['edge'] == 'start':
                    grid_cols = (b['cols'], [])
                elif grid_cols is not None:
                    out.append(f'<div class="dm-grid" style="grid-template-columns:repeat({grid_cols[0]},1fr)">' + ''.join(grid_cols[1]) + '</div>')
                    grid_cols = None
                continue
            if grid_cols is not None and k in ('figure', 'image') and b.get('grid'):
                grid_cols[1].append(self.block(b)); continue
            out.append(self.block(b))
        out.append(self.footnotes([i for ids in chapter_fn.values() for i in ids]))
        if c.profile.get('disclaimer'):
            out.append(f'<p class="dm-disclaimer">{esc(fill(c.profile["disclaimer"], c.vals))}</p>')
        out.append('</main>')
        return ''.join(out)

    def document(self, cover_only=False):
        c = self.c
        head = (f'<!doctype html><html lang="{esc_attr(c.meta.get("language") or "zh-CN")}"><head><meta charset="utf-8"><title>{esc(c.title)}</title>'
                f'<style>{c.tokens_css}\n{ENGINE_CSS}</style></head><body>')
        if cover_only:
            return head + self.cover() + '</body></html>'
        return head + self.cover() + self.revision_page() + self.summary_page() + self.toc() + self.body() + '</body></html>'


def balanced_title(ctx, text, width_mm=None, size_pt=None):
    """封面标题断行（layout.md §2）：放不下一行时，在词边界（空格后、全角括号前、中文标点后）里选两行最均衡的位置插入换行，
    避免 text-wrap: balance 在中文词中间断开或第二行只剩两三个字。找不到合适位置时交给 CSS balance。"""
    from common import text_units
    width_mm = width_mm or ctx.content_mm
    size_pt = size_pt or float(ctx.tokens['size']['cover_title'])
    cap = width_mm / (size_pt * 25.4 / 72) * 0.96
    total = text_units(text)
    if total <= cap:
        return esc(text)
    cands = set()
    for i, ch in enumerate(text):
        if ch == ' ' and 0 < i < len(text) - 1: cands.add(i + 1)
        if ch in '（(《「“' and i > 0: cands.add(i)
        if ch in '，、：；—·' and i < len(text) - 1: cands.add(i + 1)
    best = None
    for k in sorted(cands):
        a, b = text[:k].rstrip(), text[k:].lstrip()
        ua, ub = text_units(a), text_units(b)
        if ua > cap or ub > cap or min(ua, ub) < 3: continue
        score = max(ua, ub)
        if best is None or score < best[0]: best = (score, a, b)
    if not best:
        return esc(text)
    return esc(best[1]) + '<br/>' + esc(best[2])


def _v(v):
    s = str(v or '')
    return s if s.lower().startswith('v') else 'v' + s


def _inl(ctx, text):
    from docmark_parse import parse_inline, Diag
    return parse_inline(text, 0, Diag())


def build_html(ctx, markers=False, toc_pages=None, breaks=None):
    b = HtmlBuilder(ctx, markers=markers, toc_pages=toc_pages, breaks=breaks)
    return b.document(), b


def build_cover_html(ctx):
    return HtmlBuilder(ctx).document(cover_only=True)


def hf_template(ctx, spec):
    """页眉页脚模板（Chrome headerTemplate / footerTemplate）。spec：品牌档案 header 或 footer {left, right}。"""
    t = ctx.tokens
    vals = dict(ctx.vals)

    def cell(tpl):
        parts = re.split(r'(\{logo\}|\{page\}|\{pages\})', fill(tpl or '', vals))
        out = []
        for p in parts:
            if p == '{logo}':
                out.append(f'<img src="{ctx.logo_data_uri}" style="height:6mm;width:auto;vertical-align:middle"/>' if ctx.logo_data_uri else esc(vals['brand']))
            elif p == '{page}':
                out.append('<span class="pageNumber"></span>')
            elif p == '{pages}':
                out.append('<span class="totalPages"></span>')
            else:
                out.append(esc(p))
        return ''.join(out)
    font = ','.join(f"'{f}'" for f in t['font']['cjk'] + t['font']['latin']) + ',sans-serif'
    return (f'<div style="width:100%;box-sizing:border-box;padding:0 {t["space"]["page_margin_x"]}mm;display:flex;justify-content:space-between;'
            f'align-items:center;font-size:{t["size"]["header_footer"]}pt;color:{t["color"]["subtle"]};font-family:{font};'
            f'-webkit-print-color-adjust:exact"><span>{cell(spec.get("left"))}</span><span>{cell(spec.get("right"))}</span></div>')
