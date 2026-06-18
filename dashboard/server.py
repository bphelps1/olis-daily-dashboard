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


# Standing footer items repeated on every meeting (language access / livestream
# links) — not real agenda content, so they're filtered out.
_BOILERPLATE_RE = re.compile(r"language-access|Legislative-Video|livestream|ListenWiFi", re.I)


def _strip_tags(s: str | None) -> str:
    s = re.sub(r"<[^>]+>", "", s or "")
    s = s.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", s).strip()


def _parse_presenter_lines(body: str) -> tuple[list[str], list[str]]:
    """
    Split an agenda item's body into presenters vs. other lines using the OLIS
    indentation convention: one leading tab = a presenter, two+ tabs = a wrapped
    continuation of the previous presenter, no tab = a plain line (note or a
    numbered work-session item).
    """
    body = re.sub(r"<[^>]+>", "", body or "").replace("&nbsp;", " ").replace("&amp;", "&")
    presenters: list[str] = []
    lines: list[str] = []
    for raw_line in body.split("\n"):
        if not raw_line.strip():
            continue
        lead = len(raw_line) - len(raw_line.lstrip("\t"))
        text = re.sub(r"\s+", " ", raw_line).strip()
        if lead == 0:
            lines.append(text)
        elif lead == 1:
            presenters.append(text)
        elif presenters:
            presenters[-1] += " " + text
        else:
            presenters.append(text)
    return presenters, lines


def parse_agenda_comments(text: str | None, kind: str | None) -> dict | None:
    """
    Turn an informational agenda item's Comments markup into a structured topic:
        {kind, title, presenters: [...], lines: [...]}
    `title` is the bold topic heading; `presenters` are the speakers beneath it;
    `lines` holds untitled content (notes, numbered work-session items).
    Returns None for empty items and standing footer boilerplate.
    """
    if not text or _BOILERPLATE_RE.search(text):
        return None
    title = None
    body = text
    m = re.search(r"<b>(.*?)</b>", text, re.IGNORECASE | re.DOTALL)
    if m:
        title = _strip_tags(m.group(1))
        body = text[m.end():]
    presenters, lines = _parse_presenter_lines(body)
    if not title and not presenters and not lines:
        return None
    return {"kind": (kind or "").strip(), "title": title,
            "presenters": presenters, "lines": lines}


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
            parsed = parse_agenda_comments(a.get("Comments"),
                                           a.get("MeetingType") or a.get("Action"))
            if parsed:
                topics.append(parsed)

        committees_map = api.get_committees_map(session_key)
        name = committees_map.get(code, {}).get("name", code)
        return jsonify({"code": code, "name": name, "bills": bills, "topics": topics})
    except requests.RequestException as e:
        return jsonify({"error": f"Data unavailable — {e}"}), 502


# ── per-bill history: votes (by version) + testimony (by hearing/version) ─────

POSITIONS = {3983: "Support", 3981: "Neutral", 3982: "Oppose"}
# free-text affiliation values that are clearly not organizations
AFFIL_STOP = {"", "self", "myself", "my self", "me", "individual", "private citizen",
              "citizen", "concerned citizen", "constituent", "none", "n/a", "na",
              "anonymous", "resident", "voter", "parent", "teacher", "student"}
MAIN_VERSION_RE = re.compile(r"^(Introduced|[A-Z]-Engrossed|Enrolled)$")


def _version_timeline(history: list[dict]) -> list[dict]:
    events = [{"date": "", "version": "Introduced"}]
    for h in history:
        m = re.search(r"printed\s+([A-Z])-Engrossed", h.get("ActionText") or "", re.I)
        if m:
            events.append({"date": h.get("ActionDate") or "",
                           "version": f"{m.group(1).upper()}-Engrossed"})
    events.sort(key=lambda e: e["date"])
    return events


def _version_at(timeline: list[dict], date: str) -> str:
    v = "Introduced"
    for e in timeline:
        if e["date"] and e["date"] <= date:
            v = e["version"]
    return v


def _vote_result(text: str | None) -> str:
    m = re.search(r"\b(Passed|Failed|Adopted|Lost|Postponed|Withdrawn)\b", text or "", re.I)
    return m.group(1).capitalize() if m else ""


def _tally(rows: list[dict], party: dict, field: str) -> dict:
    aye = nay = excused = d_aye = d_nay = r_aye = r_nay = 0
    nay_names = []
    for r in rows:
        v = api.normalise_vote(r.get(field))
        p = party.get(r.get("VoteName"), "I")
        if v == "Yea":
            aye += 1
            if p == "D": d_aye += 1
            elif p == "R": r_aye += 1
        elif v == "Nay":
            nay += 1
            nay_names.append(r.get("VoteName"))
            if p == "D": d_nay += 1
            elif p == "R": r_nay += 1
        else:
            excused += 1
    return {"aye": aye, "nay": nay, "excused": excused, "dAye": d_aye, "dNay": d_nay,
            "rAye": r_aye, "rNay": r_nay, "nayNames": nay_names}


def _affiliation_candidates(r: dict) -> list[str]:
    """Raw affiliation strings (both free-text fields) to test against the allowlist."""
    out = []
    for v in (r.get("BehalfOf"), r.get("Organization")):
        s = (v or "").strip()
        if s and s.lower() not in AFFIL_STOP:
            out.append(s)
    return out


# ── curated organization allowlist (orgs.json, shared with the static site) ──

def _norm_org(s: str | None) -> str:
    s = re.sub(r"[.,/&'’\-]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def _load_org_matchers() -> list[tuple]:
    import json
    from pathlib import Path
    try:
        data = json.loads((Path(__file__).parent / "orgs.json").read_text())
        orgs = data.get("organizations", [])
    except Exception:
        orgs = []
    matchers = []
    for o in orgs:
        pats = []
        for a in [o["name"], *o.get("aliases", [])]:
            p = _norm_org(a)
            if p:
                pats.append((p, " " not in p and len(p) <= 5))  # short acronym -> whole-word
        matchers.append((o["name"], pats))
    return matchers


_ORG_MATCHERS = _load_org_matchers()


def match_org(aff: str | None) -> str | None:
    a = (aff or "").strip()
    if not a:
        return None
    n = _norm_org(a)
    for name, pats in _ORG_MATCHERS:
        for p, whole in pats:
            if (f" {p} " in f" {n} ") if whole else (p in n):
                return name
    # generic government / public bodies (unambiguous in an affiliation field)
    if re.match(r"^city of \S", a, re.I) or re.search(r"\b(department|bureau) of\b", a, re.I) \
            or re.search(r"\bboard of commissioners\b", a, re.I):
        return re.sub(r"\s+", " ", a).strip()
    return None


def _version_rank(name: str) -> int:
    order = ["Introduced", "A-Engrossed", "B-Engrossed", "C-Engrossed", "D-Engrossed", "Enrolled"]
    return order.index(name) if name in order else 50


@app.route("/api/bill/<prefix>/<int:number>")
def bill_history(prefix, number):
    session_key, date_str, _ = get_params()
    try:
        f = (f"SessionKey eq '{session_key}' and MeasurePrefix eq '{prefix}' "
             f"and MeasureNumber eq {number}")
        party = api.get_legislator_party_map(session_key)
        committees = api.get_committees_map(session_key)
        history = api.fetch_all("MeasureHistoryActions", f, orderby="ActionDate")
        mv = api.fetch_all("MeasureVotes", f)
        cv = api.fetch_all("CommitteeVotes", f)
        test = api.fetch_all("CommitteePublicTestimonies", f)
        docs = api.fetch_all("MeasureDocuments", f)
        tl = _version_timeline(history)

        def cname(code):
            return committees.get(code, {}).get("name", code)

        votes = []
        floor_g: dict = {}
        for r in mv:
            floor_g.setdefault(f"{r.get('Chamber')}|{r.get('MeasureHistoryId') or r.get('ActionDate')}", []).append(r)
        for rows in floor_g.values():
            date = rows[0].get("ActionDate") or ""
            votes.append({"kind": "floor",
                          "where": f"{api.CHAMBER_NAME.get(rows[0].get('Chamber'), rows[0].get('Chamber'))} Floor",
                          "date": date[:10], "version": _version_at(tl, date),
                          "result": _vote_result(rows[0].get("ActionText")),
                          "action": (rows[0].get("ActionText") or "").split(".")[0].strip(),
                          **_tally(rows, party, "Vote")})
        comm_g: dict = {}
        for r in cv:
            comm_g.setdefault(f"{r.get('CommitteeCode')}|{r.get('MeetingDate') or ''}", []).append(r)
        for rows in comm_g.values():
            date = rows[0].get("MeetingDate") or ""
            t = _tally(rows, party, "Meaning")
            votes.append({"kind": "committee", "where": cname(rows[0].get("CommitteeCode")),
                          "date": date[:10], "version": _version_at(tl, date),
                          "result": "Do pass" if t["aye"] > t["nay"] else "Not passed",
                          "action": "Work session", **t})
        votes.sort(key=lambda v: v["date"])

        h_g: dict = {}
        for r in test:
            h_g.setdefault(f"{r.get('CommitteeCode')}|{(r.get('MeetingDate') or '')[:10]}", []).append(r)
        total_by_pos = {"Support": 0, "Oppose": 0, "Neutral": 0}
        for r in test:
            p = POSITIONS.get(r.get("PositionOnMeasureId"))
            if p in total_by_pos:
                total_by_pos[p] += 1
        hearings = []
        for rows in h_g.values():
            date = rows[0].get("MeetingDate") or ""
            positions = {}
            for pos in ("Support", "Oppose", "Neutral"):
                recs = [r for r in rows if POSITIONS.get(r.get("PositionOnMeasureId")) == pos]
                orgs: dict = {}
                others = 0
                other_samples: dict = {}
                for r in recs:
                    matched = None
                    for cand in _affiliation_candidates(r):
                        matched = match_org(cand)
                        if matched:
                            break
                    if matched:
                        orgs[matched] = orgs.get(matched, 0) + 1
                    else:
                        others += 1
                        cands = _affiliation_candidates(r)
                        if cands:
                            other_samples[cands[0]] = other_samples.get(cands[0], 0) + 1
                positions[pos] = {
                    "count": len(recs), "others": others,
                    "orgs": [{"name": n, "count": c} for n, c in
                             sorted(orgs.items(), key=lambda kv: (-kv[1], kv[0]))],
                    "otherSamples": [n for n, _ in
                                     sorted(other_samples.items(), key=lambda kv: -kv[1])[:12]],
                }
            hearings.append({"where": cname(rows[0].get("CommitteeCode")),
                             "date": date[:10], "version": _version_at(tl, date),
                             "positions": positions})
        hearings.sort(key=lambda h: h["date"])

        versions = []
        seen = set()
        for d in docs:
            n = d.get("VersionDescription") or ""
            if MAIN_VERSION_RE.match(n) and n not in seen:
                seen.add(n)
                versions.append({"name": n, "url": d.get("DocumentUrl")})
        versions.sort(key=lambda v: _version_rank(v["name"]))

        return jsonify({"votes": votes,
                        "testimony": {"total": len(test), "byPosition": total_by_pos,
                                      "hearings": hearings},
                        "versions": versions})
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
