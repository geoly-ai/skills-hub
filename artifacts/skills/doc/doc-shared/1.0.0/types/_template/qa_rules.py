"""类型包专属质检规则（接口见 doc-shared/references/pack-interface.md「qa_rules.py 接口」）。

doc-qa 引擎加载本模块并调用 check(doc, ctx)，返回问题列表；引擎给每条问题补 rule_source=type。
- doc：引擎解析好的文档模型（标题树、表格、图、代码块、数据块、锚点与引用、编号实体），只读。
- ctx：run_dir、meta（doc.json 内容）、pack（pack.json 内容）、pack_dir、related(type) 读关联文档模型、
       read_json(rel) / read_text(rel) 读运行目录内文件、issue(rule, severity, line, text, msg) 构造问题。
规则编号用类型包自己的前缀（如 PRD1、SPEC2），不要占用引擎规则编号（L*、S*、X*、T*、R1、C1）。
抛出异常时引擎记一条必改 E-TYPE，不会静默跳过。
"""


def check(doc, ctx):
    return []
