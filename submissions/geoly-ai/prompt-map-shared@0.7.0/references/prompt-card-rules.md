# Product-Card Prompt Rules

## Hard eligibility test

A delivered Prompt must satisfy all four:

1. Refers to the correct physical product category or an unambiguous category synonym.
2. Expresses a purchase decision: recommendation, shortlist, comparison, best fit, product capability, review/reliability, value/budget, result/timeline, or ease-of-use choice.
3. Contains at least one meaningful decision constraint: people, scenario, pain point, body area/object, compatibility, feature, budget, result, or tradeoff.
4. Can naturally be answered with one or more concrete products/SKUs.

## Eligible intent families

- Best-for / recommendation
- Which-feature / capability fit
- Scenario fit
- Results and timeline selection
- Comparison and tradeoff
- Review, reliability, and long-term ownership
- Budget/value tier
- Ease, comfort, setup, maintenance, or adherence when used to choose a product
- Switching/replacement shortlist

## Exclude from delivery

- Pure definition or category education.
- Pure how-to, troubleshooting, or usage instructions without a product choice.
- Method-only questions such as “IPL vs shaving” that do not ask which device to buy.
- Medical/safety-only questions that ask whether something is safe, not which product fits the concern.
- Warranty, support, official-site, financing, or service-only navigation.
- Prompts about an unrelated product category.

An excluded need may be rewritten only when the underlying user concern can honestly become a product selection criterion. Example: “Is IPL painful?” is excluded; “Which at-home IPL devices are least painful for sensitive bikini-line skin?” is eligible.

## Neutrality

Default prompts must be fair and brand-neutral. A brand or competitor may appear only when the evidence shows a real comparison need, and those rows go to `Topic - Brand Comparison`.

## Language

Use natural first-person and third-person forms in a mixed set. Avoid template spam. The direct Chinese translation must preserve the English meaning and must not add claims or brand preference.

## No guarantee claim

These rules maximize product-card eligibility; no wording guarantees a card because platform, locale, inventory/feed coverage, and runtime behavior vary.
