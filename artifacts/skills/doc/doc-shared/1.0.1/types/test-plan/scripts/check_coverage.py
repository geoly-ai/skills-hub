#!/usr/bin/env python3
"""test-plan 包 D2 门检查：需求覆盖矩阵无未覆盖的 P0/P1 需求。

读 <运行目录>/data/coverage.csv（列：REQ编号、模块、优先级、关联用例数、覆盖状态），
优先级为 P0 或 P1 且覆盖状态不是「已覆盖」的行视为未覆盖，存在即门不通过。

用法：check_coverage.py <运行目录>
退出码：0 全部覆盖；1 存在未覆盖的 P0/P1 需求；2 用法或读取错误。

已知简化（落位时记入 types-landing-issues.md）：本脚本只读本包自己的 data/coverage.csv，
不跨读 prd 的 data/requirements.csv 与 test-cases 的 data/cases.csv 做交叉重算；
coverage.csv 本身假定由写作者或上游脚本据两者生成并保持一致。
"""
import csv, os, sys


def main(argv):
    if len(argv) != 1:
        print("用法：check_coverage.py <运行目录>", file=sys.stderr)
        return 2
    run_dir = argv[0]
    path = os.path.join(run_dir, "data", "coverage.csv")
    if not os.path.exists(path):
        print(f"缺少 {path}", file=sys.stderr)
        return 2
    uncovered = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pri = (row.get("优先级") or "").strip()
            status = (row.get("覆盖状态") or "").strip()
            if pri in ("P0", "P1") and status != "已覆盖":
                uncovered.append(f"{row.get('REQ编号')}（{pri}，覆盖状态：{status or '空'}）")
    if uncovered:
        print("以下 P0/P1 需求未覆盖：")
        for u in uncovered:
            print(f"  - {u}")
        return 1
    print("需求覆盖矩阵：全部 P0/P1 需求已覆盖")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
