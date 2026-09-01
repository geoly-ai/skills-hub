---
name: prompt-map-generator
description: Generate a first-version-compatible natural Prompt Map through two independent streams — a Closure Stream that closes known coverage obligations from the living registry, and an open Discovery Stream that probes K fixed candidates per round for new canonical query surfaces, appends qualifying off-inventory surfaces to the living registry, and authors natural Prompts for them. Use for initial generation, per-round discovery probes, revision, and gap/obligation supplements.
---

# Prompt Map Generator

The reusable first-version design is the structure baseline. Existing Prompt text is a content baseline only in `revision` mode.

Read `../prompt-map-shared/references/geo-coverage-mode.md`,
`../prompt-map-shared/references/discovery-protocol.md`, and
`../prompt-map-shared/references/v1-expansion-rules.md` before generating.
Read `../prompt-map-shared/references/value-rubric.md` before filling any
Stage 2 evidence column.

## Coverage mode

In `geo_full_coverage` (default), author **enough natural Prompts to close every
open coverage obligation** — iterate Category + every Topic × the
evidence-supported decision-angle grid × approved Topic intersections, plus every
surface accepted by the Discovery Stream. One well-written Prompt may close
several closely related registry cells; what is mandatory is that no obligation
is left open, and that **every accepted discovery surface has a linked valid
Prompt covering its canonical signature**. This is a coverage duty, not a
one-row-per-cell quota. Each row records the six surface fields (`audience, body_part_or_object,
attribute_or_condition, scenario, decision_angle, decision_criterion`),
`selection_change_test=surface_distinct`, a concrete `shortlist_delta`, and an
evidence tier. Keep a candidate whenever it opens a NEW canonical surface even if
the product shortlist overlaps; drop only exact-text and identical-surface
duplicates. Expected output for a data-rich category is in the many hundreds. In
`minimal_dedup`, follow the legacy shortlist-only rules below.

## Two independent streams

Generation in `geo_full_coverage` runs **two streams that are never substitutes
for one another**. Both run in every active round.

- **Closure Stream** — closes obligations that already exist: uncovered rows in
  the living registry (`02b_coverage_registry.csv` / `06_round_registry.csv`
  with `cell_status=open`), the approved gap queue, and the surfaces this round's
  Discovery Stream accepted. Closure asks *"is every known obligation closed?"*
- **Discovery Stream** — open exploration for surfaces nobody has enumerated yet.
  Exactly `K` candidates per round, allocated across fixed probe families, judged
  novel by script against a frozen baseline, scored by script, and — when they
  pass materiality and value — **appended to the living registry as new
  obligations**. Discovery asks *"does any high-value unknown surface remain?"*

Neither stream terminates the run. Termination is owned exclusively by the
verifier's two gates: **Gate A Coverage Floor** (evidence-sample recall floor)
and **Gate B Value Frontier Exhaustion** (marginal-value stopping rule), plus the
approved-budget escape hatch. See `../prompt-map-shared/references/coverage-floor-sampling.md`.

## Anti-closure clauses (hard rules, non-negotiable)

1. Discovery candidates MUST NOT be limited to, sampled from, or enumerated from
   `work/02b_surface_inventory.csv`, the current coverage registry, the demand-cell
   list, the approved Topic intersections, or the approved gap queue. Those are a
   **coverage baseline**, never a discovery ceiling.
2. Probe-family quotas allocate the fixed `K` candidate slots. They are **not** a
   whitelist and not a pre-enumerated surface list.
3. Every calibration and active round MUST submit the full `K` Stage 1 rows,
   including rejects with reasons. An empty Closure queue, a fully covered
   baseline, or a low expected yield are NOT reasons to shrink `K`, skip the
   round, or stop early.
4. Do NOT stop discovery because a Topic, route, inventory, angle grid, or gap
   queue is "exhausted" or "complete". The only legitimate stops are Gate B
   frontier exhaustion recomputed by the verifier, or budget exhaustion routed to
   `PASS_WITH_BACKLOG`.
5. An off-inventory surface is a legitimate discovery outcome, not an anomaly. A
   candidate may NEVER be rejected merely for being absent from the approved
   inventory. If it passes materiality and the value gate, it MUST be written to
   `04_accepted_surfaces.csv`.
6. An accepted discovery surface becomes an obligation **in the same round**:
   append to the round registry → author a natural Prompt → audit. Never defer it
   as "a supplement someone may pick up later". `discovered != covered`.
7. Discovery needs no per-surface human pre-approval. What is frozen and approved
   is the *protocol*: probe families and quotas, prompt templates, allowed
   derivation rules, the canonicalizer, and the E/D/P/T rubric.
8. "600+" is an expected-scale risk signal for a data-rich category, never a
   generation quota and never a PASS condition. A small output is a coverage-risk
   signal to investigate, not a compact success.
9. **Neither transcribing existing surfaces nor inventing unevidenced ones is
   probing.** A round must produce at least
   `min_new_surface_count = max(5, ceil(0.10 * K))` **exploratory** new surfaces —
   **10 on rich, 5 on narrow**. Below that the round is marked
   `probe_degenerate=true`: it does **not** count as a frontier pass, does **not**
   enter the streak, and is a **hard blocker routed to a human**.

   The counted quantity is `exploratory_new_count`, and a candidate counts only
   when all three hold:

   - `novelty_status == new` (script-adjudicated), **and**
   - `support_mode` is `direct` or `derived`, **and**
   - at least one of its `evidence_refs` resolves in the frozen evidence index.

   `new_surface_count` is still reported, but only as a diagnostic — it is not the
   floor's basis.

   **What counts, and why.** A new surface that carries resolvable evidence but
   fails the value bar (`V < V_accept`) **counts**. That is exactly the shape of
   genuine saturation: you can still find real, evidenced surfaces, they just stop
   being worth enough. What does **not** count is a `hypothesis` row — a candidate
   you never intended to evidence at all.

   This closes two ways of faking convergence. Fill all `K` slots by copying
   surfaces already in the map and every row returns `identical_existing`, giving
   `C=0, H=0, D=0` — arithmetic that reads as a *perfect* frontier pass. Patch that
   by adding a handful of well-formed but invented surfaces marked `hypothesis`,
   and a signature-only novelty count would be satisfied while still discovering
   nothing. Requiring evidence-seeking novelty closes both doors at once.
   **Failing to produce evidenced new surfaces is a probe failure, never evidence
   of saturation.** Never satisfy a slot by restating an existing Prompt, and never
   satisfy the floor with `hypothesis` filler.

   The floor stays **orthogonal to `C` / `H` / `D`**: it asks whether the probe
   explored, they ask whether what it found was valuable.

   Enforcement is literal about those three conditions and nothing more. A probe
   family's `evidence_requirements` is free text the script cannot mechanically
   adjudicate, so the gate does **not** verify that a candidate satisfies its
   family's stated evidence requirements — `verify` states the actual scope in
   `evidence.probe_floor_enforcement`. Honour the family requirements because they
   are the protocol you froze, not because a checker will catch you.

## Modes

- initial: in `cold_start`, generate a new natural category and internal-Topic
  Prompt base by running the Closure Stream over the initial coverage baseline.
  This is a **base**, not a completion.
- discovery: run one calibration or active discovery round at the frozen `K` and
  probe-family quotas.
- revision: preserve an accepted Prompt base and add only approved gap supplements.
- supplement: close approved gap-queue rows and still-open obligations produced by
  the Discovery Stream.

## Initial mode (Closure Stream over the baseline)

1. Read the first-version delivery contract and approved internal Topic list.
2. Generate the Category route for every eligible demand theme that is
   reusable across Topics.
3. Generate an independent Topic route for every approved evidence-backed
   assigned Topic. Do not route only to the theme's primary Topic.
4. Generate approved Topic intersections before writing Prompt text. For every
   high-value evidence-backed combination of Topic, audience, body/object,
   attribute/condition, scenario, decision angle, and concrete decision
   criterion, create an intersection candidate when the combination is a new
   canonical query surface. Prioritize intersections with multi-source support,
   strong Reddit demand, GEOly Topic evidence, search demand, or an approved
   long-tail/hypothesis rationale. Do not generate blind Cartesian products.
   Record each intersection in the surface/route inventory even when later
   marked `REVIEW`, `WAIVE`, or not product-card eligible. The same product
   shortlist may serve multiple intersections — expected in `geo_full_coverage`.
5. Derive an evidence-backed purchase task for each route and assign its
   canonical query-surface signature before writing final Prompt text. In
   `geo_full_coverage`, keep a candidate when it opens a new canonical surface
   (`audience | body_part_or_object | attribute_or_condition | scenario |
   decision_angle | decision_criterion`, plus evidence-backed conditional
   dimensions). Do NOT merge or reject a candidate merely because its product
   shortlist or `shortlist_delta` overlaps another; merge only exact-text or
   identical-surface duplicates (same-surface near-dups go to review). In
   `minimal_dedup`, keep only when the product shortlist/ranking lens changes.
   Every candidate records `coverage_mode, surface_signature,
   selection_change_test, shortlist_delta, decision_criterion, evidence_refs`.
6. Treat the initial draft as a base, not as proof of completion. Closing the
   baseline is the START of the run: calibration and active discovery rounds
   follow, and the verifier — not this module — decides when to stop.
7. **Do not stop when the baseline inventory is closed.** Closing every baseline
   obligation only satisfies the Closure Stream. Hand off to `discovery` mode.
   The legacy "stop when the approved surface inventory is exhausted" rule is
   REMOVED in this package version; it is the direct cause of truncated maps.
   In `minimal_dedup`, retain the legacy shortlist/ranking stopping rule.
8. Draft each Prompt as an independent, natural user utterance after its surface
   carries an obligation. Do NOT generate a batch by filling one reusable sentence
   frame with Topic/audience/scenario/criterion labels. A repeated sentence
   skeleton is allowed only when source questions naturally use it; otherwise
   route the rows to template-similarity review
   (`validate_prompt_surface_quality.py`).
9. Generate more specific Prompts under internal demand Topics when a natural
   Topic delta opens a new query surface (GEO) / changes the product shortlist
   (minimal). Do not create a Topic copy with a generic suffix; write the
   constraint into the user question.
10. Use natural user language. Do not expose internal cell IDs, raw source labels, or concatenated schema values in Prompt text. For medical- or safety-adjacent product needs, preserve the user's context while obeying the internal claim guardrail; never word a product as diagnosing, treating, curing, preventing, or guaranteeing a physiological outcome.
11. Keep the first-version balance between concise category questions and specific Topic questions.
12. Use brand-neutral prompts by default. Keep brand comparisons separate only when real comparison evidence exists.
13. Link each Prompt internally to one or more demand themes and audit cells, but keep those links out of the first-version delivery columns.
14. Do not use a fixed Prompt quota, a three-per-cell cap, or one-Topic-only
    routing. A data-rich category may correctly produce many hundreds of rows, but
    only as an outcome of distinct purchase tasks, never by Cartesian expansion.
15. Validate every candidate against
    `../prompt-map-shared/references/shortlist-difference-test.md` before handoff.
16. In `cold_start`, do not read any prior Prompt Map, regression workbook, or evaluation reference.
17. Emit the route-angle inventory and Prompt-angle links required by
    `../prompt-map-shared/references/generation-integrity.md`
    (`work/03_route_angle_inventory.csv`, `work/03_prompt_angle_links.csv`),
    carrying `route_id, route_level, topic, demand_theme_key, demand_cell_id,
    selection_change_test, shortlist_delta, evidence_refs, angle_status`. Before
    handoff, run
    `python3 ../prompt-map-shared/scripts/validate_generation_integrity.py --registry <project-root>/work/02b_coverage_registry.csv --prompts <project-root>/work/03_prompt_draft.csv --angle-inventory <project-root>/work/03_route_angle_inventory.csv --angle-links <project-root>/work/03_prompt_angle_links.csv --ledger <project-root>/work/03_candidate_surface_ledger.csv --coverage-mode <coverage_mode>`
    and treat a non-zero exit as blocking. (`--ledger` is required in
    `geo_full_coverage`; omit it only in `minimal_dedup`.)

## Discovery mode (one round)

A round is `rNN` under `work/coverage_rounds/`. Calibration rounds and active
rounds execute identically; only the gate treatment differs (calibration runs
with Gate B disabled and does not increment `coverage_round`).

### Step 0 — Baseline freeze and slot preparation

**First**, snapshot the baseline into `work/coverage_rounds/rNN/` as
`00_base_prompts.csv` (the current Prompt Map — this is what `base_map_sha256`
anchors to, never `03_prompt_draft.csv` or `05_prompt_final.csv`, which get
overwritten) and `00_base_registry.csv` (the current living registry). The script
refuses to prepare a round until both exist, because the baseline must be frozen
BEFORE any candidate exists.

**Then** run:

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py prepare-round --project-root <project-root> --round <N> --model-id <model-id> --temperature <temperature> [--calibration] [--force]
```

Preconditions the script enforces — it refuses to run otherwise, so satisfy them
before calling it:

- `state/convergence_profile.json` has `profile_frozen: true`.
- **`state/discovery_protocol.json` exists** and holds the actual content of all
  seven probe families — each family's prompt template, allowed derivation rules,
  prohibitions, and evidence requirements. This is a required project file, not
  documentation.
- `convergence_profile.discovery_protocol_sha256` equals the **real sha256 of
  `state/discovery_protocol.json`**. Both `prepare-round` and `verify` recompute
  it, so a hand-written hash, a post-freeze edit, or deleting the file is caught.
  Freeze the file first, then record its hash.
- `00_base_prompts.csv` and `00_base_registry.csv` already exist in the round dir.
- The immediately preceding round's `00_round_manifest.json` exists.
  (`prepare-round` only checks the adjacent round; the full "contiguous from
  `r01`" requirement is enforced later by `verify`, so a gap you create now
  surfaces as a failure at the final gate rather than immediately.)

Flags: `--calibration` marks a calibration round (frontier gate disabled, does not
count toward `max_round`, sets `round_kind: calibration` in the manifest);
`--model-id` and `--temperature` are recorded into the protocol fingerprint, so
pass the real values — changing them later is a protocol change that zeroes the
streak; `--force` is required to regenerate an existing round's candidates.

`--force` overwrites only `01_discovery_candidates.csv` and
`00_round_manifest.json`. It does **not** delete that round's
`01_discovery_novelty.json`, `02_discovery_values.csv`, `03_discovery_ledger.csv`,
`04_accepted_surfaces.csv`, Prompts, registry, audit, or summary. Delete those
yourself before re-preparing, or the round will be scored against stale artifacts
from the candidates you just discarded.

`--round` takes the integer `N`; the script resolves the `rNN` directory itself.
It writes `00_round_manifest.json` (profile, `K`, `N`, `delta`, family quotas,
`slot_hash`, base hashes, `previous_registry_sha256`, protocol and canonicalizer
hashes, model ID, temperature, `round_kind`, `min_new_surface_count`,
`approved_discovery_budget_rounds`) and the pre-filled
`01_discovery_candidates.csv` carrying `round_id, candidate_id, probe_family,
probe_slot`. Slots are hashed before the round so the agent cannot spend all `K`
on the easiest dimension. Never hand-write the manifest or the slot columns.

Probe family portfolio at rich `K=100`:

```
15  audience / body / condition deepening
15  constraint-bearing scenarios
20  decision-criterion and tradeoff deepening
15  high-value Topic intersections
15  compatibility / format / access
10  switching / comparison / replacement
10  reliability / maintenance / result horizon
```

Narrow `K=40` uses the same proportions rounded to `6 / 6 / 8 / 6 / 6 / 4 / 4`.

### Step 1 — Fill all K candidates (agent, exactly 10 columns)

For every one of the `K` pre-filled slots, propose a candidate surface using that
slot's probe family template, allowed derivation rules, prohibitions, and evidence
requirements. Fill ONLY:

```
audience, body_part_or_object, attribute_or_condition, scenario,
decision_angle, decision_criterion, conditional_dimensions, evidence_refs,
derivation_rule_id, decision_distinction
```

Do NOT fill `canonical_surface_signature`, `is_new_surface`, `novelty_status`,
`identical_surface`, or `nearest_prompt_id` — the script computes them. Every row
must carry a non-empty `decision_distinction`, including rows you expect to be
rejected. Submit all `K` rows; never prune the file to the promising ones.

### Step 2 — Scripted novelty adjudication (first scoring pass)

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py score-round --project-root <project-root> --round <N>
```

`score-round` is a single subcommand that recomputes novelty AND value in one
pass. Run it here purely to obtain novelty: it writes
`01_discovery_novelty.json`, judging each candidate only against the frozen
`00_base_prompts.csv` signatures plus this round's seen set, yielding
`novelty_status` in `new` / `identical_existing` / `duplicate_within_round` /
`invalid_surface`.

On this first pass the script exits non-zero with
`02_discovery_values.csv is missing but <n> new surfaces exist` (or a
new-surfaces-missing-from-Stage-2 failure), and with
`09_identical_recheck.csv is missing` when the round has identical rows. **Those
two failures are expected at this point and are not blockers** — they are the
script telling you which rows Stage 2 and the re-check must cover. Any OTHER failure (row count != `K`, an unmet probe-family quota, a
slot-hash mismatch, a script-owned column present in Stage 1) IS blocking: fix
Stage 1 and re-run before continuing.

### Step 2b — Identical re-check (required every round)

Write `09_identical_recheck.csv` covering **every** candidate in the script's
deterministic re-check sample, with exactly these columns:

```
candidate_id, reviewer_verdict, reason
```

`reviewer_verdict` is `confirmed_identical` or `actually_distinct`; `reason` must
be non-empty on every row. The round fails if the file is missing, does not cover
the full sample, carries an invalid verdict, or has an empty reason.

**Any row marked `actually_distinct` fails the round**: the canonicalizer merged a
surface that is genuinely different, so the round must be re-scored — fix the
surface fields and re-run the novelty pass before scoring. Do not "resolve" it by
flipping the verdict to `confirmed_identical`.

Do this now, before Stage 2: `score-round` requires the file whenever the round
has an identical sample, so the second scoring pass cannot exit zero without it.
The sample is deterministic, so it does not change between passes.

### Step 3 — Value evidence for new rows only (agent, exactly 12 columns)

For rows with `novelty_status == new` and ONLY those rows, fill:

```
support_mode (direct|derived|hypothesis),
reddit_cluster_count, semrush_keyword_count, semrush_monthly_volume,
geoly_public_prompt_count, geoly_topic_or_card_count, brand_customer_case_count,
product_card_eligible, product_impact_code,
track_natural_query, track_concrete_answer, track_reusable_surface
```

`product_impact_code` is one of `P4_ELIGIBILITY_GATE`, `P3_PRIMARY_RANKING`,
`P2_SECONDARY_TRADEOFF`, `P1_EMPHASIS_ONLY`, `P0_NO_CHANGE`. The three `track_*`
fields are Yes/No. Counts must be recomputable from `work/02_evidence_index.csv`;
a Reddit cluster is a distinct `cluster_id`, and score/upvotes/comment counts
never change a bucket. `support_mode=derived` **fails closed**. The one and only authoritative rule table
is `approved_derivation_rule_ids` inside the frozen
**`state/discovery_protocol.json`** — the same file `discovery_protocol_sha256`
hashes, so the rule table is covered by the protocol freeze and cannot be edited
after the fact. There is no secondary or fallback location: a rule list kept
anywhere else is not hashed, and an unhashed side door would make "the rule table
is frozen with the protocol" an empty claim.

If that table is **missing or empty, `derived` is unavailable** — every
`support_mode=derived` row scores `E0` and is rejected. Absence is never a
permissive mode; it is a closed door.

Each probe family's `allowed_derivation_rules` must be **non-empty** and a
**subset** of the global table: a family can narrow the allowed rules, never
introduce one the global table does not contain. Note the practical consequence —
an empty global table cannot satisfy both requirements at once, so the protocol
does not validate at all and the gate reports an **integrity failure**, not a
lenient run. If you genuinely intend to run without derivation, say so with a
human decision and no `derived` rows, rather than by emptying the table. A `derivation_rule_id` outside the
frozen table is rejected; it is not free text. Plain concatenation of two evidenced
dimensions is not derivation. Brand FAQ / spec sheets / marketing copy are `support_mode=hypothesis`
with no demand evidence.

**The agent NEVER writes** `source_family_count`, `direct_evidence_unit_count`,
`E`, `D_reddit`, `D_semrush`, `D_geoly`, `D_brand`, `D`, `P`, `T`, `value_score`,
`materiality_pass`, `value_gate_pass`, `critical_value`, `disposition`, or
`reason`. The script derives all of them
(`V = 0.30*E + 0.25*D + 0.30*P + 0.15*T`, rounded to 3 decimals; the hard
materiality gate is evaluated before `V_accept`). Writing any derived column by
hand is a blocking protocol violation.

### Step 4 — Scripted scoring and acceptance (second scoring pass)

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py score-round --project-root <project-root> --round <N>
```

On an **active** round, add
`--emit-run-state-patch <project-root>/work/coverage_rounds/rNN/run_state_patch.json`.
Apply the patch **verbatim** — it carries this round's recomputed frontier
statistics, and the script computes `coverage_round` and `calibration_round`
itself from each round's declared `round_kind`, which is exactly what the gate
reconciles against. Do not hand-correct either counter, and never derive one from
a directory index.

The Stage 2 ID set must now equal the `new` ID set exactly — extra rows scoring
non-new candidates fail just as hard as missing ones. This pass must exit zero.
It writes `03_discovery_ledger.csv` (ALL `K` candidates, rejects included, with
reasons) and `04_accepted_surfaces.csv` (`is_new_surface` AND `materiality_pass`
AND `value_score >= V_accept`), and reports `C_t`, `H_t`, `M_t`, `D_t = M_t / K`.
It also flags REVIEW for any `identical_existing` row whose
`decision_distinction` claims a new criterion, and nominates
`min(5, identical_existing_count)` rows for re-check by deterministic hash.
Accepted rows are NOT yet covered.

It additionally reports `min_new_surface_count`, `exploratory_new_count`,
`new_surface_count` (diagnostic only), `probe_degenerate`, and
`identical_recheck_complete`. If
`probe_degenerate` is true (`exploratory_new_count` below the floor — 10 on rich,
5 on narrow), **stop and escalate to a human**. Do not re-run the probe hoping for a
better draw and do not proceed to Prompt authoring: the round cannot pass the
frontier and counts as a hard blocker.

### Step 5 — Register the obligation

First initialize `06_round_registry.csv` as a full copy of `00_base_registry.csv`
— it is the round's complete living registry, not a delta file. Dropping the
inherited rows would silently discard every earlier obligation, and the gate fails
on any surface that disappears from the registry.

Then append every accepted surface with
`surface_origin=discovery`, `introduced_round=rNN`, `discovery_candidate_id`,
`frontier_value_score=<computed>`, `cell_status=open`, and an empty
`covered_prompt_ids`. This creates an obligation the audit will hold open.

**Closure Stream additions go in `06_closure_additions.csv`, never straight into
the registry.** The Closure Stream may also legitimately surface new registry rows
— an approved gap-queue expansion, a newly approved Topic intersection, a
human-directed addition. Those did NOT come through the Discovery value gate, so
the gate cannot see where they came from. It therefore enforces:

```
base_registry(round N) − { registry(N−1) ∪ accepted_discovery(N−1) ∪ 06_closure_additions(N−1) }  must be empty
```

Concretely, the gate evaluates this at the NEXT round's frozen
`00_base_registry.csv`: a surface that appears there but traces to none of the
three allowed origins is reported as **registry stuffing** and fails the run.
Because the previous round's `06_round_registry.csv` is taken as a whole into the
allowed set, a row quietly slipped into it during its own round is not caught by
this arithmetic — the coverage audit's round-mode check on
`06_closure_additions.csv` is what catches that, so treat the declaration as a
hard obligation and not a formality. So:

- Write every Closure-originated new surface to
  `work/coverage_rounds/rNN/06_closure_additions.csv` **before** adding it to
  `06_round_registry.csv`. Each row carries the six surface fields (an incomplete
  surface fails) **plus a full approval envelope, every field non-empty**:

  ```
  closure_addition_id, source_gap_id, evidence_refs, approval_ref, closure_reason
  ```

  `closure_addition_id` must be unique within the file.
- **Re-admitting a rejected Discovery surface requires `human_override_ref`.** If
  a closure addition's canonical signature matches a surface Discovery REJECTED in
  the same round, the row must also carry a non-empty `human_override_ref` or the
  run FAILS. This is the executable guard against laundering a value-gate
  rejection through the closure door — the override is a human decision on the
  record, not a workaround the agent may issue itself.
- This file is optional only in the sense that a round with no Closure-originated
  additions omits it. A round that adds any is required to declare them.
- It is a declaration channel, not a bypass: these rows still become obligations
  that need a linked valid Prompt, and they must not be used to launder a surface
  the Discovery value gate rejected.
- Never delete an inherited registry row: obligations may not be dropped.
- When the previous round's `06_round_registry.csv` is present, this round's
  manifest hash-binds it (`previous_registry_sha256`), so back-filling it after
  the fact is detected as rewriting registry history. That binding is skipped if
  the file is missing, so keep every round's registry in place — deleting one
  removes the tamper-evidence rather than passing the check.

### Step 6 — Author Prompts for accepted surfaces only

`05_round_prompts.csv` is the **after-round Prompt Map**, not a delta file:
initialize it as a full copy of `00_base_prompts.csv`, then add one natural,
independent user utterance per accepted surface, following the initial-mode
wording rules (natural language, no internal labels, no reusable sentence frame,
claim guardrail on medical/safety-adjacent needs). Do not author Prompts for
rejected candidates, and never drop the inherited base rows — the project-level
ledger and registry reference every earlier Prompt.

Then append this round's newly authored rows to the project-level
`work/03_candidate_surface_ledger.csv` (`candidate_id`, `prompt_id`,
`surface_signature`, `disposition`, `reason`, plus `surface_origin=discovery`,
`introduced_round`, `discovery_candidate_id`, `frontier_value_score`). The
integrity validator reads that ledger, so a new Prompt missing from it is reported
as an orphan and blocks the round. Then run the prompt-authoring guards:

```
python3 ../prompt-map-shared/scripts/validate_shortlist_difference.py --prompts <project-root>/work/coverage_rounds/rNN/05_round_prompts.csv --coverage-mode <coverage_mode>
python3 ../prompt-map-shared/scripts/validate_generation_integrity.py --registry <project-root>/work/coverage_rounds/rNN/06_round_registry.csv --prompts <project-root>/work/coverage_rounds/rNN/05_round_prompts.csv --angle-inventory <project-root>/work/03_route_angle_inventory.csv --angle-links <project-root>/work/03_prompt_angle_links.csv --ledger <project-root>/work/03_candidate_surface_ledger.csv --round-dir <project-root>/work/coverage_rounds/rNN --coverage-mode <coverage_mode>
python3 ../prompt-map-shared/scripts/validate_prompt_surface_quality.py --prompts <project-root>/work/coverage_rounds/rNN/05_round_prompts.csv --coverage-mode <coverage_mode> --output <project-root>/work/coverage_rounds/rNN/surface_quality_report.json
```

`--round-dir` is what turns on the discovery-round checks (Stage 1 = `K` rows,
family quotas, Stage 1/2 ID alignment, accepted surfaces present in the registry
and in the round Prompt Map). `--ledger` still points at the project-level
candidate→surface ledger, **not** at `03_discovery_ledger.csv`, which uses the
discovery column contract (`canonical_surface_signature`, no `prompt_id` at
scoring time) and will fail the generic ledger check. Because that ledger names
every previously accepted Prompt, `05_round_prompts.csv` must be the full
after-round map — if it held only this round's new rows, every earlier ledger row
would be reported as having no valid `prompt_id`.

During the discovery surface phase (Step 1–Step 5, structured surfaces with no
Prompt text yet) run only exact canonical duplicate, identical canonical
signature, and invalid/null surface checks. Do NOT run the template validator
before Prompt text exists.

Only a linked valid Prompt flips a registry row to `cell_status=covered` with
`covered_prompt_ids=<id>`; the coverage audit — not this module — makes that call
and emits `07_round_coverage_audit.csv`. Round files are promoted to current
state only after validators and audit pass.

## Revision mode

1. Load the accepted Prompt Map as the golden content baseline.
2. Preserve its approved Prompt wording, internal Topics, category/Topic routing, and delivery fields.
3. Add or rewrite only rows tied to an approved coverage gap, an open discovery
   obligation, or an explicit human correction.

## Supplement mode

1. Read BOTH supplement inputs: (a) the approved gap queue from the coverage
   registry, including its missing decision dimension, evidence, nearest Prompt,
   and novelty reason; and (b) every still-open obligation in
   `04_accepted_surfaces.csv` / the living registry with
   `surface_origin=discovery` and `cell_status=open`. A discovery-accepted surface
   does not need a separate gap-queue entry or a separate human approval — the
   value gate already approved it, and the agent may not choose which accepted
   rows to skip. `03_discovery_ledger.csv` is the audit ledger, not a menu.
2. If closing a gap requires a surface that is not yet in the living registry,
   declare it in that round's `06_closure_additions.csv` first, then add it to
   `06_round_registry.csv`. Adding it directly to the registry fails the
   stuffing check.
3. Add a Prompt when the gap or obligation changes the audience, body area,
   scenario, pain, function, result expectation, purchase stage, purchase
   decision, or a meaningful Topic distinction — or when it is an accepted
   discovery surface, which is by construction a new canonical surface.
4. Match the natural wording and Topic structure of the accepted base.
5. Reject synonym-only rewrites, template spam, and prompts that merely restate an existing row. In the handoff, state exactly which new decision distinction each supplement adds.

## Outputs

Initial mode:

- work/03_prompt_draft.csv
- work/03_category_prompts.csv
- work/03_topic_prompts.csv
- work/03_route_angle_inventory.csv
- work/03_prompt_angle_links.csv
- work/03_candidate_surface_ledger.csv (GEO mode: one row per candidate with
  `candidate_id, prompt_id, surface_signature, disposition` where disposition is
  `accepted` / `merged` / `rejected`, plus `reason`)
- work/03_summary.md

Discovery mode — `work/coverage_rounds/rNN/`, with ownership marked:

| file | written by |
|---|---|
| `00_base_prompts.csv` | frozen baseline snapshot, written BEFORE `prepare-round` |
| `00_base_registry.csv` | frozen baseline snapshot, written BEFORE `prepare-round` |
| `00_round_manifest.json` | script (`prepare-round`) |
| `01_discovery_candidates.csv` | script (`prepare-round`) pre-fills 4 columns; agent fills the 10 Stage 1 columns |
| `01_discovery_novelty.json` | script (`score-round`) |
| `02_discovery_values.csv` | agent fills the 12 Stage 2 columns for `new` rows only |
| `03_discovery_ledger.csv` | script (`score-round`, all `K` rows) |
| `04_accepted_surfaces.csv` | script (`score-round`) |
| `05_round_prompts.csv` | agent (this skill) — base map copy + this round's new Prompts; the after-round map |
| `06_closure_additions.csv` | this skill — optional; REQUIRED to declare any Closure-originated new surface before it enters the registry, with the full approval envelope |
| `09_identical_recheck.csv` | agent (this skill) — REQUIRED every round; covers the script's deterministic re-check sample |
| `06_round_registry.csv` | this skill copies `00_base_registry.csv` then appends accepted discovery + declared closure additions; audit updates `cell_status` |
| `07_round_coverage_audit.csv` | prompt-map-coverage-audit |
| `08_round_summary.json` | script (`score-round`) |

Supplement mode:

- work/03_prompt_supplement.csv
- merged versioned draft
- appended rows in work/03_candidate_surface_ledger.csv for the round's candidates
- updated work/03_summary.md

At the final audit, the dedupe step carries the surviving angle links, the
discovery lineage fields, and the ledger forward as
`work/05_prompt_angle_links.csv` and `work/05_candidate_surface_ledger.csv` so the
final integrity check runs against the post-dedupe set.

Internal audit links may be stored in working CSVs. Internal-only fields
(`surface_origin`, `introduced_round`, `discovery_candidate_id`,
`frontier_value_score`, `derivation_rule_id`) never appear in the visible
workbook. The visible delivery remains the first-version contract.

## Blocking rules

Pause when the run mode is not declared, the reusable delivery contract or
approved internal Topic list is missing, the convergence profile or discovery
protocol is not frozen before a round, `01_discovery_candidates.csv` has fewer
than `K` rows or an unmet probe-family quota, a Stage 1 row has an empty
`decision_distinction`, a Stage 2 row exists for a candidate the script did not
mark `new`, a derived value column was hand-written, a `derived` row has no valid
`derivation_rule_id`, a new registry surface was added without being declared in
`06_closure_additions.csv` or without its full approval envelope, a rejected
discovery surface was re-admitted through closure without `human_override_ref`,
an inherited registry row was dropped, `state/discovery_protocol.json` is missing
or its hash does not match the frozen `discovery_protocol_sha256`, the round is
`probe_degenerate`, `09_identical_recheck.csv` is missing/incomplete/invalid or
contains an `actually_distinct` verdict, a `derived` row was scored with no frozen
approved rule list, a supplement gap has no evidence, novelty rationale, or
human decision, a Prompt is unnatural or not product-card eligible, or generation
would change the delivery structure without approval. A missing prior Prompt Map
is normal in `cold_start` and must not block the run.

**Stop, don't guess.** If required upstream inputs or memory fields are missing,
halt and ask for evidence rather than fabricate a candidate, a cluster count, or a
value component.

End with the shared HandoffContract, including `CoverageFloor`,
`DiscoveryFrontier`, `ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and
`ProtocolVersion`.
