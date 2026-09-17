"""测试报告（test-report）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

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
RE_TC = re.compile(r'(?<![A-Za-z0-9-])TC-[A-Z0-9]+-\d+(?![\d])')


# ---------------------------------------------------------------- 跨文档读取（本包用到的关联文档形状）

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

CRIT_NUM = re.compile(r'(P[0-3])\s*(用例通过率|通过率|缺陷数)\s*(≥|≤|>=|<=|<|>|=|不低于|不少于|不超过|不高于|低于|高于|少于|多于)?\s*(\d+(?:\.\d+)?)\s*(?:%|％|条|个)?')
CRIT_ZERO = re.compile(r'无\s*未(?:解决|关闭|修复)的?\s*(P[0-3])\s*级?缺陷')
OPS = {'>=': '≥', '不低于': '≥', '不少于': '≥', '<=': '≤', '不超过': '≤', '不高于': '≤', '低于': '<', '少于': '<', '高于': '>', '多于': '>', None: '=', '=': '='}


def _criteria(text):
    got = {}
    for m in CRIT_NUM.finditer(text):
        metric = '缺陷数' if m.group(2) == '缺陷数' else '用例通过率'
        got.setdefault((m.group(1), metric), (OPS.get(m.group(3), m.group(3)), float(m.group(4))))
    for m in CRIT_ZERO.finditer(text):
        got.setdefault((m.group(1), '未解决缺陷数'), ('=', 0.0))
    return got


def _fmt(key, v):
    num = ('%g' % v[1]) + ('%' if key[1] == '用例通过率' else '')
    return f'{key[0]} {key[1]} {v[0]} {num}'


def check(doc, ctx):
    out, memo = [], {}
    # REPORT-02 准出结论取值合法
    concl = _section(doc, 'conclusion')
    if concl and not re.search(r'不建议发布|有条件发布|建议发布', _body(doc, concl)):
        out.append(ctx.issue('REPORT-02', SEV, concl['start'], _title(concl), '准出结论没有写「建议发布 / 不建议发布 / 有条件发布」三者之一'))
    # REPORT-03 按模块与优先级双维度统计
    cs = _section(doc, 'case-stats')
    if cs:
        ts = _tables(doc, cs)
        miss = [n for n in ('模块', '优先级') if not any(_col(t['header'], n) for t in ts)]
        if miss:
            out.append(ctx.issue('REPORT-03', SEV, cs['start'], _title(cs), f'用例执行统计缺按{"、".join(miss)}的统计表'))
    # REPORT-04 缺陷统计含级别、状态、趋势
    ds = _section(doc, 'defect-stats')
    if ds:
        ts = _tables(doc, ds)
        miss = [n for n in ('级别', '状态') if not any(_col(t['header'], n) for t in ts)]
        if not ([f for f in doc.figures if _in(ds, f['line'])] or '趋势' in _body(doc, ds)):
            miss.append('按时间的趋势（图或文字）')
        if miss:
            out.append(ctx.issue('REPORT-04', SEV, ds['start'], _title(ds), f'缺陷统计缺{"、".join(miss)}'))
    # REPORT-05 引用的 TC 编号在关联测试用例中存在
    refs = {}
    for i, l in enumerate(doc.lines):
        if not doc.code_mask[i] and not doc.comment_mask[i]:
            for code in RE_TC.findall(RE_COMMENT.sub('', l)):
                refs.setdefault(code, (i + 1, l))
    if ctx.exists_safe('data/execution.csv'):
        header, rows = _csv(ctx.read_text, 'data/execution.csv')
        ic = _col(header, '用例编号')
        for ln, r in rows:
            if RE_TC.fullmatch(_cell(r, ic)):
                refs.setdefault(_cell(r, ic), (0, f'data/execution.csv 第 {ln} 行'))
    if refs:
        tc, iss = _related(ctx, 'REPORT-05', 'test-cases', 'reports_on', memo)
        out += iss
        if tc is not None:
            cases, iss = _tc_cases(tc, ctx, 'REPORT-05')
            out += iss
            if cases:
                for code, (line, ex) in refs.items():
                    if code not in cases:
                        out.append(ctx.issue('REPORT-05', SEV, line, ex, f'引用的用例 {code} 在关联测试用例中不存在'))
    # REPORT-06 准出依据与关联测试计划的准出标准逐条一致
    if concl:
        plan, iss = _related(ctx, 'REPORT-06', 'test-plan', 'executes_plan', memo)
        out += iss
        if plan is not None:
            try:
                pdoc = plan.doc
                ee = pdoc.section('entry-exit')
                pbody = _body(pdoc, ee)
            except Exception as ex:
                pdoc, pbody = None, None
                out.append(ctx.issue('REPORT-06', SEV, 0, 'test-plan', f'关联测试计划正文解析失败：{type(ex).__name__}: {str(ex)[:120]}'))
            if pbody is not None:
                k = pbody.find('准出')
                seg = pbody[k:] if k >= 0 else ''
                seg = seg[:seg.find('\n\n')] if '\n\n' in seg else seg
                pc = _criteria(seg)
                std = [(t, _col(t['header'], '标准')) for t in _tables(doc, concl)]
                rtext = '\n'.join(_cell(r, c) for t, c in std if c for r in _records(t)) if any(c for _, c in std) else _body(doc, concl)
                rc = _criteria(rtext)
                if not pc:
                    out.append(ctx.issue('REPORT-06', SEV, concl['start'], 'test-plan', '关联测试计划的准入与准出节没有读到可比对的准出标准（Pn 用例通过率、缺陷数、无未解决 Pn 缺陷）'))
                for key, v in pc.items():
                    if key not in rc:
                        out.append(ctx.issue('REPORT-06', SEV, concl['start'], _fmt(key, v), f'测试计划准出标准「{_fmt(key, v)}」没有在准出结论依据中逐条比对'))
                    elif rc[key] != v:
                        out.append(ctx.issue('REPORT-06', SEV, concl['start'], _fmt(key, rc[key]), f'准出标准口径不一致：测试计划「{_fmt(key, v)}」，本报告「{_fmt(key, rc[key])}」'))
                for key, v in rc.items():
                    if pc and key not in pc:
                        out.append(ctx.issue('REPORT-06', SEV, concl['start'], _fmt(key, v), f'准出结论依据里的「{_fmt(key, v)}」不在测试计划的准出标准中'))
    # REPORT-07 未通过与遗留问题逐条有原因与计划
    oi = _section(doc, 'open-issues')
    if oi:
        ts = _tables(doc, oi)
        if not ts and not re.search(r'无(未通过|遗留)', _body(doc, oi)):
            out.append(ctx.issue('REPORT-07', SEV, oi['start'], _title(oi), '未通过与遗留问题节没有问题表（每条须有原因与计划；确实没有时写明「无未通过用例与遗留缺陷」）'))
        for t in ts:
            rc_, pc_ = _col(t['header'], '原因'), _col(t['header'], '计划')
            if not rc_ or not pc_:
                miss = '、'.join(n for n, c in (('原因', rc_), ('计划', pc_)) if not c)
                out.append(ctx.issue('REPORT-07', SEV, t['line'], ' | '.join(t['header']), f'未通过与遗留问题表缺「{miss}」列'))
                continue
            for i, r in enumerate(_records(t)):
                miss = '、'.join(n for n, c in (('原因', rc_), ('计划', pc_)) if not _cell(r, c))
                if miss:
                    out.append(ctx.issue('REPORT-07', SEV, *_where(t, i, _first(r)), f'「{_first(r)[:30]}」的{miss}为空'))
    # REPORT-08 执行率有具体数字
    ov = _section(doc, 'execution-overview')
    if ov and not re.search(r'\d+(?:\.\d+)?\s*[%％]|\d+\s*/\s*\d+', _body(doc, ov)):
        out.append(ctx.issue('REPORT-08', SEV, ov['start'], _title(ov), '执行概况没有执行率百分比或「已执行 / 计划总数」计数'))
    return _finish(out)
