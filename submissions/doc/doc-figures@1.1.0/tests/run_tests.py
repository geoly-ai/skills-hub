#!/usr/bin/env python3
"""doc-figures 自测。改动 scripts/、templates/、vendor/ 后运行，ALL PASS 才算改完：

  python3 ~/.claude/skills/doc-figures/tests/run_tests.py [--no-wb] [--keep]

覆盖：
 1. 文本换行（不拆拉丁词、禁则、平衡）、等效字号公式、画布宽反推
 2. 画板 lint 各项反例、字号继承、宽高比、id 命名空间（引用同步、颜色值不误伤、幂等）
 3. Mermaid 预处理：init fontFamily 去引号、xychart / quadrantChart 自动加引号、gantt todayMarker、阶梯式生成与跨行回环拦截、源码 lint
 4. 八个 svgkit 模板：正例自检为空；越界（超长单词）、重叠、字号不足三类反例都能检出；spec 错误抛 SpecError
 5. build 集成：Mermaid 六类（flowchart、sequence、state、er、gantt、xychart）+ Graphviz + 模板 + 坏成品 SVG；
    foreignObject 为 0、甘特刻度实测不重叠且密集时自动放大间隔、init 带引号的主题经预处理后生效（Chrome 实测）、review.json 字段、PNG 产出
 6. architecture.svg 复刻：layered-arch 渲染后通过自检、Chrome 实测、画板 lint 与字号检查，原图全部文字都出现在复刻图中，导出并排 PNG
 7. 引擎业务词守卫（scripts/ 不出现业务词）
"""
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)
import svgkit as k  # noqa: E402
import lint  # noqa: E402
import mermaid  # noqa: E402
import graphviz  # noqa: E402
from templates import get as get_template, NAMES  # noqa: E402

BASE = tempfile.mkdtemp(prefix='doc-figures-test-')
ARCH = os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/architecture.svg')
WB = '--no-wb' not in sys.argv
fails, skips = [], []


def check(name, cond, detail=None):
    if cond:
        print(f'  PASS {name}')
    else:
        fails.append(name)
        print(f'  FAIL {name}' + (f'\n       {str(detail)[:600]}' if detail is not None else ''))


def skip(name, why):
    skips.append(name)
    print(f'  SKIP {name}：{why}')


def rules(issues):
    return {i['rule'] for i in issues}


# ---------------------------------------------------------------- 1. 文本与尺寸
print('1. 文本与尺寸')
lines, ov = k.wrap_info('Supercalifragilisticexpialidocious 很长', 17, 120)
check('超长拉丁词不截断、报 overflow', lines[0] == 'Supercalifragilisticexpialidocious' and ov, lines)
lines, ov = k.wrap_info('通用入口：判类型 · 收 Brief · 守 D0–D4', 17, 200)
check('拉丁词不被拆开', all(not re.search(r'[A-Za-z0-9]$', a) or not re.match(r'^[A-Za-z0-9]', b) for a, b in zip(lines, lines[1:])), lines)
for text, w in [('测试计划/用例', 100), ('售前 · Reddit', 100), ('Graphviz · svgkit', 90), ('客户签署，冻结设计基线。以及后续', 60)]:
    lines, _ = k.wrap_info(text, 19, w, True)
    check(f'禁则：「{text}」@{w} 行首无收尾标点或分隔符', all(ln[0] not in k._NO_START for ln in lines[1:]), lines)
lines, _ = k.wrap_info('一二三四五六七八九十一二三四五六七八九十一', 17, 17 * 20)
check('平衡换行：末行不只剩一两个字', len(lines) == 2 and len(lines[-1]) >= 4, lines)
lines, _ = k.wrap_info('⑪\u00a0生产环境验收', 19, 80, True)
check('不断行空格：编号不与名称拆开', not any(ln.strip() == '⑪' for ln in lines), lines)
for text, w, bad in [('功能 / 兼容 / 性能 CWV / SEO 专项 / 安全基线，P0 / P1 缺陷清零', 210, ['安全基', '线']),
                     ('上线后 2–4 周监控 + 缺陷免费修复 → 项目关闭报告', 210, ['免费修', '复']),
                     ('Staging + UAT 用例 + 两轮修复 → 客户验收签字', 210, ['客', '户验收签字']),
                     ('测试计划/用例', 100, ['测试计', '划/用例'])]:
    lines, _ = k.wrap_info(text, 17, w, slack=6)
    frag = any(len(re.findall(r'[\u4e00-\u9fff]+$', a)[0] if re.findall(r'[\u4e00-\u9fff]+$', a) else 'xx') == 1 and re.match(r'[\u4e00-\u9fff]', b) for a, b in zip(lines, lines[1:])) \
        or any(re.match(r'^[\u4e00-\u9fff][^\u4e00-\u9fff]', b) or b[:1] and len(re.match(r'[\u4e00-\u9fff]*', b).group(0)) == 1 and re.search(r'[\u4e00-\u9fff]$', a) for a, b in zip(lines, lines[1:]))
    check(f'中文词不断开、不留单字碎片：「{text[:16]}…」@{w} → {lines}', lines[:2] != bad and not frag, lines)
check('T1：中英文之间自动补空格', k.cjk_space('代码经Code Review合并100%完成') == '代码经 Code Review 合并 100% 完成', k.cjk_space('代码经Code Review合并100%完成'))
check('T1：已有空格不重复（幂等）', k.cjk_space('代码经 Code') == '代码经 Code')
check('分隔符优先于普通空格断行', k.wrap_info('通用入口：判类型 · 收 Brief · 守 D0–D4', 17, 200)[0][0].endswith('·'))
check('等效字号：1200 宽 17px → 7.31pt（与 layout.md 校核值一致）', abs(k.equiv_pt(17, 1200) - 7.31) < 0.01, k.equiv_pt(17, 1200))
check('等效字号：1180 宽 12px → 5.25pt', abs(k.equiv_pt(12, 1180) - 5.25) < 0.01)
check('画布反推：显示 60% → 720；横向页 → 1774', k.canvas_width_for({'width_ratio': 0.6}) == 720 and k.canvas_width_for({'landscape': True}) == 1774)
check('min_px_for：1200 → 17，1000 → 14，800 → 11（按 layout.md 公式；figures-policy §4 写的 12 偏保守）', [k.min_px_for(w) for w in (1200, 1000, 800)] == [17, 14, 11], [k.min_px_for(w) for w in (1200, 1000, 800)])
check('调色板来自 doc-shared svg-palette.json', k.C['purple'] == ('#6C5CE7', '#EEEBFF', '#3C2A9E'))

# ---------------------------------------------------------------- 2. lint
print('2. lint')
arch = open(ARCH).read() if os.path.exists(ARCH) else None
if arch:
    check('architecture.svg 画板 lint 0 问题', lint.board_lint(arch) == [], lint.board_lint(arch))
    st = lint.font_stats(arch)
    pt, fi = lint.font_issue(st)
    check('architecture.svg 最小 17px、7.31pt、无字号问题', st['min_font_px'] == 17 and pt == 7.31 and fi is None, (st, pt))
else:
    skip('architecture.svg 基准', '文件不存在')
bad_cases = {
    'BL1_forbidden': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs></svg>',
    'BL2_filter': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><filter id="f"><feGaussianBlur/></filter></svg>',
    'BL3_thin_rect': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="1"/></svg>',
    'BL5_viewbox': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text font-size="17">x</text></svg>',
    'BL6_external': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://x.test/a.png"/></svg>',
    'BL4_text_as_path': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="glyph-1" d="M0 0"/></svg>',
}
for rule, svg in bad_cases.items():
    check(f'画板 lint 反例 {rule}', rule in rules(lint.board_lint(svg)), lint.board_lint(svg))
check('filter 只含单个 feDropShadow 时放行', lint.board_lint('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><filter id="s"><feDropShadow/></filter></svg>') == [])
for tag in ('mask', 'pattern', 'foreignObject', 'style'):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><{tag}/></svg>'
    check(f'画板 lint 拦截 {tag}', any(i['rule'] == 'BL1_forbidden' and i['target'] == tag for i in lint.board_lint(svg)))
inh = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 100"><g font-size="20"><text>a<tspan font-size="0.5em">b</tspan></text></g><text style="font-size:18px">c</text></svg>'
check('字号继承：g → text → tspan(0.5em) = 10px', lint.font_stats(inh)['min_font_px'] == 10, lint.font_stats(inh))
small = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 100"><text font-size="12">小字</text></svg>'
pt, fi = lint.font_issue(lint.font_stats(small))
check('字号不足：1200 宽 12px → 必改 LY4', fi and fi['rule'] == 'LY4_font' and fi['severity'] == '必改' and pt < 7, (pt, fi))
pt2, fi2 = lint.font_issue(lint.font_stats(small), landscape=True)
check('同一图放横向页：12px@1200 → 7.62pt 通过', fi2 is None and pt2 > 7, pt2)
check('宽高比：1200×900 报建议、1200×600 通过',
      lint.aspect_check('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900"/>')['severity'] == '建议'
      and lint.aspect_check('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600"/>') is None)
ns_src = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><style>#a{fill:#FFFFFF}#abc{stroke:#a0a0a0}</style>'
          '<defs><marker id="a"/><linearGradient id="abc"/></defs><path marker-end="url(#a)" fill="url(\'#abc\')"/><use xlink:href="#a"/>'
          '<g aria-labelledby="a t"><title id="t">x</title></g></svg>')
ns = lint.namespace_ids(ns_src, 'f3-')
check('namespace_ids：id、url(#)、xlink:href、aria、style 选择器同步加前缀',
      all(s in ns for s in ('id="f3-a"', 'id="f3-abc"', 'url(#f3-a)', "url('#f3-abc')", 'xlink:href="#f3-a"', 'aria-labelledby="f3-a f3-t"', '#f3-a{', '#f3-abc{')), ns)
check('namespace_ids：颜色值 #FFFFFF / #a0a0a0 不受影响', '#FFFFFF' in ns and '#a0a0a0' in ns and '#f3-FFFFFF' not in ns)
check('namespace_ids：幂等', lint.namespace_ids(ns, 'f3-') == ns)
q1 = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><style>#fff{fill:#fff} rect{stroke:#fff}</style><g id='fff'/><rect id=\"a\"/><use href='#a'/><path fill='url(#a)'/></svg>"
nq = lint.namespace_ids(q1, 'f1-')
check('namespace_ids（Codex 复核）：单引号 id / href 同步改写；选择器 #fff 改、声明里的颜色 #fff 不改',
      "id='f1-fff'" in nq and "href='#f1-a'" in nq and 'id="f1-a"' in nq and '#f1-fff{fill:#fff}' in nq and 'stroke:#fff' in nq and "url(#f1-a)" in nq, nq)
check('font_stats（Codex 复核）：纯 tspan 文字只按 tspan 字号计（不被父 text 默认 16px 误算）',
      lint.font_stats('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 10"><text><tspan font-size="17">x</tspan></text></svg>')['min_font_px'] == 17)
check('board_lint（Codex 复核）：任意元素的外部 href（如 linearGradient）报 BL6',
      'BL6_external' in rules(lint.board_lint('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><linearGradient href="https://x.test/g.svg#x"/></svg>')))
try:
    lint.namespace_ids(ns_src, '3bad')
    check('namespace_ids：非法前缀报错', False)
except ValueError:
    check('namespace_ids：非法前缀报错', True)

# ---------------------------------------------------------------- 3. Mermaid 预处理
print('3. Mermaid 预处理与源码 lint')
q = "%%{init: {'themeVariables': {'fontFamily': '\"PingFang SC\", sans-serif'}}}%%\nflowchart LR\n A-->B\n"
q2 = '%%{init: {"themeVariables": {"fontFamily": "\'PingFang SC\', sans-serif"}}}%%\nflowchart LR\n A-->B\n'
for label, src in (('单引号包双引号', q), ('双引号包单引号', q2)):
    fixed, notes = mermaid.preprocess(src)
    check(f'init fontFamily 带引号（{label}）：lint 必改 + 预处理去引号', any(i['rule'] == 'mmd_init_font_quotes' for i in mermaid.lint_source(src))
          and not mermaid.init_font_quoted(fixed) and 'PingFang SC, sans-serif' in fixed, (fixed, notes))
check('主题注入的 fontFamily 不带引号', not re.search(r'["\']', mermaid.theme_config()['themeVariables']['fontFamily']), mermaid.theme_config()['themeVariables']['fontFamily'])
xy = 'xychart-beta\n    x-axis [第1周, 第2周]\n    y-axis "数" 0 --> 10\n    bar [1, 12]\n'
fx, _ = mermaid.preprocess(xy)
fxq, _ = mermaid.preprocess('xychart-beta\n  x-axis ["FY 2024, Q1", "FY 2024, Q2", 第三季]\n  bar [1, 2, 3]\n')
check('xychart（Codex 复核）：已加引号且含逗号的分类不被拆坏', 'x-axis ["FY 2024, Q1", "FY 2024, Q2", "第三季"]' in fxq, fxq)
fsi, _ = mermaid.preprocess("%%{init: {'flowchart': {'curve': 'basis'}}}%%\n%% doc-figures: stairs rows=2\nflowchart LR\n A[需求] --> B[设计] --> C[开发] --> D[测试] --> E[发布]\n")
check('stairs 改写（Codex 复核）：保留原 init 指令', fsi.startswith("%%{init: {'flowchart': {'curve': 'basis'}}}%%") and 'direction LR' in fsi, fsi[:200])
check('xychart 中文分类自动加引号', 'x-axis ["第1周", "第2周"]' in fx, fx)
check('xychart 数据超出 y 轴范围 → 必改', 'mmd_xychart_range' in rules(mermaid.lint_source(xy)))
quad = 'quadrantChart\n    x-axis 低 --> 高\n    quadrant-1 机会区\n    A: [0.3, 0.6]\n'
fq, _ = mermaid.preprocess(quad)
check('quadrantChart 中文轴与象限自动加引号', 'x-axis "低" --> "高"' in fq and 'quadrant-1 "机会区"' in fq, fq)
fg, _ = mermaid.preprocess('gantt\n    dateFormat YYYY-MM-DD\n    section A\n    t :a, 2026-01-01, 3d\n')
check('gantt 补 todayMarker off', 'todayMarker off' in fg)
spec12 = {'rows': 3, 'row_labels': ['一', '二', '三'], 'phases': [{'name': f'环节{i}', 'items': ['关键活动'], 'gate': '准出条件'} for i in range(12)],
          'loops': [{'from': 3, 'to': 1, 'label': '打回'}]}
st = mermaid.stairs_mmd(spec12)
check('阶梯式生成：外层 TB、3 个 direction LR 子图、子图间行尾连行首、节点三行文案、回环在行内',
      st.startswith('flowchart TB') and st.count('direction LR') == 3 and 'R1 --> R2' in st and 'R2 --> R3' in st
      and st.count('<br/>') >= 24 and 'S4 -.->|打回| S2' in st, st)
bad = copy.deepcopy(spec12)
bad['loops'] = [{'from': 5, 'to': 1}]
try:
    mermaid.stairs_mmd(bad)
    check('阶梯式：跨行回环拦截', False)
except k.SpecError:
    check('阶梯式：跨行回环拦截', True)
lin = 'flowchart LR\n A[需求] --> B[设计] --> C[开发] --> D[测试] --> E[发布]\n'
check('>4 节点线性流程：lint 建议改阶梯式', 'mmd_linear_long' in rules(mermaid.lint_source(lin)))
r, notes = mermaid.preprocess('%% doc-figures: stairs rows=2\n' + lin)
check('stairs 指令：线性流程改写为两行', r.count('direction LR') == 2 and 'R1 --> R2' in r, r)
r, notes = mermaid.preprocess('%% doc-figures: stairs\nflowchart LR\n A --> B\n A --> C\n B --> D\n C --> D\n E --> D\n')
check('stairs 指令：有分叉时不改写并说明原因', 'direction LR' not in r and any('未生效' in n for n in notes), notes)
dot = graphviz.prepare('digraph G { a -> b [fontsize=10]; subgraph cluster_x { c } }')
check('Graphviz：注入品牌默认属性、fontsize 按 LAYOUT_SCALE 放大、cluster 样式', 'fillcolor="#EEEBFF"' in dot and 'fontsize=13.0' in dot and 'fillcolor="#F8F9FA"' in dot, dot)

print('2b. 连线自检反例')
pj = k._simplify(k._remove_jogs(k._simplify([(0, 0), (0, 10), (4, 10), (4, 30)])))
check('_remove_jogs（Codex 复核）：两端都是端口时不移动端口点', pj[0] == (0, 0) and pj[-1] == (4, 30), pj)
cv = k.S(600, 400)
cv.rect(100, 100, 120, 60, '#EEEBFF', '#6C5CE7', rx=10, node_id='a')
cv.rect(400, 100, 120, 60, '#EEEBFF', '#6C5CE7', rx=10, node_id='b')
cv.line([(160, 160), (160, 250), (460, 250)], 'gray', head=False, edge_id='e1')
cv.line([(200, 250), (500, 250), (500, 300)], 'gray', head=False, edge_id='e2')
check('反例·平行段重叠 → edge_overlap', 'edge_overlap' in rules(cv.check()), cv.check())
cv2 = k.S(600, 400)
cv2.rect(20, 60, 560, 200, '#F8F9FA', '#DADCE0', rx=12, frame_id='L', title_h=44)
cv2.line([(40, 90), (500, 90)], 'gray', head=False, edge_id='t1')
check('反例·水平穿过分组标题带 → edge_through_title', 'edge_through_title' in rules(cv2.check()), cv2.check())
cv3 = k.S(600, 400)
cv3.rect(300, 100, 160, 80, '#EEEBFF', '#6C5CE7', rx=10, node_id='n')
cv3.line([(100, 105), (300, 105)], 'gray', edge_id='c1')
check('反例·箭头落在卡片角上 → arrow_on_corner', 'arrow_on_corner' in rules(cv3.check()), cv3.check())
cv4 = k.S(600, 400)
cv4.rect(300, 100, 160, 80, '#EEEBFF', '#6C5CE7', rx=10, node_id='n')
cv4.line([(100, 140), (300, 140)], 'gray', edge_id='c1')
check('正例·箭头落在边中点不报', 'arrow_on_corner' not in rules(cv4.check()), cv4.check())
ts_ = json.load(open(os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/staging/types/tech-spec/samples/membership-points-v2/figures/target-arch.fig.json'))) if os.path.exists(os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/staging/types/tech-spec/samples/membership-points-v2/figures/target-arch.fig.json')) else None
if ts_:
    ct = get_template('layered-arch').render(ts_)
    check('tech-spec target-arch（9 条边、两条同名标签进同一目标）：无重叠段、无穿标题、无角点箭头、自检 0 问题', ct.check() == [], ct.check())
    labels = [t['text'] for t in ct.texts if t['label']]
    check('同一目标的同名标签只标一次', labels.count('同步查询规则') == 1, labels)
    check('连线标签带衬底矩形', ct.svg().count('rx="4" fill="#FFFFFF"') + ct.svg().count('rx="4" fill="#FEFEFE"') >= len(labels), labels)
    ends = [(ax, ay) for ax, ay, _ in ct.arrows]
    check('所有箭头落在节点边中点（±48px 槽位）或分组框边上', all(
        any(abs(ay - n['y']) < 1.5 and abs(ax - n['x'] - n['w'] / 2) in (0, 24, 48) or abs(ax - n['x'] - n['w'] / 2) < 0.6 or abs(ay - n['y'] - n['h'] / 2) < 0.6
            or abs(abs(ax - n['x'] - n['w'] / 2) - 24) < 0.6 or abs(abs(ax - n['x'] - n['w'] / 2) - 48) < 0.6 for n in ct.nodes) or
        any(abs(ay - f['y']) < 1.5 or abs(ay - f['y'] - f['h']) < 1.5 or abs(ax - f['x']) < 1.5 or abs(ax - f['x'] - f['w']) < 1.5 for f in ct.frames) for ax, ay in ends), ends)

# ---------------------------------------------------------------- 4. 模板正反例
print('4. svgkit 模板')
EX = os.path.join(ROOT, 'templates')
LONG = 'A' * 90
long_word = {
    'layered-arch': lambda s: s['layers'][0]['nodes'][0].__setitem__('label', LONG),
    'swimlane': lambda s: s['steps'][1].__setitem__('label', LONG),
    'compare-matrix': lambda s: s['columns'][1].__setitem__('label', LONG),
    'milestone': lambda s: s['phases'][0].__setitem__('name', LONG),
    'coverage-heatmap': lambda s: (s['cols'].__setitem__(0, LONG), [c.__setitem__('col', LONG) for c in s['cells'] if c['col'] == 'P0']),
    'phases': lambda s: s['phases'][0].__setitem__('name', LONG),
    'funnel': lambda s: s['steps'][0].__setitem__('action', LONG),
    'sitemap': lambda s: s['lanes'][0]['groups'][0]['children'].__setitem__(0, LONG),
}
spec_errors = {
    'layered-arch': lambda s: s['edges'].append({'from': 'nope', 'to': 'gw'}),
    'swimlane': lambda s: s['steps'][0].__setitem__('lane', 'nope'),
    'compare-matrix': lambda s: s['rows'][0]['cells'].pop(),
    'milestone': lambda s: s['milestones'].append({'after': 'nope', 'label': 'x'}),
    'coverage-heatmap': lambda s: s['cells'].append({'row': '账户', 'col': 'P9', 'value': 1}),
    'phases': lambda s: s.__setitem__('loops', [{'from': 'dev', 'to': 'release'}]),
    'funnel': lambda s: s.__setitem__('steps', s['steps'][:1]),
    'sitemap': lambda s: s.__delitem__('lanes'),
}
for name in sorted(NAMES):
    path = os.path.join(EX, f'{name}.fig.json')
    spec = json.load(open(path, encoding='utf-8'))
    mod = get_template(name)
    c = mod.render(spec)
    check(f'{name} 正例：自检 0 问题', c.check() == [], c.check())
    check(f'{name} 正例：画板 lint 0 问题、最小字号 ≥ 17px', lint.board_lint(c.svg()) == [] and lint.font_stats(c.svg())['min_font_px'] >= 17,
          (lint.board_lint(c.svg()), lint.font_stats(c.svg())))
    s2 = copy.deepcopy(spec)
    long_word[name](s2)
    r = rules(mod.render(s2).check())
    check(f'{name} 反例·越界：超长单词 → word_too_long / text_overflow', bool(r & {'word_too_long', 'text_overflow', 'out_of_canvas'}), r)
    s3 = copy.deepcopy(spec)
    s3['font_scale'] = 0.8
    c3 = mod.render(s3)
    r3 = rules(c3.check())
    if 'font_too_small' in r3:
        check(f'{name} 反例·字号不足：font_scale 0.8 → font_too_small', True)
    else:
        s3 = copy.deepcopy(spec)
        s3['canvas_width'] = 1800  # 画布放宽但显示宽不变 → 字号等效不足
        r3 = rules(mod.render(s3).check())
        check(f'{name} 反例·字号不足：画布 1800 宽仍用 17px → font_too_small', 'font_too_small' in r3, r3)
    c4 = mod.render(copy.deepcopy(spec))
    if c4.nodes:
        n0 = c4.nodes[0]
    else:  # 表格类模板不登记节点：在第一个文字处放两个叠放节点
        t0 = c4.texts[-1]
        n0 = {'x': t0['x'], 'y': t0['y'], 'w': 80, 'h': 30}
        c4.rect(n0['x'], n0['y'], 80, 30, '#FFFFFF', '#000000', node_id='__base__')
    c4.rect(n0['x'] + 6, n0['y'] + 6, n0['w'], n0['h'], '#FFFFFF', '#000000', node_id='__dup__')
    check(f'{name} 反例·重叠：叠放节点 → node_overlap', 'node_overlap' in rules(c4.check()))
    s5 = copy.deepcopy(spec)
    try:
        spec_errors[name](s5)
        mod.render(s5)
        check(f'{name} 反例·spec 错误抛 SpecError', False)
    except k.SpecError as e:
        check(f'{name} 反例·spec 错误抛 SpecError（{str(e)[:40]}）', True)
csw = get_template('swimlane').render(json.load(open(os.path.join(EX, 'swimlane.fig.json'), encoding='utf-8')))
check('swimlane（Codex 复核）：起止节点登记在 nodes（参与避障与重叠自检）', {'s', 'e'} <= {n['id'] for n in csw.nodes}, [n['id'] for n in csw.nodes])
sw = json.load(open(os.path.join(EX, 'swimlane.fig.json'), encoding='utf-8'))
sw['steps'][4]['col'] = 3
sw['steps'][3]['col'] = 3
sw['steps'][3]['lane'] = 'ops'
check('swimlane 反例·重叠（真实）：两个步骤显式放同一泳道同一列 → node_overlap', 'node_overlap' in rules(get_template('swimlane').render(sw).check()))
cm = json.load(open(os.path.join(EX, 'compare-matrix.fig.json'), encoding='utf-8'))
cm['columns'] = [{'label': f'候选方案{i}'} for i in range(14)]
for r in cm['rows']:
    r['cells'] = ['full'] * 14
c_split = get_template('compare-matrix').render(cm)
check('compare-matrix：14 列自动分块且自检通过', c_split.check() == [] and c_split.h > 900, (c_split.check(), c_split.h))
cm['split'] = False
check('compare-matrix 反例：split=false 时 14 列越界', 'out_of_canvas' in rules(get_template('compare-matrix').render(cm).check()))
ph = json.load(open(os.path.join(EX, 'phases.fig.json'), encoding='utf-8'))
for rows, want in (('auto', 2), (3, 3), (1, 1)):
    p2 = dict(ph, rows=rows, loops=[] if rows != 2 and rows != 'auto' else ph['loops'])
    if rows not in (2, 'auto'):
        p2.pop('row_labels', None)
    c = get_template('phases').render(p2)
    ys = sorted({round(n['y']) for n in c.nodes})
    check(f'phases 阶梯：rows={rows} → {want} 行，自检通过', len(ys) == want and c.check() == [], (ys, c.check()))
qms = {'template': 'phases', 'rows': 3, 'row_style': 'frame', 'row_labels': ['阶段一 · 定义', '阶段二 · 构建与验证', '阶段三 · 交付与保障'], 'gate_label': '质量门',
       'phases': [{'badge': b, 'name': f'环节名称{i}', 'items': ['关键活动说明文字'], 'gate': '准出条件文字' * (1 + i % 3), 'tag': '30%' if i in (0, 8) else None} for i, b in enumerate('①②③④⑤⑥⑦⑧⑨⑩⑪⑫')]}
for ph_ in qms['phases']:
    if ph_['tag'] is None:
        del ph_['tag']
cq = get_template('phases').render(qms)
hs = {round(n['h'], 1) for n in cq.nodes}
ws = {round(n['w'], 1) for n in cq.nodes}
check('phases frame 三行阶梯：12 张卡片等宽等高、3 个分组容器、自检 0 问题', len(cq.nodes) == 12 and len(hs) == 1 and len(ws) == 1 and len(cq.frames) == 3 and cq.check() == [], (hs, ws, cq.check()))
check('phases frame：行尾 → 下一行行首连线终点在首卡左边中点', all(any(abs(ax - n['x']) < 1.5 and abs(ay - n['y'] - n['h'] / 2) < 1 for n in cq.nodes) for ax, ay, e in cq.arrows if str(e).startswith('row')), cq.arrows)
check('phases frame：分组标题左对齐（x 与卡片左缘相差 ≤ 12）', all(abs(t['x'] - cq.nodes[0]['x']) <= 12.5 for t in cq.texts if t['size'] == k.FPX['group_title']))
d = json.load(open(os.path.join(EX, 'layered-arch.fig.json'), encoding='utf-8'))
d['display'] = {'width_ratio': 0.6}
c = get_template('layered-arch').render(d)
check('display.width_ratio 0.6 → 画布 720 宽、17px 等效 ≥ 7pt、自检通过', c.w == 720 and lint.font_issue(lint.font_stats(c.svg()), 0.6)[1] is None and c.check() == [], (c.w, c.check()))
check('兼容草案：tech-spec 草案 layered-arch（"kind" 字段、无 frame / role）可渲染且自检通过',
      get_template('layered-arch').render(json.load(open(os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/staging/types/tech-spec/templates/figures/target-arch.fig.json')))).check() == []
      if os.path.exists(os.path.expanduser('~/workspace/docs/doc-skill-platform-2026-09-15/staging/types/tech-spec/templates/figures/target-arch.fig.json')) else True)

# ---------------------------------------------------------------- 5. build 集成
print('5. build 集成（Chrome + Mermaid + Graphviz + whiteboard-cli）')
# mermaid.min.js 不随 skill 分发：测试一律走 DOC_FIGURES_MERMAID_JS 覆盖指向本地文件，绝不在测试里发网络请求。
# 没给覆盖就用本机缓存；缓存也没有时路径不存在 → build 报 render_error，相关断言转 SKIP（提示先跑 mermaid.py --ensure-js）。
MERMAID_JS = os.path.abspath(os.path.expanduser(os.environ.get('DOC_FIGURES_MERMAID_JS') or mermaid.cached_mermaid_js()))
os.environ['DOC_FIGURES_MERMAID_JS'] = MERMAID_JS
HAS_MJS = os.path.exists(MERMAID_JS)
NO_MJS = f'本机没有 mermaid.min.js（{MERMAID_JS}）：先运行 python3 {os.path.join(SCRIPTS, "mermaid.py")} --ensure-js（需联网一次）'


def mcheck(name, *a, **kw):
    """依赖 Mermaid 实渲的断言：没有本地 mermaid.min.js 就 SKIP，绝不为了跑测试去联网。"""
    return check(name, *a, **kw) if HAS_MJS else skip(name, NO_MJS)

run = os.path.join(BASE, 'run')
fig = os.path.join(run, 'figures')
os.makedirs(fig)
MMD = {
    'flow': 'flowchart LR\n  A[提交] --> B{校验通过?}\n  B -- 是 --> C[入库]\n  B -- 否 --> D[退回]\n',
    'seq': 'sequenceDiagram\n  participant C as 客户端\n  participant S as 服务\n  C->>S: 请求（含幂等键）\n  S-->>C: 响应\n',
    'state': 'stateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 处理中: 领取\n  处理中 --> 已完成: 成功\n  已完成 --> [*]\n',
    'er': 'erDiagram\n  ACCOUNT ||--o{ LEDGER : "产生"\n  ACCOUNT {\n    string id PK\n  }\n  LEDGER {\n    string id PK\n    string account_id FK\n  }\n',
    'gantt': 'gantt\n  title 排期\n  dateFormat YYYY-MM-DD\n  section 设计\n  评审 :a1, 2026-09-01, 10d\n  section 实现\n  开发 :a2, after a1, 30d\n',
    'gantt-dense': 'gantt\n  title 年度计划\n  dateFormat YYYY-MM-DD\n  section 全年\n  阶段一 :a1, 2026-01-01, 120d\n  阶段二 :a2, after a1, 120d\n  阶段三 :a3, after a2, 120d\n',
    'xy': 'xychart-beta\n  title "缺陷趋势"\n  x-axis [第1周, 第2周, 第3周]\n  y-axis "缺陷数" 0 --> 20\n  bar [12, 8, 3]\n  line [12, 20, 20]\n',
    'seq-long': 'sequenceDiagram\n  participant A as 会员 App\n  participant R as 兑换服务\n  participant D as 积分数据库（行锁）\n  A->>R: 发起兑换请求（含幂等键）\n  R->>D: 开启事务，SELECT ... FOR UPDATE 锁定账户与库存行\n  alt 积分与库存均充足且不违反叠加限制并且规则快照仍然有效\n    D-->>R: 锁定成功\n  else 积分不足\n    R-->>A: 错误码 INSUFFICIENT_BALANCE\n  end\n',
    'init-quoted': "%%{init: {'themeVariables': {'mainBkg': '#FF0000', 'fontFamily': '\"PingFang SC\", sans-serif'}}}%%\nflowchart LR\n  A[甲] --> B[乙]\n",
}
for n, src in MMD.items():
    open(os.path.join(fig, n + '.mmd'), 'w').write(src)
shutil.copy(os.path.join(EX, 'deps.dot'), fig)
for name in NAMES:
    shutil.copy(os.path.join(EX, f'{name}.fig.json'), fig)
open(os.path.join(fig, 'bad-asset.svg'), 'w').write(bad_cases['BL1_forbidden'].replace('viewBox="0 0 10 10"', 'viewBox="0 0 1200 100"') + '\n')
open(os.path.join(fig, 'tiny-font.svg'), 'w').write(small)
open(os.path.join(fig, 'review.json'), 'w').write(json.dumps({'figures': [{'file': 'figures/flow.svg', 'machine': {}, 'human': {'checked_at': '2026-09-15', 'checked_by': 'Claude', 'issues': '无'}}]}))
args = [sys.executable, os.path.join(SCRIPTS, 'build.py'), run, '--jobs', '6'] + ([] if WB else ['--no-wb'])
p = subprocess.run(args, capture_output=True, text=True, timeout=900)
rv = json.load(open(os.path.join(fig, 'review.json'))) if os.path.exists(os.path.join(fig, 'review.json')) else {'figures': []}
by = {os.path.basename(f['file']).rsplit('.', 1)[0]: f for f in rv['figures']}
check('build 退出码 1（坏成品与小字号 SVG 必改）', p.returncode == 1, p.stdout[-800:] + p.stderr[-400:])
for n in ('flow', 'seq', 'state', 'er', 'gantt', 'xy'):
    f = by.get(n, {})
    m = f.get('machine', {})
    mcheck(f'Mermaid {n}：渲染成功、foreignObject 0、最小字号 ≥ 7pt、PNG 产出、飞书端 type=mermaid',
          (m.get('ok') or (n == 'xy' and not any(i['rule'] == 'render_error' for i in m.get('issues', [])))) and (m.get('mermaid') or {}).get('foreign_objects') == 0 and (m.get('min_font_pt') or 0) >= 7
          and os.path.exists(os.path.join(run, f.get('png') or 'x')) and (f.get('feishu') or {}).get('type') == 'mermaid', json.dumps(f, ensure_ascii=False)[:700])
sl = by.get('seq-long', {})
slsvg = open(os.path.join(fig, 'seq-long.svg')).read() if os.path.exists(os.path.join(fig, 'seq-long.svg')) else ''
mcheck('时序图长条件：预处理按标点断行（resolved 源含 <br/>）、渲染无自动连字符', os.path.exists(os.path.join(fig, 'seq-long.resolved.mmd'))
      and '<br/>' in open(os.path.join(fig, 'seq-long.resolved.mmd')).read() and not (sl.get('machine', {}).get('mermaid') or {}).get('hyphenated'),
      sl.get('machine', {}).get('mermaid'))
mcheck('时序图：消息文字与分支条件后有衬底矩形（生命线不穿字），衬底高度 ≥ 2、画板 lint 无 filter / clipPath',
      slsvg.count('doc-figures-text-bg') >= 4 and not any(i['rule'] in ('BL2_filter', 'BL1_forbidden', 'BL3_thin_rect') for i in lint.board_lint(slsvg)), slsvg.count('doc-figures-text-bg'))
g = by.get('gantt', {}).get('machine', {}).get('gantt') or {}
mcheck('甘特：刻度实测 0 重叠', g.get('tick_overlaps') == 0, g)
gd = by.get('gantt-dense', {}).get('machine', {}).get('gantt') or {}
mcheck('甘特（全年 3 段）：默认 1week 刻度重叠 → 自动放大间隔后 0 重叠，resolved 源写入 tickInterval',
      gd.get('tick_overlaps') == 0 and len(gd.get('attempts', [])) > 1 and (gd['attempts'][0].get('tick_overlaps') or 0) > 0
      and os.path.exists(os.path.join(fig, 'gantt-dense.resolved.mmd')) and 'tickInterval ' + str(gd.get('tick_interval')) in open(os.path.join(fig, 'gantt-dense.resolved.mmd')).read(), gd)
mcheck('xychart：未加引号中文分类 → 自动加引号后渲染成功，飞书端改用 .resolved.mmd',
      by.get('xy', {}).get('feishu', {}).get('path') == 'figures/xy.resolved.mmd' and by['xy']['machine'].get('ok') is False
      and 'mmd_xychart_quote' in rules(by['xy']['machine']['issues']) and os.path.exists(os.path.join(fig, 'xy.svg')))
isvg = open(os.path.join(fig, 'init-quoted.svg')).read() if os.path.exists(os.path.join(fig, 'init-quoted.svg')) else ''
mcheck('init fontFamily 带引号：预处理后 init 生效（Chrome 实测节点填充为 init 指定的红色）', 'rgb(255, 0, 0)' in isvg)
mcheck('Mermaid SVG：style 元素已内联去除、无 foreignObject、id 已加 fig-<名>- 前缀',
      '<style' not in isvg and 'foreignObject' not in isvg and re.search(r'id="fig-init-quoted-', isvg))
f = by.get('deps', {})
check('Graphviz：渲染、字号还原为 17px、Chrome 实测节点文字不越界、飞书 type=svg、画板 lint 0',
      f.get('machine', {}).get('min_font_px') == 17 and f['machine'].get('ok') and f['feishu']['type'] == 'svg' and f['machine']['board_lint'] == []
      and f['machine']['render_check']['text_overflow'] == [], json.dumps(f, ensure_ascii=False)[:600])
for name in NAMES:
    m = by.get(name, {}).get('machine', {})
    check(f'模板 {name}：build 无必改、Chrome 实测无越界 / 重叠、画板 lint 0', m.get('ok') and m.get('board_lint') == [] and not (m.get('render_check') or {}).get('text_overflow'),
          [i['message'] for i in m.get('issues', [])])
diag = []
for name in NAMES:
    svgp = os.path.join(fig, f'{name}.svg')
    if os.path.exists(svgp):
        for pts in re.findall(r'<polyline points="([^"]+)"', open(svgp).read()):
            ps = [tuple(map(float, q.split(','))) for q in pts.split()]
            diag += [name for a, b in zip(ps, ps[1:]) if abs(a[0] - b[0]) > 0.01 and abs(a[1] - b[1]) > 0.01]
check('所有模板连线都是正交折线（无斜线段）', not diag, sorted(set(diag)))
check('坏成品 SVG：clipPath → 画板 lint 必改', 'BL1_forbidden' in rules(by.get('bad-asset', {}).get('machine', {}).get('issues', [])))
check('小字号 SVG：LY4 必改', 'LY4_font' in rules(by.get('tiny-font', {}).get('machine', {}).get('issues', [])))
check('review.json：已有 human 结论保留，新图 human 留空待填',
      by.get('flow', {}).get('human', {}).get('issues') == '无' and by.get('seq', {}).get('human') == {'checked_at': '', 'checked_by': '', 'issues': ''})
check('review.json：machine 含 min_font_pt / viewbox_width / suggested_width_ratio / whiteboard_check',
      all(key in by['seq']['machine'] for key in ('min_font_pt', 'viewbox_width', 'suggested_width_ratio', 'whiteboard_check', 'board_lint', 'must_fix')))
if WB:
    wbs = [f['machine'].get('whiteboard_check') or {} for f in rv['figures']]
    if all(w.get('skipped') for w in wbs):
        skip('whiteboard-cli', wbs[0].get('skipped'))
    else:
        check('whiteboard-cli：模板与 Graphviz 图 0 error', all(not (by[n]['machine'].get('whiteboard_check') or {}).get('errors') for n in list(NAMES) + ['deps']),
              {n: by[n]['machine'].get('whiteboard_check') for n in list(NAMES) + ['deps']})
        check('flow 宽高比检查已执行（flowchart 默认按流程类）', 'aspect_ratio' in by['flow']['machine'])
else:
    skip('whiteboard-cli', '--no-wb')

# ---------------------------------------------------------------- 6. architecture.svg 复刻
print('6. architecture.svg 复刻对照')
if arch:
    rrun = os.path.join(BASE, 'replica')
    os.makedirs(os.path.join(rrun, 'figures'))
    shutil.copy(os.path.join(ROOT, 'tests', 'fixtures', 'architecture-replica.fig.json'), os.path.join(rrun, 'figures'))
    p = subprocess.run([sys.executable, os.path.join(SCRIPTS, 'build.py'), rrun] + ([] if WB else ['--no-wb']), capture_output=True, text=True, timeout=600)
    rj = json.load(open(os.path.join(rrun, 'figures', 'review.json')))['figures'][0]
    m = rj['machine']
    check('复刻图：build 无必改（自检、Chrome 实测、画板 lint、whiteboard-cli）', p.returncode == 0 and m['ok'], p.stdout[-600:])
    check('复刻图：最小字号 17px、等效 7.31pt（与原图一致）', m['min_font_px'] == 17 and m['min_font_pt'] == 7.31, (m['min_font_px'], m['min_font_pt']))
    rsvg = open(os.path.join(rrun, 'figures', 'architecture-replica.svg')).read()
    texts = lambda s: [re.sub(r'\s+', '', t) for t in re.findall(r'<text[^>]*>([^<]+)</text>', s)]
    orig_t, rep_t = set(texts(arch)), texts(rsvg)
    rep_stream = ''.join(rep_t)  # 文档顺序拼接：复刻图里被换成两行的文字也能匹配
    missing = [t for t in orig_t if t not in rep_stream]
    check('复刻图：原图全部文字都出现在复刻图中', not missing, missing)
    cnt = lambda s: len([r for r in re.findall(r'<rect\b[^>]*>', s) if 'stroke=' in r or 'width="1200"' in r])  # 不计连线标签衬底（无描边）
    check('复刻图：卡片与分组数量一致（原图 rect 数 = 复刻图 rect 数，不计标签衬底）', cnt(arch) == cnt(rsvg), (cnt(arch), cnt(rsvg)))
    side = os.path.join(BASE, 'architecture-replica-compare.png')
    orig_png = os.path.join(BASE, 'orig.png')
    job = os.path.join(BASE, 'orig-job.json')
    json.dump({'mermaid_js': '', 'tasks': [{'kind': 'screenshot', 'id': 'o', 'svg_path': ARCH, 'png_path': orig_png, 'scale': 2}]}, open(job, 'w'))
    subprocess.run(['node', os.path.join(SCRIPTS, 'chrome.mjs'), job, os.path.join(BASE, 'orig-res.json')], capture_output=True, timeout=300)
    if shutil.which('magick') and os.path.exists(orig_png):
        subprocess.run(['magick', orig_png, os.path.join(rrun, 'figures', 'architecture-replica.png'), '-background', 'white', '-gravity', 'north', '-splice', '40x0', '+append', side], capture_output=True)
        check(f'并排对照 PNG 已导出（{side}）', os.path.exists(side) and os.path.getsize(side) > 50000)
    else:
        skip('并排对照 PNG', 'magick 或原图截图不可用')
else:
    skip('architecture.svg 复刻', '原图不存在')

# ---------------------------------------------------------------- 7. 业务词守卫
print('7. 引擎业务词守卫')
WORDS = ['报价', '确认单', '毛利', '底价', '人天', '售前', 'presales', 'pricing', '用例', 'reddit', '建站']
hits = []
for dp, _, fns in os.walk(SCRIPTS):
    if '__pycache__' in dp:
        continue
    for fn in fns:
        if fn.endswith(('.py', '.mjs', '.js', '.json')) and fn != 'font_metrics.json':
            for i, line in enumerate(open(os.path.join(dp, fn), encoding='utf-8'), 1):
                for w in WORDS:
                    if w.lower() in line.lower():
                        hits.append(f'{fn}:{i}「{w}」')
check('scripts/ 不出现业务词', not hits, hits[:10])

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}" + (f'（SKIP {len(skips)}）' if skips else '') + f'（临时目录：{BASE}）')
if '--keep' not in sys.argv and not fails:
    shutil.rmtree(BASE, ignore_errors=True)
sys.exit(1 if fails else 0)
