"""
All OLIS OData API calls for the dashboard.

Endpoint names and field quirks were verified against the live API with
explore_api.py — they differ from the original plan's guesses:
  * Floor schedule        -> FloorSessionAgendaItems  (not ScheduledActions)
  * Committee meetings     -> CommitteeMeetings (has start time, no end time)
  * Committee agenda items -> CommitteeAgendaItems  (field is 'CommitteCode', sic)
  * Committee votes        -> CommitteeVotes  (VoteName == LegislatorCode, no party)
  * Floor votes            -> MeasureVotes    (VoteName == LegislatorCode, no party)
Vote values are 'Aye'/'Nay'/'Excused' (not 'Yea'); chambers are 'H'/'S';
party is the full word 'Democrat'/'Republican'. We normalise all of these into
the clean shapes flags.py expects: Vote in {'Yea','Nay','Excused'},
Chamber in {'House','Senate'}, Party in {'D','R','I'}.
"""
from __future__ import annotations

import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API_BASE = "https://api.oregonlegislature.gov/odata/odataservice.svc"
OLIS_BASE = "https://olis.oregonlegislature.gov/liz"

PAGE_SIZE = 1000           # the API honours up to 1000 rows per request
CACHE_TTL = 600            # seconds (10 minutes)

# ── HTTP session ─────────────────────────────────────────────────────────────


def create_http() -> requests.Session:
    retry = Retry(total=3, backoff_factor=0.5,
                  status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=20)
    s = requests.Session()
    s.mount("https://", adapter)
    return s


_http = create_http()

# ── Simple in-memory TTL cache ───────────────────────────────────────────────

_cache: dict[str, tuple[float, object]] = {}


def cached_fetch(key: str, fetch_fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    result = fetch_fn()
    _cache[key] = (now, result)
    return result


def clear_cache():
    _cache.clear()


# ── Low-level OData fetch ────────────────────────────────────────────────────


def _fetch_page(endpoint: str, filter_expr: str | None, top: int, skip: int,
                orderby: str | None, inlinecount: bool) -> dict:
    params = {"$format": "json", "$top": str(top)}
    if skip:
        params["$skip"] = str(skip)
    if filter_expr:
        params["$filter"] = filter_expr
    if orderby:
        params["$orderby"] = orderby
    if inlinecount:
        params["$inlinecount"] = "allpages"
    resp = _http.get(f"{API_BASE}/{endpoint}", params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_all(endpoint: str, filter_expr: str | None = None,
              orderby: str | None = None) -> list[dict]:
    """Page through every record matching the filter."""
    results: list[dict] = []
    skip = 0
    while True:
        data = _fetch_page(endpoint, filter_expr, PAGE_SIZE, skip, orderby, False)
        page = data.get("value", data.get("d", {}).get("results", []))
        if not page:
            break
        results.extend(page)
        if len(page) < PAGE_SIZE:
            break
        skip += PAGE_SIZE
    return results


def count_only(endpoint: str, filter_expr: str) -> int:
    """Cheap count via $inlinecount=allpages without pulling all rows."""
    data = _fetch_page(endpoint, filter_expr, 1, 0, None, True)
    raw = data.get("odata.count") or data.get("d", {}).get("__count") or data.get("__count")
    try:
        return int(raw)
    except (TypeError, ValueError):
        # Fall back to actually counting (shouldn't normally happen).
        return len(data.get("value", []))


# ── Normalisation helpers ────────────────────────────────────────────────────

CHAMBER_NAME = {"H": "House", "S": "Senate", "J": "Joint"}


def chamber_to_code(chamber: str) -> str:
    """'house' / 'senate' -> 'H' / 'S'."""
    return {"house": "H", "senate": "S"}.get((chamber or "").lower(), "")


def party_letter(party_full: str | None) -> str:
    p = (party_full or "").strip().lower()
    if p.startswith("democrat"):
        return "D"
    if p.startswith("republican"):
        return "R"
    return "I"


def normalise_vote(meaning: str | None) -> str:
    m = (meaning or "").strip().lower()
    if m == "aye":
        return "Yea"
    if m == "nay":
        return "Nay"
    return "Excused"


def bill_url(session_key: str, prefix: str, number: int) -> str:
    return f"{OLIS_BASE}/{session_key}/Measures/Overview/{prefix}{number}"


def _day_filter(field: str, date_str: str) -> str:
    """OData filter fragment selecting one calendar day [date, date+1) on `field`."""
    return (f"{field} ge datetime'{date_str}T00:00:00' and "
            f"{field} lt datetime'{_next_day(date_str)}T00:00:00'")


def _next_day(date_str: str) -> str:
    from datetime import date, timedelta
    y, m, d = (int(x) for x in date_str.split("-"))
    return (date(y, m, d) + timedelta(days=1)).isoformat()


def _key(prefix, number) -> tuple[str, int]:
    return (prefix or "", number or 0)


# ── Session-wide reference data (bulk, cached) ───────────────────────────────


def get_legislator_party_map(session_key: str) -> dict[str, str]:
    """LegislatorCode -> 'D'/'R'/'I'."""
    def fetch():
        rows = fetch_all("Legislators", f"SessionKey eq '{session_key}'")
        return {r["LegislatorCode"]: party_letter(r.get("Party")) for r in rows}
    return cached_fetch(f"legislators:{session_key}", fetch)


def get_measures_map(session_key: str) -> dict[tuple, dict]:
    """(prefix, number) -> measure record (catchline, current location, chapter)."""
    def fetch():
        rows = fetch_all("Measures", f"SessionKey eq '{session_key}'")
        return {_key(r.get("MeasurePrefix"), r.get("MeasureNumber")): r for r in rows}
    return cached_fetch(f"measures:{session_key}", fetch)


def get_chief_sponsor_map(session_key: str) -> dict[tuple, str]:
    """(prefix, number) -> chief sponsor display name."""
    def fetch():
        rows = fetch_all("MeasureSponsors",
                         f"SessionKey eq '{session_key}' and SponsorLevel eq 'Chief'",
                         orderby="PrintOrder")
        out: dict[tuple, str] = {}
        for r in rows:
            k = _key(r.get("MeasurePrefix"), r.get("MeasureNumber"))
            if k in out:
                continue  # keep first (lowest PrintOrder) chief sponsor
            name = r.get("LegislatoreCode") or r.get("CommitteeCode") or ""
            if name:
                out[k] = name
        return out
    return cached_fetch(f"sponsors:{session_key}", fetch)


def get_committees_map(session_key: str) -> dict[str, dict]:
    """CommitteeCode -> {name, chamber}.  chamber: 'house'/'senate'/'joint'."""
    def fetch():
        rows = fetch_all("Committees", f"SessionKey eq '{session_key}'")
        out = {}
        for r in rows:
            ho = (r.get("HouseOfAction") or "").upper()
            chamber = {"H": "house", "S": "senate"}.get(ho, "joint")
            out[r["CommitteeCode"]] = {"name": r.get("CommitteeName", r["CommitteeCode"]),
                                       "chamber": chamber}
        return out
    return cached_fetch(f"committees:{session_key}", fetch)


def get_committee_votes_by_bill(session_key: str) -> dict[tuple, list[dict]]:
    """
    (prefix, number) -> list of normalised committee vote records for the most
    recent committee vote event on that bill:
        {'member', 'Party', 'Vote', 'Committee'}
    """
    def fetch():
        party = get_legislator_party_map(session_key)
        rows = fetch_all("CommitteeVotes", f"SessionKey eq '{session_key}'")
        grouped: dict[tuple, list[dict]] = {}
        for r in rows:
            if not r.get("MeasurePrefix"):
                continue
            grouped.setdefault(_key(r["MeasurePrefix"], r["MeasureNumber"]), []).append(r)

        out: dict[tuple, list[dict]] = {}
        for k, recs in grouped.items():
            # Use only the latest committee vote event (avoid merging re-votes /
            # votes in multiple committees).
            latest = max(r.get("MeetingDate") or "" for r in recs)
            latest_recs = [r for r in recs if (r.get("MeetingDate") or "") == latest]
            out[k] = [{
                "member": r.get("VoteName"),
                "Party": party.get(r.get("VoteName"), "I"),
                "Vote": normalise_vote(r.get("Meaning")),
                "Committee": r.get("CommitteeCode"),
            } for r in latest_recs]
        return out
    return cached_fetch(f"cvotes:{session_key}", fetch)


def get_floor_votes_by_bill(session_key: str) -> dict[tuple, list[dict]]:
    """
    (prefix, number) -> list of normalised floor vote records across BOTH
    chambers (latest roll call per chamber):
        {'member', 'Party', 'Vote', 'Chamber'}  Chamber in {'House','Senate'}
    """
    def fetch():
        party = get_legislator_party_map(session_key)
        rows = fetch_all("MeasureVotes", f"SessionKey eq '{session_key}'")
        # group by bill+chamber
        grouped: dict[tuple, list[dict]] = {}
        for r in rows:
            if not r.get("MeasurePrefix"):
                continue
            ck = (r["MeasurePrefix"], r["MeasureNumber"], r.get("Chamber"))
            grouped.setdefault(ck, []).append(r)

        out: dict[tuple, list[dict]] = {}
        for (prefix, number, ch), recs in grouped.items():
            latest = max(r.get("ActionDate") or "" for r in recs)
            latest_recs = [r for r in recs if (r.get("ActionDate") or "") == latest]
            bill_key = _key(prefix, number)
            out.setdefault(bill_key, []).extend({
                "member": r.get("VoteName"),
                "Party": party.get(r.get("VoteName"), "I"),
                "Vote": normalise_vote(r.get("Vote")),
                "Chamber": CHAMBER_NAME.get(ch, ch),
            } for r in latest_recs)
        return out
    return cached_fetch(f"fvotes:{session_key}", fetch)


# ── Date / chamber specific data ─────────────────────────────────────────────


def get_floor_schedule(session_key: str, chamber: str, date_str: str) -> list[dict]:
    """
    Today's floor agenda for a chamber. Returns raw FloorSessionAgendaItems rows
    (MeasurePrefix, MeasureNumber, OrderOfBusiness, Completed) sorted by bill.
    """
    code = chamber_to_code(chamber)

    def fetch():
        filt = (f"SessionKey eq '{session_key}' and Chamber eq '{code}' and "
                + _day_filter("ScheduleDate", date_str))
        return fetch_all("FloorSessionAgendaItems", filt,
                         orderby="MeasurePrefix,MeasureNumber")
    return cached_fetch(f"floor:{session_key}:{code}:{date_str}", fetch)


def get_convene_time(session_key: str, chamber: str, date_str: str) -> str | None:
    """Floor session convene time 'HH:MM' for the chamber/day, or None."""
    code = chamber_to_code(chamber)

    def fetch():
        filt = (f"SessionKey eq '{session_key}' and Chamber eq '{code}' and "
                + _day_filter("SessionDate", date_str))
        rows = fetch_all("ConveneTimes", filt)
        if not rows:
            return None
        return _hhmm(rows[0].get("SessionDate"))
    return cached_fetch(f"convene:{session_key}:{code}:{date_str}", fetch)


def get_committee_meetings(session_key: str, chamber: str, date_str: str) -> list[dict]:
    """
    Committee meetings for the chamber on the date. Returns list of dicts:
        {code, name, chamber, start_time, room, meeting_status}
    chamber is 'house' | 'senate' | 'joint'; each gets its own tab.
    """
    committees = get_committees_map(session_key)

    def fetch():
        filt = (f"SessionKey eq '{session_key}' and "
                + _day_filter("MeetingDate", date_str))
        rows = fetch_all("CommitteeMeetings", filt, orderby="MeetingDate")
        out = []
        for r in rows:
            code = r.get("CommitteeCode")
            info = committees.get(code, {"name": code, "chamber": "joint"})
            out.append({
                "code": code,
                "name": info["name"],
                "chamber": info["chamber"],
                "start_time": _hhmm(r.get("MeetingDate")),
                "room": r.get("Location") or r.get("AlternateLocation") or "",
                "meeting_status": r.get("MeetingStatus"),
            })
        return out

    all_meetings = cached_fetch(f"cmeetings:{session_key}:{date_str}", fetch)
    want = (chamber or "").lower()
    return [m for m in all_meetings if m["chamber"] == want]


def get_committee_agenda(session_key: str, committee_code: str, date_str: str) -> list[dict]:
    """
    Agenda items (bills) for a committee meeting on a date.
    Note the API field is 'CommitteCode' (sic). Items without a measure
    (informational, appointments) are skipped.
    """
    def fetch():
        filt = (f"SessionKey eq '{session_key}' and CommitteCode eq '{committee_code}' and "
                + _day_filter("MeetingDate", date_str))
        return fetch_all("CommitteeAgendaItems", filt, orderby="PrintOrder")
    return cached_fetch(f"agenda:{session_key}:{committee_code}:{date_str}", fetch)


def get_testimony_count(session_key: str, prefix: str, number: int) -> int:
    """Number of public testimony submissions for a bill (cheap, via $inlinecount)."""
    def fetch():
        filt = (f"SessionKey eq '{session_key}' and MeasurePrefix eq '{prefix}' "
                f"and MeasureNumber eq {number}")
        return count_only("CommitteePublicTestimonies", filt)
    return cached_fetch(f"testimony:{session_key}:{prefix}:{number}", fetch)


def testimony_counts(session_key: str, bills: list[tuple]) -> dict[tuple, int]:
    """Parallel testimony counts for many (prefix, number) bills."""
    out: dict[tuple, int] = {}
    if not bills:
        return out
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(get_testimony_count, session_key, p, n): (p, n)
                   for (p, n) in bills}
        for fut, k in futures.items():
            try:
                out[k] = fut.result()
            except Exception:
                out[k] = 0
    return out


def get_sessions() -> list[dict]:
    """All legislative sessions (for the session dropdown), newest first."""
    def fetch():
        rows = fetch_all("LegislativeSessions")
        rows.sort(key=lambda r: r.get("BeginDate") or "", reverse=True)
        return [{"key": r["SessionKey"],
                 "name": r.get("SessionName", r["SessionKey"]),
                 "begin": (r.get("BeginDate") or "")[:10],
                 "default": bool(r.get("DefaultSession"))}
                for r in rows]
    return cached_fetch("sessions", fetch)


def session_name(session_key: str) -> str:
    """Friendly name for a session key, e.g. '2025-2026 Interim'."""
    for s in get_sessions():
        if s["key"] == session_key:
            return s["name"]
    return session_key


def resolve_session_for_date(date_str: str) -> str:
    """
    Determine which session a calendar date belongs to.

    Sessions have no EndDate in the API and their date ranges overlap (e.g. the
    long interim session spans the short regular sessions), so we can't map a
    date to a session by range. Instead we look at where the activity actually
    is: the session that holds that day's committee meetings (or floor agenda).
    Falls back to the most recent session that had begun by that date.
    """
    def fetch():
        for endpoint, field in (("CommitteeMeetings", "MeetingDate"),
                                ("FloorSessionAgendaItems", "ScheduleDate")):
            rows = fetch_all(endpoint, _day_filter(field, date_str))
            keys = [r.get("SessionKey") for r in rows if r.get("SessionKey")]
            if keys:
                return Counter(keys).most_common(1)[0][0]
        # Nothing scheduled that day. Prefer the API's current default session
        # (the active interim); else the newest session already begun by then.
        sessions = get_sessions()
        if not sessions:
            return date_str[:4] + "R1"
        default = next((s for s in sessions if s.get("default") and s.get("begin", "") <= date_str), None)
        if default:
            return default["key"]
        begun = [s for s in sessions if s.get("begin") and s["begin"] <= date_str]
        return (begun or sessions)[0]["key"]
    return cached_fetch(f"resolve:{date_str}", fetch)


# ── tiny time helper ─────────────────────────────────────────────────────────


def _hhmm(dt: str | None) -> str | None:
    """'2026-02-02T13:00:00' -> '13:00'."""
    if not dt or "T" not in dt:
        return None
    try:
        return dt.split("T", 1)[1][:5]
    except Exception:
        return None
