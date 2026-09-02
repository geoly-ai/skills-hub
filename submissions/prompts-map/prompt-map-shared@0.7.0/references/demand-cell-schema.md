# Demand Cell Schema

The demand-cell registry is an internal coverage contract between the accepted Prompt base and coverage audit. It prevents an entire demand theme from being overlooked, but it is not a Prompt-generation quota.

Required fields (the six canonical surface fields —
`audience, body_part_or_object, attribute_or_condition, scenario, decision_angle,
decision_criterion` — must use exactly these column names so
`validate_generation_integrity.py` / `_surface.py` can canonicalize them; the
earlier `people` / `body_area_or_object` names are retired):

| Field | Meaning |
|---|---|
| demand_cell_id | Stable unique cell identifier |
| demand_theme_key | Parent canonical demand theme |
| level | Category or Topic routing target |
| topic | Approved Topic; blank for category-level cells |
| audience | Specific audience or persona represented by the cell (canonical surface field) |
| body_part_or_object | Specific body area or object represented by the cell (canonical surface field) |
| attribute_or_condition | Specific attribute/condition/state represented by the cell (canonical surface field) |
| scenario | Use context, event, environment, or lifecycle context (canonical surface field) |
| pain_point | Concrete friction, fear, failure, or unmet need |
| purchase_stage | Research, shortlist, fit-validation, comparison, switch, or post-purchase validation |
| decision_angle | Recommendation, feature, scenario, results, comparison, review, value, ease, or switch |
| decision_criterion | Criterion that could change the product shortlist or ranking |
| evidence_refs | Reddit, Semrush, GEOly, or brand references supporting the cell |
| evidence_status | Verified, Long-tail, Hypothesis, or Excluded |
| hypothesis_flag | Yes only when the cell is an accepted inference |
| product_card_eligible | Yes only if the question can naturally return purchasable products |
| cell_status | Open, Covered, Waived, or Review |
| waive_reason | Required when a cell is waived |

## Cell construction rules

1. A theme is not a cell. Split a theme when audience, body area, scenario, pain, purchase stage, or decision angle could change the shortlist or ranking.
2. In `geo_full_coverage`, one cell = one canonical query surface (`audience × body_part_or_object × attribute_or_condition × scenario × decision_angle × decision_criterion`, plus any present conditional dimensions: `purchase_stage`, `budget_tier`, `product_format_or_compatibility`, `comparison_target_or_alternative`, `result_time_horizon` — empty means "not applicable", not "unknown"); enumerate the full evidence-backed surface grid plus high-value Topic intersections (see `geo-coverage-mode.md`). Do not create the full mechanical Cartesian product without evidence, but do not collapse distinct evidence-backed surfaces just because their product shortlists overlap.
3. A single need may have multiple cells across purchase stages when the user question would cause a different product decision: first shortlist, comparison, fit validation, switching, or post-purchase replacement.
4. A cell is not complete because it has many wordings. It is complete when one approved Prompt covers the distinct decision, even if that Prompt is linked to several related cells.
5. Content-only, medical-only, method-only, and service-only cells remain traceable but are not Prompt-eligible.
