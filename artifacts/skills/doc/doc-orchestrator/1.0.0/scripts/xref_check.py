#!/usr/bin/env python3
"""跨文档交叉引用复查（版本迭代后必跑）。只读，不写任何运行目录。
用法：xref_check.py <运行目录> [--scan 根目录] [--no-downstream] [--pack 本文档类型包目录]
（--pack 只作用于本文档；关联文档的类型包按 DOC_TYPES_DIRS → doc-shared/types 查找）
上游方向（本文档 doc.json related_docs 登记的文档）：
  - 登记版本与对方当前版本不一致 → 复查提示
  - 本文正文与表格（含数据块）里出现、符合对方类型包 numbering.entities 格式、但对方文档里没有定义的编号 → 悬空引用（阻塞）
    只查「依据型」关系（role 为 source_*、executes_plan、reports_on）；role 必填，缺 role 的条目按无法解析给警告
下游方向（谁引用了本文档）：
  - 扫描 --scan（默认运行目录的上一级，即项目目录；跨项目引用时显式给更上层目录，最多 2000 个运行目录）下的 doc.json，related_docs 解析到本运行目录或
    run-state base_doc（改版前的旧目录）的 → 需要复查的下游文档；登记版本与本文档当前版本不一致时标 stale
  - 下游文档引用了本文档当前版本没有定义的编号（含改版时旧目录有、新版删掉的）→ 逐条列出（提示对方改版）
  扫描只看正文与表格（含数据块），代码块与 HTML 注释（含行内起始、跨行，与 fill_check、trace_matrix 同一份遮蔽：doc-shared/scripts/code_scan.py）不算；
  编号边界匹配、简写续号（如 X-A-01/02 → X-A-01、X-A-02）展开同 code_scan.find_codes；路径一律 realpath 比较
输出 JSON：{ok, upstream[], dangling[], downstream[], removed_codes{}, downstream_hits[], blocking_reasons[], warnings[]}。
退出码：0 无阻塞；3 有悬空引用；2 用法错误。"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(SKILLS, 'doc-author', 'scripts'))
import authorlib as al  # noqa: E402
import related as relmod  # noqa: E402  （authorlib 已把 doc-shared/scripts 加进 sys.path）
import code_scan as cs  # noqa: E402
sys.path.insert(0, HERE)
from orchlib import same_version  # noqa: E402

UPSTREAM_ROLES = {'source_mrd', 'source_prd', 'source_spec', 'executes_plan', 'reports_on'}
SKIP_DIRS = {'out', 'base', '.git', 'node_modules', 'figures', 'data', 'sections', '__pycache__'}


def load_doc(run_dir, pack_arg=None):
    meta, _ = al.load_meta(run_dir)
    pack, _ = al.find_pack(meta.get('type'), pack_arg)
    if pack is None or not os.path.exists(os.path.join(run_dir, pack.get('source_file', 'doc.md'))):
        return meta, pack, None
    return meta, pack, al.parse(run_dir, pack)


def haystack(doc):
    rows = list(cs.visible_lines(doc.lines))   # 代码块与 HTML 注释遮蔽：doc-shared/scripts/code_scan.py（与 fill_check、trace_matrix 同一口径）
    for t in doc.tables:
        if t.get('source') != 'data':   # Markdown 表格的单元格已在遮蔽后的行里扫过；再追加原始单元格会绕过注释遮蔽
            continue
        for r in t.get('rows') or []:
            rows.append((t.get('line', 0), ' '.join(str(c) for c in r)))
    return rows


def find_codes(doc, pattern):
    """{编号: 首次出现行号}：边界匹配与简写续号展开见 code_scan.find_codes。"""
    return cs.scan_codes(haystack(doc), pattern)


def defined(doc, kind):
    return {e['code'] for e in (doc.entities.get(kind) or [])}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--scan'); ap.add_argument('--no-downstream', action='store_true'); ap.add_argument('--pack')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    run_dir = os.path.realpath(os.path.expanduser(a.run_dir))
    if not os.path.exists(os.path.join(run_dir, 'doc.json')):
        print(json.dumps({'ok': False, 'message': f'{run_dir} 没有 doc.json'}, ensure_ascii=False)); return 2
    meta, pack, doc = load_doc(run_dir, a.pack)
    if pack is None or doc is None:
        print(json.dumps({'ok': False, 'message': '找不到类型包或正文（自定义类型包用 --pack）'}, ensure_ascii=False)); return 2
    blocking, warnings, upstream, dangling = [], [], [], []
    for rd in relmod.Related(run_dir, meta=meta).docs:
        ent = rd.summary(); upstream.append(ent)
        if not rd.ok:
            warnings.append(f'关联文档 {rd.type}（role={rd.role}）无法解析：{rd.error}'); continue
        cur_v = (rd.meta or {}).get('version')
        if rd.version and not same_version(rd.version, cur_v):
            ent['version_mismatch'] = f'登记版本 {rd.version}，对方当前版本 {cur_v}'
            warnings.append(f'关联文档 {rd.type}「{(rd.meta or {}).get("title")}」已变版本（登记 {rd.version}，当前 {cur_v}）：复查本文引用的编号、口径与章节引用，确认后把 related_docs.version 改成对方当前版本')
        else:
            ent['version_mismatch'] = None
        _, rpack, rdoc = load_doc(rd.run_dir)
        if rpack is None or rdoc is None:
            continue
        for e in (rpack.get('numbering') or {}).get('entities') or []:
            if rd.role not in UPSTREAM_ROLES:
                continue
            have = defined(rdoc, e['kind'])
            for code, ln in sorted(find_codes(doc, e['pattern']).items()):
                if code not in have:
                    dangling.append({'code': code, 'kind': e['kind'], 'line': ln, 'related_type': rd.type, 'related_dir': rd.run_dir})
    if dangling:
        blocking.append(f'引用了关联文档里不存在的编号 {len(dangling)} 个：' + '、'.join(f'{d["code"]}（第 {d["line"]} 行，{d["related_type"]}）' for d in dangling[:8]))
    downstream, hits, removed = [], [], {}
    if not a.no_downstream:
        state = {}
        sp = os.path.join(run_dir, 'run-state.json')
        if os.path.exists(sp):
            state = json.load(open(sp, encoding='utf-8'))
        targets = {run_dir}
        base = state.get('base_doc')
        base_dir = os.path.realpath(os.path.expanduser(base)) if base and os.path.isdir(os.path.expanduser(base)) else None
        if base_dir:
            targets.add(base_dir)
            _, bpack, bdoc = load_doc(base_dir)
            if bdoc is not None:
                for e in (pack.get('numbering') or {}).get('entities') or []:
                    gone = sorted(defined(bdoc, e['kind']) - defined(doc, e['kind']))
                    if gone: removed[e['kind']] = {'codes': gone, 'pattern': e['pattern']}
        root = os.path.realpath(os.path.expanduser(a.scan)) if a.scan else os.path.dirname(run_dir)
        scanned = 0
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.startswith('.')]
            if dp.count(os.sep) - root.count(os.sep) > 5:
                dns[:] = []
            if 'doc.json' not in fns or os.path.realpath(dp) in targets:
                continue
            scanned += 1
            if scanned > 2000:
                warnings.append(f'下游扫描超过 2000 个运行目录已停止：用 --scan 缩小到项目目录'); break
            try:
                other = relmod.Related(dp)
            except (OSError, json.JSONDecodeError):
                continue
            for od in other.docs:
                if os.path.realpath(od.run_dir) not in targets:
                    continue
                item = {'run_dir': os.path.realpath(dp), 'type': other.meta.get('type'), 'title': other.meta.get('title'), 'role': od.role,
                        'registered_version': od.version, 'points_to_old_dir': os.path.realpath(od.run_dir) != run_dir,
                        'stale': bool((od.version and not same_version(od.version, meta.get('version'))) or os.path.realpath(od.run_dir) != run_dir)}
                downstream.append(item)
                _, _, odoc = load_doc(dp)
                if odoc is not None:
                    # 按本文档「当前」实体集核对下游引用：下游仍指向旧目录时，旧目录里还在的编号在新版可能已删
                    for e in (pack.get('numbering') or {}).get('entities') or []:
                        cur = defined(doc, e['kind'])
                        found = find_codes(odoc, e['pattern'])
                        gone = sorted(c for c in found if c not in cur)
                        if gone:
                            hits.append({'run_dir': item['run_dir'], 'type': item['type'], 'kind': e['kind'], 'codes': gone,
                                         'removed_in_this_version': sorted(set(gone) & set((removed.get(e['kind']) or {}).get('codes') or []))})
        for d in downstream:
            if d['stale']:
                warnings.append(f'下游文档 {d["type"]}「{d["title"]}」登记的是 ' + (f'旧目录' if d['points_to_old_dir'] else f'v{d["registered_version"]}') +
                                f'，本文档当前 v{meta.get("version")}：通知其负责人复查并更新 related_docs')
        for h in hits:
            warnings.append(f'下游文档 {h["type"]}（{h["run_dir"]}）引用了本文档 v{meta.get("version")} 未定义的编号：' + '、'.join(h['codes'])
                            + ('（其中本版删除：' + '、'.join(h['removed_in_this_version']) + '）' if h['removed_in_this_version'] else ''))
    out = {'ok': not blocking, 'run_dir': run_dir, 'type': meta.get('type'), 'version': meta.get('version'), 'upstream': upstream, 'dangling': dangling,
           'downstream': downstream, 'removed_codes': {k: v['codes'] for k, v in removed.items()}, 'downstream_hits': hits,
           'blocking_reasons': blocking, 'warnings': warnings}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 3 if blocking else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
