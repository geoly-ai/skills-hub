#!/usr/bin/env python3
"""DocMark 解析器（scripts/docmark_parse.py）正反例自测。离线、只写系统临时目录。
用法：test_docmark_parse.py        （也被 doc-render/tests/run_tests.py 调用）
库：run() → 失败项列表"""
import importlib.util, json, os, shutil, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(H)
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import docmark_parse as dp  # noqa: E402

GOLDEN = os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/golden')
LEGACY_RENDER = os.path.expanduser('~/.claude/skills/presales-publish/scripts/render.py')


def run(verbose=True):
    fails = []
    base = tempfile.mkdtemp(prefix='docmark-tests-')

    def check(name, cond, detail=''):
        if verbose: print(('PASS ' if cond else 'FAIL ') + 'docmark：' + name + (f'  [{str(detail)[:400]}]' if detail and not cond else ''))
        if not cond: fails.append(name)

    def codes(doc):
        return [d['code'] for d in doc.diagnostics]

    def P(text, pack=None, run_dir=None):
        return dp.parse_text(text, pack=pack, run_dir=run_dir)

    def rd(name, files):
        d = os.path.join(base, name)
        for rel, content in files.items():
            p = os.path.join(d, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'w', encoding='utf-8').write(content)
        return d

    # ---- 标题与编号
    d = P('# 标题\n\n## 一 {#sec:one}\n\n### 子节\n\n## 二\n\n## 术语表 {#sec:glossary .appendix}\n\n### 缩写\n')
    check('标题：文档标题与四个章节', d.title == '标题' and len(d.headings) == 5)
    check('编号：1 / 1.1 / 2 / 附录 A / A.1', [h['number'] for h in d.headings] == ['1', '1.1', '2', 'A', 'A.1'], [h['number'] for h in d.headings])
    check('附录：label 为「附录 A」，锚点 label 同', d.headings[3]['label'] == '附录 A' and d.anchors['sec:glossary']['label'] == '附录 A')
    check('章节锚点：sec:one 的 label 为「1 节」', d.anchors['sec:one']['label'] == '1 节')
    check('section()：按章节号与锚点取范围', d.section('1')['start'] == 3 and d.section('sec:one')['end'] == 6 and d.section('one') is not None)
    d = P('# T\n\n## 1. 摘要\n\n## 2026 年规划\n\n## 附录 A：术语\n')
    check('手写序号与自动编号一致时去掉，title_raw 保留', d.headings[0]['title'] == '摘要' and d.headings[0]['title_raw'] == '1. 摘要' and d.headings[0]['manual_number'] == '1')
    check('不一致的数字开头不改写（2026 年规划）', d.headings[1]['title'] == '2026 年规划')
    check('「附录 A：」前缀识别为附录并去掉', d.headings[2]['appendix'] and d.headings[2]['title'] == '术语' and d.headings[2]['number'] == 'A')
    d = P('# T\n\n## 一\n\n#### 跳级\n')
    check('反例：标题跳级报 heading-skip（S2）', 'heading-skip' in codes(d))
    d = P('## 没有文档标题\n')
    check('反例：缺文档标题报 title-missing', 'title-missing' in codes(d))
    d = P('# T\n\n## A\n\n### B\n\n#### C\n\n##### D\n', pack={'numbering': {'section': 'decimal', 'figure': '图 {chapter}-{seq}', 'table': '表 {chapter}-{seq}', 'max_depth': 3}})
    check('反例：超过 max_depth 报 heading-depth，编号为空', 'heading-depth' in codes(d) and d.headings[3]['number'] == '')

    # ---- 段落与列表
    d = P('# T\n\nhello\nworld\n\n中文\n续行\n')
    ps = [b for b in d.blocks if b['kind'] == 'p']
    check('续行：拉丁字母相邻插空格、中文直接拼接', ps[0]['text'] == 'hello world' and ps[1]['text'] == '中文续行', [p['text'] for p in ps])
    d = P('# T\n\n- 一\n  - 一.一\n  - 一.二\n- 二\n    - 深\n')
    lst = d.lists[0]
    check('嵌套列表：两级', [i['level'] for i in lst['items']] == [1, 2, 2, 1, 2], [i['level'] for i in lst['items']])
    check('反例：三级缩进报 list-depth', 'list-depth' in codes(d))
    d = P('# T\n\n1. a\n2. b\n')
    check('有序列表', d.lists[0]['kind'] == 'ol' and len(d.lists[0]['items']) == 2)

    # ---- 表格
    d = P('# T\n\n## 章\n\n<!-- widths: 1,2 -->\n<!-- table: 表题 {#tbl:t1} -->\n| a | b |\n|---|---|\n| 1 | 2 |\n\n@tbl:t1\n')
    t = d.tables[0]
    check('表格：表题、锚点、编号「表 1-1」、widths', t['caption'] == '表题' and t['anchor'] == 'tbl:t1' and t['number'] == '表 1-1' and t['widths'] == [1, 2], t)
    check('表格：header / rows / records / row_lines', t['header'] == ['a', 'b'] and t['rows'] == [['1', '2']] and t['records'] == [{'a': '1', 'b': '2'}] and t['row_lines'] == [9])
    check('交叉引用：@tbl:t1 解析为「表 1-1」', d.refs == [{'target': 'tbl:t1', 'line': 11, 'resolved': True}] and d.blocks[-1]['inline'][0]['label'] == '表 1-1')
    d = P('# T\n\n<!-- widths: 1,2,3 -->\n| a | b |\n|---|---|\n| 1 | 2 | 3 |\n')
    check('反例：widths 个数不符报 widths-count 并忽略；行列不齐报 table-shape', 'widths-count' in codes(d) and 'table-shape' in codes(d) and d.tables[0]['widths'] is None)
    d = P('# T\n\n| a \\| x | b |\n|---|---|\n| 1 | 2 |\n')
    check('表格：\\| 转义', d.tables[0]['header'] == ['a | x', 'b'])
    d = P('# T\n\n| a | b |\n| 1 | 2 |\n')
    check('反例：缺分隔行报 table-no-separator', 'table-no-separator' in codes(d))
    d = P('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', pack={'features': {'table_captions': False}})
    check('table_captions 关闭时不编号', d.tables[0]['number'] == '')

    # ---- 图
    d = P('# T\n\n## 章\n\n![流程](figures/a.mmd){#fig:a width=60%}\n\n![依赖](figures/b.dot)\n\n![架构](figures/c.fig.json)\n\n![成品](figures/d.svg)\n\n![截图](shots/e.png)\n\n见 @fig:a。\n')
    f = d.figures
    check('图路由：mermaid / graphviz / svgkit / svg / image', [x['engine'] for x in f] == ['mermaid', 'graphviz', 'svgkit', 'svg', 'image'], [x['engine'] for x in f])
    check('图：build 后 SVG 路径', [x['svg'] for x in f] == ['figures/a.svg', 'figures/b.svg', 'figures/c.svg', 'figures/d.svg', None])
    check('图：编号「图 1-1」…「图 1-5」、width 60、锚点', [x['number'] for x in f] == [f'图 1-{i}' for i in range(1, 6)] and f[0]['width_pct'] == 60 and f[0]['anchor'] == 'fig:a')
    check('交叉引用：@fig:a 渲染文字「图 1-1」', d.blocks[-1]['inline'][1]['label'] == '图 1-1')
    d = P('# T\n\n![x](figures/a.xyz)\n\n![y](figures/b.svg){width=5%}\n\n![z](../out.svg)\n')
    check('反例：扩展名、宽度越界、路径越界', {'figure-ext', 'figure-width', 'figure-path'} <= set(codes(d)), codes(d))
    d = P('# T\n\n<!-- grid: 3 -->\n![a](shots/a.png)\n![b](shots/b.png)\n<!-- /grid -->\n\n<!-- grid: 5 -->\n<!-- /grid -->\n')
    check('grid：图带 grid 序号；列数非法报 grid-invalid', all(x.get('grid') == 1 for x in d.figures) and 'grid-invalid' in codes(d))

    # ---- 锚点与引用
    d = P('# T\n\n## A {#sec:x}\n\n## B {#sec:x}\n\n见 @fig:nope 与 @sec:x。\n')
    check('反例：锚点重复报 anchor-duplicate（X3）', any(x['code'] == 'anchor-duplicate' and x['rule'] == 'X3' for x in d.diagnostics))
    check('反例：引用不存在的锚点报 ref-unresolved（X1）', any(x['code'] == 'ref-unresolved' and x['rule'] == 'X1' and x['line'] == 7 for x in d.diagnostics))
    d = P('# T\n\n## A {#sec:bad!}\n')
    check('反例：锚点 id 含非法字符报 anchor-invalid', 'anchor-invalid' in codes(d))
    d = P('# T\n\n邮箱 a@b.com 不是引用\n')
    check('邮箱里的 @ 不当引用', not d.refs)

    # ---- 代码块
    txt = '# T\n\n```json\n{"a": 1}\n```\n\n```\nx\n```\n'
    d = P(txt, pack={'features': {'code_blocks': True}})
    check('代码块：lang、text、不报 code-disabled；未标语言报 code-no-lang', d.code_blocks[0]['lang'] == 'json' and d.code_blocks[0]['text'] == '{"a": 1}' and 'code-disabled' not in codes(d) and 'code-no-lang' in codes(d))
    d = P(txt, pack={'features': {'code_blocks': False}})
    check('反例：code_blocks=false 报 code-disabled（L8）', any(x['code'] == 'code-disabled' and x['rule'] == 'L8' for x in d.diagnostics))
    d = P('# T\n\n```py\nx\n')
    check('反例：代码块未闭合报 code-unclosed', 'code-unclosed' in codes(d))
    d = P('# T\n\n```md\n## 不是标题\n| 不是表 |\n```\n')
    check('代码块内的 # 与 | 不解析', not d.headings and not d.tables)

    # ---- 链接与行内
    d = P('# T\n\n见 [文档](https://example.com/a~b) 与 **粗** 与 `code`。\n')
    check('链接：URL 原样保留 ~', d.links == [{'text': '文档', 'url': 'https://example.com/a~b', 'line': 3}])
    check('反引号：报 inline-code 并从文字中去掉', 'inline-code' in codes(d) and '`' not in dp.inline_plain(d.blocks[0]['inline']))
    check('加粗节点', any(n['t'] == 'bold' for n in d.blocks[0]['inline']))
    d = P('# T\n\n正文 <span>x</span>\n')
    check('反例：HTML 标签报 html-tag（L1）', 'html-tag' in codes(d))

    # ---- 高亮块
    d = P('# T\n\n> [!note] 旧写法单行\n\n> [!risk]\n> 第一段\n>\n> - 项一\n> - 项二\n\n> [!tip] t\n> [!decision] d\n\n> [!foo] x\n')
    kinds = [c['kind'] for c in d.callouts]
    check('高亮块：旧写法、多行续行、块内列表', kinds[:4] == ['note', 'risk', 'tip', 'decision'] and [b['kind'] for b in d.callouts[1]['blocks']] == ['p', 'ul'], d.callouts[:2])
    check('反例：不支持的种类报 callout-kind，按 note', 'callout-kind' in codes(d) and kinds[4] == 'note')

    # ---- 数据块
    csv = '编号,模块,标题,优先级\nTC-ACCT-02,账户 管理,乙,P1\nTC-ACCT-01,账户 管理,甲,P0\nTC-EARN-01,获取,丙,P0\nTC-A^B-01,其他,丁,P2\n'
    r = rd('data', {'doc.md': '', 'data/cases.csv': csv})
    def D(args, pack=None):
        return P(f'# T\n\n## 章\n\n<!-- data: {args} -->\n', pack=pack, run_dir=r)
    d = D('data/cases.csv columns=编号,标题 filter=编号^TC-ACCT- sort=编号 caption="用例 列表" id=tbl:cases widths=1,3')
    t = d.tables[0]
    check('数据块：columns、filter、sort、caption 带空格、id、widths', t['header'] == ['编号', '标题'] and t['rows'] == [['TC-ACCT-01', '甲'], ['TC-ACCT-02', '乙']]
          and t['caption'] == '用例 列表' and t['anchor'] == 'tbl:cases' and t['number'] == '表 1-1' and t['widths'] == [1, 3], t['rows'])
    check('数据块：records_full 保留全部列、csv_lines', t['records_full'][0]['优先级'] == 'P0' and t['csv_lines'] == [3, 2])
    d = D('data/cases.csv filter="模块^账户 管理" filter=优先级^P0')
    check('数据块：带空格的前缀、多个 filter 取交集', [x[0] for x in d.tables[0]['rows']] == ['TC-ACCT-01'], d.tables[0]['rows'])
    d = D('data/cases.csv filter=编号^TC-A^B')
    check('数据块：前缀里可再出现 ^（以第一个 ^ 为界）', [x[0] for x in d.tables[0]['rows']] == ['TC-A^B-01'])
    d = D('data/cases.csv group=模块')
    g = d.tables[0]['groups']
    check('数据块：group 分节与小计', [(x['value'], x['count']) for x in g] == [('账户 管理', 2), ('获取', 1), ('其他', 1)], g)
    for args, code in (('data/cases.csv columns=编号,不存在', 'data-column'), ('data/cases.csv filter=编号^', 'data-filter-empty'),
                       ('data/cases.csv filter=编号TC', 'data-filter'), ('data/cases.yaml', 'data-yaml'), ('data/nope.csv', 'data-missing'),
                       ('../x.csv', 'data-path'), ('data/cases.csv filter=编号^ZZZ', 'data-no-rows'), ('data/cases.csv group=不存在', 'data-column')):
        d = D(args)
        check(f'反例：数据块 {args} 报 {code}（L9）', any(x['code'] == code and x['rule'] == 'L9' for x in d.diagnostics), codes(d))
    d = D('data/cases.csv', pack={'features': {'data_blocks': False}})
    check('反例：data_blocks=false 报 feature-disabled', 'feature-disabled' in codes(d))
    d = D('data/cases.csv filter=编号^ZZZ')
    check('数据块 0 行：只有表头、info 级', d.tables[0]['rows'] == [] and next(x for x in d.diagnostics if x['code'] == 'data-no-rows')['severity'] == 'info')

    # ---- summary / landscape / pagebreak / 脚注
    d = P('# T\n\n<!-- summary -->\n摘要段\n\n- 点\n<!-- /summary -->\n\n## 章\n\n<!-- landscape -->\n| a |\n|---|\n| 1 |\n<!-- /landscape -->\n\n<!-- pagebreak -->\n')
    sb = [b for b in d.blocks if b.get('in_summary') and b['kind'] not in ('summary',)]
    check('summary：块内段落与列表带 in_summary', [b['kind'] for b in sb] == ['p', 'ul'])
    check('landscape：表格 landscape=True；pagebreak 块', d.tables[0]['landscape'] and any(b['kind'] == 'pagebreak' for b in d.blocks))
    d = P('# T\n\n<!-- summary -->\n段\n')
    check('反例：summary 未闭合', 'summary-unclosed' in codes(d))
    d = P('# T\n\n<!-- /landscape -->\n')
    check('反例：landscape 不成对', 'landscape-unbalanced' in codes(d))
    d = P('# T\n\n正文[^1]与[^2]。\n\n[^1]: 注一\n[^3]: 没用到\n')
    check('脚注：定义、引用、缺定义（X1）、未用（X2 info）', '1' in d.footnotes and d.footnote_refs[0]['id'] == '1' and 'footnote-missing' in codes(d) and 'footnote-unused' in codes(d))
    d = P('# T\n\n[^1]: x\n', pack={'features': {'footnotes': False}})
    check('反例：footnotes=false 报 feature-disabled', 'feature-disabled' in codes(d))

    # ---- 重点高亮
    d = P('# T\n\n段落里⟪重点一⟫与**⟪不⟫**。\n\n- 列表⟪重点二⟫\n\n| 列 |\n|---|\n| 单元格⟪重点三⟫ |\n')
    ctxs = sorted(h['context'] for h in d.highlights)
    check('高亮：段落、列表项、表格单元格三处入口', {'p', 'li', 'table'} <= set(ctxs) and not d.errors(), (ctxs, codes(d)))
    check('高亮：记录纯文本与长度', any(h['text'] == '重点一' and h['length'] == 3 for h in d.highlights))
    leak = []
    def walk_all(doc):
        for inl in dp._all_inline(doc):
            for n in dp.walk_inline(inl):
                if n['t'] == 'text' and ('⟪' in n['v'] or '⟫' in n['v']): leak.append(n['v'])
    for txt, code, line in (('# T\n\n未闭合⟪重点\n', 'highlight-unclosed', 3), ('# T\n\n缺开头重点⟫\n', 'highlight-unopened', 3),
                            ('# T\n\n⟪外⟪内⟫⟫\n', 'highlight-nested', 3), ('# T\n\n第一行⟪跨\n行⟫结束\n', 'highlight-multiline', 3),
                            ('# T\n\n| 列 |\n|---|\n| ⟪未闭合 |\n', 'highlight-unclosed', 5), ('# T\n\n- ⟪项\n', 'highlight-unclosed', 3)):
        d = P(txt)
        hit = [x for x in d.diagnostics if x['code'] == code]
        check(f'反例：{code} 带行号 {line}', hit and hit[0]['line'] == line and hit[0]['severity'] == 'error', d.diagnostics)
        walk_all(d)
    check('高亮：非法 ⟪ ⟫ 从行内节点中丢弃，不泄漏', not leak, leak)

    # ---- 重点高亮颜色前缀（2026-09-15 主代理定：! risk / + tip / ~ warn / ? decision，无前缀 neutral）
    d = P('# T\n\n无⟪甲⟫、险⟪!乙⟫、利⟪+丙⟫、注⟪~丁⟫、决⟪?戊⟫。\n')
    got = [(h['kind'], h['text']) for h in d.highlights]
    check('高亮前缀：4 个前缀各识别一次，无前缀为 neutral',
          got == [('neutral', '甲'), ('risk', '乙'), ('tip', '丙'), ('warn', '丁'), ('decision', '戊')] and not d.errors(), (got, codes(d)))
    check('高亮前缀：前缀字符不进入内容与字数统计', all(h['length'] == 1 for h in d.highlights), [h['length'] for h in d.highlights])
    hn = [n for inl in dp._all_inline(d) for n in dp.walk_inline(inl) if n['t'] == 'highlight']
    check('高亮前缀：节点带 kind 字段', [n.get('kind') for n in hn] == ['neutral', 'risk', 'tip', 'warn', 'decision'], hn)
    d = P('# T\n\n非法前缀⟪#甲⟫与⟪ +乙⟫。\n')
    got = [(h['kind'], h['text']) for h in d.highlights]
    check('高亮前缀：⟪ 后不是这 4 个字符、或前缀前有空格时按无前缀处理，字符不被吞掉',
          got == [('neutral', '#甲'), ('neutral', ' +乙')] and not d.errors(), (got, codes(d)))
    d = P('# T\n\n空⟪!⟫。\n')
    hit = [x for x in d.diagnostics if x['code'] == 'highlight-empty']
    check('高亮前缀：前缀后立即闭合算空高亮（HL1 warning），kind 仍为 risk',
          hit and d.highlights[0]['kind'] == 'risk' and d.highlights[0]['text'] == '', (d.diagnostics, d.highlights))
    d = P('# T\n\n## ⟪+重点章节⟫\n\n正文。\n')
    check('高亮前缀：标题（目录场景）里也识别 kind', d.highlights[0]['kind'] == 'tip' and d.highlights[0]['context'] == 'heading', d.highlights)

    # ---- 编号实体
    pack = {'numbering': {'section': 'decimal', 'figure': '图 {chapter}-{seq}', 'table': '表 {chapter}-{seq}',
                          'entities': [{'kind': 'req', 'label': '需求', 'pattern': r'REQ-[A-Z]+-\d{2}'}]}}
    d = P('# T\n\n## 需求\n\n| 编号 | 描述 |\n|---|---|\n| REQ-A-01 | 甲，依赖 REQ-B-01 |\n| REQ-A-02 | 乙 |\n\n见 REQ-A-01。{#req:REQ-X-09}\n', pack=pack)
    check('实体：表格首列为定义，带 row', [e['code'] for e in d.entities['req']][:2] == ['REQ-A-01', 'REQ-A-02'] and d.entities['req'][0]['row']['描述'].startswith('甲'))
    check('实体：行内锚点为定义；其余为 mentions', 'REQ-X-09' in [e['code'] for e in d.entities['req']] and sorted(m['code'] for m in d.entity_mentions['req']) == ['REQ-A-01', 'REQ-B-01'], d.entity_mentions)

    # ---- include
    r = rd('inc', {'doc.md': '# T\n\n<!-- include: sections/a.md -->\n\n尾\n', 'sections/a.md': '## 引入\n\n<!-- include: sections/b.md -->\n', 'sections/b.md': 'B 段\n'})
    d = dp.parse_file(r, 'doc.md')
    check('include：两层展开、状态 ok', [x['status'] for x in d.includes] == ['ok', 'ok'] and 'B 段' in d.text and not d.errors(), d.includes)
    ln = d.lines.index('B 段') + 1
    check('include：line_origin 指回原文件行', d.line_origin[ln - 1] == ('sections/b.md', 1), d.line_origin)
    check('include：展开后的标题行号按 lines 计', d.headings[0]['line'] == d.lines.index('## 引入') + 1)
    r = rd('inc2', {'doc.md': '<!-- include: internal-cost.md -->\n<!-- include: sections/internal-x.md -->\n<!-- include: sections/none.md -->\n<!-- include: ../x.md -->\n<!-- include: data/x.md -->\n',
                    'internal-cost.md': 'x', 'sections/internal-x.md': 'y', 'data/x.md': 'z'})
    d = dp.parse_file(r, 'doc.md')
    check('反例：include 白名单外、deny、缺失、越界全部拒绝（L1）', [x['status'] for x in d.includes] == ['forbidden', 'forbidden', 'missing', 'forbidden', 'forbidden'] and all(x['rule'] == 'L1' for x in d.diagnostics if x['code'].startswith('include')), d.includes)
    chain = {'doc.md': '# T\n<!-- include: sections/1.md -->\n'}
    for k in range(1, 5): chain[f'sections/{k}.md'] = f'L{k}\n<!-- include: sections/{k + 1}.md -->\n'
    chain['sections/5.md'] = 'L5\n'
    r = rd('inc3', chain)
    d = dp.parse_file(r, 'doc.md')
    check('反例：include 超过 3 层报 too_deep（第 4 层原文插入不展开）', 'include-too_deep' in codes(d) and 'L4' in d.text and 'L5' not in d.text, codes(d))
    if os.path.exists(LEGACY_RENDER):
        spec = importlib.util.spec_from_file_location('legacy_render', LEGACY_RENDER)
        lr = importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
        r = rd('inc4', {'proposal.md': '# T\n\n<!-- include: sections/a.md -->\n正文 <!-- include: terms-x.md -->\n', 'sections/a.md': '## A\n\n<!-- include: sections/b.md -->\n', 'sections/b.md': 'B\n', 'terms-x.md': ''})
        old = lr.resolve(os.path.join(r, 'proposal.md').replace('terms-x.md', 'x'), r) if False else None
        open(os.path.join(r, 'proposal.md'), 'w').write('# T\n\n<!-- include: sections/a.md -->\n正文\n<!-- include: sections/b.md -->\n')
        old = lr.resolve(os.path.join(r, 'proposal.md'), r)
        new = dp.parse_file(r, 'proposal.md').text
        check('兼容：include 展开结果与旧渲染器 resolve() 逐字一致', old == new, (old, new))

    # ---- Codex 交付评审补充的反例
    r = rd('inc-line', {'doc.md': '# T\n\n正文一\n<!-- include: sections/a.md -->\n', 'sections/a.md': '甲\n<!-- include: secret.md -->\n', 'secret.md': 'x'})
    d = dp.parse_file(r, 'doc.md')
    bad = [x for x in d.diagnostics if x['code'] == 'include-forbidden']
    exp = d.lines.index('<!-- include: secret.md -->') + 1
    check('include 诊断行号是展开后正文行号，source_line 为原文件行号', bad and bad[0]['line'] == exp and bad[0]['source_line'] == 2 and bad[0]['file'] == 'sections/a.md', (bad, exp))
    outside = os.path.join(base, 'outside'); os.makedirs(outside, exist_ok=True)
    open(os.path.join(outside, 'leak.md'), 'w').write('泄露\n'); open(os.path.join(outside, 'leak.csv'), 'w').write('a\n1\n')
    r = rd('symlink', {'doc.md': '# T\n\n<!-- include: sections/link.md -->\n\n<!-- data: data/link.csv -->\n'})
    os.makedirs(os.path.join(r, 'sections'), exist_ok=True); os.makedirs(os.path.join(r, 'data'), exist_ok=True)
    os.symlink(os.path.join(outside, 'leak.md'), os.path.join(r, 'sections', 'link.md'))
    os.symlink(os.path.join(outside, 'leak.csv'), os.path.join(r, 'data', 'link.csv'))
    d = dp.parse_file(r, 'doc.md')
    check('反例：符号链接指向运行目录外（include 与数据块）都拒绝', d.includes[0]['status'] == 'forbidden' and '泄露' not in d.text and 'data-path' in codes(d), (d.includes, codes(d)))
    d = P('# T\n\n![图](figures/a.svg){#tbl:x}\n\n见 @tbl:x。\n')
    check('反例：图上写 tbl: 锚点报 error 并丢弃，引用随之未解析', any(x['code'] == 'anchor-kind' and x['severity'] == 'error' for x in d.diagnostics) and d.figures[0]['anchor'] is None and 'ref-unresolved' in codes(d))
    d = P('# T\n\n## 需求 {#req:REQ-A-01}\n\n## 另一 {#fig:y}\n', pack={'numbering': {'section': 'decimal', 'figure': '图 {chapter}-{seq}', 'table': '表 {chapter}-{seq}', 'entities': [{'kind': 'req', 'label': '需求', 'pattern': r'REQ-[A-Z]+-\d{2}'}]}})
    check('标题上的实体锚点转为行内锚点；标题上写 fig: 报 anchor-kind', 'req:REQ-A-01' in d.anchors and d.headings[0]['anchor'] is None and d.headings[1]['anchor'] is None and 'anchor-kind' in codes(d))
    d = P('# T\n\n<!-- table: 远处表题 -->\n\n一段正文\n\n| a |\n|---|\n| 1 |\n')
    check('反例：table 注释与表格之间隔着正文报 directive-dangling，表格不带表题', 'directive-dangling' in codes(d) and d.tables[0]['caption'] == '')
    d = P('# T\n\n<!-- widths: 1,2 -->\n<!-- table: 表题 -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    check('widths 与 table 注释连写、之间有空行仍挂到表格上', not [x for x in d.diagnostics if x['code'] == 'directive-dangling'] and d.tables[0]['caption'] == '表题' and d.tables[0]['widths'] == [1, 2])
    d = P('# T\n\n| a |\n| 1 |\n|---|\n')
    check('反例：分隔行不在第二行报 table-no-separator 与 table-separator-position', {'table-no-separator', 'table-separator-position'} <= set(codes(d)) and d.tables[0]['rows'] == [['1']])
    d = P('# T\n\n<!-- grid: 2 -->\n![a](shots/a.png)\n混进来的段落\n<!-- /grid -->\n')
    check('反例：grid 内混入段落报 grid-child（L1）', any(x['code'] == 'grid-child' and x['rule'] == 'L1' for x in d.diagnostics))

    # ---- 第三波 W3-D1：1b 验收问题回归
    d = P('# T\n\n| a | b |\n|---||\n| 1 | 2 |\n')
    check('反例：第二行分隔行有空列报 table-no-separator，该行不进数据', 'table-no-separator' in codes(d) and d.tables[0]['rows'] == [['1', '2']], (codes(d), d.tables[0]['rows']))
    d = P('# T\n\n| a | b |\n|---|\n| 1 | 2 |\n')
    check('反例：第二行分隔行列数不等于表头报 table-no-separator', 'table-no-separator' in codes(d) and d.tables[0]['rows'] == [['1', '2']], codes(d))
    d = P('# T\n\n| a | b |\n|:---|---:|\n| 1 | 2 |\n')
    check('正例：合法分隔行（含对齐冒号）无表格诊断', not [x for x in codes(d) if x.startswith('table-')], codes(d))
    d = P('# T\n\n<!-- widths: 1,2 -->\n<!-- widths: x -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    check('反例：非法 widths 清空之前挂起的合法 widths（表格 widths 为 None）', 'widths-invalid' in codes(d) and d.tables[0]['widths'] is None, d.tables[0]['widths'])
    for bad_w in ('nan,1', 'inf,1', '1,-inf'):
        d = P(f'# T\n\n<!-- widths: 1,2 -->\n<!-- widths: {bad_w} -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
        check(f'反例：widths 含非有限值（{bad_w}）报 widths-invalid 并清空挂起', 'widths-invalid' in codes(d) and d.tables[0]['widths'] is None, (codes(d), d.tables[0]['widths']))
    r_nan = rd('data-nan', {'data/t.csv': '列一,列二\n1,2\n'})
    for bad_w in ('nan,1', 'inf,1'):
        d = P(f'# T\n\n<!-- data: data/t.csv widths={bad_w} -->\n', run_dir=r_nan)
        tb = d.tables[0] if d.tables else {}
        check(f'反例：数据块 widths 含非有限值（{bad_w}）报 data-widths，表格 widths 为 None', 'data-widths' in codes(d) and tb and tb.get('widths') is None, (codes(d), tb.get('widths') if tb else None))
    d = P('# T\n\n需求定义{#req:R1}，**加粗{#req:R3}**。\n\n见 @req:R1。\n\n| a | b |\n|---|---|\n| C{#req:R2} | @req:R2 |\n')
    an = [n for nodes in dp._all_inline(d) for n in dp.walk_inline(nodes) if n['t'] == 'anchor']
    check('行内锚点保留为 anchor 节点（段落、加粗内、表格单元格），纯文本不含锚点，引用全部解析', [n['target'] for n in an] == ['req:R1', 'req:R3', 'req:R2']
          and dp.inline_plain(d.blocks[0]['inline']) == '需求定义，加粗。' and all(r['resolved'] for r in d.refs) and '{#' not in json.dumps([b.get('inline') for b in d.blocks], ensure_ascii=False), an)
    out2 = os.path.join(base, 'outside2'); os.makedirs(out2, exist_ok=True)
    open(os.path.join(out2, 'secret.md'), 'w').write('# 机密\n')
    png1 = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')
    open(os.path.join(out2, 's.png'), 'wb').write(png1); open(os.path.join(out2, 's.svg'), 'w').write('<svg xmlns="http://www.w3.org/2000/svg"/>')
    open(os.path.join(out2, 's.mmd'), 'w').write('flowchart TD\n A-->B\n')
    r = rd('src-link', {'real.md': '# 正常\n'})
    os.symlink(os.path.join(out2, 'secret.md'), os.path.join(r, 'doc.md'))
    for name, src in (('符号链接指向外部', 'doc.md'), ('..', '../outside2/secret.md')):
        try:
            dp.parse_file(r, src); raised = False
        except dp.SourcePathError:
            raised = True
        check(f'反例：正文源文件越界（{name}）抛 SourcePathError，不读入外部内容', raised)
    r = rd('fig-link', {'doc.md': '# T\n\n![位图](shots/link.png)\n\n![矢量](figures/a.svg)\n\n![源](figures/b.mmd)\n\n![构建产物](figures/c.mmd)\n\n![正常](figures/ok.mmd)\n',
                        'figures/c.mmd': 'flowchart TD\n A-->B\n', 'figures/ok.mmd': 'flowchart TD\n A-->B\n', 'figures/ok.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>'})
    os.makedirs(os.path.join(r, 'shots'), exist_ok=True)
    os.symlink(os.path.join(out2, 's.png'), os.path.join(r, 'shots', 'link.png'))
    os.symlink(os.path.join(out2, 's.svg'), os.path.join(r, 'figures', 'a.svg'))
    os.symlink(os.path.join(out2, 's.mmd'), os.path.join(r, 'figures', 'b.mmd'))
    os.symlink(os.path.join(out2, 's.svg'), os.path.join(r, 'figures', 'c.svg'))
    d = dp.parse_file(r, 'doc.md')
    fp = [x['line'] for x in d.diagnostics if x['code'] == 'figure-path']
    check('反例：图文件经符号链接越界（PNG、SVG、MMD、build 产物 SVG）各报 figure-path，正常图不报', len(fp) == 4 and d.figures[4]['line'] not in fp, (fp, codes(d)))
    # TOCTOU：说明性用例（已知限制，docmark-ast.md §10 威胁模型：运行目录由单用户、单进程可信写入）。只打印，不计失败。
    r = rd('toctou', {'doc.md': '# T\n\n<!-- include: sections/a.md -->\n', 'sections/a.md': '合法\n'})
    orig_within = dp.within
    def racing(root, path):
        ok = orig_within(root, path)
        if ok and path.endswith(os.path.join('sections', 'a.md')) and not os.path.islink(path):
            os.remove(path); os.symlink(os.path.join(outside, 'leak.md'), path)   # 检查通过之后、打开之前被替换
        return ok
    dp.within = racing
    try:
        d = dp.parse_file(r, 'doc.md')
    finally:
        dp.within = orig_within
    if verbose:
        print('KNOWN docmark：已知限制（TOCTOU）：检查后被替换为外指符号链接' + ('时仍会读入外部内容（复现）' if '泄露' in d.text else '未复现') + '；威胁模型见 docmark-ast.md §10')

    # ---- 旧文档兼容：golden 四份
    for g in ('smoke-site', 'smoke-reddit', 'smoke-guards', 'mobyvow-site-v4.0'):
        p = os.path.join(GOLDEN, g, 'proposal.resolved.md')
        if not os.path.exists(p):
            check(f'兼容：golden {g} 存在', False, p); continue
        d = dp.parse_text(open(p, encoding='utf-8').read())
        check(f'兼容：golden {g} 解析无 error 级诊断', not d.errors(), d.errors()[:3])
    d = dp.parse_text(open(os.path.join(GOLDEN, 'mobyvow-site-v4.0', 'proposal.resolved.md'), encoding='utf-8').read())
    check('兼容：MOBYVOW 标题 44、表格 32、图 6（与旧产物一致）', (len(d.headings), len(d.tables), len(d.figures)) == (44, 32, 6), (len(d.headings), len(d.tables), len(d.figures)))
    check('to_dict 可 JSON 序列化', bool(json.dumps(d.to_dict(), ensure_ascii=False)))

    shutil.rmtree(base, ignore_errors=True)
    return fails


if __name__ == '__main__':
    f = run()
    print(f"\n{'ALL PASS' if not f else str(len(f)) + ' FAILED'}（docmark 解析器）")
    sys.exit(1 if f else 0)
