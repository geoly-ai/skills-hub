#!/usr/bin/env python3
"""Shared query-surface canonicalization for the GEO coverage guardrails.

One implementation so validate_shortlist_difference.py,
validate_generation_integrity.py, and verify_decision_angle_gate.py agree on
what counts as the same surface. See references/geo-coverage-mode.md.
"""

from __future__ import annotations

import re

SURFACE_FIELDS = ("audience", "body_part_or_object", "attribute_or_condition",
                  "scenario", "decision_angle", "decision_criterion")
# Conditional dimensions add to the signature ONLY when present + non-neutral.
CONDITIONAL_FIELDS = ("purchase_stage", "budget_tier", "product_format_or_compatibility",
                      "comparison_target_or_alternative", "result_time_horizon")

NEUTRAL = {"", "none", "n/a", "na", "any", "general", "all", "cross", "cross-topic", "*"}

# Phrase-level synonym folds (extend per category as evidence accrues).
SYNONYMS = {
    "audience": {"busy mom": "working mother", "working mom": "working mother",
                 "working parent": "working mother", "ep": "exclusive pumper",
                 "ep mom": "exclusive pumper", "first time buyer": "first-time buyer",
                 "first time user": "first-time buyer"},
    "scenario": {"vacation": "travel", "on vacation": "travel", "traveling": "travel",
                 "at the office": "at work", "office": "at work", "return to work": "at work",
                 "returning to work": "at work", "back to work": "at work"},
    "decision_criterion": {"comfortable": "low pain", "comfort": "low pain",
                           "least painful": "low pain", "most comfortable": "low pain",
                           "low discomfort": "low pain", "quiet": "low noise",
                           "discreet": "low noise", "quietest": "low noise"},
}


def _base(value: str) -> str:
    v = str(value or "").lower().strip()
    v = re.sub(r"[-_/]+", " ", v)
    return re.sub(r"\s+", " ", v)


def _singular(token: str) -> str:
    if len(token) > 3 and token.endswith("s") and not token.endswith(("ss", "us", "is", "os")):
        return token[:-1]
    return token


def canon(field: str, value: str) -> str:
    """Canonical token for a surface field: normalize -> synonym-fold -> singularize -> neutral."""
    v = _base(value)
    v = SYNONYMS.get(field, {}).get(v, v)
    if v in NEUTRAL:
        return "*"
    v = " ".join(_singular(t) for t in v.split())
    v = SYNONYMS.get(field, {}).get(v, v)
    return "*" if v in NEUTRAL else v


def is_blank(value: str) -> bool:
    return not str(value or "").strip()


def is_neutral(field: str, value: str) -> bool:
    return canon(field, value) == "*"


def signature(row: dict, include_conditional: bool = True) -> tuple:
    """Canonical surface signature: six base fields + any present conditional dimensions."""
    sig = [canon(f, row.get(f)) for f in SURFACE_FIELDS]
    if include_conditional:
        for f in CONDITIONAL_FIELDS:
            c = canon(f, row.get(f))
            if c != "*":
                sig.append(f"{f}={c}")
    return tuple(sig)
