"""PDF 管线：定位遍（带标记）回填目录页码 → 终遍（无标记，带页眉页脚与 Chrome 书签）→ 封面单独打印 → pypdf 替换封面页并重建书签、写元数据 → 版式检查。
需要 doc-render/.venv 里的 pypdf；pdftotext、pdftoppm 来自 poppler。"""
import html as htmlmod, json, logging, os, re, selectors, shutil, subprocess, time
logging.getLogger('pypdf').setLevel(logging.ERROR)
from common import HERE, RenderError, find_node, heading_text, now_iso, RENDERER_NAME, RENDERER_VERSION
import backend_html

PRINT_MJS = os.path.join(HERE, 'print_pdf.mjs')
MAX_PASSES = 3
H1_TOP_GAP_PT = 9 * 72 / 25.4   # 一级标题上边距 9 mm（ENGINE_CSS h1.dm-h1）：上一章结束处到标题顶的距离


class Printer:
    """print_pdf.mjs --stdio 的客户端：一个 Chrome 进程处理全部打印任务。"""

    def __init__(self, timeout=180):
        node = find_node()
        if not node:
            raise RenderError('找不到 node（PDF 打印需要 Node 18+）')
        self.timeout = timeout
        self.p = subprocess.Popen([node, PRINT_MJS, '--stdio'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.sel = selectors.DefaultSelector(); self.sel.register(self.p.stdout, selectors.EVENT_READ)
        ready = self._read()
        if not ready.get('ready'):
            self.close()
            raise RenderError('Chrome 启动失败：' + str(ready.get('error')))
        self.chrome = ready.get('chrome', '')
        self.n = 0

    def _read(self):
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            if self.sel.select(timeout=1):
                line = self.p.stdout.readline()
                if not line:
                    err = self.p.stderr.read() if self.p.poll() is not None else ''
                    raise RenderError('打印进程意外退出：' + err[-400:])
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        raise RenderError('打印超时')

    def print(self, **job):
        self.n += 1; job['id'] = self.n
        self.p.stdin.write(json.dumps(job, ensure_ascii=False) + '\n'); self.p.stdin.flush()
        r = self._read()
        if not r.get('ok'):
            raise RenderError('打印失败：' + str(r.get('error')))
        return r

    def close(self):
        try:
            self.p.stdin.write('{"quit": true}\n'); self.p.stdin.flush()
            self.p.wait(timeout=15)
        except Exception:
            try: self.p.kill()
            except Exception: pass


# ---------------------------------------------------------------- pdftotext
def bbox_pages(pdf):
    out = subprocess.run(['pdftotext', '-bbox', pdf, '-'], capture_output=True, text=True, timeout=120).stdout
    pages = []
    for m in re.finditer(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', out, re.S):
        words = [(float(a), float(b), float(c), float(d), htmlmod.unescape(t))
                 for a, b, c, d, t in re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', m.group(3))]
        pages.append({'w': float(m.group(1)), 'h': float(m.group(2)), 'words': words})
    return pages


def find_marks(pages):
    marks = {}
    for pi, pg in enumerate(pages):
        for x0, y0, x1, y1, t in pg['words']:
            for key in re.findall(r'QQ([a-z]\d+)QQ', t):
                marks.setdefault(key, (pi + 1, y0, x0))
    return marks


def page_texts(pdf):
    out = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True, timeout=120).stdout
    pages = out.split('\f')
    if pages and not pages[-1].strip(): pages = pages[:-1]
    return pages


def norm(s):
    return re.sub(r'\s+', '', s)


def gray_band_dark(pdf, page, top_mm, bottom_mm, dpi=50, threshold=200):
    """把第 page 页转灰度，返回 (顶部带暗像素数, 底部带暗像素数)。pdftoppm 不在时返回 None。"""
    if not shutil.which('pdftoppm'): return None
    r = subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-r', str(dpi), '-gray', pdf], capture_output=True, timeout=60)
    data = r.stdout
    m = re.match(rb'P5\s+(\d+)\s+(\d+)\s+(\d+)\s', data)
    if not m: return None
    w, h = int(m.group(1)), int(m.group(2)); pix = data[m.end():]
    px_per_mm = dpi / 25.4
    tb, bb = int(top_mm * px_per_mm), int(bottom_mm * px_per_mm)

    def dark(y0, y1):
        n = 0
        for y in range(max(0, y0), min(h, y1)):
            row = pix[y * w:(y + 1) * w]
            n += sum(1 for v in row if v < threshold)
        return n
    return dark(0, tb), dark(h - bb, h)


# ---------------------------------------------------------------- pypdf
def chrome_outline(pdf):
    from pypdf import PdfReader
    r = PdfReader(pdf)
    out = []

    def walk(items, depth):
        for it in items:
            if isinstance(it, list): walk(it, depth + 1)
            else:
                try: out.append((depth, it.title, r.get_destination_page_number(it) + 1))
                except Exception: out.append((depth, it.title, None))
    walk(r.outline, 1)
    return out, len(r.pages)


def merge(full_pdf, cover_pdf, out_pdf, bookmarks, metadata):
    """以全文 PDF 为底：第 1 页内容流与资源替换为封面单独打印的第 1 页（页对象不变 → 页码、链接注释不受影响）；
    删掉 Chrome 书签，按 bookmarks[(level, title, page)] 重建；写元数据。"""
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject
    w = PdfWriter(clone_from=full_pdf)
    cover = PdfReader(cover_pdf)
    if len(cover.pages) != 1:
        raise RenderError(f'封面单独打印得到 {len(cover.pages)} 页（应为 1 页），请缩短封面内容')
    w.add_page(cover.pages[0])
    added = w.pages[-1]; p0 = w.pages[0]
    p0[NameObject('/Contents')] = added.raw_get('/Contents')
    p0[NameObject('/Resources')] = added.raw_get('/Resources')
    if '/Annots' in p0: del p0['/Annots']
    w.remove_page(len(w.pages) - 1)
    if '/Outlines' in w._root_object:
        del w._root_object['/Outlines']
    parents = {}
    for level, title, page in bookmarks:
        if not page: continue
        parent = None
        for lv in range(level - 1, 0, -1):
            if lv in parents: parent = parents[lv]; break
        item = w.add_outline_item(title, page - 1, parent=parent)
        parents[level] = item
        for lv in [k for k in parents if k > level]: del parents[lv]
    w.page_mode = '/UseOutlines'
    w.add_metadata({f'/{k}': v for k, v in metadata.items() if v})
    tmp = out_pdf + '.tmp'
    with open(tmp, 'wb') as f: w.write(f)
    os.replace(tmp, out_pdf)


def count_bookmarks(pdf):
    from pypdf import PdfReader
    r = PdfReader(pdf)

    def cnt(o): return sum(cnt(x) if isinstance(x, list) else 1 for x in o)
    return cnt(r.outline), len(r.pages), dict(r.metadata or {})


# ---------------------------------------------------------------- 主流程
def outline_tree(pdf):
    """最终 PDF 的书签：[(层级, 标题, 页)]。"""
    from pypdf import PdfReader
    r = PdfReader(pdf)
    out = []

    def walk(items, depth):
        for it in items:
            if isinstance(it, list): walk(it, depth + 1)
            else: out.append((depth, it.title, r.get_destination_page_number(it) + 1))
    walk(r.outline, 1)
    return out


def body_chars(pg, top_pt, bottom_pt):
    return sum(len(re.sub(r'\s', '', w[4])) for w in pg['words'] if w[1] >= top_pt and w[3] <= pg['h'] - bottom_pt and 'QQ' not in w[4])


def render_pdf(ctx, pdf_path, keep_work=False, sparse_chars=None):
    """返回 dict：pages、bookmarks、bytes、metadata、chrome、passes、toc_pages{heading 下标: 页}、marks、issues[]、final_html、highlights、breaks。"""
    from common import AUTO_BREAK_FRACTION, SPARSE_CHARS_DEFAULT, duplicate_front_issues, front_pages, fill, doc_metadata
    doc = ctx.doc
    work = os.path.join(ctx.out_dir, '.work'); os.makedirs(work, exist_ok=True)
    issues = []
    header = backend_html.hf_template(ctx, ctx.profile.get('header') or {})
    footer = backend_html.hf_template(ctx, ctx.profile.get('footer') or {})
    h1_idx = [i for i, h in enumerate(doc.headings) if h['level'] == 1]
    mode = ctx.h1_mode
    breaks = set(h1_idx[1:]) if mode == 'always' else set()
    # 每个一级标题之前最后一个内容块（表或图）的定位标记
    prev_key, last = {}, None
    for b in doc.blocks:
        if b['kind'] == 'heading':
            if doc.headings[b['heading']]['level'] == 1: prev_key[b['heading']] = last
            continue
        if b['kind'] in ('table', 'data') and id(b) in ctx.tbl_index: last = f't{ctx.tbl_index[id(b)]}'
        elif b['kind'] in ('figure', 'image') and id(b) in ctx.fig_index: last = f'f{ctx.fig_index[id(b)]}'
        elif b['kind'] not in ('landscape', 'grid', 'pagebreak', 'footnote', 'summary'): last = None
    max_passes = MAX_PASSES + (max(2, len(h1_idx)) if mode == 'auto' else 0)   # auto 每遍只改一个判定，最多每章一遍
    pr = Printer()
    try:
        toc_pages = None; stable = False; passes = 0; marks = {}; pages = []; history = []; changed_last = False
        for k in range(max_passes):
            h, _ = backend_html.build_html(ctx, markers=True, toc_pages=toc_pages, breaks=breaks)
            hp = os.path.join(work, f'pass{k + 1}.html'); pp = os.path.join(work, f'pass{k + 1}.pdf')
            open(hp, 'w', encoding='utf-8').write(h)
            pr.print(html=hp, pdf=pp, displayHeaderFooter=True, headerTemplate=header, footerTemplate=footer)
            passes += 1
            pages = bbox_pages(pp); marks = find_marks(pages)
            located = {i: (marks.get(f'h{i}') or (None,))[0] for i in range(len(doc.headings))}
            new_breaks = set(breaks)
            if mode == 'auto':
                # 固定点：每遍按「上一章内容结束处」e<i> 重算整个 break 集合（可增可减）。
                # e<i> 在标题之前，本标题是否换页不改变它的位置，避免「换页后标题到页首 → 撤销 → 又回到页底」式振荡。
                desired = set()
                for i in h1_idx[1:]:
                    em = marks.get(f'e{i}')
                    if not em:
                        if i in breaks: desired.add(i)
                        continue
                    if em[1] + H1_TOP_GAP_PT > pages[em[0] - 1]['h'] * AUTO_BREAK_FRACTION:
                        desired.add(i)             # 标题将落在页面 65% 以下（本页剩余不足 35%）
                    else:
                        pk = prev_key.get(i)
                        if pk and marks.get(pk) and marks[pk][0] < em[0]:
                            desired.add(i)         # 上一章以跨页的表或图结束
                # 只改文档顺序上第一个与当前不同的判定：它之后的标题位置会随之移动，本遍对它们的判定已过期。
                # 已定前缀只增不减，最多每章一遍即收敛（实测一次改全部会级联振荡、5 遍不收敛）。
                diff = [i for i in h1_idx[1:] if (i in desired) != (i in breaks)]
                new_breaks = set(breaks)
                if diff: new_breaks ^= {diff[0]}
                history.append(frozenset(breaks))
                if new_breaks != breaks and frozenset(new_breaks) in history:
                    new_breaks |= breaks           # 检测到循环：取并集，break 集合只增不减，保证收敛
            toc_now = {i: located.get(i) for i in ctx.toc_headings}
            same_toc = toc_pages is not None and toc_now == {i: toc_pages.get(i) for i in ctx.toc_headings}
            changed_last = new_breaks != breaks
            if not changed_last and (same_toc or not ctx.toc_headings):
                toc_pages = located; stable = True; break
            toc_pages = located; breaks = new_breaks
        if not stable and changed_last:
            # 最后一遍又改了 break：强制按最终 break 集合再定位一遍，目录页码与终版分页一致
            h, _ = backend_html.build_html(ctx, markers=True, toc_pages=toc_pages, breaks=breaks)
            hp = os.path.join(work, f'pass{passes + 1}.html'); pp = os.path.join(work, f'pass{passes + 1}.pdf')
            open(hp, 'w', encoding='utf-8').write(h)
            pr.print(html=hp, pdf=pp, displayHeaderFooter=True, headerTemplate=header, footerTemplate=footer)
            passes += 1
            pages = bbox_pages(pp); marks = find_marks(pages)
            relocated = {i: (marks.get(f'h{i}') or (None,))[0] for i in range(len(doc.headings))}
            # 强制定位遍用的就是最终 break 集合：只有目录页码相对上一遍还在变时才算不稳定（否则不应报 LY1）
            stable = not ctx.toc_headings or all(relocated.get(i) == toc_pages.get(i) for i in ctx.toc_headings)
            toc_pages = relocated
        if not stable:
            issues.append({'rule': 'LY1', 'severity': '必改', 'message': f'目录页码与分页回填 {passes} 遍后仍不稳定', 'page': None, 'target': 'toc'})
        final_html, builder = backend_html.build_html(ctx, markers=False, toc_pages=toc_pages, breaks=breaks)
        hp = os.path.join(ctx.out_dir, f'{ctx.stem}.html')
        open(hp, 'w', encoding='utf-8').write(final_html)
        full = os.path.join(work, 'full.pdf')
        res = pr.print(html=hp, pdf=full, displayHeaderFooter=True, headerTemplate=header, footerTemplate=footer, outline=True, measure=True, contentMm=ctx.content_mm, landscapeMm=ctx.landscape_mm)
        passes += 1
        chp = os.path.join(work, 'cover.html'); cpdf = os.path.join(work, 'cover.pdf')
        open(chp, 'w', encoding='utf-8').write(backend_html.build_cover_html(ctx))
        pr.print(html=chp, pdf=cpdf, displayHeaderFooter=False)
        chrome = pr.chrome
    finally:
        pr.close()

    # 定位遍（带标记）与终遍（无标记）分页一致性：用 Chrome 大纲逐个核对标题页
    outline, npages = chrome_outline(full)
    if len(outline) == len(doc.headings):
        for i, (_, _, pg) in enumerate(outline):
            if toc_pages.get(i) and pg and pg != toc_pages[i]:
                issues.append({'rule': 'LY1', 'severity': '必改', 'message': f'标题「{heading_text(doc.headings[i])}」定位页 {toc_pages[i]} 与终遍 Chrome 大纲页 {pg} 不一致', 'page': pg, 'target': ctx.heading_ids[i]})
    elif npages != len(pages):
        issues.append({'rule': 'LY1', 'severity': '必改', 'message': f'定位遍 {len(pages)} 页与终遍 {npages} 页不一致', 'page': None, 'target': 'toc'})
    bookmarks = [(doc.headings[i]['level'], heading_text(doc.headings[i]), toc_pages.get(i)) for i in ctx.bookmark_headings]
    meta = doc_metadata(ctx)
    merge(full, cpdf, pdf_path, bookmarks, meta)
    nbm, npages, md = count_bookmarks(pdf_path)

    # ---- LY1 目录页码
    first_body = toc_pages.get(0) if doc.headings else None
    toc_page = (marks.get('c0') or (None,))[0]
    texts = page_texts(pdf_path)
    for i in ctx.toc_headings:
        h = doc.headings[i]; pg = toc_pages.get(i)
        if not pg:
            issues.append({'rule': 'LY1', 'severity': '必改', 'message': f'目录项缺页码：{heading_text(h)}', 'page': None, 'target': ctx.heading_ids[i]}); continue
        if (toc_page and pg <= toc_page) or (first_body and pg < first_body) or pg > len(texts) or norm(h['plain'])[:30] not in norm(texts[pg - 1]):
            issues.append({'rule': 'LY1', 'severity': '必改', 'message': f'目录页码与实际不符：「{heading_text(h)}」标 {pg}（目录页 {toc_page}），该页未找到标题或页码落在目录页之前', 'page': pg, 'target': ctx.heading_ids[i]})
    # ---- LY2 书签：数量与一至 N 级标题数独立核对，逐项核对层级与目标页
    expect = [(h['level'], toc_pages.get(i)) for i, h in enumerate(doc.headings) if h['level'] <= ctx.bookmark_levels]
    got = outline_tree(pdf_path)
    if len(got) != len(expect):
        issues.append({'rule': 'LY2', 'severity': '建议', 'message': f'书签数 {len(got)} ≠ 一至{ctx.bookmark_levels}级标题数 {len(expect)}', 'page': None, 'target': 'outline'})
    else:
        bad = [k for k, ((lv, pg), (d, _, gp)) in enumerate(zip(expect, got)) if lv != d or (pg and pg != gp)]
        if bad:
            issues.append({'rule': 'LY2', 'severity': '建议', 'message': f'{len(bad)} 个书签的层级或目标页与标题不符（首个：第 {bad[0] + 1} 个）', 'page': None, 'target': 'outline'})
    # ---- LY6 封面页眉页脚
    first = norm(texts[0]) if texts else ''
    footer_left = norm(re.sub(r'\{[^}]*\}', '', fill((ctx.profile.get('footer') or {}).get('left', ''), ctx.vals)))
    if (footer_left and footer_left in first) or re.search(r'(^|\n)\s*1\s*/\s*\d+\s*($|\n)', texts[0] if texts else ''):
        issues.append({'rule': 'LY6', 'severity': '必改', 'message': '封面页出现页脚文字或页码', 'page': 1, 'target': 'cover'})
    sp = ctx.tokens['space']
    band = gray_band_dark(pdf_path, 1, sp['page_margin_top'] - 3, sp['page_margin_bottom'] - 3)
    if band and (band[0] > 0 or band[1] > 0):
        issues.append({'rule': 'LY6', 'severity': '必改', 'message': f'封面页眉或页脚区域有印迹（暗像素 顶 {band[0]} / 底 {band[1]}）', 'page': 1, 'target': 'cover'})
    # ---- LY5 每页图数
    per_page = {}
    for fi in range(len(doc.figures)):
        pm = marks.get(f'f{fi}')
        if pm: per_page.setdefault(pm[0], []).append(fi)
    for pg, fis in sorted(per_page.items()):
        if len(fis) > 2:
            issues.append({'rule': 'LY5', 'severity': '建议', 'message': f'第 {pg} 页有 {len(fis)} 张图（建议每页不超过两张）', 'page': pg, 'target': ','.join(ctx.fig_ids[f] for f in fis)})
    top_pt = sp['page_margin_top'] * 72 / 25.4; bottom_pt = sp['page_margin_bottom'] * 72 / 25.4
    # ---- LY8 一级标题孤悬页底
    for i in h1_idx:
        pm = marks.get(f'h{i}')
        if not pm or pm[0] > len(pages): continue
        pg = pages[pm[0] - 1]
        if pm[1] > pg['h'] * 0.85:
            below = [wd for wd in pg['words'] if wd[1] > pm[1] + 24 and wd[3] < pg['h'] - bottom_pt and 'QQ' not in wd[4]]
            if not below:
                issues.append({'rule': 'LY8', 'severity': '建议', 'message': f'一级标题「{heading_text(doc.headings[i])}」位于页面底部且其下无内容', 'page': pm[0], 'target': ctx.heading_ids[i]})
    # ---- LY9 稀疏页：正文区字符数低于阈值。不计：前置页、全文最后一页、页上有图的页、自然结束的章末页（下一章没有被强制换页、本来就接在同页或下页开头）。
    #      被一级标题强制换页截断的章末页要计——这正是「一级标题一律新页起」造成的空白。
    threshold = sparse_chars if sparse_chars is not None else SPARSE_CHARS_DEFAULT
    if first_body and threshold > 0:
        # 自然章末：上一章结束处 e<i> 所在页，且标题 h<i> 未被强制换页、自然落到下一页；标题与上一章末段同页时前面的页不豁免
        natural_end = {marks[f'e{i}'][0] for i in h1_idx if marks.get(f'e{i}') and marks.get(f'h{i}') and i not in breaks and marks[f'h{i}'][0] == marks[f'e{i}'][0] + 1}
        natural_end -= {v[0] for key, v in marks.items() if re.fullmatch(r'p\d+', key)}   # 以手工分页结束的页不是自然章末
        for p in range(first_body, len(pages)):
            if p in per_page or p in natural_end: continue
            n = body_chars(pages[p - 1], top_pt, bottom_pt)
            if n < threshold:
                issues.append({'rule': 'LY9', 'severity': '建议', 'message': f'第 {p} 页正文只有 {n} 字（阈值 {threshold}），且不是章末页', 'page': p, 'target': f'page-{p}'})
    # ---- LY10 与自动生成页重复
    fp_no = {}
    for kind, _ in front_pages(ctx):
        fp_no[kind] = 1 if kind == 'control' else (marks.get({'revision': 'r0', 'summary': 's0'}[kind]) or (None,))[0]
    issues += duplicate_front_issues(ctx, toc_pages, fp_no)
    # ---- LY7 溢出（print 媒体下量得）
    for o in res.get('overflow') or []:
        issues.append({'rule': 'LY7', 'severity': '必改', 'message': f'{o.get("id")} 超出版心（宽 {o.get("width_mm")} mm，版心 {o.get("limit_mm")} mm{"，单元格内容溢出" if o.get("cell") else ""}）', 'page': None, 'target': o.get('id') or ''})
    hl_items = []
    for hi in builder.highlights:
        pm = marks.get(hi['key'])
        hl_items.append({'line': hi['line'], 'length': hi['length'], 'text': hi['text'], 'page': pm[0] if pm else None})
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    return {'pages': npages, 'bookmarks': nbm, 'bytes': os.path.getsize(pdf_path), 'metadata': {k.lstrip('/'): str(v) for k, v in md.items()},
            'chrome': chrome, 'passes': passes, 'toc_pages': toc_pages, 'marks': marks, 'issues': issues, 'final_html': final_html,
            'highlights': hl_items, 'outline_entries': len(outline), 'breaks': sorted(breaks), 'h1_mode': mode}
