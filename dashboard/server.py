#!/usr/bin/env python3
"""
OLIS Daily Dashboard — Flask app.

Routes (all accept ?date=YYYY-MM-DD and ?session=2026R1):
    GET /                         single-page tabbed UI
    GET /api/sessions             list of sessions for the dropdown
    GET /api/floor/<chamber>      floor schedule (chamber = house|senate)
    GET /api/committees/<chamber> committees meeting that day + live status
    GET /api/committee/<code>     full agenda + flags for one committee
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date as date_cls, datetime

import requests
from flask import Flask, jsonify, render_template, request

from . import api, flags

app = Flask(__name__)
DEFAULT_SESSION = "2026R1"

# Committee meetings have a start time but no end time in the API. Assume a
# fixed duration so the active / concluded distinction works in live mode.
ASSUMED_MEETING_MINUTES = 120


# ── request param parsing ────────────────────────────────────────────────────


def get_params() -> tuple[str, str, bool]:
    """
    Returns (session_key, date_str, is_today). When the session param is empty
    or "auto", the session is resolved from the date — important because interim
    committee meetings live under a different (interim) session key than the
    regular session.
    """
    date_str = request.args.get("date", "").strip() or date_cls.today().isoformat()
    session_key = request.args.get("session", "").strip()
    if not session_key or session_key.lower() == "auto":
        session_key = api.resolve_session_for_date(date_str)
    is_today = (date_str == date_cls.today().isoformat())
    return session_key, date_str, is_today


# ── bill enrichment ──────────────────────────────────────────────────────────


def clean_action(text: str | None) -> str:
    if not text:
        return ""
    # "First Reading Of House Bills" -> "First Reading"
    return re.sub(r"\s+Of (House|Senate).*$", "", text, flags=re.IGNORECASE).strip()


def clean_comments(text: str | None) -> str:
    """Strip the HTML / tab markup OLIS puts in agenda-item Comments."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)                 # drop HTML tags
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    text = re.sub(r"[\t\r\n]+", " · ", text)             # tabs/newlines -> separator
    text = re.sub(r"(\s*·\s*)+", " · ", text).strip(" ·")
    return re.sub(r"\s{2,}", " ", text).strip()


def build_bill(session_key, prefix, number, action,
               measures, sponsors, cvotes, fvotes, testimony):
    key = (prefix, number)
    measure = measures.get(key, {})
    bill_flags: list[dict] = []

    tcount = testimony.get(key, 0)
    tflag = flags.testimony_flag(tcount)
    if tflag:
        bill_flags.append(tflag)

    bill_flags.extend(flags.partisan_and_bipartisan_flags(cvotes.get(key, [])))
    bill_flags.extend(flags.floor_split_flags(fvotes.get(key, [])))

    return {
        "bill": f"{prefix} {number}",
        "prefix": prefix,
        "number": number,
        "url": api.bill_url(session_key, prefix, number),
        "catchline": measure.get("CatchLine") or "",
        "status": measure.get("CurrentLocation") or "",
        "action": clean_action(action),
        "sponsor": sponsors.get(key, ""),
        "testimony_count": tcount,
        "flags": bill_flags,
    }


def originating_chamber(prefix: str) -> str:
    """Chamber a bill was introduced in, from its prefix: HB/HCR/... -> H, SB/... -> S."""
    return "H" if (prefix or "").upper().startswith("H") else "S"


def wants_testimony(prefix: str, action: str | None, action_chamber: str | None) -> bool:
    """
    Whether it's worth counting public testimony for this agenda item.

    Skip a bill getting its FIRST READING in its ORIGINATING chamber — it has
    just been introduced and hasn't been to committee, so there is no testimony
    yet. Count it everywhere else, including a first reading in the second
    chamber (which means it already cleared the first chamber's committee, where
    that testimony was taken).
    """
    if action and "first reading" in action.lower():
        return action_chamber != originating_chamber(prefix)
    return True


def enrich_bills(session_key, items):
    """
    items: list of (prefix, number, action, count_testimony) tuples.
    Returns enriched bill objects. Shared session maps are fetched once;
    testimony counts are fetched in parallel, but only for the bills flagged
    count_testimony=True (see wants_testimony).
    """
    measures = api.get_measures_map(session_key)
    sponsors = api.get_chief_sponsor_map(session_key)
    cvotes = api.get_committee_votes_by_bill(session_key)
    fvotes = api.get_floor_votes_by_bill(session_key)

    need = list({(p, n) for (p, n, _a, count_t) in items if count_t})
    testimony = api.testimony_counts(session_key, need)

    return [build_bill(session_key, p, n, a, measures, sponsors, cvotes, fvotes, testimony)
            for (p, n, a, _count_t) in items]


# ── time helpers for committee status ────────────────────────────────────────


def add_minutes(hhmm: str, minutes: int) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = h * 60 + m + minutes
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


def status_sort_key(meeting: dict) -> tuple:
    """Order: active, upcoming (by start asc), concluded (by start desc), unknown."""
    rank = {"active": 0, "upcoming": 1, "concluded": 2, "unknown": 3}
    st = meeting.get("start_time") or "99:99"
    status = meeting["status"]
    if status == "concluded":
        # most recently started first -> invert time
        return (rank[status], _invert_time(st))
    return (rank[status], st, meeting["name"].lower())


def _invert_time(hhmm: str) -> str:
    # produce a key that sorts later start times first
    try:
        h, m = (int(x) for x in hhmm.split(":"))
        return f"{(24 * 60 - (h * 60 + m)):04d}"
    except Exception:
        return "9999"


# ── routes ───────────────────────────────────────────────────────────────────


@app.route("/")
def index():
    try:
        sessions = api.get_sessions()
    except requests.RequestException:
        sessions = [{"key": DEFAULT_SESSION, "name": DEFAULT_SESSION}]
    return render_template("index.html",
                           sessions=sessions,
                           today=date_cls.today().isoformat())


@app.route("/api/sessions")
def sessions():
    try:
        return jsonify(api.get_sessions())
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/floor/<chamber>")
def floor(chamber):
    session_key, date_str, _ = get_params()
    if chamber not in ("house", "senate"):
        return jsonify({"error": "Unknown chamber"}), 404
    try:
        rows = api.get_floor_schedule(session_key, chamber, date_str)
        items = [(r["MeasurePrefix"], r["MeasureNumber"], r.get("OrderOfBusiness"),
                  wants_testimony(r["MeasurePrefix"], r.get("OrderOfBusiness"), r.get("Chamber")))
                 for r in rows if r.get("MeasurePrefix")]
        bills = enrich_bills(session_key, items)
        convene = api.get_convene_time(session_key, chamber, date_str)
        return jsonify({"bills": bills, "convene_time": convene,
                        "session": session_key, "session_name": api.session_name(session_key)})
    except requests.RequestException as e:
        return jsonify({"error": f"Data unavailable — {e}"}), 502


@app.route("/api/committees/<chamber>")
def committees(chamber):
    session_key, date_str, is_today = get_params()
    if chamber not in ("house", "senate", "joint"):
        return jsonify({"error": "Unknown chamber"}), 404
    try:
        meetings = api.get_committee_meetings(session_key, chamber, date_str)
        now_time = datetime.now().strftime("%H:%M")

        any_times = any(m.get("start_time") for m in meetings)

        # agenda counts in parallel: bills (items tied to a measure) and
        # informational items (interim topic discussions carry no bill).
        def agenda_counts(m):
            agenda = api.get_committee_agenda(session_key, m["code"], date_str)
            bills = sum(1 for a in agenda if a.get("MeasurePrefix"))
            info = sum(1 for a in agenda
                       if not a.get("MeasurePrefix") and (a.get("Comments") or a.get("MeetingType")))
            return bills, info

        with ThreadPoolExecutor(max_workers=10) as pool:
            counts = list(pool.map(agenda_counts, meetings))

        for m, (bills, info) in zip(meetings, counts):
            m["bill_count"] = bills
            m["item_count"] = info
            if is_today and m.get("start_time"):
                end = add_minutes(m["start_time"], ASSUMED_MEETING_MINUTES)
                m["status"] = flags.committee_status(m["start_time"], end, now_time)
            else:
                m["status"] = "unknown"

        if is_today and any_times:
            meetings.sort(key=status_sort_key)
            grouped = True
        elif any_times:
            # past or future day: list chronologically by start time
            meetings.sort(key=lambda m: (m.get("start_time") or "99:99", m["name"].lower()))
            grouped = False
        else:
            meetings.sort(key=lambda m: m["name"].lower())
            grouped = False

        return jsonify({"committees": meetings, "grouped": grouped, "is_today": is_today,
                        "session": session_key, "session_name": api.session_name(session_key)})
    except requests.RequestException as e:
        return jsonify({"error": f"Data unavailable — {e}"}), 502


@app.route("/api/committee/<code>")
def committee_detail(code):
    session_key, date_str, _ = get_params()
    try:
        agenda = api.get_committee_agenda(session_key, code, date_str)
        # Committee agenda items are hearings / work sessions, never first
        # readings, so testimony is always worth counting here.
        items = [(a["MeasurePrefix"], a["MeasureNumber"],
                  a.get("Action") or a.get("MeetingType"), True)
                 for a in agenda if a.get("MeasurePrefix")]
        bills = enrich_bills(session_key, items)

        # Informational / topic agenda items (common in the interim) carry no
        # bill — their substance is in MeetingType + Comments.
        topics = []
        for a in agenda:
            if a.get("MeasurePrefix"):
                continue
            text = clean_comments(a.get("Comments"))
            kind = (a.get("MeetingType") or a.get("Action") or "").strip()
            if text or kind:
                topics.append({"kind": kind, "text": text})

        committees_map = api.get_committees_map(session_key)
        name = committees_map.get(code, {}).get("name", code)
        return jsonify({"code": code, "name": name, "bills": bills, "topics": topics})
    except requests.RequestException as e:
        return jsonify({"error": f"Data unavailable — {e}"}), 502


def main():
    import os
    # Default to 5001 — macOS reserves 5000 for the AirPlay Receiver.
    port = int(os.environ.get("PORT", "5001"))
    print(f"\n  OLIS Daily Dashboard running at  http://127.0.0.1:{port}\n")
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
