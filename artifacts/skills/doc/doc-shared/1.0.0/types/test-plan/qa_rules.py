"""测试计划（test-plan）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

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
RE_REQ = re.compile(r'(?<![A-Za-z0-9-])REQ-[A-Z0-9]+-\d+(?![\d])')


# ---------------------------------------------------------------- 跨文档读取（本包用到的关联文档形状）

def _prd_requirements(prd, ctx, rule):
    """关联 PRD 的需求：data/requirements.csv 编号列 ∪ 对方正文 requirement 实体；返回 ({编号: 优先级}, 问题)。"""
    reqs, issues = {}, []
    try:
        if prd.exists('data/requirements.csv'):
            header, rows = _csv(prd.read_text, 'data/requirements.csv')
            cc, pc = _col(header, 'REQ编号', '需求编号', '编号'), _col(header, '优先级')
            for _, r in rows:
                code = _cell(r, cc)
                if RE_REQ.fullmatch(code):
                    reqs[code] = _cell(r, pc)
    except Exception as ex:
        issues.append(ctx.issue(rule, SEV, 0, 'data/requirements.csv', f'关联 PRD 的 data/requirements.csv 读取失败：{type(ex).__name__}: {ex}'))
    try:
        for e in prd.doc.entities.get('requirement') or []:
            row = e.get('row') or {}
            pri = _cell(row, _col(list(row.keys()), '优先级'))
            if not reqs.get(e['code']):
                reqs[e['code']] = pri
    except Exception as ex:
        issues.append(ctx.issue(rule, SEV, 0, 'prd', f'关联 PRD 正文解析失败：{type(ex).__name__}: {str(ex)[:120]}'))
    return reqs, issues


def _tc_cases(tc, ctx, rule):
    """关联测试用例：data/cases.csv ∪ 对方正文 test_case 实体；返回 ({用例编号: 行}, 问题)。"""
    cases, issues = {}, []
    try:
        if tc.exists('data/cases.csv'):
            header, rows = _csv(tc.read_text, 'data/cases.csv')
            ic = _col(header, '用例编号')
            for _, r in rows:
                if _cell(r, ic):
                    cases.setdefault(_cell(r, ic), r)
    except Exception as ex:
        issues.append(ctx.issue(rule, SEV, 0, 'data/cases.csv', f'关联测试用例的 data/cases.csv 读取失败：{type(ex).__name__}: {ex}'))
    try:
        for e in tc.doc.entities.get('test_case') or []:
            cases.setdefault(e['code'], e.get('row') or {})
    except Exception as ex:
        issues.append(ctx.issue(rule, SEV, 0, 'test-cases', f'关联测试用例正文解析失败：{type(ex).__name__}: {str(ex)[:120]}'))
    return cases, issues


# ---------------------------------------------------------------- 本包规则

REASON = re.compile(r'原因|理由|因为|由于')


def check(doc, ctx):
    out, memo = [], {}
    cov = _section(doc, 'coverage')
    rows = []  # 覆盖矩阵行：(REQ 编号, 行记录, 行号)
    for t in _tables(doc, cov):
        recs = _records(t)
        for i, row in enumerate(t.get('rows') or []):
            c0 = (row[0] if row else '').strip()
            if RE_REQ.fullmatch(c0):
                rows.append((c0, recs[i] if i < len(recs) else {}, _where(t, i, c0)))
    # PLAN-02 覆盖矩阵引用的 REQ 在关联 PRD 中存在
    prd, iss = _related(ctx, 'PLAN-02', 'prd', 'source_prd', memo)
    out += iss
    reqs = {}
    if prd is not None:
        reqs, iss = _prd_requirements(prd, ctx, 'PLAN-02')
        out += iss
        if cov and not rows:
            out.append(ctx.issue('PLAN-02', SEV, cov['start'], _title(cov), '需求覆盖矩阵节没有以 REQ 编号开头的行'))
        if reqs:
            for code, rec, line in rows:
                if code not in reqs:
                    out.append(ctx.issue('PLAN-02', SEV, *line, f'覆盖矩阵引用的 {code} 在关联 PRD 中不存在'))
    # PLAN-03 重算覆盖：PRD 的 P0/P1 需求在关联测试用例的「关联需求」列里至少出现一次；本文矩阵的覆盖状态与用例数与重算一致
    tc, iss = _related(ctx, 'PLAN-03', 'test-cases', 'references', memo)
    out += iss
    if prd is not None and tc is not None and reqs:
        cases, iss = _tc_cases(tc, ctx, 'PLAN-03')
        out += iss
        count = {}
        for r in cases.values():
            for q in set(RE_REQ.findall(_cell(r, _col(list(r.keys()), '关联需求')))):
                count[q] = count.get(q, 0) + 1
        if not cases:
            out.append(ctx.issue('PLAN-03', SEV, 0, 'test-cases', '关联测试用例没有读到任何用例（data/cases.csv 与正文都没有），无法重算覆盖'))
        else:
            for code, pri in reqs.items():
                if pri.upper() in ('P0', 'P1') and not count.get(code):
                    out.append(ctx.issue('PLAN-03', SEV, 0, code, f'PRD {pri} 需求 {code} 在关联测试用例中没有任何用例（按 test-cases 关联需求列重算，D2 门条件）'))
            for code, rec, line in rows:
                n = count.get(code, 0)
                keys = list(rec.keys())
                st, nv = _cell(rec, _col(keys, '覆盖状态', '覆盖')), _cell(rec, _col(keys, '关联用例数', '用例数'))
                if '已覆盖' in st and n == 0:
                    out.append(ctx.issue('PLAN-03', SEV, *line, f'覆盖矩阵写 {code}「{st}」，但关联测试用例里没有用例引用它'))
                elif '未覆盖' in st and n > 0:
                    out.append(ctx.issue('PLAN-03', SEV, *line, f'覆盖矩阵写 {code}「{st}」，但关联测试用例里有 {n} 条用例引用它'))
                if nv.isdigit() and int(nv) != n:
                    out.append(ctx.issue('PLAN-03', SEV, *line, f'覆盖矩阵写 {code} 关联用例 {nv} 条，按测试用例重算为 {n} 条'))
    # PLAN-04 准入准出标准含数字
    ee = _section(doc, 'entry-exit')
    if ee and not re.search(r'\d', _body(doc, ee)):
        out.append(ctx.issue('PLAN-04', SEV, ee['start'], _title(ee), '准入与准出标准没有任何数字（通过率、缺陷数等可量化门槛）'))
    # PLAN-05 不测范围逐条有原因
    scope = _section(doc, 'scope')
    if scope:
        subs = [x for x in _subheadings(doc, scope) if '不测' in (x[0].get('plain') or x[0].get('title') or '')]
        if not subs and '不测' not in _body(doc, scope):
            out.append(ctx.issue('PLAN-05', SEV, scope['start'], _title(scope), '测试范围节没有写不测范围（及不测理由）'))
        for h, s, e in subs:
            reg = {'start': s, 'end': e}
            for lst in doc.lists:
                for it in lst['items']:
                    if _in(reg, it['line']) and not REASON.search(it.get('text') or ''):
                        out.append(ctx.issue('PLAN-05', SEV, it['line'], it.get('text') or '', '不测范围条目没有写原因'))
            for t in _tables(doc, reg):
                rc = _col(t['header'], '原因', '理由')
                for i, r in enumerate(_records(t)):
                    if not rc or not _cell(r, rc):
                        out.append(ctx.issue('PLAN-05', SEV, *_where(t, i, _first(r)), '不测范围条目没有写原因'))
    # PLAN-06 缺陷级别有判定标准
    dm = _section(doc, 'defect-mgmt')
    if dm and not any(_col(t['header'], '级别') and _col(t['header'], '判定', '标准', '定义') for t in _tables(doc, dm)):
        out.append(ctx.issue('PLAN-06', SEV, dm['start'], _title(dm), '缺陷管理节没有同时含「级别」与「判定标准」列的缺陷级别表'))
    return _finish(out)
