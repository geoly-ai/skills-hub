#!/usr/bin/env python3
"""跨文档追踪矩阵：需求（PRD）→ 设计章节（tech-spec）→ 测试项（test-cases 实体）→ 执行结果与缺陷（test-report）。只读关联文档，只写输出文件。
用法：
  trace_matrix.py <运行目录> [--prd 目录] [--spec 目录] [--plan 目录] [--cases 目录] [--report 目录] [--scan 根目录]
                  [--out 目录（默认 <运行目录>/out）] [--snippet sections/trace-matrix.md [--force]] [--print]
发现：从输入运行目录出发，沿各文档 doc.json related_docs 广度优先遍历（realpath 去重，最多 MAX_DOCS 份）；--scan 另扫该目录下
  related_docs 指回已发现文档的下游 doc.json（跳过 out、data、figures 等目录，深度 ≤ 5，最多 2000 个运行目录）。同一类型命中多份
  且没有显式 --prd/--spec/--plan/--cases/--report 时退出 2 并列出 candidates。类型包只从 DOC_TYPES_DIRS 与 doc-shared/types 加载并过 pack schema。
取数：
  需求   PRD 类型包 numbering.entities 定义的实体（表格或数据块首列）；标题优先取 PRD data/*.csv 同编号行的「标题」列。
  设计   tech-spec 正文逐行扫描（遮蔽围栏代码块与 HTML 注释）与数据块表格行，按 PRD 实体正则找编号，支持简写续号「REQ-RULE-01/02」；
         只统计第一个标题之后的正文（摘要不算设计覆盖），命中处归到所在最深标题。
  测试项 test-cases 类型包实体；「关联需求」列（列名含「需求」）按正则提取编号，可多个。显示名取该实体的 label（labels.case）。
  结果   test-report 运行目录 data/*.csv 与正文表格：有一列多数单元格含测试项编号（test-cases 实体正则）、有状态或结果列、且状态值多数属于受控词表的表为执行表；
         有一列多数为缺陷编号（report 类型包实体正则）、另一列含测试项编号的表为缺陷表。列按单元格取值识别，不认列名。状态词表见 STATUS。
         同一测试项多条不同结果记 result_conflict，保留先出现的（CSV 先于正文表格）。
  版本   各文档 related_docs 登记的 version 与对方 doc.json 当前 version 比较（versions.same_version，1.0 = 1.0.0 = v1.0）。
输出：<out>/trace-matrix.json（schemas/trace-matrix.schema.json，写出前自校验；默认 out/ 为符号链接或越出运行目录时拒绝）与 <out>/trace-matrix.md（DocMark 片段：需求追踪矩阵表 +
  追踪缺口表，无标题，可 include）；--snippet 另写一份到本文档类型包 include_allow 允许的运行目录内路径（已有文件必须是本脚本生成的，
  否则要 --force；拒绝符号链接；写入会改变源文件，D3 签门清单需重新签）。stdout 输出摘要 JSON（--print 输出完整矩阵）。
缺口 kind 与定级见 GAP_RULES；退出码：0 无必改缺口；3 有必改缺口；2 用法错误、类型歧义、PRD 缺失或无需求、文档或类型包读取失败、输出不合 schema。"""
import argparse, copy, csv, datetime, fnmatch, io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_SHARED = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import docmark_parse as dp  # noqa: E402
import related as relmod  # noqa: E402
import validate  # noqa: E402
try:
    from versions import same_version  # noqa: E402  （doc-shared 共用的版本规范化，唯一实现）
except ImportError:  # pragma: no cover  versions.py 缺失时的兜底，口径相同
    def same_version(a, b):
        def p(v):
            m = re.match(r'^v?(\d+)\.(\d+)(?:\.(\d+))?$', str(v or '').strip())
            return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)) if m else None
        pa, pb = p(a), p(b)
        return pa == pb if pa and pb else str(a or '').strip().lstrip('v') == str(b or '').strip().lstrip('v')

SCHEMA_PATH = os.path.join(DOC_SHARED, 'schemas', 'trace-matrix.schema.json')
TYPES = ('prd', 'tech-spec', 'test-plan', 'test-cases', 'test-report')
OVERRIDE_FLAGS = {'prd': 'prd', 'tech-spec': 'spec', 'test-plan': 'plan', 'test-cases': 'cases', 'test-report': 'report'}
MAX_DOCS = 50
MAX_SCAN = 2000
SKIP_DIRS = {'out', 'base', '.git', 'node_modules', 'figures', 'data', 'sections', '__pycache__'}
MARKER = '<!-- generated: doc-shared/scripts/trace_matrix.py，重跑覆盖，请勿手改 -->'
STATUS = {'通过': 'passed', 'pass': 'passed', 'passed': 'passed', '成功': 'passed',
          '失败': 'failed', 'fail': 'failed', 'failed': 'failed', '不通过': 'failed',
          '阻塞': 'blocked', 'blocked': 'blocked', '受阻': 'blocked',
          '未执行': 'not_executed', '跳过': 'not_executed', 'skipped': 'not_executed', 'not run': 'not_executed', '待执行': 'not_executed'}
STATUS_CN = {'passed': '通过', 'failed': '失败', 'blocked': '阻塞', 'not_executed': '未执行', None: '无结果'}
# kind: (中文名, 定级函数)
# 缺口中文名模板：{case} 取 test-cases 类型包实体 label（引擎不写死业务词）
GAP_LABEL = {'doc_missing': '关联文档缺失', 'req_not_designed': '需求未被设计覆盖', 'req_no_cases': '需求没有{case}', 'case_unknown_req': '{case}指向的需求不存在',
             'case_no_req': '{case}未写关联需求', 'case_no_result': '{case}没有执行结果', 'result_unknown_case': '执行结果指向的{case}不存在',
             'result_invalid_status': '执行状态不在词表内', 'result_conflict': '同一{case}执行结果冲突', 'report_no_execution': '报告里找不到执行结果表',
             'defect_unknown_case': '缺陷关联的{case}不存在', 'duplicate_code': '编号重复', 'version_mismatch': '登记版本与对方当前版本不一致'}
DEFAULT_CASE_LABEL = '测试项'


def high(priority):
    return str(priority or '').strip().upper() in ('P0', 'P1')


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


class Fail(Exception):
    def __init__(self, message, **extra):
        super().__init__(message); self.message = message; self.extra = extra


# ---------------------------------------------------------------- 类型包与文档

def trusted_roots():
    roots = [os.path.expanduser(d) for d in os.environ.get('DOC_TYPES_DIRS', '').split(':') if d.strip()]
    roots.append(os.path.join(DOC_SHARED, 'types'))
    return [os.path.realpath(r) for r in roots if os.path.isdir(r)]


def find_pack(doc_type):
    if not doc_type or not re.match(r'^[a-z0-9][a-z0-9-]*$', str(doc_type)):
        raise Fail(f'doc.json type 不合法：{doc_type!r}')
    for root in trusted_roots():
        pdir = os.path.realpath(os.path.join(root, doc_type))
        pj = os.path.join(pdir, 'pack.json')
        if not os.path.isfile(pj):
            continue
        if not (pdir == root or pdir.startswith(root + os.sep)):
            raise Fail(f'类型包 {doc_type} 经符号链接指向可信目录之外：{pdir}')
        try:
            pack = json.load(open(pj, encoding='utf-8'))
        except (OSError, ValueError) as ex:
            raise Fail(f'类型包 {pj} 读取失败：{ex}')
        errs, _ = validate.validate_data('pack', pack, pdir)
        if errs:
            raise Fail(f'类型包 {pj} 不合 pack schema：' + '；'.join(f'{p} {m}' for p, m in errs[:3]))
        return pack, pdir
    raise Fail(f'找不到类型包 {doc_type}（查找 DOC_TYPES_DIRS 与 doc-shared/types）')


def load_meta(run_dir):
    p = os.path.join(run_dir, 'doc.json')
    try:
        meta = json.load(open(p, encoding='utf-8'))
    except (OSError, ValueError) as ex:
        raise Fail(f'{p} 读取失败：{ex}')
    if not isinstance(meta, dict):
        raise Fail(f'{p} 不是 JSON 对象')
    return meta


class Doc:
    def __init__(self, run_dir, meta=None):
        self.run_dir = os.path.realpath(run_dir)
        self.meta = meta if meta is not None else load_meta(self.run_dir)
        self.type = self.meta.get('type')
        self._pack = self._doc = None

    @property
    def pack(self):
        if self._pack is None:
            self._pack, self.pack_dir = find_pack(self.type)
        return self._pack

    @property
    def doc(self):
        if self._doc is None:
            src = self.pack.get('source_file', 'doc.md')
            if not os.path.isfile(os.path.join(self.run_dir, src)):
                raise Fail(f'{self.type} 正文不存在：{os.path.join(self.run_dir, src)}')
            try:
                self._doc = dp.parse_file(self.run_dir, src, pack=self.pack)
            except (OSError, ValueError, dp.SourcePathError) as ex:
                raise Fail(f'{self.type} 正文解析失败：{ex}')
        return self._doc

    def entity_defs(self):
        return [e for e in (self.pack.get('numbering') or {}).get('entities') or [] if e.get('kind') and e.get('pattern')]

    def safe_path(self, rel):
        full = os.path.realpath(os.path.join(self.run_dir, rel))
        if not (full == self.run_dir or full.startswith(self.run_dir + os.sep)):
            raise Fail(f'路径越出 {self.type} 运行目录：{rel}')
        return full

    def data_csvs(self):
        d = os.path.join(self.run_dir, 'data')
        if not os.path.isdir(d):
            return []
        out = []
        for f in sorted(os.listdir(d)):
            if f.endswith('.csv'):
                rel = 'data/' + f
                full = self.safe_path(rel)
                try:
                    text = open(full, encoding='utf-8-sig').read()
                except OSError as ex:
                    raise Fail(f'{self.type} {rel} 读取失败：{ex}')
                rd = csv.reader(io.StringIO(text))
                header = [h.strip() for h in next(rd, [])]
                rows = []
                for r in rd:
                    if any(c.strip() for c in r):
                        rows.append((rd.line_num, dict(zip(header, [c.strip() for c in r]))))
                out.append({'file': rel, 'header': header, 'rows': rows})
        return out


def discover(start, scan_root=None):
    found, warnings = {}, []
    queue = [os.path.realpath(start)]

    def bfs():
        while queue:
            rd = queue.pop(0)
            if rd in found:
                continue
            if len(found) >= MAX_DOCS:
                warnings.append(f'关联文档超过 {MAX_DOCS} 份，停止遍历'); queue.clear(); return
            try:
                meta = load_meta(rd)
            except Fail as ex:
                if rd == os.path.realpath(start):
                    raise
                warnings.append(ex.message); continue
            found[rd] = Doc(rd, meta)
            for r in relmod.Related(rd, meta=meta).docs:
                if r.ok:
                    queue.append(os.path.realpath(r.run_dir))
                else:
                    warnings.append(f'{meta.get("type")}（{rd}）的关联文档 {r.type}（role={r.role}）无法解析：{r.error}')

    bfs()
    if scan_root:
        root = os.path.realpath(os.path.expanduser(scan_root))
        for _ in range(5):
            scanned, added = 0, False
            for dpth, dns, fns in os.walk(root):
                dns[:] = sorted(d for d in dns if d not in SKIP_DIRS and not d.startswith('.'))
                if dpth.count(os.sep) - root.count(os.sep) >= 5:
                    dns[:] = []
                if 'doc.json' not in fns or os.path.realpath(dpth) in found:
                    continue
                scanned += 1
                if scanned > MAX_SCAN:
                    warnings.append(f'--scan 超过 {MAX_SCAN} 个运行目录已停止：缩小扫描根目录'); break
                try:
                    other = relmod.Related(dpth)
                except (OSError, ValueError):
                    warnings.append(f'--scan 跳过读不出的 {dpth}/doc.json'); continue
                if any(od.ok and os.path.realpath(od.run_dir) in found for od in other.docs):
                    queue.append(os.path.realpath(dpth)); added = True
            bfs()
            if not added:
                break
    return found, warnings


def choose(found, overrides):
    chosen, candidates = {}, {}
    for t in TYPES:
        if overrides.get(t):
            rd = os.path.realpath(os.path.expanduser(overrides[t]))
            if rd.endswith('.json'):
                rd = os.path.dirname(rd)
            d = found.get(rd) or Doc(rd)
            if d.type != t:
                raise Fail(f'--{OVERRIDE_FLAGS[t]} 指向的文档类型是 {d.type}，不是 {t}：{rd}')
            chosen[t] = d; continue
        hits = sorted((d for d in found.values() if d.type == t), key=lambda d: d.run_dir)
        if len(hits) > 1:
            candidates[t] = [d.run_dir for d in hits]
        elif hits:
            chosen[t] = hits[0]
    if candidates:
        raise Fail('同一类型找到多份文档，请用 ' + '、'.join(f'--{OVERRIDE_FLAGS[t]}' for t in candidates) + ' 指定', candidates=candidates)
    return chosen


# ---------------------------------------------------------------- 编号扫描

# 编号扫描与遮蔽统一在 code_scan.py（与 xref_check、fill_check 同一口径：只认 ``` 围栏、注释遮蔽同 masked_lines）；
# 名字保留为本模块属性，调用方与自测不变。
from code_scan import code_regex, find_codes, visible_lines  # noqa: E402,F401


def heading_at(doc, line):
    cur = None
    for h in doc.headings:
        if h['line'] <= line:
            cur = h
        else:
            break
    return cur


def col(header, *keys, exclude=()):
    for k in keys:
        for h in header:
            if k in h and not any(x in h for x in exclude):
                return h
    return None


def code_col(hdr, rows, finder, skip=()):
    """按单元格取值找编号列：多数（≥ 一半）行含编号的列里命中最多的一列；没有返回 None。"""
    best = None
    for h in hdr:
        if h in skip:
            continue
        n = sum(1 for _, r in rows if finder(r.get(h) or ''))
        if n and n * 2 >= len(rows) and (best is None or n > best[1]):
            best = (h, n)
    return best[0] if best else None


def records_of(t):
    return t.get('records_full') or t.get('records') or []


# ---------------------------------------------------------------- 主体

def build(root_dir, chosen, found, warnings):
    gaps, skipped = [], []

    def gap(kind, severity, code, doc_type, message, line=None, file=None, csv_line=None):
        gaps.append({'kind': kind, 'severity': severity, 'code': code, 'doc_type': doc_type, 'line': line, 'file': file, 'csv_line': csv_line, 'message': message})

    prd = chosen.get('prd')
    if prd is None:
        raise Fail('找不到 PRD（沿 related_docs 未发现 type=prd 的文档）：追踪矩阵以 PRD 需求为起点，用 --prd 指定')
    # ---- 需求
    req_defs = prd.entity_defs()
    if not req_defs:
        raise Fail(f'PRD 类型包没有声明 numbering.entities，无法取需求编号：{prd.pack_dir}')
    req_rx = [code_regex(e['pattern']) for e in req_defs]
    titles = {}
    for c in prd.data_csvs():
        idc = next((h for h in c['header'] if c['rows'] and all(any(f.match(r.get(h, '')) for _, f in req_rx) for _, r in c['rows'][:5])), None)
        tc = col(c['header'], '标题', '名称')
        if idc and tc:
            for _, r in c['rows']:
                titles.setdefault(r.get(idc, ''), r.get(tc, ''))
    reqs, req_index = [], {}
    for e in req_defs:
        for d in prd.doc.entities.get(e['kind']) or []:
            code = d['code']
            if code in req_index:
                gap('duplicate_code', '建议', code, 'prd', f'PRD 中需求编号 {code} 重复定义（第 {d["line"]} 行），矩阵只取第一处', line=d['line']); continue
            row = d.get('row') or {}
            hdr = list(row.keys())
            title = titles.get(code) or row.get(col(hdr, '标题', '名称') or '') or row.get(col(hdr, '描述') or '') or ''
            h = next((x for x in prd.doc.headings if x.get('number') == d.get('section_number')), None)
            item = {'code': code, 'kind': e['kind'], 'title': title[:80], 'priority': (row.get(col(hdr, '优先级') or '') or '').strip() or None,
                    'prd_section': {'number': d.get('section_number'), 'title': h['plain'] if h else None, 'line': d['line']},
                    'design': [], 'cases': [], 'defects': [], 'status': 'uncovered'}
            req_index[code] = item; reqs.append(item)
    if not reqs:
        raise Fail(f'PRD（{prd.run_dir}）没有解析出任何需求编号')

    def req_codes_in(text):
        out = []
        for rx, full in req_rx:
            out += find_codes(text, rx, full)
        return list(dict.fromkeys(out))

    # ---- 设计
    spec = chosen.get('tech-spec')
    if spec is None:
        gap('doc_missing', '建议', None, 'tech-spec', '找不到技术方案（tech-spec）：无法判断需求是否被设计覆盖')
        skipped.append({'kind': 'req_not_designed', 'reason': '缺 tech-spec'})
    else:
        sdoc = spec.doc
        first = sdoc.headings[0]['line'] if sdoc.headings else None
        hits = []
        for ln, text in visible_lines(sdoc.lines):
            if first is not None and ln >= first:
                hits += [(c, ln) for c in req_codes_in(text)]
        for t in sdoc.tables:
            if t.get('source') == 'data' and first is not None and t['line'] >= first:
                for r in t.get('rows') or []:
                    hits += [(c, t['line']) for c in req_codes_in(' '.join(str(x) for x in r))]
        for code, ln in hits:
            item = req_index.get(code)
            if item is None:
                continue   # 设计里提到 PRD 没有的编号：属于悬空引用，由 xref_check 负责
            h = heading_at(sdoc, ln)
            key = h['line'] if h else 0
            if all(x['_key'] != key for x in item['design']):
                item['design'].append({'_key': key, 'number': (h or {}).get('number'), 'title': (h or {}).get('plain'), 'line': ln})
        for item in reqs:
            item['design'].sort(key=lambda x: x['line'])
            if not item['design']:
                gap('req_not_designed', '建议' if str(item['priority']).upper() == 'P0' else '提示', item['code'], 'tech-spec',
                    f'需求 {item["code"]}（{item["priority"] or "未标优先级"}）在技术方案正文里没有被提及', line=item['prd_section']['line'])
    # ---- 测试项（test-cases 实体）
    cases_doc = chosen.get('test-cases')
    cases, case_index = [], {}
    tc_rx = []
    CL = (next((e.get('label') for e in cases_doc.entity_defs() if e.get('label')), None) if cases_doc else None) or DEFAULT_CASE_LABEL
    labels = {'requirement': next((e.get('label') for e in req_defs if e.get('label')), None) or '需求', 'case': CL,
              'defect': (next((e.get('label') for e in chosen['test-report'].entity_defs() if e.get('label')), None) if chosen.get('test-report') else None) or '缺陷'}
    if cases_doc is None:
        gap('doc_missing', '必改', None, 'test-cases', f'找不到 test-cases 文档：无法判断需求是否有{CL}')
        skipped += [{'kind': k, 'reason': '缺 test-cases'} for k in ('req_no_cases', 'case_unknown_req', 'case_no_req', 'case_no_result')]
    else:
        cdoc = cases_doc.doc
        tc_rx = [code_regex(e['pattern']) for e in cases_doc.entity_defs()]
        tables_by_line = {t['line']: t for t in cdoc.tables}
        for e in cases_doc.entity_defs():
            for d in cdoc.entities.get(e['kind']) or []:
                code = d['code']; row = d.get('row')
                t = tables_by_line.get(d.get('table_line'))
                file = (t or {}).get('data_file')
                if code in case_index:
                    prev = case_index[code]
                    if row and prev['_row'] and row != prev['_row']:
                        gap('duplicate_code', '建议', code, 'test-cases', f'{CL}编号 {code} 重复定义且内容不同（第 {d["line"]} 行）', line=d['line'], file=file, csv_line=d.get('csv_line'))
                    continue
                if row is None:
                    continue   # 锚点式定义没有字段，不能判断关联需求
                hdr = list(row.keys())
                rc = col(hdr, '关联需求', '需求')
                refs = req_codes_in(row.get(rc, '')) if rc else []
                sec = str(d.get('section_number') or '').split('.')[0]
                h = next((x for x in cdoc.headings if x.get('number') == sec), None)
                item = {'code': code, 'title': (row.get(col(hdr, '标题', '名称') or '') or '')[:80], 'priority': (row.get(col(hdr, '优先级') or '') or '').strip() or None,
                        'module': row.get(col(hdr, '模块') or '') or (h['plain'] if h else None), 'requirements': refs, 'result': None,
                        'defects': [], 'line': d['line'], 'file': file, 'csv_line': d.get('csv_line'), '_row': row}
                case_index[code] = item; cases.append(item)
                if rc is None or not (row.get(rc) or '').strip():
                    gap('case_no_req', '建议', code, 'test-cases', f'{CL} {code} 没有填写关联需求', line=d['line'], file=file, csv_line=d.get('csv_line'))
                for r in refs:
                    if r in req_index:
                        req_index[r]['cases'].append(code)
                    else:
                        gap('case_unknown_req', '必改', code, 'test-cases', f'{CL} {code} 关联的需求 {r} 在 PRD（v{prd.meta.get("version")}）中不存在', line=d['line'], file=file, csv_line=d.get('csv_line'))
                if rc and (row.get(rc) or '').strip() and not refs:
                    gap('case_unknown_req', '必改', code, 'test-cases', f'{CL} {code} 的关联需求「{row.get(rc)}」不符合 PRD 需求编号格式', line=d['line'], file=file, csv_line=d.get('csv_line'))
        for item in reqs:
            if not item['cases']:
                gap('req_no_cases', '必改' if high(item['priority']) else '建议', item['code'], 'test-cases',
                    f'需求 {item["code"]}（{item["priority"] or "未标优先级"}）没有任何{CL}关联', line=item['prd_section']['line'])
    if not tc_rx:
        tc_rx = [code_regex(r'^TC-[A-Z0-9]+-\d+$')]

    def tc_codes_in(text):
        out = []
        for rx, full in tc_rx:
            out += find_codes(text, rx, full)
        return list(dict.fromkeys(out))

    # ---- 执行结果与缺陷
    report = chosen.get('test-report')
    defects = []
    if report is None:
        gap('doc_missing', '提示', None, 'test-report', '找不到测试报告（test-report）：矩阵不含执行结果与缺陷')
        skipped += [{'kind': k, 'reason': '缺 test-report'} for k in ('case_no_result', 'result_unknown_case', 'defect_unknown_case')]
    else:
        rdoc = report.doc
        def_rx = [code_regex(e['pattern']) for e in report.entity_defs()]
        tables = []
        csv_files = set()
        for c in report.data_csvs():
            csv_files.add(c['file'])
            tables.append({'source': c['file'], 'header': c['header'], 'rows': c['rows'], 'line': None})
        for t in rdoc.tables:
            if t.get('source') == 'data' and t.get('data_file') in csv_files:
                continue
            rl = t.get('row_lines') or []
            tables.append({'source': f'{report.pack.get("source_file", "doc.md")}#{t["line"]}', 'header': t.get('header') or [],
                           'rows': [(rl[i] if i < len(rl) else t['line'], r) for i, r in enumerate(records_of(t))], 'line': t['line'], 'md': True})
        exec_found = False
        results = {}
        for t in tables:
            hdr, rows = t['header'], t['rows']
            if not rows:
                continue
            defect_col = next((h for h in hdr if def_rx and sum(1 for _, r in rows if any(f.match((r.get(h) or '').strip()) for _, f in def_rx)) >= max(1, len(rows) // 2)), None)
            case_col = code_col(hdr, rows, tc_codes_in, skip=(defect_col,))
            if defect_col and case_col:
                for ln, r in rows:
                    code = (r.get(defect_col) or '').strip()
                    tcs = tc_codes_in(r.get(case_col, ''))
                    item = {'code': code, 'title': (r.get(col(hdr, '标题', '描述') or '') or '')[:80] or None, 'severity': (r.get(col(hdr, '级别', '严重', '优先级') or '') or '') or None,
                            'status': (r.get(col(hdr, '状态') or '') or '') or None, 'cases': tcs, 'source': t['source']}
                    defects.append(item)
                    for tc in tcs:
                        if tc in case_index:
                            case_index[tc]['defects'].append(code)
                        elif cases_doc is not None:
                            gap('defect_unknown_case', '建议', code, 'test-report', f'缺陷 {code} 关联的{CL} {tc} 在 test-cases 文档中不存在', file=t['source'] if not t.get('md') else None,
                                line=ln if t.get('md') else None, csv_line=None if t.get('md') else ln)
                continue
            if defect_col:
                continue
            status_col = col(hdr, '执行状态', '执行结果', '状态', '结果')
            id_col = case_col
            if not status_col or not id_col or status_col == id_col:
                continue
            with_tc = [(ln, r) for ln, r in rows if tc_codes_in(r.get(id_col, ''))]
            vals = [(r.get(status_col) or '').strip() for _, r in with_tc if (r.get(status_col) or '').strip()]
            if not with_tc or not vals or sum(1 for v in vals if v.lower() in STATUS) * 2 < len(vals):
                continue
            exec_found = True
            for ln, r in with_tc:
                raw = (r.get(status_col) or '').strip()
                st = STATUS.get(raw.lower())
                loc = {'file': None if t.get('md') else t['source'], 'line': ln if t.get('md') else None, 'csv_line': None if t.get('md') else ln}
                for tc in tc_codes_in(r.get(id_col, '')):
                    if raw and st is None:
                        gap('result_invalid_status', '建议', tc, 'test-report', f'{CL} {tc} 的执行状态「{raw}」不在词表内（{"/".join(sorted({k for k in STATUS if not k.isascii()}))}）', **loc)
                    res = {'status': st, 'raw_status': raw or None, 'executed_by': (r.get(col(hdr, '执行人') or '') or '') or None,
                           'executed_at': (r.get(col(hdr, '执行日期', '日期', '时间') or '') or '') or None, 'note': (r.get(col(hdr, '备注', '说明') or '') or '') or None, 'source': t['source']}
                    if tc in results:
                        if results[tc]['status'] != st:
                            gap('result_conflict', '建议', tc, 'test-report', f'{CL} {tc} 有多条不同执行结果（{results[tc]["raw_status"]} / {raw}），矩阵取先出现的 {results[tc]["source"]}', **loc)
                        continue
                    results[tc] = res
                    if tc not in case_index and cases_doc is not None:
                        gap('result_unknown_case', '建议', tc, 'test-report', f'执行结果里的{CL} {tc} 在 test-cases 文档中不存在', **loc)
        if not exec_found:
            gap('report_no_execution', '建议', None, 'test-report', f'测试报告运行目录 data/*.csv 与正文表格里都找不到执行结果表（需要一列{CL}编号与一列状态或结果）')
            skipped.append({'kind': 'case_no_result', 'reason': '报告里没有执行结果表'})
        for item in cases:
            item['result'] = results.get(item['code'])
            if exec_found and item['result'] is None:
                gap('case_no_result', '建议', item['code'], 'test-report', f'{CL} {item["code"]} 在测试报告里没有执行结果', line=item['line'], file=item['file'], csv_line=item['csv_line'])
    # ---- 需求状态
    for item in reqs:
        linked = [case_index[c] for c in item['cases']]
        item['defects'] = list(dict.fromkeys(d for c in linked for d in c['defects']))
        sts = [(c['result'] or {}).get('status') for c in linked]
        if not linked:
            item['status'] = 'uncovered'
        elif report is None:
            item['status'] = 'not_reported'
        elif 'failed' in sts:
            item['status'] = 'failed'
        elif 'blocked' in sts:
            item['status'] = 'blocked'
        elif all(s == 'passed' for s in sts):
            item['status'] = 'passed'
        elif any(s == 'passed' for s in sts):
            item['status'] = 'partial'
        else:
            item['status'] = 'not_executed'
        for x in item['design']:
            x.pop('_key', None)
    # ---- 版本
    links = []
    for d in sorted(found.values(), key=lambda x: (x.type or '', x.run_dir)):
        for r in relmod.Related(d.run_dir, meta=d.meta).docs:
            cur = (r.meta or {}).get('version') if r.ok else None
            match = None if not (r.version and r.ok) else bool(same_version(r.version, cur))
            links.append({'from_type': d.type, 'from_run_dir': d.run_dir, 'to_type': r.type, 'to_run_dir': os.path.realpath(r.run_dir) if r.ok else None,
                          'role': r.role, 'registered_version': r.version, 'current_version': cur, 'match': match, 'resolved': r.ok})
            if match is False and d.type in TYPES and r.type in TYPES:
                gap('version_mismatch', '建议', None, d.type, f'{d.type}（v{d.meta.get("version")}）登记的 {r.type} 版本为 {r.version}，对方当前为 {cur}：复查引用的编号与口径后更新 related_docs.version')
    # ---- 汇总
    cstat = [(c['result'] or {}).get('status') for c in cases]
    summary = {'requirements': len(reqs), 'designed': sum(1 for r in reqs if r['design']), 'with_cases': sum(1 for r in reqs if r['cases']),
               'cases': len(cases), 'cases_linked': sum(1 for c in cases if any(x in req_index for x in c['requirements'])),
               'results': sum(1 for s in cstat if s is not None), 'passed': cstat.count('passed'), 'failed': cstat.count('failed'),
               'blocked': cstat.count('blocked'), 'not_executed': cstat.count('not_executed'), 'no_result': cstat.count(None),
               'defects': len(defects), 'must_fix': sum(1 for g in gaps if g['severity'] == '必改'),
               'complete': all(chosen.get(t) is not None for t in ('prd', 'tech-spec', 'test-cases', 'test-report'))}
    for c in cases:
        c.pop('_row', None)
    return {'schema_version': '1', 'generated_at': now_iso(), 'engine': {'name': 'doc-shared/trace_matrix', 'version': '1.0.0'},
            'root_run_dir': os.path.realpath(root_dir), 'labels': labels,
            'docs': {t: ({'run_dir': chosen[t].run_dir, 'title': chosen[t].meta.get('title'), 'version': chosen[t].meta.get('version')} if chosen.get(t) else None) for t in TYPES},
            'links': links, 'requirements': reqs, 'cases': cases, 'defects': defects, 'summary': summary,
            'gaps': gaps, 'skipped_checks': skipped, 'warnings': warnings}


# ---------------------------------------------------------------- DocMark 片段

def cell(s):
    return str(s if s not in (None, '') else '—').replace('|', '/').replace('\n', ' ').strip() or '—'


def to_docmark(m):
    cases = {c['code']: c for c in m['cases']}
    CL = m['labels']['case']
    lines = [MARKER, '', f'<!-- table: 需求追踪矩阵（{m["summary"]["requirements"]} 条需求、{m["summary"]["cases"]} 条{CL}） -->',
             f'| 需求编号 | 优先级 | 设计章节 | {CL}编号 | 执行结果 | 缺陷 |', '|---|---|---|---|---|---|']
    for r in m['requirements']:
        design = '、'.join('§' + x['number'] if x.get('number') else (x.get('title') or '') for x in r['design'])
        if not r['cases']:
            lines.append(f'| {cell(r["code"])} | {cell(r["priority"])} | {cell(design)} | — | — | — |')
        for code in r['cases']:
            c = cases[code]
            res = c['result']
            label = STATUS_CN.get(res['status']) if res and res['status'] else (res['raw_status'] if res else STATUS_CN[None])
            lines.append(f'| {cell(r["code"])} | {cell(r["priority"])} | {cell(design)} | {cell(code)} | {cell(label)} | {cell("、".join(c["defects"]))} |')
    if m['gaps']:
        order = {'必改': 0, '建议': 1, '提示': 2}
        lines += ['', f'<!-- table: 追踪缺口（{len(m["gaps"])} 条） -->', '| 类型 | 定级 | 编号 | 说明 |', '|---|---|---|---|']
        for g in sorted(m['gaps'], key=lambda g: (order.get(g['severity'], 9), g['kind'], g['code'] or '')):
            lines.append(f'| {cell(GAP_LABEL.get(g["kind"], g["kind"]).format(case=CL))} | {cell(g["severity"])} | {cell(g["code"])} | {cell(g["message"])} |')
    return '\n'.join(lines) + '\n'


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    if os.path.islink(tmp):
        os.remove(tmp)   # os.replace 不跟随目标链接，但 open(tmp) 会：临时文件是链接时先删
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def write_snippet(root_doc, rel, text, force):
    if not dp.path_safe(rel):
        raise Fail(f'--snippet 必须是运行目录内的相对路径（不含 ..）：{rel}')
    allow = root_doc.pack.get('include_allow') or []
    deny = root_doc.pack.get('include_deny') or []
    norm = rel.replace('\\', '/').lstrip('./') if rel.startswith('./') else rel.replace('\\', '/')
    if not any(fnmatch.fnmatch(norm, g) for g in allow) or any(fnmatch.fnmatch(norm, g) for g in deny):
        raise Fail(f'--snippet 路径不在类型包 {root_doc.type} 的 include 白名单内（allow={allow}，deny={deny}）：{rel}')
    full = os.path.join(root_doc.run_dir, norm)
    parent = os.path.realpath(os.path.dirname(full))
    if not (parent == root_doc.run_dir or parent.startswith(root_doc.run_dir + os.sep)):
        raise Fail(f'--snippet 所在目录经符号链接越出运行目录：{rel}')
    if os.path.islink(full):
        raise Fail(f'--snippet 目标是符号链接，拒绝写入：{rel}')
    if os.path.exists(full) and not force:
        head = open(full, encoding='utf-8').readline().strip()
        if head != MARKER:
            raise Fail(f'--snippet 目标已存在且不是本脚本生成的文件，拒绝覆盖（确认后加 --force）：{rel}')
    atomic_write(full, text)
    return full


def main(argv):
    ap = argparse.ArgumentParser(description='跨文档追踪矩阵')
    ap.add_argument('run_dir')
    for flag in OVERRIDE_FLAGS.values():
        ap.add_argument('--' + flag)
    ap.add_argument('--scan'); ap.add_argument('--out'); ap.add_argument('--snippet'); ap.add_argument('--force', action='store_true'); ap.add_argument('--print', action='store_true')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    run_dir = os.path.realpath(os.path.expanduser(a.run_dir))
    try:
        if not os.path.isfile(os.path.join(run_dir, 'doc.json')):
            raise Fail(f'{run_dir} 没有 doc.json')
        found, warnings = discover(run_dir, a.scan)
        overrides = {t: getattr(a, flag) for t, flag in OVERRIDE_FLAGS.items()}
        chosen = choose(found, overrides)
        for d in chosen.values():
            found.setdefault(d.run_dir, d)
        m = build(run_dir, chosen, found, warnings)
        schema = json.load(open(SCHEMA_PATH, encoding='utf-8'))
        errs = validate.check(m, schema, schema)
        if errs:
            raise Fail('输出不合 trace-matrix.schema.json：' + '；'.join(f'{p} {msg}' for p, msg in errs[:5]))
        if a.out:
            out_dir = os.path.realpath(os.path.expanduser(a.out))   # 显式给出的输出目录按调用方意图写
        else:
            out_dir = os.path.join(run_dir, 'out')
            if os.path.islink(out_dir) or (os.path.exists(out_dir) and not os.path.realpath(out_dir).startswith(run_dir + os.sep)):
                raise Fail('运行目录 out/ 是符号链接或越出运行目录，拒绝写入（确需写到别处用 --out 显式指定）')
        jp, mp = os.path.join(out_dir, 'trace-matrix.json'), os.path.join(out_dir, 'trace-matrix.md')
        md = to_docmark(m)
        snippet = write_snippet(found[run_dir], a.snippet, md, a.force) if a.snippet else None
        atomic_write(jp, json.dumps(m, ensure_ascii=False, indent=2) + '\n')
        atomic_write(mp, md)
    except Fail as ex:
        print(json.dumps({'ok': False, 'error': ex.message, **ex.extra}, ensure_ascii=False, indent=2))
        return 2
    code = 3 if m['summary']['must_fix'] else 0
    by_kind = {}
    for g in m['gaps']:
        by_kind.setdefault(g['kind'], {'count': 0, 'severity': set()})
        by_kind[g['kind']]['count'] += 1; by_kind[g['kind']]['severity'].add(g['severity'])
    out = m if a.print else {'ok': code == 0, 'json': jp, 'md': mp, 'snippet': snippet, 'docs': m['docs'], 'summary': m['summary'],
                             'gaps_by_kind': {k: {'count': v['count'], 'severity': sorted(v['severity'])} for k, v in by_kind.items()},
                             'skipped_checks': m['skipped_checks'], 'warnings': m['warnings']}
    if snippet:
        out.setdefault('warnings', []) if not a.print else None
        if not a.print:
            out['warnings'] = out['warnings'] + [f'已写入源文件 {snippet}：运行目录源文件变化，D3 签门清单需要重新签']
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
