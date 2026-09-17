#!/usr/bin/env python3
"""doc-shared 自测（离线，不写飞书，不改 doc-shared 与 presales-* 下任何文件；临时目录在系统 tmp）。
用法：run_tests.py [--keep]"""
import ast, copy, importlib.util, json, os, shutil, subprocess, sys, tempfile, time

H = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(H)
SCRIPTS = os.path.join(ROOT, 'scripts')
SKILLS = os.path.dirname(ROOT)
PY = sys.executable
sys.dont_write_bytecode = True
sys.path.insert(0, SCRIPTS)
import validate  # noqa: E402
import tokens as tk  # noqa: E402

fails, skips = [], []
BASE = tempfile.mkdtemp(prefix='doc-shared-tests-')


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:500]}]' if detail and not cond else ''))
    if not cond: fails.append(name)


def skip(name, why):
    print(f'SKIP {name}（{why}）'); skips.append(name)


def run(args, cwd=None, env=None):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, env=env, timeout=180)
    return r.returncode, r.stdout, r.stderr


def jout(o):
    try: return json.loads(o)
    except Exception: return {}


def verrs(kind, data, base=None):
    return validate.validate_data(kind, data, base)[0]


def dump(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f: json.dump(data, f, ensure_ascii=False, indent=2)


# ---------- 0. DocMark 解析器（tests/test_docmark_parse.py，与 doc-render 自测同一份）----------
import test_docmark_parse  # noqa: E402
fails += ['docmark：' + x for x in test_docmark_parse.run(verbose=True)]

# ---------- 1. schema 与校验器 ----------
schema_files = sorted(os.listdir(os.path.join(ROOT, 'schemas')))
check('schemas 覆盖 doc、pack、run-state、render、qa-result', set(validate.KINDS.values()) <= set(schema_files), schema_files)
for f in schema_files:
    s = json.load(open(os.path.join(ROOT, 'schemas', f)))
    extra = validate.schema_keywords(s) - validate.SUPPORTED
    check(f'schema {f} 只用校验器支持的关键字', not extra, sorted(extra))

S = {"type": "object", "required": ["a"], "additionalProperties": False,
     "properties": {"a": {"oneOf": [{"type": "integer"}, {"type": "string", "pattern": "^x"}]}, "b": {"$ref": "#/$defs/n"}},
     "$defs": {"n": {"type": "number", "minimum": 0}}}
check('校验器：oneOf 恰好满足一个时通过', not validate.check({"a": 1}, S, S) and not validate.check({"a": "xy"}, S, S))
check('校验器：oneOf 一个都不满足时报错', bool(validate.check({"a": "y"}, S, S)))
check('校验器：布尔值不算整数', bool(validate.check({"a": True}, S, S)))
check('校验器：$ref 与 minimum 生效', bool(validate.check({"a": 1, "b": -1}, S, S)))
check('校验器：additionalProperties false 拦未知字段', any('不允许' in m for _, m in validate.check({"a": 1, "z": 1}, S, S)))
try:
    validate.check({}, {"format": "date"}, {}); unsupported_raises = False
except ValueError:
    unsupported_raises = True
check('校验器：遇到不支持的关键字直接报错而不是静默忽略', unsupported_raises)

# ---------- 2. doc.json ----------
DOC = {"schema_version": "1", "type": "prd", "title": "登录改版 PRD", "project": "demo", "version": "1.0", "date": "2026-09-15",
       "status": "draft", "audience": "internal", "brand": "internal", "language": "zh-CN", "owner": "张三",
       "reviewers": [{"name": "李四", "role": "技术负责人", "decision": "pending"}],
       "related_docs": [{"type": "tech-spec", "path": "../tech-spec-login-v1.0", "role": "references", "title": "登录改版设计"}],
       "revision_history": [{"version": "1.0", "date": "2026-09-15", "author": "张三", "summary": "初稿"}],
       "lark_folder": {"token": "fldcnAbCdEf123456", "path": "Demo/PRD"}, "extra": {"problem": "登录转化低"}}
check('doc：完整正例通过', not verrs('doc', DOC), verrs('doc', DOC))
d = copy.deepcopy(DOC); d['lark_folder'] = {"pending_reason": "项目文件夹待建", "path": "Demo/PRD"}
check('doc：lark_folder 待定写法（pending_reason + path）通过', not verrs('doc', d), verrs('doc', d))
d = copy.deepcopy(DOC); d['brand'] = 'cyberklick'
check('doc：audience 与品牌档案不一致给警告', bool(validate.validate_data('doc', d)[1]))
d = copy.deepcopy(DOC); d['reviewers'] = ['王敏（研发）', {"name": "刘洋", "decision": "approved"}]; d['revision_history'][0]['version'] = 'v1.0'
check('doc：评审人可写字符串、修订记录版本可带 v 前缀（且不误报缺当前版本）', not verrs('doc', d) and not validate.validate_data('doc', d)[1], validate.validate_data('doc', d))
d = copy.deepcopy(DOC); d['version'] = '1.1'
check('doc：修订记录缺当前版本给警告', any('v1.1' in w for w in validate.validate_data('doc', d)[1]))
for name, mut, path in [
    ('缺 lark_folder', lambda d: d.pop('lark_folder'), '$.lark_folder'),
    ('status 非法', lambda d: d.update(status='done'), '$.status'),
    ('version 带 v 前缀', lambda d: d.update(version='v1.0'), '$.version'),
    ('lark_folder 同时写 token 与 pending_reason', lambda d: d['lark_folder'].update(pending_reason='x'), '$.lark_folder'),
    ('未知顶层字段（类型包字段必须放 extra）', lambda d: d.update(line='site'), '$.line'),
    ('品牌档案不存在', lambda d: d.update(brand='nobrand'), '$.brand'),
    ('修订记录缺 summary', lambda d: d['revision_history'][0].pop('summary'), 'summary'),
    ('日期格式错', lambda d: d.update(date='2026/09/15'), '$.date'),
    ('related_docs 缺 path', lambda d: d['related_docs'][0].pop('path'), '$.related_docs[0].path'),
    ('related_docs 用旧字段 relation', lambda d: d['related_docs'][0].update(relation='references'), '$.related_docs[0].relation'),
    ('related_docs role 非小写下划线', lambda d: d['related_docs'][0].update(role='Source-PRD'), '$.related_docs[0].role'),
    ('related_docs 缺 role（2026-09-15 契约第二轮定为必填）', lambda d: d['related_docs'][0].pop('role'), '$.related_docs[0].role'),
]:
    d = copy.deepcopy(DOC); mut(d); e = verrs('doc', d)
    check(f'doc 反例：{name}', any(path in p for p, _ in e), e)

# ---------- 3. 类型包 ----------
TEMPLATE = os.path.join(ROOT, 'types', '_template')
c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), TEMPLATE])
check('pack：types/_template 通过 validate.py', c == 0, o + e)
spec = importlib.util.spec_from_file_location('tpl_rules', os.path.join(TEMPLATE, 'qa_rules.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
check('pack：_template 的 qa_rules.check 空实现返回 []', mod.check(None, None) == [])
skel_ids = [x['id'] for x in json.load(open(os.path.join(TEMPLATE, 'pack.json')))['skeleton']]
skel_md = open(os.path.join(TEMPLATE, 'skeleton.md')).read()
check('pack：_template skeleton.md 与 pack.json 章节 id 一致', all(f'| {i} |' in skel_md for i in skel_ids), skel_ids)

TYPES = os.path.join(BASE, 'types'); DEMO = os.path.join(TYPES, 'demo')
shutil.copytree(TEMPLATE, DEMO, ignore=shutil.ignore_patterns('__pycache__'))
PJ = json.load(open(os.path.join(DEMO, 'pack.json'))); PJ['id'] = 'demo'; dump(os.path.join(DEMO, 'pack.json'), PJ)
c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), DEMO])
check('pack：复制 _template 改 id 后通过（新类型扩展流程第 1 步）', c == 0, o + e)
open(os.path.join(DEMO, 'bad_rules.py'), 'w').write('def check(doc):\n    return []\n')
dump(os.path.join(DEMO, 'glossary.json'), {"测试用例": ["测试案例"]})
p = copy.deepcopy(PJ); p['qa']['glossary'] = 'glossary.json'
check('pack：术语表可写包内 JSON 文件路径', not verrs('pack', p, DEMO), verrs('pack', p, DEMO))
for name, mut, path in [
    ('skeleton 为空', lambda p: p.update(skeleton=[]), '$.skeleton'),
    ('章节 id 重复', lambda p: p['skeleton'].append(dict(p['skeleton'][0])), '$.skeleton'),
    ('钩子占位符不在白名单', lambda p: p['hooks'].update(pre_qa={"command": ["{python}", "x.py", "{home}"], "desc": "d"}), '$.hooks.pre_qa'),
    ('qa 规则文件不存在', lambda p: p['qa'].update(rules_md='nope.md'), '$.qa.rules_md'),
    ('qa_rules.py 没有 check(doc, ctx)', lambda p: p['qa'].update(rules_py='bad_rules.py'), '$.qa.rules_py'),
    ('编号实体正则无效', lambda p: p['numbering']['entities'].append({"kind": "req", "label": "需求", "pattern": "REQ-("}), '$.numbering.entities[0].pattern'),
    ('include 白名单越出运行目录', lambda p: p.update(include_allow=['../x.md']), '$.include_allow[0]'),
    ('封面变体非法', lambda p: p.update(cover='fancy'), '$.cover'),
    ('D2 命令缺 desc', lambda p: p['gates'].update(D2={"command": ["true"]}), '$.gates.D2'),
    ('品牌档案不存在', lambda p: p.update(brand_profile='nobrand'), '$.brand_profile'),
    ('术语表文件不存在', lambda p: p['qa'].update(glossary='nope.json'), '$.qa.glossary'),
    ('inputs 写成字符串（须结构化，D0 才能检查）', lambda p: p.update(inputs=['用户问题与证据']), '$.inputs[0]'),
    ('skeleton 写成文件路径（须结构化，S1 才能检查）', lambda p: p.update(skeleton='skeleton.md'), '$.skeleton'),
]:
    p = copy.deepcopy(PJ); mut(p); e = verrs('pack', p, DEMO)
    check(f'pack 反例：{name}', any(path in x for x, _ in e), e)

# ---------- 3b. 类型包 modes（项目类型变体） ----------
S0 = PJ['skeleton'][0]['id']
REQ = next((s['id'] for s in PJ['skeleton'] if s.get('required')), None)
OPT = next((s['id'] for s in PJ['skeleton'] if not s.get('required') and s['id'] != S0), None)
MODES = {"field": "site.project_type", "default": "base", "items": [
    {"id": "base", "name": "基础"},
    {"id": "alt", "name": "变体", "aliases": ["0-1"], "skeleton_patch": {S0: {"title": "替换标题", "must_answer": ["替换问题"]}},
     "skeleton_insert": [{"after": S0, "section": {"id": "mode-extra", "title": "插入章节", "required": True}},
                         {"after": "mode-extra", "section": {"id": "mode-extra2", "title": "插入章节二", "required": False}}],
     "forbidden_terms": ["301"], "templates": ["skeleton.md"]}]}
p = copy.deepcopy(PJ); p['modes'] = copy.deepcopy(MODES)
check('pack：modes 正例通过', not verrs('pack', p, DEMO), verrs('pack', p, DEMO))
rs = validate.resolve_skeleton(p, 'alt')
check('pack：resolve_skeleton 按 mode 打补丁（改标题、链式插入、不改原 pack）',
      rs[0]['title'] == '替换标题' and [s['id'] for s in rs[1:3]] == ['mode-extra', 'mode-extra2'] and p['skeleton'][0]['title'] != '替换标题', [s['id'] for s in rs])
p2 = copy.deepcopy(p); p2['modes']['items'][1]['skeleton_insert'] = [{"after": S0, "section": {"id": "x1", "title": "一", "required": False}}, {"after": S0, "section": {"id": "x2", "title": "二", "required": False}}]
check('pack：同一锚点的多个插入保持声明顺序', [s['id'] for s in validate.resolve_skeleton(p2, 'alt')[1:3]] == ['x1', 'x2'])
check('pack：resolve_skeleton 默认 mode 与别名', validate.resolve_skeleton(p) == p['skeleton'] and validate.resolve_skeleton(p, '0-1') == rs)
for name, mut, path in [
    ('modes.default 不在 items 里', lambda m: m.update(default='nope'), '$.modes.default'),
    ('mode id 重复', lambda m: m['items'].append({"id": "base", "name": "重复"}), '$.modes.items'),
    ('补丁引用不存在的章节', lambda m: m['items'][1]['skeleton_patch'].update(nope={"title": "x"}), '$.modes.items[1].skeleton_patch'),
    ('插入位置章节不存在', lambda m: m['items'][1]['skeleton_insert'][0].update(after='nope'), '$.modes.items[1].skeleton_insert[0].after'),
    ('插入章节 id 与基础骨架重复', lambda m: m['items'][1]['skeleton_insert'][0]['section'].update(id=S0), '$.modes.items[1].skeleton_insert[0].section.id'),
    ('mode 删除必备章节', lambda m: m['items'][1].update(skeleton_remove=[REQ]), '$.modes.items[1].skeleton_remove[0]'),
    ('mode 模板文件不存在', lambda m: m['items'][1].update(templates=['nope.md']), '$.modes.items[1].templates[0]'),
    ('插入位置是本 mode 删除的章节', lambda m: (m['items'][1].update(skeleton_remove=[OPT]), m['items'][1]['skeleton_insert'][0].update(after=OPT)) if OPT else m.update(default='nope'), '$.modes.items[1].skeleton_insert[0].after' if OPT else '$.modes.default'),
    ('补丁里出现未知字段（只能改标题、别名、必答问题）', lambda m: m['items'][1]['skeleton_patch'][S0].update(required=False), '$.modes'),
    ('modes 缺 field', lambda m: m.pop('field'), '$.modes'),
]:
    p = copy.deepcopy(PJ); p['modes'] = copy.deepcopy(MODES); mut(p['modes']); e = verrs('pack', p, DEMO)
    check(f'pack 反例：{name}', any(path in x for x, _ in e), e)

# ---------- 3c. presales-site modes 与组织级 QMS 章 ----------
import re  # noqa: E402
SITE = json.load(open(os.path.join(ROOT, 'types', 'presales-site', 'pack.json')))
check('presales-site：resolve_mode 取值、别名、缺省、旧写法 migration',
      validate.resolve_mode(SITE, {'site': {'project_type': 'greenfield'}}) == 'greenfield' and validate.resolve_mode(SITE, {'site': {'project_type': '0-1'}}) == 'greenfield'
      and validate.resolve_mode(SITE, {}) == 'rebuild' and validate.resolve_mode(SITE, {'site': {'migration': True}}) == 'migration'
      and validate.resolve_mode({'skeleton': []}, {}) is None)
try:
    validate.resolve_mode(SITE, {'site': {'project_type': 'new'}}); bad_mode_raised = False
except validate.ModeError:
    bad_mode_raised = True
check('presales-site：未知 project_type 抛 ModeError，不静默回落', bad_mode_raised)
for mid, first, extra in [('rebuild', '01 背景与目标', None), ('greenfield', '01 业务与资产盘点', None), ('migration', '01 背景与目标', 'data-migration')]:
    sk = validate.resolve_skeleton(SITE, mid); ids = [s['id'] for s in sk]
    check(f'presales-site：{mid} 骨架首章与 QMS 章（必备、在最后）', sk[0]['title'] == first and ids[-1] == 'qms' and sk[-1]['required'] and (extra is None or (extra in ids and ids.index(extra) == ids.index('solution') + 1)), ids)
company = open(os.path.join(ROOT, 'types', 'presales-site', 'samples', 'smokesite', 'sections', 'company.md')).read()
qms_text = open(os.path.join(ROOT, 'brand', 'org', 'sections', 'qms.md')).read()
def visible(s): return re.sub(r'<!--.*?-->', '', s, flags=re.S)
check('presales-site：greenfield 禁词不误伤股票代码、QMS 章与 0-1 模板无命中',
      not validate.forbidden_hits(SITE, 'greenfield', visible(company)) and not validate.forbidden_hits(SITE, 'greenfield', visible(qms_text))
      and not validate.forbidden_hits(SITE, 'greenfield', visible(open(os.path.join(ROOT, 'types', 'presales-site', 'templates', 'modes', 'greenfield.md')).read())))
check('presales-site：greenfield 禁词命中「301 跳转」、rebuild 不查', bool(validate.forbidden_hits(SITE, 'greenfield', '上线后做 301 跳转')) and not validate.forbidden_hits(SITE, 'rebuild', '上线后做 301 跳转'))
p = copy.deepcopy(SITE); p['modes']['items'][1]['forbidden_terms'] = ['301(']
check('pack 反例：mode 禁词正则无效', any('forbidden_terms' in x for x, _ in verrs('pack', p, os.path.join(ROOT, 'types', 'presales-site'))))
p = copy.deepcopy(SITE); p['modes']['items'][2]['aliases'] = ['重构']
check('pack 反例：mode 别名与其他 mode 重复', any('aliases' in x for x, _ in verrs('pack', p, os.path.join(ROOT, 'types', 'presales-site'))))
# 组织级 QMS 章：复制进临时运行目录后 include 与两张图可解析
import docmark_parse as dmp  # noqa: E402
QRUN = os.path.join(BASE, 'qms-run'); os.makedirs(os.path.join(QRUN, 'sections')); os.makedirs(os.path.join(QRUN, 'figures'))
shutil.copy(os.path.join(ROOT, 'brand', 'org', 'sections', 'qms.md'), os.path.join(QRUN, 'sections', 'qms.md'))
for f in os.listdir(os.path.join(ROOT, 'brand', 'org', 'sections', 'figures')):
    shutil.copy(os.path.join(ROOT, 'brand', 'org', 'sections', 'figures', f), os.path.join(QRUN, 'figures', f))
open(os.path.join(QRUN, 'doc.md'), 'w').write('# QMS 引用测试\n\n## 质量管理体系（QMS） {#sec:qms}\n\n<!-- include: sections/qms.md -->\n')
for tid in ('presales-site', 'tech-spec', 'test-plan'):
    pk = json.load(open(os.path.join(ROOT, 'types', tid, 'pack.json')))
    qd = dmp.parse_file(QRUN, 'doc.md', pack=pk)
    srcs = sorted(f['src'] for f in qd.figures)
    check(f'QMS 章：{tid} 白名单下 include 成功、两张图与六张表可解析',
          [i['status'] for i in qd.includes] == ['ok'] and srcs == ['figures/qms-12-gates.fig.json', 'figures/qms-risk-loop.fig.json'] and len(qd.tables) == 6, (qd.includes, srcs, len(qd.tables)))
    want_req = tid == 'presales-site'
    check(f'QMS 章：{tid} pack.json org_sections 登记组织级 qms.md（required={want_req}），templates 不再写包外路径',
          [(x['id'], x['path'], x['required']) for x in pk.get('org_sections', [])] == [('qms', 'brand/org/sections/qms.md', want_req)]
          and not any('qms.md' in t for t in pk.get('templates', [])) and os.path.isfile(os.path.join(ROOT, 'brand', 'org', 'sections', 'qms.md')), pk.get('org_sections'))
TPL = open(os.path.join(ROOT, 'types', 'presales-site', 'templates', 'doc.md')).read()
cm = TPL.split('<!-- table: 竞品能力对比 -->', 1)[1].strip().splitlines()[0]
check('presales-site 模板：竞品能力矩阵首列维度、第二列我方现状（0-1 写我方新站起点）、其后竞品', [c.strip() for c in cm.strip('|').split('|')][:3] == ['维度', '我方现状（0-1 项目写：我方新站起点）', '{竞品 A}'], cm)
MIG = [s for s in validate.resolve_skeleton(SITE, 'migration') if s['id'] == 'data-migration'][0]
check('presales-site：migration 插入章必答评价（Review）迁 / 不迁 / 部分迁移及原因、单独计入', any('评价（Review）' in x and '原因' in x for x in MIG['must_answer']) and any('含评价迁移' in x for x in MIG['must_answer']))
check('presales-site 内容库：0-1 地基片段不写「一次做对」式承诺', '一次做对' not in open(os.path.join(ROOT, 'types', 'presales-site', 'content', 'seo-foundation-greenfield.md')).read())
RA = open(os.path.join(ROOT, 'types', 'presales-site', 'content', 'reindex-answer.md')).read()
check('presales-site 内容库：重新收录答案不写「不会清零 / 不需要重新收录 / 净提升 / 一次做对」式承诺，写验证方式', not any(w in RA for w in ('不会清零', '不需要重新收录', '净提升', '一次做对', '零风险')) and 'GSC' in RA and '通常' in RA)
PS = os.path.join(SKILLS, 'presales-shared', 'packs', 'site')
MA = open(os.path.join(PS, 'templates', 'migration-addon.md')).read()
WBS = open(os.path.join(PS, 'wbs-library.csv')).read().splitlines()
check('迁移附加章：迁移范围含评价（Review），写迁 / 不迁 / 部分迁移及原因，评价单列 W33', '评价（Review）' in MA and '部分迁移' in MA and '原因' in MA and 'W33' in MA)
check('WBS：W33 评价（Review）迁移单独一行、仅迁移项目', any(r.startswith('W33,M-MIGRATE,评价（Review）迁移') and '仅迁移项目' in r for r in WBS))
for name, q in [('阶段质量门', '门 ①'), ('付款对齐 40/30/30', '| 签约启动 | 40% |'), ('邮件留痕七节点', '| 生产事件通报与 RCA |'), ('Hypercare 免费', '保障期 Hypercare 内，全部级别'), ('风险表互相引用', '商务条款中的「风险与前置依赖」表即风险登记册的初版')]:
    check(f'QMS 章内容：{name}', q in qms_text)

# ---------- 3d. 契约补丁（W3-E）：org_sections、triggers、发布约定、brief ----------
p = copy.deepcopy(PJ); p['org_sections'] = [{"id": "qms", "path": "brand/org/sections/qms.md", "required": False, "desc": "质量管理体系"}]; p['triggers'] = ['示例文档', 'Demo']
check('pack：org_sections（可选引用）与 triggers 正例通过', not verrs('pack', p, DEMO), verrs('pack', p, DEMO))
p['org_sections'][0]['required'] = True
check('pack 反例：org_sections required 为真但基础 skeleton 没有同 id 必备章节', any('$.org_sections[0].required' in x for x, _ in verrs('pack', p, DEMO)), verrs('pack', p, DEMO))
p['skeleton'].append({"id": "qms", "title": "质量管理体系", "required": True})
check('pack：org_sections required 为真且 skeleton 有同 id 必备章节时通过', not verrs('pack', p, DEMO), verrs('pack', p, DEMO))
for name, mut, path in [
    ('templates 用 ../../ 引用包外文件', lambda p: p.update(templates=['../../brand/org/sections/qms.md']), '$.templates[0]'),
    ('templates 绝对路径', lambda p: p.update(templates=['/etc/hosts']), '$.templates[0]'),
]:
    p = copy.deepcopy(PJ); mut(p); e = verrs('pack', p, DEMO)
    check(f'pack 反例：{name}', any(path in x and '包目录内' in m for x, m in e), e)
for name, mut, path in [
    ('org_sections 用 .. 越出 brand/org/sections', lambda p: p.update(org_sections=[{"id": "q", "path": "brand/org/sections/../company.json", "required": False}]), '$.org_sections[0].path'),
    ('org_sections 同名前缀目录 sections_evil', lambda p: p.update(org_sections=[{"id": "q", "path": "brand/org/sections_evil/qms.md", "required": False}]), '$.org_sections[0].path'),
    ('org_sections 指向目录', lambda p: p.update(org_sections=[{"id": "q", "path": "brand/org/sections/figures", "required": False}]), '$.org_sections[0].path'),
    ('org_sections 文件不存在', lambda p: p.update(org_sections=[{"id": "q", "path": "brand/org/sections/nope.md", "required": False}]), '$.org_sections[0].path'),
    ('org_sections 绝对路径', lambda p: p.update(org_sections=[{"id": "q", "path": os.path.join(ROOT, 'brand', 'org', 'sections', 'qms.md'), "required": False}]), '$.org_sections[0].path'),
    ('org_sections 旧写法（包目录相对 ../../）', lambda p: p.update(org_sections=[{"id": "q", "path": "../../brand/org/sections/qms.md", "required": False}]), '$.org_sections[0].path'),
    ('org_sections id 重复', lambda p: p.update(org_sections=[{"id": "q", "path": "brand/org/sections/qms.md", "required": False}] * 2), '$.org_sections'),
    ('org_sections 缺 required', lambda p: p.update(org_sections=[{"id": "q", "path": "brand/org/sections/qms.md"}]), '$.org_sections[0].required'),
    ('triggers 空白关键词', lambda p: p.update(triggers=['  ']), '$.triggers[0]'),
    ('triggers 重复', lambda p: p.update(triggers=['PRD', 'PRD']), '$.triggers'),
]:
    p = copy.deepcopy(PJ); mut(p); e = verrs('pack', p, DEMO)
    check(f'pack 反例：{name}', any(path in x for x, _ in e), e)
FAKE = os.path.join(BASE, 'fake-shared'); os.makedirs(os.path.join(FAKE, 'brand', 'org', 'sections'))
open(os.path.join(BASE, 'outside.md'), 'w').write('x'); open(os.path.join(FAKE, 'brand', 'org', 'sections', 'ok.md'), 'w').write('x')
os.symlink(os.path.join(BASE, 'outside.md'), os.path.join(FAKE, 'brand', 'org', 'sections', 'link.md'))
_old_root = validate.ROOT; validate.ROOT = FAKE
try:
    e_link = [x for x in validate._org_sections_errors({'org_sections': [{"id": "l", "path": "brand/org/sections/link.md", "required": False}]})]
    e_ok = [x for x in validate._org_sections_errors({'org_sections': [{"id": "o", "path": "brand/org/sections/ok.md", "required": False}]})]
finally:
    validate.ROOT = _old_root
check('pack 反例：org_sections 符号链接指向目录外被拦（realpath），目录内普通文件通过', bool(e_link) and not e_ok, (e_link, e_ok))

RL = os.path.join(BASE, 'release'); os.makedirs(RL)
def rel_errs(ver, changelog):
    d = os.path.join(RL, f'p{len(os.listdir(RL))}'); os.makedirs(d)
    if changelog is not None: open(os.path.join(d, 'CHANGELOG.md'), 'w').write(changelog)
    return [x for x, _ in validate.release_errors({'version': ver}, d)]
check('发布约定：三段式版本 + 最上面的二级标题通过（v 前缀也认）', rel_errs('1.2.3', '# CHANGELOG\n\n## 1.2.3 — 2026-09-15\n') == [] and rel_errs('2.0.0', '## v2.0.0 - 2026-09-15\n\n## 1.0.0 — 2026-09-01\n') == [])
check('发布约定反例：当前版本标题不在最上面（新版本在上）', 'CHANGELOG.md' in rel_errs('1.0.0', '## 1.1.0 — 2026-09-16\n\n## 1.0.0 — 2026-09-15\n'))
check('发布约定反例：只有一级标题不算版本标题', 'CHANGELOG.md' in rel_errs('1.0.0', '# 1.0.0\n'))
check('发布约定反例：版本标题不带日期', 'CHANGELOG.md' in rel_errs('1.0.0', '## 1.0.0\n'))
check('发布约定反例：非 ASCII 数字（1.2٣.4）', '$.version' in rel_errs('1.2٣.4', '## 1.2٣.4\n'))
check('发布约定反例：两段式版本', '$.version' in rel_errs('1.0', '## 1.0 — 2026-09-15\n'))
check('发布约定反例：带预发布号', '$.version' in rel_errs('1.0.0-rc.1', '## 1.0.0-rc.1\n'))
check('发布约定反例：缺 CHANGELOG.md', 'CHANGELOG.md' in rel_errs('1.0.0', None))
check('发布约定反例：只有相近版本标题（1.0.10 不算 1.0.1；1x0x1 不算）', 'CHANGELOG.md' in rel_errs('1.0.1', '## 1.0.10 — 2026-09-15\n## 1x0x1\n'))
check('发布约定反例：版本号只出现在正文不算标题', 'CHANGELOG.md' in rel_errs('1.0.1', '正文提到 1.0.1\n'))
ND = os.path.join(RL, 'cli'); shutil.copytree(TEMPLATE, ND, ignore=shutil.ignore_patterns('__pycache__', 'CHANGELOG.md'))
c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), ND]); c2, o2, e2 = run([PY, os.path.join(SCRIPTS, 'validate.py'), ND, '--no-release'])
check('发布约定：CLI 默认检查（缺 CHANGELOG 退出 1）、--no-release 跳过、validate_data 不查（引擎运行时不受约束）',
      c == 1 and 'CHANGELOG' in o and c2 == 0 and not verrs('pack', json.load(open(os.path.join(ND, 'pack.json'))), ND), (o, o2))
NJ = os.path.join(RL, 'nonobj'); os.makedirs(NJ); open(os.path.join(NJ, 'pack.json'), 'w').write('[]')
c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), NJ])
check('发布约定：pack.json 不是对象时 CLI 输出 JSON 错误退出 1，不抛异常', c == 1 and jout(o).get('ok') is False and 'Traceback' not in e, (c, o[-300:], e[-300:]))
os.symlink(os.path.join(BASE, 'outside.md'), os.path.join(ND, 'templates', 'link.md'))
PN = json.load(open(os.path.join(ND, 'pack.json')))
e_sym = verrs('pack', dict(PN, templates=['templates/link.md']), ND)
check('pack 反例：templates 经符号链接指向包外被拦（realpath）', any('$.templates[0]' in x and '包目录内' in m for x, m in e_sym), e_sym)
pm = copy.deepcopy(PN); pm['modes'] = copy.deepcopy(MODES); pm['modes']['items'][1]['templates'] = ['../../brand/org/sections/qms.md']
e_mode = verrs('pack', pm, ND)
check('pack 反例：modes.items[].templates 引用包外文件', any('$.modes.items[1].templates[0]' in x and '包目录内' in m for x, m in e_mode), e_mode)

B_DOC = {"title": "登录改版 PRD", "project": "demo", "owner": "张三", "lark_folder": {"token": "fldcnAbCdEf123456", "path": "Demo/PRD"},
         "related_docs": [{"type": "mrd", "path": "../mrd-x-v1.0", "role": "source_mrd"}], "inputs": {"input1": "工单 1842 条", "input4": ""}}
check('brief：doc 分支正例通过、判为 doc_brief、无警告', validate.validate_brief(B_DOC) == ([], []) and validate.brief_branch(B_DOC) == 'doc_brief', validate.validate_brief(B_DOC))
check('brief：validate_data 与按文件名判 kind 接入', validate.BY_NAME.get('brief.json') == 'brief' and validate.KINDS.get('brief') == 'brief.schema.json' and validate.validate_data('brief', B_DOC) == ([], []))
be, bw = validate.validate_brief({"owner": "李四"})
check('brief：改版只写要改字段通过（不设必填），缺 title 等给警告；--strict 算错误', not be and any('title' in w for w in bw) and any('$.title' in x for x, _ in validate.validate_brief({"owner": "李四"}, strict=True)[0]), (be, bw))
PS = {"client": "SmokeSite", "line": "site", "mode": "new", "version": "1.0", "date": "2026-09-15", "currency": "USD", "goal": "冒烟测试",
      "site": {"project_type": "greenfield", "build_path": "Dawn"}, "overview": [{"dimension": "品牌资产", "result": "素材排期未定", "status": "待确认"}],
      "sources": [{"what": "现站实测", "where": "https://example.com", "date": "2026-09-14"}], "lark_folder": {"pending_reason": "待建", "path": "SmokeSite/建站"}}
check('brief：售前分支正例（业务必填齐、site 补充字段）无错无警告，判为 presales_brief', validate.validate_brief(PS) == ([], []) and validate.brief_branch(PS) == 'presales_brief', validate.validate_brief(PS))
be, bw = validate.validate_brief({"site": {"project_type": "greenfield"}})
check('brief：售前片段（只有 site）通过、给严格模式警告', not be and bw, (be, bw))
check('brief：{} 与只有 client 的走 doc 分支；指定 family=presales_brief 时不含售前独有键报错', validate.brief_branch({}) == 'doc_brief' and validate.brief_branch({"client": "X"}) == 'doc_brief'
      and bool(validate.validate_brief({"client": "X"}, family='presales_brief')[0]))
SITE_PACK = json.load(open(os.path.join(ROOT, 'types', 'presales-site', 'pack.json')))
check('brief：--pack 不合 pack.schema 时返回错误，不抛异常', any(x == '--pack' for x, _ in validate.validate_brief(PS, pack={"modes": {"field": "site.project_type"}})[0]))
check('brief：--pack 核对 mode 取值（别名 0-1 通过、空串按默认）', not validate.validate_brief(dict(PS, site={"project_type": "0-1"}), pack=SITE_PACK)[0] and not validate.validate_brief(dict(PS, site={"project_type": ""}), pack=SITE_PACK)[0])
for name, b, kw, path in [
    ('doc 分支字段按 doc.schema 深度校验（status 非法）', dict(B_DOC, status='done'), dict(), '$.status'),
    ('doc 分支 lark_folder 同时写 token 与 pending_reason', dict(B_DOC, lark_folder={"token": "fldcnAbCdEf123456", "pending_reason": "x", "path": "a"}), dict(), '$.lark_folder'),
    ('doc 分支 related_docs role 非小写下划线', dict(B_DOC, related_docs=[{"type": "prd", "path": "../x", "role": "Source-PRD"}]), dict(), '$.related_docs[0].role'),
    ('doc 分支 inputs 值不是字符串', dict(B_DOC, inputs={"input1": 3}), dict(), '$.inputs.input1'),
    ('doc 分支未知字段', dict(B_DOC, bogus=1), dict(), 'bogus'),
    ('售前 line 非法（web）', {"client": "X", "line": "web"}, dict(), 'line'),
    ('售前 line=site 却带 reddit 段', dict(PS, reddit={"brand": "B"}), dict(), '$'),
    ('售前 line=reddit 却带 site 段', dict(PS, line='reddit'), dict(), '$'),
    ('售前 overview 状态非法', dict(PS, overview=[{"dimension": "a", "result": "b", "status": "进行中"}]), dict(), 'status'),
    ('售前 sources 缺 where', dict(PS, sources=[{"what": "a", "date": "2026-09-14"}]), dict(), 'where'),
    ('售前 validity_days 为 0', dict(PS, validity_days=0), dict(), 'validity_days'),
    ('售前未知顶层字段', dict(PS, foo=1), dict(), 'foo'),
    ('售前 lark_folder 按 doc.schema 校验（缺 path）', dict(PS, lark_folder={"pending_reason": "待建"}), dict(), '$.lark_folder'),
    ('售前 project_type 不是已声明 mode（--pack）', dict(PS, site={"project_type": "new"}), dict(pack=SITE_PACK), '$.site.project_type'),
    ('售前严格模式缺 currency', {k: v for k, v in PS.items() if k != 'currency'}, dict(strict=True), '$.currency'),
    ('未知 family', PS, dict(family='nope'), '$'),
]:
    e = validate.validate_brief(b, **kw)[0]
    check(f'brief 反例：{name}', any(path in x or path in m for x, m in e), e)
BF = os.path.join(BASE, 'brief-cli', 'brief.json'); dump(BF, dict(PS, site={"project_type": "new"}))
c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), BF]); c2, o2, e2 = run([PY, os.path.join(SCRIPTS, 'validate.py'), BF, '--pack', os.path.join(ROOT, 'types', 'presales-site')])
check('brief CLI：按文件名判 kind；不给 --pack 不查 mode（退出 0），给 --pack 查出未知 mode（退出 1）', c == 0 and jout(o).get('kind') == 'brief' and c2 == 1 and 'project_type' in o2, (o, o2))
for rel in ['presales/MOBYVOW/site-v4.0/brief.json']:
    fp = os.path.expanduser('~/workspace/' + rel)
    if os.path.exists(fp):
        e, w = validate.validate_brief(json.load(open(fp)), pack=SITE_PACK)
        check(f'brief：真实售前 brief {rel} 通过（只读；旧 brief 无 project_type 只给警告）', not e, e)
    else:
        skip(f'brief：真实售前 brief {rel}', '目录不存在')

# ---------- 4. run-state / render / qa-result 静态正反例 ----------
RS = {"schema_version": "1", "doc_type": "prd", "mode": "new", "stage": "outline", "updated_at": "2026-09-15T10:00:00+08:00",
      "gates": {g: {"status": "pending", "at": None, "evidence": []} for g in validate.GATES},
      "history": [{"at": "2026-09-15T10:00:00+08:00", "action": "init"}]}
check('run-state：正例通过', not verrs('run-state', RS), verrs('run-state', RS))
r = copy.deepcopy(RS); r['gates']['D2']['status'] = 'passed'
check('run-state 反例：D2 已过但 D0、D1 未过（门顺序）', any('$.gates.D2' in p for p, _ in verrs('run-state', r)))
r = copy.deepcopy(RS); r['gates']['D0']['status'] = 'ok'
check('run-state 反例：门状态非法', any('$.gates.D0.status' in p for p, _ in verrs('run-state', r)))
r = copy.deepcopy(RS); r['gates'] = {"G0": "passed"}
check('run-state 反例：旧版 G0–G4 字符串格式不通过', bool(verrs('run-state', r)))

RJ = {"schema_version": "1", "generated_at": "2026-09-15T10:00:00+08:00",
      "renderer": {"name": "doc-render", "version": "0.1", "chrome": "152", "printer": "cdp", "passes": 2},
      "profile": "internal", "cover": "technical", "pdf": {"path": "out/x.pdf", "pages": 12, "bookmarks": 9},
      "toc": [{"level": 1, "number": "1", "title": "摘要", "page": 3}],
      "figures": [{"number": "图 1-1", "caption": "流程", "src": "figures/a.mmd", "engine": "mermaid", "viewbox_width": 1200, "min_font_px": 17, "min_font_pt": 7.31, "page": 4}],
      "tables": [{"number": "表 1-1", "columns": 3, "rows": 5, "has_thead": True}],
      "layout_issues": [], "feishu": {"path": "out/feishu.xml", "whiteboards": 1, "images": 0}}
check('render：正例通过', not verrs('render', RJ), verrs('render', RJ))
r = copy.deepcopy(RJ); r['pdf'] = None; r['feishu'] = None
check('render：只出一端时 pdf / feishu 可为 null', not verrs('render', r), verrs('render', r))
r = copy.deepcopy(RJ); r['figures'][0].pop('min_font_pt')
check('render 反例：图缺等效字号', any('min_font_pt' in p for p, _ in verrs('render', r)))
r = copy.deepcopy(RJ); r['layout_issues'] = [{"rule": "LY4", "severity": "严重", "message": "x"}]
check('render 反例：定级非法', any('severity' in p for p, _ in verrs('render', r)))

QA_LEGACY = {"generated_at": "2026-09-15T04:23:10", "must_fix": 0, "total": 1,
             "issues": [{"rule": "L5", "severity": "建议", "line": 0, "excerpt": "联系人", "message": "brief.json 未填 contact.name"}]}
check('qa-result：旧版产物（无 rule_source）兼容通过', not verrs('qa-result', QA_LEGACY), verrs('qa-result', QA_LEGACY))
q = copy.deepcopy(QA_LEGACY); q['issues'][0]['rule_source'] = 'type'
check('qa-result：新字段 rule_source 通过', not verrs('qa-result', q))
q = copy.deepcopy(QA_LEGACY); q['must_fix'] = 1
check('qa-result 反例：must_fix 与必改条数不一致', any('$.must_fix' in p for p, _ in verrs('qa-result', q)))
q = copy.deepcopy(QA_LEGACY); q['issues'][0]['severity'] = 'high'
check('qa-result 反例：定级非法', any('severity' in p for p, _ in verrs('qa-result', q)))
q = copy.deepcopy(QA_LEGACY); q['issues'][0]['rule_source'] = 'codex'
check('qa-result 反例：rule_source 非法', any('rule_source' in p for p, _ in verrs('qa-result', q)))
moby = os.path.expanduser('~/workspace/presales/MOBYVOW/site-v4.0/qa-result.json')
if os.path.exists(moby):
    c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), moby])
    check('qa-result：真实售前产物 MOBYVOW v4.0 通过（只读）', c == 0, o)
else:
    skip('qa-result：真实售前产物', 'MOBYVOW 目录不存在')

# ---------- 5. 品牌 token ----------
t = json.load(open(os.path.join(ROOT, 'brand', 'tokens.json')))
check('tokens：自检无错误', not tk.selfcheck(t), tk.selfcheck(t))
c, o, e = run([PY, os.path.join(SCRIPTS, 'tokens.py'), '--check'])
check('tokens：brand/generated 与 tokens.json 一致（--check）', c == 0, o + e)
g1, g2 = os.path.join(BASE, 'gen1'), os.path.join(BASE, 'gen2')
run([PY, os.path.join(SCRIPTS, 'tokens.py'), '--out', g1]); run([PY, os.path.join(SCRIPTS, 'tokens.py'), '--out', g2])
check('tokens：生成物确定（两次生成逐字节相同）', all(open(os.path.join(g1, f)).read() == open(os.path.join(g2, f)).read() for f in os.listdir(g1)) and len(os.listdir(g1)) == 4)
tt = copy.deepcopy(t); tt['color']['primary'] = '#000000'; dump(os.path.join(BASE, 'tokens-mod.json'), tt)
c, o, e = run([PY, os.path.join(SCRIPTS, 'tokens.py'), '--check', '--tokens', os.path.join(BASE, 'tokens-mod.json'), '--out', g1])
check('tokens：改了 tokens.json 未重新生成时 --check 退出码 1', c == 1 and 'tokens.css' in o, o)
tt = copy.deepcopy(t); tt['callout']['note']['feishu_bg'] = 'lavender'; dump(os.path.join(BASE, 'tokens-bad.json'), tt)
c, o, e = run([PY, os.path.join(SCRIPTS, 'tokens.py'), '--tokens', os.path.join(BASE, 'tokens-bad.json'), '--out', g1])
check('tokens：飞书非法色名被自检拦截', c == 1 and 'lavender' in o, o)
gen = os.path.join(ROOT, 'brand', 'generated')
css = open(os.path.join(gen, 'tokens.css')).read()
check('tokens：CSS 变量取自 tokens.json', f"--dm-color-primary:{t['color']['primary']};" in css and '--dm-size-figure-min:7pt;' in css)
check('tokens：高亮块类型与 DocMark 一致（note、warn、tip、decision、risk）', set(t['callout']) == {'note', 'warn', 'tip', 'decision', 'risk'})
fc = json.load(open(os.path.join(gen, 'feishu-callouts.json')))['callouts']
check('tokens：note / warn 的飞书配色与旧渲染器一致', fc['note']['background-color'] == 'light-purple' and fc['note']['border-color'] == 'purple' and fc['warn']['background-color'] == 'light-orange' and fc['warn']['border-color'] == 'orange')
check('tokens：等效字号公式（architecture.svg 17px/1200 = 7.31pt；MOBYVOW 12px/1180 < 7pt）', abs(tk.equiv_pt(17, 1200) - 7.31) < 0.01 and tk.equiv_pt(12, 1180) < 7)
check('tokens：1200 宽画布最小 17px、Mermaid 主题字号 17px', tk.min_px_for(7, 1200) == 17 and json.load(open(os.path.join(gen, 'mermaid-theme.json')))['themeVariables']['fontSize'] == '17px')
sp = json.load(open(os.path.join(gen, 'svg-palette.json')))
check('tokens：品牌图字号层级都不低于画布最小字号', min(sp['figure']['font_px'].values()) >= sp['figure']['min_font_px_at_canvas'])
legacy_svgkit = os.path.join(SKILLS, 'presales-publish', 'scripts', 'svgkit.py')
legacy_render = os.path.join(SKILLS, 'presales-publish', 'scripts', 'render.py')
if os.path.exists(legacy_svgkit) and os.path.exists(legacy_render):
    tree = ast.parse(open(legacy_svgkit).read())
    C = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'C')
    legacy = {k: {'stroke': v[0], 'fill': v[1], 'text': v[2]} for k, v in C.items()}
    check('tokens：调色板与售前 svgkit.C 完全一致（读源码，不 import）', legacy == t['palette'], {k: v for k, v in legacy.items() if t['palette'].get(k) != v})
    import re as _re
    rtxt = open(legacy_render).read()
    known = {v.upper() for v in t['color'].values()} | {v.upper() for p in t['palette'].values() for v in p.values()}
    missing = sorted({x.upper() for x in _re.findall(r'#[0-9A-Fa-f]{6}', rtxt)} - known)
    check('tokens：售前渲染器用到的颜色全部登记在 tokens.json', not missing, missing)
    check('tokens：@page 与旧渲染器一致', '@page{size:A4;margin:20mm 14mm 18mm}' in rtxt and '@page{size:A4;margin:20mm 14mm 18mm}' in css)
else:
    skip('tokens：与售前 svgkit / render.py 对照', '售前脚本不存在')

# ---------- 6. 品牌档案与组织资产 ----------
PH = {'brand', 'website', 'logo', 'title', 'subtitle', 'version', 'date', 'party', 'classification', 'doc_no', 'status', 'page', 'pages', 'footer_text', 'disclaimer'}
import re
for f in sorted(os.listdir(os.path.join(ROOT, 'brand', 'profiles'))):
    p = json.load(open(os.path.join(ROOT, 'brand', 'profiles', f)))
    used = set(re.findall(r'\{([a-z_]+)\}', json.dumps({k: p[k] for k in ('header', 'footer', 'disclaimer')}, ensure_ascii=False)))
    ok = p['id'] + '.json' == f and p['audience'] in ('internal', 'external') and p['cover'] in ('marketing', 'technical') and used <= PH
    check(f'品牌档案 {f}：id 与文件名一致、枚举合法、占位符合法', ok, sorted(used - PH))
for key in ('logo', 'logo_opaque', 'logo_dark', 'logo_on_dark'):
    check(f'品牌资产 tokens.brand.{key} 文件存在', os.path.exists(os.path.join(ROOT, 'brand', t['brand'][key])), t['brand'][key])
with open(os.path.join(ROOT, 'brand', t['brand']['logo']), 'rb') as f:
    head = f.read(32)
check('透明底 logo 是带 alpha 的 PNG（IHDR color type 6）', head[:8] == b'\x89PNG\r\n\x1a\n' and head[25] == 6)
legacy_company = os.path.join(SKILLS, 'presales-shared', 'references', 'company.json')
if os.path.exists(legacy_company):
    check('组织口径：brand/org/company.json 与售前原件逐字节一致（复制未走样）', open(legacy_company, 'rb').read() == open(os.path.join(ROOT, 'brand', 'org', 'company.json'), 'rb').read())

# ---------- 7. run_state.py 写回 ----------
ENV = dict(os.environ, DOC_TYPES_DIRS=TYPES)
NOPACK_ENV = dict(os.environ, DOC_TYPES_DIRS='')
RD = os.path.join(BASE, 'run'); os.makedirs(RD)


def rs(rd, *a, env=ENV):
    c, o, e = run([PY, os.path.join(SCRIPTS, 'run_state.py'), rd, *a], env=env)
    return c, jout(o), o + e


def probs(d):
    return ' | '.join(d.get('problems', []) + [d.get('message', '')])


c, d, raw = rs(RD, 'init', '--type', 'demo', '--mode', 'new')
check('run_state：init 写出合法 run-state.json', c == 0 and not verrs('run-state', json.load(open(os.path.join(RD, 'run-state.json')))), raw)
c, d, raw = rs(RD, 'init', '--type', 'demo', '--mode', 'new')
check('run_state：重复 init 拒绝', c == 1, raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D1', '--evidence', '用户：①A')
check('run_state：D0 未过时拒绝 D1', c == 1 and '前序门' in probs(d), raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D0')
check('run_state：缺 doc.json 拒绝 D0', c == 1 and 'doc.json' in probs(d), raw)
doc = copy.deepcopy(DOC); doc['type'] = 'demo'; doc['status'] = 'bogus'; dump(os.path.join(RD, 'doc.json'), doc)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D0')
check('run_state：doc.json 不合法拒绝 D0', c == 1 and 'status' in probs(d), raw)
doc['status'] = 'draft'; doc['extra'] = {}; dump(os.path.join(RD, 'doc.json'), doc)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D0')
check('run_state：类型包必需输入缺失拒绝 D0', c == 1 and 'problem' in probs(d), raw)
doc['extra'] = {'problem': '登录转化低'}; dump(os.path.join(RD, 'doc.json'), doc)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D0', env=NOPACK_ENV)
check('run_state：找不到类型包时拒绝 D0（不静默跳过 inputs 检查）', c == 1 and '找不到类型包' in probs(d), raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D0')
check('run_state：D0 通过', c == 0, raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D1')
check('run_state：D1 无证据拒绝', c == 1 and 'evidence' in probs(d), raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D1', '--evidence', '用户：全部按推荐', '--by', '用户')
check('run_state：D1 缺 outline.md 拒绝（验收⑧）', c == 1 and 'outline.md' in probs(d), raw)
open(os.path.join(RD, 'outline.md'), 'w').write('# 骨架\n\n## 待拍板\n\n① 按下面的骨架开写\n   A ✅ 按此骨架（推荐）\n\n② 术语表纳不纳入\n   A ✅ 纳入\n')
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D1', '--evidence', '用户：全部按推荐', '--by', '用户')
check('run_state：D1 没有拍板记录拒绝（验收⑧）', c == 1 and '拍板记录不足' in probs(d), raw)
rs(RD, 'decide', '--key', '①', '--value', 'A 按此骨架')
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D1', '--evidence', '用户：全部按推荐', '--by', '用户')
check('run_state：D1 拍板记录少于 outline 拍板项数拒绝（1 < 2）', c == 1 and '拍板记录不足' in probs(d), raw)
rs(RD, 'decide', '--key', '②', '--value', 'A 纳入')
for fn in ('outline.md',): os.utime(os.path.join(RD, fn), (time.time() - 100, time.time() - 100))
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D1', '--evidence', '用户：全部按推荐', '--by', '用户')
check('run_state：D1 带证据通过', c == 0, raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D2', '--evidence', 'x')
check('run_state：类型包 D2 为 null 时拒绝 pass、提示 skip', c == 1 and 'skip-gate' in probs(d), raw)
c, d, raw = rs(RD, 'skip-gate', '--gate', 'D2')
check('run_state：skip 无理由拒绝', c == 1, raw)
c, d, raw = rs(RD, 'skip-gate', '--gate', 'D2', '--reason', '类型包无专属门')
check('run_state：D2 skip 通过', c == 0 and d.get('gates', {}).get('D2') == 'skipped', raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'Codex 两轮见 qa-report.md')
check('run_state：缺 qa-result.json 拒绝 D3', c == 1 and 'qa-result.json' in probs(d), raw)
open(os.path.join(RD, 'doc.md'), 'w').write('# 登录改版 PRD\n')
past = time.time() - 100
for fn in ('doc.md', 'doc.json'): os.utime(os.path.join(RD, fn), (past, past))
qa = {"generated_at": "2026-09-15T10:00:00", "must_fix": 1, "total": 1, "issues": [{"rule": "S1", "severity": "必改", "line": 0, "excerpt": "", "message": "缺摘要"}]}
dump(os.path.join(RD, 'qa-result.json'), qa)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'x')
check('run_state：must_fix 不为 0 拒绝 D3', c == 1 and 'must_fix=1' in probs(d), raw)
dump(os.path.join(RD, 'qa-result.json'), {"generated_at": "2026-09-15T10:00:00", "must_fix": 0, "total": 0, "issues": []})
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'x')
check('run_state：缺 out/render.json 拒绝 D3', c == 1 and 'render.json' in probs(d), raw)
rj = copy.deepcopy(RJ); rj['layout_issues'] = [{"rule": "LY4", "severity": "必改", "message": "图 1-1 等效字号 5.2pt"}]
dump(os.path.join(RD, 'out', 'render.json'), rj)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'x')
check('run_state：render.json 有版式必改拒绝 D3', c == 1 and '版式必改' in probs(d), raw)
dump(os.path.join(RD, 'out', 'render.json'), RJ)
future = time.time() + 30
os.utime(os.path.join(RD, 'doc.md'), (future, future))
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'x')
check('run_state：质检之后又改正文时拒绝 D3（结果过期）', c == 1 and '质检之后又改过 doc.md' in probs(d), raw)
qa_m = os.path.getmtime(os.path.join(RD, 'qa-result.json'))
os.utime(os.path.join(RD, 'out', 'render.json'), (qa_m, qa_m))
os.utime(os.path.join(RD, 'doc.md'), (qa_m + 1, qa_m + 1))
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'x')
check('run_state：质检后 1 秒内改正文也拒绝 D3（严格比较，无容差，验收②）', c == 1 and '质检之后又改过 doc.md' in probs(d), raw)
os.utime(os.path.join(RD, 'doc.md'), (past, past)); os.utime(os.path.join(RD, 'outline.md'), (past, past))
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3')
check('run_state：D3 无证据拒绝', c == 1 and 'evidence' in probs(d), raw)
EV = 'Codex terra 与 sol 均 429，降级，见 qa-report.md'
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', EV)
check('run_state：缺 qa-report.md 拒绝 D3（验收⑧）', c == 1 and 'qa-report.md' in probs(d), raw)
open(os.path.join(RD, 'qa-report.md'), 'w').write('# 质检报告\n\n<!-- qa-auto:start -->\n| Q1 | Codex 找茬 证伪 |\n<!-- qa-auto:end -->\n\n## 人工检查\n')
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', EV)
check('run_state：人工区块为空（Codex 字样只在自动区块）拒绝 D3', c == 1 and '人工区块' in probs(d) and '为空' in probs(d), raw)
open(os.path.join(RD, 'qa-report.md'), 'a').write('\n## Codex 找茬与证伪\n\n找茬轮：terra 429、sol 429，降级；本想挑验收标准可核验性。\n')
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', EV)
check('run_state：只有找茬、缺证伪轮记录拒绝 D3', c == 1 and '证伪' in probs(d), raw)
open(os.path.join(RD, 'qa-report.md'), 'a').write('证伪轮：同样 429，降级。\n')
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', 'Codex 两轮做完了')
check('run_state：证据无法定位（没有文件名、没有 qa-report 标题）拒绝 D3', c == 1 and '无法定位' in probs(d), raw)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', '见「Codex 找茬与证伪」')
check('run_state：证据写 qa-report 人工区块标题可定位', c == 0 or '无法定位' not in probs(d), raw)
if c == 0: rs(RD, 'reset-gate', '--gate', 'D3', '--reason', '换证据形式再测')
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D3', '--evidence', EV)
check('run_state：D3 通过', c == 0, raw)
st = json.load(open(os.path.join(RD, 'run-state.json')))
man = st['gates']['D3'].get('source_manifest') or {}
paths = [x['path'] for x in man.get('files') or []]
check('manifest：D3 通过写 source_manifest（sha256、含正文与 doc.json、不含产物与 run-state）', man.get('algorithm') == 'sha256' and 'doc.md' in paths and 'doc.json' in paths
      and 'outline.md' in paths and not any(p.startswith('out/') or p in ('qa-result.json', 'qa-report.md', 'run-state.json') or p.endswith('.lock') for p in paths), man)
check('manifest：run-state.json 带 manifest 仍过 schema', not verrs('run-state', st), verrs('run-state', st))
c, o, e = run([PY, os.path.join(SCRIPTS, 'run_state.py'), RD, 'check-manifest'], env=ENV); dm = jout(o)
check('check-manifest：未改源文件 → 退出 0、差异为空', c == 0 and dm.get('ok') and not (dm.get('added') or dm.get('removed') or dm.get('changed')), o)
doc['lark_folder'] = {"pending_reason": "待建", "path": "Demo/PRD"}; dump(os.path.join(RD, 'doc.json'), doc)
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D4', '--evidence', '用户确认发布')
check('run_state：lark_folder 无 token 拒绝 D4（decisions ⑫A）', c == 1 and 'lark_folder' in probs(d), raw)
doc['lark_folder'] = DOC['lark_folder']; dump(os.path.join(RD, 'doc.json'), doc)
c, o, e = run([PY, os.path.join(SCRIPTS, 'run_state.py'), RD, 'check-manifest'], env=ENV)
check('check-manifest：doc.json 只改 lark_folder → 仍一致（退出 0，写回 token 不算改源）', c == 0, o)
os.utime(os.path.join(RD, 'doc.json'), (past, past))
c, d, raw = rs(RD, 'pass-gate', '--gate', 'D4', '--evidence', '用户：PDF 看过，发 account1，放 Demo/PRD')
check('run_state：D4 通过', c == 0 and d.get('gates', {}).get('D4') == 'passed', raw)
open(os.path.join(RD, 'doc.md'), 'a').write('补一句\n'); os.makedirs(os.path.join(RD, 'data'), exist_ok=True); open(os.path.join(RD, 'data', 'new.csv'), 'w').write('a\n1\n')
c, o, e = run([PY, os.path.join(SCRIPTS, 'run_state.py'), RD, 'check-manifest'], env=ENV); dm = jout(o)
check('check-manifest：改正文、新增数据 → 退出 3，列出 changed 与 added', c == 3 and dm.get('changed') == ['doc.md'] and dm.get('added') == ['data/new.csv'], o)
open(os.path.join(RD, 'doc.md'), 'w').write('# 登录改版 PRD\n'); os.remove(os.path.join(RD, 'data', 'new.csv')); os.rmdir(os.path.join(RD, 'data'))
for fn in ('doc.md', 'doc.json'): os.utime(os.path.join(RD, fn), (past, past))
c, d, raw = rs(RD, 'reset-gate', '--gate', 'D3', '--reason', '改版')
st = json.load(open(os.path.join(RD, 'run-state.json')))
check('run_state：reset-gate D3 让 D3、D4 回到 pending，D2 保持', c == 0 and st['gates']['D3']['status'] == 'pending' and st['gates']['D4']['status'] == 'pending' and st['gates']['D2']['status'] == 'skipped', raw)
check('manifest：reset-gate D3 清掉 source_manifest', 'source_manifest' not in st['gates']['D3'], st['gates']['D3'])
c, o, e = run([PY, os.path.join(SCRIPTS, 'run_state.py'), RD, 'check-manifest'], env=ENV)
check('check-manifest：没有 manifest → 退出 1', c == 1 and 'source_manifest' in o, o)
c, d, raw = rs(RD, 'waive-gate', '--gate', 'D1', '--reason', 'x', '--by', '用户')
check('run_state：D1 不能 waive', c == 1, raw)
c, d, raw = rs(RD, 'waive-gate', '--gate', 'D3', '--reason', '版式检查器未就绪')
check('run_state：waive 缺 --by 拒绝', c == 1, raw)
c, d, raw = rs(RD, 'waive-gate', '--gate', 'D3', '--reason', '版式检查器未就绪', '--by', '用户')
check('run_state：D3 waive 带理由与拍板人通过', c == 0 and d.get('gates', {}).get('D3') == 'waived', raw)
c, d, raw = rs(RD, 'set-stage', 'bogus')
check('run_state：未知阶段拒绝', c == 1, raw)
c, d, raw = rs(RD, 'set-stage', 'qa')
check('run_state：set-stage qa', c == 0 and d.get('stage') == 'qa', raw)
c, d, raw = rs(RD, 'decide', '--key', '①', '--value', 'A 按推荐', '--user-words', '全部按推荐')
c2, o2, e2 = run([PY, os.path.join(SCRIPTS, 'validate.py'), os.path.join(RD, 'run-state.json')])
st = json.load(open(os.path.join(RD, 'run-state.json')))
check('run_state：decide 写入，全程产物仍通过 validate.py，history 完整', c == 0 and c2 == 0 and st['decisions'].get('①') == 'A 按推荐' and len(st['history']) >= 9, o2)
c, d, raw = rs(RD, 'fail-gate', '--gate', 'D2', '--reason', '专属门复核失败')
st = json.load(open(os.path.join(RD, 'run-state.json')))
check('run_state：fail-gate D2 让其后门回到 pending', c == 0 and st['gates']['D2']['status'] == 'failed' and st['gates']['D3']['status'] == 'pending', raw)

# D2 带命令
DEMO2 = os.path.join(TYPES, 'demo2'); shutil.copytree(DEMO, DEMO2)
p2 = copy.deepcopy(PJ); p2['id'] = 'demo2'
p2['gates']['D2'] = {"command": ["{python}", "-c", "import sys; sys.exit(int(open('exit.txt').read()))"], "desc": "专属门示例"}
dump(os.path.join(DEMO2, 'pack.json'), p2)
RD2 = os.path.join(BASE, 'run2'); os.makedirs(RD2)
rs(RD2, 'init', '--type', 'demo2', '--mode', 'new')
doc2 = copy.deepcopy(doc); doc2['type'] = 'demo2'; dump(os.path.join(RD2, 'doc.json'), doc2)
shutil.copy2(os.path.join(RD, 'outline.md'), os.path.join(RD2, 'outline.md'))
rs(RD2, 'pass-gate', '--gate', 'D0'); rs(RD2, 'decide', '--key', '①', '--value', 'A'); rs(RD2, 'decide', '--key', '②', '--value', 'A')
c, d, raw = rs(RD2, 'pass-gate', '--gate', 'D1', '--evidence', 'ok')
check('run_state：RD2 D1 通过（夹具）', c == 0, raw)
c, d, raw = rs(RD2, 'skip-gate', '--gate', 'D2', '--reason', 'x')
check('run_state：类型包声明了 D2 命令时不能 skip', c == 1, raw)
open(os.path.join(RD2, 'exit.txt'), 'w').write('0')
c, d, raw = rs(RD2, 'pass-gate', '--gate', 'D2', '--evidence', '外面跑过了')
check('run_state：类型包声明了 D2 命令时不带 --run 拒绝（即使命令本会通过，验收④）', c == 1 and '--run' in probs(d), raw)
open(os.path.join(RD2, 'exit.txt'), 'w').write('5')
c, d, raw = rs(RD2, 'pass-gate', '--gate', 'D2', '--run', '--evidence', '跑专属门')
check('run_state：D2 命令退出码不在通过码内时拒绝', c == 1 and '退出码 5' in probs(d), raw)
open(os.path.join(RD2, 'exit.txt'), 'w').write('0')
c, d, raw = rs(RD2, 'pass-gate', '--gate', 'D2', '--run', '--evidence', '跑专属门')
check('run_state：D2 命令退出码 0 通过', c == 0, raw)
# D0：文本型必需输入读 brief.json（验收⑧）
DEMO4 = os.path.join(TYPES, 'demo4'); shutil.copytree(DEMO, DEMO4)
p4 = copy.deepcopy(PJ); p4['id'] = 'demo4'
p4['inputs'] = [{"id": "evidence", "desc": "用户问题证据", "required": True}, {"id": "note", "desc": "可选备注", "required": False}]
dump(os.path.join(DEMO4, 'pack.json'), p4)
RD4 = os.path.join(BASE, 'run4'); os.makedirs(RD4)
rs(RD4, 'init', '--type', 'demo4', '--mode', 'new')
doc4 = copy.deepcopy(DOC); doc4['type'] = 'demo4'; dump(os.path.join(RD4, 'doc.json'), doc4)
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：D0 文本型必需输入但没有 brief.json → 拒绝', c == 1 and 'brief.json' in probs(d) and 'evidence' in probs(d), raw)
BRIEF4 = {"title": DOC['title'], "project": DOC['project'], "owner": DOC['owner'], "lark_folder": DOC['lark_folder']}
dump(os.path.join(RD4, 'brief.json'), dict(BRIEF4, inputs={"evidence": "   "}))
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：D0 brief.json inputs 为空白 → 拒绝', c == 1 and 'inputs.evidence' in probs(d), raw)
for bad_brief, label in (([], '顶层是数组'), ("文本", '顶层是字符串'), ({"inputs": ["工单"]}, 'inputs 是数组')):
    dump(os.path.join(RD4, 'brief.json'), bad_brief)
    c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
    check(f'run_state：D0 brief.json {label} → 拒绝（Codex 复核⑧）', c == 1 and ('必须是对象' in probs(d)), raw)
dump(os.path.join(RD4, 'brief.json'), {"inputs": {"evidence": "工单 1842 条"}})
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：D0 brief.json 缺 doc_brief 严格必填（title 等）→ 拒绝（validate_brief strict）', c == 1 and 'brief.schema.json' in probs(d) and 'title' in probs(d), raw)
dump(os.path.join(RD4, 'brief.json'), dict(BRIEF4, inputs={"evidence": "工单 1842 条"}, bogus=1))
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：D0 brief.json 有 schema 外字段 → 拒绝', c == 1 and 'bogus' in probs(d), raw)
dump(os.path.join(RD4, 'brief.json'), dict(BRIEF4, inputs={"evidence": 1842}))
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：D0 brief.json inputs 值不是字符串 → 拒绝', c == 1 and 'evidence' in probs(d), raw)
dump(os.path.join(RD4, 'brief.json'), dict(BRIEF4, inputs={"evidence": "工单 1842 条"}))
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：D0 brief.json inputs 有值 → 通过（可选输入不查）', c == 0, raw)

# source_files：解析器实际引用的隐藏路径并入；未引用的隐藏文件、out/、*.tmp、*.lock、运行锁仍排除（主代理核对 accept3）
import run_state as _rsmod  # noqa: E402
HD = os.path.join(BASE, 'hidden-src'); os.makedirs(os.path.join(HD, 'out'))
hp = copy.deepcopy(PJ); hp['include_allow'] = ['sections/*.md', '.draft/*.md']
hp['features'] = dict(hp.get('features') or {}, data_blocks=True)
dump(os.path.join(HD, 'doc.json'), dict(copy.deepcopy(DOC), type='demo'))
for rel, body in (('.data/t.csv', '项,值\n甲,1\n'), ('.draft/a.md', '<!-- include: .draft/b.md -->\n片段\n'), ('.draft/b.md', '嵌套片段\n'),
                  ('.notes/n.md', '链接目标\n'), ('.junk/unused.md', '没被引用\n'), ('out/.x.md', '产物\n'), ('a.tmp', 'x'), ('b.lock', 'x')):
    os.makedirs(os.path.dirname(os.path.join(HD, rel)) or HD, exist_ok=True); open(os.path.join(HD, rel), 'w', encoding='utf-8').write(body)
open(os.path.join(HD, 'doc.md'), 'w', encoding='utf-8').write('# 隐藏路径\n\n## 背景\n\n<!-- data: .data/t.csv -->\n\n<!-- include: .draft/a.md -->\n\n见[笔记](.notes/n.md#段落)与[外链](https://example.com/x.md)。\n')
files_h = _rsmod.source_files(HD, pack=hp)
check('source_files：并入正文引用的隐藏数据、include（含嵌套）与本地链接', all(x in files_h for x in ('.data/t.csv', '.draft/a.md', '.draft/b.md', '.notes/n.md', 'doc.md', 'doc.json')), files_h)
check('source_files：未引用的隐藏文件、out/、*.tmp、*.lock 仍排除', not any(x in files_h for x in ('.junk/unused.md', 'out/.x.md', 'a.tmp', 'b.lock')), files_h)

# D0 --no-pack 时 brief.json 严格校验照查（Codex brief 复核：之前放在类型包分支内被绕过）
RD5 = os.path.join(BASE, 'run5-nopack'); os.makedirs(RD5)
rs(RD5, 'init', '--type', 'nopack-type', '--mode', 'new', env=NOPACK_ENV)
doc5 = copy.deepcopy(DOC); doc5['type'] = 'nopack-type'; dump(os.path.join(RD5, 'doc.json'), doc5)
dump(os.path.join(RD5, 'brief.json'), {"owner": "只有负责人"})
c, d, raw = rs(RD5, 'pass-gate', '--gate', 'D0', '--no-pack', env=NOPACK_ENV)
check('run_state：--no-pack 时 brief.json 缺 doc_brief 严格必填 → D0 拒绝', c == 1 and 'brief.schema.json' in probs(d) and 'title' in probs(d), raw)
dump(os.path.join(RD5, 'brief.json'), {"title": DOC['title'], "project": DOC['project'], "owner": DOC['owner'], "lark_folder": DOC['lark_folder']})
c, d, raw = rs(RD5, 'pass-gate', '--gate', 'D0', '--no-pack', env=NOPACK_ENV)
check('run_state：--no-pack 时合规 brief.json → D0 通过，checks 记录严格校验通过', c == 0 and any('brief.schema.json' in x for x in (json.load(open(os.path.join(RD5, 'run-state.json')))['gates']['D0'].get('checks') or [])), raw)

import versions  # noqa: E402
check('versions：1.0 = 1.0.0 = v1.0；1.0 < 1.0.1；1.10 > 1.9', versions.same_version('1.0', '1.0.0') and versions.same_version('v1.0', '1.0')
      and versions.compare('1.0', '1.0.1') == -1 and versions.compare('1.10', '1.9') == 1)
bad_v = False
try: versions.parse('1.x')
except ValueError: bad_v = True
check('versions：非法版本抛 ValueError', bad_v)
import related as _rel  # noqa: E402
VD = os.path.join(BASE, 'ver-other'); os.makedirs(VD); dump(os.path.join(VD, 'doc.json'), {"type": "prd", "version": "1.0.0"})
check('related：登记 1.0、对方 1.0.0 不报 version_mismatch（验收⑨）', _rel.RelatedDoc(BASE, {'type': 'prd', 'path': VD, 'role': 'references', 'version': '1.0'}).version_mismatch is None)
check('related：登记 1.0.1 或 0.9、对方 1.0.0 仍报 version_mismatch', _rel.RelatedDoc(BASE, {'type': 'prd', 'path': VD, 'role': 'references', 'version': '1.0.1'}).version_mismatch is not None
      and _rel.RelatedDoc(BASE, {'type': 'prd', 'path': VD, 'role': 'references', 'version': '0.9'}).version_mismatch is not None)

RD3 = os.path.join(BASE, 'run3'); os.makedirs(RD3)
dump(os.path.join(RD3, 'run-state.json'), {"mode": "revision", "line": "site", "stage": "solution", "gates": {"G0": "passed", "G1": "passed", "G2": "pending", "G3": "pending", "G4": "pending"}})
c, d, raw = rs(RD3, 'set-stage', 'qa')
check('run_state：旧版 G0–G4 状态文件拒绝写入（兼容期不代写）', c == 1 and 'G0–G4' in raw, raw)

# ---------- 8. org_section.py 与旧脚本一致 ----------
legacy_cs = os.path.join(SKILLS, 'presales-terms', 'scripts', 'company_section.py')
if os.path.exists(legacy_cs):
    for tag, extra_args in (('site', ['--delivery', 'site_delivery', '--cases', 'site', '--cases-columns', '项目,行业,建站方式,我方负责']),
                            ('reddit', ['--cases', 'reddit'])):
        a_dir, b_dir = os.path.join(BASE, f'org-legacy-{tag}'), os.path.join(BASE, f'org-new-{tag}')
        brief = {"client": "Demo", "line": tag, "contact": {"name": "王五", "title": "项目经理", "email": "w@example.com"}}
        dump(os.path.join(a_dir, 'brief.json'), brief); dump(os.path.join(b_dir, 'brief.json'), brief)
        c1, o1, e1 = run([PY, legacy_cs, a_dir])
        c2, o2, e2 = run([PY, os.path.join(SCRIPTS, 'org_section.py'), b_dir, '--meta', 'brief.json', '--out', 'sections/company.md'] + extra_args)
        same = c1 == 0 and c2 == 0 and open(os.path.join(a_dir, 'sections', 'company.md')).read() == open(os.path.join(b_dir, 'sections', 'company.md')).read()
        check(f'org_section：传入 {tag} 参数时与旧 company_section.py 输出逐字节一致', same, o1 + e1 + o2 + e2)
else:
    skip('org_section 与旧脚本一致', '旧脚本不存在')
b_dir = os.path.join(BASE, 'org-new-err'); dump(os.path.join(b_dir, 'doc.json'), DOC)
c, o, e = run([PY, os.path.join(SCRIPTS, 'org_section.py'), b_dir, '--delivery', 'nope'])
check('org_section：引用不存在的交付块退出码 2', c == 2, o + e)
c, o, e = run([PY, os.path.join(SCRIPTS, 'org_section.py'), b_dir])
check('org_section：默认读 doc.json，输出 sections/org.md', c == 0 and os.path.exists(os.path.join(b_dir, 'sections', 'org.md')), o + e)

# ---------- 9. import_doc.py ----------
imp = os.path.join(BASE, 'imp'); os.makedirs(imp)
open(os.path.join(imp, 'old.xml'), 'w').write('<title>旧版文档</title><h1>背景</h1><p>现状 `code` 说明 v2.3</p>'
    '<table><thead><tr><th><p>项</p></th><th><p>值</p></th></tr></thead><tbody><tr><td><p>A</p></td><td><p>1</p></td></tr></tbody></table>'
    '<ul><li>要点一</li></ul><whiteboard type="svg"></whiteboard><img path="x.png" caption="截图"/>')
c, o, e = run([PY, os.path.join(SCRIPTS, 'import_doc.py'), os.path.join(imp, 'old.xml'), imp, '--count', r'版本=v\d+\.\d+'])
md = open(os.path.join(imp, 'base', 'base-doc.md')).read() if c == 0 else ''
sm = json.load(open(os.path.join(imp, 'base', 'base-summary.json'))) if c == 0 else {}
check('import_doc：XML 导入为 base/base-doc.md（标题、表格、列表、画板占位、去反引号）',
      c == 0 and '# 旧版文档' in md and '## 背景' in md and '| 项 | 值 |' in md and '- 要点一' in md and '[原文画板' in md and '`' not in md, o + e)
check('import_doc：summary 只含通用字段与 --count 计数', sm.get('counts', {}).get('版本') == ['v2.3'] and 'money_mentions' not in sm and 'day_mentions' not in sm, sm)

# ---------- 9b. related.py 跨文档读取 ----------
import related as relmod  # noqa: E402
X = os.path.join(BASE, 'xdoc'); PRD_DIR = os.path.join(X, 'prd-login-v1.0'); TC_DIR = os.path.join(X, 'test-cases-login-v1.0')
prd_doc = copy.deepcopy(DOC); prd_doc['related_docs'] = []; dump(os.path.join(PRD_DIR, 'doc.json'), prd_doc)
os.makedirs(os.path.join(PRD_DIR, 'data'), exist_ok=True)
open(os.path.join(PRD_DIR, 'data', 'requirements.csv'), 'w', encoding='utf-8-sig').write('需求编号,标题,优先级\nREQ-LOGIN-01,短信登录,P0\nREQ-LOGIN-02,找回密码,P1\n')
tc_doc = copy.deepcopy(DOC); tc_doc['type'] = 'test-cases'
tc_doc['related_docs'] = [{"type": "prd", "path": "../prd-login-v1.0", "role": "source_prd", "version": "v1.0"},
                          {"type": "test-plan", "path": os.path.join(X, 'test-plan-login-v1.0', 'doc.json'), "role": "executes_plan"}]
check('related：doc.json 新结构（type、path、role、version）通过 schema', not verrs('doc', tc_doc), verrs('doc', tc_doc))
dump(os.path.join(TC_DIR, 'doc.json'), tc_doc)
rel = relmod.Related(TC_DIR)
rd = rel.find('prd', role='source_prd')
check('related：相对路径按当前运行目录解析并读出对方 doc.json', rd is not None and rd.ok and rd.meta['title'] == DOC['title'], rd and rd.summary())
check('related：登记版本带 v 且与对方一致时无 version_mismatch', rd is not None and rd.version_mismatch is None)
check('related：读对方 data/*.csv（UTF-8 BOM）与列', rd.column('data/requirements.csv', '需求编号') == ['REQ-LOGIN-01', 'REQ-LOGIN-02'] and rd.read_csv('data/requirements.csv')[0]['优先级'] == 'P0')
try:
    rd.read_text('../test-cases-login-v1.0/doc.json'); escaped = False
except relmod.RelatedError:
    escaped = True
check('related：读取路径越出对方运行目录被拦截', escaped)
try:
    rd.column('data/requirements.csv', '不存在的列'); colerr = False
except relmod.RelatedError as ex:
    colerr = '现有列' in str(ex)
check('related：不存在的列报错并列出现有列', colerr)
tp = rel.find('test-plan')
check('related：绝对路径指向 doc.json；对方不存在时 ok=False 并给原因', tp is not None and not tp.ok and '运行目录不存在' in tp.error, tp and tp.summary())
try:
    tp.read_csv('data/x.csv'); unreadable = False
except relmod.RelatedError:
    unreadable = True
check('related：对方不可解析时读文件抛 RelatedError', unreadable)
check('related：未登记的类型返回 None', rel.find('mrd') is None)
tc2 = copy.deepcopy(tc_doc); tc2['related_docs'].append({"type": "prd", "path": "../prd-login-v1.0", "role": "references"})
rel2 = relmod.Related(TC_DIR, meta=tc2)
try:
    rel2.find('prd'); amb = False
except relmod.AmbiguousRelated:
    amb = True
check('related：同 type 多份且不给 role 时抛 AmbiguousRelated，给 role 可消歧', amb and rel2.find('prd', role='source_prd').ok)
tc3 = copy.deepcopy(tc_doc); tc3['related_docs'] = [{"type": "tech-spec", "path": "../prd-login-v1.0", "role": "references"}, {"type": "prd", "path": "../prd-login-v1.0/doc.json", "role": "source_prd", "version": "2.0"}]
rel3 = relmod.Related(TC_DIR, meta=tc3)
ts = rel3.all('tech-spec')[0]
check('related：对方 doc.json type 不符时 ok=False', not ts.ok and '类型不符' in ts.error, ts.summary())
check('related：path 可指 doc.json；登记版本与对方不一致给 version_mismatch', rel3.find('prd').ok and bool(rel3.find('prd').version_mismatch))
# ---- W3-H 契约第二轮：role 必填、mode 取值唯一实现、qa_rules 通用小工具、编号扫描共享
nr = relmod.RelatedDoc(TC_DIR, {"type": "prd", "path": "../prd-login-v1.0"})
check('related：缺 role 的条目 ok=False、error 点明缺 role；按 role 查找不会命中', not nr.ok and '缺 role' in nr.error
      and relmod.Related(TC_DIR, meta=dict(tc_doc, related_docs=[{"type": "prd", "path": "../prd-login-v1.0"}])).find('prd', role='source_prd') is None, nr.summary())
_MP = {'meta_file': 'doc.json', 'skeleton': [{'id': 'a', 'title': 'A', 'required': True}],
       'modes': {'field': 'site.project_type', 'default': 'rebuild', 'items': [{'id': 'rebuild'}, {'id': 'greenfield', 'aliases': ['0-1']}]}}
_MD = os.path.join(BASE, 'mode-run'); os.makedirs(_MD); dump(os.path.join(_MD, 'brief.json'), {'site': {'project_type': '0-1'}})
check('mode：给 run_dir 时字段路径不全回退运行目录 brief.json；元数据有值时以元数据为准；不给 run_dir 只看 meta',
      validate.resolve_mode(_MP, {}, run_dir=_MD) == 'greenfield' and validate.resolve_mode(_MP, {'site': {'project_type': 'rebuild'}}, run_dir=_MD) == 'rebuild'
      and validate.resolve_mode(_MP, {}) == 'rebuild' and validate.mode_meta(_MD, _MP, {}) == {'site': {'project_type': '0-1'}}
      and validate.resolve_mode(dict(_MP, meta_file='brief.json'), {}, run_dir=_MD) == 'rebuild')
try:
    validate.resolve_mode(_MP, {'site': {'project_type': 'bad'}}, run_dir=_MD); _mode_bad = False
except validate.ModeError:
    _mode_bad = True
check('mode：元数据值非法时抛 ModeError，不被 brief.json 覆盖', _mode_bad)
sys.path.insert(0, os.path.join(SK, 'doc-qa', 'scripts')) if 'SK' in globals() else sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'doc-qa', 'scripts'))
import docmodel as _dm  # noqa: E402
check('mode：doc-qa docmodel.mode_meta 转发 validate.mode_meta（同一实现）', _dm.mode_meta(_MD, _MP, {}) == validate.mode_meta(_MD, _MP, {}) and 'validate' in _dm.mode_meta.__doc__)
import qa_pack_helpers as _qh  # noqa: E402


class _RD:
    def __init__(self, role, ok=True, error=None): self.role, self.ok, self.error = role, ok, error


class _QCtx:
    def __init__(self, docs): self.docs = docs
    def related(self, t, role=None): return next((d for d in self.docs if d.role == role), None)
    def related_all(self, t=None, role=None): return list(self.docs)
    def missing_related_issue(self, rule, t, role=None, detail=''): return {'rule': rule, 'severity': '必改', 'message': f'缺失 {t} {role} {detail}'}


_d, _iss = _qh.related(_QCtx([_RD(None)]), 'XX2', 'prd', 'source_prd', {})
_d2, _iss2 = _qh.related(_QCtx([_RD('source_prd')]), 'XX2', 'prd', 'source_prd', {})
check('qa_pack_helpers.related：缺 role 的条目不再兼容读取，按缺失并点明缺 role；按 role 命中可读时无问题', _d is None and '缺 role' in _iss[0]['message'] and _d2 is not None and _iss2 == [], (_iss, _iss2))
import code_scan as _cs  # noqa: E402
_rx, _full = _cs.code_regex(r'^X-[A-Z]+-\d{2}$')
check('code_scan：边界匹配、简写续号、代码块与注释遮蔽（xref_check 与 trace_matrix 共用）',
      _cs.scan_codes(_cs.visible_lines(['见 X-AB-01/02', '```', 'X-AB-03', '```', '<!-- X-AB-04 -->', 'YX-AB-05 X-AB-066']), r'^X-[A-Z]+-\d{2}$') == {'X-AB-01': 1, 'X-AB-02': 1})
check('related：缺失定级（D2 门相关必改，其余提示）', relmod.missing_issue('XX2', 'prd', for_gate=True)['severity'] == '必改' and relmod.missing_issue('XX2', 'prd')['severity'] == '提示' and not verrs('qa-result', {"generated_at": "2026-09-15T10:00:00", "must_fix": 1, "total": 1, "issues": [relmod.missing_issue('XX2', 'prd', for_gate=True)]}))
c, o, e = run([PY, os.path.join(SCRIPTS, 'related.py'), TC_DIR, '--type', 'prd', '--role', 'source_prd', '--csv', 'data/requirements.csv', '--column', '需求编号'])
check('related CLI：命中一份并输出 CSV 列值', c == 0 and jout(o).get('csv', {}).get('values') == ['REQ-LOGIN-01', 'REQ-LOGIN-02'], o + e)
c, o, e = run([PY, os.path.join(SCRIPTS, 'related.py'), TC_DIR])
check('related CLI：存在无法解析的条目时退出码 1', c == 1 and jout(o).get('ok') is False, o + e)
# pack.json related + run_state D0
DEMO3 = os.path.join(TYPES, 'demo3'); shutil.copytree(DEMO, DEMO3)
p3 = copy.deepcopy(PJ); p3['id'] = 'demo3'; p3['related'] = [{"type": "prd", "role": "source_prd", "for_gate": True, "required": True, "desc": "关联需求校验"}]
dump(os.path.join(DEMO3, 'pack.json'), p3)
check('pack：related 声明通过校验', not verrs('pack', p3, DEMO3), verrs('pack', p3, DEMO3))
p3b = copy.deepcopy(p3); p3b['related'].append(dict(p3['related'][0]))
check('pack 反例：related 同一 type + role 重复', any('$.related' in x for x, _ in verrs('pack', p3b, DEMO3)))
RD4 = os.path.join(X, 'demo3-login-v1.0'); os.makedirs(RD4)
rs(RD4, 'init', '--type', 'demo3', '--mode', 'new')
d4 = copy.deepcopy(DOC); d4['type'] = 'demo3'; d4['related_docs'] = []; dump(os.path.join(RD4, 'doc.json'), d4)
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：类型包 required 的关联文档未登记时拒绝 D0', c == 1 and '未登记' in probs(d), raw)
d4['related_docs'] = [{"type": "prd", "path": "../nope", "role": "source_prd"}]; dump(os.path.join(RD4, 'doc.json'), d4)
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：关联文档登记了但无法解析时拒绝 D0', c == 1 and '无法解析' in probs(d), raw)
d4['related_docs'] = [{"type": "prd", "path": "../prd-login-v1.0", "role": "source_prd"}]; dump(os.path.join(RD4, 'doc.json'), d4)
c, d, raw = rs(RD4, 'pass-gate', '--gate', 'D0')
check('run_state：关联文档可解析时 D0 通过并记录 checks', c == 0 and any('关联文档 prd' in x for x in json.load(open(os.path.join(RD4, 'run-state.json')))['gates']['D0']['checks']), raw)

# ---------- 10. 引擎业务词守卫 ----------
ALL_WORDS = ['报价', '确认单', '毛利', '底价', '人天']
SCRIPT_WORDS = ['售前', 'presales', 'pricing', '用例', 'reddit', '建站']


def guard(root):
    hits = []
    for sub, words in (('scripts', ALL_WORDS + SCRIPT_WORDS), ('references', ALL_WORDS)):
        for dp, _, fns in os.walk(os.path.join(root, sub)):
            if '__pycache__' in dp: continue
            for fn in sorted(fns):
                if not fn.endswith(('.py', '.md', '.mjs', '.js', '.json', '.sh')): continue
                for i, line in enumerate(open(os.path.join(dp, fn), encoding='utf-8').read().split('\n'), 1):
                    for w in words:
                        if w.lower() in line.lower():
                            hits.append(f'{sub}/{fn}:{i} 「{w}」')
    return hits


hits = guard(ROOT)
check('业务词守卫：scripts/ 与 references/ 不出现业务词（引擎不认识业务）', not hits, hits[:10])
fake = os.path.join(BASE, 'guard-root'); os.makedirs(os.path.join(fake, 'scripts')); os.makedirs(os.path.join(fake, 'references'))
open(os.path.join(fake, 'scripts', 'x.py'), 'w').write('# 生成报价片段\n')
open(os.path.join(fake, 'references', 'y.md'), 'w').write('售前映射说明可以出现\n')
fh = guard(fake)
check('业务词守卫自检：植入的业务词能被抓到，references 里的「售前」映射说明不误伤', len(fh) == 1 and '报价' in fh[0], fh)

# ---------- 11. 已落位类型包（1e）：types/ 下九个业务类型包 ----------
LANDED = ['prd', 'mrd', 'tech-spec', 'api-reference', 'test-plan', 'test-cases', 'test-report', 'presales-site', 'presales-reddit']
KNOWN_GAP = set()  # 1d 已落位 presales-site / presales-reddit 的 qa_rules.py 与 qa-rules.md（2026-09-15），九个包都必须完全通过
for tid in LANDED:
    pdir = os.path.join(ROOT, 'types', tid)
    c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), pdir, '--kind', 'pack'])
    j = jout(o)
    if tid in KNOWN_GAP:
        paths = sorted(x['path'] for x in j.get('errors', []))
        check(f'pack：types/{tid} 除 qa_rules.py/qa-rules.md 待 1d 落位外通过校验（已知过渡态）',
              paths == ['$.qa.rules_md', '$.qa.rules_py'], o + e)
    else:
        check(f'pack：types/{tid} 通过 validate.py', c == 0, o + e)

SAMPLE_DOCS = [
    'prd/samples/membership-points-v2/doc.json', 'mrd/samples/membership-points-v2/doc.json',
    'tech-spec/samples/membership-points-v2/doc.json', 'api-reference/samples/membership-points-v2/doc.json',
    'test-plan/samples/membership-points-v2/doc.json', 'test-cases/samples/membership-points-v2/doc.json',
    'test-report/samples/membership-points-v2/doc.json', 'presales-site/samples/smokesite/doc.json',
    'presales-reddit/samples/smokereddit/doc.json',
]
for rel in SAMPLE_DOCS:
    fp = os.path.join(ROOT, 'types', rel)
    c, o, e = run([PY, os.path.join(SCRIPTS, 'validate.py'), fp, '--kind', 'doc'])
    check(f'doc：types/{rel} 通过 validate.py', c == 0, o + e)

SAMPLE_ROLES = {  # 表驱动：pack.json related 声明优先，其余按 artifacts.md §2.1 词表
    ('prd', 'mrd'): 'source_mrd', ('prd', 'tech-spec'): 'references', ('prd', 'test-plan'): 'references',
    ('mrd', 'prd'): 'references',
    ('tech-spec', 'prd'): 'source_prd', ('tech-spec', 'api-reference'): 'references', ('tech-spec', 'test-plan'): 'references',
    ('api-reference', 'tech-spec'): 'source_spec',
    ('test-plan', 'prd'): 'source_prd', ('test-plan', 'tech-spec'): 'source_spec', ('test-plan', 'test-cases'): 'references', ('test-plan', 'test-report'): 'references',
    ('test-cases', 'prd'): 'source_prd', ('test-cases', 'test-plan'): 'references', ('test-cases', 'test-report'): 'references',
    ('test-report', 'test-plan'): 'executes_plan', ('test-report', 'test-cases'): 'reports_on',
}
got_roles, got_list = {}, []
for tid in ['prd', 'mrd', 'tech-spec', 'api-reference', 'test-plan', 'test-cases', 'test-report']:
    for r in json.load(open(os.path.join(ROOT, 'types', tid, 'samples', 'membership-points-v2', 'doc.json')))['related_docs']:
        got_roles[(tid, r['type'])] = r.get('role'); got_list.append((tid, r['type'], r.get('role')))
want_list = sorted(((t, o, role) for (t, o), role in SAMPLE_ROLES.items()), key=str)
check('样张 related_docs：七个内部样张每条都有 role，且与表逐条一致（按多重集合比，重复或多余登记也会报）', sorted(got_list, key=str) == want_list,
      sorted(set(got_list) ^ set(want_list), key=str) or (len(got_list), len(want_list)))
decl = [(tid, r['type'], r['role']) for tid in ['prd', 'mrd', 'tech-spec', 'api-reference', 'test-plan', 'test-cases', 'test-report'] for r in json.load(open(os.path.join(ROOT, 'types', tid, 'pack.json'))).get('related', [])]
check('样张 related_docs：pack.json related 声明的 type + role 在样张里都按声明登记', all(got_roles.get((t, o)) == role for t, o, role in decl), [x for x in decl if got_roles.get(x[:2]) != x[2]])
PRDP = json.load(open(os.path.join(ROOT, 'types', 'prd', 'pack.json')))
check('prd：input4（关联 MRD 或立项材料，如有）为可选，input1–3 仍必需', [(i['id'], i['required']) for i in PRDP['inputs']] == [('input1', True), ('input2', True), ('input3', True), ('input4', False)], PRDP['inputs'])
for tid in ['_template'] + LANDED:
    pdir = os.path.join(ROOT, 'types', tid)
    check(f'发布约定：types/{tid} version 三段式且 CHANGELOG.md 有当前版本标题', not validate.release_errors(json.load(open(os.path.join(pdir, 'pack.json'))), pdir),
          validate.release_errors(json.load(open(os.path.join(pdir, 'pack.json'))), pdir))
check('发布约定：presales-site 因 v1.5 吸收递增到 1.1.0，其余业务包保持 1.0.0',
      {t: json.load(open(os.path.join(ROOT, 'types', t, 'pack.json')))['version'] for t in LANDED} == {t: ('1.1.0' if t == 'presales-site' else '1.0.0') for t in LANDED})
for sk in ['doc-shared', 'doc-render', 'doc-figures', 'doc-qa', 'doc-publish', 'doc-author', 'doc-orchestrator']:
    cl = os.path.join(SKILLS, sk, 'CHANGELOG.md')
    check(f'发布约定：{sk}/CHANGELOG.md 存在且有 2026-09-15 版本标题', os.path.isfile(cl) and bool(re.search(r'^## \d+\.\d+\.\d+ — 2026-09-15$', open(cl, encoding='utf-8').read(), re.M)))
for rel in SAMPLE_DOCS:
    e, w = validate.validate_brief(json.load(open(os.path.join(ROOT, 'types', rel))))
    check(f'brief：样张 types/{rel} 作为 brief（doc 分支）通过', not e, e)

CHAIN = ['prd', 'mrd', 'tech-spec', 'api-reference', 'test-plan', 'test-cases', 'test-report']
for tid in CHAIN:
    rd = os.path.join(ROOT, 'types', tid, 'samples', 'membership-points-v2')
    c, o, e = run([PY, os.path.join(SCRIPTS, 'related.py'), rd])
    j = jout(o)
    ok = c == 0 and j.get('ok') and all(x.get('found') for x in j.get('related', []))
    check(f'related：{tid} 样张的 related_docs 全部解析通过（MRD → PRD → tech-spec → api-reference → test-plan → test-cases → test-report 链路）', ok, o + e)

# ---------- 跨文档追踪矩阵（W3-G，独立测试文件，主代理接线） ----------
c, o, e = run([PY, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test_trace_matrix.py')])
check('trace_matrix：test_trace_matrix.py ALL PASS', c == 0 and 'ALL PASS' in o, (o + e)[-2000:])

# ---------- 汇总 ----------
keep = '--keep' in sys.argv
print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}" + (f'（SKIP {len(skips)}）' if skips else '') + f'（临时目录：{BASE}）')
if not keep and not fails:
    shutil.rmtree(BASE, ignore_errors=True)
sys.exit(1 if fails else 0)
