#!/usr/bin/env python3
"""DocMark 共用解析器（doc-render 与 doc-qa 同一份；接口见 references/docmark-ast.md）。
纯标准库。解析器只报「事实」（diagnostics），不写 qa-result、不决定定级去留；doc-qa 负责把诊断转成问题，doc-render 只把版式事实写进 render.json。

用法（CLI，调试与给质检看 AST）：
  docmark_parse.py <运行目录> [--source doc.md] [--pack <pack.json 或类型包目录>] [--json] [--resolved-out 文件]
库：
  from docmark_parse import parse_file, parse_text
  doc = parse_file(run_dir, 'doc.md', pack=pack_dict)
退出码（CLI）：0 无 error 级诊断；1 有 error 级诊断；2 用法或读文件错误。"""
import csv, fnmatch, io, json, os, re, sys, math

VERSION = '1.0'

# ---------------------------------------------------------------- 常量
IMG_EXT = ('.png', '.jpg', '.jpeg', '.webp', '.gif')
CALLOUT_KINDS = ('note', 'warn', 'tip', 'decision', 'risk')
DEFAULT_INCLUDE_ALLOW = ['sections/*.md']
DEFAULT_INCLUDE_DENY = ['*internal*']
MAX_INCLUDE_DEPTH = 3
ANCHOR_ID = r'[A-Za-z0-9_-]+'
HL_OPEN, HL_CLOSE = '⟪', '⟫'  # ⟪ ⟫
# 重点高亮的可选单字符颜色前缀（紧跟 ⟪，不留空格）→ tokens callout 表的 kind。
# 'neutral' = 无前缀，沿用原默认色（callout.note 同色系，tokens color.tint）。
HL_PREFIX = {'!': 'risk', '+': 'tip', '~': 'warn', '?': 'decision'}
HL_KIND_CALLOUT = {'neutral': 'note', 'risk': 'risk', 'tip': 'tip', 'warn': 'warn', 'decision': 'decision'}

# features 缺省（无类型包时宽松：新语法全部可用；code_blocks 不拦截）
FEATURE_DEFAULTS = {'code_blocks': None, 'landscape': True, 'data_blocks': True, 'summary_block': True,
                    'footnotes': True, 'h1_new_page': None, 'toc': True, 'table_captions': True,
                    'figure_numbers': True, 'thead_repeat': True}

RE_INCLUDE = re.compile(r'<!--\s*include:\s*([^>]+?)\s*-->')
RE_COMMENT_LINE = re.compile(r'^<!--(.*?)-->\s*$')
RE_HEADING = re.compile(r'^(#{2,5})\s+(.*)$')
RE_ATTRS_TAIL = re.compile(r'\s*\{([^{}]*)\}\s*$')
RE_FIG = re.compile(r'^!\[(.*?)\]\((.*?)\)(.*)$')
RE_LIST = re.compile(r'^( *)(- |\d+\. )(.*)$')
RE_FENCE = re.compile(r'^\s*```\s*([^\s`]*)\s*(.*)$')
RE_FOOTDEF = re.compile(r'^\[\^([^\]\s]+)\]:\s*(.*)$')
RE_CALLOUT = re.compile(r'^>\s*\[!([A-Za-z]+)\]\s*(.*)$')
RE_SEP_CELL = re.compile(r'^:?-{2,}:?$')
RE_PARA_STOP = re.compile(r'^(#|\||- |\d+\. |>|!\[|<!--|```)')
RE_REF = re.compile(r'(?<![A-Za-z0-9_.@])@([a-z][a-z0-9_]*):(' + ANCHOR_ID + ')')
RE_INLINE_ANCHOR = re.compile(r'\{#([a-z][a-z0-9_]*):(' + ANCHOR_ID + r')\}')
RE_LINK = re.compile(r'\[([^\[\]]*)\]\(([^()\s]*)\)')
RE_FNREF = re.compile(r'\[\^([^\]\s]+)\]')
RE_BOLD = re.compile(r'\*\*(.+?)\*\*')
RE_HTML_TAG = re.compile(r'</?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?/?>')
INLINE_CORE = re.compile(r'(?P<link>\[(?P<lt>[^\[\]]*)\]\((?P<lu>[^()\s]*)\))|(?P<fn>\[\^(?P<fid>[^\]\s]+)\])|(?P<ref>(?<![A-Za-z0-9_.@])@(?P<rk>[a-z][a-z0-9_]*):(?P<rid>' + ANCHOR_ID + r'))|(?P<bold>\*\*(?P<bt>.+?)\*\*)')
RE_ENTITY_PH = re.compile(r'\{(chapter|seq|章|序)\}')

SEV = {'error': 'error', 'warning': 'warning', 'info': 'info'}


# ---------------------------------------------------------------- 工具
def _latin(ch):
    return bool(ch) and (ch.isascii() and ch.isalnum())


def join_lines(parts):
    """续行拼接：前一行末字符与后一行首字符都是拉丁字母或数字时插入一个空格，否则直接拼接（docmark.md §4）。
    返回 (text, joins)，joins 为每个续行在拼接结果里的起始偏移。"""
    out, joins = '', []
    for i, p in enumerate(parts):
        if i and out and p and _latin(out[-1]) and _latin(p[0]):
            out += ' '
        if i: joins.append(len(out))
        out += p
    return out, joins


def engine_for(src):
    s = src.lower().split('?')[0]
    if s.endswith('.fig.json'): return 'svgkit'
    if s.endswith('.mmd'): return 'mermaid'
    if s.endswith('.dot'): return 'graphviz'
    if s.endswith('.svg'): return 'svg'
    if s.endswith(IMG_EXT): return 'image'
    return None


def svg_path_for(src):
    """图源 → build 后的 SVG 路径（运行目录相对）；位图返回 None。"""
    e = engine_for(src)
    if e == 'svgkit': return src[:-len('.fig.json')] + '.svg'
    if e in ('mermaid', 'graphviz'): return src.rsplit('.', 1)[0] + '.svg'
    if e == 'svg': return src
    return None


def figure_files(src):
    """图源及渲染会读取的派生文件（build 后的 .svg、doc-figures 的 .png），运行目录相对路径。"""
    out = [src]
    sv = svg_path_for(src)
    if sv and sv not in out: out.append(sv)
    if engine_for(src) not in ('image', None):
        base = src[:-len('.fig.json')] if src.endswith('.fig.json') else os.path.splitext(src)[0]
        if base + '.png' not in out: out.append(base + '.png')
    return out


def safe_source(run_dir, rel):
    """正文、include、数据文件：相对路径不含 ..，且 realpath 在运行目录内（符号链接指向外部时为 False）。"""
    return path_safe(rel) and within(run_dir, os.path.join(run_dir, rel))


class SourcePathError(PermissionError):
    """正文源文件越出运行目录（含符号链接）。是 OSError 子类，与「源文件读不出才抛」的约定一致。"""


def format_number(template, chapter, seq):
    return RE_ENTITY_PH.sub(lambda m: str(chapter if m.group(1) in ('chapter', '章') else seq), template)


def alpha(n):
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s


def char_count(s):
    return len(re.sub(r'\s', '', s))


def parse_args_str(s):
    """数据块参数：key=value，值可用英文双引号包住。返回 (positional[], [(key, value)])。"""
    pos, kv = [], []
    for m in re.finditer(r'(?:([A-Za-z_][\w-]*)=)?("([^"]*)"|\S+)', s):
        key, raw, quoted = m.group(1), m.group(2), m.group(3)
        val = quoted if quoted is not None else raw
        if key: kv.append((key, val))
        else: pos.append(val)
    return pos, kv


def path_safe(rel):
    rel = rel.strip()
    if not rel or os.path.isabs(rel) or rel.startswith('~'): return False
    return '..' not in rel.replace('\\', '/').split('/')


def within(root, path):
    r = os.path.realpath(root); p = os.path.realpath(path)
    return p == r or p.startswith(r + os.sep)


# ---------------------------------------------------------------- 行内
def _plain(nodes):
    out = []
    for n in nodes:
        t = n['t']
        if t == 'text': out.append(n['v'])
        elif t in ('bold', 'highlight', 'link'): out.append(_plain(n['c']))
        elif t == 'ref': out.append(n.get('label') or '@' + n['target'])
        elif t == 'fnref': out.append('')
    return ''.join(out)


def inline_plain(nodes):
    """纯文本（typography.md「纯文本」口径：去 ** 与高亮符、链接只留文字、去锚点块、引用给渲染文字）。"""
    return _plain(nodes)


class Diag:
    def __init__(self):
        self.items = []

    def add(self, code, severity, line, message, rule=None, **extra):
        d = {'code': code, 'rule': rule, 'severity': severity, 'line': line, 'message': message}
        d.update(extra)
        self.items.append(d)
        return d


def parse_inline(text, line, diag, ctx=None, joins=None, context='p', highlights=None, anchors_out=None):
    """把一段 DocMark 行内文字解析为节点列表。
    节点：{t:text,v} {t:bold,c} {t:highlight,c} {t:link,url,c} {t:ref,target,kind,id} {t:fnref,id}
    joins：续行在 text 中的起始偏移（判断高亮跨行）；joins 下标 k 对应源行 line+k+1。"""
    joins = joins or []

    def line_at(off):
        k = 0
        for j in joins:
            if off >= j: k += 1
        return line + k

    # 1) 反引号：旧渲染器删除反引号，兼容保留该行为并记诊断（T9 / L2 由 doc-qa 定级）
    if '`' in text:
        diag.add('inline-code', 'warning', line_at(text.index('`')), '行内代码格式（反引号）不支持，渲染时去掉反引号', rule='T9')
        # 保持偏移：用零宽替换会打乱 joins，这里先记位置再删
        new, newjoins, removed = [], [], 0
        jset = list(joins)
        for i, ch in enumerate(text):
            while jset and jset[0] == i:
                newjoins.append(i - removed); jset.pop(0)
            if ch == '`': removed += 1; continue
            new.append(ch)
        newjoins += [len(new)] * len(jset)
        text, joins = ''.join(new), newjoins
    # 2) 行内锚点 {#kind:id}
    if anchors_out is not None:
        for m in RE_INLINE_ANCHOR.finditer(text):
            anchors_out.append({'kind': m.group(1), 'id': m.group(2), 'line': line_at(m.start())})
    # 3) 高亮分段（不嵌套、不跨行、未闭合报错；非法分隔符一律丢弃，保证渲染不泄漏 ⟪ ⟫）
    segs, buf, open_at, open_line = [], [], None, None
    i = 0
    drop = set()
    stack = []
    for i, ch in enumerate(text):
        if ch == HL_OPEN:
            if open_at is not None:
                diag.add('highlight-nested', 'error', line_at(i), '重点高亮 ⟪…⟫ 不允许嵌套', rule='HL1')
                drop.add(i)
            else:
                open_at = i
        elif ch == HL_CLOSE:
            if open_at is None:
                diag.add('highlight-unopened', 'error', line_at(i), '重点高亮缺少开头 ⟪', rule='HL1')
                drop.add(i)
            elif line_at(open_at) != line_at(i):
                diag.add('highlight-multiline', 'error', line_at(open_at), '重点高亮 ⟪…⟫ 不能跨行', rule='HL1')
                drop.add(open_at); drop.add(i); open_at = None
            else:
                stack.append((open_at, i)); open_at = None
    if open_at is not None:
        diag.add('highlight-unclosed', 'error', line_at(open_at), '重点高亮 ⟪ 未闭合', rule='HL1')
        drop.add(open_at)
    pairs = {a: b for a, b in stack}
    pos = 0; plain_start = 0
    nodes = []
    k = 0
    while k < len(text):
        if k in pairs:
            if k > plain_start:
                nodes += _inline_core(''.join(c for j, c in enumerate(text[plain_start:k], plain_start) if j not in drop), line, ctx)
            end = pairs[k]
            # 可选单字符颜色前缀：紧跟 ⟪、不留空格、只认 HL_PREFIX 四个字符；其余情况（含无前缀）
            # 一律 neutral，且该字符原样留在内容里（不吞字符）。前缀本身不进入内容与字数统计。
            hs = k + 1
            kind = 'neutral'
            if hs < end and hs not in drop:
                pk = HL_PREFIX.get(text[hs])
                if pk: kind = pk; hs += 1
            inner_raw = ''.join(c for j, c in enumerate(text[hs:end], hs) if j not in drop and c not in (HL_OPEN, HL_CLOSE))
            inner = _inline_core(inner_raw, line_at(k), ctx)
            hn = {'t': 'highlight', 'kind': kind, 'c': inner}
            nodes.append(hn)
            if highlights is not None:
                pt = _plain(inner)
                highlights.append({'line': line_at(k), 'text': pt, 'length': char_count(pt), 'context': context, 'kind': kind})
            if not pt_ok(inner_raw):
                diag.add('highlight-empty', 'warning', line_at(k), '重点高亮内容为空', rule='HL1')
            k = end + 1; plain_start = k
            continue
        k += 1
    if plain_start < len(text):
        nodes += _inline_core(''.join(c for j, c in enumerate(text[plain_start:], plain_start) if j not in drop), line, ctx)
    return _merge_text(nodes)


def pt_ok(s):
    return bool(s.strip())


def _merge_text(nodes):
    out = []
    for n in nodes:
        if n['t'] == 'text' and out and out[-1]['t'] == 'text':
            out[-1] = {'t': 'text', 'v': out[-1]['v'] + n['v']}
        elif n['t'] == 'text' and n['v'] == '':
            continue
        else:
            out.append(n)
    return out


ANCHOR_MARK = re.compile('\ue000(\\d+)\ue001')


def _inline_core(s, line, ctx, anchors=None):
    """链接、脚注引用、交叉引用、加粗。行内锚点块从文字中去掉，位置保留为 {t: anchor} 节点（1.3）。"""
    top = anchors is None
    if top:
        anchors = []
        def keep(m):
            anchors.append((m.group(1), m.group(2)))
            return '\ue000%d\ue001' % (len(anchors) - 1)
        s = RE_INLINE_ANCHOR.sub(keep, s)
    tokens = []
    pattern = INLINE_CORE
    pos = 0
    for m in pattern.finditer(s):
        if m.start() > pos: tokens.append({'t': 'text', 'v': s[pos:m.start()]})
        if m.group('fn'):
            tokens.append({'t': 'fnref', 'id': m.group('fid'), 'line': line})
        elif m.group('link'):
            tokens.append({'t': 'link', 'url': ANCHOR_MARK.sub('', m.group('lu')), 'c': _inline_core(m.group('lt'), line, ctx, anchors), 'line': line})
        elif m.group('ref'):
            kind, aid = m.group('rk'), m.group('rid')
            tokens.append({'t': 'ref', 'target': f'{kind}:{aid}', 'kind': kind, 'id': aid, 'line': line})
        elif m.group('bold'):
            tokens.append({'t': 'bold', 'c': _inline_core(m.group('bt'), line, ctx, anchors)})
        pos = m.end()
    if pos < len(s): tokens.append({'t': 'text', 'v': s[pos:]})
    out = []
    for tk in tokens:
        if tk['t'] != 'text' or '\ue000' not in tk['v']:
            out.append(tk); continue
        parts = ANCHOR_MARK.split(tk['v'])
        for j, part in enumerate(parts):
            if j % 2 == 0:
                if part: out.append({'t': 'text', 'v': part})
            else:
                kind, aid = anchors[int(part)]
                out.append({'t': 'anchor', 'target': f'{kind}:{aid}', 'kind': kind, 'id': aid, 'line': line})
    return _merge_text(out)


def walk_inline(nodes):
    for n in nodes:
        yield n
        if 'c' in n: yield from walk_inline(n['c'])


# ---------------------------------------------------------------- include 展开
def expand_includes(run_dir, source_file, allow, deny, diag):
    """与旧渲染器逐字一致的 include 展开（第 4 层起按原文插入，不再展开）。
    返回 (text, line_origin, includes)。includes 与诊断的 line 是展开后正文行号，source_line / file 是指令所在文件的行号。"""
    includes, chunks = [], []
    state = {'nl': 0}

    def emit(t, f, ln):
        if t:
            chunks.append((t, f, ln)); state['nl'] += t.count('\n')

    def resolve(path, rel_name, depth):
        txt = open(path, encoding='utf-8').read()
        pos = 0
        for m in RE_INCLUDE.finditer(txt):
            emit(txt[pos:m.start()], rel_name, txt.count('\n', 0, pos) + 1)
            src_line = txt.count('\n', 0, m.start()) + 1
            exp_line = state['nl'] + 1
            rel = m.group(1).strip()
            full = os.path.join(run_dir, rel)
            status, reason = 'ok', ''
            if not path_safe(rel):
                status, reason = 'forbidden', '绝对路径或含 ..'
            elif not any(fnmatch.fnmatchcase(rel, g) for g in allow):
                status, reason = 'forbidden', '不在类型包 include_allow 白名单'
            elif any(fnmatch.fnmatchcase(rel, g) or fnmatch.fnmatchcase(rel.lower(), g.lower()) for g in deny):
                status, reason = 'forbidden', '命中 include_deny'
            elif not within(run_dir, full):
                status, reason = 'forbidden', '越出运行目录（含符号链接指向外部）'
            elif not os.path.isfile(full):
                status, reason = 'missing', '文件不存在'
            rec = {'target': rel, 'line': exp_line, 'source_line': src_line, 'file': rel_name, 'status': status, 'depth': depth + 1}
            if reason: rec['reason'] = reason
            includes.append(rec)
            if status != 'ok':
                diag.add('include-' + status, 'error', exp_line, f'include {rel}：{reason}', rule='L1', file=rel_name, source_line=src_line)
                emit(m.group(0), rel_name, src_line)
            elif depth < MAX_INCLUDE_DEPTH:
                resolve(full, rel, depth + 1)
            else:
                raw = open(full, encoding='utf-8').read()
                if RE_INCLUDE.search(raw):
                    rec['status'] = 'too_deep'
                    diag.add('include-too_deep', 'error', exp_line, f'include 嵌套超过 {MAX_INCLUDE_DEPTH} 层，{rel} 内的 include 未展开', rule='L1', file=rel_name, source_line=src_line)
                emit(raw, rel, 1)
            pos = m.end()
        emit(txt[pos:], rel_name, txt.count('\n', 0, pos) + 1)

    resolve(os.path.join(run_dir, source_file), source_file, 0)
    text = ''.join(c[0] for c in chunks)
    origin, at_start = [], True
    for chunk, f, ln in chunks:
        parts = chunk.split('\n')
        for k, part in enumerate(parts):
            if k > 0: at_start = True
            if at_start and (part != '' or k < len(parts) - 1):
                origin.append((f, ln + k)); at_start = False
    n_lines = text.count('\n') + 1
    while len(origin) < n_lines: origin.append(origin[-1] if origin else (source_file, 1))
    return text, origin[:n_lines], includes


# ---------------------------------------------------------------- Document
class Document:
    """DocMark 文档模型（只读）。字段见 references/docmark-ast.md 与 pack-interface.md §4。"""

    def __init__(self):
        self.version = VERSION
        self.source_file = 'doc.md'
        self.run_dir = None
        self.raw = ''
        self.raw_lines = []
        self.text = ''
        self.lines = []
        self.line_origin = []
        self.title = ''
        self.title_line = 0
        self.headings = []
        self.blocks = []
        self.tables = []
        self.figures = []
        self.code_blocks = []
        self.callouts = []
        self.lists = []
        self.links = []
        self.footnotes = {}
        self.footnote_refs = []
        self.anchors = {}
        self.refs = []
        self.entities = {}
        self.entity_mentions = {}
        self.includes = []
        self.highlights = []
        self.diagnostics = []
        self.features = dict(FEATURE_DEFAULTS)
        self.numbering = {}

    # -- 查询
    def section(self, key):
        key = str(key)
        k2 = key[4:] if key.startswith('sec:') else key
        idx = None
        for i, h in enumerate(self.headings):
            if h.get('skeleton_id') == k2 or h.get('anchor') in (key, 'sec:' + k2) or h.get('number') == key:
                idx = i; break
        if idx is None: return None
        h = self.headings[idx]
        end = len(self.lines)
        for h2 in self.headings[idx + 1:]:
            if h2['level'] <= h['level']:
                end = h2['line'] - 1; break
        blocks = [b for b in self.blocks if h['line'] < b['line'] <= end]
        return {'heading': h, 'start': h['line'], 'end': end, 'text': '\n'.join(self.lines[h['line'] - 1:end]), 'blocks': blocks}

    def errors(self):
        return [d for d in self.diagnostics if d['severity'] == 'error']

    def resolve_ref(self, target):
        return self.anchors.get(target)

    def to_dict(self):
        keys = ['version', 'source_file', 'title', 'title_line', 'headings', 'blocks', 'tables', 'figures', 'code_blocks',
                'callouts', 'lists', 'links', 'footnotes', 'footnote_refs', 'anchors', 'refs', 'entities', 'entity_mentions',
                'includes', 'highlights', 'diagnostics', 'features', 'numbering']
        d = {k: getattr(self, k) for k in keys}
        d['line_origin'] = [list(x) for x in self.line_origin]
        d['lines'] = len(self.lines)
        return d


# ---------------------------------------------------------------- 主解析
def parse_file(run_dir, source_file='doc.md', pack=None, include_allow=None, include_deny=None):
    run_dir = os.path.abspath(os.path.expanduser(run_dir))
    diag = Diag()
    allow = include_allow if include_allow is not None else (pack.get('include_allow') if pack and pack.get('include_allow') is not None else DEFAULT_INCLUDE_ALLOW)
    deny = include_deny if include_deny is not None else (pack.get('include_deny') if pack and pack.get('include_deny') is not None else (DEFAULT_INCLUDE_DENY if not pack else []))
    if not safe_source(run_dir, source_file):
        raise SourcePathError(f'正文文件必须在运行目录内（不含 ..、绝对路径或指向外部的符号链接）：{source_file}')
    raw = open(os.path.join(run_dir, source_file), encoding='utf-8').read()
    text, origin, includes = expand_includes(run_dir, source_file, allow, deny or [], diag)
    doc = _parse(text, pack, diag, run_dir=run_dir, source_file=source_file, origin=origin)
    doc.raw = raw; doc.raw_lines = raw.split('\n'); doc.includes = includes
    doc.diagnostics = sorted(diag.items, key=lambda d: (d['line'] or 0))
    return doc


def parse_text(text, pack=None, run_dir=None, source_file='doc.md'):
    """不展开 include（include 指令原样保留并记 status=unresolved）；data 块相对 run_dir 读取。"""
    diag = Diag()
    doc = _parse(text, pack, diag, run_dir=os.path.abspath(run_dir) if run_dir else None, source_file=source_file,
                 origin=[(source_file, i + 1) for i in range(len(text.split('\n')))])
    doc.raw = text; doc.raw_lines = text.split('\n')
    for m in RE_INCLUDE.finditer(text):
        doc.includes.append({'target': m.group(1).strip(), 'line': text.count('\n', 0, m.start()) + 1, 'file': source_file, 'status': 'unresolved', 'depth': 1})
    doc.diagnostics = sorted(diag.items, key=lambda d: (d['line'] or 0))
    return doc


def _parse(text, pack, diag, run_dir=None, source_file='doc.md', origin=None):
    doc = Document()
    doc.run_dir = run_dir; doc.source_file = source_file
    doc.text = text; doc.lines = text.split('\n'); doc.line_origin = origin or []
    feats = dict(FEATURE_DEFAULTS)
    if pack and isinstance(pack.get('features'), dict): feats.update({k: v for k, v in pack['features'].items()})
    doc.features = feats
    numbering = {'section': 'decimal', 'appendix': 'alpha', 'max_depth': 3, 'figure': '图 {chapter}-{seq}', 'table': '表 {chapter}-{seq}', 'entities': []}
    if pack and isinstance(pack.get('numbering'), dict): numbering.update(pack['numbering'])
    doc.numbering = numbering
    entity_defs = [e for e in numbering.get('entities') or [] if e.get('kind') and e.get('pattern')]
    skeleton = (pack or {}).get('skeleton') or []

    P = _Parser(doc, diag, feats, numbering, run_dir)
    P.run()
    _number_and_link(doc, diag, feats, numbering, skeleton, entity_defs)
    return doc


class _Parser:
    def __init__(self, doc, diag, feats, numbering, run_dir):
        self.doc, self.diag, self.feats, self.numbering, self.run_dir = doc, diag, feats, numbering, run_dir
        self.L = doc.lines
        self.pending_widths = None; self.pending_widths_line = 0
        self.pending_table = None
        self.grid = None; self.grid_seq = 0
        self.in_summary = False; self.summary_line = 0
        self.in_landscape = False; self.landscape_line = 0
        self.section_number = ''
        self.inline_anchors = []
        self.entity_kinds = {e.get('kind') for e in (numbering.get('entities') or []) if e.get('kind')}

    # -- 公共
    def add_block(self, b):
        b.setdefault('section_number', None)
        b['in_summary'] = self.in_summary
        b['in_landscape'] = self.in_landscape
        if self.grid is not None and b['kind'] in ('figure', 'image'):
            b['grid'] = self.grid['id']
        elif self.grid is not None and b['kind'] != 'grid':
            self.diag.add('grid-child', 'error', b['line'], 'grid 内只能放图片或图；其他内容按 grid 之前的正文渲染（与旧渲染器一致）', rule='L1')
        self.doc.blocks.append(b)
        return b

    def inl(self, text, line, joins=None, context='p'):
        return parse_inline(text, line, self.diag, joins=joins, context=context, highlights=self.doc.highlights, anchors_out=self.inline_anchors)

    def html_check(self, s, line):
        for m in RE_HTML_TAG.finditer(s):
            self.diag.add('html-tag', 'error', line, f'不支持 HTML 标签：{m.group(0)[:40]}', rule='L1')
            break

    # -- 主循环
    def run(self):
        L = self.L; i = 0; n = len(L)
        while i < n:
            raw = L[i]; l = raw.rstrip(); ln = i + 1
            s = l.strip()
            # 注释指令
            if l.startswith('<!--'):
                if '-->' not in l:
                    j = i + 1
                    while j < n and '-->' not in L[j]: j += 1
                    i = j + 1; continue
                m = RE_COMMENT_LINE.match(l)
                body = (m.group(1) if m else l[4:l.index('-->')]).strip()
                self.directive(body, ln)
                i += 1; continue
            if not s:
                i += 1; continue
            if (self.pending_table or self.pending_widths is not None) and not s.startswith('|'):
                self.dangling(ln)
            # 文档标题
            if l.startswith('# '):
                if not self.doc.title:
                    self.doc.title = l[2:].strip(); self.doc.title_line = ln
                    self.html_check(self.doc.title, ln)
                    i += 1; continue
                self.diag.add('title-duplicate', 'warning', ln, '文档标题（# ）只能出现一次；按段落处理', rule='S2')
            # 围栏代码块
            mf = RE_FENCE.match(l)
            if mf and s.startswith('```'):
                i = self.code(i); continue
            mh = RE_HEADING.match(l)
            if mh and not l.startswith('# '):
                self.heading(mh, ln); i += 1; continue
            mc = RE_CALLOUT.match(l)
            if mc:
                i = self.callout(i, mc); continue
            mfd = RE_FOOTDEF.match(l)
            if mfd:
                i = self.footdef(i, mfd); continue
            mg = RE_FIG.match(l)
            if mg:
                self.figure(mg, ln); i += 1; continue
            if s.startswith('|'):
                i = self.table(i); continue
            if RE_LIST.match(l) and not l.startswith(' '):
                i = self.lst(i); continue
            i = self.para(i)
        if self.in_summary:
            self.diag.add('summary-unclosed', 'error', self.summary_line, 'summary 块缺少 <!-- /summary -->', rule='L1')
        if self.in_landscape:
            self.diag.add('landscape-unclosed', 'error', self.landscape_line, 'landscape 段缺少 <!-- /landscape -->', rule='L1')
        if self.grid is not None:
            self.diag.add('grid-unclosed', 'error', self.grid['line'], 'grid 缺少 <!-- /grid -->', rule='L1')
            self.close_grid(self.grid['line'])
        if self.pending_table or self.pending_widths:
            ln = (self.pending_table or {}).get('line') or self.pending_widths_line
            self.diag.add('directive-dangling', 'warning', ln, 'table / widths 注释之后没有表格', rule='L7')
        if not self.doc.title:
            self.diag.add('title-missing', 'error', 1, '缺少文档标题（第一行 # 标题）', rule='S2')
        self.doc._inline_anchors = self.inline_anchors

    # -- 指令
    def directive(self, body, ln):
        name, _, rest = body.partition(':')
        name = name.strip(); rest = rest.strip()
        low = body.strip()
        if name not in ('widths', 'table') and (self.pending_table or self.pending_widths is not None):
            self.dangling(ln)
        if name == 'include':
            return  # 已由 expand_includes 处理；未展开的留在 includes 与诊断里
        if name == 'widths':
            try:
                w = [float(x) for x in rest.split(',') if x.strip()]
                if not w or any(not math.isfinite(x) or x <= 0 for x in w): raise ValueError
                self.pending_widths = w; self.pending_widths_line = ln
            except ValueError:
                self.pending_widths = None; self.pending_widths_line = None   # 非法 widths 不能继承之前挂起的合法值
                self.diag.add('widths-invalid', 'error', ln, f'widths 只能是正数列表：{rest[:40]}', rule='L7')
            return
        if name == 'table':
            cap = rest; anchor = None
            ma = RE_ATTRS_TAIL.search(cap)
            if ma and '#' in ma.group(1):
                anchor = self.attr_anchor(ma.group(1), ln, expect='tbl'); cap = cap[:ma.start()].strip()
            self.pending_table = {'caption': cap, 'anchor': anchor, 'line': ln}
            return
        if name == 'data':
            self.data(rest, ln); return
        if name == 'grid':
            try: cols = int(rest)
            except ValueError: cols = 0
            if cols not in (2, 3):
                self.diag.add('grid-invalid', 'error', ln, 'grid 列数只能是 2 或 3', rule='L1'); cols = 2
            if self.grid is not None:
                self.diag.add('grid-nested', 'error', ln, 'grid 不能嵌套', rule='L1'); self.close_grid(ln)
            self.grid_seq += 1
            self.grid = {'id': self.grid_seq, 'cols': cols, 'line': ln}
            self.add_block({'kind': 'grid', 'edge': 'start', 'cols': cols, 'grid': self.grid_seq, 'line': ln, 'section_number': self.section_number})
            return
        if low == '/grid':
            if self.grid is None: self.diag.add('grid-unopened', 'error', ln, '<!-- /grid --> 没有对应的开始标记', rule='L1')
            else: self.close_grid(ln)
            return
        if low == 'pagebreak':
            self.add_block({'kind': 'pagebreak', 'line': ln, 'section_number': self.section_number}); return
        if low in ('summary', '/summary'):
            opening = low == 'summary'
            if opening == self.in_summary:
                self.diag.add('summary-unbalanced', 'error', ln, 'summary 开始 / 结束标记不成对', rule='L1'); return
            if opening and self.feats.get('summary_block') is False:
                self.diag.add('feature-disabled', 'error', ln, '类型包未开启 summary_block', rule='L1', feature='summary_block')
            if opening:
                if any(b['kind'] == 'summary' for b in self.doc.blocks):
                    self.diag.add('summary-duplicate', 'error', ln, 'summary 块只能有一个', rule='L1')
                self.in_summary = True; self.summary_line = ln
                self.add_block({'kind': 'summary', 'edge': 'start', 'line': ln, 'section_number': self.section_number})
            else:
                self.add_block({'kind': 'summary', 'edge': 'end', 'line': ln, 'section_number': self.section_number})
                self.in_summary = False
            return
        if low in ('landscape', '/landscape'):
            opening = low == 'landscape'
            if opening == self.in_landscape:
                self.diag.add('landscape-unbalanced', 'error', ln, 'landscape 开始 / 结束标记不成对', rule='L1'); return
            if opening and self.feats.get('landscape') is False:
                self.diag.add('feature-disabled', 'error', ln, '类型包未开启 landscape', rule='L1', feature='landscape')
            if opening:
                self.add_block({'kind': 'landscape', 'edge': 'start', 'line': ln, 'section_number': self.section_number})
                self.in_landscape = True; self.landscape_line = ln
            else:
                self.in_landscape = False
                self.add_block({'kind': 'landscape', 'edge': 'end', 'line': ln, 'section_number': self.section_number})
            return
        # 其他注释：旧渲染器忽略，这里同样忽略（不报）

    def dangling(self, ln):
        at = (self.pending_table or {}).get('line') or self.pending_widths_line
        self.diag.add('directive-dangling', 'warning', at, f'table / widths 注释必须紧挨表格上一行（第 {ln} 行不是表格），已忽略该注释', rule='L7')
        self.pending_table = None; self.pending_widths = None

    def close_grid(self, ln):
        self.add_block({'kind': 'grid', 'edge': 'end', 'cols': self.grid['cols'], 'grid': self.grid['id'], 'line': ln, 'section_number': self.section_number})
        self.grid = None

    def attr_anchor(self, attrs, ln, expect):
        """标题只收 sec:（类型包声明的实体锚点转为行内锚点），图只收 fig:，表只收 tbl:；类型不符报 error 并丢弃。"""
        anchor = None
        for tok in attrs.split():
            if tok.startswith('#'):
                m = re.fullmatch(r'#([a-z][a-z0-9_]*):(' + ANCHOR_ID + ')', tok)
                if not m:
                    self.diag.add('anchor-invalid', 'error', ln, f'锚点写法不合法：{tok}（id 只用 A-Z a-z 0-9 _ -）', rule='X3')
                    continue
                kind = m.group(1)
                if kind != expect:
                    if expect == 'sec' and kind in self.entity_kinds:
                        self.inline_anchors.append({'kind': kind, 'id': m.group(2), 'line': ln})
                        continue
                    self.diag.add('anchor-kind', 'error', ln, f'此处锚点只能是 {expect}:…，写成了 {kind}:…（已忽略）', rule='X3')
                    continue
                anchor = f'{kind}:{m.group(2)}'
        return anchor

    # -- 标题
    def heading(self, m, ln):
        hashes, rest = m.group(1), m.group(2).strip()
        level = len(hashes) - 1
        anchor, classes = None, []
        ma = RE_ATTRS_TAIL.search(rest)
        if ma and re.search(r'(^|\s)[#.]', ma.group(1)):
            anchor = self.attr_anchor(ma.group(1), ln, expect='sec')
            classes = [t[1:] for t in ma.group(1).split() if t.startswith('.')]
            rest = rest[:ma.start()].strip()
        self.html_check(rest, ln)
        h = {'level': level, 'number': '', 'title': rest, 'title_raw': m.group(2).strip(), 'manual_number': None,
             'line': ln, 'anchor': anchor, 'appendix': 'appendix' in classes, 'classes': classes, 'skeleton_id': None,
             'inline': None, 'in_landscape': self.in_landscape}
        mapx = re.match(r'^附录\s*([A-Z])\s*[：:.、\s]\s*(.+)$', rest)
        if mapx:
            h['appendix'] = True; h['manual_number'] = '附录 ' + mapx.group(1); h['_manual_strip'] = mapx.group(2).strip()
        else:
            mn = re.match(r'^(\d{1,2}(?:\.\d{1,2}){0,3})(?:[.、]\s*|\s+)(\S.*)$', rest)
            if mn:
                h['manual_number'] = mn.group(1); h['_manual_strip'] = mn.group(2).strip()
        if self.in_summary:
            self.diag.add('heading-in-summary', 'error', ln, 'summary 块内不能有标题', rule='L1')
        if not rest:
            self.diag.add('heading-empty', 'error', ln, '标题为空', rule='S2')
        self.doc.headings.append(h)
        self.add_block({'kind': 'heading', 'level': level, 'heading': len(self.doc.headings) - 1, 'line': ln})

    # -- 代码块
    def code(self, i):
        L = self.L; ln = i + 1
        m = RE_FENCE.match(L[i])
        lang = m.group(1).strip()
        j = i + 1; body = []
        while j < len(L) and not L[j].strip().startswith('```'):
            body.append(L[j]); j += 1
        closed = j < len(L)
        if not closed:
            self.diag.add('code-unclosed', 'error', ln, '围栏代码块缺少结束 ```', rule='L8')
        if self.feats.get('code_blocks') is False:
            self.diag.add('code-disabled', 'error', ln, '类型包未开启 code_blocks，不允许围栏代码块', rule='L8')
        if not lang:
            self.diag.add('code-no-lang', 'warning', ln, '代码块未标语言', rule='L8')
        cb = {'kind': 'code', 'lang': lang, 'text': '\n'.join(body), 'line': ln, 'end_line': j + 1 if closed else len(L), 'section_number': self.section_number}
        self.add_block(cb)
        self.doc.code_blocks.append(cb)
        return j + 1

    # -- 高亮块
    def callout(self, i, m):
        L = self.L; ln = i + 1
        kind = m.group(1).lower()
        if kind not in CALLOUT_KINDS:
            self.diag.add('callout-kind', 'error', ln, f'不支持的高亮块类型 [!{m.group(1)}]，按 note 渲染', rule='L1')
            kind = 'note'
        body = [(m.group(2), ln)]
        j = i + 1
        while j < len(L) and L[j].startswith('>') and not RE_CALLOUT.match(L[j]):
            body.append((re.sub(r'^>\s?', '', L[j]), j + 1)); j += 1
        # 块内：空行分段；- / 1. 开头为列表（支持两级）
        sub = []; para = []; lst = None
        def flush_para():
            nonlocal para
            if para:
                t, joins = join_lines([p for p, _ in para])
                self.html_check(t, para[0][1])
                sub.append({'kind': 'p', 'text': t, 'line': para[0][1], 'inline': self.inl(t, para[0][1], joins, 'callout')})
                para = []
        def flush_list():
            nonlocal lst
            if lst: sub.append(lst); self.doc.lists.append(lst); lst = None
        for t, tl in body:
            if not t.strip():
                flush_para(); flush_list(); continue
            ml = RE_LIST.match(t)
            if ml:
                flush_para()
                level = 2 if len(ml.group(1)) >= 2 else 1
                k = 'ol' if ml.group(2)[0].isdigit() else 'ul'
                if lst is None: lst = {'kind': k, 'line': tl, 'items': [], 'in_callout': True}
                item_text = ml.group(3).strip()
                lst['items'].append({'text': item_text, 'line': tl, 'level': level, 'kind': k, 'inline': self.inl(item_text, tl, None, 'li')})
                continue
            flush_list(); para.append((t.strip(), tl))
        flush_para(); flush_list()
        text = '\n'.join(t for t, _ in body).strip()
        cb = {'kind': 'callout', 'callout': kind, 'text': text, 'line': ln, 'blocks': sub, 'section_number': self.section_number}
        self.add_block(cb)
        self.doc.callouts.append({'kind': kind, 'text': text, 'line': ln, 'blocks': sub})
        return j

    # -- 脚注定义
    def footdef(self, i, m):
        ln = i + 1; fid = m.group(1)
        parts = [m.group(2).strip()]; j = i + 1
        while j < len(self.L) and self.L[j].startswith('  ') and self.L[j].strip():
            parts.append(self.L[j].strip()); j += 1
        t, joins = join_lines(parts)
        if self.feats.get('footnotes') is False:
            self.diag.add('feature-disabled', 'error', ln, '类型包未开启 footnotes', rule='L1', feature='footnotes')
        if fid in self.doc.footnotes:
            self.diag.add('footnote-duplicate', 'error', ln, f'脚注 [^{fid}] 重复定义', rule='X3')
        else:
            self.doc.footnotes[fid] = {'text': t, 'line': ln, 'inline': self.inl(t, ln, joins, 'footnote'), 'section_number': self.section_number}
        self.add_block({'kind': 'footnote', 'id': fid, 'line': ln, 'section_number': self.section_number})
        return j

    # -- 图
    def figure(self, m, ln):
        cap, src, tail = m.group(1), m.group(2).strip(), m.group(3).strip()
        anchor, width = None, 100.0
        if tail:
            ma = re.fullmatch(r'\{([^{}]*)\}', tail)
            if ma:
                for tok in ma.group(1).split():
                    if tok.startswith('#'):
                        anchor = self.attr_anchor(tok, ln, expect='fig')
                    elif tok.startswith('width='):
                        try:
                            v = float(tok[6:].rstrip('%'))
                            if not 10 <= v <= 100: raise ValueError
                            width = v
                        except ValueError:
                            self.diag.add('figure-width', 'error', ln, f'图宽度只能是 10%–100%：{tok}', rule='L1')
                    else:
                        self.diag.add('figure-attr', 'warning', ln, f'图属性不认识：{tok}', rule='L1')
            else:
                self.diag.add('figure-trailing', 'warning', ln, f'图片行末尾多余文字：{tail[:40]}', rule='L1')
        eng = engine_for(src)
        if eng is None:
            self.diag.add('figure-ext', 'error', ln, f'图源扩展名不支持：{src}（.mmd .dot .fig.json .svg 或 png jpg jpeg webp gif）', rule='L1')
        if src.startswith(('http://', 'https://')) or not path_safe(src):
            self.diag.add('figure-path', 'error', ln, f'图路径必须是运行目录内相对路径：{src}', rule='L1')
        elif self.run_dir:
            outside = [c for c in figure_files(src) if os.path.lexists(os.path.join(self.run_dir, c)) and not within(self.run_dir, os.path.join(self.run_dir, c))]
            if outside:
                self.diag.add('figure-path', 'error', ln, f'图文件经符号链接越出运行目录：{"、".join(outside)}', rule='L1')
        kind = 'image' if eng == 'image' else 'figure'
        self.html_check(cap, ln)
        fig = {'kind': kind, 'src': src, 'caption': cap, 'caption_inline': self.inl(cap, ln, None, 'caption'), 'anchor': anchor,
               'number': '', 'engine': eng or 'unknown', 'svg': svg_path_for(src), 'width_pct': width, 'line': ln,
               'section_number': self.section_number, 'landscape': self.in_landscape}
        b = self.add_block(fig)
        self.doc.figures.append(b)

    # -- 表格（Markdown）
    def split_row(self, s):
        s = s.strip()
        if s.startswith('|'): s = s[1:]
        if s.endswith('|') and not s.endswith('\\|'): s = s[:-1]
        cells, cur, k = [], '', 0
        while k < len(s):
            if s[k] == '\\' and k + 1 < len(s) and s[k + 1] == '|':
                cur += '|'; k += 2; continue
            if s[k] == '|':
                cells.append(cur.strip()); cur = ''
            else:
                cur += s[k]
            k += 1
        cells.append(cur.strip())
        return cells

    def table(self, i):
        L = self.L; ln = i + 1
        rows, row_lines = [], []
        k = 0
        sep_second = False
        bad_sep = False
        while i < len(L) and L[i].strip().startswith('|'):
            cells = self.split_row(L[i])
            is_sep = any(cells) and all(RE_SEP_CELL.match(c) for c in cells if c)
            if is_sep and k == 1:
                # 第二行：每列都必须是分隔符（不许空列），且列数等于表头列数
                if rows and len(cells) == len(rows[0]) and all(RE_SEP_CELL.match(c) for c in cells):
                    sep_second = True
                else:
                    bad_sep = True
            elif is_sep:
                self.diag.add('table-separator-position', 'warning', i + 1, '分隔行（|---|）只能是表格第二行，此行已忽略', rule='L7')
            else:
                rows.append(cells); row_lines.append(i + 1)
            i += 1; k += 1
        if bad_sep:
            self.diag.add('table-no-separator', 'warning', ln + 1, '表格第二行的分隔行不合法（每列都要是 |---|，列数须等于表头），此行已忽略，首行仍按表头处理', rule='L7')
        elif not sep_second:
            self.diag.add('table-no-separator', 'warning', ln, '表格第二行不是分隔行（|---|），首行仍按表头处理', rule='L7')
        self.emit_table(rows, row_lines, ln, source='md')
        return i

    def emit_table(self, rows, row_lines, ln, source='md', data_file=None, caption=None, anchor=None, widths=None, groups=None, params=None):
        header = rows[0] if rows else []
        body = rows[1:]
        ncol = len(header)
        for r, rl in zip(body, row_lines[1:]):
            if len(r) != ncol:
                self.diag.add('table-shape', 'warning', rl, f'表格行有 {len(r)} 列，表头 {ncol} 列', rule='L7')
        body = [(r + [''] * ncol)[:ncol] for r in body]
        if source == 'md':
            pt = self.pending_table; self.pending_table = None
            if pt: caption, anchor = pt['caption'], pt['anchor']
            if self.pending_widths is not None:
                widths = self.pending_widths
            self.pending_widths = None
        if widths is not None and len(widths) != ncol:
            self.diag.add('widths-count', 'error', ln, f'widths 个数 {len(widths)} 与列数 {ncol} 不一致，已忽略', rule='L7')
            widths = None
        for c, name in enumerate(header):
            if not name.strip():
                self.diag.add('table-empty-header', 'warning', ln, f'表头第 {c + 1} 列为空', rule='L7')
        for r, rl in zip([header] + body, row_lines):
            for c in r: self.html_check(c, rl)
        t = {'kind': 'data' if source == 'data' else 'table', 'caption': caption or '', 'anchor': anchor, 'number': '',
             'header': header, 'rows': body, 'records': [dict(zip(header, r)) for r in body],
             'header_inline': [self.inl(c, ln, None, 'th') for c in header],
             'rows_inline': [[self.inl(c, rl, None, 'table') for c in r] for r, rl in zip(body, row_lines[1:] or [ln] * len(body))],
             'row_lines': row_lines[1:], 'widths': widths, 'line': ln, 'source': source, 'data_file': data_file,
             'landscape': self.in_landscape, 'groups': groups, 'params': params, 'section_number': self.section_number}
        b = self.add_block(t)
        self.doc.tables.append(b)
        return b

    # -- 数据块
    def data(self, rest, ln):
        pos, kv = parse_args_str(rest)
        params = {'columns': None, 'filter': [], 'group': None, 'sort': None, 'caption': None, 'id': None, 'widths': None}
        ok = True
        def err(code, msg, sev='error'):
            self.diag.add(code, sev, ln, msg, rule='L9')
        if self.feats.get('data_blocks') is False:
            err('feature-disabled', '类型包未开启 data_blocks')
        if len(pos) != 1:
            err('data-args', '数据块第一个参数必须是文件路径（且只能有一个）'); return
        path = pos[0]
        for k, v in kv:
            if k == 'filter': params['filter'].append(v)
            elif k in params: params[k] = v
            else: err('data-param', f'数据块参数不认识：{k}', 'warning')
        caption = params['caption']; anchor = None
        if params['id']:
            m = re.fullmatch(r'tbl:(' + ANCHOR_ID + ')', params['id'])
            if m: anchor = params['id']
            else: err('data-id', f'数据块 id 必须是 tbl:xxx：{params["id"]}')
        widths = None
        if params['widths']:
            try:
                widths = [float(x) for x in params['widths'].split(',') if x.strip()]
                if any(not math.isfinite(x) or x <= 0 for x in widths): raise ValueError
            except ValueError:
                err('data-widths', f'widths 只能是正数列表：{params["widths"]}'); widths = None
        low = path.lower()
        if low.endswith(('.yaml', '.yml')):
            err('data-yaml', f'数据块暂不支持 YAML（阶段 1 只支持 CSV）：{path}'); ok = False
        elif not low.endswith('.csv'):
            err('data-format', f'数据块只支持 .csv：{path}'); ok = False
        if ok and not path_safe(path):
            err('data-path', f'数据文件必须是运行目录内相对路径：{path}'); ok = False
        header, rows, row_lines = [], [], []
        if ok:
            if not self.run_dir:
                err('data-no-run-dir', '未提供运行目录，无法读取数据文件'); ok = False
            else:
                full = os.path.join(self.run_dir, path)
                if not within(self.run_dir, full):
                    err('data-path', f'数据文件越出运行目录：{path}'); ok = False
                elif not os.path.isfile(full):
                    err('data-missing', f'数据文件不存在：{path}'); ok = False
                else:
                    try:
                        with open(full, encoding='utf-8-sig', newline='') as f:
                            rd = csv.reader(f)
                            all_rows = []
                            for rec in rd:
                                all_rows.append((rec, rd.line_num))
                        if not all_rows:
                            err('data-empty', f'数据文件为空：{path}'); ok = False
                        else:
                            header = [h.strip() for h in all_rows[0][0]]
                            for rec, lnum in all_rows[1:]:
                                if not any(c.strip() for c in rec): continue
                                rows.append((rec + [''] * len(header))[:len(header)]); row_lines.append(lnum)
                    except (UnicodeDecodeError, csv.Error) as ex:
                        err('data-read', f'数据文件读取失败（需 UTF-8 CSV）：{path}：{ex}'); ok = False
        if not ok:
            b = self.add_block({'kind': 'data', 'error': True, 'data_file': path, 'line': ln, 'params': params, 'caption': caption or '', 'anchor': anchor,
                                'header': [], 'rows': [], 'records': [], 'header_inline': [], 'rows_inline': [], 'row_lines': [], 'widths': None,
                                'source': 'data', 'number': '', 'landscape': self.in_landscape, 'groups': None, 'section_number': self.section_number})
            return
        idx = {h: k for k, h in enumerate(header)}
        # filter
        sel = list(range(len(rows)))
        for f in params['filter']:
            col, sep, prefix = f.partition('^')
            if not sep:
                err('data-filter', f'filter 写法应为 列名^前缀：{f}'); continue
            if col not in idx:
                err('data-column', f'filter 引用了不存在的列：{col}'); continue
            if prefix == '':
                err('data-filter-empty', f'filter 前缀为空：{f}'); continue
            sel = [r for r in sel if rows[r][idx[col]].strip().startswith(prefix)]
        # sort
        if params['sort']:
            if params['sort'] not in idx: err('data-column', f'sort 引用了不存在的列：{params["sort"]}')
            else: sel.sort(key=lambda r: rows[r][idx[params['sort']]])
        # columns
        cols = list(range(len(header)))
        if params['columns']:
            names = [c.strip() for c in params['columns'].split(',') if c.strip()]
            bad = [c for c in names if c not in idx]
            if bad: err('data-column', f'columns 引用了不存在的列：{"、".join(bad)}')
            cols = [idx[c] for c in names if c in idx]
        groups = None
        if params['group']:
            if params['group'] not in idx: err('data-column', f'group 引用了不存在的列：{params["group"]}')
            else:
                gi = idx[params['group']]; order = []; members = {}
                for r in sel:
                    v = rows[r][gi].strip()
                    if v not in members: members[v] = []; order.append(v)
                    members[v].append(r)
                sel = [r for v in order for r in members[v]]
                groups = []; start = 0
                for v in order:
                    groups.append({'value': v, 'count': len(members[v]), 'start': start}); start += len(members[v])
        if not sel:
            err('data-no-rows', f'数据块 filter 之后 0 行：{path}', 'info')
        out_rows = [[header[c] for c in cols]] + [[rows[r][c].strip() for c in cols] for r in sel]
        out_lines = [ln] + [ln for _ in sel]
        t = self.emit_table(out_rows, out_lines, ln, source='data', data_file=path, caption=caption, anchor=anchor, widths=widths, groups=groups, params=params)
        t['csv_lines'] = [row_lines[r] for r in sel]
        # 行的 records 保留 CSV 全部列（质检要看未显示的列）
        t['records_full'] = [dict(zip(header, rows[r])) for r in sel]

    # -- 列表
    def lst(self, i):
        L = self.L; ln = i + 1
        first = RE_LIST.match(L[i])
        kind = 'ol' if first.group(2)[0].isdigit() else 'ul'
        lst = {'kind': kind, 'line': ln, 'items': [], 'section_number': self.section_number}
        cur = None
        while i < len(L):
            l = L[i].rstrip()
            m = RE_LIST.match(l)
            if m:
                indent = len(m.group(1))
                level = 1 if indent < 2 else 2
                if indent >= 4:
                    self.diag.add('list-depth', 'warning', i + 1, '列表最多两级，更深的缩进按二级处理', rule='L1')
                if level == 2 and cur is None:
                    level = 1
                k = 'ol' if m.group(2)[0].isdigit() else 'ul'
                cur = {'text': m.group(3).strip(), 'line': i + 1, 'level': level, 'kind': k, '_parts': [m.group(3).strip()]}
                lst['items'].append(cur); i += 1; continue
            if cur is not None and l.startswith('  ') and l.strip() and not RE_PARA_STOP.match(l.strip()):
                cur['_parts'].append(l.strip()); i += 1; continue
            break
        for it in lst['items']:
            t, joins = join_lines(it.pop('_parts'))
            it['text'] = t
            self.html_check(t, it['line'])
            it['inline'] = self.inl(t, it['line'], joins, 'li')
        self.add_block(lst)
        self.doc.lists.append(lst)
        return i

    # -- 段落
    def para(self, i):
        L = self.L; ln = i + 1
        parts = [L[i].strip()]; i += 1
        while i < len(L) and L[i].strip() and not RE_PARA_STOP.match(L[i]) and not RE_FOOTDEF.match(L[i]) and not L[i].startswith('# '):
            parts.append(L[i].strip()); i += 1
        t, joins = join_lines(parts)
        if t.startswith('>'):
            self.diag.add('blockquote', 'warning', ln, '普通引用块（> ）不支持，请用 > [!note] 等高亮块；按段落处理', rule='L1')
        self.html_check(t, ln)
        self.add_block({'kind': 'p', 'text': t, 'line': ln, 'end_line': i, 'inline': self.inl(t, ln, joins, 'p'), 'section_number': self.section_number})
        return i


# ---------------------------------------------------------------- 编号与链接
def _norm_title(s):
    return re.sub(r'[\s　]', '', s or '')


def _number_and_link(doc, diag, feats, numbering, skeleton, entity_defs):
    sec_mode = numbering.get('section', 'decimal')
    app_mode = numbering.get('appendix', 'alpha')
    max_depth = int(numbering.get('max_depth') or 3)
    cnt = [0, 0, 0, 0]; app = 0; in_app = False
    prev_level = 0
    chapter = '0'
    heading_of_block = {}
    for hi, h in enumerate(doc.headings):
        lv = h['level']
        if prev_level and lv > prev_level + 1:
            diag.add('heading-skip', 'error', h['line'], f'标题跳级：{prev_level} 级之后直接 {lv} 级', rule='S2')
        if prev_level == 0 and lv > 1:
            diag.add('heading-skip', 'error', h['line'], f'第一个标题应为一级（##），这里是 {lv} 级', rule='S2')
        prev_level = lv
        if lv > max_depth:
            diag.add('heading-depth', 'error', h['line'], f'标题层级 {lv} 超过 numbering.max_depth {max_depth}', rule='S2')
        if lv == 1:
            in_app = bool(h['appendix'])
        elif in_app:
            h['appendix'] = True
        if in_app and app_mode != 'none':
            if lv == 1:
                app += 1; cnt = [0, 0, 0, 0]
            else:
                cnt[lv - 1] += 1
                for j in range(lv, 4): cnt[j] = 0
            parts = [alpha(app)] + [str(c) for c in cnt[1:lv]]
            h['number'] = '.'.join(parts) if lv <= max_depth else ''
        elif sec_mode != 'none':
            cnt[lv - 1] += 1
            for j in range(lv, 4): cnt[j] = 0
            if in_app: pass
            h['number'] = '.'.join(str(c) for c in cnt[:lv]) if lv <= max_depth else ''
        # 手写序号：只有与自动编号完全一致（或是附录前缀）时才从显示标题里去掉；title_raw 原样保留，T5 由 doc-qa 报
        mn = h.get('manual_number')
        strip_to = h.pop('_manual_strip', None)
        if mn:
            if mn.startswith('附录'):
                h['title'] = strip_to or h['title']
            elif mn == h['number']:
                h['title'] = strip_to or h['title']
        h['inline'] = parse_inline(h['title'], h['line'], diag, context='heading', highlights=doc.highlights)
        h['plain'] = _plain(h['inline'])
        h['label'] = ('附录 ' + h['number'] if h['appendix'] and lv == 1 else h['number'])
    # 块归属章节号 + 图表编号
    fig_seq, tbl_seq = {}, {}
    cur_h = None
    num_fig = feats.get('figure_numbers') is not False and numbering.get('figure')
    num_tbl = feats.get('table_captions') is not False and numbering.get('table')
    for b in doc.blocks:
        if b['kind'] == 'heading':
            cur_h = doc.headings[b['heading']]
            b['section_number'] = cur_h['number']
            if cur_h['level'] == 1: chapter = cur_h['number'] or '0'
            continue
        b['section_number'] = cur_h['number'] if cur_h else ''
        b['chapter'] = chapter if cur_h else '0'
        if b['kind'] in ('figure', 'image') and num_fig:
            fig_seq[b['chapter']] = fig_seq.get(b['chapter'], 0) + 1
            b['number'] = format_number(numbering['figure'], b['chapter'], fig_seq[b['chapter']])
        if b['kind'] in ('table', 'data') and num_tbl and not b.get('error') and (b.get('caption') or b.get('anchor')):
            tbl_seq[b['chapter']] = tbl_seq.get(b['chapter'], 0) + 1
            b['number'] = format_number(numbering['table'], b['chapter'], tbl_seq[b['chapter']])
    for lst in doc.lists:
        pass
    # 锚点表
    def add_anchor(key, rec):
        if key in doc.anchors:
            diag.add('anchor-duplicate', 'error', rec['line'], f'锚点重复：{key}（首次在第 {doc.anchors[key]["line"]} 行）', rule='X3')
            return
        doc.anchors[key] = rec
    for h in doc.headings:
        if h['anchor']:
            kind, aid = h['anchor'].split(':', 1)
            label = (('附录 ' + h['number']) if h['appendix'] and h['level'] == 1 else (h['number'] + ' 节' if h['number'] else h['plain']))
            add_anchor(h['anchor'], {'kind': kind, 'id': aid, 'number': h['number'], 'line': h['line'], 'label': label, 'target': 'heading'})
    for b in doc.blocks:
        if b['kind'] in ('figure', 'image') and b.get('anchor'):
            add_anchor(b['anchor'], {'kind': 'fig', 'id': b['anchor'][4:], 'number': b['number'], 'line': b['line'], 'label': b['number'] or b['caption'], 'target': 'figure'})
        if b['kind'] in ('table', 'data') and b.get('anchor'):
            add_anchor(b['anchor'], {'kind': 'tbl', 'id': b['anchor'][4:], 'number': b['number'], 'line': b['line'], 'label': b['number'] or b['caption'], 'target': 'table'})
    for a in getattr(doc, '_inline_anchors', []):
        key = f'{a["kind"]}:{a["id"]}'
        add_anchor(key, {'kind': a['kind'], 'id': a['id'], 'number': a['id'], 'line': a['line'], 'label': a['id'], 'target': 'inline'})
    # 引用
    def collect(nodes):
        for n in walk_inline(nodes):
            if n['t'] == 'ref':
                rec = doc.anchors.get(n['target'])
                n['resolved'] = rec is not None
                n['label'] = rec['label'] if rec else None
                doc.refs.append({'target': n['target'], 'line': n['line'], 'resolved': rec is not None})
                if not rec:
                    diag.add('ref-unresolved', 'error', n['line'], f'交叉引用指向不存在的锚点：@{n["target"]}', rule='X1')
            elif n['t'] == 'fnref':
                doc.footnote_refs.append({'id': n['id'], 'line': n['line']})
                if n['id'] not in doc.footnotes:
                    diag.add('footnote-missing', 'error', n['line'], f'脚注 [^{n["id"]}] 没有定义', rule='X1')
            elif n['t'] == 'link':
                doc.links.append({'text': _plain(n['c']), 'url': n['url'], 'line': n['line']})
    for inl in _all_inline(doc):
        collect(inl)
    used = {r['id'] for r in doc.footnote_refs}
    for fid, fn in doc.footnotes.items():
        if fid not in used:
            diag.add('footnote-unused', 'info', fn['line'], f'脚注 [^{fid}] 定义了但没有被引用', rule='X2')
    # 骨架匹配
    for h in doc.headings:
        for sk in skeleton:
            names = [sk.get('title', '')] + list(sk.get('aliases') or [])
            if h['anchor'] == 'sec:' + str(sk.get('id')) or any(_norm_title(h['plain']) == _norm_title(nm) for nm in names if nm):
                h['skeleton_id'] = sk.get('id'); break
    # 编号实体
    for e in entity_defs:
        try:
            rx = re.compile(e['pattern'])
        except re.error as ex:
            diag.add('entity-pattern', 'error', 0, f'实体 {e["kind"]} 的正则无法编译：{ex}', rule='S3'); continue
        defs, mentions, def_keys = [], [], set()
        for b in doc.blocks:
            if b['kind'] in ('table', 'data') and not b.get('error'):
                for ri, r in enumerate(b['rows']):
                    if r and rx.fullmatch(r[0].strip()):
                        rline = b['row_lines'][ri] if ri < len(b['row_lines']) else b['line']
                        rec = (b.get('records_full') or b['records'])[ri]
                        defs.append({'code': r[0].strip(), 'line': rline, 'section_number': b['section_number'], 'row': rec,
                                     'table_line': b['line'], 'csv_line': (b.get('csv_lines') or [None] * (ri + 1))[ri]})
                        def_keys.add((b['line'], ri))
        for key, a in doc.anchors.items():
            if a['kind'] == e['kind']:
                defs.append({'code': a['id'], 'line': a['line'], 'section_number': None, 'row': None})
        for b in doc.blocks:
            texts = []
            if b['kind'] == 'p': texts.append((b['text'], b['line']))
            elif b['kind'] in ('ul', 'ol'): texts += [(it['text'], it['line']) for it in b['items']]
            elif b['kind'] == 'callout': texts.append((b['text'], b['line']))
            elif b['kind'] in ('table', 'data') and not b.get('error'):
                for ri, r in enumerate(b['rows']):
                    rl = b['row_lines'][ri] if ri < len(b['row_lines']) else b['line']
                    for ci, c in enumerate(r):
                        if ci == 0 and (b['line'], ri) in def_keys: continue
                        texts.append((c, rl))
            for t, tl in texts:
                for m in rx.finditer(RE_INLINE_ANCHOR.sub('', RE_REF.sub('', t))):
                    mentions.append({'code': m.group(0), 'line': tl})
        doc.entities[e['kind']] = defs
        doc.entity_mentions[e['kind']] = mentions


def _all_inline(doc):
    for h in doc.headings:
        if h.get('inline'): yield h['inline']
    for b in doc.blocks:
        k = b['kind']
        if k == 'p': yield b['inline']
        elif k in ('ul', 'ol'):
            for it in b['items']: yield it['inline']
        elif k in ('table', 'data'):
            for c in b.get('header_inline') or []: yield c
            for r in b.get('rows_inline') or []:
                for c in r: yield c
        elif k in ('figure', 'image'): yield b['caption_inline']
        elif k == 'callout':
            for sb in b['blocks']:
                if sb['kind'] == 'p': yield sb['inline']
                else:
                    for it in sb['items']: yield it['inline']
    for fn in doc.footnotes.values():
        yield fn['inline']


# ---------------------------------------------------------------- CLI
def _load_pack(arg):
    if not arg: return None
    p = arg if arg.endswith('.json') else os.path.join(arg, 'pack.json')
    return json.load(open(p, encoding='utf-8'))


def main(argv):
    args = list(argv)
    if not args or args[0] in ('-h', '--help'):
        print(__doc__); return 2
    run_dir = args.pop(0)
    opts = {'--source': None, '--pack': None, '--resolved-out': None}
    as_json = False
    k = 0
    while k < len(args):
        if args[k] in opts and k + 1 < len(args): opts[args[k]] = args[k + 1]; k += 2; continue
        if args[k] == '--json': as_json = True; k += 1; continue
        print(__doc__); return 2
    try:
        pack = _load_pack(opts['--pack'])
        source = opts['--source'] or (pack or {}).get('source_file') or ('doc.md' if os.path.exists(os.path.join(run_dir, 'doc.md')) else 'proposal.md')
        doc = parse_file(run_dir, source, pack=pack)
    except (OSError, json.JSONDecodeError) as ex:
        print(json.dumps({'ok': False, 'error': str(ex)}, ensure_ascii=False)); return 2
    if opts['--resolved-out']:
        open(opts['--resolved-out'], 'w', encoding='utf-8').write(doc.text)
    if as_json:
        print(json.dumps(doc.to_dict(), ensure_ascii=False, indent=1))
    else:
        print(json.dumps({'ok': not doc.errors(), 'title': doc.title, 'headings': len(doc.headings), 'blocks': len(doc.blocks),
                          'tables': len(doc.tables), 'figures': len(doc.figures), 'code_blocks': len(doc.code_blocks),
                          'anchors': len(doc.anchors), 'refs': len(doc.refs), 'highlights': len(doc.highlights),
                          'diagnostics': doc.diagnostics}, ensure_ascii=False, indent=2))
    return 1 if doc.errors() else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
