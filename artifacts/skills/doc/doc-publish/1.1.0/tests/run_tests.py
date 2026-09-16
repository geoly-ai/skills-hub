#!/usr/bin/env python3
"""doc-publish 自测。不写真实飞书：lark-cli 一律用 PATH 注入的假服务端（严格校验 argv、按文档响应形状返回、服务端保存并转换文档内容）；
golden 段只允许读命令透传到真实 lark-cli。只写系统临时目录与 ~/.cache/doc-publish/lark-write.lock（引擎的全局写锁），
不改 doc-shared、presales-*、golden 下任何文件。
用法：run_tests.py [--keep] [--fast] [--no-real-lark] [--allow-missing-golden] [--allow-unverified-lark]
  --fast                  跳过 golden（显式跳过，汇总里列出）
  --allow-missing-golden  golden 输入缺失时记 SKIP 而不是 FAIL
  --allow-unverified-lark 真实 lark-cli 读命令或 --help 核对失败时记 SKIP 而不是 FAIL
覆盖（按验收 8 项）：钩子沙箱（调用 lark-cli、改运行目录、环境变量、dry-run 同样适用）、类型包可信目录与 schema；写命令不自动重试、
结果不确定退出 7 并留新建意图；token 必须与 path 解析一致；恢复记录与正式归档参与同版本比较、--create 与 --abandon-recovery；
跨运行目录全局写锁；source_manifest 新鲜度与严格修改时间退回、lark_folder 字段级例外；XML 解析器守卫；
服务端已写入但客户端失败的状态机；假服务端参数违规计 FAIL；以及原有 dry-run、哈希、D3、create/overwrite、评论、退出码 10、代理、账号、
文件夹、归档、schema、回查、锁、业务词守卫与 golden smoke-site dry-run。"""
import copy, glob, hashlib, json, os, re, shutil, subprocess, sys, tarfile, tempfile, time

H = os.path.dirname(os.path.abspath(__file__))
DP = os.path.dirname(H)
SK = os.path.dirname(DP)
DS = os.path.join(SK, 'doc-shared')
PUB = os.path.join(DP, 'scripts', 'publish.py')
RS = os.path.join(DS, 'scripts', 'run_state.py')
G = os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/golden')
PY = sys.executable
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(DS, 'scripts'))
import validate  # noqa: E402
import docmark_parse as dp  # noqa: E402

fails, skips, critical_skips = [], [], []
BASE = tempfile.mkdtemp(prefix='doc-publish-tests-')
PACKS = os.path.join(BASE, 'packs')
os.makedirs(PACKS)
FAST = '--fast' in sys.argv
SCHEMA = json.load(open(os.path.join(DS, 'schemas', 'published.schema.json')))
_seq = [0]


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:700]}]' if detail and not cond else ''))
    if not cond: fails.append(name)


def skip(name, why, allowed=False):
    """allowed=True 只给已拍板的例外（--allow-missing-golden）；其他 SKIP 都让整次自测以退出码 2「未完成」结束，不算通过。"""
    print(f'SKIP {name}（{why}）' + ('' if allowed else '【关键契约未验证，自测不算通过】')); skips.append(name)
    if not allowed: critical_skips.append(name)


def jout(s):
    try: return json.loads(s)
    except Exception: return {}


def schema_errors(rec):
    return validate.check(rec, SCHEMA, SCHEMA)


# ---------------------------------------------------------------- 假飞书服务端（lark-cli）

FAKE = r'''#!__PY__
import json, os, re, sys, time
t0 = time.time()
argv = sys.argv[1:]
scen = json.load(open(os.environ['FAKE_LARK_SCENARIO']))
state_path = os.environ['FAKE_LARK_STATE']
state = json.load(open(state_path)) if os.path.exists(state_path) else {'folders': scen.get('folders', {}), 'seq': 0, 'doc_seq': 0, 'docs': scen.get('docs', {}), 'fail_once_done': []}
env = os.environ
log = {'argv': argv, 'cwd': os.getcwd(), 'proxies': {k: v for k, v in env.items() if k.upper() in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')},
       'config_dir': env.get('LARKSUITE_CLI_CONFIG_DIR'), 't': t0}
open(env['FAKE_LARK_LOG'], 'a').write(json.dumps(log, ensure_ascii=False) + '\n')
def save(): json.dump(state, open(state_path, 'w'), ensure_ascii=False)
def out(obj, code=0, err=False):
    s = json.dumps(obj, ensure_ascii=False)
    (sys.stderr if err else sys.stdout).write(s + '\n'); save(); sys.exit(code)
def violation(msg):
    open(env['FAKE_LARK_VIOLATIONS'], 'a').write(json.dumps({'argv': argv, 'message': msg}, ensure_ascii=False) + '\n')
    out({'ok': False, 'error': {'type': 'validation', 'subtype': 'invalid_argument', 'message': msg}}, 2, err=True)

TOKEN = r'^[A-Za-z0-9]{8,}$'
SPEC = {
    ('docs', '+script'): {'req': {'--as': 'user', '--command': 'parse', '--content': '@file', '--format': 'json'}, 'opt': {}},
    ('drive', 'files', 'list'): {'req': {'--as': 'user', '--params': 'params', '--format': 'json'}, 'opt': {}},
    ('drive', '+create-folder'): {'req': {'--as': 'user', '--name': 'any', '--format': 'json'}, 'opt': {'--folder-token': 'token'}},
    ('docs', '+create'): {'req': {'--as': 'user', '--doc-format': 'xml', '--content': '@file', '--parent-token': 'token', '--format': 'json'}, 'opt': {}},
    ('docs', '+update'): {'req': {'--as': 'user', '--doc': 'token', '--command': 'overwrite', '--doc-format': 'xml', '--content': '@file', '--format': 'json'}, 'opt': {}},
    ('drive', '+list-comments'): {'req': {'--as': 'user', '--token': 'token', '--type': 'docx', '--solved-status': 'all', '--format': 'json'}, 'opt': {'--page-token': 'any'}},
    ('docs', '+fetch'): {'req': {'--as': 'user', '--doc': 'token', '--format': 'json'}, 'opt': {}},
}
cmd = tuple(argv[:3]) if tuple(argv[:3]) in SPEC else tuple(argv[:2])
if cmd not in SPEC:
    violation('fake: 不认识的命令 ' + ' '.join(argv[:3]))
spec = SPEC[cmd]
rest = argv[len(cmd):]
if len(rest) % 2:
    violation('fake: 参数不是成对的 flag 值：' + ' '.join(rest))
opts = {}
for i in range(0, len(rest), 2):
    k, v = rest[i], rest[i + 1]
    if k not in spec['req'] and k not in spec['opt']:
        violation(f'fake: {" ".join(cmd)} 不接受 {k}')
    if k in opts:
        violation(f'fake: 重复 {k}')
    kind = spec['req'].get(k) or spec['opt'].get(k)
    if kind == '@file':
        if not v.startswith('@./') or not os.path.isfile(os.path.join(os.getcwd(), v[3:])):
            violation(f'fake: {k} 必须是 @./ 开头且相对 cwd 存在的文件：{v}')
    elif kind == 'token':
        if not re.match(TOKEN, v): violation(f'fake: {k} token 格式不对：{v}')
    elif kind == 'params':
        try:
            p = json.loads(v)
        except ValueError:
            violation(f'fake: --params 不是 JSON：{v}')
        if not isinstance(p.get('folder_token'), str) or not isinstance(p.get('page_size'), int) or set(p) - {'folder_token', 'page_size', 'page_token'}:
            violation(f'fake: --params 字段不对：{v}')
    elif kind == 'any':
        if not v: violation(f'fake: {k} 为空')
    elif v != kind:
        violation(f'fake: {k} 必须是 {kind}，实际 {v}')
    opts[k] = v
missing = [k for k in spec['req'] if k not in opts]
if missing:
    violation(f'fake: {" ".join(cmd)} 缺少 {missing}')
if rest[-2:] != ['--format', 'json']:
    violation('fake: --format json 必须在最后')
key = ' '.join(cmd[:2])

def convert(xml):
    """模拟服务端转换：本地资源换成服务端 token，块加 id；可按场景丢画板、加斜体。"""
    n = [0]
    def tok(prefix):
        n[0] += 1; return f'{prefix}{n[0]:08d}'
    x = re.sub(r"<whiteboard\b[^>]*?\bpath=(['\"])[^'\"]*\1[^>]*>\s*</whiteboard>", lambda m: f'<whiteboard token="{tok("wbSrv")}" type="blank"></whiteboard>', xml)
    x = re.sub(r"<img\b[^>]*?\bpath=(['\"])[^'\"]*\1[^>]*/>", lambda m: f'<img token="{tok("imgSrv")}"/>', x)
    x = re.sub(r'<p>', lambda m: f'<p id="{tok("blk")}">', x)
    if scen.get('server_drop_whiteboards'):
        x = re.sub(r'<whiteboard[^>]*></whiteboard>', '', x)
    if scen.get('server_italic'):
        x = x.replace('<p id=', '<p data-x="1" id=', 1).replace('正文一段。', '<i>正文一段。</i>', 1)
    return x

if key in scen.get('exit10_stdout_noise_on', []):
    sys.stdout.write(json.dumps({'ok': False, 'data': {'note': 'noise'}}) + '\n')
    out({'ok': False, 'error': {'type': 'confirmation', 'subtype': 'confirmation_required', 'message': key + ' requires confirmation',
         'hint': 'add --yes to confirm', 'risk': 'high-risk-write', 'action': key}}, 10, err=True)
if key in scen.get('exit10_on', []):
    out({'ok': False, 'error': {'type': 'confirmation', 'subtype': 'confirmation_required', 'message': key + ' requires confirmation',
         'hint': 'add --yes to confirm', 'risk': 'high-risk-write', 'action': key}}, 10, err=True)
fo = scen.get('fail_once', {})
if key in fo and key not in state['fail_once_done']:
    state['fail_once_done'].append(key)
    out({'ok': False, 'error': {'type': 'api', 'message': fo[key]}}, 1, err=True)
if key in scen.get('fail_on', {}):
    out({'ok': False, 'error': {'type': 'api', 'message': scen['fail_on'][key]}}, 1, err=True)
if key in scen.get('raw_exit10_on', []):
    sys.stderr.write('some unrelated failure'); save(); sys.exit(10)
if key == 'docs +script':
    out({'ok': True, 'data': {'assessment': {'status': scen.get('parse_status', 'passed')}, 'diagnostics': []}})
if key == 'drive files':
    params = json.loads(opts['--params'])
    tok = params['folder_token']
    if tok not in state['folders']:
        out({'ok': False, 'error': {'type': 'api', 'message': 'folder not found'}}, 1, err=True)
    files = [{'name': f['name'], 'token': f['token'], 'type': 'folder', 'url': 'https://x/drive/folder/' + f['token']} for f in state['folders'][tok]]
    for did, doc in sorted(state['docs'].items()):
        if doc.get('parent') == tok:
            m = re.search(r'<title>(.*?)</title>', doc.get('content', ''), re.S)
            files.append({'name': m.group(1).strip() if m else '', 'token': did, 'type': 'docx', 'url': 'https://x.feishu.cn/docx/' + did})
    if scen.get('broken_paging'):
        out({'ok': True, 'data': {'files': files[:1], 'has_more': True}})
    ps = scen.get('page_size')
    if ps:
        start = int(params.get('page_token') or 0)
        more = start + ps < len(files)
        out({'ok': True, 'data': {'files': files[start:start + ps], 'has_more': more, 'next_page_token': str(start + ps) if more else ''}})
    out({'ok': True, 'data': {'files': files, 'has_more': False}})
if key == 'drive +create-folder':
    parent = opts.get('--folder-token', '')
    if parent not in state['folders']:
        out({'ok': False, 'error': {'type': 'api', 'message': 'parent folder not found'}}, 1, err=True)
    state['seq'] += 1
    tok = 'fldNew%04d' % state['seq']
    state['folders'][parent].append({'name': opts['--name'], 'token': tok})
    state['folders'][tok] = []
    if scen.get('create_folder_created_but_rate_limited'):
        out({'ok': False, 'error': {'type': 'api', 'message': 'request trigger frequency limit'}}, 1, err=True)
    if scen.get('create_folder_lost_response'):
        save(); sys.exit(1)
    out({'ok': True, 'data': {'folder_token': tok, 'name': opts['--name'], 'parent_folder_token': parent}})
if key == 'docs +create':
    parent = opts['--parent-token']
    if parent not in state['folders']:
        out({'ok': False, 'error': {'type': 'api', 'message': 'parent folder not found'}}, 1, err=True)
    state['doc_seq'] += 1
    doc_id = 'doxNew%08d' % state['doc_seq']
    state['docs'][doc_id] = {'parent': parent, 'content': convert(open(os.path.join(os.getcwd(), opts['--content'][3:]), encoding='utf-8').read())}
    if scen.get('create_server_ok_client_fail'):
        save(); sys.exit(1)          # 服务端已写入，客户端没有拿到任何响应
    if scen.get('create_missing_id'):
        out({'ok': True, 'data': {'document': {'url': 'https://x.feishu.cn/docx/' + doc_id}}})
    out({'ok': True, 'data': {'document': {'document_id': doc_id, 'url': 'https://x.feishu.cn/docx/' + doc_id}}})
if key == 'docs +update':
    d = opts['--doc']
    if d not in state['docs']:
        out({'ok': False, 'error': {'type': 'api', 'message': 'document not found'}}, 1, err=True)
    state['docs'][d]['content'] = convert(open(os.path.join(os.getcwd(), opts['--content'][3:]), encoding='utf-8').read())
    out({'ok': True, 'data': {'result': scen.get('update_result', 'success'), 'warnings': []}})
if key == 'drive +list-comments':
    if scen.get('comments_paging_endless'):
        tok = int(opts.get('--page-token') or 0) + 1
        out({'ok': True, 'data': {'items': [], 'has_more': True, 'page_token': str(tok)}})
    n = scen.get('comments', 0)
    out({'ok': True, 'data': {'items': [{'comment_id': str(i)} for i in range(n)], 'has_more': False}})
if key == 'docs +fetch':
    d = opts['--doc']
    if d not in state['docs']:
        out({'ok': False, 'error': {'type': 'api', 'message': 'document not found'}}, 1, err=True)
    out({'ok': True, 'data': {'document': {'document_id': d, 'revision_id': 3, 'content': state['docs'][d]['content']}}})
violation('fake: 未处理的命令 ' + key)
'''


def make_fake_bin():
    d = os.path.join(BASE, 'fakebin')
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, 'lark-cli')
    open(p, 'w').write(FAKE.replace('__PY__', PY))
    os.chmod(p, 0o755)
    return d


FAKE_BIN = make_fake_bin()
VIOLATIONS = os.path.join(BASE, 'fake-violations.jsonl')
ROOT_TREE = {'': [{'name': '自测客户', 'token': 'fldClient0000001'}], 'fldClient0000001': [{'name': '自测项目', 'token': 'fldProj00000001'}], 'fldProj00000001': []}
EXPECTED_VIOLATIONS = []  # 用例里故意触发的违规（目前没有）


def lark_env(scenario, extra_env=None):
    _seq[0] += 1
    d = os.path.join(BASE, 'lark', f's{_seq[0]}')
    os.makedirs(d)
    scenario = dict(scenario)
    scenario.setdefault('folders', copy.deepcopy(ROOT_TREE))
    sp = os.path.join(d, 'scenario.json'); json.dump(scenario, open(sp, 'w'), ensure_ascii=False)
    env = dict(os.environ, PATH=FAKE_BIN + os.pathsep + os.environ.get('PATH', ''), FAKE_LARK_SCENARIO=sp,
               FAKE_LARK_STATE=os.path.join(d, 'state.json'), FAKE_LARK_LOG=os.path.join(d, 'calls.jsonl'),
               FAKE_LARK_VIOLATIONS=VIOLATIONS, DOC_TYPES_DIRS=PACKS)
    env.update(extra_env or {})
    return env


def calls(env):
    p = env['FAKE_LARK_LOG']
    return [json.loads(x) for x in open(p)] if os.path.exists(p) else []


def keys(env):
    return [' '.join(c['argv'][:2]) for c in calls(env)]


def server(env):
    p = env['FAKE_LARK_STATE']
    return json.load(open(p)) if os.path.exists(p) else {}


WRITES = {'docs +create', 'docs +update', 'drive +create-folder'}


# ---------------------------------------------------------------- 夹具

DOC_MD = '# 自测文档\n\n## 背景\n\n正文一段。\n\n## 方案\n\n第二段。\n'
XML = '<title>自测文档</title><h1 seq="auto">背景</h1><p>正文一段。</p><h1 seq="auto">方案</h1><p>第二段。</p><whiteboard type="svg" path="@./figures/a.svg"></whiteboard>'


def make_pack(hooks=None, features=None, filename=None, meta_file=None, root=PACKS, mut=None):
    _seq[0] += 1
    d = os.path.join(root, f'p{_seq[0]}')
    shutil.copytree(os.path.join(DS, 'types', '_template'), d)
    p = json.load(open(os.path.join(d, 'pack.json')))
    p.update({'id': 'tpub', 'name': '自测包', 'status': 'draft', 'inputs': []})
    if hooks: p['hooks'].update(hooks)
    if features: p['features'].update(features)
    if filename: p['filename'] = filename
    if meta_file: p['meta_file'] = meta_file
    if mut: mut(p)
    json.dump(p, open(os.path.join(d, 'pack.json'), 'w'), ensure_ascii=False, indent=2)
    return d


def rs(run_dir, *args, pack=None):
    cmd = [PY, RS, run_dir] + list(args) + (['--pack', pack] if pack else [])
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, (args, r.stdout, r.stderr)


QA_REPORT = """# 质检报告

## 人工检查

Codex 找茬：自测夹具，无真实轮次。
Codex 证伪：自测夹具，无真实轮次。
"""


def strip_manifest(run_dir):
    """模拟旧 run-state：去掉 gates.D3.source_manifest（引擎退回严格修改时间比较）。"""
    p = os.path.join(run_dir, 'run-state.json')
    st = json.load(open(p))
    st['gates']['D3'].pop('source_manifest', None)
    json.dump(st, open(p, 'w'), ensure_ascii=False, indent=2)


def make_run(pack=None, meta_over=None, d3='passed', xml=XML, render_over=None, qa_over=None, docx=False, meta_name='doc.json', legacy=False):
    pack = pack or make_pack()
    _seq[0] += 1
    d = os.path.join(BASE, 'runs', f'r{_seq[0]}')
    os.makedirs(os.path.join(d, 'out')); os.makedirs(os.path.join(d, 'figures'))
    open(os.path.join(d, 'doc.md'), 'w').write(DOC_MD)
    open(os.path.join(d, 'figures', 'a.svg'), 'w').write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')
    meta = {'type': 'tpub', 'title': '自测文档', 'project': 'selftest', 'version': '1.0', 'date': '2026-09-15', 'status': 'approved',
            'audience': 'internal', 'brand': 'internal', 'language': 'zh-CN', 'owner': '自测',
            'lark_folder': {'token': 'fldProj00000001', 'path': '自测客户/自测项目'}}
    meta.update(meta_over or {})
    json.dump(meta, open(os.path.join(d, meta_name), 'w'), ensure_ascii=False, indent=2)
    open(os.path.join(d, 'outline.md'), 'w').write('# 骨架\n\n① 章节结构\n   A 按类型包骨架\n')
    rs(d, 'init', '--type', 'tpub', '--mode', 'new', pack=pack)
    rs(d, 'pass-gate', '--gate', 'D0', pack=pack)
    rs(d, 'decide', '--key', '①', '--value', 'A 按类型包骨架', pack=pack)
    rs(d, 'pass-gate', '--gate', 'D1', '--evidence', '自测：①A', pack=pack)
    rs(d, 'skip-gate', '--gate', 'D2', '--reason', '类型包无 D2', pack=pack)
    pj = json.load(open(os.path.join(pack, 'pack.json')))
    doc = dp.parse_file(d, 'doc.md', pack=pj)
    sha = hashlib.sha256(doc.text.encode('utf-8')).hexdigest()
    time.sleep(0.02)  # 产物晚于源文件（严格修改时间比较不留容差）
    pdf_name = 'selftest_自测包_自测文档_v1.0_20260915.pdf'
    open(os.path.join(d, 'out', pdf_name), 'wb').write(b'%PDF-1.4 selftest\n')
    if docx: open(os.path.join(d, 'out', pdf_name[:-4] + '.docx'), 'wb').write(b'PK selftest docx')
    open(os.path.join(d, 'out', 'feishu.xml'), 'w').write(xml)
    qa = {'schema_version': '1', 'generated_at': '2026-09-15T10:00:00+08:00', 'source_sha256': sha, 'must_fix': 0, 'total': 0, 'issues': []}
    qa.update(qa_over or {})
    json.dump(qa, open(os.path.join(d, 'qa-result.json'), 'w'), ensure_ascii=False)
    open(os.path.join(d, 'qa-report.md'), 'w').write(QA_REPORT)
    render = {'schema_version': '1', 'generated_at': '2026-09-15T10:00:00+08:00', 'source_sha256': sha, 'renderer': {'name': 'doc-render', 'version': '1.0'},
              'profile': 'internal', 'pdf': {'path': f'out/{pdf_name}', 'pages': 1, 'bookmarks': 0}, 'toc': [], 'figures': [], 'tables': [],
              'layout_issues': [], 'feishu': {'path': 'out/feishu.xml', 'whiteboards': xml.count('<whiteboard'), 'images': 0, 'code_blocks': xml.count('<pre')}}
    render.update(render_over or {})
    json.dump(render, open(os.path.join(d, 'out', 'render.json'), 'w'), ensure_ascii=False)
    if d3 == 'passed':
        rs(d, 'pass-gate', '--gate', 'D3', '--evidence', '自测：Codex 两轮见 qa-report.md', pack=pack)
    elif d3 == 'waived':
        rs(d, 'waive-gate', '--gate', 'D3', '--reason', '自测豁免', '--by', '自测用户', pack=pack)
    if legacy:
        strip_manifest(d)
    return d, pack


def publish(run_dir, pack, env, *args):
    r = subprocess.run([PY, PUB, run_dir, '--pack', pack] + list(args), capture_output=True, text=True, env=env, timeout=300)
    return r.returncode, jout(r.stdout), r.stdout + r.stderr


def state(run_dir):
    return json.load(open(os.path.join(run_dir, 'run-state.json')))


def dry_rec(d):
    p = os.path.join(d, 'out', 'published', 'v1.0.dry-run', 'published.json')
    return json.load(open(p)) if os.path.isfile(p) else {}


def opt(argv, name):
    return argv[argv.index(name) + 1] if name in argv else None


# ---------------------------------------------------------------- 基础流程

def t_dry_run():
    d, p = make_run()
    before_state = open(os.path.join(d, 'run-state.json'), 'rb').read()
    before_meta = open(os.path.join(d, 'doc.json'), 'rb').read()
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('dry-run：退出码 0', code == 0, raw)
    ks = keys(env)
    check('dry-run：不调用任何写命令', not (set(ks) & WRITES), ks)
    check('dry-run：parse + 从根目录逐层列文件夹（根、客户两层）', ks == ['docs +script', 'drive files', 'drive files'], ks)
    check('dry-run：run-state.json 与 doc.json 不变', open(os.path.join(d, 'run-state.json'), 'rb').read() == before_state and open(os.path.join(d, 'doc.json'), 'rb').read() == before_meta)
    check('dry-run：归档到 .dry-run 目录，不写正式归档与根 published.json', os.path.isfile(os.path.join(d, 'out', 'published', 'v1.0.dry-run', 'published.json'))
          and not os.path.exists(os.path.join(d, 'out', 'published', 'v1.0')) and not os.path.exists(os.path.join(d, 'published.json')))
    rec = dry_rec(d)
    check('dry-run：published.json 过 schema 且 dry_run 为真', not schema_errors(rec) and rec.get('dry_run') is True, schema_errors(rec))
    check('dry-run：计划里有 docs +create 与目标文件夹 token', any(w[:2] == ['docs', '+create'] and 'fldProj00000001' in w for w in rec.get('plan', {}).get('writes', [])), rec.get('plan'))
    check('dry-run：D3 签门写了 source_manifest，freshness_check=manifest', rec.get('freshness_check') == 'manifest', rec.get('freshness_check'))
    d2, p2 = make_run(legacy=True)
    code, o, raw = publish(d2, p2, lark_env({}))
    r2 = dry_rec(d2)
    check('dry-run：旧 run-state 无 source_manifest 时 freshness_check=mtime 且有警告', code == 0 and r2.get('freshness_check') == 'mtime' and any('source_manifest' in w for w in r2.get('warnings', [])), raw)
    env2 = lark_env({})
    code, o, raw = publish(d, p, env2, '--offline')
    check('--offline：退出码 0 且不调用 lark-cli', code == 0 and calls(env2) == [], raw)


def t_hash():
    d, p = make_run()
    doc = os.path.join(d, 'doc.md'); open(doc, 'a').write('\n质检之后追加的一段。\n')
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('哈希：正文改动后拒绝（退出码 1）', code == 1 and 'source_sha256' in raw, raw)
    check('哈希：拒绝时不调用 lark-cli', calls(env) == [])
    d, p = make_run()
    rj = os.path.join(d, 'out', 'render.json'); r = json.load(open(rj)); r.pop('source_sha256'); json.dump(r, open(rj, 'w'))
    code, o, raw = publish(d, p, lark_env({}))
    check('哈希：render.json 缺 source_sha256 拒绝', code == 1 and '没有 source_sha256' in raw, raw)
    d, p = make_run(qa_over={'source_sha256': '0' * 64})
    code, o, raw = publish(d, p, lark_env({}))
    check('哈希：qa-result.json 与正文不一致拒绝', code == 1 and 'qa-result.json 的 source_sha256' in raw, raw)


def t_d3():
    d, p = make_run(d3='pending')
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('D3 未过：拒绝（退出码 1，step D3）', code == 1 and o.get('step') == 'D3', raw)
    check('D3 未过：不调用 lark-cli', calls(env) == [])
    d, p = make_run(d3='passed')
    rs(d, 'fail-gate', '--gate', 'D3', '--reason', '自测失败', pack=p)
    code, o, raw = publish(d, p, lark_env({}))
    check('D3 failed：拒绝', code == 1 and o.get('step') == 'D3', raw)
    d, p = make_run(d3='waived', qa_over={'must_fix': 1, 'total': 1, 'issues': [{'rule': 'R1', 'severity': '必改', 'line': 1, 'excerpt': 'x', 'message': 'x'}]})
    code, o, raw = publish(d, p, lark_env({}))
    check('D3 waived：放行并记警告', code == 0 and any('waived' in w for w in o.get('warnings', [])), raw)


def t_create_apply():
    d, p = make_run(docx=True)
    env = lark_env({}, {'HTTP_PROXY': 'http://127.0.0.1:7890', 'https_proxy': 'http://127.0.0.1:7890', 'ALL_PROXY': 'socks5://127.0.0.1:7890'})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户：PDF 看过了，发 account1，放自测项目文件夹')
    check('create：退出码 0', code == 0, raw)
    ks = keys(env)
    check('create：调用顺序 parse → 逐层列文件夹 → +create → +fetch', ks == ['docs +script', 'drive files', 'drive files', 'docs +create', 'docs +fetch'], ks)
    cr = [c for c in calls(env) if c['argv'][:2] == ['docs', '+create']]
    check('create：完整 argv（--as user、xml、@./out/feishu.xml、--parent-token 末级 token、--format json 在最后），cwd 为运行目录',
          cr and cr[0]['argv'] == ['docs', '+create', '--as', 'user', '--doc-format', 'xml', '--content', '@./out/feishu.xml', '--parent-token', 'fldProj00000001', '--format', 'json']
          and os.path.realpath(cr[0]['cwd']) == os.path.realpath(d), cr)
    check('代理变量：每次 lark-cli 调用的环境里 HTTP_PROXY、https_proxy、ALL_PROXY 都已清除', calls(env) and all(not c['proxies'] for c in calls(env)), [c['proxies'] for c in calls(env)])
    check('create：不追加 --yes', not any('--yes' in c['argv'] for c in calls(env)))
    srv = server(env)
    check('create：服务端恰好一份文档，建在自测项目文件夹', list(srv.get('docs', {})) == ['doxNew00000001'] and srv['docs']['doxNew00000001']['parent'] == 'fldProj00000001', srv.get('docs'))
    root = os.path.join(d, 'published.json'); arch = os.path.join(d, 'out', 'published', 'v1.0', 'published.json')
    rec = json.load(open(root)) if os.path.isfile(root) else {}
    check('published.json：根目录与归档各一份、内容一致、过 schema', os.path.isfile(arch) and json.load(open(arch)) == rec and not schema_errors(rec), schema_errors(rec))
    check('published.json：mode create、doc id、回查按服务端转换后的内容通过（画板 token 形式也计数）',
          rec.get('mode') == 'create' and rec.get('lark_doc_id') == 'doxNew00000001' and rec.get('problems') == [] and rec.get('verify', {}).get('whiteboards') == 1, rec)
    names = sorted(os.listdir(os.path.join(d, 'out', 'published', 'v1.0')))
    want = sorted(['selftest_自测包_自测文档_v1.0_20260915.pdf', 'selftest_自测包_自测文档_v1.0_20260915.docx', 'feishu.xml', 'render.json', 'qa-result.json', 'qa-report.md', 'published.json', 'figures'])
    check('归档命名：PDF 与 docx 按类型包 filename 模板、其余原名', names == want, names)
    ok_hash = all(hashlib.sha256(open(os.path.join(d, x['path']), 'rb').read()).hexdigest() == x['sha256'] == hashlib.sha256(open(os.path.join(d, x['source']), 'rb').read()).hexdigest() for x in rec.get('archive', []))
    check('归档：每个文件 sha256 与源文件一致（含 figures/a.svg 资源）', ok_hash and len(rec.get('archive', [])) == 7 and any(x['role'] == 'resource' for x in rec.get('archive', [])), rec.get('archive'))
    check('归档：apply 成功后不留暂存目录与新建意图', not os.path.exists(os.path.join(d, 'out', 'published', '.staging-v1.0')) and not os.path.exists(os.path.join(d, 'out', 'published', '.create-intent.json')))
    st = state(d)
    check('run-state：D4 passed、证据为用户原话、stage publish', st['gates']['D4']['status'] == 'passed' and '放自测项目文件夹' in st['gates']['D4']['evidence'][0] and st['stage'] == 'publish', st['gates']['D4'])
    # 第二次 apply：从 published.json 推断 overwrite（同一假服务端）
    env2 = dict(env, FAKE_LARK_LOG=env['FAKE_LARK_LOG'] + '.2')
    code, o, raw = publish(d, p, env2, '--apply', '--evidence', '用户：再发一次，覆盖原文档')
    ks = keys(env2)
    check('overwrite（published.json 推断）：先查评论再 +update overwrite，不新建', code == 0 and ks.count('drive +list-comments') == 1 and 'docs +update' in ks and 'docs +create' not in ks
          and ks.index('drive +list-comments') < ks.index('docs +update'), (ks, raw))
    check('overwrite：服务端仍只有一份文档', list(server(env2).get('docs', {})) == ['doxNew00000001'])
    rec = json.load(open(root))
    check('overwrite：published.json mode overwrite 且过 schema', rec.get('mode') == 'overwrite' and not schema_errors(rec), rec.get('mode'))


def t_overwrite_token():
    docs = {'doxOld00000009': {'parent': 'fldProj00000001', 'content': '<title>旧</title><p>旧</p>'}}
    d, p = make_run()
    env = lark_env({'docs': docs, 'comments': 0})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认覆盖', '--doc-token', 'doxOld00000009')
    ks = keys(env)
    check('overwrite（--doc-token）：退出码 0、+update、不 +create', code == 0 and 'docs +update' in ks and 'docs +create' not in ks, (ks, raw))
    d, p = make_run()
    env = lark_env({'docs': docs, 'comments': 2})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认覆盖', '--doc-token', 'doxOld00000009')
    check('overwrite 有评论：退出码 6、不写', code == 6 and not (set(keys(env)) & WRITES) and o.get('comments') == 2, (keys(env), raw))
    check('overwrite 有评论：D4 未写', state(d)['gates']['D4']['status'] == 'pending')
    env = lark_env({'docs': docs, 'comments': 2})
    code, o, raw = publish(d, p, env, '--doc-token', 'doxOld00000009')
    check('overwrite dry-run 也查评论（只读）', code == 6 and keys(env).count('drive +list-comments') == 1, raw)
    d, p = make_run()
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认', '--create')
    check('--create 强制新建', code == 0 and 'docs +create' in keys(env), raw)
    d, p = make_run()
    env = lark_env({'docs': docs, 'update_result': 'partial_success'})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认', '--doc-token', 'doxOld00000009')
    check('overwrite partial_success：退出码 3、problems 记录', code == 3 and any('partial_success' in x for x in o.get('problems', [])), raw)


def t_exit10():
    d, p = make_run()
    env = lark_env({'exit10_on': ['docs +create']})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认发布')
    check('退出码 10：透传', code == 10, raw)
    check('退出码 10：输出 confirmation_required、action、hint、原 argv', o.get('confirmation_required') is True and o.get('action') == 'docs +create' and o.get('hint') and o.get('argv', [])[:3] == ['lark-cli', 'docs', '+create'], o)
    ks = keys(env)
    check('退出码 10：只调用一次 +create，不追加 --yes 重试，不回查', ks.count('docs +create') == 1 and 'docs +fetch' not in ks and not any('--yes' in c['argv'] for c in calls(env)), ks)
    check('退出码 10（确认 envelope）：删除刚写的新建意图并在输出标明', not os.path.lexists(os.path.join(d, 'out', 'published', '.create-intent.json')) and o.get('intent_cleared') is True, o)
    check('退出码 10：不写根 published.json、不留正式归档与暂存目录', not os.path.exists(os.path.join(d, 'published.json')) and not os.path.exists(os.path.join(d, 'out', 'published', 'v1.0')) and not os.path.exists(os.path.join(d, 'out', 'published', '.staging-v1.0')))
    d, p = make_run()
    env = lark_env({'raw_exit10_on': ['docs +create']})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认发布')
    check('退出码 10 但没有确认 envelope：按调用失败（7），不当确认门', code == 7 and not o.get('confirmation_required'), raw)
    check('退出码 10 但没有确认 envelope：新建意图保留', os.path.isfile(os.path.join(d, 'out', 'published', '.create-intent.json')) and not o.get('intent_cleared'))
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': '待建', 'path': '自测客户/新子项目'}})
    env = lark_env({'exit10_on': ['drive +create-folder']})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认发布')
    check('退出码 10（建文件夹时）：透传且不继续建文档', code == 10 and 'docs +create' not in keys(env), (keys(env), raw))
    d, p = make_run()
    env = lark_env({'exit10_stdout_noise_on': ['docs +create']})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('exit 10 stdout 有噪声 JSON：仍识别 stderr 确认 envelope', code == 10 and o.get('action') == 'docs +create', raw)


def t_account2():
    d, p = make_run(meta_over={'lark_profile': 'account2'})
    env = lark_env({}, {'LARKSUITE_CLI_CONFIG_DIR': '/should/be/replaced'})
    code, o, raw = publish(d, p, env)
    check('account2：LARKSUITE_CLI_CONFIG_DIR 指向 ~/.lark-cli-account2', code == 0 and all((c['config_dir'] or '').endswith('.lark-cli-account2') for c in calls(env)), [c['config_dir'] for c in calls(env)])
    env = lark_env({}, {'LARKSUITE_CLI_CONFIG_DIR': '/should/be/removed'})
    code, o, raw = publish(d, p, env, '--profile', 'account1')
    check('account1：清掉 LARKSUITE_CLI_CONFIG_DIR', code == 0 and all(c['config_dir'] is None for c in calls(env)), [c['config_dir'] for c in calls(env)])
    code, o, raw = publish(d, p, lark_env({}), '--profile', 'account9')
    check('非法账号：退出码 2', code == 2, raw)


def t_folders():
    pend = {'lark_folder': {'pending_reason': '发布时建', 'path': '自测客户/新子项目'}}
    tree = {'': [{'name': '自测客户', 'token': 'fldClient0000001'}, {'name': '其他客户', 'token': 'fldOther00000001'}], 'fldClient0000001': [], 'fldOther00000001': []}
    d, p = make_run(meta_over=pend)
    env = lark_env({'folders': tree})
    code, o, raw = publish(d, p, env)
    rec = dry_rec(d)
    check('文件夹缺失 dry-run：计划里的建文件夹命令带父 token', any(w[:2] == ['drive', '+create-folder'] and w[-2:] == ['--folder-token', 'fldClient0000001'] for w in rec.get('plan', {}).get('writes', [])), rec.get('plan'))
    check('文件夹缺失 dry-run：不建，计划列出待建子项目', code == 0 and 'drive +create-folder' not in keys(env) and [x['name'] for x in rec.get('plan', {}).get('folders_to_create', [])] == ['新子项目'] and rec.get('plan', {}).get('d4_ready') is False, (keys(env), raw))
    env = lark_env({'folders': tree})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认新建子项目文件夹并发布')
    ks = keys(env)
    check('文件夹缺失 apply：先 +create-folder 再 +create', code == 0 and 'drive +create-folder' in ks and ks.index('drive +create-folder') < ks.index('docs +create'), (ks, raw))
    cf = [c for c in calls(env) if c['argv'][:2] == ['drive', '+create-folder']]
    cr = [c for c in calls(env) if c['argv'][:2] == ['docs', '+create']]
    check('文件夹缺失 apply：子文件夹建在客户文件夹下、文档 parent 为新 token', cf and opt(cf[0]['argv'], '--folder-token') == 'fldClient0000001'
          and opt(cf[0]['argv'], '--name') == '新子项目' and cr and opt(cr[0]['argv'], '--parent-token') == 'fldNew0001', (cf, cr))
    ts = [c['t'] for c in calls(env) if ' '.join(c['argv'][:2]) in WRITES]
    check('写命令串行且间隔 ≥ 1 秒（全局写锁）', len(ts) == 2 and ts[1] - ts[0] >= 0.99, ts)
    meta = json.load(open(os.path.join(d, 'doc.json')))
    check('文件夹缺失 apply：token 写回 doc.json lark_folder、其余字段不变', meta.get('lark_folder') == {'token': 'fldNew0001', 'path': '自测客户/新子项目'} and meta.get('title') == '自测文档', meta.get('lark_folder'))
    check('文件夹缺失 apply：D4 passed', state(d)['gates']['D4']['status'] == 'passed')
    env2 = dict(env, FAKE_LARK_LOG=env['FAKE_LARK_LOG'] + '.2')
    code, o, raw = publish(d, p, env2)
    check('写回 lark_folder 后再 dry-run（source_manifest 模式）：字段级例外放行', code == 0, raw)
    strip_manifest(d)
    code, o, raw = publish(d, p, env2)
    check('写回 lark_folder 后再 dry-run（旧 run-state 严格修改时间模式）：按发布记录的元数据规范哈希放行', code == 0, raw)
    m2 = json.load(open(os.path.join(d, 'doc.json'))); m2['owner'] = '别人'; json.dump(m2, open(os.path.join(d, 'doc.json'), 'w'), ensure_ascii=False)
    code, o, raw = publish(d, p, env2)
    check('之后改了元数据其他字段：拒绝', code == 1 and 'doc.json' in raw, raw)
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': '新客户', 'path': '全新客户/首个项目'}})
    env = lark_env({'folders': tree})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('新客户文件夹未授权：退出码 5、不写、带选项', code == 5 and not (set(keys(env)) & WRITES) and o.get('options'), (keys(env), raw))
    env = lark_env({'folders': tree})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认新建全新客户', '--allow-new-project-folder')
    cf = [c for c in calls(env) if c['argv'][:2] == ['drive', '+create-folder']]
    check('新客户文件夹授权后：根目录建项目、其下建子项目', code == 0 and len(cf) == 2 and '--folder-token' not in cf[0]['argv'] and opt(cf[1]['argv'], '--folder-token') == 'fldNew0001', ([c['argv'] for c in cf], raw))
    for label, lf, t in (('同名多个', {'pending_reason': 'x', 'path': '重名客户/项目'}, {'': [{'name': '重名客户', 'token': 'fldDup00000001'}, {'name': '重名客户', 'token': 'fldDup00000002'}]}),
                         ('近似名', {'pending_reason': 'x', 'path': '自测 客户/项目'}, tree),
                         ('路径只有一段', {'pending_reason': 'x', 'path': '自测客户'}, tree)):
        d, p = make_run(meta_over={'lark_folder': lf})
        env = lark_env({'folders': t})
        code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认', '--allow-new-project-folder')
        check(f'文件夹{label}：退出码 5、不写', code == 5 and not (set(keys(env)) & WRITES), (keys(env), raw))
    d, p = make_run()
    env = lark_env({'fail_on': {'drive files': 'permission denied'}})
    code, o, raw = publish(d, p, env)
    check('文件夹列表读不到：退出码 7', code == 7 and o.get('step') == 'folder-list', raw)
    tree = {'': [{'name': 'A客户', 'token': 'fldA0000000001'}, {'name': 'B客户', 'token': 'fldB0000000001'}, {'name': '翻页客户', 'token': 'fldPage00000001'}], 'fldPage00000001': [{'name': '子项目', 'token': 'fldSub000000001'}], 'fldSub000000001': []}
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': 'x', 'path': '翻页客户/子项目'}})
    env = lark_env({'folders': tree, 'page_size': 1})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    cr = [c for c in calls(env) if c['argv'][:2] == ['docs', '+create']]
    check('根目录分页：翻到第 3 页找到项目文件夹，不新建', code == 0 and 'drive +create-folder' not in keys(env) and cr and opt(cr[0]['argv'], '--parent-token') == 'fldSub000000001', (keys(env), raw))
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': 'x', 'path': '翻页客户/子项目'}})
    env = lark_env({'folders': tree, 'broken_paging': True})
    code, o, raw = publish(d, p, env)
    check('分页信息不完整：退出码 7，不拿半张清单判断', code == 7 and o.get('step') == 'folder-list', raw)


# ---------------------------------------------------------------- 验收 1：钩子与类型包

def t_hooks():
    for label, cmd, expect in (('退出非 0', ['{python}', '-c', 'import sys; print("{\\"ok\\": false}"); sys.exit(2)'], '退出码 2'),
                               ('stdout 非 JSON', ['{python}', '-c', 'print("not json")'], '不是 JSON'),
                               ('ok=false', ['{python}', '-c', 'import json; print(json.dumps({"ok": False, "message": "模型哈希不符"}))'], 'ok=false'),
                               ('缺 ok=true', ['{python}', '-c', 'print("{}")'], 'ok=true')):
        p = make_pack(hooks={'pre_publish': {'command': cmd, 'desc': '自测'}})
        d, _ = make_run(pack=p)
        env = lark_env({})
        code, o, raw = publish(d, p, env)
        check(f'pre_publish {label}：退出码 4', code == 4 and o.get('step') == 'pre_publish' and expect in o.get('message', ''), raw)
        check(f'pre_publish {label}：不调用 lark-cli、不归档', calls(env) == [] and not os.path.exists(os.path.join(d, 'out', 'published')))
    hook_env = ('import json,os; e=os.environ; print(json.dumps({"ok": True, "extra": {"model_hash": "abc", "dry": e["DOC_PUBLISH_DRY_RUN"], '
                '"cwd_ok": os.path.realpath(os.getcwd()) == os.path.realpath(e["DOC_RUN_DIR"]), '
                '"proxy": sorted(k for k in e if k.upper() in ("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY")), "home_real": e.get("HOME") == ' + repr(os.path.expanduser('~')) + ', '
                '"inherited": "FAKE_LARK_LOG" in e or "DOC_TYPES_DIRS" in e, "lark_cfg_empty": os.listdir(e["LARKSUITE_CLI_CONFIG_DIR"]) == []}}))')
    p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', hook_env], 'desc': '自测'}})
    d, _ = make_run(pack=p)
    code, o, raw = publish(d, p, lark_env({}, {'HTTP_PROXY': 'http://127.0.0.1:7890'}))
    rec = dry_rec(d) if code == 0 else {}
    check('pre_publish 成功：extra 合并；钩子环境无代理、不继承父进程变量、HOME 与 lark-cli 配置目录是临时空目录',
          rec.get('extra') == {'model_hash': 'abc', 'dry': '1', 'cwd_ok': True, 'proxy': [], 'home_real': False, 'inherited': False, 'lark_cfg_empty': True}, (raw, rec.get('extra')))
    call_lark = 'import json,subprocess; subprocess.run(["lark-cli","docs","+create","--as","user"]); print(json.dumps({"ok": True}))'
    for mode_args, label in (([], 'dry-run'), (['--apply', '--evidence', '用户确认'], 'apply')):
        p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', call_lark], 'desc': '自测'}})
        d, _ = make_run(pack=p)
        env = lark_env({})
        code, o, raw = publish(d, p, env, *mode_args)
        check(f'钩子调用 lark-cli（{label}）：被 shim 拦截，E-HOOK 退出码 4，假服务端收不到任何调用', code == 4 and o.get('rule') == 'E-HOOK' and '调用了 lark-cli' in o.get('message', '') and calls(env) == [], raw)
    for label, code_str in (('正文', 'open("doc.md","a").write("\\n钩子追加\\n")'),
                            ('元数据', 'import json as j; m=j.load(open("doc.json")); m["version"]="9.9"; j.dump(m, open("doc.json","w"), ensure_ascii=False)'),
                            ('产物', 'open("out/feishu.xml","a").write("<p>钩子加的</p>")')):
        p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', code_str + '; import json; print(json.dumps({"ok": True}))'], 'desc': '自测'}})
        d, _ = make_run(pack=p)
        env = lark_env({})
        code, o, raw = publish(d, p, env)
        check(f'钩子改了{label}：E-HOOK 退出码 4、不调用 lark-cli', code == 4 and '改动了运行目录' in o.get('message', '') and calls(env) == [], raw)
    p = make_pack(hooks={'post_publish': {'command': ['{python}', '-c', call_lark], 'desc': '自测'}})
    d, _ = make_run(pack=p)
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('post_publish 调用 lark-cli：记 problems、退出码 3，引擎之外没有写入', code == 3 and any('E-HOOK' in x for x in o.get('problems', [])) and keys(env).count('docs +create') == 1, raw)
    # 钩子篡改 out/ 下的正式归档记录、docx（快照必须覆盖整个运行目录）
    d, p = make_run()
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    pj = json.load(open(os.path.join(p, 'pack.json')))
    pj['hooks']['pre_publish'] = {'command': ['{python}', '-c', 'import os,json; os.remove("out/published/v1.0/published.json"); print(json.dumps({"ok": True}))'], 'desc': '自测'}
    json.dump(pj, open(os.path.join(p, 'pack.json'), 'w'), ensure_ascii=False, indent=2)
    e2 = lark_env({'folders': server(env)['folders'], 'docs': server(env)['docs']})
    code, o, raw = publish(d, p, e2, '--apply', '--evidence', '用户确认')
    check('钩子删除正式归档 published.json：E-HOOK 退出码 4、不调用 lark-cli', code == 4 and '改动了运行目录' in o.get('message', '') and 'out/published/v1.0/published.json' in o.get('message', '') and calls(e2) == [], raw)
    p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', 'import glob,json; open(glob.glob("out/*.docx")[0], "ab").write(b"x"); print(json.dumps({"ok": True}))'], 'desc': '自测'}})
    d, _ = make_run(pack=p, docx=True)
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('钩子改 docx：E-HOOK 退出码 4', code == 4 and '.docx' in o.get('message', '') and calls(env) == [], raw)
    p = make_pack(hooks={'post_publish': {'command': ['{python}', '-c', 'import os,json; os.remove("out/published/v1.0/render.json"); print(json.dumps({"ok": True}))'], 'desc': '自测'}})
    d, _ = make_run(pack=p)
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('post_publish 删正式归档文件：记 E-HOOK problems、退出码 3', code == 3 and any('E-HOOK' in x and 'render.json' in x for x in o.get('problems', [])), raw)
    # 类型包可信目录与 schema
    untrusted = os.path.join(BASE, 'untrusted'); os.makedirs(untrusted, exist_ok=True)
    p = make_pack(root=untrusted)
    d, _ = make_run(pack=p)
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('类型包不在 doc-shared/types 或 DOC_TYPES_DIRS 下：退出码 2、不调用 lark-cli', code == 2 and o.get('step') == 'pack' and calls(env) == [], raw)
    p = make_pack(mut=lambda j: j.update({'status': 'bogus'}))
    d, _ = make_run(pack=make_pack())
    code, o, raw = publish(d, p, lark_env({}))
    check('类型包不合 pack schema：退出码 1', code == 1 and o.get('step') == 'pack', raw)
    d, p = make_run()
    open(os.path.join(p, 'pack.json'), 'w').write('{not json')
    code, o, raw = publish(d, p, lark_env({}))
    check('pack.json 损坏：退出码 2、无 traceback', code == 2 and 'Traceback' not in raw, raw)


# ---------------------------------------------------------------- 验收 2：写命令不自动重试

def t_write_no_retry():
    d, p = make_run()
    env = lark_env({'fail_once': {'docs +create': 'HTTP 429 too many requests'}})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('docs +create 报 429：退出码 7、只调用一次、提示可能已写入先只读定位', code == 7 and keys(env).count('docs +create') == 1 and '可能已写入' in o.get('message', '') and o.get('uncertain_write') is True, (keys(env), raw))
    check('docs +create 报 429：留下新建意图文件', os.path.isfile(os.path.join(d, 'out', 'published', '.create-intent.json')))
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': 'x', 'path': '自测客户/限流'}})
    env = lark_env({'fail_once': {'drive +create-folder': 'request trigger frequency limit'}})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('+create-folder 报频率限制且没建成：只读重列后退出 7（located_folders 为空），不重试、不建文档', code == 7 and keys(env).count('drive +create-folder') == 1 and 'docs +create' not in keys(env)
          and o.get('located_folders') == [], (keys(env), raw))
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': 'x', 'path': '自测客户/限流子项目'}})
    env = lark_env({'create_folder_created_but_rate_limited': True})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    same = [f for f in server(env)['folders'].get('fldClient0000001', []) if f['name'] == '限流子项目']
    check('+create-folder 已建成但报频率限制：退出 7、不继续建文档，located_folders 给出只读定位到的唯一同名文件夹',
          code == 7 and 'docs +create' not in keys(env) and keys(env).count('drive +create-folder') == 1 and len(same) == 1
          and [x['token'] for x in (o.get('located_folders') or [])] == [same[0]['token']] if same else False, (keys(env), o.get('located_folders'), raw))
    e2 = lark_env({'folders': server(env)['folders']})
    code, o, raw = publish(d, p, e2, '--apply', '--evidence', '用户：核对过，就用这个文件夹')
    same2 = [f for f in server(e2)['folders'].get('fldClient0000001', []) if f['name'] == '限流子项目']
    check('核对后重跑：按 path 解析直接用已存在的文件夹，不再建，父目录下仍恰好一个同名', code == 0 and 'drive +create-folder' not in keys(e2) and len(same2) == 1, (keys(e2), raw))
    d, p = make_run(meta_over={'lark_folder': {'pending_reason': 'x', 'path': '自测客户/丢响应'}})
    env = lark_env({'create_folder_lost_response': True})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('+create-folder 无响应但已建成：退出 7、只建一次、不继续建文档、located_folders 有 1 个', code == 7 and keys(env).count('drive +create-folder') == 1 and 'docs +create' not in keys(env)
          and len(o.get('located_folders') or []) == 1, (keys(env), raw))
    d, p = make_run()
    env = lark_env({'fail_once': {'drive files': 'request trigger frequency limit'}})
    code, o, raw = publish(d, p, env)
    check('读命令（drive files list）限流：自动重试后成功', code == 0 and keys(env).count('drive files') == 3, (keys(env), raw))
    d, p = make_run()
    env = lark_env({'create_missing_id': True})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('+create 响应缺 document_id（字段漂移）：退出码 7、可能已写入、留意图', code == 7 and '可能已写入' in o.get('message', '') and os.path.isfile(os.path.join(d, 'out', 'published', '.create-intent.json')), raw)


# ---------------------------------------------------------------- 验收 2 + 8：服务端已写入但客户端失败的状态机

def t_state_machine():
    d, p = make_run()
    env = lark_env({'create_server_ok_client_fail': True})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    srv = server(env)
    check('状态机①：服务端已建文档、客户端无响应 → 退出码 7、提示可能已写入', code == 7 and '可能已写入' in o.get('message', ''), raw)
    check('状态机①：只发了一次 +create，服务端恰好一份文档', keys(env).count('docs +create') == 1 and len(srv.get('docs', {})) == 1, (keys(env), srv.get('docs')))
    check('状态机①：没有根 published.json、没有正式归档、有新建意图', not os.path.exists(os.path.join(d, 'published.json')) and not os.path.exists(os.path.join(d, 'out', 'published', 'v1.0'))
          and os.path.isfile(os.path.join(d, 'out', 'published', '.create-intent.json')))
    base_scen = {'folders': srv['folders'], 'docs': srv['docs']}
    for label, args in (('再 apply', ['--apply', '--evidence', '用户确认']), ('--create', ['--apply', '--evidence', '用户确认', '--create']), ('dry-run', [])):
        e2 = lark_env(base_scen)
        code, o, raw = publish(d, p, e2, *args)
        check(f'状态机②：存在未决新建时{label} → 退出码 8、不调用写命令', code == 8 and o.get('step') == 'pending-create' and not (set(keys(e2)) & WRITES), (code, keys(e2), o.get('message')))
    located = list(srv['docs'])[0]
    e3 = lark_env(base_scen)
    code, o, raw = publish(d, p, e3, '--apply', '--evidence', '用户：找到了，覆盖这份', '--doc-token', located)
    check('状态机③：只读定位后 --doc-token 覆盖 → 成功、服务端仍一份、意图清除', code == 0 and 'docs +create' not in keys(e3) and len(server(e3)['docs']) == 1
          and not os.path.exists(os.path.join(d, 'out', 'published', '.create-intent.json')), (keys(e3), raw))
    # 另一分支：用户确认没建成 → --abandon-recovery
    d, p = make_run()
    env = lark_env({'create_server_ok_client_fail': True})
    publish(d, p, env, '--apply', '--evidence', '用户确认')
    e4 = lark_env({'folders': server(env)['folders']})
    code, o, raw = publish(d, p, e4, '--apply', '--abandon-recovery', '--evidence', '用户：看过文件夹，没有这份，重新建')
    rec = json.load(open(os.path.join(d, 'published.json'))) if os.path.exists(os.path.join(d, 'published.json')) else {}
    check('状态机④：--abandon-recovery --evidence 后新建成功，published.json 留痕（intent 与用户原话）', code == 0 and rec.get('recovery_abandoned', {}).get('intent')
          and '没有这份' in rec['recovery_abandoned']['evidence'][0] and not schema_errors(rec), (raw, rec.get('recovery_abandoned')))
    d, p = make_run()
    publish(d, p, lark_env({'create_server_ok_client_fail': True}), '--apply', '--evidence', '用户确认')
    code, o, raw = publish(d, p, lark_env({}), '--apply', '--abandon-recovery')
    check('--abandon-recovery 不带 --evidence：退出码 2', code == 2, raw)


# ---------------------------------------------------------------- 验收 3：token 必须与 path 解析一致

def t_token_trust():
    for label, lf in (('token 指向一级客户文件夹、path 只有一段', {'token': 'fldClient0000001', 'path': '自测客户'}),
                      ('token 是一级客户文件夹、path 两段（末级不一致）', {'token': 'fldClient0000001', 'path': '自测客户/自测项目'}),
                      ('path 第二段不存在', {'token': 'fldProj00000001', 'path': '自测客户/不存在'}),
                      ('token 可读但不在 path 上', {'token': 'fldOther00000001', 'path': '自测客户/自测项目'})):
        d, p = make_run(meta_over={'lark_folder': lf})
        tree = copy.deepcopy(ROOT_TREE); tree['fldOther00000001'] = []
        env = lark_env({'folders': tree})
        code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
        check(f'token 信任：{label} → 退出码 5、不写', code == 5 and not (set(keys(env)) & WRITES), (code, keys(env), o.get('message')))
    d, p = make_run()
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    rec = json.load(open(os.path.join(d, 'published.json')))
    b1 = json.loads(json.dumps(rec)); b1['lark_folder']['path'] = '自测客户'
    b2 = json.loads(json.dumps(rec)); b2['lark_folder']['token'] = None
    b3 = json.loads(json.dumps(rec)); b3['lark_folder']['path'] = None
    check('schema：真发布记录 lark_folder.token 为空、path 为空或只有一段 都报错', all(schema_errors(b) for b in (b1, b2, b3)) and not schema_errors(rec), [len(schema_errors(b)) for b in (b1, b2, b3)])


# ---------------------------------------------------------------- 验收 4：恢复记录与同版本重发保护

def resha(d, p):
    doc = dp.parse_file(d, 'doc.md', pack=json.load(open(os.path.join(p, 'pack.json'))))
    sha = hashlib.sha256(doc.text.encode('utf-8')).hexdigest()
    time.sleep(0.02)
    for f in ('qa-result.json', 'out/render.json'):
        j = json.load(open(os.path.join(d, f))); j['source_sha256'] = sha; json.dump(j, open(os.path.join(d, f), 'w'), ensure_ascii=False)
    # 模拟重跑质检、渲染并重过 D3：刷新 gates.D3.source_manifest（与 run_state.py 同一实现）
    import run_state as rsm
    sp = os.path.join(d, 'run-state.json'); st = json.load(open(sp))
    st['gates']['D3']['source_manifest'] = rsm.build_manifest(d)
    json.dump(st, open(sp, 'w'), ensure_ascii=False, indent=2)


def t_recovery():
    d, p = make_run()
    env = lark_env({'fail_on': {'docs +fetch': 'network error'}})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    rec = json.load(open(os.path.join(d, 'published.json'))) if os.path.exists(os.path.join(d, 'published.json')) else {}
    check('恢复记录：回查读取失败 → 退出码 7，根目录与归档有合法恢复记录', code == 7 and rec.get('lark_doc_id') == 'doxNew00000001' and rec.get('verify') is None and rec.get('problems')
          and not schema_errors(rec) and os.path.isfile(os.path.join(d, 'out', 'published', 'v1.0', 'published.json')), (raw, schema_errors(rec)))
    srv = {'folders': server(env)['folders'], 'docs': server(env)['docs']}
    code, o, raw = publish(d, p, lark_env(srv))
    check('恢复记录之后 dry-run：推断为 overwrite 同一文档', code == 0 and o.get('mode') == 'overwrite' and o.get('doc_token') == 'doxNew00000001', raw)
    e = lark_env(srv)
    code, o, raw = publish(d, p, e, '--apply', '--evidence', '用户确认', '--create')
    check('恢复记录存在时 --create：退出码 8、不写', code == 8 and o.get('step') == 'recovery' and not (set(keys(e)) & WRITES), raw)
    # 恢复记录只在根目录（正式归档还没落盘就中断）
    shutil.rmtree(os.path.join(d, 'out', 'published', 'v1.0'))
    open(os.path.join(d, 'doc.md'), 'a').write('\n改过的一段。\n')
    resha(d, p)
    for label, args in (('默认', ['--apply', '--evidence', '用户确认']), ('--create', ['--apply', '--evidence', '用户确认', '--create'])):
        e = lark_env(srv)
        code, o, raw = publish(d, p, e, *args)
        check(f'同版本、正文不同、只有根恢复记录（{label}）：拒绝、不写', code in (1, 8) and not (set(keys(e)) & WRITES) and 'v1.0' in raw, (code, o.get('message'), o.get('problems')))
    e = lark_env(srv)
    code, o, raw = publish(d, p, e, '--apply', '--abandon-recovery', '--evidence', '用户：旧的那份作废，按新正文重新建')
    rec = json.load(open(os.path.join(d, 'published.json')))
    check('--abandon-recovery：放行新建，published.json 记录 previous_doc_id 与用户原话', code == 0 and 'docs +create' in keys(e)
          and rec.get('recovery_abandoned', {}).get('previous_doc_id') == 'doxNew00000001' and rec['mode'] == 'create', (raw, rec.get('recovery_abandoned')))
    # 正式归档（完整记录）同版本不同正文
    d, p = make_run()
    env = lark_env({})
    publish(d, p, env, '--apply', '--evidence', '用户确认')
    os.remove(os.path.join(d, 'published.json'))  # 只剩正式归档
    open(os.path.join(d, 'doc.md'), 'a').write('\n新增一段。\n')
    resha(d, p)
    e = lark_env({'folders': server(env)['folders'], 'docs': server(env)['docs']})
    code, o, raw = publish(d, p, e, '--apply', '--evidence', '用户确认', '--create')
    check('正式归档同版本不同正文：拒绝，要求升版本', code == 1 and '升版本号' in raw and not (set(keys(e)) & WRITES), raw)
    open(os.path.join(d, 'out', 'published', 'v1.0', 'published.json'), 'w').write('{broken')
    e = lark_env({})
    code, o, raw = publish(d, p, e)
    check('正式归档 published.json 损坏：退出码 2、不调用 lark-cli', code == 2 and o.get('step') == 'published.json' and calls(e) == [], raw)
    d, p = make_run()
    open(os.path.join(d, 'published.json'), 'w').write('[]')
    e = lark_env({})
    code, o, raw = publish(d, p, e)
    check('根 published.json 非对象：退出码 2 且没有任何 lark-cli 调用', code == 2 and calls(e) == [], raw)


# ---------------------------------------------------------------- 验收 5：跨运行目录全局写锁

def t_global_lock():
    d1, p1 = make_run()
    d2, p2 = make_run()
    e1, e2 = lark_env({}), lark_env({})
    procs = [subprocess.Popen([PY, PUB, d, '--pack', p, '--apply', '--evidence', '用户确认'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=e)
             for d, p, e in ((d1, p1, e1), (d2, p2, e2))]
    codes = [pr.wait(timeout=300) for pr in procs]
    t1 = [c['t'] for c in calls(e1) if c['argv'][:2] == ['docs', '+create']]
    t2 = [c['t'] for c in calls(e2) if c['argv'][:2] == ['docs', '+create']]
    check('全局写锁：两个运行目录并发 apply 都成功，两次 +create 间隔 ≥ 1 秒', codes == [0, 0] and t1 and t2 and abs(t1[0] - t2[0]) >= 0.99, (codes, t1, t2))
    check('全局写锁：锁文件在 ~/.cache/doc-publish/lark-write.lock 且记录 last_write', os.path.isfile(os.path.expanduser('~/.cache/doc-publish/lark-write.lock'))
          and 'last_write' in open(os.path.expanduser('~/.cache/doc-publish/lark-write.lock')).read())
    d, p = make_run()
    lk = os.path.join(d, 'out', '.publish.lock')
    import fcntl
    f = open(lk, 'w'); fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('另一个发布进程持运行目录锁：退出码 2、不调用 lark-cli', code == 2 and o.get('step') == 'lock' and calls(env) == [], raw)
    fcntl.flock(f, fcntl.LOCK_UN); f.close()


# ---------------------------------------------------------------- 验收 6：source_manifest 新鲜度

def t_manifest():
    d, p = make_run()
    code, o, raw = publish(d, p, lark_env({}))
    check('source_manifest：一致时 dry-run 通过，freshness_check=manifest', code == 0 and dry_rec(d).get('freshness_check') == 'manifest', raw)
    d, p = make_run()
    f = os.path.join(d, 'figures', 'a.svg'); old = os.stat(f)
    open(f, 'a').write('<!-- changed -->'); os.utime(f, ns=(old.st_atime_ns, old.st_mtime_ns))
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('source_manifest：改图后回拨修改时间 → 仍被内容哈希拦下、不调用 lark-cli', code == 1 and 'figures/a.svg' in raw and calls(env) == [], raw)
    d, p = make_run()
    open(os.path.join(d, 'figures', 'new.csv'), 'w').write('x\n')
    code, o, raw = publish(d, p, lark_env({}))
    check('source_manifest：D3 之后新增源文件 → 拒绝', code == 1 and 'figures/new.csv' in raw, raw)
    d, p = make_run()
    m = json.load(open(os.path.join(d, 'doc.json'))); m['lark_profile'] = 'account1'
    json.dump(m, open(os.path.join(d, 'doc.json'), 'w'), ensure_ascii=False)
    code, o, raw = publish(d, p, lark_env({}))
    check('source_manifest：改了元数据 lark_profile（非 lark_folder）→ 拒绝', code == 1 and 'doc.json' in raw, raw)
    d, p = make_run()
    m = json.load(open(os.path.join(d, 'doc.json'))); m['lark_folder'] = {'token': 'fldProj00000001', 'path': '自测客户/自测项目'}
    json.dump(m, open(os.path.join(d, 'doc.json'), 'w'), ensure_ascii=False, indent=4)
    code, o, raw = publish(d, p, lark_env({}))
    check('source_manifest：只改元数据 lark_folder（且重排版）→ 字段级例外放行', code == 0, raw)
    d, p = make_run()
    st = json.load(open(os.path.join(d, 'run-state.json'))); st['gates']['D3']['source_manifest'] = {'files': 'bad'}
    json.dump(st, open(os.path.join(d, 'run-state.json'), 'w'))
    code, o, raw = publish(d, p, lark_env({}))
    check('source_manifest 格式不合 run-state schema：拒绝', code == 1 and o.get('step') == 'run-state', raw)
    # 旧 run-state：严格修改时间，不留容差
    d, p = make_run(legacy=True)
    f = os.path.join(d, 'figures', 'a.svg'); art = os.path.getmtime(os.path.join(d, 'out', 'render.json'))
    open(f, 'a').write('<!-- changed -->'); os.utime(f, (art + 0.5, art + 0.5))
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('旧 run-state 严格修改时间：图晚于产物 0.5 秒也拒绝（原 2 秒容差已去掉）', code == 1 and 'figures/a.svg' in raw and calls(env) == [], raw)
    src = open(PUB, encoding='utf-8').read()
    check('publish.py 不再伪造修改时间（无 os.utime）', 'os.utime' not in src)


# ---------------------------------------------------------------- 验收 7：XML 解析器守卫

def t_xml_guard():
    cases = (('同段两个 &#126; 实体', XML.replace('<p>正文一段。</p>', '<p>工时 3&#126;5 天，测试 1&#126;2 天</p>'), '~'),
             ('CDATA 里两个 ~', XML.replace('<p>正文一段。</p>', '<p><![CDATA[3~5 与 1~2]]></p>'), '~'),
             ('嵌套 <b> 里两个 ~', XML.replace('<p>正文一段。</p>', '<p>工时 <b>3~5</b> 天，测试 <b>1~2</b> 天</p>'), '~'),
             ('单引号 path 越界', XML.replace('path="@./figures/a.svg"', "path='@./../outside.svg'"), '越出运行目录'),
             ('path 不是 @./', XML.replace('path="@./figures/a.svg"', 'path="/etc/passwd"'), '@./'),
             ('资源不存在', XML.replace('figures/a.svg', 'figures/missing.svg'), '不存在'),
             ('行内代码', XML.replace('<p>正文一段。</p>', '<p>字段 <code>user_id</code></p>'), '行内代码'),
             ('属性里两个 ~', XML.replace('<p>第二段。</p>', '<img path="@./figures/a.svg" caption="3~5 与 1~2"/><p>第二段。</p>'), '~'),
             ('不是合法 XML', XML.replace('<p>第二段。</p>', '<p>第二段。'), '合法 XML'))
    for label, x, expect in cases:
        d, p = make_run(xml=x)
        env = lark_env({})
        code, o, raw = publish(d, p, env)
        check(f'XML 守卫：{label} → 拒绝、不调用 lark-cli', code == 1 and expect in raw and calls(env) == [], raw)
    d, p = make_run(xml=XML.replace('path="@./figures/a.svg"', "path='@./figures/a.svg'"))
    code, o, raw = publish(d, p, lark_env({}))
    check('XML 守卫：单引号合法 path 正常识别并归档', code == 0 and any(a['role'] == 'resource' and a['source'] == 'figures/a.svg' for a in dry_rec(d).get('archive', [])), raw)
    d, p = make_run(xml=XML.replace('<p>第二段。</p>', '<pre lang="sh"><code>ls ~ ~/x</code></pre>'), pack=make_pack(features={'code_blocks': True}))
    code, o, raw = publish(d, p, lark_env({}))
    check('XML 守卫：允许代码块时 <pre><code> 内的 ~ 与 code 不算违规', code == 0, raw)


# ---------------------------------------------------------------- 回查（服务端转换）与其他守卫

def t_verify_and_guards():
    d, p = make_run()
    env = lark_env({'server_drop_whiteboards': True})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    rec = json.load(open(os.path.join(d, 'published.json'))) if os.path.exists(os.path.join(d, 'published.json')) else {}
    check('服务端丢画板：回查退出码 3、problems 记画板、published.json 过 schema', code == 3 and any('画板' in x for x in rec.get('problems', [])) and not schema_errors(rec), raw)
    d, p = make_run()
    env = lark_env({'server_italic': True})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('服务端转换出斜体：回查退出码 3', code == 3 and any('斜体' in x for x in o.get('problems', [])), raw)
    d, p = make_run()
    code, o, raw = publish(d, p, lark_env({}), '--apply')
    check('--apply 无 --evidence：退出码 2', code == 2, raw)
    d, p = make_run()
    code, o, raw = publish(d, p, lark_env({}), '--apply', '--offline', '--evidence', 'x')
    check('--apply --offline：退出码 2', code == 2, raw)
    d, p = make_run()
    meta = json.load(open(os.path.join(d, 'doc.json'))); meta['version'] = '1.1'; json.dump(meta, open(os.path.join(d, 'doc.json'), 'w'), ensure_ascii=False)
    code, o, raw = publish(d, p, lark_env({}))
    check('渲染后改版本号：拒绝', code == 1, raw)
    d, p = make_run()
    rjp = os.path.join(d, 'out', 'render.json'); rj = json.load(open(rjp))
    rj['layout_issues'] = [{'rule': 'LY4', 'severity': '必改', 'message': '图字号过小'}]; json.dump(rj, open(rjp, 'w'), ensure_ascii=False)
    code, o, raw = publish(d, p, lark_env({}))
    check('render.json 版式必改（D3 passed 之后被改）：拒绝', code == 1 and '版式必改' in raw, raw)
    code, o, raw = publish(d, p, lark_env({'parse_status': 'failed'}), '--create')
    check('parse 未通过：拒绝', code == 1, raw)
    p = make_pack(meta_file='brief.json')
    d, _ = make_run(pack=p, meta_name='brief.json')
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认发布')
    check('meta_file=brief.json：apply 成功且 D4 passed', code == 0 and state(d)['gates']['D4']['status'] == 'passed', raw)
    d, p = make_run()
    env = lark_env({'comments_paging_endless': True, 'docs': {'doxOld00000009': {'parent': 'fldProj00000001', 'content': '<p>x</p>'}}})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认', '--doc-token', 'doxOld00000009')
    check('评论分页超过上限：退出码 7、不写', code == 7 and o.get('step') == 'list-comments' and not (set(keys(env)) & WRITES), (code, o.get('message')))
    d, p = make_run()
    prev = os.path.join(d, 'out', 'published', 'v1.0.dry-run', 'published.json')
    publish(d, p, lark_env({}))
    before = open(prev, 'rb').read() if os.path.exists(prev) else None
    code, o, raw = publish(d, p, lark_env({'parse_status': 'failed'}))
    check('dry-run 失败：保留上次 dry-run 记录、不留暂存目录', code == 1 and before is not None and open(prev, 'rb').read() == before
          and not os.path.exists(os.path.join(d, 'out', 'published', '.staging-v1.0.dry-run')), raw)
    d, p = make_run()
    x = os.path.join(d, 'out', 'feishu.xml'); os.chmod(x, 0)
    try:
        code, o, raw = publish(d, p, lark_env({}))
    finally:
        os.chmod(x, 0o644)
    check('feishu.xml 不可读：退出码 2、无 traceback', code == 2 and 'Traceback' not in raw, raw)
    d, p = make_run()
    publish(d, p, lark_env({}))
    rec = dry_rec(d)
    bad1 = dict(rec); bad1.pop('plan')
    bad2 = dict(rec); bad2['dry_run'] = False
    bad3 = dict(rec); bad3.pop('engine')
    bad4 = dict(rec); bad4['lark_doc_id'] = 'doxX00000001'
    check('schema 反例：dry-run 缺 plan、dry_run 假却带 plan、缺 engine、dry-run 新建带 doc id 都报错', all(schema_errors(b) for b in (bad1, bad2, bad3, bad4)) and not schema_errors(rec),
          [len(schema_errors(b)) for b in (bad1, bad2, bad3, bad4)])


# ---------------------------------------------------------------- 第三轮验收：快照、写入路径、意图结构、--doc-token 核对

def pending_run():
    """留下一个真实的未决新建：服务端已建文档、客户端无响应。"""
    d, p = make_run()
    env = lark_env({'create_server_ok_client_fail': True})
    publish(d, p, env, '--apply', '--evidence', '用户确认')
    return d, p, env


def t_accept3():
    intent = lambda d: os.path.join(d, 'out', 'published', '.create-intent.json')
    ext = tempfile.mkdtemp(prefix='ext-', dir=BASE)
    # 写入路径经过软链（钩子之外预先存在）
    d, p = make_run()
    os.symlink(ext, os.path.join(d, 'out', 'published'))
    for args, label in (([], 'dry-run'), (['--apply', '--evidence', '用户确认'], 'apply')):
        env = lark_env({})
        code, o, raw = publish(d, p, env, *args)
        check(f'写入路径 out/published 是指向外部的软链（{label}）：退出码 1 path-guard、不写飞书、外部目录无文件', code == 1 and o.get('step') == 'path-guard'
              and not (set(keys(env)) & WRITES) and os.listdir(ext) == [], (code, o.get('message'), os.listdir(ext)))
    os.remove(os.path.join(d, 'out', 'published'))
    os.symlink(ext, os.path.join(d, 'out', 'redir'))
    open(os.path.join(d, 'published.json.tmp'), 'w').close(); os.remove(os.path.join(d, 'published.json.tmp'))
    os.symlink(os.path.join(ext, 'rec.json'), os.path.join(d, 'published.json.tmp'))
    env = lark_env({})
    code, o, raw = publish(d, p, env, '--apply', '--evidence', '用户确认')
    check('发布记录的临时文件 published.json.tmp 是软链：写记录前拒绝（path-guard），外部不出现文件', code == 1 and o.get('step') == 'path-guard' and not os.path.exists(os.path.join(ext, 'rec.json')), (code, o.get('message')))
    # 钩子建目录软链 / 改权限 / 建空目录 / 改文件软链目标
    hooks = (('建 out/published 目录软链指向外部', f'import os; os.makedirs("out", exist_ok=True); os.symlink({ext!r}, "out/published")', 'out/published'),
             ('改 feishu.xml 权限位', 'import os; os.chmod("out/feishu.xml", 0o600)', 'out/feishu.xml'),
             ('建空目录', 'import os; os.mkdir("out/emptydir")', 'out/emptydir'),
             ('改文件软链目标', 'import os; os.remove("out/lnk"); os.symlink("render.json", "out/lnk")', 'out/lnk'))
    for label, code_str, expect in hooks:
        p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', code_str + '; import json; print(json.dumps({"ok": True}))'], 'desc': '自测'}})
        d, _ = make_run(pack=p)
        os.symlink('feishu.xml', os.path.join(d, 'out', 'lnk'))
        env = lark_env({})
        code, o, raw = publish(d, p, env)
        check(f'钩子{label}：E-HOOK 退出码 4、消息点名 {expect}、不调用 lark-cli、外部目录无文件', code == 4 and expect in o.get('message', '') and calls(env) == [] and os.listdir(ext) == [], (code, o.get('message')))
    p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', 'import time; open("figures/hook.txt","w").write("x"); time.sleep(8)'], 'desc': '自测', 'timeout_s': 1}})
    d, _ = make_run(pack=p)
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('钩子超时：先做后快照，E-HOOK 退出码 4 且写明残留改动 figures/hook.txt', code == 4 and '超时' in o.get('message', '') and 'figures/hook.txt' in o.get('message', '') and calls(env) == [], raw)
    p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', 'import subprocess,json; open("figures/hook2.txt","w").write("x"); subprocess.run(["lark-cli","docs","+create"]); print(json.dumps({"ok": True}))'], 'desc': '自测'}})
    d, _ = make_run(pack=p)
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    check('钩子触发 lark-cli shim：E-HOOK 退出码 4 且写明残留改动 figures/hook2.txt', code == 4 and '调用了 lark-cli' in o.get('message', '') and 'figures/hook2.txt' in o.get('message', '') and calls(env) == [], raw)
    # 意图文件结构：{}、[]、null、损坏、缺字段 一律未决
    d, p, env0 = pending_run()
    srv = {'folders': server(env0)['folders'], 'docs': server(env0)['docs']}
    located = list(srv['docs'])[0]
    good = json.load(open(intent(d)))
    check('新建意图文件含 schema_version、created_at、folder_token、title、argv 等字段', all(k in good for k in ('schema_version', 'created_at', 'version', 'source_sha256', 'folder_token', 'folder_path', 'title', 'argv'))
          and good['argv'][:2] == ['docs', '+create'] and good['title'] == '自测文档', good)
    bad_contents = (('{}', '{}'), ('[]', '[]'), ('null', 'null'), ('损坏', '{broken'), ('缺 argv', json.dumps({k: v for k, v in good.items() if k != 'argv'}, ensure_ascii=False)))
    for label, content in bad_contents:
        open(intent(d), 'w').write(content)
        for args, how in ((['--apply', '--evidence', '用户确认'], '默认'), (['--apply', '--evidence', '用户确认', '--create'], '--create'),
                          (['--apply', '--evidence', '用户确认', '--doc-token', located], '--doc-token'), ([], 'dry-run')):
            e = lark_env(srv)
            code, o, raw = publish(d, p, e, *args)
            check(f'意图文件为 {label}（{how}）：退出码 8、不写飞书', code == 8 and not (set(keys(e)) & WRITES), (code, keys(e), o.get('message')))
    e = lark_env(srv)
    code, o, raw = publish(d, p, e, '--apply', '--abandon-recovery', '--evidence', '用户：意图文件坏了，核对过没建成，重新建')
    rec = json.load(open(os.path.join(d, 'published.json'))) if os.path.exists(os.path.join(d, 'published.json')) else {}
    check('意图文件损坏时 --abandon-recovery --evidence 放行并留痕 intent.invalid', code == 0 and (rec.get('recovery_abandoned') or {}).get('intent', {}).get('invalid') is True and not schema_errors(rec), (raw[-400:], rec.get('recovery_abandoned')))
    # --doc-token 与未决意图：必须只读核对
    d, p, env0 = pending_run()
    folders = server(env0)['folders']; folders['fldOther00000001'] = []
    docs = dict(server(env0)['docs'])
    docs['doxOther0000001'] = {'parent': 'fldProj00000001', 'content': '<title>别的文档</title><p>无关</p>'}
    docs['doxElse00000001'] = {'parent': 'fldOther00000001', 'content': '<title>自测文档</title><p>别的文件夹里同名</p>'}
    located = [k for k, v in docs.items() if v['parent'] == 'fldProj00000001' and '自测文档' in v['content']][0]
    for label, tok in (('同文件夹但不同名的无关文档', 'doxOther0000001'), ('别的文件夹里同名文档', 'doxElse00000001'), ('不存在的 token', 'doxNope00000001')):
        e = lark_env({'folders': folders, 'docs': docs})
        code, o, raw = publish(d, p, e, '--apply', '--evidence', '用户确认', '--doc-token', tok)
        after = server(e).get('docs', docs)
        check(f'有未决意图时 --doc-token 为{label}：退出码 8、不 +update、意图保留、无关文档未变', code == 8 and 'docs +update' not in keys(e) and os.path.isfile(intent(d))
              and after.get('doxOther0000001', {}).get('content') == docs['doxOther0000001']['content'] and o.get('located_docs') is not None, (code, keys(e), o.get('message')))
    e = lark_env({'folders': folders, 'docs': docs})
    code, o, raw = publish(d, p, e)
    check('有未决意图时 dry-run 仍退出 8', code == 8, raw)
    e = lark_env({'folders': folders, 'docs': docs})
    code, o, raw = publish(d, p, e, '--doc-token', located)
    check('有未决意图、--doc-token 为核对通过的文档（dry-run）：退出码 0、计划 overwrite、意图保留', code == 0 and o.get('mode') == 'overwrite' and os.path.isfile(intent(d)), raw)
    e = lark_env({'folders': folders, 'docs': docs})
    code, o, raw = publish(d, p, e, '--offline', '--doc-token', located)
    check('有未决意图、--offline 无法核对 --doc-token：退出码 8', code == 8, raw)
    e = lark_env({'folders': folders, 'docs': docs})
    code, o, raw = publish(d, p, e, '--apply', '--evidence', '用户：找到了，覆盖这份', '--doc-token', located)
    check('有未决意图、--doc-token 核对通过（apply）：覆盖该文档、清除意图', code == 0 and 'docs +update' in keys(e) and not os.path.lexists(intent(d)), raw)


# ---------------------------------------------------------------- 终核收口：延迟改动与 run-state 锁软链

def t_final():
    late = ('import subprocess,sys,json; '
            'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.5); open(\'figures/late.txt\',\'w\').write(\'x\')"], '
            'start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print(json.dumps({"ok": True}))')
    p = make_pack(hooks={'pre_publish': {'command': ['{python}', '-c', late], 'desc': '自测'}})
    d, _ = make_run(pack=p)
    env = lark_env({})
    code, o, raw = publish(d, p, env)
    time.sleep(0.6)
    check('钩子启动脱离会话的后台子进程、0.5 秒后改文件：退出后等 1 秒的后快照检出，E-HOOK 退出码 4、不调用 lark-cli', code == 4 and 'figures/late.txt' in o.get('message', '') and calls(env) == [], raw)
    for args, label in (([], 'dry-run'), (['--apply', '--evidence', '用户确认'], 'apply')):
        d, p = make_run()
        escaped = os.path.join(BASE, f'escaped-lock-{label}')
        lk = os.path.join(d, 'run-state.json.lock')
        if os.path.lexists(lk): os.remove(lk)   # make_run 调 run_state.py 时已建过真实锁文件
        os.symlink(escaped, lk)
        env = lark_env({})
        code, o, raw = publish(d, p, env, *args)
        check(f'run-state.json.lock 是指向外部的软链（{label}）：退出码 1 path-guard、外部文件未被写入、不写飞书', code == 1 and o.get('step') == 'path-guard'
              and not os.path.lexists(escaped) and not (set(keys(env)) & WRITES), (code, o.get('message'), os.path.lexists(escaped)))
    d, p = make_run()
    escaped = os.path.join(BASE, 'escaped-lock-direct')
    lk = os.path.join(d, 'run-state.json.lock')
    if os.path.lexists(lk): os.remove(lk)
    os.symlink(escaped, lk)
    r = subprocess.run([PY, RS, d, 'check-manifest'], capture_output=True, text=True)
    check('run_state.py 直接调用、lock 是软链：O_NOFOLLOW 拒绝（非 0）、外部文件未被写入', r.returncode != 0 and not os.path.lexists(escaped), (r.returncode, r.stdout[-300:], r.stderr[-300:]))
    d, p = make_run()
    escaped = os.path.join(BASE, 'escaped-tmp-direct')
    tp = os.path.join(d, 'run-state.json.tmp')
    if os.path.lexists(tp): os.remove(tp)
    os.symlink(escaped, tp)
    r = subprocess.run([PY, RS, d, 'set-stage', 'review', '--pack', p], capture_output=True, text=True)
    check('run_state.py 写状态、run-state.json.tmp 是软链：O_NOFOLLOW 拒绝（非 0）、外部文件未被写入', r.returncode != 0 and not os.path.lexists(escaped), (r.returncode, r.stdout[-300:], r.stderr[-300:]))


def t_business_words():
    src = open(PUB, encoding='utf-8').read()
    hits = re.findall(r'报价|售前|presales|pricing|Reddit|建站|用例|确认单', src, flags=re.I)
    check('引擎业务词守卫：publish.py 不含业务线词', not hits, hits)
    check('publish.py 不包含 --yes', '--yes' not in src)


def t_fake_violations():
    v = [json.loads(x) for x in open(VIOLATIONS)] if os.path.exists(VIOLATIONS) else []
    check('假服务端：全部用例里引擎发出的 lark-cli argv 都符合严格参数规格（违规计 FAIL）', v == EXPECTED_VIOLATIONS, v[:5])


# ---------------------------------------------------------------- golden

def t_golden():
    allow_missing = '--allow-missing-golden' in sys.argv
    allow_unverified = '--allow-unverified-lark' in sys.argv
    tgz = os.path.join(G, 'inputs', 'smoke-site.tgz')
    if not os.path.isfile(tgz):
        if allow_missing:
            skip('golden smoke-site 输入存在', f'找不到 {tgz}（--allow-missing-golden）', allowed=True)
        else:
            check('golden smoke-site 输入存在', False, f'找不到 {tgz}')
        return
    root = os.path.join(BASE, 'golden'); os.makedirs(root)
    with tarfile.open(tgz) as t:
        t.extractall(root, filter='data') if sys.version_info >= (3, 12) else t.extractall(root)
    d = os.path.join(root, 'site')
    pack = os.path.join(DS, 'types', 'presales-site')
    brief_p = os.path.join(d, 'brief.json')
    brief = json.load(open(brief_p))
    brief['lark_folder'] = {'pending_reason': '自测：golden dry-run', 'path': 'DocPublishSelftest/SmokeSite'}
    json.dump(brief, open(brief_p, 'w'), ensure_ascii=False, indent=2)
    for f in ('qa-result.json', 'qa-report.md'):
        if os.path.exists(os.path.join(d, f)): os.remove(os.path.join(d, f))

    def step(name, cmd, ok_codes=(0,), timeout=600, env=None):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        check(f'golden：{name}（退出码 {r.returncode}）', r.returncode in ok_codes, (r.stdout + r.stderr)[-600:])
        return r
    step('run_state init', [PY, RS, d, 'init', '--type', 'presales-site', '--mode', 'new', '--pack', pack])
    step('D0', [PY, RS, d, 'pass-gate', '--gate', 'D0', '--pack', pack])
    open(os.path.join(d, 'outline.md'), 'w').write('# 骨架\n\n① 骨架沿用 golden 快照\n   A 沿用\n')
    step('decide ①', [PY, RS, d, 'decide', '--key', '①', '--value', 'A 沿用', '--pack', pack])
    step('D1', [PY, RS, d, 'pass-gate', '--gate', 'D1', '--evidence', '自测：①A', '--pack', pack])
    step('D2 waive（golden 输入无计价脚本输入）', [PY, RS, d, 'waive-gate', '--gate', 'D2', '--reason', '自测：golden 快照已含 pricing 产物', '--by', 'doc-publish 自测', '--pack', pack])
    step('doc-qa', [PY, os.path.join(SK, 'doc-qa', 'scripts', 'qa.py'), d, '--type', 'presales-site', '--pack', pack], ok_codes=(0, 3))
    rr = step('doc-render（PDF + 飞书 XML）', [PY, os.path.join(SK, 'doc-render', 'scripts', 'render.py'), d, '--pack', pack], ok_codes=(0, 3), timeout=900)
    qa = json.load(open(os.path.join(d, 'qa-result.json'))) if os.path.exists(os.path.join(d, 'qa-result.json')) else {}
    rj = json.load(open(os.path.join(d, 'out', 'render.json'))) if os.path.exists(os.path.join(d, 'out', 'render.json')) else {}
    must_layout = [x for x in rj.get('layout_issues', []) if x.get('severity') == '必改']
    if qa.get('must_fix') == 0 and not must_layout:
        step('D3 pass', [PY, RS, d, 'pass-gate', '--gate', 'D3', '--evidence', '自测：golden 无 Codex 轮次', '--pack', pack])
    else:
        print(f'  golden：qa must_fix={qa.get("must_fix")}，版式必改 {len(must_layout)} 条 → D3 waive')
        step('D3 waive', [PY, RS, d, 'waive-gate', '--gate', 'D3', '--reason', f'自测：golden must_fix={qa.get("must_fix")} 版式必改={len(must_layout)}', '--by', 'doc-publish 自测', '--pack', pack])
    real_exe = shutil.which('lark-cli')
    real = real_exe and '--no-real-lark' not in sys.argv
    unverified = skip if allow_unverified else (lambda n, w: check(n, False, w))
    if real:
        clean = {k: v for k, v in os.environ.items() if k.upper() not in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')}
        for cmd, flags in ((['docs', '+script'], ['--as', '--command', '--content']), (['drive', 'files', 'list'], ['--as', '--params']),
                           (['drive', '+create-folder'], ['--as', '--name', '--folder-token']), (['docs', '+create'], ['--as', '--doc-format', '--content', '--parent-token']),
                           (['docs', '+update'], ['--as', '--doc', '--command', '--doc-format', '--content']), (['drive', '+list-comments'], ['--as', '--token', '--type', '--solved-status', '--page-token']),
                           (['docs', '+fetch'], ['--as', '--doc'])):
            r = subprocess.run([real_exe] + cmd + ['--help'], capture_output=True, text=True, env=clean, timeout=60)
            missing = [f for f in flags if f not in r.stdout + r.stderr]
            name = f'真实 lark-cli {" ".join(cmd)} --help 含引擎用到的参数 {flags}'
            if r.returncode == 0 and not missing:
                check(name + '（已验证）', True)
            else:
                unverified(name, f'未验证：退出码 {r.returncode}，缺 {missing}')
        guard_dir = os.path.join(BASE, 'guardbin'); os.makedirs(guard_dir)
        gl = os.path.join(guard_dir, 'calls.jsonl')
        open(os.path.join(guard_dir, 'lark-cli'), 'w').write(f'''#!{PY}
import json, os, sys
a = sys.argv[1:]
open({gl!r}, 'a').write(json.dumps(a, ensure_ascii=False) + '\\n')
READ = [['docs', '+script'], ['drive', 'files', 'list'], ['drive', '+list-comments'], ['docs', '+fetch']]
if not any(a[:len(r)] == r for r in READ):
    sys.stderr.write('guard: 自测禁止写命令 ' + ' '.join(a[:2])); sys.exit(99)
os.execv({real_exe!r}, [{real_exe!r}] + a)
''')
        os.chmod(os.path.join(guard_dir, 'lark-cli'), 0o755)
        env = dict(os.environ, PATH=guard_dir + os.pathsep + os.environ.get('PATH', ''))
    else:
        skip('真实 lark-cli 只读与 --help 参数核对', '--no-real-lark 或本机没有 lark-cli')
        env = lark_env({'folders': {'': []}})
    r = subprocess.run([PY, PUB, d, '--pack', pack, '--allow-new-project-folder'], capture_output=True, text=True, env=env, timeout=300)
    o = jout(r.stdout)
    label = '真实 lark-cli 只读' if real else '假 lark-cli'
    if real and r.returncode == 7:
        unverified(f'golden：publish dry-run（{label}）', f'lark-cli 读命令失败，未验证：{o.get("lark_error") or o.get("message")}')
    else:
        check(f'golden：publish dry-run（{label}）退出码 0', r.returncode == 0, (r.stdout + r.stderr)[-900:])
    if real:
        used = [json.loads(x) for x in open(gl)] if os.path.exists(gl) else []
        check('golden：真实 lark-cli 只收到读命令', used and all(u[:2] in (['docs', '+script'], ['drive', 'files'], ['drive', '+list-comments'], ['docs', '+fetch']) for u in used), used)
    if r.returncode == 0:
        rec = dry_rec(d)
        pdf = [x for x in rec['archive'] if x['role'] == 'pdf']
        check('golden：published.json 过 schema', not schema_errors(rec), schema_errors(rec))
        check('golden：PDF 归档名 = render.json PDF 名（售前命名规则）', pdf and os.path.basename(pdf[0]['path']) == os.path.basename(rj['pdf']['path']), (pdf, rj.get('pdf')))
        check('golden：计划新建 DocPublishSelftest/SmokeSite 并新建文档', [x['name'] for x in rec['plan']['folders_to_create']] == ['DocPublishSelftest', 'SmokeSite'] and rec['plan']['writes'][-1][:2] == ['docs', '+create'], rec['plan'])
        print(f'  golden：PDF {pdf[0]["path"] if pdf else None}；画板 {o.get("whiteboards_expected")}、图片 {o.get("images_expected")}；D3 {rec["gate_d3"]}；新鲜度 {rec["freshness_check"]}；render 退出码 {rr.returncode}')


def main():
    for t in (t_dry_run, t_hash, t_d3, t_create_apply, t_overwrite_token, t_exit10, t_account2, t_folders, t_hooks, t_write_no_retry,
              t_state_machine, t_token_trust, t_recovery, t_global_lock, t_manifest, t_xml_guard, t_verify_and_guards, t_accept3, t_final, t_business_words):
        try:
            t()
        except Exception as ex:
            import traceback; traceback.print_exc()
            check(f'{t.__name__} 未抛异常', False, f'{type(ex).__name__}: {ex}')
    if FAST:
        skip('golden smoke-site', '--fast 显式跳过')
    else:
        try:
            t_golden()
        except Exception as ex:
            import traceback; traceback.print_exc()
            check('t_golden 未抛异常', False, f'{type(ex).__name__}: {ex}')
    # 测试用例导出电子表格（W3-G，独立测试文件，主代理接线）
    import subprocess as _sp
    _r = _sp.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test_export_cases_sheet.py')], capture_output=True, text=True)
    check('export_cases_sheet：test_export_cases_sheet.py ALL PASS', _r.returncode == 0 and 'ALL PASS' in _r.stdout, (_r.stdout + _r.stderr)[-2000:])
    t_fake_violations()
    verdict = f'FAILED {len(fails)}' if fails else (f'INCOMPLETE（关键契约 SKIP {len(critical_skips)}，不算通过）' if critical_skips else 'ALL PASS')
    print(f'\n{verdict}；SKIP {len(skips)}{"：" + "、".join(skips) if skips else ""}；临时目录 {BASE}')
    if '--keep' not in sys.argv and not fails:
        shutil.rmtree(BASE, ignore_errors=True)
    return 1 if fails else (2 if critical_skips else 0)


if __name__ == '__main__':
    sys.exit(main())
