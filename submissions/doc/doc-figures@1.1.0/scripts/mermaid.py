"""Mermaid：品牌主题配置、源码预处理（修复与补全）、源码检查、阶梯式流程生成器。

- theme_config()：doc-shared 生成的 mermaid-theme.json + 本引擎的字号与图类型补丁（themeCSS 把 CSS 类设的小字号抬到最小字号）。
- preprocess(src)：返回 (新源码, 改动说明[])。init 指令里 fontFamily 去引号；xychart 轴分类自动加引号；gantt 补 todayMarker off；
  `%% doc-figures: stairs rows=2` 指令把线性 flowchart 改写成阶梯式。改动后的源码写 figures/<名>.resolved.mmd，飞书端用它。
- mermaid_js()：返回 mermaid.min.js 路径。首次联网按 vendor/VERSIONS.md 的地址拉取并校验 sha256，缓存到 ~/.cache/doc-figures 后离线复用；
  DOC_FIGURES_MERMAID_JS 可直接指向本地文件（测试夹具 / 离线环境），DOC_FIGURES_CACHE_DIR 可改缓存目录。
- lint_source(src)：源码问题（必改 / 建议 / 提示）。
- stairs_mmd(spec)：phases 形式的 spec → 阶梯式 flowchart 源码（外层 TB + 每行一个 direction LR 子图，子图之间行尾连行首）。
"""
import copy
import hashlib
import io
import json
import math
import os
import re
import sys
import tarfile
import tempfile

import svgkit as k

THEME_PATH = os.path.join(k.SHARED, 'brand', 'generated', 'mermaid-theme.json')

# mermaid.min.js 不再随 skill 分发（3.4 MB）：首次使用时按 vendor/VERSIONS.md 登记的地址拉取、校验 sha256、缓存到本机后离线复用。
MERMAID_VERSION = '11.17.2'
MERMAID_TARBALL_URL = 'https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz'
MERMAID_TARBALL_SHA256 = '6ad2f42c3fc26bbf9e45cbb6d11898972573ea52b33a5f4ff51952899f950ffd'
MERMAID_JS_MEMBER = 'package/dist/mermaid.min.js'
MERMAID_JS_SHA256 = '581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8'
MERMAID_JS_BYTES = 3572661
MERMAID_LICENSE_MEMBER = 'package/LICENSE'


def cache_dir():
    """mermaid.min.js 的本机缓存目录。DOC_FIGURES_CACHE_DIR 可整体改写；否则 ${XDG_CACHE_HOME:-~/.cache}/doc-figures。"""
    d = os.environ.get('DOC_FIGURES_CACHE_DIR')
    if d:
        return os.path.expanduser(d)
    base = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
    return os.path.join(base, 'doc-figures')


def cached_mermaid_js():
    return os.path.join(cache_dir(), f'mermaid-{MERMAID_VERSION}', 'mermaid.min.js')


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _member_bytes(tar, name, want_sha=None, want_bytes=None):
    info = tar.getmember(name)
    if not info.isfile():
        raise RuntimeError(f'mermaid tarball 成员 {name} 不是普通文件（{info.type!r}），拒绝解包')
    data = tar.extractfile(info).read()
    if want_bytes and len(data) != want_bytes:
        raise RuntimeError(f'mermaid tarball 里 {name} 字节数不符：期望 {want_bytes}，实得 {len(data)}')
    got = hashlib.sha256(data).hexdigest()
    if want_sha and got != want_sha:
        raise RuntimeError(f'mermaid tarball 里 {name} 的 sha256 不符：期望 {want_sha}，实得 {got}')
    return data


def _atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.tmp-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)  # 原子替换：并行进程同时拉取也不会读到半个文件
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def fetch_mermaid_js(dest=None):
    """按 vendor/VERSIONS.md 登记的 tarball 地址联网拉取，双重校验 sha256（tarball + 单文件），写入缓存。返回路径。"""
    import urllib.request
    dest = dest or cached_mermaid_js()
    try:
        with urllib.request.urlopen(MERMAID_TARBALL_URL, timeout=120) as r:
            blob = r.read()
    except Exception as e:
        raise RuntimeError(f'拉取 mermaid {MERMAID_VERSION} 失败（{type(e).__name__}: {e}）；'
                           f'可手动下载 {MERMAID_TARBALL_URL}，取出 {MERMAID_JS_MEMBER} 放到 {dest}，'
                           f'或用 DOC_FIGURES_MERMAID_JS 指向本地文件')
    got = hashlib.sha256(blob).hexdigest()
    if got != MERMAID_TARBALL_SHA256:
        raise RuntimeError(f'mermaid tarball sha256 不符：期望 {MERMAID_TARBALL_SHA256}，实得 {got}')
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as tar:  # 只按名取两个已知成员，不做 extractall
        js = _member_bytes(tar, MERMAID_JS_MEMBER, MERMAID_JS_SHA256, MERMAID_JS_BYTES)
        try:
            lic = _member_bytes(tar, MERMAID_LICENSE_MEMBER)
        except KeyError:
            lic = None
    _atomic_write(dest, js)
    if lic:
        _atomic_write(os.path.join(os.path.dirname(dest), 'LICENSE'), lic)
    return dest


def mermaid_js(allow_download=True):
    """返回可用的 mermaid.min.js 绝对路径。
    ① DOC_FIGURES_MERMAID_JS 指定的本地文件（显式覆盖 / 测试夹具，不校验 sha256）；
    ② 缓存文件存在且 sha256 匹配 → 直接用（离线）；
    ③ 否则联网拉取一次并缓存。"""
    ov = os.environ.get('DOC_FIGURES_MERMAID_JS')
    if ov:
        ov = os.path.abspath(os.path.expanduser(ov))
        if not os.path.exists(ov):
            raise RuntimeError(f'DOC_FIGURES_MERMAID_JS 指向的文件不存在：{ov}')
        return ov
    p = cached_mermaid_js()
    if os.path.exists(p) and _sha256(p) == MERMAID_JS_SHA256:
        return p
    if not allow_download:
        raise RuntimeError(f'本机缓存里没有 mermaid {MERMAID_VERSION}（{p}）：先运行 '
                           f'`python3 {os.path.join(k.HERE, "mermaid.py")} --ensure-js` 联网拉取一次')
    return fetch_mermaid_js(p)


LABEL_WRAP_PX = 180  # 阶梯式节点每行文字宽（约 10 个汉字），控制整图宽度（四列时 viewBox 约 1150 宽）
GANTT_INTERVALS = ['1day', '2day', '1week', '2week', '1month', '3month', '6month']

INIT_RE = re.compile(r'%%\{\s*(?:init|initialize)\s*:\s*(.*?)\}%%', re.S)
FONT_RE = re.compile(r'''(["']?fontFamily["']?\s*:\s*)(["'])(.*?)(?<!\\)\2''', re.S)


def diagram_kind(src):
    body = INIT_RE.sub('', src)
    for line in body.splitlines():
        t = line.strip()
        if not t or t.startswith('%%') or t.startswith('---'):
            continue
        w = re.split(r'[\s:;]', t, 1)[0]
        return {'graph': 'flowchart', 'flowchart-elk': 'flowchart', 'stateDiagram-v2': 'stateDiagram', 'xychart': 'xychart-beta'}.get(w, w)
    return ''


def theme_config():
    T = json.load(open(THEME_PATH, encoding='utf-8'))
    cfg = {kk: v for kk, v in T.items() if not kk.startswith('_')}
    fam = strip_font_quotes(cfg['themeVariables'].get('fontFamily', ''))
    cfg['themeVariables']['fontFamily'] = fam
    body = k.FPX['node_body']
    title = k.FPX['node_title_emphasis']
    P = k.PALETTE
    cfg['sequence'] = dict(cfg.get('sequence', {}), actorFontSize=body, messageFontSize=body, noteFontSize=body, wrap=False,
                           actorFontFamily=fam, messageFontFamily=fam, noteFontFamily=fam, boxTextMargin=6, noteMargin=12)
    cfg['gantt'] = dict(cfg.get('gantt', {}), todayMarker='off', barHeight=30, barGap=8, topPadding=64, leftPadding=140,
                        gridLineStartPadding=44, fontSize=body, sectionFontSize=body, numberSectionStyles=2)
    cfg['er'] = dict(cfg.get('er', {}), fontSize=body)
    cfg['state'] = dict(cfg.get('state', {}), htmlLabels=False)
    cfg['class'] = dict(cfg.get('class', {}), htmlLabels=False)
    cfg['quadrantChart'] = {'chartWidth': 900, 'chartHeight': 700, 'titleFontSize': title, 'quadrantLabelFontSize': k.FPX['group_title'],
                            'pointLabelFontSize': body, 'xAxisLabelFontSize': body, 'yAxisLabelFontSize': body, 'pointRadius': 7}
    cfg['xyChart'] = {'width': 1100, 'height': 560, 'titleFontSize': title,
                      'xAxis': {'labelFontSize': body, 'titleFontSize': body}, 'yAxis': {'labelFontSize': body, 'titleFontSize': body}}
    tv = cfg['themeVariables']
    tv.update({
        'quadrant1Fill': P['purple']['fill'], 'quadrant2Fill': P['gray']['fill'], 'quadrant3Fill': '#FFFFFF', 'quadrant4Fill': P['blue']['fill'],
        'quadrant1TextFill': k.TEXT['title'], 'quadrant2TextFill': k.TEXT['title'], 'quadrant3TextFill': k.TEXT['title'], 'quadrant4TextFill': k.TEXT['title'],
        'quadrantPointFill': P['purple']['stroke'], 'quadrantPointTextFill': k.TEXT['title'], 'quadrantXAxisTextFill': k.TEXT['body'],
        'quadrantYAxisTextFill': k.TEXT['body'], 'quadrantInternalBorderStrokeFill': P['gray']['stroke'], 'quadrantExternalBorderStrokeFill': P['purple']['stroke'],
        'quadrantTitleFill': k.TEXT['title'],
        'xyChart': {'backgroundColor': '#FFFFFF', 'titleColor': k.TEXT['title'], 'xAxisLabelColor': k.TEXT['body'], 'xAxisTitleColor': k.TEXT['body'],
                    'xAxisLineColor': P['gray']['stroke'], 'xAxisTickColor': P['gray']['stroke'], 'yAxisLabelColor': k.TEXT['body'],
                    'yAxisTitleColor': k.TEXT['body'], 'yAxisLineColor': P['gray']['stroke'], 'yAxisTickColor': P['gray']['stroke'],
                    'plotColorPalette': ', '.join([P['purple']['stroke'], P['orange']['stroke'], P['green']['stroke'], P['blue']['stroke']])},
    })
    # Mermaid 部分图类型的字号由 CSS 类决定（配置里的 fontSize 不生效）：用 themeCSS 抬到最小字号。实测来源见 SKILL.md。
    cfg['themeCSS'] = (
        f'.tick text{{font-size:{body}px !important;}}'
        f'.messageText,.noteText,.loopText,.loopText>tspan,.labelText,.labelText>tspan,.sectionTitle,text.actor>tspan,text.actor{{font-size:{body}px !important;}}'
        f'.er.relationshipLabel,.relationshipLabel,.relationshipLabel tspan,.er.entityLabel,.er.attributeBoxOdd,.er.attributeBoxEven,g.label text,g.label tspan,.row-rect-odd+text,.row-rect-even+text,.label text,.label tspan{{font-size:{body}px !important;}}'
        f'.edgeLabel rect.background,.labelBkg{{opacity:1 !important;fill:#FFFFFF !important;}}'
        f'.grid .tick line{{stroke:{k.FIG["group"]["stroke"]} !important;}}.grid path{{stroke-width:0 !important;}}'
        f'.legend text{{font-size:{body}px !important;fill:{k.TEXT["body"]} !important;}}'
    )
    return cfg


def strip_font_quotes(v):
    return re.sub(r'\s*,\s*', ', ', v.replace('\\"', '').replace('"', '').replace("'", '')).strip()


def init_font_quoted(src):
    """init 指令里 fontFamily 的值带引号（会让整条 init 失效）。返回有问题的原值列表。"""
    bad = []
    for m in INIT_RE.finditer(src):
        for f in FONT_RE.finditer(m.group(1)):
            val = f.group(3)
            if '"' in val or "'" in val or '\\"' in val:
                bad.append(val)
    return bad


def _fix_init(src):
    def fix_init(m):
        def fix_font(f):
            return f.group(1) + f.group(2) + strip_font_quotes(f.group(3)) + f.group(2)
        return m.group(0).replace(m.group(1), FONT_RE.sub(fix_font, m.group(1)))
    return INIT_RE.sub(fix_init, src)


XY_AXIS_RE = re.compile(r'^(\s*x-axis\s*(?:"[^"]*"\s*)?)\[(.*)\]\s*$', re.M)


def _xy_quote(src):
    changed = False

    def rep(m):
        nonlocal changed
        items = [x.strip() for x in re.findall(r'\s*"[^"]*"|[^,]+', m.group(2)) if x.strip()]
        out = []
        for x in items:
            if x and not (x.startswith('"') and x.endswith('"')) and re.search(r'[^\x00-\x7f]|\s', x):
                out.append(f'"{x}"')
                changed = True
            else:
                out.append(x)
        return m.group(1) + '[' + ', '.join(out) + ']'

    return XY_AXIS_RE.sub(rep, src), changed


QUAD_AXIS_RE = re.compile(r'^(\s*[xy]-axis\s+)(.+?)(?:\s*-->\s*(.+?))?\s*$', re.M)
QUAD_POINT_RE = re.compile(r'^(\s*)(?!x-axis|y-axis|quadrant-|title|classDef|style)([^"\n:%]+?)\s*:(\s*\[[^\]]*\].*)$', re.M)
QUAD_LABEL_RE = re.compile(r'^(\s*(?:quadrant-[1-4])\s+)(.+?)\s*$', re.M)  # title 不加引号：Mermaid 会把引号原样画出来


def _q(t):
    t = t.strip()
    if not t or (t.startswith('"') and t.endswith('"')) or not re.search(r'[^\x00-\x7f]', t):
        return t, False
    return '"' + t.replace('"', "'") + '"', True


def _quadrant_quote(src):
    changed = False

    def axis(mm):
        nonlocal changed
        a, c1 = _q(mm.group(2))
        if mm.group(3):
            b, c2 = _q(mm.group(3))
            changed = changed or c1 or c2
            return f'{mm.group(1)}{a} --> {b}'
        changed = changed or c1
        return f'{mm.group(1)}{a}'

    def label(mm):
        nonlocal changed
        a, c1 = _q(mm.group(2))
        changed = changed or c1
        return mm.group(1) + a

    def point(mm):
        nonlocal changed
        a, c1 = _q(mm.group(2))
        changed = changed or c1
        return f'{mm.group(1)}{a}:{mm.group(3)}'

    out = QUAD_AXIS_RE.sub(axis, src)
    out = QUAD_LABEL_RE.sub(label, out)
    out = QUAD_POINT_RE.sub(point, out)
    return out, changed


STAIRS_RE = re.compile(r'^\s*%%\s*doc-figures:\s*stairs(?:\s+rows=(\d+))?\s*$', re.M)
NODE_RE = re.compile(r'([A-Za-z_][\w-]*)\s*(\[\[.*?\]\]|\[\(.*?\)\]|\(\[.*?\]\)|\[.*?\]|\(\(.*?\)\)|\(.*?\)|\{.*?\}|>.*?\])?')
EDGE_RE = re.compile(r'\s*(-->|---|==>|-\.->)\s*(?:\|([^|]*)\|)?\s*')


def _parse_linear(src):
    """解析简单 flowchart：每行 `A[标签] --> B[标签] --> C`（可带 |标签|）。返回 (nodes 顺序, 定义, 边列表) 或 None。"""
    defs, edges, order = {}, [], []
    for line in src.splitlines():
        t = line.strip()
        if not t or t.startswith('%%') or re.match(r'^(flowchart|graph)\b', t):
            continue
        if re.match(r'^(subgraph|end|direction|style|classDef|class|linkStyle|click)\b', t):
            return None
        parts = EDGE_RE.split(t)
        # parts = [node, arrow, label, node, arrow, label, node ...]
        prev = None
        i = 0
        while i < len(parts):
            m = NODE_RE.fullmatch(parts[i].strip())
            if not m:
                return None
            nid, shape = m.group(1), m.group(2)
            if shape:
                defs[nid] = shape
            if nid not in order:
                order.append(nid)
            if prev is not None:
                edges.append((prev, nid, parts[i - 1] or '', parts[i - 2]))
            prev = nid
            i += 3
    return order, defs, edges


def stairs_rewrite(src, rows=None):
    """把线性 flowchart 改写成阶梯式。非线性（有分叉）时返回 (None, 原因)。"""
    parsed = _parse_linear(src)
    if not parsed:
        return None, '含 subgraph / style 等语句或无法解析，未改写'
    order, defs, edges = parsed
    succ = {}
    back = []
    pos = {n: i for i, n in enumerate(order)}
    for a, b, label, arrow in edges:
        if pos[b] <= pos[a]:
            back.append((a, b, label, arrow))
            continue
        if a in succ:
            return None, f'节点 {a} 有多个后继，不是线性流程，未改写'
        succ[a] = (b, label, arrow)
    chain = [order[0]]
    while chain[-1] in succ:
        chain.append(succ[chain[-1]][0])
    if len(chain) != len(order):
        return None, '不是单一线性链，未改写'
    spec = {'phases': [{'id': n, 'shape': defs.get(n)} for n in chain], 'rows': rows or 'auto',
            'loops': [{'from': a, 'to': b, 'label': label} for a, b, label, _ in back],
            '_edge_labels': {a: succ[a][1] for a in succ if succ[a][1]}}
    try:
        body = stairs_mmd(spec)
    except k.SpecError as e:
        return None, str(e)
    # 保留原有的 init 指令（curve、theme 等配置）
    inits = [mm.group(0) for mm in INIT_RE.finditer(src)]
    return ('\n'.join(inits) + '\n' if inits else '') + body, None


SEQ_BLOCK_RE = re.compile(r'^(\s*(?:alt|else|opt|loop|par|and|critical|break|rect)\s+)(.+?)\s*$', re.M)
SEQ_MSG_RE = re.compile(r'^(\s*[^:%\n]+?(?:->>|-->>|->|-->|-x|--x|-\)|--\))[+-]?\s*[^:\n]+?:\s*)(.+?)\s*$', re.M)
SEQ_MSG_WRAP_PX = 420  # 消息文字：只有很长时才预断行（Mermaid 按参与者间距排消息，一般放得下）
SEQ_WRAP_PX = 220  # 实测：alt 条件约 16 个汉字（272px）时 Mermaid 已按框宽自动连字符断行


def _seq_break(src):
    """时序图：分支条件与消息文字宽于 SEQ_WRAP_PX 时，用 svgkit 断行算法预先插入 <br/>（在标点、空格处优先断）。"""
    changed = False

    def rep(mm):
        nonlocal changed
        text = mm.group(2)
        limit = SEQ_WRAP_PX if mm.re is SEQ_BLOCK_RE else SEQ_MSG_WRAP_PX
        if '<br' in text or k.text_width(text, k.FPX['node_body']) <= limit:
            return mm.group(0)
        lines = k.wrap(text, k.FPX['node_body'], limit)
        if len(lines) <= 1:
            return mm.group(0)
        changed = True
        return mm.group(1) + '<br/>'.join(lines)

    out = SEQ_BLOCK_RE.sub(rep, src)
    out = SEQ_MSG_RE.sub(rep, out)
    return out, changed


def _label(p, gate_label):
    if p.get('shape'):
        return None
    parts = [((p.get('badge') + ' ') if p.get('badge') else '') + p.get('name', p.get('id', ''))]
    act = p.get('meta') or ' · '.join(str(x) for x in (p.get('items') or [])[:1])
    if act:
        parts.append(act)
    if p.get('gate'):
        parts.append(f'{gate_label}：{p["gate"]}')
    lines = []
    for x in parts:
        lines += k.wrap(x, k.FPX['node_body'], LABEL_WRAP_PX)
    return '<br/>'.join(x.replace('"', '#quot;') for x in lines)


ROW_CLASS = ['purple', 'blue', 'green', 'orange']


def stairs_mmd(spec):
    """phases 形式 spec → 阶梯式 Mermaid 源码（飞书端可编辑版本）。
    外层 TB；每行一个 direction LR 子图（阶段容器，灰底细边）；节点圆角、按行着色；子图之间 `R1 --> R2`（行尾连行首）。
    Mermaid 的限制：子图内节点一旦直接连到子图外，子图 direction 会被忽略，所以行间连线只能画在子图之间；
    卡片无法强制等宽、容器标题居中不可改——PDF 端要达到品牌图质量时用 svgkit phases（row_style frame）。"""
    from templates._stairs import split_rows, check_loops
    phases = spec['phases']
    n = len(phases)
    rows = split_rows(n, spec.get('rows', 'auto'))
    ids = [p.get('id') or f'S{i + 1}' for i, p in enumerate(phases)]
    index = {v: i for i, v in enumerate(ids)}

    def resolve(v):
        if isinstance(v, int):
            return v
        if v in index:
            return index[v]
        raise k.SpecError(f'loops 引用了不存在的环节：{v!r}')

    loops = check_loops(rows, spec.get('loops'), resolve)
    gate_label = spec.get('gate_label', '准出')
    labels = spec.get('row_labels') or []
    edge_labels = spec.get('_edge_labels') or {}
    styled = not any(p.get('shape') for p in phases)
    out = ['flowchart TB']
    for ri, row in enumerate(rows):
        title = labels[ri] if ri < len(labels) else ' '
        out.append(f'    subgraph R{ri + 1}["{title}"]')
        out.append('        direction LR')
        for i in row:
            p = phases[i]
            out.append(f'        {ids[i]}{p["shape"]}' if p.get('shape') else f'        {ids[i]}("{_label(p, gate_label)}")')
        for a, b in zip(row, row[1:]):
            el = edge_labels.get(ids[a])
            out.append(f'        {ids[a]} -->|{el}| {ids[b]}' if el else f'        {ids[a]} --> {ids[b]}')
        for a, b, label in loops:
            if a in row:
                out.append(f'        {ids[a]} -.->|{label}| {ids[b]}' if label else f'        {ids[a]} -.-> {ids[b]}')
        out.append('    end')
    for ri in range(len(rows) - 1):
        out.append(f'    R{ri + 1} --> R{ri + 2}')
    group = k.FIG['group']
    for ri in range(len(rows)):
        out.append(f'    style R{ri + 1} fill:{group["fill"]},stroke:{group["stroke"]},stroke-width:1.5px')
    if styled:
        for ri, row in enumerate(rows):
            pal = k.PALETTE[ROW_CLASS[ri % 4] if len(rows) > 1 else 'purple']
            out.append(f'    classDef row{ri + 1} fill:{pal["fill"]},stroke:{pal["stroke"]},color:{k.TEXT["title"]},stroke-width:1.8px')
            out.append(f'    class {",".join(ids[i] for i in row)} row{ri + 1}')
    return '\n'.join(out) + '\n'


def preprocess(src):
    notes = []
    out = src
    if init_font_quoted(out):
        out = _fix_init(out)
        notes.append('init 指令里 fontFamily 的引号已去掉（带引号会让整条 init 失效）')
    kind = diagram_kind(out)
    if kind == 'xychart-beta':
        out, ch = _xy_quote(out)
        if ch:
            notes.append('xychart x-axis 分类含中文或空格，已自动加引号（不加会报 Lexical error）')
    if kind == 'gantt' and not re.search(r'^\s*todayMarker\b', out, re.M):
        out = re.sub(r'^(\s*gantt\s*)$', r'\1\n    todayMarker off', out, count=1, flags=re.M)
        notes.append('gantt 补 todayMarker off（配置项不生效，实测需写进源码）')
    if kind == 'quadrantChart':
        out, ch = _quadrant_quote(out)
        if ch:
            notes.append('quadrantChart 轴与象限文字含中文，已自动加引号（飞书画板解析器不认未加引号的中文，报 Lexical error）')
    if kind == 'sequenceDiagram':
        out, ch = _seq_break(out)
        if ch:
            notes.append('时序图过长的分支条件 / 消息文字已按标点预断行（<br/>），避免 Mermaid 自动连字符断词')
    m = STAIRS_RE.search(out)
    if m and kind == 'flowchart':
        new, why = stairs_rewrite(out, int(m.group(1)) if m.group(1) else None)
        if new:
            out = new
            notes.append('按 doc-figures: stairs 指令改写为阶梯式')
        else:
            notes.append('stairs 指令未生效：' + why)
    return out, notes


def lint_source(src):
    """源码层问题：[{rule, severity, message}]。"""
    issues = []
    for v in init_font_quoted(src):
        issues.append({'rule': 'mmd_init_font_quotes', 'severity': '必改', 'message': f'init 指令 fontFamily 带引号（{v}），会让整条 init 失效；build 已在 .resolved.mmd 去引号，请同步改源'})
    kind = diagram_kind(src)
    if kind == 'xychart-beta' and _xy_quote(src)[1]:
        issues.append({'rule': 'mmd_xychart_quote', 'severity': '必改', 'message': 'xychart x-axis 分类含中文或空格未加引号，Mermaid 11.17.2 报 Lexical error；build 已自动加引号，请同步改源'})
    if kind == 'xychart-beta':
        yr = re.search(r'^\s*y-axis\b.*?(-?[\d.]+)\s*-->\s*(-?[\d.]+)', src, re.M)
        if yr:
            lo, hi = float(yr.group(1)), float(yr.group(2))
            for mm in re.finditer(r'^\s*(bar|line)\b[^\[]*\[([^\]]*)\]', src, re.M):
                vals = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', mm.group(2))]
                bad = [v for v in vals if v > hi or v < lo]
                if bad:
                    issues.append({'rule': 'mmd_xychart_range', 'severity': '必改', 'message': f'xychart {mm.group(1)} 数据 {bad} 超出 y-axis 范围 {lo:g}–{hi:g}，折线或柱会画出坐标区'})
    if kind == 'quadrantChart' and _quadrant_quote(src)[1]:
        issues.append({'rule': 'mmd_quadrant_quote', 'severity': '必改', 'message': 'quadrantChart 轴 / 象限 / 点名含中文未加引号：Chrome 能渲染，但飞书画板解析器报 Lexical error；build 已在 .resolved.mmd 加引号，请同步改源'})
    if kind == 'flowchart' and not STAIRS_RE.search(src):
        parsed = _parse_linear(src)
        if parsed and len(parsed[0]) > 4:
            order, defs, edges = parsed
            fwd = [e for e in edges if order.index(e[1]) > order.index(e[0])]
            if len({a for a, *_ in fwd}) == len(fwd) and len(fwd) == len(order) - 1:
                issues.append({'rule': 'mmd_linear_long', 'severity': '建议', 'message': f'{len(order)} 个节点的线性流程：建议加 `%% doc-figures: stairs` 改两行阶梯式（宽高比更易落在 1:0.35–0.7）'})
    return issues


if __name__ == '__main__':
    if '--ensure-js' in sys.argv:
        try:
            print(mermaid_js())
        except RuntimeError as e:
            print(e, file=sys.stderr)
            sys.exit(2)
    elif '--cache-path' in sys.argv:
        print(cached_mermaid_js())
    else:
        print(__doc__.strip().splitlines()[0])
        print('用法：python3 mermaid.py --ensure-js | --cache-path')
        sys.exit(2)
