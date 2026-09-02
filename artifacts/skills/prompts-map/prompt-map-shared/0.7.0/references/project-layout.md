# Project Layout

```text
project/
├── project.json
├── inputs/
│   ├── reddit/
│   ├── semrush/
│   ├── geoly/
│   └── brand/
├── work/
│   ├── 01_input_manifest.json
│   ├── 01_normalized/
│   ├── 01_summary.md
│   ├── 02_demand_master.csv
│   ├── 02_evidence_index.csv
│   ├── 02_summary.md
│   ├── 02b_coverage_registry.csv
│   ├── 02b_prompt_cell_links.csv
│   ├── 02b_topic_routing.csv
│   ├── 02b_surface_inventory.csv        # GEO: INITIAL coverage baseline, NOT a discovery ceiling
│   ├── 02b_angle_inventory.csv          # GEO: decision-angle inventory
│   ├── 02b_topic_intersections.csv      # GEO: approved high-value Topic intersections
│   ├── 02b_summary.md
│   ├── 03_prompt_draft.csv
│   ├── 03_category_prompts.csv
│   ├── 03_topic_prompts.csv
│   ├── 03_route_angle_inventory.csv
│   ├── 03_prompt_angle_links.csv
│   ├── 03_candidate_surface_ledger.csv  # GEO: candidate→surface accept/merge/reject ledger
│   ├── 03_prompt_supplement.csv
│   ├── 03_summary.md
│   ├── 04_coverage_audit.csv
│   ├── 04_decision_angle_audit.csv
│   ├── 04_decision_angle_summary.md
│   ├── 04_gap_queue.csv
│   ├── 04_summary.md
│   ├── 05_prompt_registry.csv
│   ├── 05_dedupe_report.csv
│   ├── 05_prompt_final.csv
│   ├── 05_prompt_angle_links.csv        # angle links carried forward post-dedupe
│   ├── 05_candidate_surface_ledger.csv  # GEO: ledger carried forward post-dedupe
│   ├── 05_surface_quality_report.json   # GEO: validate_prompt_surface_quality --strict output
│   ├── 05_final_coverage_audit.csv
│   ├── 05_final_coverage_summary.md
│   ├── 05_summary.md
│   ├── coverage_rounds/                 # per-round discovery dirs, rNN/ (see discovery-protocol.md)
│   └── coverage_floor/                  # Coverage Floor batch ledgers (see coverage-floor-sampling.md)
├── outputs/
│   ├── prompt_map.xlsx
│   ├── prompt_map.csv
│   ├── discovery_backlog.csv            # required artifact for PASS_WITH_BACKLOG
│   └── delivery_summary.md
└── state/
    ├── run_state.json
    ├── convergence_profile.json         # frozen profile + protocol hashes
    ├── discovery_protocol.json          # frozen probe family templates; pinned by sha256
    └── template_resolutions.json        # resolution OBJECTS for template REVIEW findings
```

Each `work/coverage_rounds/rNN/` directory holds the frozen baseline snapshots,
the round manifest, the two-stage discovery ledger, accepted surfaces, round
Prompts, round registry, round audit, and round summary — plus the required
`09_identical_recheck.csv`, the conditionally required
`10_probe_degenerate_disposition.json` (mandatory for any round flagged
`probe_degenerate`, and it does not expire), and the optional
`06_closure_additions.csv` and `06_waivers.csv`. See `discovery-protocol.md` for
the full file list and the ordering that makes a round non-self-certifying.

`outputs/discovery_backlog.csv` requires at least these columns:

```
discovery_candidate_id, introduced_round, frontier_value_score, reason
```

Every row must trace to a real ledger candidate; the gate rejects a backlog whose
rows do not resolve.

`work/02b_surface_inventory.csv` is the **initial coverage baseline**, not a
discovery ceiling. The living registry extends it through verified discovery
rounds — see `geo-coverage-mode.md`.

Never overwrite user source files. New versions of an approved artifact should preserve the prior file or carry a run/version suffix. Round directories and floor batch ledgers are append-only: never rewrite `rNN/` after it has been promoted, and never repair a floor batch in place.
