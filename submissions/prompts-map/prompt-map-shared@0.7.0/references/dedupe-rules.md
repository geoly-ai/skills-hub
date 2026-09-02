# Semantic Dedupe Rules

> **Coverage mode.** In `geo_full_coverage` (default) the canonical dedupe key is
> the query surface `audience | body_part_or_object | attribute_or_condition |
> scenario | decision_angle | decision_criterion` (+ present conditional
> dimensions), canonicalized by `scripts/_surface.py`. Merge ONLY exact-text or
> identical-surface duplicates; a shared product shortlist across different
> surfaces is not a duplicate. The shortlist-based key below is the
> `minimal_dedup` (legacy) behavior.

## Canonical semantic key (minimal_dedup)

Build the key from normalized values:

`level | topic | demand_theme_key | demand_cell_id | decision_criteria | shortlist_delta`

The broader evidence fields remain attached to the registry for audit. The
route fields above are mandatory because Category and Topic variants must not
be collapsed before their Topic-specific decision lens is checked.

Maintain the canonical key in `work/05_prompt_registry.csv` so later Topics and future runs can test against previously approved prompts.

## Decisions

- `KEEP`: opens a new query surface (GEO) / adds a real person, scene, pain, body area/object, product capability, result expectation, tradeoff, or decision criterion that changes the shortlist or ranking (minimal).
- `MERGE`: identical canonical surface (GEO) / same need and decision outcome (minimal), with only wording or order changes. Keep the clearer, more natural Prompt and merge evidence references.
- `REVIEW`: high semantic similarity, missing shortlist delta, or a possible meaningful decision distinction.
- `REJECT`: exact duplicate in the same route, wrong category, brand-biased
  claim, or product-card-ineligible. An exact wording repeat across Topics is a
  rewrite/review item until the Topic distinction is resolved.

## Cross-Topic handling

The same generic Prompt must not be copied into multiple Topic sheets. Keep a
cross-Topic need in `品类 Prompt`. In `geo_full_coverage`, a Topic adaptation is
kept when it opens a new canonical query surface (a Topic-specific audience,
condition, scenario, angle, or criterion) — even if the product ranking would
overlap the Category row. In `minimal_dedup`, a Topic adaptation is allowed only
when its constraints or language change the recommended product set or ranking.
In both modes, do not merge Topic adaptations merely because their sentence
frames are similar, and do not keep a bare parenthetical Topic suffix.

Do not merge prompts across different physical-product categories. Brand Comparison stays outside neutral dedupe coverage but is deduped within its own Topic. A different intent-family label is never enough to keep a near duplicate.

## Required report fields

`candidate_prompt_id, kept_prompt_id, similarity_reason, canonical_key, decision, merged_evidence, reviewer_note`.

## Discovery surfaces are protected

Dedupe runs after discovery, so it is the last place an accepted discovery
surface can silently disappear. Three rules:

- **Never delete the only Prompt covering an accepted discovery surface.** If a
  merge would leave a registry row with `surface_origin=discovery` and no
  `covered_prompt_ids`, the merge is invalid. Restore the row, or rewrite the
  kept Prompt so it genuinely covers that surface and re-link it.
- **A merge preserves discovery lineage.** The kept row inherits
  `surface_origin`, `introduced_round`, `discovery_candidate_id`,
  `frontier_value_score`, and `derivation_rule_id` from the merged row when the
  kept row does not already carry them. Merging evidence refs without carrying
  lineage breaks the final gate's accepted-surface reconciliation.
- **Reconcile the final map against the living registry.** After dedupe, every
  accepted discovery surface from every round must still be covered in
  `05_prompt_final.csv`. The final map must be an **additive superset** of
  accepted discovery coverage — later steps may add coverage, never remove it.

See `discovery-protocol.md` and `generation-integrity.md`.

## Final safeguard

After dedupe, rerun coverage audit. If a merge removed the only row covering a distinct demand cell, restore or rewrite that distinction.
