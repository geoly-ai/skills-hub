# GEO Full-Coverage Mode

This is the default coverage doctrine for the Prompt Map matrix. It replaces the
old "minimal, non-redundant product-decision set" posture with **maximum
coverage of distinct GEO query surfaces**: for every different way a shopper
might ask an AI engine about buying this category, the map should carry a
Prompt, so the brand can be tracked and optimized on that answer.

## Coverage modes

`coverage_mode` is declared once per run and recorded in `state/run_state.json`,
every audit artifact, and validator output.

- **`geo_full_coverage`** (default): keep a Prompt when it opens a NEW,
  evidence-backed query surface — even if the recommended product shortlist
  overlaps another Prompt. This is what a brand's GEO Prompt Map needs.
- **`minimal_dedup`** (legacy 0.4.x): keep a Prompt only when it changes the
  product shortlist/ranking. Use for regression against a 0.4.x map, for a
  deliberately condensed deliverable, or when a `revision` run must inherit an
  accepted map built this way. A `revision` run inherits the accepted map's mode
  unless a human approves migration.

Never let the same data change dedupe semantics without a declared mode.

## The unit of coverage: a query surface

A Prompt covers exactly one **query surface**. Its canonical signature has six
required fields; treat empty fields as a defect, not as a new surface:

`audience | body_part_or_object | attribute_or_condition | scenario | decision_angle | decision_criterion`

- **audience** — who is asking (e.g. `first-time buyer`, `exclusive pumper`, `PCOS`).
- **body_part_or_object** — the part/object treated or served (e.g. `bikini`, `face/upper-lip`, `larger breasts`). `general` when truly cross-part.
- **attribute_or_condition** — an attribute of the user/object that gates products (e.g. `dark skin`, `coarse/thick hair`, `sensitive skin`). `none` when not gated.
- **scenario** — the use context that imposes a product constraint (e.g. `at work`, `travel`, `overnight`). A scenario that imposes NO product constraint is dropped, not counted.
- **decision_angle** — the buy-decision lens from the grid below (a broad class).
- **decision_criterion** — the CONCRETE selection criterion under that angle (e.g. `low pain / cooling`, `skin-tone sensor safety`, `results timeline`, `flange size range`). This is what makes two prompts under the same `decision_angle` genuinely different surfaces.

**Conditional dimensions** — add to the signature ONLY when evidence shows they
change the ask; never expand them Cartesian-style: `purchase_stage`,
`budget_tier` (`under $X` vs `premium best-overall` can be different surfaces),
`product_format_or_compatibility`, `comparison_target_or_alternative`,
`result_time_horizon`.

`attribute_or_condition` describes the user/object; `decision_criterion`
describes the purchase filter — keep them distinct.

## Keep / merge rule (replaces "changes the shortlist")

Keep a Prompt when its **canonical surface signature is new**. Merge only when
the canonical signature is identical (a true synonym / word-order / intent-label
variant on the same surface). The same products may appear across many surfaces;
that is expected and correct for GEO.

### Three anti-bloat layers (the anti-Cartesian guard survives, retargeted)

1. **Exact normalized text duplicate** → drop.
2. **Identical canonical surface signature** → merge (keep the most natural, best-evidenced wording).
3. **Same surface, near-identical semantics or template pattern** → send to `REVIEW`, do not auto-keep.

What still does NOT earn a row: a different intent LABEL on the same surface;
`which` → `what are the best` rephrasings; synonyms/word order; a parenthetical
Topic suffix; a broad scene that imposes no product constraint. GEO mode widens
what counts as distinct (any new surface), it does not license meaningless
template spam.

### Canonicalization (do this before dedup)

Normalize before comparing signatures: synonym-fold audiences
(`busy moms`≈`working mothers`), scenarios (`travel`≈`vacation`), and criteria
(`comfortable`≈`low pain` — a criterion, not an attribute); null-normalize empty
vs `none`/`general`; fold parent/child values unless evidence shows the child
ranks products differently; and filter scenarios that impose no product
constraint.

## Decision-angle grid

Enumerate these buy-decision angles; apply the **evidence-supported subset** to
each Topic and audience (never the full grid to every Topic). Each angle ×
concrete `decision_criterion` is a surface.

recommendation · feature/capability-filter · brand-comparison ·
results-and-timeline · budget-value · comfort/pain · scenario-fit ·
long-term/maintenance · risk-concern · ease/adherence · safety-gate ·
compatibility · retail-availability · insurance/access · first-time ·
switching/replacement · vs-alternative (e.g. device vs clinic) · best-overall ·
review/reliability · value-vs-professional

## Topic decomposition

For a data-rich category, decompose demand into **12–16 internal Topics** along
the strongest evidence axes — body-part, attribute/condition, audience/persona,
pain, scenario, access/payment — and do NOT collapse distinct axes into one
Topic. A narrow category may need fewer. Category-level Prompts carry the
cross-Topic surfaces; each Topic sheet carries surfaces specific to its axis.

## Topic-intersection generation

After per-Topic coverage, generate **high-value cross-Topic intersections**
where evidence supports a combined ask (e.g. `dark skin × brazilian`,
`PCOS × face`, `large breasts × wearable`). Each evidence-backed intersection is
a new surface. Keep only intersections with evidence or an explicit
`待验证假设`; do not multiply every Topic pair.

## The surface inventory is a living registry

`02b_surface_inventory.csv` is the **initial coverage baseline**, not a discovery
ceiling. Enumerating it up front bounds the *starting* obligations; it does not
bound what the category contains, because the extractor can only surface what the
input corpus made visible.

- The initial inventory is an input **baseline**. A run that stops when the
  initial inventory is exhausted has not converged — it has merely run out of
  pre-enumerated work.
- The registry is **living**: verified discovery output may append new rows via
  the Discovery Stream ledger. Appended rows carry `surface_origin=discovery`,
  `introduced_round=rNN`, `cell_status=open`, and `frontier_value_score`.
- A **derived material surface** — one composed under an approved
  `derivation_rule_id` from evidenced dimensions — may be appended on the same
  terms as a directly evidenced one. It is still subject to the hard materiality
  gate in `value-rubric.md`.
- A high-value discovery outside the original inventory can **never** be
  rejected merely for being off-inventory.
- Appending a row creates an **obligation**, not coverage. `discovered !=
  covered`; only a linked valid Prompt flips `cell_status` to `covered`. See
  `discovery-protocol.md`.

Convergence is therefore not "inventory exhausted" but "coverage obligations
closed AND discovery frontier exhausted" — see `coverage-loop.md`.

## Expected scale

Scale is an OUTCOME of surface coverage, not a target. A data-rich category
(IPL, breast pumps) is expected to produce **hundreds** of Prompts across
category + 12–16 Topics + evidence-backed intersections. A narrow category
produces fewer. Do not cap to a small deduped list, and do not pad to hit a
number.

## Evidence tiers (3-tier)

Use `已验证` (cross-source or Semrush-supported), `Reddit已验证/长尾` (real
Reddit VOC, weak/absent search volume), and `待验证假设` (inferred / sparse /
uncovered-matrix-cell, retained for later testing). Never promote `待验证假设`
to `已验证` merely because a Prompt was generated. See `status-vocabulary.md`.
