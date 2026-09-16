#!/usr/bin/env python3
"""运行目录进度摘要（人读）。只读：判定逻辑复用 advance.plan，不执行任何步骤。
用法：status.py <运行目录> [--json] [--pack 类型包目录]
退出码：0 成功；2 运行目录不存在。"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import advance  # noqa: E402

LABEL = {'passed': '通过', 'skipped': '跳过', 'waived': '豁免', 'failed': '失败', 'pending': '待办'}
ACTOR = {'script': '脚本（advance --run 可自动执行）', 'user': '用户确认', 'author': '写作者（doc-author）', 'codex': 'Codex 两轮 + 主代理',
         'orchestrator': '主代理', 'none': '无'}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--json', action='store_true'); ap.add_argument('--pack')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    rd = os.path.abspath(os.path.expanduser(a.run_dir))
    if not os.path.isdir(rd):
        print(f'运行目录不存在：{rd}'); return 2
    p = advance.plan(rd, a.pack)
    if a.json:
        print(json.dumps(p, ensure_ascii=False, indent=2)); return 0
    state = advance.load_json(os.path.join(rd, 'run-state.json')) or {}
    meta = advance.load_json(os.path.join(rd, 'doc.json')) or {}
    L = [f'{meta.get("title", "（无标题）")}　{p.get("type", "?")} v{p.get("version", "?")}　模式 {p.get("mode", "?")}　阶段 {p.get("stage", "?")}', rd, '']
    L.append('门　状态　时间　　　　　　　　　　证据 / 原因')
    for g, v in (state.get('gates') or {}).items():
        ev = '；'.join(v.get('evidence') or []) or v.get('reason') or ''
        L.append(f'{g}　{LABEL.get(v.get("status"), v.get("status"))}　{(v.get("at") or "—"):<25}　{ev[:60]}')
    art = p.get('artifacts') or {}
    L += ['', '产物：']
    fc = art.get('fill_check')
    if fc: L.append(f'- 正文：占位符 {fc["placeholders"]} 处，写作提示注释 {fc.get("hints") or 0} 处')
    fs = art.get('figures')
    if fs: L.append(f'- 图：图源 {fs["sources"]} 个，' + ('需重建（' + fs['why'] + '）' if fs['stale'] else f'已构建，必改 {fs["must_fix"]}'))
    r = art.get('render')
    if r: L.append(f'- 渲染：PDF {r.get("pages")} 页，版式必改 {r.get("layout_must_fix")}')
    q = art.get('qa')
    if q: L.append(f'- 质检：必改 {q.get("must_fix")}，共 {q.get("total")} 条')
    x = art.get('xref')
    if x: L.append(f'- 交叉引用：悬空 {x["dangling"]}，下游 {x["downstream"]} 份')
    if os.path.exists(os.path.join(rd, 'published.json')): L.append('- 已发布（published.json）')
    L += ['', f'下一步：{p.get("step")}　由 {ACTOR.get(p.get("actor"), p.get("actor"))}']
    if p.get('next_command'): L.append(f'  {p["next_command"]}')
    if p['blocking_reasons']:
        L += ['', '阻塞：'] + [f'- {b}' for b in p['blocking_reasons']]
    if p['warnings']:
        L += ['', '提示：'] + [f'- {w}' for w in p['warnings'][:12]]
    print('\n'.join(L))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
