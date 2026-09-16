"""MRD（mrd）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

doc-qa 调用 check(doc, ctx)。约定：不修改 doc、不写文件、不 import 引擎内部模块；新规则一律定级「提示」试运行（W3-A，2026-09-15）；
跨文档读取用 ctx.related(type, role=…)，缺失时 ctx.missing_related_issue。与引擎重复的判据（必备章节 S1、编号重复 S3、
代码块未标语言 L8、绝对化用语 R1、验收列空泛词 T11）不在这里重复实现。
"""
import csv, io, os, re, sys

SEV = '提示'  # 新自动规则先定级「提示」试运行（doc-qa/SKILL.md「类型包接入」）；定级调整走 pack.json qa.severity_overrides

# 通用小工具在 doc-shared/scripts/qa_pack_helpers.py（2026-09-15 W3-H 从七个包各自一份上移）。doc-qa 进程里 doc-shared/scripts 已在 sys.path；
# 直接加载本文件时按包目录相对路径（types/<包>/ → doc-shared/scripts）兜底。
try:
    import qa_pack_helpers  # noqa: F401
except ImportError:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'scripts'))
from qa_pack_helpers import (RE_COMMENT, norm as _norm, chars as _chars, section as _section, in_section as _in, title as _title,  # noqa: E402,F401
                             tables as _tables, col as _col, cell as _cell, records as _records, row_line as _row_line, where as _where,
                             ent_where as _ent_where, finish as _finish, first as _first, body as _body, visible as _visible,
                             subheadings as _subheadings, read_csv as _csv, related as _related)


# ---------------------------------------------------------------- 本包规则

NUM = re.compile(r'\d+(?:\.\d+)?\s*(?:%|％|亿|万)')
SRC = re.compile(r'来源|出处|依据|根据|统计|报告|看板|调研|访谈|埋点|抽样|工单|实测|扫描|评测|截图')


def check(doc, ctx):
    out = []
    secs = [s for s in (_section(doc, k) for k in ('market', 'segments', 'competition')) if s]
    fn_lines = {r['line'] for r in doc.footnote_refs}
    # MRD-01 市场数字有来源：三节与摘要块里的段落、列表、提示块；表格按行
    for kind, line, text, extra in doc.text_units():
        if kind not in ('p', 'li', 'callout') or not text:
            continue
        in_summary = isinstance(extra, dict) and extra.get('in_summary')
        if not (in_summary or any(_in(s, line) for s in secs)):
            continue
        m = NUM.search(text)
        if m and not SRC.search(text) and line not in fn_lines:
            out.append(ctx.issue('MRD-01', SEV, line, text, f'市场数字「{m.group(0)}」所在段落没有来源标注（来源、脚注或括注）'))
    for s in secs:
        for t in _tables(doc, s):
            sc = _col(t['header'], '来源', '依据', '出处')
            for i, r in enumerate(_records(t)):
                vals = [_cell(r, c) for c in t['header'] if c != sc]
                hit = next((NUM.search(v) for v in vals if NUM.search(v)), None)
                if not hit:
                    continue
                if sc and not _cell(r, sc):
                    out.append(ctx.issue('MRD-01', SEV, *_where(t, i, _first(r)), f'含市场数字「{hit.group(0)}」的行「{sc}」列为空'))
                elif not sc and not SRC.search(' '.join(vals)):
                    out.append(ctx.issue('MRD-01', SEV, *_where(t, i, _first(r)), f'表格行含市场数字「{hit.group(0)}」，但表格没有来源列，该行也没有括注来源'))
    # MRD-02 竞品矩阵有依据列或脚注 / 表下依据说明
    comp = _section(doc, 'competition')
    if comp:
        units = {line: text for kind, line, text, _ in doc.text_units() if kind == 'p' and text}
        has_fn = any(_in(comp, ln) for ln in fn_lines)
        for t in _tables(doc, comp):
            is_matrix = _col(t['header'], '维度') or any(ch in '●◐○' for row in t.get('rows') or [] for c in row for ch in c)
            if not is_matrix or _col(t['header'], '依据', '来源', '出处') or has_fn:
                continue
            nxt = next((b for b in sorted(doc.blocks, key=lambda b: b['line']) if b['line'] > t['line'] and b['kind'] != 'table'), None)
            if nxt and nxt['kind'] == 'p' and re.match(r'\s*(依据|来源|注|数据来源)', units.get(nxt['line'], '')):
                continue
            out.append(ctx.issue('MRD-02', SEV, t['line'], ' | '.join(t['header']), '竞品矩阵没有「依据」列，也没有脚注或表下依据说明'))
    # MRD-03 MR 需求有优先级（编号重复由引擎 S3 查）
    warned = set()
    for d in doc.entities.get('market_requirement') or []:
        row = d.get('row')
        if row is None:
            continue
        pc = _col(list(row.keys()), '优先级')
        if not pc:
            if d.get('table_line') not in warned:
                warned.add(d.get('table_line'))
                out.append(ctx.issue('MRD-03', SEV, *_ent_where(d), f'需求 {d["code"]} 所在表格没有「优先级」列'))
        elif not _cell(row, pc):
            out.append(ctx.issue('MRD-03', SEV, *_ent_where(d), f'需求 {d["code"]} 的优先级为空'))
    return _finish(out)
