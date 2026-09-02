# Value Rubric

This file is the authority for the surface value score `V` used by the Discovery
Stream. `discovery-protocol.md` consumes `V` to compute the round frontier
metrics; `coverage-loop.md` consumes the frontier verdict.

**The agent never writes `V` or any of its components.** The agent writes closed
enums and integer counts in Stage 2 of the round ledger; the script computes
everything below. Any run in which a value component appears as a
free-floating float written by an agent is invalid.

```
V = 0.30*E + 0.25*D + 0.30*P + 0.15*T      # round to 3 decimals
```

`value_rubric_version` and `materiality_rule_version` are frozen before round 1
and recorded in `state/run_state.json`. Changing either mid-run does **not**
merely zero `frontier_streak`: both are re-checked on every historical round
manifest against the code's own constants, so a change turns every earlier round
into an **integrity failure** until those rounds are re-run under the new rubric.
Plan it as a restart, not as a revision you can absorb. See "Protocol changes and
the streak" in `coverage-loop.md`.

---

## Hard materiality gate — evaluated BEFORE `V_accept`

All of the following must hold. If any fails, set `materiality_pass=No`,
`value_gate_pass=No`, `disposition=rejected` — **regardless of how high the
weighted `V` is**. A high `V` never rescues a surface that fails materiality.

```
product_card_eligible == Yes
support_mode in {direct, derived}
E >= 0.50
D >= 0.40
P >= 0.60
T >= 0.70
decision_criterion non-empty
support_mode == derived requires a valid derivation_rule_id
```

`support_mode == hypothesis` can never pass. Hypotheses stay quarantined as
optional backlog and are never part of any convergence statistic.

A plain concatenation of two evidenced dimensions is **not** derivation. Derived
surfaces require a pre-approved `derivation_rule_id`, and every composing
dimension must carry its own evidence refs.

"Pre-approved" means present in `approved_derivation_rule_ids`, the frozen table
in `state/discovery_protocol.json` — the **only** authoritative location, with no
mirror copy in the profile (see `discovery-protocol.md`). There is no fallback
that accepts an arbitrary non-empty string, which would make
`derivation_rule_id` a free-text field the agent controls.

A missing or empty table is an **integrity failure**, not a way to switch
derivation off. A project that does not use derivation declares the table
normally and writes no `support_mode=derived` rows. The scoring path does treat
an unresolvable table as `E0_UNSUPPORTED`, but that is defense in depth for a
misconfigured project — not a supported way to run without derivation.

---

## E — Evidence quality

Match the **first** row that applies, top to bottom.

| evidence_code | condition | E |
|---|---|---:|
| `E4_MULTI_SOURCE_DIRECT` | `support_mode=direct` AND >= 2 non-zero demand source families | 1.00 |
| `E3_REPEATED_DIRECT` | direct, 1 source family, >= 3 independent direct evidence units | 0.80 |
| `E2_SINGLE_DIRECT` | direct, >= 1 direct evidence unit | 0.60 |
| `E1_VALID_DERIVED` | derived, valid `derivation_rule_id`, every composing dimension has evidence refs | 0.50 |
| `E0_UNSUPPORTED` | hypothesis / free brainstorm / no evidence / invalid derived | 0.00 |

**Demand source families** are exactly: `reddit`, `semrush`, `geoly`,
`brand_customer`.

**Not demand evidence**, and never counted as a source family:
`brand_feature`, `brand_marketing`, `brand_positioning`, `agent_inference`.

- **Brand-only cap.** If the only non-zero source is `brand_customer`, then
  `E = min(E, 0.60)`. A brand corpus alone cannot certify multi-source demand.
- Brand FAQ, spec sheets, and marketing copy give `E = 0.00` and force
  `support_mode = hypothesis`.

Naming note: `work/02_evidence_index.csv` uses `source_type = brand`. Only rows
that are **quantified independent customer cases, support tickets, or customer
interviews** map to the `brand_customer` source family. Brand feature/marketing
rows in the same index never do. See `demand-schema.md` and `evidence-policy.md`.

---

## D — Demand strength

`D` is computed per source, then combined. Score each source independently.

### D_reddit

Count **distinct `cluster_id`**. The default cluster is `post:<post_id>` — all
comments on one post form a single cluster, unless a comment demonstrably has
both a different author AND a different purchase decision, in which case that
comment becomes its own cluster `comment:<comment_id>`.

Reddit score, upvotes, and comment count never change the bucket. Popularity is
not demand breadth.

| distinct reddit clusters | D_reddit |
|---|---:|
| >= 8 | 1.00 |
| 3–7 | 0.70 |
| 1–2 | 0.40 |
| 0 | 0.00 |

### D_semrush

`semrush_monthly_volume = sum(volume over unique normalized keyword rows)` for
the same canonical need. A repeated export of the same keyword counts once.
Never substitute CPC, KD, or SERP position for volume.

| aggregated monthly volume | D_semrush |
|---|---:|
| >= 500 | 1.00 |
| 50–499 | 0.70 |
| 10–49 | 0.40 |
| 1–9 | 0.20 |
| 0 / missing | 0.00 |

### D_geoly

Fields: `geoly_public_prompt_count`, `geoly_topic_or_card_count`. Each public
prompt ID counts once.

| condition | D_geoly |
|---|---:|
| public prompts >= 3 | 1.00 |
| public prompts == 2 | 0.70 |
| public prompts >= 1 AND topic/card >= 1 | 0.70 |
| public prompts == 1 | 0.40 |
| public prompts == 0 AND topic/card >= 1 | 0.40 |
| no GEOly evidence | 0.00 |

### D_brand

Only **quantified independent customer cases**, support tickets, or customer
interviews count. FAQ, feature pages, and marketing material score 0.00.

| independent customer cases | D_brand |
|---|---:|
| >= 20 | 0.70 |
| 5–19 | 0.40 |
| 1–4 | 0.20 |
| unquantified FAQ / feature / marketing, or none | 0.00 |

A brand source can **never** reach `D = 1.00` on its own — the table has no
1.00 row by design.

### Combination

```python
scores = [D_reddit, D_semrush, D_geoly, D_brand]
if max(scores) == 1.00:                    D = 1.00
elif sum(s >= 0.70 for s in scores) >= 2:  D = 1.00
elif max(scores) >= 0.70:                  D = 0.70
elif sum(s >= 0.40 for s in scores) >= 2:  D = 0.70
elif max(scores) >= 0.40:                  D = 0.40
elif max(scores) >= 0.20:                  D = 0.20
else:                                      D = 0.00
```

Two independent mid-strength sources promote one bucket; one strong source is
enough for 0.70; two strong sources reach 1.00.

### When there is no Semrush data

Two distinct cases, and they must not be conflated:

1. **The Semrush file exists but this need has no volume.** Set
   `D_semrush = 0` and leave every other source at its own bucket. Do NOT
   downgrade Reddit, GEOly, or brand because search volume is absent — a
   long-tail purchase need with no search volume is still real demand.
2. **The project has no Semrush input at all.** Record
   `reduced_evidence_sources += ["semrush"]` in run state. The Coverage Floor
   still runs, but a non-empty `reduced_evidence_sources` caps the run at
   **`PASS_WITH_BACKLOG` permanently** — there is no human approval that
   upgrades it to a normal `PASS`, because missing evidence cannot be approved
   into complete coverage. Note also that `PASS_WITH_BACKLOG` still requires the
   floor to have **passed** and the budget to be spent: the cap lowers the
   ceiling, it never delivers around a failed floor or an unspent budget.

Brand material may never substitute for Semrush in either case.

**How the floor still reaches `n` without Semrush.** The Coverage Floor draws a
fixed per-source quota (rich: 20 Semrush rows; narrow: 15) and tops up shortfalls
from the same source first. When a source's pool is exhausted — which is the case
for the entire Semrush quota in a project with no Semrush input — its unmet quota
is reallocated in the fixed order `reddit → geoly → semrush`, with brand never
participating. The batch must record `floor_quota_reallocated` and
`floor_source_pool_exhausted` so the reallocation is auditable. If even the full
evidence pool cannot reach `coverage_floor_n`, Wilson is computed on the actual
`n` and the run is capped at `PASS_WITH_BACKLOG`. See
`coverage-floor-sampling.md` for the full rule.

---

## P — Product differentiation

The agent writes only the `product_impact_code`. The script maps it to `P`.

| product_impact_code | meaning | P |
|---|---|---:|
| `P4_ELIGIBILITY_GATE` | eliminates part of the product set: compatibility, availability, size/format, voltage, access, eligibility | 1.00 |
| `P3_PRIMARY_RANKING` | changes the primary filter criterion or clearly changes ranking | 0.80 |
| `P2_SECONDARY_TRADEOFF` | changes a real secondary tradeoff, usually without eliminating a product group | 0.60 |
| `P1_EMPHASIS_ONLY` | only changes emphasis / tone / scene wording; product constraints unchanged | 0.30 |
| `P0_NO_CHANGE` | synonym, intent label, word order; no product-decision difference | 0.00 |

Because the hard gate requires `P >= 0.60`, `P1_EMPHASIS_ONLY` and
`P0_NO_CHANGE` can never pass materiality. See `shortlist-difference-test.md`.

### Quick test

> If answering this question changes at least one column's weight, filter, or
> elimination rule in the product comparison table:
> clearly changes **elimination** → `P4`;
> clearly changes **primary ranking** → `P3`;
> changes a real **secondary tradeoff** → `P2`;
> only needs **different wording** → `P1` / `P0`.

---

## T — Trackability

The agent writes three Yes/No fields.

| field | Yes when |
|---|---|
| `track_natural_query` | it can be written as one natural user question with no internal labels exposed |
| `track_concrete_answer` | the AI answer lets you observe whether products are filtered, compared, or ranked by an explicit criterion |
| `track_reusable_surface` | it does not depend on one person, one store, a one-off event, or an over-specific place; it is still testable later |

3 Yes → `T = 1.00`; 2 → 0.70; 1 → 0.40; 0 → 0.00.

Because the hard gate requires `T >= 0.70`, a surface needs at least two Yes.

**The laundromat case.** A one-off location such as "at a laundromat" usually
fails `track_reusable_surface`. But do not reject it mechanically: if the
underlying constraint — "public place / cannot wash or sterilize / needs offline
storage" — forms a reusable product constraint, canonicalize the surface **up to
the stable parent scenario** and re-evaluate. The rule filters over-specific
instances, not the real constraint hiding inside them.

---

## Thresholds

| profile | `V_accept` | `V_critical` |
|---|---:|---:|
| rich | 0.60 | 0.85 |
| narrow | 0.60 | 0.85 |

`V_i >= V_accept` (after materiality) makes a surface **accepted material**;
`V_i >= V_critical` makes it **critical**, and a single critical new surface
blocks frontier exhaustion for that round. Both thresholds are frozen with the
profile before the first discovery round — see `coverage-loop.md`.
