#!/usr/bin/env python3
"""从类型包 skeleton 动态生成 doc.md 骨架与 outline.md（D1 拍板稿）。不写死任何章节名：章节、层级、必备、
must_answer、附录、按需条件全部来自 pack.json（按元数据里的 mode 打补丁；将来标 engine_generated 的项跳过）。
用法：outline.py <运行目录> [--pack 类型包目录] [--target doc|outline|both] [--force] [--stdout]
      outline.py <运行目录> --add-section <章节 id> [--add-section …]   D1 拍板纳入的按需章节插入正文（按骨架顺序定位）
  doc      写 <source_file>（默认 doc.md）：# 标题、summary 块（features.summary_block 开启时）、
           必备章节「## 标题 {#sec:<id>}」（锚点与标题同一行，S1 才认）+ 写作提示注释（must_answer）+ 【待写：…】占位；
           按需章节不预建（D1 拍板纳入后再用 --add-section 插入，避免「不纳入」的章节留下占位符）
  outline  写 <outline_file>（默认 outline.md）：章节树、must_answer、按需章节与关联文档的字母选项拍板项
  已存在的文件不覆盖，除非 --force。
退出码：0 成功；1 目标文件已存在（未加 --force），或 --add-section 有章节未插入（不存在或已有）；2 用法错误（运行目录、元数据或类型包缺失）。"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import authorlib as al  # noqa: E402

def num(i):
    s = ''.join(chr(0x2460 + k) for k in range(20))
    return s[i - 1] if 1 <= i <= 20 else f'({i})'


def heading_title(sk):
    t = sk.get('title', sk['id']).strip()
    if sk.get('appendix'):
        t = re.sub(r'^附录\s*[A-Z]?\s*[：:、.．]?\s*', '', t) or t
    return t


def numbered(skeleton):
    """按 level 算显示编号（附录用字母），仅用于 outline.md 展示；正文编号由渲染器自动生成。"""
    cnt = [0, 0, 0]; app = 0; out = []
    for sk in skeleton:
        lv = int(sk.get('level') or 1)
        if sk.get('appendix') and lv == 1:
            app += 1; cnt = [0, 0, 0]; out.append((sk, f'附录 {chr(64 + app)}')); continue
        if app and lv > 1:
            cnt[lv - 1] += 1
            for j in range(lv, 3): cnt[j] = 0
            out.append((sk, chr(64 + app) + '.' + '.'.join(str(c) for c in cnt[1:lv]))); continue
        cnt[lv - 1] += 1
        for j in range(lv, 3): cnt[j] = 0
        out.append((sk, '.'.join(str(c) for c in cnt[:lv])))
    return out


def section_lines(sk):
    lv = int(sk.get('level') or 1)
    cls = ' .appendix' if sk.get('appendix') else ''
    L = ['#' * (lv + 1) + f' {heading_title(sk)} {{#sec:{sk["id"]}{cls}}}', '']
    hint = []
    if sk.get('must_answer'): hint.append('must_answer: ' + '；'.join(sk['must_answer']))
    if not sk.get('required') and sk.get('when'): hint.append(f'适用条件：{sk["when"]}')
    if hint:
        L += ['<!-- 写作提示 ' + ' | '.join(hint) + ' -->', '']
    return L + [f'【待写：{heading_title(sk)}】', '']


def add_sections(run_dir, pack, meta, ids):
    """把按需章节插入正文：放在骨架中其后第一个已存在章节之前；后面都没有则追加到文末。返回 (added, skipped)。"""
    name = pack.get('source_file', 'doc.md')
    src = os.path.join(run_dir, name)
    sk_list = al.skeleton_for(pack, meta, run_dir=run_dir)
    by_id = {s['id']: i for i, s in enumerate(sk_list)}
    added, skipped, notes = [], [], []
    for sid in ids:
        if sid not in by_id:
            skipped.append(f'{sid}：骨架里没有这个章节'); continue
        doc = al.parse(run_dir, pack)   # 展开 include：片段里已有的章节也算已有
        present = {h.get('skeleton_id'): h for h in doc.headings if h.get('skeleton_id')}
        if sid in present:
            skipped.append(f'{sid}：正文已有（第 {present[sid]["line"]} 行）'); continue
        lines = open(src, encoding='utf-8').read().split('\n')
        at = None
        for later in sk_list[by_id[sid] + 1:]:
            h = present.get(later['id'])
            if not h: continue
            f, ln = doc.line_origin[h['line'] - 1] if h['line'] - 1 < len(doc.line_origin) else (name, h['line'])
            if f == name:
                at = ln - 1
            else:
                notes.append(f'{sid}：其后的章节「{h["plain"]}」在 include 片段 {f} 里，已追加到正文末尾，请手动挪到合适位置')
            break
        block = section_lines(sk_list[by_id[sid]])
        if at is None:
            while lines and not lines[-1].strip(): lines.pop()
            lines += [''] + block
        else:
            lines[at:at] = block
        open(src, 'w', encoding='utf-8').write('\n'.join(lines).rstrip() + '\n')
        added.append(sid)
    return added, skipped, notes


def build_doc(pack, meta, optional=(), run_dir=None):
    title = meta.get('title') or '【待写：文档标题】'
    L = [f'# {title}', '']
    if (pack.get('features') or {}).get('summary_block'):
        L += ['<!-- summary -->', '<!-- 写作提示 summary: 结论先行，3–5 句；只放问题、目标、范围、判据这类读者先要知道的结论；块内只用段落与列表 -->',
              '【待写：摘要】', '<!-- /summary -->', '']
    for sk in al.skeleton_for(pack, meta, run_dir=run_dir):
        if sk.get('required') or sk['id'] in optional:
            L += section_lines(sk)
    return '\n'.join(L).rstrip() + '\n'


def build_outline(pack, meta, run_dir):
    sk_list = al.skeleton_for(pack, meta, run_dir=run_dir)
    L = [f'# {meta.get("title", "（未定标题）")}：骨架（D1 拍板稿）', '',
         f'类型：{pack.get("name", pack["id"])}（{pack["id"]}）｜版本：v{meta.get("version", "?")}｜负责人：{meta.get("owner", "?")}', '']
    decisions = [('按下面的章节骨架开写',
                  [('A', True, '按此骨架开写', '之后再增删必备章节要重走 D1'),
                   ('B', False, '需要调整（写明增、删、改哪些章节）', '本轮 D1 不通过，改完重新拍板')])]
    for sk in sk_list:
        if not sk.get('required'):
            decisions.append((f'「{heading_title(sk)}」纳不纳入' + (f'（适用条件：{sk["when"]}）' if sk.get('when') else ''),
                              [('A', True, f'纳入（拍板后 outline.py --add-section {sk["id"]}）', '多写一节，质检与评审多一章；内容不足时会被判空洞'),
                               ('B', False, '不纳入', '读者看不到这部分，评审可能追问；以后补要改版')]))
    registered = {(r.get('type'), r.get('role')) for r in meta.get('related_docs') or []}
    for r in pack.get('related') or []:
        if (r['type'], r.get('role')) not in registered:
            decisions.append((f'关联文档 {r["type"]}（role={r.get("role")}）还没登记：{r.get("desc", "")}',
                              [('A', True, '现在补登记路径', '要先找到对方运行目录；' + ('D0 必需，不补无法开工' if r.get('required') else '不补则跨文档检查只报提示')),
                               ('B', False, '不关联，正文写明依据来源', '跨文档编号追踪失效' + ('；该项 D0 必需，选 B 需要改类型包，不推荐' if r.get('required') else '')),
                               ('C', False, '先给我看对方文档再定', '本轮 D1 不能通过')]))
    L += ['回复格式：「①A ②B」；也可回「全部按推荐」。拍板结果逐项记 run_state.py decide --key ① --value "A …"（D1 要求记录数不少于拍板项数），原话作为 D1 --evidence。', '']
    L += ['## 章节骨架', '', '| 编号 | 章节 | 必备 | 必须回答 |', '|---|---|---|---|']
    for sk, n in numbered(sk_list):
        L.append(f'| {n} | {heading_title(sk)} | {"是" if sk.get("required") else "按需"} | {"；".join(sk.get("must_answer") or []) or "—"} |')
    feats = pack.get('features') or {}
    L += ['', '## 引擎自动生成（不在正文写）', '',
          '- 封面、目录（带页码）、页眉页脚、图表编号与交叉引用文字' + ('、摘要页（来自 summary 块）' if feats.get('summary_block') else '') + '；修订记录按 doc.json revision_history 生成（品牌档案决定是否出页）。']
    ents = (pack.get('numbering') or {}).get('entities') or []
    if ents:
        L += ['', '## 编号实体', '', '| 实体 | 前缀 | 格式 | 唯一 | 连续 |', '|---|---|---|---|---|']
        for e in ents:
            L.append(f'| {e.get("label", e["kind"])} | {e.get("prefix", "")} | {e["pattern"]} | {"是" if e.get("unique") else "否"} | {"是" if e.get("contiguous") else "否"} |')
    if decisions:   # 至少有 ① 骨架确认
        L += ['', '## 待拍板', '']
        for i, (q, opts) in enumerate(decisions, 1):
            L.append(f'{num(i)} {q}')
            for letter, rec, text, cost in opts:
                L.append(f'   {letter} {"✅ " if rec else "   "}{text}{"（推荐）" if rec else ""} —— 代价：{cost}')
            L.append('')
    L += ['## 已关闭', '', '（暂无）', '']
    return '\n'.join(L)


def write(path, text, force):
    if os.path.exists(path) and not force:
        return False
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return True


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--pack')
    ap.add_argument('--target', choices=['doc', 'outline', 'both'], default='both')
    ap.add_argument('--force', action='store_true'); ap.add_argument('--stdout', action='store_true')
    ap.add_argument('--add-section', action='append', default=[])
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    run_dir = os.path.abspath(os.path.expanduser(a.run_dir))
    if not os.path.isdir(run_dir):
        print(json.dumps({'ok': False, 'message': f'运行目录不存在：{run_dir}'}, ensure_ascii=False)); return 2
    meta, meta_name = al.load_meta(run_dir)
    pack, pack_dir = al.find_pack(meta.get('type'), a.pack)
    if pack is None:
        print(json.dumps({'ok': False, 'message': f'找不到类型包（{meta_name} type={meta.get("type")!r}；用 --pack 或 DOC_TYPES_DIRS）'}, ensure_ascii=False)); return 2
    meta, meta_name = al.load_meta(run_dir, pack)
    try:
        al.skeleton_for(pack, meta, run_dir=run_dir)
    except (ValueError, KeyError) as ex:
        print(json.dumps({'ok': False, 'message': f'类型包 mode 无法确定：{ex}'}, ensure_ascii=False)); return 2
    if a.add_section:
        if not os.path.exists(os.path.join(run_dir, pack.get('source_file', 'doc.md'))):
            print(json.dumps({'ok': False, 'message': '正文不存在，先生成骨架'}, ensure_ascii=False)); return 2
        added, skipped, notes = add_sections(run_dir, pack, meta, a.add_section)
        print(json.dumps({'ok': not skipped, 'added': added, 'skipped': skipped, 'notes': notes}, ensure_ascii=False, indent=2))
        return 0 if not skipped else 1
    outs = {}
    if a.target in ('doc', 'both'): outs[pack.get('source_file', 'doc.md')] = build_doc(pack, meta, run_dir=run_dir)
    if a.target in ('outline', 'both'): outs[pack.get('outline_file', 'outline.md')] = build_outline(pack, meta, run_dir)
    if a.stdout:
        for k, v in outs.items(): print(f'===== {k} =====\n{v}')
        return 0
    written, kept = [], []
    for name, text in outs.items():
        (written if write(os.path.join(run_dir, name), text, a.force) else kept).append(name)
    sk = al.skeleton_for(pack, meta, run_dir=run_dir)
    print(json.dumps({'ok': not kept, 'written': written, 'kept_existing': kept, 'pack': pack['id'], 'sections': len(sk),
                      'required': sum(1 for s in sk if s.get('required')),
                      'message': ('已存在未覆盖：' + '、'.join(kept) + '（加 --force 覆盖）') if kept else ''}, ensure_ascii=False, indent=2))
    return 1 if kept else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
