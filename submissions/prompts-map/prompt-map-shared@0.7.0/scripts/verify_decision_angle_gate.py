#!/usr/bin/env python3
"""Block final Prompt Map audit or delivery until decision-angle closure is proven.

Usage:
    python verify_decision_angle_gate.py --project-root /path/to/project --stage delivery

The validator intentionally accepts both the current file names and the earlier
angle-expansion names so existing projects can adopt the guardrail without a
forced migration. It fails closed: any unexpected error is reported as FAIL, not
a crash, and it exits non-zero with a concise list of missing evidence.

This gate verifies the audit SUMMARY (closure counts, freshness, reconciliation)
against the declared `coverage_mode`; per-row surface canonicalization is done by
validate_shortlist_difference.py / validate_generation_integrity.py, which share
scripts/_surface.py.

In `geo_full_coverage` all convergence logic lives in
verify_coverage_convergence.py (Coverage Floor + Value Frontier Exhaustion,
`coverage_floor_plus_value_frontier_v1`). This gate CALLS `vcc.run()` and merges
its status/failures — it must never re-implement recall, frontier or Wilson
logic. Everything else here (decision-angle audit, freshness, stale steps,
prompt IDs, delivery reconciliation) is unchanged.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


ANGLE_AUDIT_NAMES = ("04_decision_angle_audit.csv", "04_angle_expansion_audit.csv")
FINAL_AUDIT_GLOBS = ("05_final_coverage_audit.csv", "05_final_coverage_audit_v*.csv")
ANGLE_STEP_NAMES = {"decision_angle_expansion", "decision-angle-expansion"}
COUNT_FIELDS = ("delivered_prompt_count", "final_prompt_count", "prompt_count")
PROMPT_TEXT_FIELDS = ("prompt_en", "Prompt", "prompt")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def latest_match(work_dir: Path, patterns: tuple[str, ...]) -> Path | None:
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(work_dir.glob(pattern))
    return max(candidates, key=lambda item: item.stat().st_mtime) if candidates else None


def is_zero(value: str | None) -> bool:
    try:
        return int(str(value or "").strip()) == 0
    except ValueError:
        return False


def prompt_text(row: dict[str, str]) -> str:
    for field in PROMPT_TEXT_FIELDS:
        if row.get(field):
            return " ".join(row[field].lower().split())
    return ""


def has_id(rows: list[dict[str, str]]) -> bool:
    return bool(rows) and "prompt_id" in rows[0]


def reconcile_delivery(project_root: Path, final_prompts: Path, final_audit: Path | None,
                       failures: list[str], evidence: dict[str, object]) -> None:
    certified = read_csv(final_prompts)
    evidence["certified_count"] = len(certified)
    masters = sorted((project_root / "outputs").glob("*_prompt_map.csv"))
    if len(masters) != 1:
        failures.append(f"expected exactly one outputs/*_prompt_map.csv, found {len(masters)}")
        return
    delivered = read_csv(masters[0])
    evidence["delivery_master"] = str(masters[0])
    evidence["delivered_count"] = len(delivered)
    if len(certified) != len(delivered):
        failures.append(f"delivered prompt count {len(delivered)} != certified count {len(certified)}")

    cert_has, del_has = has_id(certified), has_id(delivered)
    if cert_has != del_has:
        failures.append("prompt_id column present in only one of the certified/delivered files")
    elif cert_has and del_has:
        cert_map = {r.get("prompt_id", "").strip(): prompt_text(r) for r in certified}
        del_map = {r.get("prompt_id", "").strip(): prompt_text(r) for r in delivered}
        missing_ids = sorted(set(cert_map) - set(del_map))
        extra_ids = sorted(set(del_map) - set(cert_map))
        if missing_ids:
            failures.append("delivered master is missing certified prompt_ids: " + ", ".join(missing_ids))
        if extra_ids:
            failures.append("delivered master has prompt_ids not in the certified set: " + ", ".join(extra_ids))
        drifted = sorted(pid for pid in set(cert_map) & set(del_map)
                         if cert_map[pid] and del_map[pid] and cert_map[pid] != del_map[pid])
        if drifted:
            failures.append("delivered Prompt text differs from certified for prompt_ids: " + ", ".join(drifted))
    else:
        # No prompt_id anywhere: fall back to a normalized Prompt-text multiset,
        # but only if both files actually expose a Prompt-text column.
        cert_col = any(f in certified[0] for f in PROMPT_TEXT_FIELDS) if certified else False
        del_col = any(f in delivered[0] for f in PROMPT_TEXT_FIELDS) if delivered else False
        if not (cert_col and del_col):
            failures.append("cannot reconcile delivery: no prompt_id and no Prompt-text column in both files")
            return
        evidence["id_reconciliation"] = "text-multiset (no prompt_id column)"
        cert_texts = Counter(prompt_text(r) for r in certified)
        del_texts = Counter(prompt_text(r) for r in delivered)
        if cert_texts != del_texts:
            only_cert = sorted((cert_texts - del_texts).elements())
            only_del = sorted((del_texts - cert_texts).elements())
            if only_cert:
                failures.append("certified Prompts absent from delivered master: " + "; ".join(only_cert))
            if only_del:
                failures.append("delivered Prompts absent from certified set: " + "; ".join(only_del))

    if final_audit is not None:
        audit_rows = read_csv(final_audit)
        row = audit_rows[0] if audit_rows else {}
        seen: dict[str, int] = {}
        for field in COUNT_FIELDS:
            val = row.get(field)
            if val is None or not str(val).strip():
                continue
            try:
                reported = int(str(val).strip())
            except ValueError:
                failures.append(f"final audit {field} is not an integer: {val!r}")
                continue
            seen[field] = reported
            if reported != len(certified):
                failures.append(f"final audit {field}={reported} but certified set has {len(certified)}")
        if len(set(seen.values())) > 1:
            failures.append(f"final audit count fields disagree: {seen}")
        if seen:
            evidence["audit_reported_counts"] = seen


def _check_geo_convergence(state: dict, project_root: Path, stage: str,
                           failures: list[str], evidence: dict[str, object]) -> str:
    """Delegate convergence entirely to verify_coverage_convergence.run().

    v0.7.0 replaced the frozen-evidence-manifest / evidence_coverage /
    blind_reaudit contract with Coverage Floor + Value Frontier Exhaustion.
    That logic has exactly one implementation; this gate calls it and merges
    the result, then continues with its own freshness / prompt-ID / delivery
    reconciliation checks. Do not re-implement any of it here.
    """
    try:
        import verify_coverage_convergence as vcc  # noqa: WPS433
    except ImportError as exc:  # pragma: no cover - packaging error
        failures.append(f"geo: verify_coverage_convergence.py is not importable: {exc}")
        evidence["geo_convergence"] = {"status": "FAIL"}
        return "FAIL"

    try:
        status, conv_failures, conv_evidence = vcc.run(project_root, stage)
    except vcc.ConvergenceError as exc:
        status, conv_failures, conv_evidence = "FAIL", [f"geo: {exc}"], {}
    except (OSError, csv.Error, json.JSONDecodeError, ValueError, KeyError, TypeError) as exc:
        status, conv_failures, conv_evidence = "FAIL", [f"geo: convergence engine error: {exc}"], {}

    evidence["convergence_status"] = status
    evidence["geo_convergence"] = conv_evidence
    failures.extend(f"geo: {msg}" for msg in conv_failures)
    if status not in ("PASS", "PASS_WITH_BACKLOG"):
        failures.append(f"geo: convergence_status={status} (needs PASS or PASS_WITH_BACKLOG)")
    return status


def run(args: argparse.Namespace) -> tuple[list[str], dict[str, object]]:
    project_root = args.project_root.resolve()
    work_dir = project_root / "work"
    state_path = project_root / "state" / "run_state.json"
    failures: list[str] = []
    evidence: dict[str, object] = {"project_root": str(project_root), "stage": args.stage}

    coverage_mode = "geo_full_coverage"
    if not state_path.is_file():
        failures.append("state/run_state.json is missing")
    else:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        coverage_mode = str(state.get("coverage_mode", "geo_full_coverage"))
        if coverage_mode not in ("geo_full_coverage", "minimal_dedup"):
            failures.append(f"invalid coverage_mode in run_state: {coverage_mode!r}")
            coverage_mode = "geo_full_coverage"  # fail-safe to the stricter surface closure
        evidence["coverage_mode"] = coverage_mode
        approved_steps = set(state.get("approved_steps", []))
        evidence["approved_steps"] = sorted(approved_steps)
        if not approved_steps.intersection(ANGLE_STEP_NAMES):
            failures.append("decision-angle expansion is not recorded as an approved step")
        stale_steps = [s for s in state.get("stale_steps", []) if s]
        evidence["stale_steps"] = stale_steps
        if stale_steps:
            failures.append("run state has stale steps that must be rerun: " + ", ".join(stale_steps))

        if coverage_mode == "geo_full_coverage":
            _check_geo_convergence(state, project_root, args.stage, failures, evidence)

    angle_audit = next((work_dir / name for name in ANGLE_AUDIT_NAMES if (work_dir / name).is_file()), None)
    if angle_audit is None:
        failures.append("decision-angle audit file is missing")
    else:
        angle_rows = read_csv(angle_audit)
        evidence["decision_angle_audit"] = str(angle_audit)
        evidence["decision_angle_audit_rows"] = len(angle_rows)
        if not angle_rows:
            failures.append("decision-angle audit file has no rows")

    final_audit = latest_match(work_dir, FINAL_AUDIT_GLOBS)
    if final_audit is None:
        failures.append("final coverage audit file is missing")
    else:
        final_rows = read_csv(final_audit)
        evidence["final_audit"] = str(final_audit)
        if len(final_rows) != 1:
            failures.append("final coverage audit must contain exactly one summary row")
        else:
            row = final_rows[0]
            if row.get("final_status", "").strip().upper() != "PASS":
                failures.append("final coverage audit status is not PASS")
            if "unresolved_decision_angle_gap_count" not in row:
                failures.append("final coverage audit does not report unresolved decision-angle gaps")
            elif not is_zero(row.get("unresolved_decision_angle_gap_count")):
                failures.append("unresolved decision-angle gaps remain")
            if coverage_mode == "geo_full_coverage":
                if "unresolved_query_surface_gap_count" not in row:
                    failures.append("geo: final audit does not report unresolved_query_surface_gap_count")
                elif not is_zero(row.get("unresolved_query_surface_gap_count")):
                    failures.append("geo: unresolved query-surface gaps remain")
                if "unresolved_intersection_gap_count" not in row:
                    failures.append("geo: final audit does not report unresolved_intersection_gap_count")
                elif not is_zero(row.get("unresolved_intersection_gap_count")):
                    failures.append("geo: unresolved Topic-intersection gaps remain")

    gap_queue = work_dir / "04_gap_queue.csv"
    if gap_queue.is_file():
        unresolved_gap_ids: list[str] = []
        for row in read_csv(gap_queue):
            action = row.get("proposed_action", "").strip().upper()
            waived = row.get("human_decision", "").strip().upper() == "WAIVE"
            resolved = bool(row.get("resolution_prompt_ids", "").strip())
            if action in {"SUPPLEMENT", "REWRITE"} and not waived and not resolved:
                unresolved_gap_ids.append(row.get("gap_id", "<unnamed>"))
        evidence["gap_queue"] = str(gap_queue)
        evidence["unresolved_gap_ids"] = unresolved_gap_ids
        if unresolved_gap_ids:
            failures.append("gap queue has unresolved supplements or rewrites: " + ", ".join(unresolved_gap_ids))
    else:
        failures.append("04_gap_queue.csv is missing")

    # The certified prompt set is required from final-audit onward.
    final_prompts = work_dir / "05_prompt_final.csv"
    if not final_prompts.is_file():
        failures.append("work/05_prompt_final.csv is missing")
    elif final_audit is not None:
        # Freshness: the certified final audit must not predate the final prompts.
        audit_mtime = final_audit.stat().st_mtime
        prompts_mtime = final_prompts.stat().st_mtime
        evidence["final_audit_newer_than_prompts"] = audit_mtime >= prompts_mtime
        if audit_mtime < prompts_mtime:
            failures.append(
                "final coverage audit is older than work/05_prompt_final.csv "
                "(re-run the final audit against the current prompts)"
            )

    if args.stage == "delivery" and final_prompts.is_file():
        reconcile_delivery(project_root, final_prompts, final_audit, failures, evidence)

    return failures, evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("--stage", required=True, choices=("final-audit", "delivery"))
    args = parser.parse_args()

    try:
        failures, evidence = run(args)
    except (OSError, csv.Error, json.JSONDecodeError, ValueError, TypeError, AttributeError) as exc:
        result = {"status": "FAIL", "evidence": {"stage": args.stage}, "failures": [f"gate error: {exc}"]}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2

    result = {"status": "PASS" if not failures else "FAIL", "evidence": evidence, "failures": failures}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not failures else 2


if __name__ == "__main__":
    sys.exit(main())
