#!/usr/bin/env python3
"""run-state.json 的唯一写入口。引擎脚本在阶段完成时调用，不靠人记（修 assessment §5 第 14 条）。
用法（<运行目录> 在前）：
  run_state.py <dir> init --type prd --mode new|revision|import [--base-doc URL --base-version 3.1] [--force]
  run_state.py <dir> set-stage <stage> [--by 谁]
  run_state.py <dir> pass-gate --gate D0..D4 [--evidence 文本]... [--by 谁] [--run]
  run_state.py <dir> skip-gate --gate D2 --reason 文本 [--by 谁]
  run_state.py <dir> waive-gate --gate D2|D3 --reason 文本 --by 谁
  run_state.py <dir> fail-gate --gate Dn --reason 文本 [--by 谁]
  run_state.py <dir> reset-gate --gate Dn [--reason 文本]        （Dn 及其后的门全部回到 pending，改版重开用）
  run_state.py <dir> decide --key ① --value "A …" [--user-words "原话"]
  run_state.py <dir> show
  run_state.py <dir> check-manifest                         （当前源文件与 gates.D3.source_manifest 比对；一致退出 0，不一致退出 3）
公共选项：--pack <pack.json 或类型包目录>；--no-pack（找不到类型包时显式声明跳过包相关检查，会记入 checks）。
类型包查找顺序：--pack → 环境变量 DOC_TYPES_DIRS（冒号分隔的 types 根目录）→ doc-shared/types/<type>/。
门规则（详见 references/gates.md）：
  前序门未 passed/skipped/waived 时拒绝后序门。
  D0 自动校验 doc.json（schema + 语义）与类型包 inputs；元数据文件为 doc.json 时，没有 path / doc_field 的必需输入读 brief.json inputs，缺失或为空即拒绝；
     brief.json 存在时按 validate.validate_brief(family='doc_brief', strict=True, pack=类型包) 校验，错误拒绝，警告以「notes：」写进 checks（gate schema 无 notes 字段）。
  D1 必须有 --evidence；outline 文件（类型包 outline_file，默认 outline.md）存在；decisions 至少有一条，且不少于 outline 里 ①② 拍板项数。
  D2 类型包 gates.D2 为 null 时只能 skip-gate；有命令时必须 --run（不带 --run 拒绝），并需 --evidence，按 pass_exit_codes 判定。
  D3 自动检查：qa-result.json 合法、must_fix 为 0；out/render.json 合法、layout_issues 无必改；质检、渲染之后源文件未再修改（严格比较，无容差）；
     qa-report.md 人工区块（qa-auto 标记之外）非空、出现 Codex，且非标题的正文行里同时记有「找茬」「证伪」两轮；--evidence 须能定位（写出运行目录内存在的文件名，或 qa-report.md 的某个标题）。
     通过时写 gates.D3.source_manifest（源文件路径 + SHA-256；doc.json / brief.json 去掉 lark_folder 后计算）；D3 回到 pending 或 failed 时清掉。
  D4 自动检查：doc.json lark_folder 有 token；需 --evidence（用户看过 PDF 并确认范围、版本、账号、文件夹）。
退出码：0 成功；1 规则拒绝（check-manifest：没有 manifest）；2 用法或读写错误；3 check-manifest 发现源文件与 manifest 不一致。"""
import argparse, datetime, fcntl, glob, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILLS = os.path.dirname(ROOT)
sys.path.insert(0, HERE)
import validate  # noqa: E402

GATES = ['D0', 'D1', 'D2', 'D3', 'D4']
DONE = {'passed', 'skipped', 'waived'}
GENERIC_STAGES = ['intake', 'outline', 'author', 'figures', 'render', 'qa', 'review', 'publish', 'done']
# 判断「质检或渲染之后是否又改过正文」时不计入的路径（这些是质检、渲染、发布自己的产物）
NOT_SOURCE = ('out/', 'base/', '.git/')
NOT_SOURCE_FILES = {'qa-result.json', 'qa-report.md', 'run-state.json', 'run-state.json.lock', 'published.json'}
MTIME_SLACK = 2.0   # 仅 doc-publish 仍引用（另派修改）；本文件的 D3 判定一律严格比较，不用它
QA_AUTO_START, QA_AUTO_END = '<!-- qa-auto:start -->', '<!-- qa-auto:end -->'
META_FILES = ('doc.json', 'brief.json')


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def emit(ok, **kw):
    print(json.dumps({'ok': ok, **kw}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def find_pack(doc_type, pack_arg):
    cands = []
    if pack_arg:
        cands.append(pack_arg if pack_arg.endswith('.json') else os.path.join(pack_arg, 'pack.json'))
    for d in filter(None, os.environ.get('DOC_TYPES_DIRS', '').split(':')):
        cands.append(os.path.join(os.path.expanduser(d), doc_type, 'pack.json'))
    cands.append(os.path.join(ROOT, 'types', doc_type, 'pack.json'))
    for c in cands:
        if os.path.exists(c):
            return json.load(open(c)), os.path.dirname(os.path.abspath(c))
    return None, None


def load_state(path):
    return json.load(open(path))


def write_state(path, state):
    errors, _ = validate.validate_data('run-state', state)
    if errors:
        raise SystemExit(json.dumps({'ok': False, 'step': 'validate-before-write', 'errors': [{'path': p, 'message': m} for p, m in errors]}, ensure_ascii=False, indent=2))
    tmp = path + '.tmp'
    # O_NOFOLLOW：run-state.json.tmp 是软链时拒绝，不跟随写到运行目录外（W3-D2 定点修改）
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644), 'w') as f:
        json.dump(state, f, ensure_ascii=False, indent=2); f.write('\n')
    os.replace(tmp, path)


def _excluded(rel):
    base = rel.rsplit('/', 1)[-1]
    return (any(rel.startswith(x) for x in NOT_SOURCE) or rel in NOT_SOURCE_FILES or base in NOT_SOURCE_FILES
            or base.endswith('.tmp') or base.endswith('.lock'))


def referenced_files(run_dir, pack=None):
    """解析器实际引用到的运行目录内文件（隐藏路径也算）：include（含嵌套）、图源与构建出的 SVG、数据块文件、本地链接。
    只收存在的普通文件、realpath 在运行目录内、不在排除集合里的路径。解析失败时返回空列表（目录遍历部分照常生效）。"""
    import re as _re, posixpath, urllib.parse
    try:
        import docmark_parse as dp
    except Exception:
        return []
    if pack is None:
        meta = {}
        for name in ('doc.json', 'brief.json'):
            mp = os.path.join(run_dir, name)
            if os.path.exists(mp):
                try:
                    meta = json.load(open(mp, encoding='utf-8'))
                except (OSError, json.JSONDecodeError):
                    meta = {}
                break
        if isinstance(meta, dict) and meta.get('type'):
            try:
                pack, _ = find_pack(meta['type'], None)
            except (OSError, json.JSONDecodeError):
                pack = None
    src = (pack or {}).get('source_file') or next((n for n in ('doc.md', 'proposal.md') if os.path.exists(os.path.join(run_dir, n))), None)
    if not src or not os.path.isfile(os.path.join(run_dir, src)):
        return []
    try:
        doc = dp.parse_file(run_dir, src, pack=pack)
    except Exception:
        return []
    cands = [i.get('target') for i in doc.includes]
    for f in doc.figures:
        cands += [f.get('src'), f.get('svg')]
    for b in doc.blocks:
        if b.get('data_file'): cands.append(b['data_file'])
    for t in doc.tables:
        if t.get('data_file'): cands.append(t['data_file'])
    for l in doc.links:
        u = (l.get('url') or '').strip()
        if not u or u.startswith(('#', '/')) or _re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', u):
            continue
        cands.append(urllib.parse.unquote(u.split('#', 1)[0].split('?', 1)[0]))
    root = os.path.realpath(run_dir)
    out = set()
    for c in cands:
        if not isinstance(c, str) or not c.strip() or os.path.isabs(c):
            continue
        rel = posixpath.normpath(c.strip().replace(os.sep, '/'))
        if rel.startswith('../') or rel == '..' or rel == '.':
            continue
        full = os.path.realpath(os.path.join(run_dir, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full) or _excluded(rel):
            continue
        out.add(rel)
    return sorted(out)


def source_files(run_dir, pack=None):
    """D3 新鲜度判定与 source_manifest 共用的源文件集合（运行目录相对路径，/ 分隔，排序）：
    目录遍历（跳过 out/、base/、.git/、点开头的目录与文件、*.tmp、*.lock、运行与发布产物）∪ 解析器实际引用到的文件（referenced_files，隐藏路径也收）。
    pack 为类型包 pack.json 内容；不给时按元数据 type 查找（DOC_TYPES_DIRS → doc-shared/types）。"""
    out = []
    for dp, dns, fns in os.walk(run_dir):
        rel_dir = os.path.relpath(dp, run_dir)
        rel_dir = '' if rel_dir == '.' else rel_dir.replace(os.sep, '/') + '/'
        if any(rel_dir.startswith(x) for x in NOT_SOURCE) or any(part.startswith('.') for part in rel_dir.split('/') if part):
            dns[:] = []; continue
        for fn in fns:
            rel = rel_dir + fn
            if rel in NOT_SOURCE_FILES or fn.endswith('.tmp') or fn.endswith('.lock') or fn.startswith('.'): continue
            out.append(rel)
    return sorted(set(out) | set(referenced_files(run_dir, pack)))


def newest_source_mtime(run_dir, pack=None):
    newest, which = 0.0, None
    for rel in source_files(run_dir, pack):
        m = os.path.getmtime(os.path.join(run_dir, rel))
        if m > newest: newest, which = m, rel
    return newest, which


def file_sha256(run_dir, rel):
    import hashlib
    p = os.path.join(run_dir, rel)
    if rel in META_FILES:   # 元数据去掉 lark_folder（doc-publish 写回 token 不算改源）后按规范化 JSON 计算
        try:
            data = json.load(open(p, encoding='utf-8'))
            if isinstance(data, dict):
                data.pop('lark_folder', None)
                return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
        except (OSError, json.JSONDecodeError):
            pass
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def build_manifest(run_dir, pack=None):
    return {'algorithm': 'sha256', 'generated_at': now(), 'files': [{'path': rel, 'sha256': file_sha256(run_dir, rel)} for rel in source_files(run_dir, pack)]}


def diff_manifest(run_dir, manifest, pack=None):
    old = {x['path']: x['sha256'] for x in (manifest or {}).get('files') or []}
    cur = {x['path']: x['sha256'] for x in build_manifest(run_dir, pack)['files']}
    return {'added': sorted(set(cur) - set(old)), 'removed': sorted(set(old) - set(cur)),
            'changed': sorted(k for k in set(cur) & set(old) if cur[k] != old[k])}


def split_qa_report(text):
    """qa-report.md → (人工区块文本, 是否有自动区块)。人工区块 = qa-auto 标记之外的全部内容。"""
    a, b = text.find(QA_AUTO_START), text.find(QA_AUTO_END)
    if a >= 0 and b > a:
        return text[:a] + text[b + len(QA_AUTO_END):], True
    return text, False


def outline_decision_items(text):
    import re as _re
    return sorted(set(_re.findall(r'^([\u2460-\u2473]) ', text, _re.M)))


def get_field(d, dotted):
    for part in dotted.split('.'):
        if not isinstance(d, dict) or part not in d: return None
        d = d[part]
    return d


def check_gate(gate, run_dir, state, pack, no_pack, args):
    """返回 (problems[str], checks[str])。problems 非空即拒绝。"""
    problems, checks = [], []
    meta_name = (pack or {}).get('meta_file', 'doc.json')
    meta_path = os.path.join(run_dir, meta_name)
    if pack is None:
        if no_pack: checks.append('未找到类型包，按 --no-pack 跳过类型包相关检查')
        elif gate in ('D0', 'D2'): problems.append(f'找不到类型包 {state["doc_type"]}（用 --pack 指定，或确认后加 --no-pack）')
    if gate == 'D0':
        if not os.path.exists(meta_path):
            problems.append(f'缺少 {meta_name}')
        elif meta_name == 'doc.json':
            errors, warnings = validate.validate_data('doc', json.load(open(meta_path)))
            problems += [f'doc.json {p}：{m}' for p, m in errors]
            checks += [f'doc.json 警告：{w}' for w in warnings]
            if not errors: checks.append('doc.json 通过 schema 与语义校验')
        else:
            checks.append(f'{meta_name} 非 doc.json，schema 校验交给类型包钩子')
        if pack:
            meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
            for inp in pack.get('inputs', []):
                if not inp.get('required'): continue
                if inp.get('path') and not glob.glob(os.path.join(run_dir, inp['path'])):
                    problems.append(f'类型包必需输入缺失：{inp["id"]}（{inp["desc"]}；找不到 {inp["path"]}）')
                if inp.get('doc_field') and get_field(meta, inp['doc_field']) in (None, '', [], {}):
                    problems.append(f'类型包必需输入缺失：{inp["id"]}（{inp["desc"]}；{meta_name} 的 {inp["doc_field"]} 为空）')
            text_inputs = [inp for inp in pack.get('inputs', []) if inp.get('required') and not inp.get('path') and not inp.get('doc_field')]
            if text_inputs and meta_name == 'doc.json':
                bp = os.path.join(run_dir, 'brief.json')
                try:
                    brief = json.load(open(bp, encoding='utf-8')) if os.path.exists(bp) else None
                except (OSError, json.JSONDecodeError) as ex:
                    brief = None; problems.append(f'brief.json 读取失败：{ex}')
                if brief is None and not any('brief.json 读取失败' in x for x in problems):
                    problems.append('缺少 brief.json：类型包有文本型必需输入（' + '、'.join(i['id'] for i in text_inputs) + '），应记在 brief.json inputs')
                elif brief is not None and not isinstance(brief, dict):
                    problems.append(f'brief.json 顶层必须是对象（现在是 {type(brief).__name__}）：文本型必需输入无法核对')
                elif isinstance(brief, dict) and 'inputs' in brief and not isinstance(brief['inputs'], dict):
                    problems.append(f'brief.json inputs 必须是对象（现在是 {type(brief["inputs"]).__name__}）：文本型必需输入无法核对')
                elif isinstance(brief, dict):
                    for inp in text_inputs:
                        v = (brief.get('inputs') or {}).get(inp['id'])
                        if v is None or (isinstance(v, str) and not v.strip()) or v in ([], {}):
                            problems.append(f'类型包必需输入缺失：{inp["id"]}（{inp["desc"]}；brief.json inputs.{inp["id"]} 为空）')
            elif text_inputs:
                checks.append(f'元数据文件为 {meta_name}，文本型必需输入（' + '、'.join(i['id'] for i in text_inputs) + '）由业务线自查')
            checks.append(f'类型包 {pack["id"]} inputs 检查完成')
            needed = [r for r in pack.get('related', []) if r.get('required')]
            if needed:
                import related as related_mod
                rel = related_mod.Related(run_dir, meta=meta)
                for r in needed:
                    try:
                        found = rel.find(r['type'], role=r['role'])
                    except related_mod.AmbiguousRelated as ex:
                        problems.append(str(ex)); continue
                    if found is None:
                        problems.append(f'类型包要求的关联文档未登记：{r["type"]}（role={r["role"]}；{r.get("desc", "")}），在 {meta_name} related_docs 补 type、path、role')
                    elif not found.ok:
                        problems.append(f'关联文档无法解析：{r["type"]}（role={r["role"]}）：{found.error}')
                    else:
                        checks.append(f'关联文档 {r["type"]}（role={r["role"]}）已解析：{found.run_dir}' + (f'；{found.version_mismatch}' if found.version_mismatch else ''))
    if gate == 'D0' and meta_name == 'doc.json' and os.path.exists(os.path.join(run_dir, 'brief.json')):
        # doc-* 类型（元数据文件 doc.json）的 brief.json 严格校验；放在类型包分支之外，--no-pack 也照查（pack 为 None 时不核对 modes）
        text_inputs_d0 = bool(pack) and any(inp.get('required') and not inp.get('path') and not inp.get('doc_field') for inp in pack.get('inputs', []))
        try:
            b2 = json.load(open(os.path.join(run_dir, 'brief.json'), encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            b2 = None
            if not text_inputs_d0: problems.append('brief.json 读取失败')   # 有文本型输入时上面已报
        if isinstance(b2, dict):
            berr, bwarn = validate.validate_brief(b2, family='doc_brief', strict=True, pack=pack)
            problems += [f'brief.json 不合 brief.schema.json（doc_brief 严格模式）：{p} {m}' for p, m in berr]
            checks += [f'notes：brief.json {w}' for w in bwarn]
            if not berr: checks.append('brief.json 通过 brief.schema.json（doc_brief 严格模式）')
        elif b2 is not None and not text_inputs_d0:
            problems.append(f'brief.json 顶层必须是对象（现在是 {type(b2).__name__}）')
    if gate in ('D1', 'D2', 'D3', 'D4') and not [e for e in args.evidence if e.strip()]:
        problems.append(f'{gate} 必须提供 --evidence')
    if gate == 'D1':
        of = (pack or {}).get('outline_file', 'outline.md')
        op = os.path.join(run_dir, of)
        decisions = state.get('decisions') or {}
        if not os.path.exists(op):
            problems.append(f'缺少 {of}：D1 拍板的是骨架稿，先生成并发给用户')
        else:
            items = outline_decision_items(open(op, encoding='utf-8').read())
            need = max(1, len(items))
            if len(decisions) < need:
                problems.append(f'拍板记录不足：{of} 有 {len(items)} 个拍板项，run-state decisions 只有 {len(decisions)} 条（用 decide --key ① --value "A …" 逐项记录）')
            else:
                checks.append(f'{of} 存在；拍板项 {len(items)} 个，decisions {len(decisions)} 条')
    if gate == 'D2' and pack is not None:
        d2 = pack.get('gates', {}).get('D2')
        if d2 is None:
            problems.append(f'类型包 {pack["id"]} 没有 D2 专属门，请用 skip-gate')
        elif not args.run:
            problems.append(f'类型包 {pack["id"]} 声明了 D2 命令（{d2.get("desc", "")}）：必须加 --run 由本脚本执行并判定，不接受只填证据')
        else:
            cmd = [x.format(run_dir=run_dir, pack_dir=args._pack_dir, skills_dir=SKILLS, doc_shared=ROOT, python=sys.executable) for x in d2['command']]
            r = subprocess.run(cmd, cwd=run_dir, capture_output=True, text=True, timeout=d2.get('timeout_s', 600))
            ok_codes = d2.get('pass_exit_codes', [0])
            checks.append(f'D2 命令退出码 {r.returncode}（通过码 {ok_codes}）')
            if r.returncode not in ok_codes:
                problems.append(f'D2 命令未通过：退出码 {r.returncode}；输出尾部：{(r.stdout + r.stderr).strip()[-300:]}')
    if gate == 'D3':
        newest, which = newest_source_mtime(run_dir, pack)
        qa = os.path.join(run_dir, 'qa-result.json')
        if not os.path.exists(qa):
            problems.append('缺少 qa-result.json')
        else:
            data = json.load(open(qa))
            errors, _ = validate.validate_data('qa-result', data)
            problems += [f'qa-result.json {p}：{m}' for p, m in errors]
            if data.get('must_fix') != 0: problems.append(f'qa-result.json must_fix={data.get("must_fix")}，不为 0')
            if newest > os.path.getmtime(qa): problems.append(f'质检之后又改过 {which}，重跑质检')
            if not problems: checks.append('qa-result.json 合法、must_fix 为 0、未过期')
        rj = os.path.join(run_dir, 'out', 'render.json')
        if not os.path.exists(rj):
            problems.append('缺少 out/render.json（版式检查结果）')
        else:
            data = json.load(open(rj))
            errors, _ = validate.validate_data('render', data)
            problems += [f'render.json {p}：{m}' for p, m in errors]
            must = [x for x in data.get('layout_issues', []) if x.get('severity') == '必改']
            if must: problems.append(f'render.json 版式必改 {len(must)} 条：' + '；'.join(x['message'] for x in must[:3]))
            if newest > os.path.getmtime(rj): problems.append(f'渲染之后又改过 {which}，重新渲染')
            if not errors and not must: checks.append('render.json 合法、无版式必改')
        rp = os.path.join(run_dir, 'qa-report.md')
        if not os.path.exists(rp):
            problems.append('缺少 qa-report.md：人工检查与 Codex 两轮结论要写在人工区块')
        else:
            report = open(rp, encoding='utf-8').read()
            manual, _ = split_qa_report(report)
            body = '\n'.join(l for l in manual.split('\n') if l.strip() and not l.lstrip().startswith('#'))
            if not body.strip():
                problems.append('qa-report.md 人工区块（qa-auto 标记之外）为空：写人工检查结论与 Codex 两轮记录')
            else:
                miss = [w for w in ('找茬', '证伪') if w not in body]   # 只看正文行：标题「Codex 找茬与证伪」本身不算某一轮的记录
                if 'Codex' not in manual and 'codex' not in manual:
                    problems.append('qa-report.md 人工区块没有 Codex 记录（找茬、证伪两轮，或两轮均失败的降级说明）')
                elif miss:
                    problems.append('qa-report.md 人工区块正文缺 Codex ' + '、'.join(miss) + ' 轮记录（标题不算；两轮都失败时写明降级原因，并仍按「找茬」「证伪」分别说明）')
                heads = [l.lstrip('#').strip() for l in manual.split('\n') if l.lstrip().startswith('#') and l.lstrip('#').strip()]
                ev = ' '.join(args.evidence)
                files = [t for t in __import__('re').findall(r'[\w\-./]+\.(?:md|json|txt|csv)', ev) if os.path.exists(os.path.join(run_dir, t)) or os.path.exists(os.path.expanduser(t))]
                if not files and not any(h in ev for h in heads):
                    problems.append('--evidence 无法定位：写出运行目录内存在的文件（如 qa-report.md）或 qa-report.md 人工区块的标题')
                if not miss and ('Codex' in manual or 'codex' in manual) and (files or any(h in ev for h in heads)):
                    checks.append('qa-report.md 人工区块有 Codex 找茬、证伪记录；证据可定位：' + '、'.join(files or [h for h in heads if h in ev][:1]))
    if gate == 'D4':
        meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
        folder = meta.get('lark_folder') or {}
        if not folder.get('token'):
            problems.append(f'{meta_name} 的 lark_folder 没有 token（decisions ⑫A：没有项目文件夹不发布）')
        else:
            checks.append(f'lark_folder token 已填（{folder.get("path", "未写路径")}）')
    return problems, checks


def order_problem(state, gate):
    idx = GATES.index(gate)
    bad = [g for g in GATES[:idx] if state['gates'][g]['status'] not in DONE]
    return f'前序门未完成：{bad}' if bad else None


def main(argv):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('run_dir')
    ap.add_argument('action', choices=['init', 'set-stage', 'pass-gate', 'skip-gate', 'waive-gate', 'fail-gate', 'reset-gate', 'decide', 'show', 'check-manifest'])
    ap.add_argument('stage', nargs='?')
    ap.add_argument('--type'); ap.add_argument('--mode', choices=['new', 'revision', 'import'])
    ap.add_argument('--base-doc'); ap.add_argument('--base-version'); ap.add_argument('--force', action='store_true')
    ap.add_argument('--gate', choices=GATES); ap.add_argument('--evidence', action='append', default=[])
    ap.add_argument('--by', default=''); ap.add_argument('--reason', default=''); ap.add_argument('--run', action='store_true')
    ap.add_argument('--key'); ap.add_argument('--value'); ap.add_argument('--user-words')
    ap.add_argument('--pack'); ap.add_argument('--no-pack', action='store_true'); ap.add_argument('--allow-custom-stage', action='store_true')
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        return 2
    run_dir = os.path.abspath(args.run_dir)
    if not os.path.isdir(run_dir):
        return emit(False, message=f'运行目录不存在：{run_dir}') and 2
    path = os.path.join(run_dir, 'run-state.json')
    try:  # O_NOFOLLOW：run-state.json.lock 是软链时拒绝，不跟随写到运行目录外（W3-D2 定点修改）
        lock = os.fdopen(os.open(path + '.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o644), 'w')
    except OSError as ex:
        print(json.dumps({'ok': False, 'message': f'run-state.json.lock 无法安全打开（是软链或不可写）：{ex}'}, ensure_ascii=False)); return 2
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        if args.action == 'init':
            if not args.type or not args.mode:
                print('init 需要 --type 与 --mode'); return 2
            if os.path.exists(path) and not args.force:
                return emit(False, message='run-state.json 已存在（改版请用 reset-gate；确需重建加 --force）')
            t = now()
            state = {'schema_version': '1', 'doc_type': args.type, 'mode': args.mode, 'stage': 'intake',
                     'gates': {g: {'status': 'pending', 'at': None, 'evidence': []} for g in GATES},
                     'history': [{'at': t, 'action': 'init', 'by': args.by, 'detail': f'type={args.type} mode={args.mode}'}], 'updated_at': t}
            if args.base_doc: state['base_doc'] = args.base_doc
            if args.base_version: state['base_version'] = args.base_version
            write_state(path, state)
            return emit(True, action='init', stage='intake')
        if not os.path.exists(path):
            return emit(False, message='run-state.json 不存在，先 init')
        state = load_state(path)
        errors, _ = validate.validate_data('run-state', state)
        if errors:
            return emit(False, message='现有 run-state.json 不合法（可能是旧版 G0–G4 格式，兼容期不由本脚本写）', errors=[{'path': p, 'message': m} for p, m in errors])
        if args.action == 'show':
            return emit(True, **state)
        if args.action == 'check-manifest':
            d3 = state['gates']['D3']
            man = d3.get('source_manifest')
            if not man:
                return emit(False, action='check-manifest', gate_d3=d3.get('status'), message='gates.D3 没有 source_manifest（D3 未通过、被豁免或已重置）')
            cm_pack, _ = find_pack(state['doc_type'], args.pack)
            dif = diff_manifest(run_dir, man, cm_pack)
            same = not any(dif.values())
            print(json.dumps({'ok': same, 'action': 'check-manifest', 'gate_d3': d3.get('status'), 'manifest_at': man.get('generated_at'),
                              'files': len(man.get('files') or []), **dif}, ensure_ascii=False, indent=2))
            return 0 if same else 3
        pack, pack_dir = find_pack(state['doc_type'], args.pack)
        args._pack_dir = pack_dir or ''
        t = now()
        if args.action == 'set-stage':
            allowed = GENERIC_STAGES + ((pack or {}).get('stages') or [])
            if not args.stage: print('set-stage 需要阶段名'); return 2
            if args.stage not in allowed and not args.allow_custom_stage:
                return emit(False, message=f'阶段 {args.stage} 不在 {allowed}（类型包 stages 可扩展；临时阶段加 --allow-custom-stage）')
            state['stage'] = args.stage
            state['history'].append({'at': t, 'action': 'set-stage', 'stage': args.stage, 'by': args.by})
        elif args.action == 'decide':
            if not args.key or args.value is None: print('decide 需要 --key 与 --value'); return 2
            state.setdefault('decisions', {})[args.key] = args.value
            if args.user_words: state.setdefault('user_words', []).append(args.user_words)
            state['history'].append({'at': t, 'action': 'decide', 'by': args.by, 'detail': f'{args.key}={args.value}'})
        else:
            if not args.gate: print(f'{args.action} 需要 --gate'); return 2
            g = args.gate
            if args.action == 'pass-gate':
                op = order_problem(state, g)
                problems, checks = check_gate(g, run_dir, state, pack, args.no_pack, args)
                if op: problems.insert(0, op)
                if problems:
                    return emit(False, action='pass-gate', gate=g, problems=problems, checks=checks)
                state['gates'][g] = {'status': 'passed', 'at': t, 'by': args.by, 'evidence': args.evidence, 'checks': checks}
                if g == 'D3':
                    state['gates'][g]['source_manifest'] = build_manifest(run_dir, pack)
                state['history'].append({'at': t, 'action': 'pass-gate', 'gate': g, 'by': args.by, 'detail': '；'.join(args.evidence)[:300]})
            elif args.action == 'skip-gate':
                if g != 'D2': return emit(False, message='只有 D2（类型专属门）可以 skip')
                if pack is not None and pack.get('gates', {}).get('D2') is not None:
                    return emit(False, message=f'类型包 {pack["id"]} 声明了 D2 命令，不能 skip')
                if pack is None and not args.no_pack:
                    return emit(False, message='找不到类型包，无法确认 D2 为空（用 --pack 指定，或确认后加 --no-pack）')
                if not args.reason: return emit(False, message='skip-gate 需要 --reason')
                op = order_problem(state, g)
                if op: return emit(False, message=op)
                state['gates'][g] = {'status': 'skipped', 'at': t, 'by': args.by, 'evidence': [], 'reason': args.reason}
                state['history'].append({'at': t, 'action': 'skip-gate', 'gate': g, 'by': args.by, 'detail': args.reason})
            elif args.action == 'waive-gate':
                if g not in ('D2', 'D3'): return emit(False, message='只有 D2、D3 可以 waive；D0 输入、D1 骨架、D4 发布确认不能豁免')
                if not args.reason or not args.by: return emit(False, message='waive-gate 需要 --reason 与 --by（谁拍板豁免）')
                op = order_problem(state, g)
                if op: return emit(False, message=op)
                state['gates'][g] = {'status': 'waived', 'at': t, 'by': args.by, 'evidence': args.evidence, 'reason': args.reason}
                state['history'].append({'at': t, 'action': 'waive-gate', 'gate': g, 'by': args.by, 'detail': args.reason})
            elif args.action == 'fail-gate':
                if not args.reason: return emit(False, message='fail-gate 需要 --reason')
                state['gates'][g] = {'status': 'failed', 'at': t, 'by': args.by, 'evidence': [], 'reason': args.reason}
                for later in GATES[GATES.index(g) + 1:]:
                    state['gates'][later] = {'status': 'pending', 'at': None, 'evidence': []}
                state['history'].append({'at': t, 'action': 'fail-gate', 'gate': g, 'by': args.by, 'detail': args.reason})
            elif args.action == 'reset-gate':
                for later in GATES[GATES.index(g):]:
                    state['gates'][later] = {'status': 'pending', 'at': None, 'evidence': []}
                state['history'].append({'at': t, 'action': 'reset-gate', 'gate': g, 'by': args.by, 'detail': args.reason or '重开'})
        state['updated_at'] = t
        write_state(path, state)
        return emit(True, action=args.action, gate=args.gate, stage=state['stage'], gates={k: v['status'] for k, v in state['gates'].items()})
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); lock.close()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
