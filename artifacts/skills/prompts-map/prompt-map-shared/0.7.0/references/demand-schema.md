# Demand Master Schema

Use CSV as the editable source of truth. Required columns:

| Field | Meaning |
|---|---|
| `demand_theme_key` | Stable semantic identifier |
| `canonical_need` | One-sentence user need, without brand bias |
| `people` | Audience or life condition |
| `body_area_or_object` | Body area or product-use object |
| `scenario` | Use context, event, environment, or task |
| `pain_point` | Friction, fear, failure, or unmet result |
| `purchase_stage` | Research, shortlist, comparison, switch, validation |
| `decision_criteria` | What the user uses to choose a product |
| `evidence_posts` | Reddit post IDs/URLs |
| `evidence_comments` | Reddit comment IDs/URLs |
| `semrush_keywords` | Supporting keyword IDs/strings |
| `geoly_topic_ids` | Supporting GEOly Topic IDs |
| `brand_input_refs` | Optional brand source refs |
| `evidence_status` | Allowed status from vocabulary |
| `prompt_eligible` | Yes/No after product-card filter |
| `priority` | High/Medium/Low independent of confidence |
| `confidence` | High/Medium/Low |
| `assigned_topics` | One or more target Topics |
| `review_status` | Pending/Approved/Rejected/Needs review |

## Theme splitting rule

In `geo_full_coverage` (default), split a theme whenever a different person,
scenario, pain point, body area/object, product capability, result expectation,
decision angle, or decision criterion opens a new canonical **query surface** —
even when the product shortlist would overlap. Only merge pure synonyms or
cosmetic wording on the same surface.

In `minimal_dedup` (legacy), split a theme only when such a distinction would
reasonably change which products should be shortlisted. In both modes, do not
split for synonyms or cosmetic wording changes.

## Coverage universe

The demand master may contain non-Prompt content themes, but only rows with `prompt_eligible=Yes` move into the product-card Prompt Map. Keep excluded rows for auditability.

## Evidence Index schema (`work/02_evidence_index.csv`)

The evidence index is the raw, per-evidence-unit record behind the demand
master. It is also the **sampling frame for the Coverage Floor** (Gate A), so it
must be complete and stable, not a convenience by-product.

| Field | Meaning |
|---|---|
| `evidence_id` | Stable unique ID for this evidence unit; the hash-ordering key for floor sampling |
| `source_type` | `reddit`, `semrush`, `geoly`, or `brand` |
| `source_record_id` | The source's own identifier (post ID, keyword row ID, public prompt ID, document ref) |
| `cluster_id` | Demand-clustering key; for Reddit defaults to `post:<post_id>` — see `value-rubric.md` |
| `evidence_text` | The verbatim or minimally normalized evidence text |
| `source_metric` | Semrush monthly volume; may be empty for other source types |
| `source_url` | Traceable source URL where one exists |
| `demand_theme_key` | Link to the demand master row this evidence supports, when assigned |
| `floor_candidate` | `Yes` / `No` — set to `Yes` by the demand extractor for any row that **could** express purchase demand |

`floor_candidate` is a permissive pre-filter, not a judgement: it defines what
may enter the sampling frame. Eligibility is decided per sampled row during the
floor pass, using the closed `exclusion_reason` enum in
`coverage-floor-sampling.md`.

Naming note: `source_type = brand` covers all brand material, but only
**quantified independent customer cases, support tickets, and customer
interviews** map to the `brand_customer` demand source family in the value
rubric. Brand FAQ, feature, marketing, and positioning material never does —
see `evidence-policy.md` and `value-rubric.md`.

### Counting conventions (the script recomputes D from these)

The demand buckets in `value-rubric.md` are recomputed from this index, so
`cluster_id` is not free-form. Two conventions decide bucket boundaries, and
getting them wrong silently mis-scores `D`:

- **GEOly.** A `cluster_id` prefixed `topic:` or `card:` counts toward
  `geoly_topic_or_card_count`. Any other `cluster_id` on a `geoly` row counts as
  a **public prompt**, toward `geoly_public_prompt_count`. Each public prompt ID
  counts once.
- **Brand.** A `brand` row counts as one quantified independent customer case
  **only if it carries a `cluster_id`**. Brand rows with an empty `cluster_id`
  are not counted at all — they are unquantified material, which scores 0.00 by
  policy.

Reddit clustering (`post:<post_id>` by default) is defined in `value-rubric.md`.

Deleting or re-filtering evidence-index rows to make a floor batch easier to
pass is a convergence failure, not a cleanup.
