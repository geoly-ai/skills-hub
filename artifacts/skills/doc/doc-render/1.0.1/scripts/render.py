#!/usr/bin/env python3
"""doc-render：DocMark 正文 → out/<源名>.html、PDF（Chrome CDP）、out/feishu.xml、out/render.json。
用法：render.py <运行目录> [--printer cdp|none] [--profile 品牌档案] [--pack 类型包] [--no-feishu] [--docx | --no-docx] [--legacy-tilde] [--keep-work] [--no-state] [--sparse-chars N]
  --docx / --no-docx  输出 out/<文件名模板>.docx 并读回校验（DX1–DX9）；缺省按类型包 outputs → 品牌档案 outputs
  --sparse-chars   LY9 稀疏页阈值（正文区字符数，默认 400，也可用环境变量 DOC_RENDER_SPARSE_CHARS；0 关闭）
  --printer none   只出 HTML 与飞书 XML（render.json 的 pdf 为 null，目录无页码）
  --legacy-tilde   正文 ~ 替换为 –（旧渲染器兼容行为，只给迁移期类型包用）
  --legacy-widths-px  飞书列宽：widths 全部 ≥ 20 时按像素原样输出（旧产物行为，只给迁移期类型包保 golden 用；缺省一律按权重归一化）
  --keep-work      保留 out/.work 里的各遍 HTML 与 PDF（排查分页）
  --no-state       不写 run-state.json
类型包查找：--pack → 环境变量 DOC_TYPES_DIRS → doc-shared/types/<type>/。品牌档案：--profile → doc.json brand → pack brand_profile → internal。
退出码：0 完成且无版式必改；3 完成但 render.json layout_issues 有必改；1 拒绝或失败（include 越权、钩子失败、打印失败、render.json 不合 schema）；2 用法错误。"""
import argparse, json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VENV_PY = os.path.join(ROOT, '.venv', 'bin', 'python')


def ensure_venv(modules=('pypdf',)):
    """缺任一模块（pypdf；docx 输出另需 python-docx、lxml）时切到 doc-render/.venv 重新执行。"""
    import importlib
    missing = []
    for m in modules:
        try:
            importlib.import_module(m)
        except ImportError:
            missing.append(m)
    if not missing:
        return
    if os.path.exists(VENV_PY) and not os.environ.get('DOC_RENDER_REEXEC'):
        os.environ['DOC_RENDER_REEXEC'] = '1'
        os.execv(VENV_PY, [VENV_PY, os.path.abspath(__file__)] + sys.argv[1:])
    print(json.dumps({'ok': False, 'error': f'缺少 {"、".join(missing)}：{ROOT}/.venv 未安装（python3 -m venv .venv && .venv/bin/pip install -r requirements.txt）'}, ensure_ascii=False))
    sys.exit(1)


def want_docx(a, ctx):
    """--docx / --no-docx > 类型包 outputs（字段存在时）> 品牌档案 outputs > 不输出。"""
    if a.docx is not None:
        return a.docx
    for src in (ctx.pack or {}, ctx.profile or {}):
        if isinstance(src.get('outputs'), list):
            return 'docx' in src['outputs']
    return False


def run_hook(ctx, name, common):
    hk = ((ctx.pack or {}).get('hooks') or {}).get(name)
    if not hk:
        return None
    vals = {'run_dir': ctx.run_dir, 'pack_dir': ctx.pack_dir or '', 'skills_dir': common.SKILLS, 'doc_shared': common.DOC_SHARED, 'python': sys.executable}
    argv = [re.sub(r'\{(run_dir|pack_dir|skills_dir|doc_shared|python)\}', lambda m: vals[m.group(1)], a) for a in hk.get('command', [])]
    env = dict(os.environ, DOC_RUN_DIR=ctx.run_dir, DOC_PACK_DIR=ctx.pack_dir or '', DOC_SHARED=common.DOC_SHARED, DOC_TYPE=ctx.type)
    try:
        r = subprocess.run(argv, cwd=ctx.run_dir, capture_output=True, text=True, timeout=hk.get('timeout_s', 600), env=env)
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise common.RenderError(f'{name} 钩子无法执行：{ex}')
    if r.returncode not in (hk.get('pass_exit_codes') or [0]):
        raise common.RenderError(f'{name} 钩子退出码 {r.returncode}，渲染中止：{(r.stdout + r.stderr)[-300:]}')
    return r.stdout


def prepare_figures(ctx, common, svgtools):
    doc = ctx.doc
    grid_cols = {b['grid']: b['cols'] for b in doc.blocks if b['kind'] == 'grid' and b['edge'] == 'start'}
    ctx.fig_info = []
    for i, b in enumerate(doc.figures):
        land = bool(b.get('landscape'))
        base = ctx.landscape_mm if land else ctx.content_mm
        max_h = 150.0 if land else 230.0
        if b.get('grid'):
            cols = grid_cols.get(b['grid'], 2)
            width = (base - 4 * (cols - 1)) / cols
        else:
            width = base * b['width_pct'] / 100
        info = {'limit_mm': base, 'display_width_mm': round(width, 2), 'exists': False}
        if b['kind'] == 'image':
            uri, _ = common.image_data_uri(ctx, b['src'], width)
            info.update(data_uri=uri, exists=uri is not None)
        elif b.get('svg'):
            p = os.path.join(ctx.run_dir, b['svg'])
            if os.path.isfile(p) and common.dp.within(ctx.run_dir, p):
                text = open(p, encoding='utf-8').read()
                an = svgtools.analyze(text)
                info.update(exists=True, error=an['error'], viewbox_width=an['viewbox_width'], viewbox_height=an['viewbox_height'],
                            min_font_px=an['min_font_px'], foreign_object=an['has_foreign_object'])
                vbw, vbh = an['viewbox_width'], an['viewbox_height']
                if vbw and vbh:
                    info['display_width_mm'] = round(min(width, max_h * vbw / vbh), 2)
                if an['min_font_px'] and vbw:
                    info['min_font_pt'] = round(common.tk.equiv_pt(an['min_font_px'], vbw, info['display_width_mm']), 2)
                if not an['error']:
                    info['markup'] = svgtools.namespace(text, f'f{i + 1}-')
        ctx.fig_info.append(info)


def main(argv):
    ap = argparse.ArgumentParser(add_help=True, usage=__doc__)
    ap.add_argument('run_dir')
    ap.add_argument('--printer', choices=['cdp', 'none'], default='cdp')
    ap.add_argument('--profile'); ap.add_argument('--pack')
    ap.add_argument('--no-feishu', action='store_true'); ap.add_argument('--legacy-tilde', action='store_true'); ap.add_argument('--legacy-widths-px', action='store_true')
    ap.add_argument('--keep-work', action='store_true'); ap.add_argument('--no-state', action='store_true')
    ap.add_argument('--sparse-chars', type=int, default=None)
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--docx', dest='docx', action='store_true', default=None)
    g.add_argument('--no-docx', dest='docx', action='store_false')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    if a.printer == 'cdp':
        ensure_venv()
    if a.docx:
        ensure_venv(('pypdf', 'docx', 'lxml'))
    sys.path.insert(0, HERE)
    import common, svgtools, backend_html, backend_feishu
    dp = common.dp
    import validate  # doc-shared/scripts（common 已加入 sys.path）
    try:
        ctx = common.load_context(a.run_dir, a.pack, a.profile, a.legacy_tilde, a.legacy_widths_px)
        do_docx = want_docx(a, ctx)
        if do_docx:
            ensure_venv(('pypdf', 'docx', 'lxml'))   # 类型包或品牌档案默认输出 docx 时，在钩子与写盘之前切 venv
        run_hook(ctx, 'pre_render', common)
        doc = dp.parse_file(ctx.run_dir, ctx.source_file, pack=ctx.pack)
        bad = [x for x in doc.includes if x['status'] != 'ok']
        refuse = [x for x in doc.diagnostics if x['severity'] == 'error' and (x['code'].startswith('include-') or x['code'] in common.REFUSE_CODES)]
        if bad or refuse:
            print(json.dumps({'ok': False, 'error': 'include 越权或缺失、资源路径越界、类型包禁用的块（代码块、摘要、横向页段、脚注、数据块）出现，渲染中止',
                              'includes': bad, 'diagnostics': refuse}, ensure_ascii=False, indent=2))
            return 1
        os.makedirs(ctx.out_dir, exist_ok=True)
        open(os.path.join(ctx.out_dir, f'{ctx.stem}.resolved.md'), 'w', encoding='utf-8').write(doc.text)
        common.finish_context(ctx, doc)
        prepare_figures(ctx, common, svgtools)
        issues = []

        feishu = None
        xml = ''
        if not a.no_feishu:
            xml, stats = backend_feishu.build_feishu(ctx)
            open(os.path.join(ctx.out_dir, 'feishu.xml'), 'w', encoding='utf-8').write(xml)
            feishu = {'path': 'out/feishu.xml', **stats}

        docx_info = None
        if do_docx:
            import backend_docx
            dpath = os.path.join(ctx.out_dir, backend_docx.docx_filename(ctx))
            if os.path.exists(dpath): os.remove(dpath)
            dstats = backend_docx.build_docx(ctx, dpath)
            rb, rb_issues = backend_docx.readback(ctx, dpath, dstats)
            so, so_issues = backend_docx.soffice_check(ctx, dpath, dstats, os.path.join(ctx.out_dir, '.work', 'docx-check'))
            if so is None:
                ctx.warnings.append('未找到 LibreOffice（soffice）：docx 只做了读回校验，未做客户端转换核验')
            backend_docx.merge_soffice(rb, so)   # DX9 转换核验与 DX8 空白页进 checks；ok = 无必改级失败，all_passed = 全部通过
            if not a.keep_work: shutil.rmtree(os.path.join(ctx.out_dir, '.work', 'docx-check'), ignore_errors=True)
            issues += rb_issues + so_issues
            docx_info = {'path': os.path.relpath(dpath, ctx.run_dir), **{k: v for k, v in dstats.items() if not k.startswith('_')}, 'readback': rb}

        pdf_info, chrome, passes, toc_pages, marks, hl_items = None, None, 0, {}, {}, []
        if a.printer == 'cdp':
            import pdf as pdfmod
            name = common.pdf_filename(ctx)
            pdf_path = os.path.join(ctx.out_dir, name)
            if os.path.exists(pdf_path): os.remove(pdf_path)
            sparse = a.sparse_chars if a.sparse_chars is not None else (int(os.environ['DOC_RENDER_SPARSE_CHARS']) if os.environ.get('DOC_RENDER_SPARSE_CHARS', '').isdigit() else None)
            r = pdfmod.render_pdf(ctx, pdf_path, keep_work=a.keep_work, sparse_chars=sparse)
            final_html = r['final_html']; issues += r['issues']
            chrome, passes, toc_pages, marks, hl_items = r['chrome'], r['passes'], r['toc_pages'], r['marks'], r['highlights']
            pdf_info = {'path': os.path.relpath(pdf_path, ctx.run_dir), 'pages': r['pages'], 'bookmarks': r['bookmarks'], 'bytes': r['bytes'], 'metadata': r['metadata']}
        else:
            final_html, builder = backend_html.build_html(ctx)
            open(os.path.join(ctx.out_dir, f'{ctx.stem}.html'), 'w', encoding='utf-8').write(final_html)
            hl_items = [{'line': h['line'], 'length': h['length'], 'text': h['text'], 'page': None} for h in builder.highlights]
            issues += common.duplicate_front_issues(ctx)

        # LY3：HTML 与飞书 XML 里每个表格都要有 thead
        for label, src in (('HTML', final_html), ('飞书 XML', xml)):
            for m in re.finditer(r'<table\b[^>]*>(.*?)</table>', src, re.S):
                if '<thead' not in m.group(1):
                    issues.append({'rule': 'LY3', 'severity': '必改', 'message': f'{label} 中有表格缺 thead', 'page': None, 'target': label})
        # LY4：图等效最小字号
        fmin = float(ctx.tokens['size']['figure_min'])
        figures = []
        engines = {'mermaid', 'graphviz', 'svgkit', 'svg', 'image'}
        for i, b in enumerate(doc.figures):
            info = ctx.fig_info[i]
            pm = marks.get(f'f{i}')
            ent = {'id': ctx.fig_ids[i], 'number': b.get('number') or '', 'caption': b.get('caption') or '', 'src': b['src'],
                   'engine': b['engine'] if b['engine'] in engines else 'svg', 'min_font_pt': info.get('min_font_pt'),
                   'display_width_mm': info['display_width_mm'], 'page': pm[0] if pm else None, 'referenced': (b.get('anchor') or '') in ctx.referenced}
            if b.get('svg'): ent['svg'] = b['svg']
            if info.get('viewbox_width'): ent['viewbox_width'] = info['viewbox_width']
            if info.get('min_font_px'): ent['min_font_px'] = info['min_font_px']
            figures.append(ent)
            tgt = ctx.fig_ids[i]
            if b['kind'] == 'image':
                if not info['exists']:
                    issues.append({'rule': 'LY4', 'severity': '必改', 'message': f'图片不存在：{b["src"]}', 'page': ent['page'], 'target': tgt})
                continue
            if not info['exists']:
                issues.append({'rule': 'LY4', 'severity': '必改', 'message': f'图未构建，无法计算等效字号：{b.get("svg")}（先运行 doc-figures build）', 'page': ent['page'], 'target': tgt})
            elif info.get('error'):
                issues.append({'rule': 'LY4', 'severity': '必改', 'message': f'{b.get("svg")}：{info["error"]}', 'page': ent['page'], 'target': tgt})
            elif info.get('min_font_pt') is not None and info['min_font_pt'] < fmin:
                issues.append({'rule': 'LY4', 'severity': '必改', 'message': f'{ent["number"] or b["src"]} 等效最小字号 {info["min_font_pt"]} pt < {fmin:g} pt（图内 {info["min_font_px"]} px，viewBox 宽 {info["viewbox_width"]:g}，显示宽 {info["display_width_mm"]} mm）', 'page': ent['page'], 'target': tgt})
        tables = []
        for i, b in enumerate(doc.tables):
            _, given = common.table_widths(ctx, b)
            pm = marks.get(f't{i}')
            tables.append({'id': ctx.tbl_ids[i], 'number': b.get('number') or '', 'caption': b.get('caption') or '', 'columns': max(1, len(b['header'])),
                           'rows': len(b['rows']), 'has_thead': True, 'widths_given': given, 'dense': common.is_dense(ctx, b),
                           'landscape': bool(b.get('landscape')), 'page': pm[0] if pm else None, 'referenced': (b.get('anchor') or '') in ctx.referenced})
        toc = [{'level': doc.headings[i]['level'], 'number': common.heading_label(doc.headings[i]), 'title': doc.headings[i]['plain'],
                'anchor': ctx.heading_ids[i], 'page': toc_pages.get(i) if toc_pages else None} for i in ctx.toc_headings]
        per_page = {}
        for h in hl_items:
            if h['page']: per_page[str(h['page'])] = per_page.get(str(h['page']), 0) + 1
        highlights = {'total': len(hl_items), 'per_page': per_page, 'items': hl_items}
        rj = {
            'schema_version': '1', 'generated_at': common.now_iso(), 'source_sha256': common.sha256_text(doc.text),
            'renderer': {'name': common.RENDERER_NAME, 'version': common.RENDERER_VERSION, 'printer': a.printer, 'passes': passes, **({'chrome': chrome} if chrome else {})},
            'profile': ctx.profile_id, 'cover': ctx.cover, 'pdf': pdf_info, 'html': f'out/{ctx.stem}.html',
            'toc': toc, 'figures': figures, 'tables': tables, 'layout_issues': issues, 'feishu': feishu, 'docx': docx_info,
        }
        schema = json.load(open(os.path.join(common.DOC_SHARED, 'schemas', 'render.schema.json'), encoding='utf-8'))
        hl_path = None
        if 'highlights' in schema.get('properties', {}):
            rj['highlights'] = highlights
        else:
            hl_path = os.path.join(ctx.out_dir, 'render.highlights.json')
            json.dump(highlights, open(hl_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        errors, warnings = validate.validate_data('render', rj)
        rjp = os.path.join(ctx.out_dir, 'render.json')
        with open(rjp, 'w', encoding='utf-8') as f:
            json.dump(rj, f, ensure_ascii=False, indent=2); f.write('\n')
        if errors:
            print(json.dumps({'ok': False, 'error': 'render.json 不合 schema（引擎缺陷）', 'errors': errors}, ensure_ascii=False, indent=2))
            return 1
        state = None
        if not a.no_state and os.path.exists(os.path.join(ctx.run_dir, 'run-state.json')):
            r = subprocess.run([sys.executable, os.path.join(common.DOC_SHARED, 'scripts', 'run_state.py'), ctx.run_dir, 'set-stage', 'render', '--by', 'doc-render'],
                               capture_output=True, text=True, timeout=60)
            state = 'render' if r.returncode == 0 else f'set-stage 失败：{(r.stdout + r.stderr)[-200:]}'
        must = [x for x in issues if x['severity'] == '必改']
        print(json.dumps({'ok': True, 'title': ctx.title, 'type': ctx.type, 'profile': ctx.profile_id, 'cover': ctx.cover,
                          'html': rj['html'], 'pdf': pdf_info and pdf_info['path'], 'pages': pdf_info and pdf_info['pages'],
                          'bookmarks': pdf_info and pdf_info['bookmarks'], 'feishu': feishu and feishu['path'], 'docx': docx_info and docx_info['path'],
                          'docx_readback': docx_info and docx_info['readback']['ok'], 'docx_all_passed': docx_info and docx_info['readback']['all_passed'], 'render_json': 'out/render.json',
                          'highlights_json': hl_path and os.path.relpath(hl_path, ctx.run_dir), 'passes': passes, 'chrome': chrome, 'h1_page_break': ctx.h1_mode,
                          'layout_issues': {'必改': len(must), '建议': sum(1 for x in issues if x['severity'] == '建议'), '提示': sum(1 for x in issues if x['severity'] == '提示')},
                          'must_fix': [f'{x["rule"]} {x["message"]}' for x in must][:10], 'run_state': state,
                          'warnings': ctx.warnings + warnings, 'parse_errors': len(doc.errors())}, ensure_ascii=False, indent=2))
        return 3 if must else 0
    except common.RenderError as ex:
        print(json.dumps({'ok': False, 'error': str(ex)}, ensure_ascii=False))
        return ex.code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
