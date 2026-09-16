"""售前类型包（presales-site、presales-reddit）的专属质检规则（接口见 doc-shared/references/pack-interface.md「qa_rules.py 接口」）。

来源：~/.claude/skills/presales-qa/scripts/qa_checks.py（2026-09-15 版本）的售前专属规则，判据、定级、行号基准、消息文字逐条照搬，
保证 golden 逐项一致：A1 A2 A3 C2 C3 B1 F2 F4 R2 R3 L3 L5。引擎通用部分（L1 L2 L4 C1 R1）由 doc-qa 执行，本文件不重复。
两个包用同一份实现（旧脚本按 brief.json 的 line 字段分支，这里原样保留）；两个文件除 PACK_ID 一行外逐字一致，doc-qa/tests 校验。

输入对应（旧 → 新）：raw（proposal.md 原文）→ doc.raw；full / lines（include 展开后）→ doc.text / doc.lines；
root → ctx.run_dir；brief.json 仍按旧脚本直接读运行目录下的 brief.json（与 pack.json meta_file 无关，迁移期兼容）。
"""
import json, os, re
from decimal import Decimal, InvalidOperation

PACK_ID = 'presales-site'

# 引擎 L1 白名单外消息的兼容文案（doc-qa 的 MESSAGE_OVERRIDES 扩展）；{allow} 由引擎按 include_allow 填入
MESSAGE_OVERRIDES = {'L1.forbidden': 'include 目标不在白名单（只允许 {allow}，禁止内部成本文件与路径穿越）'}

STALE = [
    (r'Hydrogen[^。\n]{0,6}[（(]\s*Remix', 'Hydrogen 已迁到 React Router 7（2025.7.0 起），不再写基于 Remix', '建议'),
    (r'Multipass[^。\n]{0,20}(新版客户账户|customer accounts)', '官方说明 Multipass 不支持新版客户账户', '建议'),
]
LEAK = [(r'毛利率?', '毛利'), (r'成本价', '成本价'), (r'底价', '底价'), (r'渠道单价', '渠道单价'), (r'采购价', '采购价'), (r'让价空间', '让价空间'), (r'成本明细', '成本明细'),
        (r'AI\s?辅助', 'AI 辅助'), (r'Claude(?!Bot)', 'Claude'), (r'\bCodex\b', 'Codex'), (r'internal[-_]cost', 'internal-cost'),
        (r'direct_cost', 'direct_cost'), (r'\bmargin', 'margin'), (r'floor_usd', 'floor_usd'), (r'list_ge_floor', 'list_ge_floor')]
PROMISE = [r'零成本', r'找回\s*\d+\s*/\s*\d+', r'(提升|增长|提高|降低)\s*\d+(\.\d+)?\s*%', r'翻倍', r'显著提升', r'立竿见影']
NOT_FOR_SALE = ['点赞助推', '互动量保证', '批量私信', '虚假测评', '虚假身份', '诱导投票', '黑灰产外链']
THIRD_PARTY_AMOUNT = ('价格带', '客单', '订阅', '主题费', 'App ', '托管', 'CMS 月费')


def amount(s):
    try:
        return Decimal(s.replace(',', '')).normalize()
    except InvalidOperation:
        return None


def check(doc, ctx):
    root = ctx.run_dir
    raw, full = doc.raw, doc.text
    lines = full.split('\n')
    issues = []

    def add(rule, sev, line_no, text, msg):
        issues.append({'rule': rule, 'severity': sev, 'line': line_no, 'excerpt': str(text).strip()[:120], 'message': msg})

    bp = os.path.join(root, 'brief.json')
    brief = json.load(open(bp)) if os.path.exists(bp) else {}
    line_kind = brief.get('line')
    # L3 必备章节与 include；L5 公司介绍与联系人
    if line_kind in ('site', 'reddit'):
        incs = [m.strip() for m in re.findall(r'<!--\s*include:\s*([^>]+?)\s*-->', raw)]
        if not any(x.startswith('pricing/') for x in incs): add('L3', '必改', 0, '报价', '报价章节没有 include pricing/ 下的脚本产物')
        if 'terms.md' not in incs: add('L3', '必改', 0, '商务条款', '没有 include terms.md')
        if 'confirm-list.md' not in incs: add('L3', '必改', 0, '确认单', '没有 include confirm-list.md（确认单须由 confirm_list.py 生成）')
        if not re.search(r'(?m)^#{2,4}\s*.*需求梳理速览', full): add('L3', '必改', 0, '需求梳理速览', '缺少「需求梳理速览」章节')
        if not re.search(r'(?m)^#{2,4}\s*需求与范围确认单', full): add('L3', '必改', 0, '需求与范围确认单', '缺少「需求与范围确认单」章节')
        if 'sections/company.md' not in incs: add('L5', '必改', 0, '公司介绍', '没有 include sections/company.md（公司定位、服务矩阵、团队与质量保障、案例、联系方式，由 company_section.py 生成）')
        if not brief.get('contact', {}).get('name'): add('L5', '建议', 0, '联系人', 'brief.json 未填 contact.name，联系我们只有公司热线与官网')
    # A1 金额：与 pricing/ 产物精确匹配或登记在 allowed-amounts.json
    tokens = set(); pdir = os.path.join(root, 'pricing')
    if os.path.isdir(pdir):
        for f in os.listdir(pdir):
            if f.endswith(('.md', '.json')) and 'internal' not in f:
                for t in re.findall(r'\d[\d,]*(?:\.\d+)?', open(os.path.join(pdir, f)).read()):
                    a = amount(t)
                    if a is not None: tokens.add(a)
    allow = set()
    ap = os.path.join(pdir, 'allowed-amounts.json')
    if os.path.exists(ap):
        for t in json.load(open(ap)).get('amounts', []): allow.add(amount(str(t)))
    raw_no_inc = re.sub(r'<!--\s*include:[^>]*-->', '', raw)
    for i, l in enumerate(raw_no_inc.split('\n'), 1):
        if any(k in l for k in THIRD_PARTY_AMOUNT): continue
        for m in re.finditer(r'(?:USD|\$|¥|CNY)\s?(\d[\d,]*(?:\.\d+)?)', l):
            v = amount(m.group(1))
            if v is not None and v not in tokens and v not in allow:
                add('A1', '必改', i, l, f'金额 {m.group(0)} 与 pricing/ 产物不精确匹配（正文不应手写报价；第三方费用写入 pricing/allowed-amounts.json）')
        for m in re.finditer(r'(\d+(?:\.\d+)?)\s*人天', l):
            if re.search(r'单价|/\s*人天|人天\s*=', l): continue
            v = amount(m.group(1))
            if v is not None and v not in tokens and v not in allow: add('A1', '建议', i, l, f'人天数 {m.group(0)} 与 pricing/ 产物不精确匹配')
    # A2 范围（建站）
    mp = os.path.join(pdir, 'site-model.json'); model = json.load(open(mp)) if os.path.exists(mp) else {}
    if line_kind == 'site':
        sp = os.path.join(root, 'scope.json')
        if not os.path.exists(sp): add('A2', '必改', 0, 'scope.json', '缺少 scope.json（正文范围清单，报价与质检共用）')
        elif model:
            scope = json.load(open(sp))
            for p in model.get('plans', []):
                ids = {x['id'] for x in p.get('items', [])}
                need = {s['id'] for s in scope.get('items', []) if not s.get('plans') or p['key'] in s['plans']}
                if need - ids: add('A2', '必改', 0, p['key'], f"方案 {p['key']} 报价缺少正文范围内的工作项：{sorted(need - ids)}")
                extra = ids - {s['id'] for s in scope.get('items', [])}
                if extra: add('A2', '必改', 0, p['key'], f"方案 {p['key']} 报价含正文范围外的工作项：{sorted(extra)}")
    # A3 比例与倍数表述
    rts = model.get('ratios', {})
    if rts:
        r = list(rts.values())[0]; big = max(r, 1 / r)
        words = {'一半': 0.5, '三分之一': 1/3, '三分之二': 2/3, '2/3': 2/3, '1/2': 0.5, '1/3': 1/3}
        for i, l in enumerate(lines, 1):
            cx = l.replace('零成本', '')
            for w, val in words.items():
                if re.search(r'(成本|报价|价格|工期|费用)[^。；;\n]{0,15}' + re.escape(w), cx) and abs(val - r) > 0.05 and abs(val - 1/r) > 0.05:
                    add('A3', '建议', i, l, f'比例表述「{w}」与模型比值 {r:.3f} 不一致，改用 pricing/ratio.md')
            if re.search(r'成本|报价|价格|工期|费用', cx):
                for m in re.finditer(r'(\d+(?:\.\d+)?)\s*倍', cx):
                    if abs(float(m.group(1)) - big) > 0.1: add('A3', '建议', i, l, f'倍数表述「{m.group(0)}」与模型 {big:.2f} 倍不一致')
    # C2 「N 大模块（见 X.Y）」与 X.Y 节表格行数
    heads, cnt = [], [0, 0, 0]
    for i, l in enumerate(lines):
        mh = re.match(r'^(#{2,4})\s+(.*)', l)
        if mh:
            lv = len(mh.group(1)) - 1; cnt[lv - 1] += 1
            for j in range(lv, 3): cnt[j] = 0
            heads.append((i, lv, '.'.join(str(c) for c in cnt[:lv])))

    def rows_under(num):
        for k, (i, lv, n) in enumerate(heads):
            if n == num:
                end = next((h[0] for h in heads[k+1:] if h[1] <= lv), len(lines))
                tbl = [x for x in lines[i+1:end] if x.strip().startswith('|') and not re.match(r'^\|[\s:|-]+\|?$', x.strip())]
                return max(len(tbl) - 1, 0) if tbl else None
        return None
    for i, l in enumerate(lines, 1):
        for m in re.finditer(r'(\d+)\s*(?:大|个)模块[^（(\n]{0,10}[（(]见\s*([\d.]+)\s*[)）]', l):
            rows = rows_under(m.group(2))
            if rows is not None and rows != int(m.group(1)): add('C2', '建议', i, l, f'「{m.group(0)}」写 {m.group(1)} 个，{m.group(2)} 节模块表实际 {rows} 行')
    # C3 需求梳理速览的待确认项 → 确认单
    pending = [o for o in brief.get('overview', []) if o.get('status') == '待确认']
    conf = re.search(r'(?m)^#{2,4}\s*需求与范围确认单[^\n]*\n(.*?)(?=^#{2,3}\s|\Z)', full, re.S)
    conf_txt = conf.group(1) if conf else ''
    for o in pending:
        key = o.get('dimension', '')
        phrases = [w for w in re.findall(r'[一-龥A-Za-z]{2,}', o.get('result', '')) if w not in ('待确认', '待定', '确认')]
        if key and key not in conf_txt and not any(w in conf_txt for w in phrases):
            add('C3', '必改', 0, key, f'需求梳理速览的待确认项「{key}」未出现在需求与范围确认单')
    # B1 否定性条款
    for i, l in enumerate(lines, 1):
        for w in ['仅供参考', '不作为最终报价依据', '不作为报价依据', '仅为参考量级']:
            if w in l: add('B1', '必改', i, l, f'否定性条款「{w}」可能吞掉报价承诺')
    # F2 过时表述、F4 效果承诺
    for i, l in enumerate(lines, 1):
        for pat, msg, sev in STALE:
            if re.search(pat, l): add('F2', sev, i, l, msg)
        for pat in PROMISE:
            mm = re.search(pat, l)
            if mm: add('F4', '建议', i, l, f'量化或效果承诺「{mm.group(0)}」需有实测依据与口径，否则改为预期表述')
    # R2 内部口径泄露、R3 不可售项
    for i, l in enumerate(lines, 1):
        for pat, label in LEAK:
            if re.search(pat, l): add('R2', '必改', i, l, f'内部口径或成本泄露：「{label}」')
        for w in NOT_FOR_SALE:
            if w in l and not re.search(r'不提供|不采购|不做|不安排|不接受|禁止|不得', l) and not re.search(r'我方不提供', '\n'.join(lines[max(0, i-6):i])):
                add('R3', '必改', i, l, f'不可售项「{w}」出现在非拒绝语境')
    return issues


# ==== presales-site 专属规则（W3-A，2026-09-15）：本行以上与 presales-reddit/qa_rules.py 除 PACK_ID 外逐字一致，以下只在本包 ====
# SITE-06 按 mode 的必备章节（提示；引擎 S1 迁移期未开，是否打开由 1f 定）
# SITE-07 mode 禁词（必改；pack.json modes.items[].forbidden_terms，客户可见正文，validate.forbidden_hits）
# SITE-08 有效期两处（必改；封面 = presales-publish 渲染封面的数据源，第二处 = 报价或商务条款章 / pricing 与 terms.md 展开正文）
# SITE-09 mode 配置错误（必改；元数据 site.project_type 无法识别，不回落默认骨架）
# 与 L3、L5、A2 同口径：只在 brief.json line 为 site 时检查。
import importlib.util as _ilu

_check_migrated = check
_VALIDATE = []
_HAND_NUM = re.compile(r'^(\d+(\.\d+)*[.、\s]\s*|[一二三四五六七八九十]+[、.．]\s*|第[一二三四五六七八九十\d]+[章节部分]\s*|[（(]\d+[)）]\s*)')
_VALID_30 = re.compile(r'(?<!\d)30\s*(?:个)?(?:自然日|日历日|天)内有效')


def _validate_mod():
    """doc-shared/scripts/validate.py（resolve_mode、resolve_skeleton、forbidden_hits）。doc-qa 进程里已在 sys.path；包目录被复制到别处时按相对路径兜底。"""
    if not _VALIDATE:
        try:
            import validate as v
            if not hasattr(v, 'forbidden_hits'):
                raise ImportError
        except ImportError:
            p = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'scripts', 'validate.py')
            spec = _ilu.spec_from_file_location('doc_shared_validate', p)
            v = _ilu.module_from_spec(spec)
            spec.loader.exec_module(v)
        _VALIDATE.append(v)
    return _VALIDATE[0]


def _visible_text(doc):
    """客户可见正文（行号与 doc.lines 一致）：去围栏代码块、HTML 注释（含跨行）、链接与图片地址（保留文字）、锚点与属性块、交叉引用、裸 URL、include 兼容标记。"""
    blank = lambda m: re.sub(r'[^\n]', ' ', m.group(0))
    text = '\n'.join('' if doc.code_mask[i] else l for i, l in enumerate(doc.lines))
    text = re.sub(r'<!--.*?-->', blank, text, flags=re.S)
    text = re.sub(r'<!--.*\Z', blank, text, flags=re.S)
    text = re.sub(r'!?\[([^\]\n]*)\]\([^)\n]*\)', lambda m: m.group(1), text)
    text = re.sub(r'\{[#.][^}\n]*\}', '', text)
    text = re.sub(r'@[a-z_]+:[\w-]+', '', text)
    text = re.sub(r'https?://[^\s）)]+', '', text)
    return re.sub(r'\[\[(?:FORBIDDEN|UNRESOLVED) include: [^\]\n]*\]\]', '', text)


def _hnorm(t):
    return re.sub(r'\s+', '', _HAND_NUM.sub('', (t or '').strip())).lower()


def _site_mode_checks(doc, ctx):
    bp = os.path.join(ctx.run_dir, 'brief.json')
    brief = json.load(open(bp)) if os.path.exists(bp) else {}
    if not isinstance(brief, dict) or brief.get('line') != 'site':
        return []
    out = []
    add = lambda rule, sev, line, text, msg: out.append({'rule': rule, 'severity': sev, 'line': line, 'excerpt': str(text).strip()[:120], 'message': msg})
    V = _validate_mod()
    field = (ctx.pack.get('modes') or {}).get('field', '')
    try:
        mode = V.resolve_mode(ctx.pack, brief)
        skeleton = V.resolve_skeleton(ctx.pack, mode)
    except (V.ModeError, KeyError) as ex:
        mode, skeleton = None, None
        add('SITE-09', '必改', 0, field, f'mode 配置错误：{ex}；按 mode 的必备章节与禁词检查未执行（不回落默认骨架），修正 brief.json 的 {field}')
    visible = _visible_text(doc)
    if skeleton is not None:
        found = set()
        for h in doc.headings:
            nt = _hnorm(h.get('plain') or h.get('title'))
            for s in skeleton:
                if h.get('anchor') == f'sec:{s["id"]}' or nt == _hnorm(s['title']) or any(nt == _hnorm(a) for a in s.get('aliases') or []):
                    found.add(s['id'])
        missing = [s for s in skeleton if s.get('required') and s['id'] not in found]
        if missing:  # 全文汇总一条：迁移期骨架标题与正文常不匹配（缺 aliases），逐章报会淹没其他问题
            names = '、'.join(f'「{s["title"]}」' for s in missing)
            add('SITE-06', '提示', 0, missing[0]['title'], f'（mode {mode}）缺少 {len(missing)} 个必备章节：{names}（按标题、aliases 或 {{#sec:id}} 锚点匹配；标题不同但内容在时给骨架补 aliases 或正文加锚点）')
        for term, ln, txt in V.forbidden_hits(ctx.pack, mode, visible):
            m = re.search(term, txt)
            add('SITE-07', '必改', ln, doc.lines[ln - 1] if 0 < ln <= len(doc.lines) else txt, f'mode {mode} 客户可见正文不得出现「{m.group(0) if m else term}」（禁词 {term}）')
        for t in doc.tables:
            if t.get('source') != 'data':
                continue
            cl = t.get('csv_lines') or []
            for i, row in enumerate(t.get('rows') or []):
                for term, _, txt in V.forbidden_hits(ctx.pack, mode, ' | '.join(row)):
                    n = cl[i] if i < len(cl) else None  # 数据块各行共用指令行号：报全文级、摘录写 CSV 行号，免被同规则同行合并
                    add('SITE-07', '必改', 0, f'{t.get("data_file")}' + (f' 第 {n} 行' if n else '') + f'：{txt}', f'mode {mode} 客户可见数据块（{t.get("data_file")}' + (f' 第 {n} 行' if n else '') + f'）不得出现禁词 {term}')
    # SITE-08 有效期两处
    sm = ctx.read_json_opt('pricing/site-model.json')
    mv = sm.get('validity_days') if isinstance(sm, dict) else None
    bv = brief.get('validity_days', 30)
    if mv is None:
        add('SITE-08', '必改', 0, 'pricing/site-model.json', '封面有效期取 pricing/site-model.json 的 validity_days（presales-publish 渲染封面用它），文件或字段缺失：先跑 price_site.py')
    elif mv != 30 or bv != mv:
        add('SITE-08', '必改', 0, 'validity_days', f'封面有效期必须是 30 天且 brief.json 与报价模型一致：brief.json validity_days {bv}，pricing/site-model.json {mv}')
    idx = set()
    for sid in ('pricing', 'terms'):
        sec = doc.section(sid)
        if sec:
            idx.update(range(sec['start'], sec['end'] + 1))
    for i, org in enumerate(doc.line_origin or [], 1):
        f = str(org[0] if isinstance(org, (list, tuple)) else '')
        if f.startswith('pricing/') or f == 'terms.md':
            idx.add(i)
    vis = visible.split('\n')
    if not any(_VALID_30.search(vis[i - 1]) for i in idx if 0 < i <= len(vis)):
        add('SITE-08', '必改', 0, '报价 / 商务条款', '报价汇总或商务条款里没有「30 天内有效」（封面与正文两处都要写；报价汇总由 price_site.py 生成时自带）')
    return out


def check(doc, ctx):
    return _check_migrated(doc, ctx) + _site_mode_checks(doc, ctx)
