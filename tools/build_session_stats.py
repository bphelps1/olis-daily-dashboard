#!/usr/bin/env python3
"""
Precompute session-wide statistics for completed sessions and write them as
static JSON files (docs/stats/<SESSION>.json and dashboard/stats/<SESSION>.json).

The dashboard's Session Stats tab loads these instantly instead of pulling the
whole floor-vote table and computing in the browser. Sessions without a file
(e.g. the current in-progress session) fall back to live computation.

Reuses dashboard/api.py so the numbers are identical to the live computation.

Usage:
    python3 tools/build_session_stats.py                 # recent R/S sessions
    python3 tools/build_session_stats.py 2026R1 2025R1    # specific sessions
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dashboard import api  # noqa: E402

# Only sessions on/after this begin date are precomputed by default (older ones
# fall back to live compute, which is rarely needed).
DEFAULT_CUTOFF = "2024-01-01"


def analyze(arr):
    if not arr:
        return None
    aye = sum(1 for v in arr if v["Vote"] == "Yea")
    nay = sum(1 for v in arr if v["Vote"] == "Nay")
    if aye <= nay:
        return None
    d_aye = any(v["Party"] == "D" and v["Vote"] == "Yea" for v in arr)
    r_aye = any(v["Party"] == "R" and v["Vote"] == "Yea" for v in arr)
    dv = [v["Vote"] for v in arr if v["Party"] == "D" and v["Vote"] in ("Yea", "Nay")]
    rv = [v["Vote"] for v in arr if v["Party"] == "R" and v["Vote"] in ("Yea", "Nay")]
    party_line = bool(dv and rv and len(set(dv)) == 1 and len(set(rv)) == 1 and dv[0] != rv[0])
    return {"bipartisan": d_aye and r_aye, "partyLine": party_line, "unanimous": nay == 0}


def compute(session):
    measures = api.get_measures_map(session)
    fvotes = api.get_floor_votes_by_bill(session)
    total = enacted = 0
    by_prefix = {}
    for m in measures.values():
        total += 1
        by_prefix[m.get("MeasurePrefix")] = by_prefix.get(m.get("MeasurePrefix"), 0) + 1
        if m.get("ChapterNumber") is not None:
            enacted += 1
    passed_both = bipartisan_both = party_line_any = unanimous_both = passed_one = 0
    bills_passed = bills_bipartisan = 0
    for k, votes in fvotes.items():
        by_ch = {"House": [], "Senate": []}
        for v in votes:
            if v["Chamber"] in by_ch:
                by_ch[v["Chamber"]].append(v)
        h, s = analyze(by_ch["House"]), analyze(by_ch["Senate"])
        if h and s:
            passed_both += 1
            if h["bipartisan"] and s["bipartisan"]:
                bipartisan_both += 1
            if h["partyLine"] or s["partyLine"]:
                party_line_any += 1
            if h["unanimous"] and s["unanimous"]:
                unanimous_both += 1
            pfx = (measures.get(k) or {}).get("MeasurePrefix")
            if pfx in ("HB", "SB"):
                bills_passed += 1
                if h["bipartisan"] and s["bipartisan"]:
                    bills_bipartisan += 1
        elif h or s:
            passed_one += 1
    by_prefix_arr = [{"prefix": p, "count": c} for p, c in
                     sorted(by_prefix.items(), key=lambda kv: -kv[1])]
    return {
        "session": session, "session_name": api.session_name(session),
        "total": total, "enacted": enacted, "byPrefix": by_prefix_arr,
        "passedBoth": passed_both, "bipartisanBoth": bipartisan_both,
        "partyLineAny": party_line_any, "unanimousBoth": unanimous_both,
        "passedOne": passed_one,
        "bills": {"passed": bills_passed, "bipartisan": bills_bipartisan},
        "precomputed": True,
    }


def main():
    args = sys.argv[1:]
    if args:
        sessions = args
    else:
        sessions = [s["key"] for s in api.get_sessions()
                    if re.search(r"[RS]\d+$", s["key"]) and (s.get("begin") or "") >= DEFAULT_CUTOFF]
    out_dirs = [ROOT / "docs" / "stats", ROOT / "dashboard" / "stats"]
    for d in out_dirs:
        d.mkdir(exist_ok=True)
    for sess in sessions:
        stats = compute(sess)
        for d in out_dirs:
            (d / f"{sess}.json").write_text(json.dumps(stats, indent=1))
        print(f"  {sess:8} {stats['total']:>4} measures  "
              f"{stats['bills']['passed']:>3} bills passed  "
              f"{stats['bills']['bipartisan']:>3} bipartisan")


if __name__ == "__main__":
    main()
