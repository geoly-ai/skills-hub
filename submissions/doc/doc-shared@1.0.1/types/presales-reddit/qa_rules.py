"""售前类型包（presales-site、presales-reddit）的专属质检规则（接口见 doc-shared/references/pack-interface.md「qa_rules.py 接口」）。

来源：presales-qa/scripts/qa_checks.py（2026-09-15 版本）的售前专属规则，判据、定级、行号基准、消息文字逐条照搬，
保证 golden 逐项一致：A1 A2 A3 C2 C3 B1 F2 F4 R2 R3 L3 L5。引擎通用部分（L1 L2 L4 C1 R1）由 doc-qa 执行，本文件不重复。
两个包用同一份实现（旧脚本按 brief.json 的 line 字段分支，这里原样保留）；两个文件除 PACK_ID 一行外逐字一致，doc-qa/tests 校验。

输入对应（旧 → 新）：raw（proposal.md 原文）→ doc.raw；full / lines（include 展开后）→ doc.text / doc.lines；
root → ctx.run_dir；brief.json 仍按旧脚本直接读运行目录下的 brief.json（与 pack.json meta_file 无关，迁移期兼容）。
"""
import json, os, re
from decimal import Decimal, InvalidOperation

PACK_ID = 'presales-reddit'

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
