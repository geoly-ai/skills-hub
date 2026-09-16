#!/usr/bin/env python3
"""doc-qa 引擎通用规则。判据只在 doc-shared/references/qa-engine.md 与 typography.md 定义，这里按原文实现。
每条规则：@rule('编号') def f(doc, ctx) -> list[issue]。结构事实来自共享解析器（doc.diag(规则) 取其诊断），引擎只定级。
引擎不认识任何业务词；词表、白名单、术语、关键数字口径都来自类型包声明。"""
import glob, json, os, re
from decimal import Decimal, InvalidOperation

from docmodel import char_count, width_units

RULES = {}
ORDER = []


def rule(code):
    def deco(fn):
        RULES[code] = fn; ORDER.append(code)
        return fn
    return deco


HAN = '㐀-鿿豈-﫿'
HAN_C = f'[{HAN}]'
SEV_OF_DIAG = {'error': '必改', 'warning': '建议', 'info': '提示'}
RE_COMMENT = re.compile(r'<!--.*?-->')
RE_INLINE_CODE = re.compile(r'`[^`\n]*`')
RE_IMG = re.compile(r'!\[[^\]]*\]\([^)]*\)')
RE_LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')


def _line_text(doc, line):
    return doc.lines[line - 1] if 0 < line <= len(doc.lines) else ''


def _diag_issues(doc, ctx, rule_code, sev_map=None, skip_codes=()):
    out = []
    for d in doc.diag(rule_code):
        if d['code'] in skip_codes:
            continue
        sev = (sev_map or {}).get(d['code']) or SEV_OF_DIAG.get(d['severity'], '提示')
        line = d.get('line') or 0
        out.append(ctx.issue(rule_code, sev, line, _line_text(doc, line) or d['message'], d['message']))
    return out


def _dedupe_line(items):
    """typography.md「报告粒度」：同一规则同一行只报一条（行号 0 的全文级问题不合并）。"""
    seen, out = set(), []
    for x in items:
        k = (x['rule'], x['line'])
        if x['line'] and k in seen:
            continue
        seen.add(k); out.append(x)
    return out


# ---------------------------------------------------------------- L1

ITALIC_RE = re.compile(r'(?<![*A-Za-z0-9_])\*(?![*\s])[^*\n]+?(?<![*\s])\*(?![*A-Za-z0-9_])')  # 汉字在 \w 内，边界只看 ASCII
STRIKE_RE = re.compile(r'~~[^~\n]+~~')


@rule('L1')
def r_l1(doc, ctx):
    out = []
    allow = ctx.pack.get('include_allow') or []
    forb = ctx.message('L1.forbidden', 'include 目标不在白名单（只允许 {allow}，禁止黑名单文件、绝对路径与路径穿越）')
    for i, l in enumerate(doc.lines, 1):
        if 'FORBIDDEN include' in l:
            out.append(ctx.issue('L1', '必改', i, l, forb.format(allow='、'.join(allow) if allow else '无')))
        elif 'UNRESOLVED include' in l or re.search(r'\{\{[^}]+\}\}', l):
            out.append(ctx.issue('L1', '必改', i, l, '未解析的 include 或占位符'))
    # 解析器事实：HTML 标签、include 嵌套过深、成对标记、特性未开启等（include 白名单外与找不到已由上面的标记行报出）
    out += _diag_issues(doc, ctx, 'L1', skip_codes=('include-forbidden', 'include-missing'))
    for rec in getattr(doc, 'compat_unmatched', []):
        what = '白名单外' if rec['status'] == 'forbidden' else '找不到'
        out.append(ctx.issue('L1', '必改', 0, f'{rec["file"]}：<!-- include: {rec["target"]} -->', f'include {rec["target"]} {what}（{rec.get("reason", "")}；位于 {rec["file"]} 第 {rec["line"]} 行）'))
    for i, l in enumerate(doc.lines, 1):
        if doc.code_mask[i - 1] or doc.comment_mask[i - 1]:
            continue
        body = RE_INLINE_CODE.sub('', RE_COMMENT.sub('', l))
        body = re.sub(r'^\s*[*+-]\s+', '', body)
        body = RE_LINK.sub(lambda m: m.group(1), RE_IMG.sub('', body)).replace('**', '')
        if ITALIC_RE.search(body):
            out.append(ctx.issue('L1', '必改', i, l, '斜体标记（DocMark 只允许加粗，飞书回查视为残留）'))
        if STRIKE_RE.search(body):
            out.append(ctx.issue('L1', '必改', i, l, '删除线标记（飞书回查视为残留）'))
    return out


# ---------------------------------------------------------------- L2（兼容规则：判据与旧脚本逐字一致，检查全部行）

@rule('L2')
def r_l2(doc, ctx):
    out = []
    for i, l in enumerate(doc.lines, 1):
        if '`' in l: out.append(ctx.issue('L2', '建议', i, l, '行内代码格式（飞书不使用）'))
        if re.search(r'\d\s*~\s*\d', l): out.append(ctx.issue('L2', '建议', i, l, '波浪号区间，改用「–」'))
    return out


# ---------------------------------------------------------------- L4 / L6 图

FIG_REF_RE = re.compile(r'!\[[^\]]*\]\((figures/[^)]+?\.(?:svg|mmd|dot|fig\.json))\)')  # 与旧 L4 一样允许路径含空格


def _fig_list(doc):
    """正文引用的 figures/ 图：沿用旧 L4 的正则（行内图片也算，代码块内不算），按 src 去重，并补上解析器识别的图。"""
    seen, out = set(), []
    cands = []
    for i, l in enumerate(doc.lines):
        if doc.code_mask[i]:
            continue
        cands += [m.group(1) for m in FIG_REF_RE.finditer(l)]
    cands += [f['src'] for f in doc.figures if f['kind'] == 'figure' and f['src'].startswith('figures/')]
    for src in cands:
        if src in seen:
            continue
        seen.add(src)
        stem = next((src[:-len(e)] for e in ('.fig.json', '.svg', '.mmd', '.dot') if src.endswith(e)), src)
        out.append({'src': src, 'svg': stem + '.svg'})
    return out


def review_index(ctx):
    rv = ctx.figures_review
    idx = {}
    for x in (rv.get('figures', []) if isinstance(rv, dict) else []):
        if isinstance(x, dict):
            for key in (x.get('file'), x.get('source')):
                if key: idx.setdefault(key, x)
    return idx


@rule('L4')
def r_l4(doc, ctx):
    out = []
    idx = review_index(ctx)
    for f in _fig_list(doc):
        src, svg = f['src'], f['svg']
        entry = idx.get(svg) or idx.get(src)
        human_ok = entry is not None and ('machine' not in entry or 'human' in entry)
        if not ctx.exists_safe(svg[:-4] + '.png') or not human_ok:
            out.append(ctx.issue('L4', '建议', 0, src, f'{src} 缺少 PNG 预览或 figures/review.json 自查记录'))
    return out


FONT_SIZE_RULES = {'LY4_font'}  # 字号问题的规则编号白名单：doc-figures 只有 lint.font_issue 产出 LY4_font（2026-09-15 读 doc-figures/scripts 核实）；新增字号规则时在这里登记


def _wb_errors(wb):
    """whiteboard-cli 结果：doc-figures 写对象 {errors, warnings, summary, issues} 或 {skipped}；旧契约示例为数组。返回错误条数。"""
    if isinstance(wb, list):
        return len(wb)
    if isinstance(wb, dict):
        n = int(wb.get('errors') or 0) if str(wb.get('errors') or 0).isdigit() else 0
        errs = [i for i in wb.get('issues') or [] if isinstance(i, dict) and str(i.get('severity', '')).lower() == 'error']
        return max(n, len(errs))
    return 0


def _lint_blocking(bl):
    """画板 lint：数组；条目带 severity 时只算必改 / error，不带时每条都算（旧契约示例）。"""
    if not isinstance(bl, list):
        return 0
    return sum(1 for i in bl if not isinstance(i, dict) or 'severity' not in i or str(i['severity']).lower() in ('必改', 'error'))


@rule('L6')
def r_l6(doc, ctx):
    """图机器检查（figures-policy.md §4、§7）。判据按 doc-figures 实际写入的 machine 结构：ok、issues[{rule, severity}]、board_lint[]、
    whiteboard_check 对象（数组形态兼容）、min_font_pt。ok=false 只有在「必改项全是字号类」且 render.json 实测字号达标时才清除。"""
    out = []
    idx = review_index(ctx)
    fmin = ((ctx.tokens or {}).get('size') or {}).get('figure_min', 7)
    render_figs, ly4 = {}, set()
    if isinstance(ctx.render_json, dict):
        for rf in ctx.render_json.get('figures') or []:
            for key in (rf.get('src'), rf.get('svg')):
                if key: render_figs[key] = rf
        for li in ctx.render_json.get('layout_issues') or []:
            if li.get('rule') == 'LY4' and li.get('target'): ly4.add(li['target'])
    for f in _fig_list(doc):
        src, svg = f['src'], f['svg']
        m = (idx.get(svg) or idx.get(src) or {}).get('machine')
        if not isinstance(m, dict):
            out.append(ctx.issue('L6', '必改', 0, src, f'{src} 缺少 figures/review.json 的 machine 检查记录（先跑图检查）'))
            continue
        rf = render_figs.get(src) or render_figs.get(svg)
        font_render = rf.get('min_font_pt') if rf else None
        font = font_render if font_render is not None else m.get('min_font_pt')
        must_issues = [i for i in m.get('issues') or [] if isinstance(i, dict) and i.get('severity') == '必改']
        font_must = [i for i in must_issues if str(i.get('rule', '')) in FONT_SIZE_RULES]
        other_must = [i for i in must_issues if i not in font_must]
        lint_n, wb_n = _lint_blocking(m.get('board_lint')), _wb_errors(m.get('whiteboard_check'))
        problems = []
        if lint_n: problems.append(f'画板 lint {lint_n} 条')
        if wb_n: problems.append(f'whiteboard-cli 错误 {wb_n} 条')
        for i in other_must:
            msg = str(i.get('message', ''))
            if not (str(i.get('rule', '')).startswith(('BL', 'wb_')) and (lint_n or wb_n)):
                problems.append(msg[:60] or str(i.get('rule')))
        if font is not None and font < fmin and not ({src, svg} & ly4):
            problems.append(f'等效最小字号 {font} pt < {fmin} pt' + ('（按 render.json 实际显示宽）' if font_render is not None else ''))
        # 字号是唯一已知失败原因：review 里字号不足（或必改项全是字号类），且没有其他失败
        # machine 里认不出的非空列表字段（未来新增的检查）一律当作其他失败，不放宽清除
        unknown_fail = any(isinstance(v, list) and v for k, v in m.items() if k not in ('issues', 'notes', 'board_lint'))
        # machine.must_fix 与识别出的必改条数不符时说明有未写进 issues 的失败，不清除
        count_ok = isinstance(m.get('must_fix'), int) and not isinstance(m.get('must_fix'), bool) and m['must_fix'] == len(font_must) > 0  # must_fix 缺失或与字号必改数不符都不清除
        font_only = (not other_must and not lint_n and not wb_n and not unknown_fail and count_ok
                     and bool(font_must))
        font_cleared = font_only and font_render is not None and font_render >= fmin
        # 同一张图 L6 与 LY4 双必改去重（W3-I）：L6 唯一原因是字号（font_only，判据同上）且 render.json 对该图已报 LY4 时不报 L6，
        # 由 merge_render 在 LY4 消息末尾注明「另见 L6 字号」。L6 其他原因（lint、whiteboard、其他必改、原因不明）照报。
        if getattr(ctx, 'merges_render', False) and not problems and m.get('ok') is False and font_only and not font_cleared and ({src, svg} & ly4):
            ctx.l6_font_deferred.update({src, svg} & ly4)
            continue
        if problems or (m.get('ok') is False and not font_cleared):
            out.append(ctx.issue('L6', '必改', 0, src, f'{src} 图机器检查未通过：' + ('；'.join(problems) if problems else 'machine.ok 为 false')))
    return out


# ---------------------------------------------------------------- L7 表题与表格

@rule('L7')
def r_l7(doc, ctx):
    out = []
    if ctx.feature('table_captions'):
        for t in doc.tables:
            if t.get('error'):
                continue
            if not t.get('caption'):
                where = '数据块缺 caption 参数' if t['source'] == 'data' else '表格上方没有 <!-- table: 表题 -->'
                out.append(ctx.issue('L7', '提示', t['line'], ' | '.join(t['header'])[:120], where))
    out += _diag_issues(doc, ctx, 'L7', sev_map={c: '提示' for c in ('table-no-separator', 'table-shape', 'table-empty-header', 'widths-count',
                                                                       'widths-invalid', 'directive-dangling')})
    return out


# ---------------------------------------------------------------- L8 代码块

@rule('L8')
def r_l8(doc, ctx):
    skip = () if ctx.feature('code_blocks') else ('code-no-lang',)
    return _diag_issues(doc, ctx, 'L8', sev_map={'code-disabled': '必改', 'code-unclosed': '必改', 'code-no-lang': '建议'}, skip_codes=skip)


# ---------------------------------------------------------------- L9 数据块

@rule('L9')
def r_l9(doc, ctx):
    return _diag_issues(doc, ctx, 'L9', sev_map={'data-no-rows': '提示', 'data-param': '提示'})


# ---------------------------------------------------------------- L10 链接与图片路径

@rule('L10')
def r_l10(doc, ctx):
    out = []
    for lk in doc.links:
        url = lk['url']
        if not lk['text'].strip():
            out.append(ctx.issue('L10', '建议', lk['line'], f'[]({url})', '链接文字为空'))
        if re.match(r'^https?://', url, re.I):
            continue
        if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', url):
            out.append(ctx.issue('L10', '建议', lk['line'], url, f'链接协议不是 http(s) 也不是相对路径：{url}')); continue
        path = url.split('#', 1)[0].split('?', 1)[0]
        if path and not ctx.exists_safe(path):
            out.append(ctx.issue('L10', '建议', lk['line'], url, f'相对链接指向的文件不存在：{path}'))
    for f in doc.figures:
        src = f['src']
        if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', src):
            continue
        if not ctx.exists_safe(src):
            out.append(ctx.issue('L10', '建议', f['line'], src, f'图源文件不存在：{src}'))
    return out


# ---------------------------------------------------------------- S1–S3

HAND_NUM_RE = re.compile(r'^(\d+(\.\d+)*[.、\s]\s*|[一二三四五六七八九十]+[、.．]\s*|第[一二三四五六七八九十\d]+[章节部分]\s*|[（(]\d+[)）]\s*|附录\s*[A-Z][:：.、\s]\s*)')


def norm_title(t):
    return re.sub(r'\s+', '', HAND_NUM_RE.sub('', (t or '').strip())).lower()


def doc_skeleton(doc, ctx):
    """pack 声明 modes 时为 docmodel 按元数据取的 mode 骨架，否则为基础 skeleton。"""
    sk = doc.__dict__.get('skeleton') if hasattr(doc, '__dict__') else None
    return sk if sk is not None else (ctx.pack.get('skeleton') or [])


def match_skeleton(doc, ctx):
    sk = doc_skeleton(doc, ctx)
    for h in doc.headings:
        if h.get('skeleton_id'):
            continue
        nt = norm_title(h.get('title_text') or h.get('plain') or h.get('title'))
        for s in sk:
            if h.get('anchor') == f'sec:{s["id"]}' or nt == norm_title(s['title']) or any(nt == norm_title(a) for a in s.get('aliases') or []):
                h['skeleton_id'] = s['id']; break
    return sk


@rule('S1')
def r_s1(doc, ctx):
    """必备章节按 mode 骨架检查（pack-interface.md §2.1）。mode 值无法识别时报配置错误，不按默认骨架报缺章（避免假红，也不假绿）。"""
    err = doc.__dict__.get('mode_error') if hasattr(doc, '__dict__') else None
    if err:
        field = ((ctx.pack.get('modes') or {}).get('field')) or ''
        return [ctx.issue('S1', '必改', 0, field, f'mode 配置错误：{err}；必备章节检查未执行（不回落默认骨架），修正元数据文件的 {field}')]
    sk = match_skeleton(doc, ctx)
    mode = doc.__dict__.get('mode') if hasattr(doc, '__dict__') else None
    found = {h['skeleton_id'] for h in doc.headings if h.get('skeleton_id')}
    out = []
    for s in sk:
        if s.get('required') and s['id'] not in found:
            names = '、'.join([s['title']] + list(s.get('aliases') or []))
            where = f'（mode {mode}）' if mode else ''
            out.append(ctx.issue('S1', '必改', 0, s['title'], f'缺少必备章节「{s["title"]}」{where}（标题 {names} 或锚点 {{#sec:{s["id"]}}} 均未匹配）'))
    return out


@rule('S2')
def r_s2(doc, ctx):
    return _diag_issues(doc, ctx, 'S2', sev_map={'heading-skip': '必改', 'heading-depth': '必改', 'heading-empty': '必改', 'title-missing': '必改',
                                                  'title-duplicate': '建议'})


@rule('S3')
def r_s3(doc, ctx):
    out = _diag_issues(doc, ctx, 'S3', sev_map={'entity-pattern': '必改'})
    cfg = {e['kind']: e for e in (ctx.pack.get('numbering') or {}).get('entities') or []}
    for kind, defs in doc.entities.items():
        e = cfg.get(kind, {})
        label = e.get('label', kind)
        if e.get('unique'):
            seen = {}
            for d in defs:
                if d['code'] in seen:
                    out.append(ctx.issue('S3', '必改', d['line'], d['code'], f'{label}编号 {d["code"]} 重复（首次在第 {seen[d["code"]]} 行）'))
                else:
                    seen[d['code']] = d['line']
        if e.get('contiguous'):
            groups = {}
            for d in defs:
                m = re.match(r'^(.*?)(\d+)$', d['code'])
                if m: groups.setdefault(m.group(1), {})[int(m.group(2))] = m.group(2)
            for prefix, nums in groups.items():
                ns = sorted(nums)
                gaps = [f'{prefix}{nums[a]}→{prefix}{nums[b]}' for a, b in zip(ns, ns[1:]) if b - a > 1]
                if gaps:
                    out.append(ctx.issue('S3', '提示', 0, prefix, f'{label}编号不连续（按「编号去掉末尾序号」分组）：{"、".join(gaps[:5])}'))
    return out


# ---------------------------------------------------------------- X1–X4

@rule('X1')
def r_x1(doc, ctx):
    return _diag_issues(doc, ctx, 'X1', sev_map={'ref-unresolved': '必改', 'footnote-missing': '必改'})


@rule('X2')
def r_x2(doc, ctx):
    """校准（2026-09-15，9 个样张 73 处）：有锚点却没被引用的逐条报；没有锚点的图表全文汇总为一条。"""
    out = []
    if ctx.feature('figure_numbers'):
        refd = {r['target'] for r in doc.refs}
        items = [('图', f['line'], f['src'], f.get('caption') or '', f.get('anchor')) for f in doc.figures if f['kind'] == 'figure' and f.get('number')]
        items += [('表', t['line'], t.get('caption') or '', t.get('caption') or '', t.get('anchor')) for t in doc.tables if t.get('number')]
        unanchored = []
        for kind, line, ex, cap, anchor in sorted(items, key=lambda x: x[1]):
            if not anchor:
                unanchored.append((kind, line, ex, cap))
            elif anchor not in refd:
                out.append(ctx.issue('X2', '提示', line, ex, f'{kind}「{cap}」有锚点 {{#{anchor}}} 但正文没有 @{anchor} 引用'))
        if unanchored:
            k, line, ex, cap = unanchored[0]
            out.append(ctx.issue('X2', '提示', line, ex, f'全文 {len(unanchored)} 张有编号的图表没有锚点，正文无法用 @fig: / @tbl: 引用（首个：{k}「{cap}」）'))
    out += _diag_issues(doc, ctx, 'X2', sev_map={'footnote-unused': '提示'})
    return out


@rule('X3')
def r_x3(doc, ctx):
    return _diag_issues(doc, ctx, 'X3', sev_map={'anchor-duplicate': '必改', 'anchor-invalid': '必改', 'footnote-duplicate': '必改', 'anchor-kind': '必改'})


def _norm_value(v, how):
    v = v.strip()
    if how == 'number':
        try:
            return str(Decimal(v.replace(',', '').replace('，', '')).normalize())
        except InvalidOperation:
            return v
    return re.sub(r'\s+', '', v)


@rule('X4')
def r_x4(doc, ctx):
    """关键数字一致性：类型包 qa.key_figures 声明口径（命名组 value 为值，可选命名组 key 为分组键），引擎只比对。
    在解析器纯文本单元上匹配（段落续行已拼接、注释与代码块不在其中），行号为单元起始行。"""
    out = []
    units = [(line, text) for kind, line, text, _ in doc.text_units() if text]
    for kf in ctx.qa.get('key_figures') or []:
        label = kf.get('label') or kf.get('id')
        try:
            rx = re.compile(kf['pattern'])
        except (re.error, KeyError) as ex:
            out.append(ctx.issue('X4', '必改', 0, kf.get('pattern', ''), f'关键数字「{label}」的识别正则无法编译：{ex}')); continue
        if 'value' not in rx.groupindex:
            out.append(ctx.issue('X4', '必改', 0, kf['pattern'], f'关键数字「{label}」的识别正则缺命名组 value')); continue
        how = kf.get('normalize', 'number')
        groups = {}
        for line, text in units:
            for m in rx.finditer(text):
                val = m.group('value')
                if val is None or not val.strip():
                    continue
                key = (m.group('key') or '').strip() if 'key' in rx.groupindex else ''
                groups.setdefault(key, []).append((_norm_value(val, how), val.strip(), line, text))
        for key, occ in groups.items():
            if len({x[0] for x in occ}) <= 1:
                continue
            diff = next(x for x in occ if x[0] != occ[0][0])
            vals = []
            for x in occ:
                if x[0] not in [v[0] for v in vals]:
                    vals.append(x)
            desc = '、'.join(f'{x[1]}（第 {x[2]} 行）' for x in vals[:4])
            name = f'{label}「{key}」' if key else f'{label}'
            out.append(ctx.issue('X4', kf.get('severity', '必改'), diff[2], diff[3], f'{name}多处不一致：{desc}'))
    return out


# ---------------------------------------------------------------- C1

@rule('C1')
def r_c1(doc, ctx):
    out = []
    meta = ctx.meta if isinstance(ctx.meta, dict) else {}
    bv = str(meta.get('version', ''))
    history = {str(x.get('version', '')).lstrip('v') for x in meta.get('revision_history') or [] if isinstance(x, dict)}
    rev_lines = set()
    for t in doc.tables:
        if any(re.search(r'版本|修订|[Vv]ersion', h) for h in t.get('header') or []):
            rev_lines.update(t.get('row_lines') or [])
    head = doc.text[:2000]
    related = [x for x in meta.get('related_docs') or [] if isinstance(x, dict)]
    names = [x['title'] for x in related if x.get('title')] + [x['type'] for x in related if x.get('type')]

    keep = max([12] + [len(re.sub(r'\s+', '', nm)) + 2 for nm in names])  # 按 related_docs 名称实际长度回看
    look = keep * 3

    def cites_other(pos):
        """校准（2026-09-15）：版本号紧跟在书名号、「被测版本」或 related_docs 登记的文档名 / 类型名之后，是别的文档或被测对象的版本。
        只看版本号紧前（至少 12 个字符，related_docs 名称更长时按名称长度），不按整行放过，避免同一行里本文版本被一起吞掉。"""
        before = re.sub(r'[\s|｜:：]+', '', head[max(0, pos - look):pos])[-keep:]  # 表格单元格分隔符与冒号不算上下文
        if before.endswith('》') or before.endswith('被测版本'):
            return True
        return any(nm and before.lower().endswith(re.sub(r'\s+', '', nm).lower()) for nm in names)
    for v in set(re.findall(r'\bv(\d+\.\d+)', head)):
        if not bv or v == bv:
            continue
        occ = [m.start() for m in re.finditer(r'\bv' + re.escape(v), head)]
        lines_v = {head.count('\n', 0, pos) + 1 for pos in occ}
        if history or rev_lines:
            if v in history or (lines_v and lines_v <= rev_lines):
                continue
        if occ and all(cites_other(pos) for pos in occ):
            continue
        out.append(ctx.issue('C1', '提示', 1, f'v{v}', f'文中版本 v{v} 与 {ctx.meta_file} 版本 v{bv} 不一致'))
    pub = ctx.read_json_opt('published.json')
    if bv and isinstance(pub, dict):
        pv = str(pub.get('version', '')).lstrip('v')
        if pv and pv != bv.lstrip('v'):
            out.append(ctx.issue('C1', '提示', 0, f'v{pv}', f'published.json 版本 v{pv} 与 {ctx.meta_file} 版本 v{bv} 不一致'))
        pm = re.search(r'_v([\d.]+)_\d{8}\.pdf$', str(pub.get('pdf_path', '')))
        if pm and pm.group(1) != bv.lstrip('v'):
            out.append(ctx.issue('C1', '提示', 0, str(pub.get('pdf_path')), f'PDF 文件名版本 v{pm.group(1)} 与 {ctx.meta_file} 版本 v{bv} 不一致'))
    return out


# ---------------------------------------------------------------- R1

ABSOLUTE = ['零风险', '无损', '完全保证', '确保排名', '100% 通过', '保证排名', '绝对安全', '万无一失']


def _compile_terms(ctx, terms, rule_code, out):
    good = []
    for b in terms:
        if b.get('regex'):
            try:
                b = dict(b, _rx=re.compile(b['term']))
            except re.error as ex:
                out.append(ctx.issue(rule_code, '必改', 0, b['term'], f'类型包 banned_terms 正则「{b["term"]}」无法编译：{ex}')); continue
        good.append(b)
    return good, out


@rule('R1')
def r_r1(doc, ctx):
    out = []
    extra, out = _compile_terms(ctx, [b for b in ctx.qa.get('banned_terms') or [] if not b.get('columns')], 'R1', out)
    for i, l in enumerate(doc.lines, 1):
        for w in ABSOLUTE:
            if w in l and not re.search(r'不(承诺|保证|写|提供)[^。]{0,10}' + re.escape(w), l):
                out.append(ctx.issue('R1', '必改', i, l, f'绝对化用语「{w}」'))
        if doc.code_mask[i - 1] or doc.comment_mask[i - 1]:
            continue
        for b in extra:
            term = b['term']
            if term in ABSOLUTE and not b.get('regex'):
                continue  # 与内置词表重复，不重复报
            hit = b['_rx'].search(l) if b.get('regex') else (term in l)
            if hit and not re.search(r'不(承诺|保证|写|提供)[^。]{0,10}' + re.escape(term if not b.get('regex') else hit.group(0)), l):
                out.append(ctx.issue('R1', b['severity'], i, l, f'{b["message"]}（「{hit.group(0) if b.get("regex") else term}」）'))
    return out


# ---------------------------------------------------------------- H1–H4 高亮

def _hl_limits(ctx):
    lim = ctx.qa.get('highlight_limits') or {}
    return {'total': lim.get('total', 25), 'per_page': lim.get('per_page', 3), 'max_length': lim.get('max_length', 40)}


@rule('H1')
def r_h1(doc, ctx):
    lim = _hl_limits(ctx)['total']
    n = len(doc.highlights)
    if n > lim:
        first_over = doc.highlights[lim]
        return [ctx.issue('H1', '建议', 0, first_over.get('text', ''), f'全文重点高亮 {n} 处，超过 {lim} 处（从第 {first_over.get("line")} 行起超出）')]
    return []


def _per_page_counts(rj):
    """render.json 的高亮按页统计。接受 highlights_per_page {页: 数} 或 highlights [{page, …}]（doc-render 定稿后以其字段为准）。"""
    if not isinstance(rj, dict):
        return None
    hp = rj.get('highlights_per_page')
    if isinstance(hp, dict):
        return {str(k): int(v) for k, v in hp.items() if isinstance(v, (int, float))}
    hl = rj.get('highlights')
    if isinstance(hl, list):
        counts = {}
        for x in hl:
            if isinstance(x, dict) and x.get('page') is not None:
                counts[str(x['page'])] = counts.get(str(x['page']), 0) + 1
        return counts
    if isinstance(hl, dict) and isinstance(hl.get('per_page'), dict):
        return {str(k): int(v) for k, v in hl['per_page'].items()}
    return None


@rule('H2')
def r_h2(doc, ctx):
    counts = _per_page_counts(ctx.render_json)
    src = 'out/render.json'
    has_field = isinstance(ctx.render_json, dict) and ('highlights' in ctx.render_json or 'highlights_per_page' in ctx.render_json)
    if counts is None and not has_field:  # 字段不存在时才读 doc-render 另写的 out/render.highlights.json {total, per_page, items}
        side = ctx.read_json_opt('out/render.highlights.json')
        counts = _per_page_counts({'highlights': side}) if isinstance(side, dict) else None
        src = 'out/render.highlights.json'
    if not counts:
        return []
    lim = _hl_limits(ctx)['per_page']
    out = []
    for page, c in sorted(counts.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
        if c > lim:
            out.append(dict(ctx.issue('H2', '建议', 0, f'第 {page} 页', f'第 {page} 页重点高亮 {c} 处，超过每页 {lim} 处'), file=src))
    return out


@rule('H3')
def r_h3(doc, ctx):
    lim = _hl_limits(ctx)['max_length']
    out = []
    for h in doc.highlights:
        w = width_units(h.get('text', ''))
        if w > lim:
            out.append(ctx.issue('H3', '建议', h.get('line', 0), h.get('text', ''), f'单处重点高亮约 {w:g} 个汉字当量，超过 {lim:g}（不超过一行）'))
    out += _diag_issues(doc, ctx, 'HL1', sev_map={'highlight-empty': '建议'}, skip_codes=('highlight-nested', 'highlight-unopened', 'highlight-unclosed', 'highlight-multiline'))
    for x in out:
        x['rule'] = 'H3'
    return _dedupe_line(out)


@rule('H4')
def r_h4(doc, ctx):
    out = []
    for d in doc.diag('HL1'):
        if d['code'] in ('highlight-nested', 'highlight-unopened', 'highlight-unclosed', 'highlight-multiline'):
            out.append(ctx.issue('H4', '必改', d['line'] or 0, _line_text(doc, d['line'] or 0), f'重点高亮标记未配对：{d["message"]}'))
    rendered = sorted(os.path.relpath(p, ctx.run_dir) for p in glob.glob(os.path.join(ctx.run_dir, 'out', '*.html'))) + ['out/feishu.xml']
    for rel in rendered:
        try:
            txt = ctx.read_text(rel) if ctx.exists_safe(rel) else ''
        except (OSError, ValueError):
            txt = ''
        n = txt.count('⟪') + txt.count('⟫')
        if n:
            out.append(dict(ctx.issue('H4', '必改', 0, rel, f'渲染产物 {rel} 残留高亮标记字符 {n} 处（泄漏）'), file=rel))
    return out


# ---------------------------------------------------------------- T1–T12（typography.md）

T6_UNIT_RE = re.compile(r'\d(MB|GB|KB|TB|ms|s|px|pt|mm|cm|kg|W|Hz)\b')
T6_PCT_RE = re.compile(r'\d\s+%')
T6_QTY_RE = re.compile(r'\d(个|天|周|月|年|小时|分钟|次|条|页|项|人|台|套|倍)')
T6_EXEMPT_RE = re.compile(r'(?<![A-Za-z0-9])(3D|4K|5G|H5|2x|Top\d+|P\d|v\d+(\.\d+)*)(?![A-Za-z0-9])', re.I)


def _units(doc, kinds=None):
    for kind, line, text, extra in doc.text_units():
        if text and (not kinds or kind in kinds):
            yield kind, line, text, extra


def _mask(s, rx):
    return rx.sub(lambda m: '#' * len(m.group(0)), s)


@rule('T1')
def r_t1(doc, ctx):
    out = []
    for kind, line, text, _ in _units(doc):
        t = text
        qty = {m.start() for m in T6_QTY_RE.finditer(t)}  # 数字位置；T1 命中「汉+数字」或「数字+量词」且数字在此集合时归 T6
        miss = next((m for m in re.finditer(f'(?={HAN_C}[A-Za-z0-9]|[A-Za-z0-9]{HAN_C})', t)
                     if m.start() not in qty and m.start() + 1 not in qty), None)
        if miss:
            out.append(ctx.issue('T1', '建议', line, text, f'中文与英文、数字之间缺半角空格：「{text[max(0, miss.start() - 5):miss.start() + 7]}」'))
            continue
        # 只查半角空白：全角空格（U+3000）是有意的版式留白（如签字行），校准后排除
        m2 = re.search(r'[，。；：！？、）」』][ \t]+\S|\S[ \t]+[，。；：！？、（「『]', t)
        if m2:
            out.append(ctx.issue('T1', '建议', line, text, f'全角标点旁多余空格：「{m2.group(0)}」'))
    return _dedupe_line(out)


@rule('T2')
def r_t2(doc, ctx):
    out = []
    for kind, line, text, _ in _units(doc):
        if not re.search(HAN_C, text):
            continue
        t = re.sub(r'(?<=\d)[,.:](?=\d)', '#', text)
        m = re.search(f'{HAN_C}[,;:!?]|[,;:!?]{HAN_C}', t) or re.search(f'{HAN_C}\\.(\\s|$)', t)
        if m:
            out.append(ctx.issue('T2', '建议', line, text, f'中文语境用了半角标点：「{m.group(0).strip()}」')); continue
        if any(',' in s and '，' in s for s in re.split(r'[。！？]', t)):
            out.append(ctx.issue('T2', '建议', line, text, '同一句混用半角「,」与全角「，」'))
    return _dedupe_line(out)


@rule('T3')
def r_t3(doc, ctx):
    out = []
    for kind, line, text, _ in _units(doc):
        m = re.search(f'[0-9{HAN}]\\s*[~～〜]\\s*[0-9{HAN}]', text)
        if m:
            out.append(ctx.issue('T3', '必改', line, text, f'区间用了波浪号「{m.group(0)}」，改用「–」'))
    return _dedupe_line(out)


@rule('T4')
def r_t4(doc, ctx):
    out, corner, curly = [], [], []
    for kind, line, text, _ in _units(doc):
        if re.search('[「」]', text): corner.append((line, text))
        if re.search('[“”]', text): curly.append((line, text))
        m = re.search(f'{HAN_C}["\']|["\']{HAN_C}', text)
        if m:
            out.append(ctx.issue('T4', '建议', line, text, f'汉字旁用了半角引号：「{m.group(0)}」'))
    if corner and curly:
        style = (ctx.profile or {}).get('quote_style', '「」')
        if len(curly) != len(corner):
            minority = curly if len(curly) < len(corner) else corner
        else:
            minority = curly if style == '「」' else corner
        name = '“”' if minority is curly else '「」'
        out.append(ctx.issue('T4', '建议', minority[0][0], minority[0][1], f'全文同时用了「」与“”两种引号（{name} 共 {len(minority)} 处，品牌档案约定 {style}）'))
    return _dedupe_line(out)


T5_PUNCT_RE = re.compile(r'[。，；：！？、.,;:!?]$')
T5_NUM_RE = re.compile(r'^(\d+(\.\d+)*[.、\s]|[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十\d]+[章节部分]|[（(]\d+[)）]|附录\s*[A-Z])')


@rule('T5')
def r_t5(doc, ctx):
    """校准（2026-09-15，9 个样张 121 处）：手写序号与自动编号一致时解析器渲染前会去掉，不造成错号，全文汇总为一条提示；
    不一致（或中文序号、「第 N 章」等解析器不去掉的写法）逐条报建议。"""
    out, matched = [], []
    for h in doc.headings:
        t = h['title_text']
        if T5_PUNCT_RE.search(t):
            out.append(ctx.issue('T5', '建议', h['line'], t, f'标题末尾带标点「{t[-1]}」'))
        elif T5_NUM_RE.match(t):
            mn, auto = h.get('manual_number'), h.get('number')
            if mn and (mn == auto or (mn.startswith('附录') and 'appendix' in (h.get('classes') or []) and h.get('level') == 1 and mn == f'附录 {auto}')):
                matched.append(h)
            else:
                out.append(ctx.issue('T5', '建议', h['line'], t, f'标题里手写了序号，与自动编号「{auto or "无"}」不一致（渲染后会重复或错号；编号交给渲染，附录用 .appendix）'))
    if matched:
        out.append(ctx.issue('T5', '提示', matched[0]['line'], matched[0]['title_text'],
                             f'全文 {len(matched)} 个标题手写了序号（与自动编号一致，渲染时去掉；源文件宜删去）'))
    return out


@rule('T6')
def r_t6(doc, ctx):
    out = []
    for kind, line, text, _ in _units(doc):
        t = _mask(text, T6_EXEMPT_RE)
        m = T6_UNIT_RE.search(t)
        if m:
            out.append(ctx.issue('T6', '提示', line, text, f'数字与单位之间缺半角空格：「{text[max(0, m.start() - 4):m.end() + 2]}」')); continue
        m = T6_PCT_RE.search(t)
        if m:
            out.append(ctx.issue('T6', '提示', line, text, f'百分号前多余空格：「{m.group(0)}」')); continue
        m = T6_QTY_RE.search(t)
        if m:
            out.append(ctx.issue('T6', '提示', line, text, f'数字与量词之间缺半角空格：「{text[max(0, m.start() - 4):m.end() + 1]}」'))
    return _dedupe_line(out)


def _end_class(s):
    s = s.rstrip()
    if s and s[-1] in '。．.': return 'period'
    if s and s[-1] in '；;': return 'semi'
    return 'none'


@rule('T7')
def r_t7(doc, ctx):
    out = []
    desc = {'period': '句号', 'semi': '分号', 'none': '无标点'}
    for lst in doc.lists:
        for level in (1, 2):
            items = [it for it in lst['items'] if it['level'] == level]
            if len(items) < 2:
                continue
            classes = [_end_class(plain_of(it)) for it in items]
            if len(set(classes)) <= 1 or (set(classes[:-1]) == {'semi'} and classes[-1] == 'period'):
                continue
            out.append(ctx.issue('T7', '提示', items[0]['line'], plain_of(items[0]), '同一列表句末标点不一致：' + '、'.join(sorted({desc[c] for c in classes}))))
    return out


def plain_of(item):
    from docmodel import plain_nodes
    return plain_nodes(item.get('inline')) if item.get('inline') is not None else item.get('text', '')


def load_glossary(ctx):
    g = ctx.qa.get('glossary')
    if isinstance(g, str):
        try:
            g = json.load(open(os.path.join(ctx.pack_dir, g), encoding='utf-8'))
        except (OSError, json.JSONDecodeError, TypeError):
            g = {}
    if not isinstance(g, dict):
        return {}
    if isinstance(g.get('terms'), list):  # 兼容草稿形态 {terms: [{term, forbidden_synonyms}]}
        return {t['term']: [re.sub(r'[（(][^）)]*[）)]\s*$', '', v).strip() for v in t.get('forbidden_synonyms', []) if isinstance(v, str)]
                for t in g['terms'] if isinstance(t, dict) and t.get('term')}
    return {k: v for k, v in g.items() if isinstance(v, list)}


GLOSSARY_TITLES = {'术语表', '术语与缩略语', '名词解释', 'glossary'}  # 受控别名，规范化（去手写序号与空白、小写）后整体相等才算
QUOTED_RE = re.compile(r'「[^」]*」|“[^”]*”|"[^"]*"')


@rule('T8')
def r_t8(doc, ctx):
    gl = load_glossary(ctx)
    if not gl:
        return []
    variants = sorted(((v, k) for k, vs in gl.items() for v in vs if v and v != k), key=lambda x: -len(x[0]))
    skip = set()
    if norm_title(getattr(doc, 'title', '') or '') in GLOSSARY_TITLES:  # 文档主标题就是术语表（整体相等，不按子串）：整篇都是术语表章节
        return []
    for i, h in enumerate(doc.headings):
        if h.get('anchor') == 'sec:glossary' or h.get('skeleton_id') == 'glossary' or norm_title(h['title_text']) in GLOSSARY_TITLES:
            end = next((x['line'] for x in doc.headings[i + 1:] if x['level'] <= h['level']), len(doc.lines) + 1)
            skip.update(range(h['line'], end))
    out = []
    for kind, line, text, _ in _units(doc):
        if line in skip:
            continue
        t = QUOTED_RE.sub(lambda m: '\0' * len(m.group(0)), text)
        for correct in sorted(gl, key=len, reverse=True):
            t = t.replace(correct, '\0' * len(correct))
        for v, correct in variants:
            if re.fullmatch(r'[A-Za-z0-9 ._-]+', v):
                hit = re.search(r'(?<![A-Za-z0-9_-])' + re.escape(v) + r'(?![A-Za-z0-9_]|-[A-Za-z0-9])', t, re.I)
            else:
                hit = v in t
            if hit:
                out.append(ctx.issue('T8', '建议', line, text, f'术语异写「{v}」，统一用「{correct}」')); break
    return _dedupe_line(out)


@rule('T9')
def r_t9(doc, ctx):
    out = []
    for i, l in enumerate(doc.lines, 1):
        if doc.code_mask[i - 1] or doc.comment_mask[i - 1]:
            continue
        body = RE_LINK.sub(lambda m: m.group(1), RE_IMG.sub('', RE_COMMENT.sub('', l)))
        if '`' in body:
            out.append(ctx.issue('T9', '建议', i, l, '行内代码格式（飞书不使用；代码只放代码块）'))
    return out


@rule('T10')
def r_t10(doc, ctx):
    limit = ((ctx.tokens or {}).get('table') or {}).get('cell_chars_hint', 80)
    out = []
    for kind, line, text, extra in _units(doc, {'cell'}):
        c = char_count(text)
        if c > limit:
            out.append(ctx.issue('T10', '提示', line, text, f'单元格 {c} 字，超过 {limit} 字（列「{extra["column"]}」），考虑拆分或移到正文'))
    return _dedupe_line(out)


T11_COL_RE = re.compile(r'验收|预期|期望|判据|标准|结果')
T11_VAGUE = ['等等', '若干', '相关', '尽量', '合理', '适当', '友好', '及时', '体验更好', '性能高', '显著']
T11_EMPTY = {'正常', '成功', '通过', '符合预期', 'OK', 'ok'}


def _overlap(a, b):
    a = (a[0], max(a[1], a[0] + 1)); b = (b[0], max(b[1], b[0] + 1))  # 零宽匹配按 1 个字符算
    return a[0] < b[1] and b[0] < a[1]


@rule('T11')
def r_t11(doc, ctx):
    """内置空泛词与类型包 banned_terms（columns）同时检查。优先级（2026-09-15 主代理拍板）：同一单元格里类型包命中片段与内置命中片段重叠时，
    丢弃内置那条，保留类型包的定级与文案；同一行只留一条时类型包来源优先。优先级在规则内部完成，不依赖最终合并（最终合并按定级取高）。"""
    extra, errs = _compile_terms(ctx, [b for b in ctx.qa.get('banned_terms') or [] if b.get('columns')], 'T11', [])
    cands = []  # (去重键, issue, 是否类型包来源)
    for kind, line, text, info in _units(doc, {'cell'}):
        col = info['column']
        builtin, packed = [], []
        tb, ri = info.get('table') or {}, info.get('row')
        key, where, loc = line, text, ''
        if tb.get('source') == 'data':  # 数据块各行共用指令行号：报全文级、摘录写 CSV 行号，按 CSV 行去重，避免被最终「同规则同行」合并
            cl = tb.get('csv_lines') or []
            n = cl[ri] if ri is not None and ri < len(cl) else None
            loc = f'{tb.get("data_file") or "数据块"}' + (f' 第 {n} 行' if n else '')
            key, line, where = (tb.get('data_file'), n), 0, f'{loc}：{text}'
            loc = f'（{loc}）'
        if T11_COL_RE.search(col):
            core = re.sub(r'[。，；：、.,;:!！\s]', '', text)
            if core in T11_EMPTY:
                builtin.append(((0, len(text)), ctx.issue('T11', '建议', line, where, f'列「{col}」整格只有「{core}」，写出可观察的结果{loc}')))
            else:
                w = next((w for w in T11_VAGUE if w in text), None)
                if w:
                    i = text.find(w)
                    builtin.append(((i, i + len(w)), ctx.issue('T11', '建议', line, where, f'列「{col}」含空泛表述「{w}」{loc}')))
        for b in extra:
            if col not in b['columns']:
                continue
            if b.get('regex'):
                m = b['_rx'].search(text)
                span = m.span() if m else None
            else:
                i = text.find(b['term'])
                span = (i, i + len(b['term'])) if i >= 0 else None
            if span is not None:
                packed.append((span, ctx.issue('T11', b['severity'], line, where, b['message'] + loc)))
        for span, x in builtin:
            if not any(_overlap(span, ps) for ps, _ in packed):
                cands.append((key, x, False))
        cands += [(key, x, True) for _, x in packed]
    chosen, order = {}, []
    for k, x, from_pack in cands:
        if k not in chosen:
            chosen[k] = (x, from_pack); order.append(k)
        elif from_pack and not chosen[k][1]:
            chosen[k] = (x, from_pack)
    return errs + [chosen[k][0] for k in order]


SENT_SPLIT_RE = re.compile(r'[。！？；]|\.\s')


@rule('T12')
def r_t12(doc, ctx):
    out = []
    for kind, line, text, _ in _units(doc, {'p', 'callout', 'li'}):
        if kind in ('p', 'callout'):
            c = char_count(text)
            if c > 250:
                out.append(ctx.issue('T12', '提示', line, text, f'段落 {c} 字，超过 250 字')); continue
        longest = max((char_count(s) for s in SENT_SPLIT_RE.split(text)), default=0)
        if longest > 80:
            out.append(ctx.issue('T12', '提示', line, text, f'句子 {longest} 字，超过 80 字'))
    return _dedupe_line(out)
