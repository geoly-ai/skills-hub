#!/usr/bin/env python3
"""生成组织介绍章节（公司定位、服务矩阵、可选的交付团队与流程、可选的案例、联系方式）。
内容只来自 brand/org/company.json（带来源的公司口径）与运行目录元数据文件里的 contact。
用法：org_section.py <运行目录> [--company PATH] [--meta doc.json|brief.json] [--delivery KEY] [--cases KEY]
                     [--cases-columns 项目,行业,交付方式,我方负责] [--out sections/org.md]
  --meta      默认先找 doc.json，没有再找 brief.json
  --delivery  company.json 里交付块的键（含 team、process、quality、docs）；不给则不输出团队与流程
  --cases     company.json cases 下的键；不给或该键为空则不输出案例
来源与改动记录见 doc-shared/SKILL.md「脚本来源」。
退出码：0 成功；1 缺少 company.json 或元数据文件；2 参数引用的键不存在。"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_COMPANY = os.path.join(os.path.dirname(HERE), 'brand', 'org', 'company.json')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root', nargs='?', default='.')
    ap.add_argument('--company', default=DEFAULT_COMPANY)
    ap.add_argument('--meta')
    ap.add_argument('--delivery'); ap.add_argument('--cases')
    ap.add_argument('--cases-columns', default='项目,行业,交付方式,我方负责')
    ap.add_argument('--out', default='sections/org.md')
    a = ap.parse_args()
    root = a.root
    meta_path = os.path.join(root, a.meta) if a.meta else next((os.path.join(root, n) for n in ('doc.json', 'brief.json') if os.path.exists(os.path.join(root, n))), None)
    if not os.path.exists(a.company) or not meta_path or not os.path.exists(meta_path):
        print('缺少 company.json 或元数据文件（doc.json / brief.json）'); return 1
    if os.path.isabs(a.out) or '..' in a.out.split('/'):
        print('--out 必须是运行目录内的相对路径'); return 2
    c = json.load(open(a.company)); b = json.load(open(meta_path))
    contact = b.get('contact', {})
    L = [f"{c['brand']} 是{c['entity']}，{c['positioning']}", '',
         '| 业务板块 | 服务内容 |', '|---|---|'] + [f'| {k} | {v} |' for k, v in c['services']]
    if a.delivery:
        if a.delivery not in c:
            print(f'company.json 没有交付块 {a.delivery}'); return 2
        d = c[a.delivery]
        L += ['', '### 项目团队', '', '| 角色 | 人数 | 职责 |', '|---|---|---|'] + [f'| {r} | {n} | {j} |' for r, n, j in d['team']]
        L += ['', '### 交付流程与质量保障', '', f"交付流程：{d['process']}。", '', '质量保障：' + '；'.join(d['quality']) + '。', '', f"交付文档：{d['docs']}。"]
    cases = []
    if a.cases:
        if a.cases not in c.get('cases', {}):
            print(f'company.json cases 下没有 {a.cases}'); return 2
        cases = c['cases'][a.cases]
    if cases:
        cols = [x.strip() for x in a.cases_columns.split(',')]
        if len(cols) != len(cases[0]):
            print(f'--cases-columns 列数 {len(cols)} 与案例字段数 {len(cases[0])} 不一致'); return 2
        L += ['', '### 参考案例', '', '| ' + ' | '.join(cols) + ' |', '|' + '---|' * len(cols)] + ['| ' + ' | '.join(row) + ' |' for row in cases]
    L += ['', '### 联系我们', '', '| 项 | 内容 |', '|---|---|']
    if contact.get('name'): L.append(f"| 项目联系人 | {contact['name']}{('（' + contact['title'] + '）') if contact.get('title') else ''} |")
    if contact.get('email'): L.append(f"| 邮箱 | {contact['email']} |")
    if contact.get('phone'): L.append(f"| 电话 | {contact['phone']} |")
    L += [f"| 咨询热线 | {c['hotline']} |", f"| 官网 | {c['website']} |"]
    out = os.path.join(root, a.out)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    open(out, 'w').write('\n'.join(L) + '\n')
    print(json.dumps({'ok': True, 'out': a.out, 'cases': len(cases), 'contact_person': bool(contact.get('name'))}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
