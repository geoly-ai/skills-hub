#!/usr/bin/env python3
"""读 run-state 与产物新鲜度，判断当前该做哪一步；--run 时执行本地脚本步骤，直到遇到必须由人、写作者或 Codex 处理的步骤。
用法：advance.py <运行目录> [--run] [--max-steps 12] [--pack 类型包目录] [--publish-offline]
判定顺序（每次都从头判，不信任 stage 字段）：
  D0 未过            → run_state pass-gate D0                          （脚本，可执行）
  D1 未过            → 用户确认 outline.md 后 pass-gate D1 --evidence   （人，阻塞）
  D3 通过后又改了源文件 → reset-gate D3（在正文与交叉引用检查之前判，改源立即失效；有 source_manifest 时按内容比对、
                       lark_folder 写回不算，没有时严格比较修改时间）（脚本，可执行）
  正文未写完          → fill_check 阻塞项（缺必备章、必备章为空、占位符）   （写作者，阻塞）
  交叉引用悬空        → xref_check 阻塞项（退出码非 0 / 3 为引擎故障，阻塞）  （写作者 / 主代理）
  D2 未过            → 类型包 D2 为 null：skip-gate；有命令：pass-gate --run（脚本，可执行；失败阻塞）
  图过期             → doc-figures build.py                              （脚本，可执行；必改阻塞）
  渲染过期           → doc-render render.py                             （脚本，可执行；版式必改阻塞）
  质检过期           → doc-qa qa.py                                      （脚本，可执行；must_fix 阻塞）
  D3 未过            → Codex 找茬 + 证伪两轮，pass-gate D3 --evidence    （Codex / 主代理，阻塞）
  D4 未过            → doc-publish publish.py 预检（默认 dry-run，可执行；--publish-offline 时加 --offline 不调 lark-cli），
                       然后等用户看 PDF 确认 → 主代理执行 publish.py --apply --evidence "<原话>"（doc-publish 在写飞书前自己写 D4）（人，阻塞）
  D4 已过、未发布     → 同上 publish.py --apply（advance 永不执行 --apply）
  已发布             → set-stage done
「过期」按 doc-shared run_state.newest_source_mtime（out/、base/、qa-result.json、qa-report.md、run-state.json、published.json 不算源文件）。
advance 自己只往 out/ 写（out/advance-last.json、out/publish-dry-run.json），不会让 D3 判为「质检后又改过源文件」。
发布预检记录绑定 doc.json 版本与 render.json、qa-result.json 的 source_sha256，任一变化即重跑；published.json 须版本一致、problems 为空、PDF 为当前产物。
D0 前复查 brief.json inputs（类型包 required inputs）；outline.md 拍板项数多于 run-state decisions 时提示；D3 已过但 qa-report.md 人工区块无 Codex 记录时提示。
doc-publish 路径：环境变量 DOC_PUBLISH_SCRIPT，缺省 <doc-publish>/scripts/publish.py（经 skills 根相对解析，见 orchlib.publish_script）。
输出 JSON：{run_dir, type, version, mode, stage, gates, step, actor, runnable, next_command, argv, blocking_reasons[], warnings[], executed[], artifacts}
退出码：0 无阻塞（有可执行的下一步或已完成）；3 阻塞；1 执行的步骤故障；2 用法错误。"""
import argparse, datetime, glob, json, os, shlex, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orchlib as ol  # noqa: E402
from orchlib import al  # noqa: E402
import run_state as rs  # noqa: E402

DONE = {'passed', 'skipped', 'waived'}
FIG_SRC = ('*.mmd', '*.dot', '*.fig.json', '*.svg')


def mtime(p):
    return os.path.getmtime(p) if os.path.exists(p) else None


def load_json(p):
    try:
        return json.load(open(p, encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None


def svg_for(src):
    return src[:-len('.fig.json')] + '.svg' if src.endswith('.fig.json') else src.rsplit('.', 1)[0] + '.svg'


def figures_state(rd):
    found = sorted(p for pat in FIG_SRC for p in glob.glob(os.path.join(rd, 'figures', pat)) if not p.endswith('.resolved.mmd'))
    gen = {svg_for(p) for p in found if not p.endswith('.svg')}
    srcs = [p for p in found if p not in gen]   # 成品 .svg 本身是图源；由 .mmd/.dot/.fig.json 生成的 .svg 不是
    if not srcs:
        return {'sources': 0, 'stale': False, 'must_fix': 0, 'why': ''}
    rv = os.path.join(rd, 'figures', 'review.json')
    review = load_json(rv) or {}
    entries = {}
    for f in review.get('figures') or []:
        for k in (f.get('source'), f.get('file')):
            if k: entries[k] = f
    why = []
    for s in srcs:
        rel = os.path.relpath(s, rd)
        svg = svg_for(s)
        png = svg[:-4] + '.png'
        ent = entries.get(rel) or entries.get(os.path.relpath(svg, rd))
        if not os.path.exists(svg): why.append(f'{rel} 未构建')
        elif mtime(s) > mtime(svg): why.append(f'{rel} 比 SVG 新')
        elif not os.path.exists(png): why.append(f'{rel} 缺 PNG 预览')
        elif not ent or not isinstance(ent.get('machine'), dict): why.append(f'{rel} 无 review.json machine 记录')
        elif (mtime(rv) or 0) < mtime(s): why.append(f'review.json 比 {rel} 旧')
    must = sum(int((f.get('machine') or {}).get('must_fix') or 0) for f in review.get('figures') or [])
    issues = [f'{f.get("file")}：{i.get("message")}' for f in review.get('figures') or [] for i in (f.get('machine') or {}).get('issues') or [] if i.get('severity') == '必改']
    return {'sources': len(srcs), 'stale': bool(why), 'why': '；'.join(why[:4]), 'must_fix': must, 'issues': issues[:10]}


def sha256_file(p):
    import hashlib
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


PUBLISHED_SCHEMA = os.path.join(ol.DOC_SHARED, 'schemas', 'published.schema.json')


def inside(rd, rel):
    if not isinstance(rel, str) or not rel or os.path.isabs(rel):
        return None
    full = os.path.realpath(os.path.join(rd, rel))
    root = os.path.realpath(rd)
    return full if full.startswith(root + os.sep) else None


def published_problems(rd, meta, rj, pj):
    """根目录 published.json 能否判为「发布完成」（主代理 2026-09-15 拍板）：
    过 published.schema；dry_run 为 false；verify 为对象；lark_doc_id、lark_url 非空；problems 为空；版本与 doc.json 等值；
    archive 里唯一的 role=pdf 条目：路径在运行目录内且文件存在、bytes 与 sha256 与文件一致、与当前渲染 PDF 哈希一致，且 pdf_path 指向它。
    source 字段只作溯源，不参与判定。"""
    import validate
    if not isinstance(pj, dict):
        return ['published.json 不是对象']
    probs = []
    try:
        schema = json.load(open(PUBLISHED_SCHEMA, encoding='utf-8'))
        errs = validate.check(pj, schema, schema)
    except (OSError, json.JSONDecodeError) as ex:
        errs = [('$', f'published.schema.json 读取失败：{ex}')]
    if errs:
        probs.append('published.json 不合 schema：' + '；'.join(f'{p} {m}' for p, m in errs[:3]))
    if pj.get('dry_run') is not False:
        probs.append('根目录 published.json 是 dry-run 形态（dry_run 不为 false）：不是真发布记录')
    if not isinstance(pj.get('verify'), dict):
        probs.append('published.json verify 不是对象：回查未完成')
    for k in ('lark_doc_id', 'lark_url'):
        if not (isinstance(pj.get(k), str) and pj[k].strip()):
            probs.append(f'published.json 缺 {k}')
    if pj.get('problems'):
        probs.append(f'发布回查问题 {len(pj["problems"])} 条：' + '；'.join(str(x) for x in pj['problems'][:3]))
    if not ol.same_version(pj.get('version'), meta.get('version')):
        probs.append(f'published.json 版本 {pj.get("version")} 与 doc.json {meta.get("version")} 不一致')
    arch = [x for x in (pj.get('archive') or []) if isinstance(x, dict) and x.get('role') == 'pdf']
    if len(arch) != 1:
        probs.append(f'published.json archive 里 role=pdf 的条目有 {len(arch)} 个，应恰好 1 个')
        return probs
    a = arch[0]
    full = inside(rd, a.get('path'))
    if full is None:
        probs.append(f'归档 PDF 路径不在运行目录内：{a.get("path")}')
        return probs
    if not os.path.isfile(full):
        probs.append(f'归档 PDF 不存在：{a.get("path")}')
        return probs
    if pj.get('pdf_path') != a.get('path'):
        probs.append(f'pdf_path（{pj.get("pdf_path")}）与归档 PDF 条目路径（{a.get("path")}）不一致')
    if os.path.getsize(full) != a.get('bytes'):
        probs.append(f'归档 PDF 大小 {os.path.getsize(full)} 与记录 bytes {a.get("bytes")} 不符：归档被改动')
    got = sha256_file(full)
    if got != a.get('sha256'):
        probs.append('归档 PDF 的 sha256 与记录不符：归档被改动')
    cur = inside(rd, (rj.get('pdf') or {}).get('path'))
    if cur is None or not os.path.isfile(cur):
        probs.append(f'当前渲染 PDF 不存在：{(rj.get("pdf") or {}).get("path")}')
    elif sha256_file(cur) != got:
        probs.append(f'归档 PDF 与当前渲染 PDF（{(rj.get("pdf") or {}).get("path")}）哈希不同：发布后又重新渲染过，需重发')
    return probs


def sh(argv):
    return shlex.join(argv)


PUBLISH_EXIT = {1: '预检拒绝（D3、哈希、产物、排版守卫或 parse）', 2: '用法或读写错误', 3: '已发布但回查不通过', 4: 'pre_publish 钩子失败或越权',
                5: '飞书文件夹归属需用户拍板', 6: '覆盖目标有评论', 7: 'lark-cli 调用失败（写命令失败时可能已写入）',
                8: '存在恢复记录或未决新建，需用户决定', 10: 'lark-cli 高风险确认门'}
# 1–4：交给写作者或主代理处理（对齐 doc-publish/SKILL.md 退出码表），同样不自动重试
PUBLISH_FIX = {1: ('author', '按 problems 回 doc-qa / doc-render 重跑，或升版本；源文件与清单不一致时 advance 会先 reset D3'),
               2: ('orchestrator', '修命令或运行目录（evidence、锁、published.json 损坏、类型包位置），再重跑预检'),
               3: ('orchestrator', '文档已发布但回查不通过：按 problems 局部修复，不重建文档'),
               4: ('orchestrator', '看 pre_publish 钩子输出，修业务前置条件或类型包钩子')}
# 这些退出码一律转成向用户提问：不自动重试，不自动追加 --abandon-recovery、--create、确认 flag（主代理 2026-09-15 定）
PUBLISH_ASK = {
    5: ('飞书文件夹归属拿不准，发到哪里？', [('A', '按预检列出的候选文件夹选一个（写回 doc.json lark_folder.token 与 path）', '要先确认候选是否属于本项目'),
                                           ('B', '新建「客户或项目/子项目」文件夹（再跑预检，新客户一级文件夹需加 --allow-new-project-folder）', '飞书里多一个文件夹，建错要手动移'),
                                           ('C', '先不发布，我去飞书里整理目录', '本轮停在发布前')]),
    6: ('覆盖目标文档上有评论，overwrite 会丢评论，怎么发？', [('A', '改为新建文档（--create），旧文档保留', '链接会变，要通知读者'),
                                                         ('B', '先在飞书里处理完评论，再覆盖原文档', '要等评论处理完'),
                                                         ('C', '暂不发布', '本轮停在发布前')]),
    7: ('飞书调用失败，写命令可能已经写入，先怎么处理？', [('A', '先只读核对飞书里是否已有这篇文档（lark-cli 列文件夹 / fetch），再决定', '要多一次人工核对'),
                                                       ('B', '确认没有写入后重跑预检与发布', '若实际已写入会重复建文档'),
                                                       ('C', '暂不发布，先排查认证 / 网络 / 代理', '本轮停在发布前')]),
    8: ('存在未决的新建或恢复记录，怎么处理？', [('A', '按恢复记录继续上次的发布（不新建）', '要确认恢复记录指向的文档仍然有效'),
                                             ('B', '放弃恢复记录重新发布（由用户确认后主代理手动加 --abandon-recovery 并写原话）', '旧的半成品文档要手动清理'),
                                             ('C', '暂不发布，先看恢复记录内容', '本轮停在发布前')]),
    10: ('lark-cli 触发高风险确认门，是否确认执行？', [('A', '确认执行（由用户确认后主代理按提示手动加确认，advance 不代加）', '高风险操作不可撤销'),
                                                 ('B', '不执行，调整发布方式', '本轮停在发布前')]),
}


def plan(rd, pack_arg=None, check_xref=True, publish_offline=False):
    sp = os.path.join(rd, 'run-state.json')
    state = load_json(sp)
    out = {'run_dir': rd, 'blocking_reasons': [], 'warnings': [], 'artifacts': {}}
    if state is None:
        out.update(step='init', actor='orchestrator', runnable=False, argv=None,
                   blocking_reasons=['没有 run-state.json：先用 new_run.py 建运行目录'])
        return out
    meta = load_json(os.path.join(rd, 'doc.json')) or {}
    pack, pack_dir = al.find_pack(state.get('doc_type'), pack_arg)
    packopt = ['--pack', pack_arg] if pack_arg else []
    gates = {g: v.get('status') for g, v in state['gates'].items()}
    out.update(type=state.get('doc_type'), version=meta.get('version'), mode=state.get('mode'), stage=state.get('stage'), gates=gates)
    if pack is None:
        out.update(step='pack', actor='orchestrator', runnable=False, argv=None, blocking_reasons=[f'找不到类型包 {state.get("doc_type")}'])
        return out
    if pack.get('meta_file', 'doc.json') != 'doc.json':   # 售前等业务线：元数据文件由类型包 meta_file 声明（如 brief.json）
        meta = load_json(os.path.join(rd, pack['meta_file'])) or {}
        out['version'] = meta.get('version')
    RS = [ol.PY, ol.RUN_STATE, rd]
    by = ['--by', 'doc-orchestrator']

    def step(name, actor, argv, runnable, reasons=None, **kw):
        out.update(step=name, actor=actor, argv=argv, runnable=runnable, next_command=sh(argv) if argv else None, **kw)
        out['blocking_reasons'] += reasons or []
        return out

    if gates['D0'] not in DONE:
        gaps = ol.brief_input_gaps(pack, rd, meta)
        if gaps:
            return step('gate-D0', 'user', RS + ['pass-gate', '--gate', 'D0'] + by + packopt, False,
                        ['D0 输入缺项（补进 brief.json inputs 后再过 D0）：' + '；'.join(gaps)])
        return step('gate-D0', 'script', RS + ['pass-gate', '--gate', 'D0'] + by + packopt, True)
    if gates['D1'] not in DONE:
        of = pack.get('outline_file', 'outline.md')
        return step('gate-D1', 'user', RS + ['pass-gate', '--gate', 'D1', '--evidence', '<用户对 ' + of + ' 的确认原话或选项回复>'] + by + packopt, False,
                    [f'D1 待用户确认 {of}（带字母选项的拍板项；用户回复原话作为 --evidence）'])
    of = pack.get('outline_file', 'outline.md')
    op = os.path.join(rd, of)
    if os.path.exists(op):
        n_dec = len(set(__import__('re').findall(r'^([\u2460-\u2473]|\(\d+\)) ', open(op, encoding='utf-8').read(), __import__('re').M)))
        if n_dec > len(state.get('decisions') or {}):
            out['warnings'].append(f'{of} 有 {n_dec} 个拍板项，run-state 只记了 {len(state.get("decisions") or {})} 个：用 run_state.py decide 逐项记录')
    newest, which = rs.newest_source_mtime(rd, pack)
    qa_p, rj_p = os.path.join(rd, 'qa-result.json'), os.path.join(rd, 'out', 'render.json')
    # D3 已签后的「源文件是否变了」（先于正文与交叉引用检查）：
    #   有 gates.D3.source_manifest → 按内容比对（doc.json / brief.json 去掉 lark_folder），发布引擎写回 token 即使改了修改时间也不作废；
    #   manifest 一致时，渲染与质检的过期判断也不看修改时间（否则写回 token 会触发重渲染，PDF 哈希变化后发布记录对不上）
    #   没有 manifest（豁免或旧 run-state）→ 严格比较修改时间，无容差
    manifest = (state['gates'].get('D3') or {}).get('source_manifest')
    manifest_ok = False
    if gates['D3'] in DONE and manifest:
        dif = rs.diff_manifest(rd, manifest, pack)
        manifest_ok = not any(dif.values())
        out['artifacts']['manifest'] = {'ok': manifest_ok, **{k: v[:10] for k, v in dif.items()}}
        if not manifest_ok:
            what = '；'.join(f'{k} {v[:5]}' for k, v in dif.items() if v)
            return step('reset-D3', 'script', RS + ['reset-gate', '--gate', 'D3', '--reason', f'D3 通过后源文件与 source_manifest 不一致（{what}），重走质检'] + by + packopt, True)
    elif gates['D3'] in DONE and ((mtime(qa_p) or 0) < newest or (mtime(rj_p) or 0) < newest):
        return step('reset-D3', 'script', RS + ['reset-gate', '--gate', 'D3', '--reason', f'D3 通过后又改了 {which}（无 source_manifest，按修改时间严格判定），重走质检'] + by + packopt, True)
    if manifest_ok:
        newest = 0.0   # 内容与签门时一致：产物不因修改时间过期
    # 正文完成度
    c, o, e = ol.run([ol.PY, os.path.join(ol.AUTHOR, 'fill_check.py'), rd] + packopt, timeout=300)
    fc = ol.jparse(o)
    out['artifacts']['fill_check'] = {'exit_code': c, 'placeholders': len(fc.get('placeholders') or []), 'hints': fc.get('hints')}
    out['warnings'] += fc.get('warnings') or []
    if c == 3:
        return step('author', 'author', [ol.PY, os.path.join(ol.AUTHOR, 'fill_check.py'), rd] + packopt, False,
                    ['正文未完成（doc-author）：' + r for r in fc.get('blocking_reasons') or []])
    if c != 0:
        return step('author', 'orchestrator', None, False, [f'fill_check 故障（退出码 {c}）：{(o + e)[-300:]}'])
    if check_xref and (meta.get('related_docs') or state.get('mode') == 'revision'):
        xargv = [ol.PY, ol.XREF, rd] + ([] if state.get('mode') == 'revision' else ['--no-downstream']) + packopt
        c, o, e = ol.run(xargv, timeout=300)
        xr = ol.jparse(o)
        out['artifacts']['xref'] = {'exit_code': c, 'dangling': len(xr.get('dangling') or []), 'downstream': len(xr.get('downstream') or [])}
        out['warnings'] += xr.get('warnings') or []
        if c == 3:
            return step('xref', 'author', xargv, False, xr.get('blocking_reasons') or [])
        if c != 0:
            out['fault'] = True
            return step('xref', 'orchestrator', xargv, False, [f'交叉引用检查故障（退出码 {c}），不能跳过：{(xr.get("message") if isinstance(xr, dict) else "") or (o + e)[-300:]}'])
    if gates['D2'] not in DONE:
        d2 = (pack.get('gates') or {}).get('D2')
        if d2 is None:
            return step('gate-D2', 'script', RS + ['skip-gate', '--gate', 'D2', '--reason', f'类型包 {pack["id"]} 未声明 D2 专属门'] + by + packopt, True)
        return step('gate-D2', 'script', RS + ['pass-gate', '--gate', 'D2', '--run', '--evidence', f'advance.py --run 执行类型包 D2 命令：{d2.get("desc", "")}'] + by + packopt, True)
    fs = figures_state(rd)
    out['artifacts']['figures'] = fs
    if fs['stale']:
        return step('figures', 'script', [ol.PY, ol.FIG_BUILD, rd], True, why=fs['why'])
    if fs['must_fix']:
        return step('figures', 'author', [ol.PY, ol.FIG_BUILD, rd], False, [f'图机器检查必改 {fs["must_fix"]} 条（改图源后 advance 会重建）：' + '；'.join(fs['issues'][:5])])
    rj = load_json(rj_p)
    if rj:
        out['artifacts']['render'] = {'pages': (rj.get('pdf') or {}).get('pages'), 'layout_must_fix': sum(1 for x in rj.get('layout_issues') or [] if x.get('severity') == '必改')}
    if rj is None or newest > mtime(rj_p):
        return step('render', 'script', [ol.PY, ol.RENDER, rd] + packopt, True, why='out/render.json 缺失' if rj is None else f'渲染后又改了 {which}')
    lmust = [x for x in rj.get('layout_issues') or [] if x.get('severity') == '必改']
    if lmust:
        return step('render', 'author', [ol.PY, ol.RENDER, rd] + packopt, False, [f'版式必改 {len(lmust)} 条：' + '；'.join(f'{x.get("rule")} {x.get("message")}' for x in lmust[:5])])
    qa = load_json(qa_p)
    if qa:
        out['artifacts']['qa'] = {'must_fix': qa.get('must_fix'), 'total': qa.get('total')}
    if qa is None or newest > mtime(qa_p) or mtime(qa_p) < mtime(rj_p):
        return step('qa', 'script', [ol.PY, ol.QA, rd] + packopt, True, why='qa-result.json 缺失' if qa is None else '质检结果早于源文件或渲染')
    if qa.get('must_fix'):
        must = [x for x in qa.get('issues') or [] if x.get('severity') == '必改']
        return step('qa', 'author', [ol.PY, ol.QA, rd] + packopt, False,
                    [f'质检必改 {qa["must_fix"]} 条（见 qa-report.md）：'] + [f'{x["rule"]} 第 {x["line"]} 行 {x["message"]}' for x in must[:10]])
    report = open(os.path.join(rd, 'qa-report.md'), encoding='utf-8').read() if os.path.exists(os.path.join(rd, 'qa-report.md')) else ''
    auto_end = report.find('<!-- qa-auto:end -->')
    manual = report[:report.find('<!-- qa-auto:start -->')] + report[auto_end:] if auto_end >= 0 else report
    has_codex = ('Codex' in manual or 'codex' in manual) and ('证伪' in manual or '降级' in manual)
    if gates['D3'] in DONE and not has_codex:
        out['warnings'].append('D3 已过，但 qa-report.md 人工区块里找不到 Codex 找茬 / 证伪（或降级说明）记录')
    if gates['D3'] not in DONE:
        src = pack.get('source_file', 'doc.md')
        return step('gate-D3', 'codex', RS + ['pass-gate', '--gate', 'D3', '--evidence', '<Codex 两轮结论位置（qa-report.md 某节）或降级说明>'] + by + packopt, False,
                    ['D3 待 Codex 找茬与证伪两轮（doc-shared/references/qa-engine.md §5）：输入 out/' + src[:-3] + '.resolved.md、qa-report.md 与关联文档；'
                     '采纳意见改源文件后 advance 会自动重跑图、渲染、质检；两轮结论写进 qa-report.md 后 pass-gate D3'])
    pub = ol.publish_script()
    dry_p = os.path.join(rd, 'out', 'publish-dry-run.json')
    if gates['D4'] not in DONE:
        if not os.path.exists(pub):
            return step('publish-dry-run', 'orchestrator', None, False, [f'doc-publish 未落地（找不到 {pub}），无法做发布预检'])
        dargv = [ol.PY, pub, rd] + (['--offline'] if publish_offline else []) + packopt
        dry = load_json(dry_p)
        bound = dry and dry.get('doc_version') == meta.get('version') and dry.get('render_sha256') == rj.get('source_sha256') and dry.get('qa_sha256') == qa.get('source_sha256')
        if dry is None or not bound or mtime(dry_p) < max(mtime(rj_p), mtime(qa_p)):
            return step('publish-dry-run', 'script', dargv, True)
        out['artifacts']['publish_dry_run'] = {'exit_code': dry.get('exit_code'), 'offline': '--offline' in (dry.get('argv') or [])}
        dc = dry.get('exit_code')
        if dc != 0:
            msg = (dry.get('output') or {}).get('message') if isinstance(dry.get('output'), dict) else str(dry.get('output'))[-300:]
            if dc in PUBLISH_ASK:
                q, opts = PUBLISH_ASK[dc]
                return step('publish-dry-run', 'user', dargv, False,
                            [f'发布预检需要用户决定（退出码 {dc}：{PUBLISH_EXIT[dc]}）：{msg}'],
                            question=q, options=[{'letter': l, 'text': t, 'cost': c} for l, t, c in opts],
                            no_auto_retry=True)
            actor, todo = PUBLISH_FIX.get(dc, ('orchestrator', '未登记的退出码：读 doc-publish 输出后人工判断，不自动重试'))
            return step('publish-dry-run', actor, dargv, False, [f'发布预检未通过（退出码 {dc}：{PUBLISH_EXIT.get(dc, "未登记")}）：{msg}；处理：{todo}'], no_auto_retry=True)
        reasons = []
        if not (meta.get('lark_folder') or {}).get('token'):
            reasons.append('doc.json lark_folder 没有 token：先确认飞书项目文件夹（没有就建），把 token 写进 doc.json')
        pdf = (rj.get('pdf') or {}).get('path')
        reasons.append(f'D4 待用户看过 PDF 预览（{pdf}）并确认发布范围、版本 v{meta.get("version")}、飞书账号与项目文件夹；确认后主代理执行下面的命令（doc-publish 写 D4 后才写飞书）')
        if '--offline' in (dry.get('argv') or []):
            out['warnings'].append('发布预检是 --offline（没查飞书文件夹与评论）：真发布前 publish.py --apply 会在线再查一遍')
        return step('publish', 'user', [ol.PY, pub, rd, '--apply', '--evidence', '<用户确认原话>'] + packopt, False, reasons)
    pj = load_json(os.path.join(rd, 'published.json'))
    if pj is None:
        return step('publish', 'orchestrator', [ol.PY, pub, rd, '--apply', '--evidence', '<用户确认原话>'] + packopt, False, ['D4 已过但没有 published.json：发布中断或未执行，主代理重跑 --apply（advance 不写飞书）'])
    pub_problems = published_problems(rd, meta, rj, pj)
    if pub_problems:
        return step('publish', 'orchestrator', [ol.PY, pub, rd, '--apply', '--evidence', '<用户确认原话>'] + packopt, False, pub_problems)
    if state.get('stage') != 'done':
        return step('done', 'script', RS + ['set-stage', 'done'] + by + packopt, True)
    return step('done', 'none', None, False)


def execute(p, rd):
    argv = p['argv']
    if p['step'] == 'figures':
        ol.run_state(rd, 'set-stage', 'figures', '--by', 'doc-orchestrator')
    c, o, e = ol.run(argv, cwd=rd, timeout=1800)
    rec = {'step': p['step'], 'argv': argv, 'exit_code': c, 'tail': (o + e)[-400:]}
    j = ol.jparse(o)
    if p['step'] == 'publish-dry-run':
        os.makedirs(os.path.join(rd, 'out'), exist_ok=True)
        meta = load_json(os.path.join(rd, 'doc.json')) or {}
        rj = load_json(os.path.join(rd, 'out', 'render.json')) or {}
        qa = load_json(os.path.join(rd, 'qa-result.json')) or {}
        json.dump({'at': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'argv': argv, 'exit_code': c,
                   'doc_version': meta.get('version'), 'render_sha256': rj.get('source_sha256'), 'qa_sha256': qa.get('source_sha256'),
                   'apply': '--apply' in argv, 'output': j or (o + e)[-2000:]},
                  open(os.path.join(rd, 'out', 'publish-dry-run.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        rec['ok'] = c == 0
        return rec, (None if c == 0 else [f'发布预检退出码 {c}：{(o + e)[-300:]}']), False
    if p['step'].startswith(('gate-', 'reset-', 'done')):
        ok = c == 0 and j.get('ok', True)
        rec['ok'] = ok
        if not ok:
            rec['detail'] = j.get('problems') or j.get('message') or (o + e)[-400:]
            return rec, [f'{p["step"]} 未通过：' + ('；'.join(j['problems']) if j.get('problems') else str(rec['detail']))], False
        return rec, None, False
    engine_block = {'figures': {1}, 'render': {3}, 'qa': {3}}[p['step']]
    rec['ok'] = c == 0
    if c == 0:
        return rec, None, False
    if c in engine_block:
        return rec, None, False   # 结果已写盘，重新 plan 会给出具体阻塞原因
    rec['detail'] = (o + e)[-600:]
    return rec, [f'{p["step"]} 故障（退出码 {c}）：{rec["detail"][-300:]}'], True


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--run', action='store_true'); ap.add_argument('--max-steps', type=int, default=12)
    ap.add_argument('--pack'); ap.add_argument('--publish-offline', action='store_true')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    rd = os.path.abspath(os.path.expanduser(a.run_dir))
    if not os.path.isdir(rd):
        print(json.dumps({'ok': False, 'message': f'运行目录不存在：{rd}'}, ensure_ascii=False)); return 2
    executed, fault = [], False
    p = plan(rd, a.pack, publish_offline=a.publish_offline)
    while a.run and p.get('runnable') and not p['blocking_reasons']:
        if len(executed) >= a.max_steps:
            fault = True
            p['blocking_reasons'].append(f'执行了 {a.max_steps} 步仍未停下（最后一步 {p["step"]}），疑似循环')
            break
        rec, reasons, fault = execute(p, rd)
        executed.append(rec)
        prev_step = p['step']
        p = plan(rd, a.pack, publish_offline=a.publish_offline)
        if reasons:
            p['blocking_reasons'] = reasons + p['blocking_reasons']
            break
        if prev_step == 'done':
            break
        if p.get('runnable') and p['step'] == prev_step:
            # 执行完仍判为同一个待执行步骤：引擎没有产出可识别的结果，不能当成功
            fault = True
            p['blocking_reasons'].insert(0, f'{prev_step} 执行后（退出码 {rec["exit_code"]}）产物仍缺失或过期：引擎故障，输出尾部：{str(rec.get("detail") or rec.get("tail") or "")[-300:]}')
            break
    p['executed'] = executed
    if p.pop('fault', False):
        fault = True
    p.pop('argv', None) if not p.get('argv') else None
    os.makedirs(os.path.join(rd, 'out'), exist_ok=True)
    json.dump(p, open(os.path.join(rd, 'out', 'advance-last.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(json.dumps(p, ensure_ascii=False, indent=2))
    if fault:
        return 1
    return 3 if p['blocking_reasons'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
