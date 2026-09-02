---
name: prompt-map-orchestrator
description: Orchestrate a first-version-compatible physical-product Prompt Map workflow through convergence-profile freezing, three calibration rounds, dual-stream active rounds (Closure plus open Discovery), the Coverage Floor and Value Frontier gates, human approval gates, step-level reruns, and the PASS_WITH_BACKLOG escape hatch. Use whenever a product-card Prompt Map must be created, revised, audited, converged, or declared deliverable.
---

# Prompt Map Orchestrator

Choose the run mode before normalization:

- `cold_start`: no existing Prompt Map is read. Build a new map only from Reddit, Semrush, GEOly, optional brand material, and approved human decisions.
- `revision`: an accepted Prompt Map is supplied and becomes the golden content baseline. New modules add control and auditability without silently rewriting it.

For Skill acceptance tests and first-time projects, default to `cold_start`. An older workbook may be kept outside `inputs/` as a blind evaluation reference, but it must not be read during generation.

Also declare `coverage_mode` and record it in `state/run_state.json` (schema
`1.3`). Default is `geo_full_coverage` — build **maximum coverage of distinct GEO
query surfaces** (audience × body-part × attribute × scenario × decision-angle ×
decision-criterion), expecting many hundreds of Prompts for a data-rich category,
not a small deduped set. Use `minimal_dedup` only for a condensed deliverable or a
`revision` run inheriting a 0.4.x map. Read
`../prompt-map-shared/references/geo-coverage-mode.md`,
`../prompt-map-shared/references/discovery-protocol.md`,
`../prompt-map-shared/references/value-rubric.md`, and
`../prompt-map-shared/references/coverage-floor-sampling.md` before Phase 4.

## Convergence doctrine

`convergence_method = "coverage_floor_plus_value_frontier_v1"`.

Generation runs as **two independent streams** and termination is decided by
**two opposing gates**, with a budget escape hatch:

- **Closure Stream** — close every known obligation in the living registry.
- **Discovery Stream** — probe exactly `K` open candidates per round; qualifying
  off-inventory surfaces are appended to the living registry as new obligations.
- **Gate A — Coverage Floor**: a recall floor computed by script from an
  independent evidence sample. Prevents under-production.
- **Gate B — Value Frontier Exhaustion**: a marginal-value stopping rule.
  Guarantees termination.
- **`PASS_WITH_BACKLOG`**: deliver at approved-budget exhaustion instead of
  deadlocking.

The orchestrator never reimplements the gate math. `verify_coverage_convergence.py`
recomputes everything from the ledgers; run-state floats and booleans are never
trusted. Never optimize for the smallest acceptable Prompt count; a small output
is a coverage-risk signal to investigate.

## Convergence profiles

Frozen to `state/convergence_profile.json` before the first discovery round.

```yaml
rich:    # any ONE of: approved_topics >= 10 | eligible_demand_themes >= 80 | initial_surface_inventory >= 180
  K: 100
  V_accept: 0.60
  V_critical: 0.85
  N: 5                      # frontier_count_threshold
  delta: 0.039              # frontier_density_threshold
  streak: 2
  max_round: 6
  coverage_floor_n: 60
  coverage_floor_threshold: 0.10
  min_new_surface_count: 10   # = max(5, ceil(0.10 * K))

narrow:  # ALL of: approved_topics < 10 AND eligible_demand_themes < 80 AND initial_surface_inventory < 180
  K: 40
  V_accept: 0.60
  V_critical: 0.85
  N: 3
  delta: 0.062
  streak: 2
  max_round: 4
  coverage_floor_n: 50
  coverage_floor_threshold: 0.10
  min_new_surface_count: 5    # = max(5, ceil(0.10 * K))
```

Both profiles also carry `approved_discovery_budget_rounds`, default `null`. Set
it to a positive integer to approve a **smaller** discovery budget than
`max_round`; leave it `null` to use `max_round` alone. It freezes with the profile,
enters the protocol fingerprint, and is re-declared in every round manifest —
changing it mid-run is a protocol change that zeroes `frontier_streak`, and a
manifest that disagrees with the profile fails the round.

Conflict → `rich` wins. Profile selection happens only after Phase 3, when
`approved_topics`, `eligible_demand_themes`, and `initial_surface_inventory` are
computable.

**Every profile constant is immutable for the whole run** — `K`, `V_accept`,
`V_critical`, `N`, `delta`, `streak`, `max_round`, `coverage_floor_n`,
`coverage_floor_threshold`, `min_new_surface_count`. The gate re-checks each one
against the built-in profile and fails on any deviation, including a deletion.
There is no in-project threshold tuning: freeze the profile, `K`, the
probe-family portfolio, the canonicalizer, and the E/D/P/T rubric before
calibration, and leave them alone. Re-tuning `N` / `delta` belongs to a future
package version, decided from a complete ledger — never inside the run whose
result it would change.

## Full workflow

### Phase 1: Normalize inputs

Invoke prompt-map-input-normalizer. Semrush volume, GEOly public prompt IDs,
GEOly topic/card record IDs, and Reddit `post_id` / `comment_id` / `author` must
survive normalization or the D buckets and the Coverage Floor cannot be
recomputed. Pause for approval.

### Phase 2: Extract demand and build the evidence index

Invoke prompt-map-demand-extractor. Build the complete category demand master,
preserve the approved internal Topic structure, and emit the standardized
`work/02_evidence_index.csv` (`evidence_id, source_type, source_record_id,
cluster_id, evidence_text, source_metric, source_url, demand_theme_key,
floor_candidate`). Gate A cannot run without it. Pause for approval.

### Phase 3: Build the initial coverage baseline and living registry

Invoke prompt-map-demand-grid. In `cold_start`, build grouped coverage
requirements without creating Prompt text. In `revision`, also link existing
Prompts to requirements and produce audit gaps.

In `geo_full_coverage`, this phase must produce a **rich surface grid**, not a
minimal cell list:

1. **Topic decomposition** — decompose demand into 12–16 internal Topics for a
   data-rich category along the strongest evidence axes (body-part, attribute/
   condition, audience/persona, pain, scenario, access). Do not collapse
   distinct axes.
2. **Decision-angle grid inventory** — list the evidence-supported subset of the
   ~20 decision angles (see `geo-coverage-mode.md`) per Topic/audience.
3. **Surface enumeration** — one coverage cell per canonical query surface
   (audience × body-part × attribute × scenario × decision-angle ×
   decision-criterion).
4. **High-value Topic intersections** — enumerate evidence-backed cross-Topic
   combinations (e.g. dark-skin × brazilian, PCOS × face) as their own surfaces.

The result is an **initial coverage baseline inside a living registry**, never a
discovery ceiling. Pause for approval.

### Phase 4: Freeze the profile and the discovery protocol

1. Compute `approved_topics`, `eligible_demand_themes`, and
   `initial_surface_inventory`; select `rich` or `narrow`; write and freeze
   `state/convergence_profile.json` with `profile_frozen=true`.
2. Write **`state/discovery_protocol.json`** — a required project file holding the
   actual content of all seven probe families: each family's prompt template,
   allowed derivation rules, prohibitions, and evidence requirements. It also
   holds `approved_derivation_rule_ids`, the **single authoritative derivation
   rule table**. Because this file is what `discovery_protocol_sha256` hashes, the
   rule table is frozen with the protocol; there is no fallback file, and any rule
   list kept elsewhere is unhashed and must not be used or referenced. The
   convergence profile must **not** carry a copy of `approved_derivation_rule_ids`
   — that field has been removed, and a profile still carrying it is an integrity
   failure. Each
   family's `allowed_derivation_rules` must be **non-empty** and a subset of the
   global table. If `approved_derivation_rule_ids` is missing or empty,
   `support_mode=derived` is unavailable and every derived row scores E0 — absence
   fails closed, never into a permissive mode. In practice an empty global table
   cannot coexist with the non-empty per-family requirement, so the protocol fails
   validation outright as an integrity failure; populate the table, and simply
   author no `derived` rows if the project should not use derivation.
3. Freeze the discovery protocol **before the first calibration round**:
   `discovery_protocol_id`, `discovery_protocol_sha256`, `canonicalizer_version`,
   `value_rubric_version`, `materiality_rule_version`, probe-family quotas,
   prompt-template hashes, model ID, temperature, and the hard materiality gate.
   `discovery_protocol_sha256` must equal the **real sha256 of
   `state/discovery_protocol.json`**; both `prepare-round` and `verify` recompute
   it, so a hand-written hash, a post-freeze edit, or deleting the file is caught.
   Calibration determines nothing afterwards — every profile constant is
   immutable.

The Coverage Floor batch is NOT drawn here. It is a holdout: drawing it before
generation would let the generator see the sample it is later measured against,
and the script cannot anchor the sampled-map hash until a final map exists.
Sampling happens in Phase 9. Pause for approval.

### Phase 5: Initial Closure over the baseline

Invoke prompt-map-generator in `initial` mode (in `revision`, in `revision`
mode; never run `initial` against a `revision` run). Close every baseline
obligation: Category routes, all 12–16 Topic routes, the decision-angle grid, and
the approved Topic intersections. Each row carries the six surface fields and an
evidence tier (`已验证` / `Reddit已验证/长尾` / `待验证假设`).

**Closing the baseline is not a stopping condition.** It satisfies the Closure
Stream only and produces a base, not a deliverable. Do not cap a theme at three
rows and do not multiply themes × Topics × intent labels with no distinct surface.
Run the generation-integrity guardrail and treat a non-zero exit as blocking:

```
python3 ../prompt-map-shared/scripts/validate_generation_integrity.py --registry <project-root>/work/02b_coverage_registry.csv --prompts <project-root>/work/03_prompt_draft.csv --angle-inventory <project-root>/work/03_route_angle_inventory.csv --angle-links <project-root>/work/03_prompt_angle_links.csv --ledger <project-root>/work/03_candidate_surface_ledger.csv --coverage-mode <coverage_mode>
```

Pause for approval.

### Phase 6: Calibration — exactly 3 rounds, Gate B disabled

Run prompt-map-generator in `discovery` mode for exactly three rounds at the
profile's `K`, with the frontier gate DISABLED. Prepare each with
`prepare-round --calibration` so the round manifest records
`calibration_round: true`. Calibration rounds **never increment `coverage_round`
or count toward `max_round`**; they increment `calibration_round`.

Calibration rounds occupy round directories like any other round, and the
active-round numbering continues upward from the last calibration round — never
restart at `r01`. Two invariants follow, and both must hold before a `PASS`:

- The frontier streak may only be counted over rounds whose manifest has
  `calibration_round: false`. A streak that includes a calibration round is a
  blocking protocol failure to escalate, not a pass.
- Round kind is declared, never inferred. Each `00_round_manifest.json` carries
  `round_kind: calibration | active`, and **nothing is derived from the directory
  number**. Directories stay contiguous from `r01`; calibration rounds must be a
  **leading contiguous prefix**, and once `calibration_complete=true` there must
  be **exactly 3** of them.
- `coverage_round` = the **count of active rounds**. `calibration_round` = the
  count of calibration rounds. After three calibration rounds, active round `r04`
  is `coverage_round = 1` / `calibration_round = 3`. The gate reconciles both
  counts against the manifests on disk, so calibration genuinely does not consume
  the `max_round` budget. `score-round --emit-run-state-patch` derives both
  counters from the declared `round_kind` and emits them ready to apply — take the
  patch as-is and never hand-edit either counter.
- `frontier_streak` accumulates over **active rounds only**, and must be the last
  `streak` contiguous active rounds — an older comparable round may not be
  substituted for a failing recent one.

All three rounds must share one probe-family profile, prompt-template hashes,
model ID, temperature, canonicalizer, E/D/P/T rubric, and hard materiality gate.
This is observation only — **do not edit the probe because a round yielded
little.**

Record per round: `candidate_count, new_surface_count, exploratory_new_count,
probe_degenerate, identical_existing_count,
duplicate_within_round_count, invalid_surface_count, hard_material_count, C, H, M,
D, score_060_069_count, score_070_079_count, score_080_084_count,
score_085_plus_count, accepted_by_probe_family, rejected_by_reason,
template_detected_count, template_resolved_count,
human_reject_after_value_gate_count`.

**Calibration never changes a threshold.** It is pure observation: the profile
constants are immutable and the gate fails on any deviation, so an in-project
recalibration of `N` or `delta` cannot be executed at all. Re-tuning belongs to a
future package version, decided from a complete ledger. Calibration's job is to
show you what the probe actually yields before the frontier gate starts counting.

Human review remains as a quality observation over three sets, each getting
`human_keep=Yes/No`: every `value_gate_pass=Yes` row, every near-threshold row
with `0.55 <= V < 0.60`, and the deterministic `identical_existing` sample. It
drives **no** threshold change. The identical-sample portion is no longer
advisory — it is enforced per round through `09_identical_recheck.csv`.

Use the calibration read-out to decide whether the **probe** is sound, not whether
the thresholds are. A `probe_degenerate` calibration round (fewer than
`min_new_surface_count` **exploratory** new surfaces — `new`, `direct`/`derived`,
with at least one resolvable `evidence_refs` entry) means the probe is either
transcribing the existing map or padding with unevidenced `hypothesis` rows. Fix
it before active rounds begin: that is a probe defect, never evidence of
saturation.

Exactly 3 calibration rounds are required, on `narrow` as well as `rich`. The gate
reads `calibration_complete`: setting it `false` while active rounds exist on disk
is an integrity failure, and setting it `true` with any number of calibration
rounds other than 3 is likewise an integrity failure. Set
`calibration_complete=true` only after the third round, then freeze the active
protocol. Pause for approval.

### Phase 7: Active rounds — Closure plus Discovery

Repeat per active round `rNN`, incrementing `coverage_round`:

1. Freeze `00_base_prompts.csv` / `00_base_registry.csv` and prepare slots
   (`--prepare-round`). `base_map_sha256` anchors to `00_base_prompts.csv`, never
   to `03_prompt_draft.csv` or `05_prompt_final.csv`, which get overwritten.
2. **Discovery Stream** — generator Stage 1 (all `K` candidates, 10 agent
   columns) → scripted novelty → Stage 2 (12 agent columns, `new` rows only) →
   scripted scoring. All `K` rows, rejects included, land in the ledger.
3. Append accepted surfaces to `06_round_registry.csv` as **open obligations**
   (`surface_origin=discovery`, `introduced_round=rNN`, `cell_status=open`, empty
   `covered_prompt_ids`, computed `frontier_value_score`). `discovered != covered`.
4. **Closure Stream** — generator `supplement` mode closes both the pre-existing
   gap queue and this round's accepted discovery obligations, authoring natural
   Prompts into `05_round_prompts.csv`. `06_round_registry.csv` starts as a full
   copy of `00_base_registry.csv` before accepted surfaces are appended, and
   `05_round_prompts.csv` starts as a full copy of `00_base_prompts.csv` before
   the round's new Prompts are added — it is the after-round map, not a delta.
   This round's new rows are also appended to the project-level
   `work/03_candidate_surface_ledger.csv` before the validators run.
5. Run the three prompt-authoring guards
   (`validate_shortlist_difference.py`, `validate_generation_integrity.py`,
   `validate_prompt_surface_quality.py`, all `--coverage-mode geo_full_coverage`).
   During the discovery surface phase run only exact-duplicate / identical-signature
   / invalid-surface checks; the template validator runs only once Prompt text
   exists.
6. Invoke prompt-map-coverage-audit for the round audit
   (`07_round_coverage_audit.csv`). Only a linked valid Prompt flips a registry
   row to `cell_status=covered`; otherwise it stays `cell_status=open` with
   `gap=SUPPLEMENT`.
7. Promote round files to current state only after validators and audit pass.
8. Read this round's Gate B result from `08_round_summary.json`
   (`frontier_passed`, `candidate_count`, `accepted_material_count`,
   `critical_new_count`, `value_mass`, `value_density`), which `score-round`
   already computed, and update `frontier_streak` accordingly. Do **not** run the
   full `verify` gate here: `verify` also evaluates Gate A and the final map, and
   before dedupe, the final audit, and an annotated floor batch exist it can only
   return a meaningless `CONTINUE`/`FAIL`. Run
   `verify --project-root <project-root> --stage round` only as an optional mid-run
   sanity check, never as this round's verdict. `verify` accepts
   `--stage round|final-audit|delivery` plus optional `--registry` and
   `--final-map` overrides when the artifacts are not at their default paths.

**Gate B single-round pass** requires ALL of `candidate_count == K`, `H_t == 0`,
`C_t <= N`, `D_t < delta`, **`probe_degenerate == false`**, and
**`identical_recheck_complete == true`**. The last two are what stop a round of
transcribed, already-existing surfaces from reading as a perfect frontier pass;
a degenerate round in the streak fails the whole streak. Frontier exhaustion requires `streak` consecutive
passing rounds under an identical protocol hash.

**Protocol changes reset the streak.** The full **protocol fingerprint** is
`discovery_protocol_sha256`, `canonicalizer_sha256`, model ID, temperature,
`value_rubric_version`, `materiality_rule_version`, `K`, `family_quotas`,
`{V_accept, V_critical, N, delta}`, `approved_discovery_budget_rounds`,
`min_new_surface_count`, and `slot_hash`. The **streak-comparable fingerprint** is
that tuple minus its last element. `slot_hash` is excluded because it binds this
round's own candidate-slot integrity — the slots are generated deterministically
and their hash includes the `rNN`-scoped `candidate_id`s, so it is a per-round
field that has no cross-round protocol meaning.

The three-way split below covers the **streak-comparable** members. `slot_hash`
is not one of them: it is a per-round integrity field the script freezes before
each round and checks against that round's own Stage 1 rows. It is never compared
across rounds and carries no protocol meaning.

Three distinct behaviours hide in the streak-comparable list. Treat them
differently:

- **Freely changeable, reset the streak.** Model ID and temperature are recorded
  per round and only ever compared across the streak. Changing one sets
  `frontier_streak = 0` and `protocol_revision_count += 1`; earlier rounds stay
  valid.
- **Changeable only by re-running history.** `discovery_protocol_sha256`, the
  canonicalizer, `approved_discovery_budget_rounds`, `value_rubric_version`, and
  `materiality_rule_version` are re-checked on **every historical round manifest
  against the current value** (the last two against the code's own constants).
  Changing one does not merely zero the streak — it makes every earlier round an
  integrity failure until those rounds are re-run under the new protocol. Plan such
  a change as a restart, not as a revision you can absorb.
- **Not changeable at all.** `K`, `family_quotas` (probe-family quotas),
  `V_accept`, `V_critical`, `N`, `delta`, and `min_new_surface_count` are profile
  constants that a round manifest may not redefine, and `streak`, `max_round`,
  `coverage_floor_n`, `coverage_floor_threshold`, and `floor_quotas` are profile
  constants guarded by profile equality rather than by the fingerprint. Editing or
  deleting any of them is an **integrity failure at the gate — not a streak reset
  and not a protocol revision.**

Do NOT reset for: adding accepted Prompts, rewording without changing a surface,
adding evidence URLs, resolving template REVIEWs, CSV column order, or summary
edits.

**Anti-perpetual-calibration:** calibration is **exactly 3 rounds** — a count to
hit, not a cap to approach — and changes no threshold. After protocol freeze **at
most ONE protocol revision** is allowed. That budget applies to the changeable
fingerprint members from the previous section (model ID and temperature freely;
`discovery_protocol_sha256`, the canonicalizer, `approved_discovery_budget_rounds`,
`value_rubric_version`, and `materiality_rule_version` only alongside re-running
the affected rounds).
Editing a profile constant is **never** a revision — it is an integrity failure at
the gate. A second proposed revision does not restart calibration —
escalate to a human decision between continuing on the current protocol and taking
`PASS_WITH_BACKLOG`.

Pause for approval each round.

### Phase 8: Semantic dedupe

Invoke prompt-map-semantic-dedupe. Preserve meaningful people, body, scenario,
pain, Topic, and decision distinctions, and carry the discovery lineage fields
through. The final map must remain an additive superset of accepted discovery
coverage. Pause for approval.

### Phase 9: Final audit, Coverage Floor sampling, and the two gates

1. Invoke prompt-map-coverage-audit in `post-dedupe-final` mode against
   `work/05_prompt_final.csv`.
2. Draw the Coverage Floor batch by script — never by the agent, and only now
   that a final map exists to anchor against:

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py prepare-floor --project-root <project-root> --batch 1
```

Rich `n=60`: Reddit 30 / Semrush 20 / GEOly 10 / Brand 0. Narrow `n=50`:
Reddit 25 / Semrush 15 / GEOly 10 / Brand 0. Rows are drawn over
`floor_candidate == Yes` in hash order; within the Semrush quota, the first half
by descending volume and the second half by hash order. The batch lands in
`work/coverage_floor/batch1/floor_batch.csv`.

3. Invoke prompt-map-coverage-audit in `coverage-floor` mode to annotate the batch
   — the agent fills only `eligible`, `exclusion_reason`, and the six surface
   fields, never `surface_signature`, `covered`, or `covered_prompt_ids`. An
   unannotated batch cannot pass Gate A.
4. Run the gate and the validators:

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py verify --project-root <project-root> --stage final-audit
python3 ../prompt-map-shared/scripts/verify_decision_angle_gate.py --project-root <project-root> --stage final-audit
python3 ../prompt-map-shared/scripts/validate_shortlist_difference.py --prompts <project-root>/work/05_prompt_final.csv --coverage-mode <coverage_mode>
python3 ../prompt-map-shared/scripts/validate_generation_integrity.py --registry <project-root>/work/02b_coverage_registry.csv --prompts <project-root>/work/05_prompt_final.csv --angle-inventory <project-root>/work/03_route_angle_inventory.csv --angle-links <project-root>/work/05_prompt_angle_links.csv --ledger <project-root>/work/05_candidate_surface_ledger.csv --coverage-mode <coverage_mode>
python3 ../prompt-map-shared/scripts/validate_prompt_surface_quality.py --prompts <project-root>/work/05_prompt_final.csv --coverage-mode <coverage_mode> --strict --resolved-ledger <project-root>/state/template_resolutions.json --output <project-root>/work/05_surface_quality_report.json
```

Treat a non-zero exit from ANY of them as blocking and return to the relevant
audit or supplement step. The generation-integrity and surface-quality guards MUST
run against the post-dedupe `05_prompt_final.csv`, not only the initial draft —
dedupe or supplementation can drop surface links or reintroduce templating after
an earlier check passed. `verify_decision_angle_gate.py` calls
`verify_coverage_convergence.py` rather than reimplementing it, then continues
with its freshness / Prompt-ID / delivery reconciliation checks.

**Gate A — Coverage Floor.** The floor is recomputed from the floor ledger
against `work/05_prompt_final.csv`: `n` eligible rows, `x` uncovered, Wilson upper
bound at `z=1.645`, `passed = upper < 0.10`. `n` must reach the profile's
`coverage_floor_n`. Verified tolerances: rich `n=60` → `x=2` upper 9.59% PASS,
`x=3` upper 11.87% FAIL; narrow `n=50` → `x=1` upper 8.48% PASS, `x=2` upper
11.39% FAIL. If exclusions leave `n` below `coverage_floor_n`, top the batch up
from the same source's next hash-ordered rows before judging it.

**Two different shortfalls, two different remedies — never mix them.**

*Sample too small after exclusions* (`n < coverage_floor_n` because rows were
judged ineligible). Top the same batch back up:

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py prepare-floor --project-root <project-root> --batch <N> --top-up
```

`--top-up` requires every existing row to already carry an `eligible` verdict, then
deterministically adds still-unsampled rows — same source first, then the
`reddit -> geoly -> semrush` reallocation order. Annotate only the added rows and
re-judge. The gate recomputes the expected top-up and fails if the added evidence
was hand-picked. `--top-up` is for eligibility exclusions ONLY.

*Batch failed the Wilson bound.* Never repair against the same batch and then
declare that batch passing, and never use `--top-up` to dilute a failure. The full
cycle is: Batch 1 FAIL → the missed surfaces enter the gap queue → **return to
Phase 7 supplement** → re-run dedupe (Phase 8), the final audit, and all
validators → freeze the new `05_prompt_final.csv` → only then
`prepare-floor --batch 2`, which draws from evidence Batch 1 never sampled (the
gate verifies the two batches are disjoint) → annotate and judge Batch 2
independently. At most two batches; still failing → `coverage_floor_passed = false`
and no normal PASS.

`coverage_floor_mode = registry_proxy` is allowed only when the base/angle/final
audits all pass, `high_priority_uncovered_count == 0`, and a human approves that
evidence sampling cannot be run. It caps the run at `PASS_WITH_BACKLOG`, must
never emit a normal `PASS`, and must never claim a Wilson bound.

### Phase 10: Outcome

Four statuses, decided by the verifier, never by narrative judgement:

- **`PASS`** — Gate A passed, hard blockers zero, Gate B frontier exhausted over
  the required streak under one protocol hash.
- **`PASS_WITH_BACKLOG`** — Gate A passed, hard blockers zero, `coverage_round >=
  max_round` **or**, when `approved_discovery_budget_rounds` is non-null, the
  active-round count has reached it — the two equivalent ways budget exhaustion is
  expressed, both measured in active rounds. `max_round` itself is a frozen
  profile constant and any edit to it fails the gate; approving a smaller budget
  is done by freezing `approved_discovery_budget_rounds` with the profile, not by
  editing `max_round` mid-run. **The budget condition is never waived**, not even
  by a `capped_at_backlog` condition. Frontier still open **or** the run capped at
  backlog,
  this round's high-value surfaces already merged into the map, remaining frontier
  candidates plus mid/low-value derived surfaces plus exploration directions
  attached as `outputs/discovery_backlog.csv`, and
  `human_backlog_delivery_approved = true`.
- **`CONTINUE`** — not yet convergent, no hard failure. Run another active round.
- **`FAIL`** — floor failed, or high-priority gaps, or validator blockers, or an
  incomplete ledger/protocol, or an attempt to converge by shrinking the
  denominator or editing the rubric.

Hard blockers are zero when `high_priority_uncovered_count == 0`,
`unresolved_query_surface_gap_count == 0`, `unresolved_intersection_gap_count == 0`,
`template_review_count == 0` (unresolved only), and
`hard_validator_failure_count == 0`.

**Reduced evidence.** If the project has no Semrush input at all, record
`reduced_evidence_sources += ["semrush"]`. The Coverage Floor still runs, but the
run is **permanently capped at `PASS_WITH_BACKLOG`**. There is no human-approval
upgrade path — the gate's `capped_at_backlog` flag makes a normal `PASS`
unreachable, and asking a human to approve one is asking for something the gate
will refuse. The same permanent cap applies to `coverage_floor_mode =
registry_proxy` and to `evidence_pool_short_of_n` (the eligible evidence pool is
smaller than `coverage_floor_n`). Brand material may never substitute for Semrush.

The cap limits the best achievable outcome; it never waives the budget condition.
`PASS_WITH_BACKLOG` still requires `budget_spent` — that is,
`active rounds >= max_round` or `>= approved_discovery_budget_rounds`. A capped
run that has not spent its budget reads `CONTINUE`, not `PASS_WITH_BACKLOG`.

### Phase 11: Delivery

Invoke prompt-map-delivery using the approved delivery contract, only on `PASS` or
`PASS_WITH_BACKLOG`. In `cold_start`, this is the reusable seven-column
category/internal-Topic structure; in `revision`, preserve the accepted workbook
structure. Pause for final human acceptance.

## Completion language

Use one of these statuses precisely. Never claim "exhaustive category complete".

- **基础单元覆盖完成 / base-cell coverage complete**: baseline obligations are
  linked, but neither gate has passed. Not a delivery-ready conclusion.
- **`coverage_floor_passed` + `frontier_exhausted`**: "evidence coverage floor
  passed; discovery frontier exhausted." This is `PASS`.
- **`coverage_floor_passed` + `frontier_open`**: "evidence coverage floor passed;
  discovery frontier not fully exhausted within the approved budget; backlog
  attached." This is `PASS_WITH_BACKLOG`.

Reopen a completed map when new evidence adds a new person/body-fit, scene, pain,
function, result expectation, purchase stage, tradeoff, or ranking criterion, or
when a backlog item is promoted. Synonym-only changes do not reopen it.

## Rerun behavior

Run only the failed or edited module and invalidate downstream consumers:

normalize -> demand+evidence-index -> coverage-registry -> profile+protocol-freeze -> initial-closure -> calibration(x3) -> active-round(discovery+closure+round-audit) -> dedupe -> final-audit+floor-sample+floor-annotation+gates -> delivery

A Coverage Floor miss re-enters at `active-round` supplement and must re-run
dedupe and the final audit before Batch 2 may be drawn.

## Gate message

After every module and every round, summarize what was completed, inputs and
outputs, counts, gaps, `C_t / H_t / M_t / D_t`, `frontier_streak`, Coverage Floor
state, current convergence status, and the next module. Wait for 通过/继续, 修改,
重跑, or 停止.

End with the shared HandoffContract, including `CoverageFloor`,
`DiscoveryFrontier`, `ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and
`ProtocolVersion`.
