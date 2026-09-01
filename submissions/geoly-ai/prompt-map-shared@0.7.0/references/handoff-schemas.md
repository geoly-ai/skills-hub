# Handoff Schemas

Every module writes a Markdown summary containing:

1. What this step did.
2. Input files read and their hashes.
3. Output files written.
4. Key counts and quality checks.
5. Blockers, assumptions, and items requiring review.
6. The following contract.

```markdown
## HandoffContract
- ProducerSkill:
- ConsumerSkill:
- Project:
- InputFilesRead:
- OutputFilesWritten:
- RequiredFieldsProvided:
- QualityChecks:
- HumanReviewRequired:
- BlockingGaps:
- ReadyForApproval: Yes / No
- ReadyForNextSkill: Yes / No
- IntegrityArtifacts:
- FreshnessCheck:
- CoverageFloor:
- DiscoveryFrontier:
- ConvergenceStatus:
- DeliveryStatus:
- BacklogFiles:
- ProtocolVersion:
```

The six convergence fields carry the two-gate state forward between skills:

- `CoverageFloor` — `passed` / `failed`, the mode (`evidence_sample` or
  `registry_proxy`), batch ID, `n`, misses, and the recomputed Wilson upper
  bound. See `coverage-floor-sampling.md`.
- `DiscoveryFrontier` — `frontier_exhausted` / `frontier_open`, plus the current
  streak against the required streak. See `discovery-protocol.md`.
- `ConvergenceStatus` — `PASS`, `PASS_WITH_BACKLOG`, `CONTINUE`, or `FAIL`.
- `DeliveryStatus` — `BLOCKED` or the approved delivery state.
- `BacklogFiles` — `outputs/discovery_backlog.csv` and its hash; required and
  non-empty whenever `ConvergenceStatus` is `PASS_WITH_BACKLOG`.
- `ProtocolVersion` — `discovery_protocol_id` / `discovery_protocol_sha256`,
  `canonicalizer_version`, `value_rubric_version`, `materiality_rule_version`.

A consumer must treat a handoff whose `ProtocolVersion` differs from its own
frozen protocol as a protocol change, not as a compatible input. See
`status-vocabulary.md` for the status definitions.

For a blocked step:

```markdown
## HandoffContract
- ProducerSkill:
- ConsumerSkill:
- BlockingGaps:
- MinimumUserInputToUnblock:
- ReadyForNextSkill: No
```

`ReadyForNextSkill: Yes` means technically ready, not automatically approved. The orchestrator still waits for explicit human approval.
