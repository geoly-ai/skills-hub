# Reddit Input Handoff

This reference defines the Reddit files consumed by Prompt Map Skills. It does
not define how Reddit is crawled. Reddit collection is performed separately by
the team's approved Reddit Skill and Cursor workflow.

## Required project identity

Every handoff must identify one:

`brand + physical-product category + country/language`

Do not mix Reddit exports from different categories, markets, or unrelated
brands in one Prompt Map project.

## Accepted files

The normal handoff contains:

- `reddit_posts_raw.csv`: original post title, body, subreddit, permalink,
  date, score, comment count, query, and fetch status.
- `comments_raw.csv`: original comment body, comment ID, post ID, parent ID,
  subreddit, permalink, date, score, depth, selection reason, and fetch status.
- `reddit_query_log.csv`: query, subreddit, sort, time filter, requested and
  returned counts, run status, and rate-limit or parsing notes.
- `reddit_demand_themes.csv`: canonical demand themes with representative post
  or comment IDs, links, audience, scene, pain point, purchase stage, and
  evidence status.

`reddit_coverage_ledger.csv` is recommended when the collector has checked a
demand coverage skeleton. It may contain audience, body area/object, scene,
pain point, product criterion, purchase stage, source subreddits, representative
IDs, and a coverage or saturation status.

## Handoff checks

Before demand extraction, Prompt Map Skills check:

1. Project identity matches the active brand, category, and market.
2. Raw post text and any supplied comment text are present; summaries do not
   replace raw text. Comments are conditionally required (see below).
3. Representative IDs and permalinks trace themes back to evidence.
4. Fetch failures, empty comment threads, 403/429/TLS errors, and partial runs
   are recorded rather than presented as evidence of no demand.
5. Reddit-only long-tail themes remain available for demand extraction even
   when another source has no matching keyword or Topic.

Posts are always required. Comments are conditionally required: when posts
report `comment_count > 0` but `comments_raw.csv` is absent, record the gap as a
reduced-evidence limitation and either request the comments file or continue on
explicit human approval (per the reduced-evidence rule in `context-contract.md`).
Never label a comment-less run as fully source-complete. If the posts file
itself is missing or materially incomplete, pause and request it. Do not re-run
Reddit collection or fabricate missing records inside Prompt Map.

## Evidence role

Reddit is a complementary VOC source. It supplies preference signals, user
language, audience/scenario detail, pain points, decision barriers, and usage or
switching experiences. It does not by itself prove search volume, product-card
appearance, or that a brand is the correct answer.
