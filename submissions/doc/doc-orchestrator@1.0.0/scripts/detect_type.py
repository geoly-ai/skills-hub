#!/usr/bin/env python3
"""判型：把用户原话映射到 doc-* 类型包，判不准时给字母选项。
用法：detect_type.py "用户原话" [--triggers references/type-triggers.json]
候选类型 = doc-shared/types/*/pack.json（不含 _template；DOC_TYPES_DIRS 里的包也算，同名先到先得）；关键词 = type-triggers.json types.<id>
+ 类型包 pack.json triggers（pack.schema 已声明，追加到同类型，去重）+ pack.json name。handoff（转售前、转 lark-doc）只在 type-triggers.json 定义，
类型包 triggers 不能改变转交规则。计分：原话中每个关键词出现记其长度，重叠区间只算最长的词（长词命中后，被它包含的短词不再计分）。
优先级：售前（命中售前类型为第一名，或出现售前词）> 单一类型 > 追问；轻量文档 handoff 只在没有任何类型命中时触发。
并列：前两名分数相等、或第二名 ≥ 第一名 60% 时追问（选项取前三名 + 「都不是」）。关键词匹配前去空白、转小写。
输出 JSON：
  decision=single   唯一高分（第二名不到第一名的 60%）→ type
  decision=ask      0 分或前两名接近 → options[{letter, type, name, score}]，最后一项是「都不是」
  decision=handoff  命中售前类型或售前词 → skill=presales-orchestrator；命中轻量文档词且无类型命中 → skill=lark-doc
退出码：0 single；3 ask；4 handoff；2 用法错误。"""
import argparse, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ORCH = os.path.dirname(HERE)
SKILLS = os.path.dirname(ORCH)
TYPES = os.path.join(SKILLS, 'doc-shared', 'types')


def list_packs():
    roots = [os.path.expanduser(d) for d in os.environ.get('DOC_TYPES_DIRS', '').split(':') if d] + [TYPES]
    out = {}
    for r in roots:
        for p in sorted(glob.glob(os.path.join(r, '*', 'pack.json'))):
            tid = os.path.basename(os.path.dirname(p))
            if tid.startswith('_') or tid in out: continue
            try:
                out[tid] = json.load(open(p, encoding='utf-8'))
            except (OSError, json.JSONDecodeError):
                continue
    return out


def spans(text, kw):
    norm = lambda s: re.sub(r'\s+', '', s).lower()
    t, k = norm(text), norm(kw)
    i, res = 0, []
    while k and (j := t.find(k, i)) >= 0:
        res.append((j, j + len(k))); i = j + 1
    return res, len(k)


def score_all(text, table):
    hits = []  # (start, end, type, kw)
    for tid, kws in table.items():
        for kw in kws:
            ss, n = spans(text, kw)
            hits += [(a, b, tid, kw) for a, b in ss]
    hits.sort(key=lambda h: (-(h[1] - h[0]), h[0]))
    taken, scores, matched = [], {}, {}
    for a, b, tid, kw in hits:
        if any(a < y and x < b for x, y, _ in taken):
            # 与已计分的更长词重叠：同一区间别的类型也叫这个词时并列计分
            same = [z for z in taken if z[0] == a and z[1] == b and z[2] != tid]
            if not same: continue
        taken.append((a, b, tid))
        scores[tid] = scores.get(tid, 0) + (b - a)
        matched.setdefault(tid, []).append(kw)
    return scores, matched


TOP_KEYS = {'_comment', 'types', 'handoff'}
HANDOFF_KEYS = {'types', 'keywords', 'why'}
HANDOFF_SKILLS = {'presales-orchestrator': ('keywords', 'types', 'why'), 'lark-doc': ('keywords', 'why')}   # 必填字段


def _str_list(v):
    return isinstance(v, list) and len(v) > 0 and all(isinstance(x, str) and x.strip() for x in v)


def config_problems(cfg, packs):
    out = []
    if not isinstance(cfg, dict) or not isinstance(cfg.get('types'), dict) or not cfg['types']:
        return ['顶层须为对象，types 须为非空的 {类型 id: [关键词]}']
    out += [f'顶层未知字段：{k}' for k in sorted(set(cfg) - TOP_KEYS)]
    for t, v in cfg['types'].items():
        if t not in packs: out.append(f'types.{t}：类型包不存在')
        if not _str_list(v): out.append(f'types.{t}：须为非空字符串数组（空数组会静默移除该类型的关键词）')
    ho = cfg.get('handoff')
    if not isinstance(ho, dict):
        return out + ['handoff 须为对象，且包含 ' + '、'.join(HANDOFF_SKILLS)]
    for k in sorted(set(HANDOFF_SKILLS) - set(ho)):
        out.append(f'handoff 缺少 {k}（删掉会静默改变转交规则）')
    for k, v in ho.items():
        if k not in HANDOFF_SKILLS: out.append(f'handoff.{k}：未知的转交目标（允许 {sorted(HANDOFF_SKILLS)}）'); continue
        if not isinstance(v, dict): out.append(f'handoff.{k} 须为对象'); continue
        out += [f'handoff.{k}.{f}：未知字段（允许 {sorted(HANDOFF_KEYS)}）' for f in sorted(set(v) - HANDOFF_KEYS)]
        for f in HANDOFF_SKILLS[k]:
            if f not in v: out.append(f'handoff.{k} 缺少 {f}')
        for f in ('keywords', 'types'):
            if f in v and not _str_list(v[f]): out.append(f'handoff.{k}.{f} 须为非空字符串数组')
        if 'why' in v and not (isinstance(v['why'], str) and v['why'].strip()): out.append(f'handoff.{k}.why 须为非空字符串')
        for t in v.get('types') or []:
            if isinstance(t, str) and t not in cfg['types']: out.append(f'handoff.{k}.types：{t} 不在 types 里')
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('text'); ap.add_argument('--triggers', default=os.path.join(ORCH, 'references', 'type-triggers.json'))
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    packs = list_packs()
    try:
        cfg = json.load(open(a.triggers, encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as ex:
        print(json.dumps({'ok': False, 'message': f'关键词表读取失败：{ex}'}, ensure_ascii=False)); return 2
    problems = config_problems(cfg, packs)
    if problems:
        print(json.dumps({'ok': False, 'message': 'type-triggers.json 不合法', 'problems': problems}, ensure_ascii=False)); return 2
    # 合并：type-triggers.json types.<id> + 类型包 pack.json triggers（追加，同类型关键词去重）+ 类型包 name；handoff 只在 type-triggers.json 定义
    table = {tid: list(dict.fromkeys(list(cfg['types'].get(tid, [])) + [x for x in (p.get('triggers') or []) if isinstance(x, str) and x.strip()] + [p.get('name', '')])) for tid, p in packs.items()}
    table = {k: [x for x in v if x] for k, v in table.items()}
    scores, matched = score_all(a.text, table)
    ho = cfg.get('handoff', {})
    pres = ho.get('presales-orchestrator', {})
    pres_kw = [k for k in pres.get('keywords', []) if spans(a.text, k)[0]]
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    base = {'text': a.text, 'scores': dict(ranked), 'matched': matched}
    if pres_kw or (ranked and ranked[0][0] in pres.get('types', [])):
        print(json.dumps({**base, 'decision': 'handoff', 'skill': 'presales-orchestrator', 'why': pres.get('why'),
                          'type': ranked[0][0] if ranked and ranked[0][0] in pres.get('types', []) else None}, ensure_ascii=False, indent=2))
        return 4
    lark = ho.get('lark-doc', {})
    if not ranked and any(spans(a.text, k)[0] for k in lark.get('keywords', [])):
        print(json.dumps({**base, 'decision': 'handoff', 'skill': 'lark-doc', 'why': lark.get('why')}, ensure_ascii=False, indent=2))
        return 4
    if ranked and (len(ranked) == 1 or ranked[1][1] < ranked[0][1] * 0.6):
        tid = ranked[0][0]
        print(json.dumps({**base, 'decision': 'single', 'type': tid, 'name': packs[tid].get('name')}, ensure_ascii=False, indent=2))
        return 0
    cands = [t for t, _ in ranked[:3]] or [t for t in packs if t not in pres.get('types', [])]
    letters = 'ABCDEFGHIJ'
    opts = [{'letter': letters[i], 'type': t, 'name': packs[t].get('name'), 'score': scores.get(t, 0)} for i, t in enumerate(cands)]
    opts.append({'letter': letters[len(opts)], 'type': None, 'name': '都不是：售前方案转 presales-orchestrator；轻量飞书文档转 lark-doc'})
    print(json.dumps({**base, 'decision': 'ask', 'options': opts,
                      'question': '判不准文档类型，请选：' + ' '.join(f'{o["letter"]} {o["name"]}' for o in opts)}, ensure_ascii=False, indent=2))
    return 3


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
