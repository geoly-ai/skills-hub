---
name: prompt-map-demand-grid
description: Build the initial coverage baseline inside a living demand coverage registry for a cold-start or revision Prompt Map, without turning every theoretical demand cell into a Prompt and without treating the baseline as a discovery ceiling that later rounds may not extend.
---

# Prompt Map Coverage Registry

Read `../prompt-map-shared/SKILL.md` and the relevant references under `../prompt-map-shared/references/` before proceeding (`prompt-map-shared` installs as a sibling skill).

This module is an audit layer. It does not generate Prompt text or replace the approved internal Topic taxonomy and delivery workbook.

In `geo_full_coverage` (default; read `../prompt-map-shared/references/geo-coverage-mode.md`),
build a **rich surface grid**: (1) decompose demand into 12–16 internal Topics
for a data-rich category along body-part / attribute / audience / pain / scenario
/ access axes without collapsing them; (2) inventory the evidence-supported
decision-angle subset per Topic; (3) create one audit cell per canonical query
surface (audience × body-part × attribute × scenario × decision-angle ×
decision-criterion); (4) enumerate evidence-backed high-value Topic intersections
(e.g. dark-skin × brazilian) as their own cells. A cell is an audit unit; the
target is surface-coverage completeness, not a minimal deduped list.

## The registry is a living registry, not a closed inventory

What this module produces is the **initial coverage baseline**: the set of
surfaces already visible from ingested evidence, and the starting obligations for
the Closure Stream. It is explicitly **NOT** the complete surface universe and
**NOT** a ceiling on generation.

- The Closure Stream consumes this baseline. The Discovery Stream is
  **independent of it** and MUST NOT sample, enumerate, or bound its candidates
  from `02b_surface_inventory.csv`, `02b_coverage_registry.csv`,
  `02b_topic_intersections.csv`, or the gap queue.
- Every active round may **append** rows with `surface_origin=discovery`,
  `introduced_round=rNN`, `discovery_candidate_id`, `frontier_value_score`,
  `cell_status=open`, and empty `covered_prompt_ids`. Rows written here carry
  `surface_origin=baseline`.
- A high-value surface discovered outside this baseline **may never be rejected,
  waived, or downgraded merely for being off-inventory.** If it passes
  materiality and the value gate it becomes an obligation like any other.
- "The approved surface inventory is exhausted" is not a stopping condition.
  Closing this baseline satisfies the Closure Stream only; the run ends when the
  verifier closes Gate A (Coverage Floor) and Gate B (Value Frontier Exhaustion),
  or at approved-budget exhaustion via `PASS_WITH_BACKLOG`.
- Sizing this baseline also selects the convergence profile downstream:
  `approved_topics >= 10`, `eligible_demand_themes >= 80`, or
  `initial_surface_inventory >= 180` (any one) selects `rich`; all three below
  those values selects `narrow`; conflict → `rich` wins. Report these three
  counts in the summary so the orchestrator can freeze the profile.

## Inputs

- Approved demand master.
- Run mode. An accepted Prompt base is required only in `revision` mode.
- Evidence index and optional brand evidence.
- Approved internal demand Topic list.

## Procedure

This module builds the **auditable initial query-surface baseline** that the
Closure Stream consumes; it does not write Prompt text and does not bound the
Discovery Stream. In `minimal_dedup`, keep the legacy purchase-task
interpretation.

1. Read `coverage_mode`, run mode, approved demand master, evidence index, and approved internal Topic list. In `revision`, read the accepted Prompt base; in `cold_start`, do not read prior Prompt content.
2. **Topic decomposition.** In `geo_full_coverage`, do not collapse evidence-rich demand into one umbrella Topic. For a data-rich category, propose ~12–16 internal Topics where evidence supports it, splitting by meaningful body/object, audience, attribute/condition, pain, scenario, product format, or purchase concern. Record proposed Topic, rationale, `evidence_refs`, `evidence_status`, and approval status. GEOly Topics are evidence/routing signals, not automatic delivery Topics.
3. **Decision-angle inventory.** Enumerate the evidence-supported subset of the decision-angle grid (recommendation, feature-filter, brand-comparison, results/timeline, budget/value, comfort/pain, scenario-fit, maintenance, risk/concern, ease/adherence, safety-gate, compatibility, retail-availability, insurance/access, first-time, switching, versus-alternative, best-overall, review-driven). Each angle needs evidence and a concrete decision criterion; do not apply every angle to every Topic.
4. **Canonical surface enumeration.** Create the base surface inventory from `audience | body_part_or_object | attribute_or_condition | scenario | decision_angle | decision_criterion`, adding an evidence-backed conditional dimension (`purchase_stage`, `budget_tier`, `product_format_or_compatibility`, `comparison_target_or_alternative`, `result_time_horizon`) only when it changes the ask. Canonicalize all values via the shared `_surface.py`; empty/neutral values must not create fake surfaces.
5. **High-value Topic intersections.** Cross approved Topics with audience/body/attribute/scenario/angle/criterion only where evidence or an explicit approved hypothesis supports the intersection (multi-source, strong Reddit VOC, GEOly/search data, product-card eligible, likely-distinct surface). Do not build the mechanical Cartesian product. Record rejected/unsupported/waived intersections rather than silently omitting them.
6. **Link or mark open.** In `revision`, link accepted Prompt rows to their canonical surfaces and preserve the delivery baseline; in `cold_start`, leave links empty until generation. Mark a surface a gap only when it is product-card eligible and evidence-backed. Classify each surface `Verified` / `Long-tail` / `Hypothesis`; hypotheses need visible approval status and must not read as verified demand.
7. Produce the registry + approval handoff.

## Outputs

- work/02b_coverage_registry.csv — the living registry. Fields include
  `record_type` (`surface` / `angle` / `intersection`), `cell_status`
  (`open` / `covered` / `waived`), `covered_prompt_ids`, `surface_origin`
  (`baseline` here; `discovery` when a round appends), `introduced_round`,
  `discovery_candidate_id`, and `frontier_value_score`.
- work/02b_surface_inventory.csv — the **initial coverage baseline**, not a
  discovery ceiling. Label it as such in the file header comment and the summary.
- work/02b_angle_inventory.csv
- work/02b_topic_intersections.csv
- work/02b_prompt_cell_links.csv
- work/02b_summary.md

The summary must report grouped requirements, internal Topic coverage, evidence
status, hypotheses, and the three profile-selection counts (`approved_topics`,
`eligible_demand_themes`, `initial_surface_inventory`). In `revision`, also report
base Prompt coverage. It must not claim that every theoretical combination
requires a Prompt, and it must state explicitly that the inventory is an initial
baseline that discovery rounds will extend — never that it is the complete set of
surfaces to generate.

**Stop, don't guess.** When required upstream inputs are missing, halt and ask for
evidence rather than invent a surface.

End with the HandoffContract — including `CoverageFloor`, `DiscoveryFrontier`,
`ConvergenceStatus`, `DeliveryStatus`, `BacklogFiles`, and `ProtocolVersion` — and
wait for human approval.

## Blocking rules

Pause when the run mode is missing, a Prompt base is missing in `revision`, the internal Topic list is missing or unapproved, a gap cannot be distinguished from a synonym-only rewrite, or the registry would change the delivery contract without approval. A missing prior Prompt Map is expected in `cold_start`.
