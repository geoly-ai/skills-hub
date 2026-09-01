# Evidence Policy

## Reddit

Use posts and comments as VOC evidence for people, scenes, pain points, language, failure stories, anxieties, switching behavior, and decision criteria. Read selftext and comments before separating “pre-purchase concern” from “post-use failure”. One strong source can justify a long-tail theme when the need is concrete and purchase-relevant.

Do not use Reddit popularity as the sole priority score. Record subreddit, date, URL/post ID, and whether the evidence came from a post or comment.

## Semrush

Use keywords and volume to confirm search language, relative scale, modifiers, body areas, competitors, and demand patterns. Semrush absence does not invalidate Reddit-only or brand-input demand. Remove brand names to discover category-level wording, but keep the original branded query in the evidence index.

## GEOly

Use GEOly MCP for public product spaces, Topics, public prompts, shopping-card examples, and product-card activation evidence. GEOly Topics are an important delivery taxonomy, not the complete demand universe. Preserve public prompt IDs when available. Do not import prompts from unrelated categories.

## Brand materials

Use product features, audience notes, use cases, FAQs, support issues, and positioning as hypothesis generators and claim guardrails. Convert a feature into a user need only when the underlying pain or decision criterion is explicit or labeled `待验证假设`.

## Confidence is not priority

Source count indicates confidence, not necessarily value. Prioritize concrete purchase relevance and unmet decision need. Maintain both `evidence_status` and `priority` so high-intent long-tail needs are not deleted for low volume.

## Traceability

Every demand theme and Prompt must trace to at least one evidence row or be labeled `待验证假设`. Never present inferred demand as verified VOC.

## Scoring evidence in the Discovery Stream

When evidence is scored for a discovery round, `value-rubric.md` is
authoritative for every bucket and threshold. This file states the qualitative
policy; the rubric states the numbers. Do not restate bucket boundaries here.

The rules from this policy that the rubric makes binding:

- **Demand source families are exactly four**: `reddit`, `semrush`, `geoly`,
  `brand_customer`. `brand_feature`, `brand_marketing`, `brand_positioning`, and
  `agent_inference` are **not** demand evidence and never count as a source
  family.
- **Reddit popularity is not demand strength.** `D_reddit` counts distinct
  `cluster_id` values — by default `post:<post_id>`, so all comments on one post
  form one cluster unless a comment demonstrably has both a different author and
  a different purchase decision. Score, upvotes, and comment count never change
  the bucket.
- **Semrush means volume.** Aggregate volume over unique normalized keyword rows
  for the same canonical need; a repeated export counts once. Never substitute
  CPC, KD, or position for volume.
- **Semrush absence does not invalidate other sources.** If the file exists but
  a need has no volume, only `D_semrush` goes to zero. If the project has no
  Semrush input at all, record it in `reduced_evidence_sources` — the run then
  defaults to `PASS_WITH_BACKLOG`, and brand material may never substitute.
- **Brand material is capped.** Only quantified independent customer cases,
  support tickets, and customer interviews score at all; FAQ, feature pages, and
  marketing score zero. A brand source can never reach the top demand bucket on
  its own, and a brand-only surface has its evidence quality capped.

Evidence units are recorded in `work/02_evidence_index.csv` (see
`demand-schema.md`), which is also the sampling frame for the Coverage Floor.
