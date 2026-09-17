# 旧 qa_checks.py 冻结结果（1f，2026-09-15）

presales-qa/scripts/qa_checks.py 已改为调用 doc-qa 的包装脚本，自测不能再现场调用它当「旧脚本」参照。
本目录是迁移前旧实现（~/.claude/skills-backups/presales-pre-1f-20260915.tgz 里的 presales-qa/scripts/qa_checks.py，
与 presales-qa/scripts/legacy/qa_checks_legacy.py 除首行说明外逐字相同）在同一夹具上的输出，去掉 generated_at。

| 文件 | 夹具 | 生成方式 |
|---|---|---|
| waykar-qa-result.json | presales-qa/tests/fixtures/waykar-v18-excerpt.md + brief {"client": "Waykar", "line": "site", "version": "1.8", "overview": []} + price_site.py waykar-site-input.json 产出的 pricing/ | 旧脚本 must_fix 9 / total 15 |
| equivalence-qa-result.json | doc-qa/tests/fixtures/equivalence/ 原样 | 旧脚本 must_fix 17 / total 30 |
| equivalence-proposal.resolved.md | 同上 | 旧脚本写出的 out/proposal.resolved.md |

Waykar 结果依赖 price_site.py 的产物：报价脚本或 waykar-site-input.json 改动导致比对失败时，用备份里的旧脚本重新生成本目录，不要手改 JSON。
