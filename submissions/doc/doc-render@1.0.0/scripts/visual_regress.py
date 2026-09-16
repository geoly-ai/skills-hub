#!/usr/bin/env python3
"""PDF 视觉回归：逐页栅格化（pdftoppm）后与基线目录的 PNG 做像素比较，输出每页差异比例与差异热图。
用法：
  visual_regress.py <pdf> --baseline <基线目录> [--out <热图目录>] [--threshold 0.005] [--dpi 60] [--tolerance 32]
  visual_regress.py <pdf> --baseline <基线目录> --update-baseline [--dpi 60]
判定：某像素任一通道差 > tolerance（0–255，吸收抗锯齿与色彩舍入）即计为差异像素；差异比例 = 差异像素 / 页面像素（两页尺寸不同时按
并集画布计，并标 size_changed，尺寸变化一律失败）；比例 > threshold（默认 0.5%）该页失败。页数不同时，多出或缺少的页比例记 1.0 且失败。
单个字符替换（不引起重排）通常只有几十到几百个差异像素，低于 0.5% 阈值：结果里该页 status 为 diff（有差异但未超阈值），
diff_pixels 与 bbox 照常给出，调用方要更严可调低 --threshold。
基线目录：page-001.png …、baseline.json {schema_version, dpi, pages, page_sizes, pdf_name, pdf_sha256, tolerance, created_at, tool, env{pdftoppm, pillow}}。
比较时 dpi 以基线为准（--dpi 与基线不同给 warning）。--update-baseline 写入 PNG 与 baseline.json，并删除多余的旧页。
热图（只写有差异的页）：<out>/page-NNN.diff.png，基线灰度淡化作底，差异像素标红，尺寸不同的并集区域标黄。
输出 JSON：{ok, pdf, baseline, dpi, threshold, tolerance, page_count{pdf, baseline, changed}, pages[{page, status: same / diff / fail / added / removed,
  diff_pixels, total_pixels, diff_ratio, size_changed, size{pdf, baseline}, bbox, heatmap}], failed_pages[], warnings[]}；--update-baseline 时 {ok, updated, pages, removed_files}。
退出码：0 通过（或基线已更新）；3 有失败页或页数变化；2 用法错误、依赖缺失、基线缺失或损坏、PDF 栅格化失败。
依赖：poppler 的 pdftoppm；Pillow（doc-render/.venv，见 requirements.txt）。当前解释器缺 Pillow 时自动切到 doc-render/.venv 重新执行。"""
import argparse, datetime, glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VENV_PY = os.path.join(ROOT, '.venv', 'bin', 'python')
TOOL = {'name': 'doc-render/visual_regress', 'version': '1.0.0'}
DEFAULT_DPI, DEFAULT_THRESHOLD, DEFAULT_TOLERANCE = 60, 0.005, 32
PAGE_RE = re.compile(r'^page-(\d{3,})\.png$')


def emit(obj, code):
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def ensure_pillow():
    try:
        import PIL  # noqa: F401
        return True
    except ImportError:
        # venv 的 python 通常是指向系统解释器的符号链接，不能用 realpath 判断是否已在 venv 里；看 sys.prefix
        in_venv = os.path.realpath(sys.prefix) == os.path.realpath(os.path.join(ROOT, '.venv'))
        if os.path.exists(VENV_PY) and not in_venv and not os.environ.get('DOC_VISUAL_REEXEC'):
            os.environ['DOC_VISUAL_REEXEC'] = '1'
            os.execv(VENV_PY, [VENV_PY, os.path.abspath(__file__)] + sys.argv[1:])
        return False


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def rasterize(pdf, dpi, work):
    """pdftoppm 逐页转 PNG，返回按页序排列的文件路径。"""
    if not shutil.which('pdftoppm'):
        raise RuntimeError('找不到 pdftoppm（poppler）')
    prefix = os.path.join(work, 'p')
    r = subprocess.run(['pdftoppm', '-r', str(dpi), '-png', pdf, prefix], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f'pdftoppm 失败（退出码 {r.returncode}）：{r.stderr.strip()[-300:]}')
    files = glob.glob(prefix + '-*.png')
    files.sort(key=lambda p: int(re.search(r'-(\d+)\.png$', p).group(1)))
    if not files:
        raise RuntimeError('pdftoppm 没有输出任何页面（PDF 为空或已损坏）')
    return files


def load_rgb(path):
    from PIL import Image
    with Image.open(path) as im:
        return im.convert('RGB')


def pad(im, size):
    from PIL import Image
    if im.size == size:
        return im
    canvas = Image.new('RGB', size, (255, 255, 255))
    canvas.paste(im, (0, 0))
    return canvas


def compare_images(cur, base, tolerance):
    """返回 (diff_pixels, total_pixels, bbox, mask)。mask 为 L 模式，差异像素 255。"""
    from PIL import ImageChops
    size = (max(cur.size[0], base.size[0]), max(cur.size[1], base.size[1]))
    a, b = pad(cur, size), pad(base, size)
    diff = ImageChops.difference(a, b)
    r, g, bl = diff.split()
    mx = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    mask = mx.point(lambda v: 255 if v > tolerance else 0)
    n = mask.histogram()[255]
    bbox = mask.getbbox() if n else None
    return n, size[0] * size[1], (list(bbox) if bbox else None), mask


def heatmap(cur, base, mask, path):
    from PIL import Image, ImageOps
    size = mask.size
    under = ImageOps.grayscale(pad(base if base is not None else cur, size))
    under = under.point(lambda v: 160 + v * 95 // 255).convert('RGB')
    red = Image.new('RGB', size, (230, 30, 30))
    out = Image.composite(red, under, mask)
    if base is not None and cur.size != base.size:
        # 并集画布中只属于一方的区域描黄边，提示尺寸变化
        yellow = Image.new('RGB', size, (250, 200, 0))
        only = Image.new('L', size, 0)
        w0, h0 = min(cur.size[0], base.size[0]), min(cur.size[1], base.size[1])
        only.paste(90, (w0, 0, size[0], size[1])); only.paste(90, (0, h0, size[0], size[1]))
        out = Image.composite(yellow, out, only.point(lambda v: 255 if v else 0)) if only.getbbox() else out
        out = Image.composite(red, out, mask)
    out.save(path)


def environment():
    """基线的栅格化环境（poppler、Pillow 版本变化会改变像素；PDF 的 Chrome 版本见 render.json renderer.chrome）。"""
    import PIL
    try:
        r = subprocess.run(['pdftoppm', '-v'], capture_output=True, text=True, timeout=30)
        pv = next((l.strip() for l in (r.stderr + r.stdout).splitlines() if 'version' in l.lower()), None)
    except (OSError, subprocess.TimeoutExpired):
        pv = None
    return {'pdftoppm': pv, 'pillow': PIL.__version__}


def read_baseline(bdir):
    meta_path = os.path.join(bdir, 'baseline.json')
    if not os.path.isfile(meta_path):
        raise FileNotFoundError(f'基线不存在：{meta_path}（先用 --update-baseline 建立）')
    try:
        meta = json.load(open(meta_path, encoding='utf-8'))
    except (OSError, ValueError) as ex:
        raise ValueError(f'baseline.json 读取失败：{ex}')
    pages = meta.get('pages')
    if not isinstance(pages, int) or pages < 1 or not isinstance(meta.get('dpi'), int):
        raise ValueError('baseline.json 缺 pages 或 dpi')
    files = [os.path.join(bdir, f'page-{i:03d}.png') for i in range(1, pages + 1)]
    missing = [os.path.basename(f) for f in files if not os.path.isfile(f)]
    if missing:
        raise ValueError(f'基线缺页面文件：{"、".join(missing[:5])}')
    return meta, files


def update_baseline(pdf, bdir, dpi, tolerance):
    work = tempfile.mkdtemp(prefix='visual-regress-')
    try:
        pages = rasterize(pdf, dpi, work)
        os.makedirs(bdir, exist_ok=True)
        sizes = []
        for i, p in enumerate(pages, 1):
            dst = os.path.join(bdir, f'page-{i:03d}.png')
            shutil.copyfile(p, dst + '.tmp'); os.replace(dst + '.tmp', dst)
            sizes.append(list(load_rgb(dst).size))
        removed = []
        for f in sorted(os.listdir(bdir)):
            m = PAGE_RE.match(f)
            if m and int(m.group(1)) > len(pages):
                os.remove(os.path.join(bdir, f)); removed.append(f)
        meta = {'schema_version': '1', 'dpi': dpi, 'pages': len(pages), 'page_sizes': sizes, 'pdf_name': os.path.basename(pdf),
                'pdf_sha256': sha256_file(pdf), 'tolerance': tolerance, 'created_at': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'tool': TOOL,
                'env': environment()}
        tmp = os.path.join(bdir, 'baseline.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        os.replace(tmp, os.path.join(bdir, 'baseline.json'))
        return {'ok': True, 'updated': True, 'pdf': pdf, 'baseline': bdir, 'dpi': dpi, 'pages': len(pages), 'removed_files': removed}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def compare(pdf, bdir, out_dir, dpi_arg, threshold, tolerance):
    meta, bfiles = read_baseline(bdir)
    warnings = []
    dpi = meta['dpi']
    if dpi_arg is not None and dpi_arg != dpi:
        warnings.append(f'--dpi {dpi_arg} 与基线 dpi {dpi} 不同，按基线 dpi 栅格化')
    if meta.get('pdf_sha256') and meta['pdf_sha256'] == sha256_file(pdf):
        warnings.append('PDF 与建立基线时的文件字节完全相同')
    work = tempfile.mkdtemp(prefix='visual-regress-')
    try:
        cfiles = rasterize(pdf, dpi, work)
        os.makedirs(out_dir, exist_ok=True)
        for f in glob.glob(os.path.join(out_dir, 'page-*.diff.png')):
            os.remove(f)   # 旧热图不留，避免把上一次的差异误当本次结果
        pages, failed = [], []
        for i in range(1, max(len(cfiles), len(bfiles)) + 1):
            cur = load_rgb(cfiles[i - 1]) if i <= len(cfiles) else None
            base = load_rgb(bfiles[i - 1]) if i <= len(bfiles) else None
            item = {'page': i, 'size': {'pdf': list(cur.size) if cur else None, 'baseline': list(base.size) if base else None}, 'heatmap': None}
            if cur is None or base is None:
                only = cur or base
                item.update(status='added' if base is None else 'removed', diff_pixels=only.size[0] * only.size[1], total_pixels=only.size[0] * only.size[1],
                            diff_ratio=1.0, size_changed=False, bbox=[0, 0, only.size[0], only.size[1]])
                failed.append(i)
            else:
                n, total, bbox, mask = compare_images(cur, base, tolerance)
                ratio = n / total if total else 0.0
                size_changed = cur.size != base.size
                # 尺寸变化优先判失败：新增区域即使全白（差异像素为 0）也不能算相同
                status = 'fail' if size_changed else ('same' if n == 0 else ('fail' if ratio > threshold else 'diff'))
                item.update(status=status, diff_pixels=n, total_pixels=total, diff_ratio=round(ratio, 6), size_changed=size_changed, bbox=bbox)
                if n or size_changed:
                    hp = os.path.join(out_dir, f'page-{i:03d}.diff.png')
                    heatmap(cur, base, mask, hp)
                    item['heatmap'] = hp
                if status == 'fail':
                    failed.append(i)
            pages.append(item)
        pc = {'pdf': len(cfiles), 'baseline': len(bfiles), 'changed': len(cfiles) != len(bfiles)}
        return {'ok': not failed and not pc['changed'], 'pdf': pdf, 'baseline': bdir, 'dpi': dpi, 'threshold': threshold, 'tolerance': tolerance,
                'page_count': pc, 'pages': pages, 'failed_pages': failed, 'heatmap_dir': out_dir, 'warnings': warnings}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    ap = argparse.ArgumentParser(description='PDF 视觉回归（逐页像素比较）')
    ap.add_argument('pdf'); ap.add_argument('--baseline', required=True); ap.add_argument('--out')
    ap.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD); ap.add_argument('--dpi', type=int)
    ap.add_argument('--tolerance', type=int, default=DEFAULT_TOLERANCE); ap.add_argument('--update-baseline', action='store_true')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    pdf = os.path.abspath(os.path.expanduser(a.pdf)); bdir = os.path.abspath(os.path.expanduser(a.baseline))
    if not os.path.isfile(pdf):
        return emit({'ok': False, 'error': f'PDF 不存在：{pdf}'}, 2)
    if not (0 <= a.threshold < 1) or not (0 <= a.tolerance <= 255) or (a.dpi is not None and not (10 <= a.dpi <= 600)):
        return emit({'ok': False, 'error': '参数越界：threshold 取 [0,1)，tolerance 取 0–255，dpi 取 10–600'}, 2)
    if not ensure_pillow():
        return emit({'ok': False, 'error': f'缺少 Pillow：{ROOT}/.venv 未安装（python3 -m venv .venv && .venv/bin/pip install -r requirements.txt）'}, 2)
    try:
        if a.update_baseline:
            return emit(update_baseline(pdf, bdir, a.dpi or DEFAULT_DPI, a.tolerance), 0)
        out_dir = os.path.abspath(os.path.expanduser(a.out)) if a.out else os.path.join(os.path.dirname(pdf), 'visual-diff')
        res = compare(pdf, bdir, out_dir, a.dpi, a.threshold, a.tolerance)
        return emit(res, 0 if res['ok'] else 3)
    except (FileNotFoundError, ValueError, RuntimeError, OSError) as ex:
        return emit({'ok': False, 'error': str(ex)}, 2)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
