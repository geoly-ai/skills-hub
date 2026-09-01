# Generation Integrity Contract

This contract prevents a cold-start run from turning demand themes, Topics, and
intent labels into a **meaningless** Cartesian-product Prompt matrix. It is
mode-aware (see `geo-coverage-mode.md`).

> **`geo_full_coverage` (default):** the distinctness unit is a canonical query
> surface. A candidate is kept for every NEW evidence-backed surface, even when
> the product shortlist overlaps. Rows must also carry the surface fields
> `audience, body_part_or_object, attribute_or_condition, scenario,
> decision_angle, decision_criterion`. `selection_change_test` may be
> `surface_distinct`. The guard below fires only against IDENTICAL surfaces and
> pure synonym / intent-label swaps on the SAME surface — not against a shared
> product-selection rationale across different surfaces.
>
> **`minimal_dedup` (legacy):** the distinctness unit is the product shortlist,
> exactly as written below.

## The initial inventory is an input baseline (GEO mode)

In `geo_full_coverage`, the canonical **surface inventory**
(`02b_surface_inventory.csv`) and the Topic-intersection list
(`02b_topic_intersections.csv`) are *inputs* to generation, not by-products of
it — but they are an **initial coverage baseline, not a discovery ceiling**. The
registry is a **living registry** that may only be extended through a **verified
discovery ledger** (`discovery-protocol.md`), never by free-hand addition.

The generator must:

1. Read the initial inventory first and treat every eligible surface + approved
   intersection as a coverage obligation.
2. Extend the registry only via accepted discovery-ledger rows, carrying
   `surface_origin=discovery`, `introduced_round=rNN`, `cell_status=open`,
   `frontier_value_score`, and `discovery_candidate_id`.
3. Link each emitted Prompt to the surface signature(s) it covers.
4. Keep a candidate→surface ledger recording, per candidate, whether it was
   `accepted` (opens a new surface), `merged` (identical surface as an existing
   Prompt), or `rejected` (no surface / evidence). This ledger feeds the
   reduction-safety reconciliation below. It never produces a convergence
   statistic — see `coverage-loop.md`.

Finishing the initial inventory is **not** finishing the map. A run that stops
there has an unresolved discovery obligation, not a converged result.

## Discovery ledger invariants the validators must enforce

The full column contract, the two-stage split, the novelty algorithm, and the
round file ordering live in `discovery-protocol.md`. Do not restate them here.
The validators must independently verify:

1. **Stage 1 completeness** — exactly `K` rows, every probe family at its fixed
   quota, candidate and slot IDs unique and complete, every row carrying a
   non-empty `decision_distinction`. Rejects stay in the ledger with reasons.
2. **Stage set equality** —
   `set(ids where novelty_status == new) == set(ids in 02_discovery_values.csv)`.
3. **Base snapshot anchoring** — novelty was recomputed against that round's
   `base_map_sha256 = sha256(00_base_prompts.csv)`. Anchoring to
   `03_prompt_draft.csv` or `05_prompt_final.csv` is invalid: those files are
   overwritten during the round and would let the baseline drift.
   `base_registry_sha256` anchors `00_base_registry.csv` the same way.
4. **Derived-field independence** — `E`, `D`, `P`, `T`, `value_score`,
   `materiality_pass`, `value_gate_pass`, `disposition`, and all novelty fields
   were script-computed, not agent-written.
5. **Accepted surface → registry reconciliation** — every row in
   `04_accepted_surfaces.csv` appears in the living registry with
   `surface_origin=discovery` and the correct `introduced_round`.
6. **Registry → Prompt reconciliation** — every accepted discovery surface is
   either linked to a valid Prompt (`cell_status=covered`,
   `covered_prompt_ids` non-empty) or carries `cell_status=open` with a
   `SUPPLEMENT` gap. Silently dropping an accepted surface is a blocking
   failure: a probe must not "discover" without producing.
7. **Additive superset** — the final map covers every accepted discovery surface
   from every prior round. Later rounds may add coverage; they may never remove
   it.
8. **`K` / family slot completeness across the streak** — the streak's rounds
   share one streak-comparable protocol fingerprint, one `K`, and one family
   quota table. `K` and `family_quotas` are immutable profile constants: a round
   manifest that redefines either is an **integrity failure**, not a streak
   reset. For the fingerprint members that *can* change, and which of those cost
   a full re-run of history, see "Protocol changes and the streak" in
   `coverage-loop.md`.

## Template and anti-bloat guards run in three phases

Running the template validator against structured discovery surfaces produces
noise, because those rows have no prompt text yet.

- **Discovery surface phase** (structured surfaces, no prompt text) — run only
  exact canonical duplicate, identical canonical signature, and invalid/null
  surface checks. Do **NOT** run the template validator here.
- **Prompt authoring phase** (accepted discovery surfaces only) — run
  `validate_shortlist_difference.py`, `validate_generation_integrity.py`, and
  `validate_prompt_surface_quality.py`.
- **Final phase** — the whole map with `--strict`.

`template_review_count == 0` means **every detected REVIEW was rewritten,
merged, or human-resolved** — NOT that the detector never fired. Track all three:

```
template_review_count = template_detected_count - template_resolved_count
```

Only the unresolved count must be zero.

### Scale-aware surface-quality thresholds

Fixed absolute counts fire constantly at 600+ rows, so
`validate_prompt_surface_quality.py` scales with the map:

```
Global exact skeleton: REVIEW if count >= max(8, ceil(total_prompts * 0.03))
Per angle:             REVIEW if n >= 10 and dominant share > 0.50
                       WARN   if n >= 10 and dominant share > 0.35
Per Topic:             REVIEW if skeleton count >= max(5, ceil(topic_n * 0.25))
                       WARN   if skeleton count >= 3
Near-template:         REVIEW if same Topic + same angle + Jaccard >= 0.85
                       WARN   if 0.75 <= Jaccard < 0.85
```

Open discovery does not lower the quality bar. The validator simply stops using
absolute counts as a proxy for density.

## Required route fields

Every **authored Prompt route and generation candidate** must include:

`route_id, route_level, topic, demand_theme_key, demand_cell_id,
selection_change_test, shortlist_delta, evidence_refs, angle_status`

This does **not** apply to Stage 1 discovery surface candidates. A discovery
candidate is a structured surface with no prompt text yet, and its ledger admits
exactly the ten agent-written columns in `discovery-protocol.md` — nothing more.
These route fields become required when an accepted discovery surface enters the
Prompt authoring phase.

`selection_change_test` must be `different`, `same`, `unknown`, or (GEO mode)
`surface_distinct`. Required routes may only be `different` / `surface_distinct`;
`same` routes must be removed or rewritten; `unknown` routes must stop for review.

`shortlist_delta` must explain the concrete product-selection change. Values
such as `different intent`, `Topic angle`, `better fit`, or a bare intent-family
label are not sufficient.

## Blocking checks

The generator and audit must block when:

1. Every theme has been assigned the same standard intent-family list without
   evidence-specific criteria or a distinct surface per row.
2. A Topic Prompt differs from its Category Prompt only by a parenthetical
   suffix or generic scene wording.
3. A candidate has no explicit shortlist delta (GEO mode: no `decision_criterion`).
4. A near duplicate is kept only because its intent-family label differs **on the
   same canonical surface** (GEO mode: a different surface is not a duplicate).
5. A route is linked to a Prompt but its selection-change test is `same` or
   `unknown`.
6. A rewrite or dedupe step removes a large share of candidates without a
   row-level merge ledger containing source Prompt IDs, the same-shortlist
   reason, and the kept Prompt ID. Grouping by `decision_criteria` alone is
   never a valid merge proof.

Coverage means all evidence-backed query surfaces (GEO mode) / purchase tasks
(minimal mode) are represented — across Category, all Topics, and evidence-backed
Topic intersections. It does not mean every theoretical combination of axes or
every standard intent family is present without evidence.

## Reduction safety

Shortlist-aware review is an audit step, not a quota-reduction step. If an
automatic rewrite would remove more than 20% of the upstream candidates, stop
and request pairwise review. The final audit must reconcile:

`source_prompt_count = kept_count + merged_count + explicitly_rejected_count`
