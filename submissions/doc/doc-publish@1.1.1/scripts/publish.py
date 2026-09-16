#!/usr/bin/env python3
"""doc-publish：把已过 D3 的运行目录归档并发布到飞书项目文件夹，回查后写 published.json 与 run-state（D4、publish 阶段）。
用法：
  publish.py <运行目录>                                   默认 dry-run：预检 + pre_publish 检查钩子 + 归档到 out/published/v<版本>.dry-run/ + 只读 lark-cli，不写飞书、不写 run-state
  publish.py <运行目录> --apply --evidence "用户确认原话"   真发布：文件夹缺失时先建 → D4 → 新建或覆盖 → 回查 → post_publish → published.json
选项：
  --apply                 真的写飞书（没有它一律 dry-run）
  --evidence 文本         D4 证据（用户看过 PDF 并确认范围、版本、账号、文件夹的原话）；--apply 与 --abandon-recovery 时必填，可多次
  --doc-token TOKEN       覆盖这个已有文档（overwrite）；不给时取运行目录 published.json 的 lark_doc_id，都没有则新建
  --create                强制新建（例如覆盖目标有评论、用户确认改新建）；存在恢复记录或未决新建时拒绝
  --abandon-recovery      放弃运行目录里的恢复记录或未决新建（用户确认后才用，须带 --evidence），记录进 published.json
  --profile account1|account2   飞书账号；默认元数据 lark_profile，再默认 account1
  --pack 类型包目录或 pack.json   只接受 doc-shared/types 与 DOC_TYPES_DIRS 下的类型包，加载前过 pack schema
  --allow-new-project-folder    允许新建「客户或项目」一级文件夹（新客户，编排层问过用户后才传）
  --offline               只用于 dry-run：不调用任何 lark-cli（离线预检与归档）
  --by 谁                 写 run-state 时的操作者，默认 doc-publish
退出码：0 成功；1 预检拒绝或 run_state 拒绝；2 用法或读写错误；3 已发布但回查不通过；4 发布钩子失败或越权；
       5 飞书文件夹归属需用户拍板；6 覆盖目标有评论；7 lark-cli 调用失败（写命令失败时可能已写入，先只读定位）；
       8 存在恢复记录或未决新建，需用户决定；10 lark-cli 高风险确认门（原样透传，不自动追加确认 flag）。"""
import argparse, datetime, fcntl, glob, hashlib, json, os, re, shutil, stat, subprocess, sys, tempfile, time
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILLS = os.path.dirname(ROOT)
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
sys.path.insert(0, os.path.join(DOC_SHARED, 'scripts'))
import validate  # noqa: E402
import run_state as rsmod  # noqa: E402  （源文件集合、source_manifest 与 run-state 写入口同一实现）
import lark_io  # noqa: E402  （lark-cli 调用、写锁、确认门、文件夹解析：与 export_cases_sheet 同一实现）
from lark_io import Stop, PROFILES, MAX_PAGES, list_children  # noqa: E402

ENGINE = {'name': 'doc-publish', 'version': '1.1'}
DEFAULT_FILENAME = '{project}_{name}_{title}_v{version}_{yyyymmdd}.pdf'
CN_PLACEHOLDERS = {'项目': 'project', '标题': 'title', '版本': 'version', '日期': 'yyyymmdd', '名称': 'name', '类型': 'type', '客户': 'client'}
HOOK_PLACEHOLDERS = ('run_dir', 'pack_dir', 'skills_dir', 'doc_shared', 'python')
SCHEMA_PATH = os.path.join(DOC_SHARED, 'schemas', 'published.schema.json')
INTENT_REL = 'out/published/.create-intent.json'
INTENT_FIELDS = ('schema_version', 'created_at', 'version', 'source_sha256', 'folder_token', 'folder_path', 'title', 'argv')
BLOCK_TAGS = {'p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'callout', 'title', 'quote'}

TOKEN_RE = r'^[A-Za-z0-9]{8,}$'
EXIT_OK, EXIT_REJECT, EXIT_USAGE, EXIT_VERIFY, EXIT_HOOK, EXIT_FOLDER, EXIT_COMMENTS, EXIT_LARK, EXIT_PENDING, EXIT_CONFIRM = 0, 1, 2, 3, 4, 5, 6, 7, 8, 10


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')
    os.replace(tmp, path)


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def within(root, path):
    root = os.path.realpath(root); path = os.path.realpath(path)
    return path == root or path.startswith(root + os.sep)


def guard_rel(c, rel, what, file=False):
    """写入路径边界：rel 相对运行目录，逐级 lstat，任何一级是软链即拒绝（含不存在的末端之前的各级）；
    逐级 realpath 必须留在运行目录内。file=True 时同时检查写临时文件用的 <rel>.tmp。"""
    rel = rel.replace(os.sep, '/').strip('/')
    parts = [x for x in rel.split('/') if x]
    if not parts or any(x in ('.', '..') for x in parts):
        raise Stop(EXIT_REJECT, 'path-guard', f'{what} 路径不合法：{rel}')
    root_real = os.path.realpath(c.run_dir)
    cur = c.run_dir
    checks = [parts] + ([parts[:-1] + [parts[-1] + '.tmp']] if file else [])
    for chain in checks:
        cur = c.run_dir
        for i, part in enumerate(chain):
            cur = os.path.join(cur, part)
            shown = '/'.join(chain[:i + 1])
            if os.path.islink(cur):
                raise Stop(EXIT_REJECT, 'path-guard', f'{what} 写入路径经过软链：{shown} → {os.readlink(cur)}（归档、暂存、记录、意图文件的路径不允许经过软链）')
            if not os.path.lexists(cur):
                break
            real = os.path.realpath(cur)
            if not (real == root_real or real.startswith(root_real + os.sep)):
                raise Stop(EXIT_REJECT, 'path-guard', f'{what} 写入路径越出运行目录：{shown} → {real}')
    return os.path.join(c.run_dir, *parts)


# ---------------------------------------------------------------- 源文件清单（D3 source_manifest，gates.md §6）

def meta_canonical_sha256(data):
    """元数据文件去掉 lark_folder 后按 sort_keys、ensure_ascii=False、separators=(',', ':') 序列化的 UTF-8 sha256（与 run_state.file_sha256 同口径）。
    lark_folder 是发布期唯一允许改的元数据字段（写回飞书文件夹 token），字段级例外，不伪造修改时间。"""
    d = {k: v for k, v in data.items() if k != 'lark_folder'} if isinstance(data, dict) else data
    return sha256_bytes(json.dumps(d, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


# ---------------------------------------------------------------- 上下文

def trusted_pack_roots():
    roots = [os.path.join(DOC_SHARED, 'types')]
    roots += [os.path.expanduser(d) for d in os.environ.get('DOC_TYPES_DIRS', '').split(':') if d]
    return roots


def find_pack(doc_type, pack_arg):
    cands = []
    if pack_arg:
        p = os.path.expanduser(pack_arg)
        cands.append(p if p.endswith('.json') else os.path.join(p, 'pack.json'))
    for d in filter(None, os.environ.get('DOC_TYPES_DIRS', '').split(':')):
        if doc_type: cands.append(os.path.join(os.path.expanduser(d), doc_type, 'pack.json'))
    if doc_type: cands.append(os.path.join(DOC_SHARED, 'types', doc_type, 'pack.json'))
    for cand in cands:
        if os.path.isfile(cand):
            pack_dir = os.path.dirname(os.path.abspath(cand))
            roots = trusted_pack_roots()
            if not any(within(r, pack_dir) and os.path.realpath(r) != os.path.realpath(pack_dir) for r in roots):
                raise Stop(EXIT_USAGE, 'pack', f'类型包目录不在可信位置：{pack_dir}（只接受 doc-shared/types 与 DOC_TYPES_DIRS 下的类型包）', trusted_roots=roots)
            pack = load_json(cand)
            errs, _ = validate.validate_data('pack', pack, pack_dir)
            if errs:
                raise Stop(EXIT_REJECT, 'pack', f'类型包 pack.json 不合 schema：{pack_dir}', errors=[f'{p}：{m}' for p, m in errs][:10])
            return pack, pack_dir
    if pack_arg:
        raise Stop(EXIT_USAGE, 'pack', f'--pack 指定的类型包不存在：{pack_arg}')
    return None, None


class Ctx:
    pass


def load_context(a):
    c = Ctx()
    c.args = a
    c.run_dir = os.path.abspath(os.path.expanduser(a.run_dir))
    if not os.path.isdir(c.run_dir):
        raise Stop(EXIT_USAGE, 'context', f'运行目录不存在：{a.run_dir}')
    c.warnings = []
    rs_path = os.path.join(c.run_dir, 'run-state.json')
    if not os.path.isfile(rs_path):
        raise Stop(EXIT_REJECT, 'run-state', 'run-state.json 不存在：没有门记录不能发布（先按 gates.md 走完 D0–D3）')
    try:
        c.state = load_json(rs_path)
    except (OSError, ValueError) as ex:
        raise Stop(EXIT_USAGE, 'run-state', f'run-state.json 读不出：{ex}')
    errors, _ = validate.validate_data('run-state', c.state)
    if errors:
        raise Stop(EXIT_REJECT, 'run-state', 'run-state.json 不合法（旧版 G0–G4 格式先迁移）', errors=[f'{p}：{m}' for p, m in errors][:10])
    c.source_manifest = c.state['gates']['D3'].get('source_manifest')
    c.doc_type = c.state['doc_type']
    c.pack, c.pack_dir = find_pack(c.doc_type, a.pack)
    if c.pack is None:
        raise Stop(EXIT_REJECT, 'pack', f'找不到类型包 {c.doc_type}（用 --pack 指定）：发布需要类型包的命名规则与钩子')
    c.meta_file = c.pack.get('meta_file') or 'doc.json'
    c.meta_path = os.path.join(c.run_dir, c.meta_file)
    if not os.path.isfile(c.meta_path):
        raise Stop(EXIT_REJECT, 'meta', f'缺少元数据文件 {c.meta_file}')
    try:
        c.meta = load_json(c.meta_path)
    except (OSError, ValueError) as ex:
        raise Stop(EXIT_USAGE, 'meta', f'{c.meta_file} 读不出：{ex}')
    if not isinstance(c.meta, dict):
        raise Stop(EXIT_REJECT, 'meta', f'{c.meta_file} 不是 JSON 对象')
    c.source_file = c.pack.get('source_file') or 'doc.md'
    c.features = c.pack.get('features') or {}
    c.version = str(c.meta.get('version') or '').lstrip('vV')
    if not c.version:
        raise Stop(EXIT_REJECT, 'meta', f'{c.meta_file} 缺 version，无法确定归档目录')
    if not re.match(r'^[0-9A-Za-z][0-9A-Za-z._-]*$', c.version):
        raise Stop(EXIT_REJECT, 'meta', f'version 含非法字符：{c.version}')
    c.profile = a.profile or c.meta.get('lark_profile') or 'account1'
    if c.profile not in PROFILES:
        raise Stop(EXIT_USAGE, 'profile', f'飞书账号只能是 {"、".join(PROFILES)}，当前 {c.profile}')
    c.stage_dir = None
    return c


# ---------------------------------------------------------------- 预检

def current_doc(c):
    try:
        import docmark_parse as dp
    except Exception as ex:  # 解析器不可用是环境问题
        raise Stop(EXIT_USAGE, 'parse-source', f'doc-shared 解析器不可用：{ex}')
    if not os.path.isfile(os.path.join(c.run_dir, c.source_file)):
        raise Stop(EXIT_REJECT, 'source', f'正文文件不存在：{c.source_file}')
    try:
        return dp.parse_file(c.run_dir, c.source_file, pack=c.pack)
    except Exception as ex:
        raise Stop(EXIT_REJECT, 'parse-source', f'正文解析失败：{type(ex).__name__}: {ex}')


def fill(template, vals):
    return re.sub(r'\{(\w+)\}', lambda m: str(vals[m.group(1)]) if vals.get(m.group(1)) is not None else m.group(0), template or '')


def expected_pdf_name(c, doc, fallback_date):
    """与 layout.md §11 同口径（doc-render common.pdf_filename）：类型包 filename 模板，/ : 等替换为 -。"""
    m = c.meta
    revs = [r for r in (m.get('revision_history') or []) if isinstance(r, dict)]
    rev_date = next((r.get('date') for r in revs if str(r.get('version', '')).lstrip('vV') == c.version), None)
    date = m.get('date') or rev_date or fallback_date
    project = m.get('project') or os.path.basename(c.run_dir)
    client = m.get('client_cn') or m.get('client') or ''
    vals = {'title': m.get('title') or doc.title or os.path.splitext(c.source_file)[0], 'version': c.version, 'date': date,
            'client': client or project, 'project': project, 'name': c.pack.get('name') or c.doc_type, 'type': c.doc_type,
            'yyyymmdd': str(date).replace('-', '')}
    tpl = c.pack.get('filename') or DEFAULT_FILENAME
    for cn, en in CN_PLACEHOLDERS.items():
        tpl = tpl.replace('{' + cn + '}', '{' + en + '}')
    safe = {k: re.sub(r'[\\/:*?"<>|\s]+', '-', str(v)).strip('-') for k, v in vals.items()}
    name = re.sub(r'\{\w+\}', '', fill(tpl, safe))
    if not name.lower().endswith('.pdf'): name += '.pdf'
    return name, str(date)


def parse_xml(xml):
    """feishu.xml 是若干顶层元素的片段：包一层根节点后用 XML 解析器解析（实体、CDATA、单双引号属性都按解码后的值处理）。"""
    return ET.fromstring('<doc-publish-root>' + xml + '</doc-publish-root>')


def xml_title(c):
    t = c.xml_root.find('title') if getattr(c, 'xml_root', None) is not None else None
    text = ''.join(t.itertext()).strip() if t is not None else ''
    return text or c.meta.get('title') or c.doc.title or '（无标题）'


def tildes(s):
    return len(re.findall(r'(?<!\\)~', s or ''))


def xml_guard(c, root):
    """飞书排版约定（feishu.md §1）与资源边界。返回 (问题列表, 资源相对路径列表)。"""
    problems, resources = [], []
    allow_code_blocks = bool(c.features.get('code_blocks'))
    parent = {ch: p for p in root.iter() for ch in p}

    def in_pre(el):
        while el is not None:
            if el.tag == 'pre':
                return True
            el = parent.get(el)
        return False

    inline = [el for el in root.iter('code') if not in_pre(el)]
    if inline:
        problems.append(f'feishu.xml 有 {len(inline)} 处行内代码（<pre> 之外的 <code>），飞书约定一律不用行内代码格式')
    if not allow_code_blocks and any(True for _ in root.iter('pre')):
        problems.append('类型包未开启 code_blocks，但 feishu.xml 含代码块')
    tilde_reported = False
    for el in root.iter():
        if el is root:
            continue
        if not tilde_reported and el.tag in BLOCK_TAGS and not in_pre(el) and tildes(''.join(el.itertext())) >= 2:
            problems.append(f'feishu.xml 同一块内有两个及以上未转义的 ~（会被配成删除线）：{"".join(el.itertext()).strip()[:60]}')
            tilde_reported = True
        for k, v in el.attrib.items():
            if not tilde_reported and tildes(v) >= 2:
                problems.append(f'feishu.xml <{el.tag}> 的 {k} 属性里有两个及以上 ~：{v[:60]}')
                tilde_reported = True
            if k == 'path':
                if not v.startswith('@./'):
                    problems.append(f'feishu.xml <{el.tag}> 的 path 只允许 @./ 开头的运行目录相对路径：{v[:80]}')
                    continue
                rel = v[3:]
                full = os.path.join(c.run_dir, rel)
                if not rel or rel.startswith('/') or '..' in rel.replace('\\', '/').split('/') or not within(c.run_dir, full):
                    problems.append(f'feishu.xml 引用的资源越出运行目录：{rel}')
                elif not os.path.isfile(full):
                    problems.append(f'feishu.xml 引用的资源不存在：{rel}')
                else:
                    resources.append(rel)
    return problems, sorted(set(resources))


def read_record(path, label):
    """读 published.json；读不出或不合 schema 抛 Stop(2)。"""
    try:
        rec = load_json(path)
    except (OSError, ValueError) as ex:
        raise Stop(EXIT_USAGE, 'published.json', f'{label} 读不出（{ex}）：无法确认发布状态，人工核对后再发布')
    errs = check_record(rec) if isinstance(rec, dict) else ['不是 JSON 对象']
    if errs:
        raise Stop(EXIT_USAGE, 'published.json', f'{label} 不合 schema（旧格式或损坏）：无法确认发布状态，人工核对；覆盖已有文档用 --doc-token', errors=errs[:5])
    return rec


def intent_problems(obj):
    """新建意图文件结构校验；返回问题列表（空 = 合法）。"""
    if not isinstance(obj, dict):
        return [f'不是 JSON 对象（实际 {type(obj).__name__}）']
    probs = [f'缺少 {k}' for k in INTENT_FIELDS if k not in obj]
    if probs:
        return probs
    if obj['schema_version'] != '1': probs.append('schema_version 应为 "1"')
    for k in ('created_at', 'version', 'title', 'folder_path'):
        if not isinstance(obj[k], str) or not obj[k].strip(): probs.append(f'{k} 应为非空字符串')
    if not isinstance(obj['folder_token'], str) or not re.match(TOKEN_RE, obj['folder_token']): probs.append('folder_token 格式不对')
    if not isinstance(obj['source_sha256'], str) or not re.match(r'^[0-9a-f]{64}$', obj['source_sha256']): probs.append('source_sha256 格式不对')
    if not (isinstance(obj['argv'], list) and obj['argv'][:2] == ['docs', '+create'] and all(isinstance(x, str) for x in obj['argv'])): probs.append('argv 应为 docs +create 的参数数组')
    return probs


def is_recovery(rec):
    return bool(rec) and not rec.get('dry_run') and rec.get('verify') is None


def check_freshness(c, qa_path, rj_path, problems):
    """源文件是否在 D3 之后改过：有 gates.D3.source_manifest 时调用 run_state.py check-manifest 比内容哈希（lark_folder 字段级例外已含在清单口径里）；
    旧 run-state（或 D3 为 waived）没有清单时，退回严格修改时间比较（不留容差），并给警告。"""
    if c.source_manifest:
        guard_run_state_files(c)
        cmd = [sys.executable, os.path.join(DOC_SHARED, 'scripts', 'run_state.py'), c.run_dir, 'check-manifest']
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise Stop(EXIT_USAGE, 'check-manifest', 'run_state.py check-manifest 超时')
        try:
            body = json.loads(r.stdout)
        except ValueError:
            body = {}
        c.freshness = 'manifest'
        if r.returncode == 3:
            diff = {k: body.get(k) or [] for k in ('added', 'removed', 'changed')}
            problems.append(f'D3 签门之后源文件有变化（source_manifest 比对：新增 {diff["added"][:5]}，删除 {diff["removed"][:5]}，修改 {diff["changed"][:5]}）：重跑质检与渲染并重过 D3')
        elif r.returncode != 0:
            problems.append(f'run_state.py check-manifest 失败（退出码 {r.returncode}）：{(r.stdout + r.stderr).strip()[-200:]}')
        return
    c.freshness = 'mtime'
    c.warnings.append('run-state 没有 gates.D3.source_manifest（旧 run-state 或 D3 豁免）：退回严格修改时间比较，改内容后回拨修改时间的情况查不出；重过 D3 可得到内容清单')
    art = min(os.path.getmtime(qa_path), os.path.getmtime(rj_path))
    newer = [rel for rel in rsmod.source_files(c.run_dir) if rel != c.meta_file and os.path.getmtime(os.path.join(c.run_dir, rel)) > art]
    if newer:
        problems.append(f'质检或渲染之后又改过 {newer[:8]}：重跑质检与渲染（D3 需重过）')
    if os.path.getmtime(c.meta_path) > art:
        # 字段级例外：只允许本引擎写回 lark_folder。上一次发布记录里的元数据规范哈希与现在一致才放行
        ok = False
        root_pub = os.path.join(c.run_dir, 'published.json')
        if os.path.isfile(root_pub):
            try:
                prev = load_json(root_pub)
                ok = isinstance(prev, dict) and prev.get('meta_canonical_sha256') == meta_canonical_sha256(c.meta)
            except (OSError, ValueError):
                ok = False
        if not ok:
            problems.append(f'质检或渲染之后又改过 {c.meta_file}（且不是发布引擎写回 lark_folder）：重跑质检与渲染（D3 需重过）')


def preflight(c):
    gates = c.state['gates']
    allowed = {'D0': ('passed',), 'D1': ('passed',), 'D2': ('passed', 'skipped', 'waived')}
    order_bad = [g for g, ok in allowed.items() if gates[g]['status'] not in ok]
    d3 = gates['D3']['status']
    if order_bad or d3 not in ('passed', 'waived'):
        raise Stop(EXIT_REJECT, 'D3', f'D3 未通过（D3={d3}；状态不合要求的前序门：{order_bad}），不能发布',
                   gates={k: v['status'] for k, v in gates.items()})
    c.gate_d3 = d3
    problems = []
    qa_path = os.path.join(c.run_dir, 'qa-result.json')
    rj_path = os.path.join(c.run_dir, 'out', 'render.json')
    qa = rj = None
    for label, path, kind in (('qa-result.json', qa_path, 'qa-result'), ('out/render.json', rj_path, 'render')):
        if not os.path.isfile(path):
            problems.append(f'缺少 {label}'); continue
        try:
            data = load_json(path)
        except (OSError, ValueError) as ex:
            problems.append(f'{label} 读不出：{ex}'); continue
        errs, _ = validate.validate_data(kind, data)
        if errs:
            problems.append(f'{label} 不合 schema：' + '；'.join(f'{p} {m}' for p, m in errs[:3])); continue
        if kind == 'qa-result': qa = data
        else: rj = data
    if problems:
        raise Stop(EXIT_REJECT, 'artifacts', '质检或渲染产物不可用', problems=problems)
    check_freshness(c, qa_path, rj_path, problems)
    doc = current_doc(c)
    c.doc = doc
    c.source_sha256 = hashlib.sha256(doc.text.encode('utf-8')).hexdigest()
    for label, data in (('qa-result.json', qa), ('out/render.json', rj)):
        got = data.get('source_sha256')
        if not got:
            problems.append(f'{label} 没有 source_sha256（旧产物），重跑后再发布')
        elif got != c.source_sha256:
            problems.append(f'{label} 的 source_sha256 与当前正文不一致（{got[:12]}… ≠ {c.source_sha256[:12]}…）：产物之后正文被改过，重跑质检与渲染')
    if d3 == 'passed':
        if qa.get('must_fix') != 0:
            problems.append(f'qa-result.json must_fix={qa.get("must_fix")}')
        must = [x for x in rj.get('layout_issues', []) if x.get('severity') == '必改']
        if must:
            problems.append(f'render.json 版式必改 {len(must)} 条')
    else:
        c.warnings.append(f'D3 为 waived（{gates["D3"].get("reason", "")}）：不再检查必改清零，哈希一致性照查')
    pdf = rj.get('pdf') or {}
    feishu = rj.get('feishu') or {}
    if not pdf.get('path'):
        problems.append('render.json 没有 PDF（--printer none 的渲染不能发布）')
    elif not os.path.isfile(os.path.join(c.run_dir, pdf['path'])) or not within(c.run_dir, os.path.join(c.run_dir, pdf['path'])):
        problems.append(f'PDF 不存在或越出运行目录：{pdf["path"]}')
    if not feishu.get('path'):
        problems.append('render.json 没有飞书 XML（--no-feishu 的渲染不能发布）')
    elif not os.path.isfile(os.path.join(c.run_dir, feishu['path'])) or not within(c.run_dir, os.path.join(c.run_dir, feishu['path'])):
        problems.append(f'飞书 XML 不存在或越出运行目录：{feishu["path"]}')
    if problems:
        raise Stop(EXIT_REJECT, 'preflight', '发布预检未通过', problems=problems)
    c.render, c.qa = rj, qa
    c.pdf_rel, c.xml_rel = pdf['path'], feishu['path']
    try:
        with open(os.path.join(c.run_dir, c.xml_rel), encoding='utf-8') as f:
            c.xml = f.read()
    except (OSError, UnicodeError) as ex:
        raise Stop(EXIT_USAGE, 'io', f'feishu.xml 读不出：{type(ex).__name__}: {ex}')
    name, c.doc_date = expected_pdf_name(c, doc, rj['generated_at'][:10])
    if os.path.basename(c.pdf_rel) != name:
        problems.append(f'PDF 文件名 {os.path.basename(c.pdf_rel)} 与当前元数据按命名规则算出的 {name} 不一致：渲染之后改过标题、版本或日期，重新渲染')
    c.pdf_name = name
    try:
        c.xml_root = parse_xml(c.xml)
    except ET.ParseError as ex:
        raise Stop(EXIT_REJECT, 'preflight', f'feishu.xml 不是合法 XML（{ex}）：重新渲染')
    guard_problems, c.resources = xml_guard(c, c.xml_root)
    problems += guard_problems
    # docx：render.json 有 docx 字段时以它为准（null = 本次没出 docx）；旧 render.json 无该字段时才取与 PDF 同名的 .docx
    docx = rj.get('docx') if isinstance(rj.get('docx'), dict) else None
    docx_rel = (docx or {}).get('path') or os.path.splitext(c.pdf_rel)[0] + '.docx'
    docx_abs = os.path.join(c.run_dir, docx_rel)
    c.docx_rel = docx_rel if ('docx' not in rj or docx) and os.path.isfile(docx_abs) and within(c.run_dir, docx_abs) else None
    if docx and docx.get('path') and not c.docx_rel:
        problems.append(f'render.json 登记的 docx 不存在或越界：{docx["path"]}')
    if c.docx_rel and not docx and os.path.getmtime(docx_abs) < os.path.getmtime(os.path.join(c.run_dir, c.pdf_rel)):
        c.warnings.append(f'{c.docx_rel} 比 PDF 旧（不是本次渲染产物），不归档')
        c.docx_rel = None
    c.archive_rel = f'out/published/v{c.version}' + ('' if c.args.apply else '.dry-run')
    # 发布状态：运行目录根记录、正式归档记录、未决新建意图
    c.root_record = read_record(os.path.join(c.run_dir, 'published.json'), '运行目录 published.json') if os.path.isfile(os.path.join(c.run_dir, 'published.json')) else None
    formal_pub = os.path.join(c.run_dir, f'out/published/v{c.version}', 'published.json')
    c.formal_record = read_record(formal_pub, f'正式归档 v{c.version}/published.json') if os.path.isfile(formal_pub) else None
    intent_path = os.path.join(c.run_dir, INTENT_REL)
    c.intent, c.intent_present, c.intent_invalid = None, os.path.lexists(intent_path), None
    if c.intent_present:
        # 存在即未决：读不出、{}、[]、null、缺字段都不能当作没有意图
        try:
            if os.path.islink(intent_path):
                raise ValueError('意图文件是软链')
            obj = load_json(intent_path)
            probs = intent_problems(obj)
        except (OSError, ValueError) as ex:
            obj, probs = None, [f'读不出：{ex}']
        if probs:
            c.intent_invalid = probs
        else:
            c.intent = obj
    for label, rec in (('运行目录 published.json', c.root_record), (f'正式归档 v{c.version}', c.formal_record)):
        if not rec or rec.get('dry_run') or str(rec.get('version')) != c.version:
            continue
        if rec.get('source_sha256') != c.source_sha256:
            if is_recovery(rec) and c.args.abandon_recovery:
                c.warnings.append(f'{label} 是同版本、正文不同的恢复记录（{rec.get("lark_url")}），按 --abandon-recovery 放弃')
                continue
            problems.append(f'v{c.version} 已写入过飞书且正文不同（{label}：{rec.get("lark_url")}）：同一版本号不能发布两份内容，先升版本号'
                            + ('；该记录是恢复记录，用户确认放弃后可加 --abandon-recovery --evidence' if is_recovery(rec) else ''))
    if problems:
        raise Stop(EXIT_REJECT, 'preflight', '发布预检未通过', problems=problems)


def check_pending(c):
    """恢复记录与未决新建：需要用户决定的情形退出 8。--abandon-recovery --evidence 是唯一的放弃方式。"""
    a = c.args
    recovery = [r for r in (c.root_record, c.formal_record) if is_recovery(r)]
    if a.abandon_recovery:
        if not (recovery or c.intent_present):
            raise Stop(EXIT_USAGE, 'args', '--abandon-recovery 只在存在恢复记录或未决新建时使用')
        intent_trace = c.intent if c.intent is not None else ({'invalid': True, 'problems': c.intent_invalid} if c.intent_present else None)
        c.abandoned = {'previous_doc_id': (recovery[0].get('lark_doc_id') if recovery else None),
                       'previous_url': (recovery[0].get('lark_url') if recovery else None),
                       'intent': intent_trace, 'evidence': [e for e in a.evidence if e.strip()], 'at': now_iso()}
        c.warnings.append('按 --abandon-recovery 放弃恢复记录或未决新建：' + json.dumps({k: v for k, v in c.abandoned.items() if k != 'evidence'}, ensure_ascii=False)[:300])
        return
    c.abandoned = None
    if c.intent_present:
        if c.intent_invalid:
            raise Stop(EXIT_PENDING, 'pending-create', f'新建意图文件 {INTENT_REL} 存在但结构不对（{"；".join(c.intent_invalid)[:200]}）：视为未决新建，'
                       '先只读核对目标文件夹，确认后经用户同意加 --abandon-recovery --evidence 重跑', intent_problems=c.intent_invalid)
        if not a.doc_token:
            raise Stop(EXIT_PENDING, 'pending-create', '上一次 docs +create 结果不确定（可能已写入）：先只读定位意图记录的文件夹里是否已有这份文档；'
                       '找到了用 --doc-token <该文档 token> 覆盖（引擎会只读核对 token 属于该文件夹且同名），确认没建成则经用户确认后加 --abandon-recovery --evidence 重跑', intent=c.intent)
    if recovery and a.create:
        raise Stop(EXIT_PENDING, 'recovery', f'运行目录有恢复记录（已写入 {recovery[0].get("lark_url")}，回查未完成）：不允许 --create 再建一份；'
                   '不加 --create 重跑会覆盖该文档，确需另建须用户确认后加 --abandon-recovery --evidence', recovery_doc=recovery[0].get('lark_doc_id'))


def verify_intent_doc(c, lark, token):
    """有未决新建时，--doc-token 必须只读核对：在意图记录的文件夹里列目录，找到与意图标题同名的文档且 token 一致。"""
    it = c.intent
    if lark is None:
        raise Stop(EXIT_PENDING, 'pending-create', '离线模式无法只读核对 --doc-token 与未决新建是否对应')
    docs = [f for f in list_children(lark, it['folder_token']) if f.get('type') in ('docx', 'doc')]
    same = [f for f in docs if f.get('name') == it['title']]
    if not any(f.get('token') == token for f in same):
        raise Stop(EXIT_PENDING, 'pending-create', f'--doc-token {token} 不是意图记录文件夹（{it["folder_path"]}）里名为「{it["title"]}」的文档：不更新、不清除意图；'
                   '按 located_docs 核对后重跑，或经用户确认加 --abandon-recovery --evidence',
                   located_docs=[{'name': f.get('name'), 'token': f.get('token'), 'url': f.get('url')} for f in same], intent=it)
    c.warnings.append(f'--doc-token 已只读核对：属于未决新建的目标文件夹 {it["folder_path"]} 且同名「{it["title"]}」')


# ---------------------------------------------------------------- 钩子（只做检查、只输出 JSON）

HOOK_SHIM = '''#!/bin/sh
echo "doc-publish：发布钩子禁止调用 lark-cli（$*）" >&2
echo "$*" >> "$DOC_PUBLISH_HOOK_SHIM_LOG"
exit 97
'''


def artifact_snapshot(c):
    """钩子前后对整个运行目录递归快照（不跟随软链）：目录与权限位、普通文件权限位与 sha256、软链目标（及目标是文件时其 sha256）。
    只排除本进程持有的运行目录锁文件。"""
    snap = {}
    try:
        snap['.'] = f'dir:{oct(os.lstat(c.run_dir).st_mode & 0o7777)}'
    except OSError:
        snap['.'] = 'missing'
    for dpath, dns, fns in os.walk(c.run_dir, followlinks=False):
        for name in sorted(dns) + sorted(fns):
            full = os.path.join(dpath, name)
            rel = os.path.relpath(full, c.run_dir).replace(os.sep, '/')
            if rel == 'out/.publish.lock':
                continue
            try:
                st = os.lstat(full)
            except OSError:
                continue
            perm = oct(st.st_mode & 0o7777)
            if stat.S_ISLNK(st.st_mode):
                target = os.readlink(full)
                tsha = sha256_file(full) if os.path.isfile(full) else ('dir' if os.path.isdir(full) else 'dangling')
                snap[rel] = f'link:{target}:{tsha}'
            elif stat.S_ISDIR(st.st_mode):
                snap[rel] = f'dir:{perm}'
            elif stat.S_ISREG(st.st_mode):
                try:
                    snap[rel] = f'file:{perm}:{sha256_file(full)}'
                except OSError as ex:
                    snap[rel] = f'file:{perm}:unreadable:{ex.errno}'
            else:
                snap[rel] = f'other:{st.st_mode}'
    return snap


def run_hook(c, name, require_ok=False):
    """钩子只做检查、只在 stdout 输出 JSON：受控环境（清空继承环境、临时 HOME、空 lark-cli 配置目录）、
    PATH 最前面放拦截 lark-cli 的 shim；调用 lark-cli 或改动运行目录都判为钩子失败（E-HOOK）。dry-run 同样适用。"""
    hk = (c.pack.get('hooks') or {}).get(name)
    if not hk:
        return None, None
    vals = {'run_dir': c.run_dir, 'pack_dir': c.pack_dir or '', 'skills_dir': SKILLS, 'doc_shared': DOC_SHARED, 'python': sys.executable}
    argv = [re.sub(r'\{(' + '|'.join(HOOK_PLACEHOLDERS) + r')\}', lambda m: vals[m.group(1)], x) for x in hk.get('command', [])]
    sandbox = tempfile.mkdtemp(prefix='doc-publish-hook-')
    try:
        shim_dir = os.path.join(sandbox, 'bin'); os.makedirs(shim_dir)
        shim_log = os.path.join(sandbox, 'lark-calls.log')
        for exe in ('lark-cli', 'lark'):
            p = os.path.join(shim_dir, exe)
            with open(p, 'w') as f: f.write(HOOK_SHIM)
            os.chmod(p, 0o755)
        home = os.path.join(sandbox, 'home'); os.makedirs(home)
        empty_cfg = os.path.join(sandbox, 'lark-config'); os.makedirs(empty_cfg)
        env = {'PATH': os.pathsep.join([shim_dir, os.path.dirname(sys.executable), '/usr/bin', '/bin']),
               'HOME': home, 'TMPDIR': sandbox, 'LANG': os.environ.get('LANG', 'en_US.UTF-8'), 'LC_ALL': os.environ.get('LC_ALL', 'en_US.UTF-8'),
               'LARKSUITE_CLI_CONFIG_DIR': empty_cfg, 'DOC_PUBLISH_HOOK_SHIM_LOG': shim_log,
               'DOC_RUN_DIR': c.run_dir, 'DOC_PACK_DIR': c.pack_dir or '', 'DOC_SHARED': DOC_SHARED, 'DOC_TYPE': c.doc_type,
               'DOC_PUBLISH_DRY_RUN': '0' if c.args.apply else '1', 'DOC_PUBLISH_HOOK': name}
        if getattr(c, 'published', None):
            env['DOC_PUBLISHED_JSON'] = json.dumps(c.published, ensure_ascii=False)
        before = artifact_snapshot(c)
        timed_out, run_error, r = False, None, None
        try:
            r = subprocess.run(argv, cwd=c.run_dir, capture_output=True, text=True, timeout=hk.get('timeout_s', 600), env=env)
        except subprocess.TimeoutExpired:
            timed_out = True
        except OSError as ex:
            run_error = ex
        # 钩子退出后等 1 秒再做后快照（低成本防线：拦住钩子留下的短延迟后台改动；不防恶意钩子，见 SKILL.md 威胁模型）；
        # 超时、无法执行、触发拦截 shim 时也先做后快照比对，残留改动写进消息
        time.sleep(1.0)
        after = artifact_snapshot(c)
        changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
        residual = f'；运行目录残留改动 {len(changed)} 处：{changed[:8]}（钩子不得改动运行目录，需人工核对恢复）' if changed else ''
        if timed_out:
            return None, f'E-HOOK {name} 超时（{hk.get("timeout_s", 600)} 秒）{residual}'
        if run_error is not None:
            return None, f'E-HOOK {name} 无法执行：{run_error}{residual}'
        if os.path.isfile(shim_log):
            calls = open(shim_log).read().strip().splitlines()
            return None, f'E-HOOK {name} 调用了 lark-cli（发布钩子只允许做检查并输出 JSON，飞书读写一律由引擎发起）：{calls[:3]}{residual}'
        if changed:
            return None, f'E-HOOK {name} 改动了运行目录（发布钩子只允许做检查）：{changed[:8]}'
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)
    tail = (r.stdout + r.stderr).strip()[-300:]
    body = None
    try:
        body = json.loads(r.stdout) if r.stdout.strip() else {}
    except ValueError:
        pass
    if r.returncode not in (hk.get('pass_exit_codes') or [0]):
        return body, f'{name} 退出码 {r.returncode}：{tail}'
    if not isinstance(body, dict):
        return None, f'{name} stdout 不是 JSON 对象：{r.stdout.strip()[:120]}'
    if body.get('ok') is False:
        return body, f'{name} 返回 ok=false：{body.get("message", "")}'
    if require_ok and body.get('ok') is not True:
        return body, f'{name} 必须返回 ok=true（pack-interface.md §3），实际 ok={body.get("ok")!r}：{body.get("message", "")}'
    if 'extra' in body and not isinstance(body['extra'], dict):
        return body, f'{name} 的 extra 不是对象'
    return body, None


# ---------------------------------------------------------------- 归档

def archive(c):
    """先写暂存目录 out/published/.staging-v<版本>[.dry-run]/，成功后 finalize_archive 换成正式目录
    （apply：飞书写入成功后；dry-run：计划与记录都通过后）。失败时由 main 清掉暂存，旧归档不动。记录里的 path 一律是正式路径。"""
    suffix = '' if c.args.apply else '.dry-run'
    stage_rel = f'out/published/.staging-v{c.version}{suffix}'
    guard_rel(c, c.archive_rel, '正式归档目录')
    c.stage_dir = guard_rel(c, stage_rel, '暂存归档目录')
    if os.path.isdir(c.stage_dir):
        shutil.rmtree(c.stage_dir)
    os.makedirs(c.stage_dir)
    items = [('pdf', c.pdf_rel, c.pdf_name), ('feishu_xml', c.xml_rel, 'feishu.xml'),
             ('render_json', 'out/render.json', 'render.json'), ('qa_result', 'qa-result.json', 'qa-result.json')]
    if c.docx_rel:
        items.insert(1, ('docx', c.docx_rel, os.path.splitext(c.pdf_name)[0] + '.docx'))
    if os.path.isfile(os.path.join(c.run_dir, 'qa-report.md')):
        items.append(('qa_report', 'qa-report.md', 'qa-report.md'))
    items += [('resource', rel, rel) for rel in c.resources]
    out = []
    for role, src, name in items:
        target = guard_rel(c, f'{stage_rel}/{name}', '暂存归档文件')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(c.run_dir, src), target)
        out.append({'role': role, 'source': src, 'path': f'{c.archive_rel}/{name}', 'bytes': os.path.getsize(target), 'sha256': sha256_file(target)})
    c.archive = out
    c.archived = {x['role']: x['path'] for x in out if x['role'] != 'resource'}


def finalize_archive(c):
    """暂存 → 正式：旧正式目录先改名为备份，换入失败则还原，成功后删备份。"""
    formal = guard_rel(c, c.archive_rel, '正式归档目录')
    guard_rel(c, os.path.relpath(c.stage_dir, c.run_dir), '暂存归档目录')
    backup = None
    if os.path.isdir(formal):
        backup = guard_rel(c, f'{c.archive_rel}.bak-{os.getpid()}', '归档备份目录')
        if os.path.isdir(backup):
            shutil.rmtree(backup)
        os.rename(formal, backup)
    try:
        os.rename(c.stage_dir, formal)
    except OSError:
        if backup:
            os.rename(backup, formal)
        raise
    c.stage_dir = None
    if backup:
        shutil.rmtree(backup, ignore_errors=True)


# ---------------------------------------------------------------- lark-cli（doc-shared/scripts/lark_io.py：命令读写判定、写锁、确认门、文件夹解析，与 export_cases_sheet 共用）

UNCERTAIN = lark_io.UNCERTAIN


def resolve_folder(c, lark, allow_create):
    """返回 {token, path, created[], planned[], source}。落点取元数据 lark_folder（path 至少「客户或项目/子项目」两段，给了 token 时末级必须一致），
    解析、新建与归属拿不准退出 5 的规则见 lark_io.resolve_folder。"""
    lf = c.meta.get('lark_folder') or {}
    return lark_io.resolve_folder(lark, lf.get('path'), lf.get('token'), allow_create, c.args.allow_new_project_folder,
                                  path_label=f'{c.meta_file} lark_folder.path', verb='发布', warnings=c.warnings)


def write_back_folder(c, folder):
    """把解析或新建得到的 token 写回元数据 lark_folder（D4 要求 token）。只改这一个字段，修改时间照常更新；
    新鲜度检查对 lark_folder 做字段级例外（source_manifest 的元数据哈希不含 lark_folder）。"""
    guard_rel(c, c.meta_file, '元数据文件', file=True)
    meta = load_json(c.meta_path)
    meta['lark_folder'] = {'token': folder['token'], 'path': folder['path']}
    write_json(c.meta_path, meta)
    c.meta = meta


def guard_run_state_files(c):
    """调用 run_state.py 之前：run-state.json、.lock、.tmp 逐级校验，不允许软链、不越出运行目录（run_state.py 自身另用 O_NOFOLLOW 打开 lock 与 tmp）。"""
    for rel in ('run-state.json', 'run-state.json.lock', 'run-state.json.tmp'):
        guard_rel(c, rel, 'run-state 文件')


def run_state(c, *args):
    guard_run_state_files(c)
    cmd = [sys.executable, os.path.join(DOC_SHARED, 'scripts', 'run_state.py'), c.run_dir] + list(args) + ['--pack', c.pack_dir]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise Stop(EXIT_USAGE, 'run-state', f'run_state.py {args[0]} 超时')
    try:
        body = json.loads(r.stdout)
    except ValueError:
        body = {'raw': (r.stdout + r.stderr)[-300:]}
    return r.returncode, body


def count_verify(content):
    """回查计数：能按 XML 解析就按解析结果数，解析不了（服务端返回片段不规整）退回正则。"""
    try:
        root = parse_xml(content)
        parent = {ch: p for p in root.iter() for ch in p}

        def in_pre(el):
            while el is not None:
                if el.tag == 'pre': return True
                el = parent.get(el)
            return False
        text = ''.join(t for el in root.iter() if not in_pre(el) for t in ([el.text or ''] + [ch.tail or '' for ch in el]))
        return {'whiteboards': sum(1 for _ in root.iter('whiteboard')), 'images': sum(1 for _ in root.iter('img')),
                'code': sum(1 for _ in root.iter('pre')), 'inline_code': sum(1 for el in root.iter('code') if not in_pre(el)),
                'italic': sum(1 for el in root.iter() if el.tag in ('i', 'em')), 'del': sum(1 for _ in root.iter('del')),
                'asterisks': text.count('*')}
    except ET.ParseError:
        no_pre = re.sub(r'<pre[\s>].*?</pre>', '', content, flags=re.S)
        return {'whiteboards': len(re.findall(r'<whiteboard[\s>]', content)), 'images': len(re.findall(r'<img[\s>/]', content)),
                'code': len(re.findall(r'<pre[\s>]', content)), 'inline_code': len(re.findall(r'<code[\s>]', no_pre)),
                'italic': len(re.findall(r'<(?:i|em)[\s>]', content)), 'del': len(re.findall(r'<del[\s>]', content)),
                'asterisks': re.sub(r'<[^>]+>', '', no_pre).count('*')}


# ---------------------------------------------------------------- 主流程

def build_record(c, mode, folder, doc_id, url, verify, problems, extra, plan):
    rec = {'schema_version': '1', 'dry_run': not c.args.apply, 'engine': ENGINE, 'doc_type': c.doc_type,
           'title': c.meta.get('title') or c.doc.title or '', 'version': c.version,
           'date': c.doc_date, 'published_at': now_iso(),
           'lark_doc_id': doc_id, 'lark_url': url, 'lark_profile': c.profile,
           'lark_folder': {'token': folder.get('token'), 'path': folder.get('path'), 'created': folder.get('created', [])},
           'mode': mode, 'source_sha256': c.source_sha256, 'meta_canonical_sha256': meta_canonical_sha256(c.meta), 'gate_d3': c.gate_d3,
           'freshness_check': getattr(c, 'freshness', 'mtime'),
           'pdf_path': c.archived['pdf'], 'docx_path': c.archived.get('docx'), 'feishu_xml_path': c.archived['feishu_xml'],
           'render_json_path': c.archived['render_json'], 'qa_result_path': c.archived['qa_result'], 'qa_report_path': c.archived.get('qa_report'),
           'archive_dir': c.archive_rel, 'archive': c.archive, 'verify': verify, 'problems': list(problems),
           'warnings': list(dict.fromkeys(c.warnings)), 'extra': extra}
    if getattr(c, 'abandoned', None):
        rec['recovery_abandoned'] = c.abandoned
    if plan is not None: rec['plan'] = plan
    return rec


def check_record(rec):
    schema = load_json(SCHEMA_PATH)
    return [f'{p}：{m}' for p, m in validate.check(rec, schema, schema)]


def save_record(c, rec, where):
    """校验通过才写（artifacts.md §7）。where：目录列表。"""
    errs = check_record(rec)
    if errs:
        raise Stop(EXIT_VERIFY if c.args.apply and rec.get('lark_doc_id') else EXIT_USAGE, 'published-schema',
                   'published.json 不合 schema（引擎缺陷），未写入', errors=errs[:10])
    for d in where:
        write_json(guard_rel(c, os.path.relpath(os.path.join(d, 'published.json'), c.run_dir), '发布记录', file=True), rec)


def infer_doc_token(c):
    """覆盖目标：运行目录根记录（非 dry-run）的 lark_doc_id。放弃恢复记录时不从恢复记录推断。"""
    rec = c.root_record
    if not rec or rec.get('dry_run'):
        return None
    if is_recovery(rec) and c.args.abandon_recovery:
        return None
    tok = rec.get('lark_doc_id')
    if tok and not re.match(TOKEN_RE, tok):
        raise Stop(EXIT_USAGE, 'published.json', f'运行目录 published.json 的 lark_doc_id 格式不对：{tok}')
    return tok


def run(a, out, holder):
    if a.apply and a.dry_run:
        raise Stop(EXIT_USAGE, 'args', '--apply 与 --dry-run 不能同时给')
    if a.apply and a.offline:
        raise Stop(EXIT_USAGE, 'args', '--offline 只能用于 dry-run')
    if (a.apply or a.abandon_recovery) and not [e for e in a.evidence if e.strip()]:
        raise Stop(EXIT_USAGE, 'args', '--apply 与 --abandon-recovery 必须带 --evidence（用户确认的原话）')
    if a.doc_token and not re.match(TOKEN_RE, a.doc_token):
        raise Stop(EXIT_USAGE, 'args', f'--doc-token 格式不对：{a.doc_token}')
    c = load_context(a)
    holder['c'] = c
    lock_path = guard_rel(c, 'out/.publish.lock', '运行目录锁文件', file=True)
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    holder['lock'] = lock = open(lock_path, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        holder['lock'] = None; lock.close()
        raise Stop(EXIT_USAGE, 'lock', '另一个 doc-publish 进程正在发布这个运行目录，等它结束再跑')
    preflight(c)
    check_pending(c)
    hook_body, hook_err = run_hook(c, 'pre_publish', require_ok=True)
    if hook_err:
        raise Stop(EXIT_HOOK, 'pre_publish', hook_err, rule='E-HOOK', hook_output=hook_body)
    # 钩子被禁止改动运行目录（上面已按快照比对）；仍重新加载上下文并重做预检，之后只用这次的结果
    c = load_context(a)
    holder['c'] = c
    preflight(c)
    check_pending(c)
    extra = dict((hook_body or {}).get('extra') or {})
    out.update(run_dir=c.run_dir, doc_type=c.doc_type, version=c.version, source_sha256=c.source_sha256, gate_d3=c.gate_d3, freshness_check=c.freshness)

    # 模式（dry-run 与 apply 同一推断；在任何 lark-cli 调用之前）
    doc_token, token_source = None, None
    if a.doc_token:
        doc_token, token_source = a.doc_token, '--doc-token'
    elif not a.create:
        doc_token = infer_doc_token(c)
        token_source = 'published.json' if doc_token else None
    mode = 'overwrite' if doc_token else 'create'
    out.update(mode=mode, doc_token=doc_token, doc_token_source=token_source)

    lark = None if a.offline else lark_io.Lark(c.run_dir, c.profile, a.apply, UNCERTAIN)
    if c.intent is not None and a.doc_token and not a.abandon_recovery:
        verify_intent_doc(c, lark, a.doc_token)
    want = count_verify(c.xml)
    exp_boards = (c.render.get('feishu') or {}).get('whiteboards', want['whiteboards'])
    if exp_boards != want['whiteboards']:
        raise Stop(EXIT_REJECT, 'preflight', f'render.json 登记画板 {exp_boards} 与 feishu.xml 实际 {want["whiteboards"]} 不一致：飞书 XML 不是这次渲染的产物')
    xml_arg = '@./' + c.xml_rel
    if lark:
        d = lark.call(['docs', '+script', '--as', 'user', '--command', 'parse', '--content', xml_arg], 'parse')
        st = ((d.get('data') or {}).get('assessment') or {}).get('status')
        if st != 'passed':
            raise Stop(EXIT_REJECT, 'parse', f'feishu.xml 预检未通过（assessment.status={st}）', diagnostics=((d.get('data') or {}).get('diagnostics') or [])[:10])

    if mode == 'create' and c.state.get('base_doc'):
        c.warnings.append(f'run-state 登记了 base_doc（{c.state["base_doc"]}）但本次新建文档；要保持旧链接请用 --doc-token 覆盖')

    if mode == 'overwrite' and lark:
        n, page, seen = 0, '', set()
        for _ in range(MAX_PAGES):
            args = ['drive', '+list-comments', '--as', 'user', '--token', doc_token, '--type', 'docx', '--solved-status', 'all']
            if page: args += ['--page-token', page]
            d = lark.call(args, 'list-comments')
            data = d.get('data') or {}
            n += len(data.get('items') or [])
            if not data.get('has_more'): break
            page = data.get('page_token') or data.get('next_page_token') or ''
            if not page or page in seen:
                raise Stop(EXIT_LARK, 'list-comments', '评论分页不完整，无法确认评论数为 0')
            seen.add(page)
        else:
            raise Stop(EXIT_LARK, 'list-comments', f'评论超过 {MAX_PAGES} 页仍未读完，无法确认评论数，不覆盖')
        out['comments'] = n
        if n:
            raise Stop(EXIT_COMMENTS, 'list-comments', f'覆盖目标有 {n} 条评论，overwrite 会丢评论：请编排层问用户是否改用 --create 新建', comments=n)

    archive(c)
    out.update(archive_dir=c.archive_rel)
    # 归档完成后、写飞书前再核一次源文件清单（钩子遗留的后台改动、归档期间的误改）
    late = []
    check_freshness(c, os.path.join(c.run_dir, 'qa-result.json'), os.path.join(c.run_dir, 'out', 'render.json'), late)
    if late:
        raise Stop(EXIT_REJECT, 'recheck', '归档后复核发现源文件有变化，未写飞书', problems=late)

    if not a.apply:
        folder = resolve_folder(c, lark, allow_create=False)
        writes = []
        if mode == 'create':
            writes += [['drive', '+create-folder', '--as', 'user', '--name', p['name']] + (['--folder-token', p['parent_token']] if p['parent_token'] else []) for p in folder['planned']]
            writes.append(['docs', '+create', '--as', 'user', '--doc-format', 'xml', '--content', xml_arg, '--parent-token',
                           folder['token'] or f'<待建:{folder["planned"][-1]["name"]}>'])
        else:
            writes.append(['docs', '+update', '--as', 'user', '--doc', doc_token, '--command', 'overwrite', '--doc-format', 'xml', '--content', xml_arg])
        plan = {'writes': writes, 'folders_to_create': folder['planned'], 'd4_ready': bool(folder.get('token')),
                'd4_note': '真发布需 --apply --evidence「用户原话」；D4 由本脚本在写飞书前调用 run_state.py pass-gate 写入'}
        rec = build_record(c, mode, folder, doc_token, None, None, [], extra, plan)
        save_record(c, rec, [c.stage_dir])
        finalize_archive(c)
        out.update(ok=True, folder=folder, plan=plan, archive=c.archive, published_json=f'{c.archive_rel}/published.json', warnings=rec['warnings'],
                   lark_calls=[x['args'][:2] for x in (lark.calls if lark else [])], whiteboards_expected=want['whiteboards'], images_expected=want['images'])
        return EXIT_OK

    # ---- apply：先用占位值校验一次记录结构，确保写飞书之后一定写得出合法记录
    lf = c.meta.get('lark_folder') or {}
    placeholder = {'token': 'fldPlaceholder', 'path': 'placeholder/placeholder', 'created': []}  # 只校验记录结构；落点的合法性由 resolve_folder 判定（退出码 5）
    errs = check_record(build_record(c, mode, placeholder, doc_token or 'doxPlaceholder', 'https://feishu.cn/docx/doxPlaceholder',
                                     {'whiteboards': 0, 'whiteboards_expected': 0, 'images': 0, 'images_expected': 0, 'code': 0, 'code_expected': 0, 'inline_code': 0, 'italic': 0, 'del': 0, 'asterisks_extra': 0}, [], extra, None))
    if errs:
        raise Stop(EXIT_USAGE, 'published-schema', 'published.json 结构预校验不通过（引擎缺陷或钩子 extra 异常），未写飞书', errors=errs[:10])
    folder = resolve_folder(c, lark, allow_create=mode == 'create')
    out['folder'] = folder
    if folder['token'] and (lf.get('token') != folder['token'] or (lf.get('path') or '').strip('/') != folder['path']):
        write_back_folder(c, folder)
    code, body = run_state(c, 'pass-gate', '--gate', 'D4', '--by', a.by, *sum([['--evidence', e] for e in a.evidence], []))
    if code != 0:
        raise Stop(EXIT_REJECT, 'D4', 'run_state.py 拒绝 D4', run_state=body)
    code, body = run_state(c, 'set-stage', 'publish', '--by', a.by)
    if code != 0:
        raise Stop(EXIT_REJECT, 'set-stage', 'run_state.py set-stage publish 失败，未写飞书', run_state=body)

    problems = []
    intent_path = os.path.join(c.run_dir, INTENT_REL)
    if mode == 'overwrite':
        r = lark.call(['docs', '+update', '--as', 'user', '--doc', doc_token, '--command', 'overwrite', '--doc-format', 'xml', '--content', xml_arg], 'write')
        doc_id, url = doc_token, None
        data = r.get('data') or {}
        if data.get('result') != 'success':
            problems.append(f'overwrite 结果 {data.get("result")}：回查文档后局部修复')
    else:
        # 新建意图先落盘：create 结果不确定（超时、限流、无响应、响应缺字段）时它留在原地，下次发布被拦下，先只读定位
        create_args = ['docs', '+create', '--as', 'user', '--doc-format', 'xml', '--content', xml_arg, '--parent-token', folder['token']]
        intent_path = guard_rel(c, INTENT_REL, '新建意图文件', file=True)
        os.makedirs(os.path.dirname(intent_path), exist_ok=True)
        intent = {'schema_version': '1', 'created_at': now_iso(), 'version': c.version, 'source_sha256': c.source_sha256,
                  'folder_token': folder['token'], 'folder_path': folder['path'], 'title': xml_title(c), 'argv': create_args}
        assert not intent_problems(intent), intent_problems(intent)
        write_json(intent_path, intent)
        try:
            r = lark.call(create_args, 'write')
        except Stop as ex:
            if ex.code == EXIT_CONFIRM and os.path.lexists(intent_path):
                # 确认门 envelope 表明请求没有执行：删掉刚写的意图；没有 envelope 的失败是退出 7，意图保留
                os.remove(intent_path)
                ex.payload['intent_cleared'] = True
            raise
        data = r.get('data') or {}
        doc = data.get('document') or {}
        doc_id, url = doc.get('document_id'), doc.get('url')
        if not doc_id or not re.match(TOKEN_RE, str(doc_id)):
            raise Stop(EXIT_LARK, 'write', f'docs +create 响应没有合法的 data.document.document_id：{UNCERTAIN}（目标文件夹 {folder["path"]}）',
                       lark_response=json.dumps(r, ensure_ascii=False)[:300], uncertain_write=True)
    warnings = data.get('warnings') or []
    if not url: url = f'https://feishu.cn/docx/{doc_id}'
    out.update(lark_doc_id=doc_id, lark_url=url)
    # 恢复记录先落运行目录根（下次推断覆盖目标只读它），再清新建意图、把暂存归档转正式、在归档里写同一份
    recovery = build_record(c, mode, folder, doc_id, url, None, problems + ['已写入飞书，回查尚未完成（本记录未被更新说明回查中断，重跑发布会按 lark_doc_id 覆盖）'], extra, None)
    save_record(c, recovery, [c.run_dir])
    if os.path.lexists(intent_path):
        os.remove(intent_path)
    finalize_archive(c)
    formal = os.path.join(c.run_dir, c.archive_rel)
    save_record(c, recovery, [formal])

    f = lark.call(['docs', '+fetch', '--as', 'user', '--doc', doc_id], 'verify-fetch')
    content = ((f.get('data') or {}).get('document') or {}).get('content')
    if not isinstance(content, str):
        raise Stop(EXIT_LARK, 'verify-fetch', 'docs +fetch 响应没有 data.document.content：回查未完成，恢复记录已留', lark_response=json.dumps(f, ensure_ascii=False)[:300])
    got = count_verify(content)
    code_allowed = bool(c.features.get('code_blocks'))
    exp_code = len(c.doc.code_blocks) if code_allowed else 0  # 期望值取源文件（DocMark）代码块数，feishu.md §7
    verify = {'whiteboards': got['whiteboards'], 'whiteboards_expected': exp_boards, 'images': got['images'], 'images_expected': want['images'],
              'code': got['code'], 'code_expected': exp_code, 'inline_code': got['inline_code'], 'italic': got['italic'], 'del': got['del'],
              'asterisks_extra': max(0, got['asterisks'] - want['asterisks'])}
    if got['whiteboards'] != exp_boards:
        problems.append(f'画板 {got["whiteboards"]}/{exp_boards}：有图解析失败，修 SVG 后用 docs +update block_insert_after 在对应图注前补插，不重建文档')
    if got['images'] < want['images']:
        problems.append(f'图片 {got["images"]}/{want["images"]}')
    if got['code'] != exp_code:
        problems.append(f'代码块 {got["code"]}/{exp_code}' + ('' if code_allowed else '（类型包不允许代码块）'))
    for k, label in (('inline_code', '行内代码'), ('italic', '斜体'), ('del', '删除线')):
        if got[k]: problems.append(f'{label}残留 {got[k]}')
    if verify['asterisks_extra']:
        problems.append(f'字面 * 残留 {verify["asterisks_extra"]}（加粗未生效）')
    if warnings:
        problems.append('服务端警告：' + json.dumps(warnings, ensure_ascii=False)[:300])

    c.published = {'lark_doc_id': doc_id, 'lark_url': url, 'mode': mode}
    post_body, post_err = run_hook(c, 'post_publish')
    if post_err:
        problems.append(f'post_publish：{post_err}')
    elif post_body and isinstance(post_body.get('extra'), dict):
        extra.update(post_body['extra'])

    rec = build_record(c, mode, folder, doc_id, url, verify, problems, extra, None)
    save_record(c, rec, [formal, c.run_dir])
    out.update(ok=not problems, verify=verify, problems=problems, archive=c.archive, warnings=rec['warnings'], published_json='published.json',
               lark_calls=[x['args'][:2] for x in lark.calls])
    return EXIT_VERIFY if problems else EXIT_OK


def main(argv):
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument('run_dir')
    ap.add_argument('--apply', action='store_true'); ap.add_argument('--dry-run', action='store_true', help='默认即 dry-run，写上只为显式')
    ap.add_argument('--evidence', action='append', default=[])
    g = ap.add_mutually_exclusive_group(); g.add_argument('--doc-token'); g.add_argument('--create', action='store_true')
    ap.add_argument('--abandon-recovery', action='store_true')
    ap.add_argument('--profile'); ap.add_argument('--pack'); ap.add_argument('--allow-new-project-folder', action='store_true')
    ap.add_argument('--offline', action='store_true'); ap.add_argument('--by', default='doc-publish')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return EXIT_USAGE
    out, holder = {'dry_run': not a.apply}, {}
    code = EXIT_USAGE
    try:
        code = run(a, out, holder)
    except Stop as s:
        code = s.code
        out.update(ok=False, step=s.step, message=s.message, **s.payload)
    except (OSError, UnicodeError, ValueError, subprocess.TimeoutExpired) as ex:  # JSONDecodeError 是 ValueError
        code = EXIT_USAGE
        out.update(ok=False, step='io', message=f'读写或解析错误（pack.json、元数据、schema 等）：{type(ex).__name__}: {ex}')
    finally:
        c = holder.get('c')
        stage = getattr(c, 'stage_dir', None) if c is not None else None
        if stage and os.path.isdir(stage):  # 没走到转正：暂存作废，旧归档不动，不留伪「已归档」版本
            shutil.rmtree(stage, ignore_errors=True)
            out['archive_dir'] = None
        lock = holder.get('lock')
        if lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_UN)
            finally:
                lock.close()
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
