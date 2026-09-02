# Prompt Schema

Use one canonical CSV schema from draft through delivery. Required fields:

| Field | Meaning |
|---|---|
| `prompt_id` | Stable unique row identifier |
| `prompt_en` | Natural English user question |
| `prompt_zh` | Direct Chinese translation |
| `level` | `Category` or `Topic` |
| `topic` | Approved Topic name; blank only for category rows |
| `demand_theme_key` | Link to demand master |
| `demand_cell_id` | Link to the auditable demand-cell registry |
| `people` | Audience/condition |
| `body_area_or_object` | Body area or product-use object |
| `scenario` | Use context/event/environment |
| `purchase_stage` | User decision stage represented by the Prompt |
| `pain_point` | User friction/fear/failure |
| `decision_criteria` | Product-selection criterion |
| `audience` | GEO surface field: who is asking (canonical; may mirror `people`) |
| `body_part_or_object` | GEO surface field: part/object treated or served (`general` when cross-part) |
| `attribute_or_condition` | GEO surface field: gating attribute (skin tone, hair type, material; `none` when not gated) |
| `decision_angle` | GEO surface field: the buy-decision lens (a broad class from the angle grid) |
| `decision_criterion` | GEO surface field: the CONCRETE selection criterion under that angle |
| `evidence_sources` | GEO: which sources support the row (`geoly,reddit_voc,semrush,brand`) |
| `selection_change_test` | `different`, `same`, `unknown`, or (GEO) `surface_distinct` versus the nearest existing surface |
| `shortlist_delta` | Concrete explanation of how this Prompt changes product shortlist or ranking |
| `topic_delta` | Natural Topic-specific constraint; required for Topic rows |
| `intent_family` | Recommendation, feature, scenario, results, comparison, review, value, ease, switch |
| `evidence_refs` | Traceable source IDs |
| `evidence_status` | Shared status vocabulary |
| `hypothesis_flag` | Yes/No |
| `product_card_eligible` | Yes/No; delivery requires Yes |
| `generation_mode` | Initial/Supplement/Rewrite |
| `gap_id` | Required for supplement rows |
| `canonical_key` | Semantic registry key after dedupe |
| `review_status` | Pending/Approved/Rejected/Needs review |

In `geo_full_coverage` the canonical query-surface signature is
`audience | body_part_or_object | attribute_or_condition | scenario | decision_angle | decision_criterion`;
these six must be present (no null-faking) — see `geo-coverage-mode.md`.

**Conditional surface dimensions** (optional, formal): `purchase_stage`,
`budget_tier`, `product_format_or_compatibility`,
`comparison_target_or_alternative`, `result_time_horizon`. They join the surface
signature ONLY when present and non-neutral. An empty value means "this
dimension does not apply / imposes no constraint" — it never means "unknown".
Populate a conditional dimension on both rows of a comparison, or on neither, so
an omission does not fabricate a distinct surface.

## Internal discovery fields (never delivered)

These five fields trace a Prompt back to the discovery round that produced its
surface. They are **internal only** — they must never appear in the visible
workbook or in any delivery column set.

| Field | Meaning |
|---|---|
| `surface_origin` | `baseline` (from the initial coverage baseline) or `discovery` (appended by a verified discovery round) |
| `introduced_round` | The round that introduced the surface, `rNN`; empty for baseline rows |
| `discovery_candidate_id` | The Stage 1 candidate ID this surface came from; joins the Prompt to its round ledger |
| `frontier_value_score` | The script-computed `V` for the surface at acceptance time; never agent-written, never recomputed at delivery to flatter the result |
| `derivation_rule_id` | Required when the surface's `support_mode` was `derived`; must be a pre-approved rule |

They exist so the final gate can verify that every accepted discovery surface
actually landed in the map (`discovery-protocol.md`,
`generation-integrity.md`). Dropping them breaks the reconciliation and is a
blocking failure, not a schema simplification.

Do not change Prompt text after approval without updating `prompt_id` version or recording the edit in the dedupe/audit report.
