#!/usr/bin/env python3
"""doc-qa 质检引擎。
用法：qa.py <运行目录> [--type 类型] [--pack 类型包目录或 pack.json] [--only R1,T3] [--exclude T1,T2]
              [--no-hooks] [--no-state] [--allow-invalid-pack] [--quiet]
流程（doc-shared/references/qa-engine.md §1）：找类型包 → 读元数据文件 → include 展开并写 out/<源文件名>.resolved.md →
构造文档模型 → 引擎规则（pack.qa.engine_rules 过滤）→ 类型包 check(doc, ctx) → 钩子 pre_qa → 并入 out/render.json 的
layout_issues → severity_overrides → 去重与截断 → 按 schema 校验 → 写 qa-result.json 与 qa-report.md 自动区块 →
run_state.py 写回阶段。
类型包查找顺序：--pack → 环境变量 DOC_TYPES_DIRS（冒号分隔的 types 根目录）→ doc-shared/types/<类型>/。
退出码：0 无必改；3 有必改；1 缺源文件；2 用法错误（含找不到类型包）；4 引擎自身故障（类型包不合法、结果不过 schema、规则代码异常）。"""
import argparse, datetime, hashlib, importlib.util, json, os, re, subprocess, sys, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.dirname(os.path.dirname(HERE))
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(DOC_SHARED, 'scripts'))
sys.dont_write_bytecode = True

import docmodel  # noqa: E402
import engine_rules  # noqa: E402

ENGINE_NAME, ENGINE_VERSION = 'doc-qa', '1.0.0'
SEVERITIES = ('必改', '建议', '提示')
MAX_PER_RULE = 30
ENGINE_CODES = set(engine_rules.ORDER) | {'E-TYPE', 'E-HOOK'}
AUTO_START, AUTO_END = '<!-- qa-auto:start -->', '<!-- qa-auto:end -->'


def find_pack(doc_type, pack_arg):
    cands = []
    if pack_arg:
        p = os.path.expanduser(pack_arg)
        cands.append(p if p.endswith('.json') else os.path.join(p, 'pack.json'))
    if doc_type:
        for d in filter(None, os.environ.get('DOC_TYPES_DIRS', '').split(':')):
            cands.append(os.path.join(os.path.expanduser(d), doc_type, 'pack.json'))
        cands.append(os.path.join(DOC_SHARED, 'types', doc_type, 'pack.json'))
    for c in cands:
        if os.path.exists(c):
            try:
                return json.load(open(c, encoding='utf-8')), os.path.dirname(os.path.abspath(c))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as ex:
                raise PackLoadError(f'{c} 读取失败：{type(ex).__name__}: {ex}')
    return None, None


class PackLoadError(RuntimeError):
    pass


def load_json_opt(path):
    """读不出、不是 UTF-8 或不是合法 JSON 时返回 None（UnicodeDecodeError 与 JSONDecodeError 都是 ValueError）。"""
    try:
        return json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError):
        return None


class RelatedView:
    """RelatedDoc 的只读代理，额外挂 doc（对方文档模型，按需解析）。"""

    def __init__(self, rd):
        self._rd = rd
        self._doc = None

    def __getattr__(self, name):
        return getattr(self._rd, name)

    @property
    def doc(self):
        if self._doc is None and self._rd.ok:
            try:
                pack, _ = find_pack(self._rd.type, None)
            except PackLoadError as ex:
                raise RuntimeError(str(ex))
            if pack is None:
                raise RuntimeError(f'关联文档类型 {self._rd.type} 找不到类型包，无法解析文档模型')
            mf = pack.get('meta_file', 'doc.json')
            meta = self._rd.meta if mf == 'doc.json' else (load_json_opt(os.path.join(self._rd.run_dir, mf)) or {})
            self._doc = docmodel.build(self._rd.run_dir, pack, meta=meta, meta_file=mf)
        return self._doc


class Ctx:
    def __init__(self, run_dir, pack, pack_dir, meta, meta_file, profile, tokens, type_module):
        self.run_dir, self.pack, self.pack_dir = run_dir, pack, pack_dir
        self.meta, self.meta_file = meta, meta_file
        self.profile, self.tokens = profile, tokens
        self.qa = pack.get('qa') or {}
        self._type_module = type_module
        self.render_json = load_json_opt(os.path.join(run_dir, 'out', 'render.json'))
        self.figures_review = load_json_opt(os.path.join(run_dir, 'figures', 'review.json'))
        self._related = None
        self.l6_font_deferred = set()  # L6 因「只有字号」让位给 LY4 的图（target），merge_render 在 LY4 消息里注明
        self.merges_render = False     # 本次运行会并入 render.json layout_issues 时才为真（--only 不并入，L6 不让位，防止两条都不出现）

    # 文件读取（不得越出运行目录）
    def _safe(self, rel):
        full = os.path.realpath(os.path.join(self.run_dir, rel))
        root = os.path.realpath(self.run_dir)
        if os.path.isabs(rel) or not (full == root or full.startswith(root + os.sep)):
            raise ValueError(f'路径越出运行目录：{rel}')
        return full

    def exists(self, rel):
        return os.path.exists(self._safe(rel))

    def exists_safe(self, rel):
        try:
            return self.exists(rel)
        except ValueError:
            return False

    def read_text(self, rel):
        return open(self._safe(rel), encoding='utf-8').read()

    def read_json(self, rel):
        return json.loads(self.read_text(rel))

    def read_json_opt(self, rel):
        try:
            return self.read_json(rel)
        except (OSError, ValueError):
            return None

    def list_dir(self, rel):
        """扩展：列运行目录内子目录的文件名（不存在返回 []），顺序同 os.listdir。"""
        p = self._safe(rel)
        return os.listdir(p) if os.path.isdir(p) else []

    def glob(self, pattern):
        import glob as _g
        self._safe(os.path.dirname(pattern) or '.')
        root = os.path.realpath(self.run_dir)
        return sorted(os.path.relpath(x, root) for x in _g.glob(os.path.join(root, pattern)))

    # 类型包声明
    def feature(self, name):
        return bool((self.pack.get('features') or {}).get(name))

    def message(self, key, default):
        """扩展：类型包 qa_rules.py 可导出 MESSAGE_OVERRIDES = {键: 模板} 覆盖引擎消息（兼容期保证逐项比对）。"""
        ov = getattr(self._type_module, 'MESSAGE_OVERRIDES', None) or {}
        return ov.get(key, default)

    # 关联文档
    def _rel(self):
        if self._related is None:
            import related
            self._related = related.Related(self.run_dir, meta=self.meta if isinstance(self.meta, dict) else {})
        return self._related

    def related(self, doc_type, role=None, title=None):
        d = self._rel().find(doc_type, role=role, title=title)
        return RelatedView(d) if d is not None else None

    def related_all(self, doc_type=None, role=None):
        return [RelatedView(d) for d in self._rel().all(doc_type, role)]

    def missing_related_issue(self, rule, doc_type, role=None, for_gate=None, detail=''):
        import related
        if for_gate is None:
            for_gate = any(r.get('type') == doc_type and (role is None or r.get('role') == role) and r.get('for_gate')
                           for r in self.pack.get('related') or [])
        return related.missing_issue(rule, doc_type, role=role, for_gate=for_gate, detail=detail or '')

    @staticmethod
    def issue(rule, severity, line, text, msg):
        return {'rule': rule, 'severity': severity, 'line': line, 'excerpt': str(text).strip()[:120], 'message': msg}


def select_rules(pack, only=None, exclude=None):
    er = ((pack.get('qa') or {}).get('engine_rules')) or {}
    inc = er.get('include', 'all')
    codes = list(engine_rules.ORDER) if inc == 'all' else [c for c in engine_rules.ORDER if c in set(inc)]
    ex = set(er.get('exclude') or []) | set(exclude or [])
    codes = [c for c in codes if c not in ex]
    if only:
        codes = [c for c in codes if c in set(only)]
    return codes


def load_type_module(pack, pack_dir):
    rp = (pack.get('qa') or {}).get('rules_py')
    if not rp:
        return None, None
    path = os.path.join(pack_dir, rp)
    if not rules_py_inside(pack_dir, rp):
        return None, f'qa.rules_py「{rp}」越出类型包目录'
    if not os.path.exists(path):
        return None, f'qa.rules_py 指向的 {rp} 不存在'
    spec = importlib.util.spec_from_file_location(f'qa_rules_{pack.get("id", "x").replace("-", "_")}', path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as ex:
        return None, f'加载 {rp} 失败：{type(ex).__name__}: {ex}'
    if not callable(getattr(mod, 'check', None)):
        return None, f'{rp} 没有顶层 check(doc, ctx)'
    return mod, None


def rules_py_inside(pack_dir, rp):
    norm = str(rp).replace('\\', '/')
    if os.path.isabs(norm) or '..' in norm.split('/'):
        return False
    full = os.path.realpath(os.path.join(pack_dir, norm)); root = os.path.realpath(pack_dir)
    return full.startswith(root + os.sep)


def normalize_external(items, source, code_rule):
    """类型包 / 钩子返回的问题：补字段、校验定级；不合法记 E-TYPE / E-HOOK。"""
    out, bad = [], []
    if not isinstance(items, list):
        return [], [f'返回值不是列表（{type(items).__name__}）']
    for k, x in enumerate(items):
        if not isinstance(x, dict) or not x.get('rule') or not x.get('message'):
            bad.append(f'第 {k + 1} 条缺 rule 或 message'); continue
        y = {'rule': str(x['rule']), 'severity': x.get('severity'), 'line': x.get('line', 0), 'excerpt': str(x.get('excerpt', '') or '')[:120],
             'message': str(x['message'])}
        if y['severity'] not in SEVERITIES:
            bad.append(f'{y["rule"]} 定级「{y["severity"]}」不合法'); continue
        if not isinstance(y['line'], int) or isinstance(y['line'], bool) or y['line'] < 0:
            bad.append(f'{y["rule"]} 行号「{y["line"]}」不合法'); continue
        if y['rule'] in ENGINE_CODES:
            bad.append(f'占用了引擎规则编号 {y["rule"]}')
        if x.get('file'):
            y['file'] = str(x['file'])
        y['rule_source'] = source
        out.append(y)
    return out, bad


def run_hook(cmd_obj, run_dir, pack, pack_dir):
    try:
        argv = [a.format(run_dir=run_dir, pack_dir=pack_dir, skills_dir=SKILLS, doc_shared=DOC_SHARED, python=sys.executable) for a in cmd_obj['command']]
    except (KeyError, IndexError, ValueError) as ex:
        return None, f'pre_qa 命令占位符无法展开（只支持 {{run_dir}} {{pack_dir}} {{skills_dir}} {{doc_shared}} {{python}}；字面花括号写成 {{{{ }}}}）：{type(ex).__name__}: {ex}'
    env = dict(os.environ, DOC_RUN_DIR=run_dir, DOC_PACK_DIR=pack_dir, DOC_SHARED=DOC_SHARED, DOC_TYPE=pack.get('id', ''))
    try:
        r = subprocess.run(argv, cwd=run_dir, capture_output=True, timeout=cmd_obj.get('timeout_s', 600), env=env)
    except subprocess.TimeoutExpired:
        return None, f'pre_qa 超时（{cmd_obj.get("timeout_s", 600)} 秒）'
    except OSError as ex:
        return None, f'pre_qa 无法执行：{ex}'
    try:
        stdout = r.stdout.decode('utf-8')
    except UnicodeDecodeError as ex:
        return None, f'pre_qa stdout 不是 UTF-8：{ex}'
    try:
        stderr = r.stderr.decode('utf-8')
    except UnicodeDecodeError as ex:
        return None, f'pre_qa stderr 不是 UTF-8：{ex}'
    if r.returncode not in (0, 3):
        return None, f'pre_qa 退出码 {r.returncode}：{(stdout + stderr).strip()[-200:]}'
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return None, f'pre_qa stdout 不是合法 JSON：{stdout.strip()[:120]}'
    if not isinstance(data, dict) or not isinstance(data.get('issues', []), list):
        return None, 'pre_qa stdout 缺 issues 列表'
    return data.get('issues', []), None


def merge_render(ctx):
    rj = ctx.render_json
    out = []
    if not isinstance(rj, dict):
        return out
    for li in rj.get('layout_issues', []) or []:
        if not isinstance(li, dict) or li.get('severity') not in SEVERITIES:
            continue
        where = '；'.join(x for x in [f'第 {li["page"]} 页' if li.get('page') else '', str(li.get('target') or '')] if x)
        msg = str(li.get('message', ''))
        if li.get('rule') == 'LY4' and li.get('target') in getattr(ctx, 'l6_font_deferred', ()):
            msg += '（另见 L6 字号）'
        out.append({'rule': str(li.get('rule') or 'LY'), 'severity': li['severity'], 'line': 0, 'excerpt': where[:120],
                    'message': msg, 'rule_source': 'engine', 'file': 'out/render.json'})
    return out


SEV_RANK = {'必改': 0, '建议': 1, '提示': 2}


def finalize(issues, overrides):
    """qa-engine.md §3：定级覆盖 → 精确去重 → 同规则同行合并 → 截断。必改永不被合并掉定级、永不被截断。"""
    for x in issues:
        if x['rule'] in overrides and overrides[x['rule']] in SEVERITIES:
            x['severity'] = overrides[x['rule']]
    seen, deduped = set(), []
    for x in issues:
        k = (x['rule'], x['line'], x['message'])
        if k in seen:
            continue
        seen.add(k); deduped.append(x)
    # 同一规则同一行只保留一条（行号 0 为全文级，不合并）；被合并的若定级更高，保留定级更高的那条
    merged, slot, extra_n = [], {}, {}
    for x in deduped:
        k = (x['rule'], x['line'])
        if x['line'] and k in slot:
            i = slot[k]; extra_n[i] = extra_n.get(i, 0) + 1
            if SEV_RANK[x['severity']] < SEV_RANK[merged[i]['severity']]:
                merged[i] = x
            continue
        if x['line']:
            slot[k] = len(merged)
        merged.append(x)
    for i, n in extra_n.items():
        merged[i] = dict(merged[i], message=merged[i]['message'] + f'（同一行另有 {n} 条同规则问题）')
    # 截断：单条规则超过 30 条时，非必改的超出部分折叠为一条汇总（定级取被折叠中最高的），必改全部保留
    counts, kept, hidden = {}, [], {}
    for x in merged:
        counts[x['rule']] = counts.get(x['rule'], 0) + 1
        if counts[x['rule']] <= MAX_PER_RULE or x['severity'] == '必改':
            kept.append(x)
        else:
            hidden.setdefault(x['rule'], []).append(x)
    for rule_code, xs in hidden.items():
        sev = min((x['severity'] for x in xs), key=lambda v: SEV_RANK[v])
        kept.append({'rule': rule_code, 'severity': sev, 'line': 0, 'excerpt': '',
                     'message': f'另有 {len(xs)} 处（单条规则只列前 {MAX_PER_RULE} 条，必改不折叠）', 'rule_source': xs[0].get('rule_source', 'engine')})
    return kept


def write_report(run_dir, result):
    rp = os.path.join(run_dir, 'qa-report.md')
    old = open(rp, encoding='utf-8').read() if os.path.exists(rp) else '# 质检报告\n'
    old = re.sub(re.escape(AUTO_START) + r'.*?' + re.escape(AUTO_END) + r'\n?', '', old, flags=re.S)
    old = re.sub(r'\n## 自动检查（qa_checks\.py）.*?(?=\n## (?!自动检查)|\Z)', '', old, flags=re.S)
    e = result['engine']
    L = [AUTO_START, '## 自动检查（doc-qa）', '',
         f"运行时间 {result['generated_at']}；类型包 {e['pack']} {e['pack_version']}；必改 {result['must_fix']} 条，共 {result['total']} 条。"
         "证据列为规则说明（来源 engine / type / hook）；修改指令与复核记录由人工填写。", '',
         '| 编号 | 规则 | 定级 | 位置 | 原文摘录 | 证据 | 修改指令 | 状态 | 复核记录 |', '|---|---|---|---|---|---|---|---|---|']
    esc = lambda v: str(v).replace('|', '/').replace('\n', ' ')
    for n, x in enumerate(result['issues'], 1):
        where = (f"第 {x['line']} 行" if x['line'] else '全文') + (f"（{x['file']}）" if x.get('file') else '')
        L.append(f"| Q{n} | {x['rule']} | {x['severity']} | {esc(where)} | {esc(x['excerpt'])} | {esc(x['message'])}（{x.get('rule_source', '')}） |  | 待修改 |  |")
    L.append(AUTO_END)
    with open(rp, 'w', encoding='utf-8') as f:
        f.write(old.rstrip('\n') + '\n\n' + '\n'.join(L) + '\n')


def write_state(run_dir, must_fix, pack_dir):
    """run-state.json 存在且为新格式时：阶段置 qa；有必改而 D3 已通过时 fail-gate D3。旧格式或不存在时跳过。"""
    sp = os.path.join(run_dir, 'run-state.json')
    if not os.path.exists(sp):
        return {'skipped': 'run-state.json 不存在'}
    import validate
    state = load_json_opt(sp)
    if not isinstance(state, dict) or validate.validate_data('run-state', state)[0]:
        return {'skipped': 'run-state.json 是旧版 G0–G4 格式或不合法，不由 doc-qa 写回'}
    rs = os.path.join(os.environ.get('DOC_QA_RUN_STATE_DIR') or os.path.join(DOC_SHARED, 'scripts'), 'run_state.py')
    base = [sys.executable, rs, run_dir]
    tail = ['--pack', pack_dir] if pack_dir else []
    notes = {}

    def call(args, label):
        try:
            r = subprocess.run(base + args + tail, capture_output=True, text=True, timeout=60)
        except UnicodeDecodeError as ex:
            notes['error'] = f'{label} 输出不是 UTF-8：{ex}'; return False
        except (subprocess.TimeoutExpired, OSError) as ex:
            notes['error'] = f'{label} 失败：{type(ex).__name__}: {ex}'; return False
        notes[f'{label}_exit'] = r.returncode
        if r.returncode != 0:
            notes['error'] = f'{label} 退出码 {r.returncode}：{(r.stdout + r.stderr).strip()[-200:]}'; return False
        return True
    if not call(['set-stage', 'qa', '--by', 'doc-qa'], 'set_stage'):
        return notes
    if must_fix and ((state.get('gates') or {}).get('D3') or {}).get('status') == 'passed':
        call(['fail-gate', '--gate', 'D3', '--reason', f'doc-qa 重跑发现必改 {must_fix} 条', '--by', 'doc-qa'], 'fail_d3')
    return notes


def drop_stale_result(run_dir):
    """引擎故障退出前删除旧 qa-result.json，避免 D3 读到过期结果（qa-engine.md §4）。"""
    p = os.path.join(run_dir, 'qa-result.json')
    if os.path.exists(p):
        os.replace(p, p + '.stale')
        return 'qa-result.json 已改名为 qa-result.json.stale'
    return None


def main(argv):
    ap = argparse.ArgumentParser(description='doc-qa 质检引擎')
    ap.add_argument('run_dir'); ap.add_argument('--type'); ap.add_argument('--pack')
    ap.add_argument('--only'); ap.add_argument('--exclude')
    ap.add_argument('--no-hooks', action='store_true'); ap.add_argument('--no-state', action='store_true')
    ap.add_argument('--allow-invalid-pack', action='store_true'); ap.add_argument('--quiet', action='store_true')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    if a.only is not None and not [x for x in a.only.split(',') if x.strip()]:
        print(json.dumps({'ok': False, 'message': '--only 没有有效的规则编号'}, ensure_ascii=False)); return 2
    run_dir = os.path.abspath(os.path.expanduser(a.run_dir))
    if not os.path.isdir(run_dir):
        print(json.dumps({'ok': False, 'message': f'运行目录不存在：{run_dir}'}, ensure_ascii=False)); return 2
    doc_json = load_json_opt(os.path.join(run_dir, 'doc.json')) or {}
    doc_type = a.type or doc_json.get('type')
    try:
        pack, pack_dir = find_pack(doc_type, a.pack)
    except PackLoadError as ex:
        print(json.dumps({'ok': False, 'step': 'pack', 'error': str(ex), 'stale': drop_stale_result(run_dir)}, ensure_ascii=False)); return 4
    if pack is None:
        print(json.dumps({'ok': False, 'message': f'找不到类型包 {doc_type!r}（用 --type / --pack，或设 DOC_TYPES_DIRS）'}, ensure_ascii=False)); return 2
    import validate
    rp = (pack.get('qa') or {}).get('rules_py') if isinstance(pack.get('qa'), dict) else None
    if rp and not rules_py_inside(pack_dir, rp):  # 先查边界：validate 会读 rules_py，指向目录或包外文件时不能先读
        print(json.dumps({'ok': False, 'step': 'pack', 'error': f'qa.rules_py「{rp}」越出类型包目录', 'stale': drop_stale_result(run_dir)}, ensure_ascii=False)); return 4
    try:
        perr, _ = validate.validate_data('pack', pack, pack_dir)
    except Exception as ex:
        print(json.dumps({'ok': False, 'step': 'pack', 'error': f'类型包校验异常：{type(ex).__name__}: {ex}', 'stale': drop_stale_result(run_dir)}, ensure_ascii=False)); return 4
    if perr and not a.allow_invalid_pack:
        print(json.dumps({'ok': False, 'step': 'pack', 'pack_dir': pack_dir, 'errors': [{'path': p, 'message': m} for p, m in perr], 'stale': drop_stale_result(run_dir)}, ensure_ascii=False, indent=2))
        return 4
    source = pack.get('source_file', 'doc.md')
    if not os.path.exists(os.path.join(run_dir, source)):
        print(json.dumps({'ok': False, 'message': f'{source} 不存在'}, ensure_ascii=False)); return 1
    meta_file = pack.get('meta_file', 'doc.json')
    meta = load_json_opt(os.path.join(run_dir, meta_file)) or {}
    profile_id = (meta.get('brand') if isinstance(meta, dict) else None) or pack.get('brand_profile')
    profile = load_json_opt(os.path.join(DOC_SHARED, 'brand', 'profiles', f'{profile_id}.json')) if profile_id else None
    tokens = load_json_opt(os.path.join(DOC_SHARED, 'brand', 'tokens.json'))

    try:
        doc = docmodel.build(run_dir, pack, meta=meta, meta_file=meta_file)
    except Exception as ex:
        print(json.dumps({'ok': False, 'step': 'parse', 'error': f'{type(ex).__name__}: {ex}', 'trace': traceback.format_exc()[-800:], 'stale': drop_stale_result(run_dir)}, ensure_ascii=False)); return 4
    os.makedirs(os.path.join(run_dir, 'out'), exist_ok=True)
    with open(os.path.join(run_dir, 'out', source[:-3] + '.resolved.md'), 'w', encoding='utf-8') as f:
        f.write(doc.text)

    only = [x.strip() for x in a.only.split(',') if x.strip()] if a.only else None
    exclude = [x.strip() for x in a.exclude.split(',') if x.strip()] if a.exclude else None
    want_type = not only or 'E-TYPE' in only or any(c not in ENGINE_CODES for c in only)
    mod, mod_err = load_type_module(pack, pack_dir) if want_type else (None, None)
    ctx = Ctx(run_dir, pack, pack_dir, meta, meta_file, profile, tokens, mod)
    ctx.merges_render = not only
    codes = select_rules(pack, only, exclude)
    issues = []
    for code in codes:
        try:
            for x in engine_rules.RULES[code](doc, ctx):
                x['rule_source'] = 'engine'; issues.append(x)
        except Exception as ex:
            print(json.dumps({'ok': False, 'step': f'engine-rule {code}', 'error': f'{type(ex).__name__}: {ex}', 'trace': traceback.format_exc()[-1200:], 'stale': drop_stale_result(run_dir)}, ensure_ascii=False)); return 4
    type_run = False
    if mod_err:
        issues.append({'rule': 'E-TYPE', 'severity': '必改', 'line': 0, 'excerpt': str((pack.get('qa') or {}).get('rules_py', ''))[:120], 'message': mod_err, 'rule_source': 'type'})
    elif mod is not None:
        type_run = True
        try:
            got = mod.check(doc, ctx)
            good, bad = normalize_external(got, 'type', 'E-TYPE')
            issues += good
            for b in bad:
                issues.append({'rule': 'E-TYPE', 'severity': '必改', 'line': 0, 'excerpt': '', 'message': f'类型包规则返回不合法：{b}', 'rule_source': 'type'})
        except Exception as ex:
            tb = traceback.extract_tb(ex.__traceback__)
            where = f'{os.path.basename(tb[-1].filename)}:{tb[-1].lineno}' if tb else ''
            issues.append({'rule': 'E-TYPE', 'severity': '必改', 'line': 0, 'excerpt': where, 'message': f'类型包 check(doc, ctx) 抛异常：{type(ex).__name__}: {str(ex)[:200]}', 'rule_source': 'type'})
    hook = (pack.get('hooks') or {}).get('pre_qa')
    hook_run = False
    if hook and not a.no_hooks and not only:
        hook_run = True
        got, err = run_hook(hook, run_dir, pack, pack_dir)
        if err:
            issues.append({'rule': 'E-HOOK', 'severity': '必改', 'line': 0, 'excerpt': ' '.join(hook['command'])[:120], 'message': err, 'rule_source': 'hook'})
        else:
            good, bad = normalize_external(got, 'hook', 'E-HOOK')
            issues += good
            for b in bad:
                issues.append({'rule': 'E-HOOK', 'severity': '必改', 'line': 0, 'excerpt': ' '.join(hook['command'])[:120], 'message': f'pre_qa 返回不合法：{b}', 'rule_source': 'hook'})
    if not only:
        issues += merge_render(ctx)
    issues = finalize(issues, (pack.get('qa') or {}).get('severity_overrides') or {})
    must = sum(1 for x in issues if x['severity'] == '必改')
    rules_run = codes + (['type:' + (pack.get('qa') or {}).get('rules_py', '')] if type_run else []) + (['hook:pre_qa'] if hook_run else [])
    result = {'schema_version': '1', 'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
              'source_sha256': hashlib.sha256(doc.text.encode('utf-8')).hexdigest(),
              'engine': {'name': ENGINE_NAME, 'version': ENGINE_VERSION, 'pack': pack.get('id', ''), 'pack_version': pack.get('version', ''), 'rules_run': rules_run},
              'must_fix': must, 'total': len(issues), 'issues': issues}
    errs, _ = validate.validate_data('qa-result', result)
    if errs:
        print(json.dumps({'ok': False, 'step': 'qa-result schema', 'errors': [{'path': p, 'message': m} for p, m in errs], 'stale': drop_stale_result(run_dir)}, ensure_ascii=False, indent=2)); return 4
    with open(os.path.join(run_dir, 'qa-result.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    write_report(run_dir, result)
    state = {'skipped': '--no-state'} if a.no_state else write_state(run_dir, must, pack_dir)
    if state.get('error'):
        print(json.dumps({'ok': False, 'step': 'run-state 写回', 'error': state['error'], 'must_fix': must,
                          'message': 'qa-result.json 已写入，但 run-state.json 未同步（D3 状态可能过期），修好后重跑质检'}, ensure_ascii=False, indent=2))
        return 4
    if not a.quiet:
        print(json.dumps({**result, 'model_source': doc.model_source, 'run_state': state}, ensure_ascii=False, indent=2))
    return 3 if must else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
