#!/usr/bin/env python3
"""Validate the Prompt Map coverage contract.

Two modes (see references/geo-coverage-mode.md):

  --coverage-mode geo_full_coverage  (default)
      Distinctness is by canonical QUERY SURFACE, not product shortlist. Fails on
      exact-text duplicates and identical canonical surface signatures; flags
      same-surface near-duplicates for REVIEW; generic/empty shortlist_delta is a
      warning. Requires the six surface fields on every row.

  --coverage-mode minimal_dedup  (legacy 0.4.x)
      Distinctness is by product shortlist. Requires selection_change_test=different
      and a non-generic shortlist_delta; a shortlist_delta reused within one demand
      cell/task fails.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _surface import SURFACE_FIELDS, canon, signature, is_blank, is_neutral  # noqa: E402

REQUIRED_MIN = {"prompt_id", "prompt_en", "level", "selection_change_test", "shortlist_delta"}
# v0.7.0 internal (non-delivery) columns. They may appear on any row; they are
# NOT part of the canonical surface signature, so their presence must never
# change a distinctness verdict or trigger a false duplicate/missing-field call.
INTERNAL_FIELDS = ("surface_origin", "introduced_round", "discovery_candidate_id",
                   "frontier_value_score", "derivation_rule_id", "product_impact_code")
# P1/P0 mean "no product-decision difference" (P <= 0.30) and can never clear the
# materiality gate (P >= 0.60). A retained Prompt carrying one is a contradiction.
SURFACE_ORIGINS = {"baseline", "discovery"}
NON_DIFFERENTIATING_IMPACT = {"P1_EMPHASIS_ONLY", "P0_NO_CHANGE"}
VALID_IMPACT = {"P4_ELIGIBILITY_GATE", "P3_PRIMARY_RANKING", "P2_SECONDARY_TRADEOFF",
                *NON_DIFFERENTIATING_IMPACT}
GENERIC_DELTA = {"different intent", "topic angle", "different angle", "better fit",
                 "same need", "different", "n/a", ""}
PARENTHETICAL_TOPIC = re.compile(r"\s+\(with a focus on .+\)\s*$", re.I)


def norm(value: str) -> str:
    return " ".join(str(value or "").lower().split())


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def validate_geo(rows: list[dict[str, str]]) -> tuple[list[str], list[str], dict]:
    failures: list[str] = []
    warnings: list[str] = []
    if not rows:
        return ["prompt file is empty"], [], {}
    missing_cols = [c for c in SURFACE_FIELDS if c not in rows[0]]
    if missing_cols:
        return [f"geo_full_coverage requires surface fields: {', '.join(missing_cols)}"], [], {}
    if "product_card_eligible" not in rows[0]:
        return ["geo_full_coverage requires a product_card_eligible column"], [], {}

    seen_text: dict[str, str] = {}
    seen_surface: dict[tuple, str] = {}
    by_prefix: defaultdict[tuple, list[tuple[str, str]]] = defaultdict(list)
    for row in rows:
        pid = row.get("prompt_id", "<unnamed>")
        if row.get("product_card_eligible", "").strip().lower() not in ("yes", "true"):
            failures.append(f"{pid}: not product_card_eligible")
        blank = [f for f in SURFACE_FIELDS if is_blank(row.get(f))]
        if blank:
            failures.append(f"{pid}: empty surface fields (no null-faking): {', '.join(blank)}")
        if is_neutral("decision_criterion", row.get("decision_criterion")):
            failures.append(f"{pid}: decision_criterion is neutral/empty — a surface needs a concrete criterion")
        change = norm(row.get("selection_change_test"))
        if change not in ("different", "surface_distinct"):
            failures.append(f"{pid}: selection_change_test must be surface_distinct or different, got {change or '<blank>'}")
        if norm(row.get("shortlist_delta")) in GENERIC_DELTA:
            warnings.append(f"{pid}: shortlist_delta is missing or generic (warning in geo mode)")
        if row.get("level", "").strip().lower() == "topic":
            if not norm(row.get("topic_delta")):
                failures.append(f"{pid}: Topic row has no topic_delta")
            if PARENTHETICAL_TOPIC.search(row.get("prompt_en", "")):
                failures.append(f"{pid}: Topic Prompt uses a parenthetical focus suffix")

        text = norm(row.get("prompt_en", ""))
        if text and text in seen_text:
            failures.append(f"{pid}: exact normalized Prompt duplicate of {seen_text[text]}")
        elif text:
            seen_text[text] = pid

        # Internal v0.7.0 provenance fields: validated for consistency, never
        # folded into the signature (see INTERNAL_FIELDS).
        origin = str(row.get("surface_origin", "")).strip().lower()
        if origin and origin not in SURFACE_ORIGINS:
            failures.append(f"{pid}: surface_origin must be baseline or discovery, got {origin!r}")
        if origin == "discovery" and not str(row.get("introduced_round", "")).strip():
            failures.append(f"{pid}: surface_origin=discovery requires an introduced_round")
        impact = str(row.get("product_impact_code", "")).strip().upper()
        if impact:
            if impact not in VALID_IMPACT:
                failures.append(f"{pid}: product_impact_code {impact!r} is not a valid P code")
            elif impact in NON_DIFFERENTIATING_IMPACT:
                failures.append(
                    f"{pid}: product_impact_code={impact} implies P<=0.30, which cannot pass the "
                    "materiality gate (P>=0.60) — a retained Prompt may not be emphasis-only")
        fvs = str(row.get("frontier_value_score", "")).strip()
        if fvs:
            try:
                score = float(fvs)
            except ValueError:
                failures.append(f"{pid}: frontier_value_score is not a number: {fvs!r}")
            else:
                if not 0.0 <= score <= 1.0:
                    failures.append(f"{pid}: frontier_value_score {score} outside [0, 1]")
                elif impact in NON_DIFFERENTIATING_IMPACT and score >= 0.60:
                    failures.append(f"{pid}: frontier_value_score {score} >= V_accept but "
                                    f"product_impact_code={impact} (inconsistent P)")

        sig = signature(row)  # six base fields + present conditional dimensions
        if sig in seen_surface:
            failures.append(f"{pid}: identical query-surface signature as {seen_surface[sig]} — merge (true duplicate)")
        else:
            seen_surface[sig] = pid
        by_prefix[sig[:5]].append((pid, canon("decision_criterion", row.get("decision_criterion"))))

    for _, items in by_prefix.items():
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, b = set(items[i][1].split()), set(items[j][1].split())
                if a and b and items[i][1] != items[j][1] and len(a & b) / len(a | b) >= 0.8:
                    warnings.append(f"REVIEW near-duplicate surface: {items[i][0]} ~ {items[j][0]}")

    internal_present = sorted(f for f in INTERNAL_FIELDS if f in rows[0])
    return failures, warnings, {"prompts": len(rows), "distinct_surfaces": len(seen_surface),
                                "internal_fields_present": internal_present,
                                "internal_fields_in_signature": False}


def validate_minimal(rows: list[dict[str, str]]) -> tuple[list[str], list[str], dict]:
    failures: list[str] = []
    warnings: list[str] = []
    if not rows:
        return ["prompt file is empty"], [], {}
    missing = sorted(REQUIRED_MIN - set(rows[0]))
    if missing:
        failures.append("missing required shortlist fields: " + ", ".join(missing))
    if "demand_cell_id" not in rows[0]:
        warnings.append("no demand_cell_id column: duplicate-delta detection may over-report distinct cells")
    seen_text: dict[str, str] = {}
    by_task: defaultdict[tuple, list[str]] = defaultdict(list)
    for row in rows:
        pid = row.get("prompt_id", "<unnamed>")
        change = norm(row.get("selection_change_test"))
        delta = norm(row.get("shortlist_delta"))
        if change != "different":
            failures.append(f"{pid}: selection_change_test must be different, got {change or '<blank>'}")
        if delta in GENERIC_DELTA:
            failures.append(f"{pid}: shortlist_delta is missing or generic")
        text = norm(row.get("prompt_en", ""))
        if text in seen_text:
            failures.append(f"{pid}: exact normalized Prompt duplicate of {seen_text[text]}")
        elif text:
            seen_text[text] = pid
        if row.get("level", "").strip().lower() == "topic":
            if not norm(row.get("topic_delta")):
                failures.append(f"{pid}: Topic row has no topic_delta")
            if PARENTHETICAL_TOPIC.search(row.get("prompt_en", "")):
                failures.append(f"{pid}: Topic Prompt uses a parenthetical focus suffix")
        key = (row.get("level", "").strip(), row.get("topic", "").strip(),
               row.get("demand_theme_key", "").strip(), row.get("demand_cell_id", "").strip(), delta)
        if delta:
            by_task[key].append(pid)
    for _, ids in by_task.items():
        if len(ids) > 1:
            failures.append("same shortlist_delta reused within one demand cell/task by rows: " + ", ".join(ids))
    return failures, warnings, {"prompt_count": len(rows)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompts", required=True, type=Path)
    parser.add_argument("--coverage-mode", default="geo_full_coverage",
                        choices=("geo_full_coverage", "minimal_dedup"))
    args = parser.parse_args()
    try:
        rows = read_rows(args.prompts)
    except (OSError, csv.Error) as exc:
        print(json.dumps({"status": "FAIL", "failures": [f"read error: {exc}"]}))
        return 2
    if args.coverage_mode == "geo_full_coverage":
        failures, warnings, evidence = validate_geo(rows)
    else:
        failures, warnings, evidence = validate_minimal(rows)
    result = {"status": "PASS" if not failures else "FAIL", "coverage_mode": args.coverage_mode,
              "prompt_count": len(rows), "failure_count": len(failures), "warning_count": len(warnings),
              "evidence": evidence, "failures": failures, "warnings": warnings}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not failures else 2


if __name__ == "__main__":
    sys.exit(main())
