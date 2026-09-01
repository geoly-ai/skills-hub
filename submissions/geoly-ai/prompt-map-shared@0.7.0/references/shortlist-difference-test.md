# Shortlist Difference Test

This is the cross-category safeguard against **meaningless** mechanical
expansion. It applies to every physical-product Prompt Map, regardless of
product type.

> **Coverage mode (read first).** The default is `geo_full_coverage` (see
> `geo-coverage-mode.md`): the unit of distinctness is a **query surface**
> (`audience × body_part × attribute × scenario × decision_angle ×
> decision_criterion`), not a product shortlist. Throughout this file read
> "changes the product shortlist" as "opens a new query surface": two prompts
> that share a product shortlist but differ in surface ARE distinct and both
> kept; only an identical canonical surface or a pure synonym/label/word-order
> variant on the same surface is merged. `selection_change_test` may be
> `surface_distinct`. In `minimal_dedup` (legacy) the shortlist language below is
> literal.

## Core question

Before creating or keeping a Prompt, ask:

> If a shopper asked this version instead of the nearest existing version,
> would the recommended products or their ranking criteria materially change?

The answer must be `different`, `surface_distinct` (GEO), `same`, or `unknown`.

- `different` / `surface_distinct`: keep or create the Prompt, and record the
  concrete change — `shortlist_delta` (minimal) or a distinct canonical query
  surface (GEO). Use `surface_distinct` when the surface is new even though the
  product shortlist overlaps.
- `same`: merge, remove, or rewrite as a genuinely different decision/surface.
- `unknown`: send to review. Do not treat a different intent label as proof of
  a different shortlist or surface.

## What counts as a real difference

A difference is real when evidence shows that the shopper would prioritize a
different product capability, compatibility requirement, audience fit, scene,
pain-point solution, result expectation, budget tradeoff, purchase stage, or
comparison criterion. The axis names are generic; the actual values must come
from the active category evidence.

Examples:

- A breast-pump Prompt prioritizing quiet operation for long shifts can differ
  from one prioritizing output as a primary pump.
- A robot-vacuum Prompt prioritizing pet-hair pickup can differ from one
  prioritizing multi-floor mapping and stair avoidance.
- An IPL Prompt prioritizing low pain for sensitive bikini skin can differ from
  one prioritizing dark-skin compatibility.

The same product can appear in both answers. What matters is whether the
selection or ranking lens changes, not whether the final SKU sets are
guaranteed to be disjoint.

## What does not count

Do not create a new row merely because:

- `recommendation`, `feature`, `scenario`, `value`, or `comparison` is a
  different label while the product-selection criterion is unchanged;
- the sentence changes from “which” to “what are the best”;
- synonyms or word order change;
- a generic Topic name is appended in parentheses;
- a broad scene is added but does not impose a product constraint;
- the Topic and Category rows would return the same product ranking.

## Topic rule

In `minimal_dedup`, a Topic row needs a natural `topic_delta`: the concrete
constraint that makes the Topic route rank products differently from the
Category route; if no delta exists, keep the broader Category row only.

In `geo_full_coverage`, a Topic row is kept when it presents a new canonical
query surface for that Topic (a Topic-specific audience, condition, scenario,
angle, or criterion), even if the product ranking would overlap the Category
row — the Topic surface is itself the distinction. In both modes, a bare
parenthetical Topic suffix is never a substitute for a real Topic surface/delta.

Note: this whole test is scoped to `minimal_dedup`-style shortlist reasoning.
In `geo_full_coverage` the distinctness unit is the canonical query surface (see
`geo-coverage-mode.md`); overlapping shortlists across different surfaces do NOT
make two rows duplicates.

## Mapping to `product_impact_code` (Discovery Stream)

In a discovery round the agent does not write prose about the difference — it
writes one closed enum, `product_impact_code`, and the script maps it to the
`P` component of the value score. The mapping is the same judgement this test
describes, expressed as a code:

| product_impact_code | this test's language | P |
|---|---|---:|
| `P4_ELIGIBILITY_GATE` | eliminates part of the product set (compatibility, availability, size/format, voltage, access, eligibility) | 1.00 |
| `P3_PRIMARY_RANKING` | changes the primary filter criterion or clearly changes ranking | 0.80 |
| `P2_SECONDARY_TRADEOFF` | changes a real secondary tradeoff, usually without eliminating a product group | 0.60 |
| `P1_EMPHASIS_ONLY` | "what does not count" — only emphasis, tone, or scene wording changes | 0.30 |
| `P0_NO_CHANGE` | synonym, intent label, word order; no product-decision difference | 0.00 |

**`P1_EMPHASIS_ONLY` and `P0_NO_CHANGE` never pass materiality.** The hard gate
in `value-rubric.md` requires `P >= 0.60`, so a surface whose only claim is a
different emphasis or a different label is rejected regardless of how strong its
evidence is. This is the shortlist-difference test made non-negotiable.

**An identical surface is never kept on a decision-distinction claim alone.**
If the canonical signature matches an existing row, the candidate is
`identical_existing` and is not admitted — even when its `decision_distinction`
argues for a new criterion. Such a row is emitted as `REVIEW`: it is either a
canonicalizer defect or a genuinely missed surface, and it must be resolved as
one of those, never by keeping a duplicate. See `discovery-protocol.md`.

## Required internal record

Every **authored Prompt route or generation candidate** must carry:

`selection_change_test, shortlist_delta, evidence_refs`

Stage 1 discovery surface candidates are out of scope: they carry only the ten
agent-written columns defined in `discovery-protocol.md`, and their equivalent
judgement is the `product_impact_code` above. These fields become required once
an accepted discovery surface reaches the Prompt authoring phase.

`shortlist_delta` must describe the actual product-selection change, not merely
repeat an intent-family label. Missing or generic values are blocking review
issues in the final audit.

## Stopping rule

Mode-specific:

- `minimal_dedup`: after all evidence-backed differences are represented, stop.
- `geo_full_coverage`: representing the known evidence-backed differences is
  **not** a stopping condition — that is the initial baseline, not the frontier.
  Stop only when coverage obligations are closed AND the discovery frontier is
  exhausted, or under an approved `PASS_WITH_BACKLOG`. See `coverage-loop.md`.

In both modes, do not fill every possible combination of audience, scene, pain,
function, stage, and angle. Stopping late is governed by the gates; padding is
still forbidden by the materiality rules above.
