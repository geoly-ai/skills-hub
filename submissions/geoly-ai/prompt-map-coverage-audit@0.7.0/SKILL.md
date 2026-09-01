---
name: prompt-map-coverage-audit
description: Audit whether a product-card Prompt Map covers every approved demand cell, Topic, decision angle, and accepted discovery obligation, annotate the Coverage Floor evidence sample, and report the dual-gate convergence state (Coverage Floor recall plus Value Frontier exhaustion) before and after semantic dedupe. Use it to distinguish base-cell coverage from gate-verified convergence and to audit a per-round discovery ledger.
---

# Prompt Map Coverage Audit

Read the shared geo-coverage-mode doc, discovery protocol, value rubric,
coverage-floor sampling doc, demand-cell schema, Prompt schema, product-card
rules, dedupe rules, shortlist-difference test, status vocabulary, and handoff
schema.

In `geo_full_coverage` (default), audit **query-surface coverage completeness**,
not a minimal deduped set: every evidence-backed surface (audience × body-part ×
attribute × scenario × decision-angle × decision-criterion) across Category, all
Topics, the decision-angle grid, and approved Topic intersections must have a
Prompt, or an explicit `待验证假设` / WAIVE reason. Report surface coverage %,
uncovered high-value surfaces and intersections, and near-duplicate REVIEW
flags. Do not close coverage merely because product shortlists would overlap.

## Modes

- pre-dedupe-base: audit the draft for approved demand-cell and Topic-route
  presence, then create a supplementation queue.
- decision-angle-expansion: mandatory after base coverage and before final
  dedupe. Audit each eligible theme and Topic for source-backed purchase
  decision angles, then create or update the supplementation queue.
- round: audit one discovery round `rNN`. Check that every accepted discovery
  surface in `06_round_registry.csv` either has a linked valid Prompt in
  `05_round_prompts.csv` (→ `cell_status=covered`, `covered_prompt_ids=<id>`) or
  stays `cell_status=open` with `gap=SUPPLEMENT`. Also confirm every
  Closure-originated new registry surface was declared in
  `06_closure_additions.csv`, and that no inherited row was dropped. **This audit
  is the primary detection point**: the convergence gate compares the NEXT round's
  frozen base registry against the previous round's registry taken as a whole, so
  a row added to `06_round_registry.csv` inside its own round without a
  declaration will pass the gate's arithmetic. Treat an undeclared addition found
  here as a blocking failure. Emit `07_round_coverage_audit.csv`. Run the round integrity check with
  the discovery-round flags:

```
python3 ../prompt-map-shared/scripts/validate_generation_integrity.py --registry <project-root>/work/coverage_rounds/rNN/06_round_registry.csv --prompts <project-root>/work/coverage_rounds/rNN/05_round_prompts.csv --angle-inventory <project-root>/work/03_route_angle_inventory.csv --angle-links <project-root>/work/03_prompt_angle_links.csv --ledger <project-root>/work/03_candidate_surface_ledger.csv --round-dir <project-root>/work/coverage_rounds/rNN --coverage-mode <coverage_mode>
```

  `--round-dir` enables the round checks (Stage 1 = `K` rows, family quotas,
  Stage 1/2 ID alignment, accepted surfaces present in the registry and the round
  map). Optional `--expected-k` overrides `K`; omit it and the round manifest's
  `K` is used.
- coverage-floor: annotate the script-drawn Coverage Floor batch (see below).
- post-dedupe-final: audit the deduped final candidates before delivery and
  verify that base coverage, decision-angle closure, and accepted-discovery
  coverage all remain true.

`pre-dedupe-base` is a foundation check, not a completion certificate. Do not
skip `decision-angle-expansion` even when every active cell is linked. Closing
every baseline obligation is likewise not a completion certificate — it satisfies
the Closure Stream only.

## Audit dimensions

1. Demand-cell coverage: every approved non-waived product-card-eligible cell has at least one Prompt. Theme-level PASS never closes a cell-level gap.
2. Topic coverage: every approved Topic has appropriate Prompts; Category Prompts are not duplicated merely to inflate Topic counts.
3. Expansion depth: each eligible demand theme is checked for both its
   cross-Topic Category route and every assigned Topic route. Cell presence
   alone is insufficient.
4. Decision-angle coverage: recommendation, feature, scenario, results,
comparison, review, value, ease, and switch are checked only where the cell
evidence supports a distinct ranking criterion. These are not a mandatory
matrix. In decision-angle-expansion mode, build an evidence-backed inventory
of actual purchase tasks and check people, body/fit, scene, pain, function,
result expectation, purchase stage, tradeoff, and ranking criterion.
5. People/body/scenario/pain/stage coverage: compare Prompts against the approved cell registry, including evidence-backed intersections and clearly marked hypotheses. Do not require blind theoretical combinations.
6. Product-card eligibility: every delivered row passes all hard tests and remains in the correct physical-product category. For medical- or safety-adjacent needs, require a non-clinical product decision criterion and a claim guardrail; do not allow diagnosis, treatment, prevention, safety clearance, or guaranteed physiological-outcome claims.
7. Neutrality and traceability: neutral rows do not force the client brand; every row has evidence or an approved hypothesis label.
8. Translation: Chinese is present and faithful.
9. Semantic risk: flag exact or near duplicates, template spam, Cartesian
expansion, parenthetical Topic copies, and cross-Topic repeats.
10. Shortlist difference: every retained candidate must state a concrete
`shortlist_delta`; missing, generic, or label-only deltas are REWRITE/REVIEW
failures, not covered routes.
11. Discovery obligation closure: every surface with `surface_origin=discovery`
and `cell_status=covered` must name a real linked Prompt ID present in the
audited Prompt file; every `cell_status=open` discovery row must appear in the
gap queue. A registry row may never be flipped to `covered` by the module that
appended it.
12. Registry row-level invariants. Signature-set containment is not enough —
metadata edits shrink the real obligation set while passing a set check. Verify
between rounds that:
   - `demand_cell_id` is unique, and **every baseline cell still exists**. A cell
     may not be renamed, dropped, or merged away.
   - These fields are **immutable** on an existing cell: the six surface fields,
     `product_card_eligible`, `surface_origin`, and `introduced_round`. Flipping
     `product_card_eligible` to No is a silent obligation deletion.
   - `cell_status` may move freely only `open -> covered`. `open -> waived`
     requires a matching row in that round's **`06_waivers.csv`** carrying
     `demand_cell_id`, a non-empty `waiver_approval_ref`, and a non-empty
     `waiver_reason`. Every other transition — including `covered -> open` and
     `waived -> anything` — is illegal and fails the run.
13. Closure declarations: every Closure-originated new registry surface has a row
in `06_closure_additions.csv` with a complete approval envelope
(`closure_addition_id, source_gap_id, evidence_refs, approval_ref,
closure_reason`), and any row whose signature Discovery rejected that round also
carries `human_override_ref`.

## Saturation stopping rule — two opposing gates

Coverage is NOT closed by exhausting an inventory. In `geo_full_coverage` the run
stops only when the verifier recomputes both gates from the ledgers:

**Gate A — Coverage Floor (recall floor, prevents under-production).** Over the
script-drawn evidence sample: `n` = eligible rows, `x` = eligible rows whose
canonical signature is absent from the final Prompt signatures,
`rate = x / n`, `upper = wilson_upper(x, n, z=1.645)`, `passed = upper < 0.10`.
`n` must reach the profile's `coverage_floor_n` (rich 60, narrow 50). If
exclusions leave the batch short, the run is NOT allowed to judge it as-is: top it
up from the same source's next hash-ordered rows (or draw Batch 2) and re-annotate
the added rows. A short sample is a blocking condition the verifier reports, not a
smaller denominator to pass against. Verified tolerances: rich `n=60` → `x=2` upper 9.59% PASS,
`x=3` upper 11.87% FAIL; narrow `n=50` → `x=1` upper 8.48% PASS, `x=2` upper
11.39% FAIL.

**Gate B — Value Frontier Exhaustion (marginal-value rule, guarantees
termination).** For a round with exactly `K` candidates:

```
A_i = 1 if (is_new_surface AND materiality_pass AND V_i >= V_accept) else 0
C_t = sum(A_i)                              # accepted material count
H_t = sum(A_i == 1 and V_i >= V_critical)   # critical new count
M_t = sum(A_i * V_i)                        # value mass
D_t = M_t / K                               # value density
```

A single round passes only with ALL of `candidate_count == K`, `H_t == 0`,
`C_t <= N`, `D_t < delta`, `probe_degenerate == false`, and
`identical_recheck_complete == true`.

`probe_degenerate` is true when `exploratory_new_count < min_new_surface_count =
max(5, ceil(0.10 * K))` — 10 on rich, 5 on narrow. A candidate counts toward
`exploratory_new_count` only when `novelty_status == new`, `support_mode` is
`direct` or `derived`, and at least one `evidence_refs` entry resolves in the
frozen evidence index. `new_surface_count` is reported too, but as a diagnostic
only — do not audit against it.

Auditing this floor is not optional, because it closes two ways of faking
convergence. A round whose `K` candidates merely transcribe surfaces already in
the map produces `C=0, H=0, D=0` and would otherwise read as a *perfect* frontier
pass while discovering nothing; padding it with well-formed but unevidenced
`hypothesis` rows would satisfy a signature-only count while doing the same. Real
saturation is the opposite shape — plenty of genuinely `new`, evidence-backed
surfaces that simply fail the value bar, and those **do** count toward the floor.
Treat a degenerate round as a probe defect and a hard blocker for human review,
never as evidence that the space is exhausted.

Enforcement covers exactly those three conditions. A probe family's
`evidence_requirements` is free text that cannot be machine-adjudicated, so do not
report or rely on the gate verifying it; `verify` states the actual scope in
`evidence.probe_floor_enforcement`.

`identical_recheck_complete` requires that round's `09_identical_recheck.csv` to
cover the full deterministic sample with a valid `reviewer_verdict` and a
non-empty `reason` on every row, and **no** row marked `actually_distinct`. Frontier exhaustion requires `streak` consecutive
passing rounds under an identical protocol hash (rich `N=5, delta=0.039`; narrow
`N=3, delta=0.062`; `V_accept=0.60`, `V_critical=0.85`, `streak=2`). The three
conditions are non-redundant — count catches many barely-qualifying surfaces,
density catches few-but-strong, and `H_t` catches the single one that really
matters.

A new Prompt is justified when its canonical surface differs after shared
canonicalization, EVEN IF the recommended products overlap, the `shortlist_delta`
overlaps, the intent family is the same, or the Topic and Category routes rank
many of the same products. Never use a fixed Prompt quota, a shortlist-overlap
test, an inventory-exhausted claim, or a free-brainstorm acceptance rate as the
GEO stopping rule. An off-inventory high-value surface must be appendable and may
never be marked WAIVE merely for being off-inventory.

In `minimal_dedup`, continue only while a candidate changes the product shortlist
or ranking lens (legacy rule).

## Coverage Floor annotation duty

The batch is drawn by `verify_coverage_convergence.py prepare-floor --project-root
<project-root> --batch <1|2>` and lands in
`work/coverage_floor/batch<N>/floor_batch.csv`, never drawn by
the agent. For each sampled evidence row the agent fills ONLY:

```
eligible, exclusion_reason, audience, body_part_or_object,
attribute_or_condition, scenario, decision_angle, decision_criterion
```

`exclusion_reason` is a closed enum: `not_purchase_related`, `education_only`,
`medical_or_safety_only`, `service_only`, `wrong_category`, `duplicate_evidence`,
`insufficient_text`. Any other value is a blocking failure.

The agent NEVER fills `surface_signature`, `covered`, or `covered_prompt_ids`, and
never computes the rate or the Wilson bound. The floor is computed against an
independent evidence sample and never uses registry row counts as a denominator,
so appending registry rows cannot inflate it.

On a floor miss, never repair against the same batch and then declare that batch
passing. Batch 1 FAIL → misses into the gap queue → supplement → Batch 2 drawn
from the still-unsampled evidence → Batch 2 judged independently. At most two
batches; still failing → `coverage_floor_passed = false` and no normal PASS.

`coverage_floor_mode = registry_proxy` is allowed only when the base/angle/final
audits all pass, `high_priority_uncovered_count == 0`, and a human approves that
evidence sampling cannot be run. It caps the run at `PASS_WITH_BACKLOG`, must
never emit a normal `PASS`, and must never claim a Wilson bound — the audit checks
the registry, and the registry comes from demand extraction, so it cannot detect
evidence the extractor never surfaced.

## Template review accounting

`template_review_count == 0` means "every detected REVIEW was rewritten, merged,
or human-resolved", NOT "the detector never fired". Track and report all three of
`template_detected_count`, `template_resolved_count`, and
`template_review_count = detected - resolved`. Only the unresolved count must be
zero. A run reporting zero detections on a 600-row map is a suspicious result to
investigate, not a clean bill of health.

Resolutions live in **`state/template_resolutions.json`**, a JSON **list of
resolution objects** — a bare list of finding keys resolves nothing. Every entry
needs:

```json
{"key": "<finding key>", "resolution_type": "rewritten|merged|human_waived",
 "reason": "<non-empty>", "approval_ref": "<required when human_waived>"}
```

An entry with a missing/invalid `resolution_type`, an empty `reason`, or a
`human_waived` type without `approval_ref` is discarded and its finding stays
unresolved. This is deliberate: it stops the ledger from being filled in by
copying the current finding keys. Pass it to the validator so the three counters
are emitted:

```
python3 ../prompt-map-shared/scripts/validate_prompt_surface_quality.py --prompts <project-root>/work/05_prompt_final.csv --coverage-mode <coverage_mode> --strict --resolved-ledger <project-root>/state/template_resolutions.json --output <project-root>/work/05_surface_quality_report.json
```

The convergence gate does not trust those counters: it **re-runs the detector
against the current map** and applies the resolution ledger to the findings that
fire *now*. Two consequences to respect:

- After rewriting or merging any Prompt, re-run the detector. Resolutions are
  keyed to findings, so an edit can retire an old finding and fire a new one that
  no ledger entry covers.
- A resolution entry for a finding the detector no longer produces resolves
  nothing. Never "resolve" a REVIEW by adding a key without changing the map.

Template guards run in three phases: during the discovery surface phase
(structured surfaces, no Prompt text) run only exact canonical duplicate,
identical canonical signature, and invalid/null surface checks and do NOT run the
template validator; during Prompt authoring run
`validate_shortlist_difference.py`, `validate_generation_integrity.py`, and
`validate_prompt_surface_quality.py`; at the final phase run the whole map with
`--strict`.

Record the nearest existing Prompt and the new decision distinction for every
SUPPLEMENT recommendation. If the distinction is unsupported by evidence or does
not open a new query surface (GEO) / change a product shortlist (minimal), use
WAIVE with a reason instead.

## Gap decisions

- SUPPLEMENT: an approved cell or decision distinction has no Prompt.
- REWRITE: the need exists but the Prompt is not product-card eligible or natural.
- MOVE: the row belongs at Category level or another Topic.
- WAIVE: the surface does not open a new evidence-backed canonical query surface (GEO) / does not change the shortlist or ranking lens (minimal), or lacks product-decision value; requires a reason and human approval. Never WAIVE a surface merely because it is off-inventory.
- REVIEW: evidence, Topic, or semantic distinction is ambiguous.

## Outputs

- work/04_coverage_audit.csv (base mode)
- work/04_decision_angle_audit.csv (decision-angle-expansion mode)
- work/04_gap_queue.csv
- work/04_summary.md or work/04_decision_angle_summary.md
- work/coverage_rounds/rNN/07_round_coverage_audit.csv (round mode)
- work/coverage_floor/batch<N>/floor_batch.csv (coverage-floor mode) — annotated
  in place, agent columns only; the script owns
  `floor_batch_manifest.json` alongside it
- state/template_resolutions.json — the resolution-object ledger, updated
  whenever a template REVIEW is genuinely rewritten, merged, or human-waived
- work/coverage_rounds/rNN/06_waivers.csv — when any registry cell moves to
  `waived` in that round
- work/05_final_coverage_audit.csv (**post-dedupe-final mode**) — exactly one
  summary row with `final_status`, `final_prompt_count`,
  `unresolved_decision_angle_gap_count`, and in `geo_full_coverage` also
  `unresolved_query_surface_gap_count`, `unresolved_intersection_gap_count`,
  `high_priority_uncovered_count`, `template_detected_count`,
  `template_resolved_count`, `template_review_count`,
  `hard_validator_failure_count`, `coverage_floor_passed`, and
  `frontier_exhausted`. This is the artifact `verify_decision_angle_gate.py`
  reads at the final-audit / delivery gate.
- work/05_final_coverage_summary.md (post-dedupe-final mode)

Required gap fields:

gap_id, demand_cell_id, demand_theme_key, topic, missing_dimension, evidence_refs, proposed_action, priority, human_decision, resolution_prompt_ids, surface_origin, introduced_round

## Final mode outcomes

`final_status` is reported by the verifier, not decided narratively. Four values:

- **PASS** — Gate A passed, hard blockers zero, Gate B exhausted over the required
  streak under one protocol hash.
- **PASS_WITH_BACKLOG** — Gate A passed, hard blockers zero, `coverage_round >=
  max_round` **or** the approved discovery budget is spent, frontier still open,
  this round's high-value surfaces already merged, a valid
  `outputs/discovery_backlog.csv` attached, and `human_backlog_delivery_approved
  = true`.
- **CONTINUE** — not yet convergent and no hard failure. Run another active round;
  this is not a failure and must not be reported as one.
- **FAIL** — floor failed, high-priority gaps remain, validator blockers, an
  incomplete ledger/protocol, or an attempt to converge by shrinking the
  denominator or editing the rubric.

Hard blockers are zero when `high_priority_uncovered_count == 0`,
`unresolved_query_surface_gap_count == 0`, `unresolved_intersection_gap_count ==
0`, `template_review_count == 0` (unresolved only), and
`hard_validator_failure_count == 0`.

In final mode, do not pass delivery if any SUPPLEMENT, REWRITE, or unresolved
REVIEW remains, or if decision-angle-expansion was not run. Report base-cell
coverage, decision-angle closure, accepted-discovery coverage, Coverage Floor
state, and frontier state as separate counts. Before emitting PASS or
PASS_WITH_BACKLOG, run:

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py verify --project-root <project-root> --stage final-audit
python3 ../prompt-map-shared/scripts/verify_decision_angle_gate.py --project-root <project-root> --stage final-audit
```

(paths are relative to this skill's install directory; `prompt-map-shared` is
installed as a sibling skill). A non-zero exit is a blocking audit failure. Never
pre-fill a rate, score, or boolean the verifier is supposed to recompute.

**Stop, don't guess.** If the frozen profile, protocol hash, evidence index, floor
ledger, or round ledger is missing or incomplete, halt and ask rather than assume
a passing value.

End with the HandoffContract — including `CoverageFloor`, `DiscoveryFrontier`,
`ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and `ProtocolVersion` — and
wait for approval.
