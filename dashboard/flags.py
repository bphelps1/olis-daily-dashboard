"""
Flag logic: testimony, partisan / bipartisan (committee), floor splits, and
committee meeting status.

All vote records passed in here are already normalised by api.py:
    Vote   in {'Yea', 'Nay', 'Excused'}
    Party  in {'D', 'R', 'I'}
    Chamber in {'House', 'Senate'}   (floor votes only)
"""
from __future__ import annotations

TESTIMONY_THRESHOLD = 25


def testimony_flag(count: int) -> dict | None:
    """Flag dict if testimony count meets the threshold, else None."""
    if count >= TESTIMONY_THRESHOLD:
        return {"type": "testimony", "label": f"{count} testimonies",
                "icon": "🔴", "color": "danger"}
    return None


def partisan_and_bipartisan_flags(vote_records: list[dict]) -> list[dict]:
    """
    Analyse COMMITTEE vote records.

    Partisan:   every voting D went one way AND every voting R went the opposite.
    Bipartisan: at least one D AND at least one R both voted Yea.
    """
    flags: list[dict] = []

    d_votes = [r["Vote"] for r in vote_records
               if r.get("Party") == "D" and r["Vote"] in ("Yea", "Nay")]
    r_votes = [r["Vote"] for r in vote_records
               if r.get("Party") == "R" and r["Vote"] in ("Yea", "Nay")]

    if not d_votes or not r_votes:
        return flags

    d_unanimous = len(set(d_votes)) == 1
    r_unanimous = len(set(r_votes)) == 1
    opposite = d_votes[0] != r_votes[0]

    if d_unanimous and r_unanimous and opposite:
        flags.append({"type": "partisan", "label": "Partisan vote",
                      "icon": "⚠️", "color": "warning"})

    if any(v == "Yea" for v in d_votes) and any(v == "Yea" for v in r_votes):
        flags.append({"type": "bipartisan", "label": "Bipartisan",
                      "icon": "✅", "color": "success"})

    return flags


def floor_split_flags(floor_vote_records: list[dict]) -> list[dict]:
    """
    Analyse FLOOR vote records (both chambers) for cross-party splits on bills
    that passed. Returns one flag per chamber per split type, each carrying a
    'chamber' key so the UI can label "House: R split (3)".

    These flags travel with the bill: a House split shows in the Senate tab too.
    """
    flags: list[dict] = []

    for chamber in ("House", "Senate"):
        chamber_votes = [r for r in floor_vote_records if r.get("Chamber") == chamber]
        if not chamber_votes:
            continue

        total_yea = sum(1 for r in chamber_votes if r["Vote"] == "Yea")
        total_nay = sum(1 for r in chamber_votes if r["Vote"] == "Nay")
        if total_yea <= total_nay:
            continue  # only flag splits on bills that actually passed

        r_yeas = [r for r in chamber_votes if r.get("Party") == "R" and r["Vote"] == "Yea"]
        d_nays = [r for r in chamber_votes if r.get("Party") == "D" and r["Vote"] == "Nay"]

        if r_yeas:
            flags.append({"type": "floor_split", "chamber": chamber, "party": "R",
                          "count": len(r_yeas), "icon": "🔵",
                          "label": f"{chamber}: R split ({len(r_yeas)})", "color": "primary"})
        if d_nays:
            flags.append({"type": "floor_split", "chamber": chamber, "party": "D",
                          "count": len(d_nays), "icon": "🔵",
                          "label": f"{chamber}: D split ({len(d_nays)})", "color": "primary"})

    return flags


def committee_status(start_time: str | None, end_time: str | None, now_time: str) -> str:
    """
    Status of a committee meeting relative to the current time.
    Returns 'active' | 'upcoming' | 'concluded' | 'unknown'.

    The OLIS API provides a start time but no end time, so callers pass an
    assumed end (start + a fixed duration) to make the active/concluded split
    meaningful in live mode.
    """
    if not start_time:
        return "unknown"
    if now_time < start_time:
        return "upcoming"
    if end_time and now_time > end_time:
        return "concluded"
    return "active"
