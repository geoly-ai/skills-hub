"""doc-render 公共层：运行目录上下文（元数据、类型包、品牌档案、tokens）、占位符、编号与 id 映射、列宽估算。
后端无关：HTML/PDF 后端（backend_html.py + pdf.py）、飞书后端（backend_feishu.py）以及后续的 docx 后端都只读这里产出的 Ctx 与 Document。"""
import base64, datetime, hashlib, html, json, math, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILLS = os.path.dirname(ROOT)
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
sys.path.insert(0, os.path.join(DOC_SHARED, 'scripts'))
import docmark_parse as dp  # noqa: E402
import tokens as tk  # noqa: E402

RENDERER_NAME = 'doc-render'
RENDERER_VERSION = '1.0'
STATUS_CN = {'draft': '草稿', 'review': '评审中', 'approved': '已批准', 'published': '已发布'}
DECISION_CN = {'pending': '待评审', 'approved': '通过', 'changes_requested': '需修改', 'rejected': '驳回'}
DEFAULT_FILENAME = '{project}_{name}_{title}_v{version}_{yyyymmdd}.pdf'
CN_PLACEHOLDERS = {'项目': 'project', '标题': 'title', '版本': 'version', '日期': 'yyyymmdd', '名称': 'name', '类型': 'type', '客户': 'client'}


BOOKMARK_LEVELS = 3          # layout.md §4：书签层级 = 标题层级，覆盖一至三级（目录只到品牌档案 toc_levels）
H1_MODES = ('always', 'auto', 'never')
AUTO_BREAK_FRACTION = 0.65   # auto：一级标题落在页面 65% 以下（本页剩余不足 35%）时换页
SPARSE_CHARS_DEFAULT = 400   # LY9 稀疏页阈值（正文区字符数），--sparse-chars 或 DOC_RENDER_SPARSE_CHARS 可改
FRONT_PAGE_NAMES = {'revision': ('修订记录', '文档控制与修订记录'), 'control': ('文档控制', '文档控制与修订记录'), 'summary': ('摘要', '执行摘要')}  # 受控别名，规范化后精确匹配
REFUSE_CODES = ('figure-path', 'data-path', 'code-disabled', 'feature-disabled')  # 加 include-*：渲染前必须拒绝的解析错误


def h1_break_mode(pack, profile, cover, feats):
    """一级标题分页：类型包 features.h1_page_break（always / auto / never，schema 待 doc-shared 登记）
    → 类型包 features.h1_new_page 显式布尔（true=always，false=never）→ 品牌档案 h1_page_break
    → 按封面：technical（对内）auto；marketing（对外）never（旧渲染器不分页，保持 golden 页数）。"""
    v = (feats or {}).get('h1_page_break')
    if v in H1_MODES: return v
    v = (((pack or {}).get('features')) or {}).get('h1_new_page')
    if v is True: return 'always'
    if v is False: return 'never'
    v = (profile or {}).get('h1_page_break')
    if v in H1_MODES: return v
    return 'auto' if cover == 'technical' else 'never'


def front_pages(ctx):
    """引擎自动生成的前置页：[(种类, 显示名)]。"""
    out = []
    if ctx.cover == 'technical' and ctx.profile.get('doc_control_table', True): out.append(('control', '封面文档控制表'))
    if ctx.profile.get('revision_page') and ctx.revisions: out.append(('revision', '修订记录页'))
    if ctx.features.get('summary_block') is not False and any(b.get('in_summary') and b['kind'] != 'summary' for b in ctx.doc.blocks):
        out.append(('summary', '摘要页'))
    return out


def front_alias_key(s):
    """LY10 规范化：去空白与标点后整串比较（「摘要方法」「文档控制策略」不算重复）。"""
    return re.sub(r'[\s\u3000·•:：、，,。.（）()【】\[\]「」“”"\'\-—]', '', s or '')


def duplicate_front_issues(ctx, heading_pages=None, front_page_no=None):
    """LY10：正文一、二级标题与自动生成的前置页同名或同义（修订记录、文档控制、摘要、执行摘要）。"""
    heading_pages = heading_pages or {}; front_page_no = front_page_no or {}
    issues = []
    fronts = front_pages(ctx)
    for i, h in enumerate(ctx.doc.headings):
        if h['level'] > 2: continue
        t = front_alias_key(h['plain'])
        for kind, label in fronts:
            hit = t if t in FRONT_PAGE_NAMES[kind] else None
            if hit:
                fp = front_page_no.get(kind)
                issues.append({'rule': 'LY10', 'severity': '建议', 'page': heading_pages.get(i),
                               'message': f'正文标题「{heading_text(h)}」与引擎生成的{label}（第 {fp} 页）内容重复（同名或同义「{hit}」），建议删掉正文里的这一节' if fp else f'正文标题「{heading_text(h)}」与引擎生成的{label}重复（同名或同义「{hit}」）',
                               'target': ctx.heading_ids[i]})
                break
    return issues


class RenderError(Exception):
    """用法或输入错误：render.py 以退出码 1（拒绝）或 2（用法）结束。"""
    def __init__(self, msg, code=1):
        super().__init__(msg); self.code = code


def esc(s):
    return html.escape(str(s), quote=False)


def esc_attr(s):
    return html.escape(str(s), quote=True)


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def fill(template, vals):
    """替换 {key}；不认识的占位符原样保留（{page} {pages} {logo} 由各后端处理）。"""
    return re.sub(r'\{(\w+)\}', lambda m: str(vals[m.group(1)]) if m.group(1) in vals and vals[m.group(1)] is not None else m.group(0), template or '')


def find_pack(doc_type, pack_arg=None):
    cands = []
    if pack_arg:
        p = os.path.expanduser(pack_arg)
        cands.append(p if p.endswith('.json') else os.path.join(p, 'pack.json'))
    for d in filter(None, os.environ.get('DOC_TYPES_DIRS', '').split(':')):
        if doc_type: cands.append(os.path.join(os.path.expanduser(d), doc_type, 'pack.json'))
    if doc_type: cands.append(os.path.join(DOC_SHARED, 'types', doc_type, 'pack.json'))
    for c in cands:
        if os.path.isfile(c):
            return load_json(c), os.path.dirname(os.path.abspath(c))
    if pack_arg:
        raise RenderError(f'--pack 指定的类型包不存在：{pack_arg}', 2)
    return None, None


def version_key(v):
    return tuple(int(x) for x in re.findall(r'\d+', str(v))) or (0,)


class Ctx:
    pass


def load_context(run_dir, pack_arg=None, profile_arg=None, legacy_tilde=False, legacy_widths_px=False):
    c = Ctx()
    c.run_dir = os.path.abspath(os.path.expanduser(run_dir))
    if not os.path.isdir(c.run_dir):
        raise RenderError(f'运行目录不存在：{run_dir}', 2)
    c.warnings = []
    meta_file = 'doc.json' if os.path.exists(os.path.join(c.run_dir, 'doc.json')) else ('brief.json' if os.path.exists(os.path.join(c.run_dir, 'brief.json')) else None)
    c.meta = load_json(os.path.join(c.run_dir, meta_file)) if meta_file else {}
    c.meta_file = meta_file
    doc_type = c.meta.get('type')
    c.pack, c.pack_dir = find_pack(doc_type, pack_arg)
    if c.pack and c.pack.get('meta_file') and c.pack['meta_file'] != meta_file and os.path.exists(os.path.join(c.run_dir, c.pack['meta_file'])):
        c.meta_file = c.pack['meta_file']; c.meta = load_json(os.path.join(c.run_dir, c.meta_file))
    if not c.pack:
        c.warnings.append(f'未找到类型包（type={doc_type}）：按缺省特性渲染')
    c.type = doc_type or (c.pack or {}).get('id') or ''
    c.tokens = load_json(os.path.join(DOC_SHARED, 'brand', 'tokens.json'))
    c.tokens_css = open(os.path.join(DOC_SHARED, 'brand', 'generated', 'tokens.css'), encoding='utf-8').read()
    c.feishu_map = load_json(os.path.join(DOC_SHARED, 'brand', 'generated', 'feishu-callouts.json'))
    profile_id = profile_arg or c.meta.get('brand') or (c.pack or {}).get('brand_profile') or 'internal'
    ppath = os.path.join(DOC_SHARED, 'brand', 'profiles', f'{profile_id}.json')
    if not os.path.isfile(ppath):
        raise RenderError(f'品牌档案不存在：{profile_id}', 2)
    c.profile = load_json(ppath); c.profile_id = profile_id
    src = (c.pack or {}).get('source_file')
    if not src:
        src = 'doc.md' if os.path.exists(os.path.join(c.run_dir, 'doc.md')) or not os.path.exists(os.path.join(c.run_dir, 'proposal.md')) else 'proposal.md'
    c.source_file = src
    if not dp.safe_source(c.run_dir, src):
        raise RenderError(f'正文文件越出运行目录（..、绝对路径或指向外部的符号链接），拒绝渲染：{src}', 1)
    if not os.path.isfile(os.path.join(c.run_dir, src)):
        raise RenderError(f'正文文件不存在：{src}', 1)
    c.stem = os.path.splitext(os.path.basename(src))[0]
    c.out_dir = os.path.join(c.run_dir, 'out')
    feats = dict(dp.FEATURE_DEFAULTS)
    if c.pack and isinstance(c.pack.get('features'), dict): feats.update(c.pack['features'])
    c.features = feats
    c.cover = (c.pack or {}).get('cover') or c.profile.get('cover') or 'technical'
    c.h1_mode = h1_break_mode(c.pack, c.profile, c.cover, feats)
    c.h1_new_page = c.h1_mode == 'always'
    c.toc_levels = int(c.profile.get('toc_levels') or 2)
    c.type_name = (c.pack or {}).get('name') or c.type
    page = c.tokens['page']
    c.content_mm = float(page['content_width_mm']); c.landscape_mm = float(page['landscape_content_width_mm'])
    sp = c.tokens['space']
    c.content_h_mm = float(page['height_mm']) - sp['page_margin_top'] - sp['page_margin_bottom']
    c.landscape_h_mm = float(page['width_mm']) - sp['page_margin_top'] - sp['page_margin_bottom']
    c.legacy_tilde = legacy_tilde
    c.legacy_widths_px = legacy_widths_px
    m = c.meta
    cover = m.get('cover') or {}
    c.version = str(m.get('version') or '1.0').lstrip('vV')
    revs = [r for r in (m.get('revision_history') or []) if isinstance(r, dict)]
    c.revisions = sorted(revs, key=lambda r: version_key(r.get('version')), reverse=True)
    rev_date = next((r.get('date') for r in revs if str(r.get('version', '')).lstrip('vV') == c.version), None)
    c.date = m.get('date') or rev_date or datetime.date.today().isoformat()
    c.subtitle = cover.get('subtitle') or m.get('subtitle') or ''
    c.cover_meta = list(cover.get('meta') or [])
    c.cover_badge = cover.get('badge') or (c.pack or {}).get('cover_badge') or ''
    c.party_label = cover.get('party_label') or '对象'
    c.project = m.get('project') or os.path.basename(c.run_dir)
    c.client = m.get('client_cn') or m.get('client') or ''
    c.party = c.client or c.project
    c.status = m.get('status') or ''
    c.owner = m.get('owner') or ''
    c.reviewers = m.get('reviewers') or []
    brand = c.tokens['brand']
    c.brand_dir = os.path.join(DOC_SHARED, 'brand')
    c.logo_path = os.path.join(c.brand_dir, brand['logo'])
    c.logo_data_uri = ''
    if os.path.isfile(c.logo_path):
        mime = 'image/svg+xml' if c.logo_path.endswith('.svg') else 'image/png'
        c.logo_data_uri = f'data:{mime};base64,' + base64.b64encode(open(logo_for_print(c), 'rb').read()).decode()
    c.vals = {}
    return c


def finish_context(c, doc):
    """解析之后：标题、占位符、id 映射、脚注编号。"""
    c.doc = doc
    m = c.meta
    c.title = doc.title or m.get('title') or c.stem
    c.short_title = m.get('title') or c.title
    brand = c.tokens['brand']
    v = {
        'brand': brand.get('name', ''), 'website': brand.get('website', ''), 'title': c.title, 'subtitle': c.subtitle,
        'version': c.version, 'date': c.date, 'party': c.party, 'client': c.client or c.party, 'project': c.project,
        'classification': c.profile.get('classification') or '', 'doc_no': m.get('doc_no') or '',
        'status': STATUS_CN.get(c.status, c.status), 'name': c.type_name, 'type': c.type,
        'yyyymmdd': c.date.replace('-', ''),
    }
    v['footer_text'] = fill(brand.get('footer_text', ''), v)
    disc = fill(brand.get('disclaimer', ''), v)
    if (c.pack or {}).get('disclaimer'): disc = disc + ' · ' + fill(c.pack['disclaimer'], v)
    v['disclaimer'] = disc
    c.vals = v
    # id 映射
    c.heading_ids = []
    for i, h in enumerate(doc.headings):
        a = h.get('anchor') or ''
        c.heading_ids.append('sec-' + a[4:] if a.startswith('sec:') else f'h{i + 1}')
    c.fig_index = {id(b): i for i, b in enumerate(doc.figures)}
    c.fig_ids = [('fig-' + b['anchor'][4:]) if (b.get('anchor') or '').startswith('fig:') else f'figure-{i + 1}' for i, b in enumerate(doc.figures)]
    c.tbl_index = {id(b): i for i, b in enumerate(doc.tables)}
    c.tbl_ids = [('tbl-' + b['anchor'][4:]) if (b.get('anchor') or '').startswith('tbl:') else f'table-{i + 1}' for i, b in enumerate(doc.tables)]
    c.anchor_elem = {}
    inline_targets = {n['target'] for nodes in dp._all_inline(doc) for n in dp.walk_inline(nodes or []) if n['t'] == 'anchor'}
    for key, rec in doc.anchors.items():
        if rec['target'] == 'heading':
            k = next((i for i, h in enumerate(doc.headings) if h['line'] == rec['line'] and h.get('anchor') == key), None)
            if k is not None: c.anchor_elem[key] = c.heading_ids[k]
        elif rec['target'] == 'figure':
            k = next((i for i, b in enumerate(doc.figures) if b.get('anchor') == key), None)
            if k is not None: c.anchor_elem[key] = c.fig_ids[k]
        elif rec['target'] == 'table':
            k = next((i for i, b in enumerate(doc.tables) if b.get('anchor') == key), None)
            if k is not None: c.anchor_elem[key] = c.tbl_ids[k]
        elif rec['target'] == 'inline':
            # 行内实体锚点：正文里有 anchor 节点时在该处发射目标；写在标题上的（解析器转为行内锚点、标题无节点）指向该标题
            if key in inline_targets:
                c.anchor_elem[key] = inline_anchor_id(key)
            else:
                k = next((i for i, h in enumerate(doc.headings) if h['line'] == rec['line']), None)
                if k is not None: c.anchor_elem[key] = c.heading_ids[k]
    c.fn_num = {}
    for r in doc.footnote_refs:
        if r['id'] in doc.footnotes and r['id'] not in c.fn_num:
            c.fn_num[r['id']] = len(c.fn_num) + 1
    c.toc_headings = [i for i, h in enumerate(doc.headings) if h['level'] <= c.toc_levels] if c.features.get('toc') is not False else []
    bl = c.profile.get('bookmark_levels')
    if bl is not None and bl != BOOKMARK_LEVELS:
        raise RenderError(f'品牌档案 {c.profile_id} 写了 bookmark_levels={bl}：书签层级固定为一至三级（layout.md §4），不可配置', 2)
    c.bookmark_levels = BOOKMARK_LEVELS
    c.bookmark_headings = [i for i, h in enumerate(doc.headings) if h['level'] <= c.bookmark_levels]
    c.referenced = {r['target'] for r in doc.refs if r.get('resolved')}
    return c


def inline_anchor_id(key):
    """行内实体锚点 kind:id 的元素 id（HTML id、docx 书签的来源）。"""
    return 'ent-' + re.sub(r'[^A-Za-z0-9_-]', '-', key.replace(':', '-'))


def doc_metadata(ctx):
    """PDF 元数据与 docx 核心属性的统一口径（layout.md §11）。"""
    return {
        'Title': ctx.title,
        'Author': ctx.vals['brand'] if ctx.profile.get('audience') == 'external' else (ctx.owner or ctx.vals['brand']),
        'Subject': ctx.type_name, 'Keywords': ', '.join(x for x in (ctx.project, ctx.type, 'v' + ctx.version) if x),
        'Creator': f'{RENDERER_NAME} {RENDERER_VERSION}',
    }


def heading_label(h):
    if h['appendix'] and h['level'] == 1 and h['number']:
        return '附录 ' + h['number']
    return h['number']


def heading_text(h):
    lab = heading_label(h)
    return (lab + ' ' if lab else '') + h['plain']


def hl_callout_kind(n):
    """重点高亮节点（或 kind 字符串）-> tokens callout 表的 kind。
    高亮颜色变体不另立配色表：neutral（无前缀）映射到 callout.note，其余前缀映射到同名 callout kind。"""
    k = n if isinstance(n, str) else (n or {}).get('kind', 'neutral')
    return dp.HL_KIND_CALLOUT.get(k, 'note')


def hl_fill(tokens, n):
    """重点高亮的底色（十六进制），取 tokens.callout[kind].bg 指向的 color 键。"""
    return tokens['color'][tokens['callout'][hl_callout_kind(n)]['bg']]


def tilde(ctx, s):
    return s.replace('~', '–') if ctx.legacy_tilde else s


def cell_plain(nodes):
    return dp.inline_plain(nodes)


def estimate_widths(header_plain, rows_plain):
    """layout.md §6：每列权重 = clamp(max(表头字数, 该列单元格字数的 80 分位), 4, 40)，再归一化为百分比。"""
    ws = []
    for c, hd in enumerate(header_plain):
        cells = sorted(dp.char_count(r[c]) for r in rows_plain if c < len(r))
        p80 = cells[max(0, math.ceil(0.8 * len(cells)) - 1)] if cells else 0
        ws.append(max(4, min(40, max(dp.char_count(hd), p80))))
    total = sum(ws) or 1
    return [w / total * 100 for w in ws]


MIN_COL_MM = 12.0


NOWRAP_CODE_MAX = 24  # 不超过该长度的编号类单元格不断行（HTML 加 dm-nowrap），列宽下限按它计算
RE_CODE_CELL = re.compile(r'^[A-Za-z0-9_.:/#+\-]+$')


def text_units(s):
    """显示宽度（em）：中日韩字符 1，其他 0.58。"""
    return sum(1.0 if ord(ch) > 0x2E80 else (0.68 if ch.isupper() or ch.isdigit() else 0.56) for ch in s if not ch.isspace())


def enforce_min(pcts, limit_mm, min_mm=MIN_COL_MM):
    """估算列宽时保证每列不窄于下限。min_mm 可为数值或逐列列表；下限之和放不下时按下限比例分配。"""
    n = len(pcts)
    if not n: return pcts
    mins = list(min_mm) if isinstance(min_mm, (list, tuple)) else [min_mm] * n
    floors = [m / limit_mm * 100 for m in mins]
    if sum(floors) >= 100:
        t = sum(floors); return [f / t * 100 for f in floors]
    fixed = [False] * n
    out = list(pcts)
    for _ in range(n):
        low = [i for i in range(n) if not fixed[i] and out[i] < floors[i]]
        if not low: break
        for i in low: out[i] = floors[i]; fixed[i] = True
        rest = [i for i in range(n) if not fixed[i]]
        remain = 100 - sum(floors[i] for i in range(n) if fixed[i])
        tot = sum(pcts[i] for i in rest) or 1
        for i in rest: out[i] = pcts[i] / tot * remain
    return out


def column_min_mm(ctx, b, hp, rp):
    """逐列最小宽度：不小于 12 mm；容得下最长的不可断编号（如 TC-MOD-01）与不超过 4 个字的表头（避免「优先 / 级」式断行）。"""
    t = ctx.tokens
    pt = t['size']['table_dense'] if is_dense(ctx, b) else t['size']['table']
    em = pt * 25.4 / 72
    pad = 2 * t['space']['cell_x'] + 1.0
    mins = []
    for c, hd in enumerate(hp):
        need = min(text_units(hd), 4.0) * em * 1.05
        codes = [r[c].strip() for r in rp if c < len(r) and RE_CODE_CELL.match(r[c].strip() or ' ')]
        if codes:
            need = max(need, max(text_units(x) for x in codes if len(x) <= NOWRAP_CODE_MAX) * em * 1.04 if any(len(x) <= NOWRAP_CODE_MAX for x in codes) else 0)
        mins.append(max(MIN_COL_MM, need + pad))
    return mins


def table_widths(ctx, b):
    """返回 (百分比列表, widths_given)。作者给的 widths 原样按权重；估算的列宽保证最小列宽。"""
    n = len(b['header'])
    if b.get('widths') and len(b['widths']) == n:
        t = sum(b['widths'])
        return [w / t * 100 for w in b['widths']], True
    hp = [cell_plain(x) for x in b['header_inline']]
    rp = [[cell_plain(x) for x in r] for r in b['rows_inline']]
    limit = ctx.landscape_mm if b.get('landscape') else ctx.content_mm
    return enforce_min(estimate_widths(hp, rp), limit, column_min_mm(ctx, b, hp, rp)), False


def is_dense(ctx, b):
    return len(b['header']) > int(ctx.tokens['table'].get('dense_columns_over', 6))


def reviewer_text(r):
    if isinstance(r, str): return r
    s = r.get('name', '')
    if r.get('role'): s += f'（{r["role"]}）'
    if r.get('decision'): s += ' · ' + DECISION_CN.get(r['decision'], r['decision'])
    if r.get('date'): s += ' ' + r['date']
    return s


def pdf_filename(ctx):
    tpl = (ctx.pack or {}).get('filename') or DEFAULT_FILENAME
    for cn, en in CN_PLACEHOLDERS.items(): tpl = tpl.replace('{' + cn + '}', '{' + en + '}')
    vals = {k: re.sub(r'[\\/:*?"<>|\s]+', '-', str(v)).strip('-') for k, v in ctx.vals.items()}
    vals['title'] = re.sub(r'[\\/:*?"<>|\s]+', '-', ctx.short_title).strip('-')
    name = fill(tpl, vals)
    name = re.sub(r'\{\w+\}', '', name)
    if not name.lower().endswith('.pdf'): name += '.pdf'
    return name


def sha256_text(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def find_node():
    n = shutil.which('node')
    if n: return n
    import glob
    cands = sorted(glob.glob(os.path.expanduser('~/.nvm/versions/node/v*/bin/node')), key=lambda x: [int(k) for k in re.findall(r'\d+', x)])
    return cands[-1] if cands else None


def magick():
    return shutil.which('magick') or shutil.which('convert')


def image_data_uri(ctx, rel, display_mm):
    """位图按显示尺寸 2 倍像素降采样后内嵌（layout.md §7）；没有 ImageMagick 时原图内嵌。"""
    src = os.path.join(ctx.run_dir, rel)
    if not dp.path_safe(rel) or not dp.within(ctx.run_dir, src) or not os.path.isfile(src):
        return None, None
    ext = os.path.splitext(src)[1].lower()
    mime = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'}.get(ext, 'image/png')
    target_px = int(display_mm / 25.4 * 192)
    data_path = src
    mg = magick()
    if mg and ext in ('.png', '.jpg', '.jpeg', '.webp'):
        try:
            w = int(subprocess.run([mg, 'identify', '-format', '%w', src + '[0]'] if mg.endswith('magick') else ['identify', '-format', '%w', src],
                                   capture_output=True, text=True, timeout=30).stdout.strip() or 0)
        except (ValueError, subprocess.TimeoutExpired):
            w = 0
        if w > target_px > 0:
            cache = os.path.join(ctx.out_dir, '.cache'); os.makedirs(cache, exist_ok=True)
            h = hashlib.sha1(f'{src}:{os.path.getmtime(src)}:{target_px}'.encode()).hexdigest()[:16]
            out = os.path.join(cache, f'{h}{ext}')
            if not os.path.exists(out):
                args = [mg, src, '-resize', f'{target_px}x>', '-strip', out] if mg.endswith('magick') else [mg, src, '-resize', f'{target_px}x>', out]
                r = subprocess.run(args, capture_output=True, timeout=60)
                if r.returncode != 0: out = src
            data_path = out
    return f'data:{mime};base64,' + base64.b64encode(open(data_path, 'rb').read()).decode(), os.path.getsize(data_path)


def logo_for_print(ctx, width_px=600):
    """页眉模板里的图片 Chrome 会逐页重复嵌入：logo 先降采样到 width_px 宽（约 300 dpi 下 50 mm 宽）并缓存。没有 ImageMagick 时用原图。"""
    src = ctx.logo_path
    mg = magick()
    if not mg or src.endswith('.svg'):
        return src
    cache = os.path.join(os.path.expanduser('~'), '.cache', 'doc-render'); os.makedirs(cache, exist_ok=True)
    h = hashlib.sha1(f'{src}:{os.path.getmtime(src)}:{width_px}'.encode()).hexdigest()[:16]
    out = os.path.join(cache, f'logo-{h}.png')
    if not os.path.exists(out):
        args = [mg, src, '-resize', f'{width_px}x>', '-strip', out] if mg.endswith('magick') else [mg, src, '-resize', f'{width_px}x>', out]
        if subprocess.run(args, capture_output=True, timeout=60).returncode != 0 or not os.path.exists(out):
            return src
    return out


RE_LONG_TOKEN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_\-/.:]{11,}')


def wbr_html(escaped_segment_fn, s):
    """表格单元格里的长标识符（≥ 12 字符）只在 _ - / . : 之后允许断行（<wbr>）；中文与其他文字照常。"""
    out, pos = [], 0
    for m in RE_LONG_TOKEN.finditer(s):
        out.append(escaped_segment_fn(s[pos:m.start()]))
        out.append(re.sub(r'([_\-/.:])(?=[A-Za-z0-9])', r'\1<wbr>', escaped_segment_fn(m.group(0))))
        pos = m.end()
    out.append(escaped_segment_fn(s[pos:]))
    return ''.join(out)


def feishu_col_widths(ctx, b, total_px=820):
    """飞书列宽：widths 一律是权重（docmark.md §1），与 HTML 同样经 table_widths 归一化后映射到文档宽度。
    迁移期开关 ctx.legacy_widths_px（render.py --legacy-widths-px，与 --legacy-tilde 同类，只给迁移期类型包保持 golden 用）：
    作者给的 widths 全部 ≥ 20 时按像素原样输出（旧产物行为）。"""
    w = b.get('widths')
    if getattr(ctx, 'legacy_widths_px', False) and w and len(w) == len(b['header']) and min(w) >= 20:
        return [int(x) if float(x).is_integer() else round(x, 2) for x in w]
    pct, _ = table_widths(ctx, b)
    return [max(40, round(p / 100 * total_px)) for p in pct]
