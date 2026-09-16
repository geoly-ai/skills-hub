"""API 参考（api-reference）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

doc-qa 调用 check(doc, ctx)。约定：不修改 doc、不写文件、不 import 引擎内部模块；新规则一律定级「提示」试运行（W3-A，2026-09-15）；
跨文档读取用 ctx.related(type, role=…)，缺失时 ctx.missing_related_issue。与引擎重复的判据（必备章节 S1、编号重复 S3、
代码块未标语言 L8、绝对化用语 R1、验收列空泛词 T11）不在这里重复实现。
"""
import csv, io, os, re, sys

SEV = '提示'  # 新自动规则先定级「提示」试运行（doc-qa/SKILL.md「类型包接入」）；定级调整走 pack.json qa.severity_overrides

# 通用小工具在 doc-shared/scripts/qa_pack_helpers.py（2026-09-15 W3-H 从七个包各自一份上移）。doc-qa 进程里 doc-shared/scripts 已在 sys.path；
# 直接加载本文件时按包目录相对路径（types/<包>/ → doc-shared/scripts）兜底。
try:
    import qa_pack_helpers  # noqa: F401
except ImportError:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'scripts'))
from qa_pack_helpers import (RE_COMMENT, norm as _norm, chars as _chars, section as _section, in_section as _in, title as _title,  # noqa: E402,F401
                             tables as _tables, col as _col, cell as _cell, records as _records, row_line as _row_line, where as _where,
                             ent_where as _ent_where, finish as _finish, first as _first, body as _body, visible as _visible,
                             subheadings as _subheadings, read_csv as _csv, related as _related)


# ---------------------------------------------------------------- 本包规则

# API-06 代码块语言白名单（pack.schema.json 没有 allowed_languages 字段，暂放本包常量）
ALLOWED_LANGS = {'json', 'jsonc', 'yaml', 'yml', 'xml', 'http', 'bash', 'sh', 'shell', 'console', 'curl', 'text', 'plaintext', 'python',
                 'java', 'kotlin', 'go', 'javascript', 'js', 'typescript', 'ts', 'protobuf', 'proto', 'graphql', 'csharp', 'php', 'ruby', 'swift'}


def _allowed_langs(ctx):
    """代码块语言白名单：优先 pack.json qa.allowed_languages（pack.schema 可选字段）；读不到时回退本文件 ALLOWED_LANGS。返回 (集合, 来源说明)。"""
    v = ((getattr(ctx, 'pack', None) or {}).get('qa') or {}).get('allowed_languages')
    if isinstance(v, list) and v:
        return {str(x).strip().lower() for x in v}, 'pack.json qa.allowed_languages'
    return ALLOWED_LANGS, 'qa_rules.py ALLOWED_LANGS'
AUTH = re.compile(r'UNAUTHORI[SZ]ED|FORBIDDEN|(?<!\d)40[13](?!\d)|鉴权|认证|未授权|无权限|权限不足', re.I)
RATE = re.compile(r'RATE_?LIMIT|TOO_?MANY|(?<!\d)429(?!\d)|限流|频率', re.I)
METHOD = re.compile(r'\b(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\b')


def check(doc, ctx):
    out = []
    # API-02 / 04 / 05：接口详情节的直属下一层标题 = 一个接口
    for h, s, e in _subheadings(doc, _section(doc, 'endpoints')):
        reg = {'start': s, 'end': e}
        name = h.get('plain') or h.get('title') or ''
        tbls = _tables(doc, reg)
        miss = []
        if not tbls:
            miss.append('请求 / 响应表格')
        if not [cb for cb in doc.code_blocks if s < cb['line'] <= e and (cb.get('lang') or '').strip()]:
            miss.append('标了语言的示例代码块')
        if miss:
            out.append(ctx.issue('API-02', SEV, s, name, f'接口「{name}」缺少{"、".join(miss)}'))
        body = _body(doc, reg)
        perm = [(t, _col(t['header'], '权限')) for t in tbls]
        if not (any(c and any(_cell(r, c) for r in _records(t)) for t, c in perm) or re.search(r'权限\s*[:：]\s*\S', body)):
            out.append(ctx.issue('API-04', SEV, s, name, f'接口「{name}」没有标注权限要求（表格「权限」列或正文「权限：…」）'))
        m = METHOD.search(name + '\n' + body)
        if m and m.group(1) in ('GET', 'HEAD', 'OPTIONS'):
            continue  # 安全方法按 HTTP 语义天然幂等
        idem = [(t, _col(t['header'], '幂等')) for t in tbls]
        for t, c in idem:
            for i, r in enumerate(_records(t) if c else []):
                if _cell(r, c) not in ('是', '否'):
                    out.append(ctx.issue('API-05', SEV, *_where(t, i, _cell(r, c)), f'接口「{name}」幂等列取值「{_cell(r, c) or "空"}」不是 是 / 否'))
        if not any(c for _, c in idem) and '幂等' not in body:
            out.append(ctx.issue('API-05', SEV, s, name, f'接口「{name}」没有标注是否幂等（请求表「幂等」列或正文「幂等：是 / 否」；GET、HEAD 按 HTTP 语义豁免）'))
    # API-03 通用约定节有错误码表且覆盖鉴权失败与限流
    conv = _section(doc, 'conventions')
    if conv:
        ets = [t for t in _tables(doc, conv) if _col(t['header'], '错误码', 'error_code', 'code')]
        if not ets:
            out.append(ctx.issue('API-03', SEV, conv['start'], _title(conv), '通用约定节没有全局错误码表'))
        else:
            txt = ' '.join(_cell(r, c) for t in ets for r in _records(t) for c in t['header'])
            miss = [n for n, rx in (('鉴权失败', AUTH), ('限流', RATE)) if not rx.search(txt)]
            if miss:
                out.append(ctx.issue('API-03', SEV, ets[0]['line'], ' | '.join(ets[0]['header']), f'全局错误码表没有覆盖通用错误：{"、".join(miss)}'))
    # API-06 代码块语言在白名单内（未标语言由引擎 L8 查）
    langs, langs_src = _allowed_langs(ctx)
    for cb in doc.code_blocks:
        lang = (cb.get('lang') or '').strip().lower()
        if lang and lang not in langs:
            out.append(ctx.issue('API-06', SEV, cb['line'], '```' + lang, f'代码块语言「{lang}」不在本包语言白名单内（{langs_src}）'))
    # API-07 变更记录标注是否破坏性
    cl = _section(doc, 'changelog')
    if cl:
        ts = _tables(doc, cl)
        if not ts:
            out.append(ctx.issue('API-07', SEV, cl['start'], _title(cl), '变更记录节没有变更记录表'))
        for t in ts:
            if not _col(t['header'], '破坏性', 'breaking', '不兼容'):
                out.append(ctx.issue('API-07', SEV, t['line'], ' | '.join(t['header']), '变更记录表没有「破坏性」列'))
    # API-08 弃用接口有替代方案与下线时间（该节存在时）
    for t in _tables(doc, _section(doc, 'compat')):
        rc, dc = _col(t['header'], '替代'), _col(t['header'], '下线', '移除时间', 'sunset')
        if not rc or not dc:
            miss = '、'.join(n for n, c in (('替代方案', rc), ('下线时间', dc)) if not c)
            out.append(ctx.issue('API-08', SEV, t['line'], ' | '.join(t['header']), f'弃用接口表缺「{miss}」列'))
            continue
        for i, r in enumerate(_records(t)):
            miss = '、'.join(n for n, c in (('替代方案', rc), ('下线时间', dc)) if not _cell(r, c))
            if miss:
                out.append(ctx.issue('API-08', SEV, *_where(t, i, _first(r)), f'弃用接口「{_first(r)[:40]}」的 {miss} 为空'))
    return _finish(out)
