"""svgkit 模板注册表：名称 → 模块（每个模块提供 render(spec) -> svgkit.S 与 SCHEMA 说明）。"""
import importlib

NAMES = {
    'layered-arch': 'layered_arch',
    'swimlane': 'swimlane',
    'compare-matrix': 'compare_matrix',
    'milestone': 'milestone',
    'coverage-heatmap': 'coverage_heatmap',
    'phases': 'phases',
    'funnel': 'funnel',
    'sitemap': 'sitemap',
}


def get(name):
    if name not in NAMES:
        raise KeyError(f'未知模板 {name}；可用：{", ".join(sorted(NAMES))}')
    return importlib.import_module(f'templates.{NAMES[name]}')


def template_name(spec):
    """spec 用 "template" 选模板；兼容类型包草案里的 "kind"。"""
    return spec.get('template') or spec.get('kind')
