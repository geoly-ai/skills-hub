---
name: prompt-map-semantic-dedupe
description: Remove exact and semantic duplicate product-card prompts while preserving distinct people, scenes, pains, results, and purchase-decision angles, and while carrying discovery lineage through so the final map provably remains an additive superset of every accepted discovery surface. Use after coverage is accepted or after prompt edits.
---

# Prompt Map Semantic Dedupe

Read `../prompt-map-shared/SKILL.md` first, then the shared geo-coverage-mode
doc, discovery protocol, dedupe rules, shortlist-difference test, demand schema,
prompt schema, product-card rules, and handoff schema under
`../prompt-map-shared/references/` (`prompt-map-shared` installs as a sibling
skill).

In `geo_full_coverage` (default), merge only TRUE duplicates: exact normalized
text, or an identical canonical query surface (audience × body-part × attribute ×
scenario × decision-angle × decision-criterion after canonicalization). Two rows
that share a product shortlist but differ in surface are NOT duplicates — keep
both. Same-surface near-duplicates go to REVIEW, not automatic merge. In
`minimal_dedup`, apply the legacy shortlist-based merge below.

Run this only after the full Category-plus-Topic expansion, base coverage audit,
decision-angle expansion audit, and the promoted discovery rounds. Do not use a
base-cell-only audit as proof that a Prompt can be safely merged.
Do not use dedupe to reduce the Prompt Map to a fixed size.

## Discovery lineage must survive dedupe

Dedupe is the one place where an accepted discovery surface could silently
disappear between the ledger and the delivered map, which would let a run "close
the frontier" without producing. Three rules make that impossible:

1. **Lineage passes through.** Every surviving row carries its internal fields
   forward unchanged: `surface_origin`, `introduced_round`,
   `discovery_candidate_id`, `frontier_value_score`, and `derivation_rule_id`.
   When rows merge, the kept row inherits the union of the merged rows' lineage
   values (all `discovery_candidate_id`s, the earliest `introduced_round`, and the
   highest `frontier_value_score`); nothing is dropped because the kept row
   happened to be a baseline row.
2. **Additive-superset invariant.** The set of canonical surface signatures
   covered by `05_prompt_final.csv` MUST contain every accepted discovery surface
   signature from every promoted round's `04_accepted_surfaces.csv`. This is a
   coverage superset over signatures, not a text-level superset over Prompt rows:
   a merge is legal only when the kept row's canonical signature already covers
   the merged row's signature. If a merge would remove the last row covering an
   accepted discovery signature, it is blocked — no exceptions, no human override
   inside this module.
3. **Ledger carries round, value, and origin.** Every row of
   `05_candidate_surface_ledger.csv` carries `round_id` / `introduced_round`,
   `frontier_value_score`, `surface_origin`, `discovery_candidate_id`,
   `prompt_id` (repointed to the kept Prompt on a merge), `disposition`, and
   `reason`, so the verifier can recompute coverage of accepted surfaces without
   trusting this module's summary.

A high `frontier_value_score` is a reason to look harder before merging, never a
reason to merge. Never merge two rows solely because they share a Topic and a
value score.

## Procedure

1. Normalize case, punctuation, category synonyms, people, scenarios, and criteria without changing source rows.
2. Build the canonical semantic key for every candidate. The key must reflect
   the concrete selection criterion, not just the intent-family label.
3. Remove exact duplicates automatically only within the same delivery route
   and demand theme; identical wording across Topics must be rewritten or
   reviewed rather than silently dropped.
4. For near duplicates, apply the shortlist-difference test. Merge only when the
   canonical query surface is identical (GEO) / the same need would produce the
   same shortlist/ranking and the same Category/Topic route (minimal). A
   different intent label such as `feature` versus `scenario` on the same surface
   is not sufficient evidence to keep both rows.
5. Decide what to preserve by mode. In `geo_full_coverage` (default), preserve a
   row whenever it carries a distinct canonical **query surface** (different
   audience, body area/object, attribute/condition, scenario, decision angle, or
   decision criterion) — even if `shortlist_delta` is unchanged because the
   product rationale overlaps. In `minimal_dedup` (legacy), preserve a row only
   when it adds a meaningful body area/object, person, scene, pain, product
   capability, result expectation, purchase stage, tradeoff, Topic lens, or
   criterion that changes `shortlist_delta`. In both modes a recommendation,
   feature-selection, comparison, review, value, ease, or switch lens is not
   automatically distinct merely because the intent label differs on the SAME
   surface.
6. Prefer the most natural, specific, and evidence-backed wording. Merge evidence references into the kept row.
7. Keep category prompts out of Topic sheets unless a Topic-specific constraint changes the decision.
8. Isolate and dedupe brand-comparison prompts within their optional Topic.
9. Never collapse rows by `decision_criteria` alone. A merge requires a
   row-level ledger with source Prompt IDs, the kept Prompt ID, and evidence of
   an identical canonical query surface (GEO) / that the same user need would
   receive the same shortlist and ranking (minimal).
10. Before emitting outputs, verify the additive-superset invariant: every
    accepted discovery surface signature from every promoted round is still
    covered. Report the check result — accepted-surface count, covered count, and
    any uncovered signatures — in `05_summary.md`.

## Outputs

- `work/05_prompt_registry.csv`
- `work/05_dedupe_report.csv`
- `work/05_prompt_final.csv`
- `work/05_prompt_angle_links.csv` — the surviving angle links carried forward
  from `03_prompt_angle_links.csv` for the deduped prompt set (consumed by the
  final-audit / delivery integrity gate).
- `work/05_candidate_surface_ledger.csv` (GEO mode) — the candidate→surface
  ledger carried forward from `03_candidate_surface_ledger.csv` and every promoted
  round's `03_discovery_ledger.csv`, with merged rows updated to point at the kept
  `prompt_id` and carrying `round_id` / `introduced_round`, `surface_origin`,
  `discovery_candidate_id`, and `frontier_value_score` (consumed by the same
  gate).
- `work/05_summary.md`

Do not declare the workflow complete. Set the next consumer to
`prompt-map-coverage-audit` in `post-dedupe-final` mode.

End with the HandoffContract — including `CoverageFloor`, `DiscoveryFrontier`,
`ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and `ProtocolVersion` — and
wait for approval.

## Blocking rules

Pause when a candidate has no canonical key (GEO: no complete query surface /
neutral `decision_criterion`; minimal: no `shortlist_delta`), a Topic lacks a
natural Topic delta, a near duplicate may represent a different surface (GEO) or
shortlist/ranking (minimal), a row is in the wrong category, or dedupe would
remove the only Prompt covering an approved demand surface. Return the ambiguity to human review; do not
force a merge. Also pause when a row is missing its discovery lineage fields, when
a merge would break the additive-superset invariant, or when a promoted round's
`04_accepted_surfaces.csv` cannot be read. If an automatic pass would remove more
than 20% of upstream candidates, stop and require pairwise review instead.

**Stop, don't guess.** Never assume a discovery surface is covered by a
similar-looking baseline Prompt; verify the canonical signature.
