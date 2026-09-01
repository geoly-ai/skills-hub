# Spreadsheet Output

## Sheet rules

- `README`: project scope, source coverage, statuses, exclusions, version, and limitations.
- `品类 Prompt`: only prompts valid across multiple Topics.
- Topic sheets: one sheet for each approved internal demand Topic. A GEOly Topic is an evidence/mapping field, not a replacement for the internal Topic structure.

## Column rules

Keep the accepted first-version columns. The required delivery columns are:

`Prompt`, `中文释义`, `层级`, `需求主题`, `购买意图类型`, `证据来源`, `证据状态`.

The visible workbook must stay simple. Keep demand-cell IDs, people/body/scenario/pain/stage fields, canonical keys, raw evidence IDs, hypothesis flags, and dedupe decisions in audit files alongside the workbook. Do not add internal audit columns to the accepted delivery sheets unless the user explicitly approves a delivery-format change.
