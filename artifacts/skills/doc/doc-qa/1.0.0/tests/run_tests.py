#!/usr/bin/env python3
"""doc-qa 自测（离线；只写系统临时目录，不改 doc-shared、presales-* 与 golden 下任何文件）。
用法：run_tests.py [--keep] [--fast]（--fast 跳过 golden 与售前等价比对）
覆盖：引擎规则正反例（L1 L2 L4 L6–L10 S1–S3 X1–X4 C1 R1 H1–H4 T1–T12）、engine_rules 过滤与 severity_overrides、截断、
E-TYPE、E-HOOK（正常、故障、非 JSON、超时）、render.json 并入、qa-result schema、qa-report 区块、run_state 写回、退出码、
解析器接线、golden 四目录等价比对（迁移期配置逐项一致；落位 pack.json 原样只新增不丢失）、售前 7 条回归与旧脚本全量等价、
边界夹具旧新等价、两个售前 qa_rules.py 一致、业务词守卫；W3-A：S1 按 mode 取骨架（含 presales-site 反向集成）、
T11 与类型包 banned_terms 优先级、七个内部类型包 qa_rules 逐条正反例与跨文档四种关联情形、presales-site SITE-06～09。"""
import copy, json, os, shutil, subprocess, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))
DQ = os.path.dirname(H)
SK = os.path.dirname(DQ)
DS = os.path.join(SK, 'doc-shared')
QA = os.path.join(DQ, 'scripts', 'qa.py')
G = os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/golden')
PY = sys.executable
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(DS, 'scripts'))
import validate  # noqa: E402

fails, skips = [], []
BASE = tempfile.mkdtemp(prefix='doc-qa-tests-')
FAST = '--fast' in sys.argv


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{str(detail)[:600]}]' if detail and not cond else ''))
    if not cond: fails.append(name)


def skip(name, why):
    print(f'SKIP {name}（{why}）'); skips.append(name)


def run(args, cwd=None, env=None, timeout=300):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, env=env, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


# ---------------------------------------------------------------- 夹具

TEMPLATE = os.path.join(DS, 'types', '_template')
_seq = [0]


def make_pack(mut=None, rules_py=None):
    _seq[0] += 1
    d = os.path.join(BASE, 'packs', f'p{_seq[0]}')
    shutil.copytree(TEMPLATE, d)
    p = json.load(open(os.path.join(d, 'pack.json')))
    p.update({'id': 'tpack', 'name': '测试包', 'status': 'draft'})
    p['skeleton'] = [{'id': 'intro', 'title': '背景', 'level': 1, 'required': False}]
    p['features'] = {k: True for k in ('code_blocks', 'landscape', 'data_blocks', 'summary_block', 'footnotes', 'toc', 'table_captions', 'figure_numbers', 'thead_repeat')}
    p['features']['h1_new_page'] = None
    p['numbering']['entities'] = [{'kind': 'req', 'label': '需求', 'prefix': 'REQ-', 'pattern': '^REQ-[A-Z]+-\\d{2}$', 'unique': True, 'contiguous': True}]
    p['qa']['rules_py'] = None
    p['qa']['engine_rules'] = {'include': 'all', 'exclude': ['L2']}
    if rules_py is not None:
        open(os.path.join(d, 'qa_rules.py'), 'w').write(rules_py)
        p['qa']['rules_py'] = 'qa_rules.py'
    if mut: mut(p)
    json.dump(p, open(os.path.join(d, 'pack.json'), 'w'), ensure_ascii=False, indent=2)
    return d


def make_run(doc_md, files=None, meta=None):
    _seq[0] += 1
    d = os.path.join(BASE, 'runs', f'r{_seq[0]}')
    os.makedirs(d)
    open(os.path.join(d, 'doc.md'), 'w').write(doc_md)
    json.dump(meta or {'type': 'tpack', 'version': '1.0'}, open(os.path.join(d, 'doc.json'), 'w'), ensure_ascii=False)
    for rel, content in (files or {}).items():
        full = os.path.join(d, rel); os.makedirs(os.path.dirname(full), exist_ok=True)
        if isinstance(content, (dict, list)): json.dump(content, open(full, 'w'), ensure_ascii=False)
        elif isinstance(content, bytes): open(full, 'wb').write(content)
        else: open(full, 'w').write(content)
    return d


def qa(run_dir, pack_dir, only=None, extra=()):
    args = [PY, QA, run_dir, '--pack', pack_dir, '--quiet'] + (['--only', only] if only else []) + list(extra)
    if '--state' not in extra:
        args.append('--no-state')
    else:
        args.remove('--state')
    c, o, e = run(args)
    res = json.load(open(os.path.join(run_dir, 'qa-result.json'))) if os.path.exists(os.path.join(run_dir, 'qa-result.json')) and c in (0, 3) else None
    return c, res, o + e


def hits(res, rule, severity=None, contains=None):
    return [x for x in (res or {}).get('issues', []) if x['rule'] == rule and (severity is None or x['severity'] == severity)
            and (contains is None or contains in x['message'] or contains in x['excerpt'])]


def rule_case(name, rule, pos_md, neg_md, severity=None, contains=None, files_pos=None, files_neg=None, mut=None, meta=None, only=None):
    """正例：命中目标规则，退出码与必改条数一致，且必改只来自目标规则；反例：目标规则不命中，退出码与必改一致。"""
    pk = make_pack(mut)
    c1, r1, o1 = qa(make_run(pos_md, files_pos, meta), pk, only or rule)
    c2, r2, o2 = qa(make_run(neg_md, files_neg, meta), pk, only or rule)
    def consistent(c, r):
        return r is not None and c == (3 if r['must_fix'] else 0) and r['must_fix'] == sum(1 for x in r['issues'] if x['severity'] == '必改')
    unexpected = [x for x in (r1 or {}).get('issues', []) if x['severity'] == '必改' and x['rule'] != rule]
    check(f'{rule} 正例：{name}', bool(hits(r1, rule, severity, contains)) and consistent(c1, r1) and not unexpected, (c1, (r1 or {}).get('issues'), o1[-400:]))
    unexpected2 = [x for x in (r2 or {}).get('issues', []) if x['severity'] == '必改']
    check(f'{rule} 反例：{name}', r2 is not None and not hits(r2, rule) and consistent(c2, r2) and not unexpected2, (c2, (r2 or {}).get('issues'), o2[-400:]))


T = '# 测试文档\n\n'

# ---------------------------------------------------------------- 1. 解析器接线与基本输出

pk0 = make_pack()
rd0 = make_run(T + '## 背景\n\n正文一段。\n')
c, o, e = run([PY, QA, rd0, '--pack', pk0, '--no-state'])
out0 = json.loads(o) if o.strip().startswith('{') else {}
check('接线：文档模型来自共享解析器 docmark_parse', str(out0.get('model_source', '')).startswith('docmark_parse'), o[-300:] + e[-300:])
res0 = json.load(open(os.path.join(rd0, 'qa-result.json')))
errs, _ = validate.validate_data('qa-result', res0)
check('qa-result.json 通过 schema，含 engine、source_sha256、schema_version', not errs and res0.get('engine', {}).get('name') == 'doc-qa' and len(res0.get('source_sha256', '')) == 64, errs)
check('out/<源文件名>.resolved.md 写出', os.path.exists(os.path.join(rd0, 'out', 'doc.resolved.md')))
check('rules_run 记录实际执行的引擎规则', 'T1' in res0['engine']['rules_run'] and 'L2' not in res0['engine']['rules_run'], res0['engine'])

# ---------------------------------------------------------------- 2. 引擎规则正反例

rule_case('白名单外 include 写标记并按 include_allow 拼消息', 'L1', T + '## 背景\n\n<!-- include: secret.md -->\n', T + '## 背景\n\n<!-- include: sections/a.md -->\n',
          '必改', '只允许 sections/*.md', files_pos={'secret.md': 'x'}, files_neg={'sections/a.md': '片段内容。\n'})
rule_case('找不到的 include', 'L1', T + '<!-- include: sections/none.md -->\n', T + '正文。\n', '必改', '未解析')
rule_case('占位符', 'L1', T + '客户：{{client}}\n', T + '客户：甲方\n', '必改', '占位符')
rule_case('HTML 标签（解析器诊断）', 'L1', T + '第一行<br>第二行\n', T + '第一行，第二行\n', '必改', 'HTML')
rule_case('斜体', 'L1', T + '这是*斜体*文字\n', T + '这是 **加粗** 文字，算式 2 * 3 * 4\n', '必改', '斜体')
rule_case('删除线', 'L1', T + '这是~~删除~~文字\n', T + '这是正文\n', '必改', '删除线')
rule_case('行内代码与波浪号（兼容规则）', 'L2', T + '用 `x` 表示，3~5 天\n', T + '用 x 表示，3–5 天\n', '建议', mut=lambda p: p['qa'].update(engine_rules={'include': 'all', 'exclude': []}))

FIG_MD = T + '## 背景\n\n![流程](figures/flow.svg){#fig:flow}\n\n见 @fig:flow。\n'
SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'
rule_case('图缺 PNG 与自查记录', 'L4', FIG_MD, FIG_MD, '建议', files_pos={'figures/flow.svg': SVG},
          files_neg={'figures/flow.svg': SVG, 'figures/flow.png': b'png', 'figures/review.json': {'figures': [{'file': 'figures/flow.svg', 'checked_at': '2026-09-15', 'issues': '无'}]}})
MACHINE_OK = {'checked_at': '2026-09-15T10:00:00+08:00', 'board_lint': [], 'whiteboard_check': [], 'min_font_pt': 9, 'ok': True}
rule_case('缺 machine 检查记录', 'L6', FIG_MD, FIG_MD, '必改', 'machine',
          files_pos={'figures/flow.svg': SVG, 'figures/review.json': {'figures': [{'file': 'figures/flow.svg', 'checked_at': '2026-09-15', 'issues': '无'}]}},
          files_neg={'figures/flow.svg': SVG, 'figures/review.json': {'figures': [{'file': 'figures/flow.svg', 'machine': MACHINE_OK, 'human': {'issues': '无'}}]}})
low_font = dict(MACHINE_OK, min_font_pt=6, ok=False, must_fix=1, issues=[{'rule': 'LY4_font', 'severity': '必改', 'message': '等效最小字号 6pt < 7pt'}])  # doc-figures 实际结构
rule_case('等效字号不足；render.json 实际字号达标时以 render.json 为准', 'L6', FIG_MD, FIG_MD, '必改', '字号',
          files_pos={'figures/flow.svg': SVG, 'figures/review.json': {'figures': [{'file': 'figures/flow.svg', 'machine': low_font}]}},
          files_neg={'figures/flow.svg': SVG, 'figures/review.json': {'figures': [{'file': 'figures/flow.svg', 'machine': low_font}]},
                     'out/render.json': {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 8}], 'layout_issues': []}})
rule_case('表题缺失（table_captions 开启）', 'L7', T + '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n', T + '<!-- table: 对照 -->\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n', '提示')
rule_case('code_blocks 关闭时写代码块', 'L8', T + '```python\nx = 1\n```\n', T + '正文。\n', '必改', mut=lambda p: p['features'].update(code_blocks=False))
rule_case('代码块未标语言', 'L8', T + '```\nx = 1\n```\n', T + '```python\nx = 1\n```\n', '建议')
CSV = '编号,标题\nREQ-A-01,甲\n'
rule_case('数据块文件不存在 / 列不存在', 'L9', T + '<!-- data: data/none.csv -->\n\n<!-- data: data/x.csv columns=不存在 -->\n',
          T + '<!-- data: data/x.csv columns=编号,标题 caption=清单 -->\n', '必改', files_pos={'data/x.csv': CSV}, files_neg={'data/x.csv': CSV})
rule_case('相对链接不存在、协议不合规、链接文字为空', 'L10', T + '见 [附件](files/none.pdf)、[邮件](mailto:a@b.c)、[](https://a.example)\n',
          T + '见 [官网](https://example.com) 与 [附件](files/a.txt)\n', '建议', files_neg={'files/a.txt': 'x'})


def req_skeleton(p):
    p['skeleton'] = [{'id': 'scope', 'title': '范围与非目标', 'level': 1, 'required': True, 'aliases': ['范围']}]


rule_case('必备章节缺失（按标题、别名或锚点匹配）', 'S1', T + '## 背景\n', T + '## 范围\n\n正文。\n', '必改', mut=req_skeleton)
rule_case('必备章节用锚点匹配', 'S1', T + '## 其他\n', T + '## 做什么不做什么 {#sec:scope}\n', '必改', mut=req_skeleton)
rule_case('标题跳级', 'S2', T + '## 甲\n\n#### 乙\n', T + '## 甲\n\n### 乙\n', '必改')
ENT_TBL = '<!-- table: 需求 -->\n| 编号 | 描述 |\n|---|---|\n'
rule_case('编号实体重复', 'S3', T + ENT_TBL + '| REQ-A-01 | 甲 |\n| REQ-A-01 | 乙 |\n', T + ENT_TBL + '| REQ-A-01 | 甲 |\n| REQ-A-02 | 乙 |\n| REQ-B-01 | 丙 |\n', '必改', '重复')
rule_case('编号不连续（同前缀组内跳号为提示，跨模块不算）', 'S3', T + ENT_TBL + '| REQ-A-01 | 甲 |\n| REQ-A-03 | 乙 |\n', T + ENT_TBL + '| REQ-A-01 | 甲 |\n| REQ-B-01 | 乙 |\n', '提示', '不连续')
rule_case('交叉引用指向不存在的锚点', 'X1', T + '## 背景 {#sec:bg}\n\n见 @sec:nope。\n', T + '## 背景 {#sec:bg}\n\n见 @sec:bg。\n', '必改')
rule_case('有锚点的图未被引用', 'X2', T + '![图](figures/a.svg){#fig:a}\n', T + '![图](figures/a.svg){#fig:a}\n\n见 @fig:a。\n', '提示', '有锚点',
          files_pos={'figures/a.svg': SVG}, files_neg={'figures/a.svg': SVG})
rule_case('锚点重复', 'X3', T + '## 甲 {#sec:a}\n\n## 乙 {#sec:a}\n', T + '## 甲 {#sec:a}\n\n## 乙 {#sec:b}\n', '必改')


def kf(p):
    p['qa']['key_figures'] = [{'id': 'total', 'label': '总额', 'pattern': r'(?P<key>总额|定金)\s*(?P<value>\d[\d,]*(?:\.\d+)?)\s*元', 'normalize': 'number'}]


rule_case('关键数字多处不一致（按 key 分组）', 'X4', T + '总额 12,000 元。\n\n定金 3000 元。\n\n复述：总额 12,500 元。\n',
          T + '总额 12,000 元。\n\n定金 3000 元。\n\n复述：总额 12000 元，定金 3,000 元。\n', '必改', '总额', mut=kf)
c, r, o = qa(make_run(T + '正文。\n'), make_pack(lambda p: p['qa'].update(key_figures=[{'id': 'bad', 'label': '坏', 'pattern': '(?P<value>['},
                                                                                     {'id': 'nov', 'label': '缺组', 'pattern': r'\d+'}])), 'X4')
check('X4：口径正则无法编译、缺命名组 value 时记必改（不静默跳过）', bool(hits(r, 'X4', '必改', '无法编译')) and bool(hits(r, 'X4', '必改', '缺命名组')), (r or {}).get('issues'))
pk_nokf = make_pack()
c, r, o = qa(make_run(T + '总额 1 元，总额 2 元。\n'), pk_nokf, 'X4')
check('X4 反例：未声明 key_figures 时不检查', r is not None and not hits(r, 'X4'), o[-300:])
rule_case('版本不一致；修订记录表、关联文档版本不算', 'C1', T + '当前 v1.1 草稿。\n',
          T + '<!-- table: 修订记录 -->\n| 版本 | 日期 |\n|---|---|\n| v0.9 | 2026-09-01 |\n\n依据《某需求文档》v2.3。\n', '提示', meta={'type': 'tpack', 'version': '1.0'})
rule_case('绝对化用语；否定语境不报；banned_terms 追加', 'R1', T + '本方案零风险。\n\n支持万能适配。\n', T + '我们不承诺零风险。\n', '必改', mut=lambda p: p['qa'].update(banned_terms=[{'term': '万能', 'severity': '必改', 'message': '夸大'}]))
pk_bt = make_pack(lambda p: p['qa'].update(banned_terms=[{'term': '万能', 'severity': '建议', 'message': '夸大'}]))
c, r, o = qa(make_run(T + '支持万能适配。\n'), pk_bt, 'R1')
check('R1：banned_terms 按声明定级', bool(hits(r, 'R1', '建议', '万能')), (r or {}).get('issues'))

HL = lambda n: T + '\n\n'.join(f'第 {i} 处⟪要点⟫。' for i in range(n)) + '\n'
rule_case('全文高亮超过 25 处', 'H1', HL(26), HL(25), '建议')
rule_case('全文高亮阈值可配置', 'H1', HL(3), HL(2), '建议', mut=lambda p: p['qa'].update(highlight_limits={'total': 2}))
rule_case('单页高亮超过 3 处（读 render.json highlights.per_page）', 'H2', HL(4), HL(4), '建议',
          files_pos={'out/render.json': {'highlights': {'total': 5, 'per_page': {'3': 4, '4': 1}, 'items': []}}},
          files_neg={'out/render.json': {'highlights': {'total': 3, 'per_page': {'3': 3}, 'items': []}}})
rule_case('单页高亮超过 3 处（render.schema 未收字段时读 out/render.highlights.json）', 'H2', HL(4), HL(4), '建议',
          files_pos={'out/render.json': {'layout_issues': []}, 'out/render.highlights.json': {'total': 4, 'per_page': {'2': 4}, 'items': []}},
          files_neg={'out/render.json': {'layout_issues': []}})
c, r, o = qa(make_run(HL(4), {'out/render.highlights.json': {'total': 4, 'per_page': {'2': 4}, 'items': []}}), make_pack(), 'H2')
check('H2：file 字段指向实际读取的文件', any(x.get('file') == 'out/render.highlights.json' for x in hits(r, 'H2')), (r or {}).get('issues'))
rule_case('单处高亮超过 40 个汉字当量', 'H3', T + '⟪' + '长' * 41 + '⟫\n', T + '⟪' + '长' * 30 + 'abcdefghij' + '⟫\n', '建议')
rule_case('高亮未闭合', 'H4', T + '这是⟪没有闭合的高亮。\n', T + '这是⟪闭合⟫的高亮。\n', '必改')
rule_case('渲染产物残留高亮字符（飞书 XML）', 'H4', T + '正文。\n', T + '正文。\n', '必改', '残留', files_pos={'out/feishu.xml': '<p>⟪泄漏⟫</p>'}, files_neg={'out/feishu.xml': '<p>正常</p>'})
# 高亮颜色前缀（2026-09-15）：kind 不影响用量限额，5 种颜色合计计数
HLK = T + '无⟪甲⟫。险⟪!乙⟫。利⟪+丙⟫。注⟪~丁⟫。决⟪?戊⟫。\n'
rule_case('H1：5 种 kind 合计计入全文高亮总数（超过阈值 4 即报）', 'H1', HLK, T + '无⟪甲⟫。险⟪!乙⟫。\n', '建议',
          mut=lambda p: p['qa'].update(highlight_limits={'total': 4}))
rule_case('H3：带前缀的高亮同样按去掉前缀后的长度判超长', 'H3', T + '⟪!' + '长' * 41 + '⟫\n', T + '⟪!' + '长' * 30 + '⟫\n', '建议')
rule_case('渲染产物残留高亮字符（out/<源文件名>.html）', 'H4', T + '正文。\n', T + '正文。\n', '必改', 'out/doc.html', files_pos={'out/doc.html': '<p>⟫</p>'}, files_neg={'out/doc.html': '<p>正常</p>'})

rule_case('中英文之间缺空格', 'T1', T + '这是API接口。\n', T + '这是 API 接口，签字：（甲方）　（乙方）\n', '建议')
rule_case('中文语境半角标点', 'T2', T + '中文,逗号。\n', T + '金额 1,000 元，时间 10:30。\n', '建议')
rule_case('波浪号区间', 'T3', T + '工期 3~5 周。\n', T + '工期 3–5 周。\n', '必改')
rule_case('引号混用', 'T4', T + '甲说「好」。\n\n乙说“好”。\n\n丙说「行」。\n', T + '甲说「好」。\n\n丙说「行」。\n', '建议', '两种引号')
rule_case('标题手写序号与自动编号不一致', 'T5', T + '## 一、背景\n', T + '## 背景\n', '建议', '不一致')
rule_case('标题手写序号与自动编号一致时汇总为提示', 'T5', T + '## 1. 背景\n\n## 2. 范围\n', T + '## 背景\n\n## 范围\n', '提示', '全文 2 个')
rule_case('标题末尾标点', 'T5', T + '## 背景。\n', T + '## 背景\n', '建议', '标点')
rule_case('数字与单位', 'T6', T + '耗时 300ms。\n', T + '耗时 300 ms，占比 10%，共 3 个，3D 与 v1.0 不查。\n', '提示')
rule_case('列表句末标点不一致', 'T7', T + '- 甲。\n- 乙\n', T + '- 甲；\n- 乙；\n- 丙。\n', '提示')
rule_case('术语异写（最长匹配）', 'T8', T + '这里写了步骤。\n', T + '这里写了操作步骤。\n\n## 术语表\n\n| 术语 | 异写 |\n|---|---|\n| 操作步骤 | 步骤 |\n', '建议',
          mut=lambda p: p['qa'].update(glossary={'操作步骤': ['步骤']}))
rule_case('行内代码', 'T9', T + '用 `x` 表示。\n', T + '```python\nx = 1\n```\n', '建议')
rule_case('单元格超长', 'T10', T + '| 说明 |\n|---|\n| ' + '长' * 81 + ' |\n', T + '| 说明 |\n|---|\n| 短 |\n', '提示')
rule_case('验收列空泛表述', 'T11', T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 正常 |\n| 下单 | 体验更好 |\n', T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 返回 200 且跳转首页 |\n', '建议')
rule_case('段落超过 250 字、句子超过 80 字', 'T12', T + '长' * 90 + '。\n', T + '短句。短句。\n', '提示')

# ---------------------------------------------------------------- 2b. Codex 交付评审的回归用例

# 混合来源行：正文一行里 include 的片段本身 include 了白名单外文件
rd_mix = make_run(T + 'prefix <!-- include: sections/a.md -->\n', {'sections/a.md': '<!-- include: secret.md -->', 'secret.md': 'x'})
c, r, o = qa(rd_mix, make_pack(), 'L1')
resolved_mix = open(os.path.join(rd_mix, 'out', 'doc.resolved.md')).read()
check('混合来源行：嵌套片段里的白名单外 include 写 FORBIDDEN 标记并报 L1 必改', '[[FORBIDDEN include: secret.md]]' in resolved_mix and bool(hits(r, 'L1', '必改', '只允许')), (resolved_mix, (r or {}).get('issues')))
rd_mix2 = make_run(T + '<!-- include: sections/b.md -->\n\n<!-- include: sections/b.md -->\n', {'sections/b.md': '甲 <!-- include: nope.md --> 乙'})
c, r, o = qa(rd_mix2, make_pack(), 'L1')
check('同一片段 include 两次、片段内白名单外 include 同行混排：两处都标记', open(os.path.join(rd_mix2, 'out', 'doc.resolved.md')).read().count('[[FORBIDDEN include: nope.md]]') == 2, open(os.path.join(rd_mix2, 'out', 'doc.resolved.md')).read())

rule_case('脚注定义正文参与 T 规则', 'T1', T + '正文[^1]\n\n[^1]: 这是API接口。\n', T + '正文[^1]\n\n[^1]: 这是 API 接口。\n', '建议')
rule_case('v1.0版本 报缺空格（T6 例外不遮蔽 T1）', 'T1', T + '版本v1.0版本。\n', T + '版本 v1.0 版本。\n', '建议')
pk_t16 = make_pack()
c, r, o = qa(make_run(T + '共3个项目。\n'), pk_t16, 'T1,T6')
check('T1 与 T6 量词重叠时只报 T6', r is not None and hits(r, 'T6') and not hits(r, 'T1'), (r or {}).get('issues'))

def kf_cross(p):
    p['qa']['key_figures'] = [{'id': 'total', 'label': '总额', 'pattern': r'总额：\s*(?P<value>\d+)元'},
                              {'id': 'opt', 'label': '可选', 'pattern': r'定金(?P<value>\d+)?'}]
rule_case('关键数字跨行段落也能比对；可选 value 组不崩', 'X4', T + '总额：\n100元。\n\n总额：\n200元。\n\n定金。\n', T + '总额：\n100元。\n\n总额：100元。\n\n定金。\n', '必改', '总额', mut=kf_cross)
rule_case('行内注释里的数字不参与比对', 'X4', T + '总额：100元。\n\n总额：200元。\n', T + '总额：100元。<!-- 总额：200元 -->\n', '必改', mut=kf_cross)

ok_false_other = {'checked_at': 'x', 'board_lint': [], 'whiteboard_check': [], 'overlap': ['节点 A 与 B 重叠'], 'min_font_pt': 6, 'ok': False}
ok_false_font = {'checked_at': 'x', 'board_lint': [], 'whiteboard_check': [], 'min_font_pt': 6, 'ok': False, 'must_fix': 1,
                 'issues': [{'rule': 'LY4_font', 'severity': '必改', 'message': '等效最小字号 6pt < 7pt'}]}
ok_false_unknown = {'checked_at': 'x', 'board_lint': [], 'whiteboard_check': [], 'min_font_pt': 9, 'ok': False}
render_ok = {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 8}], 'layout_issues': []}
for label, mach, expect in (('ok=false 另有重叠等失败：render 字号达标也不清除', ok_false_other, True),
                            ('ok=false 且原因不明（review 字号达标）：render 字号达标也不清除', ok_false_unknown, True),
                            ('ok=false 只因字号：render 实测字号达标时清除', ok_false_font, False)):
    rd6 = make_run(FIG_MD, {'figures/flow.svg': SVG, 'figures/review.json': {'figures': [{'file': 'figures/flow.svg', 'machine': mach, 'human': {'issues': '无'}}]}, 'out/render.json': render_ok})
    c, r, o = qa(rd6, make_pack(), 'L6')
    check(f'L6：{label}', bool(hits(r, 'L6', '必改')) == expect, (r or {}).get('issues'))

rule_case('关联文档版本例外只看版本号紧前（「关联事项：本方案 v1.1」照报）', 'C1', T + '关联事项：本方案 v1.1。\n', T + '依据《需求文档》v1.1 编写。\n', '提示', meta={'type': 'tpack', 'version': '1.0'})
rule_case('被测版本写在表格单元格里也算他者版本', 'C1', T + '| 项 | 内容 |\n|---|---|\n| 本文版本 | v2.0 |\n', T + '| 项 | 内容 |\n|---|---|\n| 被测版本 | v2.0.0-rc1 |\n', '提示', meta={'type': 'tpack', 'version': '1.0'})
rule_case('附录手写前缀未标 .appendix 时逐条报建议', 'T5', T + '## 附录 B 说明\n', T + '## 说明 {.appendix}\n', '建议', '不一致')
rule_case('验收列「正常：」也算整格空泛', 'T11', T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 正常： |\n', T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 返回 200 |\n', '建议')
c, r, o = qa(make_run(T + '| 结果 |\n|---|\n| x |\n\n正文。\n'), make_pack(lambda p: p['qa'].update(banned_terms=[{'term': '[', 'regex': True, 'severity': '建议', 'message': 'x', 'columns': ['结果']},
                                                                                          {'term': '(', 'regex': True, 'severity': '建议', 'message': 'y'}])), 'T11,R1')
check('banned_terms 正则无法编译：T11 / R1 各报一条必改，不崩溃（退出码 3）', c == 3 and hits(r, 'T11', '必改', '无法编译') and hits(r, 'R1', '必改', '无法编译'), (c, o[-300:]))
c, r, o = qa(make_run(T + '![装饰](shots/a.png)\n', {'shots/a.png': b'png'}), make_pack(), 'X2')
check('X2：没有编号的位图不参与未引用检查', r is not None and not hits(r, 'X2'), (r or {}).get('issues'))
c, r, o = qa(make_run(HL(4), {'out/render.json': {'highlights': {'total': 0, 'per_page': {}, 'items': []}}, 'out/render.highlights.json': {'per_page': {'2': 4}}}), make_pack(), 'H2')
check('H2：render.json 有 highlights 字段（哪怕为空）就不回退旧的 render.highlights.json', r is not None and not hits(r, 'H2'), (r or {}).get('issues'))

# ---------------------------------------------------------------- 2c. Codex 第二轮复评的回归用例

REAL_REVIEW = json.load(open(os.path.join(H, 'fixtures', 'doc-figures-review.json')))  # doc-figures build.py --no-wb 实际生成
REAL_SVG = open(os.path.join(H, 'fixtures', 'doc-figures-flow.svg')).read()


def real_review(**machine_over):
    rv = copy.deepcopy(REAL_REVIEW)
    rv['figures'][0]['machine'].update(machine_over)
    rv['figures'][0]['human'] = {'checked_at': '2026-09-15', 'checked_by': '测试', 'issues': '无'}
    return rv


REAL_FIG_MD = T + '## 背景\n\n![流程](figures/flow.svg){#fig:flow}\n\n见 @fig:flow。\n'
font_issue = {'rule': 'LY4_font', 'severity': '必改', 'message': '等效最小字号 6.00pt < 7pt', 'target': ''}
overlap_issue = {'rule': 'render_text_overlap', 'severity': '必改', 'message': 'Chrome 实测文字重叠：「甲」与「乙」', 'target': '甲'}
l6_cases = (
    ('真实 review.json 原样（ok=true，whiteboard_check 为 {skipped}）', real_review(), None, False),
    ('whiteboard_check 为对象且 errors=0（上一轮误报的复现）', real_review(whiteboard_check={'errors': 0, 'warnings': 0, 'summary': {}, 'issues': []}), None, False),
    ('whiteboard_check 对象 errors=2 且 ok=false', real_review(ok=False, must_fix=2, whiteboard_check={'errors': 2, 'warnings': 0, 'summary': {}, 'issues': [{'type': 'node-overlap', 'severity': 'error', 'message': '重叠'}]}), None, True),
    ('whiteboard_check 为数组（旧契约示例）非空', real_review(whiteboard_check=[{'message': 'x'}]), None, True),
    ('ok=false 只因字号（LY4_font），render 实测字号达标时清除', real_review(ok=False, must_fix=1, min_font_pt=6, issues=[font_issue]), {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 8}], 'layout_issues': []}, False),
    ('ok=false 只因字号，没有 render.json 时照报', real_review(ok=False, must_fix=1, min_font_pt=6, issues=[font_issue]), None, True),
    ('ok=false 字号加文字重叠，render 字号达标也照报', real_review(ok=False, must_fix=2, min_font_pt=6, issues=[font_issue, overlap_issue]), {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 8}], 'layout_issues': []}, True),
)
for label, rv, rjson, expect in l6_cases:
    files = {'figures/flow.svg': REAL_SVG, 'figures/flow.png': b'png', 'figures/review.json': rv}
    if rjson: files['out/render.json'] = rjson
    c, r, o = qa(make_run(REAL_FIG_MD, files), make_pack(), 'L6')
    check(f'L6（真实 machine 结构）：{label}', r is not None and bool(hits(r, 'L6', '必改')) == expect, (c, (r or {}).get('issues'), o[-300:]))

# W3-I：同一张图 L6 与 LY4 双必改去重（合并 render.json 时 L6 只因字号且该图已有 LY4 → 只留 LY4 并注明「另见 L6 字号」）
ly4_small = {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 5.25}],
             'layout_issues': [{'rule': 'LY4', 'severity': '必改', 'message': '图 figures/flow.svg 等效最小字号 5.25 pt < 7 pt', 'page': 3, 'target': 'figures/flow.svg'}]}
pk_l6 = make_pack(lambda p: p['qa'].update(engine_rules={'include': ['L6'], 'exclude': []}))
lint_issue = [{'rule': 'BL1', 'severity': '必改', 'message': '画板 lint：节点越界'}]
dedupe_cases = (
    ('只因字号 + LY4 → 只留 LY4，消息注明另见 L6 字号', real_review(ok=False, must_fix=1, min_font_pt=5.25, issues=[font_issue]), ly4_small, False, True),
    ('字号 + 文字重叠 + LY4 → L6 照报（重叠），LY4 不注明', real_review(ok=False, must_fix=2, min_font_pt=5.25, issues=[font_issue, overlap_issue]), ly4_small, True, False),
    ('字号 + 画板 lint + LY4 → L6 照报（lint）', real_review(ok=False, must_fix=1, min_font_pt=5.25, issues=[font_issue], board_lint=lint_issue), ly4_small, True, False),
    ('字号 + whiteboard 错误 + LY4 → L6 照报（whiteboard）', real_review(ok=False, must_fix=2, min_font_pt=5.25, issues=[font_issue], whiteboard_check={'errors': 1, 'warnings': 0, 'summary': {}, 'issues': []}), ly4_small, True, False),
    ('字号 + 越界（machine 其他必改）+ LY4 → L6 照报', real_review(ok=False, must_fix=2, min_font_pt=5.25, issues=[font_issue, {'rule': 'render_overflow', 'severity': '必改', 'message': '文字越出画布'}]), ly4_small, True, False),
    ('只因字号但 render.json 没报 LY4 → L6 照报', real_review(ok=False, must_fix=1, min_font_pt=5.25, issues=[font_issue]), {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 5.25}], 'layout_issues': []}, True, False),
    ('只因字号 + LY4 指向别的图 → L6 照报', real_review(ok=False, must_fix=1, min_font_pt=5.25, issues=[font_issue]), {**ly4_small, 'layout_issues': [{**ly4_small['layout_issues'][0], 'target': 'figures/other.svg'}]}, True, False),
)
for label, rv, rjson, want_l6, want_note in dedupe_cases:
    c, r, o = qa(make_run(REAL_FIG_MD, {'figures/flow.svg': REAL_SVG, 'figures/flow.png': b'png', 'figures/review.json': rv, 'out/render.json': rjson}), pk_l6)
    ly4 = hits(r, 'LY4', '必改')
    want_ly4 = sum(1 for x in rjson['layout_issues'] if x['rule'] == 'LY4')
    check(f'L6/LY4 去重：{label}', r is not None and bool(hits(r, 'L6', '必改')) == want_l6 and len(ly4) == want_ly4
          and all(x['message'].endswith('（另见 L6 字号）') == want_note for x in ly4) and c == 3, (c, (r or {}).get('issues'), o[-300:]))
c, r, o = qa(make_run(REAL_FIG_MD, {'figures/flow.svg': REAL_SVG, 'figures/flow.png': b'png', 'figures/review.json': real_review(ok=False, must_fix=1, min_font_pt=5.25, issues=[font_issue]), 'out/render.json': ly4_small}), make_pack(), 'L6')
check('L6/LY4 去重：--only L6（不并入 render.json）时不让位，L6 照报，不会两条都不出现', r is not None and hits(r, 'L6', '必改') and not hits(r, 'LY4'), (r or {}).get('issues'))

rd_deep = make_run(T + '<!-- include: sections/a.md -->\n\n尾部 <!-- include: nope.md -->\n',
                   {'sections/a.md': '<!-- include: sections/b.md -->', 'sections/b.md': '<!-- include: sections/c.md -->',
                    'sections/c.md': '<!-- include: sections/d.md -->', 'sections/d.md': '第四层 <!-- include: nope.md -->'})
c, r, o = qa(rd_deep, make_pack(), 'L1')
res_deep = open(os.path.join(rd_deep, 'out', 'doc.resolved.md')).read()
check('include 配对：第 4 层原样插入的同名注释不抢后面真正白名单外记录（原样注释保留，后者写 FORBIDDEN）',
      '第四层 <!-- include: nope.md -->' in res_deep and '尾部 [[FORBIDDEN include: nope.md]]' in res_deep and res_deep.count('FORBIDDEN') == 1
      and bool(hits(r, 'L1', '必改', '只允许')) and bool(hits(r, 'L1', '必改', '3 层')), (res_deep, (r or {}).get('issues')))

rd_dotdot = make_run(T + '正文。\n', {'qa-result.json': {'generated_at': '2026-01-01T00:00:00', 'must_fix': 0, 'total': 0, 'issues': []}})
pk_dotdot = make_pack()
pj = json.load(open(os.path.join(pk_dotdot, 'pack.json'))); pj['qa']['rules_py'] = '..'; json.dump(pj, open(os.path.join(pk_dotdot, 'pack.json'), 'w'), ensure_ascii=False)
c, o, e = run([PY, QA, rd_dotdot, '--pack', pk_dotdot, '--no-state'])
check('rules_py 为「..」：在 validate 之前拦截，退出码 4，旧结果改名 .stale', c == 4 and '越出类型包目录' in o and os.path.exists(os.path.join(rd_dotdot, 'qa-result.json.stale')), (c, o[-300:], e[-300:]))

rd_u8 = make_run(T + '工期 3~5 周。\n')
pk_u8 = make_pack()
run([PY, os.path.join(DS, 'scripts', 'run_state.py'), rd_u8, 'init', '--type', 'tpack', '--mode', 'new', '--pack', pk_u8])
fake_u8 = os.path.join(BASE, 'fake-run-state-u8'); os.makedirs(fake_u8)
open(os.path.join(fake_u8, 'run_state.py'), 'w').write('import sys\nsys.stdout.buffer.write(b"\\xff\\xfe")\nsys.exit(0)\n')
c, o, e = run([PY, QA, rd_u8, '--pack', pk_u8, '--only', 'T3'], env=dict(os.environ, DOC_QA_RUN_STATE_DIR=fake_u8))
check('run_state 输出不是 UTF-8：退出码 4 并说明', c == 4 and 'UTF-8' in o, (c, o[-300:], e[-300:]))

long_meta = {'type': 'tpack', 'version': '1.0', 'related_docs': [{'type': 'prd', 'path': '../x', 'role': 'source_prd', 'title': '电子商务采购系统需求规格说明书'}]}
rule_case('C1 按 related_docs 标题实际长度回看（长标题紧邻的版本不报）', 'C1', T + '本方案 v1.1 草稿。\n', T + '依据电子商务采购系统需求规格说明书 v1.1 编写。\n', '提示', meta=long_meta)

pk_onlyimp = make_pack(rules_py='raise RuntimeError("导入副作用")\ndef check(doc, ctx):\n    return []\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_onlyimp, 'L1,')
check('--only「L1,」过滤空项，仍不导入类型包', r is not None and not hits(r, 'E-TYPE'), (c, (r or {}).get('issues'), o[-300:]))



def _hook_stderr_pack():
    def mut(p):
        p['qa']['engine_rules'] = {'include': [], 'exclude': []}
        p['hooks']['pre_qa'] = {'command': ['{python}', '{pack_dir}/hook.py'], 'desc': '测试钩子'}
    d = make_pack(mut)
    open(os.path.join(d, 'hook.py'), 'w').write('import sys\nsys.stderr.buffer.write(b"\\xff")\nprint("{\\"issues\\": []}")\n')
    return d


c, r, o = qa(make_run(T + '正文。\n'), _hook_stderr_pack())
check('pre_qa stderr 不是 UTF-8 → E-HOOK（与 stdout 同样处理）', c == 3 and bool(hits(r, 'E-HOOK', '必改', 'stderr')), (c, (r or {}).get('issues'), o[-300:]))

pk_app = make_pack()
c, r, o = qa(make_run(T + '## 正文\n\n## 附录 B 说明 {.appendix}\n'), pk_app, 'T5')
check('T5：带 .appendix 但手写字母 B 与自动编号 A 不一致 → 逐条建议', bool(hits(r, 'T5', '建议', '不一致')), (r or {}).get('issues'))
c, r, o = qa(make_run(T + '## 正文\n\n## 附录 A 说明 {.appendix}\n'), pk_app, 'T5')
check('T5：带 .appendix 且字母与自动编号一致 → 只进全文汇总提示', r is not None and not hits(r, 'T5', '建议') and bool(hits(r, 'T5', '提示')), (r or {}).get('issues'))

rd_sp = make_run(T + '## 背景\n\n正文 ![图](figures/a b.svg) 结束。\n', {'figures/a b.svg': SVG})
c, r, o = qa(rd_sp, make_pack(), 'L4')
check('L4：行内图片且路径含空格也检查（与旧正则 [^)]+ 一致）', bool(hits(r, 'L4', '建议', 'figures/a b.svg')), (r or {}).get('issues'))

pk_gl = make_pack(lambda p: p['qa'].update(glossary={'操作步骤': ['步骤']}))
c, r, o = qa(make_run('# 术语表\n\n这里写了步骤。\n'), pk_gl, 'T8')
c2, r2, o2 = qa(make_run('# 操作手册\n\n这里写了步骤。\n'), pk_gl, 'T8')
check('T8：文档主标题为「术语表」时整篇不查；普通主标题照查', r is not None and not hits(r, 'T8') and bool(hits(r2, 'T8')), ((r or {}).get('issues'), (r2 or {}).get('issues')))

# ---------------------------------------------------------------- 2d. Codex 第三轮复评（sol）的回归用例

render8 = {'figures': [{'src': 'figures/flow.svg', 'min_font_pt': 8}], 'layout_issues': []}
quotes_issue = {'rule': 'mmd_init_font_quotes', 'severity': '必改', 'message': 'init 指令 fontFamily 带引号', 'target': ''}
_no_mf = real_review(ok=False, min_font_pt=6, issues=[font_issue], whiteboard_check={'errors': 0, 'issues': []})
_no_mf['figures'][0]['machine'].pop('must_fix', None)
for label, rv, expect in (
        ('非字号必改 mmd_init_font_quotes（编号含 font）不被当作字号清除', real_review(ok=False, must_fix=1, min_font_pt=8, issues=[quotes_issue], whiteboard_check={'errors': 0, 'issues': []}), True),
        ('rule 与 message 拼起来含 font 也不算字号类', real_review(ok=False, must_fix=1, min_font_pt=6, issues=[{'rule': 'fo', 'severity': '必改', 'message': 'nt overlap'}]), True),
        ('machine.must_fix 与识别出的必改条数不符时不清除', real_review(ok=False, must_fix=2, min_font_pt=6, issues=[font_issue]), True),
        ('machine 缺 must_fix（Codex 第四轮复现）时不清除', _no_mf, True),
        ('LY4_font 且 must_fix 一致、render 字号达标时清除', real_review(ok=False, must_fix=1, min_font_pt=6, issues=[font_issue]), False)):
    c, r, o = qa(make_run(REAL_FIG_MD, {'figures/flow.svg': REAL_SVG, 'figures/flow.png': b'png', 'figures/review.json': rv, 'out/render.json': render8}), make_pack(), 'L6')
    check(f'L6：{label}', r is not None and bool(hits(r, 'L6', '必改')) == expect, (c, (r or {}).get('issues'), o[-300:]))

rd_ml = make_run(T + '<!-- include:\n nope.md -->\n<!-- include: nope.md -->\n尾行\n')
c, r, o = qa(rd_ml, make_pack(), 'L1')
res_ml = open(os.path.join(rd_ml, 'out', 'doc.resolved.md')).read()
src_lines = (T + '<!-- include:\n nope.md -->\n<!-- include: nope.md -->\n尾行\n').split('\n')
check('跨行 include 注释：两处白名单外 include 都写标记，行数与原文一致（尾行行号不变）',
      res_ml.count('[[FORBIDDEN include: nope.md]]') == 2 and len(res_ml.split('\n')) == len(src_lines) and res_ml.split('\n').index('尾行') == src_lines.index('尾行')
      and len(hits(r, 'L1', '必改', '只允许')) == 2, (res_ml, (r or {}).get('issues')))

rd_ff = make_run(T + '工期 3~5 周。\n', {'run-state.json': b'\xff', 'out/render.json': b'\xff\xfe', 'figures/review.json': b'\xff'})
c, o, e = run([PY, QA, rd_ff, '--pack', make_pack(), '--only', 'T3'])
check('run-state.json、render.json、review.json 不是 UTF-8：不崩溃，run-state 按不合法跳过（退出码 3，结果照写）',
      c == 3 and os.path.exists(os.path.join(rd_ff, 'qa-result.json')) and 'Traceback' not in o + e, (c, o[-300:], e[-300:]))
c, o, e = run([PY, QA, rd_ff, '--pack', make_pack()])
check('上述非 UTF-8 输入不加 --only 时同样不崩溃', c in (0, 3) and 'Traceback' not in o + e, (c, o[-300:], e[-300:]))

rd_nodoc = os.path.join(BASE, 'runs', 'onlycomma'); os.makedirs(rd_nodoc)
c, o, e = run([PY, QA, rd_nodoc, '--pack', make_pack(), '--only', ','])
check('--only「,」全空：在检查源文件、解析之前退出码 2', c == 2 and '--only' in o and not os.path.exists(os.path.join(rd_nodoc, 'out')), (c, o[-200:]))

c, r, o = qa(make_run('# 术语表编写指南\n\n这里写了步骤。\n'), pk_gl, 'T8')
c2, r2, o2 = qa(make_run(T + '## 术语表编写说明\n\n这里写了步骤。\n'), pk_gl, 'T8')
check('T8：主标题或章节标题只是含「术语表」字样（不等于术语表）时照查', bool(hits(r, 'T8')) and bool(hits(r2, 'T8')), ((r or {}).get('issues'), (r2 or {}).get('issues')))

# ---------------------------------------------------------------- 3. 过滤、定级覆盖、截断

pk_ex = make_pack(lambda p: p['qa'].update(engine_rules={'include': 'all', 'exclude': ['T3', 'T9']}))
c, r, o = qa(make_run(T + '工期 3~5 周，用 `x`。\n'), pk_ex)
check('engine_rules.exclude 关闭 T3、T9', r is not None and not hits(r, 'T3') and not hits(r, 'T9') and 'T3' not in r['engine']['rules_run'], (r or {}).get('engine'))
pk_inc = make_pack(lambda p: p['qa'].update(engine_rules={'include': ['L1', 'L2', 'L4', 'C1', 'R1'], 'exclude': []}))
c, r, o = qa(make_run(T + '工期 3~5 周，用 `x`，零风险。\n'), pk_inc)
check('engine_rules.include 列表只跑列出的规则（迁移期配置）', r is not None and r['engine']['rules_run'] == ['L1', 'L2', 'C1', 'R1', 'L4'] or sorted(r['engine']['rules_run']) == ['C1', 'L1', 'L2', 'L4', 'R1'], (r or {}).get('engine'))
check('迁移期配置下 L2、R1 照常命中，T 规则不跑', r is not None and hits(r, 'L2') and hits(r, 'R1') and not any(x['rule'].startswith('T') for x in r['issues']), (r or {}).get('issues'))
pk_ov = make_pack(lambda p: p['qa'].update(severity_overrides={'T3': '提示'}))
c, r, o = qa(make_run(T + '工期 3~5 周。\n'), pk_ov, 'T3')
check('severity_overrides 改定级（T3 必改 → 提示，退出码 0）', c == 0 and hits(r, 'T3', '提示'), (c, (r or {}).get('issues')))
many = T + '\n\n'.join(f'第{i}段文字' for i in range(40)) + '\n'
c, r, o = qa(make_run(many), make_pack(), 'T1')
t1 = hits(r, 'T1')
check('单条规则超过 30 条时保留 30 条并追加汇总', len(t1) == 31 and any(x['line'] == 0 and '另有 10 处' in x['message'] for x in t1), [x['message'] for x in t1][-2:])
sys.path.insert(0, os.path.join(DQ, 'scripts'))
import qa as qa_mod  # noqa: E402
mixed = [{'rule': 'Z', 'severity': '建议', 'line': i + 1, 'excerpt': '', 'message': f'm{i}'} for i in range(31)] + \
        [{'rule': 'Z', 'severity': '必改', 'line': 99, 'excerpt': '', 'message': '隐藏的必改'}, {'rule': 'Z', 'severity': '提示', 'line': 100, 'excerpt': '', 'message': 'p'}]
fin = qa_mod.finalize(copy.deepcopy(mixed), {})
summary = [x for x in fin if x['line'] == 0]
check('截断（混合定级）：第 31 条之后的必改不折叠、照常计入；汇总条定级取被折叠问题中最高的',
      any(x['message'] == '隐藏的必改' and x['severity'] == '必改' for x in fin) and len(summary) == 1 and summary[0]['severity'] == '建议' and '另有 2 处' in summary[0]['message'], fin[-3:])
same = qa_mod.finalize([{'rule': 'L1', 'severity': '建议', 'line': 1, 'excerpt': '', 'message': 'a'},
                        {'rule': 'L1', 'severity': '必改', 'line': 1, 'excerpt': '', 'message': 'b'},
                        {'rule': 'L3', 'severity': '必改', 'line': 0, 'excerpt': '', 'message': 'x'},
                        {'rule': 'L3', 'severity': '必改', 'line': 0, 'excerpt': '', 'message': 'y'}], {})
check('同规则同行不同消息合并为一条，保留定级更高的一条并注明另有 N 条；行号 0 的全文级问题不合并',
      [x['message'] for x in same] == ['b（同一行另有 1 条同规则问题）', 'x', 'y'] and same[0]['severity'] == '必改', same)
pk_dup = make_pack(rules_py='def check(doc, ctx):\n    return [ctx.issue("ZZ1", "提示", 3, "x", "同一条")] * 2\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_dup)
check('(rule, line, message) 完全相同的问题去重（与旧脚本的有意差异）', len(hits(r, 'ZZ1')) == 1, (r or {}).get('issues'))

# ---------------------------------------------------------------- 4. 类型包、钩子、render.json

pk_type = make_pack(rules_py='def check(doc, ctx):\n    return [ctx.issue("TP1", "建议", 1, doc.title, "类型包规则命中：" + doc.title)]\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_type)
check('类型包 check(doc, ctx) 结果并入，rule_source=type', any(x['rule'] == 'TP1' and x.get('rule_source') == 'type' and '测试文档' in x['message'] for x in (r or {}).get('issues', [])), o[-300:])
check('引擎规则 rule_source=engine', r is not None and all(x.get('rule_source') == 'engine' for x in r['issues'] if x['rule'][0] in 'LSXCRHT' and x['rule'] != 'TP1'), (r or {}).get('issues'))
pk_raise = make_pack(rules_py='def check(doc, ctx):\n    raise ValueError("故意抛错")\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_raise)
check('类型包抛异常记 E-TYPE 必改，退出码 3', c == 3 and hits(r, 'E-TYPE', '必改', '故意抛错'), (c, o[-300:]))
pk_bad = make_pack(rules_py='def check(doc, ctx):\n    return [{"rule": "T1", "severity": "严重", "line": 1, "message": "x"}, {"rule": "L1", "severity": "提示", "line": 1, "message": "占号"}]\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_bad)
check('类型包返回非法定级、占用引擎编号记 E-TYPE', len(hits(r, 'E-TYPE')) == 2, (r or {}).get('issues'))
pk_rel = make_pack(rules_py='def check(doc, ctx):\n    d = ctx.related("prd", role="source_prd")\n    return [ctx.missing_related_issue("TP2", "prd", role="source_prd", for_gate=True)] if d is None else []\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_rel)
check('ctx.related 未登记 → missing_related_issue（for_gate 为必改）', bool(hits(r, 'TP2', '必改')), (r or {}).get('issues'))
amb_meta = {'type': 'tpack', 'version': '1.0', 'related_docs': [{'type': 'prd', 'path': '../a', 'role': 'x'}, {'type': 'prd', 'path': '../b', 'role': 'y'}]}
pk_amb = make_pack(rules_py='def check(doc, ctx):\n    ctx.related("prd")\n    return []\n')
c, r, o = qa(make_run(T + '正文。\n', meta=amb_meta), pk_amb)
check('ctx.related 同条件命中多份 → E-TYPE（AmbiguousRelated）', bool(hits(r, 'E-TYPE', '必改', 'AmbiguousRelated')), (r or {}).get('issues'))


def hook_pack(script, code_list_timeout=None):
    def mut(p):
        p['qa']['engine_rules'] = {'include': [], 'exclude': []}
        cmd = {'command': ['{python}', '{pack_dir}/hook.py', '{run_dir}'], 'desc': '测试钩子'}
        if code_list_timeout: cmd['timeout_s'] = code_list_timeout
        p['hooks']['pre_qa'] = cmd
    d = make_pack(mut)
    open(os.path.join(d, 'hook.py'), 'w').write(script)
    return d


c, r, o = qa(make_run(T + '正文。\n'), hook_pack('import json, os, sys\nassert os.environ["DOC_TYPE"] == "tpack" and os.getcwd() == os.path.realpath(sys.argv[1])\n'
                                                  'print(json.dumps({"issues": [{"rule": "BZ1", "severity": "必改", "line": 0, "excerpt": "", "message": "钩子问题"}]}))\nsys.exit(3)\n'))
check('pre_qa 退出码 3 + JSON：问题并入，rule_source=hook', c == 3 and any(x['rule'] == 'BZ1' and x.get('rule_source') == 'hook' for x in (r or {}).get('issues', [])), (c, o[-400:]))
c, r, o = qa(make_run(T + '正文。\n'), hook_pack('import sys\nsys.exit(5)\n'))
check('pre_qa 退出码不是 0/3 → E-HOOK 必改', bool(hits(r, 'E-HOOK', '必改', '退出码 5')), (r or {}).get('issues'))
c, r, o = qa(make_run(T + '正文。\n'), hook_pack('print("not json")\n'))
check('pre_qa stdout 非 JSON → E-HOOK', bool(hits(r, 'E-HOOK', '必改', '不是合法 JSON')), (r or {}).get('issues'))
c, r, o = qa(make_run(T + '正文。\n'), hook_pack('import time\ntime.sleep(5)\n', 1))
check('pre_qa 超时 → E-HOOK', bool(hits(r, 'E-HOOK', '必改', '超时')), (r or {}).get('issues'))
def hook_pack_cmd(command):
    def mut(p):
        p['qa']['engine_rules'] = {'include': [], 'exclude': []}
        p['hooks']['pre_qa'] = {'command': command, 'desc': '测试钩子'}
    return make_pack(mut)
c, r, o = qa(make_run(T + '正文。\n'), hook_pack_cmd(['{python}', '-c', "print('{}')"]))
check('pre_qa 命令含字面花括号（占位符展开失败）→ E-HOOK，不崩溃', c == 3 and hits(r, 'E-HOOK', '必改', '占位符'), (c, o[-300:]))
c, r, o = qa(make_run(T + '正文。\n'), hook_pack('import sys\nsys.stdout.buffer.write(b"\\xff\\xfe")\n'))
check('pre_qa stdout 不是 UTF-8 → E-HOOK', c == 3 and hits(r, 'E-HOOK', '必改', 'UTF-8'), (c, o[-300:]))
c, r, o = qa(make_run(T + '正文。\n'), hook_pack('import json\nprint(json.dumps({"issues": []}))\n'), extra=['--no-hooks'])
check('--no-hooks 不执行钩子', r is not None and 'hook:pre_qa' not in r['engine']['rules_run'], (r or {}).get('engine'))

rd_badpack = make_run(T + '正文。\n', {'qa-result.json': {'generated_at': '2026-01-01T00:00:00', 'must_fix': 0, 'total': 0, 'issues': []}})
bad_dir = os.path.join(BASE, 'packs', 'broken'); os.makedirs(bad_dir); open(os.path.join(bad_dir, 'pack.json'), 'w').write('{不是 JSON')
c, o, e = run([PY, QA, rd_badpack, '--pack', bad_dir, '--no-state'])
check('pack.json 不是合法 JSON：退出码 4，旧 qa-result.json 改名为 .stale', c == 4 and not os.path.exists(os.path.join(rd_badpack, 'qa-result.json')) and os.path.exists(os.path.join(rd_badpack, 'qa-result.json.stale')), (c, o[-300:], e[-300:]))
pk_trav = make_pack()
pj = json.load(open(os.path.join(pk_trav, 'pack.json'))); pj['qa']['rules_py'] = '../outside.py'; json.dump(pj, open(os.path.join(pk_trav, 'pack.json'), 'w'), ensure_ascii=False)
open(os.path.join(os.path.dirname(pk_trav), 'outside.py'), 'w').write('def check(doc, ctx):\n    return []\n')
c, o, e = run([PY, QA, make_run(T + '正文。\n'), '--pack', pk_trav, '--no-state'])
check('qa.rules_py 越出类型包目录：退出码 4，不加载', c == 4 and '越出类型包目录' in o, (c, o[-300:]))
pk_imp = make_pack(rules_py='raise RuntimeError("导入副作用")\ndef check(doc, ctx):\n    return []\n')
c, r, o = qa(make_run(T + '正文。\n'), pk_imp, 'L1')
check('--only 只含引擎规则时不导入类型包（导入异常不出现）', r is not None and not hits(r, 'E-TYPE'), (r or {}).get('issues'))
c, r, o = qa(make_run(T + '正文。\n'), pk_imp)
check('不加 --only 时类型包导入异常照记 E-TYPE 必改', c == 3 and bool(hits(r, 'E-TYPE', '必改', '导入副作用')), (c, (r or {}).get('issues')))
c, r, o = qa(make_run(T + '工期 3~5 周。\n', {'out/render.json': {'layout_issues': [{'rule': '', 'severity': '建议', 'message': 'x'}]}}), make_pack(), None)
check('render.json layout_issues 的空 rule 补为 LY，结果仍过 schema', c in (0, 3) and any(x['rule'] == 'LY' for x in (r or {}).get('issues', [])), (c, o[-300:]))

rj9 = {'layout_issues': [{'rule': 'LY9', 'severity': '建议', 'message': '第 5 页正文只有 120 字（阈值 400），且不是章末页', 'page': 5, 'target': 'page-5'},
                         {'rule': 'LY10', 'severity': '建议', 'message': '正文「修订记录」与自动生成的修订记录页重复', 'page': 3, 'target': 'h-2'}],
       'highlights': {'total': 4, 'per_page': {'6': 4}, 'items': []}}
c, r, o = qa(make_run(HL(4), {'out/render.json': rj9, 'out/render.highlights.json': {'total': 0, 'per_page': {}, 'items': []}}), make_pack(lambda p: p['qa'].update(engine_rules={'include': ['H2'], 'exclude': []})))
check('render.json 的 LY9、LY10 按原定级并入（file=out/render.json，位置含页码）', any(x['rule'] == 'LY9' and x['severity'] == '建议' and x.get('file') == 'out/render.json' and '第 5 页' in x['excerpt'] for x in (r or {}).get('issues', []))
      and any(x['rule'] == 'LY10' and x['severity'] == '建议' for x in (r or {}).get('issues', [])), (r or {}).get('issues'))
check('H2 优先读 render.json 顶层 highlights（旁路文件为空也不影响）', any(x['rule'] == 'H2' and x.get('file') == 'out/render.json' and '第 6 页' in x['message'] for x in (r or {}).get('issues', [])), (r or {}).get('issues'))

rj = {'layout_issues': [{'rule': 'LY3', 'severity': '必改', 'message': '表格没有 thead', 'page': 4, 'target': 'tbl:x'}]}
c, r, o = qa(make_run(T + '正文。\n', {'out/render.json': rj}), make_pack(lambda p: p['qa'].update(engine_rules={'include': [], 'exclude': []})))
check('render.json layout_issues 并入（file=out/render.json，计入必改）', c == 3 and any(x['rule'] == 'LY3' and x.get('file') == 'out/render.json' and '第 4 页' in x['excerpt'] for x in (r or {}).get('issues', [])), (c, (r or {}).get('issues')))

# ---------------------------------------------------------------- 5. qa-report、run_state、退出码

rd_rep = make_run(T + '工期 3~5 周。\n', {'qa-report.md': '# 质检报告\n\n## 人工检查\n\n人工结论保留。\n\n## 自动检查（qa_checks.py）\n\n旧区块\n\n## Codex 两轮\n\n记录保留。\n'})
qa(rd_rep, make_pack(), 'T3'); qa(rd_rep, make_pack(), 'T3')
rep = open(os.path.join(rd_rep, 'qa-report.md')).read()
check('qa-report.md：自动区块覆盖且只有一份，人工区块保留，旧 qa_checks 区块移除',
      rep.count('<!-- qa-auto:start -->') == 1 and '人工结论保留' in rep and '记录保留' in rep and '旧区块' not in rep and '| 编号 | 规则 | 定级 | 位置 | 原文摘录 | 证据 | 修改指令 | 状态 | 复核记录 |' in rep and '| Q1 | T3 | 必改 | 第 3 行 |' in rep, rep[-800:])

rd_st = make_run(T + '工期 3~5 周。\n')
pk_st = make_pack()
c, o, e = run([PY, os.path.join(DS, 'scripts', 'run_state.py'), rd_st, 'init', '--type', 'tpack', '--mode', 'new', '--pack', pk_st])
st = json.load(open(os.path.join(rd_st, 'run-state.json')))
for g in ('D0', 'D1', 'D2', 'D3'):
    st['gates'][g] = {'status': 'passed', 'at': '2026-09-15T10:00:00+08:00', 'evidence': ['测试']}
json.dump(st, open(os.path.join(rd_st, 'run-state.json'), 'w'), ensure_ascii=False)
c, r, o = qa(rd_st, pk_st, 'T3', extra=['--state'])
st2 = json.load(open(os.path.join(rd_st, 'run-state.json')))
check('run_state 写回：阶段置 qa；有必改而 D3 已通过时 fail-gate D3', st2['stage'] == 'qa' and st2['gates']['D3']['status'] == 'failed' and st2['gates']['D4']['status'] == 'pending', (o[-300:], st2['gates']))
rd_fail = make_run(T + '工期 3~5 周。\n')
pk_fail = make_pack()
run([PY, os.path.join(DS, 'scripts', 'run_state.py'), rd_fail, 'init', '--type', 'tpack', '--mode', 'new', '--pack', pk_fail])
fake_rs = os.path.join(BASE, 'fake-run-state'); os.makedirs(fake_rs)
open(os.path.join(fake_rs, 'run_state.py'), 'w').write('import sys\nprint("写回失败（模拟）")\nsys.exit(2)\n')
c, o, e = run([PY, QA, rd_fail, '--pack', pk_fail, '--only', 'T3'], env=dict(os.environ, DOC_QA_RUN_STATE_DIR=fake_rs))
check('run_state 写回失败：退出码 4 并说明，不静默（qa-result.json 按本次结果写入）', c == 4 and 'run-state 写回' in o and json.load(open(os.path.join(rd_fail, 'qa-result.json')))['must_fix'] == 1, (c, o[-400:]))
rd_leg = make_run(T + '正文。\n', {'run-state.json': {'gates': {'G0': 'passed'}}})
c, o, e = run([PY, QA, rd_leg, '--pack', make_pack()])
check('旧版 G0–G4 run-state.json：跳过写回并注明，不影响质检结果', c in (0, 3) and '"skipped"' in o and json.load(open(os.path.join(rd_leg, 'run-state.json'))) == {'gates': {'G0': 'passed'}}, o[-300:])

rd_nosrc = os.path.join(BASE, 'runs', 'nosrc'); os.makedirs(rd_nosrc)
c, o, e = run([PY, QA, rd_nosrc, '--pack', make_pack()])
check('退出码 1：缺源文件', c == 1, o)
c, o, e = run([PY, QA, os.path.join(BASE, 'nope'), '--pack', make_pack()])
check('退出码 2：运行目录不存在', c == 2, o)
c, o, e = run([PY, QA, make_run(T), '--type', 'no-such-type'])
check('退出码 2：找不到类型包', c == 2 and '找不到类型包' in o, o)
pk_inv = make_pack(lambda p: p.update(cover='poster'))
c, o, e = run([PY, QA, make_run(T), '--pack', pk_inv])
check('退出码 4：类型包不合法（schema）', c == 4 and '"step": "pack"' in o, o[-300:])
c, r, o = qa(make_run(T + '工期 3~5 周。\n'), make_pack(), 'T3')
check('退出码 3：有必改；0：无必改', c == 3 and qa(make_run(T + '工期 3–5 周。\n'), make_pack(), 'T3')[0] == 0, c)

# ---------------------------------------------------------------- 6. 售前：golden、7 条回归、旧新等价、两个 qa_rules 一致

OVERLAY = json.load(open(os.path.join(H, 'fixtures', 'presales-migration-overlay.json')))


def presales_pack(pid, overlay=True):
    d = os.path.join(BASE, 'presales-packs', f'{pid}-{"ov" if overlay else "landed"}')
    if not os.path.exists(d):
        shutil.copytree(os.path.join(DS, 'types', pid), d)
        p = json.load(open(os.path.join(d, 'pack.json')))
        if overlay:
            for k, v in OVERLAY.items():
                if k.startswith('_'): continue
                if isinstance(v, dict): p[k].update(v)
                else: p[k] = v
        json.dump(p, open(os.path.join(d, 'pack.json'), 'w'), ensure_ascii=False, indent=2)
    return d


a = open(os.path.join(DS, 'types', 'presales-site', 'qa_rules.py')).read().split('\n')
b = open(os.path.join(DS, 'types', 'presales-reddit', 'qa_rules.py')).read().split('\n')
site_mark = next((i for i, x in enumerate(a) if x.startswith('# ==== presales-site 专属规则')), None)
check('两个售前包的 qa_rules.py：共同部分除 PACK_ID 外逐字一致，presales-site 只在末尾追加专属段（W3-A）',
      site_mark is not None and site_mark >= len(b) and [x for x, y in zip(a[:len(b)], b) if x != y] == ["PACK_ID = 'presales-site'"]
      and all(x.strip() == '' for x in a[len(b):site_mark]), ([x for x, y in zip(a, b) if x != y][:5], site_mark, len(b)))
W3A_SITE_RULES = ('SITE-06', 'SITE-07', 'SITE-08', 'SITE-09')


def strip_site(res):
    """与旧脚本 / 基线逐项比对前剔除 W3-A 新增的 presales-site 专属规则（这些规则另有独立正反例，见 6b）。"""
    if not res:
        return res or {}
    iss = [x for x in res['issues'] if x['rule'] not in W3A_SITE_RULES]
    return dict(res, issues=iss, total=len(iss), must_fix=sum(1 for x in iss if x['severity'] == '必改'))
for pid in ('presales-site', 'presales-reddit'):
    c, o, e = run([PY, os.path.join(DS, 'scripts', 'validate.py'), os.path.join(DS, 'types', pid), '--kind', 'pack'])
    check(f'types/{pid}/pack.json 连同 qa_rules.py、qa-rules.md 通过 validate', c == 0, o[-300:])
    c, o, e = run([PY, os.path.join(DS, 'scripts', 'validate.py'), presales_pack(pid), '--kind', 'pack'])
    check(f'{pid} 迁移期覆盖配置通过 validate', c == 0, o[-300:])

if FAST:
    skip('golden 与售前等价比对', '--fast')
elif not os.path.isdir(G):
    skip('golden 与售前等价比对', f'找不到 {G}')
else:
    sys.path.insert(0, G)
    import compare  # noqa: E402
    GD = os.path.join(BASE, 'golden'); os.makedirs(GD)
    cases = (('smoke-site', 'site'), ('smoke-reddit', 'reddit'), ('smoke-guards', 'guards'), ('mobyvow-site-v4.0', 'site-v4.0'))
    for mode in ('overlay', 'landed'):
        for gold, sub in cases:
            dest = os.path.join(GD, mode); os.makedirs(dest, exist_ok=True)
            subprocess.run(['tar', 'xzf', os.path.join(G, 'inputs', f'{gold}.tgz'), '-C', dest], check=True)
            rd = os.path.join(dest, sub)
            pid = 'presales-reddit' if json.load(open(os.path.join(rd, 'brief.json'))).get('line') == 'reddit' else 'presales-site'
            c, r, o = qa(rd, presales_pack(pid, mode == 'overlay'))
            base = json.load(open(os.path.join(G, gold, 'qa-result.json')))
            if r is None:
                check(f'golden {gold}（{mode}）运行', False, o[-500:]); continue
            nb, nn = compare.norm_qa(base), compare.norm_qa(strip_site(r))
            if mode == 'overlay':
                check(f'golden {gold}：迁移期配置下 qa-result 与基线逐项一致（compare.py 口径）', nb == nn,
                      {'only_base': [i for i in nb['issues'] if i not in nn['issues']], 'only_new': [i for i in nn['issues'] if i not in nb['issues']]})
                check(f'golden {gold}：out/proposal.resolved.md 与基线逐字一致', open(os.path.join(rd, 'out', 'proposal.resolved.md')).read() == open(os.path.join(G, gold, 'proposal.resolved.md')).read())
                check(f'golden {gold}：W3-A 新增 SITE 规则只有提示，must_fix 与基线一致', r['must_fix'] == base['must_fix']
                      and all(x['severity'] == '提示' for x in r['issues'] if x['rule'] in W3A_SITE_RULES), [x for x in r['issues'] if x['rule'] in W3A_SITE_RULES])
                if gold == 'smoke-guards':
                    check('守卫：白名单外 include 在新引擎路径上退出码 3 且含 L1 必改', c == 3 and hits(r, 'L1', '必改'), c)
            else:
                lost = [i for i in nb['issues'] if i not in nn['issues']]
                check(f'golden {gold}：落位 pack.json 原样运行只新增不丢失旧结果（新增 {nn["total"] - nb["total"]} 条，差异见 wave2/qa-calibration.md）', not lost, lost)

    # 售前 7 条回归（presales-qa/tests/run_tests.py 的等价用例，调用新引擎；原测试文件不改）
    WK = os.path.join(BASE, 'waykar')
    wres = {}
    for who in ('old', 'new'):
        d = os.path.join(WK, who); os.makedirs(d)
        shutil.copy(os.path.join(SK, 'presales-qa', 'tests', 'fixtures', 'waykar-v18-excerpt.md'), os.path.join(d, 'proposal.md'))
        json.dump({"client": "Waykar", "line": "site", "version": "1.8", "overview": []}, open(os.path.join(d, 'brief.json'), 'w'))
        run([PY, os.path.join(SK, 'presales-pricing', 'scripts', 'price_site.py'), os.path.join(SK, 'presales-pricing', 'tests', 'fixtures', 'waykar-site-input.json'), '--out', os.path.join(d, 'pricing')])
        if who == 'old':  # 1f：qa_checks.py 已改为 doc-qa 包装，旧脚本结果读冻结 fixture（fixtures/legacy-frozen/README.md）
            wres[who] = json.load(open(os.path.join(H, 'fixtures', 'legacy-frozen', 'waykar-qa-result.json')))
        else:
            wres[who] = qa(d, presales_pack('presales-site'))[1]
    msgs = [(x['rule'], x['message']) for x in (wres['new'] or {}).get('issues', [])]
    check('售前回归 1：A3 抓到「一半」', any(r0 == 'A3' and '一半' in m for r0, m in msgs))
    check('售前回归 2：R1 抓到「零风险」', any(r0 == 'R1' and '零风险' in m for r0, m in msgs))
    check('售前回归 3：F2 抓到 Hydrogen（Remix）', any(r0 == 'F2' for r0, m in msgs))
    check('售前回归 4：F4 抓到「零成本」或「找回 1/3」', any(r0 == 'F4' and ('零成本' in m or '找回' in m) for r0, m in msgs))
    check('售前回归 5：R2 不把 ClaudeBot 当泄露', not any(r0 == 'R2' and 'Claude' in m for r0, m in msgs))
    check('售前回归 6：A1 不把价格带、月费当报价', not any(r0 == 'A1' for r0, m in msgs))
    check('售前回归 7：A3 不把「找回 1/3」当报价比例', not any(r0 == 'A3' and '1/3' in m for r0, m in msgs))
    def contract_norm(res):
        """旧脚本结果按 qa-engine.md §3 合并（同规则同行只留一条）后再比：新旧之间唯一允许的差异就是这一条契约。"""
        iss = qa_mod.finalize([dict(x) for x in strip_site(res)['issues']], {})  # 旧入口迁移后同样会跑 presales-site 专属 SITE 规则，两侧都剔除
        return compare.norm_qa({'must_fix': sum(1 for x in iss if x['severity'] == '必改'), 'total': len(iss), 'issues': iss})
    check('Waykar 摘句：旧 qa_checks.py 结果按 §3 同行合并后与新引擎逐项一致', contract_norm(wres['old']) == compare.norm_qa(strip_site(wres['new'])),
          {'old': compare.norm_qa(strip_site(wres['old']))['issues'], 'new': strip_site(wres['new']).get('issues')})

    # 边界夹具：旧脚本与新引擎逐项一致（include 嵌套与越界、占位符、行内代码、波浪号、C1、C2、C3、A1、A2、A3、B1、F2、F4、R1–R3、L3、L5、L4）
    EQ = os.path.join(H, 'fixtures', 'equivalence')
    for who in ('old', 'new'):
        d = os.path.join(BASE, 'equiv', who)
        shutil.copytree(EQ, d)
        if who == 'old':  # 1f：同上，读迁移前旧脚本在本夹具上的冻结输出
            wres['eq_old'] = json.load(open(os.path.join(H, 'fixtures', 'legacy-frozen', 'equivalence-qa-result.json')))
            wres['eq_old_resolved'] = open(os.path.join(H, 'fixtures', 'legacy-frozen', 'equivalence-proposal.resolved.md')).read()
        else:
            wres['eq_new'] = qa(d, presales_pack('presales-site'))[1]
            wres['eq_new_resolved'] = open(os.path.join(d, 'out', 'proposal.resolved.md')).read()
    eo, en = contract_norm(wres['eq_old']), compare.norm_qa(strip_site(wres['eq_new']))
    rules_hit = sorted({x['rule'] for x in compare.norm_qa(strip_site(wres['eq_old']))['issues']})
    check(f'边界夹具：旧脚本命中 {len(rules_hit)} 类规则（{",".join(rules_hit)}），夹具有效', {'A1', 'A2', 'A3', 'B1', 'C1', 'C2', 'C3', 'F2', 'F4', 'L1', 'L2', 'L4', 'R1', 'R2', 'R3'} <= set(rules_hit), rules_hit)
    check('边界夹具：旧脚本结果按 §3 同行合并后与新引擎逐项一致', eo == en,
          {'only_old': [i for i in eo['issues'] if i not in en['issues']], 'only_new': [i for i in en['issues'] if i not in eo['issues']]})
    check('边界夹具：resolved.md 与旧脚本逐字一致（含嵌套 include 与 FORBIDDEN / UNRESOLVED 标记）', wres['eq_old_resolved'] == wres['eq_new_resolved'])

# ---------------------------------------------------------------- 6b. W3-A：S1 按 mode 取骨架、T11 优先级、类型包 qa_rules、presales-site 专属规则
import re  # noqa: E402

MODE_SK = [{'id': 'bg', 'title': '背景与目标', 'level': 1, 'required': True}, {'id': 'sol', 'title': '解法', 'level': 1, 'required': True},
           {'id': 'faq', 'title': '常见问题', 'level': 1, 'required': False}]
MODES_FX = {'field': 'site.project_type', 'default': 'base', 'items': [
    {'id': 'base', 'name': '基础'},
    {'id': 'alt', 'name': '新建', 'aliases': ['0-1'], 'skeleton_patch': {'bg': {'title': '业务盘点', 'aliases': ['资产盘点']}}},
    {'id': 'migration', 'name': '迁移', 'skeleton_insert': [{'after': 'sol', 'section': {'id': 'mig', 'title': '数据迁移与切换', 'level': 1, 'required': True}}]}]}
pk_mode = make_pack(lambda p: p.update(skeleton=copy.deepcopy(MODE_SK), modes=copy.deepcopy(MODES_FX)))


def s1_msgs(md, meta=None, files=None):
    c, r, o = qa(make_run(T + md, files, meta or {'type': 'tpack', 'version': '1.0'}), pk_mode, 'S1')
    return r, [x['message'] for x in hits(r, 'S1')], o


MM = lambda v: {'type': 'tpack', 'version': '1.0', 'site': {'project_type': v}}
r, m, o = s1_msgs('## 业务盘点\n\n## 解法\n', MM('alt'))
check('S1 mode：alt 用补丁后的新章节名通过', r is not None and not m, (m, o[-300:]))
r, m, o = s1_msgs('## 资产盘点\n\n## 解法\n', MM('0-1'))
check('S1 mode：mode 别名（0-1）与补丁 aliases 生效', r is not None and not m, m)
r, m, o = s1_msgs('## 业务盘点\n\n## 解法\n')
check('S1 mode：字段缺失取 default，新章节名报缺「背景与目标」', len(m) == 1 and '背景与目标' in m[0], m)
r, m, o = s1_msgs('## 背景与目标\n\n## 解法\n', MM('alt'))
check('S1 mode：alt 下基础标题不再算数（补丁替换标题），报缺「业务盘点」并注明 mode', len(m) == 1 and '业务盘点' in m[0] and 'mode alt' in m[0], m)
r, m, o = s1_msgs('## 背景与目标\n\n## 解法\n', MM('migration'))
check('S1 mode：migration 缺插入章「数据迁移与切换」报必改', len(m) == 1 and '数据迁移与切换' in m[0] and bool(hits(r, 'S1', '必改')), m)
r, m, o = s1_msgs('## 背景与目标\n\n## 解法\n\n## 数据迁移与切换\n', MM('migration'))
check('S1 mode：migration 写了插入章不报', r is not None and not m, m)
r, m, o = s1_msgs('## 背景与目标\n\n## 解法\n', {'type': 'tpack', 'version': '1.0', 'site': {'migration': True}})
check('S1 mode：兼容旧写法 site.migration=true → migration', len(m) == 1 and '数据迁移与切换' in m[0], m)
r, m, o = s1_msgs('## 背景与目标\n\n## 解法\n', MM('new-site'))
check('S1 mode：未知 mode 报配置错误必改一条，不按默认骨架报缺章', len(m) == 1 and 'mode 配置错误' in m[0] and bool(hits(r, 'S1', '必改')), m)
r, m, o = s1_msgs('## 业务盘点\n\n## 解法\n', None, {'brief.json': {'site': {'project_type': 'alt'}}})
check('S1 mode：doc.json 没有该字段时回退读 brief.json', r is not None and not m, m)
r, m, o = s1_msgs('## 业务盘点\n\n## 解法\n', {'type': 'tpack', 'version': '1.0', 'site': {}}, {'brief.json': {'site': {'project_type': 'alt'}}})
check('S1 mode：doc.json 有 site 但缺 project_type（完整路径缺失）仍回退 brief.json', r is not None and not m, m)
r, m, o = s1_msgs('## 业务盘点\n\n## 解法\n', MM('bogus'), {'brief.json': {'site': {'project_type': 'alt'}}})
check('S1 mode：doc.json 的非法值不被 brief.json 覆盖（照报配置错误）', len(m) == 1 and 'mode 配置错误' in m[0], m)

SITE_PACK = json.load(open(os.path.join(DS, 'types', 'presales-site', 'pack.json')))


def site_pack_s1():
    d = os.path.join(BASE, 'presales-packs', 'site-s1')
    if not os.path.exists(d):
        shutil.copytree(os.path.join(DS, 'types', 'presales-site'), d, ignore=shutil.ignore_patterns('__pycache__'))
        p = json.load(open(os.path.join(d, 'pack.json')))
        p['qa']['engine_rules'] = {'include': ['S1'], 'exclude': []}
        json.dump(p, open(os.path.join(d, 'pack.json'), 'w'), ensure_ascii=False, indent=2)
    return d


def site_md(mode):
    return '# 集成测试建站方案\n\n' + '\n\n'.join(f'## {s["title"]}\n\n正文。' for s in validate.resolve_skeleton(SITE_PACK, mode) if s.get('required')) + '\n'


def site_s1(md, brief):
    _seq[0] += 1
    rd = os.path.join(BASE, 'runs', f'site-s1-{_seq[0]}'); os.makedirs(rd)
    open(os.path.join(rd, 'proposal.md'), 'w').write(md)
    json.dump(brief, open(os.path.join(rd, 'brief.json'), 'w'), ensure_ascii=False)
    c, r, o = qa(rd, site_pack_s1(), 'S1')
    return [x['message'] for x in hits(r, 'S1')], o


m, o = site_s1(site_md('greenfield'), {'site': {'project_type': 'greenfield'}})
check('S1 反向集成（presales-site 真实包打开 S1）：greenfield 用 0-1 章节名（01 业务与资产盘点、02 从第一天做对 SEO/GEO 地基）通过',
      not m and '01 业务与资产盘点' in site_md('greenfield') and '02 从第一天做对 SEO/GEO 地基' in site_md('greenfield'), (m, o[-300:]))
m, o = site_s1(site_md('greenfield'), {})
check('S1 反向集成：同一正文不写 project_type（rebuild）→ 报缺「01 背景与目标」', any('01 背景与目标' in x for x in m), m)
m, o = site_s1(site_md('rebuild'), {'site': {'project_type': '迁移'}})
check('S1 反向集成：migration（别名「迁移」）缺「数据迁移与切换」→ 必改一条', len(m) == 1 and '数据迁移与切换' in m[0], m)
m, o = site_s1(site_md('migration'), {'site': {'project_type': 'migration'}})
check('S1 反向集成：migration 写全插入章通过', not m, m)
m, o = site_s1(site_md('rebuild'), {'site': {'project_type': 'new'}})
check('S1 反向集成：未知 project_type → 配置错误', len(m) == 1 and 'mode 配置错误' in m[0], m)

# T11 与类型包 banned_terms 的优先级（主代理拍板：同片段保留类型包定级与文案；同行去重类型包优先）
T11_PACK = [{'term': '^正常[。．.！!]?$', 'regex': True, 'severity': '提示', 'message': '预期结果使用孤立空泛词，未带限定词', 'columns': ['预期结果']}]
pk_t11 = make_pack(lambda p: p['qa'].update(banned_terms=copy.deepcopy(T11_PACK)))
c, r, o = qa(make_run(T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 正常 |\n'), pk_t11, 'T11')
t = hits(r, 'T11')
check('T11 优先级：整格「正常」内置与类型包同片段命中 → 只留一条，定级与文案取类型包', len(t) == 1 and t[0]['severity'] == '提示' and '未带限定词' in t[0]['message'], t)
c, r, o = qa(make_run(T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 正常： |\n'), pk_t11, 'T11')
t = hits(r, 'T11')
check('T11 优先级反例：「正常：」类型包正则不匹配 → 内置建议照报', len(t) == 1 and t[0]['severity'] == '建议' and '整格只有' in t[0]['message'], t)
c, r, o = qa(make_run(T + '| 验收标准 | 预期结果 |\n|---|---|\n| 合理即可 | 正常 |\n'), pk_t11, 'T11')
t = hits(r, 'T11')
check('T11 优先级：同一行内置（另一格「合理」）与类型包各一条 → 同行只留类型包那条', len(t) == 1 and t[0]['severity'] == '提示' and '未带限定词' in t[0]['message'], t)
c, r, o = qa(make_run(T + '| 步骤 | 预期结果 |\n|---|---|\n| 登录 | 正常 |\n'), make_pack(), 'T11')
t = hits(r, 'T11')
check('T11：无类型包配置时内置照报建议', len(t) == 1 and t[0]['severity'] == '建议', t)
c, r, o = qa(make_run(T + '本方案零风险。\n'), make_pack(lambda p: p['qa'].update(banned_terms=[{'term': '零风.', 'regex': True, 'severity': '提示', 'message': '包词'}])), 'R1')
check('R1 不跟进类型包优先：正则与内置红线词重叠时必改照留（内置红线不可降级）', bool(hits(r, 'R1', '必改', '零风险')), (r or {}).get('issues'))

# 七个内部类型包的 qa_rules.py：样张副本为反例基底，逐条变异构造正例
TYPES_SRC = os.path.join(DS, 'types')
PREFIX = {'prd': 'PRD-', 'mrd': 'MRD-', 'tech-spec': 'SPEC-', 'api-reference': 'API-', 'test-plan': 'PLAN-', 'test-cases': 'CASE-', 'test-report': 'REPORT-'}
_tree = [0]


def sample_tree():
    """复制 types/*/samples（保持相对路径，related_docs 的 ../../../<包>/samples 仍可解析）。"""
    _tree[0] += 1
    d = os.path.join(BASE, 'tsamples', f't{_tree[0]}')
    for pid in sorted(os.listdir(TYPES_SRC)):
        src = os.path.join(TYPES_SRC, pid, 'samples')
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(d, pid, 'samples'), ignore=shutil.ignore_patterns('out', 'qa-result.json*', 'qa-report.md', '__pycache__'))
    return d


SP = lambda pid, f: f'{pid}/samples/membership-points-v2/{f}'


def TM(rel, old, new, count=1, regex=False):
    def f(tree):
        p = os.path.join(tree, rel); s = open(p, encoding='utf-8').read()
        if regex:
            s2, n = re.subn(old, new, s, flags=re.S)
        else:
            n = s.count(old); s2 = s.replace(old, new)
        if n < 1 or (count is not None and n != count):
            raise AssertionError(f'夹具变异未命中：{rel} {old[:50]!r} 命中 {n} 次')
        open(p, 'w', encoding='utf-8').write(s2)
    return f


def JM(rel, fn):
    def f(tree):
        p = os.path.join(tree, rel); d = json.load(open(p, encoding='utf-8')); fn(d)
        json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    return f


def tqa(tree, pid):
    return qa(os.path.join(tree, SP(pid, '')), os.path.join(TYPES_SRC, pid))


def type_case(pid, rule, name, muts, contains=None, severity='提示', expect=True, extra=None):
    tree = sample_tree()
    try:
        for mu in muts: mu(tree)
    except AssertionError as ex:
        check(f'{rule} {"正" if expect else "反"}例：{name}', False, ex); return None
    c, r, o = tqa(tree, pid)
    got = hits(r, rule, severity, contains)
    ok = r is not None and not hits(r, 'E-TYPE') and (bool(got) if expect else not hits(r, rule))
    if ok and extra: ok = extra(r)
    check(f'{rule} {"正" if expect else "反"}例：{name}', ok, (r or {}).get('issues') if r else o[-500:])
    return r


base_tree = sample_tree()
for pid, pre in PREFIX.items():
    c, r, o = tqa(base_tree, pid)
    got = [x for x in (r or {}).get('issues', []) if x['rule'].startswith(pre) and not (pid == 'tech-spec' and x['rule'] == 'SPEC-09')]
    check(f'{pid} 样张反例：本包规则全部不命中、无 E-TYPE', r is not None and not got and not hits(r, 'E-TYPE'), got or o[-300:])
    if pid == 'tech-spec':
        check('SPEC-09 正例：样张全文没有「待确认 / 推断 / 未知」标注', bool(hits(r, 'SPEC-09', '提示')), (r or {}).get('issues'))

PD, MD, TD, AD = SP('prd', 'doc.md'), SP('mrd', 'doc.md'), SP('tech-spec', 'doc.md'), SP('api-reference', 'doc.md')
type_case('prd', 'PRD-02', '需求编号格式不合法', [TM(PD, '| REQ-ACCT-02 | 会员在个人中心', '| REQ-acct-2 | 会员在个人中心')], '不符合编号格式')
type_case('prd', 'PRD-03', '验收标准为空', [TM(PD, '| P0 | 新会员注册后 5 秒内可查询到积分账户，初始余额为 0；重复触发注册事件不产生第二个账户 |', '| P0 |  |')], '验收标准为空')
type_case('prd', 'PRD-04', '范围节没有非目标', [TM(PD, '### 3.2 非目标', '### 3.2 其他说明')], '没有写非目标')
type_case('prd', 'PRD-05', '开放问题表缺 owner 列', [TM(PD, '| 问题 | Owner | 截止时间 |', '| 问题 | 提出人 | 截止时间 |')], 'owner')
type_case('prd', 'PRD-06', '指标表缺来源列', [TM(PD, '| 目标 | 指标 | 口径 | 来源 | 时间窗 | 目标值 |', '| 目标 | 指标 | 口径 | 出处 | 时间窗 | 目标值 |')], '来源')
type_case('prd', 'PRD-07', '异常与边界列空泛词', [TM(PD, '若近 90 天无流水，展示空状态提示而非报错', '若近 90 天无流水，展示友好的空状态')], '友好')
type_case('prd', 'PRD-08', '用户与场景节没有流程图', [TM(PD, '![会员积分核心流程](figures/points-flow.mmd){#fig:points-flow}', '会员积分核心流程见附件。'), TM(PD, '如 @fig:points-flow 所示，', '')], '流程图')
type_case('mrd', 'MRD-01', '段落市场数字无来源', [TM(MD, 'v2 的目标是把两个维度', '头部份额约 30%，v2 的目标是把两个维度')], '所在段落没有来源')
type_case('mrd', 'MRD-01', '表格来源列为空', [TM(MD, '| 该市场同比增速 | 约 18% | 同上 | 2025→2026 |', '| 该市场同比增速 | 约 18% |  | 2025→2026 |')], '列为空')
type_case('mrd', 'MRD-02', '竞品矩阵没有依据列', [TM(MD, '| 我方（v1 现状） | 依据 |', '| 我方（v1 现状） | 备注 |')], '依据')
type_case('mrd', 'MRD-03', 'MR 需求优先级为空', [TM(MD, '| MR-002 | 积分到账更及时、有通知提醒 | 客服工单（21% 占比） | 高 |', '| MR-002 | 积分到账更及时、有通知提醒 | 客服工单（21% 占比） |  |')], '优先级为空')
type_case('tech-spec', 'SPEC-02', '只有一个方案', [TM(TD, r'### ALT-1：.*?(?=## 7\. )', '只评估了一个方案，未做备选比较。\n\n', regex=True)], '不足 2 个方案')
type_case('tech-spec', 'SPEC-03', '没有时序图或状态图', [TM(TD, '![积分兑换流程时序图](figures/sequence.mmd){#fig:sequence}', '![积分兑换流程](figures/flow-a.mmd){#fig:flow-a}'),
                                                   TM(TD, '@fig:sequence', '@fig:flow-a'), TM(TD, '![兑换单状态机](figures/state-machine.mmd){#fig:state-machine}', '![兑换单流转](figures/flow-b.mmd){#fig:flow-b}')], '时序图或状态图')
type_case('tech-spec', 'SPEC-04', '图后没有文字说明', [TM(TD, '兑换单的状态机覆盖「待处理 → 处理中 → 已完成 / 失败 → 失败可重试回到待处理」的完整路径，与 §4.2 时序图的异常分支对应。', '见上图。')], '文字等价说明')
type_case('tech-spec', 'SPEC-05', '回滚节没有判据关键词', [TM(TD, '### 8.2 回滚判据', '### 8.2 回滚'), TM(TD, '回滚条件：灰度期兑换失败率高于迁移前基线，或规则引擎服务可用性低于 99.9%，连续观察窗口 1 小时触发回滚。', '失败率升高时回滚。')], '回滚条件')
type_case('tech-spec', 'SPEC-06', '代码块语言不在白名单', [TM(TD, '```json\n{\n  "member_id": "m_10023",\n  "sku_id"', '```jsonx\n{\n  "member_id": "m_10023",\n  "sku_id"')], 'jsonx')
type_case('tech-spec', 'SPEC-07', '接口表缺错误码列', [TM(TD, '| 接口 | 输入约束 | 幂等 | 错误码 | 版本 |', '| 接口 | 输入约束 | 幂等 | 返回 | 版本 |')], '错误码')
type_case('tech-spec', 'SPEC-08', '代码示例附近没有版本或环境', [TM(TD, '完整接口契约（权限、限流、分页、全部错误码、请求响应示例）见《会员积分系统 v2 API 参考》。', '完整接口契约见接口参考文档。')], '版本号或环境')
type_case('tech-spec', 'SPEC-09', '写了「待确认」标注', [TM(TD, '现在做的触发因素：', '现在做的触发因素（排期待确认）：')], expect=False)
type_case('api-reference', 'API-02', '接口缺示例代码块', [TM(AD, r'```json\n\{\n  "rule_version".*?```\n', '', regex=True)], '标了语言的示例代码块')
type_case('api-reference', 'API-03', '全局错误码表没有限流', [TM(AD, '| RATE_LIMITED | 超出限流阈值 | 按 §5 的退避策略重试 |', '| QUOTA_EXCEEDED | 超出调用配额 | 按 §5 的退避策略重试 |')], '限流')
type_case('api-reference', 'API-04', '接口没有权限说明', [TM(AD, '权限：受信内部服务。行为与副作用：无显式副作用（纯查询，命中本地缓存时不产生额外调用）。', '行为与副作用：无显式副作用（纯查询，命中本地缓存时不产生额外调用）。')], '权限要求')
type_case('api-reference', 'API-05', '写接口没有幂等标注（GET 豁免由样张反例覆盖）', [TM(AD, '幂等：是（Idempotency-Key 请求头必填）。\n\n```json\n{\n  "member_id": "m_10023",\n  "amount": -100', '\n\n```json\n{\n  "member_id": "m_10023",\n  "amount": -100')], '是否幂等')
type_case('api-reference', 'API-06', '代码块语言不在白名单', [TM(AD, '```http\nAuthorization', '```httpx\nAuthorization')], 'httpx')
type_case('api-reference', 'API-07', '变更记录缺破坏性列', [TM(AD, '| 版本 | 日期 | 变更内容 | 破坏性 |', '| 版本 | 日期 | 变更内容 | 说明 |')], '破坏性')
type_case('api-reference', 'API-08', '弃用接口下线时间为空', [TM(AD, '| 2026-10-01（迁移双写期结束后） |', '|  |')], '下线时间')
CV, PLD, CS = SP('test-plan', 'data/coverage.csv'), SP('test-plan', 'doc.md'), SP('test-cases', 'data/cases.csv')
type_case('test-plan', 'PLAN-02', '覆盖矩阵引用 PRD 不存在的需求', [TM(CV, 'REQ-ACCT-01,积分账户,P0,2,已覆盖', 'REQ-ACCT-09,积分账户,P0,2,已覆盖')], 'REQ-ACCT-09')
type_case('test-plan', 'PLAN-03', '跨读用例重算：P0 需求无用例、矩阵写已覆盖', [TM(CS, ',REQ-ADMIN-01,', ',REQ-TIER-03,', count=3)], 'REQ-ADMIN-01 在关联测试用例中没有任何用例',
          extra=lambda r: bool(hits(r, 'PLAN-03', '提示', '覆盖矩阵写 REQ-ADMIN-01「已覆盖」')))
type_case('test-plan', 'PLAN-03', '矩阵用例数与重算不一致', [TM(CV, 'REQ-ACCT-02,积分账户,P0,2,已覆盖', 'REQ-ACCT-02,积分账户,P0,5,已覆盖')], '重算为 2')
type_case('test-plan', 'PLAN-04', '准入准出没有数字', [TM(PLD, r'(## 4\. 准入与准出标准\n).*?(?=## 5\. )', r'\1\n准入与准出标准见评审纪要。\n\n', regex=True)], '没有任何数字')
type_case('test-plan', 'PLAN-05', '不测范围条目没有原因', [TM(PLD, '原因：属于商城团队独立系统，PRD 已明确列为非目标（PRD §3.2）。', '属于商城团队独立系统。')], '没有写原因')
type_case('test-plan', 'PLAN-06', '缺陷级别表没有判定标准', [TM(PLD, '| 级别 | 判定标准 |', '| 级别 | 说明 |')], '判定标准')
TPJ = SP('test-plan', 'doc.json')
drop_prd = lambda d: d.update(related_docs=[x for x in d['related_docs'] if x['type'] != 'prd'])
type_case('test-plan', 'PLAN-02', '关联 PRD 未登记 → 缺失（D2 相关必改）', [JM(TPJ, drop_prd)], '找不到或无法读取', severity='必改')
bad_path = lambda d: [x.update(path='../../../prd/samples/nope/doc.json') for x in d['related_docs'] if x['type'] == 'prd']
type_case('test-plan', 'PLAN-02', '按 role 精确命中但路径坏 → 缺失带原因（必改）', [JM(TPJ, bad_path)], '不存在', severity='必改')
no_role = lambda d: [x.pop('role', None) for x in d['related_docs'] if x['type'] == 'prd']
# 2026-09-15 W3-H 契约第二轮：related_docs.role 必填，删除「恰好 1 条未写 role 时兼容读取」的回退——缺 role 一律按缺失（D2 相关必改），原因里点明缺 role
type_case('test-plan', 'PLAN-02', 'related_docs 缺 role → 不再兼容读取，按缺失（必改）并点明缺 role', [JM(TPJ, no_role)], '缺 role', severity='必改',
          extra=lambda r: not hits(r, 'PLAN-02', '提示', '没写 role'))
two_loose = lambda d: (no_role(d), d['related_docs'].append(dict(next(x for x in d['related_docs'] if x['type'] == 'prd'), title='另一份 PRD')))
type_case('test-plan', 'PLAN-02', 'related_docs 同类型多条都缺 role → 按缺失（必改），原因写条数', [JM(TPJ, two_loose)], '2 条 prd 条目缺 role', severity='必改')
import importlib.util as _ilu  # noqa: E402
_SH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'doc-shared')


def _load_rules(pid):
    spec = _ilu.spec_from_file_location(f'w3h_rules_{pid.replace("-", "_")}', os.path.join(_SH, 'types', pid, 'qa_rules.py'))
    m = _ilu.module_from_spec(spec); spec.loader.exec_module(m); return m


class _Ctx:
    def __init__(self, pack): self.pack = pack


for _pid in ('tech-spec', 'api-reference'):
    _m = _load_rules(_pid)
    _pk = json.load(open(os.path.join(_SH, 'types', _pid, 'pack.json'), encoding='utf-8'))
    _decl = _pk['qa'].get('allowed_languages')
    check(f'{_pid}：pack.json qa.allowed_languages 与脚本常量一致（声明后行为不变）', isinstance(_decl, list) and set(_decl) == _m.ALLOWED_LANGS, (_decl, sorted(_m.ALLOWED_LANGS)))
    _l1, _s1 = _m._allowed_langs(_Ctx({'qa': {'allowed_languages': ['JSON', 'yaml']}}))
    _l2, _s2 = _m._allowed_langs(_Ctx({'qa': {}}))
    _l3, _s3 = _m._allowed_langs(object())
    check(f'{_pid}：语言白名单优先读 pack.json（小写比较），读不到回退常量', _l1 == {'json', 'yaml'} and 'pack.json' in _s1 and _l2 is _m.ALLOWED_LANGS and _l3 is _m.ALLOWED_LANGS and 'ALLOWED_LANGS' in _s2, (_l1, _s1, _s2, _s3))
import qa_pack_helpers as _qh  # noqa: E402  （qa.py 已把 doc-shared/scripts 放进 sys.path）
_rules = {p: _load_rules(p) for p in ('prd', 'mrd', 'tech-spec', 'api-reference', 'test-plan', 'test-cases', 'test-report')}
check('七个包 qa_rules 的通用小工具来自 doc-shared/scripts/qa_pack_helpers（同一对象，不再各带一份）',
      all(m._section is _qh.section and m._where is _qh.where and m._related is _qh.related and m._csv is _qh.read_csv for m in _rules.values())
      and not any(hasattr(m, '_prd_requirements') for p, m in _rules.items() if p not in ('test-plan', 'test-cases'))
      and not any(hasattr(m, '_tc_cases') for p, m in _rules.items() if p not in ('test-plan', 'test-report')), {p: m._section for p, m in _rules.items()})
type_case('test-cases', 'CASE-01', '必填字段为空', [TM(CS, 'REQ-ACCT-01,P0,功能,会员完成注册流程,', 'REQ-ACCT-01,P0,功能,,')], '前置条件')
type_case('test-cases', 'CASE-01', '用例编号重复（全量 CSV）', [TM(CS, 'TC-ACCT-04,近90天', 'TC-ACCT-03,近90天')], '重复')
type_case('test-cases', 'CASE-02', '关联需求在 PRD 中不存在', [TM(CS, 'TC-ACCT-04,近90天无流水时展示空状态,REQ-ACCT-02,', 'TC-ACCT-04,近90天无流水时展示空状态,REQ-ACCT-07,')], 'REQ-ACCT-07')
type_case('test-cases', 'CASE-03', 'PRD P0 需求没有用例', [TM(CS, ',REQ-ADMIN-01,', ',REQ-TIER-03,', count=3)], 'REQ-ADMIN-01')
type_case('test-cases', 'CASE-05', '步骤与预期编号条数不同', [TM(CS, '账户在5秒内可查询到，初始余额为0,是', '1. 账户可查询；2. 余额为0；3. 无报错,是')], '编号对不上')
type_case('test-cases', 'CASE-06', '异常类占比超出区间', [TM(CS, ',异常,', ',功能,', count=None)], '异常类用例占比')
type_case('test-cases', 'CASE-07', '优先级取值不合法', [TM(CS, 'TC-ACCT-01,注册成功后自动开通积分账户,REQ-ACCT-01,P0,', 'TC-ACCT-01,注册成功后自动开通积分账户,REQ-ACCT-01,P5,')], 'P5')
type_case('test-cases', 'CASE-08', '类型取值不合法', [TM(CS, 'REQ-ACCT-01,P0,功能,', 'REQ-ACCT-01,P0,冒烟,')], '冒烟')
type_case('test-cases', 'CASE-09', '缺一个模块小节', [TM(SP('test-cases', 'doc.md'), '## 9. 运营后台\n\n<!-- data: data/cases.csv columns=用例编号,标题,关联需求,优先级,类型,前置条件,测试步骤,测试数据,预期结果,自动化 filter=用例编号^TC-ADMIN- -->\n\n小计：3 条。\n\n', '')], 'TC-ADMIN-')
RD = SP('test-report', 'doc.md')
type_case('test-report', 'REPORT-02', '准出结论不在三选一', [TM(RD, '**结论：建议发布**', '**结论：待评估**')], '三者之一')
type_case('test-report', 'REPORT-03', '缺按优先级统计', [TM(RD, '| 优先级 | 通过 | 失败 | 阻塞 | 未执行 | 合计 | 通过率 |', '| 分组 | 通过 | 失败 | 阻塞 | 未执行 | 合计 | 通过率 |')], '优先级')
type_case('test-report', 'REPORT-04', '缺陷统计缺状态', [TM(RD, '| 级别 | 数量 | 状态：已关闭 | 状态：处理中 | 状态：待验证 |', '| 级别 | 数量 | 已关闭 | 处理中 | 待验证 |')], '状态')
type_case('test-report', 'REPORT-05', '执行明细引用不存在的用例', [TM(SP('test-report', 'data/execution.csv'), 'TC-ACCT-01,通过', 'TC-ACCT-99,通过')], 'TC-ACCT-99')
type_case('test-report', 'REPORT-06', '准出门槛与测试计划不一致', [TM(RD, '| P1 用例通过率 ≥ 95% |', '| P1 用例通过率 ≥ 90% |')], '口径不一致')
type_case('test-report', 'REPORT-06', '漏比对「无未解决 P0 缺陷」', [TM(RD, '| 无未解决 P0 缺陷 | DEF-001（唯一 P0 缺陷）已关闭 | 是 |\n', '')], '未解决缺陷数')
type_case('test-report', 'REPORT-07', '遗留问题表缺原因列', [TM(RD, '| 编号 | 描述 | 原因 | 影响范围 | 计划 |', '| 编号 | 描述 | 说明 | 影响范围 | 计划 |')], '原因')
type_case('test-report', 'REPORT-08', '执行概况没有执行率数字', [TM(RD, '整体执行率：44/47（93.6%）；', '整体执行率见附表；')], '执行率')

# presales-site 专属规则 SITE-06～09（不依赖 golden）
SITE_SRC = os.path.join(DS, 'types', 'presales-site')
SITE_MD = ('# 测试建站方案\n\n## 1. 项目背景与目标\n\n正文。\n\n{extra}\n## 7. 报价\n\n<!-- include: pricing/summary-table.md -->\n\n'
           '## 9. 商务条款\n\n<!-- include: terms.md -->\n')


def site_case(brief_extra=None, extra='', summary='本报价自报价之日起 30 天内有效。', terms='付款方式见合同。', model=None, line='site', files=None):
    _seq[0] += 1
    rd = os.path.join(BASE, 'runs', f'site-{_seq[0]}'); os.makedirs(os.path.join(rd, 'pricing'))
    brief = {'client': '测试', 'line': line, 'version': '1.0', 'contact': {'name': '测试'}, 'overview': []}
    brief.update(brief_extra or {})
    json.dump(brief, open(os.path.join(rd, 'brief.json'), 'w'), ensure_ascii=False)
    open(os.path.join(rd, 'proposal.md'), 'w').write(SITE_MD.format(extra=extra))
    open(os.path.join(rd, 'pricing', 'summary-table.md'), 'w').write(f'| 方案 | 说明 |\n|---|---|\n| A | 示例 |\n\n{summary}\n')
    open(os.path.join(rd, 'terms.md'), 'w').write(terms + '\n')
    json.dump({'validity_days': 30, 'plans': []} if model is None else model, open(os.path.join(rd, 'pricing', 'site-model.json'), 'w'))
    json.dump({'items': []}, open(os.path.join(rd, 'scope.json'), 'w'))
    for rel, content in (files or {}).items():
        os.makedirs(os.path.dirname(os.path.join(rd, rel)), exist_ok=True); open(os.path.join(rd, rel), 'w').write(content)
    c, r, o = qa(rd, SITE_SRC)
    return rd, r, o


def site_hits(r, rule):
    return [x for x in (r or {}).get('issues', []) if x['rule'] == rule]


rd, r, o = site_case()
check('SITE 反例：rebuild、有效期两处齐 → 无 SITE-07/08/09；SITE-06 全文汇总为一条提示',
      r is not None and not site_hits(r, 'SITE-07') and not site_hits(r, 'SITE-08') and not site_hits(r, 'SITE-09')
      and len(site_hits(r, 'SITE-06')) == 1 and site_hits(r, 'SITE-06')[0]['severity'] == '提示', (r or {}).get('issues') or o[-400:])
VIS_MIX = ('上线后做 301 跳转。\n\n股票代码 301171，内部端口 3010。\n\n<!-- 301 跳转备注 -->\n\n见 [方案说明](https://example.com/301/path)。\n\n'
           '图示 ![站点结构](figures/301.svg){#fig:x301}\n\n<!--\n多行注释 301\n-->\n')
rd, r, o = site_case({'site': {'project_type': 'greenfield'}}, VIS_MIX)
s7 = site_hits(r, 'SITE-07')
want = open(os.path.join(rd, 'proposal.md')).read().split('\n').index('上线后做 301 跳转。') + 1
check('SITE-07 正例：greenfield「301 跳转」必改一条且行号准确；3010、301171、注释、链接地址、图片路径不误报',
      len(s7) == 1 and s7[0]['severity'] == '必改' and s7[0]['line'] == want, (s7, want, o[-300:]))
rd, r, o = site_case({'site': {'project_type': 'greenfield'}}, '已有 301171 与 3010 两个编号。\n')
check('SITE-07 反例：只有长数字 301171、3010 不报', r is not None and not site_hits(r, 'SITE-07'), site_hits(r, 'SITE-07'))
rd, r, o = site_case({}, '上线后做 301 跳转。\n')
check('SITE-07 反例：rebuild 不查 301', r is not None and not site_hits(r, 'SITE-07'), site_hits(r, 'SITE-07'))
rd, r, o = site_case({'site': {'project_type': 'new'}}, '上线后做 301 跳转。\n')
check('SITE-09 正例：未知 project_type → 必改配置错误，不跑 SITE-06/07', len(site_hits(r, 'SITE-09')) == 1 and site_hits(r, 'SITE-09')[0]['severity'] == '必改'
      and not site_hits(r, 'SITE-06') and not site_hits(r, 'SITE-07'), (r or {}).get('issues'))
rd, r, o = site_case({'site': {'project_type': 'migration'}})
check('SITE-06 正例：migration 汇总提示含插入章「数据迁移与切换」', any('数据迁移与切换' in x['message'] and x['severity'] == '提示' for x in site_hits(r, 'SITE-06')), site_hits(r, 'SITE-06'))
rd, r, o = site_case(model={'plans': []})
check('SITE-08 正例：site-model.json 缺 validity_days → 必改', any(x['severity'] == '必改' and 'site-model.json' in x['message'] for x in site_hits(r, 'SITE-08')), site_hits(r, 'SITE-08'))
rd, r, o = site_case({'validity_days': 45})
check('SITE-08 正例：brief.json 有效期与报价模型不一致 → 必改', any('brief.json validity_days 45' in x['message'] for x in site_hits(r, 'SITE-08')), site_hits(r, 'SITE-08'))
rd, r, o = site_case(summary='报价以合同为准。')
check('SITE-08 正例：报价汇总与商务条款都没有「30 天内有效」→ 必改', any('报价汇总或商务条款' in x['message'] and x['severity'] == '必改' for x in site_hits(r, 'SITE-08')), site_hits(r, 'SITE-08'))
rd, r, o = site_case(summary='本报价自报价之日起 30 个工作日内有效。')
check('SITE-08 正例：「30 个工作日内有效」不算', bool(site_hits(r, 'SITE-08')), site_hits(r, 'SITE-08'))
rd, r, o = site_case(summary='本报价自报价之日起 30 个自然日内有效。')
check('SITE-08 反例：「30 个自然日内有效」算数', r is not None and not site_hits(r, 'SITE-08'), site_hits(r, 'SITE-08'))
rd, r, o = site_case(summary='报价以合同为准。', terms='报价自报价之日起 30 天内有效。')
check('SITE-08 反例：有效期写在商务条款（include terms.md）也算第二处', r is not None and not site_hits(r, 'SITE-08'), site_hits(r, 'SITE-08'))
rd, r, o = site_case(summary='报价以合同为准。', extra='本报价 30 天内有效。\n', )
check('SITE-08 正例：有效期只写在背景章（不是报价或商务条款）不算', bool(site_hits(r, 'SITE-08')), site_hits(r, 'SITE-08'))
rd, r, o = site_case({'site': {'project_type': 'new'}}, line='reddit', model={})
check('SITE 反例：brief.json line 不是 site 时 SITE-06～09 都不跑', r is not None and not any(x['rule'].startswith('SITE-') for x in r['issues']), (r or {}).get('issues'))

# Codex 交付评审（W3-A）回归：数据块逐行定位、CASE-03 空 CSV、CASE-05 条数相等、关联文档按包 meta_file、各包 key_figures 冲突
rd, r, o = site_case({'site': {'project_type': 'greenfield'}}, '<!-- data: data/rows.csv columns=项,说明 caption=说明 -->\n',
                     files={'data/rows.csv': '项,说明\nA,上线后做 301 跳转\nB,保留 301 重定向清单\nC,内部端口 3010\n'})
s7 = site_hits(r, 'SITE-07')
check('SITE-07：数据块两行命中禁词 → 两条必改，行号 0、摘录各带 CSV 行号（不被同行合并）',
      len(s7) == 2 and all(x['line'] == 0 for x in s7) and any('第 2 行' in x['excerpt'] for x in s7) and any('第 3 行' in x['excerpt'] for x in s7), (s7, o[-300:]))
c, r, o = qa(make_run(T + '<!-- data: data/t.csv columns=步骤,预期结果 caption=用例 -->\n', {'data/t.csv': '步骤,预期结果\n登录,正常\n下单,正常\n支付,正常\n'}), pk_t11, 'T11')
t = hits(r, 'T11')
check('T11：数据块多行整格「正常」→ 每个 CSV 行一条（类型包定级），行号 0、摘录带 CSV 行号',
      len(t) == 3 and all(x['severity'] == '提示' and x['line'] == 0 for x in t) and [x['excerpt'] for x in t] == ['data/t.csv 第 2 行：正常', 'data/t.csv 第 3 行：正常', 'data/t.csv 第 4 行：正常'], t)
type_case('test-cases', 'CASE-03', 'cases.csv 只有表头 → PRD 的 P0/P1 需求逐条报', [TM(CS, r'(\n)TC-.*', r'\1', regex=True)], 'REQ-ACCT-01')
type_case('test-cases', 'CASE-05', '步骤与预期都编号且条数相等', [TM(CS, '1. 完成手机号验证注册一个新会员；2. 调用积分账户查询接口,新会员手机号:13800000001,账户在5秒内可查询到，初始余额为0,是',
                                                          '1. 完成手机号验证注册一个新会员；2. 调用积分账户查询接口,新会员手机号:13800000001,1. 注册成功；2. 账户余额为0,是')], expect=False)
def FW(rel, content):
    def f(tree):
        full = os.path.join(tree, rel); os.makedirs(os.path.dirname(full), exist_ok=True); open(full, 'w', encoding='utf-8').write(content)
    return f


type_case('prd', 'PRD-07', '数据块（文件名含空格）两行命中 → 两条，消息各带 CSV 行号', [
    FW(SP('prd', 'data/edge cases.csv'), '编号,异常与边界\nX-1,展示友好的提示\nX-2,返回友好的空状态\n'),
    TM(PD, '## 6. 非功能需求', '<!-- data: "data/edge cases.csv" columns=编号,异常与边界 caption=补充边界 -->\n\n## 6. 非功能需求')], '第 2 行',
    extra=lambda r: len(hits(r, 'PRD-07')) == 2 and bool(hits(r, 'PRD-07', '提示', '第 3 行')))
type_case('test-cases', 'CASE-05', '步骤 2 条、预期只编号 1 条', [TM(CS, '账户在5秒内可查询到，初始余额为0,是', '1. 账户可查询且余额为0,是')], '编号对不上')
rel_site = os.path.join(BASE, 'runs', 'rel-site'); os.makedirs(rel_site)
open(os.path.join(rel_site, 'proposal.md'), 'w').write('# 关联建站方案\n\n## 01 业务与资产盘点\n\n正文。\n')
json.dump({'type': 'presales-site', 'version': '1.0'}, open(os.path.join(rel_site, 'doc.json'), 'w'))
json.dump({'line': 'site', 'site': {'project_type': 'greenfield'}}, open(os.path.join(rel_site, 'brief.json'), 'w'))
pk_relsite = make_pack(rules_py='def check(doc, ctx):\n    d = ctx.related("presales-site", role="ref")\n    rd = d.doc\n'
                                '    return [ctx.issue("TP9", "提示", 0, "x", "mode=%s ids=%s" % (rd.__dict__.get("mode"), [h.get("skeleton_id") for h in rd.headings]))]\n')
c, r, o = qa(make_run(T + '正文。\n', meta={'type': 'tpack', 'version': '1.0', 'related_docs': [{'type': 'presales-site', 'role': 'ref', 'path': rel_site}]}), pk_relsite)
tp9 = hits(r, 'TP9')
check('RelatedView.doc 按关联包 meta_file（brief.json）取 mode：presales-site greenfield 章节名匹配到 background',
      len(tp9) == 1 and 'mode=greenfield' in tp9[0]['message'] and "'background'" in tp9[0]['message'], (tp9, o[-300:]))
KF_EX = {
    'gray-days': ('灰度 7 天。', '灰度期 14 天。'), 'req-count': ('共 19 条需求。', '共 20 条需求。'),
    'invest-days': ('投入约 35 人天。', '投入约 40 人天。'), 'market-size': ('市场规模约 340 亿元。', '市场规模约 300 亿元。'),
    'growth': ('同比增速约 18%。', '增速约 20%。'), 'interviews': ('访谈 12 位会员。', '访谈 15 位会员。'),
    'dual-write-weeks': ('双写并交叉校验约 2 周。', '双写校验 3 周。'), 'gray-ratio': ('灰度 5% 会员。', '灰度 10% 会员。'),
    'token-ttl': ('Token 有效期 2 小时。', 'Token 有效期 3 小时。'), 'idem-window': ('同一 key 在 24 小时内重复请求返回首次结果。', '48 小时内重复请求返回首次结果。'),
    'rate-limit': ('/v1/points/redeem 每分钟最多 10 次。', '/v1/points/redeem 每分钟最多 20 次。'), 'adjust-cap': ('单次权限上限 5000。', '单次权限上限 8000。'),
    'tested-version': ('被测版本：v2.0.0-rc1。', '被测版本：v2.0.0-rc2。'), 'pass-rate': ('P0 用例通过率 100%。', 'P0 用例通过率 95%。'),
    'case-total': ('共 47 条用例。', '共 48 条用例。'), 'req-by-priority': ('10 条 P0 需求。', '11 条 P0 需求。'),
    'exec-rate': ('执行率：44/47。', '执行率 45/47。'), 'verdict': ('准出结论：建议发布。', '结论：不建议发布。'),
    'validity': ('本报价 30 天内有效。', '本报价 45 天内有效。'), 'payment-ratio': ('首付 40%。', '首付款 50%。'),
    'plan-total': ('方案 A 总价 USD 12,000。', '方案 A 总价 USD 13,000。'), 'plan-days': ('方案 A 合计 30 人天。', '方案 A 合计 32 人天。'),
}
for pid in ('prd', 'mrd', 'tech-spec', 'api-reference', 'test-plan', 'test-cases', 'test-report', 'presales-site', 'presales-reddit'):
    qa_cfg = json.load(open(os.path.join(TYPES_SRC, pid, 'pack.json')))['qa']
    check(f'{pid}：pack.json 声明 key_figures 与 highlight_limits', bool(qa_cfg.get('key_figures')) and qa_cfg.get('highlight_limits') == {'total': 25, 'per_page': 3, 'max_length': 40}, qa_cfg.keys())
    for kfd in qa_cfg.get('key_figures') or []:
        ex = KF_EX.get(kfd['id'])
        if not ex:
            check(f'{pid} key_figures {kfd["id"]}：测试样例已登记', False, kfd); continue
        pk_kf = make_pack(lambda p, k=kfd: p['qa'].update(key_figures=[k]))
        c, r1, o1 = qa(make_run(T + ex[0] + '\n\n' + ex[1] + '\n'), pk_kf, 'X4')
        c, r2, o2 = qa(make_run(T + ex[0] + '\n\n' + ex[0] + '\n'), pk_kf, 'X4')
        check(f'{pid} key_figures {kfd["id"]}：两处取值不同报 X4 提示、相同不报', bool(hits(r1, 'X4', '提示')) and r2 is not None and not hits(r2, 'X4'), ((r1 or {}).get('issues'), (r2 or {}).get('issues')))


# ---------------------------------------------------------------- 7. 业务词守卫

ALL_WORDS = ['报价', '确认单', '毛利', '底价', '人天', '售前', 'presales', 'pricing', '用例', 'reddit', '建站',  # 与 doc-shared/tests 同一词表
             '成本价', '采购价', '渠道单价', '让价', 'internal-cost', 'Claude', 'Codex']  # 迁移出去的售前规则里的内部口径词


def biz_guard(root):
    found = []
    for dp, _, fns in os.walk(root):
        if '__pycache__' in dp: continue
        for fn in fns:
            if not fn.endswith('.py'): continue
            for i, line in enumerate(open(os.path.join(dp, fn), encoding='utf-8').read().split('\n'), 1):
                for w in ALL_WORDS:
                    if w.lower() in line.lower(): found.append(f'{fn}:{i}「{w}」')
    return found


gh = biz_guard(os.path.join(DQ, 'scripts'))
check('业务词守卫：doc-qa/scripts 不出现业务词（引擎不认识业务）', not gh, gh[:10])
planted = os.path.join(BASE, 'guard-plant'); os.makedirs(planted)
open(os.path.join(planted, 'x.py'), 'w').write('# 计算成本价\n')
check('业务词守卫自检：植入的业务词能被抓到', len(biz_guard(planted)) == 1, biz_guard(planted))

keep = '--keep' in sys.argv
print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}" + (f'（SKIP {len(skips)}）' if skips else '') + f'（临时目录：{BASE}）')
if not keep and not fails:
    shutil.rmtree(BASE, ignore_errors=True)
sys.exit(1 if fails else 0)
