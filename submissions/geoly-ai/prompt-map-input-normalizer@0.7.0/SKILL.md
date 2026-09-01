---
name: prompt-map-input-normalizer
description: Validate, inventory, and normalize Reddit, Semrush, GEOly, and optional brand inputs for one physical-product Prompt Map project, preserving the identity and metric fields the demand D buckets and the Coverage Floor gate must later recompute from. Use before demand extraction or after source files change.
---

# Prompt Map Input Normalizer

Read `../prompt-map-shared/SKILL.md`, `../prompt-map-shared/references/context-contract.md`, `../prompt-map-shared/references/evidence-policy.md`, `../prompt-map-shared/references/value-rubric.md`, `../prompt-map-shared/references/project-layout.md`, and `../prompt-map-shared/references/handoff-schemas.md`.

## Recomputability contract (hard requirement)

Downstream, the discovery value rubric recomputes `D_reddit`, `D_semrush`,
`D_geoly`, and `D_brand` from counts, and Gate A recomputes the Coverage Floor
from an evidence sample. Both are **blocked** if normalization drops any of these:

| must survive | why |
|---|---|
| Reddit `post_id` | the default `cluster_id` is `post:<post_id>` |
| Reddit `comment_id` | needed for a `comment:<comment_id>` cluster promotion |
| Reddit `author` (post and comment) | a comment may only become its own cluster with a **different author** and a different purchase decision |
| Reddit `parent_id` / post↔comment linkage | attaches each comment to its post cluster |
| Semrush `volume` per normalized keyword row | the only field allowed to drive `D_semrush`; CPC, KD, and position may never substitute |
| the original (unstripped) Semrush keyword | duplicate-export detection, so one keyword counts once |
| GEOly public prompt ID | each public prompt ID counts once for `geoly_public_prompt_count` |
| GEOly topic / card record ID and record type | `geoly_topic_or_card_count` |
| a stable per-row source record ID on every source | `source_record_id` in the evidence index |
| a resolvable source URL where one exists | floor-sample re-reading and traceability |

Never aggregate, deduplicate away, or round these away in the name of tidiness.
If a required field is genuinely absent from the source export, record it as a
reduced-evidence limitation in the manifest — do not silently synthesize it.

## Procedure

1. Confirm project identity and inventory every input file without modifying it.
2. Detect Reddit post and comment tables separately. Preserve `post_id`,
   `comment_id`, `author`, `parent_id`, URLs, dates, subreddit, title,
   selftext/body, score, and post↔comment relationships. Score and comment counts
   are context only and never change a demand bucket, but they are still
   preserved.
3. Normalize Semrush exports while preserving the original keyword, volume,
   URL/domain, position, intent, and brand term. Emit **one row per normalized
   keyword**, keeping volume at row level so a repeated export of the same keyword
   can be counted once. Add a normalized brand-stripped keyword; never discard the
   original and never replace volume with CPC, KD, or position.
4. Read the installed `geoly-mcp` Skill and query GEOly MCP for the project category, country, and language. Preserve the public prompt ID, the topic/card record ID, and the record type for every returned row. Cache IDs/exports in `inputs/geoly/` only when useful, and record live query parameters in the manifest. Do not substitute generic web search for GEOly evidence.
5. Read optional brand/competitor files. Mark absent brand files `可补充品牌资料`, not `阻断`.
6. Detect empty files, encoding/column mismatches, duplicate rows, missing IDs, and wrong-country/language data.

## Outputs

- `work/01_input_manifest.json`
- `work/01_normalized/reddit_posts.csv`
- `work/01_normalized/reddit_comments.csv` when available
- `work/01_normalized/semrush_keywords.csv`
- `work/01_normalized/geoly_evidence.csv` when available
- `work/01_normalized/brand_inputs.csv` when available
- `work/01_summary.md`

The manifest records source type, path, row count, schema mapping, hash, market,
warnings, and — per source — which of the recomputability-contract fields are
present, partially present, or absent. A missing required identity or metric field
must appear as an explicit warning, not as a silent gap.

## Blocking rules

Pause if the project identity is incomplete, a required source (Reddit posts, Semrush) or GEOly access is absent/unreadable, or market/language cannot be established. Missing Reddit comments are not an automatic hard stop: when posts report `comment_count > 0` but no comment file is present, record the reduced-evidence limitation and either request the file or continue on explicit human approval. That approval authorizes continuing the run, never a better final status: any recorded `reduced_evidence_sources` entry permanently caps the run at `PASS_WITH_BACKLOG`. Ask for the minimum missing input or an explicit decision to continue with
reduced evidence.

Also pause when Reddit `post_id` is unavailable (no `cluster_id` can be formed),
when Semrush volume is missing at row level while a Semrush file is present, or
when GEOly returns rows without a stable public prompt / topic / card ID — each of
these makes a downstream D bucket or the Coverage Floor unrecomputable. If a
source family is absent altogether, name it so the orchestrator can record
`reduced_evidence_sources`; a project with no Semrush input at all is
**permanently capped at** `PASS_WITH_BACKLOG` with no human-approval upgrade to a
normal `PASS`, and brand material may never substitute for Semrush.

**Stop, don't guess.** Never fabricate an ID, a volume, or an author to satisfy a
required column.

End with the shared HandoffContract — including `CoverageFloor`,
`DiscoveryFrontier`, `ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and
`ProtocolVersion` — and wait for approval.
