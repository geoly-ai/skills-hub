"""doc-orchestrator 共用：路径、子进程、run_state 调用、类型包与售前判定。"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ORCH = os.path.dirname(HERE)
SKILLS = os.path.dirname(ORCH)
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
RUN_STATE = os.path.join(DOC_SHARED, 'scripts', 'run_state.py')
IMPORT_DOC = os.path.join(DOC_SHARED, 'scripts', 'import_doc.py')
# 引擎入口；环境变量只供自测替换（DOC_FIGURES_SCRIPT、DOC_RENDER_SCRIPT、DOC_QA_SCRIPT）
FIG_BUILD = os.environ.get('DOC_FIGURES_SCRIPT') or os.path.join(SKILLS, 'doc-figures', 'scripts', 'build.py')
RENDER = os.environ.get('DOC_RENDER_SCRIPT') or os.path.join(SKILLS, 'doc-render', 'scripts', 'render.py')
QA = os.environ.get('DOC_QA_SCRIPT') or os.path.join(SKILLS, 'doc-qa', 'scripts', 'qa.py')
XREF = os.environ.get('DOC_XREF_SCRIPT') or os.path.join(HERE, 'xref_check.py')
AUTHOR = os.path.join(SKILLS, 'doc-author', 'scripts')
PY = sys.executable
sys.path.insert(0, AUTHOR)
sys.path.insert(0, HERE)
import authorlib as al  # noqa: E402


def publish_script():
    return os.environ.get('DOC_PUBLISH_SCRIPT') or os.path.join(SKILLS, 'doc-publish', 'scripts', 'publish.py')


def handoff_types():
    cfg = json.load(open(os.path.join(ORCH, 'references', 'type-triggers.json'), encoding='utf-8'))
    return set(cfg.get('handoff', {}).get('presales-orchestrator', {}).get('types', []))


def run(argv, cwd=None, timeout=1800):
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as ex:
        return 124, ex.stdout or '', f'超时 {timeout}s'


def jparse(s):
    s = (s or '').strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        i = s.find('{')
        try:
            return json.loads(s[i:]) if i >= 0 else {}
        except json.JSONDecodeError:
            return {}


def run_state(run_dir, *args):
    c, o, e = run([PY, RUN_STATE, run_dir, *args], timeout=900)
    return c, jparse(o), (o + e)[-600:]


import versions as _versions  # noqa: E402  doc-shared/scripts/versions.py（authorlib 已加入 sys.path）

same_version = _versions.same_version   # 1.0 = 1.0.0，与 related.py 同一实现


def version_tuple(v):
    return _versions.parse(v)


def brief_input_gaps(pack, run_dir, meta):
    """D0 前复查，与 run_state D0 同一口径。
    元数据文件为 doc.json（doc-* 类型）：brief.json 存在时按 brief.schema.json doc_brief 严格校验；文本型必需输入读 brief.json inputs。
    元数据文件不是 doc.json（售前等业务线，brief.json 本身就是元数据）：不套 doc_brief、不读 inputs，文本型必需输入交业务线自查；
    两种情况都照查 doc_field（读元数据文件）与 path（运行目录里的文件）。返回缺项描述列表。"""
    import glob as _g
    meta_name = (pack or {}).get('meta_file', 'doc.json')
    gaps = []
    for inp in (pack or {}).get('inputs') or []:
        if not inp.get('required'): continue
        if inp.get('doc_field'):
            if al.get_field(meta, inp['doc_field']) in (None, '', [], {}):
                gaps.append(f'{inp["id"]}（{inp.get("desc", "")}；{meta_name} {inp["doc_field"]} 为空）')
        elif inp.get('path') and not _g.glob(os.path.join(run_dir, inp['path'])):
            gaps.append(f'{inp["id"]}（{inp.get("desc", "")}；运行目录缺 {inp["path"]}）')
    if meta_name != 'doc.json':
        return gaps
    bp = os.path.join(run_dir, 'brief.json')
    text_inputs = [inp for inp in (pack or {}).get('inputs') or [] if inp.get('required') and not inp.get('path') and not inp.get('doc_field')]
    if not os.path.exists(bp):
        return gaps + ([f'缺少 brief.json（文本型必需输入：' + '、'.join(i['id'] for i in text_inputs) + '）'] if text_inputs else [])
    try:
        brief = json.load(open(bp, encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as ex:
        return gaps + [f'brief.json 读取失败：{ex}']
    if not isinstance(brief, dict):
        return gaps + [f'brief.json 顶层必须是对象（现在是 {type(brief).__name__}）']
    if 'inputs' in brief and not isinstance(brief['inputs'], dict):
        return gaps + [f'brief.json inputs 必须是对象（现在是 {type(brief["inputs"]).__name__}）']
    import validate
    berr, _ = validate.validate_brief(brief, family='doc_brief', strict=True, pack=pack)   # 与 run_state D0 同一口径（严格模式）
    if berr:
        return gaps + [f'brief.json 不合 brief.schema.json：{p} {m}' for p, m in berr[:5]]
    for inp in text_inputs:
        v = (brief.get('inputs') or {}).get(inp['id'])
        if v is None or (isinstance(v, str) and not v.strip()) or v in ([], {}):
            gaps.append(f'{inp["id"]}（{inp.get("desc", "")}）')
    return gaps

