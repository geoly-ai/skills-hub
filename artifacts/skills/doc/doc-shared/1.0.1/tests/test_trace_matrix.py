#!/usr/bin/env python3
"""trace_matrix.py 自测（离线、只写系统临时目录；不改 doc-shared 与样张）。
用法：python3 test_trace_matrix.py [--keep]；退出码 0 全部通过，1 有失败。
夹具：doc-shared/types/*/samples 复制到临时目录（保持 types/<类型>/samples/<样张> 相对结构，related_docs 相对路径仍可解析）。"""
import copy, csv, io, json, os, re, shutil, subprocess, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(H)
SCRIPT = os.path.join(ROOT, 'scripts', 'trace_matrix.py')
SCHEMA = json.load(open(os.path.join(ROOT, 'schemas', 'trace-matrix.schema.json'), encoding='utf-8'))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import validate  # noqa: E402
import docmark_parse as dp  # noqa: E402

SAMPLE = 'membership-points-v2'
FIVE = ('prd', 'tech-spec', 'test-plan', 'test-cases', 'test-report')
fails = []
BASE = tempfile.mkdtemp(prefix='trace-matrix-tests-')


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:600]}]' if detail and not cond else ''))
    if not cond:
        fails.append(name)


def fixture(name):
    root = os.path.join(BASE, name, 'types')
    for t in sorted(os.listdir(os.path.join(ROOT, 'types'))):
        src = os.path.join(ROOT, 'types', t, 'samples')
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(root, t, 'samples'), ignore=shutil.ignore_patterns('out'))
    return root


def rd(root, t):
    return os.path.join(root, t, 'samples', SAMPLE)


def run(run_dir, *args, env=None):
    r = subprocess.run([sys.executable, SCRIPT, run_dir] + list(args), capture_output=True, text=True, timeout=300, env=env)
    try:
        body = json.loads(r.stdout)
    except ValueError:
        body = {'raw': r.stdout[-400:] + r.stderr[-400:]}
    m = None
    jp = body.get('json') if isinstance(body, dict) else None
    if r.returncode in (0, 3) and jp and os.path.exists(jp):
        m = json.load(open(jp, encoding='utf-8'))
    return r.returncode, body, m


def gaps(m, kind=None, code=None):
    return [g for g in (m or {}).get('gaps', []) if (kind is None or g['kind'] == kind) and (code is None or g['code'] == code)]


def edit(path, fn):
    s = open(path, encoding='utf-8').read(); s2 = fn(s)
    assert s2 != s, f'夹具改动没有生效：{path}'
    open(path, 'w', encoding='utf-8').write(s2)


def edit_json(path, fn):
    d = json.load(open(path, encoding='utf-8')); fn(d)
    json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


def normalize(m):
    """去掉路径与时间，只留跨入口应一致的内容。"""
    m = copy.deepcopy(m)
    for k in ('generated_at', 'root_run_dir'):
        m.pop(k, None)
    for v in m['docs'].values():
        if v: v.pop('run_dir', None)
    m['links'] = sorted([{k: v for k, v in l.items() if not k.endswith('run_dir')} for l in m['links']], key=lambda l: json.dumps(l, sort_keys=True))
    return json.dumps(m, ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------- 0. 单元：编号扫描
import trace_matrix as tm  # noqa: E402
rx, full = tm.code_regex(r'^REQ-[A-Z]+-\d{2}$')
check('简写续号：REQ-RULE-01/02 展开为两条', tm.find_codes('见 REQ-RULE-01/02（运营）', rx, full) == ['REQ-RULE-01', 'REQ-RULE-02'])
check('简写续号：位宽不同或非数字不展开', tm.find_codes('REQ-RULE-01/2 与 REQ-A-01/xx', rx, full) == ['REQ-RULE-01', 'REQ-A-01'])
check('编号边界：前后粘连字母数字不算', tm.find_codes('XREQ-A-01 REQ-A-011 REQ-A-01', rx, full) == ['REQ-A-01'])
vl = dict(tm.visible_lines(['a REQ-A-01', '```', 'REQ-A-02', '```', 'x <!-- REQ-A-03', 'REQ-A-04 --> REQ-A-05', '~~~~', '~~~', 'REQ-A-06', '~~~~',
                            '<!--', '```', 'REQ-A-07 -->', 'REQ-A-08']))
# 2026-09-15 W3-H：遮蔽统一到 doc-shared/scripts/code_scan.py，口径同共享解析器——只认 ``` 围栏，~~~ 按正文渲染所以算引用；注释内的 ``` 不切换代码块
check('遮蔽：代码块与跨行注释内不算，注释后同行正文算；~~~ 不是代码块；注释里的 ``` 不开代码块',
      vl[1] == 'a REQ-A-01' and vl[3] == '' and 'REQ-A-03' not in vl[5] and vl[6].strip() == 'REQ-A-05' and vl[9] == 'REQ-A-06'
      and 'REQ-A-07' not in vl[13] and vl[14] == 'REQ-A-08', vl)
import code_scan as cs  # noqa: E402
check('遮蔽与 fill_check 同一实现：trace_matrix.visible_lines 即 code_scan.visible_lines，列位置与 masked_lines 一致',
      tm.visible_lines is cs.visible_lines and tm.find_codes is cs.find_codes and dict(cs.visible_lines(['p <!-- q --> r']))[1] == cs.masked_lines(['p <!-- q --> r'])[0])

# ---------------------------------------------------------------- 1. 五份样张
F = fixture('base')
code, body, m = run(rd(F, 'test-plan'))
check('样张：从 test-plan 入口退出 0 且写出 JSON 与 md', code == 0 and m is not None and os.path.exists(body.get('md', '')), (code, body))
if m:
    s = m['summary']
    check('样张：19 条需求、47 条用例、47 条结果、4 条缺陷', (s['requirements'], s['cases'], s['results'], s['defects']) == (19, 47, 47, 4), s)
    check('样张：43 通过、1 失败、3 阻塞、无缺结果、无必改、文档齐全', (s['passed'], s['failed'], s['blocked'], s['no_result'], s['must_fix'], s['complete']) == (43, 1, 3, 0, 0, True), s)
    check('样张：输出过 trace-matrix.schema.json', not validate.check(m, SCHEMA, SCHEMA), validate.check(m, SCHEMA, SCHEMA)[:3])
    req = {r['code']: r for r in m['requirements']}
    check('样张：REQ-RULE-02 经简写续号被 tech-spec 覆盖，REQ-ACCT-01 未覆盖', req['REQ-RULE-02']['design'] and not req['REQ-ACCT-01']['design'], (req['REQ-RULE-02']['design'], req['REQ-ACCT-01']['design']))
    check('样张：tech-spec 摘要里提到的编号不算设计覆盖（设计章节都有章节号）', all(d['number'] for r in m['requirements'] for d in r['design']))
    check('样张：REQ-RULE-02 → TC-RULE-06 失败 → DEF-003，需求状态 failed', 'TC-RULE-06' in req['REQ-RULE-02']['cases'] and req['REQ-RULE-02']['status'] == 'failed' and 'DEF-003' in req['REQ-RULE-02']['defects'], req['REQ-RULE-02'])
    check('样张：REQ-TIER-03 用例全阻塞 → blocked', req['REQ-TIER-03']['status'] == 'blocked', req['REQ-TIER-03'])
    cases = {c['code']: c for c in m['cases']}
    check('样张：用例模块取所在章节标题，执行结果带执行人与日期', cases['TC-ACCT-01']['module'] == '积分账户' and cases['TC-ACCT-01']['result']['executed_by'] == '刘洋' and cases['TC-ACCT-01']['csv_line'] == 2, cases['TC-ACCT-01'])
    check('样张：缺口只有 req_not_designed（P0 建议、其余提示）', {g['kind'] for g in m['gaps']} == {'req_not_designed'} and all(g['severity'] == ('建议' if req[g['code']]['priority'] == 'P0' else '提示') for g in m['gaps']), m['gaps'][:3])
    check('样张：未登记版本的链接 match 为 null', all(l['match'] is None for l in m['links'] if l['registered_version'] is None))
    norm0 = normalize(m)
    same = []
    for t in FIVE:
        c2, _, m2 = run(rd(F, t), '--out', os.path.join(BASE, 'entry-' + t))
        same.append((t, c2 == 0 and m2 is not None and normalize(m2) == norm0))
    check('样张：从五个入口任一运行，去掉路径与时间后结果一致', all(x for _, x in same), same)
    # 片段可 include
    c3, b3, _ = run(rd(F, 'test-plan'), '--snippet', 'sections/trace-matrix.md')
    snip = os.path.join(rd(F, 'test-plan'), 'sections', 'trace-matrix.md')
    check('片段：--snippet 写到 sections/ 并提示源文件变化', c3 == 0 and os.path.exists(snip) and any('D3' in w for w in b3.get('warnings', [])), b3)
    pack = json.load(open(os.path.join(ROOT, 'types', 'test-plan', 'pack.json'), encoding='utf-8'))
    edit(os.path.join(rd(F, 'test-plan'), 'doc.md'), lambda s: s.replace('## 8. 需求覆盖矩阵\n', '## 8. 需求覆盖矩阵\n\n<!-- include: sections/trace-matrix.md -->\n', 1))
    d = dp.parse_file(rd(F, 'test-plan'), 'doc.md', pack=pack)
    tabs = [t for t in d.tables if (t.get('caption') or '').startswith('需求追踪矩阵')]
    check('片段：include 进 test-plan 后解析无 error、表格 1 张且行数 = 需求×用例对数', not d.errors() and len(tabs) == 1 and len(tabs[0]['rows']) == 47 and all(i['status'] == 'ok' for i in d.includes),
          (d.errors()[:2], len(tabs), [i['status'] for i in d.includes]))
    c4, b4, _ = run(rd(F, 'test-plan'), '--snippet', 'sections/trace-matrix.md')
    check('片段：已存在的生成文件可覆盖', c4 == 0, b4)
    open(snip, 'w', encoding='utf-8').write('手写内容\n')
    c5, b5, _ = run(rd(F, 'test-plan'), '--snippet', 'sections/trace-matrix.md')
    c6, _, _ = run(rd(F, 'test-plan'), '--snippet', 'sections/trace-matrix.md', '--force')
    check('片段：手写文件拒绝覆盖（退出 2），--force 才覆盖', c5 == 2 and '拒绝覆盖' in b5.get('error', '') and c6 == 0, (c5, b5, c6))
    c7, b7, _ = run(rd(F, 'test-plan'), '--snippet', 'out/x.md')
    c8, b8, _ = run(rd(F, 'test-plan'), '--snippet', '../x.md')
    os.remove(snip); os.symlink(os.path.join(BASE, 'elsewhere.md'), snip)
    c9, b9, _ = run(rd(F, 'test-plan'), '--snippet', 'sections/trace-matrix.md', '--force')
    check('片段：白名单外、含 ..、符号链接目标一律退出 2', (c7, c8, c9) == (2, 2, 2) and '白名单' in b7.get('error', '') and '符号链接' in b9.get('error', ''), (b7, b8, b9))

# ---------------------------------------------------------------- 2. 缺口反例
F = fixture('neg')
cases_csv = os.path.join(rd(F, 'test-cases'), 'data', 'cases.csv')
edit(cases_csv, lambda s: s.rstrip('\n') + '\nTC-ACCT-05,指向不存在需求的用例,REQ-ACCT-09,P1,功能,无,1. 步骤,无,可观察结果,否\nTC-ACCT-06,没有关联需求的用例,,P2,功能,无,1. 步骤,无,可观察结果,否\n')
edit(os.path.join(rd(F, 'test-report'), 'data', 'execution.csv'), lambda s: s.replace('TC-ADMIN-03,通过,刘洋,2026-08-15,\n', '').rstrip('\n')
     .replace('TC-ACCT-02,通过,', 'TC-ACCT-02,OK,') + '\nTC-ACCT-01,失败,周涛,2026-08-16,重复且冲突\nTC-GHOST-01,通过,刘洋,2026-08-15,\n')
edit(os.path.join(rd(F, 'test-report'), 'data', 'defects.csv'), lambda s: s.rstrip('\n') + '\nDEF-005,关联不存在用例的缺陷,P3,TC-NOPE-01,已关闭,2026-08-19,2026-08-19,\n')
edit(os.path.join(rd(F, 'prd'), 'doc.md'), lambda s: re.sub(r'(\| REQ-ADMIN-01 \|[^\n]*\n)', r'\1| REQ-ADMIN-02 | 运营导出积分审计报表 | 运营发起导出 | 超过 10 万行分批 | P0 | 导出文件字段完整 |\n', s, count=1))
edit_json(os.path.join(rd(F, 'test-cases'), 'doc.json'), lambda d: d['related_docs'][0].__setitem__('version', '1.0'))
edit_json(os.path.join(rd(F, 'test-plan'), 'doc.json'), lambda d: d['related_docs'][0].__setitem__('version', 'v1.2'))
code, body, m = run(rd(F, 'test-report'))
check('反例：有必改缺口退出 3，输出仍过 schema', code == 3 and m is not None and not validate.check(m, SCHEMA, SCHEMA), (code, body.get('error')))
if m:
    check('反例：用例指向不存在的需求 → case_unknown_req 必改（带 CSV 行号）', any(g['severity'] == '必改' and g['file'] == 'data/cases.csv' and g['csv_line'] == 49 for g in gaps(m, 'case_unknown_req', 'TC-ACCT-05')), gaps(m, 'case_unknown_req'))
    check('反例：关联需求为空 → case_no_req 建议', [g['severity'] for g in gaps(m, 'case_no_req', 'TC-ACCT-06')] == ['建议'], gaps(m, 'case_no_req'))
    check('反例：P0 需求无用例 → req_no_cases 必改', [g['severity'] for g in gaps(m, 'req_no_cases', 'REQ-ADMIN-02')] == ['必改'], gaps(m, 'req_no_cases'))
    check('反例：删掉一条执行记录 → case_no_result', bool(gaps(m, 'case_no_result', 'TC-ADMIN-03')) and bool(gaps(m, 'case_no_result', 'TC-ACCT-05')), gaps(m, 'case_no_result'))
    check('反例：同一用例结果冲突 → result_conflict，保留先出现的「通过」', bool(gaps(m, 'result_conflict', 'TC-ACCT-01')) and next(c for c in m['cases'] if c['code'] == 'TC-ACCT-01')['result']['status'] == 'passed')
    check('反例：执行结果指向不存在的用例 → result_unknown_case', bool(gaps(m, 'result_unknown_case', 'TC-GHOST-01')))
    check('反例：状态「OK」不在词表 → result_invalid_status，status 为 null', bool(gaps(m, 'result_invalid_status', 'TC-ACCT-02')) and next(c for c in m['cases'] if c['code'] == 'TC-ACCT-02')['result']['status'] is None)
    check('反例：缺陷关联不存在的用例 → defect_unknown_case', bool(gaps(m, 'defect_unknown_case', 'DEF-005')))
    vm = gaps(m, 'version_mismatch')
    check('反例：登记 1.0 而 PRD 当前 1.2 → version_mismatch；登记 v1.2 视为一致', len(vm) == 1 and vm[0]['doc_type'] == 'test-cases' and
          any(l['from_type'] == 'test-plan' and l['to_type'] == 'prd' and l['match'] is True for l in m['links']), (vm, [l for l in m['links'] if l['to_type'] == 'prd']))
# tech-spec 不再提及任何需求
F = fixture('nodesign')
edit(os.path.join(rd(F, 'tech-spec'), 'doc.md'), lambda s: re.sub(r'REQ-[A-Z]+-\d{2}(?:/\d{2})?', '相关需求', s))
code, body, m = run(rd(F, 'prd'))
check('反例：tech-spec 删掉全部需求提及 → 19 条 req_not_designed，退出 0（不是必改）', code == 0 and m and m['summary']['designed'] == 0 and len(gaps(m, 'req_not_designed')) == 19, (code, body.get('summary')))
# 同类型两份：歧义退出 2，显式指定后通过
F = fixture('ambig')
alt = os.path.join(F, 'test-cases', 'samples', 'alt')
shutil.copytree(rd(F, 'test-cases'), alt)
edit_json(os.path.join(rd(F, 'test-plan'), 'doc.json'), lambda d: d['related_docs'].append({'type': 'test-cases', 'role': 'references', 'path': '../../../test-cases/samples/alt'}))
code, body, m = run(rd(F, 'test-plan'))
check('歧义：同类型两份退出 2 并列 candidates', code == 2 and len((body.get('candidates') or {}).get('test-cases', [])) == 2, body)
code, body, m = run(rd(F, 'test-plan'), '--cases', alt)
check('歧义：--cases 显式指定后退出 0 且用的是指定目录', code == 0 and m['docs']['test-cases']['run_dir'] == os.path.realpath(alt), (code, body.get('error')))
code, body, _ = run(rd(F, 'test-plan'), '--cases', rd(F, 'prd'))
check('显式指定类型不符退出 2', code == 2 and '不是 test-cases' in body.get('error', ''), body)
# 缺测试用例文档：doc_missing 必改，不能「通过」
F = fixture('missing')
shutil.rmtree(rd(F, 'test-cases'))
code, body, m = run(rd(F, 'test-plan'))
check('缺失：找不到 test-cases → doc_missing 必改、退出 3、complete=false、跳过相关检查', code == 3 and m and gaps(m, 'doc_missing') and gaps(m, 'doc_missing')[0]['severity'] == '必改'
      and not m['summary']['complete'] and any(s['kind'] == 'req_no_cases' for s in m['skipped_checks']) and any('无法解析' in w for w in m['warnings']), (code, body))
shutil.rmtree(rd(F, 'prd'))
code, body, _ = run(rd(F, 'test-report'))
check('缺失：找不到 PRD 退出 2', code == 2 and 'PRD' in body.get('error', ''), body)
# 报告只有正文 Markdown 表（无 CSV）：复合编号单元格也能取到
F = fixture('mdreport')
os.remove(os.path.join(rd(F, 'test-report'), 'data', 'execution.csv'))
edit(os.path.join(rd(F, 'test-report'), 'doc.md'), lambda s: s.rstrip('\n') + '\n\n## 7. 执行明细\n\n<!-- table: 执行明细 -->\n| 用例编号 | 执行结果 | 执行人 |\n|---|---|---|\n| TC-ACCT-01 / TC-ACCT-02 | 通过 | 刘洋 |\n| TC-RULE-06 | 失败 | 周涛 |\n')
code, body, m = run(rd(F, 'test-report'))
if m:
    cs = {c['code']: c for c in m['cases']}
    check('正文表：Markdown 执行表被识别（复合单元格拆成两条），其余用例 case_no_result', cs['TC-ACCT-02']['result'] and cs['TC-ACCT-02']['result']['status'] == 'passed'
          and cs['TC-RULE-06']['result']['status'] == 'failed' and len(gaps(m, 'case_no_result')) == 44 and gaps(m, 'case_no_result')[0]['line'], (m['summary'], gaps(m, 'case_no_result')[:1]))
else:
    check('正文表：Markdown 执行表被识别', False, (code, body))
os.remove(os.path.join(rd(F, 'test-report'), 'data', 'defects.csv'))
edit(os.path.join(rd(F, 'test-report'), 'doc.md'), lambda s: s.replace('| 用例编号 | 执行结果 | 执行人 |', '| 用例 | 说明 | 执行人 |'))
code, body, m = run(rd(F, 'test-report'))
check('正文表：报告里没有执行表 → report_no_execution，跳过 case_no_result', m and gaps(m, 'report_no_execution') and not gaps(m, 'case_no_result') and any(s['kind'] == 'case_no_result' for s in m['skipped_checks']), (code, body.get('gaps_by_kind')))
# 类型包：DOC_TYPES_DIRS 里的坏包退出 2
F = fixture('badpack')
bad = os.path.join(BASE, 'badtypes', 'test-report'); os.makedirs(bad)
json.dump({'id': 'test-report'}, open(os.path.join(bad, 'pack.json'), 'w'))
code, body, _ = run(rd(F, 'test-plan'), env={**os.environ, 'DOC_TYPES_DIRS': os.path.join(BASE, 'badtypes')})
check('类型包：可信目录里的类型包不合 schema 退出 2', code == 2 and 'pack schema' in body.get('error', ''), body)
# --scan 找到只单向登记的下游
F = fixture('scan')
edit_json(os.path.join(rd(F, 'test-plan'), 'doc.json'), lambda d: d.__setitem__('related_docs', [x for x in d['related_docs'] if x['type'] != 'test-report']))
edit_json(os.path.join(rd(F, 'test-cases'), 'doc.json'), lambda d: d.__setitem__('related_docs', [x for x in d['related_docs'] if x['type'] != 'test-report']))
code, body, m = run(rd(F, 'prd'))
code2, body2, m2 = run(rd(F, 'prd'), '--scan', F)
check('--scan：只由 test-report 单向登记时，不扫描找不到报告，扫描后找到', m and m['docs']['test-report'] is None and m2 and m2['docs']['test-report'] is not None and m2['summary']['results'] == 47,
      (body.get('docs', {}).get('test-report'), body2.get('summary')))
# 默认 out/ 是符号链接：拒绝写到外部
F = fixture('outlink')
ext = os.path.join(BASE, 'outside'); os.makedirs(ext)
os.symlink(ext, os.path.join(rd(F, 'test-plan'), 'out'))
code, body, _ = run(rd(F, 'test-plan'))
check('输出：默认 out/ 为符号链接 → 退出 2，外部目录不写入', code == 2 and '符号链接' in body.get('error', '') and not os.listdir(ext), (code, body, os.listdir(ext)))
# schema 反例
if m2:
    bad = copy.deepcopy(m2); bad['gaps'].append({'kind': 'x', 'severity': '严重', 'code': None, 'doc_type': 'prd', 'line': None, 'file': None, 'csv_line': None, 'message': 'm'})
    bad2 = copy.deepcopy(m2); bad2['requirements'] = []
    check('schema：未知 kind 与定级、空需求表都被拒', len(validate.check(bad, SCHEMA, SCHEMA)) >= 2 and validate.check(bad2, SCHEMA, SCHEMA))
check('schema：只用校验器支持的关键字', not (validate.schema_keywords(SCHEMA) - validate.SUPPORTED))

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}（临时目录：{BASE}）")
if '--keep' not in sys.argv and not fails:
    shutil.rmtree(BASE, ignore_errors=True)
sys.exit(1 if fails else 0)
