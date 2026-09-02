# Status Vocabulary

Two vocabularies exist and must never be mixed. **Evidence tier** describes how
well one row is supported. **Run and delivery status** describes whether the
whole run converged. A row labelled `已验证` says nothing about convergence, and
a run at `PASS` does not upgrade any row's evidence tier.

## Run status (convergence)

Recomputed by the final gate from ledgers — never read from `run_state.json`.
See `coverage-loop.md`.

- `PASS` — the Coverage Floor passed, the discovery frontier is exhausted over
  the required streak, hard blockers are zero, and the run is **not** capped at
  backlog.
- `PASS_WITH_BACKLOG` — the floor passed and hard blockers are zero, but the
  budget is spent (`coverage_round >= max_round`, or the approved discovery
  budget is exhausted) while the frontier is still open. It additionally
  requires: this round's high-value surfaces already merged into the map;
  remaining frontier candidates, mid/low-value derived surfaces, and exploration
  directions attached as `outputs/discovery_backlog.csv`; and explicit human
  approval of delivery. Delivery must state verbatim:

  > `Evidence coverage floor passed. Discovery frontier not fully exhausted within the approved budget. Remaining exploration backlog is attached.`

  The budget condition is **never waived**: backlog delivery requires
  `budget_spent AND (frontier_open OR capped_at_backlog)`.

### The permanent backlog cap

A run is capped at `PASS_WITH_BACKLOG` — **permanently, with no human upgrade
path to `PASS`** — when any of these holds:

- `reduced_evidence_sources` is non-empty;
- `evidence_pool_short_of_n` (the eligible pool could not reach
  `coverage_floor_n`);
- `coverage_floor_mode = registry_proxy`.

Missing evidence cannot be approved into complete coverage. A capped run that
also satisfies floor, hard blockers, and frontier exhaustion reads `CONTINUE`
until its budget is spent, then delivers as `PASS_WITH_BACKLOG`. It never emits
`PASS`.

### Exactly two authorized delivery claims

There are only the two sentences above — the `PASS` wording and the
`PASS_WITH_BACKLOG` wording. Do not invent a third for a reduced-evidence run:
state that fact in a note accompanying the backlog, alongside the approved
sentence rather than in place of it.

- `CONTINUE` — not yet convergent, no hard failure; run another round.
- `FAIL` — the floor failed **after the permitted second batch** (or no batch
  remains), or high-priority gaps remain, or validator blockers remain, or the
  ledger/protocol is incomplete, or someone attempted to converge by shrinking
  the denominator or editing the rubric. A Batch 1 floor miss with Batch 2 still
  available is `CONTINUE`, not `FAIL`.

## Gate status

- `coverage_floor_passed` / `coverage_floor_failed` — Gate A, the statistical
  recall floor (`coverage-floor-sampling.md`).
- `frontier_exhausted` / `frontier_open` — Gate B, the marginal-value stopping
  rule (`discovery-protocol.md`).

## Delivery status

`BLOCKED` until the recomputed run status is `PASS` or `PASS_WITH_BACKLOG`.
Never claim "exhaustive category complete" in any delivery artifact.

## Evidence tier

Use these labels consistently on individual rows:

- `已验证`: supported by direct source evidence and approved.
- `Reddit已验证/长尾`: concrete Reddit VOC with weak or absent search-volume confirmation.
- `GEOly公共池证据`: direct public Prompt/Topic/card evidence.
- `待验证假设`: inferred from a feature, sparse signal, or uncovered matrix cell.
- `可补充品牌资料`: analysis can continue, but brand evidence is missing.
- `需人工确认`: ambiguous split, mapping, or near duplicate.
- `阻断`: required input or contract is missing.

Do not convert `待验证假设` to `已验证` merely because a Prompt was generated.
