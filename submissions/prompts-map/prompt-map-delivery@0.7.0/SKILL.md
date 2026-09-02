---
name: prompt-map-delivery
description: Deliver an approved cold-start or revision product-card Prompt Map as CSV and Excel using the reusable seven-column category/internal-Topic workbook contract, on either a PASS or a human-approved PASS_WITH_BACKLOG outcome with an attached discovery backlog. Use when exporting the final workbook, wording the coverage claim, or shipping at approved-budget exhaustion.
---

# Prompt Map Delivery

Read the reusable delivery contract and declared run mode before exporting.

## Entry gate

Require an approved final coverage audit, no unresolved meaningful gaps,
duplicates, or route angles, and an explicit decision to use or change the
reusable delivery contract. Confirm the final audit artifact is newer than the
draft consumed for delivery; otherwise mark delivery stale and stop.

Re-run all shared guardrails at the `delivery` stage before exporting (paths
are relative to this skill's install directory; `prompt-map-shared` is a sibling
skill):

```
python3 ../prompt-map-shared/scripts/verify_coverage_convergence.py verify --project-root <project-root> --stage delivery
python3 ../prompt-map-shared/scripts/verify_decision_angle_gate.py --project-root <project-root> --stage delivery
python3 ../prompt-map-shared/scripts/validate_shortlist_difference.py --prompts <project-root>/work/05_prompt_final.csv --coverage-mode <coverage_mode>
python3 ../prompt-map-shared/scripts/validate_generation_integrity.py --registry <project-root>/work/02b_coverage_registry.csv --prompts <project-root>/work/05_prompt_final.csv --angle-inventory <project-root>/work/03_route_angle_inventory.csv --angle-links <project-root>/work/05_prompt_angle_links.csv --ledger <project-root>/work/05_candidate_surface_ledger.csv --coverage-mode <coverage_mode>
python3 ../prompt-map-shared/scripts/validate_prompt_surface_quality.py --prompts <project-root>/work/05_prompt_final.csv --coverage-mode <coverage_mode> --strict --resolved-ledger <project-root>/state/template_resolutions.json --output <project-root>/work/05_surface_quality_report.json
```

A non-zero exit from ANY of them blocks delivery. This module **consumes** the
verifier's status; it never infers convergence itself and never recomputes a rate,
Wilson bound, or frontier statistic. In `geo_full_coverage`,
`verify_decision_angle_gate.py --stage delivery` calls
`verify_coverage_convergence.py` and blocks unless the status is `PASS` or
`PASS_WITH_BACKLOG`; `validate_prompt_surface_quality.py --strict` exits non-zero
on any unresolved template REVIEW; and the gate fails if the final
surface/intersection audit is stale (older than `05_prompt_final.csv`).

## Delivery outcomes

Only two statuses may be exported.

**`PASS`** — Gate A Coverage Floor passed with a real Wilson bound, hard blockers
zero, Gate B frontier exhausted over the required streak under one protocol hash.
Claim wording:

> Evidence coverage floor passed. Discovery frontier exhausted.

**`PASS_WITH_BACKLOG`** — Gate A passed, hard blockers zero, `coverage_round >=
max_round` **or** — when `approved_discovery_budget_rounds` was frozen non-null
with the profile — the active-round count has reached that approved budget.
Either path satisfies the budget precondition, and both are measured in active
rounds, never in round-directory numbers. `max_round` is a frozen profile constant
and may not be lowered to reach this branch early. The frontier is still open, and this round's high-value surfaces are already merged into the map. All
of the following are required before export:

1. `outputs/discovery_backlog.csv` exists and is non-empty, carrying the remaining
   frontier candidates, the mid/low-value derived surfaces, and the recommended
   exploration directions. Four columns are **required** on every row:

   ```
   discovery_candidate_id, introduced_round, frontier_value_score, reason
   ```

   The full column set is `backlog_id, discovery_candidate_id, introduced_round,
   surface_signature, <the six surface fields>, frontier_value_score,
   product_impact_code, evidence_code, reason, exploration_direction`.

   The gate validates **every row against the real round ledgers**, so this file
   cannot be hand-composed:

   - `discovery_candidate_id` must resolve to an actual candidate in an actual
     round ledger.
   - `introduced_round` must be **non-empty** and equal that candidate's ledger
     round. An empty value is invalid and fails — it no longer skips the check.
   - `frontier_value_score` must equal the **recomputed** `V` for that candidate,
     not a remembered or rounded value. A candidate whose `V` cannot be recomputed
     (it was never scored — an `identical_existing` or invalid row) is not a
     legitimate backlog entry and fails closed.
   - `reason` must be non-empty.

   Each cited candidate must also be **genuinely deferred work**, all three of:
   `novelty_status == new`; `value_gate_pass == No`; and its surface signature
   **absent from the final Prompt Map**. An accepted, already-delivered,
   high-value candidate cannot be listed — otherwise a single such row would
   unlock `PASS_WITH_BACKLOG` on its own. The backlog is the record of what was
   *not* delivered.
2. `backlog_count` and `backlog_sha256` in run-state match that file, and
   `backlog_sha256` is non-empty — an empty hash is a failure, not a skip.
3. `human_backlog_delivery_approved = true` — an explicit human approval, not an
   agent inference.
4. The delivery summary and the workbook README state **verbatim**:

> Evidence coverage floor passed. Discovery frontier not fully exhausted within the approved budget. Remaining exploration backlog is attached.

Two degraded conditions cap the outcome, and they are NOT the same:

- `coverage_floor_mode = registry_proxy` caps the run at `PASS_WITH_BACKLOG`
  **permanently**. Human approval enables the degraded mode; it can never
  upgrade the run to a normal `PASS`, and the delivery may never claim a Wilson
  bound at all.
- `reduced_evidence_sources` containing `semrush` caps the run at
  `PASS_WITH_BACKLOG` **permanently**. There is no human-approval upgrade: the
  gate makes a normal `PASS` unreachable, so never present one as available.
  Brand material may never substitute for Semrush.
- `evidence_pool_short_of_n` (fewer eligible evidence rows than
  `coverage_floor_n`) caps the run the same way.

Record the reduced-evidence fact in `delivery_claim_note` alongside the backlog.
Do not invent a third claim sentence for it — the two authorized wordings above
are the only ones.

`CONTINUE` and `FAIL` block delivery outright. Never export on either.

## Claim discipline

Never write, in any deliverable, summary, or chat message, that the map is
"exhaustive", "the complete category", "all possible prompts", or "category
coverage complete". The supported claims are exactly the two wordings above,
plus the paired vocabulary `coverage_floor_passed` / `coverage_floor_failed` and
`frontier_exhausted` / `frontier_open`. Keep these run/delivery statuses out of
the evidence-tier vocabulary (`已验证` / `Reddit已验证/长尾` / `待验证假设`); they
describe the run, not a row's evidence.

## Deliverables

1. Create a master CSV containing all approved Prompts. Retain the internal
   `prompt_id` column in this master CSV (the visible workbook still hides it)
   so the delivery gate can reconcile Prompt IDs, not just row counts, against
   `work/05_prompt_final.csv`.
2. Create an Excel workbook with:
   - README
   - 品类 Prompt
   - one sheet per approved internal demand Topic
3. Use the seven visible delivery columns:
   - Prompt
   - 中文释义
   - 层级
   - 需求主题
   - 购买意图类型
   - 证据来源
   - 证据状态
4. Keep internal demand-cell IDs, purchase stages, raw source IDs, canonical keys, and hypothesis flags in audit files unless the user explicitly asks for them in the workbook.
5. Validate sheet names, row counts, exact duplicates, translations, evidence status, formulas/errors, and correspondence between the master CSV and workbook.
6. Confirm the master CSV, workbook data rows, delivery summary, and latest
   final coverage audit all report the same Prompt count and Prompt IDs.

## Outputs

- outputs/<brand>_<category>_<market>_prompt_map.csv
- outputs/<brand>_<category>_<market>_prompt_map.xlsx
- outputs/delivery_summary.md
- outputs/discovery_backlog.csv (**required** on `PASS_WITH_BACKLOG`; absent on a
  normal `PASS`)

Keep the internal-only fields `surface_origin`, `introduced_round`,
`discovery_candidate_id`, `frontier_value_score`, and `derivation_rule_id` out of
the visible workbook. They may appear in the master CSV and audit files.

Do not claim product-card trigger success without runtime testing data. Never
export an older final file when a newer approved final audit exists.

## Completion gate

Report files, counts, the convergence status and which of the two claim wordings
applies, Coverage Floor `n` / `x` / Wilson upper (or `registry_proxy` with no
bound), frontier state and streak, backlog count when applicable, verification
results, and any remaining audit notes. Wait for explicit human acceptance. Never
silently export a changed or partial delivery structure.

**Stop, don't guess.** If the verifier status, the backlog artifact, or the human
backlog approval is missing, halt and ask — never export on an assumed PASS.

End with the shared HandoffContract, including `CoverageFloor`,
`DiscoveryFrontier`, `ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and
`ProtocolVersion`.
