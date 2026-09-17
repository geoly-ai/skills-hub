"""技术 Spec（tech-spec）类型包专属质检规则。接口见 doc-shared/references/pack-interface.md §4；判据与编号见同目录 qa-rules.md。

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

# SPEC-06 代码块语言白名单（pack.schema.json 没有 allowed_languages 字段，暂放本包常量；需要时提 schema 补丁）
ALLOWED_LANGS = {'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'xml', 'sql', 'http', 'bash', 'sh', 'shell', 'console', 'text', 'plaintext',
                 'python', 'java', 'kotlin', 'go', 'rust', 'c', 'cpp', 'csharp', 'javascript', 'js', 'typescript', 'ts', 'protobuf', 'proto',
                 'graphql', 'diff', 'properties', 'dockerfile', 'nginx', 'lua', 'php', 'ruby', 'swift', 'scala', 'mermaid'}


def _allowed_langs(ctx):
    """代码块语言白名单：优先 pack.json qa.allowed_languages（pack.schema 可选字段）；读不到时回退本文件 ALLOWED_LANGS。返回 (集合, 来源说明)。"""
    v = ((getattr(ctx, 'pack', None) or {}).get('qa') or {}).get('allowed_languages')
    if isinstance(v, list) and v:
        return {str(x).strip().lower() for x in v}, 'pack.json qa.allowed_languages'
    return ALLOWED_LANGS, 'qa_rules.py ALLOWED_LANGS'
ARCH = re.compile(r'arch|架构|topolog|拓扑|部署', re.I)
FLOW = re.compile(r'seq|state|时序|状态', re.I)
VER_ENV = re.compile(r'(?i)(?<![a-z0-9])v\d+(?:\.\d+)*(?![a-z0-9])|\d+\.\d+\.\d+|版本|环境|生产|预发|灰度|staging|(?<![a-z])(?:prod|test|dev)(?![a-z])|jdk\s*\d|python\s*\d|node(?:\.js)?\s*\d|java\s*\d')


def _unit_at(units, line):
    starts = [k for k in units if k <= line]
    return units[max(starts)] if starts else ''


def check(doc, ctx):
    out = []
    units = {}
    for kind, line, text, _ in doc.text_units():
        if kind in ('p', 'callout', 'li') and text:
            units.setdefault(line, text)
    # SPEC-02 备选方案至少 2 个
    alt = _section(doc, 'alternatives')
    if alt:
        codes = set(re.findall(r'ALT-\d+', _body(doc, alt)))
        subs = _subheadings(doc, alt)
        rows = max([len(_records(t)) for t in _tables(doc, alt)] or [0])
        if len(codes) < 2 and len(subs) < 2 and rows < 2:
            out.append(ctx.issue('SPEC-02', SEV, alt['start'], _title(alt), f'备选方案节不足 2 个方案（ALT 编号 {len(codes)} 个、子标题 {len(subs)} 个、比较表最多 {rows} 行）'))
    # SPEC-03 至少一张架构图与一张时序或状态图（带锚点；未被引用由引擎 X2 查）
    figs = [f for f in doc.figures if f.get('anchor')]
    desc = lambda f: ' '.join(str(f.get(k) or '') for k in ('src', 'caption', 'anchor'))
    if not any(ARCH.search(desc(f)) for f in figs):
        out.append(ctx.issue('SPEC-03', SEV, 0, '架构图', '没有带图号锚点的架构图（图源文件名、锚点或图题含 arch / 架构）'))
    if not any(FLOW.search(desc(f)) for f in figs):
        out.append(ctx.issue('SPEC-03', SEV, 0, '时序图 / 状态图', '没有带图号锚点的时序图或状态图（图源文件名、锚点或图题含 seq / state / 时序 / 状态）'))
    # SPEC-04 每张图有文字等价说明：引用它的段落，或图后紧邻段落，超过 20 字
    blocks = sorted(doc.blocks, key=lambda b: b['line'])
    for f in figs:
        ok = any(_chars(_unit_at(units, r['line'])) > 20 for r in doc.refs if r['target'] == f['anchor'])
        if not ok:
            nxt = next((b for b in blocks if b['line'] > f['line'] and b['kind'] not in ('figure', 'image')), None)
            ok = bool(nxt and nxt['kind'] == 'p' and _chars(units.get(nxt['line'])) > 20)
        if not ok:
            out.append(ctx.issue('SPEC-04', SEV, f['line'], f.get('caption') or f['src'], f'图「{f.get("caption") or f["src"]}」没有文字等价说明（引用 @{f["anchor"]} 的段落或图后段落不足 20 字）'))
    # SPEC-05 回滚节含判据关键词
    ro = _section(doc, 'rollout')
    if ro and not re.search(r'回滚条件|触发|判据', _body(doc, ro)):
        out.append(ctx.issue('SPEC-05', SEV, ro['start'], _title(ro), '「迁移、上线与回滚」节没有写回滚条件、触发或判据'))
    # SPEC-06 代码块语言在白名单内（未标语言由引擎 L8 查）
    langs, langs_src = _allowed_langs(ctx)
    for cb in doc.code_blocks:
        lang = (cb.get('lang') or '').strip().lower()
        if lang and lang not in langs:
            out.append(ctx.issue('SPEC-06', SEV, cb['line'], '```' + lang, f'代码块语言「{lang}」不在本包语言白名单内（{langs_src}）'))
    # SPEC-07 接口设计节表格含错误码列
    itf = _section(doc, 'interface')
    for t in _tables(doc, itf):
        if not _col(t['header'], '错误码', 'error_code', 'errorcode', '错误'):
            out.append(ctx.issue('SPEC-07', SEV, t['line'], ' | '.join(t['header']), '接口设计节的表格没有「错误码」列'))
    # SPEC-08 代码示例前后 3 行有版本或环境标注
    n = len(doc.lines)
    for cb in doc.code_blocks:
        s, e = cb['line'], cb.get('end_line', cb['line'])
        near = [doc.lines[i - 1] for i in list(range(max(1, s - 3), s)) + list(range(e + 1, min(n, e + 3) + 1))]
        if not VER_ENV.search('\n'.join(near)):
            out.append(ctx.issue('SPEC-08', SEV, s, '```' + (cb.get('lang') or ''), '代码示例前后 3 行没有版本号或环境标注（如 v1、测试环境）'))
    # SPEC-09 事实 / 推断 / 未知标注（存在性）
    if not re.search(r'待确认|待定|推断|未知', _visible(doc)):
        out.append(ctx.issue('SPEC-09', SEV, 0, '全文', '全文没有「待确认 / 推断 / 未知」这类事实状态标注，读者无法区分事实与推断'))
    return _finish(out)
