#!/usr/bin/env python3
"""Prompt surface-quality / template-similarity audit (advisory: WARN/REVIEW, never auto-delete).

Catches the "templated batch" failure mode the shortlist validator cannot see:
sentence-skeleton spam, dominant-skeleton share per Topic, near-template n-gram
pairs on distinct surfaces, and surface fields not represented in the Prompt text.
See references/geo-coverage-mode.md and coverage-loop.md.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _surface import SURFACE_FIELDS  # noqa: E402

# Function / question words + ubiquitous category words kept to expose the frame.
FUNC = {"which", "what", "are", "is", "the", "a", "an", "for", "who", "how", "do", "does", "to", "of",
        "on", "in", "at", "with", "and", "or", "as", "if", "you", "your", "my", "me", "i", "need",
        "best", "most", "least", "that", "this", "when", "where", "while", "without", "during", "between",
        "versus", "vs", "than", "over", "under", "after", "before", "should", "can", "could", "would",
        "will", "not", "no", "get", "use", "using", "have", "has", "make", "makes", "keep", "keeps",
        "work", "works", "fit", "fits", "take", "takes", "stay", "stays", "hold", "holds", "give", "gives",
        "offer", "offers", "come", "comes", "among", "across", "into", "out", "up", "down", "per", "each",
        "one", "two", "both", "also", "still", "even", "only", "just", "enough", "very", "too", "so",
        "breast", "pump", "pumps", "device", "devices"}


def norm(v: str) -> str:
    return " ".join(re.sub(r"[^\w$%. ]", " ", str(v or "").lower()).split())


def skeleton(row: dict) -> str:
    """Frame signature: keep function/question words, replace content words with X,
    collapse runs of X. Reveals a reused sentence frame regardless of the filled values."""
    toks = norm(row.get("prompt_en")).split()
    shape = [t if (t in FUNC or len(t) <= 2) else "x" for t in toks]
    s = " ".join(shape)
    s = re.sub(r"(?:\bx\b\s*)+", "x ", s)  # collapse runs of content placeholders
    return s.strip()


def shingles(text: str, n: int = 3) -> set:
    toks = norm(text).split()
    return {" ".join(toks[i:i + n]) for i in range(max(0, len(toks) - n + 1))}


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if (a or b) else 0.0


def audit(rows: list[dict]) -> dict:
    """Scale-aware template audit (spec §7).

    Absolute counts fire constantly at 600+ rows, so every threshold is now a
    function of the population size. Open discovery does not lower the bar; the
    validator just stops mistaking scale for templating.
    """
    warnings: list[str] = []
    reviews: list[str] = []
    total = len(rows)

    # GLOBAL exact skeleton reuse: REVIEW at max(8, ceil(total * 0.03)).
    # The spec defines no global WARN tier — do not invent one.
    global_review_at = max(8, math.ceil(total * 0.03))
    gcounts = Counter(skeleton(r) for r in rows)
    for s, c in gcounts.most_common(10):
        if c >= global_review_at:
            reviews.append(f"global template-skeleton reused x{c} (>= {global_review_at}): '{s[:60]}'")

    # Per decision_angle: REVIEW if n >= 10 and dominant share > 0.50;
    #                    WARN   if n >= 10 and dominant share > 0.35.
    by_angle: defaultdict[str, list[str]] = defaultdict(list)
    for r in rows:
        by_angle[r.get("decision_angle", "")].append(skeleton(r))
    for ang, sks in by_angle.items():
        if len(sks) >= 10:
            share = max(Counter(sks).values()) / len(sks)
            if share > 0.50:
                reviews.append(f"angle '{ang}': one skeleton covers {share:.0%} of {len(sks)} prompts (template reuse)")
            elif share > 0.35:
                warnings.append(f"angle '{ang}': dominant skeleton {share:.0%} of {len(sks)}")

    by_topic: defaultdict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_topic[r.get("topic", "") or "(category)"].append(r)

    # Per Topic: REVIEW if a skeleton count >= max(5, ceil(topic_n * 0.25)); WARN at >= 3.
    for topic, items in by_topic.items():
        sk = [(skeleton(r), r.get("prompt_id", "?")) for r in items]
        counts = Counter(s for s, _ in sk)
        n = len(items)
        topic_review_at = max(5, math.ceil(n * 0.25))
        for s, c in counts.items():
            if c >= topic_review_at:
                ids = [pid for sk_s, pid in sk if sk_s == s][:8]
                reviews.append(f"template-skeleton x{c} (>= {topic_review_at}) in Topic "
                               f"'{topic}' (n={n}): {', '.join(ids)}")
            elif c >= 3:
                warnings.append(f"template-skeleton x{c} in Topic '{topic}' (n={n})")

    # Near-template n-gram pairs, same Topic + same decision_angle:
    #   REVIEW at Jaccard >= 0.85; WARN in [0.75, 0.85).
    for topic, items in by_topic.items():
        buckets: defaultdict[str, list[dict]] = defaultdict(list)
        for r in items:
            buckets[r.get("decision_angle", "")].append(r)
        for ang, group in buckets.items():
            sh = [(r.get("prompt_id", "?"), shingles(r.get("prompt_en", ""))) for r in group]
            for i in range(len(sh)):
                for j in range(i + 1, len(sh)):
                    score = jaccard(sh[i][1], sh[j][1])
                    if score >= 0.85:
                        reviews.append(f"near-template pair J={score:.2f} (Topic '{topic}', angle "
                                       f"'{ang}'): {sh[i][0]} ~ {sh[j][0]}")
                    elif score >= 0.75:
                        warnings.append(f"near-template pair J={score:.2f} (Topic '{topic}', angle "
                                        f"'{ang}'): {sh[i][0]} ~ {sh[j][0]}")

    # surface not represented at all in Prompt text: warn only when NONE of the
    # content words across all surface fields appear (low false-positive).
    STOP = {"pump", "pumps", "breast", "which", "best", "none", "general"}
    for r in rows:
        text = norm(r.get("prompt_en"))
        content = []
        for f in SURFACE_FIELDS:
            content += [w for w in norm(r.get(f)).split() if len(w) > 4 and w not in STOP]
        if content and not any(w in text for w in content):
            warnings.append(f"{r.get('prompt_id','?')}: surface not represented in Prompt text")

    return {"warnings": warnings, "reviews": reviews}


def finding_key(message: str) -> str:
    """Stable 12-hex id for a REVIEW finding, so resolutions can be ledgered."""
    return hashlib.sha256(message.encode("utf-8")).hexdigest()[:12]


RESOLUTION_TYPES = {"rewritten", "merged", "human_waived"}


def load_resolved(path: Path | None) -> set[str]:
    """Resolved REVIEW keys, with justification (see `resolution_problems`).

    A bare list of keys is NOT accepted: copying every current finding key into
    the ledger would otherwise "resolve" the whole audit for free. Each entry
    must be an object carrying a `resolution_type` and a `reason`, and a
    `human_waived` entry additionally needs an `approval_ref`.
    """
    return {key for key, _ in _load_resolution_entries(path)[0].items()}


def _load_resolution_entries(path: Path | None) -> tuple[dict[str, dict], list[str]]:
    problems: list[str] = []
    if path is None or not path.is_file():
        return {}, problems
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {}, [f"{path.name} is unreadable/malformed: {exc}"]
    if isinstance(data, dict):
        data = data.get("resolved", data.get("resolutions", data.get("resolved_keys", [])))
    if not isinstance(data, list):
        return {}, [f"{path} must hold a list of resolution objects"]

    entries: dict[str, dict] = {}
    for item in data:
        if not isinstance(item, dict):
            problems.append(f"resolution entry {item!r} is not an object with "
                            "key/resolution_type/reason")
            continue
        key = str(item.get("key", "")).strip()
        if not key:
            problems.append("resolution entry has no finding `key`")
            continue
        rtype = str(item.get("resolution_type", "")).strip().lower()
        if rtype not in RESOLUTION_TYPES:
            problems.append(f"{key}: resolution_type must be one of {sorted(RESOLUTION_TYPES)}, "
                            f"got {rtype or '<empty>'}")
            continue
        if not str(item.get("reason", "")).strip():
            problems.append(f"{key}: resolution has an empty reason")
            continue
        if rtype == "human_waived" and not str(item.get("approval_ref", "")).strip():
            problems.append(f"{key}: human_waived resolution needs an approval_ref")
            continue
        entries[key] = item
    return entries, problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--prompts", required=True, type=Path)
    ap.add_argument("--coverage-mode", default="geo_full_coverage",
                    choices=("geo_full_coverage", "minimal_dedup"))
    ap.add_argument("--strict", action="store_true",
                    help="Exit non-zero when status is REVIEW (use at the final-audit / delivery gate).")
    ap.add_argument("--output", type=Path, default=None,
                    help="Also write the JSON report to this path (the persisted review ledger).")
    ap.add_argument("--resolved-ledger", type=Path, default=None,
                    help="File of resolved REVIEW finding keys. template_review_count = "
                         "detected - resolved; only the UNRESOLVED count must reach zero. "
                         "A detector that never fired is not the same as a clean map.")
    args = ap.parse_args()
    try:
        with args.prompts.open("r", encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
    except (OSError, csv.Error) as exc:
        print(json.dumps({"status": "FAIL", "error": str(exc)}))
        return 2
    if not rows:
        # An empty / header-only map is not a clean map — never report PASS.
        print(json.dumps({"status": "FAIL", "prompt_count": 0,
                          "error": "prompt file is empty or header-only"},
                         ensure_ascii=False, indent=2))
        return 2
    res = audit(rows)
    resolution_entries, resolution_problems = _load_resolution_entries(args.resolved_ledger)
    resolved_keys = set(resolution_entries)
    findings = [{"key": finding_key(m), "message": m} for m in res["reviews"]]
    unresolved = [f for f in findings if f["key"] not in resolved_keys]

    detected_count = len(findings)
    resolved_count = detected_count - len(unresolved)
    review_count = detected_count - resolved_count

    status = ("REVIEW" if (unresolved or resolution_problems)
              else ("WARN" if res["warnings"] else "PASS"))
    total = len(rows)
    out = {"status": status, "coverage_mode": args.coverage_mode, "prompt_count": total,
           "resolution_problems": resolution_problems,
           "resolution_types": sorted({str(e.get("resolution_type"))
                                       for e in resolution_entries.values()}),
           "template_detected_count": detected_count,
           "template_resolved_count": resolved_count,
           "template_review_count": review_count,
           "review_count": review_count, "warning_count": len(res["warnings"]),
           "thresholds": {
               "global_skeleton_review_at": max(8, math.ceil(total * 0.03)),
               "angle_min_n": 10, "angle_review_share": 0.50, "angle_warn_share": 0.35,
               "topic_skeleton_review_at": "max(5, ceil(topic_n * 0.25))",
               "topic_skeleton_warn_at": 3,
               "near_template_review_jaccard": 0.85, "near_template_warn_jaccard": 0.75,
           },
           "findings": findings[:60],
           "unresolved_review_keys": [f["key"] for f in unresolved][:60],
           "reviews": [f["message"] for f in unresolved][:40],
           "warnings": res["warnings"][:40]}
    payload = json.dumps(out, ensure_ascii=False, indent=2)
    print(payload)
    if args.output is not None:
        try:
            args.output.write_text(payload + "\n", encoding="utf-8")
        except OSError as exc:
            print(json.dumps({"status": "FAIL", "error": f"cannot write --output: {exc}"}))
            return 2
    # Default: advisory (exit 0). With --strict, unresolved REVIEW blocks the gate.
    if args.strict and status == "REVIEW":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
