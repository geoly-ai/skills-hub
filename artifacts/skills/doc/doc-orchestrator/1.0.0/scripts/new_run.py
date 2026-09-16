#!/usr/bin/env python3
"""建运行目录（新建 / 导入 / 改版），校验 brief，生成 doc.json、run-state、outline.md 与 doc.md 骨架。
用法：
  new_run.py <type> <运行目录> --brief brief.json                      新建（mode=new）
  new_run.py <type> <运行目录> --brief brief.json --import <来源>      导入已有文档作底稿（mode=import；旧稿就是本文档旧版时加 --mode revision）
  new_run.py <type> <运行目录> --from <上一版运行目录> --version X.Y --change-summary "改了什么" [--brief 只写要改的字段]
                                                                      改版（mode 恒为 revision）：以上一版 doc.json 为基线，--brief 显式给的字段覆盖；
                                                                      inputs 沿用上一版 brief.json 并合并；复制正文、data、figures、sections
可选：--profile account1|account2（导入飞书时）；--by 谁；--force（目录非空时仍建，已有正文不覆盖）；--pack
brief.json 字段（契约见 doc-shared/references/artifacts.md §8，结构由 doc-shared/schemas/brief.schema.json doc_brief 分支校验，
validate.validate_brief(family='doc_brief', strict=False, pack=类型包)；不合 schema 退出 2）：doc.json 可写字段 + inputs{类型包 inputs 的 id: 值}。
  类型包 input 声明了 path（运行目录内 glob）时，值必须是一个存在的文件路径，建目录时复制到该 path（glob 时保留文件名，须匹配 glob）；
  声明了 doc_field 时由 doc.json 该字段满足；两者都没有时值为非空文本。
缺项：doc 必填（title、project、owner、lark_folder）、类型包 required inputs、类型包 related 中 required 的关联文档（type + role
已登记且 path 可解析）、doc.json 不过 schema → 输出 missing[{field, desc, question}]，退出 3，不建目录。
原子性：先在同级临时目录完成 init、导入、复制、骨架与 set-stage（检查返回码），全部成功才落位；落位也是事务（目标已存在时先建合并副本，
再「目标改名为备份 → 合并副本改名为目标」，失败把备份改回）。任何一步失败目标目录保持原样可重试。
改版的 path 型必需输入：brief 显式给了新文件就复制到类型包 path 并删掉匹配同一 path 的旧副本；没给才复用上一版的文件。
版本号比较：1.0 与 1.0.0 等值（补齐三段后按数值比较）。
退出码：0 成功；1 目录非空或已有 run-state.json（未加 --force）、run_state init / set-stage、导入或落位失败；2 用法错误、未知类型、参数冲突（--from 与任何 --mode）、版本不递增；
       3 brief 缺项；4 售前类型（转 presales-orchestrator）。"""
import argparse, datetime, fnmatch, glob, json, os, re, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orchlib as ol  # noqa: E402
from orchlib import al  # noqa: E402
import validate  # noqa: E402
import related as relmod  # noqa: E402
import outline as outline_mod  # noqa: E402

DOC_KEYS = {'title', 'subtitle', 'project', 'owner', 'reviewers', 'version', 'date', 'doc_no', 'client', 'cover', 'contact', 'related_docs',
            'revision_history', 'lark_folder', 'lark_profile', 'extra', 'status', 'audience', 'brand', 'language'}
BRIEF_KEYS = DOC_KEYS | {'inputs', '$comment', 'schema_version', 'type'}
REVISION_OWNED = {'version', 'date', 'status', 'revision_history'}   # 改版时由 --version / --change-summary 决定，brief 不能覆盖
QUESTIONS = {
    'title': '文档标题（封面大标题）是什么？',
    'project': '项目英文短名是什么（决定运行目录与飞书项目文件夹，小写短横线）？',
    'owner': '文档负责人是谁（姓名（角色））？',
    'lark_folder': '发布到飞书哪个项目文件夹？有 token 给 token；暂时没有就给拟定路径（「客户或项目/子项目」）并说明原因，D4 前补 token。',
}
GLOB_CHARS = re.compile(r'[*?\[]')


def today():
    return datetime.date.today().isoformat()


def owner_name(owner):
    return re.split(r'[（(]', owner or '')[0].strip() or owner


def emit(obj, code):
    print(json.dumps(obj, ensure_ascii=False, indent=2)); return code


def input_dest(inp, src):
    """path 型输入：返回复制目标（运行目录相对路径）或 (None, 原因)。"""
    pat = inp['path']
    if not GLOB_CHARS.search(pat):
        return pat, None
    dest = os.path.join(os.path.dirname(pat), os.path.basename(src)) if os.path.dirname(pat) else os.path.basename(src)
    if not fnmatch.fnmatch(dest, pat):
        return None, f'文件名 {os.path.basename(src)} 不匹配 {pat}'
    return dest, None


def check_brief(pack, doc, inputs, run_dir, prev_dir=None, explicit_inputs=None):
    missing, copies = [], []
    for k, q in QUESTIONS.items():
        if doc.get(k) in (None, '', {}, []):
            missing.append({'field': k, 'desc': 'doc.json 必填', 'question': q})
    for inp in pack.get('inputs') or []:
        if not inp.get('required'): continue
        val = inputs.get(inp['id'])
        if inp.get('doc_field'):
            if al.get_field(doc, inp['doc_field']) in (None, '', [], {}):
                missing.append({'field': f'inputs.{inp["id"]}', 'desc': inp.get('desc', ''), 'question': f'请提供：{inp.get("desc", inp["id"])}（写进 doc.json 的 {inp["doc_field"]}）'})
            continue
        if inp.get('path'):
            given = inp['id'] in (explicit_inputs or {}) and explicit_inputs[inp['id']] not in (None, '')
            if prev_dir and not given:
                old = sorted(glob.glob(os.path.join(prev_dir, inp['path'])))
                if old:   # 改版且没给新值：复用上一版的文件（不论 path 在不在 data/figures/sections）
                    copies += [('reuse', p, os.path.relpath(p, prev_dir), inp['path']) for p in old]
                    continue
            if prev_dir and given:
                val = explicit_inputs[inp['id']]
            src = os.path.expanduser(str(val)) if isinstance(val, str) and val else None
            if not src or not os.path.isfile(src):
                missing.append({'field': f'inputs.{inp["id"]}', 'desc': inp.get('desc', ''),
                                'question': f'请提供文件：{inp.get("desc", inp["id"])}（brief.json inputs.{inp["id"]} 写本机文件路径，建目录时放到 {inp["path"]}）'})
                continue
            dest, why = input_dest(inp, src)
            if dest is None:
                missing.append({'field': f'inputs.{inp["id"]}', 'desc': why, 'question': f'{inp["id"]}：{why}，请改文件名或换文件'}); continue
            copies.append(('new', src, dest, inp['path']))
            continue
        if val in (None, '', [], {}):
            missing.append({'field': f'inputs.{inp["id"]}', 'desc': inp.get('desc', ''), 'question': f'请提供：{inp.get("desc", inp["id"])}'})
    for r in pack.get('related') or []:
        if not r.get('required'): continue
        hits = [e for e in doc.get('related_docs') or [] if e.get('type') == r['type'] and e.get('role') == r.get('role')]
        if not hits:
            missing.append({'field': f'related_docs[{r["type"]}/{r.get("role")}]', 'desc': r.get('desc', ''),
                            'question': f'本类型要求登记关联文档 {r["type"]}（role={r.get("role")}，{r.get("desc", "")}）：它的运行目录在哪？'})
            continue
        rd = relmod.RelatedDoc(run_dir, hits[0])
        if not rd.ok:
            missing.append({'field': f'related_docs[{r["type"]}/{r.get("role")}]', 'desc': rd.error,
                            'question': f'关联文档 {r["type"]} 的 path 解析不到（{rd.error}）：请给正确的运行目录（相对新运行目录或绝对路径）'})
    errors, warnings = validate.validate_data('doc', doc)
    reported = {m['field'] for m in missing}
    for p, m in errors:
        if p.split('.')[-1] in reported: continue
        missing.append({'field': p or 'doc.json', 'desc': m, 'question': f'doc.json 字段 {p} 不合法：{m}'})
    return missing, warnings, copies


def copy_prev(prev, dst, pack):
    src = pack.get('source_file', 'doc.md')
    copied = []
    p = os.path.join(prev, src)
    if os.path.exists(p):
        shutil.copy2(p, os.path.join(dst, src)); copied.append(src)
        os.makedirs(os.path.join(dst, 'base'), exist_ok=True)
        shutil.copy2(p, os.path.join(dst, 'base', 'base-doc.md')); copied.append('base/base-doc.md')
    for d in ('data', 'figures', 'sections'):
        if os.path.isdir(os.path.join(prev, d)):
            shutil.copytree(os.path.join(prev, d), os.path.join(dst, d), dirs_exist_ok=True); copied.append(d + '/')
    return copied


class LandError(RuntimeError):
    def __init__(self, msg, restored):
        super().__init__(msg); self.restored = restored


def fault(point):
    """自测故障注入：DOC_NEW_RUN_FAULT=<point> 时在该点抛异常（只供 tests/run_tests.py 验证回滚）。"""
    if os.environ.get('DOC_NEW_RUN_FAULT') == point:
        raise RuntimeError(f'注入故障：{point}')


def land(staging, run_dir, keep_existing):
    """事务落位。目标不存在：staging 原子改名为目标。目标已存在（空目录或 --force）：
    ① 在同级建合并目录 = 目标原内容的完整副本 + staging 覆盖（keep_existing 里已有的不覆盖；文件与目录同名冲突直接失败）
    ② 目标改名为备份 → 合并目录改名为目标 → 删备份。①出错只清合并目录；②出错把备份改回目标。目标要么是原样、要么是完整新树。"""
    parent = os.path.dirname(run_dir)
    if not os.path.lexists(run_dir):
        try:
            fault('land-rename')
            os.rename(staging, run_dir)
        except Exception as ex:
            if os.path.lexists(run_dir) and not os.path.lexists(staging):
                shutil.rmtree(run_dir, ignore_errors=True)
            raise LandError(f'落位失败（目标原本不存在，已清理）：{type(ex).__name__}: {ex}', restored=True)
        return []
    if not os.path.isdir(run_dir) or os.path.islink(run_dir):
        raise LandError(f'{run_dir} 不是普通目录', restored=True)
    tag = f'{os.path.basename(run_dir)}-{os.getpid()}'
    merged, backup = os.path.join(parent, f'.new_run-merge-{tag}'), os.path.join(parent, f'.new_run-backup-{tag}')
    kept = []
    try:
        shutil.rmtree(merged, ignore_errors=True)
        shutil.copytree(run_dir, merged, symlinks=True)
        for name in sorted(os.listdir(staging)):
            s, d = os.path.join(staging, name), os.path.join(merged, name)
            if os.path.lexists(d) and name in keep_existing:
                kept.append(name); continue
            if os.path.lexists(d) and (os.path.isdir(s) != os.path.isdir(d) or os.path.islink(d)):
                raise LandError(f'目标目录里的 {name} 与新建内容类型冲突（文件 / 目录），未改动目标', restored=True)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)
        fault('merge')
    except LandError:
        shutil.rmtree(merged, ignore_errors=True); raise
    except Exception as ex:
        shutil.rmtree(merged, ignore_errors=True)
        raise LandError(f'合并失败（目标未改动）：{type(ex).__name__}: {ex}', restored=True)
    try:
        os.rename(run_dir, backup)
    except OSError as ex:
        shutil.rmtree(merged, ignore_errors=True)
        raise LandError(f'备份目标失败（目标未改动）：{ex}', restored=True)
    try:
        fault('swap')
        os.rename(merged, run_dir)
    except Exception as ex:
        restored = True
        try:
            if os.path.lexists(run_dir): shutil.rmtree(run_dir)
            os.rename(backup, run_dir)
        except OSError:
            restored = False
        shutil.rmtree(merged, ignore_errors=True)
        raise LandError(f'换入新目录失败：{type(ex).__name__}: {ex}' + ('；已恢复原目录' if restored else f'；恢复失败，原目录在 {backup}'), restored=restored)
    shutil.rmtree(backup, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    return kept


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('type'); ap.add_argument('run_dir')
    ap.add_argument('--brief'); ap.add_argument('--import', dest='import_src'); ap.add_argument('--from', dest='prev')
    ap.add_argument('--version'); ap.add_argument('--change-summary'); ap.add_argument('--mode', choices=['new', 'import', 'revision'])
    ap.add_argument('--profile', default='account1'); ap.add_argument('--by', default='doc-orchestrator')
    ap.add_argument('--force', action='store_true'); ap.add_argument('--pack')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    if a.type in ol.handoff_types():
        return emit({'ok': False, 'handoff': 'presales-orchestrator', 'message': f'{a.type} 是售前类型：入口是 presales-orchestrator（含计价、条款、确认单），不在这里建目录'}, 4)
    pack, pack_dir = al.find_pack(a.type, a.pack)
    if pack is None:
        avail = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(ol.DOC_SHARED, 'types', '*', 'pack.json')))
        return emit({'ok': False, 'message': f'未知类型 {a.type}', 'available': [t for t in avail if not t.startswith('_') and t not in ol.handoff_types()]}, 2)
    if a.prev and a.import_src:
        return emit({'ok': False, 'message': '--from 与 --import 不能同时用'}, 2)
    if a.prev and a.mode is not None:
        return emit({'ok': False, 'message': f'--from 已经表示改版（mode 恒为 revision），不接受 --mode（给了 {a.mode}）'}, 2)
    if a.import_src and a.mode == 'new':
        return emit({'ok': False, 'message': '--import 的 mode 只能是 import 或 revision'}, 2)
    if not a.import_src and not a.prev and a.mode in ('import', 'revision'):
        return emit({'ok': False, 'message': f'mode={a.mode} 需要 --import 或 --from'}, 2)
    run_dir = os.path.abspath(os.path.expanduser(a.run_dir))
    explicit = {}
    if a.brief:
        try:
            explicit = json.load(open(os.path.expanduser(a.brief), encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as ex:
            return emit({'ok': False, 'message': f'brief 读取失败：{ex}'}, 2)
        if not isinstance(explicit, dict):
            return emit({'ok': False, 'message': 'brief 顶层必须是对象'}, 2)
        # 结构校验走契约层 brief.schema.json（doc_brief 分支，非严格：改版 brief 只写要改的字段也合法；必填缺项下面按 QUESTIONS 追问）
        berr, bwarn = validate.validate_brief(explicit, family='doc_brief', strict=False, pack=pack)
        if berr:
            return emit({'ok': False, 'message': 'brief 不合 brief.schema.json（doc_brief 分支；类型包专属字段放 extra）',
                         'errors': [{'path': p, 'message': m} for p, m in berr]}, 2)
    mode = 'revision' if a.prev else (a.mode or ('import' if a.import_src else 'new'))
    prev, prev_meta, base_version = None, None, None
    if a.prev:
        prev = os.path.abspath(os.path.expanduser(a.prev))
        try:
            prev_meta = json.load(open(os.path.join(prev, 'doc.json'), encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as ex:
            return emit({'ok': False, 'message': f'上一版 doc.json 读取失败：{ex}'}, 2)
        if prev_meta.get('type') != a.type:
            return emit({'ok': False, 'message': f'上一版类型是 {prev_meta.get("type")}，不是 {a.type}'}, 2)
        if os.path.realpath(prev) == os.path.realpath(run_dir):
            return emit({'ok': False, 'message': '改版要建新目录（<类型>-<短名>-v<新版本>），不能原地改'}, 2)
        if not a.version or not a.change_summary:
            return emit({'ok': False, 'message': '改版必须给 --version（大于上一版）与 --change-summary（本版改了什么）'}, 2)
        base_version = prev_meta.get('version')
        try:
            if ol.version_tuple(a.version) <= ol.version_tuple(base_version):
                return emit({'ok': False, 'message': f'新版本 {a.version} 必须大于上一版 {base_version}（1.0 与 1.0.0 等值）'}, 2)
        except ValueError:
            return emit({'ok': False, 'message': f'版本号不合法：{a.version}'}, 2)
        ignored = sorted(REVISION_OWNED & set(explicit))
        doc = json.loads(json.dumps(prev_meta))
        for e in doc.get('related_docs') or []:   # 相对路径按上一版目录解析后，改写为相对新目录
            p = os.path.expanduser(e.get('path', ''))
            if p and not os.path.isabs(p):
                e['path'] = os.path.relpath(os.path.normpath(os.path.join(prev, p)), run_dir)
        for k in DOC_KEYS - REVISION_OWNED:
            if k in explicit: doc[k] = explicit[k]
        old_brief = {}
        if os.path.exists(os.path.join(prev, 'brief.json')):
            try:
                old_brief = json.load(open(os.path.join(prev, 'brief.json'), encoding='utf-8'))
            except (OSError, json.JSONDecodeError):
                old_brief = {}
        inputs = {**(old_brief.get('inputs') or {}), **(explicit.get('inputs') or {})}
        doc['version'] = a.version; doc['date'] = today(); doc['status'] = 'draft'
        doc['revision_history'] = list(doc.get('revision_history') or []) + [
            {'version': 'v' + a.version, 'date': today(), 'author': owner_name(doc.get('owner')), 'summary': a.change_summary}]
        brief_out = {k: v for k, v in doc.items() if k in DOC_KEYS - {'revision_history'}}
        brief_out['inputs'] = inputs
    else:
        ignored = []
        doc = {k: v for k, v in explicit.items() if k in DOC_KEYS}
        inputs = dict(explicit.get('inputs') or {})
        doc.setdefault('version', '0.1'); doc.setdefault('date', today())
        if not doc.get('revision_history') and doc.get('owner'):
            doc['revision_history'] = [{'version': 'v' + doc['version'], 'date': doc['date'], 'author': owner_name(doc['owner']),
                                        'summary': '导入旧稿作为底稿' if a.import_src else '创建'}]
        brief_out = dict(explicit)
    doc['schema_version'] = '1'; doc['type'] = a.type
    doc.setdefault('status', 'draft'); doc.setdefault('language', 'zh-CN')
    doc.setdefault('audience', pack.get('audience')); doc.setdefault('brand', pack.get('brand_profile'))
    missing, warnings, copies = check_brief(pack, doc, inputs, run_dir, prev, explicit.get('inputs') or {})
    if ignored:
        warnings.append(f'改版时 brief 里的 {ignored} 被忽略（由 --version / --change-summary 决定）')
    if missing:
        return emit({'ok': False, 'type': a.type, 'missing': missing,
                     'ask_user': '开工前还缺这些信息（一次性问完，能自己查到的先查）：\n' + '\n'.join(f'{i + 1}. {m["question"]}' for i, m in enumerate(missing))}, 3)
    if os.path.exists(os.path.join(run_dir, 'run-state.json')) and not a.force:
        return emit({'ok': False, 'message': f'{run_dir} 已有 run-state.json（继续推进用 advance.py；改版用 --from 建新目录；确需重建加 --force）'}, 1)
    if os.path.isdir(run_dir) and os.listdir(run_dir) and not a.force:
        return emit({'ok': False, 'message': f'{run_dir} 不是空目录（不覆盖已有文件；确需在此建加 --force，已有正文不会被覆盖）'}, 1)
    parent = os.path.dirname(run_dir)
    os.makedirs(parent, exist_ok=True)
    staging = os.path.join(parent, f'.new_run-{os.path.basename(run_dir)}-{os.getpid()}')
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    src_name = pack.get('source_file', 'doc.md')
    of = pack.get('outline_file', 'outline.md')

    def fail(code, obj):
        shutil.rmtree(staging, ignore_errors=True)
        return emit({**obj, 'ok': False, 'run_dir': run_dir, 'cleaned': True}, code)

    try:
        for d in ['figures', 'data'] + (['sections'] if any(x.startswith('sections/') for x in pack.get('include_allow') or []) else []):
            os.makedirs(os.path.join(staging, d), exist_ok=True)
        files = copy_prev(prev, staging, pack) if prev else []
        for kind, src, dest, pat in copies:
            if kind == 'new':   # 显式新值：先清掉随上一版复制进来、匹配同一 path 的旧副本，再放新文件
                for old in glob.glob(os.path.join(staging, pat)):
                    os.remove(old); files.append(f'-{os.path.relpath(old, staging)}')
            os.makedirs(os.path.dirname(os.path.join(staging, dest)) or staging, exist_ok=True)
            shutil.copy2(src, os.path.join(staging, dest)); files.append(dest)
        json.dump(doc, open(os.path.join(staging, 'doc.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2); files.append('doc.json')
        if brief_out:
            json.dump(brief_out, open(os.path.join(staging, 'brief.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2); files.append('brief.json')
        init = ['init', '--type', a.type, '--mode', mode, '--by', a.by]
        if prev: init += ['--base-doc', prev, '--base-version', str(base_version)]
        elif a.import_src: init += ['--base-doc', a.import_src]
        if a.pack: init += ['--pack', a.pack]
        c, j, tail = ol.run_state(staging, *init)
        if c != 0:
            return fail(1, {'step': 'run_state init', 'detail': j or tail})
        imported = None
        if a.import_src:
            c, o, e = ol.run([ol.PY, ol.IMPORT_DOC, a.import_src, staging, '--profile', a.profile], timeout=300)
            imported = ol.jparse(o)
            if c != 0:
                return fail(1, {'step': 'import_doc', 'exit_code': c, 'detail': (o + e)[-600:]})
            files += ['base/base-doc.md', 'base/base-summary.json']
        if not os.path.exists(os.path.join(staging, src_name)):
            open(os.path.join(staging, src_name), 'w', encoding='utf-8').write(outline_mod.build_doc(pack, doc)); files.append(src_name)
        open(os.path.join(staging, of), 'w', encoding='utf-8').write(outline_mod.build_outline(pack, doc, run_dir))
        if of not in files: files.append(of)
        fault('set-stage')
        c, j, tail = ol.run_state(staging, 'set-stage', 'outline', '--by', a.by, *(['--pack', a.pack] if a.pack else []))
        if c != 0:
            return fail(1, {'step': 'run_state set-stage', 'detail': j or tail})
        for lock in glob.glob(os.path.join(staging, '*.lock')):
            os.remove(lock)
    except Exception as ex:   # 任何异常都不留半成品
        return fail(1, {'step': 'staging', 'error': f'{type(ex).__name__}: {ex}'})
    try:
        kept = land(staging, run_dir, keep_existing={src_name, 'data', 'figures', 'sections'} if a.force else set())
    except LandError as ex:
        shutil.rmtree(staging, ignore_errors=True)
        return emit({'ok': False, 'step': 'land', 'run_dir': run_dir, 'error': str(ex), 'restored': ex.restored}, 1)
    if kept:
        warnings.append(f'--force：目标目录已有 {kept}，保留原文件未覆盖')
    nxt = [f'python3 {os.path.join(ol.HERE, "advance.py")} {run_dir} --run    # 过 D0，停在 D1',
           f'把 {of} 发给用户拍板，逐项 run_state.py decide，确认后：python3 {ol.RUN_STATE} {run_dir} pass-gate --gate D1 --evidence "<用户原话>"']
    if mode == 'revision':
        nxt.insert(0, f'改版：python3 {os.path.join(ol.HERE, "xref_check.py")} {run_dir} 看上下游需要复查的引用')
    return emit({'ok': True, 'run_dir': run_dir, 'type': a.type, 'mode': mode, 'version': doc['version'], 'base_version': base_version,
                 'files': files, 'imported': imported, 'warnings': warnings, 'next': nxt}, 0)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
