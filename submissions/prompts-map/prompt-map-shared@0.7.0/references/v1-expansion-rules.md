# First-Version-Compatible Expansion Rules

These rules restore the accepted first-version Prompt Map behavior while
keeping the workflow auditable and reusable across brands and categories.

> **Coverage mode.** The default is `geo_full_coverage` (see
> `geo-coverage-mode.md`): the distinctness unit is a **query surface**, so two
> routes with the same `shortlist_delta` but a different surface (audience /
> body-part / attribute / scenario / decision-criterion) ARE distinct rows and
> are both kept. The `shortlist`-change language below is the `minimal_dedup`
> legacy posture; read it as "changes the query surface" in GEO mode.

## Two-layer expansion

For every product-card-eligible demand theme:

1. Generate a cross-Topic `Category` route when the need applies across more
   than one Topic.
2. Generate a separate `Topic` route for every approved evidence-backed Topic
   assigned to that need.

The Topic route is not a copy quota. It must express the Topic's language,
body area, audience, scene, pain, function, or ranking criterion so it opens a
new query surface (GEO) / the recommended product shortlist could change
(minimal).

## Decision-angle depth

Treat recommendation, feature-filter, results/timeline, comparison,
review/reliability, value/budget, scenario-fit, ease/maintenance/adherence,
risk/concern, compatibility, availability/access, first-time, switching,
versus-alternative, and best-overall as labels for evidence-backed routes.

In `geo_full_coverage`, create an angle route when the angle plus its concrete
decision criterion opens a **new canonical query surface** for the relevant
audience, body/object, attribute/condition, scenario, Topic, or purchase stage.
The product shortlist may overlap another route — shortlist overlap is not a
dedupe reason. In `minimal_dedup`, create an angle only when the evidence-backed
criterion materially changes the product shortlist or ranking lens.

In both modes, never create an angle from a label alone: a row needs a concrete
criterion, evidence references, product-card eligibility, and a valid surface (or
shortlist) decision record. Never apply the complete angle list to every demand
theme without evidence.

The stopping rule is mode-specific:

- `geo_full_coverage`: stop when **coverage obligations are closed AND the
  discovery frontier is exhausted**, OR when an approved `PASS_WITH_BACKLOG` is
  in force. Obligations are closed when every approved evidence-backed canonical
  query surface, every accepted discovery surface in the living registry, and
  every high-priority Topic intersection is either **covered** or **explicitly
  waived**. An item parked in `REVIEW` is NOT closed — it stays in
  `unresolved_query_surface_gap_count` / `unresolved_intersection_gap_count`, and
  a non-zero count blocks both `PASS` and `PASS_WITH_BACKLOG`. Exhausting the
  initial surface inventory is NOT a stopping condition — see `coverage-loop.md`
  and `geo-coverage-mode.md`.
- `minimal_dedup`: stop after every evidence-backed shortlist/ranking distinction
  is represented.

In neither mode do synonyms, word order, intent labels, generic Topic suffixes,
or unsupported Cartesian combinations create additional Prompts. A data-rich
category commonly yields hundreds of surfaces; quantity is an outcome of
coverage, never a target quota.

## Topic and category boundaries

- Category prompts stay broad and reusable across Topics.
- Topic prompts may adapt the same underlying need when the Topic lens changes
  the product shortlist; preserve those rows until semantic audit.
- Never replace an existing accepted GEOly/internal Topic with a new umbrella
  label just because a comparison Topic is useful.
- A separate `Brand Comparison` Topic is allowed only when neutral comparison
  evidence exists and the project has approved that sheet.

## Rewritable VOC

Content-adjacent VOC may become a product-card Prompt when the source shows a
real device-selection decision. Examples include eye/eyebrow safety,
skincare compatibility, preparation, tattoos or dark areas, privacy burden,
and emotional confidence. Pure education, medical advice, or method-only
questions remain out of the Prompt Map.

## Anti-Cartesian rule

Do not construct Prompts by multiplying demand themes by Topics by intent
families. The generation unit is an evidence-backed purchase task. First write
the task and its concrete selection constraint; only then assign its delivery
route and intent label. In `minimal_dedup`, two routes with the same
`shortlist_delta` are not distinct unless the Topic adds a real ranking lens. In
`geo_full_coverage`, two routes with the same `shortlist_delta` ARE distinct when
their canonical query surface differs — the guard is against identical surfaces
and pure synonyms, not against a shared product-selection rationale.

## Dedupe timing

Do not semantically dedupe Category and Topic routes before coverage expansion.
First preserve the full route-aware candidate set, then merge only genuinely
identical product-selection decisions. This is the rule that prevents a
data-rich run from collapsing into a small list of generic prompts.
