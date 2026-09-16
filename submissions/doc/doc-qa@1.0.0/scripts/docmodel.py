#!/usr/bin/env python3
"""doc-qa 的文档模型适配层：只用共享解析器 doc-shared/scripts/docmark_parse.py，不自带第二套 DocMark 解析。

build() = docmark_parse.parse_file()（结构、诊断、锚点、实体、高亮）+ 质检需要的派生视图：
  code_mask / comment_mask   每行是否在围栏代码块 / 多行 HTML 注释内
  text_units()               T 规则检查单元（标题、段落、列表项、单元格、高亮块段落、图表题）的纯文本
  diag(rule)                 解析器诊断按规则编号取
其余属性（headings、blocks、tables、figures、anchors、refs、entities、highlights、section() 等）原样转发解析器 Document，
字段以解析器为准（pack-interface.md「doc」一节；docmark-ast.md 出来后以其为准）。

兼容点（唯一与解析器不同之处）：旧质检把白名单外、找不到的 include 写成 [[FORBIDDEN include: x]] / [[UNRESOLVED include: x]]
标记行，out/<源>.resolved.md 与 golden 逐字比对依赖它；解析器保留原注释。两者行数相同，doc.text / doc.lines 用标记版，
结构仍来自解析器。compat_marker_lines 记录被替换的行。"""
import importlib.util, os, re, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.dirname(os.path.dirname(HERE))
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
PARSER_ENTRY = os.path.join(DOC_SHARED, 'scripts', 'docmark_parse.py')

RE_INCLUDE = re.compile(r'<!--\s*include:\s*([^>]+?)\s*-->')
MAX_INCLUDE_DEPTH = 3  # 与共享解析器一致；depth 为记录的 1 起层数
RE_ATTRS_TAIL = re.compile(r'\s*\{([^{}]*)\}\s*$')
RE_INLINE_COMMENT = re.compile(r'<!--.*?-->')
FORBIDDEN_MARK = '[[FORBIDDEN include: {}]]'
UNRESOLVED_MARK = '[[UNRESOLVED include: {}]]'


class ParserUnavailable(RuntimeError):
    pass


_PARSER = None


def parser():
    global _PARSER
    if _PARSER is None:
        if not os.path.exists(PARSER_ENTRY):
            raise ParserUnavailable(f'共享解析器不存在：{PARSER_ENTRY}')
        spec = importlib.util.spec_from_file_location('docmark_parse', PARSER_ENTRY)
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
        except Exception as ex:
            raise ParserUnavailable(f'共享解析器导入失败：{type(ex).__name__}: {ex}')
        _PARSER = mod
    return _PARSER


def char_count(s):
    return len(re.sub(r'\s+', '', s))


def width_units(s):
    """汉字当量：全角（East Asian Wide / Fullwidth）计 1，其余计 0.5。"""
    return sum(1.0 if unicodedata.east_asian_width(ch) in ('W', 'F') else 0.5 for ch in s)


def plain_nodes(nodes):
    """typography.md「纯文本」：去 ** 与高亮符、链接只留文字、去锚点块；@引用与脚注引用属于例外区，去掉。"""
    out = []
    for n in nodes or []:
        t = n.get('t')
        if t == 'text': out.append(n['v'])
        elif t in ('bold', 'highlight', 'link'): out.append(plain_nodes(n.get('c')))
    return ''.join(out)


def _leftover_sequence(run_dir, pdoc):
    """展开后正文里仍留着的 include 注释，按出现顺序：forbidden / missing 记录本身，以及第 4 层原样插入的文件里的 include（占位 None）。
    解析器按先序记录 include；原样插入的文件（depth 达上限的记录，含 include 时状态为 too_deep）其内容紧跟在该记录的位置之后。"""
    seq = []
    for rec in pdoc.includes:
        st = rec.get('status')
        if st in ('forbidden', 'missing'):
            seq.append(rec)
        elif st == 'too_deep' or (st == 'ok' and rec.get('depth', 0) > MAX_INCLUDE_DEPTH):
            try:
                raw = open(os.path.join(run_dir, rec['target']), encoding='utf-8').read()
            except (OSError, UnicodeDecodeError):
                raw = ''
            seq.extend(None for _ in RE_INCLUDE.finditer(raw))
    return seq


def compat_resolved_text(run_dir, source_file, pdoc):
    """把解析器 includes 中 forbidden / missing 的注释替换为旧标记（与旧质检 resolve() 逐字一致）。
    按出现顺序配对：_leftover_sequence 给出正文里剩余 include 注释的完整序列（含第 4 层原样插入的占位），第 k 个注释对应第 k 项；
    target 对不上时说明序列推断失败，该项与之后的记录都不再标记，交 L1 按记录报。不依赖 line_origin。
    返回 (text, 改动的行号, 未能配对的记录)。"""
    seq = _leftover_sequence(run_dir, pdoc)
    bad = [x for x in seq if x is not None]
    if not bad:
        return pdoc.text, [], []
    k, broken, matched = 0, False, set()

    def rep(m):
        nonlocal k, broken
        tgt = m.group(1).strip()
        if broken or k >= len(seq):
            return m.group(0)
        item = seq[k]
        if item is not None and item['target'] != tgt:
            broken = True
            return m.group(0)
        k += 1
        if item is None:
            return m.group(0)
        matched.add(id(item))
        mark = (FORBIDDEN_MARK if item['status'] == 'forbidden' else UNRESOLVED_MARK).format(tgt)
        # 跨行注释：标记后补回被吞掉的换行，保持行号与解析器一致（旧脚本会把多行注释压成一行，这是唯一的有意差异）
        return mark + '\n' * m.group(0).count('\n')
    text = RE_INCLUDE.sub(rep, pdoc.text)
    old_lines, new_lines = pdoc.text.split('\n'), text.split('\n')
    changed = [i + 1 for i, (a, b) in enumerate(zip(old_lines, new_lines)) if a != b]
    return text, changed, [x for x in bad if id(x) not in matched]


class Doc:
    def __init__(self, pdoc, text, changed, run_dir, unmatched=None):
        self._p = pdoc
        self.compat_unmatched = unmatched or []
        self.run_dir = run_dir
        self.text = text
        self.lines = text.split('\n')
        self.compat_marker_lines = changed
        self.model_source = f'docmark_parse {getattr(pdoc, "version", "?")}'
        n = len(self.lines)
        self.code_mask = [False] * n
        for cb in pdoc.code_blocks:
            for k in range(cb['line'] - 1, min(cb.get('end_line', cb['line']), n)):
                self.code_mask[k] = True
        self.comment_mask = [False] * n
        i = 0
        while i < n:
            l = self.lines[i]
            if not self.code_mask[i] and l.lstrip().startswith('<!--'):
                j = i
                while j < n and '-->' not in self.lines[j]:
                    j += 1
                for k in range(i, min(j + 1, n)):
                    self.comment_mask[k] = True
                i = j + 1
                continue
            i += 1
        for h in pdoc.headings:
            raw = h.get('title_raw', h.get('title', ''))
            ma = RE_ATTRS_TAIL.search(raw)
            if ma and re.search(r'(^|\s)[#.]', ma.group(1)):
                raw = raw[:ma.start()].strip()
            h.setdefault('title_text', plain_nodes(pdoc_inline(raw)))

    def __getattr__(self, name):
        return getattr(self._p, name)

    def diag(self, *rules):
        return [d for d in self._p.diagnostics if d.get('rule') in rules]

    def text_units(self):
        """(kind, line, 纯文本, extra)。kind：title / heading / p / li / cell / callout / caption / footnote。"""
        p = self._p
        out = []
        if p.title:
            out.append(('title', p.title_line, plain_nodes(pdoc_inline(p.title)), None))
        for h in p.headings:
            out.append(('heading', h['line'], h['title_text'], h))
        for b in p.blocks:
            k = b['kind']
            if k == 'p':
                out.append(('p', b['line'], plain_nodes(b['inline']), b))
            elif k == 'callout':
                for sb in b.get('blocks') or []:
                    if sb['kind'] == 'p':
                        out.append(('callout', sb['line'], plain_nodes(sb['inline']), b))
            elif k in ('table', 'data') and not b.get('error'):
                if b.get('caption'):
                    out.append(('caption', b['line'], b['caption'], b))
                rl = b.get('row_lines') or []
                for ri, row in enumerate(b.get('rows_inline') or []):
                    line = rl[ri] if ri < len(rl) else b['line']
                    for ci, cell in enumerate(row):
                        col = b['header'][ci] if ci < len(b['header']) else ''
                        out.append(('cell', line, plain_nodes(cell), {'table': b, 'column': col, 'row': ri}))
            elif k in ('figure', 'image') and b.get('caption'):
                out.append(('caption', b['line'], plain_nodes(b.get('caption_inline')), b))
        for lst in p.lists:
            for it in lst['items']:
                out.append(('li', it['line'], plain_nodes(it.get('inline')), it))
        for fid, fn in (p.footnotes or {}).items():
            out.append(('footnote', fn['line'], plain_nodes(fn.get('inline')), fn))
        # 例外区：行内 HTML 注释（解析器把段内注释留在文本里）不参与 T 规则与 X4
        out = [(k, ln, RE_INLINE_COMMENT.sub('', t) if t and '<!--' in t else t, ex) for k, ln, t, ex in out]
        out.sort(key=lambda x: x[1])
        return out


def pdoc_inline(s):
    from_parser = parser()

    class _D:
        def add(self, *a, **k):
            return {}
    return from_parser.parse_inline(s, 0, _D())


def _validate():
    import sys
    scripts = os.path.join(DOC_SHARED, 'scripts')
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import validate
    return validate


def _field_value(data, field):
    """点号路径取值：(路径完整存在且值非空, 值)。转发 validate.field_value。"""
    return _validate().field_value(data, field)


def mode_meta(run_dir, pack, meta, meta_file=None):
    """取 mode 用的元数据（字段路径优先、不全时回退运行目录 brief.json）。已上移 doc-shared/scripts/validate.mode_meta（2026-09-15 W3-H），
    与 validate.resolve_mode(pack, meta, run_dir=…) 同一实现，这里只转发。"""
    return _validate().mode_meta(run_dir, pack, meta, meta_file)


def mode_skeleton(run_dir, pack, meta, meta_file=None):
    """返回 (mode id 或 None, 该 mode 打完补丁的 skeleton, 配置错误文本或 None)。
    pack 没有 modes 时返回基础 skeleton；mode 值无法识别时返回基础 skeleton 与错误（调用方报配置错误，不静默回落）。"""
    base = list((pack or {}).get('skeleton') or [])
    if not (pack or {}).get('modes'):
        return None, base, None
    import sys
    scripts = os.path.join(DOC_SHARED, 'scripts')
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import validate
    src = mode_meta(run_dir, pack, meta, meta_file)
    try:
        mid = validate.resolve_mode(pack, meta, run_dir=run_dir, meta_file=meta_file)   # 与 mode_meta 同一实现（src 即其选出的元数据）
        return mid, validate.resolve_skeleton(pack, mid), None
    except (validate.ModeError, KeyError) as ex:
        return None, base, str(ex)


def build(run_dir, pack, source_file=None, meta=None, meta_file=None):
    """meta 为元数据文件内容（doc.json / brief.json）：pack 声明 modes 时按 mode 取骨架交给解析器，
    headings.skeleton_id、doc.section() 与 S1 都按该 mode 的骨架（validate.resolve_mode / resolve_skeleton）。"""
    run_dir = os.path.abspath(run_dir)
    source_file = source_file or pack.get('source_file', 'doc.md')
    mode, skeleton, mode_error = mode_skeleton(run_dir, pack, meta, meta_file)
    parse_pack = pack
    if pack.get('modes') and mode is not None:
        parse_pack = dict(pack, skeleton=skeleton)
    dp = parser()
    pdoc = dp.parse_file(run_dir, source_file, pack=parse_pack)
    text, changed, unmatched = compat_resolved_text(run_dir, source_file, pdoc)
    doc = Doc(pdoc, text, changed, run_dir, unmatched)
    doc.mode, doc.skeleton, doc.mode_error = mode, skeleton, mode_error
    return doc
