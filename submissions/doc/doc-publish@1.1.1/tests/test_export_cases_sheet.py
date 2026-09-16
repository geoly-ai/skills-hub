#!/usr/bin/env python3
"""export_cases_sheet.py 自测。不写真实飞书：lark-cli 一律用 PATH 注入的带状态假服务端（严格校验 argv 与 @文件内容，违规计 FAIL）；
真实 lark-cli 只跑 --help，核对脚本用到的每个 flag 都存在。只写系统临时目录与 ~/.cache/doc-publish/lark-write.lock（与 publish.py 共用的全局写锁）。
用法：test_export_cases_sheet.py [--keep] [--allow-unverified-lark]；退出码 0 全部通过，1 有失败。"""
import json, os, re, shutil, subprocess, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))
DP = os.path.dirname(H)
SK = os.path.dirname(DP)
SCRIPT = os.path.join(DP, 'scripts', 'export_cases_sheet.py')
RS = os.path.join(SK, 'doc-shared', 'scripts', 'run_state.py')
SAMPLE = os.path.join(SK, 'doc-shared', 'types', 'test-cases', 'samples', 'membership-points-v2')
PY = sys.executable
sys.dont_write_bytecode = True
fails, skips = [], []
BASE = tempfile.mkdtemp(prefix='export-sheet-tests-')

FAKE = r'''#!__PY__
import csv, io, json, os, re, sys, time
argv = sys.argv[1:]
env = os.environ
scen = json.load(open(env['FAKE_SCENARIO']))
sp = env['FAKE_STATE']
state = json.load(open(sp)) if os.path.exists(sp) else {'folders': scen.get('folders', {'': []}), 'books': scen.get('books', {}), 'seq': 0, 'fail_once_done': []}
open(env['FAKE_LOG'], 'a').write(json.dumps({'argv': argv, 't': time.time(), 'cwd': os.getcwd(),
     'proxies': sorted(k for k in env if k.upper() in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')), 'config_dir': env.get('LARKSUITE_CLI_CONFIG_DIR')}, ensure_ascii=False) + '\n')
def save(): json.dump(state, open(sp, 'w'), ensure_ascii=False)
def out(obj, code=0, err=False):
    (sys.stderr if err else sys.stdout).write(json.dumps(obj, ensure_ascii=False) + '\n'); save(); sys.exit(code)
def violation(msg):
    open(env['FAKE_VIOLATIONS'], 'a').write(json.dumps({'argv': argv, 'message': msg}, ensure_ascii=False) + '\n')
    out({'ok': False, 'error': {'type': 'validation', 'message': msg}}, 2, err=True)
TOKEN = r'^[A-Za-z0-9]{8,}$'
A1 = r'^[A-Z]+[1-9]\d*(:[A-Z]+[1-9]\d*)?$'
SPEC = {
    ('drive', 'files', 'list'): {'req': {'--as': 'user', '--params': 'params', '--format': 'json'}, 'opt': {}},
    ('drive', '+create-folder'): {'req': {'--as': 'user', '--name': 'any', '--format': 'json'}, 'opt': {'--folder-token': 'token'}},
    ('sheets', '+workbook-create'): {'req': {'--as': 'user', '--title': 'any', '--folder-token': 'token', '--sheets': '@sheets', '--styles': '@styles', '--format': 'json'}, 'opt': {}},
    ('sheets', '+workbook-info'): {'req': {'--as': 'user', '--spreadsheet-token': 'token', '--format': 'json'}, 'opt': {}},
    ('sheets', '+sheet-info'): {'req': {'--as': 'user', '--spreadsheet-token': 'token', '--sheet-id': 'any', '--include': 'merges', '--format': 'json'}, 'opt': {}},
    ('sheets', '+csv-get'): {'req': {'--as': 'user', '--spreadsheet-token': 'token', '--sheet-id': 'any', '--format': 'json'}, 'opt': {}},
    ('sheets', '+table-put'): {'req': {'--as': 'user', '--spreadsheet-token': 'token', '--sheets': '@sheets', '--styles': '@styles', '--format': 'json'}, 'opt': {}},
    ('sheets', '+dropdown-update'): {'req': {'--as': 'user', '--spreadsheet-token': 'token', '--ranges': '@ranges', '--options': '@options', '--format': 'json'}, 'opt': {'--colors': '@colors'}},
}
cmd = tuple(argv[:3]) if tuple(argv[:3]) in SPEC else tuple(argv[:2])
if cmd not in SPEC: violation('不认识的命令 ' + ' '.join(argv[:3]))
spec = SPEC[cmd]; rest = argv[len(cmd):]
if len(rest) % 2: violation('参数不是成对的 flag 值')
if rest[-2:] != ['--format', 'json']: violation('--format json 必须在最后')
opts, files = {}, {}
for i in range(0, len(rest), 2):
    k, v = rest[i], rest[i + 1]
    kind = spec['req'].get(k) or spec['opt'].get(k)
    if kind is None: violation(f'{" ".join(cmd)} 不接受 {k}')
    if k in opts: violation(f'重复 {k}')
    if kind.startswith('@'):
        if not v.startswith('@./') or not os.path.isfile(os.path.join(os.getcwd(), v[3:])): violation(f'{k} 必须是 @./ 相对 cwd 存在的文件：{v}')
        try: files[kind[1:]] = json.load(open(os.path.join(os.getcwd(), v[3:]), encoding='utf-8'))
        except ValueError: violation(f'{k} 文件不是 JSON')
    elif kind == 'token':
        if not re.match(TOKEN, v): violation(f'{k} token 格式不对：{v}')
    elif kind == 'params':
        p = json.loads(v)
        if not isinstance(p.get('folder_token'), str) or not isinstance(p.get('page_size'), int) or set(p) - {'folder_token', 'page_size', 'page_token'}: violation('--params 字段不对')
    elif kind == 'any':
        if not v: violation(f'{k} 为空')
    elif v != kind: violation(f'{k} 必须是 {kind}，实际 {v}')
    opts[k] = v
miss = [k for k in spec['req'] if k not in opts]
if miss: violation(f'缺少 {miss}')
key = ' '.join(cmd[:2]) if cmd[0] != 'drive' or cmd[1] != 'files' else 'drive files'
def check_sheets(p):
    if not isinstance(p, dict) or not isinstance(p.get('sheets'), list) or not p['sheets']: violation('--sheets 顶层必须是 {sheets:[...]} 且非空')
    names = []
    for it in p['sheets']:
        if not isinstance(it.get('name'), str) or not it['name'] or it['name'] in names: violation('--sheets 每项 name 必填且不重复')
        names.append(it['name'])
        cols = it.get('columns')
        if not isinstance(cols, list) or not all(isinstance(c, str) and c for c in cols): violation('--sheets columns 必须是非空字符串数组')
        if set(it) - {'name', 'start_cell', 'mode', 'header', 'allow_overwrite', 'columns', 'data', 'dtypes', 'formats'}: violation('--sheets 项有未知字段')
        if it.get('mode', 'overwrite') not in ('overwrite', 'append'): violation('mode 取值不对')
        for r in it.get('data') or []:
            if not isinstance(r, list) or len(r) != len(cols) or not all(isinstance(x, (str, int, float, bool)) or x is None for x in r): violation('--sheets data 行长度必须等于 columns')
    return names
def check_styles(p, names):
    if not isinstance(p, dict) or [s.get('name') for s in p.get('styles') or []] != names: violation('--styles 长度、顺序、name 必须与 --sheets 一致')
    for s in p['styles']:
        if set(s) - {'name', 'cell_styles', 'cell_merges', 'row_sizes', 'col_sizes', 'freeze'}: violation('--styles 项有未知字段')
        if not any(s.get(k) for k in ('cell_styles', 'cell_merges', 'row_sizes', 'col_sizes', 'freeze')): violation('--styles 项至少给一类样式')
        for c in s.get('cell_styles') or []:
            if not re.match(A1, c.get('range', '')) or len(c) < 2: violation(f'cell_styles range 或字段不对：{c}')
        for c in s.get('col_sizes') or []:
            if not re.match(r'^[A-Z]+(:[A-Z]+)?$', c.get('range', '')) or not isinstance(c.get('size'), (int, float)): violation(f'col_sizes 不对：{c}')
        fz = s.get('freeze')
        if fz is not None and (set(fz) - {'rows', 'cols'} or not all(isinstance(v, int) and v >= 0 for v in fz.values())): violation('freeze 不对')
def grid_write(sheet, cols, data):
    rows = [cols] + [[('' if x is None else str(x)) for x in r] for r in data]
    g = sheet['grid']
    for i, r in enumerate(rows):
        while len(g) <= i: g.append([])
        while len(g[i]) < len(r): g[i].append('')
        for j, v in enumerate(r): g[i][j] = v
def book_or_404(tok):
    if tok not in state['books']: out({'ok': False, 'error': {'type': 'api', 'message': 'spreadsheet not found'}}, 1, err=True)
    return state['books'][tok]
for ev, lst in (('exit10_on', scen.get('exit10_on', [])),):
    if key in lst:
        out({'ok': False, 'error': {'type': 'confirmation', 'subtype': 'confirmation_required', 'message': key + ' requires confirmation', 'hint': 'add --yes', 'risk': 'high-risk-write', 'action': key}}, 10, err=True)
fo = scen.get('fail_once', {})
if key in fo and key not in state['fail_once_done']:
    state['fail_once_done'].append(key); out({'ok': False, 'error': {'type': 'api', 'message': fo[key]}}, 1, err=True)
if key in scen.get('fail_on', {}):
    out({'ok': False, 'error': {'type': 'api', 'message': scen['fail_on'][key]}}, 1, err=True)
if key == 'drive files':
    tok = json.loads(opts['--params'])['folder_token']
    if tok not in state['folders']: out({'ok': False, 'error': {'type': 'api', 'message': 'folder not found'}}, 1, err=True)
    out({'ok': True, 'data': {'files': [{'name': f['name'], 'token': f['token'], 'type': 'folder'} for f in state['folders'][tok]], 'has_more': False}})
if key == 'drive +create-folder':
    parent = opts.get('--folder-token', '')
    state['seq'] += 1; tok = 'fldNew%04d' % state['seq']
    state['folders'].setdefault(parent, []).append({'name': opts['--name'], 'token': tok}); state['folders'][tok] = []
    out({'ok': True, 'data': {'folder_token': tok}})
if key == 'sheets +workbook-create':
    names = check_sheets(files['sheets']); check_styles(files['styles'], names)
    if opts['--folder-token'] not in state['folders']: out({'ok': False, 'error': {'type': 'api', 'message': 'folder not found'}}, 1, err=True)
    state['seq'] += 1; tok = 'shtNew%06d' % state['seq']
    book = {'title': opts['--title'], 'folder': opts['--folder-token'], 'sheets': [], 'dropdowns': []}
    for i, it in enumerate(files['sheets']['sheets']):
        sh = {'sheet_id': 'sid%03d%02d' % (state['seq'], i), 'title': it['name'], 'grid': [], 'merges': []}
        grid_write(sh, it['columns'], it['data']); book['sheets'].append(sh)
    state['books'][tok] = book
    if scen.get('tamper_after_write'): book['sheets'][0]['grid'][1][0] = 'TAMPERED'
    if scen.get('create_lost_response'): save(); sys.exit(1)
    out({'ok': True, 'data': {'spreadsheet': {'spreadsheet_token': tok, 'url': 'https://x.feishu.cn/sheets/' + tok, 'title': opts['--title']}}})
if key == 'sheets +workbook-info':
    b = book_or_404(opts['--spreadsheet-token'])
    out({'ok': True, 'data': {'sheets': [{'sheet_id': s['sheet_id'], 'title': s['title'], 'index': i, 'resource_type': s.get('resource_type', 'sheet'),
         'row_count': 200, 'column_count': 20} for i, s in enumerate(b['sheets'])]}})
def sheet_by_id(b, sid):
    s = next((x for x in b['sheets'] if x['sheet_id'] == sid), None)
    if s is None: out({'ok': False, 'error': {'type': 'api', 'message': 'sheet not found'}}, 1, err=True)
    return s
if key == 'sheets +sheet-info':
    s = sheet_by_id(book_or_404(opts['--spreadsheet-token']), opts['--sheet-id'])
    out({'ok': True, 'data': {'merges': s['merges'], 'frozen_row_count': 1}})
if key == 'sheets +csv-get':
    s = sheet_by_id(book_or_404(opts['--spreadsheet-token']), opts['--sheet-id'])
    buf = io.StringIO(); w = csv.writer(buf, lineterminator='\n')
    for i, r in enumerate(s['grid'], 1):
        buf.write(f'[row={i}] '); w.writerow(r)
    out({'ok': True, 'data': {'annotated_csv': buf.getvalue(), 'row_count': len(s['grid']), 'has_more': False, 'actual_range': 'A1:Z%d' % max(1, len(s['grid']))}})
if key == 'sheets +table-put':
    b = book_or_404(opts['--spreadsheet-token'])
    names = check_sheets(files['sheets']); check_styles(files['styles'], names)
    for it in files['sheets']['sheets']:
        s = next((x for x in b['sheets'] if x['title'] == it['name']), None)
        if s is None:
            s = {'sheet_id': 'sidT%04d' % len(b['sheets']), 'title': it['name'], 'grid': [], 'merges': []}; b['sheets'].append(s)
        grid_write(s, it['columns'], it['data'])
    out({'ok': True, 'data': {'written': len(names)}})
if key == 'sheets +dropdown-update':
    b = book_or_404(opts['--spreadsheet-token'])
    rg, op, co = files['ranges'], files['options'], files.get('colors')
    if not isinstance(rg, list) or not rg or len(rg) > 100: violation('--ranges 必须是 1–100 项数组')
    titles = {s['title'] for s in b['sheets']}
    for r in rg:
        m = re.match(r'^(.+)!([A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*)$', r)
        if not m or m.group(1) not in titles: violation(f'--ranges 项必须带存在的工作表名前缀：{r}')
    if not isinstance(op, list) or not op or not all(isinstance(x, str) and x for x in op): violation('--options 必须是非空字符串数组')
    if co is not None and (not isinstance(co, list) or len(co) > len(op) or not all(re.match(r'^#[0-9A-Fa-f]{6}$', c) for c in co)): violation('--colors 长度不能超过选项数且为 #RRGGBB')
    b['dropdowns'].append({'ranges': rg, 'options': op, 'colors': co})
    out({'ok': True, 'data': {'updated': len(rg)}})
violation('未处理的命令 ' + key)
'''


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:700]}]' if detail and not cond else ''))
    if not cond:
        fails.append(name)


def skip(name, why):
    print(f'SKIP {name}（{why}）'); skips.append(name)


class Env:
    _n = {}

    def __init__(self, scen=None, folders=None, doc_edit=None, meta_edit=None, prefix='case', d3='passed'):
        Env._n[prefix] = Env._n.get(prefix, 0) + 1
        self.dir = os.path.join(BASE, f'{prefix}{Env._n[prefix]}')
        self.run_dir = os.path.join(self.dir, 'run')
        shutil.copytree(SAMPLE, self.run_dir, ignore=shutil.ignore_patterns('out'))
        self.bin = os.path.join(self.dir, 'bin'); os.makedirs(self.bin)
        fake = os.path.join(self.bin, 'lark-cli')
        open(fake, 'w').write(FAKE.replace('__PY__', PY)); os.chmod(fake, 0o755)
        self.log, self.viol, self.state = (os.path.join(self.dir, x) for x in ('log.jsonl', 'violations.jsonl', 'state.json'))
        sc = dict(scen or {})
        sc['folders'] = folders if folders is not None else {'': [{'name': '内部产品文档', 'token': 'fldRoot0001'}], 'fldRoot0001': [{'name': '会员积分系统 v2', 'token': 'fldProj0001'}], 'fldProj0001': []}
        self.scen_path = os.path.join(self.dir, 'scen.json'); json.dump(sc, open(self.scen_path, 'w'), ensure_ascii=False)
        if meta_edit:
            p = os.path.join(self.run_dir, 'doc.json'); d = json.load(open(p, encoding='utf-8')); meta_edit(d); json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
        if doc_edit:
            doc_edit(self.run_dir)
        if d3:
            self.gate(d3)

    def gate(self, d3='passed'):
        """导出前置检查夹具：run_state.py init 建合法 run-state，D0–D2 记为通过，D3 按参数；passed 时写 source_manifest（与 run_state.py 同一实现）。"""
        r = subprocess.run([PY, RS, self.run_dir, 'init', '--type', 'test-cases', '--mode', 'new', '--force'], capture_output=True, text=True)
        assert r.returncode == 0, r.stdout + r.stderr
        sp = self.path('run-state.json'); st = json.load(open(sp, encoding='utf-8'))
        for g in ('D0', 'D1', 'D2'):
            st['gates'][g] = {'status': 'passed', 'by': '自测', 'evidence': ['自测夹具']}
        st['gates']['D3'] = {'status': d3, 'by': '自测', 'evidence': ['自测夹具']}
        json.dump(st, open(sp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        if d3 == 'passed':
            self.sign()

    def sign(self):
        """模拟重跑质检并重过 D3：按当前源文件刷新 gates.D3.source_manifest。"""
        sys.path.insert(0, os.path.dirname(RS))
        import run_state as rsm  # noqa: E402
        sp = self.path('run-state.json'); st = json.load(open(sp, encoding='utf-8'))
        st['gates']['D3']['source_manifest'] = rsm.build_manifest(self.run_dir)
        json.dump(st, open(sp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    def scen(self, **kw):
        sc = json.load(open(self.scen_path)); sc.update(kw); json.dump(sc, open(self.scen_path, 'w'), ensure_ascii=False)

    def run(self, *args, extra_env=None):
        env = {k: v for k, v in os.environ.items() if k not in ('LARKSUITE_CLI_CONFIG_DIR',)}
        env.update({'PATH': self.bin + os.pathsep + '/usr/bin:/bin', 'FAKE_SCENARIO': self.scen_path, 'FAKE_STATE': self.state, 'FAKE_LOG': self.log,
                    'FAKE_VIOLATIONS': self.viol, 'HTTP_PROXY': 'http://127.0.0.1:7890', 'https_proxy': 'http://127.0.0.1:7890', 'HOME': os.environ.get('HOME', '')})
        env.update(extra_env or {})
        r = subprocess.run([PY, SCRIPT, self.run_dir] + list(args), capture_output=True, text=True, env=env, timeout=600)
        try:
            body = json.loads(r.stdout)
        except ValueError:
            body = {'raw': r.stdout[-500:] + r.stderr[-500:]}
        return r.returncode, body

    def calls(self):
        return [json.loads(l) for l in open(self.log)] if os.path.exists(self.log) else []

    def cmds(self):
        return [' '.join(c['argv'][:2]) for c in self.calls()]

    def violations(self):
        return [json.loads(l) for l in open(self.viol)] if os.path.exists(self.viol) else []

    def st(self):
        return json.load(open(self.state)) if os.path.exists(self.state) else {}

    def path(self, rel):
        return os.path.join(self.run_dir, rel)


WRITES = ('drive +create-folder', 'sheets +workbook-create', 'sheets +table-put', 'sheets +dropdown-update')
EVID = ['--evidence', '用户：确认导出到测试用例文件夹']


def write_calls(e):
    return [c for c in e.calls() if ' '.join(c['argv'][:2]) in WRITES]


# ---------------------------------------------------------------- 1. dry-run
e = Env()
code, b = e.run('--offline')
check('dry-run 离线：退出 0、不调用 lark-cli、写 plan.json', code == 0 and b.get('dry_run') and not e.calls() and os.path.exists(e.path('out/sheet-export/plan.json')), (code, b.get('message')))
sh = b.get('sheets') or []
check('dry-run：按模块 7 个工作表共 47 行，模块名取章节标题', [s['name'] for s in sh] == ['积分账户', '积分获取', '积分消耗', '会员等级', '规则引擎', '通知', '运营后台'] and sum(s['rows'] for s in sh) == 47, [(s['name'], s['rows']) for s in sh])
if sh:
    s0 = sh[0]
    dd = {d['column']: d for d in s0['dropdowns']}
    check('dry-run：优先级 P0–P3 与执行状态下拉、类型与自动化按 skeleton.md 下拉', dd.get('优先级', {}).get('options') == ['P0', 'P1', 'P2', 'P3'] and dd.get('执行状态', {}).get('options') == ['未执行', '通过', '失败', '阻塞']
          and '功能' in dd.get('类型', {}).get('options', []) and dd.get('自动化', {}).get('options') == ['是', '否', '计划'] and dd['优先级']['range'] == '积分账户!D2:D5', dd)
    check('dry-run：必填列取 skeleton.md（测试数据、自动化为按需不算），冻结首行首列，列宽 80–360', s0['required_columns'] == ['用例编号', '标题', '关联需求', '优先级', '类型', '前置条件', '测试步骤', '预期结果']
          and s0['freeze'] == {'rows': 1, 'cols': 1} and all(80 <= c['size'] <= 360 for c in s0['col_sizes']) and s0['columns'][-1] == '执行状态', s0)
    sheets_json = json.load(open(e.path('out/sheet-export/sheets.json')))
    check('dry-run：sheets.json 状态列初值「未执行」，用例编号在首列', all(r[-1] == '未执行' for it in sheets_json['sheets'] for r in it['data']) and sheets_json['sheets'][0]['data'][0][0] == 'TC-ACCT-01')
e = Env()
code, b = e.run()
wc = [c for c in b.get('plan', {}).get('writes', [])]
check('dry-run 在线：只调用读命令（drive files list），计划里有新建子项目文件夹与 +workbook-create', code == 0 and set(e.cmds()) == {'drive files'} and not e.violations()
      and any(w[1:3] == ['drive', '+create-folder'] and '测试用例' in w for w in wc) and any(w[1:3] == ['sheets', '+workbook-create'] for w in wc), (code, e.cmds(), e.violations(), b.get('message')))
check('dry-run 在线：lark-cli 调用前代理变量已删除', all(not c['proxies'] for c in e.calls()), [c['proxies'] for c in e.calls()][:2])
code, b = e.run('--layout', 'single', '--offline')
check('single 布局：一个「全部用例」工作表、首列为模块', code == 0 and [s['name'] for s in b['sheets']] == ['全部用例'] and b['sheets'][0]['columns'][0] == '模块' and b['sheets'][0]['rows'] == 47, b.get('sheets'))
code, b = e.run('--status-column', 'none', '--offline')
check('--status-column none：不加状态列', code == 0 and '执行状态' not in b['sheets'][0]['columns'])
e = Env()
ext = os.path.join(e.dir, 'outside'); os.makedirs(ext); os.symlink(ext, e.path('out'))
code, b = e.run('--offline')
check('out/ 是符号链接：退出 2，外部目录不写入', code == 2 and '符号链接' in b.get('message', '') and not os.listdir(ext), (code, b.get('message'), os.listdir(ext)))
e = Env()
import fcntl
os.makedirs(e.path('out'), exist_ok=True)
lf = open(e.path('out/.sheet-export.lock'), 'a+'); fcntl.flock(lf, fcntl.LOCK_EX)
code, b = e.run('--offline')
fcntl.flock(lf, fcntl.LOCK_UN); lf.close()
check('同一运行目录已有导出进程持锁：退出 2，不生成计划', code == 2 and '另一个导出进程' in b.get('message', '') and not os.path.exists(e.path('out/sheet-export/plan.json')), (code, b.get('message')))

# ---------------------------------------------------------------- 2. 参数与预检
e = Env()
code, b = e.run('--apply')
check('--apply 缺 --evidence 退出 2，不调用 lark-cli', code == 2 and not e.calls(), b.get('message'))
code, b = e.run('--apply', '--offline', *EVID)
check('--apply 与 --offline 同给退出 2', code == 2)
code, b = e.run('--folder-path', '只有一段', '--offline')
check('落点不足两段退出 5 并给选项', code == 5 and b.get('options'), b)
code, b = e.run('--pack', os.path.join(BASE, 'nowhere'), '--offline')
check('--pack 不在可信目录退出 2', code == 2 and '可信' in b.get('message', '') or '只接受' in b.get('message', ''), b.get('message'))
e2 = Env(meta_edit=lambda d: d.__setitem__('type', 'prd'))
code, b = e2.run('--offline')
check('运行目录类型不是 test-cases 退出 2', code == 2 and 'test-cases' in b.get('message', ''), b)


def edit_csv(fn):
    def _(rd):
        p = os.path.join(rd, 'data', 'cases.csv'); s = open(p, encoding='utf-8').read(); s2 = fn(s); assert s2 != s; open(p, 'w', encoding='utf-8').write(s2)
    return _


e = Env(doc_edit=edit_csv(lambda s: s.replace('TC-ACCT-01,注册成功后自动开通积分账户,REQ-ACCT-01,P0,', 'TC-ACCT-01,注册成功后自动开通积分账户,REQ-ACCT-01,P9,')
                         .replace(',是\nTC-ACCT-02,重复触发注册事件不重复开通账户,REQ-ACCT-01,P1,异常,会员账户已存在,', ',是\nTC-ACCT-02,,REQ-ACCT-01,P1,异常,会员账户已存在,')))
code, b = e.run('--offline')
check('预检：优先级取值不在下拉选项、必填标题为空 → 退出 1，列出 problems', code == 1 and any('P9' in p for p in b['problems']) and any('TC-ACCT-02' in p and '标题' in p for p in b['problems']), b.get('problems'))
e = Env(doc_edit=edit_csv(lambda s: s.replace(',是\nTC-ACCT-02,重复触发注册事件不重复开通账户,', ',是\nTC-ACCT-02,,')))
code, b = e.run('--offline', '--allow-missing-required')
check('预检：--allow-missing-required 把必填为空降为警告', code == 0 and any('TC-ACCT-02' in w for w in b['warnings']), (code, b.get('problems')))

# ---------------------------------------------------------------- 3. apply 新建 → 更新
e = Env()
code, b = e.run('--apply', *EVID)
token = (b.get('spreadsheet') or {}).get('token')
rec = json.load(open(e.path('out/sheet-export.json'))) if os.path.exists(e.path('out/sheet-export.json')) else {}
check('apply 新建：退出 0、写记录、删除意图文件、假服务端无参数违规', code == 0 and token and rec.get('spreadsheet_token') == token and not os.path.exists(e.path('out/sheet-export/.write-intent.json')) and not e.violations(),
      (code, b.get('message'), b.get('problems'), e.violations()[:2]))
seq = [x for x in e.cmds()]
check('apply 新建：顺序为 逐层列文件夹 → 建子项目文件夹 → +workbook-create → 4 次 +dropdown-update → 回读 +workbook-info 与 7 次 +csv-get', seq ==
      ['drive files'] * 3 + ['drive +create-folder', 'sheets +workbook-create'] + ['sheets +dropdown-update'] * 4 + ['sheets +workbook-info'] + ['sheets +csv-get'] * 7, seq)
st = e.st(); book = st.get('books', {}).get(token or '', {})
check('apply 新建：表格落在新建的「测试用例」文件夹，7 个工作表各有 sheet_id 记录', book.get('folder') == 'fldNew0001' and len(rec.get('sheets', [])) == 7 and all(s['sheet_id'] for s in rec['sheets']), (book.get('folder'), rec.get('sheets')))
wt = [c['t'] for c in write_calls(e)]
check('apply：写命令间隔 ≥ 1 秒（全局写锁）', len(wt) == 6 and all(b2 - a2 >= 0.98 for a2, b2 in zip(wt, wt[1:])), [round(b2 - a2, 2) for a2, b2 in zip(wt, wt[1:])])
check('apply：所有 lark-cli 调用无代理变量、account1 不设配置目录', all(not c['proxies'] and not c['config_dir'] for c in e.calls()))
check('apply：下拉覆盖全部 7 个工作表，优先级胶囊用语义色', any(d['options'] == ['P0', 'P1', 'P2', 'P3'] and len(d['ranges']) == 7 and d['colors'] == ['#FDE2E1', '#FFF1D6', '#E3F1FF', '#EEF0F2'] for d in book.get('dropdowns', [])), book.get('dropdowns'))
# 更新：删两条用例，链接不变，多出的旧行被空值覆盖；执行人员已填的状态保留
st0 = e.st(); a0 = next(x for x in st0['books'][token]['sheets'] if x['title'] == '积分账户')
a0['grid'][1][a0['grid'][0].index('执行状态')] = '通过'
json.dump(st0, open(e.state, 'w'), ensure_ascii=False)
open(e.log, 'w').close()
p = e.path('data/cases.csv'); s = open(p, encoding='utf-8').read()
s = '\n'.join(l for l in s.split('\n') if not l.startswith(('TC-ACCT-03,', 'TC-ACCT-04,'))); open(p, 'w', encoding='utf-8').write(s)
e.sign()   # 改了用例数据：模拟重跑质检并重过 D3（否则导出前置检查拒绝）
code, b = e.run('--apply', *EVID)
st = e.st(); book = st['books'][token]
acct = next(x for x in book['sheets'] if x['title'] == '积分账户')
check('apply 更新：沿用记录里的表格（不新建、链接不变），table-put 覆盖，退出 0', code == 0 and len(st['books']) == 1 and (b.get('spreadsheet') or {}).get('token') == token
      and 'sheets +workbook-create' not in e.cmds() and 'sheets +table-put' in e.cmds() and not e.violations(), (code, b.get('message'), b.get('problems'), e.cmds()))
check('apply 更新：先读 +workbook-info、+sheet-info、+csv-get 再写；多出的 2 行被空值覆盖，回读通过', e.cmds().index('sheets +table-put') > e.cmds().index('sheets +csv-get') > e.cmds().index('sheets +sheet-info')
      and [r[0] for r in acct['grid'][1:]] == ['TC-ACCT-01', 'TC-ACCT-02', '', ''] and b.get('plan', {}).get('pads', {}).get('积分账户') == 2, ([r[0] for r in acct['grid']], b.get('plan', {}).get('pads')))
si = acct['grid'][0].index('执行状态')
check('apply 更新：表格里已填的执行状态按用例编号回填（TC-ACCT-01 保持「通过」，其余「未执行」）', acct['grid'][1][si] == '通过' and acct['grid'][2][si] == '未执行' and b.get('status_preserved') == 1,
      ([r[si] for r in acct['grid'][1:3]], b.get('status_preserved')))
# 计划外旧工作表：警告不删；有合并单元格：拒绝
book['sheets'].append({'sheet_id': 'sidOld01', 'title': '旧模块', 'grid': [['x']], 'merges': []})
json.dump(st, open(e.state, 'w'), ensure_ascii=False)
open(e.log, 'w').close()
code, b = e.run()
check('更新 dry-run：计划外的工作表只警告、不删除', code == 0 and any('旧模块' in w for w in b['warnings']) and not [c for c in write_calls(e)], b.get('warnings'))
book['sheets'][0]['merges'] = [{'range': 'A2:A3'}]
json.dump(st, open(e.state, 'w'), ensure_ascii=False)
open(e.log, 'w').close()
code, b = e.run('--apply', *EVID)
check('更新：目标工作表有合并单元格 → 退出 1，不发写命令', code == 1 and any('合并单元格' in p for p in b['problems']) and not write_calls(e), (code, b.get('problems')))
book['sheets'][0]['merges'] = []; book['sheets'][0]['grid'][0] += ['', '', '人工加的列']
json.dump(st, open(e.state, 'w'), ensure_ascii=False)
code, b = e.run('--apply', *EVID)
check('更新：旧区域比新表宽 → 退出 1（不调用高风险清空）', code == 1 and any('更宽' in p for p in b['problems']), b.get('problems'))

# ---------------------------------------------------------------- 4. 失败与未决写入
e = Env(scen={'create_lost_response': True})
code, b = e.run('--apply', *EVID)
check('新建结果不确定（服务端已建、客户端无响应）：退出 7 uncertain_write、只调用一次 +workbook-create、留下意图文件', code == 7 and b.get('uncertain_write') and e.cmds().count('sheets +workbook-create') == 1
      and os.path.exists(e.path('out/sheet-export/.write-intent.json')), (code, b.get('message'), e.cmds()))
code, b = e.run()
check('存在未决写入：之后的 dry-run 也退出 8', code == 8 and b.get('intent'), (code, b.get('message')))
created = next(iter(e.st()['books']))
e.scen(create_lost_response=False)
code, b = e.run('--apply', '--spreadsheet-token', created, *EVID)
check('只读定位到已建表格后 --spreadsheet-token 重跑：走更新、退出 0、清掉意图文件', code == 0 and (b.get('spreadsheet') or {}).get('token') == created and not os.path.exists(e.path('out/sheet-export/.write-intent.json'))
      and len(e.st()['books']) == 1, (code, b.get('message'), b.get('problems')))
e = Env(scen={'fail_on': {'sheets +workbook-create': 'request trigger frequency limit'}})
code, b = e.run('--apply', *EVID)
check('写命令限流：不自动重试（+workbook-create 只调一次）、退出 7、rate_limited', code == 7 and e.cmds().count('sheets +workbook-create') == 1 and b.get('rate_limited'), (code, e.cmds()))
code, b = e.run('--abandon-recovery', *EVID)
check('--abandon-recovery dry-run：不退出 8，但不删意图文件', code == 0 and os.path.exists(e.path('out/sheet-export/.write-intent.json')) and b.get('recovery_abandoned'), (code, b.get('message')))
e.scen(fail_on={})
code, b = e.run('--apply', '--abandon-recovery', *EVID)
check('--apply --abandon-recovery：删除意图文件后正常新建', code == 0 and not os.path.exists(e.path('out/sheet-export/.write-intent.json')) and b.get('recovery_abandoned'), (code, b.get('message')))
e = Env(scen={'fail_once': {'drive files': 'too many requests'}})
code, b = e.run()
check('读命令限流：退避重试后成功', code == 0 and e.cmds().count('drive files') == 4, (code, e.cmds()))
e = Env(scen={'exit10_on': ['sheets +dropdown-update']})
code, b = e.run('--apply', *EVID)
check('退出码 10 透传：输出 action/risk/hint/argv，不追加 --yes，不重试', code == 10 and b.get('confirmation_required') and b.get('action') == 'sheets +dropdown-update'
      and '--yes' not in b.get('argv', []) and e.cmds().count('sheets +dropdown-update') == 1 and os.path.exists(e.path('out/sheet-export/.write-intent.json')), (code, b))
e = Env()
code, b = e.run('--layout', 'single', '--apply', *EVID)
check('single 布局 apply：模块在首列时回读按用例编号列核对，退出 0', code == 0 and not b.get('problems') and os.path.exists(e.path('out/sheet-export.json')), (code, b.get('problems'), b.get('message')))
e = Env(scen={'tamper_after_write': True})
code, b = e.run('--apply', *EVID)
intent = json.load(open(e.path('out/sheet-export/.write-intent.json'))) if os.path.exists(e.path('out/sheet-export/.write-intent.json')) else {}
check('回读与计划不一致：退出 3，保留意图（stage verify_failed、带 token），不写成功记录', code == 3 and intent.get('stage') == 'verify_failed' and intent.get('spreadsheet_token')
      and not os.path.exists(e.path('out/sheet-export.json')), (code, intent, b.get('problems')))
code, b = e.run()
check('回读不一致之后再运行：退出 8', code == 8, (code, b.get('message')))
e = Env(scen={'exit10_on': ['sheets +workbook-create']})
code, b = e.run('--apply', *EVID)
check('第一条表格写命令遇确认门：退出 10，请求未执行，删除意图文件（intent_cleared）', code == 10 and b.get('intent_cleared') and not os.path.exists(e.path('out/sheet-export/.write-intent.json')), (code, b.get('intent_cleared')))
# 落点
e = Env(folders={'': [{'name': '内部产品文档', 'token': 'fldRoot0001'}], 'fldRoot0001': [{'name': '会员积分系统v2（旧）', 'token': 'fldNear0001'}], 'fldNear0001': []})
code, b = e.run()
check('落点：只有近似名文件夹 → 退出 5 给 candidates', code == 5 and b.get('candidates'), b)
e = Env(folders={'': []})
code, b = e.run('--apply', *EVID)
check('落点：一级项目文件夹不存在且未授权 → 退出 5，不发写命令', code == 5 and not write_calls(e), (code, b.get('message')))
code, b = e.run('--apply', '--allow-new-project-folder', *EVID)
check('落点：--allow-new-project-folder 后逐层新建三层文件夹再建表', code == 0 and e.cmds().count('drive +create-folder') == 3, (code, b.get('message'), e.cmds()))
e = Env()
code, b = e.run('--profile', 'account2')
check('account2：设 LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-account2', code == 0 and all(c['config_dir'] == os.path.expanduser('~/.lark-cli-account2') for c in e.calls()), [c['config_dir'] for c in e.calls()][:1])

# ---------------------------------------------------------------- 5. 真实 lark-cli：只跑 --help 核对 flag
USED = {('sheets', '+workbook-create'): ['--as', '--title', '--folder-token', '--sheets', '--styles', '--format'],
        ('sheets', '+workbook-info'): ['--as', '--spreadsheet-token', '--format'],
        ('sheets', '+sheet-info'): ['--as', '--spreadsheet-token', '--sheet-id', '--include', '--format'],
        ('sheets', '+csv-get'): ['--as', '--spreadsheet-token', '--sheet-id', '--format'],
        ('sheets', '+table-put'): ['--as', '--spreadsheet-token', '--sheets', '--styles', '--format'],
        ('sheets', '+dropdown-update'): ['--as', '--spreadsheet-token', '--ranges', '--options', '--colors', '--format'],
        ('drive', '+create-folder'): ['--as', '--name', '--folder-token', '--format']}
env = {k: v for k, v in os.environ.items() if k.upper() not in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')}
nvm = sorted([os.path.join(os.path.expanduser('~/.nvm/versions/node'), d, 'bin') for d in os.listdir(os.path.expanduser('~/.nvm/versions/node'))] if os.path.isdir(os.path.expanduser('~/.nvm/versions/node')) else [],
             key=lambda x: [int(n) for n in re.findall(r'\d+', x)])
if nvm:
    env['PATH'] = nvm[-1] + os.pathsep + env.get('PATH', '')
real = shutil.which('lark-cli', path=env['PATH'])
if not real:
    (skip if '--allow-unverified-lark' in sys.argv else lambda n, w: check(n, False, w))('真实 lark-cli --help 核对 flag', '找不到 lark-cli')
else:
    bad = {}
    for (grp, cmd), flags in USED.items():
        r = subprocess.run([real, grp, cmd, '--help'], capture_output=True, text=True, env=env, timeout=60)
        text = r.stdout + r.stderr
        miss = [f for f in flags if not re.search(r'(?<![\w-])' + re.escape(f) + r'(?![\w-])', text)]
        if r.returncode != 0 or miss:
            bad[f'{grp} {cmd}'] = (r.returncode, miss)
    r = subprocess.run([real, 'drive', 'files', 'list', '--help'], capture_output=True, text=True, env=env, timeout=60)
    if '--params' not in r.stdout + r.stderr:
        bad['drive files list'] = (r.returncode, ['--params'])
    ok_risk = all('Risk: write' in subprocess.run([real, 'sheets', c, '--help'], capture_output=True, text=True, env=env, timeout=60).stdout for c in ('+workbook-create', '+table-put', '+dropdown-update'))
    check('真实 lark-cli --help：脚本用到的命令与 flag 都存在；三个 sheets 写命令风险级为 write（非 high-risk）', not bad and ok_risk, (bad, ok_risk))
src = open(SCRIPT, encoding='utf-8').read()
sys.path.insert(0, os.path.join(SK, 'doc-shared', 'scripts'))
import lark_io  # noqa: E402
check('写命令判定：不在读命令白名单即为写（共享 lark_io；sheets 写命令受写锁、不重试）',
      'lark_io.Lark(' in src and 'class Lark' not in src
      and all(lark_io.is_read(a) for a in (['drive', 'files', 'list'], ['sheets', '+workbook-info'], ['sheets', '+sheet-info'], ['sheets', '+csv-get']))
      and all(lark_io.is_write(a) for a in (['sheets', '+workbook-create'], ['sheets', '+table-put'], ['sheets', '+dropdown-update'], ['drive', '+create-folder'], ['sheets', '+cells-clear'])))
check('读命令白名单：publish 用到的读命令为读、docs +script 只有 --command parse 为读',
      all(lark_io.is_read(a) for a in (['docs', '+fetch', '--doc', 'x'], ['drive', '+list-comments'], ['docs', '+script', '--as', 'user', '--command', 'parse', '--content', '@./x']))
      and all(lark_io.is_write(a) for a in (['docs', '+create'], ['docs', '+update'], ['docs', '+script', '--command', 'run'], ['docs', '+script'])))
check('脚本不含 --yes 等确认 flag、不调用高风险命令', not re.search(r"'--yes'|\+cells-clear'|\+sheet-delete'|\+dropdown-delete'", src))

# ---------------------------------------------------------------- 6. 导出前置检查（D3 已通过且 source_manifest 一致，2026-09-15 W3-H）
e = Env(prefix='gate', d3=None)
code, b = e.run('--apply', *EVID)
check('前置检查：没有 run-state.json → --apply 退出 1，不调用 lark-cli、不写计划', code == 1 and b.get('step') == 'gate' and not e.calls() and not os.path.exists(e.path('out/sheet-export/plan.json'))
      and 'run-state.json' in b.get('message', ''), (code, b.get('message')))
code, b = e.run('--offline')
check('前置检查：没有 run-state.json → dry-run 仍退出 0，只给 warning 与 gate.ok=false', code == 0 and (b.get('gate') or {}).get('ok') is False
      and any('前置检查' in w for w in b.get('warnings', [])), (code, b.get('gate'), b.get('warnings')))
e = Env(prefix='gate', d3='pending')
code, b = e.run('--apply', *EVID)
check('前置检查：D3 pending → --apply 退出 1，不调用 lark-cli', code == 1 and 'D3' in b.get('message', '') and not e.calls(), (code, b.get('message')))
code, b = e.run()
check('前置检查：D3 pending → 在线 dry-run 退出 0，warning 提示 --apply 会拒绝', code == 0 and any('D3' in w for w in b.get('warnings', [])), (code, b.get('warnings')))
e = Env(prefix='gate')
p = e.path('data/cases.csv'); open(p, 'a', encoding='utf-8').write('\n')
code, b = e.run('--apply', *EVID)
check('前置检查：D3 签门后改了 data/cases.csv → --apply 退出 1，message 列出修改的文件，不调用 lark-cli',
      code == 1 and 'data/cases.csv' in b.get('message', '') and not e.calls(), (code, b.get('message')))
e.sign()
code, b = e.run('--offline')
check('前置检查：重过 D3（刷新 manifest）后 gate.ok=true、无前置 warning', code == 0 and (b.get('gate') or {}).get('ok') is True and not any('前置检查' in w for w in b.get('warnings', [])), (code, b.get('gate')))
e = Env(prefix='gate')
ext = os.path.join(e.dir, 'rs-outside.json'); shutil.move(e.path('run-state.json'), ext); os.symlink(ext, e.path('run-state.json'))
code, b = e.run('--apply', *EVID)
check('前置检查：run-state.json 是符号链接 → --apply 退出 1', code == 1 and '符号链接' in b.get('message', ''), (code, b.get('message')))

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}" + (f'（SKIP {len(skips)}）' if skips else '') + f'（临时目录：{BASE}）')
if '--keep' not in sys.argv and not fails:
    shutil.rmtree(BASE, ignore_errors=True)
sys.exit(1 if fails else 0)
