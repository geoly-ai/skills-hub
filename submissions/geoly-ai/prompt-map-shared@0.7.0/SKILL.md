---
name: prompt-map-shared
description: Shared contracts, schemas, evidence policy, product-card rules, and handoff requirements for the modular product-card Prompt Map workflow. Read this before any prompt-map module or when validating a project handoff.
---

# Prompt Map Shared

This Skill is the source of truth for all Prompt Map modules. It is not a user-facing workflow by itself.

## GEO default operating doctrine

When `coverage_mode=geo_full_coverage` (the default), the objective is **maximum
evidence-scoped query-surface coverage, not a minimal Prompt set**. Always
**build the initial coverage baseline first** (Topic decomposition →
evidence-backed angle inventory → canonical surface enumeration → high-value
Topic intersections), **generate natural Prompts second**, and **dedupe/audit
only after expansion**. Never write a few dozen Prompts and then guess whether
they cover the space.

The expected output for a data-rich category is commonly in the **many
hundreds**; a small output is a **coverage-risk signal to investigate, never a
compact success**. If a data-rich baseline produces a two-hundred-row map, treat
that as evidence the generator was truncated by a closed inventory, and
investigate before approving. Do not optimize for the smallest acceptable count
and do not set a fixed minimum quota — preserve distinct evidence-backed surfaces
for review and remove only exact duplicates, identical canonical surfaces,
unsupported combinations, and confirmed same-surface template variants.

### Two streams, two gates, one escape hatch

`convergence_method = "coverage_floor_plus_value_frontier_v1"`. Generation is
**never** bounded by a pre-enumerated inventory. It runs as two independent
streams, both active in every round:

- **Closure Stream** — close every known obligation in the living registry
  (baseline surfaces, gap queue, and surfaces this round's Discovery accepted).
- **Discovery Stream** — probe exactly `K` open candidates per round across fixed
  probe families. Qualifying surfaces are **appended to the living registry** as
  new obligations. An off-inventory high-value surface may never be rejected for
  being off-inventory.

Termination is owned by two opposing gates, recomputed from the ledgers by
`scripts/verify_coverage_convergence.py` — never by an agent-written float:

- **Gate A — Coverage Floor** (recall floor, prevents under-production): Wilson
  upper bound at `z=1.645` over an independent evidence sample must be `< 0.10`,
  with `n` reaching the profile's `coverage_floor_n` (rich 60, narrow 50).
- **Gate B — Value Frontier Exhaustion** (guarantees termination): a round passes
  only with `candidate_count == K`, `H_t == 0`, `C_t <= N`, and `D_t < delta`;
  exhaustion needs `streak` consecutive passing rounds under one protocol hash.
  Rich `K=100, N=5, delta=0.039`; narrow `K=40, N=3, delta=0.062`;
  `V_accept=0.60`, `V_critical=0.85`, `streak=2`.
- **`PASS_WITH_BACKLOG`** — the escape hatch: at approved-budget exhaustion,
  deliver with `outputs/discovery_backlog.csv` and explicit human approval rather
  than deadlock.

`discovered != covered`: an accepted discovery surface creates an obligation that
only a linked valid Prompt can close. "The approved surface inventory is
exhausted" is **not** a stopping condition in this package version, and any module
still phrasing completion that way is superseded by this doctrine.

## Required reading

Read the references relevant to the active module:

- `references/geo-coverage-mode.md`: **read first** — the default GEO full-coverage doctrine, query-surface signature, decision-angle grid, Topic decomposition, intersections, and `coverage_mode`.
- `references/discovery-protocol.md`: **read before any discovery round** — the two-stage ledger, probe-family portfolio, per-round directory, anti-gaming rules, and the frontier math worked examples.
- `references/value-rubric.md`: the hard materiality gate and the E/D/P/T buckets behind `V = 0.30*E + 0.25*D + 0.30*P + 0.15*T`. Agents write enums and counts only; the script derives every score.
- `references/coverage-floor-sampling.md`: Gate A — the evidence-index sampling quotas, the closed `exclusion_reason` enum, the Wilson computation and verified tolerances, the two-batch rule, and degraded `registry_proxy` mode.
- `references/coverage-loop.md`: the explicit multi-round loop (expand → guard → audit → gap → validation round → convergence) and its calibration + max-round rules.
- `references/context-contract.md`: project identity, required inputs, resume behavior.
- `references/evidence-policy.md`: how each source may and may not be used.
- `references/demand-schema.md`: demand master fields.
- `references/prompt-schema.md`: Prompt master and delivery fields.
- `references/prompt-card-rules.md`: Prompt eligibility.
- `references/dedupe-rules.md`: semantic key and registry rules.
- `references/v1-expansion-rules.md`: accepted first-version-compatible
  category/Topic expansion and stopping rules.
- `references/generation-integrity.md`: required route/candidate fields and the
  route-angle inventory contract the generation-integrity guardrail enforces.
- `references/shortlist-difference-test.md`: cross-category test for deciding
  whether a new Prompt opens a new query surface (GEO) / changes the product
  shortlist (minimal).
- `references/reddit-input-handoff.md`: the Reddit files consumed by Prompt
  Map, traceability checks, and evidence-role boundaries. Reddit collection is
  performed outside this package.
- `references/handoff-schemas.md`: module summary contract.
- `references/project-layout.md`: file ownership and output paths.
- `references/status-vocabulary.md`: allowed review/evidence statuses.
- `references/routing.md`: which module to invoke.

## Shared operating rules

0. Declare `coverage_mode` (default `geo_full_coverage`). In GEO mode the unit of
   coverage is a distinct **query surface** (audience × body-part × attribute ×
   scenario × decision-angle × decision-criterion), not a distinct product
   shortlist — keep a Prompt for every new evidence-backed surface, merge only
   true duplicates. Read `references/geo-coverage-mode.md`. `minimal_dedup` is the
   legacy shortlist-only posture.
1. Treat evidence sources as complementary. No single source defines the complete demand universe.
2. Build the complete category demand master before assigning prompts to Topics.
3. Apply the two-layer expansion rules before dedupe: Category routes for
   cross-Topic needs, then independent Topic routes for every approved
   evidence-backed Topic. Read `references/v1-expansion-rules.md`.
4. Generate Topic prompts when a Topic adds or reframes a real person, scene,
   pain point, body/object, function, result, or decision criterion that opens a
   new query surface (GEO) / changes the product shortlist or ranking (minimal).
   Do not use a fixed per-cell cap or a mechanical Cartesian product of axes.
5. Every delivered Prompt must name or clearly refer to the correct purchasable product category and ask for product selection, comparison, fit, or evaluation.
6. Do not force the client brand into neutral prompts or assume its product is the answer.
7. Preserve evidence-backed long-tail demand even when Semrush volume is absent.
8. Stop at every module boundary for human approval.
9. A coverage gap returns to generation. Dedupe must never be the last quality check; run final coverage audit afterward.
10. Final audit and delivery must execute
    `verify_decision_angle_gate.py --project-root <project-root> --stage <final-audit|delivery>`.
    A non-zero result blocks the workflow. This is the executable guardrail
    against treating base-cell coverage as decision-angle completeness.
11. Final audit and delivery must also validate the Prompt file with
    `validate_shortlist_difference.py --prompts <final-prompts.csv> --coverage-mode <mode>`.
    In `geo_full_coverage`, exact-text duplicates, identical query-surface
    signatures, empty surface fields, and product-card-ineligible rows are
    blocking; generic shortlist deltas and same-surface near-duplicates are
    warnings for review. In `minimal_dedup`, reused shortlist deltas remain
    blocking (legacy behavior).
12. In `geo_full_coverage`, convergence is owned by
    `verify_coverage_convergence.py`, whose subcommands are `prepare-floor`,
    `prepare-round`, `score-round`, and `verify`. It RECOMPUTES novelty, materiality, every value
    component, `C_t / H_t / M_t / D_t`, and the Wilson bound from the ledgers.
    `verify_decision_angle_gate.py` calls it rather than reimplementing it. No
    module may pre-fill a rate, score, or boolean the verifier is meant to
    recompute; doing so is a blocking protocol violation.
13. Agents write **enums and counts, never derived floats**. Discovery Stage 1 is
    10 agent columns; Stage 2 is 12 agent columns, for script-adjudicated `new`
    rows only; the Coverage Floor batch is 8 agent columns. Every other column
    belongs to the script.
14. Freeze before the first **calibration** round: the convergence profile, the
    discovery protocol hash, probe-family quotas, prompt-template hashes, model ID,
    temperature, the canonicalizer, the hard materiality gate, the E/D/P/T rubric,
    and `min_new_surface_count`. **Calibration is observation only — it computes,
    proposes, and adjusts no threshold whatsoever.**

    The frozen set splits three ways, and the difference matters:
    - Model ID and temperature can genuinely change mid-run. That is what the
      reset rule is for: the change zeroes `frontier_streak` and costs the one
      allowed protocol revision, while earlier rounds stay valid. A second
      proposal escalates to a human choice between continuing on the current
      protocol and taking `PASS_WITH_BACKLOG`.
    - `discovery_protocol_sha256`, the canonicalizer,
      `approved_discovery_budget_rounds`, `value_rubric_version`, and
      `materiality_rule_version` are re-checked on every historical round manifest
      against the current value, so changing one invalidates all earlier rounds
      until they are re-run. Treat it as a restart, not an absorbable revision.
    - `K`, `family_quotas`, `V_accept`, `V_critical`, `N`, `delta`,
      `min_new_surface_count`, `streak`, `max_round`, `coverage_floor_n`,
      `coverage_floor_threshold`, and `floor_quotas` are **profile constants:
      immutable within a run**. The gate checks each for presence AND equality
      against the built-in profile, so deleting one is a failure too, not a way to
      make it unenforceable. Editing one is an **integrity failure at the gate,
      never a protocol revision** — some of them are fingerprint members and some
      are guarded by profile equality alone, but neither route lets a run change
      them. They change only with a new package version, derived from a complete
      ledger across projects — never from the run being judged.

    Calibration is **exactly 3 rounds** — a count to hit, not a cap to approach —
    and never counts toward `max_round`.
15. Run/delivery statuses are `PASS`, `PASS_WITH_BACKLOG`, `CONTINUE`, and
    `FAIL`, plus the paired vocabulary `frontier_exhausted` / `frontier_open` and
    `coverage_floor_passed` / `coverage_floor_failed`. Keep them OUT of the
    evidence-tier vocabulary (`已验证` / `Reddit已验证/长尾` / `待验证假设`).
    Never claim "exhaustive category complete".
16. New registry surfaces have exactly two legal origins. Discovery surfaces
    enter via `04_accepted_surfaces.csv` after passing the value gate;
    Closure-originated surfaces must be declared in
    `work/coverage_rounds/rNN/06_closure_additions.csv` BEFORE they are appended
    to `06_round_registry.csv`. Anything else appearing in the next round's base
    registry is **registry stuffing** and fails the gate, and an inherited
    obligation may never be dropped.
17. Round bookkeeping is declared, not inferred. Every round manifest carries
    `round_kind: calibration | active`; `coverage_round` is the count of ACTIVE
    rounds and `calibration_round` the count of calibration rounds — never a
    directory number. Calibration rounds must be a leading contiguous prefix and
    must number **exactly 3** once `calibration_complete=true`, and
    `frontier_streak` accumulates only over the last contiguous active rounds. Budget exhaustion is `active rounds >= max_round` **or**
    `active rounds >= approved_discovery_budget_rounds` when that profile field is
    frozen non-null.
18. `template_review_count` is recomputed by re-running the detector against the
    CURRENT map and applying `state/template_resolutions.json`. Re-run the
    detector after any Prompt rewrite or merge; a resolution key for a finding the
    detector no longer fires resolves nothing.
19. **Anti-degenerate probe floor.** Every round must yield at least
    `min_new_surface_count = max(5, ceil(0.10 * K))` **exploratory** new surfaces
    (10 rich / 5 narrow). A candidate counts toward `exploratory_new_count` only
    when `novelty_status == new`, `support_mode` is `direct` or `derived`, and at
    least one `evidence_refs` entry resolves in the frozen evidence index;
    `new_surface_count` remains a diagnostic only. Below the floor the round is
    `probe_degenerate`: not a frontier pass, not in the streak, and a hard blocker
    for human review.

    Neither transcribing existing surfaces nor inventing `hypothesis` ones is
    probing. Transcription yields `C=0, H=0, D=0` — arithmetic that reads as a
    perfect frontier pass while discovering nothing; unevidenced invention would
    satisfy a signature-only count while doing the same. An evidenced new surface
    that fails the value bar **does** count: that is what genuine saturation looks
    like. The floor is orthogonal to `C` / `H` / `D`, and enforcement covers those
    three conditions only — a family's free-text `evidence_requirements` cannot be
    machine-adjudicated (`verify` reports the actual scope in
    `evidence.probe_floor_enforcement`). Each round also requires a complete
    `09_identical_recheck.csv`.
20. **Calibration is exactly 3 rounds**, on `narrow` as well as `rich`, and it
    changes no threshold. Profile constants are immutable for the whole run and
    the gate fails on any deviation or deletion; re-tuning `N` / `delta` belongs
    to a future package version decided from a complete ledger, never to the run
    whose result it would change. `calibration_complete` must be `true` before any
    active round and only with exactly 3 calibration rounds on disk.
21. **Degraded conditions cap the run permanently.** `reduced_evidence_sources`,
    `evidence_pool_short_of_n`, and `coverage_floor_mode = registry_proxy` each
    cap the outcome at `PASS_WITH_BACKLOG` with **no human-approval upgrade path**
    to a normal `PASS`. A cap limits the ceiling; it never waives the budget
    condition, so a capped run that has not spent its budget is `CONTINUE`.
22. Every skill must run independently for a narrow task, but full-flow work must
    pass through these contracts. **Stop, don't guess**: when a required upstream
    input, frozen profile, protocol hash, or memory field is missing, halt and ask
    for evidence rather than fabricate it. End a handoff with the HandoffContract
    block, including `CoverageFloor`, `DiscoveryFrontier`, `ConvergenceStatus`,
    `DeliveryStatus`, `BacklogFiles`, and `ProtocolVersion`.

The shared guardrail scripts — `verify_coverage_convergence.py`,
`verify_decision_angle_gate.py`, `validate_shortlist_difference.py`,
`validate_generation_integrity.py`, and `validate_prompt_surface_quality.py` —
live in this shared skill's `scripts/` directory. Paths in a skill are relative
to that skill's own install directory, so invoke them from another skill as
`python3 ../prompt-map-shared/scripts/<script>.py ...` (all skills are installed
as siblings). From inside this shared skill, `scripts/<script>.py` is the same
file.

If a module conflicts with these rules, this shared Skill wins.
