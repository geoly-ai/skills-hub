# Coverage Loop

In `geo_full_coverage`, Prompt generation is NOT complete after the initial
draft. The orchestrator runs explicit coverage rounds until convergence.
`minimal_dedup` runs do not enter this loop.

`convergence_method = "coverage_floor_plus_value_frontier_v1"`.

---

## 0. The problem this design fixes

- **v0.6.0** defined convergence as a free-brainstorm `acceptance_rate < 10%`
  for two rounds. That is unreachable on a rich category — measured 63% at 512
  Prompts, 52.5% at 578, 65% at 687. But the unreachable gate accidentally
  forced repeated open exploration, and that is what produced a broad,
  high-quality 600+ Prompt map.
- **v0.6.1** replaced it with a frozen evidence manifest plus the schema-`1.2`
  `evidence_coverage` threshold and `blind_reaudit_clean` — both removed in
  `1.3`, and no longer part of any gate. Runs became
  terminable, but output collapsed to roughly 200 Prompts: generation is bounded
  by a pre-enumerated inventory, and once the inventory was exhausted nothing
  forced open discovery any more. Worse, the gate never recomputed anything — it
  read floats the agent had written.
- **v0.7.0** uses **two independent streams, two opposing gates, and an escape
  hatch**. A recall floor prevents under-production; a marginal-value stopping
  rule guarantees termination; a budget-exhaustion status prevents deadlock.

**Delivery claim wording.** Never say "exhaustive category complete". Say
"evidence coverage floor passed; discovery frontier exhausted", or
"...frontier not fully exhausted within the approved budget, backlog attached".

---

## 1. Two streams

| | Closure Stream | Discovery Stream |
|---|---|---|
| Purpose | close known coverage obligations | open exploration that can extend the registry |
| Input | the living registry's `cell_status=open` rows, gap queue | probe family portfolio at budget `K` |
| Output | authored Prompts, `cell_status=covered` transitions | accepted new surfaces appended as new obligations |
| Gated by | Gate A — Coverage Floor | Gate B — Value Frontier Exhaustion |
| Failure mode it prevents | under-production / low recall | non-termination / infinite brainstorm |

The streams run in the same round but are scored separately. Discovery output
becomes Closure input: an accepted discovery surface is an **obligation**, not a
completion. See `discovery-protocol.md` for the ordering that enforces this.

---

## 2. Convergence profiles

`state/convergence_profile.json` is frozen **before the first discovery round**
and carries the profile plus all protocol hashes.

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

narrow:  # ALL of: approved_topics < 10 AND eligible_demand_themes < 80 AND initial_surface_inventory < 180
  K: 40
  V_accept: 0.60
  V_critical: 0.85
  N: 3
  delta: 0.062
  streak: 2
  max_round: 4
  coverage_floor_n: 50      # 50, not 40 — at n=40 the Wilson bound tolerates zero misses
  coverage_floor_threshold: 0.10
```

If the two classifications conflict, **`rich` wins**. Under-budgeting a rich
category is the more expensive error.

---

## 3. Round lifecycle

Each active round runs in this order:

1. **Freeze the round baseline** — snapshot `00_base_prompts.csv` and
   `00_base_registry.csv` and record their hashes before any candidate exists.
2. **Discovery Stream** — Stage 1 (all `K` candidates), script novelty pass,
   Stage 2 (new rows only), script value pass. See `discovery-protocol.md`.
3. **Append accepted surfaces to the living registry** with `cell_status=open`.
   This creates obligations; it does not advance coverage.
4. **Closure Stream** — hand-author natural Prompts for accepted discovery
   surfaces and for approved open registry rows. No template batches, and never
   a copy of the previous round's batch.
5. **Guardrail validation** — see the three-phase order in
   `generation-integrity.md`.
6. **Coverage audit** — audit canonical-surface, Topic, audience/persona,
   body/object, attribute/condition, scenario, decision-angle + criterion,
   conditional-dimension, and high-value Topic-intersection coverage, plus
   product-card eligibility and evidence-tier/hypothesis status. Only a linked
   valid Prompt flips a registry row to `covered`.
7. **Gap classification** — every uncovered item becomes `SUPPLEMENT`,
   `REWRITE`, `REVIEW`, `WAIVE`, or `NOT_ELIGIBLE`, with `evidence_refs`,
   priority, nearest Prompt, and proposed resolution.
8. **Human approval** — do not generate supplements for unapproved hypotheses or
   ambiguous intersections.
9. **Gate A and Gate B evaluation** — recomputed, never read from run state.
10. **Convergence decision** — see the decision table in §6.

---

## 4. Gate A — Coverage Floor

A statistical recall floor drawn from an independent sample of
`work/02_evidence_index.csv`, scored against the final map's canonical
signatures, and gated on the one-sided Wilson upper bound (`z = 1.645`) being
`< 0.10`.

`coverage-floor-sampling.md` is authoritative for quotas, hash ordering, the
closed `exclusion_reason` enum, the two-batch miss procedure, the verified
tolerance table, and the `registry_proxy` degraded mode.

Two properties matter here:

- The denominator is **eligible sampled evidence**, not registry rows. Appending
  registry rows therefore cannot inflate the floor — `discovered != covered`.
- A floor miss is never repaired inside the same batch. Batch 2 is drawn from
  still-unsampled evidence and judged independently. Maximum two batches.

If the floor fails, neither `PASS` nor `PASS_WITH_BACKLOG` is available.

---

## 5. Gate B — Value Frontier Exhaustion

A round passes the frontier when, over exactly `K` candidates, **all** of
`H_t == 0`, `C_t <= N`, `D_t < delta`, `not probe_degenerate`, and
`recheck_complete` hold. Frontier exhaustion requires `streak` consecutive
passing rounds under an **identical protocol hash**.

The last two conditions close a hole in the first three: a round that transcribes
`K` already-known surfaces — or pads them with unevidenced inventions — scores
`C=0, H=0, D=0` and would otherwise look like a perfect pass while discovering
nothing.

`probe_degenerate` fires when `exploratory_new_count < min_new_surface_count`
(rich 10, narrow 5) and is a hard blocker. `exploratory_new_count` counts
candidates that are signature-new **and** carry a real `support_mode`
(`direct`/`derived`) **and** cite at least one evidence ref that resolves in the
frozen index — so a new surface that brought evidence but failed the value gate
still counts (that is what real saturation looks like), while a `hypothesis` row
does not. `new_surface_count` remains diagnostic only.

`recheck_complete` requires clean verdicts in `09_identical_recheck.csv`. Both
are detailed in `discovery-protocol.md`.

**A degenerate round blocks delivery until it is explicitly disposed of.** It is
a standing obligation for the whole run, not a condition that lapses once later
rounds push it out of the streak window — a blocker that expires on its own is
not a blocker. Every round is scanned, and each degenerate one needs
`10_probe_degenerate_disposition.json` with a `disposition` of
`probe_protocol_fixed` / `round_rerun` / `accepted_by_human`, a non-empty
`reason`, and an `approval_ref`. Outstanding rounds are mirrored in
`unresolved_degenerate_rounds`, which the gate cross-checks against disk.

Only **active** rounds (`round_kind: "active"` in the round manifest) count.
Calibration rounds never enter `frontier_streak` and never consume the
`max_round` budget; `coverage_round` counts active rounds and
`calibration_round` counts calibration rounds, and the two are never summed.
Never infer a round's kind from its directory number.

`discovery-protocol.md` is authoritative for the definitions of `A_i`, `C_t`,
`H_t`, `M_t`, `D_t`, the strict `<` on density, the numeric-rounding rule, and
the five worked examples showing the three conditions are non-redundant.
`value-rubric.md` is authoritative for `V_i`.

The gate is a **marginal-value** rule, not an exhaustion proof. It says the
probe has stopped finding material new surfaces at this budget and protocol — a
different protocol might find more, which is exactly why a protocol change zeroes
the streak.

---

## 6. Convergence decision table

| Gate A (floor) | Gate B (frontier) | hard blockers | outcome |
|---|---|---|---|
| passed | exhausted | zero, and the run is **not** capped at backlog | **`PASS`** |
| passed | exhausted | zero, but capped at backlog (reduced evidence / pool short of `n` / registry proxy) | **`CONTINUE`** until the budget is spent, then **`PASS_WITH_BACKLOG`** — never `PASS` |
| passed | open | zero, and `coverage_round >= max_round` **or** `approved_discovery_budget_rounds` reached, with human approval and a valid backlog artifact | **`PASS_WITH_BACKLOG`** |
| passed | open | zero, budget remaining | **`CONTINUE`** — run another round |
| failed | any | zero | **`CONTINUE`** if a second floor batch remains, else **`FAIL`** |
| any | any | any non-zero hard blocker, or an incomplete ledger/protocol | **`FAIL`** |

Hard blockers are all of:

```
high_priority_uncovered_count == 0
unresolved_query_surface_gap_count == 0
unresolved_intersection_gap_count == 0
template_review_count == 0
hard_validator_failure_count == 0
unresolved_degenerate_rounds == []      # every degenerate round explicitly disposed
```

`template_review_count == 0` means every detected REVIEW was rewritten, merged,
or human-resolved — **not** that the detector never fired. Track
`template_detected_count` and `template_resolved_count` separately; only the
unresolved difference must be zero. The gate reads resolved REVIEW keys from
`state/template_resolutions.json`, so a REVIEW counts as resolved only when its
key is recorded there. See `generation-integrity.md` and `context-contract.md`.

Attempting to converge by shrinking a denominator or editing the rubric mid-run
is a `FAIL`, not a pass. See `status-vocabulary.md` for the full status
definitions and the required verbatim `PASS_WITH_BACKLOG` delivery sentence.

---

## 7. Calibration (first real run)

Before the frontier gate is armed, run **exactly 3 calibration rounds** at the
profile's `K` with the frontier gate **disabled**. This is enforced, not
aspirational: the verifier requires exactly 3 calibration rounds — as a
contiguous prefix starting at `r01` — before the first active round, for **both**
profiles. `calibration_complete` must be `true` at that point. A `false` flag
with active rounds already on disk, or a `true` flag with fewer than 3
calibration rounds, is an integrity failure. ("At most 3" would let a run open at
`r01` as active and silently skip `3 * K` candidates.)

Calibration rounds do not increment `coverage_round` and do not consume the
`max_round` budget; active rounds do both. `max_round` itself is a fixed profile
threshold and never changes during a run.

All three must share one probe family profile, prompt-template hashes, model ID,
temperature, canonicalizer, E/D/P/T rubric, and hard materiality gate. This is
observation only — **do not edit the probe because a round yielded little.**

Calibration rounds are not throwaway: they run the real probe and produce real
Prompts. What they do **not** do is change any threshold.

Per-round record:

```
candidate_count, new_surface_count, identical_existing_count,
duplicate_within_round_count, invalid_surface_count, hard_material_count,
min_new_surface_count, exploratory_new_count, probe_degenerate,
identical_recheck_complete,
C, H, M, D,
score_060_069_count, score_070_079_count, score_080_084_count, score_085_plus_count,
accepted_by_probe_family, rejected_by_reason,
template_detected_count, template_resolved_count,
human_reject_after_value_gate_count
```

### Profile constants are immutable — no in-project threshold tuning

`N`, `delta`, `K`, `V_accept`, `V_critical`, `streak`, `max_round`,
`coverage_floor_n`, and `min_new_surface_count` are **profile constants**.
Calibration does not compute them, propose them, or adjust them. Any attempt to
recompute a threshold from a run's own rounds is an integrity failure at the
gate.

The reason is simple: a project that retunes its stopping rule from its own
results can always stop. Threshold changes belong to a **later package version**,
derived from a complete ledger across projects — never to the run being judged.

Human review during calibration remains, as **quality observation only** and with
no threshold consequences. It covers every `value_gate_pass=Yes` row, every
near-threshold row with `0.55 <= V < 0.60`, and the 5-row deterministic
`identical_existing` sample. The identical-sample portion is no longer an
informal read: it is enforced through `09_identical_recheck.csv` (see
`discovery-protocol.md`), and an `actually_distinct` verdict fails the round.

### Protocol changes and the streak

The full **protocol fingerprint** is `discovery_protocol_sha256`,
`canonicalizer_sha256`, model ID, temperature, `value_rubric_version`,
`materiality_rule_version`, `K`, `family_quotas`,
`{V_accept, V_critical, N, delta}`, `approved_discovery_budget_rounds`,
`min_new_surface_count`, and `slot_hash`.

The **streak-comparable fingerprint** is that tuple **minus its last element**.
`slot_hash` is excluded because it binds this round's own candidate-slot
integrity: the slots are generated deterministically and their hash includes the
`rNN`-scoped `candidate_id`s, so it is a per-round integrity field, checked
against that round's own Stage 1 rows and never compared across rounds. It
carries no cross-round protocol meaning — it is not missing from the roster
below, it is deliberately not a member of it.

Three distinct behaviours hide inside the streak-comparable list, and treating
them alike will mis-plan a run:

- **Freely changeable, reset the streak.** Model ID and temperature are recorded
  per round and only ever compared **across the streak**. Changing one sets
  `frontier_streak = 0` and `protocol_revision_count += 1`; earlier rounds stay
  valid.
- **Changeable only by re-running history.** `discovery_protocol_sha256`, the
  canonicalizer, `approved_discovery_budget_rounds`, `value_rubric_version`, and
  `materiality_rule_version` are re-checked on **every historical round manifest
  against the current value** (the last two against the code's own constants).
  Changing one does not merely zero the streak — it turns every earlier round
  into an **integrity failure** until those rounds are re-run under the new
  protocol. Plan such a change as a **restart**, not as a revision you can
  absorb.
- **Not changeable at all.** `K`, `family_quotas`, `V_accept`, `V_critical`,
  `N`, `delta`, and `min_new_surface_count` are profile constants a round
  manifest may not redefine; `streak`, `max_round`, `coverage_floor_n`,
  `coverage_floor_threshold`, and `floor_quotas` are profile constants guarded by
  profile equality rather than by the fingerprint (they are **not** fingerprint
  members). Editing or deleting any of them is an **integrity failure at the
  gate — neither a streak reset nor a protocol revision.**

Keep this roster identical to the fingerprint the verifier computes, and keep the
three categories accurate. A roster that drifts from the code leads a later
reader to conclude a field is unprotected and relax it elsewhere; a roster that
lists the right fields under the wrong category is worse, because it makes a
restart-grade change look like a routine one.

Do **not** reset for: adding accepted Prompts, rewording without changing a
surface, adding evidence URLs, resolving template REVIEWs, CSV column order, or
summary edits.

### Anti-perpetual-calibration

- Calibration is **exactly** 3 rounds — not a cap to approach, a count to hit.
- After the protocol is frozen, at most **one** protocol revision is allowed.
  That budget covers the changeable fingerprint members above: model ID and
  temperature freely; `discovery_protocol_sha256`, the canonicalizer,
  `approved_discovery_budget_rounds`, `value_rubric_version`, and
  `materiality_rule_version` only alongside re-running the affected rounds. The
  immutable profile constants are not revisable at all.
- A second proposed revision does **not** restart calibration. Escalate to a
  human decision: continue on the current protocol, or take
  `PASS_WITH_BACKLOG`.
- Calibration rounds never count toward `max_round`; active rounds do.

---

## 8. Circuit breaker and the three endings

`max_round` is 6 for rich, 4 for narrow. On reaching it, stop automatic
generation. There are exactly three endings:

1. **`PASS`** — floor passed, frontier exhausted over the required streak, hard
   blockers zero, and the run is **not** capped at backlog. Deliver as "evidence
   coverage floor passed; discovery frontier exhausted".
2. **`PASS_WITH_BACKLOG`** — floor passed, hard blockers zero, budget spent,
   frontier still open. The budget condition is satisfied by **either** path,
   equivalently:
   - `coverage_round >= max_round`, or
   - `approved_discovery_budget_rounds` is non-null and the active round count
     has reached it.

   Requires: this round's high-value surfaces
   already merged into the map; remaining frontier candidates, mid/low-value
   derived surfaces, and exploration directions attached as
   `outputs/discovery_backlog.csv`; and explicit human approval of delivery.
3. **`FAIL`** — floor failed, high-priority gaps remain, validator blockers
   remain, the ledger/protocol is incomplete, or someone tried to converge by
   shrinking the denominator or editing the rubric.

### The permanent backlog cap

Three conditions cap a run at `PASS_WITH_BACKLOG` **permanently**, with no human
upgrade path to a normal `PASS`:

- a non-empty `reduced_evidence_sources`;
- `evidence_pool_short_of_n` — the whole eligible pool could not reach
  `coverage_floor_n`;
- `coverage_floor_mode = registry_proxy`.

Missing evidence is missing evidence: no approval turns it into complete
coverage. A capped run that satisfies floor, hard blockers, *and* frontier
exhaustion still does not emit `PASS` — it reads `CONTINUE` until the budget is
spent, then delivers as `PASS_WITH_BACKLOG`.

**The budget condition is never waived.** Backlog delivery requires
`budget_spent AND (frontier_open OR capped_at_backlog)`. The cap limits the best
achievable outcome; it does not license delivering early. A capped run whose
budget is not yet spent keeps running rounds.

Never continue indefinitely, never chase a count target unsupported by evidence,
and never silently declare completion.

---

## 9. Final convergence verification

`verify_coverage_convergence.py` is the **sole owner** of convergence logic and
**recomputes everything from ledgers**. `verify_decision_angle_gate.py` must
call it rather than reimplement it, then continue with its existing freshness,
prompt-ID, and delivery-reconciliation checks. The gate must not trust any
pre-filled rate, score, or boolean in `run_state.json`.

Recomputation checklist:

1. exactly `K` rows in Stage 1 — so "only the good candidates were logged" fails
2. every probe family met its fixed quota
3. candidate and slot IDs are unique and complete
4. protocol / model / prompt hashes / canonicalizer / rubric versions unchanged
   across the streak, and `state/discovery_protocol.json` valid by **content**
   (seven families, four non-empty fields each, derivation rules a subset of the
   frozen table) — not merely hash-matched
5. novelty recomputed against that round's `base_map_sha256`
6. canonicalizer re-run over every signature
7. hard materiality recomputed from evidence refs, cluster counts, and enums
8. `V_i` recomputed from the four component enums
9. `C_t`, `H_t`, `M_t`, `D_t` recomputed
10. accepted discovery surfaces present in the living registry, with registry
    containment checked at **both** layers — same-round
    (`00_base_registry → 06_round_registry`, run for every round including the
    last) and cross-round
11. accepted discovery surfaces present in the after-round / final Prompt Map
12. the final map is an **additive superset** of accepted discovery coverage
13. the Coverage Floor Wilson bound recomputed from the floor ledger
14. all `exclusion_reason` values are in the closed enum

Delivery stage: if the recomputed status is not `PASS` or `PASS_WITH_BACKLOG`,
delivery is blocked.

### Anti-gaming rules (run level)

- The ledger keeps **all** `K` candidates, including rejects with reasons.
- Probe slots are hashed before the round.
- Value components are closed enums, never free-floating floats.
- Evidence cluster counts are recomputed from the evidence index.
- `derived` requires a pre-approved `derivation_rule_id`; a plain concatenation
  of two evidenced dimensions is not derivation.
- The hard gate and the rubric freeze before round 1. Changing a threshold
  mid-run is a new protocol and zeroes the streak.
- Agent overrides go to the human backlog and never into convergence statistics.
- Relative percentiles may be reported, never gated on.
- Accepted surfaces must land in the map, so a probe cannot "discover" without
  producing.
- A high-value discovery **outside** the original registry must be appendable —
  it can never be rejected merely for being off-inventory.

---

## 10. Run-state fields

`state/run_state.json` carries **summaries and ledger hashes only** — never
per-round arrays. The full schema `1.3` is in `context-contract.md`. The fields
this loop reads and writes:

- profile / protocol: `convergence_method`, `convergence_profile`,
  `profile_frozen`, `discovery_protocol_id`, `discovery_protocol_sha256`,
  `canonicalizer_version`, `value_rubric_version`, `materiality_rule_version`,
  `protocol_revision_count`
- rounds: `coverage_round` (active only), `calibration_round`,
  `calibration_complete`, `max_round`, `approved_discovery_budget_rounds`
- frontier: `probe_budget_k`, `value_accept_threshold`,
  `value_critical_threshold`, `frontier_count_threshold`,
  `frontier_density_threshold`, `frontier_required_streak`, `frontier_streak`,
  `frontier_exhausted`, and the `last_round_*` block
- floor: the `coverage_floor_*` block
- blockers: `high_priority_uncovered_count`,
  `unresolved_query_surface_gap_count`, `unresolved_intersection_gap_count`,
  `template_detected_count`, `template_resolved_count`, `template_review_count`,
  `hard_validator_failure_count`
- outcome: `convergence_status`, `delivery_status`, `backlog_count`,
  `backlog_sha256`, `human_backlog_delivery_approved`,
  `reduced_evidence_sources`, `hypothesis_quarantined`

Removed in `1.3` (present in schema `1.2`): `evidence_manifest_id`,
`evidence_coverage` — removed; `blind_reaudit_clean` and
`blind_reaudit_manifest_id` — removed; `last_round_acceptance_rate` — removed.
A free-brainstorm acceptance rate is **not** a stopping condition and is no
longer recorded as one.
