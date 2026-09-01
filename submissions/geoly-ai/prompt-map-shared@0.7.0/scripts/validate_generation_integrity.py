#!/usr/bin/env python3
"""Validate route/angle coverage and optional delivery freshness contracts."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _surface import SURFACE_FIELDS, signature, is_neutral  # noqa: E402


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def fail(messages: list[str]) -> int:
    for message in messages:
        print(f"FAIL: {message}")
    return 1


def validate_closure_rows(path: Path, rejected: set[tuple]) -> tuple[set[tuple], list[str]]:
    """Approved Closure-Stream additions. Delegates to the single implementation."""
    import verify_coverage_convergence as vcc  # noqa: WPS433 (sibling on sys.path)
    rows, failures = vcc.validate_closure_additions(
        path, {"|".join(s) for s in rejected}, "round")
    return {signature(r) for r in rows}, failures


def registry_row_violations(base_rows: list[dict], round_rows: list[dict],
                            waived: set[str]) -> list[str]:
    import verify_coverage_convergence as vcc  # noqa: WPS433
    return vcc.registry_metadata_violations(base_rows, round_rows, waived, "round")


def load_waivers(path: Path) -> set[str]:
    import verify_coverage_convergence as vcc  # noqa: WPS433
    return vcc.load_waived_cells(path)


def check_round_dir(args: argparse.Namespace, prompts: list[dict[str, str]],
                    registry: list[dict[str, str]]) -> list[str]:
    """v0.7.0 discovery-round contract (spec §3/§4/§9 items 1, 2, 10, 11, 12).

    Verifies the Stage 1 / Stage 2 shape and that accepted discovery surfaces
    really landed in the living registry AND in the after-round / final Prompt
    Map, and that the map is an ADDITIVE superset of accepted discovery
    coverage. Value/novelty recomputation itself belongs to
    verify_coverage_convergence.py; this validator does not duplicate it.
    """
    errors: list[str] = []
    rdir: Path = args.round_dir
    if not rdir.is_dir():
        return [f"round dir does not exist: {rdir}"]

    manifest_path = rdir / "00_round_manifest.json"
    cand_path = rdir / "01_discovery_candidates.csv"
    values_path = rdir / "02_discovery_values.csv"
    ledger_path = rdir / "03_discovery_ledger.csv"
    accepted_path = rdir / "04_accepted_surfaces.csv"

    manifest: dict = {}
    if not manifest_path.is_file():
        errors.append(f"round: {manifest_path.name} is missing (freeze the round protocol first)")
    else:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"round: {manifest_path.name} is malformed: {exc}")
        if not isinstance(manifest, dict):
            errors.append(f"round: {manifest_path.name} must be a JSON object")
            manifest = {}

    if not cand_path.is_file():
        errors.append(f"round: {cand_path.name} is missing")
        return errors
    candidates = read_csv(cand_path)

    # (1) Stage 1 must carry exactly K rows — "only the good candidates were
    # logged" must fail, not quietly shrink the denominator.
    expected_k = args.expected_k if args.expected_k is not None else manifest.get("K")
    if expected_k is None:
        errors.append("round: cannot determine K (pass --expected-k or freeze K in the manifest)")
    elif len(candidates) != int(expected_k):
        errors.append(f"round: Stage 1 has {len(candidates)} rows, expected exactly K={expected_k}")

    ids = [r.get("candidate_id", "").strip() for r in candidates]
    if any(not i for i in ids):
        errors.append("round: Stage 1 has row(s) with an empty candidate_id")
    dup_ids = sorted({i for i in ids if i and ids.count(i) > 1})
    if dup_ids:
        errors.append(f"round: duplicate candidate_id(s) in Stage 1: {', '.join(dup_ids)}")

    # (2) every probe family met its fixed quota
    quotas = manifest.get("family_quotas") or {}
    if quotas and not isinstance(quotas, dict):
        errors.append("round: manifest family_quotas must be an object")
        quotas = {}
    if quotas:
        actual = Counter(r.get("probe_family", "") for r in candidates)
        for family, quota in quotas.items():
            if actual.get(family, 0) != int(quota):
                errors.append(f"round: probe family '{family}' has {actual.get(family, 0)} "
                              f"candidates, quota is {quota}")
        stray = sorted(set(actual) - set(quotas))
        if stray:
            errors.append(f"round: unknown probe families in Stage 1: {', '.join(stray)}")

    # Stage 1 / Stage 2 ID alignment: the set of `novelty_status == new`
    # candidates must equal the ID set of the values file, exactly.
    if ledger_path.is_file():
        ledger = read_csv(ledger_path)
        new_ids = {r.get("candidate_id", "").strip() for r in ledger
                   if r.get("novelty_status", "").strip() == "new"}
        if not values_path.is_file():
            if new_ids:
                errors.append(f"round: {values_path.name} is missing but "
                              f"{len(new_ids)} new surfaces exist")
        else:
            value_ids = [r.get("candidate_id", "").strip() for r in read_csv(values_path)]
            vdup = sorted({i for i in value_ids if i and value_ids.count(i) > 1})
            if vdup:
                errors.append(f"round: duplicate candidate_id(s) in Stage 2: {', '.join(vdup)}")
            missing_v = sorted(new_ids - set(value_ids))
            extra_v = sorted(set(value_ids) - new_ids)
            if missing_v:
                errors.append("round: new surfaces missing from Stage 2: "
                              + ", ".join(missing_v[:10]))
            if extra_v:
                errors.append("round: Stage 2 scores non-new candidates: "
                              + ", ".join(extra_v[:10]))
    else:
        errors.append(f"round: {ledger_path.name} is missing (run score-round first)")

    # (10/11/12) accepted discovery surfaces must be in the living registry AND
    # in the after-round / final Prompt Map. A probe may not "discover" a
    # surface without producing a Prompt for it, and the map may only ADD.
    if accepted_path.is_file():
        accepted = read_csv(accepted_path)
        registry_sigs = {signature(r) for r in registry}
        prompt_sigs = {signature(r) for r in prompts}
        after_sigs = prompt_sigs
        after_path = rdir / "05_round_prompts.csv"
        if after_path.is_file():
            after_sigs = {signature(r) for r in read_csv(after_path)}
        for row in accepted:
            label = row.get("candidate_id", "?")
            sig = signature(row)
            if sig not in registry_sigs:
                errors.append(f"round: accepted discovery surface {label} is not in the "
                              "living registry (append it as an open obligation first)")
            if sig not in after_sigs:
                errors.append(f"round: accepted discovery surface {label} has no Prompt in "
                              "05_round_prompts.csv")
            if sig not in prompt_sigs:
                errors.append(f"round: accepted discovery surface {label} is absent from the "
                              "final Prompt Map (the map must be an additive superset)")
    else:
        errors.append(f"round: {accepted_path.name} is missing")

    # (13) WITHIN-ROUND registry containment. The cross-round stuffing check in
    # verify_coverage_convergence.py only fires once the NEXT round freezes its
    # base, so a row pushed straight into 06_round_registry.csv this round would
    # otherwise have no executable guard at all.
    #
    # Two layers, because signature-set containment alone is bypassable:
    #   a) origin: every signature must come from the frozen base, from
    #      Discovery-accepted surfaces, or from a VALIDATED closure addition;
    #   b) row metadata: baseline rows keep their cell id, surface, eligibility
    #      and provenance, and cell_status may only move open -> covered
    #      (open -> waived needs a waiver ledger).
    # (a) proves membership in at least one allowed set — it deliberately does
    # not try to prove a single exclusive origin, since a Closure addition and a
    # Discovery acceptance can legitimately land on the same surface.
    round_reg_path = rdir / "06_round_registry.csv"
    base_reg_path = rdir / "00_base_registry.csv"
    closure_path = rdir / "06_closure_additions.csv"
    if not round_reg_path.is_file():
        # Fail closed: deleting the artifact must not skip its own check.
        errors.append(f"round: {round_reg_path.name} is missing — the living registry for this "
                      "round cannot be checked against its frozen base")
    else:
        if not base_reg_path.is_file():
            errors.append(f"round: {base_reg_path.name} is missing — the round registry cannot "
                          "be checked for stuffing without its frozen baseline")
        else:
            base_rows = read_csv(base_reg_path)
            round_rows = read_csv(round_reg_path)
            accepted_rows = read_csv(accepted_path) if accepted_path.is_file() else []
            base_sigs = {signature(r) for r in base_rows}
            allowed = set(base_sigs) | {signature(r) for r in accepted_rows}

            # Closure additions are only "allowed" once they are properly
            # evidenced and approved — otherwise any surface could be laundered
            # into the registry, including one Discovery just rejected.
            rejected_sigs: set[tuple] = set()
            if ledger_path.is_file():
                rejected_sigs = {signature(r) for r in read_csv(ledger_path)
                                 if r.get("novelty_status", "").strip() == "new"
                                 and r.get("value_gate_pass", "").strip() != "Yes"}
            closure_sigs, closure_errors = validate_closure_rows(closure_path, rejected_sigs)
            errors.extend(closure_errors)
            allowed |= closure_sigs

            round_sigs = {signature(r) for r in round_rows}
            stuffed = sorted(round_sigs - allowed)
            if stuffed:
                errors.append(
                    f"round: {len(stuffed)} row(s) in {round_reg_path.name} trace to no legal "
                    f"origin (not in the frozen base, not Discovery-accepted, not an approved "
                    f"closure addition): " + "; ".join(" | ".join(s) for s in stuffed[:5]))
            dropped = sorted(base_sigs - round_sigs)
            if dropped:
                errors.append(
                    f"round: {len(dropped)} baseline row(s) disappeared from "
                    f"{round_reg_path.name} — the living registry is append-only within a "
                    "round: " + "; ".join(" | ".join(s) for s in dropped[:5]))
            errors.extend(registry_row_violations(base_rows, round_rows,
                                                  load_waivers(rdir / "06_waivers.csv")))

    return errors


def run(args: argparse.Namespace) -> int:
    required_paths = [args.registry, args.prompts, args.angle_inventory, args.angle_links]
    missing = [str(path) for path in required_paths if not path.exists()]
    if missing:
        return fail([f"missing required integrity artifact: {path}" for path in missing])

    registry = read_csv(args.registry)
    prompts = read_csv(args.prompts)
    inventory = read_csv(args.angle_inventory)
    links = read_csv(args.angle_links)
    errors: list[str] = []

    # Reject empty or mis-headered artifacts before trusting their contents.
    header_errors: list[str] = []
    for rows, cols, name, must_have_rows in (
        (registry, ("demand_cell_id", "cell_status", "product_card_eligible"), "registry", True),
        (prompts, ("prompt_id", "demand_cell_id"), "prompts", True),
        (inventory, ("route_id", "angle_status"), "angle-inventory", True),
        (links, ("route_id", "prompt_id"), "angle-links", False),
    ):
        if must_have_rows and not rows:
            header_errors.append(f"{name} has no rows")
            continue
        present = set(rows[0]) if rows else set()
        for col in cols:
            if rows and col not in present:
                header_errors.append(f"{name} is missing required column: {col}")
    if header_errors:
        return fail(header_errors)

    # Final Prompt IDs must be present and unique — an empty or duplicate ID
    # would otherwise slip past the ledger reconciliation below.
    raw_prompt_ids = [row.get("prompt_id", "").strip() for row in prompts]
    if any(not pid for pid in raw_prompt_ids):
        errors.append("prompts file has row(s) with an empty prompt_id")
    dup_prompt_ids = sorted({pid for pid in raw_prompt_ids if pid and raw_prompt_ids.count(pid) > 1})
    if dup_prompt_ids:
        errors.append(f"prompts file has duplicate prompt_id(s): {', '.join(dup_prompt_ids)}")
    prompt_ids = {pid for pid in raw_prompt_ids if pid}
    eligible_cells = {
        row.get("demand_cell_id", "")
        for row in registry
        if row.get("cell_status", "").lower() in {"open", "covered"}
        and row.get("product_card_eligible", "").lower() in {"yes", "true"}
    }
    prompt_cells = {row.get("demand_cell_id", "") for row in prompts}
    missing_cells = sorted(cell for cell in eligible_cells if cell and cell not in prompt_cells)
    if missing_cells:
        errors.append(f"eligible cells without Prompts: {', '.join(missing_cells)}")

    # GEO mode: prompts and registry must carry a canonical query surface, and
    # every eligible registry surface must be covered by a prompt sharing it.
    if args.coverage_mode == "geo_full_coverage":
        pmiss = [c for c in SURFACE_FIELDS if c not in prompts[0]]
        rmiss = [c for c in SURFACE_FIELDS if c not in registry[0]]
        if pmiss:
            errors.append(f"geo: prompts missing surface fields: {', '.join(pmiss)}")
        if rmiss:
            errors.append(f"geo: registry missing surface fields: {', '.join(rmiss)}")
        if not pmiss:
            for row in prompts:
                if is_neutral("decision_criterion", row.get("decision_criterion")):
                    errors.append(f"geo: prompt {row.get('prompt_id', '?')} has neutral/empty decision_criterion")
        if not pmiss and not rmiss:
            prompt_surfaces = {signature(row) for row in prompts}
            for row in registry:
                covered = (row.get("cell_status", "").lower() in {"open", "covered"}
                           and row.get("product_card_eligible", "").lower() in {"yes", "true"})
                if covered and signature(row) not in prompt_surfaces:
                    errors.append(f"geo: eligible registry surface not covered by any prompt: cell {row.get('demand_cell_id', '?')}")

    required_routes = {
        row.get("route_id", ""): row
        for row in inventory
        if row.get("angle_status", "").lower() in {"required", "open", "resolved", "waived"}
    }
    linked_routes: dict[str, list[str]] = {}
    for row in links:
        route_id = row.get("route_id", "")
        prompt_id = row.get("prompt_id", "")
        if route_id:
            linked_routes.setdefault(route_id, []).append(prompt_id)
        if prompt_id and prompt_id not in prompt_ids:
            errors.append(f"angle link points to unknown prompt: {prompt_id}")

    unresolved: list[str] = []
    for route_id, row in required_routes.items():
        status = row.get("angle_status", "").lower()
        if status == "waived":
            if not row.get("waive_reason", "").strip():
                errors.append(f"waived route has no reason: {route_id}")
            continue
        if not linked_routes.get(route_id):
            unresolved.append(route_id)
    if unresolved:
        errors.append(f"required route angles without Prompt links: {', '.join(sorted(unresolved))}")

    # GEO mode: the candidate→surface ledger is a required input contract. It is
    # what the Coverage Loop's acceptance_rate is computed from, so it must exist,
    # use valid dispositions, reconcile candidate_count = accepted+merged+rejected,
    # and every accepted surface must be present in the prompt surface set.
    LEDGER_COLS = ("candidate_id", "prompt_id", "surface_signature", "disposition", "reason")
    VALID_DISP = {"accepted", "merged", "rejected"}
    if args.coverage_mode == "geo_full_coverage":
        if not args.ledger:
            errors.append("geo: --ledger (candidate→surface ledger) is required")
        elif not args.ledger.exists():
            errors.append(f"geo: candidate→surface ledger missing: {args.ledger}")
        else:
            ledger = read_csv(args.ledger)
            if not ledger:
                errors.append("geo: candidate→surface ledger has no rows")
            else:
                lmiss = [c for c in LEDGER_COLS if c not in ledger[0]]
                if lmiss:
                    errors.append(f"geo: ledger missing required columns: {', '.join(lmiss)}")
                else:
                    disp = Counter(r.get("disposition", "").strip().lower() for r in ledger)
                    bad = sorted(set(disp) - VALID_DISP)
                    if bad:
                        errors.append(f"geo: ledger has invalid disposition(s): {', '.join(bad)}")
                    # Required non-empty fields + unique candidate_id.
                    seen_candidates: set[str] = set()
                    for r in ledger:
                        cid = r.get("candidate_id", "").strip()
                        if not cid:
                            errors.append("geo: ledger row has empty candidate_id")
                        elif cid in seen_candidates:
                            errors.append(f"geo: ledger has duplicate candidate_id: {cid}")
                        else:
                            seen_candidates.add(cid)
                        if not r.get("surface_signature", "").strip():
                            errors.append(f"geo: ledger candidate {cid or '?'} has empty surface_signature")
                        if not r.get("reason", "").strip():
                            errors.append(f"geo: ledger candidate {cid or '?'} has empty reason")
                        if r.get("disposition", "").strip().lower() == "accepted":
                            pid = r.get("prompt_id", "").strip()
                            if not pid or pid not in prompt_ids:
                                errors.append(f"geo: ledger accepted candidate {cid or '?'} has no valid prompt_id")
                    # Reconciliation: every final Prompt must trace to an 'accepted'
                    # ledger row, so a fabricated all-rejected ledger cannot pass.
                    accepted_prompt_ids = {
                        r.get("prompt_id", "").strip() for r in ledger
                        if r.get("disposition", "").strip().lower() == "accepted"
                    }
                    orphan_prompts = sorted(pid for pid in prompt_ids if pid and pid not in accepted_prompt_ids)
                    if orphan_prompts:
                        errors.append(
                            "geo: final Prompts with no 'accepted' ledger row: "
                            + ", ".join(orphan_prompts)
                        )

    # --- v0.7.0 discovery-round integrity -------------------------------
    # Back-compatible: only runs when --round-dir is supplied.
    if args.round_dir:
        errors.extend(check_round_dir(args, prompts, registry))

    if args.delivery_csv:
        if not args.delivery_csv.exists():
            errors.append(f"delivery CSV missing: {args.delivery_csv}")
        else:
            delivered = read_csv(args.delivery_csv)
            delivered_ids = {row.get("prompt_id", "") for row in delivered}
            if delivered_ids != prompt_ids:
                errors.append("delivery CSV Prompt IDs do not match the approved final Prompt file")

    if errors:
        return fail(errors)

    print("PASS")
    print(f"Prompts: {len(prompts)}")
    print(f"Eligible cells: {len(eligible_cells)}")
    print(f"Required route angles: {len(required_routes)}")
    print(f"Linked route angles: {sum(bool(value) for value in linked_routes.values())}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--prompts", type=Path, required=True)
    parser.add_argument("--angle-inventory", type=Path, required=True)
    parser.add_argument("--angle-links", type=Path, required=True)
    parser.add_argument("--delivery-csv", type=Path)
    parser.add_argument("--ledger", type=Path,
                        help="candidate→surface ledger CSV (required in geo_full_coverage)")
    parser.add_argument("--coverage-mode", default="geo_full_coverage",
                        choices=("geo_full_coverage", "minimal_dedup"))
    parser.add_argument("--round-dir", type=Path,
                        help="work/coverage_rounds/rNN — enables the v0.7.0 discovery-round "
                             "checks (Stage 1 = K rows, family quotas, Stage 1/2 ID alignment, "
                             "accepted surfaces present in registry + round/final Prompt Map)")
    parser.add_argument("--expected-k", type=int,
                        help="override K; defaults to the round manifest's K")
    args = parser.parse_args()
    try:
        return run(args)
    except (OSError, csv.Error, json.JSONDecodeError, ValueError, TypeError,
            AttributeError, KeyError) as exc:
        return fail([f"integrity validator error: {exc}"])


if __name__ == "__main__":
    sys.exit(main())
