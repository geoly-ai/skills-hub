"""doc-author 共用函数：找类型包、读元数据、解析骨架（按 mode）、解析正文。只读，不写运行目录。"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.dirname(os.path.dirname(HERE))
DOC_SHARED = os.path.join(SKILLS, 'doc-shared')
sys.path.insert(0, os.path.join(DOC_SHARED, 'scripts'))
import validate  # noqa: E402
import docmark_parse as dp  # noqa: E402

PLACEHOLDER_RE = re.compile(r'【待(?:写|补|定)[^】]*】')
# 模板式占位 {产品名称}、{N}、{链接}：排除 {#锚点}、{{…}}（L1 另报）、空花括号与超过 40 字的内容
TEMPLATE_PH_RE = re.compile(r'(?<![{\\$])\{(?![#{\s])[^{}\n]{1,40}\}(?!\})')
TODO_RE = re.compile(r'(?<![A-Za-z])(TODO|TBD|FIXME|XXX)(?![A-Za-z])')
HINT_RE = re.compile(r'<!--\s*写作提示')


def find_pack(doc_type, pack_arg=None):
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
            return json.load(open(c, encoding='utf-8')), os.path.dirname(os.path.abspath(c))
    return None, None


def load_meta(run_dir, pack=None):
    name = (pack or {}).get('meta_file', 'doc.json')
    p = os.path.join(run_dir, name)
    return (json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}), name


def get_field(d, dotted):
    for part in (dotted or '').split('.'):
        if not isinstance(d, dict) or part not in d:
            return None
        d = d[part]
    return d


def skeleton_for(pack, meta, run_dir=None, meta_file=None):
    """按元数据里的 mode 取打完补丁的骨架；跳过将来标 engine_generated 的项。
    给 run_dir 时 mode 取值规则与 doc-qa 一致（validate.resolve_mode → mode_meta：字段路径不全时回退运行目录 brief.json）。"""
    mode = validate.resolve_mode(pack, meta, run_dir=run_dir, meta_file=meta_file)
    sk = validate.resolve_skeleton(pack, mode)   # mode 值无法识别时抛 ValueError（ModeError / KeyError），由调用方报错退出
    return [s for s in sk if not s.get('engine_generated')]


def parse(run_dir, pack):
    return dp.parse_file(run_dir, pack.get('source_file', 'doc.md'), pack=pack)


# 遮蔽函数已上移 doc-shared/scripts/code_scan.py（2026-09-15 W3-H，与 xref_check、trace_matrix 同一口径），这里 re-export，fill_check 与旧调用方不变。
from code_scan import masked_lines, comment_mask, code_mask  # noqa: E402,F401
