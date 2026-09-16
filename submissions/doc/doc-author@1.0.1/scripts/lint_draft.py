#!/usr/bin/env python3
"""写作期快检：在运行目录的临时副本上跑 doc-qa 的规则子集，只报指定章节的问题。不写真运行目录（qa-result.json、
qa-report.md、run-state 都不动），所以不会让 D3 读到子集结果。
用法：lint_draft.py <运行目录> [--section id|标题|编号] [--rules L1,T3,…] [--all-lines] [--pack 类型包目录]
默认规则：doc-qa 引擎全部规则，去掉需要全文或渲染后才有意义的 L4 L6（图检查）、S1（必备章节，交给 fill_check）、
X2（未被引用，写完才准）、C1（版本一致）、H2（按页高亮，需渲染）；类型包 engine_rules 的 include / exclude 照常生效。
--section：只保留该章节行号区间内的问题（行号按 include 展开后的正文，与 qa-result 一致）；全文级（line 0）问题默认丢弃，--all-lines 保留。
输出 JSON：{ok, rules, section, must_fix, counts{定级: 数}, issues[]}。
退出码：0 所选范围无必改；3 有必改；2 用法错误；4 doc-qa 故障。"""
import argparse, json, os, shutil, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import authorlib as al  # noqa: E402

QA_DIR = os.path.join(al.SKILLS, 'doc-qa', 'scripts')
NOT_DRAFT = {'L4', 'L6', 'S1', 'X2', 'C1', 'H2'}
SKIP = {'out', 'base', '.git'}
SKIP_FILES = {'qa-result.json', 'qa-report.md', 'run-state.json', 'run-state.json.lock', 'published.json'}


def default_rules():
    sys.path.insert(0, QA_DIR)
    import engine_rules
    return [c for c in engine_rules.ORDER if c not in NOT_DRAFT]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--section'); ap.add_argument('--rules'); ap.add_argument('--all-lines', action='store_true')
    ap.add_argument('--pack')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    rd = os.path.abspath(os.path.expanduser(a.run_dir))
    meta, _ = al.load_meta(rd)
    pack, pack_dir = al.find_pack(meta.get('type'), a.pack)
    if pack is None:
        print(json.dumps({'ok': False, 'message': '找不到类型包'}, ensure_ascii=False)); return 2
    rules = [x.strip() for x in a.rules.split(',')] if a.rules else default_rules()
    rng = None
    if a.section:
        doc = al.parse(rd, pack)
        sec = doc.section(a.section)
        if sec is None:
            print(json.dumps({'ok': False, 'message': f'找不到章节 {a.section}', 'headings': [f'{h["number"]} {h["plain"]}' for h in doc.headings]}, ensure_ascii=False)); return 2
        rng = (sec['start'], sec['end'])
    tmp = tempfile.mkdtemp(prefix='lint-draft-')
    try:
        work = os.path.join(tmp, os.path.basename(rd))
        shutil.copytree(rd, work, ignore=lambda d, names: [n for n in names if (d == rd and (n in SKIP or n in SKIP_FILES))])
        dj = os.path.join(work, 'doc.json')
        if os.path.exists(dj):
            m = json.load(open(dj, encoding='utf-8'))
            for e in m.get('related_docs') or []:
                p = os.path.expanduser(e.get('path', ''))
                if p and not os.path.isabs(p): e['path'] = os.path.normpath(os.path.join(rd, p))
            json.dump(m, open(dj, 'w', encoding='utf-8'), ensure_ascii=False)
        cmd = [sys.executable, os.path.join(QA_DIR, 'qa.py'), work, '--only', ','.join(rules), '--no-state', '--no-hooks', '--quiet', '--pack', pack_dir]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        qp = os.path.join(work, 'qa-result.json')
        if r.returncode not in (0, 3) or not os.path.exists(qp):
            print(json.dumps({'ok': False, 'message': f'doc-qa 退出码 {r.returncode}', 'detail': (r.stdout + r.stderr)[-600:]}, ensure_ascii=False)); return 4
        issues = json.load(open(qp, encoding='utf-8'))['issues']
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if rng:
        issues = [x for x in issues if (x['line'] == 0 and a.all_lines) or rng[0] <= x['line'] <= rng[1]]
    elif not a.all_lines:
        issues = [x for x in issues if x['line'] != 0 or x['severity'] == '必改']
    counts = {k: sum(1 for x in issues if x['severity'] == k) for k in ('必改', '建议', '提示')}
    print(json.dumps({'ok': counts['必改'] == 0, 'rules': rules, 'section': a.section, 'range': rng, 'must_fix': counts['必改'], 'counts': counts, 'issues': issues}, ensure_ascii=False, indent=2))
    return 3 if counts['必改'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
