# Coverage Floor Sampling

This file is the authority for **Gate A — the Coverage Floor**: a statistical
recall floor computed against an independent evidence sample. It answers "does
the delivered map actually cover the demand our own evidence corpus contains?"

Gate A prevents under-production. Gate B (`discovery-protocol.md`,
`coverage-loop.md`) prevents non-termination. The two gates oppose each other
deliberately — neither alone is sufficient.

The floor is **never** computed from registry row counts. The registry is
downstream of demand extraction, so a registry-based ratio can only tell you
whether the map matches what the extractor already surfaced; it cannot detect
evidence the extractor missed. The floor samples the raw evidence index instead.

The executable interface is owned by the script layer; the operations below are
normative. Batch selection is
`verify_coverage_convergence.py --prepare-floor`, which takes:

- `--batch 1|2` — which batch to draw. Batch 2 is the independent re-draw after a
  **Wilson failure**; the script verifies that the two batches are disjoint.
- `--top-up` — the automatic completion path for a batch whose **eligible count
  fell short of `coverage_floor_n` because of exclusions**. It appends rows to
  the *same* batch, deterministically, same-source first and then cross-source
  in the fixed order `reddit → geoly → semrush`.

Batch ledgers are written to `work/coverage_floor/batch<N>/floor_batch.csv`.

**`--top-up` and `--batch 2` are not interchangeable.** Reaching for the wrong
one silently destroys the gate's meaning:

| situation | correct action |
|---|---|
| the batch drew `n` rows but exclusions left `eligible_count < coverage_floor_n` | `--top-up` — extend the **same** batch until it reaches `n` |
| the batch reached `n` and the Wilson upper bound came out `>= 0.10` | `--batch 2` — a **new, disjoint** batch drawn from still-unsampled evidence, judged independently |

Never use `--top-up` to recover from a Wilson failure: appending rows to a failed
batch until the bound drops is sampling until you like the answer. Never use
`--batch 2` to fix a mere shortfall either — that burns unsampled evidence which
the run may need later for a genuine second batch.

---

## Evidence index

The floor samples `work/02_evidence_index.csv`. Its schema is defined in
`demand-schema.md`:

```
evidence_id, source_type, source_record_id, cluster_id, evidence_text,
source_metric, source_url, demand_theme_key, floor_candidate
```

- `source_type in {reddit, semrush, geoly, brand}`.
- `source_metric` carries Semrush volume; it may be empty for other sources.
- `floor_candidate in {Yes, No}`, set to `Yes` by the demand extractor for any
  row that **could** express purchase demand. It is a permissive pre-filter, not
  a judgement — the sampled agent still decides eligibility per row.

---

## Sampling — done by the script, never by the agent

Quotas by profile:

| profile | `n` | Reddit | Semrush | GEOly | Brand |
|---|---:|---:|---:|---:|---:|
| rich | 60 | 30 | 20 | 10 | 0 |
| narrow | 50 | 25 | 15 | 10 | 0 |

Brand quota is zero: brand material is a hypothesis generator, not a demand
sample, so it cannot be part of a recall denominator.

Over rows with `floor_candidate == Yes`, sort ascending by

```
sha256(project_id + "|coverage_floor_v1|" + evidence_id)
```

and take each source's quota from the head of its own ordering. The hash is
deterministic and independent of anything the agent controls, so a batch cannot
be steered toward already-covered evidence.

**Semrush sub-rule.** Within the Semrush quota, take the first half by
**descending volume** and the second half by **hash order** — head plus tail,
without probability-proportional-to-size. Pure hash order under-samples the
high-volume head; pure volume order ignores the long tail.

### Reaching `n`: same-source top-up, then cross-source reallocation

`n` must reach the profile's `coverage_floor_n`. Two mechanisms apply, strictly
in this order.

Both are driven by `--prepare-floor --top-up` on the same batch.

**1. Same-source top-up (first priority).** If exclusions leave the eligible
count short, the script tops up from **the same source's** next hash-ordered
rows. Quota is never reallocated while the source still has unsampled
`floor_candidate == Yes` rows.

**2. Cross-source reallocation (second step).** Once a source's
`floor_candidate == Yes` pool is exhausted, its unmet remaining quota is
reallocated to the sources that still have unsampled rows, in the fixed order:

```
reddit → geoly → semrush
```

Brand is permanently 0 and never participates in reallocation, in either
direction. This is what lets a project with no Semrush input at all still reach
its nominal `n`: the unfillable Semrush quota flows to Reddit first, then GEOly.

The order is fixed rather than proportional so that reallocation is deterministic
and cannot be steered.

**3. Reallocation must be visible.** The floor batch ledger and the round summary
must record:

- `floor_quota_reallocated` — the original quota per source → the actual quota
  per source;
- `floor_source_pool_exhausted` — which source pools ran dry.

The gate reads both. A batch that reallocated silently is an invalid batch: the
whole point of a fixed quota is that a deviation from it is auditable.

**4. When even the full pool is short.** If every source's eligible pool is
exhausted and the batch still has `n < coverage_floor_n`:

- compute Wilson on the **actual** `n` — never pad, never assume the unsampled
  remainder is covered;
- set `reduced_evidence_sources` and `evidence_pool_short_of_n` on the run;
- cap the run at **`PASS_WITH_BACKLOG` permanently**. A normal `PASS` is not
  available, and no human approval unlocks one.

This is the same treatment as a project with no Semrush input at all — see
`value-rubric.md`. Note that `PASS_WITH_BACKLOG` still requires the floor to have
**passed** at the reduced `n`; the cap limits the best available outcome, it
never delivers around a failed floor.

---

## What the agent fills

For each sampled row, the agent fills only:

```
eligible, exclusion_reason, audience, body_part_or_object,
attribute_or_condition, scenario, decision_angle, decision_criterion
```

`exclusion_reason` is a **closed enum**:

```
not_purchase_related
education_only
medical_or_safety_only
service_only
wrong_category
duplicate_evidence
insufficient_text
```

Any value outside this enum fails the gate. `exclusion_reason` is required when
`eligible == No` and must be empty when `eligible == Yes`.

Of these eight columns, two (`eligible`, `exclusion_reason`) are the eligibility
judgement; the other six are the canonical surface fields.

The agent never fills `surface_signature`, `covered`, or `covered_prompt_ids`.
The script canonicalizes the **six canonical surface fields** and matches the
signature against the final map itself — so an agent cannot declare a row
covered.

---

## Computation

```python
eligible_rows  = [r for r in sample if r.eligible == "Yes"]
uncovered_rows = [r for r in eligible_rows
                  if canonical_signature(r) not in final_prompt_signatures]
n, x  = len(eligible_rows), len(uncovered_rows)
rate  = x / n
upper = wilson_upper(x, n, z=1.645)
passed = upper < 0.10

def wilson_upper(x, n, z=1.645):
    if n <= 0: raise ValueError("n must be positive")
    p, z2 = x / n, z * z
    num = p + z2/(2*n) + z*sqrt(p*(1-p)/n + z2/(4*n*n))
    return num / (1 + z2/n)
```

`z = 1.645` is a one-sided 95% bound. Gating on the Wilson **upper** bound
rather than the raw rate means a small sample cannot pass by luck.

### Verified tolerances

| profile | `n` | misses `x` | Wilson upper | verdict |
|---|---:|---:|---:|---|
| rich | 60 | 2 | 9.59% | PASS |
| rich | 60 | 3 | 11.87% | FAIL |
| narrow | 50 | 1 | 8.48% | PASS |
| narrow | 50 | 2 | 11.39% | FAIL |

### Why `n` has a hard lower bound

At `x = 0` the Wilson upper bound collapses to a closed form that depends only on
`n`:

```
wilson_upper(0, n) = z² / (n + z²)
```

Requiring that to be `< 0.10` with `z = 1.645` (`z² = 2.706`) gives
`n > 24.354`, i.e. **`n >= 25`**. Below 25, a sample cannot pass the floor *even
with a perfect score* — the gate would be unreachable no matter how good the map
is.

That is the arithmetic behind `coverage_floor_n = 50` for narrow rather than 40.
`n = 40` clears the `x = 0` bar (6.34%), but its very next step already fails:
`x = 1` gives 10.46%. A gate that tolerates **zero** misses is too brittle to be
usable, so narrow takes `n = 50`, where `x = 1` passes at 8.48% and `x = 2`
fails at 11.39%.

---

## On a floor miss

Never repair against the same batch and then declare that batch passing — that
converts the sample into a checklist and destroys its statistical meaning.

```
Batch 1 FAIL (Wilson upper >= 0.10)
  → the misses go into the gap queue
  → supplement (Closure Stream authors Prompts for them)
  → --prepare-floor --batch 2, drawn from the STILL-UNSAMPLED evidence
  → Batch 2 judged independently   (the script verifies the batches are disjoint)
```

This is the **Wilson-failure** path, and `--top-up` has no role in it. A
short-sample shortfall is a different problem with a different fix — see the
comparison table above.

At most two batches per run. If Batch 2 still fails, set
`coverage_floor_passed = false`. No normal `PASS` is available, and
`PASS_WITH_BACKLOG` is not available either — both require the floor to have
passed.

---

## Degraded mode: `registry_proxy`

`coverage_floor_mode = registry_proxy` computes the floor against the coverage
registry instead of an evidence sample. It is allowed **only** when all of:

- the base, angle, and final audits all pass;
- `high_priority_uncovered_count == 0`;
- a human approves that evidence sampling cannot be run.

Its consequences are mandatory:

- it **caps the run at `PASS_WITH_BACKLOG`**;
- it must **never** emit a normal `PASS`;
- it must **never** claim or report a Wilson bound.

Reason: the audit checks the registry, and the registry comes from demand
extraction — so a registry proxy cannot detect evidence that the extractor never
surfaced. It is a consistency check, not a recall measurement, and must not be
presented as one.

---

## Recorded state

The floor writes to `state/run_state.json` (see `context-contract.md`):

```
coverage_floor_mode, coverage_floor_batch_id, coverage_floor_eligible_count,
coverage_floor_uncovered_count, coverage_floor_rate, coverage_floor_wilson_upper,
coverage_floor_passed, coverage_floor_ledger_sha256
```

Batch ledgers live under `work/coverage_floor/`. The final gate **recomputes**
the Wilson bound from the ledger and never trusts the stored value — see the
recomputation checklist in `coverage-loop.md`.
