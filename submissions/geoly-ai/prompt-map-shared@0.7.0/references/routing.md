# Routing

- Full new project or resume: `prompt-map-orchestrator`.
- Raw file validation/normalization only: `prompt-map-input-normalizer`.
- Rebuild demand themes after source edits: `prompt-map-demand-extractor`.
- Build an internal coverage registry for auditing an approved first-version Prompt Map: `prompt-map-demand-grid`.
- Generate initial prompts or fill an approved gap queue: `prompt-map-generator`.
- Check topic/demand/decision-angle completeness: `prompt-map-coverage-audit`.
- Remove wording duplicates and maintain canonical registry: `prompt-map-semantic-dedupe`.
- Build final workbook after final audit pass: `prompt-map-delivery`.
- Verify convergence (Gate A + Gate B, recomputed from ledgers):
  `verify_coverage_convergence.py`. It is the sole owner of convergence logic;
  `verify_decision_angle_gate.py` calls it rather than reimplementing it. The
  executable interface is owned by the script layer — treat the recomputation
  contract in `coverage-loop.md` as the normative requirement.
- Run a discovery-only round without re-running the full pipeline: the generator
  in **discovery mode** (`prompt-map-generator`), driven by the frozen profile
  and protocol hashes. It produces a complete `work/coverage_rounds/rNN/`
  directory and appends obligations to the living registry; those obligations
  still have to be closed by the Closure Stream before the run can converge. See
  `discovery-protocol.md`.
- Full-flow convergence across rounds, gates, and human approvals stays with
  `prompt-map-orchestrator`.

Use the narrowest module that satisfies the request. A standalone rerun must still read `prompt-map-shared` and update run state. Do not route around a failed approval gate.
