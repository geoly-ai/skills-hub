# Context Contract

## Required project identity

- `project_id`
- `brand`
- `physical_product_category`
- `country`
- `language`
- `project_root`

Confirm that the category is a physical purchasable product category. If the request spans multiple categories or markets, split it into separate projects.

## Input policy

Normal required inputs are Reddit posts/comments, Semrush keywords, and GEOly MCP access. Brand files are optional. If a required file is missing, unreadable, or inaccessible, pause and ask for the exact minimum input needed. A user may explicitly approve continuing without one source; record the reduced-evidence limitation and never label the result as fully source-complete.

Declare one run mode:

- `cold_start`: no existing Prompt Map is an input. Use this for a first project or Skill acceptance test.
- `revision`: an accepted Prompt Map is supplied as the golden content baseline.

Never place a comparison workbook inside `inputs/` during a `cold_start` run. Keep it in a separate evaluation directory and do not read it until delivery is complete.

## Scope boundary

Shared across a brand:

- Positioning, legal/claim guardrails, product catalog, brand vocabulary.

Maintained per category-market project:

- Competitors, Reddit VOC, Semrush keywords, GEOly Topics, demand master, Prompt Map, audits, and tests.

## Run state

Maintain `state/run_state.json` at **run-state schema `1.3`**. It carries
summaries and ledger hashes only — never embed per-round arrays.

```json
{
  "package_version": "0.7.0",
  "run_state_schema": "1.3",
  "project_id": "",
  "coverage_mode": "geo_full_coverage",

  "convergence_method": "coverage_floor_plus_value_frontier_v1",
  "convergence_profile": "rich",
  "profile_frozen": false,

  "coverage_round": 0,
  "calibration_round": 0,
  "calibration_complete": false,
  "protocol_revision_count": 0,

  "discovery_protocol_id": "",
  "discovery_protocol_sha256": "",
  "canonicalizer_version": "",
  "value_rubric_version": "1.0",
  "materiality_rule_version": "1.0",

  "probe_budget_k": 100,
  "value_accept_threshold": 0.60,
  "value_critical_threshold": 0.85,
  "frontier_count_threshold": 5,
  "frontier_density_threshold": 0.039,
  "frontier_required_streak": 2,
  "frontier_streak": 0,
  "max_round": 6,
  "approved_discovery_budget_rounds": null,
  "min_new_surface_count": 10,

  "last_round_base_map_sha256": "",
  "last_round_base_registry_sha256": "",
  "last_round_candidate_count": 0,
  "last_round_new_surface_count": 0,
  "last_round_exploratory_new_count": 0,
  "last_round_material_accepted_count": 0,
  "last_round_critical_new_count": 0,
  "last_round_value_mass": 0.0,
  "last_round_value_density": 0.0,
  "last_round_probe_degenerate": false,
  "last_round_identical_recheck_complete": false,
  "last_round_frontier_passed": false,
  "last_round_ledger_sha256": "",

  "coverage_floor_mode": "evidence_sample",
  "coverage_floor_batch_id": "",
  "coverage_floor_eligible_count": 0,
  "coverage_floor_uncovered_count": 0,
  "coverage_floor_rate": 0.0,
  "coverage_floor_wilson_upper": 1.0,
  "coverage_floor_passed": false,
  "coverage_floor_ledger_sha256": "",

  "high_priority_uncovered_count": 0,
  "unresolved_query_surface_gap_count": 0,
  "unresolved_intersection_gap_count": 0,
  "template_detected_count": 0,
  "template_resolved_count": 0,
  "template_review_count": 0,
  "hard_validator_failure_count": 0,

  "unresolved_degenerate_rounds": [],

  "frontier_exhausted": false,
  "backlog_count": 0,
  "backlog_sha256": "",
  "human_backlog_delivery_approved": false,

  "reduced_evidence_sources": [],
  "hypothesis_quarantined": true,

  "convergence_status": "CONTINUE",
  "delivery_status": "BLOCKED",

  "artifact_hashes": {},
  "approved_steps": [],
  "stale_steps": [],
  "blockers": [],
  "updated_at": ""
}
```

Convergence is **two-gated**: Gate A (`coverage_floor_*`) is a statistical recall
floor and Gate B (`frontier_*`) is a marginal-value stopping rule. See
`coverage-loop.md`, `coverage-floor-sampling.md`, and `discovery-protocol.md`.
The final gate **recomputes** every rate, score, and boolean from ledgers and
never trusts the values stored here.

### Round counting: active vs calibration

`coverage_round` counts **active** rounds; `calibration_round` counts
**calibration** rounds. They are separate counters and are never added together.
Each round's `00_round_manifest.json` declares its
`round_kind: "calibration" | "active"` — never infer a round's kind or index from
its directory number.

Do not hand-maintain these two counters. `--emit-run-state-patch` derives both
from the rounds' `round_kind` values and emits them directly; earlier it emitted
only a directory number, which then had to be corrected by hand — exactly the
inference this rule forbids.

Calibration rounds do not consume the `max_round` budget and do not participate
in `frontier_streak`, which accumulates across active rounds only. Calibration is
**exactly 3 rounds**, a contiguous prefix starting at `r01`, and
`calibration_complete` must be `true` before the first active round. A `false`
flag with active rounds on disk, or `true` with fewer than 3 calibration rounds,
is an integrity failure.

### `approved_discovery_budget_rounds`

An optional discovery budget, default `null`. It is frozen together with the
convergence profile and is part of the protocol fingerprint. Changing it mid-run
does **not** merely zero the streak: every historical round manifest is
re-checked against the current value, so a change turns every earlier round into
an **integrity failure** until those rounds are re-run. Plan it as a restart —
this is what stops a mid-run budget edit from silently unlocking
`PASS_WITH_BACKLOG`. See "Protocol changes and the streak" in `coverage-loop.md`.

When it is non-null and the active round count has reached it, the budget
condition for backlog delivery is satisfied — **equivalently to**
`coverage_round >= max_round`. Either path can support `PASS_WITH_BACKLOG`; both
still require the floor to have passed, hard blockers at zero, a valid backlog
artifact, and explicit human approval. See `coverage-loop.md`.

### Anti-degenerate probe fields

`min_new_surface_count` is a profile constant (`max(5, ceil(0.10 * K))` — rich
10, narrow 5) and is part of the protocol fingerprint. The counter compared
against it is **`exploratory_new_count`**: candidates that are signature-new AND
carry `support_mode ∈ {direct, derived}` AND cite at least one `evidence_refs`
entry resolving in the frozen evidence index. A round below the floor sets
`probe_degenerate = true`, which bars it from the frontier gate and the streak
and raises a hard blocker.

`last_round_new_surface_count` is **diagnostic only** — it is not the criterion.
An evidenced new surface that fails the value gate still counts toward the floor
(that is what genuine saturation looks like); a `hypothesis` row does not. See
`discovery-protocol.md` for why this is orthogonal to `C`/`H`/`D`, and for the
gate's stated enforcement limits.

`last_round_probe_degenerate` and `last_round_identical_recheck_complete` carry
the last round's verdicts. Both are recomputed by the gate.

`unresolved_degenerate_rounds` lists every degenerate round that still lacks a
landed disposition, as round IDs (`["r03", ...]`). A degenerate round is a
**standing obligation across the whole run**, not an alert that expires once
later rounds push it out of the streak window; each needs
`10_probe_degenerate_disposition.json` before delivery. The gate cross-checks
this list against the rounds on disk, so emptying it without disposing the rounds
is an integrity failure. See `discovery-protocol.md`.

### Template resolution counts

`template_detected_count`, `template_resolved_count`, and
`template_review_count` are not free-standing tallies. The gate derives
`template_review_count = template_detected_count - template_resolved_count` from
**`state/template_resolutions.json`**.

That file holds a **list of resolution objects**, not a list of keys — a bare key
list now resolves nothing, because copying the current finding keys was itself
the exploit:

```json
[
  {
    "key": "<finding key from validate_prompt_surface_quality>",
    "resolution_type": "rewritten | merged | human_waived",
    "reason": "<non-empty>",
    "approval_ref": "<required only when resolution_type = human_waived>"
  }
]
```

An entry counts only when `key` is non-empty, `resolution_type` is in the enum,
and `reason` is non-empty; `human_waived` additionally requires a non-empty
`approval_ref`. Entries failing any of these are reported as resolution problems
and leave their finding unresolved.

**Editing verdicts are falsifiable claims.** Structural validity alone was not
enough: copying every open finding key and stamping each `rewritten` marked the
whole backlog resolved without changing a word. So the ledger is applied and the
detector is **re-run against the current map**:

- `rewritten` and `merged` assert *"the text changed, so this no longer fires"*.
  If the detector still fires that finding, the claim is **false** and the
  resolution is rejected.
- `human_waived` asserts *"this frame is deliberate"*. It is the only type that
  may excuse a finding that still fires, and it must carry an `approval_ref`.

So a REVIEW is resolved either by actually changing the text, or by a named human
accepting it — never by asserting it away.

### Frozen protocol artifacts

Two files must exist and stay unmodified once frozen:

- `state/convergence_profile.json` — the profile constants, `profile_frozen`,
  `approved_discovery_budget_rounds`, and `discovery_protocol_sha256`.
- `state/discovery_protocol.json` — the seven probe family templates, with their
  allowed derivation rules, prohibitions, and evidence requirements.
  `discovery_protocol_sha256` must equal this file's **actual** sha256; both
  `prepare-round` and `verify` enforce it, so a post-freeze edit or deletion is
  caught. Schema in `discovery-protocol.md`.

### Removed from schema `1.2`

These schema-`1.2` fields are removed: `evidence_manifest_id`,
`evidence_coverage`, `blind_reaudit_clean` — all removed;
`blind_reaudit_manifest_id` and `last_round_acceptance_rate` are removed. The
frozen-evidence-manifest / blind-re-audit convergence model is retired, and a
free-brainstorm acceptance rate is never a stopping condition, so it is no
longer recorded as one. `last_round_accepted_new_surface_count` is superseded by
`last_round_new_surface_count` and `last_round_material_accepted_count`.

`convergence_streak` is also removed. Retain it **only** if a `minimal_dedup`
back-compat path genuinely requires it; if retained, it applies to
`minimal_dedup` alone and has no role in `geo_full_coverage` convergence.

Declare `coverage_mode` once (`geo_full_coverage` default, or `minimal_dedup`
legacy) — see `geo-coverage-mode.md`. A `revision` run inherits the accepted
map's mode unless a human approves migration. The mode is echoed in every audit
artifact and validator call.

Recompute input hashes before consuming a handoff. If an upstream file changed, mark all dependent downstream steps stale. Preserve prior files, but never treat stale output as approved truth.

## Golden output contract

In `revision` mode, when a project already has an accepted first-version Prompt Map, preserve it as the golden output contract:

- Keep its category-versus-Topic split.
- Keep its internal demand Topics and sheet names.
- Keep its natural Prompt style.
- Keep its delivery columns unless the user explicitly approves a schema change.

New coverage fields such as demand cells, purchase stages, and audit links belong in internal work files. They must not silently replace the accepted delivery format.

In `cold_start` mode, use these points as a reusable design contract only. Do not import Prompt rows from another project or from an evaluation baseline.

## Approval gate

Every module ends with a summary and waits for one of:

- `通过` or `继续`: approve and advance.
- `修改`: pause for edits.
- `重跑 <module>`: rerun that module and invalidate its consumers.
- `停止`: preserve state and stop.
