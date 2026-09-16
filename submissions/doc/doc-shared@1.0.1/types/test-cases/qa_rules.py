"""测试用例（test-cases）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

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


# ---------------------------------------------------------------- 本包规则

REQUIRED = ['用例编号', '标题', '关联需求', '优先级', '类型', '前置条件', '测试步骤', '预期结果']
PRIORITIES = {'P0', 'P1', 'P2', 'P3'}
TYPES = {'功能', '接口', '兼容', '性能', '安全', '异常', '边界'}
ABNORMAL_RANGE = (20, 40)  # CASE-06 异常类占比建议区间（整数百分比，含端点）
STEP_NUM = re.compile(r'(?:^|[；;。，,\s])(\d{1,2})[.、．)）](?!\d)')


def _nums(s):
    return len(set(STEP_NUM.findall(s or '')))


def check(doc, ctx):
    out, memo = [], {}
    rels = []
    for t in doc.tables:
        if t.get('source') == 'data' and t.get('data_file') and '用例编号' in (t.get('header') or []) and t['data_file'] not in rels:
            rels.append(t['data_file'])
    rels = rels or ['data/cases.csv']
    ent_line = {}
    for e in doc.entities.get('test_case') or []:
        ent_line.setdefault(e['code'], e['line'])
    cases = []  # (rel, CSV 行号, 行)
    for rel in rels:
        if not ctx.exists_safe(rel):
            out.append(ctx.issue('CASE-01', SEV, 0, rel, f'找不到用例数据 {rel}'))
            continue
        header, rows = _csv(ctx.read_text, rel)
        miss = [c for c in REQUIRED if c not in header]
        if miss:
            out.append(ctx.issue('CASE-01', SEV, 0, rel, f'{rel} 缺必填列：{"、".join(miss)}'))
        cases += [(rel, ln, r) for ln, r in rows]
    where = lambda rel, ln, r: (0, f'{rel} 第 {ln} 行 {r.get("用例编号", "")}'.strip())  # CSV 行：数据块各行共用指令行号，报全文级免被同行合并
    # CASE-01 必填字段非空、编号唯一（全量 CSV，不只看被 filter 渲染的行）
    seen = {}
    for rel, ln, r in cases:
        line, ex = where(rel, ln, r)
        cid = r.get('用例编号', '')
        empty = [c for c in REQUIRED if c in r and not r[c]]
        if empty:
            out.append(ctx.issue('CASE-01', SEV, line, ex, f'用例 {cid or "（无编号）"} 必填字段为空：{"、".join(empty)}'))
        if cid:
            if cid in seen:
                out.append(ctx.issue('CASE-01', SEV, line, ex, f'用例编号 {cid} 重复（{seen[cid]} 与 {rel} 第 {ln} 行）'))
            else:
                seen[cid] = f'{rel} 第 {ln} 行'
    # CASE-02 / 03 跨读关联 PRD
    prd, iss = _related(ctx, 'CASE-02', 'prd', 'source_prd', memo)
    out += iss
    if prd is not None:
        reqs, iss = _prd_requirements(prd, ctx, 'CASE-02')
        out += iss
        linked = set()
        for rel, ln, r in cases:
            line, ex = where(rel, ln, r)
            raw = r.get('关联需求', '')
            codes = RE_REQ.findall(raw)
            linked.update(codes)
            if raw and not codes:
                out.append(ctx.issue('CASE-02', SEV, line, ex, f'用例 {r.get("用例编号", "")} 的关联需求「{raw}」没有 REQ 编号'))
            if reqs:
                for q in codes:
                    if q not in reqs:
                        out.append(ctx.issue('CASE-02', SEV, line, ex, f'用例 {r.get("用例编号", "")} 关联的 {q} 在关联 PRD 中不存在'))
        for code, pri in reqs.items():
            if pri.upper() in ('P0', 'P1') and code not in linked:
                out.append(ctx.issue('CASE-03', SEV, 0, code, f'PRD {pri} 需求 {code} 没有任何用例（D2 门条件）'))
    # CASE-05 步骤与预期条数对应（预期写成整体结果时不编号，不查；预期有编号就要与步骤条数一致）
    for rel, ln, r in cases:
        st, exn = _nums(r.get('测试步骤')), _nums(r.get('预期结果'))
        if exn >= 1 and st != exn:
            line, ex = where(rel, ln, r)
            out.append(ctx.issue('CASE-05', SEV, line, ex, f'用例 {r.get("用例编号", "")} 测试步骤 {st} 条、预期结果 {exn} 条，编号对不上'))
    # CASE-06 异常类占比
    typed = [r for _, _, r in cases if r.get('类型')]
    if typed:
        pct = round(100 * sum(1 for r in typed if r['类型'] == '异常') / len(typed))
        if not ABNORMAL_RANGE[0] <= pct <= ABNORMAL_RANGE[1]:
            out.append(ctx.issue('CASE-06', SEV, 0, rels[0], f'异常类用例占比约 {pct}%，不在建议区间 {ABNORMAL_RANGE[0]}%–{ABNORMAL_RANGE[1]}%'))
    # CASE-07 / 08 取值合法
    for rel, ln, r in cases:
        line, ex = where(rel, ln, r)
        if r.get('优先级') and r['优先级'] not in PRIORITIES:
            out.append(ctx.issue('CASE-07', SEV, line, ex, f'用例 {r.get("用例编号", "")} 优先级「{r["优先级"]}」不在 P0–P3'))
        if r.get('类型') and r['类型'] not in TYPES:
            out.append(ctx.issue('CASE-08', SEV, line, ex, f'用例 {r.get("用例编号", "")} 类型「{r["类型"]}」不在 {"、".join(sorted(TYPES))}'))
    # CASE-09 模块小节：每个模块（用例编号 TC-<模块>- 前缀）的用例都出现在正文
    missing = {}
    for rel, ln, r in cases:
        cid = r.get('用例编号', '')
        m = re.match(r'^(TC-[A-Z0-9]+-)', cid)
        if m and cid not in ent_line:
            missing.setdefault(m.group(1), []).append(cid)
    for prefix, ids in missing.items():
        out.append(ctx.issue('CASE-09', SEV, 0, prefix, f'模块 {prefix} 有 {len(ids)} 条用例没出现在正文（缺该模块的用例小节，或数据块 filter 漏行）：{"、".join(ids[:5])}'))
    return _finish(out)
