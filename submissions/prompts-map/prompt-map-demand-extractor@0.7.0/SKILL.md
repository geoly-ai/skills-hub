---
name: prompt-map-demand-extractor
description: Extract a traceable category demand universe and the standardized evidence index from normalized Reddit VOC, Semrush keywords, GEOly evidence, and optional brand material. Emits the cluster IDs, source metrics, and floor candidates the Coverage Floor gate and the discovery value rubric recompute from. Use before generating prompts or after source evidence changes.
---

# Prompt Map Demand Extractor

Read `../prompt-map-shared/SKILL.md` first, then the shared evidence policy, demand schema, coverage-floor sampling doc, value rubric, status vocabulary, and handoff schema under `../prompt-map-shared/references/` (`prompt-map-shared` installs as a sibling skill).

## Procedure

1. Read posts, selftext, and comments. Extract people, body area/object, scenario, pain point, desired outcome, purchase stage, switching behavior, and decision criteria.
2. Use Semrush to validate language and relative scale, and to discover modifiers or needs missing from Reddit. Do not delete Reddit-only long-tail demand.
3. Use GEOly public prompts and Topics to add product-card language, known Topics, and evidence IDs. Do not limit the demand universe to GEOly Topics.
4. Use optional brand features and audience notes to propose underlying needs. Label unsupported inferences `待验证假设`.
5. Build canonical demand themes. In `geo_full_coverage` (default), split
   whenever a distinction opens a new canonical **query surface** (a different
   audience, body area/object, attribute/condition, scenario, decision angle, or
   decision criterion) — even if the product shortlist would overlap; only merge
   pure synonyms / cosmetic wording on the SAME surface. In `minimal_dedup`
   (legacy), split only when a distinction could change the product shortlist or
   ranking. Never let shortlist overlap collapse two distinct GEO surfaces this
   early — it is upstream of the surface registry and cannot be recovered later.
6. Apply the product-card eligibility filter while preserving excluded content needs for traceability.
7. Propose new internal demand Topics when evidence does not fit an existing GEOly Topic. Mark them for human approval and document how they differ.
8. Emit the standardized evidence index (below). It is a **required** input to
   Gate A (Coverage Floor sampling) and to the discovery value rubric's D bucket —
   without it neither can be recomputed and the run cannot converge.

## Evidence index contract

`work/02_evidence_index.csv` has exactly these columns:

```
evidence_id, source_type, source_record_id, cluster_id, evidence_text,
source_metric, source_url, demand_theme_key, floor_candidate
```

- `evidence_id` — unique within the index and **stable across re-extractions**:
  the same source record must keep the same `evidence_id`, or the deterministic
  floor sample silently changes between runs. Never reuse one `evidence_id` for a
  different source record.
- `source_type` — closed enum `reddit` / `semrush` / `geoly` / `brand`.
- `source_record_id` — the normalizer's row identity: Reddit `post_id` /
  `comment_id`, the normalized Semrush keyword row ID, the GEOly public prompt ID
  or topic/card record ID, the brand document/case ID.
- `cluster_id` — the demand-strength counting unit (see below).
- `evidence_text` — the verbatim snippet a human can re-read to re-judge the row.
  Never a paraphrase written by the agent.
- `source_metric` — Semrush monthly volume for `semrush` rows; may be empty for
  other source types. Never substitute CPC, KD, or position for volume.
- `source_url` — the traceable public URL where one exists.
- `demand_theme_key` — the canonical theme this row supports.
- `floor_candidate` — `Yes` / `No`.

### cluster_id rules

Cluster IDs exist so demand strength counts *independent* demand, not volume of
text. Reddit score, upvotes, and comment counts NEVER change a bucket.

- **Reddit — default `post:<post_id>`.** Every comment on one post belongs to
  that post's cluster. Promote a comment to its own `comment:<comment_id>`
  cluster ONLY when it demonstrably has **both** a different author **and** a
  different purchase decision. Same author, or a restatement of the post's
  decision, stays in the post cluster.
- **Semrush — one cluster per unique normalized keyword row.** A repeated export
  of the same keyword counts once; `semrush_monthly_volume` is the sum of volume
  over unique normalized keyword rows for the same canonical need.
- **GEOly — the `cluster_id` prefix decides which counter the row feeds.** A
  `cluster_id` starting `topic:` or `card:` counts toward
  `geoly_topic_or_card_count`; anything else counts as a public prompt toward
  `geoly_public_prompt_count`. Each public prompt ID counts once. Get the prefix
  wrong and the script recomputes the wrong `D_geoly` bucket — this is a scoring
  error, not a cosmetic one.
- **Brand — one cluster per independent, quantified customer case, support
  ticket, or customer interview, and the `cluster_id` is mandatory to be
  counted.** A brand row with an empty `cluster_id` contributes nothing to
  `brand_customer_case_count`; that is exactly how unquantified brand material is
  kept out of the demand math, so never invent a `cluster_id` to make a brand row
  count. FAQ pages, feature pages, spec sheets, and marketing copy are NOT demand
  evidence: index them for traceability with `floor_candidate=No` and no
  `cluster_id`. A brand source can never on its
  own reach the top demand bucket.

### floor_candidate rules

`floor_candidate=Yes` is deliberately **wide**: set it for any row that *could*
express purchase demand, not only rows already confirmed eligible. The Coverage
Floor draws its sample from `floor_candidate == Yes` rows, and the audit — not the
extractor — decides `eligible` / `exclusion_reason` per sampled row. Marking a
plausible row `No` here silently shrinks the recall denominator and is a
convergence-by-denominator-shrinking violation.

Set `floor_candidate=No` only for rows that clearly cannot express purchase demand
at all: pure brand marketing/FAQ/spec copy, non-category content, empty or
unreadable text, and exact duplicate evidence already indexed under another
`evidence_id`.

## Outputs

- `work/02_demand_master.csv`
- `work/02_evidence_index.csv`
- `work/02_summary.md`

The summary reports source coverage, verified/long-tail/hypothesis counts,
proposed Topic changes, excluded non-shopping needs, unresolved theme splits, and
the evidence-index counts by `source_type`, by distinct `cluster_id`, and by
`floor_candidate`. If a source family is absent entirely, name it so the
orchestrator can record `reduced_evidence_sources` — a project with no Semrush
input at all is **permanently capped at** `PASS_WITH_BACKLOG` with no
human-approval upgrade to a normal `PASS`, and brand material may never
substitute for Semrush.

Do not generate Prompts in this module.

## Blocking rules

Pause when a normalized evidence row cannot be traced to a source, Reddit
posts/comments cannot be distinguished, `post_id` / `comment_id` / author is
missing so `cluster_id` cannot be assigned, the market is mixed, or a proposed
demand theme has neither evidence nor an explicit hypothesis label. Do not hand
off a demand master with blank `demand_theme_key`, `evidence_status`, or
`prompt_eligible` fields, and do not hand off an evidence index with a blank
`evidence_id`, `source_type`, `cluster_id`, or `floor_candidate`.

**Stop, don't guess.** Never invent a cluster count, a volume figure, or an
evidence snippet to fill a column.

End with the HandoffContract — including `CoverageFloor`, `DiscoveryFrontier`,
`ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and `ProtocolVersion` — and
wait for approval.
