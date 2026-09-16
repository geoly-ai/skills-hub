"""模板共用：画布建立、标题、图例、文字换行度量。"""
import svgkit as k
from svgkit import SpecError, FPX, MARGIN

ROLE_LABELS = {'generic_layer': '通用层', 'business_line': '业务线', 'category': '分类', 'deliverable': '交付物', 'neutral': '中性', 'placeholder': '待扩展'}


def new_canvas(spec, height=None):
    display = spec.get('display') or {}
    w = int(spec.get('canvas_width') or k.canvas_width_for(display))
    ratio = float(display.get('width_ratio', 1.0))
    mm = k.LANDSCAPE_MM if display.get('landscape') else k.CONTENT_MM
    s = k.S(w, height, spec.get('title', ''), spec.get('subtitle', ''), width_ratio=ratio, content_mm=mm)
    s.font_scale = float(spec.get('font_scale', 1.0))
    return s


def fs(s, key):
    """按 font_scale 取字号（font_scale < 1 只用于演示字号不足的反例，自检会报 font_too_small）。"""
    return round(FPX[key] * getattr(s, 'font_scale', 1.0), 2)


def as_lines(v):
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    return [str(x) for x in v]


def need(spec, key, typ=None, where='spec'):
    if key not in spec:
        raise SpecError(f'{where} 缺少字段 {key}')
    if typ and not isinstance(spec[key], typ):
        raise SpecError(f'{where}.{key} 类型应为 {typ.__name__ if isinstance(typ, type) else typ}')
    return spec[key]


def wrap_lines(s, texts, size, width, bold=False, where='', slack=6):
    """多段文字各自换行后拼接；单词比宽度还宽时登记 word_too_long。"""
    out = []
    for t in texts:
        lines, ov = k.wrap_info(t, size, width, bold, slack=slack)
        if ov:
            s.issues.append(k.issue('word_too_long', f'{where}单词或数字串宽于可用宽度 {width:.0f}px，无法换行（不截断），会越界', t))
        out += lines
    return out


def draw_legend(s, spec, used, y):
    """used = [(color, dashed, role)]。spec.legend: "auto"（默认）| false | [{color|role, label, dashed, kind}]。返回高度。"""
    lg = spec.get('legend', 'auto')
    if lg is False or lg == 'none':
        return 0
    style = spec.get('legend_style', 'swatch')
    items = []
    if isinstance(lg, list):
        for it in lg:
            color = k.role_color(it.get('role') or it.get('color') or 'neutral')
            items.append({'color': color, 'dashed': bool(it.get('dashed')), 'label': it['label'], 'kind': it.get('kind', 'box')})
    else:
        seen = set()
        for color, dashed, role in used:
            if not role or role not in ROLE_LABELS:
                continue
            key = (role, dashed)
            if key in seen:
                continue
            seen.add(key)
            label = ROLE_LABELS[role] + ('（虚线：保留原样或待扩展）' if dashed and role != 'placeholder' else '')
            items.append({'color': color, 'dashed': dashed, 'label': label})
        if len(items) < 2:
            return 0
    if not items:
        return 0
    return s.legend(items, y, style=style)
