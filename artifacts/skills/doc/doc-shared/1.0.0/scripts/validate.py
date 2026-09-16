#!/usr/bin/env python3
"""按 doc-shared/schemas 校验工件；纯标准库（本机无 jsonschema，契约层不引第三方依赖）。
用法：
  validate.py <文件> [--kind doc|pack|run-state|render|qa-result|published|brief]
  validate.py --kind pack <类型包目录> [--no-release]   （目录时读其中 pack.json；默认另做发布约定检查 release_errors，--no-release 跳过）
  validate.py brief.json [--family 分支] [--strict] [--pack <类型包目录>]   （validate_brief：分支、严格模式、mode 取值）
不给 --kind 时按文件名判断：doc.json、pack.json、run-state.json、render.json、qa-result.json、published.json、brief.json。
输出 JSON：{ok, kind, file, errors[{path, message}], warnings[]}。
退出码：0 通过；1 不通过；2 用法或读取错误。

JSON Schema 只支持下面 SUPPORTED 列出的关键字（draft 2020-12 子集）。schemas/ 里用到子集外的关键字时
tests/run_tests.py 会失败，避免「写了约束但校验器静默忽略」。"""
import ast, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMAS = os.path.join(ROOT, 'schemas')
KINDS = {'doc': 'doc.schema.json', 'pack': 'pack.schema.json', 'run-state': 'run-state.schema.json',
         'render': 'render.schema.json', 'qa-result': 'qa-result.schema.json', 'published': 'published.schema.json', 'brief': 'brief.schema.json'}
BY_NAME = {'doc.json': 'doc', 'pack.json': 'pack', 'run-state.json': 'run-state', 'render.json': 'render', 'qa-result.json': 'qa-result', 'published.json': 'published', 'brief.json': 'brief'}
ANNOTATIONS = {'$schema', '$id', 'title', 'description', '$comment', 'default', 'examples'}
SUPPORTED = ANNOTATIONS | {'type', 'properties', 'required', 'additionalProperties', 'patternProperties', 'enum', 'const',
                           'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'items', 'minItems', 'maxItems',
                           'uniqueItems', '$ref', '$defs', 'oneOf', 'anyOf', 'allOf'}
HOOK_PLACEHOLDERS = {'run_dir', 'pack_dir', 'skills_dir', 'doc_shared', 'python'}
GATES = ['D0', 'D1', 'D2', 'D3', 'D4']
SEMVER = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')   # 发布约定：三段式，不带预发布与构建号（pack-interface.md §6）
SHARED_DOC_FIELDS = ('lark_folder',)   # 非 doc 分支的 brief 里，按 doc.schema.json 同名字段深度校验的字段


def _type_ok(v, t):
    if t == 'object': return isinstance(v, dict)
    if t == 'array': return isinstance(v, list)
    if t == 'string': return isinstance(v, str)
    if t == 'integer': return isinstance(v, int) and not isinstance(v, bool)
    if t == 'number': return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == 'boolean': return isinstance(v, bool)
    if t == 'null': return v is None
    raise ValueError(f'未知 type：{t}')


def _resolve_ref(ref, root):
    if not ref.startswith('#/'): raise ValueError(f'只支持本地 $ref：{ref}')
    node = root
    for part in ref[2:].split('/'):
        node = node[part]
    return node


def check(v, s, root, path='$'):
    """返回错误列表 [(path, message)]。"""
    errs = []
    if s is True or s == {}: return errs
    if s is False: return [(path, '不允许出现')]
    unknown = set(s) - SUPPORTED
    if unknown: raise ValueError(f'{path}: schema 使用了不支持的关键字 {sorted(unknown)}')
    if '$ref' in s:
        errs += check(v, _resolve_ref(s['$ref'], root), root, path)
    if 'type' in s:
        ts = s['type'] if isinstance(s['type'], list) else [s['type']]
        if not any(_type_ok(v, t) for t in ts):
            return errs + [(path, f'类型应为 {"/".join(ts)}，实际 {type(v).__name__}')]
    if 'const' in s and v != s['const']: errs.append((path, f'应为 {json.dumps(s["const"], ensure_ascii=False)}'))
    if 'enum' in s and v not in s['enum']: errs.append((path, f'取值 {json.dumps(v, ensure_ascii=False)} 不在 {json.dumps(s["enum"], ensure_ascii=False)}'))
    if isinstance(v, str):
        if 'minLength' in s and len(v) < s['minLength']: errs.append((path, f'长度小于 {s["minLength"]}'))
        if 'maxLength' in s and len(v) > s['maxLength']: errs.append((path, f'长度大于 {s["maxLength"]}'))
        if 'pattern' in s and not re.search(s['pattern'], v): errs.append((path, f'不匹配 {s["pattern"]}'))
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if 'minimum' in s and v < s['minimum']: errs.append((path, f'小于 {s["minimum"]}'))
        if 'maximum' in s and v > s['maximum']: errs.append((path, f'大于 {s["maximum"]}'))
    if isinstance(v, list):
        if 'minItems' in s and len(v) < s['minItems']: errs.append((path, f'至少 {s["minItems"]} 项'))
        if 'maxItems' in s and len(v) > s['maxItems']: errs.append((path, f'至多 {s["maxItems"]} 项'))
        if s.get('uniqueItems'):
            seen = [json.dumps(x, sort_keys=True) for x in v]
            if len(seen) != len(set(seen)): errs.append((path, '存在重复项'))
        if 'items' in s:
            for i, x in enumerate(v): errs += check(x, s['items'], root, f'{path}[{i}]')
    if isinstance(v, dict):
        for k in s.get('required', []):
            if k not in v: errs.append((f'{path}.{k}', '缺少必填字段'))
        props = s.get('properties', {}); pprops = s.get('patternProperties', {})
        for k, x in v.items():
            matched = False
            if k in props:
                matched = True; errs += check(x, props[k], root, f'{path}.{k}')
            for pat, sub in pprops.items():
                if re.search(pat, k):
                    matched = True; errs += check(x, sub, root, f'{path}.{k}')
            if not matched and 'additionalProperties' in s:
                ap = s['additionalProperties']
                if ap is False: errs.append((f'{path}.{k}', '不允许的字段'))
                elif isinstance(ap, dict): errs += check(x, ap, root, f'{path}.{k}')
    for sub in s.get('allOf', []): errs += check(v, sub, root, path)
    if 'anyOf' in s and not any(not check(v, sub, root, path) for sub in s['anyOf']):
        errs.append((path, '不满足 anyOf 中任何一个'))
    if 'oneOf' in s:
        results = [check(v, sub, root, path) for sub in s['oneOf']]
        ok = sum(1 for r in results if not r)
        if ok != 1:
            best = min(results, key=len) if results else []
            detail = '；'.join(f'{p} {m}' for p, m in best[:3])
            errs.append((path, f'应恰好满足 oneOf 中一个（满足 {ok} 个）' + (f'。最接近的分支：{detail}' if ok == 0 and detail else '')))
    return errs


def schema_keywords(node, found=None):
    """收集 schema 里作为关键字出现的键（跳过 properties/$defs/patternProperties 下的名字）。"""
    found = set() if found is None else found
    if isinstance(node, dict):
        for k, x in node.items():
            found.add(k)
            if k in ('properties', '$defs', 'patternProperties'):
                for sub in x.values(): schema_keywords(sub, found)
            elif k in ('items', 'additionalProperties') and isinstance(x, dict):
                schema_keywords(x, found)
            elif k in ('oneOf', 'anyOf', 'allOf'):
                for sub in x: schema_keywords(sub, found)
    return found


def load_schema(kind):
    return json.load(open(os.path.join(SCHEMAS, KINDS[kind])))


def _inside(base_dir, rel):
    """rel 是否为 base_dir 内的相对路径（按 realpath：拦绝对路径、~、..、符号链接越界，base_dir 本身不算）。"""
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or rel.startswith('~'): return False
    root = os.path.realpath(base_dir)
    real = os.path.realpath(os.path.join(root, rel))
    return real != root and os.path.commonpath([real, root]) == root


def _modes_errors(data, base_dir):
    """pack.modes 语义检查：default 存在、id 唯一、补丁引用的章节存在、插入不撞 id、不删必备章节、模板文件存在。"""
    modes = data.get('modes')
    if not modes: return []
    errors = []
    base = {s['id']: s for s in data.get('skeleton', [])}
    mids = [m['id'] for m in modes.get('items', [])]
    dup = sorted({i for i in mids if mids.count(i) > 1})
    if dup: errors.append(('$.modes.items', f'mode id 重复：{dup}'))
    if modes.get('default') not in mids: errors.append(('$.modes.default', f'default {modes.get("default")!r} 不在 items 的 id 里'))
    for i, m in enumerate(modes.get('items', [])):
        mp = f'$.modes.items[{i}]'
        for sid in (m.get('skeleton_patch') or {}):
            if sid not in base: errors.append((f'{mp}.skeleton_patch', f'章节 id {sid} 不在基础 skeleton 里'))
        removed = set(m.get('skeleton_remove') or [])
        known = set(base) - removed
        for j, ins in enumerate(m.get('skeleton_insert') or []):
            if ins['after'] in removed: errors.append((f'{mp}.skeleton_insert[{j}].after', f'插入位置 {ins["after"]} 已被本 mode 删除'))
            elif ins['after'] not in known: errors.append((f'{mp}.skeleton_insert[{j}].after', f'章节 id {ins["after"]} 不存在（基础 skeleton 或本 mode 之前插入的章节）'))
            sid = ins['section']['id']
            if sid in known: errors.append((f'{mp}.skeleton_insert[{j}].section.id', f'插入章节 id {sid} 与已有章节重复'))
            known.add(sid)
        for j, sid in enumerate(m.get('skeleton_remove') or []):
            if sid not in base: errors.append((f'{mp}.skeleton_remove[{j}]', f'章节 id {sid} 不在基础 skeleton 里'))
            elif base[sid].get('required'): errors.append((f'{mp}.skeleton_remove[{j}]', f'必备章节 {sid} 不能被 mode 删除'))
            if sid in (m.get('skeleton_patch') or {}): errors.append((f'{mp}.skeleton_remove[{j}]', f'章节 {sid} 同时被补丁与删除'))
        for j, term in enumerate(m.get('forbidden_terms') or []):
            try: re.compile(term)
            except re.error as ex: errors.append((f'{mp}.forbidden_terms[{j}]', f'正则无效：{ex}'))
        als = [a for x in modes.get('items', []) for a in [x['id']] + (x.get('aliases') or [])]
        for a in [m['id']] + (m.get('aliases') or []):
            if als.count(a) > 1 and a != m['id']: errors.append((f'{mp}.aliases', f'别名 {a!r} 与其他 mode 的 id 或别名重复'))
        if base_dir:
            for j, rel in enumerate(m.get('templates') or []):
                if not _inside(base_dir, rel): errors.append((f'{mp}.templates[{j}]', f'必须是包目录内的相对路径：{rel}'))
                elif not os.path.exists(os.path.join(base_dir, rel)): errors.append((f'{mp}.templates[{j}]', f'文件不存在：{rel}'))
    return errors


class ModeError(ValueError):
    pass


def field_value(data, field):
    """点号路径取值：(路径完整存在且值非空, 值)。"""
    cur = data
    for part in field.split('.'):
        if not isinstance(cur, dict) or part not in cur:
            return False, None
        cur = cur[part]
    return cur not in (None, ''), cur


def mode_meta(run_dir, pack, meta, meta_file=None):
    """取 mode 用的元数据（pack-interface.md §2.1）：元数据文件里有完整字段路径（值非空）就用它（非法值也不被覆盖）；
    否则元数据文件不是 brief.json 且运行目录 brief.json 有该字段时用 brief.json；都没有时仍用元数据文件（resolve_mode 取 default 或兼容旧写法）。
    doc-qa docmodel.mode_meta 转发到这里（2026-09-15 W3-H 上移，唯一实现）。"""
    field = ((pack or {}).get('modes') or {}).get('field') or ''
    meta = meta if isinstance(meta, dict) else {}
    if not field or field_value(meta, field)[0]:
        return meta
    if (meta_file or pack.get('meta_file', 'doc.json')) != 'brief.json' and run_dir:
        try:
            brief = json.load(open(os.path.join(run_dir, 'brief.json'), encoding='utf-8'))
        except (OSError, ValueError):
            brief = None
        if isinstance(brief, dict) and field_value(brief, field)[0]:
            return brief
    return meta


def resolve_mode(pack, meta, run_dir=None, meta_file=None):
    """按 pack.modes.field 从元数据（doc.json / brief.json 内容）取 mode，返回 mode id。
    给了 run_dir 时先经 mode_meta 选元数据（字段路径不全时回退运行目录 brief.json，pack-interface.md §2.1）；不给时只看传入的 meta。
    值匹配 id 或 aliases；字段缺失时兼容旧写法（site.migration 为真 → migration，若该 mode 存在），否则取 default；
    值无法识别时抛 ModeError（不静默回落到默认骨架）。pack 没有 modes 时返回 None。"""
    modes = pack.get('modes')
    if not modes: return None
    if run_dir is not None:
        meta = mode_meta(run_dir, pack, meta, meta_file)
    cur = meta or {}
    for part in modes['field'].split('.'):
        cur = cur.get(part) if isinstance(cur, dict) else None
    if cur in (None, ''):
        legacy = (meta or {}).get(modes['field'].split('.')[0], {}) if '.' in modes['field'] else {}
        if isinstance(legacy, dict) and legacy.get('migration') is True and any(m['id'] == 'migration' for m in modes['items']):
            return 'migration'
        return modes['default']
    for m in modes['items']:
        if cur == m['id'] or cur in (m.get('aliases') or []):
            return m['id']
    raise ModeError(f"{modes['field']} = {cur!r} 不是已声明的 mode：{[m['id'] for m in modes['items']]}")


def forbidden_hits(pack, mode_id, text):
    """返回 [(term, 行号, 行文本)]：mode 的 forbidden_terms 按 Python 正则逐行匹配；调用方负责先去掉注释等例外区。"""
    modes = pack.get('modes') or {}
    m = next((x for x in modes.get('items', []) if x['id'] == mode_id), None)
    out = []
    for term in (m or {}).get('forbidden_terms') or []:
        rx = re.compile(term)
        for i, ln in enumerate(text.splitlines(), 1):
            if rx.search(ln): out.append((term, i, ln))
    return out


def resolve_skeleton(pack, mode_id=None):
    """按 mode 返回打完补丁的 skeleton 列表（不改原 pack）；mode_id 为 None 取 default，未知 id 抛 KeyError。"""
    import copy as _copy
    sk = _copy.deepcopy(pack.get('skeleton', []))
    modes = pack.get('modes')
    if not modes: return sk
    mid = mode_id or modes['default']
    m = next((x for x in modes['items'] if x['id'] == mid or mid in (x.get('aliases') or [])), None)
    if m is None: raise KeyError(mid)
    drop = set(m.get('skeleton_remove') or [])
    sk = [s for s in sk if s['id'] not in drop]
    for s in sk:
        s.update(_copy.deepcopy((m.get('skeleton_patch') or {}).get(s['id'], {})))
    tail = {}  # 同一锚点的多个插入保持声明顺序：记录该锚点最近一次插入的章节 id
    for ins in m.get('skeleton_insert') or []:
        anchor = tail.get(ins['after'], ins['after'])
        k = next((i for i, s in enumerate(sk) if s['id'] == anchor), None)
        if k is None: raise KeyError(f"插入位置 {ins['after']} 不存在（先跑 validate）")
        sk.insert(k + 1, _copy.deepcopy(ins['section']))
        tail[ins['after']] = ins['section']['id']
    return sk


def _org_sections_errors(data):
    """pack.org_sections：id 不重复；path 相对 doc-shared，按 realpath 规范化后必须落在 brand/org/sections/ 内且是文件
    （拦 ..、同名前缀目录、符号链接越界、目录）；required 为真时基础 skeleton 必须有同 id 的必备章节。"""
    secs = data.get('org_sections') or []
    errors = []
    ids = [x.get('id') for x in secs]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup: errors.append(('$.org_sections', f'组织级章节 id 重复：{dup}'))
    root = os.path.realpath(ROOT)
    sec_root = os.path.realpath(os.path.join(root, 'brand', 'org', 'sections'))
    required_ids = {x.get('id') for x in data.get('skeleton') or [] if isinstance(x, dict) and x.get('required')}
    for i, x in enumerate(secs):
        if x.get('required') and x.get('id') not in required_ids:
            errors.append((f'$.org_sections[{i}].required', f'required 为真时基础 skeleton 必须有同 id 的必备章节：{x.get("id")}'))
        rel, p = x.get('path', ''), f'$.org_sections[{i}].path'
        if os.path.isabs(rel) or rel.startswith('~'):
            errors.append((p, f'必须是相对 doc-shared 的路径：{rel}')); continue
        real = os.path.realpath(os.path.join(root, rel))
        if real == sec_root or os.path.commonpath([real, sec_root]) != sec_root:
            errors.append((p, f'规范化后不在 brand/org/sections/ 内：{rel}'))
        elif not os.path.isfile(real):
            errors.append((p, f'文件不存在或不是文件：{rel}'))
    return errors


def release_errors(data, base_dir):
    """发布约定（pack-interface.md §6）：version 为三段式 X.Y.Z；base_dir 下 CHANGELOG.md 存在且有当前版本标题（「## X.Y.Z — YYYY-MM-DD」二级标题，可带 v，破折号也可写 – 或 -；最上面的版本标题必须是当前版本；不识别代码块，代码块里的同形行也算标题）。
    只由 CLI 调用（--no-release 跳过），不放进 validate_data：引擎运行时与自测夹具包不受发布约定约束。"""
    errors = []
    v = data.get('version')
    if not isinstance(v, str) or not SEMVER.match(v):
        errors.append(('$.version', f'版本号必须是三段式 X.Y.Z（不带预发布与构建号）：{v!r}'))
    if not base_dir: return errors
    cl = os.path.join(base_dir, 'CHANGELOG.md')
    if not os.path.isfile(cl):
        errors.append(('CHANGELOG.md', '包目录缺 CHANGELOG.md（pack-interface.md §6）'))
    elif isinstance(v, str) and SEMVER.match(v):
        heads = re.findall(r'^##[ \t]+v?([0-9]+\.[0-9]+\.[0-9]+)[ \t]+[—–-][ \t]+[0-9]{4}-[0-9]{2}-[0-9]{2}[ \t]*$', open(cl, encoding='utf-8').read(), re.M)
        if v not in heads:
            errors.append(('CHANGELOG.md', f'CHANGELOG.md 没有当前版本 {v} 的二级标题「## {v} — YYYY-MM-DD」（须带日期）'))
        elif heads[0] != v:
            errors.append(('CHANGELOG.md', f'CHANGELOG.md 最上面的版本标题是 {heads[0]}，应为当前版本 {v}（新版本在上）'))
    return errors


def brief_branch(data, schema=None):
    """brief 命中的 oneOf 分支名（brief.schema.json $defs 的键）；一个都不命中或命中多个时返回 None。"""
    schema = schema or load_schema('brief')
    names = [x['$ref'].rsplit('/', 1)[1] for x in schema.get('oneOf', [])]
    hits = [n for n in names if not check(data, schema['$defs'][n], schema)]
    return hits[0] if len(hits) == 1 else None


def validate_brief(data, family=None, strict=False, pack=None):
    """brief.json 校验，返回 (errors[(path, msg)], warnings[str])。
    family：oneOf 里的分支名（如 doc_brief）；给了只按该分支校验，不给按 oneOf 自动判定。
    命中 doc_brief 时各字段再按 doc.schema.json 同名字段深度校验；其他分支只深度校验 SHARED_DOC_FIELDS。
    strict：$defs 里 <分支>_strict 的要求不满足时算错误，否则算警告（缺项由调用方追问）。
    pack：类型包 pack.json 内容；声明了 modes 时按 resolve_mode 核对取值（无法识别为错误）。"""
    schema = load_schema('brief')
    names = [x['$ref'].rsplit('/', 1)[1] for x in schema.get('oneOf', [])]
    if family is not None and family not in names:
        return [('$', f'未知 brief 分支 {family!r}，可选 {names}')], []
    if pack is not None:
        pschema = load_schema('pack')
        perr = check(pack, pschema, pschema)
        if perr: return [('--pack', f'类型包不合 pack.schema：{perr[0][0]} {perr[0][1]}')], []
    if family:
        errors, branch = check(data, schema['$defs'][family], schema), family
    else:
        errors, branch = check(data, schema, schema), brief_branch(data, schema)
    if errors or not branch: return errors, []
    warnings = []
    doc_schema = load_schema('doc')
    fields = list(data) if branch == 'doc_brief' else [k for k in SHARED_DOC_FIELDS if k in data]
    for k in fields:
        if k in doc_schema['properties']:
            errors += check(data[k], doc_schema['properties'][k], doc_schema, f'$.{k}')
    strict_def = schema['$defs'].get(branch + '_strict')
    if strict_def:
        for p, m in check(data, strict_def, schema):
            if strict: errors.append((p, f'{m}（{branch} 严格模式）'))
            else: warnings.append(f'{p} {m}（{branch} 严格模式必填，调用方按需要追问或补齐）')
    if pack and pack.get('modes'):
        try:
            resolve_mode(pack, data)
        except ModeError as ex:
            errors.append((f"$.{pack['modes']['field']}", str(ex)))
    return errors, warnings


def _semantic(kind, data, base_dir):
    errors, warnings = [], []
    if kind == 'pack':
        ids = [x['id'] for x in data.get('skeleton', [])]
        dup = sorted({i for i in ids if ids.count(i) > 1})
        if dup: errors.append(('$.skeleton', f'章节 id 重复：{dup}'))
        kinds = [e['kind'] for e in data.get('numbering', {}).get('entities', [])]
        dupk = sorted({k for k in kinds if kinds.count(k) > 1})
        if dupk: errors.append(('$.numbering.entities', f'编号实体 kind 重复：{dupk}'))
        for i, e in enumerate(data.get('numbering', {}).get('entities', [])):
            try: re.compile(e['pattern'])
            except re.error as ex: errors.append((f'$.numbering.entities[{i}].pattern', f'正则无效：{ex}'))
        prof = os.path.join(ROOT, 'brand', 'profiles', f"{data.get('brand_profile', '')}.json")
        if not os.path.exists(prof): errors.append(('$.brand_profile', f'品牌档案不存在：brand/profiles/{data.get("brand_profile")}.json'))
        if base_dir:
            qa = data.get('qa', {})
            refs = [('$.qa.rules_md', qa.get('rules_md')), ('$.qa.rules_py', qa.get('rules_py'))]
            refs += [(f'$.templates[{i}]', t) for i, t in enumerate(data.get('templates', []))]
            wc = data.get('writing_contract') or {}
            if wc.get('snapshot'): refs.append(('$.writing_contract.snapshot', wc['snapshot']))
            for p, rel in refs:
                if not rel: continue
                if p.startswith('$.templates[') and not _inside(base_dir, rel): errors.append((p, f'必须是包目录内的相对路径（组织级章节写 org_sections）：{rel}'))
                elif not os.path.exists(os.path.join(base_dir, rel)): errors.append((p, f'文件不存在：{rel}'))
            if isinstance(qa.get('glossary'), str):
                gp = os.path.join(base_dir, qa['glossary'])
                if not os.path.exists(gp):
                    errors.append(('$.qa.glossary', f'术语表文件不存在：{qa["glossary"]}'))
                else:
                    try:
                        g = json.load(open(gp))
                        if not (isinstance(g, dict) and all(isinstance(v, list) and all(isinstance(x, str) for x in v) for v in g.values())):
                            errors.append(('$.qa.glossary', '术语表文件必须是 {正写: [异写]} 形态'))
                    except json.JSONDecodeError as ex:
                        errors.append(('$.qa.glossary', f'术语表文件不是合法 JSON：{ex}'))
            if qa.get('rules_py') and os.path.exists(os.path.join(base_dir, qa['rules_py'])):
                try:
                    tree = ast.parse(open(os.path.join(base_dir, qa['rules_py'])).read())
                    fn = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'check']
                    if not fn or [a.arg for a in fn[0].args.args][:2] != ['doc', 'ctx']:
                        errors.append(('$.qa.rules_py', 'qa_rules.py 必须在模块顶层定义 check(doc, ctx)'))
                except SyntaxError as ex:
                    errors.append(('$.qa.rules_py', f'qa_rules.py 语法错误：{ex}'))
        rel_keys = [(r.get('type'), r.get('role')) for r in data.get('related', [])]
        if len(rel_keys) != len(set(rel_keys)): errors.append(('$.related', '同一 type + role 重复声明'))
        cmds = [('$.gates.D2', (data.get('gates') or {}).get('D2'))] + [(f'$.hooks.{k}', v) for k, v in (data.get('hooks') or {}).items()]
        for p, c in cmds:
            if not c: continue
            for arg in c.get('command', []):
                for ph in re.findall(r'\{([a-z_]+)\}', arg):
                    if ph not in HOOK_PLACEHOLDERS: errors.append((p, f'命令占位符 {{{ph}}} 不在 {sorted(HOOK_PLACEHOLDERS)}'))
        errors += _modes_errors(data, base_dir)
        errors += _org_sections_errors(data)
        for i, e in enumerate(data.get('include_allow', [])):
            if e.startswith('/') or '..' in e.split('/'): errors.append((f'$.include_allow[{i}]', 'include 白名单不能是绝对路径或含 ..'))
    elif kind == 'doc':
        prof_path = os.path.join(ROOT, 'brand', 'profiles', f"{data.get('brand', '')}.json")
        if not os.path.exists(prof_path):
            errors.append(('$.brand', f'品牌档案不存在：brand/profiles/{data.get("brand")}.json'))
        else:
            prof = json.load(open(prof_path))
            if prof.get('audience') != data.get('audience'):
                warnings.append(f'audience={data.get("audience")} 与品牌档案 {prof["id"]} 的 audience={prof.get("audience")} 不一致，确认是有意为之')
        hist = [h['version'].lstrip('v') for h in data.get('revision_history', [])]
        if hist and data.get('version') not in hist:
            warnings.append(f'revision_history 里没有当前版本 v{data.get("version")}')
    elif kind == 'run-state':
        st = [(g, data.get('gates', {}).get(g, {}).get('status')) for g in GATES]
        done = {'passed', 'skipped', 'waived'}
        for i, (g, s) in enumerate(st):
            if s in done:
                bad = [pg for pg, ps in st[:i] if ps not in done]
                if bad: errors.append((f'$.gates.{g}', f'{g} 已是 {s}，但前序门 {bad} 未完成'))
    elif kind == 'qa-result':
        issues = data.get('issues', [])
        must = sum(1 for x in issues if x.get('severity') == '必改')
        if data.get('must_fix') != must: errors.append(('$.must_fix', f'must_fix={data.get("must_fix")} 与 issues 中必改条数 {must} 不一致'))
        if data.get('total') != len(issues): errors.append(('$.total', f'total={data.get("total")} 与 issues 条数 {len(issues)} 不一致'))
    elif kind == 'render':
        for i, f in enumerate(data.get('figures', [])):
            if f.get('engine') != 'image' and f.get('min_font_pt') is None:
                warnings.append(f'figures[{i}] {f.get("src")} 缺等效最小字号（非位图必须计算）')
    return errors, warnings


def validate_data(kind, data, base_dir=None):
    """供其他脚本复用：返回 (errors[(path, msg)], warnings[str])。brief 走 validate_brief（自动判分支、非严格）；pack 不含发布约定检查。"""
    if kind == 'brief': return validate_brief(data)
    schema = load_schema(kind)
    errors = check(data, schema, schema)
    if not errors:
        e2, w2 = _semantic(kind, data, base_dir)
        return errors + e2, w2
    return errors, []


def main(argv):
    args = list(argv); kind = None; family = None; pack_arg = None
    flags = {f: f in args for f in ('--strict', '--no-release')}
    args = [x for x in args if x not in flags]
    for opt in ('--kind', '--family', '--pack'):
        if opt in args:
            i = args.index(opt)
            if i + 1 >= len(args): print(__doc__); return 2
            val = args[i + 1]; del args[i:i + 2]
            if opt == '--kind': kind = val
            elif opt == '--family': family = val
            else: pack_arg = val
    if len(args) != 1 or (kind and kind not in KINDS):
        print(__doc__); return 2
    target = os.path.abspath(args[0])
    if os.path.isdir(target): target = os.path.join(target, 'pack.json'); kind = kind or 'pack'
    kind = kind or BY_NAME.get(os.path.basename(target))
    if not kind:
        print(json.dumps({'ok': False, 'file': target, 'errors': [{'path': '', 'message': '无法按文件名判断类型，请加 --kind'}]}, ensure_ascii=False)); return 2
    try:
        data = json.load(open(target))
    except (OSError, json.JSONDecodeError) as ex:
        print(json.dumps({'ok': False, 'kind': kind, 'file': target, 'errors': [{'path': '', 'message': f'读取失败：{ex}'}]}, ensure_ascii=False)); return 2
    if kind == 'brief':
        pack = None
        if pack_arg:
            pp = os.path.abspath(os.path.expanduser(pack_arg))
            pp = os.path.join(pp, 'pack.json') if os.path.isdir(pp) else pp
            try:
                pack = json.load(open(pp))
            except (OSError, json.JSONDecodeError) as ex:
                print(json.dumps({'ok': False, 'kind': kind, 'file': target, 'errors': [{'path': '--pack', 'message': f'类型包读取失败：{ex}'}]}, ensure_ascii=False)); return 2
        errors, warnings = validate_brief(data, family=family, strict=flags['--strict'], pack=pack)
    else:
        errors, warnings = validate_data(kind, data, os.path.dirname(target))
        if kind == 'pack' and not flags['--no-release'] and isinstance(data, dict):
            errors = errors + release_errors(data, os.path.dirname(target))
    print(json.dumps({'ok': not errors, 'kind': kind, 'file': target, 'errors': [{'path': p, 'message': m} for p, m in errors], 'warnings': warnings}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
