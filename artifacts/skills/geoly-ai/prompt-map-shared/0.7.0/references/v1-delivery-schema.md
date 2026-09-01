# First-Version Delivery Contract

Use this contract when a project provides an accepted first-version Prompt Map.

## Required workbook structure

- README
- 品类 Prompt
- One sheet per approved internal demand Topic

## Required delivery columns

1. Prompt
2. Chinese translation
3. Level
4. Demand theme
5. Purchase-intent type
6. Evidence source
7. Evidence status

Internal fields such as demand cell IDs, purchase stages, canonical keys, raw evidence IDs, and hypothesis flags may remain in audit CSVs. They do not enter the visible delivery workbook unless the user explicitly asks for them.

## Generation rule

Use the accepted first-version Prompt Map as the natural-language baseline. New Prompts are added only when the coverage audit identifies a meaningful uncovered demand or decision distinction. Do not generate one Prompt per theoretical cell.
