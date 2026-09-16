#!/usr/bin/env python3
"""写作完成度检查：每章 must_answer 覆盖、正文字数、占位符与写作提示残留。只读，不写运行目录。
用法：fill_check.py <运行目录> [--pack 类型包目录] [--section id|标题|编号]
检查（章节来自类型包 skeleton，按元数据 mode 打补丁）：
  - 必备章节缺失（按标题、aliases 或 {#sec:id} 匹配，与 doc-qa S1 同一解析器）；必备章节正文为空
  - must_answer 覆盖（启发式：条目按标点切词，≥ 2 字的词在本章纯文本或表格单元格中出现即算覆盖；只作提示，不阻塞）
  - 占位符残留：【待写…】【待补…】【待定…】、模板式 {占位}（如 {产品名称}、{N}；{#锚点}、{{…}}、代码块与 HTML 注释内（含行内起始、跨行注释）不算）、TODO / TBD / FIXME → 阻塞
  - 写作提示注释（<!-- 写作提示 … -->）残留 → 提示（不影响渲染，交付前建议删除）
输出 JSON：{ok, sections[], placeholders[], hints, blocking_reasons[], warnings[]}。
退出码：0 无阻塞；3 有阻塞（缺必备章、必备章为空、占位符残留）；2 用法错误。"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import authorlib as al  # noqa: E402

SPLIT_RE = re.compile(r'[、，,；;/／：:（）()\[\]「」“”"\s→←|·]+|与|和|及|或')
STOP = {'每条', '每项', '每节', '必须', '写清', '明确', '说明', '如有', '按需', '自动统计', '本节', '只放'}


QWORDS = re.compile(r'什么|怎么|哪些|哪个|是否|如何|多少|谁')


def terms(item):
    return [t for t in (QWORDS.sub('', x) for x in SPLIT_RE.split(item)) if len(t) >= 2 and t not in STOP]


def term_hit(t, hay, has_figure):
    # 中文名词短语的中心语通常在末尾：全词或末两字出现即算；含「图」的条目有图块即算
    if t in hay or (len(t) >= 3 and t[-2:] in hay):
        return True
    return '图' in t and has_figure


def section_body(doc, sec, masked):
    body = [masked[i - 1] for i in range(sec['start'] + 1, sec['end'] + 1)]  # 去掉标题行；注释（行内起始、跨行）已遮蔽
    cells = []
    for b in sec['blocks']:
        if b['kind'] in ('table', 'data'):
            for t in doc.tables:
                if t.get('line') == b['line'] and t.get('source') == 'data':   # Markdown 表格单元格已在遮蔽后的正文行里
                    cells += [c for r in t.get('rows') or [] for c in r] + list(t.get('header') or [])
    return '\n'.join(body), ' '.join(str(c) for c in cells)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--pack'); ap.add_argument('--section')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    run_dir = os.path.abspath(os.path.expanduser(a.run_dir))
    meta, _ = al.load_meta(run_dir)
    pack, _ = al.find_pack(meta.get('type'), a.pack)
    if pack is None:
        print(json.dumps({'ok': False, 'message': '找不到类型包'}, ensure_ascii=False)); return 2
    meta, _ = al.load_meta(run_dir, pack)
    try:
        al.skeleton_for(pack, meta, run_dir=run_dir)
    except (ValueError, KeyError) as ex:
        print(json.dumps({'ok': False, 'message': f'类型包 mode 无法确定：{ex}'}, ensure_ascii=False)); return 2
    src = pack.get('source_file', 'doc.md')
    if not os.path.exists(os.path.join(run_dir, src)):
        print(json.dumps({'ok': False, 'message': f'{src} 不存在'}, ensure_ascii=False)); return 2
    doc = al.parse(run_dir, pack)
    blocking, warnings, sections = [], [], []
    masked = al.masked_lines(doc.lines)
    for sk in al.skeleton_for(pack, meta, run_dir=run_dir):
        sec = doc.section(sk['id'])
        ent = {'id': sk['id'], 'title': sk.get('title'), 'required': bool(sk.get('required')), 'present': sec is not None}
        if sec is None:
            if sk.get('required'):
                blocking.append(f'缺必备章节「{sk.get("title")}」（标题、aliases 或 {{#sec:{sk["id"]}}} 均未匹配）')
            sections.append(ent); continue
        body, cells = section_body(doc, sec, masked)
        plain = re.sub(r'\*\*|\{#[^}]*\}|@\w+:[\w-]+|[#>|\-]', '', body)
        chars = len(re.sub(r'\s', '', al.PLACEHOLDER_RE.sub('', plain)))
        has_block = any(b['kind'] in ('table', 'data', 'figure', 'image', 'code') for b in sec['blocks'])
        ent.update({'heading': sec['heading']['plain'], 'number': sec['heading']['number'], 'line': sec['start'], 'chars': chars})
        if sk.get('required') and chars == 0 and not has_block:
            blocking.append(f'必备章节「{sec["heading"]["plain"]}」正文为空')
        hay = plain + ' ' + cells
        has_fig = any(b['kind'] in ('figure', 'image') for b in sec['blocks'])
        missing = [m for m in sk.get('must_answer') or [] if terms(m) and not any(term_hit(t, hay, has_fig) for t in terms(m))]
        total = len(sk.get('must_answer') or [])
        ent['must_answer'] = {'total': total, 'covered': total - len(missing), 'missing': missing}
        if missing:
            warnings.append(f'「{sec["heading"]["plain"]}」must_answer 可能未回答：' + '；'.join(missing) + '（启发式，人工确认）')
        sections.append(ent)
    code = al.code_mask(doc.lines)
    ph, hints = [], 0
    for i, l in enumerate(doc.lines, 1):
        if al.HINT_RE.search(l): hints += 1
        if i in code: continue
        ml = masked[i - 1]
        for m in list(al.PLACEHOLDER_RE.finditer(ml)) + list(al.TEMPLATE_PH_RE.finditer(ml)) + list(al.TODO_RE.finditer(ml)):
            f, ln = doc.line_origin[i - 1] if i - 1 < len(doc.line_origin) else (src, i)
            ph.append({'line': i, 'file': f, 'file_line': ln, 'text': m.group(0)[:60]})
    if ph:
        blocking.append(f'占位符残留 {len(ph)} 处：' + '；'.join(f'第 {p["line"]} 行 {p["text"]}' for p in ph[:5]))
    if hints:
        warnings.append(f'写作提示注释残留 {hints} 处（不影响渲染，交付前建议删除）')
    if a.section:
        sec = doc.section(a.section)
        if sec is None:
            print(json.dumps({'ok': False, 'message': f'找不到章节 {a.section}'}, ensure_ascii=False)); return 2
        sid = sec['heading'].get('skeleton_id')
        sections = [s for s in sections if s['id'] == sid] or sections
        ph = [p for p in ph if sec['start'] <= p['line'] <= sec['end']]
    out = {'ok': not blocking, 'run_dir': run_dir, 'pack': pack['id'], 'sections': sections, 'placeholders': ph, 'hints': hints,
           'blocking_reasons': blocking, 'warnings': warnings}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 3 if blocking else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
