#!/usr/bin/env python3
"""Coverage Floor + Value Frontier convergence engine (`coverage_floor_plus_value_frontier_v1`).

This module is the SINGLE implementation of v0.7.0 convergence logic. Nothing
else may re-implement it: `verify_decision_angle_gate.py` imports `run()`.

Four modes (both `prepare-floor` and `--prepare-floor` spellings work):

    verify_coverage_convergence.py prepare-floor  --project-root R [--batch 1]
    verify_coverage_convergence.py prepare-round  --project-root R --round 1
    verify_coverage_convergence.py score-round    --project-root R --round 1
    verify_coverage_convergence.py verify         --project-root R --stage final-audit

Design contract (references/discovery-protocol.md, coverage-floor-sampling.md):

- The agent NEVER writes a derived number. It writes surface fields, closed
  enums and raw counts; this script derives E / D / P / T / V, materiality,
  novelty, C/H/M/D and the Wilson bound.
- `verify` RECOMPUTES everything from the frozen per-round inputs. It never
  trusts a rate, score or boolean pre-filled in run_state; where a value can
  only come from another validator it is cross-checked against that
  validator's artifact, and the trust boundary is reported explicitly.
- Fail closed: a missing, malformed or tampered artifact is an integrity
  failure, never a silent pass.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _surface import SURFACE_FIELDS, signature, is_blank, is_neutral  # noqa: E402

SAMPLING_KEY_VERSION = "coverage_floor_v1"
CONVERGENCE_METHOD = "coverage_floor_plus_value_frontier_v1"
VALUE_RUBRIC_VERSION = "1.0"
MATERIALITY_RULE_VERSION = "1.0"
RUN_STATE_SCHEMA = "1.3"
PACKAGE_VERSION = "0.7.0"

# --------------------------------------------------------------------------
# Frozen profile constants. A profile on disk must EQUAL one of these exactly;
# a hand-edited threshold is an integrity failure, not a configuration option.
# --------------------------------------------------------------------------

PROBE_FAMILIES: tuple[tuple[str, str, int, int], ...] = (
    # (family_key, short code, rich quota, narrow quota)
    ("audience_body_condition", "abc", 15, 6),
    ("constraint_scenario", "csc", 15, 6),
    ("criterion_tradeoff", "ctd", 20, 8),
    ("topic_intersection", "tix", 15, 6),
    ("compatibility_format_access", "cfa", 15, 6),
    ("switching_comparison", "swc", 10, 4),
    ("reliability_maintenance", "rmh", 10, 4),
)

PROFILES: dict[str, dict] = {
    "rich": {
        "profile": "rich",
        "K": 100,
        "V_accept": 0.60,
        "V_critical": 0.85,
        "N": 5,
        "delta": 0.039,
        "streak": 2,
        "max_round": 6,
        "coverage_floor_n": 60,
        "coverage_floor_threshold": 0.10,
        # Anti-degenerate probe floor: max(5, ceil(0.10 * K)).
        "min_new_surface_count": 10,
        "floor_quotas": {"reddit": 30, "semrush": 20, "geoly": 10, "brand": 0},
        "family_quotas": {k: r for k, _s, r, _n in PROBE_FAMILIES},
    },
    "narrow": {
        "profile": "narrow",
        "K": 40,
        "V_accept": 0.60,
        "V_critical": 0.85,
        "N": 3,
        "delta": 0.062,
        "streak": 2,
        "max_round": 4,
        # n=50, not 40: n=40 tolerates zero misses, too brittle.
        "coverage_floor_n": 50,
        "coverage_floor_threshold": 0.10,
        # max(5, ceil(0.10 * 40)) = max(5, 4) = 5.
        "min_new_surface_count": 5,
        "floor_quotas": {"reddit": 25, "semrush": 15, "geoly": 10, "brand": 0},
        "family_quotas": {k: n for k, _s, _r, n in PROBE_FAMILIES},
    },
}

FAMILY_SHORT = {k: s for k, s, _r, _n in PROBE_FAMILIES}

EXCLUSION_REASONS = {
    "not_purchase_related", "education_only", "medical_or_safety_only",
    "service_only", "wrong_category", "duplicate_evidence", "insufficient_text",
}
FLOOR_SOURCE_TYPES = ("reddit", "semrush", "geoly", "brand")
SUPPORT_MODES = {"direct", "derived", "hypothesis"}
PRODUCT_IMPACT_P = {
    "P4_ELIGIBILITY_GATE": 1.00,
    "P3_PRIMARY_RANKING": 0.80,
    "P2_SECONDARY_TRADEOFF": 0.60,
    "P1_EMPHASIS_ONLY": 0.30,
    "P0_NO_CHANGE": 0.00,
}
NOVELTY_NEW = "new"
NOVELTY_IDENTICAL = "identical_existing"
NOVELTY_DUP = "duplicate_within_round"
NOVELTY_INVALID = "invalid_surface"

STAGE1_PREFILLED = ("round_id", "candidate_id", "probe_family", "probe_slot")
STAGE1_AGENT = ("audience", "body_part_or_object", "attribute_or_condition", "scenario",
                "decision_angle", "decision_criterion", "conditional_dimensions",
                "evidence_refs", "derivation_rule_id", "decision_distinction")
STAGE1_COLUMNS = STAGE1_PREFILLED + STAGE1_AGENT
# Columns the agent must NOT author in Stage 1 — the script owns them.
STAGE1_FORBIDDEN = ("canonical_surface_signature", "novelty_status", "is_new_surface",
                    "identical_surface", "nearest_prompt_id", "value_score",
                    "materiality_pass", "disposition")

STAGE2_COLUMNS = ("candidate_id", "support_mode",
                  "reddit_cluster_count", "semrush_keyword_count", "semrush_monthly_volume",
                  "geoly_public_prompt_count", "geoly_topic_or_card_count",
                  "brand_customer_case_count", "product_card_eligible", "product_impact_code",
                  "track_natural_query", "track_concrete_answer", "track_reusable_surface")
STAGE2_FORBIDDEN = ("E", "D", "P", "T", "value_score", "evidence_code", "materiality_pass",
                    "value_gate_pass", "critical_value", "disposition", "source_family_count")

LEDGER_COLUMNS = (
    "round_id", "candidate_id", "probe_family", "probe_slot",
    *SURFACE_FIELDS, "conditional_dimensions", "evidence_refs", "derivation_rule_id",
    "decision_distinction",
    "canonical_surface_signature", "novelty_status", "identical_surface", "nearest_prompt_id",
    "support_mode", "evidence_code", "source_family_count", "direct_evidence_unit_count",
    "E", "D_reddit", "D_semrush", "D_geoly", "D_brand", "D", "P", "T", "value_score",
    "materiality_pass", "value_gate_pass", "critical_value", "disposition", "reason",
)
ACCEPTED_COLUMNS = ("round_id", "candidate_id", "canonical_surface_signature", *SURFACE_FIELDS,
                    "conditional_dimensions", "evidence_code", "product_impact_code",
                    "derivation_rule_id", "value_score", "critical_value")

FLOOR_PREFILLED = ("batch_id", "sample_rank", "quota_source", "evidence_id", "source_type",
                   "source_record_id", "cluster_id", "evidence_text", "source_metric",
                   "source_url", "demand_theme_key", "sample_key")
FLOOR_AGENT = ("eligible", "exclusion_reason", *SURFACE_FIELDS)
FLOOR_COLUMNS = FLOOR_PREFILLED + FLOOR_AGENT

EVIDENCE_INDEX_COLUMNS = ("evidence_id", "source_type", "source_record_id", "cluster_id",
                          "evidence_text", "source_metric", "source_url", "demand_theme_key",
                          "floor_candidate")

# outputs/discovery_backlog.csv — the PASS_WITH_BACKLOG artifact. Field names
# follow the delivery reference; every row must trace to a real ledger candidate.
BACKLOG_REQUIRED_COLUMNS = ("discovery_candidate_id", "introduced_round",
                            "frontier_value_score", "reason")
BACKLOG_COLUMNS = ("backlog_id", "discovery_candidate_id", "introduced_round",
                   "surface_signature", *SURFACE_FIELDS, "frontier_value_score",
                   "product_impact_code", "evidence_code", "reason", "exploration_direction")

# Approved Closure-Stream additions to the living registry.
CLOSURE_REQUIRED_COLUMNS = ("closure_addition_id", "source_gap_id", "evidence_refs",
                            "approval_ref", "closure_reason")

FINAL_MAP_REL = "work/05_prompt_final.csv"
ROUNDS_REL = "work/coverage_rounds"
FLOOR_REL = "work/coverage_floor"
PROFILE_REL = "state/convergence_profile.json"
PROTOCOL_REL = "state/discovery_protocol.json"


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

class ConvergenceError(Exception):
    """Recoverable, reportable error — never a traceback at the gate."""


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, columns, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(columns), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in columns})


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonicalizer_sha256() -> str:
    return sha256_file(Path(__file__).resolve().parent / "_surface.py")


def sig_str(row: dict) -> str:
    """Canonical surface signature as a stable string."""
    return "|".join(signature(row))


def as_int(value, default: int | None = None) -> int | None:
    text = str(value if value is not None else "").strip()
    if text == "":
        return default
    if not re.fullmatch(r"[+-]?\d+", text):
        return None
    return int(text)


def as_float(value) -> float | None:
    try:
        result = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def yes(value) -> bool:
    return str(value or "").strip().lower() in {"yes", "true", "1"}


def q3(value: float) -> float:
    """Round to 3 decimals, ROUND_HALF_UP (never bankers rounding)."""
    return float(Decimal(repr(value)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def q6(value: float) -> float:
    return float(Decimal(repr(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def split_refs(value: str) -> list[str]:
    return [t.strip() for t in re.split(r"[;,\s]+", str(value or "")) if t.strip()]


def valid_surface(row: dict) -> bool:
    """A structurally usable surface: all six fields present, non-neutral criterion."""
    if any(is_blank(row.get(f)) for f in SURFACE_FIELDS):
        return False
    if is_neutral("decision_criterion", row.get("decision_criterion")):
        return False
    return True


# --------------------------------------------------------------------------
# Wilson upper bound (spec §5, verbatim)
# --------------------------------------------------------------------------

def wilson_upper(x: int, n: int, z: float = 1.645) -> float:
    if n <= 0:
        raise ValueError("n must be positive")
    p, z2 = x / n, z * z
    num = p + z2 / (2 * n) + z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    return num / (1 + z2 / n)


# --------------------------------------------------------------------------
# Value rubric (spec §2) — pure functions shared by score-round and verify.
# --------------------------------------------------------------------------

def demand_source_families(v: dict) -> list[str]:
    families = []
    if (v.get("reddit_cluster_count") or 0) > 0:
        families.append("reddit")
    if (v.get("semrush_monthly_volume") or 0) > 0 or (v.get("semrush_keyword_count") or 0) > 0:
        families.append("semrush")
    if (v.get("geoly_public_prompt_count") or 0) > 0 or (v.get("geoly_topic_or_card_count") or 0) > 0:
        families.append("geoly")
    if (v.get("brand_customer_case_count") or 0) > 0:
        families.append("brand_customer")
    return families


def score_evidence(support_mode: str, families: list[str], direct_units: int,
                   derivation_ok: bool) -> tuple[str, float]:
    """E — match the first row of the evidence table that applies.

    `direct_units` is the number of DISTINCT evidence refs that resolve in the
    frozen evidence index. Zero resolvable units is E0 no matter what source
    counts the agent claims: "no evidence" outranks every other row.
    """
    if support_mode == "direct" and direct_units < 1:
        return "E0_UNSUPPORTED", 0.00
    if support_mode == "direct":
        if len(families) >= 2:
            code, e = "E4_MULTI_SOURCE_DIRECT", 1.00
        elif len(families) == 1 and direct_units >= 3:
            code, e = "E3_REPEATED_DIRECT", 0.80
        elif direct_units >= 1:
            code, e = "E2_SINGLE_DIRECT", 0.60
        else:
            code, e = "E0_UNSUPPORTED", 0.00
    elif support_mode == "derived":
        if derivation_ok and direct_units >= 1:
            code, e = "E1_VALID_DERIVED", 0.50
        else:
            code, e = "E0_UNSUPPORTED", 0.00
    else:
        code, e = "E0_UNSUPPORTED", 0.00
    # Brand-only cap: brand_customer alone can never exceed 0.60.
    if families == ["brand_customer"]:
        e = min(e, 0.60)
        if e == 0.60 and code in ("E4_MULTI_SOURCE_DIRECT", "E3_REPEATED_DIRECT"):
            code = "E2_SINGLE_DIRECT"
    return code, e


def d_reddit(clusters: int) -> float:
    if clusters >= 8:
        return 1.00
    if clusters >= 3:
        return 0.70
    if clusters >= 1:
        return 0.40
    return 0.00


def d_semrush(volume: int) -> float:
    if volume >= 500:
        return 1.00
    if volume >= 50:
        return 0.70
    if volume >= 10:
        return 0.40
    if volume >= 1:
        return 0.20
    return 0.00


def d_geoly(prompts: int, topic_or_card: int) -> float:
    if prompts >= 3:
        return 1.00
    if prompts == 2:
        return 0.70
    if prompts >= 1 and topic_or_card >= 1:
        return 0.70
    if prompts == 1:
        return 0.40
    if prompts == 0 and topic_or_card >= 1:
        return 0.40
    return 0.00


def d_brand(cases: int) -> float:
    if cases >= 20:
        return 0.70
    if cases >= 5:
        return 0.40
    if cases >= 1:
        return 0.20
    return 0.00


def combine_demand(scores: list[float]) -> float:
    if max(scores) == 1.00:
        return 1.00
    if sum(1 for s in scores if s >= 0.70) >= 2:
        return 1.00
    if max(scores) >= 0.70:
        return 0.70
    if sum(1 for s in scores if s >= 0.40) >= 2:
        return 0.70
    if max(scores) >= 0.40:
        return 0.40
    if max(scores) >= 0.20:
        return 0.20
    return 0.00


def score_track(v: dict) -> float:
    n = sum(1 for f in ("track_natural_query", "track_concrete_answer", "track_reusable_surface")
            if yes(v.get(f)))
    return {3: 1.00, 2: 0.70, 1: 0.40, 0: 0.00}[n]


DERIVABLE_COUNTS = ("reddit_cluster_count", "semrush_keyword_count", "semrush_monthly_volume",
                    "geoly_public_prompt_count", "geoly_topic_or_card_count",
                    "brand_customer_case_count")


GEOLY_TOPIC_PREFIXES = ("topic:", "card:")


def counts_from_refs(refs: list[str], index: dict[str, dict]) -> tuple[dict[str, int], list[str]]:
    """Recompute demand counts from the frozen evidence index (spec §9 item 7).

    The agent writes counts, but the gate does not trust them. Everything here
    comes from the referenced evidence records:

    - Reddit: DISTINCT `cluster_id` (default `post:<record>`). Ten comments on
      one post are one cluster.
    - Semrush: volume summed once per unique `source_record_id`; a repeated
      export of the same keyword counts once. Conflicting volumes for the same
      record are an integrity problem, not a silent last-wins.
    - GEOly: `cluster_id` prefixed `topic:`/`card:` is a topic/card record;
      everything else is a public prompt ID, counted once.
    - Brand: only rows carrying a `cluster_id` count as an independent,
      quantified customer case. FAQ / feature / marketing rows have no case
      cluster and contribute 0 (demand-schema.md).
    """
    problems: list[str] = []
    clusters: set[str] = set()
    semrush: dict[str, int] = {}
    geoly_prompts: set[str] = set()
    geoly_topics: set[str] = set()
    brand: set[str] = set()
    identities: set[tuple[str, str]] = set()
    for ref in refs:
        row = index.get(ref)
        if row is None:
            continue
        stype = str(row.get("source_type", "")).strip().lower()
        record = str(row.get("source_record_id", "")).strip() or ref
        cluster = str(row.get("cluster_id", "")).strip()
        if stype == "reddit":
            key = cluster or f"post:{record}"
            clusters.add(key)
            identities.add((stype, key))
        elif stype == "semrush":
            volume = as_int(row.get("source_metric"), 0) or 0
            if record in semrush and semrush[record] != volume:
                problems.append(f"semrush record {record} has conflicting volumes "
                                f"({semrush[record]} vs {volume}); taking the maximum")
                volume = max(semrush[record], volume)
            semrush[record] = volume
            identities.add((stype, record))
        elif stype == "geoly":
            if cluster.lower().startswith(GEOLY_TOPIC_PREFIXES):
                geoly_topics.add(cluster)
            else:
                geoly_prompts.add(record)
            identities.add((stype, cluster or record))
        elif stype == "brand":
            if cluster:
                brand.add(cluster)
                identities.add((stype, cluster))
            else:
                problems.append(f"brand evidence {ref} has no customer-case cluster_id; "
                                "unquantified FAQ/feature/marketing is not demand evidence")
    return {
        "reddit_cluster_count": len(clusters),
        "semrush_keyword_count": len(semrush),
        "semrush_monthly_volume": sum(semrush.values()),
        "geoly_public_prompt_count": len(geoly_prompts),
        "geoly_topic_or_card_count": len(geoly_topics),
        "brand_customer_case_count": len(brand),
        # Independent evidence UNITS, not raw ref count: three comments on one
        # Reddit post are one unit, so they cannot buy E3_REPEATED_DIRECT.
        "_independent_units": len(identities),
    }, problems


def evaluate_candidate(cand: dict, values: dict, profile: dict,
                       approved_rules: set[str] | None,
                       evidence_index: dict[str, dict] | None = None) -> dict:
    """Derive every value column for one Stage-2 row. Agent input is enums only."""
    problems: list[str] = []

    support_mode = str(values.get("support_mode", "")).strip().lower()
    if support_mode not in SUPPORT_MODES:
        problems.append(f"support_mode invalid: {values.get('support_mode')!r}")
        support_mode = "hypothesis"

    counts: dict[str, int] = {}
    for field in ("reddit_cluster_count", "semrush_keyword_count", "semrush_monthly_volume",
                  "geoly_public_prompt_count", "geoly_topic_or_card_count",
                  "brand_customer_case_count"):
        n = as_int(values.get(field), 0)
        if n is None or n < 0:
            problems.append(f"{field} is not a non-negative integer: {values.get(field)!r}")
            n = 0
        counts[field] = n

    # Distinct refs only — repeating one ref three times is not "3 independent
    # direct evidence units".
    refs = sorted(set(split_refs(cand.get("evidence_refs"))))
    if evidence_index is not None:
        resolvable = [r for r in refs if r in evidence_index]
        derived_counts, ref_problems = counts_from_refs(resolvable, evidence_index)
        problems.extend(ref_problems)
        direct_units = derived_counts.pop("_independent_units")
        for field, recomputed in derived_counts.items():
            claimed = counts.get(field, 0)
            if claimed > recomputed:
                problems.append(f"{field}={claimed} exceeds the {recomputed} supported by "
                                "evidence_refs (counts are recomputed, not trusted)")
            counts[field] = recomputed
    else:
        # No frozen evidence index means nothing can be recomputed. Refuse to
        # score rather than falling back to self-reported numbers.
        problems.append("work/02_evidence_index.csv is missing — demand counts cannot be "
                        "recomputed, so this candidate cannot be scored")
        direct_units = 0
        for field in DERIVABLE_COUNTS:
            counts[field] = 0
    rule_id = str(cand.get("derivation_rule_id", "")).strip()
    if approved_rules is None:
        # Defensive path for a MISCONFIGURED project: score-round can run before
        # the gate, and an absent/empty rule table means nothing can be approved.
        # A project in this state is an integrity FAIL at `verify` — this branch
        # only keeps scoring sane in the meantime, it is not a supported mode.
        derivation_ok = False
        if support_mode == "derived":
            problems.append(
                f"support_mode=derived cannot be scored: {PROTOCOL_REL} has no frozen "
                "approved_derivation_rule_ids (this project is misconfigured and will fail "
                "the convergence gate)")
    else:
        derivation_ok = bool(rule_id) and rule_id in approved_rules
        if support_mode == "derived" and not derivation_ok:
            problems.append(f"derived row has no pre-approved derivation_rule_id ({rule_id!r})")

    families = demand_source_families(counts)
    evidence_code, e = score_evidence(support_mode, families, direct_units, derivation_ok)

    dr = d_reddit(counts["reddit_cluster_count"])
    ds = d_semrush(counts["semrush_monthly_volume"])
    dg = d_geoly(counts["geoly_public_prompt_count"], counts["geoly_topic_or_card_count"])
    db = d_brand(counts["brand_customer_case_count"])
    d = combine_demand([dr, ds, dg, db])

    impact = str(values.get("product_impact_code", "")).strip().upper()
    if impact not in PRODUCT_IMPACT_P:
        problems.append(f"product_impact_code invalid: {values.get('product_impact_code')!r}")
        p = 0.00
    else:
        p = PRODUCT_IMPACT_P[impact]

    t = score_track(values)
    value_score = q3(0.30 * e + 0.25 * d + 0.30 * p + 0.15 * t)

    eligible = yes(values.get("product_card_eligible"))
    material_reasons: list[str] = []
    if not eligible:
        material_reasons.append("product_card_eligible!=Yes")
    if support_mode not in ("direct", "derived"):
        material_reasons.append("support_mode not direct/derived")
    if e < 0.50:
        material_reasons.append(f"E={e:.2f}<0.50")
    if d < 0.40:
        material_reasons.append(f"D={d:.2f}<0.40")
    if p < 0.60:
        material_reasons.append(f"P={p:.2f}<0.60")
    if t < 0.70:
        material_reasons.append(f"T={t:.2f}<0.70")
    if is_blank(cand.get("decision_criterion")):
        material_reasons.append("decision_criterion empty")
    if support_mode == "derived" and not derivation_ok:
        material_reasons.append("invalid derivation_rule_id")

    materiality_pass = not material_reasons
    value_gate_pass = materiality_pass and value_score >= profile["V_accept"]
    critical = value_gate_pass and value_score >= profile["V_critical"]

    if value_gate_pass:
        disposition, reason = "accepted", f"V={value_score:.3f}>={profile['V_accept']:.2f}"
    elif materiality_pass:
        disposition, reason = "rejected", f"below V_accept: V={value_score:.3f}"
    else:
        disposition, reason = "rejected", "materiality: " + "; ".join(material_reasons)
    if problems:
        reason = reason + " | input problems: " + "; ".join(problems)

    return {
        "support_mode": support_mode,
        "evidence_code": evidence_code,
        "source_family_count": len(families),
        "direct_evidence_unit_count": direct_units,
        "E": f"{e:.2f}", "D_reddit": f"{dr:.2f}", "D_semrush": f"{ds:.2f}",
        "D_geoly": f"{dg:.2f}", "D_brand": f"{db:.2f}", "D": f"{d:.2f}",
        "P": f"{p:.2f}", "T": f"{t:.2f}",
        "value_score": f"{value_score:.3f}",
        "materiality_pass": "Yes" if materiality_pass else "No",
        "value_gate_pass": "Yes" if value_gate_pass else "No",
        "critical_value": "Yes" if critical else "No",
        "disposition": disposition,
        "reason": reason,
        "product_impact_code": impact,
        "_value_score": value_score,
        "_accepted": value_gate_pass,
        "_critical": critical,
        "_problems": problems,
    }


# --------------------------------------------------------------------------
# Profile handling
# --------------------------------------------------------------------------

def classify_profile(approved_topics: int, eligible_demand_themes: int,
                     initial_surface_inventory: int) -> str:
    """rich if ANY threshold is met (conflict → rich); narrow only if ALL are below."""
    if (approved_topics >= 10 or eligible_demand_themes >= 80
            or initial_surface_inventory >= 180):
        return "rich"
    return "narrow"


def profile_constants(name: str) -> dict:
    if name not in PROFILES:
        raise ConvergenceError(f"unknown convergence profile {name!r} (expected rich|narrow)")
    return json.loads(json.dumps(PROFILES[name]))


def load_profile(project_root: Path) -> tuple[dict, dict, list[str]]:
    """Return (constants, on-disk profile doc, integrity failures).

    The on-disk profile is NOT authoritative for thresholds: it must equal the
    built-in constants for its declared profile name, otherwise a mid-run
    threshold edit would silently redefine convergence.
    """
    failures: list[str] = []
    path = project_root / PROFILE_REL
    if not path.is_file():
        raise ConvergenceError(f"{PROFILE_REL} is missing — freeze the convergence profile "
                               "before the first discovery round")
    doc = read_json(path)
    if not isinstance(doc, dict):
        raise ConvergenceError(f"{PROFILE_REL} must be a JSON object")
    name = str(doc.get("profile", "")).strip().lower()
    const = profile_constants(name)
    # Every constant must be PRESENT and EQUAL. A missing key is not a pass:
    # deleting a threshold must not make it unenforceable.
    for key, expected in const.items():
        if key not in doc:
            failures.append(f"convergence_profile is missing the frozen {name} constant "
                            f"'{key}' (expected {expected!r})")
        elif doc[key] != expected:
            failures.append(f"convergence_profile.{key}={doc[key]!r} != frozen {name} "
                            f"constant {expected!r} (thresholds are not configurable)")
    if str(doc.get("convergence_method", CONVERGENCE_METHOD)) != CONVERGENCE_METHOD:
        failures.append(f"convergence_profile.convergence_method must be {CONVERGENCE_METHOD!r}")
    return const, doc, failures


PROTOCOL_FAMILY_FIELDS = ("prompt_template", "allowed_derivation_rules", "prohibitions",
                          "evidence_requirements")


def validate_discovery_protocol(project_root: Path) -> tuple[dict, list[str]]:
    """Validate the CONTENT of state/discovery_protocol.json, not just its hash.

    Hashing an empty file proves only that nobody edited the empty file. A
    "frozen protocol" has to actually contain the seven probe families and,
    for each, the template / allowed derivation rules / prohibitions / evidence
    requirements that the round is supposed to be bound to.
    """
    failures: list[str] = []
    path = project_root / PROTOCOL_REL
    if not path.is_file():
        return {}, [f"{PROTOCOL_REL} is missing"]
    try:
        doc = read_json(path)
    except json.JSONDecodeError as exc:
        return {}, [f"{PROTOCOL_REL} is malformed: {exc}"]
    if not isinstance(doc, dict):
        return {}, [f"{PROTOCOL_REL} must be a JSON object"]

    families = doc.get("families")
    if not isinstance(families, dict):
        return doc, [f"{PROTOCOL_REL} must declare a 'families' object with the seven probe "
                     "families"]
    # The global approved rule list must be present and non-empty.
    #
    # There is deliberately NO "empty list = derivation gracefully disabled"
    # mode. It could not be expressed anyway: every family must declare a
    # non-empty `allowed_derivation_rules`, and those must be a subset of this
    # global list, so an empty global list is unsatisfiable by construction.
    # Rather than advertise a configuration the validator can never accept, a
    # project that does not use derivation fills the table normally and simply
    # writes no `support_mode=derived` rows.
    global_rules = doc.get("approved_derivation_rule_ids")
    if not isinstance(global_rules, list) or not [r for r in global_rules if str(r).strip()]:
        failures.append(
            f"{PROTOCOL_REL}: 'approved_derivation_rule_ids' is missing or empty. It is the ONLY "
            "source of approved derivation rules and must list every rule the probe families may "
            "cite. If this project does not use derivation, still declare the rule table and "
            "simply write no support_mode=derived rows — an empty table is not a way to switch "
            "derivation off.")

    expected = {k for k, _s, _r, _n in PROBE_FAMILIES}
    missing = sorted(expected - set(families))
    extra = sorted(set(families) - expected)
    if missing:
        failures.append(f"{PROTOCOL_REL}: missing probe family definition(s): "
                        + ", ".join(missing))
    if extra:
        failures.append(f"{PROTOCOL_REL}: unknown probe family/families: " + ", ".join(extra))

    approved = {str(r).strip() for r in (global_rules or []) if str(r).strip()}
    for name in sorted(expected & set(families)):
        spec = families[name]
        if not isinstance(spec, dict):
            failures.append(f"{PROTOCOL_REL}/{name}: family definition must be an object")
            continue
        for field in PROTOCOL_FAMILY_FIELDS:
            value = spec.get(field)
            empty = value is None or (isinstance(value, (str, list, dict)) and not value) \
                or (isinstance(value, str) and not value.strip())
            if empty:
                failures.append(f"{PROTOCOL_REL}/{name}: '{field}' is missing or empty — a frozen "
                                "protocol must actually state it")
        # Subset check, run UNCONDITIONALLY — including when the global table is
        # empty or absent. Skipping it in that branch is what let a family claim
        # `allowed_derivation_rules: ["DR1"]` against an empty global table, a
        # self-contradictory protocol that the docs said was impossible.
        allowed = {str(r).strip() for r in (spec.get("allowed_derivation_rules") or [])
                   if str(r).strip()}
        stray = sorted(allowed - approved)
        if stray:
            failures.append(
                f"{PROTOCOL_REL}/{name}: allowed_derivation_rules cites rule id(s) absent from "
                "the global approved_derivation_rule_ids: " + ", ".join(stray))
    return doc, failures


def protocol_derivation_rules(protocol: dict) -> tuple[set[str], dict[str, set[str]]]:
    """(global approved rule ids, per-family allowed rule ids) from the protocol."""
    global_ids = {str(r).strip() for r in (protocol.get("approved_derivation_rule_ids") or [])
                  if str(r).strip()}
    per_family: dict[str, set[str]] = {}
    for name, spec in (protocol.get("families") or {}).items():
        if isinstance(spec, dict):
            per_family[name] = {str(r).strip()
                                for r in (spec.get("allowed_derivation_rules") or [])
                                if str(r).strip()}
    return global_ids, per_family


def approved_derivation_rules(project_root: Path, doc: dict | None = None) -> set[str] | None:
    """The frozen approved derivation rule IDs, or None if none is frozen.

    SINGLE SOURCE: `approved_derivation_rule_ids` inside the sha256-pinned
    `state/discovery_protocol.json`. There is deliberately no fallback path —
    an unhashed side file (the old `state/derivation_rules.json`) would become
    the effective rule source whenever the protocol list was absent or empty,
    which makes the whole "frozen with the protocol" claim vacuous.

    Returning None is DEFENSE IN DEPTH, not a supported configuration: an
    absent or empty rule table is already an integrity failure in
    `validate_discovery_protocol()`, so a project in that state cannot pass the
    gate. This only keeps the scoring path fail-closed (E0_UNSUPPORTED /
    rejected rather than "any non-empty id") if it is reached first.
    """
    path = project_root / PROTOCOL_REL
    if not path.is_file():
        return None
    try:
        protocol = read_json(path)
    except json.JSONDecodeError:
        return None
    if not isinstance(protocol, dict):
        return None
    rules = {str(r).strip() for r in (protocol.get("approved_derivation_rule_ids") or [])
             if str(r).strip()}
    return rules or None


# --------------------------------------------------------------------------
# Round directory helpers
# --------------------------------------------------------------------------

def round_dir(project_root: Path, number: int) -> Path:
    return project_root / ROUNDS_REL / f"r{number:02d}"


def discover_rounds(project_root: Path) -> list[int]:
    root = project_root / ROUNDS_REL
    if not root.is_dir():
        return []
    numbers = []
    for child in root.iterdir():
        m = re.fullmatch(r"r(\d+)", child.name)
        if child.is_dir() and m:
            numbers.append(int(m.group(1)))
    return sorted(numbers)


def protocol_fingerprint(manifest: dict) -> tuple:
    """The tuple that must be identical across a streak (spec §6 streak reset list)."""
    return (
        str(manifest.get("discovery_protocol_sha256", "")),
        str(manifest.get("canonicalizer_sha256", "")),
        str(manifest.get("model_id", "")),
        str(manifest.get("temperature", "")),
        str(manifest.get("value_rubric_version", "")),
        str(manifest.get("materiality_rule_version", "")),
        int(manifest.get("K", -1)),
        json.dumps(manifest.get("family_quotas", {}), sort_keys=True),
        json.dumps({k: manifest.get(k) for k in ("V_accept", "V_critical", "N", "delta")},
                   sort_keys=True),
        # Changing the approved budget mid-run is a protocol change: it zeroes
        # the streak rather than silently unlocking PASS_WITH_BACKLOG.
        str(manifest.get("approved_discovery_budget_rounds", "")),
        str(manifest.get("min_new_surface_count", "")),
        str(manifest.get("slot_hash", "")),
    )


RECHECK_COLUMNS = ("candidate_id", "reviewer_verdict", "reason")
RECHECK_VERDICTS = {"confirmed_identical", "actually_distinct"}

DEGENERATE_DISPOSITION_NAME = "10_probe_degenerate_disposition.json"
DEGENERATE_DISPOSITIONS = {"probe_protocol_fixed", "round_rerun", "accepted_by_human"}


def degenerate_disposition(rdir: Path) -> tuple[bool, str]:
    """Has this probe_degenerate round been explicitly dealt with by a human?

    Returns (disposed, why-not). Requires a landed record so the blocker cannot
    quietly expire once later rounds push this one out of the streak window.
    """
    path = rdir / DEGENERATE_DISPOSITION_NAME
    if not path.is_file():
        return False, f"{DEGENERATE_DISPOSITION_NAME} is missing"
    try:
        doc = read_json(path)
    except json.JSONDecodeError as exc:
        return False, f"{DEGENERATE_DISPOSITION_NAME} is malformed: {exc}"
    if not isinstance(doc, dict):
        return False, f"{DEGENERATE_DISPOSITION_NAME} must be a JSON object"
    disposition = str(doc.get("disposition", "")).strip().lower()
    if disposition not in DEGENERATE_DISPOSITIONS:
        return False, ("disposition must be one of "
                       + "/".join(sorted(DEGENERATE_DISPOSITIONS))
                       + f", got {disposition or '<empty>'}")
    if not str(doc.get("reason", "")).strip():
        return False, "disposition has an empty reason"
    if not str(doc.get("approval_ref", "")).strip():
        return False, "disposition has no approval_ref"
    return True, ""


ROUND_KINDS = ("calibration", "active")
MAX_CALIBRATION_ROUNDS = 3


def round_kind(manifest: dict) -> str:
    """`calibration` or `active`. Never inferred from the directory number."""
    kind = str(manifest.get("round_kind", "")).strip().lower()
    if kind in ROUND_KINDS:
        return kind
    # Back-compat with the first v0.7.0 manifests, which only had a boolean.
    return "calibration" if manifest.get("calibration_round") is True else "active"


def slot_hash(rows: list[dict]) -> str:
    payload = "\n".join(f"{r['candidate_id']}|{r['probe_family']}|{r['probe_slot']}"
                        for r in rows)
    return sha256_text(payload)


# --------------------------------------------------------------------------
# prepare-round
# --------------------------------------------------------------------------

def build_slots(round_number: int, const: dict) -> list[dict]:
    rows = []
    slot = 0
    for family, short, _r, _n in PROBE_FAMILIES:
        quota = const["family_quotas"][family]
        for i in range(quota):
            slot += 1
            rows.append({
                "round_id": f"r{round_number:02d}",
                "candidate_id": f"r{round_number:02d}-{short}-{i + 1:03d}",
                "probe_family": family,
                "probe_slot": str(slot),
            })
    return rows


def cmd_prepare_round(args) -> int:
    project_root = args.project_root.resolve()
    const, doc, failures = load_profile(project_root)
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 2

    # Freeze ordering: the protocol must be frozen BEFORE any candidate exists,
    # otherwise "frozen before round 1" is unprovable after the fact.
    if doc.get("profile_frozen") is not True:
        print("FAIL: state/convergence_profile.json has profile_frozen != true — freeze the "
              "profile and protocol before generating candidates")
        return 2
    declared_protocol = str(doc.get("discovery_protocol_sha256", "")).strip()
    protocol_path = project_root / PROTOCOL_REL
    if not declared_protocol:
        print("FAIL: convergence_profile.discovery_protocol_sha256 is empty — pin the probe "
              "templates / schema / rubric before generating candidates")
        return 2
    if not protocol_path.is_file():
        print(f"FAIL: {PROTOCOL_REL} is missing — it must hold the seven probe family templates "
              "that discovery_protocol_sha256 pins")
        return 2
    if declared_protocol != sha256_file(protocol_path):
        print(f"FAIL: discovery_protocol_sha256 does not match the actual sha256 of "
              f"{PROTOCOL_REL}")
        return 2
    # Validate the protocol's CONTENT here too, so a project learns its rule
    # table is unusable before it spends a round generating K candidates.
    _protocol, protocol_content_failures = validate_discovery_protocol(project_root)
    if protocol_content_failures:
        for message in protocol_content_failures:
            print(f"FAIL: {message}")
        return 2

    rdir = round_dir(project_root, args.round)
    base_prompts = rdir / "00_base_prompts.csv"
    base_registry = rdir / "00_base_registry.csv"
    missing = [str(p) for p in (base_prompts, base_registry) if not p.is_file()]
    if missing:
        print("FAIL: freeze the baseline BEFORE generating candidates; missing: "
              + ", ".join(missing))
        return 2

    candidates = rdir / "01_discovery_candidates.csv"
    if candidates.is_file() and not args.force:
        print(f"FAIL: {candidates} already exists (use --force to regenerate; this zeroes the round)")
        return 2

    rows = build_slots(args.round, const)
    write_csv(candidates, STAGE1_COLUMNS, rows)

    prev_manifest_sha = ""
    if args.round > 1:
        prev = round_dir(project_root, args.round - 1) / "00_round_manifest.json"
        if prev.is_file():
            prev_manifest_sha = sha256_file(prev)

    manifest = {
        "round_id": f"r{args.round:02d}",
        "round_number": args.round,
        "convergence_method": CONVERGENCE_METHOD,
        "profile": const["profile"],
        "K": const["K"],
        "V_accept": const["V_accept"],
        "V_critical": const["V_critical"],
        "N": const["N"],
        "delta": const["delta"],
        "streak_required": const["streak"],
        "max_round": const["max_round"],
        "family_quotas": const["family_quotas"],
        "min_new_surface_count": const["min_new_surface_count"],
        "slot_hash": slot_hash(rows),
        "base_map_sha256": sha256_file(base_prompts),
        "base_registry_sha256": sha256_file(base_registry),
        "previous_round_manifest_sha256": prev_manifest_sha,
        "discovery_protocol_sha256": str(doc.get("discovery_protocol_sha256", "")),
        "canonicalizer_sha256": canonicalizer_sha256(),
        "model_id": args.model_id,
        "temperature": str(args.temperature),
        "value_rubric_version": VALUE_RUBRIC_VERSION,
        "materiality_rule_version": MATERIALITY_RULE_VERSION,
        "convergence_method": CONVERGENCE_METHOD,
        "approved_discovery_budget_rounds": doc.get("approved_discovery_budget_rounds"),
        # Round TYPE is declared here, never inferred from the directory number.
        # Calibration rounds do not advance coverage_round and never count
        # toward max_round (spec §6).
        "round_kind": "calibration" if args.calibration else "active",
        "calibration_round": bool(args.calibration),
        # Binds the previous round's living registry, so registry stuffing
        # cannot be hidden by editing the earlier round after the fact.
        "previous_registry_sha256": (
            sha256_file(round_dir(project_root, args.round - 1) / "06_round_registry.csv")
            if args.round > 1
            and (round_dir(project_root, args.round - 1) / "06_round_registry.csv").is_file()
            else ""),
    }
    if args.round > 1 and not prev_manifest_sha:
        print(f"FAIL: r{args.round:02d} has no r{args.round - 1:02d} manifest to chain to — "
              "the round history must be contiguous")
        return 2
    write_json(rdir / "00_round_manifest.json", manifest)
    print(json.dumps({"status": "OK", "round_dir": str(rdir), "candidates": len(rows),
                      "slot_hash": manifest["slot_hash"]}, ensure_ascii=False, indent=2))
    return 0


# --------------------------------------------------------------------------
# Round recomputation — the one implementation used by score-round AND verify.
# --------------------------------------------------------------------------

def recompute_round(rdir: Path, const: dict, approved_rules: set[str] | None,
                    profile_doc: dict | None = None) -> dict:
    """Recompute a whole discovery round from its FROZEN inputs only.

    Reads 00_round_manifest.json, 00_base_prompts.csv, 01_discovery_candidates.csv
    and 02_discovery_values.csv. It never reads a derived column back.
    """
    res: dict = {"round_dir": str(rdir), "failures": [], "reviews": [], "ledger_rows": [],
                 "accepted": []}
    fail = res["failures"].append

    manifest_path = rdir / "00_round_manifest.json"
    if not manifest_path.is_file():
        fail(f"{rdir.name}: 00_round_manifest.json is missing")
        return res
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict):
        fail(f"{rdir.name}: 00_round_manifest.json must be a JSON object")
        return res
    res["manifest"] = manifest
    kind = round_kind(manifest)
    res["round_kind"] = kind
    res["calibration_round"] = kind == "calibration"
    if str(manifest.get("round_kind", "")).strip().lower() not in ROUND_KINDS:
        fail(f"{rdir.name}: round manifest must declare round_kind as one of {ROUND_KINDS}")
    if str(manifest.get("convergence_method", CONVERGENCE_METHOD)) != CONVERGENCE_METHOD:
        fail(f"{rdir.name}: round manifest convergence_method must be {CONVERGENCE_METHOD!r}")
    if profile_doc is not None:
        frozen_protocol = str(profile_doc.get("discovery_protocol_sha256", "")).strip()
        if str(manifest.get("discovery_protocol_sha256", "")).strip() != frozen_protocol:
            fail(f"{rdir.name}: round manifest discovery_protocol_sha256 does not match the "
                 "frozen convergence_profile (this round ran a different protocol)")
        if manifest.get("approved_discovery_budget_rounds") != \
                profile_doc.get("approved_discovery_budget_rounds"):
            fail(f"{rdir.name}: round manifest approved_discovery_budget_rounds does not match "
                 "the frozen profile (changing the budget is a protocol revision)")

    # The manifest is NOT allowed to redefine the budget or the thresholds.
    # Without this, a streak of two self-consistent manifests declaring K=1
    # would satisfy every other check.
    for key, expected in (("K", const["K"]), ("V_accept", const["V_accept"]),
                          ("V_critical", const["V_critical"]), ("N", const["N"]),
                          ("delta", const["delta"]), ("profile", const["profile"]),
                          ("family_quotas", const["family_quotas"]),
                          ("streak_required", const["streak"]),
                          ("min_new_surface_count", const["min_new_surface_count"]),
                          ("max_round", const["max_round"])):
        if key not in manifest:
            fail(f"{rdir.name}: round manifest is missing '{key}'")
        elif manifest[key] != expected:
            fail(f"{rdir.name}: round manifest {key}={manifest[key]!r} != frozen profile "
                 f"{expected!r} (a round may not redefine the protocol)")
    if str(manifest.get("canonicalizer_sha256", "")) != canonicalizer_sha256():
        fail(f"{rdir.name}: the canonicalizer changed since this round was frozen "
             "(re-run the round under the new protocol; the streak is zero)")
    if str(manifest.get("value_rubric_version", "")) != VALUE_RUBRIC_VERSION:
        fail(f"{rdir.name}: round manifest value_rubric_version != {VALUE_RUBRIC_VERSION}")
    if str(manifest.get("materiality_rule_version", "")) != MATERIALITY_RULE_VERSION:
        fail(f"{rdir.name}: round manifest materiality_rule_version != {MATERIALITY_RULE_VERSION}")

    base_path = rdir / "00_base_prompts.csv"
    cand_path = rdir / "01_discovery_candidates.csv"
    values_path = rdir / "02_discovery_values.csv"
    for path in (base_path, cand_path):
        if not path.is_file():
            fail(f"{rdir.name}: {path.name} is missing")
            return res

    # (4/5) baseline binding: the manifest hash must still match the base file.
    actual_base = sha256_file(base_path)
    if str(manifest.get("base_map_sha256", "")) != actual_base:
        fail(f"{rdir.name}: 00_base_prompts.csv changed after the round manifest was frozen")
    registry_path = rdir / "00_base_registry.csv"
    if registry_path.is_file():
        if str(manifest.get("base_registry_sha256", "")) != sha256_file(registry_path):
            fail(f"{rdir.name}: 00_base_registry.csv changed after the manifest was frozen")
    else:
        fail(f"{rdir.name}: 00_base_registry.csv is missing")

    base_rows = read_csv(base_path)
    base_signatures = {sig_str(r) for r in base_rows if valid_surface(r)}
    base_ids = {}
    for r in base_rows:
        if valid_surface(r):
            base_ids.setdefault(sig_str(r), r.get("prompt_id", ""))

    candidates = read_csv(cand_path)
    header = set(candidates[0]) if candidates else set()
    for col in STAGE1_FORBIDDEN:
        if col in header:
            fail(f"{rdir.name}: Stage 1 must not contain the script-owned column '{col}'")
    for col in STAGE1_COLUMNS:
        if candidates and col not in header:
            fail(f"{rdir.name}: Stage 1 is missing required column '{col}'")

    # (1) exactly K rows
    K = int(manifest.get("K", const["K"]))
    if len(candidates) != K:
        fail(f"{rdir.name}: Stage 1 has {len(candidates)} rows, expected exactly K={K}")

    # (2) probe family quotas
    quotas = manifest.get("family_quotas", const["family_quotas"])
    actual_family: dict[str, int] = {}
    for row in candidates:
        actual_family[row.get("probe_family", "")] = actual_family.get(row.get("probe_family", ""), 0) + 1
    for family, quota in quotas.items():
        if actual_family.get(family, 0) != quota:
            fail(f"{rdir.name}: probe family '{family}' has {actual_family.get(family, 0)} rows, "
                 f"quota is {quota}")
    stray = sorted(set(actual_family) - set(quotas))
    if stray:
        fail(f"{rdir.name}: Stage 1 has unknown probe families: {', '.join(stray)}")

    # (3) candidate/slot ids unique + complete, and identical to the pre-hashed slots
    ids = [r.get("candidate_id", "").strip() for r in candidates]
    if any(not i for i in ids):
        fail(f"{rdir.name}: Stage 1 has row(s) with an empty candidate_id")
    dups = sorted({i for i in ids if i and ids.count(i) > 1})
    if dups:
        fail(f"{rdir.name}: duplicate candidate_id(s): {', '.join(dups)}")
    if manifest.get("slot_hash") and slot_hash([
            {"candidate_id": r.get("candidate_id", ""), "probe_family": r.get("probe_family", ""),
             "probe_slot": r.get("probe_slot", "")} for r in candidates]) != manifest["slot_hash"]:
        fail(f"{rdir.name}: candidate/probe slots differ from the slot_hash frozen before the round")

    # (5/6) novelty recomputed against the frozen base, canonicalizer re-run
    seen_round: set[str] = set()
    novelty: dict[str, dict] = {}
    for row in candidates:
        cid = row.get("candidate_id", "")
        sig = sig_str(row)
        if not valid_surface(row):
            status, identical, nearest = NOVELTY_INVALID, "", ""
        elif sig in base_signatures:
            status, identical, nearest = NOVELTY_IDENTICAL, sig, base_ids.get(sig, "")
        elif sig in seen_round:
            status, identical, nearest = NOVELTY_DUP, sig, ""
        else:
            status, identical, nearest = NOVELTY_NEW, "", ""
            seen_round.add(sig)
        novelty[cid] = {"canonical_surface_signature": sig, "novelty_status": status,
                        "identical_surface": identical, "nearest_prompt_id": nearest}
        if is_blank(row.get("decision_distinction")):
            fail(f"{rdir.name}/{cid}: decision_distinction is empty (required on every Stage 1 row)")

    counts = {s: sum(1 for v in novelty.values() if v["novelty_status"] == s)
              for s in (NOVELTY_NEW, NOVELTY_IDENTICAL, NOVELTY_DUP, NOVELTY_INVALID)}
    res["novelty_counts"] = counts

    # Anti-gaming: a "structurally valid" round is required for a frontier pass, so
    # blank/duplicate candidates cannot manufacture a low-value round.
    structurally_valid = K - counts[NOVELTY_INVALID] - counts[NOVELTY_DUP] if candidates else 0
    res["structurally_valid_count"] = structurally_valid

    # --- Anti-degenerate probe floor -------------------------------------
    # `structurally_valid` counts identical_existing rows as valid, so a lazy
    # agent could fill all K slots with surfaces copied out of the frozen base
    # map, score C=H=0, D=0, and "exhaust" the frontier in two rounds without
    # discovering anything. Real saturation looks like "we can still propose new
    # surfaces, but none of them clear the value bar" (new, V < V_accept), NOT
    # "we stopped proposing new surfaces": measured free-probe novelty on a rich
    # category was still 52.5%-65% at 512/578/687 prompts.
    #
    # This is NOT a "more new surfaces is better" reward. It is orthogonal to the
    # three frontier conditions: C/H/D judge whether the new surfaces are
    # VALUABLE ENOUGH; this judges whether the probe explored AT ALL.
    # The floor counts ATTEMPTED EXPLORATION, not signature novelty. Counting
    # `novelty_status == new` alone was bypassable: `hypothesis` is a legal
    # support_mode that scores E=0 and is merely materiality-rejected, so K-minus-
    # min_new copied rows plus min_new fabricated, evidence-free `hypothesis` rows
    # cleared the floor while discovering nothing.
    #
    # Deliberately NOT "the new surfaces must clear the value bar" — that would
    # duplicate C/H/D and could never be satisfied at true saturation. A direct/
    # derived candidate with resolvable evidence and V < V_accept is exactly what
    # real saturation looks like and DOES count here. Only candidates that never
    # even attempted to cite evidence are excluded.
    min_new = int(manifest.get("min_new_surface_count", const["min_new_surface_count"]))
    new_count = counts[NOVELTY_NEW]
    res["min_new_surface_count"] = min_new
    res["new_surface_count"] = new_count  # diagnostic only — no longer the criterion

    # Deterministic re-check sample of identical_existing rows + conflicting claims.
    identical_ids = sorted(cid for cid, v in novelty.items()
                           if v["novelty_status"] == NOVELTY_IDENTICAL)
    recheck = sorted(identical_ids,
                     key=lambda c: hashlib.sha256(f"{rdir.name}|recheck|{c}".encode()).hexdigest()
                     )[:min(5, len(identical_ids))]
    res["identical_recheck_sample"] = recheck

    # The deterministic re-check sample is ENFORCED, not merely reported: every
    # sampled row needs a landed verdict, and a single `actually_distinct`
    # verdict means the canonicalizer wrongly folded a real new surface into the
    # base — the round's Stage 2 must be re-run.
    recheck_path = rdir / "09_identical_recheck.csv"
    recheck_complete = not recheck
    if recheck:
        if not recheck_path.is_file():
            fail(f"{rdir.name}: 09_identical_recheck.csv is missing — the {len(recheck)} "
                 "deterministically sampled identical_existing row(s) must be re-checked")
        else:
            rc_rows = read_csv(recheck_path)
            rc_header = set(rc_rows[0]) if rc_rows else set()
            missing_cols = [c for c in RECHECK_COLUMNS if c not in rc_header]
            if missing_cols:
                fail(f"{rdir.name}: 09_identical_recheck.csv is missing column(s): "
                     + ", ".join(missing_cols))
            verdicts = {r.get("candidate_id", "").strip(): r for r in rc_rows}
            unreviewed = [c for c in recheck if c not in verdicts]
            if unreviewed:
                fail(f"{rdir.name}: identical_existing re-check is incomplete, no verdict for: "
                     + ", ".join(unreviewed))
            bad_verdict, no_reason, distinct = [], [], []
            for cid in recheck:
                row = verdicts.get(cid)
                if row is None:
                    continue
                verdict = str(row.get("reviewer_verdict", "")).strip().lower()
                if verdict not in RECHECK_VERDICTS:
                    bad_verdict.append(f"{cid}={verdict or '<empty>'}")
                elif verdict == "actually_distinct":
                    distinct.append(cid)
                if not str(row.get("reason", "")).strip():
                    no_reason.append(cid)
            if bad_verdict:
                fail(f"{rdir.name}: reviewer_verdict must be one of {sorted(RECHECK_VERDICTS)}: "
                     + ", ".join(bad_verdict))
            if no_reason:
                fail(f"{rdir.name}: identical_existing re-check rows need a reason: "
                     + ", ".join(no_reason))
            if distinct:
                fail(f"{rdir.name}: re-check found {len(distinct)} surface(s) judged "
                     "actually_distinct after being auto-folded into the base "
                     f"({', '.join(distinct)}) — the novelty verdict is wrong; fix the surface "
                     "or the canonicalizer and re-run Stage 2 for this round")
            recheck_complete = not (unreviewed or bad_verdict or no_reason or distinct)
    res["identical_recheck_complete"] = recheck_complete

    distinction_by_id = {r.get("candidate_id", ""): r.get("decision_distinction", "")
                         for r in candidates}
    for cid in identical_ids:
        text = str(distinction_by_id.get(cid, "")).strip().lower()
        if text and re.search(r"\bnew\b|新的?(准则|标准|维度)|different criterion", text):
            res["reviews"].append(
                f"{cid}: identical_existing but decision_distinction claims a new criterion")

    # Stage 2 must exist iff there are new rows; ID sets must match exactly.
    new_ids = {cid for cid, v in novelty.items() if v["novelty_status"] == NOVELTY_NEW}
    values_rows: list[dict] = []
    if values_path.is_file():
        values_rows = read_csv(values_path)
        vheader = set(values_rows[0]) if values_rows else set()
        for col in STAGE2_FORBIDDEN:
            if col in vheader:
                fail(f"{rdir.name}: Stage 2 must not contain the script-owned column '{col}'")
        for col in STAGE2_COLUMNS:
            if values_rows and col not in vheader:
                fail(f"{rdir.name}: Stage 2 is missing required column '{col}'")
    elif new_ids:
        fail(f"{rdir.name}: 02_discovery_values.csv is missing but {len(new_ids)} new surfaces exist")

    value_ids = [r.get("candidate_id", "").strip() for r in values_rows]
    vdups = sorted({i for i in value_ids if i and value_ids.count(i) > 1})
    if vdups:
        fail(f"{rdir.name}: Stage 2 has duplicate candidate_id(s): {', '.join(vdups)}")
    if set(value_ids) != new_ids:
        only_new = sorted(new_ids - set(value_ids))
        only_val = sorted(set(value_ids) - new_ids)
        if only_new:
            fail(f"{rdir.name}: new surfaces missing from Stage 2: {', '.join(only_new[:10])}"
                 + (" ..." if len(only_new) > 10 else ""))
        if only_val:
            fail(f"{rdir.name}: Stage 2 scores non-new candidates: {', '.join(only_val[:10])}"
                 + (" ..." if len(only_val) > 10 else ""))
    if len(value_ids) != len(set(value_ids)):
        fail(f"{rdir.name}: Stage 2 row count {len(value_ids)} != unique ids {len(set(value_ids))}")

    values_by_id = {r.get("candidate_id", "").strip(): r for r in values_rows}

    # Evidence refs must resolve into the project's evidence index when it
    # exists; the index is also what demand counts are recomputed from.
    evidence_index: dict[str, dict] | None = None
    index_path = rdir.parents[1] / "02_evidence_index.csv"
    if index_path.is_file():
        evidence_index = {r["evidence_id"].strip(): r for r in read_csv(index_path)
                          if r.get("evidence_id", "").strip()}

    # (7/8/9) materiality, V, then C/H/M/D
    ledger: list[dict] = []
    accepted: list[dict] = []
    exploratory_ids: list[str] = []
    C = H = 0
    M = 0.0
    for row in candidates:
        cid = row.get("candidate_id", "")
        nov = novelty.get(cid, {})
        entry = {c: row.get(c, "") for c in STAGE1_COLUMNS}
        entry.update(nov)
        if nov.get("novelty_status") == NOVELTY_NEW and cid in values_by_id:
            derived = evaluate_candidate(row, values_by_id[cid], const, approved_rules,
                                         evidence_index)
            entry.update({k: v for k, v in derived.items() if not k.startswith("_")})
            if evidence_index is not None:
                bad = [r for r in split_refs(row.get("evidence_refs")) if r not in evidence_index]
                if bad:
                    fail(f"{rdir.name}/{cid}: evidence_refs not in work/02_evidence_index.csv: "
                         + ", ".join(bad[:5]))
            if derived["_problems"]:
                fail(f"{rdir.name}/{cid}: " + "; ".join(derived["_problems"][:3]))
            # Counts toward the anti-degenerate floor only if this candidate
            # actually TRIED to gather evidence: a real support mode plus at
            # least one evidence ref that resolves in the frozen index.
            resolvable = [r for r in split_refs(row.get("evidence_refs"))
                          if evidence_index is not None and r in evidence_index]
            if derived["support_mode"] in ("direct", "derived") and resolvable:
                exploratory_ids.append(cid)
            if derived["_accepted"]:
                C += 1
                M += derived["_value_score"]
                if derived["_critical"]:
                    H += 1
                accepted.append({
                    "round_id": entry.get("round_id", rdir.name),
                    "candidate_id": cid,
                    "canonical_surface_signature": nov.get("canonical_surface_signature", ""),
                    **{f: row.get(f, "") for f in SURFACE_FIELDS},
                    "conditional_dimensions": row.get("conditional_dimensions", ""),
                    "evidence_code": derived["evidence_code"],
                    "product_impact_code": derived["product_impact_code"],
                    "derivation_rule_id": row.get("derivation_rule_id", ""),
                    "value_score": derived["value_score"],
                    "critical_value": derived["critical_value"],
                })
        else:
            entry.update({
                "support_mode": "", "evidence_code": "", "source_family_count": "",
                "direct_evidence_unit_count": "", "E": "", "D_reddit": "", "D_semrush": "",
                "D_geoly": "", "D_brand": "", "D": "", "P": "", "T": "", "value_score": "",
                "materiality_pass": "No", "value_gate_pass": "No", "critical_value": "No",
                "disposition": "rejected",
                "reason": f"novelty_status={nov.get('novelty_status', 'unknown')}",
            })
        ledger.append(entry)

    exploratory_new_count = len(exploratory_ids)
    probe_degenerate = exploratory_new_count < min_new
    res["exploratory_new_count"] = exploratory_new_count
    res["probe_degenerate"] = probe_degenerate
    if probe_degenerate:
        res["reviews"].append(
            f"probe_degenerate: only {exploratory_new_count} evidence-seeking new surface(s) out "
            f"of K={K} (floor is {min_new}; {new_count} signature-new rows, of which "
            f"{new_count - exploratory_new_count} were hypothesis-only or cited no resolvable "
            "evidence). The probe did not actually explore — either it was answered "
            "perfunctorily or the probe protocol / canonicalizer is broken. Both require human "
            "review; this round cannot pass the frontier gate.")

    M = q3(M)
    D_t = q6(M / K) if K else 0.0
    frontier_pass = bool(
        len(candidates) == K
        and structurally_valid == K
        # The probe must actually have explored (orthogonal to C/H/D) and its
        # identical_existing sample must have been re-checked.
        and not probe_degenerate
        and recheck_complete
        and H == 0
        and C <= const["N"]
        and D_t < const["delta"]
    )
    res.update({
        "K": K,
        "candidate_count": len(candidates),
        "accepted_material_count": C,
        "critical_new_count": H,
        "value_mass": M,
        "value_density": D_t,
        "frontier_passed": frontier_pass,
        "ledger_rows": ledger,
        "accepted": accepted,
        "novelty_map": novelty,
        "protocol_fingerprint": protocol_fingerprint(manifest),
    })
    return res


def summary_payload(res: dict, const: dict) -> dict:
    counts = res.get("novelty_counts", {})
    ledger = res.get("ledger_rows", [])
    scores = [as_float(r.get("value_score")) for r in ledger]
    scores = [s for s in scores if s is not None]

    def band(lo: float, hi: float | None) -> int:
        return sum(1 for s in scores if s >= lo and (hi is None or s < hi))

    by_family: dict[str, int] = {}
    by_reason: dict[str, int] = {}
    for row in ledger:
        if row.get("value_gate_pass") == "Yes":
            key = row.get("probe_family", "")
            by_family[key] = by_family.get(key, 0) + 1
        else:
            key = str(row.get("reason", "")).split("|")[0].strip()[:80]
            by_reason[key] = by_reason.get(key, 0) + 1
    return {
        "round_id": res.get("manifest", {}).get("round_id", ""),
        "convergence_method": CONVERGENCE_METHOD,
        "profile": const["profile"],
        "candidate_count": res.get("candidate_count", 0),
        "K": res.get("K", const["K"]),
        "structurally_valid_count": res.get("structurally_valid_count", 0),
        "new_surface_count": counts.get(NOVELTY_NEW, 0),
        "min_new_surface_count": res.get("min_new_surface_count", const["min_new_surface_count"]),
        "exploratory_new_count": res.get("exploratory_new_count", 0),
        "probe_degenerate": res.get("probe_degenerate", False),
        "identical_recheck_complete": res.get("identical_recheck_complete", False),
        "identical_existing_count": counts.get(NOVELTY_IDENTICAL, 0),
        "duplicate_within_round_count": counts.get(NOVELTY_DUP, 0),
        "invalid_surface_count": counts.get(NOVELTY_INVALID, 0),
        "hard_material_count": sum(1 for r in ledger if r.get("materiality_pass") == "Yes"),
        "accepted_material_count": res.get("accepted_material_count", 0),
        "critical_new_count": res.get("critical_new_count", 0),
        "value_mass": res.get("value_mass", 0.0),
        "value_density": res.get("value_density", 0.0),
        "frontier_passed": res.get("frontier_passed", False),
        "score_060_069_count": band(0.60, 0.70),
        "score_070_079_count": band(0.70, 0.80),
        "score_080_084_count": band(0.80, 0.85),
        "score_085_plus_count": band(0.85, None),
        "accepted_by_probe_family": by_family,
        "rejected_by_reason": by_reason,
        "identical_recheck_sample": res.get("identical_recheck_sample", []),
        "reviews": res.get("reviews", []),
        "failures": res.get("failures", []),
    }


def cmd_score_round(args) -> int:
    project_root = args.project_root.resolve()
    const, doc, pfail = load_profile(project_root)
    rules = approved_derivation_rules(project_root)
    rdir = round_dir(project_root, args.round)
    res = recompute_round(rdir, const, rules, doc)
    failures = pfail + res["failures"]

    write_csv(rdir / "03_discovery_ledger.csv", LEDGER_COLUMNS, res.get("ledger_rows", []))
    write_csv(rdir / "04_accepted_surfaces.csv", ACCEPTED_COLUMNS, res.get("accepted", []))
    write_json(rdir / "01_discovery_novelty.json", {
        "round_id": res.get("manifest", {}).get("round_id", rdir.name),
        "base_map_sha256": res.get("manifest", {}).get("base_map_sha256", ""),
        "canonicalizer_sha256": canonicalizer_sha256(),
        "novelty": res.get("novelty_map", {}),
        "counts": res.get("novelty_counts", {}),
    })
    summary = summary_payload(res, const)
    summary["ledger_sha256"] = sha256_file(rdir / "03_discovery_ledger.csv")
    summary["accepted_sha256"] = sha256_file(rdir / "04_accepted_surfaces.csv")
    summary["failures"] = failures
    write_json(rdir / "08_round_summary.json", summary)

    if args.emit_run_state_patch:
        # coverage_round counts ACTIVE rounds. The script knows each round's
        # round_kind, so it emits the correct number itself — a patch that a
        # human has to hand-correct is not a patch.
        active_so_far = 0
        calibration_so_far = 0
        for earlier in range(1, args.round + 1):
            man = round_dir(project_root, earlier) / "00_round_manifest.json"
            if not man.is_file():
                continue
            if round_kind(read_json(man)) == "calibration":
                calibration_so_far += 1
            else:
                active_so_far += 1
        patch = {
            "coverage_round": active_so_far,
            "calibration_round": calibration_so_far,
            "last_round_base_map_sha256": res.get("manifest", {}).get("base_map_sha256", ""),
            "last_round_base_registry_sha256": res.get("manifest", {}).get("base_registry_sha256", ""),
            "last_round_candidate_count": summary["candidate_count"],
            "last_round_new_surface_count": summary["new_surface_count"],
            "last_round_material_accepted_count": summary["accepted_material_count"],
            "last_round_critical_new_count": summary["critical_new_count"],
            "last_round_value_mass": summary["value_mass"],
            "last_round_value_density": summary["value_density"],
            "last_round_frontier_passed": summary["frontier_passed"],
            "last_round_ledger_sha256": summary["ledger_sha256"],
        }
        args.emit_run_state_patch.parent.mkdir(parents=True, exist_ok=True)
        args.emit_run_state_patch.write_text(
            json.dumps(patch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not failures else 2


# --------------------------------------------------------------------------
# Coverage Floor
# --------------------------------------------------------------------------

def sample_key(project_id: str, evidence_id: str) -> str:
    return sha256_text(f"{project_id}|{SAMPLING_KEY_VERSION}|{evidence_id}")


# Fixed order in which an exhausted source's unmet quota is handed to the
# sources that still have unsampled rows. Brand is never a floor source.
REALLOCATION_ORDER = ("reddit", "geoly", "semrush")


def _take_from_pool(available: list[dict], quota: int, stype: str,
                    project_id: str) -> list[dict]:
    """Hash order, except Semrush: first half by descending volume, rest by hash."""
    if quota <= 0:
        return []
    if stype != "semrush":
        return available[:quota]
    head_n = quota // 2  # floor division: an odd quota puts the extra row in the hash tail
    by_volume = sorted(available,
                       key=lambda r: (-(as_int(r.get("source_metric"), 0) or 0),
                                      sample_key(project_id, r["evidence_id"].strip())))
    head = by_volume[:head_n]
    head_ids = {r["evidence_id"].strip() for r in head}
    tail = [r for r in available if r["evidence_id"].strip() not in head_ids][:quota - head_n]
    return head + tail


def _floor_pools(rows: list[dict], project_id: str,
                 excluded: set[str]) -> dict[str, list[dict]]:
    pool: dict[str, list[dict]] = {s: [] for s in FLOOR_SOURCE_TYPES}
    for row in rows:
        eid = row.get("evidence_id", "").strip()
        stype = row.get("source_type", "").strip().lower()
        if not eid or eid in excluded:
            continue
        if str(row.get("floor_candidate", "")).strip().lower() not in ("yes", "true"):
            continue
        if stype in pool:
            pool[stype].append(row)
    for stype in pool:
        pool[stype].sort(key=lambda r: sample_key(project_id, r["evidence_id"].strip()))
    return pool


def top_up_floor_batch(rows: list[dict], project_id: str, deficit_by_source: dict[str, int],
                       already: set[str]) -> tuple[list[dict], dict]:
    """Fill a batch back up to n after the agent's eligibility exclusions.

    Same-source top-up first (each source replaces the rows IT lost), then the
    cross-source reallocation order `reddit -> geoly -> semrush` for any source
    whose pool is exhausted. Draws only from still-unsampled rows in hash order,
    so the top-up is as deterministic as the original draw.
    """
    pool = _floor_pools(rows, project_id, already)
    added: list[dict] = []
    chosen = set(already)
    exhausted: list[str] = []
    reallocated: dict[str, int] = {}
    shortfall = 0

    for stype in FLOOR_SOURCE_TYPES:
        need = deficit_by_source.get(stype, 0)
        if need <= 0:
            continue
        available = [r for r in pool[stype] if r["evidence_id"].strip() not in chosen]
        take = _take_from_pool(available, min(need, len(available)), stype, project_id)
        for row in take:
            added.append({"row": row, "quota_source": f"{stype}:topup"})
            chosen.add(row["evidence_id"].strip())
        if len(take) < need:
            exhausted.append(stype)
            shortfall += need - len(take)

    for stype in REALLOCATION_ORDER:
        if shortfall <= 0:
            break
        available = [r for r in pool[stype] if r["evidence_id"].strip() not in chosen]
        if not available:
            continue
        take = _take_from_pool(available, min(shortfall, len(available)), stype, project_id)
        for row in take:
            added.append({"row": row, "quota_source": f"{stype}:topup_reallocated"})
            chosen.add(row["evidence_id"].strip())
        reallocated[stype] = reallocated.get(stype, 0) + len(take)
        shortfall -= len(take)

    return added, {"floor_topup_added": len(added),
                   "floor_topup_reallocated": reallocated,
                   "floor_topup_source_pool_exhausted": exhausted,
                   "floor_topup_unfilled": max(0, shortfall)}


def select_floor_batch(rows: list[dict], project_id: str, quotas: dict[str, int],
                       excluded: set[str]) -> tuple[list[dict], dict]:
    """Deterministic Coverage Floor sample.

    Order of operations (spec §5 + the v0.7.0 reallocation amendment):
      1. draw each source's fixed quota in `sha256(project_id|key|evidence_id)`
         order; within the Semrush quota take the first half by descending
         volume and the rest by hash order;
      2. if a source's `floor_candidate=Yes` pool is exhausted, hand its unmet
         remainder to the sources that still have unsampled rows, in the fixed
         order reddit -> geoly -> semrush;
      3. report what was reallocated, so the gate can see it happened.

    Without step 2 a project with no Semrush input could never reach the
    nominal n, and would be stuck short-sampled forever.
    """
    pool = _floor_pools(rows, project_id, excluded)

    selected: list[dict] = []
    chosen: set[str] = set()
    exhausted: list[str] = []
    effective = dict.fromkeys(FLOOR_SOURCE_TYPES, 0)
    shortfall = 0

    # (1) fixed quotas
    for stype in FLOOR_SOURCE_TYPES:
        quota = quotas.get(stype, 0)
        if quota <= 0:
            continue
        take = _take_from_pool(pool[stype], quota, stype, project_id)
        for row in take:
            selected.append({"row": row, "quota_source": stype})
            chosen.add(row["evidence_id"].strip())
        effective[stype] = len(take)
        if len(take) < quota:
            exhausted.append(stype)
            shortfall += quota - len(take)

    # (2) cross-source reallocation of the unmet remainder
    reallocated: dict[str, int] = {}
    if shortfall:
        for stype in REALLOCATION_ORDER:
            if shortfall <= 0:
                break
            remaining = [r for r in pool[stype] if r["evidence_id"].strip() not in chosen]
            if not remaining:
                continue
            take = _take_from_pool(remaining, min(shortfall, len(remaining)), stype, project_id)
            for row in take:
                selected.append({"row": row, "quota_source": f"{stype}:reallocated"})
                chosen.add(row["evidence_id"].strip())
            effective[stype] += len(take)
            reallocated[stype] = reallocated.get(stype, 0) + len(take)
            shortfall -= len(take)

    report = {
        "floor_quota_original": {s: quotas.get(s, 0) for s in FLOOR_SOURCE_TYPES},
        "floor_quota_effective": effective,
        "floor_quota_reallocated": reallocated,
        "floor_source_pool_exhausted": exhausted,
        "floor_unfilled_quota": max(0, shortfall),
        "floor_pool_sizes": {s: len(pool[s]) for s in FLOOR_SOURCE_TYPES},
    }
    return selected, report


def cmd_prepare_floor(args) -> int:
    project_root = args.project_root.resolve()
    const, _doc, pfail = load_profile(project_root)
    if pfail:
        for f in pfail:
            print(f"FAIL: {f}")
        return 2

    index_path = project_root / "work" / "02_evidence_index.csv"
    if not index_path.is_file():
        print("FAIL: work/02_evidence_index.csv is missing (the floor sample must come from "
              "the frozen evidence index, never from the registry)")
        return 2
    rows = read_csv(index_path)
    header = set(rows[0]) if rows else set()
    missing = [c for c in EVIDENCE_INDEX_COLUMNS if c not in header]
    if missing:
        print(f"FAIL: 02_evidence_index.csv is missing columns: {', '.join(missing)}")
        return 2
    ids = [r.get("evidence_id", "").strip() for r in rows]
    dup = sorted({i for i in ids if i and ids.count(i) > 1})
    if dup:
        print(f"FAIL: duplicate evidence_id(s) in the evidence index: {', '.join(dup[:10])}")
        return 2

    project_json = project_root / "project.json"
    if not project_json.is_file():
        print("FAIL: project.json is missing (project_id anchors the sampling key)")
        return 2
    project_id = str(read_json(project_json).get("project_id", "")).strip()
    if not project_id:
        print("FAIL: project.json has no project_id")
        return 2

    excluded: set[str] = set()
    if args.batch > 1:
        for prior in range(1, args.batch):
            prior_csv = project_root / FLOOR_REL / f"batch{prior}" / "floor_batch.csv"
            if not prior_csv.is_file():
                print(f"FAIL: batch {args.batch} requested but batch {prior} was never drawn")
                return 2
            excluded |= {r.get("evidence_id", "").strip() for r in read_csv(prior_csv)}
    if args.batch > 2:
        print("FAIL: at most two coverage-floor batches are allowed")
        return 2

    bdir_existing = project_root / FLOOR_REL / f"batch{args.batch}"
    existing_csv = bdir_existing / "floor_batch.csv"
    if args.top_up:
        # Top-up mode: the batch was already judged and eligibility exclusions
        # left it below n. Fill it back up from still-unsampled rows, same-source
        # first. This is NOT a repair of a failing batch — a batch that fails the
        # Wilson bound must be followed by an independent batch 2.
        if not existing_csv.is_file():
            print(f"FAIL: --top-up needs an existing {existing_csv}")
            return 2
        current = read_csv(existing_csv)
        judged = [r for r in current if str(r.get("eligible", "")).strip()]
        if len(judged) != len(current):
            print(f"FAIL: --top-up requires every row to carry an eligible verdict "
                  f"({len(current) - len(judged)} row(s) unjudged)")
            return 2
        eligible = [r for r in current if str(r.get("eligible", "")).strip().lower()
                    in ("yes", "true")]
        deficit = const["coverage_floor_n"] - len(eligible)
        if deficit <= 0:
            print(json.dumps({"status": "OK", "note": "batch already has "
                              f"{len(eligible)} eligible rows (n={const['coverage_floor_n']}); "
                              "no top-up needed"}, ensure_ascii=False, indent=2))
            return 0
        by_source: dict[str, int] = {}
        for r in current:
            if str(r.get("eligible", "")).strip().lower() not in ("yes", "true"):
                s = str(r.get("source_type", "")).strip().lower()
                by_source[s] = by_source.get(s, 0) + 1
        already = {r.get("evidence_id", "").strip() for r in current} | excluded
        added, topup_report = top_up_floor_batch(rows, project_id, by_source, already)
        start = len(current)
        for offset, item in enumerate(added):
            row = item["row"]
            eid = row["evidence_id"].strip()
            current.append({
                "batch_id": f"batch{args.batch}", "sample_rank": str(start + offset + 1),
                "quota_source": item["quota_source"], "evidence_id": eid,
                "source_type": row.get("source_type", ""),
                "source_record_id": row.get("source_record_id", ""),
                "cluster_id": row.get("cluster_id", ""),
                "evidence_text": row.get("evidence_text", ""),
                "source_metric": row.get("source_metric", ""),
                "source_url": row.get("source_url", ""),
                "demand_theme_key": row.get("demand_theme_key", ""),
                "sample_key": sample_key(project_id, eid),
            })
        write_csv(existing_csv, FLOOR_COLUMNS, current)
        man_path = bdir_existing / "floor_batch_manifest.json"
        manifest = read_json(man_path)
        manifest["selected_count"] = len(current)
        manifest["selected_ids_sha256"] = sha256_text(
            "\n".join(r.get("evidence_id", "").strip() for r in current))
        manifest["topup_rounds"] = manifest.get("topup_rounds", 0) + 1
        manifest.update(topup_report)
        write_json(man_path, manifest)
        print(json.dumps({"status": "OK", "batch": f"batch{args.batch}",
                          "eligible_before": len(eligible), "deficit": deficit,
                          **topup_report, "rows_now": len(current)},
                         ensure_ascii=False, indent=2))
        return 0

    selected, report = select_floor_batch(rows, project_id, const["floor_quotas"], excluded)
    out_rows = []
    for rank, item in enumerate(selected, start=1):
        row = item["row"]
        eid = row["evidence_id"].strip()
        out_rows.append({
            "batch_id": f"batch{args.batch}", "sample_rank": str(rank),
            "quota_source": item["quota_source"], "evidence_id": eid,
            "source_type": row.get("source_type", ""), "source_record_id": row.get("source_record_id", ""),
            "cluster_id": row.get("cluster_id", ""), "evidence_text": row.get("evidence_text", ""),
            "source_metric": row.get("source_metric", ""), "source_url": row.get("source_url", ""),
            "demand_theme_key": row.get("demand_theme_key", ""),
            "sample_key": sample_key(project_id, eid),
        })

    bdir = project_root / FLOOR_REL / f"batch{args.batch}"
    write_csv(bdir / "floor_batch.csv", FLOOR_COLUMNS, out_rows)

    # The whole evidence pool can be smaller than the profile's nominal n. That
    # is a REDUCED-EVIDENCE run: the Wilson bound is still computed on the real
    # n, but the run may never claim a normal PASS.
    total_pool = sum(report["floor_pool_sizes"][s] for s in REALLOCATION_ORDER)
    pool_short = (total_pool + len(excluded)) < const["coverage_floor_n"]
    reduced_sources = sorted(s for s in REALLOCATION_ORDER
                             if report["floor_pool_sizes"][s] == 0
                             and const["floor_quotas"].get(s, 0) > 0)

    final_map = project_root / FINAL_MAP_REL
    manifest = {
        "batch_id": f"batch{args.batch}",
        "project_id": project_id,
        "profile": const["profile"],
        "coverage_floor_n": const["coverage_floor_n"],
        "coverage_floor_threshold": const["coverage_floor_threshold"],
        "sampling_key_version": SAMPLING_KEY_VERSION,
        "quotas": const["floor_quotas"],
        "selected_count": len(out_rows),
        "selected_ids_sha256": sha256_text("\n".join(r["evidence_id"] for r in out_rows)),
        "evidence_index_sha256": sha256_file(index_path),
        # Binds the batch to the map that existed when the sample was revealed:
        # repairing the map against a revealed batch invalidates that batch.
        "final_map_sha256_at_sampling": sha256_file(final_map) if final_map.is_file() else "",
        "excluded_prior_ids_count": len(excluded),
        "evidence_pool_short_of_n": pool_short,
        "reduced_evidence_sources": reduced_sources,
        **report,
    }
    write_json(bdir / "floor_batch_manifest.json", manifest)
    out = {"status": "OK", "batch": manifest["batch_id"], "rows": len(out_rows),
           "floor_quota_reallocated": report["floor_quota_reallocated"],
           "floor_source_pool_exhausted": report["floor_source_pool_exhausted"],
           "evidence_pool_short_of_n": pool_short,
           "reduced_evidence_sources": reduced_sources,
           "path": str(bdir / "floor_batch.csv")}
    if pool_short:
        out["warning"] = (f"the whole floor_candidate pool ({total_pool + len(excluded)}) is "
                          f"below coverage_floor_n={const['coverage_floor_n']} — this run is "
                          "capped at PASS_WITH_BACKLOG and can never emit a normal PASS")
    if reduced_sources:
        out.setdefault("warning", "")
        out["warning"] = (out["warning"] + " | " if out["warning"] else "") + \
            "no floor evidence at all from: " + ", ".join(reduced_sources)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def recompute_coverage_floor(project_root: Path, const: dict,
                             final_signatures: set[str], final_map: Path) -> dict:
    """(13/14) Re-draw the sample, recompute the Wilson bound, validate reasons.

    The batch is not trusted: the deterministic sampling is re-executed from the
    frozen evidence index and the selected IDs must match, so an agent cannot
    hand-pick easy-to-cover evidence and then write a matching manifest.
    """
    res: dict = {"failures": [], "batches": [], "passed": False, "mode": "evidence_sample",
                 "reduced_evidence_sources": [], "pool_short_of_n": False}
    fail = res["failures"].append
    froot = project_root / FLOOR_REL
    if not froot.is_dir():
        fail("work/coverage_floor/ is missing — the Coverage Floor was never sampled")
        return res

    batch_dirs = sorted((d for d in froot.iterdir()
                         if d.is_dir() and re.fullmatch(r"batch\d+", d.name)),
                        key=lambda d: int(d.name[5:]))
    if not batch_dirs:
        fail("no coverage-floor batch directories found")
        return res
    expected_names = [f"batch{i}" for i in range(1, len(batch_dirs) + 1)]
    if [d.name for d in batch_dirs] != expected_names:
        fail(f"coverage-floor batches must be exactly {expected_names}, found "
             f"{[d.name for d in batch_dirs]} (batch 1 may not be deleted)")
    if len(batch_dirs) > 2:
        fail(f"{len(batch_dirs)} coverage-floor batches found; at most two are allowed")

    index_path = project_root / "work" / "02_evidence_index.csv"
    if not index_path.is_file():
        fail("work/02_evidence_index.csv is missing — the floor sample cannot be re-drawn")
        return res
    index_rows = read_csv(index_path)
    index_sha = sha256_file(index_path)
    final_sha = sha256_file(final_map) if final_map.is_file() else ""

    project_json = project_root / "project.json"
    project_id = str(read_json(project_json).get("project_id", "")).strip() \
        if project_json.is_file() else ""
    if not project_id:
        fail("project.json / project_id is missing — the sampling key cannot be reproduced")

    # Pool health is a property of the WHOLE evidence index, computed once.
    # Doing it per batch would misread "batch 1 already took everything from
    # this source" as "the project has no evidence from this source".
    full_pools = _floor_pools(index_rows, project_id, set()) if project_id else \
        {s: [] for s in FLOOR_SOURCE_TYPES}
    res["floor_pool_sizes_total"] = {s: len(v) for s, v in full_pools.items()}
    res["reduced_evidence_sources"] = sorted(
        s for s in REALLOCATION_ORDER
        if not full_pools[s] and const["floor_quotas"].get(s, 0) > 0)
    total_pool = sum(len(full_pools[s]) for s in REALLOCATION_ORDER)
    res["total_floor_candidate_rows"] = total_pool
    if project_id and total_pool < const["coverage_floor_n"]:
        res["pool_short_of_n"] = True

    last: dict | None = None
    prior_ids: set[str] = set()
    for bdir in batch_dirs:
        csv_path = bdir / "floor_batch.csv"
        man_path = bdir / "floor_batch_manifest.json"
        if not csv_path.is_file() or not man_path.is_file():
            fail(f"{bdir.name}: floor_batch.csv / floor_batch_manifest.json missing")
            continue
        manifest = read_json(man_path)
        rows = read_csv(csv_path)
        batch_ids = [r.get("evidence_id", "").strip() for r in rows]

        # Required bindings — a missing hash must not skip its check.
        for key in ("evidence_index_sha256", "selected_ids_sha256", "sampling_key_version",
                    "project_id"):
            if not str(manifest.get(key, "")).strip():
                fail(f"{bdir.name}: floor manifest is missing '{key}'")
        if str(manifest.get("sampling_key_version", SAMPLING_KEY_VERSION)) != SAMPLING_KEY_VERSION:
            fail(f"{bdir.name}: sampling_key_version != {SAMPLING_KEY_VERSION}")
        if project_id and str(manifest.get("project_id", project_id)) != project_id:
            fail(f"{bdir.name}: floor manifest project_id does not match project.json")
        if manifest.get("evidence_index_sha256") != index_sha:
            fail(f"{bdir.name}: work/02_evidence_index.csv changed after the batch was drawn")
        if manifest.get("selected_ids_sha256") != sha256_text("\n".join(batch_ids)):
            fail(f"{bdir.name}: sampled evidence_id set was edited after sampling")

        # Re-execute the deterministic sampling and compare. Top-up rows are
        # appended after the original draw, so compare the base prefix first.
        base_rows = [r for r in rows if "topup" not in str(r.get("quota_source", ""))]
        topup_rows = [r for r in rows if "topup" in str(r.get("quota_source", ""))]
        if project_id:
            redrawn, report = select_floor_batch(index_rows, project_id,
                                                 const["floor_quotas"], prior_ids)
            expected_ids = [item["row"]["evidence_id"].strip() for item in redrawn]
            base_ids = [r.get("evidence_id", "").strip() for r in base_rows]
            if expected_ids != base_ids:
                fail(f"{bdir.name}: the batch is not the deterministic sample for this "
                     "project_id + evidence index (evidence was hand-picked)")
            if topup_rows:
                deficit_by_source: dict[str, int] = {}
                for r in base_rows:
                    if str(r.get("eligible", "")).strip().lower() not in ("yes", "true"):
                        s = str(r.get("source_type", "")).strip().lower()
                        deficit_by_source[s] = deficit_by_source.get(s, 0) + 1
                expected_topup, _ = top_up_floor_batch(
                    index_rows, project_id, deficit_by_source, set(base_ids) | prior_ids)
                exp_ids = [i["row"]["evidence_id"].strip() for i in expected_topup]
                got_ids = [r.get("evidence_id", "").strip() for r in topup_rows]
                if exp_ids[:len(got_ids)] != got_ids:
                    fail(f"{bdir.name}: the top-up rows are not the deterministic same-source "
                         "continuation (top-up evidence was hand-picked)")
            # Script-owned prefilled columns must still match the evidence index:
            # keeping the ID but rewriting the text/metric would fake the sample.
            index_by_id = {r.get("evidence_id", "").strip(): r for r in index_rows}
            drift = []
            for r in rows:
                src = index_by_id.get(r.get("evidence_id", "").strip())
                if src is None:
                    continue
                for col in ("source_type", "source_record_id", "cluster_id", "evidence_text",
                            "source_metric", "source_url", "demand_theme_key"):
                    if str(r.get(col, "")).strip() != str(src.get(col, "")).strip():
                        drift.append(f"{r.get('evidence_id')}:{col}")
                if str(r.get("sample_key", "")).strip() != \
                        sample_key(project_id, r.get("evidence_id", "").strip()):
                    drift.append(f"{r.get('evidence_id')}:sample_key")
            if drift:
                fail(f"{bdir.name}: {len(drift)} prefilled field(s) differ from the evidence "
                     "index: " + ", ".join(drift[:8]) + (" ..." if len(drift) > 8 else ""))
            # The manifest's own reallocation report must match the
            # recomputation, so it cannot understate what was reallocated.
            for key in ("floor_quota_reallocated", "floor_source_pool_exhausted",
                        "floor_quota_effective"):
                if key in manifest and manifest[key] != report[key]:
                    fail(f"{bdir.name}: manifest {key}={manifest[key]!r} does not match the "
                         f"recomputed {report[key]!r}")
                res.setdefault(key, report[key])
            res.setdefault("floor_pool_sizes", report["floor_pool_sizes"])
        # Batch 2 must be drawn from still-unsampled evidence.
        overlap = sorted(set(batch_ids) & prior_ids)
        if overlap:
            fail(f"{bdir.name}: {len(overlap)} evidence row(s) already appeared in an earlier "
                 "batch (batch 2 must come from still-unsampled evidence): "
                 + ", ".join(overlap[:5]))
        prior_ids |= set(batch_ids)

        eligible, uncovered = [], []
        bad_reason, bad_flag, bad_surface = [], [], []
        for row in rows:
            flag = str(row.get("eligible", "")).strip().lower()
            eid = row.get("evidence_id", "?")
            if flag in ("yes", "true"):
                eligible.append(row)
                if sig_str(row) not in final_signatures:
                    uncovered.append(eid)
                if not valid_surface(row):
                    bad_surface.append(eid)
            elif flag in ("no", "false"):
                reason = str(row.get("exclusion_reason", "")).strip()
                if reason not in EXCLUSION_REASONS:
                    bad_reason.append(f"{eid}={reason or '<empty>'}")
            else:
                bad_flag.append(eid)
        if bad_flag:
            fail(f"{bdir.name}: {len(bad_flag)} row(s) have no Yes/No 'eligible' verdict "
                 "(the batch has not been judged): " + ", ".join(bad_flag[:8])
                 + (" ..." if len(bad_flag) > 8 else ""))
        if bad_surface:
            fail(f"{bdir.name}: {len(bad_surface)} eligible row(s) have an incomplete surface "
                 "(no null-faking): " + ", ".join(bad_surface[:8])
                 + (" ..." if len(bad_surface) > 8 else ""))
        if bad_reason:
            fail(f"{bdir.name}: {len(bad_reason)} exclusion_reason value(s) outside the closed "
                 "enum: " + ", ".join(bad_reason[:8]) + (" ..." if len(bad_reason) > 8 else ""))

        n, x = len(eligible), len(uncovered)
        entry = {"batch_id": bdir.name, "eligible_count": n, "uncovered_count": x,
                 "uncovered_evidence_ids": uncovered[:20]}
        if n <= 0:
            entry.update({"rate": None, "wilson_upper": None, "passed": False,
                          "note": "no eligible rows — the floor is not evaluable"})
        else:
            entry["rate"] = q6(x / n)
            entry["wilson_upper"] = q6(wilson_upper(x, n))
            # Normally n must reach the profile's nominal size. When the WHOLE
            # evidence pool is smaller than n, the bound stands on the real n
            # instead — but `pool_short_of_n` then caps the run at
            # PASS_WITH_BACKLOG, so a thin pool can never buy a normal PASS.
            big_enough = n >= const["coverage_floor_n"] or res["pool_short_of_n"]
            entry["passed"] = bool(
                big_enough and entry["wilson_upper"] < const["coverage_floor_threshold"])
            entry["sample_below_nominal_n"] = n < const["coverage_floor_n"]
        # Test-leakage guard: after the sample is revealed the map must not move.
        pinned = str(manifest.get("final_map_sha256_at_sampling", ""))
        if not pinned and bdir is batch_dirs[-1]:
            fail(f"{bdir.name}: floor manifest has no final_map_sha256_at_sampling — the batch "
                 "is not pinned to the map it was drawn against")
        if pinned and final_sha and pinned != final_sha and bdir is batch_dirs[-1]:
            entry["map_changed_after_sampling"] = True
            fail(f"{bdir.name}: work/05_prompt_final.csv changed after this batch was revealed — "
                 "draw an independent batch instead of repairing against a revealed sample")
        res["batches"].append(entry)
        last = entry

    if last is None:
        return res
    res.update({
        "eligible_count": last["eligible_count"],
        "uncovered_count": last["uncovered_count"],
        "rate": last["rate"],
        "wilson_upper": last["wilson_upper"],
        "batch_id": last["batch_id"],
        "batch_count": len(batch_dirs),
    })
    if last["eligible_count"] < const["coverage_floor_n"]:
        res["short_sample"] = True
    res["passed"] = bool(last.get("passed"))
    return res


# --------------------------------------------------------------------------
# verify
# --------------------------------------------------------------------------

def load_signatures(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return {sig_str(r) for r in read_csv(path) if valid_surface(r)}


def validate_closure_additions(path: Path, rejected_signatures: set[str],
                               label: str) -> tuple[list[dict], list[str]]:
    """Validate approved Closure-Stream registry additions.

    Returns (allowed rows, failures). Without this, any surface written
    into 06_closure_additions.csv would launder itself into the registry — in
    particular a surface Discovery had just REJECTED on value grounds could
    reappear as an "obligation" and shrink the frontier.
    """
    failures: list[str] = []
    if not path.is_file():
        return [], failures
    rows = read_csv(path)
    if not rows:
        return [], failures
    missing = [c for c in CLOSURE_REQUIRED_COLUMNS if c not in rows[0]]
    if missing:
        failures.append(f"{label}: 06_closure_additions.csv is missing required column(s): "
                        + ", ".join(missing))
        return [], failures

    allowed: list[dict] = []
    seen_ids: set[str] = set()
    for row in rows:
        cid = str(row.get("closure_addition_id", "")).strip()
        if not cid:
            failures.append(f"{label}: closure addition with an empty closure_addition_id")
            continue
        if cid in seen_ids:
            failures.append(f"{label}: duplicate closure_addition_id {cid}")
            continue
        seen_ids.add(cid)
        for field in ("source_gap_id", "evidence_refs", "approval_ref", "closure_reason"):
            if not str(row.get(field, "")).strip():
                failures.append(f"{label}/{cid}: closure addition has an empty {field}")
        if not valid_surface(row):
            failures.append(f"{label}/{cid}: closure addition has an incomplete surface")
            continue
        sig = sig_str(row)
        # A surface Discovery already rejected cannot be re-admitted through the
        # closure door without a separate, explicit human override.
        if sig in rejected_signatures and not str(row.get("human_override_ref", "")).strip():
            failures.append(
                f"{label}/{cid}: this surface was REJECTED by discovery in the same round; "
                "re-admitting it through closure requires a human_override_ref")
            continue
        allowed.append(row)
    return allowed, failures


IMMUTABLE_REGISTRY_FIELDS = (*SURFACE_FIELDS, "product_card_eligible", "surface_origin",
                             "introduced_round")


def registry_metadata_violations(prev_rows: list[dict], base_rows: list[dict],
                                 waived_cells: set[str], label: str) -> list[str]:
    """Row-level registry invariants between two rounds.

    Signature-set containment alone is not enough: keeping every signature but
    flipping `product_card_eligible` to No, moving `cell_status` from open to
    waived, rewriting `demand_cell_id`, or dropping one of two rows that share a
    signature all shrink the real obligation set while passing a set check.
    """
    failures: list[str] = []
    base_by_id: dict[str, dict] = {}
    for row in base_rows:
        cid = str(row.get("demand_cell_id", "")).strip()
        if not cid:
            failures.append(f"{label}: base registry row with an empty demand_cell_id")
            continue
        if cid in base_by_id:
            failures.append(f"{label}: duplicate demand_cell_id in the base registry: {cid}")
            continue
        base_by_id[cid] = row

    for row in prev_rows:
        cid = str(row.get("demand_cell_id", "")).strip()
        if not cid:
            continue
        current = base_by_id.get(cid)
        if current is None:
            failures.append(f"{label}: demand_cell_id {cid} disappeared from the registry "
                            "(obligations may not be deleted)")
            continue
        for field in IMMUTABLE_REGISTRY_FIELDS:
            if field not in row and field not in current:
                continue
            before = str(row.get(field, "")).strip()
            after = str(current.get(field, "")).strip()
            if before != after:
                failures.append(f"{label}: cell {cid} changed immutable field '{field}' "
                                f"({before!r} -> {after!r})")
        before_status = str(row.get("cell_status", "")).strip().lower()
        after_status = str(current.get("cell_status", "")).strip().lower()
        if before_status != after_status:
            if before_status == "open" and after_status == "covered":
                pass  # the only free transition
            elif before_status == "open" and after_status == "waived":
                if cid not in waived_cells:
                    failures.append(f"{label}: cell {cid} was waived without a matching row in "
                                    "06_waivers.csv")
            else:
                failures.append(f"{label}: cell {cid} made an illegal cell_status transition "
                                f"{before_status!r} -> {after_status!r} "
                                "(only open->covered, or open->waived with a waiver, is allowed)")
    return failures


def load_waived_cells(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return {str(r.get("demand_cell_id", "")).strip() for r in read_csv(path)
            if str(r.get("demand_cell_id", "")).strip()
            and str(r.get("waiver_approval_ref", "")).strip()
            and str(r.get("waiver_reason", "")).strip()}


TEMPLATE_RESOLUTIONS_REL = "state/template_resolutions.json"


def _recompute_template_detections(project_root: Path, final_map: Path) -> dict | None:
    """Re-run the template detector against the CURRENT map and TEST the ledger.

    A structurally valid resolution entry is not proof of resolution. The two
    editing verdicts make a falsifiable claim — `rewritten` and `merged` both
    assert "I changed the text, so this finding no longer fires" — so they are
    checked against the detector's CURRENT output: if the finding still fires,
    the claim is false and the item counts as unresolved.

    Only `human_waived` (which asserts "this frame is deliberate", and carries
    an approval_ref) may excuse a finding that still fires.
    """
    try:
        import validate_prompt_surface_quality as vpsq  # noqa: WPS433
    except ImportError:
        return None
    if not final_map.is_file():
        return None
    try:
        report = vpsq.audit(read_csv(final_map))
        entries, problems = vpsq._load_resolution_entries(project_root / TEMPLATE_RESOLUTIONS_REL)
        findings = [vpsq.finding_key(m) for m in report.get("reviews", [])]
    except (OSError, csv.Error, ValueError, KeyError, TypeError, AttributeError):
        return None

    unresolved: list[str] = []
    false_claims: list[str] = []
    for key in findings:
        entry = entries.get(key)
        if entry is None:
            unresolved.append(key)
            continue
        rtype = str(entry.get("resolution_type", "")).strip().lower()
        if rtype == "human_waived":
            continue  # deliberate frame, approved; may legitimately still fire
        # rewritten / merged claimed the text changed — but it still fires.
        false_claims.append(f"{key}({rtype})")
        unresolved.append(key)
    if false_claims:
        problems = list(problems) + [
            f"{len(false_claims)} resolution(s) claim rewritten/merged but the detector still "
            "fires the same finding on the current map: " + ", ".join(false_claims[:8])]
    return {"detected": len(findings), "resolved": len(findings) - len(unresolved),
            "unresolved": len(unresolved), "resolution_problems": problems,
            "false_resolution_claims": len(false_claims)}


def run(project_root: Path, stage: str = "final-audit",
        registry: Path | None = None,
        final_map: Path | None = None) -> tuple[str, list[str], dict]:
    """The convergence gate. Returns (status, failures, evidence).

    status ∈ {PASS, PASS_WITH_BACKLOG, CONTINUE, FAIL}. `failures` merges
    integrity failures and hard blockers; pending (not-yet-convergent)
    conditions are reported under evidence["pending"], not as failures, so a
    mid-run project reads CONTINUE rather than FAIL.
    """
    project_root = Path(project_root).resolve()
    integrity: list[str] = []      # tampering / missing / schema → FAIL
    blockers: list[str] = []       # unrecoverable → FAIL
    pending: list[str] = []        # not yet convergent → CONTINUE
    ev: dict = {"project_root": str(project_root), "stage": stage,
                "convergence_method": CONVERGENCE_METHOD,
                "canonicalizer_sha256": canonicalizer_sha256()}

    state_path = project_root / "state" / "run_state.json"
    if not state_path.is_file():
        return "FAIL", ["state/run_state.json is missing"], ev
    state = read_json(state_path)
    ev["run_state_schema"] = state.get("run_state_schema")
    if str(state.get("run_state_schema", "")) != RUN_STATE_SCHEMA:
        integrity.append(f"run_state_schema must be {RUN_STATE_SCHEMA}, got "
                         f"{state.get('run_state_schema')!r}")
    if str(state.get("convergence_method", "")) != CONVERGENCE_METHOD:
        integrity.append(f"run_state convergence_method must be {CONVERGENCE_METHOD!r}")

    try:
        const, doc, pfail = load_profile(project_root)
    except ConvergenceError as exc:
        return "FAIL", [str(exc)], ev
    integrity.extend(pfail)
    ev["profile"] = const["profile"]
    if doc.get("profile_frozen") is not True:
        integrity.append("convergence_profile.json is not frozen (set profile_frozen=true before "
                         "round 1; a missing flag is not frozen)")
    # The protocol hash must pin an actual artifact, not just be non-empty.
    declared_protocol = str(doc.get("discovery_protocol_sha256", "")).strip()
    protocol_path = project_root / PROTOCOL_REL
    if not declared_protocol:
        integrity.append("convergence_profile.discovery_protocol_sha256 is empty — the probe "
                         "templates / schema / rubric were never pinned")
    elif not protocol_path.is_file():
        integrity.append(f"{PROTOCOL_REL} is missing — discovery_protocol_sha256 pins nothing "
                         "(the seven probe family templates live in that file)")
    elif declared_protocol != sha256_file(protocol_path):
        integrity.append(f"convergence_profile.discovery_protocol_sha256 does not match the "
                         f"actual sha256 of {PROTOCOL_REL} (the probe protocol changed after "
                         "it was frozen)")
    # The hash pins a file; this checks that the file actually says something.
    protocol_doc, protocol_failures = validate_discovery_protocol(project_root)
    integrity.extend(protocol_failures)
    if str(state.get("convergence_profile", const["profile"])) != const["profile"]:
        integrity.append("run_state convergence_profile disagrees with the frozen profile")
    # run_state thresholds are advisory copies; they must not contradict the profile.
    for state_key, const_key in (("probe_budget_k", "K"), ("value_accept_threshold", "V_accept"),
                                 ("value_critical_threshold", "V_critical"),
                                 ("frontier_count_threshold", "N"),
                                 ("frontier_density_threshold", "delta"),
                                 ("frontier_required_streak", "streak"),
                                 ("max_round", "max_round")):
        if state_key in state and state[state_key] != const[const_key]:
            integrity.append(f"run_state {state_key}={state[state_key]!r} contradicts the frozen "
                             f"profile {const_key}={const[const_key]!r}")

    # --- Derivation rules: frozen, hashed, and cross-checked per family ---
    # The ONLY authority is the sha256-pinned protocol file. The profile may
    # carry a mirror copy for readability, but it is never a source: if it
    # disagrees, that is an integrity failure, not an alternative reading.
    protocol_rules, _family_rules = protocol_derivation_rules(protocol_doc)
    effective_rules = protocol_rules
    ev["approved_derivation_rule_ids"] = sorted(effective_rules)
    ev["derivation_rule_source"] = PROTOCOL_REL
    ev["derivation_rule_enforcement"] = (
        f"{PROTOCOL_REL}.approved_derivation_rule_ids is the only source; each family's "
        "allowed_derivation_rules must be a subset of it. A missing or empty table is an "
        "integrity FAILURE, not a way to switch derivation off — a project that does not use "
        "derivation declares the table normally and writes no support_mode=derived rows. The "
        "scoring path additionally treats an unresolvable rule table as E0_UNSUPPORTED, but that "
        "is defense in depth for a misconfigured project, not a supported configuration.")
    # There is no mirror copy in the profile at all. A second, editable home for
    # the rule list is either a contradiction to police or an empty field that
    # silently skips its own check — so the field simply does not exist.
    if "approved_derivation_rule_ids" in doc:
        integrity.append(
            "convergence_profile.json must not carry 'approved_derivation_rule_ids' — the rule "
            f"list lives only in the sha256-pinned {PROTOCOL_REL}. Delete the field.")
    # A leftover unhashed rule file must not sit there looking authoritative.
    legacy_rules = project_root / "state" / "derivation_rules.json"
    if legacy_rules.is_file():
        integrity.append(
            "state/derivation_rules.json exists but is NOT a rule source (it is unhashed). "
            f"Move the list into {PROTOCOL_REL}.approved_derivation_rule_ids and delete it.")
    # The per-family subset check now lives inside validate_discovery_protocol()
    # so the content validator is self-contained and cannot be bypassed by
    # calling it directly; its failures are already in `integrity` above.
    #
    # No `if not effective_rules:` note here on purpose. An empty rule table is
    # already an integrity failure from validate_discovery_protocol() above, so
    # a message describing "derivation is gracefully disabled" would document a
    # state this gate can never actually report.
    rules = effective_rules or None

    mid_run = stage == "round"
    final_map_path = Path(final_map) if final_map else project_root / FINAL_MAP_REL
    ev["final_map"] = str(final_map_path)
    if not final_map_path.is_file():
        (pending if mid_run else blockers).append(
            f"{final_map_path} is missing — nothing to verify coverage against")
        final_signatures: set[str] = set()
    else:
        final_signatures = load_signatures(final_map_path)
        ev["final_map_signature_count"] = len(final_signatures)
        if not final_signatures:
            (pending if mid_run else blockers).append(
                "final Prompt Map has no valid surfaces (empty or header-only)")

    # --- Gate A: Coverage Floor (13/14) -----------------------------------
    # The floor is measured against the SAME map the batch was pinned to, so a
    # `--final-map` override cannot dodge the test-leakage guard.
    floor = recompute_coverage_floor(project_root, const, final_signatures, final_map_path)
    ev["coverage_floor"] = {k: v for k, v in floor.items() if k != "failures"}
    floor_mode = str(state.get("coverage_floor_mode", "evidence_sample")).strip()
    ev["coverage_floor_mode"] = floor_mode
    degraded = floor_mode == "registry_proxy"

    if degraded:
        # Degraded mode never claims a Wilson bound and caps the run at backlog.
        # Its own preconditions are evaluated in isolation — an unrelated blocker
        # elsewhere must not silently decide whether the floor "passed".
        degraded_problems: list[str] = []
        if as_int(state.get("high_priority_uncovered_count"), 1) != 0:
            degraded_problems.append("registry_proxy floor requires high_priority_uncovered_count == 0")
        if state.get("human_backlog_delivery_approved") is not True:
            degraded_problems.append("registry_proxy floor requires explicit human approval")
        # The audits the degraded mode substitutes for must themselves be clean.
        for field in ("unresolved_query_surface_gap_count", "unresolved_intersection_gap_count"):
            if as_int(state.get(field), 1) != 0:
                degraded_problems.append(f"registry_proxy floor requires {field} == 0")
        blockers.extend(degraded_problems)
        floor_passed = not degraded_problems
        ev["coverage_floor"]["wilson_upper"] = None
        ev["coverage_floor"]["note"] = "registry_proxy: no Wilson bound, PASS_WITH_BACKLOG at best"
    elif floor_mode != "evidence_sample":
        integrity.append(f"coverage_floor_mode must be evidence_sample or registry_proxy, "
                         f"got {floor_mode!r}")
        floor_passed = False
    else:
        if mid_run and any("was never sampled" in f or "no coverage-floor batch" in f
                            for f in floor["failures"]):
            pending.append("the Coverage Floor has not been sampled yet")
        else:
            integrity.extend(floor["failures"])
        floor_passed = bool(floor.get("passed"))
        if not floor_passed:
            if floor.get("short_sample") and floor.get("batch_count", 0) < 2:
                pending.append(f"coverage floor sample too small "
                               f"({floor.get('eligible_count')} < {const['coverage_floor_n']}) — "
                               "top up or draw batch 2")
            elif floor.get("short_sample"):
                blockers.append(f"coverage floor eligible sample too small after two batches "
                                f"({floor.get('eligible_count')} < {const['coverage_floor_n']})")
            elif floor.get("batch_count", 0) >= 2:
                blockers.append("coverage floor failed on both batches")
            else:
                pending.append("coverage floor failed on batch 1 — supplement, then draw batch 2")

    # --- Gate B: Value Frontier (1-12) ------------------------------------
    numbers = discover_rounds(project_root)
    ev["rounds_on_disk"] = numbers
    streak_required = const["streak"]
    round_results: list[dict] = []
    frontier_exhausted = False

    all_results: dict[int, dict] = {}
    if not numbers:
        pending.append("no discovery rounds have been run")
    else:
        if numbers != list(range(1, max(numbers) + 1)):
            integrity.append(f"discovery round directories are not contiguous from r01: {numbers} "
                             "(a deleted round cannot be skipped)")

        # EVERY round is recomputed: obligations from early rounds must still be
        # honoured, and only recomputation can tell which rounds are calibration.
        for n in numbers:
            res = recompute_round(round_dir(project_root, n), const, rules, doc)
            integrity.extend(res["failures"])
            all_results[n] = res
            # (integrity) the on-disk ledger must equal the recomputation
            ledger_path = round_dir(project_root, n) / "03_discovery_ledger.csv"
            if ledger_path.is_file():
                disk_rows = read_csv(ledger_path)
                disk_ids = [r.get("candidate_id", "").strip() for r in disk_rows]
                if len(disk_ids) != len(set(disk_ids)):
                    integrity.append(f"r{n:02d}: 03_discovery_ledger.csv has duplicate "
                                     "candidate_id rows")
                on_disk = {r.get("candidate_id", "").strip(): r for r in disk_rows}
                fresh = {r.get("candidate_id", "").strip(): r for r in res.get("ledger_rows", [])}
                if set(on_disk) != set(fresh):
                    integrity.append(f"r{n:02d}: 03_discovery_ledger.csv candidate set differs "
                                     f"from the recomputation ({len(on_disk)} vs {len(fresh)} rows)")
                else:
                    checked = [c for c in LEDGER_COLUMNS if c != "reason"]
                    drift = [f"{cid}:{c}" for cid, a in on_disk.items() for c in checked
                             if str(a.get(c, "")).strip() != str(fresh[cid].get(c, "")).strip()]
                    if drift:
                        integrity.append(f"r{n:02d}: ledger was edited after scoring "
                                         f"({len(drift)} field(s), e.g. {', '.join(drift[:5])})")
            else:
                integrity.append(f"r{n:02d}: 03_discovery_ledger.csv is missing")

            # 04 must equal the recomputed accepted set — deleting an
            # inconvenient obligation is how a probe "discovers without producing".
            acc_path = round_dir(project_root, n) / "04_accepted_surfaces.csv"
            fresh_acc = {a["canonical_surface_signature"] for a in res.get("accepted", [])}
            if acc_path.is_file():
                disk_acc = {r.get("canonical_surface_signature", "").strip()
                            for r in read_csv(acc_path)}
                if disk_acc != fresh_acc:
                    integrity.append(f"r{n:02d}: 04_accepted_surfaces.csv does not match the "
                                     f"recomputed accepted set ({len(disk_acc)} vs {len(fresh_acc)})")
            elif fresh_acc:
                integrity.append(f"r{n:02d}: 04_accepted_surfaces.csv is missing but "
                                 f"{len(fresh_acc)} surfaces were accepted")

            # Every accepted surface must have a Prompt in THIS round's output.
            after_path = round_dir(project_root, n) / "05_round_prompts.csv"
            if fresh_acc:
                if not after_path.is_file():
                    integrity.append(f"r{n:02d}: 05_round_prompts.csv is missing but "
                                     f"{len(fresh_acc)} surfaces were accepted")
                else:
                    unwritten = fresh_acc - load_signatures(after_path)
                    if unwritten:
                        integrity.append(
                            f"r{n:02d}: {len(unwritten)} accepted surface(s) have no Prompt in "
                            "05_round_prompts.csv (a probe may not discover without producing)")

            # (a) SAME-ROUND registry delta: 00_base_registry -> 06_round_registry.
            # This runs for EVERY round and depends on no successor, which
            # matters twice over: tampering done inside 06 is invisible to the
            # cross-round check as soon as it is faithfully carried into the next
            # base, and the FINAL round has no successor at all — which is
            # precisely the round with the most incentive to launder something in.
            base_reg_same = round_dir(project_root, n) / "00_base_registry.csv"
            round_reg_same = round_dir(project_root, n) / "06_round_registry.csv"
            if not round_reg_same.is_file():
                # Fail CLOSED: deleting the artifact must not be a way to skip
                # the check. Only an in-progress round may legitimately lack it.
                (pending if mid_run and n == max(numbers) else integrity).append(
                    f"r{n:02d}: 06_round_registry.csv is missing — the living registry for this "
                    "round cannot be checked against its frozen base")
            else:
                if not base_reg_same.is_file():
                    integrity.append(f"r{n:02d}: 00_base_registry.csv is missing — the round "
                                     "registry cannot be checked against its own baseline")
                else:
                    rejected_now = {
                        row.get("canonical_surface_signature", "")
                        for row in res.get("ledger_rows", [])
                        if row.get("novelty_status") == NOVELTY_NEW
                        and row.get("value_gate_pass") != "Yes"}
                    closure_now = round_dir(project_root, n) / "06_closure_additions.csv"
                    closure_rows_now, closure_fail_now = validate_closure_additions(
                        closure_now, rejected_now, f"r{n:02d}")
                    integrity.extend(closure_fail_now)

                    base_sigs_now = load_signatures(base_reg_same)
                    allowed_now = (base_sigs_now
                                   | {sig_str(r) for r in closure_rows_now}
                                   | fresh_acc)
                    stuffed_now = load_signatures(round_reg_same) - allowed_now
                    if stuffed_now:
                        integrity.append(
                            f"r{n:02d}: 06_round_registry.csv contains {len(stuffed_now)} "
                            "surface(s) that are neither in this round's frozen base, nor "
                            "accepted discovery, nor an approved closure addition")
                    dropped_now = base_sigs_now - load_signatures(round_reg_same)
                    if dropped_now:
                        integrity.append(
                            f"r{n:02d}: {len(dropped_now)} surface(s) from the frozen base are "
                            "missing from 06_round_registry.csv (the registry is append-only "
                            "within a round)")
                    integrity.extend(registry_metadata_violations(
                        read_csv(base_reg_same), read_csv(round_reg_same),
                        load_waived_cells(round_dir(project_root, n) / "06_waivers.csv"),
                        f"r{n:02d} (same-round)"))

            # (b) CROSS-ROUND registry delta: the living registry may only grow by
            # the previous round's accepted discovery surfaces plus explicitly
            # approved closure additions. The previous round's 06 is hash-bound in
            # this round's manifest, so stuffing it after the fact is detected.
            if n > 1:
                prev_reg = round_dir(project_root, n - 1) / "06_round_registry.csv"
                base_reg = round_dir(project_root, n) / "00_base_registry.csv"
                declared_prev_reg = str(res.get("manifest", {})
                                        .get("previous_registry_sha256", ""))
                if prev_reg.is_file():
                    if declared_prev_reg and declared_prev_reg != sha256_file(prev_reg):
                        integrity.append(
                            f"r{n:02d}: r{n - 1:02d}/06_round_registry.csv changed after this "
                            "round's manifest was frozen (registry history was rewritten)")
                    if base_reg.is_file():
                        prev_round = all_results[n - 1]
                        rejected_sigs = {
                            row.get("canonical_surface_signature", "")
                            for row in prev_round.get("ledger_rows", [])
                            if row.get("novelty_status") == NOVELTY_NEW
                            and row.get("value_gate_pass") != "Yes"}
                        closure = round_dir(project_root, n - 1) / "06_closure_additions.csv"
                        closure_rows, closure_failures = validate_closure_additions(
                            closure, rejected_sigs, f"r{n - 1:02d}")
                        integrity.extend(closure_failures)

                        allowed = load_signatures(prev_reg) | {sig_str(r) for r in closure_rows}
                        allowed |= {a["canonical_surface_signature"]
                                    for a in prev_round.get("accepted", [])}
                        stuffed = load_signatures(base_reg) - allowed
                        if stuffed:
                            integrity.append(
                                f"r{n:02d}: base registry contains {len(stuffed)} surface(s) "
                                f"that are neither in r{n - 1:02d}'s living registry, nor "
                                "accepted discovery, nor an approved closure addition")
                        dropped = load_signatures(prev_reg) - load_signatures(base_reg)
                        if dropped:
                            integrity.append(
                                f"r{n:02d}: {len(dropped)} surface(s) were DROPPED from the "
                                "living registry (obligations may not be deleted)")
                        # Row-level invariants: metadata tampering shrinks the
                        # obligation set without touching any signature.
                        waived = load_waived_cells(
                            round_dir(project_root, n - 1) / "06_waivers.csv")
                        integrity.extend(registry_metadata_violations(
                            read_csv(prev_reg), read_csv(base_reg), waived, f"r{n:02d}"))

        # Calibration rounds never count toward the streak OR the budget.
        # coverage_round is the COUNT of active rounds, never a directory number.
        calibration = [n for n in numbers if all_results[n].get("calibration_round")]
        active = [n for n in numbers if not all_results[n].get("calibration_round")]
        ev["calibration_rounds"] = calibration
        ev["active_rounds"] = active
        ev["active_round_count"] = len(active)
        ev["calibration_round_count"] = len(calibration)

        # Calibration is EXACTLY 3 rounds, always the leading prefix, for both
        # profiles. "At most 3" would let a run skip straight to active rounds
        # and silently drop 3*K calibration candidates. Calibration rounds no
        # longer tune N/delta (profile constants are immutable) — they exist to
        # produce real Prompts and observation data before the gate switches on.
        if calibration != list(range(1, len(calibration) + 1)):
            integrity.append(f"calibration rounds {calibration} are not a contiguous prefix "
                             "starting at r01")
        if active and len(calibration) != MAX_CALIBRATION_ROUNDS:
            integrity.append(
                f"exactly {MAX_CALIBRATION_ROUNDS} calibration rounds must precede the first "
                f"active round, found {len(calibration)} "
                f"(run `prepare-round --calibration` for r01..r{MAX_CALIBRATION_ROUNDS:02d})")
        if len(calibration) > MAX_CALIBRATION_ROUNDS:
            integrity.append(f"{len(calibration)} calibration rounds exceed the cap of "
                             f"{MAX_CALIBRATION_ROUNDS}")
        if active and state.get("calibration_complete") is not True:
            integrity.append("run_state calibration_complete is not true, but active rounds "
                             "have already been run")
        if state.get("calibration_complete") is True and len(calibration) != MAX_CALIBRATION_ROUNDS:
            integrity.append(f"run_state calibration_complete=true but {len(calibration)} "
                             f"calibration round(s) exist (need {MAX_CALIBRATION_ROUNDS})")
        declared = as_int(state.get("coverage_round"), None)
        if declared is not None and declared != len(active):
            integrity.append(f"run_state coverage_round={declared} but {len(active)} ACTIVE "
                             "round(s) exist (calibration rounds do not advance coverage_round)")
        declared_calib = as_int(state.get("calibration_round"), None)
        if declared_calib is not None and declared_calib != len(calibration):
            integrity.append(f"run_state calibration_round={declared_calib} but "
                             f"{len(calibration)} calibration round(s) exist")

        # The streak must be the LAST `streak` contiguous ACTIVE rounds; picking
        # older comparable rounds would let a failing round be skipped.
        tail = active[-streak_required:] if len(active) >= streak_required else active
        if tail and tail != list(range(tail[0], tail[0] + len(tail))):
            integrity.append(f"the trailing active rounds {tail} are not contiguous")
        round_results = [all_results[n] for n in tail]

        # (4) identical protocol across the streak, and a complete manifest chain
        fps = {r.get("protocol_fingerprint") for r in round_results if r.get("protocol_fingerprint")}
        # slot_hash legitimately differs per round; compare everything else.
        fps_nosl = {fp[:-1] for fp in fps if fp}
        if len(fps_nosl) > 1:
            pending.append("protocol drifted inside the streak — the frontier streak is zero; "
                           "run `streak` fresh rounds under one protocol")
        for n in numbers[1:]:
            man = round_dir(project_root, n) / "00_round_manifest.json"
            prev = round_dir(project_root, n - 1) / "00_round_manifest.json"
            if not (man.is_file() and prev.is_file()):
                continue
            declared_prev = str(read_json(man).get("previous_round_manifest_sha256", ""))
            if not declared_prev:
                integrity.append(f"r{n:02d}: previous_round_manifest_sha256 is empty — the round "
                                 "history chain is broken")
            elif declared_prev != sha256_file(prev):
                integrity.append(f"r{n:02d}: previous_round_manifest_sha256 does not match "
                                 f"r{n - 1:02d} (round history was rewritten)")

        passes = [bool(r.get("frontier_passed")) for r in round_results]
        frontier_exhausted = (len(passes) == streak_required and all(passes)
                              and len(fps_nosl) <= 1)
        # A degenerate round is a standing obligation, not an alert that expires
        # once later rounds push it out of the streak window. Scan EVERY round
        # and require an explicit, landed disposition for each one.
        undisposed: list[str] = []
        disposed: list[str] = []
        for n in numbers:
            if not all_results[n].get("probe_degenerate"):
                continue
            rid = f"r{n:02d}"
            ok, why = degenerate_disposition(round_dir(project_root, n))
            (disposed if ok else undisposed).append(rid if ok else f"{rid} ({why})")
        ev["degenerate_rounds_disposed"] = disposed
        ev["degenerate_rounds_undisposed"] = undisposed
        if undisposed:
            blockers.append(
                f"probe_degenerate round(s) without a landed disposition: "
                + "; ".join(undisposed)
                + f" — fewer than min_new_surface_count={const['min_new_surface_count']} new "
                  "surfaces were proposed, so the probe did not actually explore. Record the "
                  f"human decision in <round>/{DEGENERATE_DISPOSITION_NAME}; this blocker does "
                  "not expire when later rounds push the round out of the streak window.")
        # Required by run_state schema 1.3 — a missing or mistyped field is an
        # integrity failure, not a reason to skip the cross-check.
        on_disk = {u.split(" ")[0] for u in undisposed}
        if "unresolved_degenerate_rounds" not in state:
            integrity.append("run_state is missing 'unresolved_degenerate_rounds' "
                             f"(required by run_state schema {RUN_STATE_SCHEMA})")
        elif not isinstance(state["unresolved_degenerate_rounds"], list):
            integrity.append("run_state 'unresolved_degenerate_rounds' must be a list, got "
                             f"{type(state['unresolved_degenerate_rounds']).__name__}")
        elif {str(x) for x in state["unresolved_degenerate_rounds"]} != on_disk:
            integrity.append(
                "run_state unresolved_degenerate_rounds="
                f"{sorted(map(str, state['unresolved_degenerate_rounds']))} "
                f"disagrees with the rounds on disk {sorted(on_disk)}")
        ev["frontier_rounds"] = [{
            "round": r.get("manifest", {}).get("round_id", ""),
            "candidate_count": r.get("candidate_count"),
            "structurally_valid_count": r.get("structurally_valid_count"),
            "new_surface_count": r.get("new_surface_count"),
            "exploratory_new_count": r.get("exploratory_new_count"),
            "probe_degenerate": r.get("probe_degenerate"),
            "identical_recheck_complete": r.get("identical_recheck_complete"),
            "accepted_material_count": r.get("accepted_material_count"),
            "critical_new_count": r.get("critical_new_count"),
            "value_mass": r.get("value_mass"),
            "value_density": r.get("value_density"),
            "frontier_passed": r.get("frontier_passed"),
        } for r in round_results]
        if not frontier_exhausted:
            pending.append(f"discovery frontier not exhausted "
                           f"({sum(passes)}/{streak_required} passing rounds)")

    ev["frontier_exhausted"] = frontier_exhausted
    # State the anti-degenerate floor's real scope. Three conditions are machine
    # enforced; the fourth (a family's own `evidence_requirements`) is free text
    # and is NOT adjudicated. Anyone reading this output must be able to see at a
    # glance which half is checked and which half rests on protocol discipline.
    ev["probe_floor_enforcement"] = {
        "criterion": "exploratory_new_count >= min_new_surface_count",
        "min_new_surface_count": const["min_new_surface_count"],
        "enforced": [
            "novelty_status == new (recomputed against that round's frozen base map)",
            "support_mode in {direct, derived} — hypothesis rows do NOT count",
            "at least one evidence_refs id resolves in the frozen "
            "work/02_evidence_index.csv",
        ],
        "not_enforced": [
            "the candidate satisfies its probe family's declared "
            "`evidence_requirements` — that field is free text in "
            f"{PROTOCOL_REL} and is NOT machine-adjudicated",
        ],
        "reading": (
            "A passing floor means the probe genuinely attempted evidence-backed "
            "exploration. It does NOT mean every candidate met its family's stated "
            "evidence requirement; that rests on protocol discipline, not on this check."),
    }

    # (10/11/12) accepted discovery surfaces must land in the registry and the map
    registry_path = Path(registry) if registry else None
    if registry_path is None and numbers:
        candidate = round_dir(project_root, max(numbers)) / "06_round_registry.csv"
        registry_path = candidate if candidate.is_file() else None
    registry_signatures = load_signatures(registry_path) if registry_path else set()
    ev["living_registry"] = str(registry_path) if registry_path else None

    # Obligations come from the RECOMPUTED accepted set of every round, never
    # from the on-disk 04 files (which the ledger check above pins separately).
    all_accepted: dict[str, str] = {}
    for n, res in sorted(all_results.items()):
        for row in res.get("accepted", []):
            all_accepted.setdefault(row["canonical_surface_signature"],
                                    f"r{n:02d}/{row.get('candidate_id', '?')}")
    ev["accepted_discovery_surface_count"] = len(all_accepted)

    if all_accepted:
        if registry_path is None:
            integrity.append("living registry (06_round_registry.csv) not found — accepted "
                             "discovery surfaces cannot be reconciled")
        else:
            missing_reg = [v for s, v in all_accepted.items() if s not in registry_signatures]
            if missing_reg:
                integrity.append("accepted discovery surfaces absent from the living registry: "
                                 + ", ".join(sorted(missing_reg)[:10]))
        if final_signatures:
            missing_map = [v for s, v in all_accepted.items() if s not in final_signatures]
            if missing_map:
                blockers.append("accepted discovery surfaces absent from the final Prompt Map "
                                "(a probe may not discover without producing): "
                                + ", ".join(sorted(missing_map)[:10]))
    # additive superset: the final map may add, never drop, accepted coverage
    if final_signatures and all_accepted:
        ev["final_map_is_additive_superset"] = all(s in final_signatures for s in all_accepted)

    # --- hard blockers from the other validators --------------------------
    hard_fields = ("high_priority_uncovered_count", "unresolved_query_surface_gap_count",
                   "unresolved_intersection_gap_count", "template_review_count",
                   "hard_validator_failure_count")
    hard_counts: dict[str, int] = {}
    for field in hard_fields:
        if field not in state:
            integrity.append(f"run_state is missing '{field}'")
            continue
        value = as_int(state.get(field), None)
        if value is None:
            integrity.append(f"run_state '{field}' is not an integer: {state.get(field)!r}")
            continue
        hard_counts[field] = value
        if value != 0:
            blockers.append(f"{field}={value} (must be 0)")
    hard_clean = len(hard_counts) == len(hard_fields) and all(v == 0 for v in hard_counts.values())
    ev["hard_counts"] = hard_counts

    # Template counts are produced by another validator; the detector is re-run
    # against the current map and the resolution ledger applied to what it fires
    # NOW, so a stale "everything resolved" snapshot cannot clear the gate.
    detected = as_int(state.get("template_detected_count"), None)
    resolved = as_int(state.get("template_resolved_count"), None)
    review = hard_counts.get("template_review_count")
    if detected is None or resolved is None:
        integrity.append("run_state is missing template_detected_count / template_resolved_count")
    elif review is not None and detected - resolved != review:
        integrity.append(f"template_review_count={review} != detected({detected}) - "
                         f"resolved({resolved})")
    recomputed = _recompute_template_detections(project_root, final_map_path)
    ev["template_recomputed"] = recomputed
    if recomputed is None and final_map_path.is_file():
        integrity.append("the template detector could not be re-run against the final map — "
                         "run_state's template counters cannot be verified")
    if recomputed is not None:
        if recomputed.get("resolution_problems"):
            integrity.append(f"{TEMPLATE_RESOLUTIONS_REL} has invalid entries: "
                             + "; ".join(recomputed["resolution_problems"][:5]))
        if recomputed["unresolved"] != 0:
            blockers.append(
                f"{recomputed['unresolved']} template REVIEW item(s) still unresolved on the "
                f"current final map (resolve them, or record their keys in "
                f"{TEMPLATE_RESOLUTIONS_REL})")
            hard_clean = False
        if detected is not None and detected < recomputed["detected"]:
            integrity.append(f"template_detected_count={detected} is below the "
                             f"{recomputed['detected']} REVIEW item(s) the detector still fires")

    if state.get("hypothesis_quarantined") is not True:
        blockers.append("hypothesis_quarantined is not true — hypothesis-tier surfaces must stay "
                        "an optional backlog, never counted as evidence-complete")

    # Reduced evidence: either run_state declares it, or the floor sampler found
    # a source with no floor_candidate rows at all / a pool below the nominal n.
    declared_reduced = state.get("reduced_evidence_sources") or []
    if not isinstance(declared_reduced, list):
        integrity.append("run_state reduced_evidence_sources must be a list of source names")
        declared_reduced = []
    bad_sources = sorted({str(s) for s in declared_reduced} - set(FLOOR_SOURCE_TYPES))
    if bad_sources:
        integrity.append("run_state reduced_evidence_sources has unknown source(s): "
                         + ", ".join(bad_sources))
    reduced = sorted({str(s) for s in declared_reduced if str(s) in FLOOR_SOURCE_TYPES}
                     | set(floor.get("reduced_evidence_sources") or []))
    ev["reduced_evidence_sources"] = reduced
    pool_short = bool(floor.get("pool_short_of_n"))
    ev["evidence_pool_short_of_n"] = pool_short
    if pool_short:
        ev["floor_note"] = ("the whole floor_candidate pool is below coverage_floor_n; the "
                            "Wilson bound stands on the real n but this run is capped at "
                            "PASS_WITH_BACKLOG")
    # A reduced-evidence or short-pool run may never emit a normal PASS: it needs
    # explicit human approval of the reduced-evidence delivery.
    capped_at_backlog = bool(reduced) or pool_short or degraded

    # --- backlog artifact --------------------------------------------------
    # PASS_WITH_BACKLOG is the escape hatch, so the backlog must be a real
    # artifact: every row has to trace to a real candidate in a real round
    # ledger, and its value score has to match the RECOMPUTED V for that
    # candidate. An arbitrary CSV must not unlock delivery.
    backlog_path = project_root / "outputs" / "discovery_backlog.csv"
    backlog_rows = read_csv(backlog_path) if backlog_path.is_file() else []
    backlog_problems: list[str] = []
    if not backlog_path.is_file():
        backlog_problems.append("outputs/discovery_backlog.csv is missing")
    elif not backlog_rows:
        backlog_problems.append("outputs/discovery_backlog.csv has no rows "
                                "(an empty backlog is not a backlog)")
    else:
        header = set(backlog_rows[0])
        missing_cols = [c for c in BACKLOG_REQUIRED_COLUMNS if c not in header]
        if missing_cols:
            backlog_problems.append("outputs/discovery_backlog.csv is missing required column(s): "
                                    + ", ".join(missing_cols))
        else:
            # candidate_id -> (round_id, recomputed value_score)
            known: dict[str, dict] = {}
            for n, res in sorted(all_results.items()):
                rid = res.get("manifest", {}).get("round_id", f"r{n:02d}")
                for row in res.get("ledger_rows", []):
                    known[row.get("candidate_id", "").strip()] = {
                        "round_id": rid,
                        "value_score": str(row.get("value_score", "")),
                        "novelty_status": str(row.get("novelty_status", "")),
                        "value_gate_pass": str(row.get("value_gate_pass", "")),
                        "signature": str(row.get("canonical_surface_signature", "")),
                    }
            unknown, mismatched, no_reason, bad_round = [], [], [], []
            not_backlog_shaped, already_delivered = [], []
            for row in backlog_rows:
                cid = str(row.get("discovery_candidate_id", "")).strip()
                if not cid or cid not in known:
                    unknown.append(cid or "<empty>")
                    continue
                entry = known[cid]
                rid, recomputed = entry["round_id"], entry["value_score"]
                # The backlog is "remaining frontier candidates / mid-to-low value
                # surfaces" — NOT already-delivered work. Without these checks a
                # single accepted, delivered, high-value candidate could be listed
                # and would unlock PASS_WITH_BACKLOG on its own.
                if entry["novelty_status"] != NOVELTY_NEW:
                    not_backlog_shaped.append(f"{cid}(novelty={entry['novelty_status']})")
                elif entry["value_gate_pass"] == "Yes":
                    not_backlog_shaped.append(f"{cid}(value_gate_pass=Yes — this was accepted, "
                                              "not deferred)")
                if entry["signature"] and entry["signature"] in final_signatures:
                    already_delivered.append(cid)
                # introduced_round is REQUIRED: an empty value used to skip the
                # check entirely, which is the "documented but unenforced" shape.
                declared_round = str(row.get("introduced_round", "")).strip()
                if not declared_round:
                    bad_round.append(f"{cid}(introduced_round is empty)")
                elif declared_round != rid:
                    bad_round.append(f"{cid}({declared_round}!={rid})")
                declared_v = str(row.get("frontier_value_score", "")).strip()
                # Fail CLOSED: a candidate whose V cannot be recomputed (it was
                # never scored, e.g. an identical_existing or invalid row) is not
                # a legitimate backlog entry. Skipping the comparison here would
                # let exactly those rows through unchecked.
                if not recomputed:
                    mismatched.append(f"{cid}(no recomputable V — not a scored candidate)")
                elif not declared_v:
                    mismatched.append(f"{cid}(missing frontier_value_score)")
                elif as_float(declared_v) != as_float(recomputed):
                    mismatched.append(f"{cid}({declared_v}!={recomputed})")
                if not str(row.get("reason", "")).strip():
                    no_reason.append(cid)
            if unknown:
                backlog_problems.append(
                    f"{len(unknown)} backlog row(s) cite a discovery_candidate_id that exists in "
                    "no round ledger: " + ", ".join(unknown[:8]))
            if bad_round:
                backlog_problems.append("backlog introduced_round is missing or disagrees with "
                                        "the ledger: " + ", ".join(bad_round[:8]))
            if not_backlog_shaped:
                backlog_problems.append(
                    "backlog row(s) cite candidates that are not deferred discovery work: "
                    + ", ".join(not_backlog_shaped[:8]))
            if already_delivered:
                backlog_problems.append(
                    f"{len(already_delivered)} backlog row(s) cite a surface that is ALREADY in "
                    "the final Prompt Map — the backlog is for what was NOT delivered: "
                    + ", ".join(already_delivered[:8]))
            if mismatched:
                backlog_problems.append(
                    "backlog frontier_value_score does not match the recomputed V: "
                    + ", ".join(mismatched[:8]))
            if no_reason:
                backlog_problems.append("backlog row(s) with an empty reason: "
                                        + ", ".join(no_reason[:8]))
        declared = str(state.get("backlog_sha256", "")).strip()
        actual = sha256_file(backlog_path)
        ev["backlog_sha256"] = actual
        if not declared:
            backlog_problems.append("run_state backlog_sha256 is empty — the backlog is not "
                                    "pinned to this run")
        elif declared != actual:
            backlog_problems.append("run_state backlog_sha256 does not match "
                                    "outputs/discovery_backlog.csv")
        declared_n = as_int(state.get("backlog_count"), None)
        if declared_n is None:
            backlog_problems.append("run_state backlog_count is missing or not an integer")
        elif declared_n != len(backlog_rows):
            backlog_problems.append(f"run_state backlog_count={declared_n} != "
                                    f"{len(backlog_rows)} backlog rows")
    backlog_valid = not backlog_problems
    ev["backlog_problems"] = backlog_problems
    # Budget is measured in ACTIVE rounds. `approved_discovery_budget_rounds`
    # (frozen with the profile, null by default) lets a run spend a smaller
    # approved budget and still qualify for PASS_WITH_BACKLOG.
    active_count = ev.get("active_round_count", 0)
    approved_budget = doc.get("approved_discovery_budget_rounds")
    if approved_budget is not None:
        approved_budget = as_int(approved_budget, None)
        if approved_budget is None or approved_budget < 1:
            integrity.append("convergence_profile.approved_discovery_budget_rounds must be null "
                             "or a positive integer")
            approved_budget = None
    ev["approved_discovery_budget_rounds"] = approved_budget
    budget_spent = (active_count >= const["max_round"]
                    or (approved_budget is not None and active_count >= approved_budget))
    ev["budget_spent"] = budget_spent
    # "Stop at the budget" has to be enforced, not merely documented: running
    # PAST max_round (or past the approved budget) is an integrity failure, not
    # a state the gate quietly tolerates.
    hard_cap = min([const["max_round"]] + ([approved_budget] if approved_budget else []))
    if active_count > hard_cap:
        integrity.append(
            f"{active_count} active rounds exceed the approved discovery budget of {hard_cap} "
            f"({'approved_discovery_budget_rounds' if approved_budget and approved_budget <= const['max_round'] else 'max_round'})"
            " — the run should have stopped and taken PASS_WITH_BACKLOG")

    # --- status ------------------------------------------------------------
    if integrity or blockers:
        status = "FAIL"
    elif floor_passed and hard_clean and frontier_exhausted and not capped_at_backlog:
        status = "PASS"
    elif (floor_passed and hard_clean
          # The budget condition is NEVER waived. `capped_at_backlog` limits the
          # best achievable outcome; it does not license early delivery.
          and budget_spent
          and (not frontier_exhausted or capped_at_backlog)
          and state.get("human_backlog_delivery_approved") is True and backlog_valid):
        status = "PASS_WITH_BACKLOG"
    else:
        status = "CONTINUE"
        if floor_passed and hard_clean and frontier_exhausted and capped_at_backlog:
            # There is no human upgrade path out of reduced evidence: missing
            # Semrush is missing evidence, and no approval turns that into
            # "complete coverage". The ceiling is PASS_WITH_BACKLOG.
            pending.append("reduced-evidence run ("
                           + (", ".join(reduced) if reduced
                              else ("registry proxy" if degraded else "floor pool below n"))
                           + "): this run is permanently capped at PASS_WITH_BACKLOG and can "
                             "never emit a normal PASS")
        if budget_spent and not backlog_valid:
            pending.append("budget spent but the backlog artifact is invalid: "
                           + "; ".join(backlog_problems[:3]))
        if budget_spent and state.get("human_backlog_delivery_approved") is not True:
            pending.append("budget spent — PASS_WITH_BACKLOG needs explicit human approval")
        if not budget_spent and capped_at_backlog:
            pending.append("this run is capped at PASS_WITH_BACKLOG, but the discovery budget "
                           "is not spent yet — keep running rounds")

    failures = integrity + blockers
    if stage == "delivery" and status not in {"PASS", "PASS_WITH_BACKLOG"}:
        failures.append("delivery blocked: convergence not approved "
                        f"(convergence_status={status})")

    ev["pending"] = pending
    ev["integrity_failures"] = integrity
    ev["hard_blockers"] = blockers
    ev["coverage_floor_passed"] = floor_passed
    # Everything this gate CANNOT verify, stated plainly. These are not
    # recomputed; a reader must not mistake a PASS for a proof about them.
    ev["trust_boundaries"] = [
        "coverage_floor_eligibility_and_surface_labels: the eligible/exclusion_reason verdict "
        "and the six surface fields on each sampled evidence row are written by the agent under "
        "test; the script only re-draws the sample and recomputes the Wilson bound",
        "discovery_evidence_relevance: evidence_refs are checked to RESOLVE in the frozen "
        "evidence index and demand counts are recomputed from them, but whether a cited record "
        "actually supports the claimed surface is not verified",
        "product_card_eligible / product_impact_code / track_* are agent judgements; only their "
        "enum validity and arithmetic consequences are recomputed",
        "human_backlog_delivery_approved is a run_state boolean with no external approval anchor",
        "approved_discovery_budget_rounds is frozen in the profile but has no approval anchor",
        "round-1 base artifacts (00_base_prompts.csv / 00_base_registry.csv) have no external "
        "root anchor; the hash chain only proves rounds 2..N were not rewritten afterwards",
    ]
    # Exactly two authorized delivery claims — no third wording is invented.
    # A reduced-evidence run states that fact in `delivery_claim_note`, which
    # accompanies the backlog rather than replacing the approved sentence.
    if status == "PASS":
        ev["delivery_claim"] = "Evidence coverage floor passed. Discovery frontier exhausted."
    elif status == "PASS_WITH_BACKLOG":
        ev["delivery_claim"] = (
            "Evidence coverage floor passed. Discovery frontier not fully exhausted within the "
            "approved budget. Remaining exploration backlog is attached.")
    else:
        ev["delivery_claim"] = ""
    if status == "PASS_WITH_BACKLOG" and capped_at_backlog:
        ev["delivery_claim_note"] = (
            "Reduced-evidence run ("
            + (", ".join(reduced) if reduced
               else ("registry proxy" if degraded else "evidence pool below the nominal sample"))
            + "): this run is capped at PASS_WITH_BACKLOG by construction.")
    return status, failures, ev


def cmd_verify(args) -> int:
    try:
        status, failures, evidence = run(args.project_root, args.stage,
                                         registry=args.registry, final_map=args.final_map)
    except ConvergenceError as exc:
        status, failures, evidence = "FAIL", [str(exc)], {"stage": args.stage}
    print(json.dumps({"status": status, "failures": failures, "evidence": evidence},
                     ensure_ascii=False, indent=2))
    return 0 if status in ("PASS", "PASS_WITH_BACKLOG") else 2


# --------------------------------------------------------------------------
# init helper (used by scripts/init_project.py)
# --------------------------------------------------------------------------

def default_profile_document(name: str = "rich") -> dict:
    doc = profile_constants(name)
    doc.update({
        "convergence_method": CONVERGENCE_METHOD,
        "profile_frozen": False,
        "discovery_protocol_id": "",
        "discovery_protocol_sha256": "",
        "canonicalizer_sha256": canonicalizer_sha256(),
        "value_rubric_version": VALUE_RUBRIC_VERSION,
        "materiality_rule_version": MATERIALITY_RULE_VERSION,
        "approved_discovery_budget_rounds": None,
        "protocol_revision_count": 0,
    })
    return doc


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

MODES = ("prepare-floor", "prepare-round", "score-round", "verify")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_coverage_convergence.py", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    subs = parser.add_subparsers(dest="mode", required=True)

    pf = subs.add_parser("prepare-floor", help="draw a deterministic Coverage Floor batch")
    pf.add_argument("--project-root", required=True, type=Path)
    pf.add_argument("--batch", type=int, default=1, choices=(1, 2))
    pf.add_argument("--top-up", action="store_true",
                    help="after the batch has been judged, fill it back up to coverage_floor_n "
                         "from still-unsampled rows (same source first, then the "
                         "reddit->geoly->semrush reallocation order). Use this for eligibility "
                         "exclusions only — a batch that FAILS the Wilson bound must be "
                         "followed by an independent --batch 2.")
    pf.set_defaults(func=cmd_prepare_floor)

    pr = subs.add_parser("prepare-round", help="generate the Stage 1 skeleton + round manifest")
    pr.add_argument("--project-root", required=True, type=Path)
    pr.add_argument("--round", required=True, type=positive_round)
    pr.add_argument("--model-id", default="")
    pr.add_argument("--temperature", default="")
    pr.add_argument("--calibration", action="store_true",
                    help="mark this as a calibration round (frontier gate disabled, "
                         "does not count toward max_round)")
    pr.add_argument("--force", action="store_true")
    pr.set_defaults(func=cmd_prepare_round)

    sr = subs.add_parser("score-round", help="recompute novelty + value and write the ledger")
    sr.add_argument("--project-root", required=True, type=Path)
    sr.add_argument("--round", required=True, type=positive_round)
    sr.add_argument("--emit-run-state-patch", type=Path, default=None,
                    help="write the run_state fields this round implies (never writes run_state)")
    sr.set_defaults(func=cmd_score_round)

    vf = subs.add_parser("verify", help="the full convergence gate (recomputes everything)")
    vf.add_argument("--project-root", required=True, type=Path)
    vf.add_argument("--stage", default="final-audit", choices=("round", "final-audit", "delivery"))
    vf.add_argument("--registry", type=Path, default=None)
    vf.add_argument("--final-map", type=Path, default=None)
    vf.set_defaults(func=cmd_verify)
    return parser


def normalize_argv(argv: list[str]) -> list[str]:
    """Accept both `prepare-floor` and `--prepare-floor` as the FIRST token.

    Only the leading token is rewritten. Scanning the whole argv would turn a
    malformed option VALUE (`--model-id --verify`) into a different subcommand.
    """
    if argv and argv[0].startswith("--") and argv[0][2:] in MODES:
        return [argv[0][2:], *argv[1:]]
    return list(argv)


def positive_round(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("round numbers start at 1")
    return number


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(normalize_argv(list(sys.argv[1:] if argv is None else argv)))
    try:
        return args.func(args)
    except ConvergenceError as exc:
        print(json.dumps({"status": "FAIL", "failures": [str(exc)]}, ensure_ascii=False, indent=2))
        return 2
    except (OSError, csv.Error, json.JSONDecodeError, ValueError, KeyError, TypeError,
            AttributeError, IndexError) as exc:
        print(json.dumps({"status": "FAIL", "failures": [f"convergence engine error: {exc}"]},
                         ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
