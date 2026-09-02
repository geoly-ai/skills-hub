# Version Manifest

- Package: `product-card-prompt-map-skill-suite`
- Version: `0.7.0`
- Updated: `2026-07-27`
- Installable Skills: `9`
- Demand schema: `1.2`
- Prompt schema: `1.2`
- Handoff schema: `1.0`
- Run-state schema: `1.3`

Demand, Prompt, and Handoff schemas gained **additive** fields in `0.7.0` (the
Evidence Index schema, the five internal discovery fields, and the six
convergence handoff fields). No existing field changed meaning or type, so their
schema numbers are unchanged. Run-state moved to `1.3` because fields were
removed — see `context-contract.md`.

## References added in `0.7.0`

- `discovery-protocol.md` — two-stage discovery ledger, probe family portfolio,
  frontier arithmetic and worked examples, round directory and ordering.
- `value-rubric.md` — the `V` score, the hard materiality gate, and the E/D/P/T
  component tables.
- `coverage-floor-sampling.md` — Gate A sampling, the Wilson bound, the
  two-batch miss procedure, and the `registry_proxy` degraded mode.

`coverage-loop.md` was fully rewritten for the two-stream, two-gate convergence
model (`convergence_method = "coverage_floor_plus_value_frontier_v1"`). The
`0.6.1` frozen-evidence-manifest and blind-re-audit model is retired.
