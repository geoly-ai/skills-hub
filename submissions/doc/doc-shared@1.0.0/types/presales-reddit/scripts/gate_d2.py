#!/usr/bin/env python3
"""presales-reddit 包 D2 门：转调 presales-pricing/scripts/price_reddit.py，退出码透传（不改动 price_reddit.py）。

三段检查，全部在临时目录输出（不改运行目录：D2 是检查，不能让 pricing/ 与 internal-cost.json 在质检之后变动）：
  1. capacity（必需）：读 <运行目录>/capacity-input.json（字段与 capacity 子命令参数一一对应：
     subreddits、weeks、posts、comments、official_posts、accounts、official_accounts，model 可选），缺文件即退出 2。
  2. rfp：<运行目录>/pricing/rfp-spec.json 存在时跑 rfp --spec（RFP 定制单价与对赌）。
  3. package：pricing/reddit-packages.md 存在时跑 package（标准套餐标价不低于底价）。
  rfp-spec.json 与 reddit-packages.md 都没有时退出 2：只过产能核查不算 D2（报价体裁没定，问用户）。
price_reddit.py 退出码：0 通过；1 输入错误；2 标价低于底价或产能不足；3 产能无法判定。
本脚本退出码：按 capacity → rfp → package 顺序取第一个非 0 的退出码；全部为 0 时 0；2 也用于缺 capacity-input.json 等用法或输入错误。
stdout 最后一行是 JSON 汇总：{"ok", "steps": [{"step", "exit_code", "argv"}]}。
用法：gate_d2.py <运行目录>
"""
import json, os, shutil, subprocess, sys, tempfile

PRICE_REDDIT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "presales-pricing", "scripts", "price_reddit.py"))


def main(argv):
    if len(argv) != 1:
        print("用法：gate_d2.py <运行目录>", file=sys.stderr)
        return 2
    run_dir = os.path.abspath(argv[0])
    cfg_path = os.path.join(run_dir, "capacity-input.json")
    if not os.path.exists(cfg_path):
        print(f"缺少 {cfg_path}", file=sys.stderr)
        return 2
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as ex:
        print(f"capacity-input.json 读不出：{ex}", file=sys.stderr)
        return 2
    if not isinstance(cfg, dict):
        print("capacity-input.json 顶层不是对象", file=sys.stderr)
        return 2

    tmp = tempfile.mkdtemp(prefix="presales-reddit-d2-")
    out = os.path.join(tmp, "pricing")
    os.makedirs(out)
    steps = []
    try:
        cmd = [sys.executable, PRICE_REDDIT, "capacity"]
        key_flags = [
            ("model", "--model"), ("subreddits", "--subreddits"), ("weeks", "--weeks"),
            ("posts", "--posts"), ("comments", "--comments"),
            ("official_posts", "--official-posts"), ("accounts", "--accounts"),
            ("official_accounts", "--official-accounts"),
        ]
        for key, flag in key_flags:
            if key in cfg and cfg[key] is not None:
                cmd += [flag, str(cfg[key])]
        steps.append(("capacity", cmd + ["--out", out]))
        model = ["--model", str(cfg["model"])] if cfg.get("model") else []
        spec = os.path.join(run_dir, "pricing", "rfp-spec.json")
        if os.path.exists(spec):
            steps.append(("rfp", [sys.executable, PRICE_REDDIT, "rfp", "--spec", spec, "--out", out] + model))
        if os.path.exists(os.path.join(run_dir, "pricing", "reddit-packages.md")):
            steps.append(("package", [sys.executable, PRICE_REDDIT, "package", "--out", out] + model))
        if len(steps) == 1:
            print("pricing/ 下既没有 reddit-packages.md（标准套餐）也没有 rfp-spec.json（RFP 定制）：只过产能核查不算 D2，先定报价体裁并跑 price_reddit.py", file=sys.stderr)
            print(json.dumps({"ok": False, "steps": [], "message": "缺报价产物"}, ensure_ascii=False))
            return 2
        results, first_bad = [], 0
        for name, argv_ in steps:
            proc = subprocess.run(argv_, capture_output=True, text=True, cwd=tmp)
            sys.stdout.write(proc.stdout)
            sys.stderr.write(proc.stderr)
            results.append({"step": name, "exit_code": proc.returncode, "argv": [a.replace(tmp, "<tmp>") for a in argv_]})
            if proc.returncode and not first_bad:
                first_bad = proc.returncode
        print(json.dumps({"ok": first_bad == 0, "steps": results}, ensure_ascii=False))
        return first_bad
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
