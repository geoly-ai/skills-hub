#!/usr/bin/env python3
"""测试用例导出飞书电子表格（doc-publish 附属工具，2026-09-15 W3-G）。默认 dry-run，--apply 才写飞书。
用法：
  export_cases_sheet.py <test-cases 运行目录> [--pack <类型包>] [--profile account1|account2] [--layout per-module|single]
      [--status-column 执行状态|none] [--folder-path 客户或项目/子项目] [--title 表格标题] [--offline]
      [--spreadsheet-token <已有表格> | --create] [--allow-new-project-folder] [--allow-missing-required]
      [--apply --evidence "用户原话"] [--abandon-recovery --evidence "用户原话"]
数据：解析正文（与 doc-render / doc-qa 同一个解析器），取类型包 numbering.entities 的用例实体（数据块或表格首列）与其整行 CSV 字段；
  列顺序按正文数据块 columns= 显示顺序，CSV 未显示的列接在后面；模块 = CSV「模块」列，否则用例所在一级章节标题。
  必填列与下拉取值读类型包 skeleton.md「用例字段」表（字段 | 必填 | 说明）：必填=是 为必填列；说明形如「P0–P3」或「a / b / c」的列做下拉。
  另加状态列（默认「执行状态」，选项 未执行 / 通过 / 失败 / 阻塞，初值 未执行）；CSV 已有同名列时直接对它做下拉。
表格：per-module（默认）每个模块一个工作表；single 一个「全部用例」工作表、首列为模块。表头加粗底色、必填列表头红字、
  冻结首行首列、按内容估列宽（像素 ≈ 显示宽度 × 8 + 16，限 80–360）、正文自动换行；优先级与状态等列下拉校验。
写入（与 doc-publish 同一套规则，同一实现 doc-shared/scripts/lark_io.py）：
  - 读命令（lark_io.READ_COMMANDS，本工具用到 drive files list、sheets +workbook-info、+sheet-info、+csv-get）；其余一律按写命令处理：跨进程全局写锁
    ~/.cache/doc-publish/lark-write.lock 内串行、间隔 ≥ 1 秒、一律不自动重试；读命令遇限流或超时退避重试至多 3 次。
  - lark-cli 前删除 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY；account2 设 LARKSUITE_CLI_CONFIG_DIR。
  - 落点：--folder-path 或 doc.json lark_folder.path，至少「客户或项目/子项目」两段，从根目录逐层解析；子项目层缺失时 apply 新建、
    一级文件夹缺失需 --allow-new-project-folder；同名多个、近似名、token 与 path 不一致退出 5。给了 --folder-path 时忽略 doc.json 里的 token。
  - 新建：sheets +workbook-create（--sheets / --styles 一次建表写数与样式）→ +dropdown-update（每组选项一次，跨工作表）→ 回读校验。
  - 更新（out/sheet-export.json 记录里的表格或 --spreadsheet-token）：+workbook-info → 已有工作表 +sheet-info（有合并单元格则拒绝）
    与 +csv-get（取已用区域）→ +table-put（overwrite；数据按旧区域补空行覆盖，不调用高风险的 +cells-clear；旧区域比新表宽则拒绝）
    → +dropdown-update → 回读校验。表格链接不变；计划外的旧工作表不删（+sheet-delete 为高风险），只给 warnings。
  - 前置检查（与 doc-publish 同一口径）：run-state.json 的 D3 为 passed，且 run_state.py check-manifest 一致（D3 签门后源文件未改）；
    --apply 不满足退出 1，dry-run 只写 warnings（输出 gate.ok / gate.problems）。
  - 同一运行目录加排他锁 out/.sheet-export.lock（覆盖全流程）；out/ 与 out/sheet-export/ 是符号链接或越出运行目录时拒绝（退出 2）。
  - 更新时状态列不来自 CSV 的，按用例编号回填表格里已有的执行状态，新用例才用初值。
  - 写之前落 out/sheet-export/.write-intent.json（阶段、目标 token、数据哈希），全部成功（含回读）后删除；回读不一致时保留（stage verify_failed）、不写成功记录；
    第一条表格写命令遇确认门（请求未执行）时删除；残留时之后任何运行退出 8，
    直到用 --spreadsheet-token 指向已建表格（更新幂等，可重跑）或 --abandon-recovery --evidence。
  - 退出码 10（lark-cli 高风险确认门）原样透传 action、risk、hint、argv，不追加 --yes。
输出：out/sheet-export/plan.json（dry-run 与 apply 都写；含 reads、writes argv、工作表规格、problems、warnings）与 JSON 到 stdout；
  apply 成功写 out/sheet-export.json（spreadsheet_token、url、title、folder、sheets[{name, sheet_id, rows}]、cases_sha256、evidence、exported_at）。
退出码：0 成功（dry-run 为计划通过）；1 预检不过（--apply 时 D3 未通过或源文件已变、解析错误、编号重复且内容不同、必填为空、取值不在下拉选项、目标工作表有合并单元格或旧区域更宽）；
  2 用法错误；3 已写入但回读校验不通过；5 落点需用户拍板；7 lark-cli 失败（写命令失败时 uncertain_write=true，先只读核对）；8 存在未决写入；10 确认门。"""
import argparse, csv, datetime, fcntl, glob, hashlib, io, json, os, re, shutil, subprocess, sys, time, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILLS = os.path.dirname(ROOT)
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
sys.path.insert(0, os.path.join(DOC_SHARED, 'scripts'))
import docmark_parse as dp  # noqa: E402
import validate  # noqa: E402
import lark_io  # noqa: E402  （lark-cli 调用、写锁、确认门、文件夹解析：与 publish.py 同一实现）
from lark_io import Stop, PROFILES  # noqa: E402

ENGINE = {'name': 'doc-publish/export_cases_sheet', 'version': '1.0.0'}
EXIT_OK, EXIT_PRE, EXIT_USAGE, EXIT_VERIFY, EXIT_FOLDER, EXIT_LARK, EXIT_PENDING, EXIT_CONFIRM = 0, 1, 2, 3, 5, 7, 8, 10
OUT_REL = 'out/sheet-export'
RECORD_REL = 'out/sheet-export.json'
INTENT_REL = OUT_REL + '/.write-intent.json'
STATUS_OPTIONS = ['未执行', '通过', '失败', '阻塞']
SEMANTIC_COLORS = {'P0': '#FDE2E1', 'P1': '#FFF1D6', 'P2': '#E3F1FF', 'P3': '#EEF0F2',
                   '未执行': '#EEF0F2', '通过': '#DFF5E3', '失败': '#FDE2E1', '阻塞': '#FFF1D6'}
DEFAULT_REQUIRED = ['用例编号', '标题', '关联需求', '优先级', '预期结果']
SHEET_BAD = re.compile(r"[\[\]:*?/\\]")
MAX_SHEET_NAME = 31
UNCERTAIN = '写命令结果不确定，可能已写入飞书：先只读定位（drive files list 看目标文件夹 / sheets +workbook-info 看表格）再决定，不要直接重跑写入'


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    if os.path.islink(tmp):
        os.remove(tmp)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def col_letter(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s


def disp_width(s):
    return sum(2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in str(s))


# ---------------------------------------------------------------- 类型包与数据

def trusted_roots():
    roots = [os.path.expanduser(d) for d in os.environ.get('DOC_TYPES_DIRS', '').split(':') if d.strip()]
    roots.append(os.path.join(DOC_SHARED, 'types'))
    return [os.path.realpath(r) for r in roots if os.path.isdir(r)]


def load_pack(doc_type, pack_arg):
    roots = trusted_roots()
    cand = os.path.realpath(os.path.expanduser(pack_arg)) if pack_arg else None
    if cand is None:
        for r in roots:
            if os.path.isfile(os.path.join(r, doc_type, 'pack.json')):
                cand = os.path.realpath(os.path.join(r, doc_type)); break
    if cand is None:
        raise Stop(EXIT_USAGE, 'pack', f'找不到类型包 {doc_type}')
    if not any(cand == r or cand.startswith(r + os.sep) for r in roots):
        raise Stop(EXIT_USAGE, 'pack', f'--pack 只接受 doc-shared/types 或 DOC_TYPES_DIRS 下的类型包：{cand}')
    try:
        pack = json.load(open(os.path.join(cand, 'pack.json'), encoding='utf-8'))
    except (OSError, ValueError) as ex:
        raise Stop(EXIT_USAGE, 'pack', f'类型包读取失败：{ex}')
    errs, _ = validate.validate_data('pack', pack, cand)
    if errs:
        raise Stop(EXIT_PRE, 'pack', '类型包不合 pack schema：' + '；'.join(f'{p} {m}' for p, m in errs[:3]))
    return pack, cand


def field_spec(pack_dir):
    """读 skeleton.md「用例字段」表：返回 (必填列, {列: 下拉选项}, 来源说明)。"""
    path = os.path.join(pack_dir, 'skeleton.md')
    required, options = [], {}
    if not os.path.isfile(path):
        return list(DEFAULT_REQUIRED), {'优先级': ['P0', 'P1', 'P2', 'P3']}, 'default'
    lines = open(path, encoding='utf-8').read().split('\n')
    hdr_i = next((i for i, l in enumerate(lines) if l.strip().startswith('|') and '字段' in l and '必填' in l), None)
    if hdr_i is None:
        return list(DEFAULT_REQUIRED), {'优先级': ['P0', 'P1', 'P2', 'P3']}, 'default'
    hdr = [c.strip() for c in lines[hdr_i].strip().strip('|').split('|')]
    fi, ri = hdr.index('字段'), hdr.index('必填')
    di = hdr.index('说明') if '说明' in hdr else None
    for l in lines[hdr_i + 2:]:
        if not l.strip().startswith('|'):
            break
        cells = [c.strip() for c in l.strip().strip('|').split('|')]
        if len(cells) <= max(fi, ri):
            continue
        name = cells[fi]
        if cells[ri] == '是':
            required.append(name)
        desc = cells[di] if di is not None and di < len(cells) else ''
        m = re.fullmatch(r'P(\d)\s*[–\-~至]\s*P(\d)', desc)
        if m and int(m.group(1)) <= int(m.group(2)):
            options[name] = [f'P{i}' for i in range(int(m.group(1)), int(m.group(2)) + 1)]
        elif ' / ' in desc:
            toks = [t.strip() for t in desc.split('/')]
            if len(toks) >= 2 and all(t and len(t) <= 8 and ' ' not in t for t in toks):
                options[name] = toks
    return required or list(DEFAULT_REQUIRED), options, 'skeleton.md'


def sanitize_sheet_names(names):
    out, used = [], set()
    for n in names:
        base = SHEET_BAD.sub('', str(n or '')).strip().strip("'").strip() or '未分组'
        base = base[:MAX_SHEET_NAME]
        name, k = base, 2
        while name in used:
            suf = f'-{k}'; name = base[:MAX_SHEET_NAME - len(suf)] + suf; k += 1
        used.add(name); out.append(name)
    return out


def meta_date(meta):
    ver = str(meta.get('version', '')).lstrip('vV')
    rev = next((r.get('date') for r in meta.get('revision_history') or [] if str(r.get('version', '')).lstrip('vV') == ver), None)
    return meta.get('date') or rev or datetime.date.today().isoformat()


def workbook_title(meta, pack):
    tpl = re.sub(r'\.pdf$', '', pack.get('filename') or '{project}_{name}_{title}_v{version}')
    vals = {'project': meta.get('project', ''), 'title': meta.get('title', ''), 'version': meta.get('version', ''), 'name': pack.get('name', ''),
            'type': meta.get('type', ''), 'client': meta.get('client', ''), 'yyyymmdd': meta_date(meta).replace('-', '')}
    return re.sub(r'\{(\w+)\}', lambda m: str(vals.get(m.group(1), m.group(0))), tpl)


def load_cases(run_dir, meta, pack, pack_dir, a):
    problems, warnings = [], []
    src = pack.get('source_file', 'doc.md')
    try:
        doc = dp.parse_file(run_dir, src, pack=pack)
    except (OSError, dp.SourcePathError) as ex:
        raise Stop(EXIT_PRE, 'parse', f'正文读取失败：{ex}')
    for e in doc.errors():
        problems.append(f'解析错误（第 {e.get("line")} 行）：{e.get("message")}')
    kinds = [e['kind'] for e in (pack.get('numbering') or {}).get('entities') or [] if e.get('kind')]
    tables = {t['line']: t for t in doc.tables}
    columns, cases, index, files = [], [], {}, set()
    for kind in kinds:
        for d in doc.entities.get(kind) or []:
            row = d.get('row')
            if row is None:
                continue
            t = tables.get(d.get('table_line')) or {}
            if t.get('data_file'):
                files.add(t['data_file'])
            for c in (t.get('header') or []) + list(row.keys()):
                if c not in columns:
                    columns.append(c)
            code = d['code']
            id_col = next((k for k, v in row.items() if str(v).strip() == code), None)
            if code in index:
                if index[code]['row'] != row:
                    problems.append(f'用例编号 {code} 重复且内容不同（第 {d["line"]} 行），不能确定导出哪一条')
                continue
            sec = str(d.get('section_number') or '').split('.')[0]
            h = next((x for x in doc.headings if x.get('number') == sec), None)
            item = {'code': code, 'row': dict(row), 'module': (row.get('模块') or '').strip() or (h['plain'] if h else '未分组'), 'line': d['line'], 'csv_line': d.get('csv_line'), 'id_col': id_col}
            index[code] = item; cases.append(item)
    if not cases:
        raise Stop(EXIT_PRE, 'data', f'正文里没有解析出用例实体（类型包 numbering.entities：{kinds}）')
    required, options, spec_src = field_spec(pack_dir)
    if spec_src == 'default':
        warnings.append('类型包 skeleton.md 没有「用例字段」表，必填列与下拉取值用默认值')
    status_col = None if a.status_column == 'none' else a.status_column
    add_status = bool(status_col) and status_col not in columns
    if status_col:
        options.setdefault(status_col, STATUS_OPTIONS)
    for c in list(options):
        if c not in columns and c != status_col:
            options.pop(c)
    missing_cols = [c for c in required if c not in columns]
    if missing_cols:
        problems.append('用例数据缺少必填列：' + '、'.join(missing_cols))
    for it in cases:
        for c in required:
            if c in columns and not str(it['row'].get(c) or '').strip():
                (warnings if a.allow_missing_required else problems).append(f'{it["code"]} 必填列「{c}」为空（第 {it["line"]} 行）')
        for c, opts in options.items():
            v = str(it['row'].get(c) or '').strip()
            if v and v not in opts:
                problems.append(f'{it["code"]} 列「{c}」取值「{v}」不在下拉选项 {opts} 内')
        if add_status:
            it['row'][status_col] = STATUS_OPTIONS[0]
    if add_status:
        columns.append(status_col)
    sha = hashlib.sha256()
    for f in sorted(files):
        full = os.path.realpath(os.path.join(run_dir, f))
        if dp.within(run_dir, full) and os.path.isfile(full):
            sha.update(open(full, 'rb').read())
    sha.update(json.dumps([c['row'] for c in cases], ensure_ascii=False, sort_keys=True).encode())
    id_cols = [c['id_col'] for c in cases if c['id_col']]
    return {'doc': doc, 'columns': columns, 'cases': cases, 'id_column': id_cols[0] if id_cols else columns[0], 'required': [c for c in required if c in columns], 'options': options,
            'status_column': status_col, 'status_added': add_status, 'data_files': sorted(files), 'sha256': sha.hexdigest(),
            'problems': problems, 'warnings': warnings}


def build_sheets(data, layout):
    cols = list(data['columns'])
    groups = []
    if layout == 'single':
        if '模块' not in cols:
            cols = ['模块'] + cols
        groups.append(('全部用例', data['cases']))
    else:
        order = []
        for c in data['cases']:
            if c['module'] not in order:
                order.append(c['module'])
        groups = [(m, [c for c in data['cases'] if c['module'] == m]) for m in order]
    names = sanitize_sheet_names([g[0] for g in groups])
    sheets = []
    for name, (module, items) in zip(names, groups):
        rows = [[str(({**c['row'], '模块': c['module']} if '模块' in cols else c['row']).get(k) or '') for k in cols] for c in items]
        last = col_letter(len(cols)); n = len(rows)
        widths = []
        for j, k in enumerate(cols):
            w = max([disp_width(k) + (2 if k in data['required'] else 0)] + [disp_width(r[j]) for r in rows])
            widths.append(max(80, min(360, w * 8 + 16)))
        cell_styles = [{'range': f'A1:{last}1', 'font_weight': 'bold', 'background_color': '#E8EEF7', 'vertical_alignment': 'middle', 'word_wrap': 'auto-wrap'},
                       {'range': f'A2:{last}{n + 1}', 'vertical_alignment': 'top', 'word_wrap': 'auto-wrap'}]
        for j, k in enumerate(cols):
            if k in data['required']:
                cell_styles.append({'range': f'{col_letter(j + 1)}1', 'font_color': '#C0392B'})
        sheets.append({'name': name, 'module': module, 'columns': cols, 'rows': rows, 'codes': [c['code'] for c in items],
                       'id_index': cols.index(data['id_column']) if data['id_column'] in cols else 0,
                       'styles': {'name': name, 'cell_styles': cell_styles, 'row_sizes': [{'range': '1:1', 'size': 32}],
                                  'col_sizes': [{'range': f'{col_letter(j + 1)}:{col_letter(j + 1)}', 'size': w} for j, w in enumerate(widths)],
                                  'freeze': {'rows': 1, 'cols': 1}},
                       'dropdowns': [{'column': k, 'range': f'{name}!{col_letter(cols.index(k) + 1)}2:{col_letter(cols.index(k) + 1)}{n + 1}', 'options': data['options'][k]}
                                     for k in cols if k in data['options']],
                       'required_columns': [k for k in cols if k in data['required']]})
    return sheets


# ---------------------------------------------------------------- lark-cli（doc-shared/scripts/lark_io.py，与 publish.py 共用）

def resolve_folder(lark, path, given, allow_create, allow_new_project):
    """返回 {token, path, created[], planned[]}；lark 为 None 时离线只做计划。规则与 publish.resolve_folder 同一实现（lark_io.resolve_folder）。"""
    return lark_io.resolve_folder(lark, path, given, allow_create, allow_new_project, path_label='落点（--folder-path 或 doc.json lark_folder.path）', verb='导出')


def gate_check(run_dir, pack_dir):
    """导出前置检查：run-state.json 的 D3 为 passed，且 run_state.py check-manifest 一致（D3 签门后源文件未改）。返回问题列表（空为通过）。
    --apply 时有问题退出 1；dry-run 只写 warnings。"""
    for rel in ('run-state.json', 'run-state.json.lock', 'run-state.json.tmp'):
        if os.path.islink(os.path.join(run_dir, rel)):
            return [f'{rel} 是符号链接，拒绝读取门状态']
    sp = os.path.join(run_dir, 'run-state.json')
    if not os.path.isfile(sp):
        return ['没有 run-state.json：先按 gates.md 走完 D0–D3（质检必改清零、D3 通过）再导出']
    try:
        d3 = ((json.load(open(sp, encoding='utf-8')).get('gates') or {}).get('D3') or {}).get('status')
    except (OSError, ValueError, AttributeError) as ex:
        return [f'run-state.json 读取失败：{ex}']
    if d3 != 'passed':
        return [f'D3 未通过（D3={d3}）：质检必改清零并过 D3 后再导出']
    cmd = [sys.executable, os.path.join(DOC_SHARED, 'scripts', 'run_state.py'), run_dir, 'check-manifest', '--pack', pack_dir]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return ['run_state.py check-manifest 超时']
    try:
        body = json.loads(r.stdout)
    except ValueError:
        body = {}
    if r.returncode == 3:
        diff = {k: body.get(k) or [] for k in ('added', 'removed', 'changed')}
        return [f'D3 签门之后源文件有变化（source_manifest 比对：新增 {diff["added"][:5]}，删除 {diff["removed"][:5]}，修改 {diff["changed"][:5]}）：重跑质检并重过 D3']
    if r.returncode != 0:
        return [f'run_state.py check-manifest 未通过（退出码 {r.returncode}）：{body.get("message") or (r.stdout + r.stderr).strip()[-200:]}']
    return []


# ---------------------------------------------------------------- 表格读写

def find_key(obj, keys):
    """在响应里递归找第一个非空字段（响应形状以 lark-cli 为准，这里容忍 data 下多一层包装）。"""
    if isinstance(obj, dict):
        for k in keys:
            if obj.get(k) not in (None, ''):
                return obj[k]
        for v in obj.values():
            r = find_key(v, keys)
            if r not in (None, ''):
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_key(v, keys)
            if r not in (None, ''):
                return r
    return None


def workbook_sheets(lark, token):
    d = lark.call(['sheets', '+workbook-info', '--as', 'user', '--spreadsheet-token', token], 'workbook-info')
    lst = find_key(d, ['sheets'])
    if not isinstance(lst, list):
        raise Stop(EXIT_LARK, 'workbook-info', '+workbook-info 响应里没有 sheets 数组', lark_response=json.dumps(d, ensure_ascii=False)[:300])
    return [{'sheet_id': s.get('sheet_id'), 'title': s.get('title') or s.get('sheet_name'), 'resource_type': s.get('resource_type', 'sheet')} for s in lst if isinstance(s, dict)]


def read_grid(lark, token, sheet_id):
    d = lark.call(['sheets', '+csv-get', '--as', 'user', '--spreadsheet-token', token, '--sheet-id', sheet_id], 'csv-get')
    text = find_key(d, ['annotated_csv', 'csv'])
    if not isinstance(text, str):
        if find_key(d, ['row_count']) == 0:
            return []
        raise Stop(EXIT_LARK, 'csv-get', '+csv-get 响应里没有 annotated_csv', lark_response=json.dumps(d, ensure_ascii=False)[:300])
    if find_key(d, ['has_more']) is True:
        raise Stop(EXIT_LARK, 'csv-get', '+csv-get 结果被截断（has_more），不能据此判断已用区域')
    rows = []
    for rec in csv.reader(io.StringIO(text)):
        if rec:
            rec[0] = re.sub(r'^\[row=\d+\]\s?', '', rec[0])
        rows.append(rec)
    while rows and not any(c.strip() for c in rows[-1]):
        rows.pop()
    return rows


def sheet_merges(lark, token, sheet_id):
    d = lark.call(['sheets', '+sheet-info', '--as', 'user', '--spreadsheet-token', token, '--sheet-id', sheet_id, '--include', 'merges'], 'sheet-info')
    m = find_key(d, ['merges', 'merged_cells'])
    return m if isinstance(m, list) else []


def used_extent(rows):
    h = len(rows)
    w = max([max([i + 1 for i, c in enumerate(r) if c.strip()] or [0]) for r in rows] or [0])
    return h, w


def payloads(run_dir, sheets, pads):
    """写 --sheets / --styles / 下拉文件（运行目录 out/sheet-export/，argv 用 @./ 相对路径）。"""
    base = os.path.join(run_dir, OUT_REL)
    os.makedirs(base, exist_ok=True)
    items = []
    for s in sheets:
        data = [list(r) for r in s['rows']]
        extra = pads.get(s['name'], 0)
        data += [[''] * len(s['columns']) for _ in range(extra)]
        items.append({'name': s['name'], 'start_cell': 'A1', 'mode': 'overwrite', 'header': True, 'allow_overwrite': True, 'columns': s['columns'], 'data': data})
    write_json(os.path.join(base, 'sheets.json'), {'sheets': items})
    write_json(os.path.join(base, 'styles.json'), {'styles': [s['styles'] for s in sheets]})
    groups = []
    for s in sheets:
        for dd in s['dropdowns']:
            g = next((x for x in groups if x['column'] == dd['column'] and x['options'] == dd['options']), None)
            if g is None:
                g = {'column': dd['column'], 'options': dd['options'], 'ranges': []}; groups.append(g)
            g['ranges'].append(dd['range'])
    files = []
    for gi, g in enumerate(groups, 1):
        for ci in range(0, len(g['ranges']), 100):
            k = f'{gi}-{ci // 100 + 1}'
            write_json(os.path.join(base, f'dropdown-{k}-ranges.json'), g['ranges'][ci:ci + 100])
            write_json(os.path.join(base, f'dropdown-{k}-options.json'), g['options'])
            colors = [SEMANTIC_COLORS[o] for o in g['options']] if all(o in SEMANTIC_COLORS for o in g['options']) else None
            if colors:
                write_json(os.path.join(base, f'dropdown-{k}-colors.json'), colors)
            files.append({'column': g['column'], 'key': k, 'colors': bool(colors), 'ranges': g['ranges'][ci:ci + 100]})
    return files


def dropdown_argv(token, f):
    a = ['sheets', '+dropdown-update', '--as', 'user', '--spreadsheet-token', token,
         '--ranges', f'@./{OUT_REL}/dropdown-{f["key"]}-ranges.json', '--options', f'@./{OUT_REL}/dropdown-{f["key"]}-options.json']
    if f['colors']:
        a += ['--colors', f'@./{OUT_REL}/dropdown-{f["key"]}-colors.json']
    return a


def verify(lark, token, sheets):
    problems, ids = [], {}
    live = {s['title']: s for s in workbook_sheets(lark, token)}
    for s in sheets:
        if s['name'] not in live:
            problems.append(f'回读：表格里没有工作表「{s["name"]}」'); continue
        ids[s['name']] = live[s['name']]['sheet_id']
        grid = read_grid(lark, token, live[s['name']]['sheet_id'])
        if not grid or [c.strip() for c in grid[0][:len(s['columns'])]] != s['columns']:
            problems.append(f'回读：工作表「{s["name"]}」表头与计划不一致'); continue
        ix = s['id_index']
        got = [r[ix].strip() if len(r) > ix else '' for r in grid[1:]]
        if got[:len(s['codes'])] != s['codes'] or any(x for x in got[len(s['codes']):]):
            problems.append(f'回读：工作表「{s["name"]}」用例编号列与计划不一致（期望 {len(s["codes"])} 行，读到 {len([x for x in got if x])} 行非空）')
    return problems, ids


# ---------------------------------------------------------------- 主流程

def guard_out_dirs(run_dir):
    """out/ 与 out/sheet-export/ 不得是符号链接，也不得经符号链接越出运行目录（dry-run 同样适用）。"""
    cur = run_dir
    for part in OUT_REL.split('/'):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            raise Stop(EXIT_USAGE, 'path', f'{os.path.relpath(cur, run_dir)} 是符号链接，拒绝写入（产物必须留在运行目录内）')
        if os.path.exists(cur) and not os.path.realpath(cur).startswith(run_dir + os.sep):
            raise Stop(EXIT_USAGE, 'path', f'{os.path.relpath(cur, run_dir)} 越出运行目录，拒绝写入')
    for rel in (RECORD_REL, INTENT_REL, OUT_REL + '/plan.json'):
        if os.path.islink(os.path.join(run_dir, rel)):
            raise Stop(EXIT_USAGE, 'path', f'{rel} 是符号链接，拒绝写入')


class RunLock:
    """同一运行目录同时只允许一个导出进程（覆盖 检查未决 → 生成 payload → 写入 → 回读 全流程）；全局写锁另管跨目录节流。"""
    def __init__(self, run_dir):
        self.path = os.path.join(run_dir, 'out', '.sheet-export.lock')

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if os.path.islink(self.path):
            raise Stop(EXIT_USAGE, 'lock', 'out/.sheet-export.lock 是符号链接，拒绝使用')
        self.f = open(self.path, 'a+')
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.f.close()
            raise Stop(EXIT_USAGE, 'lock', '另一个导出进程正在处理同一运行目录（out/.sheet-export.lock），等它结束再运行')
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN); self.f.close()
        return False


def read_record(run_dir):
    p = os.path.join(run_dir, RECORD_REL)
    if not os.path.exists(p):
        return None
    try:
        rec = json.load(open(p, encoding='utf-8'))
    except (OSError, ValueError) as ex:
        raise Stop(EXIT_USAGE, 'record', f'{RECORD_REL} 读取失败：{ex}（确认表格后用 --spreadsheet-token 或 --create 显式指定）')
    if not isinstance(rec, dict) or not re.match(r'^[A-Za-z0-9]{8,}$', str(rec.get('spreadsheet_token') or '')):
        raise Stop(EXIT_USAGE, 'record', f'{RECORD_REL} 缺少合法的 spreadsheet_token（确认表格后用 --spreadsheet-token 或 --create 显式指定）')
    return rec


def call_first_write(lark, args, step, intent_path):
    """本轮第一条表格写命令：遇确认门（exit 10，请求未执行）时删除意图文件，避免之后无意义地要求 --abandon-recovery。"""
    try:
        return lark.call(args, step)
    except Stop as ex:
        if ex.code == EXIT_CONFIRM and os.path.exists(intent_path):
            os.remove(intent_path); ex.payload['intent_cleared'] = True
        raise


def run(a, out):
    run_dir = os.path.realpath(os.path.expanduser(a.run_dir))
    out['run_dir'] = run_dir
    if not os.path.isfile(os.path.join(run_dir, 'doc.json')):
        raise Stop(EXIT_USAGE, 'args', f'{run_dir} 没有 doc.json')
    if (a.apply or a.abandon_recovery) and not a.evidence:
        raise Stop(EXIT_USAGE, 'args', '--apply 与 --abandon-recovery 必须带 --evidence（用户原话）')
    if a.apply and a.offline:
        raise Stop(EXIT_USAGE, 'args', '--apply 与 --offline 不能同时给')
    if a.create and a.spreadsheet_token:
        raise Stop(EXIT_USAGE, 'args', '--create 与 --spreadsheet-token 不能同时给')
    if a.spreadsheet_token and not re.match(r'^[A-Za-z0-9]{8,}$', a.spreadsheet_token):
        raise Stop(EXIT_USAGE, 'args', f'--spreadsheet-token 格式不对：{a.spreadsheet_token}')
    try:
        meta = json.load(open(os.path.join(run_dir, 'doc.json'), encoding='utf-8'))
    except (OSError, ValueError) as ex:
        raise Stop(EXIT_USAGE, 'meta', f'doc.json 读取失败：{ex}')
    if meta.get('type') != 'test-cases':
        raise Stop(EXIT_USAGE, 'meta', f'只支持 test-cases 运行目录，doc.json type 为 {meta.get("type")}')
    guard_out_dirs(run_dir)
    with RunLock(run_dir):
        return run_locked(a, out, run_dir, meta)


def run_locked(a, out, run_dir, meta):
    pack, pack_dir = load_pack('test-cases', a.pack)
    gate = gate_check(run_dir, pack_dir)
    out['gate'] = {'ok': not gate, 'problems': gate}
    if gate and a.apply:
        raise Stop(EXIT_PRE, 'gate', '导出前置检查不通过（D3 须已通过且 D3 之后源文件未改）：' + '；'.join(gate))
    data = load_cases(run_dir, meta, pack, pack_dir, a)
    sheets = build_sheets(data, a.layout)
    title = a.title or workbook_title(meta, pack)
    out.update(title=title, layout=a.layout, cases=len(data['cases']), data_files=data['data_files'], cases_sha256=data['sha256'],
               sheets=[{'name': s['name'], 'module': s['module'], 'rows': len(s['rows']), 'columns': s['columns'], 'required_columns': s['required_columns'],
                        'dropdowns': s['dropdowns'], 'freeze': s['styles']['freeze'], 'col_sizes': s['styles']['col_sizes']} for s in sheets],
               problems=list(data['problems']), warnings=[f'导出前置检查未通过（--apply 会拒绝）：{g}' for g in gate] + list(data['warnings']))
    # 未决写入
    intent_path = os.path.join(run_dir, INTENT_REL)
    intent = None
    if os.path.exists(intent_path):
        try:
            intent = json.load(open(intent_path, encoding='utf-8'))
        except (OSError, ValueError):
            intent = {'stage': 'unknown'}
        if a.abandon_recovery:
            if a.apply:
                os.remove(intent_path)
            out['recovery_abandoned'] = {'intent': intent, 'evidence': a.evidence, 'at': now_iso(), 'applied': bool(a.apply)}
            out['warnings'].append('已按 --abandon-recovery 放弃未决写入记录' + ('' if a.apply else '（dry-run 未删除意图文件）'))
        elif not (a.spreadsheet_token and intent.get('spreadsheet_token') in (None, a.spreadsheet_token)):
            # 新建结果不确定时意图里没有 token：用户只读定位到已建表格后用 --spreadsheet-token 指定，按更新（幂等）继续
            raise Stop(EXIT_PENDING, 'pending', '存在未决写入（上次写入没有完成或结果不确定）：先只读核对表格，再用 --spreadsheet-token <已建表格> 重跑（更新幂等），或确认后 --abandon-recovery --evidence 用户原话',
                       intent=intent)
    if out['problems']:
        raise Stop(EXIT_PRE, 'preflight', f'预检不通过 {len(out["problems"])} 项（见 problems）')
    record = None if a.create else read_record(run_dir)
    token = a.spreadsheet_token or (record or {}).get('spreadsheet_token')
    mode = 'update' if token else 'create'
    out['mode'] = mode
    lark = None if a.offline else lark_io.Lark(run_dir, a.profile, a.apply, UNCERTAIN)
    if a.offline:
        out['warnings'].append('--offline：没有调用 lark-cli，落点与已有表格状态未核对')
    reads, writes = [], []
    pads = {}
    if mode == 'create':
        lf = meta.get('lark_folder') or {}
        path = a.folder_path or lf.get('path')
        given = None if a.folder_path else lf.get('token')
        if a.folder_path and lf.get('token'):
            out['warnings'].append('给了 --folder-path，忽略 doc.json lark_folder.token')
        folder = resolve_folder(lark, path, given, allow_create=a.apply, allow_new_project=a.allow_new_project_folder)
        out['folder'] = {k: folder[k] for k in ('token', 'path', 'created', 'planned')}
        files = payloads(run_dir, sheets, pads)
        create_args = ['sheets', '+workbook-create', '--as', 'user', '--title', title, '--folder-token', folder['token'] or f'<待建:{folder["path"].split("/")[-1]}>',
                       '--sheets', f'@./{OUT_REL}/sheets.json', '--styles', f'@./{OUT_REL}/styles.json']
        writes += [['lark-cli', 'drive', '+create-folder', '--as', 'user', '--name', p['name']] + (['--folder-token', p['parent_token']] if p['parent_token'] else []) for p in folder['planned']]
        writes.append(['lark-cli'] + create_args)
        writes += [['lark-cli'] + dropdown_argv('<新建后获得>', f) for f in files]
    else:
        out['spreadsheet'] = {'token': token, 'url': (record or {}).get('url') if (record or {}).get('spreadsheet_token') == token else None}
        out['warnings'].append('更新已有表格：链接不变，工作簿标题与所在文件夹不改')
        if lark is not None:
            live = {s['title']: s for s in workbook_sheets(lark, token)}
            reads.append(['lark-cli', 'sheets', '+workbook-info', '--spreadsheet-token', token])
            for s in sheets:
                if s['name'] not in live:
                    continue
                sid = live[s['name']]['sheet_id']
                if live[s['name']].get('resource_type', 'sheet') != 'sheet':
                    out['problems'].append(f'工作表「{s["name"]}」不是普通表格（{live[s["name"]]["resource_type"]}），不能覆盖'); continue
                if sheet_merges(lark, token, sid):
                    out['problems'].append(f'工作表「{s["name"]}」有合并单元格：覆盖写入可能失败或错位，请先人工处理'); continue
                grid = read_grid(lark, token, sid)
                h, w = used_extent(grid)
                if data['status_added'] and grid:
                    head = [c.strip() for c in grid[0]]
                    st_col, ix = data['status_column'], s['id_index']
                    if st_col in head and len(head) > ix and head[ix] == s['columns'][ix]:
                        si = head.index(st_col); keep = {}
                        for r in grid[1:]:
                            if len(r) > max(si, ix) and r[ix].strip() and r[si].strip() in STATUS_OPTIONS:
                                keep[r[ix].strip()] = r[si].strip()
                        tj = s['columns'].index(st_col)
                        for code, row in zip(s['codes'], s['rows']):
                            if code in keep:
                                row[tj] = keep[code]
                                if keep[code] != STATUS_OPTIONS[0]:   # 只统计执行人员改过的（不是初值「未执行」）
                                    out['status_preserved'] = out.get('status_preserved', 0) + 1
                if w > len(s['columns']):
                    out['problems'].append(f'工作表「{s["name"]}」已用 {w} 列，比本次 {len(s["columns"])} 列更宽：多出的列不会被覆盖，需人工清理（+cells-clear 为高风险操作，须用户确认）')
                pads[s['name']] = max(0, h - 1 - len(s['rows']))
                if pads[s['name']]:
                    out['warnings'].append(f'工作表「{s["name"]}」旧数据比本次多 {pads[s["name"]]} 行：以空值覆盖；这些行的下拉与格式保留')
            planned = {s['name'] for s in sheets}
            stale = [t for t in live if t not in planned]
            if stale:
                out['warnings'].append('表格里有计划外的工作表（未删除，删除为高风险操作需用户确认）：' + '、'.join(stale))
            if out['problems']:
                raise Stop(EXIT_PRE, 'preflight', f'更新预检不通过 {len(out["problems"])} 项（见 problems）')
        files = payloads(run_dir, sheets, pads)
        writes.append(['lark-cli', 'sheets', '+table-put', '--as', 'user', '--spreadsheet-token', token, '--sheets', f'@./{OUT_REL}/sheets.json', '--styles', f'@./{OUT_REL}/styles.json'])
        writes += [['lark-cli'] + dropdown_argv(token, f) for f in files]
    out['plan'] = {'reads': reads, 'writes': writes, 'pads': pads}
    write_json(os.path.join(run_dir, OUT_REL, 'plan.json'), {k: out.get(k) for k in ('title', 'mode', 'layout', 'cases', 'cases_sha256', 'folder', 'spreadsheet', 'sheets', 'plan', 'problems', 'warnings')}
               | {'dry_run': not a.apply, 'generated_at': now_iso(), 'engine': ENGINE})
    if not a.apply:
        out['dry_run'] = True
        return EXIT_OK
    # ---- apply
    out['dry_run'] = False
    base_intent = {'at': now_iso(), 'mode': mode, 'title': title, 'cases_sha256': data['sha256'], 'evidence': a.evidence}
    if mode == 'create':
        write_json(intent_path, {**base_intent, 'stage': 'create', 'folder_token': folder['token']})
        d = call_first_write(lark, create_args, 'workbook-create', intent_path)
        token = find_key(d, ['spreadsheet_token'])
        url = find_key(d, ['url'])
        if not token or not re.match(r'^[A-Za-z0-9]{8,}$', str(token)):
            raise Stop(EXIT_LARK, 'workbook-create', f'+workbook-create 响应没有 spreadsheet_token：{UNCERTAIN}', uncertain_write=True, lark_response=json.dumps(d, ensure_ascii=False)[:300])
        write_json(intent_path, {**base_intent, 'stage': 'created', 'folder_token': folder['token'], 'spreadsheet_token': token, 'url': url})
        out['spreadsheet'] = {'token': token, 'url': url}
    else:
        write_json(intent_path, {**base_intent, 'stage': 'update', 'spreadsheet_token': token})
        call_first_write(lark, ['sheets', '+table-put', '--as', 'user', '--spreadsheet-token', token, '--sheets', f'@./{OUT_REL}/sheets.json', '--styles', f'@./{OUT_REL}/styles.json'], 'table-put', intent_path)
    for f in files:
        lark.call(dropdown_argv(token, f), 'dropdown-update')
    problems, ids = verify(lark, token, sheets)
    if problems:
        write_json(intent_path, {**base_intent, 'stage': 'verify_failed', 'spreadsheet_token': token, 'url': (out.get('spreadsheet') or {}).get('url'), 'problems': problems})
        out['spreadsheet'] = {'token': token, 'url': (out.get('spreadsheet') or {}).get('url') or (record or {}).get('url')}
        out['problems'] += problems
        out['message'] = '已写入但回读与计划不一致：保留未决写入记录，核对表格后用 --spreadsheet-token 重跑'
        return EXIT_VERIFY
    rec = {'schema_version': '1', 'engine': ENGINE, 'spreadsheet_token': token, 'url': (out.get('spreadsheet') or {}).get('url') or (record or {}).get('url'),
           'title': title if mode == 'create' else (record or {}).get('title', title), 'mode': mode, 'layout': a.layout,
           'folder': out.get('folder') or (record or {}).get('folder'), 'sheets': [{'name': s['name'], 'sheet_id': ids.get(s['name']), 'rows': len(s['rows'])} for s in sheets],
           'cases': len(data['cases']), 'cases_sha256': data['sha256'], 'evidence': a.evidence, 'exported_at': now_iso()}
    write_json(os.path.join(run_dir, RECORD_REL), rec)
    os.remove(intent_path)
    out['record'] = RECORD_REL
    out['spreadsheet'] = {'token': token, 'url': rec['url']}
    return EXIT_OK


def main(argv):
    ap = argparse.ArgumentParser(description='测试用例导出飞书电子表格（默认 dry-run）')
    ap.add_argument('run_dir'); ap.add_argument('--pack'); ap.add_argument('--profile', choices=PROFILES, default='account1')
    ap.add_argument('--layout', choices=('per-module', 'single'), default='per-module'); ap.add_argument('--status-column', default='执行状态')
    ap.add_argument('--folder-path'); ap.add_argument('--title'); ap.add_argument('--offline', action='store_true')
    ap.add_argument('--spreadsheet-token'); ap.add_argument('--create', action='store_true'); ap.add_argument('--allow-new-project-folder', action='store_true')
    ap.add_argument('--allow-missing-required', action='store_true'); ap.add_argument('--apply', action='store_true')
    ap.add_argument('--evidence', action='append'); ap.add_argument('--abandon-recovery', action='store_true')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return EXIT_USAGE
    out = {'ok': False, 'engine': ENGINE, 'problems': [], 'warnings': []}
    try:
        code = run(a, out)
    except Stop as ex:
        code = ex.code
        out.update(step=ex.step, message=ex.message, **ex.payload)
    out['ok'] = code == EXIT_OK
    out['exit_code'] = code
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
