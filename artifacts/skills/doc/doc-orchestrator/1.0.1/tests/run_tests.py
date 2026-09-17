#!/usr/bin/env python3
"""doc-orchestrator 自测（离线、只写系统临时目录；不改 doc-shared、类型包、样张、golden）。
用法：run_tests.py [--keep] [--quick]（--quick 跳过渲染与全流程）
覆盖：判型（single / ask / handoff / 配置校验）；brief 缺项（doc 必填、类型包 inputs、required 关联文档未登记或解析不到、
样张原始 related_docs 缺 role）；未知类型、售前转交、非空目录；门禁阻塞原因（D0 输入、D1、正文占位符、必备章缺失、交叉引用悬空、
D3 待 Codex、发布脚本缺失、D4 待用户）；prd 与 test-cases 全流程（new_run → D0 → D1 → 样张正文 → advance --run 执行 D2、图、渲染、
质检 → D3 → doc-publish 真实 dry-run --offline → 阻塞在用户确认发布，全程不执行 --apply）；D3 后改源文件判 reset；导入已有文档；
改版（版本校验、修订记录、related 路径重算）与交叉引用复查（上游悬空、下游 stale、本版删除的编号）；status.py；业务词守卫。"""
import glob, json, os, re, shutil, subprocess, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))
ORCH = os.path.dirname(H)
SK = os.path.dirname(ORCH)
S = os.path.join(ORCH, 'scripts')
DS = os.path.join(SK, 'doc-shared')
RS = os.path.join(DS, 'scripts', 'run_state.py')
TYPES = os.path.join(DS, 'types')
PY = sys.executable
QUICK = '--quick' in sys.argv
BASE = tempfile.mkdtemp(prefix='doc-orch-tests-')
DOCS = os.path.join(BASE, 'docs', 'membership-points-v2')
fails = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:700]}]' if detail and not cond else ''))
    if not cond: fails.append(name)


def run(args, env=None, timeout=1800):
    e = dict(os.environ); e.update(env or {})
    r = subprocess.run(args, capture_output=True, text=True, env=e, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def jout(s):
    try:
        return json.loads(s)
    except Exception:
        i = s.find('{'); return json.loads(s[i:]) if i >= 0 else {}


def script(name, *args, env=None, timeout=1800):
    c, o, e = run([PY, os.path.join(S, name), *args], env=env, timeout=timeout)
    return c, jout(o) if o.strip().startswith('{') else o, e


def sample(t):
    return os.path.join(TYPES, t, 'samples', 'membership-points-v2')


def brief_from_sample(t, **over):
    d = json.load(open(os.path.join(sample(t), 'doc.json'), encoding='utf-8'))
    for k in ('type', 'revision_history', 'related_docs'): d.pop(k, None)
    pack = json.load(open(os.path.join(TYPES, t, 'pack.json'), encoding='utf-8'))
    d['inputs'] = {i['id']: f'测试输入：{i["desc"]}' for i in pack['inputs']}
    d['related_docs'] = []
    d.update(over)
    return d


def write_brief(name, d):
    p = os.path.join(BASE, 'briefs', name); os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False); return p


def decide_all(rd, env=None, extra=()):
    of = os.path.join(rd, 'outline.md')
    items = sorted(set(re.findall(r'^([\u2460-\u2473]) ', open(of, encoding='utf-8').read(), re.M))) if os.path.exists(of) else []
    for k in items or ['①']:
        run([PY, RS, rd, 'decide', '--key', k, '--value', 'A 按推荐（自测）', *extra], env=env)


def gate(rd, g, ev, env=None, extra=()):
    if g == 'D1':
        decide_all(rd, env=env, extra=extra)
    c, o, e = run([PY, RS, rd, 'pass-gate', '--gate', g, '--evidence', ev, '--by', 'tests', *extra], env=env)
    return c, jout(o)


def copy_body(t, rd):
    src = sample(t)
    shutil.copy2(os.path.join(src, 'doc.md'), os.path.join(rd, 'doc.md'))
    for d in ('data', 'figures'):
        if os.path.isdir(os.path.join(src, d)):
            shutil.copytree(os.path.join(src, d), os.path.join(rd, d), dirs_exist_ok=True)


def mark_codex(rd):
    p = os.path.join(rd, 'qa-report.md')
    s = open(p, encoding='utf-8').read() if os.path.exists(p) else ''
    open(p, 'w', encoding='utf-8').write(s + '\n\n## Codex 找茬与证伪\n\n找茬轮：自测环境不调用 Codex，按降级处理（仅用于 doc-orchestrator 自测）。\n\n证伪轮：同上降级。\n')


# ---------------------------------------------------------------- 判型
print('== 判型 ==')
for text, want_code, want in [('帮我写个会员积分的 PRD', 0, 'prd'), ('出一份测试用例', 0, 'test-cases'), ('积分系统测试报告，含缺陷统计', 0, 'test-report'),
                              ('写一份技术方案设计文档', 0, 'tech-spec'), ('写个市场需求文档', 0, 'mrd'),
                              ('写一份 API 设计文档', 3, ['tech-spec', 'api-reference']), ('写个文档', 3, None),
                              ('给客户做个建站方案报价', 4, 'presales-orchestrator'), ('Reddit 代运营方案', 4, 'presales-orchestrator'),
                              ('把这周周报整理一下', 4, 'lark-doc')]:
    c, d, e = script('detect_type.py', text)
    if want_code == 0:
        ok = c == 0 and d.get('decision') == 'single' and d.get('type') == want
    elif want_code == 3:
        opts = [o['type'] for o in d.get('options') or []]
        ok = c == 3 and d.get('decision') == 'ask' and (want is None or all(w in opts for w in want)) and opts[-1] is None \
            and not any(o in ('presales-site', 'presales-reddit') for o in opts)
    else:
        ok = c == 4 and d.get('decision') == 'handoff' and d.get('skill') == want
    check(f'判型「{text}」→ {want}', ok, (c, d))
bad = os.path.join(BASE, 'bad-triggers.json')
json.dump({'types': {'no-such-type': ['x']}}, open(bad, 'w'))
c, d, e = script('detect_type.py', 'PRD', '--triggers', bad)
check('判型：关键词表引用不存在的类型 → 退出 2', c == 2 and 'no-such-type' in json.dumps(d), (c, d))
open(bad, 'w').write('{broken')
c, d, e = script('detect_type.py', 'PRD', '--triggers', bad)
check('判型：关键词表 JSON 损坏 → 退出 2（不抛 traceback）', c == 2 and 'Traceback' not in e, (c, d, e[-200:]))
json.dump({'types': {'prd': ['PRD']}, 'handoff': {'presales-orchestrator': ['x']}}, open(bad, 'w'))
c, d, e = script('detect_type.py', 'PRD', '--triggers', bad)
check('判型：handoff 结构错误 → 退出 2', c == 2 and 'handoff' in json.dumps(d, ensure_ascii=False), (c, d, e[-200:]))

TGROOT = os.path.join(BASE, 'types-triggers'); os.makedirs(TGROOT)
for tid, trig in (('prd', ['积分蓝图']), ('growth-plan', ['增长作战图'])):
    shutil.copytree(os.path.join(TYPES, 'prd'), os.path.join(TGROOT, tid), ignore=shutil.ignore_patterns('samples'))
    ptg = json.load(open(os.path.join(TGROOT, tid, 'pack.json'), encoding='utf-8'))
    ptg.update(id=tid, samples=[], triggers=trig)
    if tid != 'prd': ptg['name'] = '增长计划'
    json.dump(ptg, open(os.path.join(TGROOT, tid, 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
ETG = {'DOC_TYPES_DIRS': TGROOT}
c, d, e = script('detect_type.py', '写一份积分蓝图', env=ETG)
check('判型：类型包 pack.json triggers 追加到同类型关键词（积分蓝图 → prd）', c == 0 and d.get('type') == 'prd' and '积分蓝图' in (d.get('matched') or {}).get('prd', []), (c, d))
c, d, e = script('detect_type.py', '帮我写个 PRD', env=ETG)
check('判型：追加不替换，type-triggers.json 原关键词仍生效', c == 0 and d.get('type') == 'prd', (c, d))
c, d, e = script('detect_type.py', '出一份增长作战图', env=ETG)
check('判型：关键词表没登记的新类型只靠 pack triggers 也能命中', c == 0 and d.get('type') == 'growth-plan', (c, d))
c, d, e = script('detect_type.py', '写个积分蓝图', '--triggers', os.path.join(ORCH, 'references', 'type-triggers.json'))
check('判型：不在 DOC_TYPES_DIRS 时 pack triggers 不生效（对照组）', not (c == 0 and d.get('type') == 'prd' and '积分蓝图' in json.dumps(d, ensure_ascii=False)), (c, d))
shutil.copytree(os.path.join(TYPES, 'prd'), os.path.join(TGROOT, 'sneaky'), ignore=shutil.ignore_patterns('samples'))
psn = json.load(open(os.path.join(TGROOT, 'sneaky', 'pack.json'), encoding='utf-8')); psn.update(id='sneaky', samples=[], triggers=['周报整理'], name='偷渡包')
json.dump(psn, open(os.path.join(TGROOT, 'sneaky', 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
c, d, e = script('detect_type.py', '给客户做个售前方案报价', env=ETG)
check('判型：handoff 只在 type-triggers.json 定义，类型包 triggers 改不了售前转交', c == 4 and d.get('skill') == 'presales-orchestrator', (c, d))

# ---------------------------------------------------------------- brief 缺项与参数
print('== brief 缺项 ==')
os.makedirs(DOCS, exist_ok=True)
b = brief_from_sample('prd'); b.pop('owner'); b['inputs'].pop('input1')
c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x1'), '--brief', write_brief('b-miss.json', b))
fields = [m['field'] for m in d.get('missing') or []]
check('brief 缺 owner 与类型包必需输入 → 退出 3、列出缺项、不建目录', c == 3 and 'owner' in fields and 'inputs.input1' in fields and not os.path.exists(os.path.join(BASE, 'x1')), (c, fields))
check('brief 缺项输出一次性追问文本', 'ask_user' in d and '负责人' in d.get('ask_user', ''), d.get('ask_user'))
b = brief_from_sample('test-cases')
c, d, e = script('new_run.py', 'test-cases', os.path.join(BASE, 'x2'), '--brief', write_brief('b-tc-norel.json', b))
check('类型包 required 关联文档未登记 → 退出 3', c == 3 and any(m['field'].startswith('related_docs[prd') for m in d.get('missing') or []), (c, d))
b['related_docs'] = [{'type': 'prd', 'role': 'source_prd', 'path': os.path.join(BASE, 'nowhere')}]
c, d, e = script('new_run.py', 'test-cases', os.path.join(BASE, 'x2'), '--brief', write_brief('b-tc-badrel.json', b))
check('关联文档 path 解析不到 → 退出 3', c == 3 and any('解析不到' in m['question'] for m in d.get('missing') or []), (c, d))
raw = json.load(open(os.path.join(sample('test-cases'), 'doc.json'), encoding='utf-8'))
b = brief_from_sample('test-cases'); b['related_docs'] = [dict(r, path=os.path.normpath(os.path.join(sample('test-cases'), r['path']))) for r in raw['related_docs']]
c, d, e = script('new_run.py', 'test-cases', os.path.join(BASE, 'x3'), '--brief', write_brief('b-tc-rawrel.json', b))
if any(r['type'] == 'prd' and r.get('role') == 'source_prd' for r in raw['related_docs']):
    # 类型包块已给样张补 role：原样 related_docs 应能直接建目录
    check('样张原始 related_docs 已带 role → new_run 退出 0（关联文档可解析）', c == 0, (c, d))
else:
    check('样张原始 related_docs 缺 role（登记缺口回归）→ 退出 3', c == 3 and any(m['field'] == 'related_docs[prd/source_prd]' for m in d.get('missing') or []), (c, d))
c, d, e = script('new_run.py', 'presales-site', os.path.join(BASE, 'x4'))
check('售前类型 → 退出 4 转 presales-orchestrator', c == 4 and d.get('handoff') == 'presales-orchestrator', (c, d))
c, d, e = script('new_run.py', 'no-such', os.path.join(BASE, 'x5'))
check('未知类型 → 退出 2 并列出可选类型', c == 2 and 'prd' in d.get('available', []) and 'presales-site' not in d.get('available', []), (c, d))
b = brief_from_sample('prd'); b['bogus'] = 1
c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x6'), '--brief', write_brief('b-bogus.json', b))
check('brief 未知字段 → 退出 2（brief.schema.json doc_brief）', c == 2 and 'bogus' in json.dumps(d, ensure_ascii=False) and d.get('errors'), (c, d))
b = brief_from_sample('prd'); b['inputs']['input1'] = 42
c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x6b'), '--brief', write_brief('b-badinput.json', b))
check('brief inputs 值不是字符串 → 退出 2（schema 口径，不建目录）', c == 2 and 'input1' in json.dumps(d, ensure_ascii=False) and not os.path.exists(os.path.join(BASE, 'x6b')), (c, d))
b = brief_from_sample('prd'); b['presales_goal'] = 'x'; b['line'] = 'site'
c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x6c'), '--brief', write_brief('b-presales.json', b))
check('brief 混入售前键 → 退出 2（doc 分支不允许售前键）', c == 2, (c, d))
os.makedirs(os.path.join(BASE, 'x7')); open(os.path.join(BASE, 'x7', 'keep.txt'), 'w').write('x')
c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x7'), '--brief', write_brief('b-ok.json', brief_from_sample('prd')))
check('非空目录不覆盖 → 退出 1', c == 1, (c, d))

c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x8'), '--from', sample('prd'), '--mode', 'new', '--version', '9.0', '--change-summary', 'x')
check('--from 与 --mode new 冲突 → 退出 2', c == 2 and 'revision' in d.get('message', ''), (c, d))
c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'x9'), '--brief', write_brief('b-ok2.json', brief_from_sample('prd')), '--import', os.path.join(BASE, 'missing.pdf'))
check('导入失败 → 退出 1 且不留半成品目录（可直接重试）', c == 1 and not os.path.exists(os.path.join(BASE, 'x9')) and not glob.glob(os.path.join(BASE, '.new_run-*')), (c, d))

print('== path 型必需输入 ==')
TROOT = os.path.join(BASE, 'types'); os.makedirs(TROOT)
shutil.copytree(os.path.join(TYPES, 'prd'), os.path.join(TROOT, 'prdp'), ignore=shutil.ignore_patterns('samples'))
pp = json.load(open(os.path.join(TROOT, 'prdp', 'pack.json'), encoding='utf-8'))
pp['id'] = 'prdp'; pp['samples'] = []; pp['inputs'][0]['path'] = 'data/evidence*.csv'
json.dump(pp, open(os.path.join(TROOT, 'prdp', 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
PENV = {'DOC_TYPES_DIRS': TROOT}
bp_ = brief_from_sample('prd'); bp_['inputs']['input1'] = '只有文字没有文件'
c, d, e = script('new_run.py', 'prdp', os.path.join(BASE, 'p1'), '--brief', write_brief('b-p1.json', bp_), env=PENV)
check('path 型输入给文字 → 退出 3，追问文件', c == 3 and any(m['field'] == 'inputs.input1' and 'data/evidence*.csv' in m['question'] for m in d.get('missing') or []), (c, d))
ev = os.path.join(BASE, 'evidence-q2.csv'); open(ev, 'w').write('来源,数量\n工单,1842\n')
bp_['inputs']['input1'] = ev
c, d, e = script('new_run.py', 'prdp', os.path.join(BASE, 'p2'), '--brief', write_brief('b-p2.json', bp_), env=PENV)
check('path 型输入给文件 → 复制到运行目录 data/evidence-q2.csv', c == 0 and os.path.exists(os.path.join(BASE, 'p2', 'data', 'evidence-q2.csv')), (c, d))
c, d, e = script('advance.py', os.path.join(BASE, 'p2'), '--run', env=PENV)
check('path 型输入：advance 过 D0（与 run_state 同一口径）', d.get('gates', {}).get('D0') == 'passed', (c, d.get('blocking_reasons')))
os.remove(os.path.join(BASE, 'p2', 'data', 'evidence-q2.csv'))
c, g = gate(os.path.join(BASE, 'p2'), 'D1', 'x')
run([PY, RS, os.path.join(BASE, 'p2'), 'reset-gate', '--gate', 'D0'])
c, d, e = script('advance.py', os.path.join(BASE, 'p2'), env=PENV)
check('path 型输入文件被删 → D0 阻塞（brief 里的旧值不算数）', c == 3 and d.get('step') == 'gate-D0' and any('data/evidence*.csv' in r for r in d['blocking_reasons']), (c, d.get('blocking_reasons')))

print('== 引擎无产出不当成功 ==')
rd_ng = os.path.join(BASE, 'ng', 'prd-ng-v1.2')
script('new_run.py', 'prd', rd_ng, '--brief', write_brief('b-ng.json', brief_from_sample('prd')))
script('advance.py', rd_ng, '--run'); gate(rd_ng, 'D1', 'x'); copy_body('prd', rd_ng)
fake_fig = os.path.join(BASE, 'fake_build.py'); open(fake_fig, 'w').write('import sys\nprint("{}")\nsys.exit(1)\n')
c, d, e = script('advance.py', rd_ng, '--run', env={'DOC_FIGURES_SCRIPT': fake_fig})
check('图引擎退出 1 但没写产物 → advance 退出 1、不循环', c == 1 and len([x for x in d.get('executed') or [] if x['step'] == 'figures']) == 1 and any('产物仍缺失' in r for r in d['blocking_reasons']), (c, d.get('executed'), d.get('blocking_reasons')))

# ---------------------------------------------------------------- 验收 12 项回归（主代理 2026-09-15 不予验收后补，--quick 也跑）
print('== 验收回归 ==')
import hashlib, time  # noqa: E402
SHA0 = '0' * 64


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def d3_run(name, token=True, env=None, pack_type='prd', before_d3=None):
    """不渲染的 D3 已签运行目录：样张正文（不带图）、假 PDF 与 render.json、qa-result、带 Codex 两轮的 qa-report。"""
    rd = os.path.join(BASE, 'acc', name)
    over = {'lark_folder': {'token': 'fldProj00000001', 'path': '自测/PRD'}} if token else {}
    c, d, e = script('new_run.py', pack_type, rd, '--brief', write_brief(f'acc-{name}.json', brief_from_sample('prd', **over)), env=env)
    assert c == 0, (d, e)
    run([PY, RS, rd, 'pass-gate', '--gate', 'D0'], env=env)
    c, g = gate(rd, 'D1', '全部按推荐（自测）', env=env)
    assert c == 0, g
    shutil.copy2(os.path.join(sample('prd'), 'doc.md'), os.path.join(rd, 'doc.md'))
    shutil.copytree(os.path.join(sample('prd'), 'data'), os.path.join(rd, 'data'), dirs_exist_ok=True)
    run([PY, RS, rd, 'skip-gate', '--gate', 'D2', '--reason', '类型包无 D2'], env=env)
    os.makedirs(os.path.join(rd, 'out'), exist_ok=True)
    open(os.path.join(rd, 'out', 'x.pdf'), 'wb').write(b'%PDF-1.4 acceptance\n')
    rj = {'schema_version': '1', 'generated_at': '2026-09-15T10:00:00+08:00', 'source_sha256': SHA0, 'renderer': {'name': 'doc-render', 'version': '1.0'},
          'profile': 'internal', 'pdf': {'path': 'out/x.pdf', 'pages': 1, 'bookmarks': 0}, 'toc': [], 'figures': [], 'tables': [], 'layout_issues': [],
          'feishu': {'path': 'out/feishu.xml', 'whiteboards': 0, 'images': 0, 'code_blocks': 0}}
    json.dump(rj, open(os.path.join(rd, 'out', 'render.json'), 'w'))
    json.dump({'schema_version': '1', 'generated_at': '2026-09-15T10:00:00+08:00', 'source_sha256': SHA0, 'must_fix': 0, 'total': 0, 'issues': []},
              open(os.path.join(rd, 'qa-result.json'), 'w'))
    mark_codex(rd)
    if before_d3: before_d3(rd)
    past = time.time() - 100
    for dp, dn, fn in os.walk(rd):
        if os.sep + 'out' in dp: continue
        for f in fn:
            if f not in ('qa-result.json', 'qa-report.md', 'run-state.json'): os.utime(os.path.join(dp, f), (past, past))
    c, g = gate(rd, 'D3', 'qa-report.md「Codex 找茬与证伪」节', env=env)
    assert c == 0, g
    return rd, rj


def real_published(rd, rj, **over):
    """按 published.schema 构造一份真发布记录（归档文件真实存在，bytes 与 sha256 正确）。"""
    arch = os.path.join(rd, 'out', 'published', 'v1.2'); os.makedirs(arch, exist_ok=True)
    files = [('pdf', rj['pdf']['path'], 'x.pdf'), ('feishu_xml', 'out/feishu.xml', 'feishu.xml'), ('render_json', 'out/render.json', 'render.json'), ('qa_result', 'qa-result.json', 'qa-result.json')]
    open(os.path.join(rd, 'out', 'feishu.xml'), 'w').write('<title>x</title>')
    items = []
    for role, src, name in files:
        dst = os.path.join(arch, name); shutil.copyfile(os.path.join(rd, src), dst)
        items.append({'role': role, 'source': src, 'path': f'out/published/v1.2/{name}', 'bytes': os.path.getsize(dst), 'sha256': sha(dst)})
    rec = {'schema_version': '1', 'dry_run': False, 'engine': {'name': 'doc-publish', 'version': '1.0'}, 'doc_type': 'prd', 'title': '会员积分系统 v2',
           'version': '1.2', 'date': '2026-09-15', 'published_at': '2026-09-15T12:00:00+08:00', 'lark_doc_id': 'doxcnSelftest0001',
           'lark_url': 'https://example.feishu.cn/docx/doxcnSelftest0001', 'lark_profile': 'account1',
           'lark_folder': {'token': 'fldProj00000001', 'path': '自测/PRD'}, 'mode': 'create', 'source_sha256': SHA0, 'gate_d3': 'passed',
           'pdf_path': 'out/published/v1.2/x.pdf', 'docx_path': None, 'feishu_xml_path': 'out/published/v1.2/feishu.xml',
           'render_json_path': 'out/published/v1.2/render.json', 'qa_result_path': 'out/published/v1.2/qa-result.json', 'qa_report_path': None,
           'archive_dir': 'out/published/v1.2', 'archive': items,
           'verify': {k: 0 for k in ('whiteboards', 'whiteboards_expected', 'images', 'images_expected', 'code', 'code_expected', 'inline_code', 'italic', 'del', 'asterisks_extra')},
           'problems': [], 'warnings': [], 'extra': {}}
    rec.update(over)
    json.dump(rec, open(os.path.join(rd, 'published.json'), 'w'), ensure_ascii=False)
    return rec


# ① 发布完成态
rd1, rj1 = d3_run('pub')
c, o, e = run([PY, RS, rd1, 'pass-gate', '--gate', 'D4', '--evidence', '用户：PDF 看过，发 account1'])
check('验收①夹具：D4 通过', c == 0, o[-300:])
sys.path.insert(0, S)
sys.path.insert(0, os.path.join(DS, 'scripts'))
import validate as _val  # noqa: E402
_ps = json.load(open(os.path.join(DS, 'schemas', 'published.schema.json')))
rec = real_published(rd1, rj1)
check('验收①夹具：构造的真发布记录过 published.schema', not _val.check(rec, _ps, _ps), _val.check(rec, _ps, _ps)[:3])
c, d, e = script('advance.py', rd1, '--run')
check('验收①：合规真发布记录 → set-stage done', c == 0 and d.get('step') == 'done' and json.load(open(os.path.join(rd1, 'run-state.json')))['stage'] == 'done', (c, d.get('step'), d.get('blocking_reasons')))


def pub_block(label, mutate, want):
    rec = real_published(rd1, rj1)
    mutate(rec)
    json.dump(rec, open(os.path.join(rd1, 'published.json'), 'w'), ensure_ascii=False)
    run([PY, RS, rd1, 'set-stage', 'publish'])
    c, d, e = script('advance.py', rd1)
    check(f'验收①：{label} → 阻塞在 publish', c == 3 and d.get('step') == 'publish' and any(want in r for r in d['blocking_reasons']), (c, d.get('step'), d.get('blocking_reasons')))


def to_dry(r):
    r.update(dry_run=True, lark_doc_id=None, lark_url=None, verify=None, archive_dir='out/published/v1.2.dry-run',
             plan={'writes': [], 'folders_to_create': [], 'd4_ready': True})


pub_block('根目录是 dry-run 形态记录', to_dry, 'dry-run 形态')
pub_block('verify 为 null、problems 有一条（回查未完成的恢复记录）', lambda r: r.update(verify=None, problems=['回查超时']), 'verify 不是对象')
pub_block('problems 非空', lambda r: r.update(problems=['画板 1 个未回查到']), '发布回查问题')
pub_block('lark_url 缺失（不合 schema）', lambda r: r.pop('lark_url'), 'lark_url')
pub_block('归档 PDF 被删', lambda r: os.remove(os.path.join(rd1, r['pdf_path'])), '归档 PDF 不存在')
pub_block('归档 PDF 被篡改（大小与哈希都变）', lambda r: open(os.path.join(rd1, r['pdf_path']), 'ab').write(b'tampered'), 'sha256 与记录不符')
pub_block('记录的 bytes 与文件不符', lambda r: r['archive'][0].update(bytes=r['archive'][0]['bytes'] + 1), 'bytes')
pub_block('归档路径越出运行目录', lambda r: [r['archive'][0].update(path='../../etc/x.pdf'), r.update(pdf_path='../../etc/x.pdf')], '不在运行目录内')
pub_block('两个 role=pdf 条目', lambda r: r['archive'].append(dict(r['archive'][0])), '应恰好 1 个')
pub_block('source 字符串对得上但当前 PDF 已重渲染', lambda r: open(os.path.join(rd1, 'out', 'x.pdf'), 'wb').write(b'%PDF-1.4 re-rendered\n'), '哈希不同')
open(os.path.join(rd1, 'out', 'x.pdf'), 'wb').write(b'%PDF-1.4 acceptance\n')

# ②③ D3 两秒窗口与改源检查顺序
rd3, _ = d3_run('d3order')
t_qa = os.path.getmtime(os.path.join(rd3, 'qa-result.json'))
os.utime(os.path.join(rd3, 'out', 'render.json'), (t_qa, t_qa))
open(os.path.join(rd3, 'doc.md'), 'a', encoding='utf-8').write('\n【待写：补充说明】\n')
os.utime(os.path.join(rd3, 'doc.md'), (t_qa + 1, t_qa + 1))
c, d, e = script('advance.py', rd3)
check('验收②③：D3 后 1 秒内把正文改出占位符 → 先 reset-D3（不是 author）', c == 0 and d.get('step') == 'reset-D3' and d.get('runnable'), (c, d.get('step'), d.get('blocking_reasons')))
c, d, e = script('advance.py', rd3, '--run')
st3 = json.load(open(os.path.join(rd3, 'run-state.json')))
check('验收③：--run 执行 reset 后停在 author，D3 已回 pending 且 manifest 清掉', c == 3 and d.get('step') == 'author' and st3['gates']['D3']['status'] == 'pending'
      and 'source_manifest' not in st3['gates']['D3'], (c, d.get('step'), st3['gates']['D3']))
c, o, e = run([PY, RS, rd3, 'pass-gate', '--gate', 'D3', '--evidence', 'qa-report.md「Codex 找茬与证伪」节'])
check('验收②：run_state 直调 D3，1 秒内改过正文也拒绝', c == 1 and '质检之后又改过' in o, o[-300:])
rd3x, _ = d3_run('d3xref')
p3 = os.path.join(rd3x, 'doc.json'); m3 = json.load(open(p3))
m3['related_docs'] = [{'type': 'prd', 'role': 'references', 'path': sample('prd'), 'version': '1.2'}]
json.dump(m3, open(p3, 'w', encoding='utf-8'), ensure_ascii=False)
c, d, e = script('advance.py', rd3x, env={'DOC_XREF_SCRIPT': os.path.join(BASE, 'no-such-xref.py')})
check('验收③：D3 后改 related_docs（xref 会故障）→ 仍先 reset-D3', d.get('step') == 'reset-D3', (c, d.get('step'), d.get('blocking_reasons')))

# ② lark_folder 写回例外（Codex 复核②）：发布引擎写回 token 会更新 doc.json 修改时间，manifest 按内容比对不作废 D3、不重渲染
rd2x, _ = d3_run('d3token', token=False)
p2x = os.path.join(rd2x, 'doc.json'); m2x = json.load(open(p2x))
m2x['lark_folder'] = {'token': 'fldWriteBack0001', 'path': m2x['lark_folder']['path']}
json.dump(m2x, open(p2x, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)   # 不回拨修改时间
check('验收②夹具：写回 token 后 doc.json 修改时间晚于质检产物', os.path.getmtime(p2x) > os.path.getmtime(os.path.join(rd2x, 'qa-result.json')))
c, d, e = script('advance.py', rd2x)
check('验收②：只写回 lark_folder（修改时间已变）→ 不 reset D3、不重渲染、不重质检', d.get('step') not in ('reset-D3', 'render', 'qa') and d['gates']['D3'] == 'passed'
      and (d.get('artifacts') or {}).get('manifest', {}).get('ok'), (c, d.get('step'), d.get('artifacts', {}).get('manifest'), d.get('blocking_reasons')))
open(os.path.join(rd2x, 'data', 'requirements.csv'), 'a').write('x\n')
os.utime(os.path.join(rd2x, 'data', 'requirements.csv'), (time.time() - 1000, time.time() - 1000))   # 改内容但把修改时间回拨
c, d, e = script('advance.py', rd2x)
check('验收②：改内容后回拨修改时间 → manifest 仍判不一致并 reset-D3', d.get('step') == 'reset-D3' and 'data/requirements.csv' in json.dumps(d.get('artifacts', {}).get('manifest'), ensure_ascii=False),
      (c, d.get('step'), d.get('artifacts', {}).get('manifest')))

# ② 隐藏路径（主代理核对 accept3）：正文引用的隐藏数据文件、include 的隐藏片段，D3 后修改也要 reset
HROOT = os.path.join(BASE, 'types-hidden'); os.makedirs(HROOT)
shutil.copytree(os.path.join(TYPES, 'prd'), os.path.join(HROOT, 'prd'), ignore=shutil.ignore_patterns('samples'))
ph = json.load(open(os.path.join(HROOT, 'prd', 'pack.json'), encoding='utf-8'))
ph['samples'] = []; ph['include_allow'] = list(ph['include_allow']) + ['.draft/*.md']
json.dump(ph, open(os.path.join(HROOT, 'prd', 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
EH = {'DOC_TYPES_DIRS': HROOT}


def add_hidden(rd):
    os.makedirs(os.path.join(rd, '.data')); os.makedirs(os.path.join(rd, '.draft'))
    open(os.path.join(rd, '.data', 'table.csv'), 'w', encoding='utf-8').write('项,值\n甲,1\n')
    open(os.path.join(rd, '.draft', 'a.md'), 'w', encoding='utf-8').write('隐藏片段里的说明。\n')
    open(os.path.join(rd, 'doc.md'), 'a', encoding='utf-8').write('\n<!-- data: .data/table.csv caption=隐藏数据 -->\n\n<!-- include: .draft/a.md -->\n')


for label, rel, content in (('正文引用的 .data/table.csv', '.data/table.csv', '项,值\n甲,2\n'), ('include 的 .draft/a.md', '.draft/a.md', '隐藏片段改过了。\n')):
    rdh, _ = d3_run('hidden-' + rel.split('/')[0].strip('.'), env=EH, before_d3=add_hidden)
    man = json.load(open(os.path.join(rdh, 'run-state.json')))['gates']['D3'].get('source_manifest') or {}
    check(f'验收②隐藏路径：manifest 收录 {rel}', rel in [x['path'] for x in man.get('files') or []], [x['path'] for x in man.get('files') or []][:12])
    fp = os.path.join(rdh, rel); st_h = os.stat(fp)
    open(fp, 'w', encoding='utf-8').write(content); os.utime(fp, (st_h.st_atime, st_h.st_mtime))   # 改内容、回拨修改时间
    c, d, e = script('advance.py', rdh, env=EH)
    check(f'验收②隐藏路径：D3 后修改 {label} → reset-D3', d.get('step') == 'reset-D3' and rel in json.dumps(d.get('artifacts', {}).get('manifest'), ensure_ascii=False),
          (c, d.get('step'), d.get('artifacts', {}).get('manifest')))
    c, o, e = run([PY, RS, rdh, 'check-manifest'], env=EH)
    check(f'验收②隐藏路径：check-manifest 报 {rel} changed（退出 3）', c == 3 and rel in jout(o).get('changed', []), o[-300:])

# ④ D2 有命令时必须 --run（advance 侧：给出的命令带 --run）
TROOT2 = os.path.join(BASE, 'types-acc'); os.makedirs(TROOT2)
shutil.copytree(os.path.join(TYPES, 'prd'), os.path.join(TROOT2, 'prdd2'), ignore=shutil.ignore_patterns('samples'))
pd2 = json.load(open(os.path.join(TROOT2, 'prdd2', 'pack.json'), encoding='utf-8'))
pd2['id'] = 'prdd2'; pd2['samples'] = []; pd2['gates']['D2'] = {'command': ['{python}', '-c', 'import sys; sys.exit(5)'], 'desc': '专属门必失败', 'pass_exit_codes': [0]}
json.dump(pd2, open(os.path.join(TROOT2, 'prdd2', 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
E2 = {'DOC_TYPES_DIRS': TROOT2}
rd4 = os.path.join(BASE, 'acc', 'd2run')
script('new_run.py', 'prdd2', rd4, '--brief', write_brief('acc-d2.json', brief_from_sample('prd')), env=E2)
run([PY, RS, rd4, 'pass-gate', '--gate', 'D0'], env=E2); gate(rd4, 'D1', 'ok', env=E2)
c, o, e = run([PY, RS, rd4, 'pass-gate', '--gate', 'D2', '--evidence', '外面跑过了'], env=E2)
check('验收④：有 D2 命令时 pass-gate 不带 --run → 拒绝', c == 1 and '--run' in o, o[-300:])
copy_body('prd', rd4); shutil.rmtree(os.path.join(rd4, 'figures'), ignore_errors=True); os.makedirs(os.path.join(rd4, 'figures'))
c, d, e = script('advance.py', rd4, '--run', env=E2)
d2x = [x for x in d.get('executed') or [] if x['step'] == 'gate-D2']
check('验收④：advance 执行 D2 带 --run，命令失败 → 阻塞并给出退出码', d2x and '--run' in d2x[0]['argv'] and c == 3 and any('退出码 5' in r for r in d['blocking_reasons']), (c, d2x, d.get('blocking_reasons')))

# ⑤⑦ 自定义 --pack 下的 xref；行内起始多行注释
CP = os.path.join(BASE, 'custom-packs', 'tcx'); shutil.copytree(os.path.join(TYPES, 'test-cases'), CP, ignore=shutil.ignore_patterns('samples'))
pcx = json.load(open(os.path.join(CP, 'pack.json'), encoding='utf-8')); pcx['id'] = 'tcx'; pcx['samples'] = []
json.dump(pcx, open(os.path.join(CP, 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
bcx = brief_from_sample('test-cases'); bcx['related_docs'] = [{'type': 'prd', 'role': 'source_prd', 'path': sample('prd'), 'version': '1.2'}]
rd5 = os.path.join(BASE, 'acc', 'tcx')
c, d, e = script('new_run.py', 'tcx', rd5, '--brief', write_brief('acc-tcx.json', bcx), '--pack', CP)
check('验收⑤夹具：只能靠 --pack 找到的类型包建目录', c == 0, (c, d))
shutil.copy2(os.path.join(sample('test-cases'), 'doc.md'), os.path.join(rd5, 'doc.md'))
shutil.copytree(os.path.join(sample('test-cases'), 'data'), os.path.join(rd5, 'data'), dirs_exist_ok=True)
open(os.path.join(rd5, 'doc.md'), 'a', encoding='utf-8').write('\n另见 REQ-NOPE-99。\n\n结尾说明 <!--\nTODO {产品名称} REQ-NOT-REAL\n-->\n\n<!-- table: 注释回归 -->\n| 项 | 说明 |\n|---|---|\n| 注释 | 见说明 <!-- REQ-CELL-FAKE TODO --> |\n')
c, d, e = script('xref_check.py', rd5, '--pack', CP, '--no-downstream')
codes = {x['code'] for x in d.get('dangling') or []}
check('验收⑤：xref_check 支持 --pack，报悬空 REQ-NOPE-99', c == 3 and 'REQ-NOPE-99' in codes, (c, d if isinstance(d, dict) else str(d)[:300]))
check('验收⑦：行内起始的多行注释里的编号不算引用', 'REQ-NOT-REAL' not in codes, codes)
check('验收⑦：Markdown 表格单元格里注释中的编号也不算引用（Codex 复核⑦）', 'REQ-CELL-FAKE' not in codes, codes)
check('验收⑦：数据块（CSV）里的编号仍参与核对（REQ 全部存在，不误报也不漏扫）', not any(c.startswith('REQ-') and c not in ('REQ-NOPE-99',) for c in codes) and (d.get('upstream') or [{}])[0].get('found'), (codes, d.get('upstream')))
c, d, e = script('xref_check.py', rd5, '--no-downstream')
check('验收⑤：不给 --pack 找不到类型包 → 退出 2（advance 视为故障）', c == 2, (c, d))
c, o, e = run([PY, os.path.join(SK, 'doc-author', 'scripts', 'fill_check.py'), rd5, '--pack', CP]); dfc = jout(o)
check('验收⑦：fill_check 不把行内起始注释里的 TODO / {产品名称} 当占位符', c == 0 and not dfc.get('placeholders'), (c, dfc.get('placeholders'), dfc.get('blocking_reasons')))
run([PY, RS, rd5, 'pass-gate', '--gate', 'D0', '--pack', CP]); gate(rd5, 'D1', 'ok', extra=('--pack', CP))
c, d, e = script('advance.py', rd5, '--pack', CP)
check('验收⑤：advance 把 --pack 传给 xref → 阻塞在 xref（悬空编号）', c == 3 and d.get('step') == 'xref' and (d.get('artifacts') or {}).get('xref', {}).get('exit_code') == 3, (c, d.get('step'), d.get('artifacts', {}).get('xref'), d.get('blocking_reasons')))
fx = os.path.join(BASE, 'fake_xref.py'); open(fx, 'w').write('import sys\nprint("{}")\nsys.exit(2)\n')
c, d, e = script('advance.py', rd5, '--pack', CP, env={'DOC_XREF_SCRIPT': fx})
check('验收⑤：xref 退出码既不是 0 也不是 3 → advance 退出 1，按引擎故障阻塞（不跳过）', c == 1 and d.get('step') == 'xref' and any('故障' in r for r in d['blocking_reasons']), (c, d.get('step'), d.get('blocking_reasons')))

# ⑥ 改版的 path 型输入：显式新值覆盖、没给才复用
PROOT = os.path.join(BASE, 'types-path'); os.makedirs(PROOT)
for tid, pth in (('prdp6', 'data/evidence*.csv'), ('prdq6', 'evidence/*.csv')):
    shutil.copytree(os.path.join(TYPES, 'prd'), os.path.join(PROOT, tid), ignore=shutil.ignore_patterns('samples'))
    pp6 = json.load(open(os.path.join(PROOT, tid, 'pack.json'), encoding='utf-8')); pp6['id'] = tid; pp6['samples'] = []; pp6['inputs'][0]['path'] = pth
    json.dump(pp6, open(os.path.join(PROOT, tid, 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False)
E6 = {'DOC_TYPES_DIRS': PROOT}
old6, new6 = os.path.join(BASE, 'evidence-old.csv'), os.path.join(BASE, 'evidence-new.csv')
open(old6, 'w').write('来源\n旧\n'); open(new6, 'w').write('来源\n新\n')
b6 = brief_from_sample('prd'); b6['inputs']['input1'] = old6
v12 = os.path.join(BASE, 'acc', 'p6-v1.2'); script('new_run.py', 'prdp6', v12, '--brief', write_brief('acc-p6.json', b6), env=E6)
c, d, e = script('new_run.py', 'prdp6', os.path.join(BASE, 'acc', 'p6-v1.3'), '--from', v12, '--version', '1.3', '--change-summary', '换证据',
                 '--brief', write_brief('acc-p6b.json', {'inputs': {'input1': new6}}), env=E6)
got6 = sorted(os.path.basename(x) for x in glob.glob(os.path.join(BASE, 'acc', 'p6-v1.3', 'data', 'evidence*.csv')))
check('验收⑥：改版显式给新文件 → 复制新文件并删掉旧副本', c == 0 and got6 == ['evidence-new.csv'] and open(os.path.join(BASE, 'acc', 'p6-v1.3', 'data', 'evidence-new.csv')).read().endswith('新\n'), (c, got6, d))
c, d, e = script('new_run.py', 'prdp6', os.path.join(BASE, 'acc', 'p6-v1.4'), '--from', os.path.join(BASE, 'acc', 'p6-v1.3'), '--version', '1.4', '--change-summary', '不换证据', env=E6)
check('验收⑥：改版没给新值 → 复用上一版文件', c == 0 and sorted(os.path.basename(x) for x in glob.glob(os.path.join(BASE, 'acc', 'p6-v1.4', 'data', 'evidence*.csv'))) == ['evidence-new.csv'], (c, d))
bq = brief_from_sample('prd'); bq['inputs']['input1'] = old6
q12 = os.path.join(BASE, 'acc', 'q6-v1.2')
c, d, e = script('new_run.py', 'prdq6', q12, '--brief', write_brief('acc-q6.json', bq), env=E6)
check('验收⑥夹具：path 不在 data/figures/sections（evidence/*.csv）也能建目录', c == 0 and os.path.exists(os.path.join(q12, 'evidence', 'evidence-old.csv')), (c, d))
q13 = os.path.join(BASE, 'acc', 'q6-v1.3')
c, d, e = script('new_run.py', 'prdq6', q13, '--from', q12, '--version', '1.3', '--change-summary', '不换证据', env=E6)
c2, d2, e2 = script('advance.py', q13, '--run', env=E6)
check('验收⑥：path 不在 data/figures/sections 时改版复用旧文件，D0 能过', c == 0 and os.path.exists(os.path.join(q13, 'evidence', 'evidence-old.csv')) and (d2.get('gates') or {}).get('D0') == 'passed', (c, d, d2.get('blocking_reasons')))

# ⑧ D0 文本输入、D1 拍板、D3 两轮 Codex（run_state 直调）
rd8 = os.path.join(BASE, 'acc', 'gates8')
script('new_run.py', 'prd', rd8, '--brief', write_brief('acc-g8.json', brief_from_sample('prd')))
bj8 = json.load(open(os.path.join(rd8, 'brief.json')))
bj8_owner = bj8.pop('owner'); json.dump(bj8, open(os.path.join(rd8, 'brief.json'), 'w'), ensure_ascii=False)
c, o, e = run([PY, RS, rd8, 'pass-gate', '--gate', 'D0'])
c2, d2, e2 = script('advance.py', rd8, '--run')
check('brief schema：brief.json 缺严格必填 owner → run_state D0 拒绝；advance 同口径阻塞交用户', c == 1 and 'brief.schema.json' in o and 'owner' in o
      and c2 == 3 and d2.get('step') == 'gate-D0' and any('owner' in r for r in d2.get('blocking_reasons') or []), (o[-300:], d2.get('blocking_reasons')))
bj8['owner'] = bj8_owner
json.dump([bj8], open(os.path.join(rd8, 'brief.json'), 'w'), ensure_ascii=False)
c, o, e = run([PY, RS, rd8, 'pass-gate', '--gate', 'D0'])
c2, d2, e2 = script('advance.py', rd8, '--run')
check('验收⑧：brief.json 顶层是数组 → run_state D0 拒绝；advance 阻塞交用户、不崩', c == 1 and '必须是对象' in o and c2 == 3 and d2.get('step') == 'gate-D0'
      and any('必须是对象' in r for r in d2.get('blocking_reasons') or []) and 'Traceback' not in e2, (o[-200:], c2, d2.get('blocking_reasons'), e2[-200:]))
bj8['inputs']['input2'] = '  '; json.dump(bj8, open(os.path.join(rd8, 'brief.json'), 'w'), ensure_ascii=False)
c, o, e = run([PY, RS, rd8, 'pass-gate', '--gate', 'D0'])
check('验收⑧：run_state 直调 D0，brief.json 文本输入为空白 → 拒绝', c == 1 and 'input2' in o, o[-300:])
bj8['inputs']['input2'] = '指标草案'; json.dump(bj8, open(os.path.join(rd8, 'brief.json'), 'w'), ensure_ascii=False)
run([PY, RS, rd8, 'pass-gate', '--gate', 'D0'])
c, o, e = run([PY, RS, rd8, 'pass-gate', '--gate', 'D1', '--evidence', 'x'])
check('验收⑧：D1 没有拍板记录 → 拒绝', c == 1 and '拍板记录不足' in o, o[-300:])
n8 = len(set(re.findall(r'^([\u2460-\u2473]) ', open(os.path.join(rd8, 'outline.md'), encoding='utf-8').read(), re.M)))
run([PY, RS, rd8, 'decide', '--key', '①', '--value', 'A'])
c, o, e = run([PY, RS, rd8, 'pass-gate', '--gate', 'D1', '--evidence', 'x'])
check(f'验收⑧：outline 有 {n8} 个拍板项、只记 1 条 → 拒绝', n8 > 1 and c == 1 and '拍板记录不足' in o, (n8, o[-300:]))
c, g = gate(rd8, 'D1', '全部按推荐')
check('验收⑧：拍板项全部记录后 D1 通过', c == 0, g)
rd8b, _ = d3_run('gates8b'); run([PY, RS, rd8b, 'reset-gate', '--gate', 'D3'])
open(os.path.join(rd8b, 'qa-report.md'), 'w').write('# 质检报告\n\n<!-- qa-auto:start -->\nCodex 找茬 证伪\n<!-- qa-auto:end -->\n')
c, o, e = run([PY, RS, rd8b, 'pass-gate', '--gate', 'D3', '--evidence', 'qa-report.md'])
check('验收⑧：Codex 字样只在自动区块、人工区块为空 → D3 拒绝', c == 1 and '人工区块' in o, o[-300:])
open(os.path.join(rd8b, 'qa-report.md'), 'a').write('\n## Codex 找茬\n\n找茬轮 3 条已采纳。\n')
c, o, e = run([PY, RS, rd8b, 'pass-gate', '--gate', 'D3', '--evidence', 'qa-report.md'])
check('验收⑧：缺证伪轮 → D3 拒绝', c == 1 and '证伪' in o, o[-300:])
open(os.path.join(rd8b, 'qa-report.md'), 'a').write('\n证伪轮 1 条撤回。\n')
c, o, e = run([PY, RS, rd8b, 'pass-gate', '--gate', 'D3', '--evidence', '两轮都做了'])
check('验收⑧：证据不可定位 → D3 拒绝', c == 1 and '无法定位' in o, o[-300:])
c, o, e = run([PY, RS, rd8b, 'pass-gate', '--gate', 'D3', '--evidence', 'qa-report.md「Codex 找茬」节'])
st8 = json.load(open(os.path.join(rd8b, 'run-state.json')))
check('验收⑧：两轮记录齐、证据可定位 → D3 通过并写 manifest', c == 0 and st8['gates']['D3'].get('source_manifest', {}).get('files'), o[-300:])
c, o, e = run([PY, RS, rd8b, 'check-manifest'])
check('manifest：刚签 D3 → check-manifest 退出 0', c == 0, o[-300:])
p8 = os.path.join(rd8b, 'doc.json'); m8 = json.load(open(p8)); m8['lark_folder'] = {'token': 'fldOther000000002', 'path': '别处'}
st_m = os.stat(p8); json.dump(m8, open(p8, 'w'), ensure_ascii=False); os.utime(p8, (st_m.st_atime, st_m.st_mtime))
c, o, e = run([PY, RS, rd8b, 'check-manifest'])
check('manifest：只改 doc.json lark_folder（保留修改时间）→ 仍一致；advance 不 reset D3', c == 0 and script('advance.py', rd8b)[1].get('step') != 'reset-D3', o[-300:])
open(os.path.join(rd8b, 'data', 'requirements.csv'), 'a').write('x\n')
c, o, e = run([PY, RS, rd8b, 'check-manifest'])
check('manifest：改数据文件 → 退出 3 列出 changed', c == 3 and 'data/requirements.csv' in jout(o).get('changed', []), o[-300:])

# brief schema 与售前运行目录（Codex brief 复核）：元数据文件为 brief.json 的类型包不套 doc_brief、不读 inputs
rdps = os.path.join(BASE, 'acc', 'presales-site-run'); os.makedirs(rdps)
json.dump({'line': 'site', 'mode': 'new', 'client': '自测客户', 'version': '1.0', 'lark_folder': {'pending_reason': '自测', 'path': '自测/建站'}},
          open(os.path.join(rdps, 'brief.json'), 'w', encoding='utf-8'), ensure_ascii=False)
run([PY, RS, rdps, 'init', '--type', 'presales-site', '--mode', 'new'])
sys.path.insert(0, S)
import orchlib as _olb  # noqa: E402
ps_pack = json.load(open(os.path.join(TYPES, 'presales-site', 'pack.json'), encoding='utf-8'))
gaps_ps = _olb.brief_input_gaps(ps_pack, rdps, json.load(open(os.path.join(rdps, 'brief.json'))))
check('brief schema：售前运行目录（meta_file brief.json）不按 doc_brief 严格校验、不读 inputs → 无缺项', gaps_ps == [], gaps_ps)
c, d, e = script('advance.py', rdps)
check('brief schema：advance 对售前运行目录不因 doc_brief 规则阻塞 D0，版本取自 brief.json', not any('doc_brief' in r or 'brief.schema' in r or 'input1' in r for r in d.get('blocking_reasons') or [])
      and d.get('version') == '1.0', (c, d.get('step'), d.get('version'), d.get('blocking_reasons')))
tmp_pack = dict(ps_pack, inputs=[{'id': 'need', 'desc': '必需路径输入', 'required': True, 'path': 'scope.json'}])
check('brief schema：售前运行目录仍查 path 型必需输入', any('scope.json' in g for g in _olb.brief_input_gaps(tmp_pack, rdps, {})), _olb.brief_input_gaps(tmp_pack, rdps, {}))

# ⑨ 版本等值走共享函数
sys.path.insert(0, os.path.join(DS, 'scripts'))
import versions as _v  # noqa: E402
import orchlib as _ol  # noqa: E402
check('验收⑨：orchlib 与 related 用同一个 versions.same_version', _ol.same_version is _v.same_version and _ol.version_tuple('1.0') == (1, 0, 0))

# ⑩ --from 与任何 --mode 互斥
for mm in ('new', 'import', 'revision'):
    c, d, e = script('new_run.py', 'prd', os.path.join(BASE, 'acc', f'm-{mm}'), '--from', rd8, '--mode', mm, '--version', '9.0', '--change-summary', 'x')
    check(f'验收⑩：--from 配 --mode {mm} → 退出 2', c == 2 and not os.path.exists(os.path.join(BASE, 'acc', f'm-{mm}')), (c, d))

# ⑪ 事务落位
bp11 = write_brief('acc-11.json', brief_from_sample('prd'))


def tree(rd):
    return {os.path.relpath(os.path.join(dp, f), rd): sha(os.path.join(dp, f)) for dp, dn, fn in os.walk(rd) for f in fn}


for point in ('set-stage', 'merge', 'swap'):
    rd11 = os.path.join(BASE, 'acc', f'land-{point}'); os.makedirs(rd11)
    open(os.path.join(rd11, 'keep.txt'), 'w').write('x'); open(os.path.join(rd11, 'figures'), 'w').write('用户同名文件')
    before = tree(rd11)
    c, d, e = script('new_run.py', 'prd', rd11, '--brief', bp11, '--force', env={'DOC_NEW_RUN_FAULT': point})
    check(f'验收⑪：--force 在 {point} 处故障 → 退出 1，目标目录逐字节不变，无临时目录残留',
          c == 1 and tree(rd11) == before and not glob.glob(os.path.join(BASE, 'acc', '.new_run-*')), (c, d, sorted(tree(rd11)), glob.glob(os.path.join(BASE, 'acc', '.new_run-*'))))
rd11 = os.path.join(BASE, 'acc', 'land-new')
c, d, e = script('new_run.py', 'prd', rd11, '--brief', bp11, env={'DOC_NEW_RUN_FAULT': 'land-rename'})
check('验收⑪：目标不存在、落位故障 → 退出 1，不留目标与临时目录', c == 1 and not os.path.exists(rd11) and not glob.glob(os.path.join(BASE, 'acc', '.new_run-*')), (c, d))
rd11 = os.path.join(BASE, 'acc', 'land-conflict'); os.makedirs(os.path.join(rd11, 'outline.md'))
before = tree(rd11)
c, d, e = script('new_run.py', 'prd', rd11, '--brief', bp11, '--force')
check('验收⑪：目标里文件 / 目录同名冲突 → 退出 1，目标不变', c == 1 and os.path.isdir(os.path.join(rd11, 'outline.md')) and tree(rd11) == before, (c, d))
rd11 = os.path.join(BASE, 'acc', 'land-ok'); os.makedirs(rd11); open(os.path.join(rd11, 'keep.txt'), 'w').write('x')
c, d, e = script('new_run.py', 'prd', rd11, '--brief', bp11, '--force')
check('验收⑪：--force 正常落位：原文件保留、新文件齐、stage=outline', c == 0 and os.path.exists(os.path.join(rd11, 'keep.txt')) and os.path.exists(os.path.join(rd11, 'doc.md'))
      and json.load(open(os.path.join(rd11, 'run-state.json')))['stage'] == 'outline', (c, d))

# ⑫ 判型配置
for label, cfg in (('types 空数组', {'types': {'prd': []}, 'handoff': json.load(open(os.path.join(ORCH, 'references', 'type-triggers.json')))['handoff']}),
                   ('handoff 关键词空数组', {'types': {'prd': ['PRD']}, 'handoff': {'presales-orchestrator': {'types': [], 'keywords': [], 'why': 'x'}, 'lark-doc': {'keywords': ['周报'], 'why': 'x'}}}),
                   ('handoff 未知字段', {'types': {'prd': ['PRD']}, 'handoff': {'presales-orchestrator': {'keywords': ['售前'], 'why': 'x', 'priority': 1}, 'lark-doc': {'keywords': ['周报'], 'why': 'x'}}}),
                   ('handoff 缺 lark-doc', {'types': {'prd': ['PRD']}, 'handoff': {'presales-orchestrator': {'keywords': ['售前'], 'why': 'x'}}}),
                   ('handoff 未知转交目标', {'types': {'prd': ['PRD']}, 'handoff': {'presales-orchestrator': {'keywords': ['售前'], 'why': 'x'}, 'lark-doc': {'keywords': ['周报'], 'why': 'x'}, 'other': {'keywords': ['x']}}})):
    json.dump(cfg, open(bad, 'w'), ensure_ascii=False)
    c, d, e = script('detect_type.py', 'PRD', '--triggers', bad)
    check(f'验收⑫：{label} → 退出 2', c == 2 and d.get('problems'), (c, d))
c, d, e = script('detect_type.py', 'PRD')
check('验收⑫：正式 type-triggers.json 通过新校验', c == 0 and d.get('type') == 'prd', (c, d))

# ---------------------------------------------------------------- 导入
print('== 导入已有文档 ==')
xml = os.path.join(BASE, 'old.xml')
open(xml, 'w', encoding='utf-8').write('<title>旧版需求</title><h1>背景</h1><p>旧版 v0.9 的背景段落。</p><h1>需求</h1><table><tr><th>编号</th><th>标题</th></tr><tr><td>A-1</td><td>旧需求</td></tr></table>')
rd_imp = os.path.join(DOCS, 'prd-import-v1.0')
c, d, e = script('new_run.py', 'prd', rd_imp, '--brief', write_brief('b-imp.json', brief_from_sample('prd', version='1.0')), '--import', xml)
st = json.load(open(os.path.join(rd_imp, 'run-state.json'))) if os.path.exists(os.path.join(rd_imp, 'run-state.json')) else {}
base_md = open(os.path.join(rd_imp, 'base', 'base-doc.md'), encoding='utf-8').read() if os.path.exists(os.path.join(rd_imp, 'base', 'base-doc.md')) else ''
check('--import：退出 0、mode=import、base_doc 登记', c == 0 and st.get('mode') == 'import' and st.get('base_doc') == xml, (c, d, st.get('mode')))
check('--import：base/base-doc.md 含原文标题与表格，另生成 doc.md 骨架', '## 背景' in base_md and '| A-1 | 旧需求 |' in base_md and os.path.exists(os.path.join(rd_imp, 'doc.md')), base_md[:300])
check('--import：修订记录写「导入旧稿作为底稿」', json.load(open(os.path.join(rd_imp, 'doc.json')))['revision_history'][0]['summary'] == '导入旧稿作为底稿')


def flow(t, rd, brief, fix=None, expect_block=None):
    """new_run → D0 → D1 → 样张正文 → advance --run 到 D3 阻塞。返回最后一次 advance 输出。"""
    c, d, e = script('new_run.py', t, rd, '--brief', write_brief(f'b-{t}.json', brief))
    check(f'{t}：new_run 退出 0', c == 0, (c, d, e[-300:]))
    pack = json.load(open(os.path.join(TYPES, t, 'pack.json'), encoding='utf-8'))
    body = open(os.path.join(rd, 'doc.md'), encoding='utf-8').read()
    req = [s for s in pack['skeleton'] if s['required']]
    opt = [s for s in pack['skeleton'] if not s['required']]
    check(f'{t}：doc.md 骨架由 pack.json 生成（必备章节标题行带 {{#sec:id}}，按需章节不预建）',
          all(re.search(r'^#{2,4} .+\{#sec:' + re.escape(s['id']) + r'[ }]', body, re.M) for s in req) and not any(('{#sec:' + s['id'] + '}') in body or ('{#sec:' + s['id'] + ' ') in body for s in opt), body[:500])
    c, d, e = script('advance.py', rd)
    check(f'{t}：advance 首步为 gate-D0（脚本可执行，退出 0）', c == 0 and d.get('step') == 'gate-D0' and d.get('runnable'), (c, d.get('step'), d.get('blocking_reasons')))
    c, d, e = script('advance.py', rd, '--run')
    check(f'{t}：advance --run 过 D0 后阻塞在 D1（用户）', c == 3 and d.get('step') == 'gate-D1' and d.get('actor') == 'user' and d['gates']['D0'] == 'passed', (c, d.get('step'), d.get('blocking_reasons'), d.get('executed')))
    c, g = gate(rd, 'D1', '全部按推荐（自测）')
    check(f'{t}：D1 带证据通过', c == 0, g)
    c, d, e = script('advance.py', rd)
    check(f'{t}：正文仍是骨架 → 阻塞在 author（占位符）', c == 3 and d.get('step') == 'author' and any('占位符' in r for r in d['blocking_reasons']), (c, d.get('step'), d.get('blocking_reasons')))
    copy_body(t, rd)
    if expect_block:
        c, d, e = script('advance.py', rd, '--run', '--publish-offline')
        check(f'{t}：原样张正文 → {expect_block[0]}', c == 3 and d.get('step') == expect_block[1] and any(expect_block[2] in r for r in d['blocking_reasons']), (c, d.get('step'), d.get('blocking_reasons')))
    if fix: fix(rd)
    c, d, e = script('advance.py', rd, '--run', '--publish-offline')
    ex = {x['step']: x['exit_code'] for x in d.get('executed') or []}
    check(f'{t}：advance --run 依次执行 D2、图、渲染、质检（退出码均 0）', all(ex.get(k) == 0 for k in ('gate-D2', 'render', 'qa')) and ('figures' not in ex or ex['figures'] == 0),
          (c, ex, d.get('blocking_reasons')[:5], [x.get('detail') for x in d.get('executed') or [] if x.get('exit_code')]))
    check(f'{t}：阻塞在 D3（Codex 两轮），不自动过 D3', c == 3 and d.get('step') == 'gate-D3' and d.get('actor') == 'codex' and d['gates']['D3'] == 'pending', (c, d.get('step'), d.get('blocking_reasons')))
    if not (os.path.exists(os.path.join(rd, 'qa-result.json')) and os.path.exists(os.path.join(rd, 'out', 'render.json'))):
        check(f'{t}：渲染与质检产物存在（引擎故障时 advance 退出 1 并给出故障原因）', False, (c, d.get('blocking_reasons')[:2]))
        return d
    qa = json.load(open(os.path.join(rd, 'qa-result.json')))
    rj = json.load(open(os.path.join(rd, 'out', 'render.json')))
    check(f'{t}：qa must_fix 0（全量规则，非子集）', qa['must_fix'] == 0 and len(qa['engine']['rules_run']) > 20, (qa['must_fix'], [i for i in qa['issues'] if i['severity'] == '必改'][:3]))
    check(f'{t}：PDF 有页数、版式无必改', (rj.get('pdf') or {}).get('pages', 0) > 0 and not [x for x in rj['layout_issues'] if x['severity'] == '必改'], rj.get('pdf'))
    print(f'     证据：{t} 执行 {ex}；qa must_fix={qa["must_fix"]} total={qa["total"]}；PDF {rj["pdf"]["pages"]} 页 {rj["pdf"]["path"]}')
    mark_codex(rd)
    c, g = gate(rd, 'D3', 'Codex 两轮：qa-report.md「Codex 找茬与证伪」节（自测降级）')
    check(f'{t}：D3 通过（run_state 自动检查 qa 与 render 新鲜）', c == 0, g)
    c, d, e = script('advance.py', rd, '--run', '--publish-offline')
    ex = [x for x in d.get('executed') or [] if x['step'] == 'publish-dry-run']
    dry = json.load(open(os.path.join(rd, 'out', 'publish-dry-run.json'))) if os.path.exists(os.path.join(rd, 'out', 'publish-dry-run.json')) else {}
    check(f'{t}：D3 后执行 doc-publish 预检（dry-run --offline），不带 --apply', ex and '--apply' not in ex[0]['argv'] and '--offline' in ex[0]['argv'], ex)
    check(f'{t}：doc-publish dry-run 退出 0，记录绑定版本与哈希', dry.get('exit_code') == 0 and dry.get('doc_version') == brief['version'] and dry.get('render_sha256') == rj['source_sha256'], (dry.get('exit_code'), str(dry.get('output'))[:400]))
    check(f'{t}：阻塞在用户确认发布（下一步 publish.py --apply --evidence，advance 不执行）', c == 3 and d.get('step') == 'publish' and d.get('actor') == 'user'
          and '--apply' in (d.get('next_command') or '') and any('lark_folder' in r for r in d['blocking_reasons']) and not os.path.exists(os.path.join(rd, 'published.json')), (c, d.get('step'), d.get('blocking_reasons')))
    print(f'     证据：{t} dry-run 退出 {dry.get("exit_code")}；下一步 {d.get("step")}（{d.get("actor")}）')
    return d


if QUICK:
    print('SKIP 全流程（--quick）')
else:
    print('== prd 全流程 ==')
    rd_prd = os.path.join(DOCS, 'prd-points-v1.2')
    flow('prd', rd_prd, brief_from_sample('prd'))
    c, o, e = run([PY, os.path.join(S, 'status.py'), rd_prd])
    check('status.py 人读摘要含门表与下一步', c == 0 and 'D3　通过' in o and '下一步：publish' in o, o[-600:])

    print('== 门禁：发布脚本缺失 / 假发布脚本 ==')
    c, d, e = script('advance.py', rd_prd, env={'DOC_PUBLISH_SCRIPT': os.path.join(BASE, 'no-publish.py')})
    # 预检记录已存在且绑定，脚本缺失只在需要跑预检时暴露：删掉记录再判
    os.remove(os.path.join(rd_prd, 'out', 'publish-dry-run.json'))
    c, d, e = script('advance.py', rd_prd, env={'DOC_PUBLISH_SCRIPT': os.path.join(BASE, 'no-publish.py')})
    check('doc-publish 脚本缺失 → 阻塞「doc-publish 未落地」', c == 3 and any('未落地' in r for r in d['blocking_reasons']), (c, d.get('blocking_reasons')))
    fake = os.path.join(BASE, 'fake_publish.py'); log = os.path.join(BASE, 'fake_publish.log')
    open(fake, 'w').write(f'import json,sys\nopen({log!r},"a").write(json.dumps(sys.argv[1:])+"\\n")\nprint(json.dumps({{"ok": False, "message": "文件夹需拍板"}}))\nsys.exit(5)\n')
    c, d, e = script('advance.py', rd_prd, '--run', env={'DOC_PUBLISH_SCRIPT': fake})
    argvs = [json.loads(l) for l in open(log)] if os.path.exists(log) else []
    check('假发布脚本：只以 dry-run 方式调用（无 --apply）', argvs and all('--apply' not in a for a in argvs), argvs)
    check('发布预检退出 5 → 阻塞交用户（文件夹归属需拍板）', c == 3 and d.get('actor') == 'user' and any('退出码 5' in r for r in d['blocking_reasons']), (c, d.get('actor'), d.get('blocking_reasons')))
    EXPECT_ACTOR = {1: 'author', 2: 'orchestrator', 3: 'orchestrator', 4: 'orchestrator', 5: 'user', 6: 'user', 7: 'user', 8: 'user', 10: 'user'}
    for code in (1, 2, 3, 4, 5, 6, 7, 8, 10):
        log_c = os.path.join(BASE, f'fake_publish_{code}.log'); fake_c = os.path.join(BASE, f'fake_publish_{code}.py')
        open(fake_c, 'w').write(f'import json,sys\nopen({log_c!r},"a").write(json.dumps(sys.argv[1:])+"\\n")\nprint(json.dumps({{"ok": False, "message": "退出码 {code} 自测"}}))\nsys.exit({code})\n')
        dp_ = os.path.join(rd_prd, 'out', 'publish-dry-run.json')
        if os.path.exists(dp_): os.remove(dp_)
        c, d, e = script('advance.py', rd_prd, '--run', env={'DOC_PUBLISH_SCRIPT': fake_c})
        calls = [json.loads(l) for l in open(log_c)] if os.path.exists(log_c) else []
        asks = code in (5, 6, 7, 8, 10)
        check(f'发布预检退出 {code} → blocking_reasons 非空、runnable=false、actor={EXPECT_ACTOR[code]}' + ('、给问题与字母选项' if asks else '、写明处理方式'),
              c == 3 and d.get('runnable') is False and d.get('actor') == EXPECT_ACTOR[code] and any(f'退出码 {code}' in r for r in d['blocking_reasons'])
              and ((len(d.get('options') or []) >= 2 and d.get('question')) if asks else (not d.get('options') and any('处理：' in r for r in d['blocking_reasons']))),
              (c, d.get('runnable'), d.get('actor'), d.get('options'), d.get('blocking_reasons')))
        c2, d2, e2 = script('advance.py', rd_prd, '--run', env={'DOC_PUBLISH_SCRIPT': fake_c})
        calls = [json.loads(l) for l in open(log_c)] if os.path.exists(log_c) else []
        check(f'发布预检退出 {code}：不自动重试（再跑 advance --run 也不再调用），从不带 --apply / --abandon-recovery / --create / --yes',
              len(calls) == 1 and not any(f in a for a in calls for f in ('--apply', '--abandon-recovery', '--create', '--yes', '--force')), calls)

    print('== test-cases 全流程 ==')
    rd_tc = os.path.join(DOCS, 'test-cases-points-v1.0')
    btc = brief_from_sample('test-cases')
    btc['related_docs'] = [{'type': 'prd', 'role': 'source_prd', 'path': '../prd-points-v1.2', 'version': '1.2', 'title': '会员积分系统 v2 PRD'}]

    sys.path.insert(0, os.path.join(DS, 'scripts'))
    import docmark_parse as dp  # noqa: E402
    tcp = json.load(open(os.path.join(TYPES, 'test-cases', 'pack.json'), encoding='utf-8'))
    sdoc = dp.parse_file(sample('test-cases'), 'doc.md', pack=tcp)
    unmatched = [s['id'] for s in tcp['skeleton'] if s['required'] and sdoc.section(s['id']) is None]
    print(f'     test-cases 样张与当前骨架未对齐的必备章节：{unmatched or "无"}')

    def fix_tc(rd):
        # 夹具修正（类型包缺陷，待骨架块修复）：pack.json 的 module-sections 标题不可能匹配正文，这里按 doc-author「动态标题章节用锚点对齐骨架」给第一个模块章加锚点
        p = os.path.join(rd, 'doc.md'); s = open(p, encoding='utf-8').read()
        s2 = re.sub(r'^(## (?:\d+\. )?积分账户)\s*$', r'\1 {#sec:module-sections}', s, count=1, flags=re.M)
        check('test-cases 夹具修正已应用（给第一个模块章加 {#sec:module-sections}）', s2 != s)
        open(p, 'w', encoding='utf-8').write(s2)
    if 'module-sections' in unmatched:
        flow('test-cases', rd_tc, btc, fix=fix_tc, expect_block=('阻塞在 author：缺必备章节 module-sections（类型包缺陷回归）', 'author', '缺必备章节'))
    else:
        flow('test-cases', rd_tc, btc)
    c, d, e = script('xref_check.py', rd_tc, '--no-downstream')
    check('test-cases 引用的 REQ 在 PRD 中全部存在（xref 退出 0，悬空 0）', c == 0 and not d.get('dangling'), (c, d.get('dangling')))

    # published.json 一致性由「验收回归」①（真实 schema 记录 + 反例）覆盖；旧的简化对象用例已移除

    print('== D3 后改源文件 ==')
    qa_p, rj_p = os.path.join(rd_prd, 'qa-result.json'), os.path.join(rd_prd, 'out', 'render.json')
    import time
    t0 = time.time()
    os.utime(qa_p, (t0, t0)); os.utime(rj_p, (t0, t0))
    p = os.path.join(rd_prd, 'doc.md'); s0 = open(p, encoding='utf-8').read()
    open(p, 'w', encoding='utf-8').write(s0.replace('\n\n', '\n\n补。\n\n', 1)); os.utime(p, (t0 + 0.5, t0 + 0.5))
    c, d, e = script('advance.py', rd_prd)
    check('D3 后 1 秒内改源文件（run_state slack 之内）→ 仍判 reset-D3', c == 0 and d.get('step') == 'reset-D3', (c, d.get('step')))
    open(p, 'w', encoding='utf-8').write(s0)
    p = os.path.join(rd_prd, 'doc.md'); open(p, 'a', encoding='utf-8').write('\n补一句说明。\n')
    os.utime(p, None)
    c, d, e = script('advance.py', rd_prd)
    check('D3 通过后又改了 doc.md → 下一步 reset-D3（可执行）', c == 0 and d.get('step') == 'reset-D3' and d.get('runnable'), (c, d.get('step'), d.get('blocking_reasons')))

    print('== 改版与交叉引用复查 ==')
    rd_prd13 = os.path.join(DOCS, 'prd-points-v1.3')
    pm = json.load(open(os.path.join(rd_prd, 'doc.json'))); pm['title'] = '会员积分系统 v2（运行中改过的标题）'
    json.dump(pm, open(os.path.join(rd_prd, 'doc.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    c, d, e = script('new_run.py', 'prd', rd_prd13, '--from', rd_prd, '--version', '1.2.0', '--change-summary', 'x')
    check('改版：新版本与旧版等值（1.2.0 = 1.2）→ 退出 2', c == 2, (c, d))
    c, d, e = script('new_run.py', 'prd', rd_prd13, '--from', rd_prd, '--version', '1.3')
    check('改版：缺 --change-summary → 退出 2', c == 2, (c, d))
    c, d, e = script('new_run.py', 'prd', rd_prd13, '--from', rd_prd, '--version', '1.3', '--change-summary', '删除运营后台人工调整需求')
    check('改版：new_run --from 退出 0（沿用上一版 brief.json 的 inputs）', c == 0, (c, d, e[-300:]))
    if c != 0:
        raise SystemExit('改版目录未建成，后续断言无意义：' + json.dumps(d, ensure_ascii=False)[:600])
    m13 = json.load(open(os.path.join(rd_prd13, 'doc.json')))
    st13 = json.load(open(os.path.join(rd_prd13, 'run-state.json')))
    check('改版：退出 0、version 1.3、status draft、修订记录追加 v1.3', c == 0 and m13['version'] == '1.3' and m13['status'] == 'draft' and m13['revision_history'][-1]['version'] == 'v1.3', (c, d))
    check('改版：以上一版当前 doc.json 为基线（运行中改过的标题不被旧 brief 覆盖）', m13['title'] == pm['title'], m13['title'])
    check('改版：inputs 沿用上一版 brief.json', json.load(open(os.path.join(rd_prd13, 'brief.json'))).get('inputs', {}).get('input1'), open(os.path.join(rd_prd13, 'brief.json')).read()[:300])
    check('改版：run-state mode=revision、base_doc 指向旧目录、门全部 pending', st13['mode'] == 'revision' and os.path.realpath(st13['base_doc']) == os.path.realpath(rd_prd)
          and all(v['status'] == 'pending' for v in st13['gates'].values()), st13)
    check('改版：base/base-doc.md 为上一版正文快照；out/、qa-result 不复制', os.path.exists(os.path.join(rd_prd13, 'base', 'base-doc.md')) and not os.path.exists(os.path.join(rd_prd13, 'qa-result.json')) and not os.path.exists(os.path.join(rd_prd13, 'out')))
    p = os.path.join(rd_prd13, 'doc.md'); s = open(p, encoding='utf-8').read()
    removed = sorted(set(re.findall(r'^\| (REQ-ADMIN-\d{2}) \|', s, re.M)))
    open(p, 'w', encoding='utf-8').write('\n'.join(l for l in s.split('\n') if not re.match(r'^\| REQ-ADMIN-\d{2} \|', l)))
    c, d, e = script('xref_check.py', rd_prd13, '--scan', os.path.join(BASE, 'docs'))
    hits = [h for h in d.get('downstream_hits') or [] if os.path.realpath(h['run_dir']) == os.path.realpath(rd_tc)]
    check('改版删掉编号：样张确有 REQ-ADMIN 定义可删', bool(removed), removed)
    check('xref（新版 PRD）：removed_codes 列出本版删除的编号', set(removed) <= set((d.get('removed_codes') or {}).get('requirement', [])), d.get('removed_codes'))
    check('xref（新版 PRD）：下游找到 test-cases（指向旧目录，stale）', any(os.path.realpath(x['run_dir']) == os.path.realpath(rd_tc) and x['stale'] and x['points_to_old_dir'] for x in d.get('downstream') or []), d.get('downstream'))
    check('xref（新版 PRD）：下游仍引用被删编号 → 逐条提示', hits and set(removed) & set(hits[0]['codes']) and any('未定义的编号' in w for w in d['warnings']), (hits, d.get('warnings')))
    p = os.path.join(rd_tc, 'doc.json'); m = json.load(open(p))
    m['related_docs'][0]['path'] = '../prd-points-v1.3'
    json.dump(m, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    c, d, e = script('xref_check.py', rd_tc, '--no-downstream')
    check('xref（test-cases 改指新版 PRD）：悬空引用 → 退出 3', c == 3 and set(removed) & {x['code'] for x in d.get('dangling') or []}, (c, d.get('dangling')))
    check('xref（test-cases）：关联文档版本不一致 → 复查提示', any('已变版本' in w for w in d.get('warnings') or []), d.get('warnings'))
    c, d, e = script('advance.py', rd_tc)
    check('advance（test-cases）：D3 已签后改了 related_docs → 先给 reset-D3（验收③）', c == 0 and d.get('step') == 'reset-D3', (c, d.get('step'), d.get('blocking_reasons')))
    c, d, e = script('advance.py', rd_tc, '--run')
    check('advance --run（test-cases）：执行 reset-D3 后阻塞在 xref（写作者）', c == 3 and d.get('step') == 'xref' and d.get('actor') == 'author'
          and [x['step'] for x in d.get('executed') or []] == ['reset-D3'], (c, d.get('step'), d.get('executed'), d.get('blocking_reasons')))
    m['related_docs'][0]['path'] = '../prd-points-v1.2'; m['related_docs'][0]['version'] = '1.2.0'
    json.dump(m, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    c, d, e = script('xref_check.py', rd_tc, '--no-downstream')
    check('xref：登记 1.2.0、对方 1.2 → 不报版本变化', not any('已变版本' in w for w in d.get('warnings') or []), d.get('warnings'))
    script('advance.py', rd_prd13, '--run'); gate(rd_prd13, 'D1', '改版范围确认（自测）')
    c, d, e = script('advance.py', rd_prd13)
    check('advance（改版 PRD，自身无 related_docs）：仍跑交叉引用复查并发现下游', (d.get('artifacts') or {}).get('xref', {}).get('downstream', 0) >= 1, (c, d.get('artifacts'), d.get('warnings')[:3]))

# ---------------------------------------------------------------- D0 输入复查
print('== 门禁：D0 输入 ==')
rd_d0 = os.path.join(BASE, 'd0', 'prd-d0-v0.1')
c, d, e = script('new_run.py', 'prd', rd_d0, '--brief', write_brief('b-d0.json', brief_from_sample('prd', version='0.1')))
bp = os.path.join(rd_d0, 'brief.json'); b = json.load(open(bp)); b['inputs']['input2'] = ''; json.dump(b, open(bp, 'w'), ensure_ascii=False)
c, d, e = script('advance.py', rd_d0, '--run')
check('brief.json inputs 事后被清空 → D0 不执行、阻塞交用户', c == 3 and d.get('step') == 'gate-D0' and d.get('actor') == 'user' and not d.get('executed') and any('input2' in r for r in d['blocking_reasons']), (c, d))
c, o, e = run([PY, os.path.join(S, 'status.py'), rd_d0])
check('status.py：D0 阻塞原因可读', c == 0 and 'input2' in o, o[-400:])

# ---------------------------------------------------------------- 业务词守卫
print('== 业务词守卫 ==')
words = ['REQ-', 'TC-', 'PRD', 'MRD', '用例', '报价', '需求文档', '测试计划', 'Reddit', 'Shopify', '会员积分']
hits = []
for f in glob.glob(os.path.join(S, '*.py')):
    for i, l in enumerate(open(f, encoding='utf-8'), 1):
        for w in words:
            if w in l: hits.append(f'{os.path.basename(f)}:{i}:{w}')
check('scripts/ 不含业务词（类型词只在 references/type-triggers.json）', not hits, hits[:10])

print()
if '--keep' in sys.argv: print('临时目录保留：', BASE)
else: shutil.rmtree(BASE, ignore_errors=True)
print('ALL PASS' if not fails else f'{len(fails)} FAIL：' + '；'.join(fails))
sys.exit(1 if fails else 0)
