#!/usr/bin/env python3
"""跨文档读取：解析 doc.json 的 related_docs，读对方文档的元数据与运行目录内文件（如 data/*.csv）。
库用法（doc-qa 的 ctx.related 基于它；类型包 D2 门脚本也可直接用）：
  from related import Related, missing_issue
  rel = Related(run_dir)                         # 读 run_dir/doc.json；也可传 meta=dict
  d = rel.find('prd', role='source_prd')         # 返回 RelatedDoc 或 None；同条件命中多份时抛 AmbiguousRelated
  if d is None or not d.ok: issues.append(missing_issue('XX2', 'prd', role='source_prd', for_gate=True, detail=d and d.error))
  rows = d.read_csv('data/requirements.csv')     # list[dict]，路径不得越出对方运行目录
  codes = d.column('data/requirements.csv', '需求编号')
CLI（排查用）：
  related.py <运行目录> [--meta doc.json] [--type T] [--role R] [--csv data/x.csv [--column 列名]]
输出 JSON：每条 related_docs 的解析结果（found、对方 type 与 version、不一致、错误）以及可选的 CSV 摘要。
role 必填（2026-09-15 契约第二轮）：缺 role 的条目解析结果 ok=False、error 说明缺 role，find / all 按 role 过滤时不会命中它。
path 规则：相对路径按当前运行目录解析，也可写绝对路径（支持 ~）；可以指向对方运行目录，也可以指向对方的 doc.json。
缺失定级：关联文档找不到或读不出时，D2 门相关的检查定「必改」，其余定「提示」（missing_severity）。
退出码：0 全部解析成功；1 有缺失、类型不符或 CSV 读取失败；2 用法错误。"""
import argparse, csv, io, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from versions import same_version  # noqa: E402


class RelatedError(Exception):
    pass


class AmbiguousRelated(RelatedError):
    pass


def missing_severity(for_gate):
    return '必改' if for_gate else '提示'


def missing_issue(rule, doc_type, role=None, for_gate=False, detail=''):
    who = doc_type + (f'（role={role}）' if role else '')
    msg = f'关联文档 {who} 找不到或无法读取' + (f'：{detail}' if detail else '') + '；在 doc.json related_docs 登记正确的 path'
    return {'rule': rule, 'severity': missing_severity(for_gate), 'line': 0, 'excerpt': who[:120], 'message': msg}


def resolve_entry_path(base_run_dir, path):
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(base_run_dir, p)
    p = os.path.normpath(p)
    if p.endswith('.json'):
        return os.path.dirname(p), p
    return p, os.path.join(p, 'doc.json')


class RelatedDoc:
    def __init__(self, base_run_dir, entry):
        self.entry = entry
        self.type = entry.get('type')
        self.role = entry.get('role')
        self.title = entry.get('title')
        self.version = entry.get('version')
        self.run_dir, self.doc_json_path = resolve_entry_path(base_run_dir, entry.get('path', ''))
        self.meta, self.error, self.version_mismatch = None, None, None
        if not entry.get('path'):
            self.error = 'related_docs 条目缺 path'
        elif not entry.get('role'):
            self.error = 'related_docs 条目缺 role（必填，见 doc-shared/references/artifacts.md §2.1；一般参考写 references）'
        elif not os.path.isdir(self.run_dir):
            self.error = f'运行目录不存在：{self.run_dir}'
        elif not os.path.exists(self.doc_json_path):
            self.error = f'找不到 {self.doc_json_path}'
        else:
            try:
                self.meta = json.load(open(self.doc_json_path, encoding='utf-8'))
            except (OSError, json.JSONDecodeError) as ex:
                self.error = f'doc.json 读取失败：{ex}'
        if self.meta is not None:
            if self.meta.get('type') != self.type:
                self.error = f'类型不符：related_docs 写 {self.type}，对方 doc.json type 为 {self.meta.get("type")}'
            if self.version and not same_version(self.version, self.meta.get('version', '')):   # 1.0 = 1.0.0（versions.py）
                self.version_mismatch = f'登记版本 {self.version}，对方当前版本 {self.meta.get("version")}'

    @property
    def ok(self):
        return self.error is None

    def _safe(self, rel):
        if not self.ok:
            raise RelatedError(self.error)
        full = os.path.realpath(os.path.join(self.run_dir, rel))
        root = os.path.realpath(self.run_dir)
        if os.path.isabs(rel) or not (full == root or full.startswith(root + os.sep)):
            raise RelatedError(f'路径越出关联文档运行目录：{rel}')
        return full

    def exists(self, rel):
        return os.path.exists(self._safe(rel))

    def read_text(self, rel):
        return open(self._safe(rel), encoding='utf-8').read()

    def read_json(self, rel):
        return json.loads(self.read_text(rel))

    def read_csv(self, rel):
        text = open(self._safe(rel), encoding='utf-8-sig').read()
        return [dict(r) for r in csv.DictReader(io.StringIO(text))]

    def column(self, rel, name):
        rows = self.read_csv(rel)
        if rows and name not in rows[0]:
            raise RelatedError(f'{rel} 没有列「{name}」，现有列：{list(rows[0].keys())}')
        return [r[name].strip() for r in rows if r.get(name) is not None]

    def summary(self):
        return {'type': self.type, 'role': self.role, 'title': self.title, 'path': self.entry.get('path'), 'run_dir': self.run_dir,
                'found': self.ok, 'meta_type': (self.meta or {}).get('type'), 'meta_version': (self.meta or {}).get('version'),
                'version_mismatch': self.version_mismatch, 'error': self.error}


class Related:
    def __init__(self, run_dir, meta=None, meta_file='doc.json'):
        self.run_dir = os.path.abspath(run_dir)
        if meta is None:
            mp = os.path.join(self.run_dir, meta_file)
            meta = json.load(open(mp, encoding='utf-8')) if os.path.exists(mp) else {}
        self.meta = meta
        self.docs = [RelatedDoc(self.run_dir, e) for e in (meta.get('related_docs') or [])]

    def all(self, doc_type=None, role=None):
        return [d for d in self.docs if (doc_type is None or d.type == doc_type) and (role is None or d.role == role)]

    def find(self, doc_type, role=None, title=None):
        hits = [d for d in self.all(doc_type, role) if title is None or d.title == title]
        if len(hits) > 1:
            raise AmbiguousRelated(f'related_docs 中 type={doc_type}' + (f' role={role}' if role else '') + f' 命中 {len(hits)} 份，请指定 role 或 title')
        return hits[0] if hits else None


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--meta', default='doc.json')
    ap.add_argument('--type'); ap.add_argument('--role'); ap.add_argument('--csv'); ap.add_argument('--column')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    if not os.path.isdir(a.run_dir):
        print(json.dumps({'ok': False, 'message': f'运行目录不存在：{a.run_dir}'}, ensure_ascii=False)); return 2
    rel = Related(a.run_dir, meta_file=a.meta)
    docs = rel.all(a.type, a.role)
    out = {'run_dir': rel.run_dir, 'related': [d.summary() for d in docs]}
    ok = all(d.ok for d in docs) and (bool(docs) or not (a.type or a.role))
    if (a.type or a.role) and not docs:
        out['message'] = '没有符合条件的 related_docs 条目'
    if a.csv:
        if len(docs) != 1:
            out['csv'] = {'error': f'--csv 需要条件恰好命中 1 份，当前 {len(docs)} 份'}; ok = False
        else:
            try:
                rows = docs[0].read_csv(a.csv)
                info = {'file': a.csv, 'rows': len(rows), 'columns': list(rows[0].keys()) if rows else []}
                if a.column: info['values'] = docs[0].column(a.csv, a.column)
                out['csv'] = info
            except (RelatedError, OSError) as ex:
                out['csv'] = {'file': a.csv, 'error': str(ex)}; ok = False
    out['ok'] = ok
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
