"""类型包 qa_rules.py 的通用小工具（2026-09-15 W3-H 从七个内部类型包各自一份的副本上移，行为与原副本一致）。
接口约定见 references/pack-interface.md §4：doc 为共享解析器文档模型（doc-qa docmodel 适配层），ctx 为 doc-qa 质检上下文。
类型包里用法（沿用原来的下划线名，规则代码不用改）：
  from qa_pack_helpers import norm as _norm, section as _section, ...
本模块不认识任何业务类型，只处理章节、表格、CSV 与跨文档读取的通用形状。"""
import csv, io, re

RE_COMMENT = re.compile(r'<!--.*?-->', re.S)


def norm(s):
    return re.sub(r'\s+', '', str(s or '')).lower()


def chars(s):
    return len(re.sub(r'\s+', '', str(s or '')))


def section(doc, sid):
    try:
        return doc.section(sid)
    except Exception:
        return None


def in_section(sec, line):
    return bool(sec) and sec['start'] < line <= sec['end']


def title(sec):
    h = (sec or {}).get('heading') or {}
    return h.get('plain') or h.get('title') or ''


def tables(doc, sec):
    return [t for t in doc.tables if in_section(sec, t['line']) and not t.get('error')]


def col(header, *keys):
    for h in header or []:
        if any(norm(k) in norm(h) for k in keys):
            return h
    return None


def cell(rec, column):
    return str((rec or {}).get(column) or '').strip() if column else ''


def records(t):
    return t.get('records_full') or t.get('records') or []


def row_line(t, i):
    rl = t.get('row_lines') or []
    return rl[i] if i < len(rl) else t['line']


def where(t, i, text):
    """表格行问题的 (行号, 摘录)。Markdown 表格用该行行号；数据块各行共用指令行号，同规则同行会被引擎合并，
    所以报全文级（行号 0），摘录写数据文件与 CSV 行号。"""
    if t.get('source') == 'data':
        cl = t.get('csv_lines') or []
        n = cl[i] if i < len(cl) else None
        return 0, f'{t.get("data_file") or "数据块"}' + (f' 第 {n} 行' if n else '') + f'：{text}'
    return row_line(t, i), text


def ent_where(d):
    """编号实体定义的 (行号, 摘录)：来自数据块时同 where。"""
    if d.get('csv_line'):
        return 0, f'数据块第 {d.get("table_line")} 行引用的 CSV 第 {d["csv_line"]} 行：{d["code"]}'
    return d['line'], d['code']


def finish(out):
    """行号 0 的逐行问题（数据块、CSV）把摘录里的「文件 第 N 行」补进消息：引擎按 (rule, line, message) 去重，消息相同会被合并成一条。
    注：原副本里「只处理行号 0」的条件被误写进行尾注释；2026-09-15 主代理按文档原意修正为只处理行号 0。"""
    for x in out:
        m = re.match(r'^(.*? 第 \d+ 行)', x.get('excerpt') or '')
        if x.get('line') == 0 and m and m.group(1) not in x['message']:
            x['message'] += f'（{m.group(1)}）'
    return out


def first(rec):
    return next((str(v).strip() for v in (rec or {}).values() if str(v or '').strip()), '')


def body(doc, sec):
    """节正文（不含标题行、围栏代码块与 HTML 注释）。sec 为 doc.section() 结果或 {start, end}。"""
    if not sec:
        return ''
    n = len(doc.lines)
    keep = [doc.lines[i] for i in range(sec['start'], min(sec['end'], n)) if not doc.code_mask[i] and not doc.comment_mask[i]]
    return RE_COMMENT.sub('', '\n'.join(keep)).strip()


def visible(doc):
    keep = [l for i, l in enumerate(doc.lines) if not doc.code_mask[i] and not doc.comment_mask[i]]
    return RE_COMMENT.sub('', '\n'.join(keep))


def subheadings(doc, sec):
    """节内直属下一层标题：[(heading, 起始行, 结束行)]。"""
    if not sec:
        return []
    lv = sec['heading']['level']
    hs = [h for h in doc.headings if in_section(sec, h['line']) and h['level'] > lv]
    if not hs:
        return []
    child = min(h['level'] for h in hs)
    out = []
    for h in hs:
        if h['level'] != child:
            continue
        nxt = next((x['line'] for x in doc.headings if x['line'] > h['line'] and x['level'] <= child), None)
        out.append((h, h['line'], min(sec['end'], nxt - 1) if nxt else sec['end']))
    return out


def read_csv(read_text, rel):
    """读 CSV：返回 (表头, [(CSV 行号, {列: 值})])，跳过空行。"""
    rd = csv.reader(io.StringIO(read_text(rel).lstrip('\ufeff')))
    header = [h.strip() for h in (next(rd, None) or [])]
    rows = []
    for r in rd:
        if any(c.strip() for c in r):
            rows.append((rd.line_num, dict(zip(header, [c.strip() for c in r]))))
    return header, rows


def related(ctx, rule, doc_type, role, memo):
    """跨文档读取（related_docs.role 必填，artifacts.md §2.1）：按 type + role 命中且可读 → 用；命中但读不出 → 缺失问题（带原因）；
    没有命中 → 缺失问题（同 type 有缺 role 的条目时在原因里点明）。for_gate 由 pack.json related 决定（D2 相关为必改）。同一关系只报一次。"""
    key = (doc_type, role)
    if key in memo:
        return memo[key], []
    d = ctx.related(doc_type, role=role)
    if d is not None:
        memo[key] = d if d.ok else None
        return memo[key], ([] if d.ok else [ctx.missing_related_issue(rule, doc_type, role=role, detail=d.error)])
    memo[key] = None
    loose = [x for x in ctx.related_all(doc_type) if not getattr(x, 'role', None)]
    detail = f'{len(loose)} 条 {doc_type} 条目缺 role（必填），补 "role": "{role}"' if loose else ''
    return None, [ctx.missing_related_issue(rule, doc_type, role=role, detail=detail)]
