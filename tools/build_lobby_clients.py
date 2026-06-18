#!/usr/bin/env python3
"""
Generate dashboard/lobby_clients.json (and docs/lobby_clients.json) from the
Capitol Club lobbyist spreadsheet's "Client(s)" column — the registry of
organizations represented before the Oregon Legislature.

Usage:
    python3 tools/build_lobby_clients.py [path/to/capitol_club_contacts.xlsx]

Output schema matches orgs.json: {"organizations": [{"name", "aliases": [...]}]}.
The dashboard matches the curated orgs.json first, then this file.

Cleaning:
  - split the semicolon-separated Client(s) cells into distinct names
  - strip "c/o ...", "& its affiliates", and pull "dba"/"formerly" + trailing
    "(ACRONYM)" out as aliases; add a corporate-suffix-stripped core as an alias
  - bare Oregon city names (cities lobby under their own name) are rewritten to
    "City of X" so they match only the qualified form — otherwise a resident who
    types their hometown in testimony would false-match the city government.
"""
import json
import re
import sys
from pathlib import Path

import openpyxl

# Oregon incorporated cities + common unincorporated communities that appear in
# the registry as bare client names. Used only to disambiguate (-> "City of X").
OREGON_CITIES = {
    "adair village", "adams", "albany", "amity", "antelope", "arlington", "ashland",
    "astoria", "athena", "aumsville", "aurora", "baker city", "bandon", "banks",
    "barlow", "bay city", "beaverton", "bend", "boardman", "bonanza", "brookings",
    "brownsville", "burns", "butte falls", "canby", "cannon beach", "canyon city",
    "canyonville", "carlton", "cascade locks", "cave junction", "central point",
    "chiloquin", "clatskanie", "coburg", "columbia city", "condon", "coos bay",
    "coquille", "cornelius", "corvallis", "cottage grove", "cove", "creswell",
    "culver", "dallas", "dayton", "dayville", "depoe bay", "detroit", "donald",
    "drain", "dufur", "dundee", "dunes city", "durham", "eagle point", "echo",
    "elgin", "elkton", "enterprise", "estacada", "eugene", "fairview", "falls city",
    "florence", "forest grove", "fossil", "garibaldi", "gaston", "gates", "gearhart",
    "gervais", "gladstone", "glendale", "gold beach", "gold hill", "granite",
    "grants pass", "grass valley", "greenhorn", "gresham", "haines", "halfway",
    "halsey", "happy valley", "harrisburg", "helix", "heppner", "hermiston",
    "hillsboro", "hines", "hood river", "hubbard", "huntington", "idanha",
    "independence", "ione", "irrigon", "island city", "jacksonville", "jefferson",
    "john day", "jordan valley", "joseph", "junction city", "keizer", "king city",
    "klamath falls", "lafayette", "la grande", "lake oswego", "lakeside", "lakeview",
    "la pine", "lebanon", "lexington", "lincoln city", "lonerock", "long creek",
    "lostine", "lowell", "lyons", "madras", "malin", "manzanita", "maupin",
    "maywood park", "mcminnville", "medford", "merrill", "metolius", "mill city",
    "millersburg", "milton-freewater", "milwaukie", "mitchell", "molalla", "monmouth",
    "monroe", "monument", "moro", "mosier", "mount angel", "mount vernon", "myrtle creek",
    "myrtle point", "nehalem", "newberg", "newport", "north bend", "north plains",
    "north powder", "nyssa", "oakland", "oakridge", "ontario", "oregon city",
    "paisley", "pendleton", "philomath", "phoenix", "pilot rock", "port orford",
    "portland", "powers", "prairie city", "prineville", "rainier", "redmond",
    "reedsport", "richland", "riddle", "rivergrove", "rockaway beach", "rogue river",
    "roseburg", "rufus", "st. helens", "st. paul", "salem", "sandy", "scappoose",
    "scio", "scotts mills", "seaside", "seneca", "shady cove", "shaniko", "sheridan",
    "sherwood", "siletz", "silverton", "sisters", "sodaville", "spray", "springfield",
    "stanfield", "stayton", "sublimity", "summerville", "sumpter", "sutherlin",
    "sweet home", "talent", "tangent", "the dalles", "tigard", "tillamook", "toledo",
    "troutdale", "tualatin", "turner", "ukiah", "umatilla", "union", "unity",
    "vale", "veneta", "vernonia", "waldport", "wallowa", "warrenton", "wasco",
    "waterloo", "west linn", "westfir", "weston", "wheeler", "willamina", "williams",
    "wilsonville", "winston", "wood village", "woodburn", "yachats", "yamhill", "yoncalla",
}

SUFFIX = re.compile(
    r"[\s,]+(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|incorporated|pc|p\.c|llp)\.?$",
    re.I)


def strip_ends(s: str) -> str:
    return s.strip(" ,.&-–")


def clean(c: str):
    aliases = []
    s = c.strip()
    s = re.split(r"[,;]?\s+c/o\s+", s, flags=re.I)[0].strip()
    s = re.sub(r"\s*(&|and)\s+its\s+affiliates\.?$", "", s, flags=re.I).strip()
    m = re.split(r",?\s+(?:formerly|fka|f/k/a)\s+", s, flags=re.I)
    if len(m) == 2:
        s = m[0].strip()
        aliases.append(strip_ends(m[1]))
    m = re.split(r"\s+dba\s+", s, flags=re.I)
    if len(m) == 2:
        s = m[0].strip()
        aliases.append(strip_ends(m[1]))
    m = re.search(r"\s*\(([^)]+)\)\s*$", s)
    if m:
        acr = m.group(1).strip()
        if len(acr) <= 10 and not acr.islower():   # acronym / short alt only
            aliases.append(acr)
        s = s[:m.start()].strip()
    s = strip_ends(s)
    # disambiguate bare Oregon cities -> "City of X"
    if s.lower() in OREGON_CITIES:
        s = f"City of {s}"
    else:
        core = strip_ends(SUFFIX.sub("", s))
        if core and core.lower() != s.lower() and len(core) >= 4:
            aliases.append(core)
    aliases = [a for a in dict.fromkeys(aliases) if a and a.lower() != s.lower() and len(a) >= 2]
    return s, aliases


def main():
    here = Path(__file__).resolve().parent.parent
    default_xlsx = here.parent / "capitol_club_scraper" / "capitol_club_contacts.xlsx"
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else default_xlsx
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    ws = wb["All Lobbyists"]
    rows = list(ws.iter_rows(values_only=True))
    ci = rows[0].index("Client(s)")

    raw = set()
    for r in rows[1:]:
        if r[ci]:
            for c in str(r[ci]).split(";"):
                c = c.strip()
                if c:
                    raw.add(c)

    cleaned: dict[str, list] = {}
    for c in raw:
        name, al = clean(c)
        if not name or len(name) < 2:
            continue
        cleaned.setdefault(name, [])
        for a in al:
            if a not in cleaned[name]:
                cleaned[name].append(a)

    orgs = [{"name": n, "aliases": cleaned[n]} for n in sorted(cleaned)]
    out = {
        "_comment": ("Organizations from the Capitol Club lobbyist registry (Client(s) column "
                     "of capitol_club_contacts.xlsx). Auto-generated by tools/build_lobby_clients.py. "
                     "Schema matches orgs.json; the curated orgs.json is matched first."),
        "organizations": orgs,
    }
    for dest in (here / "docs" / "lobby_clients.json", here / "dashboard" / "lobby_clients.json"):
        dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
        print(f"wrote {len(orgs)} orgs -> {dest}")


if __name__ == "__main__":
    main()
