"""PRD（prd）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

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

T11_COL = re.compile(r'验收|预期|期望|判据|标准|结果')  # 引擎 T11 已查的列，PRD-07 不重复
VAGUE = ['体验更好', '性能高', '合理', '友好']


def check(doc, ctx):
    out = []
    ent = next((e for e in (ctx.pack.get('numbering') or {}).get('entities') or [] if e.get('kind') == 'requirement'), {})
    rx = re.compile(ent['pattern']) if ent.get('pattern') else None
    defs = doc.entities.get('requirement') or []
    req = _section(doc, 'requirements')
    # PRD-02 需求编号：功能需求节有 REQ 定义；以 REQ 开头但不满足编号格式的（重复由引擎 S3、跳号由 S3 contiguous 查）
    if req:
        if not [d for d in defs if _in(req, d['line'])]:
            out.append(ctx.issue('PRD-02', SEV, req['start'], _title(req), '功能需求节没有 REQ 编号定义（表格首列或 {#requirement:…} 锚点），需求无法被用例与覆盖矩阵引用'))
        for t in _tables(doc, req):
            for i, row in enumerate(t.get('rows') or []):
                c0 = (row[0] if row else '').strip()
                if rx and re.match(r'(?i)^REQ[-_ ]', c0) and not rx.fullmatch(c0):
                    out.append(ctx.issue('PRD-02', SEV, *_where(t, i, c0), f'需求编号「{c0}」不符合编号格式 {ent["pattern"]}（REQ-模块-两位序号）'))
    # PRD-03 每条需求有验收标准
    warned = set()
    for d in defs:
        row = d.get('row')
        if row is None:
            continue
        col = _col(list(row.keys()), '验收标准', '验收')
        if not col:
            if d.get('table_line') not in warned:
                warned.add(d.get('table_line'))
                out.append(ctx.issue('PRD-03', SEV, *_ent_where(d), f'需求 {d["code"]} 所在表格没有「验收标准」列'))
        elif not _cell(row, col):
            out.append(ctx.issue('PRD-03', SEV, *_ent_where(d), f'需求 {d["code"]} 的验收标准为空'))
    # PRD-04 范围与非目标
    scope = _section(doc, 'scope')
    if scope:
        body = _body(doc, scope)
        if not _chars(body):
            out.append(ctx.issue('PRD-04', SEV, scope['start'], _title(scope), '「范围与非目标」节没有内容'))
        elif not re.search(r'非目标|不做|不在(?:本期)?范围|不包含|范围之?外|不纳入', body):
            out.append(ctx.issue('PRD-04', SEV, scope['start'], _title(scope), '「范围与非目标」节没有写非目标（明确不做什么）'))
    # PRD-05 开放问题表每行有 owner 与截止时间
    dep = _section(doc, 'dependencies')
    if dep:
        qts = [t for t in _tables(doc, dep) if '问题' in (t.get('caption') or '') or _col(t['header'], '问题')]
        if not qts and not re.search(r'(无|没有)(待决|开放|未决)?问题', _body(doc, dep)):
            out.append(ctx.issue('PRD-05', SEV, dep['start'], _title(dep), '依赖、风险与开放问题节没有开放问题表（每条问题须有 owner 与截止时间；确无开放问题时写明「无开放问题」）'))
        for t in qts:
            oc, dc = _col(t['header'], 'owner', '负责人', '责任人'), _col(t['header'], '截止', '到期', 'deadline')
            if not oc or not dc:
                miss = '、'.join(n for n, c in (('owner', oc), ('截止时间', dc)) if not c)
                out.append(ctx.issue('PRD-05', SEV, t['line'], ' | '.join(t['header']), f'开放问题表缺「{miss}」列'))
                continue
            for i, r in enumerate(_records(t)):
                miss = '、'.join(n for n, c in (('owner', oc), ('截止时间', dc)) if not _cell(r, c))
                if miss:
                    out.append(ctx.issue('PRD-05', SEV, *_where(t, i, _first(r)), f'开放问题「{_first(r)[:30]}」的 {miss} 为空'))
    # PRD-06 指标有口径与来源
    goals = _section(doc, 'goals')
    if goals:
        mts = [t for t in _tables(doc, goals) if _col(t['header'], '指标')]
        for t in mts:
            kc, sc = _col(t['header'], '口径'), _col(t['header'], '来源')
            if not kc or not sc:
                miss = '、'.join(n for n, c in (('口径', kc), ('来源', sc)) if not c)
                out.append(ctx.issue('PRD-06', SEV, t['line'], ' | '.join(t['header']), f'指标表缺「{miss}」列'))
                continue
            for i, r in enumerate(_records(t)):
                miss = '、'.join(n for n, c in (('口径', kc), ('来源', sc)) if not _cell(r, c))
                if miss:
                    out.append(ctx.issue('PRD-06', SEV, *_where(t, i, _first(r)), f'指标「{_first(r)[:30]}」的 {miss} 为空'))
        if not mts:
            body = _body(doc, goals)
            miss = [w for w in ('口径', '来源') if w not in body]
            if miss:
                out.append(ctx.issue('PRD-06', SEV, goals['start'], _title(goals), f'目标与指标节没有指标表，正文也没有写出指标的{"、".join(miss)}'))
    # PRD-07 异常与边界列无空泛词（验收类列由引擎 T11 查）
    for t in doc.tables:
        for col in t.get('header') or []:
            if '异常' not in col or T11_COL.search(col):
                continue
            for i, r in enumerate(_records(t)):
                w = next((w for w in VAGUE if w in _cell(r, col)), None)
                if w:
                    out.append(ctx.issue('PRD-07', SEV, *_where(t, i, _cell(r, col)), f'列「{col}」含空泛表述「{w}」，写出可观察的异常行为'))
    # PRD-08 用户与场景节至少一张带锚点的流程图（未被引用由引擎 X2 查）
    scen = _section(doc, 'scenarios')
    if scen and not [f for f in doc.figures if _in(scen, f['line']) and f.get('anchor')]:
        out.append(ctx.issue('PRD-08', SEV, scen['start'], _title(scen), '用户与场景节没有带图号锚点（{#fig:…}）的用户流程图'))
    return _finish(out)
