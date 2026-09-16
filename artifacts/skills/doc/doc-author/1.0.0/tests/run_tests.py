#!/usr/bin/env python3
"""doc-author 自测（离线、只写系统临时目录；不改类型包与样张）。
用法：run_tests.py [--keep]
覆盖：outline.py 按 pack.json 动态生成（改名、删章、加章、二级章、附录、mode 补丁）、锚点与 doc-qa S1 匹配、按需章节不预建与
--add-section 定位插入、D1 拍板项、不覆盖已有文件；fill_check 占位符（【待写】、{占位}、TODO；锚点与代码块不误报）、
必备章缺失与为空、must_answer 覆盖不被写作提示注释「自己命中」、正式样张零误报、test-cases 样张类型包缺陷回归；
lint_draft 不写真运行目录、--section 过滤、T3 必改命中；业务词守卫。"""
import glob, json, os, re, shutil, subprocess, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))
DA = os.path.dirname(H)
SK = os.path.dirname(DA)
S = os.path.join(DA, 'scripts')
DS = os.path.join(SK, 'doc-shared')
TYPES = os.path.join(DS, 'types')
PY = sys.executable
BASE = tempfile.mkdtemp(prefix='doc-author-tests-')
fails = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:700]}]' if detail and not cond else ''))
    if not cond: fails.append(name)


def run(args, env=None, timeout=600):
    e = dict(os.environ); e.update(env or {})
    r = subprocess.run(args, capture_output=True, text=True, env=e, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def jout(s):
    try:
        return json.loads(s)
    except Exception:
        i = s.find('{'); return json.loads(s[i:]) if i >= 0 else {}


# ---------------------------------------------------------------- 临时类型包：模拟骨架块改动
TROOT = os.path.join(BASE, 'types'); os.makedirs(TROOT)
ENV = {'DOC_TYPES_DIRS': TROOT}
pk = os.path.join(TROOT, 'xdoc')
shutil.copytree(os.path.join(TYPES, 'prd'), pk, ignore=shutil.ignore_patterns('samples'))
pack = json.load(open(os.path.join(pk, 'pack.json'), encoding='utf-8'))
pack['id'] = 'xdoc'; pack['samples'] = []
first_two = [s['id'] for s in pack['skeleton'][:2]]
pack['skeleton'] = pack['skeleton'][2:]                       # 删掉前两章（模拟改为引擎生成）
pack['skeleton'][0]['title'] = '问题与证据'                    # 改名
pack['skeleton'].insert(3, {'id': 'rollout', 'title': '灰度与回滚', 'level': 1, 'required': True, 'must_answer': ['灰度比例', '回滚条件']})
pack['skeleton'].insert(4, {'id': 'rollout-metrics', 'title': '观测指标', 'level': 2, 'required': True, 'must_answer': ['告警阈值']})
pack['modes'] = {'field': 'extra.variant', 'default': 'full', 'items': [
    {'id': 'full', 'name': '完整'},
    {'id': 'lite', 'name': '精简', 'skeleton_remove': [s['id'] for s in pack['skeleton'] if not s['required']][:1],
     'skeleton_patch': {'rollout': {'title': '上线方式'}}}]}
json.dump(pack, open(os.path.join(pk, 'pack.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
c, o, e = run([PY, os.path.join(DS, 'scripts', 'validate.py'), pk])
check('临时类型包通过 validate.py', c == 0, o[-500:])

META = {'schema_version': '1', 'type': 'xdoc', 'title': '样例文档', 'project': 'demo', 'version': '0.1', 'status': 'draft', 'audience': 'internal',
        'brand': 'internal', 'language': 'zh-CN', 'owner': '张三（产品）', 'lark_folder': {'pending_reason': '自测', 'path': '自测/样例'}}


def mkrun(name, meta=None):
    rd = os.path.join(BASE, 'runs', name); os.makedirs(rd)
    json.dump(meta or META, open(os.path.join(rd, 'doc.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    return rd


print('== outline.py ==')
rd = mkrun('a')
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd], env=ENV)
doc = open(os.path.join(rd, 'doc.md'), encoding='utf-8').read()
outline = open(os.path.join(rd, 'outline.md'), encoding='utf-8').read()
req = [s for s in pack['skeleton'] if s['required']]; opt = [s for s in pack['skeleton'] if not s['required']]
check('outline 退出 0，写 doc.md 与 outline.md', c == 0 and jout(o).get('written') == ['doc.md', 'outline.md'], o)
check('必备章节全部生成且锚点与标题同一行', all(re.search(r'^#{2,4} .+ \{#sec:' + s['id'] + r'\}$', doc, re.M) for s in req), doc[:600])
check('改名生效、删掉的章节不出现', '## 问题与证据 {#sec:' in doc and not any('{#sec:' + i + '}' in doc for i in first_two), doc[:400])
check('二级章节用 ###', '### 观测指标 {#sec:rollout-metrics}' in doc)
check('按需章节不预建', not any('{#sec:' + s['id'] + '}' in doc or '{#sec:' + s['id'] + ' ' in doc for s in opt))
check('summary 块按 features.summary_block 生成', '<!-- summary -->' in doc and '<!-- /summary -->' in doc)
check('must_answer 进写作提示注释', '<!-- 写作提示 must_answer: 灰度比例；回滚条件 -->' in doc)
n_dec = len(re.findall(r'^[\u2460-\u2473] ', outline, re.M))
check('outline.md：每个按需章节一个带字母选项与代价的拍板项', n_dec >= len(opt) and '回复格式' in outline and '代价：' in outline and '## 已关闭' in outline, (n_dec, len(opt)))
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd], env=ENV)
check('已存在不覆盖 → 退出 1', c == 1 and '--force' in jout(o).get('message', ''), o)

# S1 与生成骨架一致
work = os.path.join(BASE, 'runs', 'a-qa'); shutil.copytree(rd, work)
c, o, e = run([PY, os.path.join(SK, 'doc-qa', 'scripts', 'qa.py'), work, '--only', 'S1', '--no-state'], env=ENV)
q = json.load(open(os.path.join(work, 'qa-result.json')))
check('doc-qa S1 在生成的骨架上 0 条（锚点与骨架对齐）', c in (0, 3) and not [i for i in q['issues'] if i['rule'] == 'S1'], (c, q['issues'][:3]))

print('== --add-section ==')
target = opt[0]['id']
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd, '--add-section', target], env=ENV)
doc2 = open(os.path.join(rd, 'doc.md'), encoding='utf-8').read()
order = [s['id'] for s in pack['skeleton']]
after = next((i for i in order[order.index(target) + 1:] if '{#sec:' + i + '}' in doc2), None)
pos_t = doc2.find('{#sec:' + target); pos_a = doc2.find('{#sec:' + after) if after else len(doc2)
check('--add-section 插入按需章节，位置在骨架中其后第一个已有章节之前', c == 0 and 0 <= pos_t < pos_a, (c, o, target, after))
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd, '--add-section', target, '--add-section', 'nope'], env=ENV)
check('--add-section 重复或不存在 → 退出 1 并说明', c == 1 and len(jout(o).get('skipped', [])) == 2, o)
last = opt[-1]['id']
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd, '--add-section', last], env=ENV)
doc3 = open(os.path.join(rd, 'doc.md'), encoding='utf-8').read()
check('骨架末尾的按需章节追加到文末（附录带 .appendix）', c == 0 and doc3.rstrip().endswith('】') and ('{#sec:' + last + (' .appendix}' if opt[-1].get('appendix') else '}')) in doc3, doc3[-300:])

print('== --add-section 与 include ==')
rd_i = mkrun('inc')
run([PY, os.path.join(S, 'outline.py'), rd_i, '--target', 'doc'], env=ENV)
os.makedirs(os.path.join(rd_i, 'sections'))
di = open(os.path.join(rd_i, 'doc.md'), encoding='utf-8').read()
dep = next(s for s in pack['skeleton'] if s['id'] == 'dependencies')
m_ = re.search(r'^## [^\n]*\{#sec:dependencies\}\n(?:.*\n)*?(?=^## |\Z)', di, re.M)
open(os.path.join(rd_i, 'sections', 'dep.md'), 'w', encoding='utf-8').write(m_.group(0))
open(os.path.join(rd_i, 'doc.md'), 'w', encoding='utf-8').write(di.replace(m_.group(0), '<!-- include: sections/dep.md -->\n\n'))
nfr_like = [s['id'] for s in pack['skeleton'] if not s['required'] and pack['skeleton'].index(s) < pack['skeleton'].index(dep)][-1]
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd_i, '--add-section', nfr_like], env=ENV); d = jout(o)
check('--add-section：其后章节在 include 片段里 → 追加到文末并提示', c == 0 and d.get('added') == [nfr_like] and d.get('notes'), (c, d))
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd_i, '--add-section', 'dependencies'], env=ENV); d = jout(o)
check('--add-section：章节只在 include 片段里也算已有', c == 1 and any('正文已有' in x for x in d.get('skipped', [])), (c, d))

print('== modes ==')
rd_m = mkrun('m', dict(META, extra={'variant': 'lite'}))
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd_m, '--target', 'outline'], env=ENV)
om = open(os.path.join(rd_m, 'outline.md'), encoding='utf-8').read()
check('mode 补丁：lite 改标题、删按需章节', c == 0 and '上线方式' in om and opt[0]['title'] not in om and not os.path.exists(os.path.join(rd_m, 'doc.md')), om[:600])

rd_bad = mkrun('mbad', dict(META, extra={'variant': 'nope'}))
c, o, e = run([PY, os.path.join(S, 'outline.py'), rd_bad], env=ENV)
check('mode 值无法识别 → 退出 2（不静默回落默认骨架）', c == 2 and 'mode' in o, (c, o[-300:]))

print('== fill_check ==')
FC = os.path.join(S, 'fill_check.py')
c, o, e = run([PY, FC, rd], env=ENV); d = jout(o)
check('骨架未填 → 退出 3，占位符逐条列出', c == 3 and len(d['placeholders']) >= len(req) and any('占位符' in r for r in d['blocking_reasons']), (c, d.get('blocking_reasons')))
check('must_answer 不被写作提示注释「自己命中」', any(s['id'] == 'rollout' and s['must_answer']['covered'] == 0 for s in d['sections']), [s for s in d['sections'] if s['id'] == 'rollout'])
filled = re.sub(r'【待写：([^】]*)】', lambda m: f'{m.group(1)}：本节已写正文。灰度比例 10%，回滚条件为错误率超过 1%，告警阈值 5 分钟。', doc3)
open(os.path.join(rd, 'doc.md'), 'w', encoding='utf-8').write(filled)
c, o, e = run([PY, FC, rd], env=ENV); d = jout(o)
check('占位符填完 → 退出 0；rollout must_answer 全覆盖', c == 0 and any(s['id'] == 'rollout' and s['must_answer']['covered'] == 2 for s in d['sections']), (c, d.get('blocking_reasons')))
check('写作提示注释残留只作提示', d['hints'] > 0 and any('写作提示' in w for w in d['warnings']))
extra = '\n\n段落里有 {产品名称} 与 TODO 待补。锚点 {#fig:x} 不算。\n\n```json\n{"a": "{不算}"}\n```\n\n<!--\n跨行注释里的 TODO 与 {也不算}\n-->\n\n行内起始的注释 <!-- TODO {行内也不算}\nFIXME 第二行也不算 -->后面的正文照常。\n'
open(os.path.join(rd, 'doc.md'), 'w', encoding='utf-8').write(filled + extra)
c, o, e = run([PY, FC, rd], env=ENV); d = jout(o)
texts = [p['text'] for p in d['placeholders']]
check('模板占位 {产品名称} 与 TODO 判阻塞；锚点、代码块、跨行与行内起始注释内不误报（验收⑦）', c == 3 and '{产品名称}' in texts and 'TODO' in texts
      and not any('不算' in t or '#fig' in t for t in texts) and 'FIXME' not in texts and texts.count('TODO') == 1, texts)
sys.path.insert(0, S)
import authorlib as _al  # noqa: E402
ml = _al.masked_lines(['正文 <!-- a', 'b --> 尾巴 <!-- c --> 末', '```', '<!-- 代码里 -->', '```', '<!-- 未闭合', '到文末'])
check('masked_lines：行内起始、跨行、同行多段注释遮蔽；代码块不动；未闭合遮到文末；列位置不变',
      ml[0].rstrip() == '正文' and ml[1].strip().startswith('尾巴') and ml[1].rstrip().endswith('末') and '代码里' in ml[3] and not ml[5].strip() and not ml[6].strip()
      and [len(x) for x in ml] == [len(x) for x in ['正文 <!-- a', 'b --> 尾巴 <!-- c --> 末', '```', '<!-- 代码里 -->', '```', '<!-- 未闭合', '到文末']], ml)
s = open(os.path.join(rd, 'doc.md'), encoding='utf-8').read()
open(os.path.join(rd, 'doc.md'), 'w', encoding='utf-8').write(re.sub(r'^## 灰度与回滚 \{#sec:rollout\}$', '## 其他', s, flags=re.M))
c, o, e = run([PY, FC, rd], env=ENV); d = jout(o)
check('必备章节缺失 → 阻塞', c == 3 and any('缺必备章节「灰度与回滚」' in r for r in d['blocking_reasons']), d.get('blocking_reasons'))
sys.path.insert(0, os.path.join(DS, 'scripts'))
import docmark_parse as dp  # noqa: E402
for t in ('prd', 'tech-spec', 'test-plan', 'test-cases'):
    smp = os.path.join(TYPES, t, 'samples', 'membership-points-v2')
    if not os.path.isdir(smp): continue
    tp = json.load(open(os.path.join(TYPES, t, 'pack.json'), encoding='utf-8'))
    sdoc = dp.parse_file(smp, tp.get('source_file', 'doc.md'), pack=tp)
    # 期望值与解析器独立核对：类型包骨架正被另一块修改，样张与骨架是否对齐以当时的 pack.json 为准
    unmatched = [s['id'] for s in tp['skeleton'] if s['required'] and sdoc.section(s['id']) is None]
    c, o, e = run([PY, FC, smp]); d = jout(o)
    check(f'正式样张 {t}：占位符 0（零误报）', not d.get('placeholders'), d.get('placeholders'))
    if unmatched:
        check(f'正式样张 {t}：骨架与样张未对齐（{unmatched}）→ fill_check 判缺必备章节', c == 3 and all(any(u in r for r in d['blocking_reasons']) for u in unmatched), (c, d.get('blocking_reasons')))
    else:
        check(f'正式样张 {t}：必备章节全部匹配 → fill_check 退出 0', c == 0, (c, d.get('blocking_reasons')))

print('== lint_draft ==')
rd_l = os.path.join(BASE, 'runs', 'lint'); shutil.copytree(os.path.join(TYPES, 'prd', 'samples', 'membership-points-v2'), rd_l)
p = os.path.join(rd_l, 'doc.md'); s = open(p, encoding='utf-8').read().split('\n')
k = next(i for i, l in enumerate(s) if re.match(r'^## .*功能需求', l))
s.insert(k + 1, '\n灰度期 3~5 天内完成。\n'); open(p, 'w', encoding='utf-8').write('\n'.join(s))
before = sorted(os.listdir(rd_l))
LD = os.path.join(S, 'lint_draft.py')
c, o, e = run([PY, LD, rd_l, '--section', 'requirements']); d = jout(o)
check('lint_draft 不写真运行目录（无 qa-result.json、out/）', sorted(os.listdir(rd_l)) == before and not os.path.exists(os.path.join(rd_l, 'qa-result.json')), sorted(os.listdir(rd_l)))
check('lint_draft --section requirements：命中 T3 必改 → 退出 3；问题都在章节行号区间', c == 3 and any(i['rule'] == 'T3' for i in d['issues'])
      and all(d['range'][0] <= i['line'] <= d['range'][1] for i in d['issues']), (c, d.get('counts'), d.get('range')))
check('lint_draft 默认子集不含 S1、L6、X2、C1', not {'S1', 'L6', 'X2', 'C1', 'L4', 'H2'} & set(d.get('rules') or []), d.get('rules'))
c, o, e = run([PY, LD, rd_l, '--section', 'background']); d = jout(o)
check('lint_draft --section background：别章的 T3 不报', not any(i['rule'] == 'T3' for i in d['issues']), d.get('issues')[:3])
c, o, e = run([PY, LD, rd_l, '--section', 'nope']); d = jout(o)
check('lint_draft 章节不存在 → 退出 2 并列出标题', c == 2 and d.get('headings'), (c, o[-300:]))

print('== 业务词守卫 ==')
words = ['REQ-', 'TC-', 'PRD', 'MRD', '用例', '报价', '需求文档', 'Reddit', 'Shopify', '会员积分']
hits = [f'{os.path.basename(f)}:{i}:{w}' for f in glob.glob(os.path.join(S, '*.py')) for i, l in enumerate(open(f, encoding='utf-8'), 1) for w in words if w in l]
check('scripts/ 不含业务词', not hits, hits[:10])

print()
if '--keep' in sys.argv: print('临时目录保留：', BASE)
else: shutil.rmtree(BASE, ignore_errors=True)
print('ALL PASS' if not fails else f'{len(fails)} FAIL：' + '；'.join(fails))
sys.exit(1 if fails else 0)
