# Discovery Protocol

This file is the **authority for the Discovery Stream**: how a discovery round
draws candidates, how novelty is judged, how the round ledger is split into two
stages, how the frontier metrics are computed, and in what order the round's
files must be produced.

`coverage-loop.md` owns the run-level picture (profiles, Gate A, Gate B,
calibration, circuit breaker). `value-rubric.md` owns the `V` computation.
This file owns the round mechanics and the frontier arithmetic.

The executable interface is owned by the script layer; the operations described
here are normative regardless of how they are invoked.

---

## Why the ledger is split into two stages

A discovery round evaluates `K` candidates. The full ledger has ~26 columns. An
agent asked to hand-write 26 columns × 100 rows will degrade, and — more
importantly — an agent that writes its own novelty and its own value score is
grading its own homework. So the round is split:

- **Stage 1** covers all `K` candidates and asks only for *surface description*.
- The script then computes **novelty** from a frozen baseline.
- **Stage 2** covers only the rows the script marked `new` and asks only for
  *evidence counts and closed-enum codes*.
- The script then computes **every** derived quantity: `E`, `D`, `P`, `T`,
  `value_score`, `materiality_pass`, `value_gate_pass`, `disposition`.

The agent never writes a float and never writes a novelty verdict.

---

## Stage 1 — all K candidates

The script pre-fills `round_id, candidate_id, probe_family, probe_slot` into
`01_discovery_candidates.csv` before the agent sees the file.

The agent fills ONLY these ten columns:

```
audience, body_part_or_object, attribute_or_condition, scenario,
decision_angle, decision_criterion, conditional_dimensions, evidence_refs,
derivation_rule_id, decision_distinction
```

The agent must NOT fill `canonical_surface_signature`, `is_new_surface`,
`identical_surface`, or `nearest_prompt_id`. Those are computed by the script
into `01_discovery_novelty.json`:

```python
for row in candidates:
    sig = canonical_signature(row)
    if not valid_surface(row):     status = "invalid_surface"
    elif sig in base_signatures:   status = "identical_existing"
    elif sig in seen_round:        status = "duplicate_within_round"
    else:                          status = "new"; seen_round.add(sig)
```

`base_signatures` are derived from `00_base_prompts.csv` **only** — the frozen
baseline snapshot for this round, never a live working file.

Every Stage 1 row must carry a non-empty `decision_distinction`, including rows
that turn out to be rejects. All `K` rows stay in the ledger with their reason;
a round that logs only its good candidates is an invalid round.

---

## Stage 2 — only rows with `novelty_status == new`

The agent fills exactly these twelve columns in `02_discovery_values.csv`:

```
support_mode (direct|derived|hypothesis),
reddit_cluster_count, semrush_keyword_count, semrush_monthly_volume,
geoly_public_prompt_count, geoly_topic_or_card_count, brand_customer_case_count,
product_card_eligible, product_impact_code,
track_natural_query, track_concrete_answer, track_reusable_surface
```

The script derives, and the agent never writes:

```
source_family_count, direct_evidence_unit_count,
E, D_reddit, D_semrush, D_geoly, D_brand, D, P, T,
value_score, materiality_pass, value_gate_pass, critical_value,
disposition, reason
```

See `value-rubric.md` for every bucket, weight, and the hard materiality gate.

---

## Anti-gaming rules (round level)

- The agent cannot self-report novelty, so the primary hole is closed by design.
- The gate requires
  `set(ids where novelty_status == new) == set(ids in 02_discovery_values.csv)`.
  Stage 2 may neither drop an inconvenient new row nor smuggle in a
  non-new one.
- Every Stage 1 row must carry a non-empty `decision_distinction`.
- If a row is `identical_existing` but its `decision_distinction` claims a new
  decision criterion, emit `REVIEW` — that is either a canonicalizer defect or
  a real missed surface.
- Each round, re-check `min(5, identical_existing_count)` rows chosen by
  deterministic hash. A full re-review of all rejects is NOT required. This
  re-check is **enforced**, not advisory — see `09_identical_recheck.csv` below.

### `09_identical_recheck.csv` — required every round

The deterministic re-check sample has to land as verdicts on disk. Columns:

```
candidate_id, reviewer_verdict, reason
```

`reviewer_verdict` is a closed enum: `confirmed_identical` | `actually_distinct`.

The round **fails** if the file is missing, if any sampled `candidate_id` has no
verdict, if a `reviewer_verdict` is outside the enum, or if any `reason` is
empty. A round whose re-check is not complete does not enter `frontier_streak`.

A single `actually_distinct` verdict fails the round outright: it means the
canonicalizer folded a genuinely new surface into the base, so the novelty
verdict is wrong. Fix the surface or the canonicalizer and **re-run Stage 2** for
that round. This is the check that stops a broken canonicalizer from
manufacturing a clean frontier pass by mislabelling everything as already-known.

Run-level anti-gaming rules (probe slot hashing, enum-only value components,
recomputation of cluster counts, `derived` rule validity, rubric freezing,
override handling, off-inventory acceptance) live in `coverage-loop.md` under
"Final convergence verification".

---

## Probe family portfolio

Slots are generated and hashed **before** the round, so the agent cannot spend
all `K` on the easiest dimension. Each family fixes its prompt template,
candidate count, allowed derivation rules, prohibitions, and evidence
requirements.

rich (`K = 100`):

| probe family | slots |
|---|---:|
| audience / body / condition deepening | 15 |
| constraint-bearing scenarios | 15 |
| decision-criterion and tradeoff deepening | 20 |
| high-value Topic intersections | 15 |
| compatibility / format / access | 15 |
| switching / comparison / replacement | 10 |
| reliability / maintenance / result horizon | 10 |

narrow (`K = 40`) uses the same proportions rounded:
`6 / 6 / 8 / 6 / 6 / 4 / 4`.

A round in which any family missed its fixed quota is an invalid round.

### `state/discovery_protocol.json` — the pinned probe templates

The family table above gives the quotas; the **actual template content** lives in
`state/discovery_protocol.json`, and `discovery_protocol_sha256` in the frozen
profile must equal that file's real sha256.

Both the hash and the **content** are enforced. Hashing alone was insufficient in
two stages: first any string could claim the protocol was frozen, then a hash
over an *empty* file counted as frozen — proving only that nobody edited the
emptiness. A frozen protocol must actually contain what the round is bound to.

```json
{
  "protocol_id": "",
  "canonicalizer_version": "",
  "approved_derivation_rule_ids": ["<rule-id>", "..."],
  "families": {
    "audience_body_condition": {
      "prompt_template": "<non-empty>",
      "allowed_derivation_rules": ["<subset of the global list>"],
      "prohibitions": ["<non-empty>"],
      "evidence_requirements": "<non-empty>"
    },
    "constraint_scenario":         { "...": "same four keys" },
    "criterion_tradeoff":          { "...": "same four keys" },
    "topic_intersection":          { "...": "same four keys" },
    "compatibility_format_access": { "...": "same four keys" },
    "switching_comparison":        { "...": "same four keys" },
    "reliability_maintenance":     { "...": "same four keys" }
  }
}
```

Enforced rules:

- `families` must be an object containing **exactly** the seven family keys —
  missing families and unknown families both fail.
- Each family must define all four of `prompt_template`,
  `allowed_derivation_rules`, `prohibitions`, `evidence_requirements`, and
  **none may be empty** (empty string, empty list, or absent all fail).
- `approved_derivation_rule_ids` at the top level is the **only** authoritative
  derivation rule table, and each family's `allowed_derivation_rules` must be a
  **subset** of it — a family cannot invent a rule the project never approved.
- **There is no mirror copy.** `convergence_profile.json` must **not** carry an
  `approved_derivation_rule_ids` field; doing so is an integrity failure, and the
  fix is to delete it. A second, editable home for the list is either a
  contradiction to police or an empty field that silently skips its own check.
  Likewise, a leftover `state/derivation_rules.json` is rejected — it is unhashed
  and must not sit there looking authoritative.
- A missing or empty table is an **integrity failure**, not a way to switch
  derivation off. A project that does not use derivation still declares the table
  normally and simply writes no `support_mode=derived` rows. (The scoring path
  additionally treats an unresolvable table as `E0_UNSUPPORTED`, but that is
  defense in depth for a misconfigured project, not a supported configuration.)

Per family: `prompt_template` is the exact probe text; `prohibitions` states what
the family must not propose; `evidence_requirements` states what it must cite.

Freeze this file before round 1. Any later edit changes its hash — and that does
**not** merely zero `frontier_streak`. `discovery_protocol_sha256` is re-checked
on every historical round manifest against the current value, so editing the
protocol turns every earlier round into an **integrity failure** until those
rounds are re-run under the new protocol. Plan a protocol edit as a restart, not
as a revision you can absorb. See "Protocol changes and the streak" in
`coverage-loop.md`.

---

## Frontier arithmetic (authoritative)

For a round `t` with exactly `K` candidates:

```
A_i = 1 if (is_new_surface AND materiality_pass AND V_i >= V_accept) else 0
C_t = sum(A_i)                              # accepted material count
H_t = sum(A_i == 1 and V_i >= V_critical)   # critical new count
M_t = sum(A_i * V_i)                        # value mass
D_t = M_t / K                               # value density
```

A **single-round frontier pass** requires ALL of:

```
candidate_count == K
H_t == 0
C_t <= N
D_t < delta            # strict; D_t == delta does NOT pass
not probe_degenerate   # the probe actually explored — see below
recheck_complete       # 09_identical_recheck.csv is complete and clean
```

**Frontier exhaustion** requires `streak` consecutive passing rounds under an
identical **streak-comparable protocol fingerprint** — the full fingerprint minus
its trailing `slot_hash`, which is a per-round field with no cross-round meaning.
A protocol change zeroes the streak at best, and for most fingerprint members
costs more than that: see "Protocol changes and the streak" in
`coverage-loop.md` for the three-way split.

Numeric handling: each `V_i` is rounded to 3 decimals by the rubric, then
`M_t = sum(V_i)` over accepted rows. `D_t` is compared to `delta` at full
precision — do NOT re-round `D_t` to 2 or 3 decimals before the comparison, or
the rich `0.0395` case is decided wrongly.

### The anti-degenerate probe floor

The three frontier conditions above judge whether the new surfaces a round found
were **valuable enough**. They say nothing about whether the round looked at all
— and that gap was exploitable.

**The hole.** `identical_existing` rows are structurally valid. A round that
transcribes `K` surfaces already present in the map produces zero new surfaces,
hence `C = 0`, `H = 0`, `D = 0.000` — a perfect frontier pass. Two such rounds in
a row "converged" the run without discovering a single thing. Perfunctory
answering and a broken canonicalizer both look exactly like this.

**The second hole.** Counting *signature novelty* alone was still gameable: 90
`identical_existing` rows plus 10 structurally complete but fabricated surfaces
marked `support_mode=hypothesis` gave `probe_degenerate = false` with
`C = H = D = 0`. Two such rounds "converged" a 200-Prompt map to a normal `PASS`.
Inventing unevidenced surfaces is not exploring either.

**The floor.** Each profile carries

```
min_new_surface_count = max(5, ceil(0.10 * K))     # rich 10, narrow 5
```

which is part of the protocol fingerprint. The counter measured against it is
**`exploratory_new_count`** — candidates satisfying all three of:

1. `novelty_status == new`;
2. `support_mode ∈ {direct, derived}`;
3. at least one `evidence_refs` entry that **resolves** in the frozen evidence
   index.

`new_surface_count` is still reported, but it is **diagnostic only** and is no
longer the criterion.

Read the distinction carefully, because it inverts easily:

- **Counted:** a new surface that *brought evidence* but may fail the value gate
  (`direct`/`derived`, refs resolve, `V < V_accept`). This is exactly the shape
  of genuine saturation, so it **must** count — otherwise a truly saturated
  category could never stop.
- **Not counted:** only a surface that *did not even try* to cite evidence —
  `hypothesis` rows, and rows whose refs resolve to nothing.

Still orthogonal to `C`/`H`/`D`: those three ask whether the new surfaces were
valuable enough; this one asks whether the probe explored **with real
sourcing** at all.

If a round's `exploratory_new_count < min_new_surface_count`, then
`probe_degenerate = true`, and that round:

- cannot count as a frontier pass;
- does not enter `frontier_streak`;
- is a **hard blocker** routed to human review — either the probe was answered
  perfunctorily, or the probe protocol / canonicalizer is broken, and both need a
  person.

**A degenerate round is a standing obligation, not an expiring alert.** Earlier
it was only examined inside the streak window, so running a few more rounds
pushed it out of view and the blocker silently disappeared — a blocker with an
expiry date is not a blocker. Every round is now scanned, for the whole run, and
each degenerate round needs an explicitly landed disposition before delivery.

`work/coverage_rounds/rNN/10_probe_degenerate_disposition.json`:

```json
{
  "disposition": "probe_protocol_fixed | round_rerun | accepted_by_human",
  "reason": "<non-empty>",
  "approval_ref": "<non-empty>"
}
```

The file must exist and be a JSON object; `disposition` must be in the enum; and
`reason` and `approval_ref` must both be non-empty. Anything else leaves the
round undisposed and blocks delivery.

Run state mirrors this in `unresolved_degenerate_rounds`, which is cross-checked
against what is actually on disk — a disagreement is an integrity failure, so the
list cannot be quietly emptied.

**Why this is the right discriminator.** Genuine saturation looks like *"we can
still propose new surfaces, but none of them clear the value bar"* — plenty of
`new` rows, all with `V < V_accept`. Not proposing new surfaces at all is the
signature of a probe that stopped exploring, not of an exhausted category.
Measured free-probe novelty on a rich category was still 52.5%–65% at 512 / 578 /
687 Prompts, so a 10% floor is far below any honest saturation point.

**This is not a "more new surfaces is better" reward.** Clearing the floor earns
nothing; the round still has to pass `C`, `H`, and `D` on the merits.

**Enforcement scope, stated plainly.** The gate checks the three mechanical
conditions above and nothing more. A family's `evidence_requirements` is free
text and cannot be adjudicated mechanically, so the script does **not** verify
that a candidate satisfies its own family's evidence requirement — only that the
support mode is real and at least one ref resolves. `verify` declares this
limitation in `evidence.probe_floor_enforcement`. Do not read the floor as
"every candidate met its family's evidence requirements"; that would be a promise
the code does not keep.

### The three conditions are non-redundant

| profile | round contents | `C_t` | `H_t` | `M_t` | `D_t` | verdict |
|---|---|---:|---:|---:|---:|---|
| rich | 6 surfaces all at `V=0.60` | 6 | 0 | 3.600 | 0.036 | density passes (`0.036 < 0.039`), **`C=6 > 5` blocks** |
| rich | 5 surfaces averaging `V=0.79` | 5 | 0 | 3.950 | 0.0395 | count passes (`5 <= 5`), **`0.0395 >= 0.039` blocks** |
| rich | 1 surface at `V=0.90` | 1 | 1 | 0.900 | 0.009 | count and density both pass, **`H=1` blocks** |
| narrow | 4 surfaces at `V=0.60` | 4 | 0 | 2.400 | 0.060 | density passes (`0.060 < 0.062`), **`C=4 > 3` blocks** |
| narrow | 3 surfaces averaging `V=0.84` | 3 | 0 | 2.520 | 0.063 | count passes (`3 <= 3`), **`0.063 >= 0.062` blocks** |

Read as: **count** catches "many barely-qualifying surfaces"; **density**
catches "few but collectively strong"; **critical** catches "only one, but it
really matters".

`delta = 0.03` is REJECTED for the rich profile: `5 * 0.60 / 100 = 0.030` would
make the count condition inert, because any round that satisfied `C <= 5` at the
accept floor would also satisfy density. `0.039` keeps both live.

---

## Round directory and ordering

Each round writes to `work/coverage_rounds/rNN/`:

```
work/coverage_rounds/rNN/
├── 00_base_prompts.csv        # frozen snapshot; base_map_sha256 anchors HERE
├── 00_base_registry.csv       # base_registry_sha256
├── 00_round_manifest.json     # profile, protocol hashes, K, family slots
├── 01_discovery_candidates.csv
├── 01_discovery_novelty.json
├── 02_discovery_values.csv
├── 03_discovery_ledger.csv
├── 04_accepted_surfaces.csv
├── 05_round_prompts.csv
├── 06_round_registry.csv
├── 06_closure_additions.csv   # optional; the ONLY legal channel for Closure-approved surfaces
├── 06_waivers.csv             # optional; required to move any cell open -> waived
├── 07_round_coverage_audit.csv
├── 08_round_summary.json
├── 09_identical_recheck.csv   # REQUIRED; verdicts for the 5-row deterministic sample
└── 10_probe_degenerate_disposition.json   # REQUIRED iff this round is probe_degenerate
```

### `round_kind` — calibration and active rounds are counted separately

`00_round_manifest.json` carries `round_kind: "calibration" | "active"`.

- `coverage_round` counts **active** rounds only.
- `calibration_round` counts **calibration** rounds only.
- **Never infer a round's kind or index from its directory number.** `rNN` is a
  storage name, not a counter. Read `round_kind` from the manifest.
- Calibration rounds must be the **leading contiguous block starting at `r01`**,
  and there must be **exactly 3** of them before the first active round — for
  both profiles. A calibration round after an active round is invalid.
- `frontier_streak` accumulates across **active rounds only**. A calibration
  round neither contributes to nor resets the streak, and does not consume the
  `max_round` budget.

### `06_closure_additions.csv` — the only legal Closure channel

The Discovery Stream is not the only thing that may extend the registry: the
Closure Stream can approve a new surface too (a gap resolution that turns out to
open a genuinely new surface). That addition must be written to
`06_closure_additions.csv`, using the same surface columns.

Every row needs a full approval envelope:

```
closure_addition_id, source_gap_id, evidence_refs, approval_ref, closure_reason
```

**Anti-laundering.** If a closure addition's surface signature is one that *this
round's Discovery Stream rejected*, the row must additionally carry a
`human_override_ref`, or the round FAILs. Without it, the Closure Stream would be
a side door: reject a surface on the merits at the value gate, then re-admit the
identical surface as a "gap resolution". Re-admission is allowed, but only as an
explicit, attributable human override.

Writing rows straight into the registry without recording them here is
**registry stuffing** and is rejected. Containment is checked in **two layers**.

**Layer (a) — same-round, every round.** Within one round,
`00_base_registry.csv → 06_round_registry.csv`:

```
06_round_registry ⊆ base(N) ∪ accepted(N) ∪ 06_closure_additions.csv
base(N) ⊆ 06_round_registry        # append-only within the round
```

plus the row-level invariants below. This layer depends on **no successor
round**, which matters twice: tampering performed inside `06` becomes invisible
to a cross-round check as soon as it is faithfully carried into the next round's
base, and the **final round has no successor at all** — precisely the round with
the most incentive to launder something in.

**Layer (b) — cross-round.** Between consecutive rounds, the living registry may
grow only by the previous round's accepted discovery surfaces plus approved
closure additions:

```
base(N) − allowed ⊆ accepted(N−1) ∪ 06_closure_additions.csv
```

where `allowed` is the previous round's registry, bound by
`previous_registry_sha256` in the round manifest. In words: every row that
appeared in this round's baseline registry but was not in the previous one must
be traceable either to the previous round's accepted discovery surfaces or to an
explicit Closure addition. Anything else is an untraceable insertion.

The file is optional — omit it when the round approved no Closure additions.

### `06_waivers.csv` — the only way to waive an obligation

Optional per-round file:

```
demand_cell_id, waiver_approval_ref, waiver_reason
```

A row counts only when all three are non-empty.

`cell_status` transitions are constrained: `open → covered` is the only free
move. `open → waived` requires a matching row in this file. Every other
transition is illegal — including anything that walks a `covered` cell backwards.

### Registry row-level invariants

Signature-set containment is not sufficient. Keeping every signature while
editing metadata shrinks the real obligation set and passes a set check, so the
registry is also compared row by row — at **both** layers above (same-round
base→round, and cross-round):

- `demand_cell_id` is **unique** within a registry, and non-empty.
- Every `demand_cell_id` present in the previous round must still be present.
  Obligations are never deleted.
- These fields are **immutable** once a row exists: the six canonical surface
  fields, `product_card_eligible`, `surface_origin`, and `introduced_round`.
- `cell_status` moves only along the transitions above.

Concretely, this blocks: flipping `product_card_eligible` to `No` to make a cell
disappear from the eligible denominator; quietly re-pointing a `demand_cell_id`;
relabelling a discovery row as baseline; and dropping one of two rows that happen
to share a signature.

The ordering below is what makes the round **not self-certifying**:

A round is set up by `prepare-round`, which **refuses to run** unless the profile
is frozen (`profile_frozen == true`), `discovery_protocol_sha256` is non-empty,
`state/discovery_protocol.json` exists, and that declared hash equals the file's
**actual** sha256. A round drawn against an unfrozen profile could have its
thresholds retrofitted to its own results, so the protocol must be pinned before
candidates exist — not after. `verify` enforces the same four conditions, so
editing or deleting the protocol file after freezing is caught.

0. **Freeze the baseline before any candidate exists.**
   `base_map_sha256 = sha256(00_base_prompts.csv)` — never
   `03_prompt_draft.csv` or `05_prompt_final.csv`, which get overwritten during
   the round and would let the baseline drift under the novelty test.
1. Discovery judges novelty only against the frozen base plus this round's
   `seen_round` set.
2. Surfaces passing materiality and the value gate go to
   `04_accepted_surfaces.csv`. **They are not yet covered.**
3. Append them to `06_round_registry.csv` with `surface_origin=discovery`,
   `introduced_round=rNN`, `cell_status=open`, empty `covered_prompt_ids`, and
   `frontier_value_score=<computed>`. This creates an **obligation**, not a
   completion.
4. Author natural Prompts only for accepted rows → `05_round_prompts.csv`.
5. If the Closure Stream approved any additional new surface this round, record
   it in `06_closure_additions.csv` **before** it enters the registry. This is
   the only legal channel; a direct registry insertion is stuffing.
6. Audit runs against `05_round_prompts.csv` + `06_round_registry.csv`. No valid
   Prompt → `cell_status=open` and `gap=SUPPLEMENT`. Only a linked, valid Prompt
   flips a row to `cell_status=covered` with `covered_prompt_ids=<id>`.
7. Only after validators and the audit pass are the round files promoted to
   current state for the next round. The promoted registry hash becomes the next
   round's `previous_registry_sha256`.

### Invariant: `discovered != covered`

Appending a registry row never advances coverage by itself. Gate A (the
Coverage Floor) is computed against an **independent evidence sample** and never
uses registry row counts as a denominator, so inflating the registry cannot
inflate the floor. See `coverage-floor-sampling.md`.

---

## Validator phases inside a round

Discovery surfaces are structured rows, not prompt text. Running the template
validator against them produces noise. See `generation-integrity.md` for the
three-phase guard order; in summary:

- **Discovery surface phase** — exact canonical duplicate, identical canonical
  signature, invalid/null surface only. Do NOT run the template validator here.
- **Prompt authoring phase** (accepted discovery surfaces only) — shortlist
  difference, generation integrity, prompt surface quality.
- **Final phase** — the whole map with `--strict`.

---

## Discovery-only reruns

A run may re-enter the Discovery Stream without re-running the full pipeline:
supply the frozen profile and protocol hashes, take the next `rNN`, and produce
the full round directory. A discovery-only rerun still obeys ordering step 0
(freeze the baseline first) and still appends obligations that must later be
closed by the Closure Stream. See `routing.md`.
