"""阶梯式排布（phases、milestone 共用）：线性序列超过每行容量时分多行，行尾经行间通道连到下一行行首；回环只允许在同一行内。"""
import math
from svgkit import SpecError


def split_rows(n, rows='auto', per_row_max=4):
    """返回每行的下标列表。rows="auto"：≤4 一行，5–8 两行，9–12 三行，以此类推（每行 ≤ per_row_max）。"""
    if n == 0:
        return []
    if rows in (None, 'auto'):
        r = max(1, math.ceil(n / per_row_max))
    else:
        r = int(rows)
        if r < 1:
            raise SpecError('rows 必须 ≥ 1')
    r = min(r, n)
    per = math.ceil(n / r)
    return [list(range(i, min(i + per, n))) for i in range(0, n, per)]


def row_of(rows, idx):
    for ri, r in enumerate(rows):
        if idx in r:
            return ri
    raise SpecError(f'下标 {idx} 越界')


def check_loops(rows, loops, resolve):
    """loops = [{"from", "to", "label"}]；resolve 把 id 或下标转为下标。跨行回环报错（跨行回环会让上下行顺序看起来颠倒）。"""
    out = []
    for lp in loops or []:
        a, b = resolve(lp.get('from')), resolve(lp.get('to'))
        if row_of(rows, a) != row_of(rows, b):
            raise SpecError(f'回环 {lp.get("from")} → {lp.get("to")} 跨行：回环边必须画在同一行内（可调整 rows 或拆图）')
        out.append((a, b, lp.get('label', '')))
    return out
