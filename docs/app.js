/*
 * OLIS Daily Dashboard — client-side data layer.
 *
 * This is a browser port of the Python Flask backend (api.py / flags.py /
 * server.py). The Oregon Legislature OData API sends `Access-Control-Allow-Origin: *`,
 * so the browser can call it directly and the whole app can run as a static
 * site on GitHub Pages — no server required.
 *
 * Field quirks (verified against the live API):
 *   Floor schedule        -> FloorSessionAgendaItems
 *   Committee meetings     -> CommitteeMeetings (start time only, no end)
 *   Committee agenda items -> CommitteeAgendaItems (field is 'CommitteCode', sic)
 *   Committee / floor votes -> CommitteeVotes / MeasureVotes (VoteName == LegislatorCode)
 * Votes are 'Aye'/'Nay'/'Excused' (not 'Yea'); chambers 'H'/'S'; party full words.
 * We normalise to Vote in {Yea,Nay,Excused}, Chamber in {House,Senate}, Party in {D,R,I}.
 */
const API_BASE = "https://api.oregonlegislature.gov/odata/odataservice.svc";
const OLIS_BASE = "https://olis.oregonlegislature.gov/liz";
const PAGE = 1000;
const TTL = 10 * 60 * 1000;        // 10-minute cache
const CHAMBER = { H: "House", S: "Senate", J: "Joint" };
const TESTIMONY_THRESHOLD = 25;
const ASSUMED_MEETING_MINUTES = 120;

// ── low-level OData ──────────────────────────────────────────────────────────
async function odata(endpoint, params) {
  const u = new URL(`${API_BASE}/${endpoint}`);
  u.search = new URLSearchParams({ "$format": "json", ...params }).toString();
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${endpoint} → HTTP ${r.status}`);
  return r.json();
}

async function fetchAll(endpoint, filter, orderby) {
  const out = [];
  let skip = 0;
  for (;;) {
    const params = { "$top": String(PAGE), "$skip": String(skip) };
    if (filter) params["$filter"] = filter;
    if (orderby) params["$orderby"] = orderby;
    const data = await odata(endpoint, params);
    const page = data.value || [];
    out.push(...page);
    if (page.length < PAGE) break;
    skip += PAGE;
  }
  return out;
}

async function countOnly(endpoint, filter) {
  const data = await odata(endpoint, { "$inlinecount": "allpages", "$top": "1", "$filter": filter });
  return parseInt(data["odata.count"] || 0, 10) || 0;
}

// ── promise cache (dedupes concurrent calls, evicts on failure) ──────────────
const _cache = new Map();
function cached(key, fn) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.t < TTL) return hit.v;
  const v = fn();
  _cache.set(key, { t: now, v });
  Promise.resolve(v).catch(() => { if (_cache.get(key)?.v === v) _cache.delete(key); });
  return v;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const chamberCode = ch => ({ house: "H", senate: "S" }[(ch || "").toLowerCase()] || "");
function partyLetter(p) {
  p = (p || "").toLowerCase();
  if (p.startsWith("democrat")) return "D";
  if (p.startsWith("republican")) return "R";
  return "I";
}
function normVote(m) {
  m = (m || "").trim().toLowerCase();
  if (m === "aye") return "Yea";
  if (m === "nay") return "Nay";
  return "Excused";
}
const billUrl = (s, p, n) => `${OLIS_BASE}/${s}/Measures/Overview/${p}${n}`;
const key = (p, n) => `${p || ""}|${Number(n) || 0}`;
function nextDay(d) {
  const dt = new Date(d + "T00:00:00");
  dt.setDate(dt.getDate() + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
const dayFilter = (field, d) =>
  `${field} ge datetime'${d}T00:00:00' and ${field} lt datetime'${nextDay(d)}T00:00:00'`;
function hhmm(dt) {
  if (!dt || !dt.includes("T")) return null;
  return dt.split("T")[1].slice(0, 5);
}
function addMinutes(t, mins) {
  let [h, m] = t.split(":").map(Number);
  const tot = ((h * 60 + m + mins) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
}
function cleanAction(t) {
  return t ? t.replace(/\s+Of (House|Senate).*$/i, "").trim() : "";
}
// Standing footer items repeated on every meeting (language access / livestream
// links) — not real agenda content, so they're filtered out.
const BOILERPLATE_RE = /language-access|Legislative-Video|livestream|ListenWiFi/i;
function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function parsePresenterLines(body) {
  // OLIS indentation convention: 1 leading tab = a presenter, 2+ tabs = a wrapped
  // continuation of the previous presenter, no tab = a plain line (note / numbered item).
  body = (body || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const presenters = [], lines = [];
  for (const rawLine of body.split("\n")) {
    if (!rawLine.trim()) continue;
    const lead = rawLine.match(/^\t*/)[0].length;
    const text = rawLine.replace(/\s+/g, " ").trim();
    if (lead === 0) lines.push(text);
    else if (lead === 1) presenters.push(text);
    else if (presenters.length) presenters[presenters.length - 1] += " " + text;
    else presenters.push(text);
  }
  return { presenters, lines };
}
function parseAgendaComments(text, kind) {
  if (!text || BOILERPLATE_RE.test(text)) return null;
  let title = null, body = text;
  const m = text.match(/<b>([\s\S]*?)<\/b>/i);
  if (m) { title = stripTags(m[1]); body = text.slice(m.index + m[0].length); }
  const { presenters, lines } = parsePresenterLines(body);
  if (!title && !presenters.length && !lines.length) return null;
  return { kind: (kind || "").trim(), title, presenters, lines };
}
const originatingChamber = p => ((p || "").toUpperCase().startsWith("H") ? "H" : "S");
function wantsTestimony(p, action, ch) {
  if (action && action.toLowerCase().includes("first reading")) return ch !== originatingChamber(p);
  return true;
}

// ── flags ────────────────────────────────────────────────────────────────────
function testimonyFlag(c) {
  return c >= TESTIMONY_THRESHOLD
    ? { type: "testimony", label: `${c} testimonies`, icon: "🔴", color: "danger" } : null;
}
function partisanBipartisanFlags(votes) {
  const fl = [];
  const d = votes.filter(r => r.Party === "D" && (r.Vote === "Yea" || r.Vote === "Nay")).map(r => r.Vote);
  const r = votes.filter(v => v.Party === "R" && (v.Vote === "Yea" || v.Vote === "Nay")).map(v => v.Vote);
  if (!d.length || !r.length) return fl;
  if (new Set(d).size === 1 && new Set(r).size === 1 && d[0] !== r[0])
    fl.push({ type: "partisan", label: "Partisan vote", icon: "⚠️", color: "warning" });
  if (d.includes("Yea") && r.includes("Yea"))
    fl.push({ type: "bipartisan", label: "Bipartisan", icon: "✅", color: "success" });
  return fl;
}
function floorSplitFlags(votes) {
  const fl = [];
  for (const chamber of ["House", "Senate"]) {
    const cv = votes.filter(r => r.Chamber === chamber);
    if (!cv.length) continue;
    const yea = cv.filter(r => r.Vote === "Yea").length;
    const nay = cv.filter(r => r.Vote === "Nay").length;
    if (yea <= nay) continue;
    const ry = cv.filter(r => r.Party === "R" && r.Vote === "Yea").length;
    const dn = cv.filter(r => r.Party === "D" && r.Vote === "Nay").length;
    if (ry) fl.push({ type: "floor_split", chamber, party: "R", count: ry, icon: "🔵",
                      label: `${chamber}: R split (${ry})`, color: "primary" });
    if (dn) fl.push({ type: "floor_split", chamber, party: "D", count: dn, icon: "🔵",
                      label: `${chamber}: D split (${dn})`, color: "primary" });
  }
  return fl;
}
function committeeStatus(start, end, now) {
  if (!start) return "unknown";
  if (now < start) return "upcoming";
  if (end && now > end) return "concluded";
  return "active";
}

// ── session-wide reference data (bulk, cached) ───────────────────────────────
// LegislatorCode -> party across ALL sessions, keeping only codes whose party
// is consistent everywhere. Fallback for vote-casters missing from a session's
// roster snapshot (mid-session departures/chamber moves); ambiguous codes
// (party-switchers, reused surnames) are dropped so it never guesses.
function globalParty() {
  return cached("leg:__global__", async () => {
    const rows = await fetchAll("Legislators");
    const parties = {};
    for (const r of rows) {
      const code = r.LegislatorCode, p = partyLetter(r.Party);
      if (code in parties && parties[code] !== p) parties[code] = null;
      else if (!(code in parties)) parties[code] = p;
    }
    const out = {};
    for (const c in parties) if (parties[c]) out[c] = parties[c];
    return out;
  });
}
function legislatorParty(session) {
  return cached(`leg:${session}`, async () => {
    const [rows, global] = await Promise.all([
      fetchAll("Legislators", `SessionKey eq '${session}'`), globalParty()]);
    const o = { ...global };                 // cross-session fallback first…
    for (const r of rows) o[r.LegislatorCode] = partyLetter(r.Party);  // …session roster wins
    return o;
  });
}
function measuresMap(session) {
  return cached(`meas:${session}`, async () => {
    const rows = await fetchAll("Measures", `SessionKey eq '${session}'`);
    const o = {};
    for (const r of rows) o[key(r.MeasurePrefix, r.MeasureNumber)] = r;
    return o;
  });
}
// PrintOrder is a STRING in the API — compare numerically, or "10" sorts before "2"
function printOrder(v) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 9999;
}
// (prefix, number) -> chief sponsor codes in print order (first = primary)
function chiefSponsorsByBill(session) {
  return cached(`chiefs:${session}`, async () => {
    const rows = await fetchAll("MeasureSponsors",
      `SessionKey eq '${session}' and SponsorLevel eq 'Chief'`);
    const grouped = {};
    for (const r of rows) {
      if (!(r.LegislatoreCode || r.CommitteeCode)) continue;
      (grouped[key(r.MeasurePrefix, r.MeasureNumber)] ||= []).push(r);
    }
    const o = {};
    for (const k in grouped) {
      grouped[k].sort((a, b) => printOrder(a.PrintOrder) - printOrder(b.PrintOrder) ||
        String(a.LegislatoreCode || a.CommitteeCode).localeCompare(String(b.LegislatoreCode || b.CommitteeCode)));
      o[k] = grouped[k].map(r => r.LegislatoreCode || r.CommitteeCode);
    }
    return o;
  });
}
async function chiefSponsorMap(session) {
  const byBill = await chiefSponsorsByBill(session);
  const o = {};
  for (const k in byBill) if (byBill[k].length) o[k] = byBill[k][0];
  return o;
}
// session roster for the picker
function legislatorList(session) {
  return cached(`leglist:${session}`, async () => {
    const rows = await fetchAll("Legislators", `SessionKey eq '${session}'`);
    const out = rows.filter(r => r.LegislatorCode).map(r => ({
      code: r.LegislatorCode,
      name: `${(r.FirstName || "").trim()} ${(r.LastName || "").trim()}`.trim(),
      chamber: CHAMBER[r.Chamber] || r.Chamber,
      party: partyLetter(r.Party),
      district: r.DistrictNumber,
    }));
    out.sort((a, b) => (a.name || a.code || "").toLowerCase().localeCompare((b.name || b.code || "").toLowerCase()));
    return out;
  });
}
// ── committee bills ──────────────────────────────────────────────────────────
// Two distinct relationships, both surfaced in the Sponsors tab:
//   introduced by  -> MeasureSponsors.SponsorType === 'Committee' (+ CommitteeCode)
//   at the request -> Measures.AtTheRequestOf text names an interim/other committee
const REQUEST_RE = /(house|senate|joint)?\s*(?:interim\s+)?committee on\s+(.+?)(?:\s+for\s+|\)|$)/gi;
// collapse the stray tabs/newlines OLIS leaves in title fields
function cleanWs(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function normCmte(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ").trim();
}
// Anchored on "Committee on <name>" and disambiguated by chamber (both chambers
// have e.g. a "Rules" committee). Interim names are often longer than the session
// name, so prefix matching runs both directions and the longest match wins.
function matchRequestedCommittees(text, committees) {
  const hits = [];
  const rx = new RegExp(REQUEST_RE.source, "gi");
  let m;
  while ((m = rx.exec(text || "")) !== null) {
    const chamber = (m[1] || "").toLowerCase();
    const name = normCmte(m[2]);
    let bestCode = null, bestLen = -1;
    for (const code in committees) {
      const info = committees[code];
      const cn = normCmte(info.name);
      if (!cn) continue;
      if (chamber && info.chamber !== chamber) continue;
      if ((name.startsWith(cn) || cn.startsWith(name)) && cn.length > bestLen) {
        bestCode = code; bestLen = cn.length;
      }
    }
    if (bestCode && !hits.includes(bestCode)) hits.push(bestCode);
  }
  return hits;
}
// CommitteeCode -> {introduced: [billKey], requested: [billKey]}
function committeeBillIndex(session) {
  return cached(`cmtebills:${session}`, async () => {
    const [committees, measures, sponsorRows] = await Promise.all([
      committeesMap(session), measuresMap(session),
      fetchAll("MeasureSponsors", `SessionKey eq '${session}' and SponsorType eq 'Committee'`),
    ]);
    const idx = {};
    const slot = c => (idx[c] ||= { introduced: [], requested: [] });
    for (const r of sponsorRows) {
      if (r.CommitteeCode) slot(r.CommitteeCode).introduced.push(key(r.MeasurePrefix, r.MeasureNumber));
    }
    for (const k in measures) {
      const txt = measures[k].AtTheRequestOf || "";
      if (!txt.toLowerCase().includes("committee")) continue;
      for (const code of matchRequestedCommittees(txt, committees)) slot(code).requested.push(k);
    }
    return idx;
  });
}
async function committeeSponsorList(session) {
  const [idx, committees] = await Promise.all([committeeBillIndex(session), committeesMap(session)]);
  const out = [];
  for (const code in idx) {
    const info = committees[code] || { name: code, chamber: "joint" };
    const both = new Set([...idx[code].introduced, ...idx[code].requested]);
    out.push({ code, name: info.name, chamber: info.chamber,
      introduced: idx[code].introduced.length, requested: idx[code].requested.length,
      total: both.size });
  }
  out.sort((a, b) => (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase()));
  return out;
}
// mode: 'introduced' | 'requested' | 'any'
async function committeeBills(session, code, mode) {
  const [idx, measures, committees] = await Promise.all([
    committeeBillIndex(session), measuresMap(session), committeesMap(session)]);
  const b = idx[code] || { introduced: [], requested: [] };
  const intro = new Set(b.introduced), reqd = new Set(b.requested);
  const union = new Set([...intro, ...reqd]);
  const counts = { introduced: intro.size, requested: reqd.size, any: union.size };
  const keys = mode === "introduced" ? intro : (mode === "requested" ? reqd : union);
  const bills = [];
  for (const k of keys) {
    const m = measures[k] || {};
    const [prefix, num] = k.split("|");
    const roles = [];
    if (intro.has(k)) roles.push("Introduced by");
    if (reqd.has(k)) roles.push("At request of");
    bills.push({
      bill: `${prefix} ${num}`, prefix, number: Number(num),
      url: billUrl(session, prefix, num),
      title: cleanWs(m.RelatingTo),                  // formal "Relating to…" title
      catchline: m.CatchLine || "", status: m.CurrentLocation || "", chapter: m.ChapterNumber,
      role: roles.join(" · "), requested_text: (m.AtTheRequestOf || "").trim(),
    });
  }
  bills.sort((a, b2) => a.prefix.localeCompare(b2.prefix) || a.number - b2.number);
  return { session, session_name: await sessionName(session), code,
    name: (committees[code] || {}).name || code, mode, counts, bills };
}

// all sponsor rows for one legislator (targeted, fast)
function sponsorRecords(session, code) {
  return cached(`sponrecs:${session}:${code}`, () => fetchAll("MeasureSponsors",
    `SessionKey eq '${session}' and LegislatoreCode eq '${String(code).replace(/'/g, "''")}'`));
}
// mode: 'first' | 'chief' | 'any'
async function sponsorSearch(session, code, mode) {
  if (!code) return { code: "", mode, bills: [], counts: {} };
  const [records, chiefs, measures] = await Promise.all([
    sponsorRecords(session, code), chiefSponsorsByBill(session), measuresMap(session)]);
  const counts = { first: 0, chief: 0, any: 0 };
  const bills = [];
  for (const r of records) {
    const k = key(r.MeasurePrefix, r.MeasureNumber);
    const billChiefs = chiefs[k] || [];
    const isChief = r.SponsorLevel === "Chief";
    const isFirst = billChiefs.length > 0 && billChiefs[0] === code;
    counts.any++;
    if (isChief) counts.chief++;
    if (isFirst) counts.first++;
    if (mode === "first" && !isFirst) continue;
    if (mode === "chief" && !isChief) continue;
    const m = measures[k] || {};
    bills.push({
      bill: `${r.MeasurePrefix} ${r.MeasureNumber}`, prefix: r.MeasurePrefix, number: r.MeasureNumber,
      url: billUrl(session, r.MeasurePrefix, r.MeasureNumber),
      title: cleanWs(m.RelatingTo),                  // formal "Relating to…" title
      catchline: m.CatchLine || "", status: m.CurrentLocation || "", chapter: m.ChapterNumber,
      role: isFirst ? "First chief" : (isChief ? "Chief" : "Regular"),
      sponsor_type: r.SponsorType || "",
      cosponsors: billChiefs.filter(c => c !== code),
    });
  }
  bills.sort((a, b) => a.prefix.localeCompare(b.prefix) || a.number - b.number);
  return { session, session_name: await sessionName(session), code, mode, counts, bills };
}
function committeesMap(session) {
  return cached(`cmap:${session}`, async () => {
    const rows = await fetchAll("Committees", `SessionKey eq '${session}'`);
    const o = {};
    for (const r of rows) {
      const ho = (r.HouseOfAction || "").toUpperCase();
      o[r.CommitteeCode] = { name: r.CommitteeName || r.CommitteeCode,
                             chamber: { H: "house", S: "senate" }[ho] || "joint" };
    }
    return o;
  });
}
function committeeVotesByBill(session) {
  return cached(`cvotes:${session}`, async () => {
    const party = await legislatorParty(session);
    const rows = await fetchAll("CommitteeVotes", `SessionKey eq '${session}'`);
    const grouped = {};
    for (const r of rows) {
      if (!r.MeasurePrefix) continue;
      (grouped[key(r.MeasurePrefix, r.MeasureNumber)] ||= []).push(r);
    }
    const out = {};
    for (const k in grouped) {
      const recs = grouped[k];
      let latest = ""; for (const r of recs) if ((r.MeetingDate || "") > latest) latest = r.MeetingDate || "";
      out[k] = recs.filter(r => (r.MeetingDate || "") === latest).map(r => ({
        member: r.VoteName, Party: party[r.VoteName] || "I",
        Vote: normVote(r.Meaning), Committee: r.CommitteeCode,
      }));
    }
    return out;
  });
}
function floorVotesByBill(session) {
  return cached(`fvotes:${session}`, async () => {
    const party = await legislatorParty(session);
    const rows = await fetchAll("MeasureVotes", `SessionKey eq '${session}'`);
    const grouped = {};
    for (const r of rows) {
      if (!r.MeasurePrefix) continue;
      (grouped[`${r.MeasurePrefix}|${r.MeasureNumber}|${r.Chamber}`] ||= []).push(r);
    }
    const out = {};
    for (const ck in grouped) {
      const recs = grouped[ck];
      let latest = ""; for (const r of recs) if ((r.ActionDate || "") > latest) latest = r.ActionDate || "";
      const [pfx, num] = ck.split("|");
      (out[key(pfx, num)] ||= []).push(...recs.filter(r => (r.ActionDate || "") === latest).map(r => ({
        member: r.VoteName, Party: party[r.VoteName] || "I",
        Vote: normVote(r.Vote), Chamber: CHAMBER[r.Chamber] || r.Chamber,
      })));
    }
    return out;
  });
}

// ── date / chamber specific ──────────────────────────────────────────────────
function floorSchedule(session, chamber, date) {
  const code = chamberCode(chamber);
  return cached(`floor:${session}:${code}:${date}`, () => fetchAll("FloorSessionAgendaItems",
    `SessionKey eq '${session}' and Chamber eq '${code}' and ${dayFilter("ScheduleDate", date)}`,
    "MeasurePrefix,MeasureNumber"));
}
function conveneTime(session, chamber, date) {
  const code = chamberCode(chamber);
  return cached(`conv:${session}:${code}:${date}`, async () => {
    const rows = await fetchAll("ConveneTimes",
      `SessionKey eq '${session}' and Chamber eq '${code}' and ${dayFilter("SessionDate", date)}`);
    return rows.length ? hhmm(rows[0].SessionDate) : null;
  });
}
async function committeeMeetings(session, chamber, date) {
  const cmap = await committeesMap(session);
  const all = await cached(`cmtg:${session}:${date}`, async () => {
    const rows = await fetchAll("CommitteeMeetings",
      `SessionKey eq '${session}' and ${dayFilter("MeetingDate", date)}`, "MeetingDate");
    return rows.map(r => {
      const info = cmap[r.CommitteeCode] || { name: r.CommitteeCode, chamber: "joint" };
      return { code: r.CommitteeCode, name: info.name, chamber: info.chamber,
               start_time: hhmm(r.MeetingDate), room: r.Location || r.AlternateLocation || "",
               meeting_status: r.MeetingStatus };
    });
  });
  const want = (chamber || "").toLowerCase();
  // chamber is one of house | senate | joint — each has its own tab
  // clone so callers can annotate without mutating the cached objects
  return all.filter(m => m.chamber === want).map(m => ({ ...m }));
}
function committeeAgenda(session, code, date) {
  return cached(`agd:${session}:${code}:${date}`, () => fetchAll("CommitteeAgendaItems",
    `SessionKey eq '${session}' and CommitteCode eq '${code}' and ${dayFilter("MeetingDate", date)}`,
    "PrintOrder"));
}
function testimonyCount(session, prefix, number) {
  return cached(`t:${session}:${prefix}:${number}`, () => countOnly("CommitteePublicTestimonies",
    `SessionKey eq '${session}' and MeasurePrefix eq '${prefix}' and MeasureNumber eq ${number}`));
}

// ── sessions + resolution ────────────────────────────────────────────────────
function getSessions() {
  return cached("sessions", async () => {
    const rows = await fetchAll("LegislativeSessions");
    rows.sort((a, b) => (b.BeginDate || "").localeCompare(a.BeginDate || ""));
    return rows.map(r => ({ key: r.SessionKey, name: r.SessionName || r.SessionKey,
                            begin: (r.BeginDate || "").slice(0, 10), default: !!r.DefaultSession }));
  });
}
async function sessionName(k) {
  const s = (await getSessions()).find(s => s.key === k);
  return s ? s.name : k;
}
// most recent regular session (…R1) — used for session-wide stats, since the
// interim (…I1) that "auto" resolves to today has no floor-passed bills
async function latestRegularSession() {
  const sessions = await getSessions();  // sorted by begin desc
  const reg = sessions.find(s => /R\d+$/i.test(s.key) && (s.begin || "") <= todayISO());
  return (reg || sessions[0] || { key: "" }).key;
}
function resolveSessionForDate(date) {
  return cached(`resolve:${date}`, async () => {
    for (const [ep, field] of [["CommitteeMeetings", "MeetingDate"], ["FloorSessionAgendaItems", "ScheduleDate"]]) {
      const rows = await fetchAll(ep, dayFilter(field, date));
      const counts = {};
      for (const r of rows) if (r.SessionKey) counts[r.SessionKey] = (counts[r.SessionKey] || 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top) return top[0];
    }
    const sessions = await getSessions();
    if (!sessions.length) return date.slice(0, 4) + "R1";
    const def = sessions.find(s => s.default && (s.begin || "") <= date);
    if (def) return def.key;
    const begun = sessions.filter(s => s.begin && s.begin <= date);
    return (begun[0] || sessions[0]).key;
  });
}

// ── enrichment (route equivalents) ───────────────────────────────────────────
function buildBill(session, prefix, number, action, measures, sponsors, cvotes, fvotes, testimony) {
  const k = key(prefix, number);
  const measure = measures[k] || {};
  const tc = testimony[k] || 0;
  const fl = [];
  const tf = testimonyFlag(tc); if (tf) fl.push(tf);
  fl.push(...partisanBipartisanFlags(cvotes[k] || []));
  fl.push(...floorSplitFlags(fvotes[k] || []));
  return { bill: `${prefix} ${number}`, prefix, number, url: billUrl(session, prefix, number),
           catchline: measure.CatchLine || "", status: measure.CurrentLocation || "",
           action: cleanAction(action), sponsor: sponsors[k] || "", testimony_count: tc, flags: fl };
}
async function enrichBills(session, items) {
  const [measures, sponsors, cvotes, fvotes] = await Promise.all([
    measuresMap(session), chiefSponsorMap(session),
    committeeVotesByBill(session), floorVotesByBill(session),
  ]);
  const uniq = new Map();
  for (const i of items) if (i.countT) uniq.set(key(i.prefix, i.number), [i.prefix, i.number]);
  const testimony = {};
  await Promise.all([...uniq.values()].map(async ([p, n]) => {
    testimony[key(p, n)] = await testimonyCount(session, p, n);
  }));
  return items.map(i => buildBill(session, i.prefix, i.number, i.action,
                                  measures, sponsors, cvotes, fvotes, testimony));
}

async function floorData(chamber, session, date) {
  const rows = await floorSchedule(session, chamber, date);
  const items = rows.filter(r => r.MeasurePrefix).map(r => ({
    prefix: r.MeasurePrefix, number: r.MeasureNumber, action: r.OrderOfBusiness,
    countT: wantsTestimony(r.MeasurePrefix, r.OrderOfBusiness, r.Chamber),
  }));
  const [bills, convene] = await Promise.all([enrichBills(session, items), conveneTime(session, chamber, date)]);
  return { bills, convene_time: convene, session, session_name: await sessionName(session) };
}

function statusSortCmp(a, b) {
  const rank = { active: 0, upcoming: 1, concluded: 2, unknown: 3 };
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
  if (a.status === "concluded") return (b.start_time || "").localeCompare(a.start_time || "");
  const ta = a.start_time || "99:99", tb = b.start_time || "99:99";
  return ta !== tb ? ta.localeCompare(tb) : a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

async function committeesData(chamber, session, date, isToday) {
  const meetings = await committeeMeetings(session, chamber, date);
  const now = nowHHMM();
  const anyTimes = meetings.some(m => m.start_time);
  await Promise.all(meetings.map(async m => {
    const agenda = await committeeAgenda(session, m.code, date);
    m.bill_count = agenda.filter(a => a.MeasurePrefix).length;
    m.item_count = agenda.filter(a => !a.MeasurePrefix && (a.Comments || a.MeetingType)).length;
    m.status = (isToday && m.start_time)
      ? committeeStatus(m.start_time, addMinutes(m.start_time, ASSUMED_MEETING_MINUTES), now)
      : "unknown";
  }));
  let grouped;
  if (isToday && anyTimes) { meetings.sort(statusSortCmp); grouped = true; }
  else if (anyTimes) {
    meetings.sort((a, b) => (a.start_time || "99:99").localeCompare(b.start_time || "99:99")
      || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    grouped = false;
  } else { meetings.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())); grouped = false; }
  return { committees: meetings, grouped, is_today: isToday, session, session_name: await sessionName(session) };
}

async function committeeDetail(code, session, date) {
  const agenda = await committeeAgenda(session, code, date);
  const items = agenda.filter(a => a.MeasurePrefix).map(a => ({
    prefix: a.MeasurePrefix, number: a.MeasureNumber, action: a.Action || a.MeetingType, countT: true,
  }));
  const bills = await enrichBills(session, items);
  const topics = [];
  for (const a of agenda) {
    if (a.MeasurePrefix) continue;
    const parsed = parseAgendaComments(a.Comments, a.MeetingType || a.Action);
    if (parsed) topics.push(parsed);
  }
  const name = ((await committeesMap(session))[code] || {}).name || code;
  return { code, name, bills, topics };
}

// ── session-wide statistics ──────────────────────────────────────────────────
function analyzeChamberVote(arr) {
  // returns null if the chamber didn't pass; else {bipartisan, partyLine, unanimous}
  if (!arr.length) return null;
  const aye = arr.filter(v => v.Vote === "Yea").length;
  const nay = arr.filter(v => v.Vote === "Nay").length;
  if (aye <= nay) return null;
  const dAye = arr.some(v => v.Party === "D" && v.Vote === "Yea");
  const rAye = arr.some(v => v.Party === "R" && v.Vote === "Yea");
  const dv = arr.filter(v => v.Party === "D" && (v.Vote === "Yea" || v.Vote === "Nay")).map(v => v.Vote);
  const rv = arr.filter(v => v.Party === "R" && (v.Vote === "Yea" || v.Vote === "Nay")).map(v => v.Vote);
  const partyLine = dv.length && rv.length && new Set(dv).size === 1 && new Set(rv).size === 1 && dv[0] !== rv[0];
  return { bipartisan: dAye && rAye, partyLine, unanimous: nay === 0 };
}
function sessionStats(session) {
  return cached(`stats:${session}`, async () => {
    // precomputed file for completed sessions loads instantly; the current /
    // in-progress session has no file and falls back to live computation below.
    try {
      const r = await fetch(`stats/${encodeURIComponent(session)}.json`, { cache: "no-cache" });
      if (r.ok) { const j = await r.json(); if (j && j.session) return j; }
    } catch (e) { /* fall through to live compute */ }
    const [measures, fvotes] = await Promise.all([measuresMap(session), floorVotesByBill(session)]);
    let total = 0, enacted = 0;
    const byPrefix = {};
    for (const k in measures) {
      const m = measures[k];
      total++;
      byPrefix[m.MeasurePrefix] = (byPrefix[m.MeasurePrefix] || 0) + 1;
      if (m.ChapterNumber != null) enacted++;
    }
    let passedBoth = 0, bipartisan = 0, partyLineAny = 0, unanimousBoth = 0, passedOne = 0;
    let billsPassed = 0, billsBipartisan = 0;
    for (const k in fvotes) {
      const byCh = { House: [], Senate: [] };
      for (const v of fvotes[k]) if (byCh[v.Chamber]) byCh[v.Chamber].push(v);
      const h = analyzeChamberVote(byCh.House), s = analyzeChamberVote(byCh.Senate);
      if (h && s) {
        passedBoth++;
        // bipartisan = cross-party Aye support in at least one chamber
        if (h.bipartisan || s.bipartisan) bipartisan++;
        if (h.partyLine || s.partyLine) partyLineAny++;
        if (h.unanimous && s.unanimous) unanimousBoth++;
        const pfx = (measures[k] || {}).MeasurePrefix;
        if (pfx === "HB" || pfx === "SB") { billsPassed++; if (h.bipartisan || s.bipartisan) billsBipartisan++; }
      } else if (h || s) { passedOne++; }
    }
    const byPrefixArr = Object.entries(byPrefix).sort((a, b) => b[1] - a[1])
      .map(([prefix, count]) => ({ prefix, count }));
    return {
      session, session_name: await sessionName(session), total, enacted, byPrefix: byPrefixArr,
      passedBoth, bipartisan, partyLineAny, unanimousBoth, passedOne,
      bills: { passed: billsPassed, bipartisan: billsBipartisan },
    };
  });
}

// ── committee topic search (across all sessions) ─────────────────────────────
function globalCommittees() {
  // committee code -> name, keyed both by session|code and bare code (latest wins)
  return cached("committees:__global__", async () => {
    const rows = await fetchAll("Committees");
    const o = {};
    for (const r of rows) {
      const name = r.CommitteeName || r.CommitteeCode;
      o[`${r.SessionKey}|${r.CommitteeCode}`] = name;
      o[r.CommitteeCode] = name;
    }
    return o;
  });
}
function agendaUrl(session, code, meetingDate) {
  if (!meetingDate || !meetingDate.includes("T")) return null;
  const dt = meetingDate.slice(0, 16).replace("T", "-").replace(":", "-");  // 2026-06-16-11-30
  return `${OLIS_BASE}/${session}/Committees/${code}/${dt}/Agenda`;
}
function snippetAround(comments, re) {
  const c = stripTags(comments);
  const m = c.match(re);
  if (!m) return c.slice(0, 140);
  const i = c.toLowerCase().indexOf(m[0].toLowerCase());
  const start = Math.max(0, i - 60), end = Math.min(c.length, i + m[0].length + 90);
  return (start > 0 ? "…" : "") + c.slice(start, end) + (end < c.length ? "…" : "");
}
async function searchTopics(term) {
  term = (term || "").trim();
  if (!term) return { query: "", total: 0, meetings: [] };
  const q = term.replace(/'/g, "''");                      // OData escapes ' as ''
  const data = await odata("CommitteeAgendaItems", {
    "$filter": `substringof('${q}', Comments)`,
    "$orderby": "MeetingDate desc",
    "$top": "1000",
    "$inlinecount": "allpages",
  });
  const rows = data.value || [];
  const total = parseInt(data["odata.count"] || rows.length, 10) || rows.length;
  const committees = await globalCommittees();
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const meetings = new Map();
  for (const r of rows) {
    const code = r.CommitteCode;                            // note API typo (no 'e')
    const mkey = `${r.SessionKey}|${code}|${(r.MeetingDate || "").slice(0, 16)}`;
    if (!meetings.has(mkey)) {
      meetings.set(mkey, {
        session: r.SessionKey, code,
        committee: committees[`${r.SessionKey}|${code}`] || committees[code] || code,
        date: (r.MeetingDate || "").slice(0, 10),
        agendaUrl: agendaUrl(r.SessionKey, code, r.MeetingDate),
        items: [],
      });
    }
    const snip = snippetAround(r.Comments, re);
    const bill = r.MeasurePrefix ? `${r.MeasurePrefix} ${r.MeasureNumber}` : null;
    const url = bill ? billUrl(r.SessionKey, r.MeasurePrefix, r.MeasureNumber) : null;
    const m = meetings.get(mkey);
    if (snip && !m.items.some(it => it.snippet === snip)) m.items.push({ bill, url, snippet: snip });
  }
  const list = [...meetings.values()];   // already newest-first from the query order
  return { query: term, total, shown: list.length, capped: total > rows.length, meetings: list };
}

// ── per-bill history: votes (by version) + testimony (by hearing/version) ─────
const POSITIONS = { 3983: "Support", 3981: "Neutral", 3982: "Oppose" };
// free-text affiliation values that are clearly not organizations
const AFFIL_STOP = new Set(["", "self", "myself", "my self", "me", "individual",
  "private citizen", "citizen", "concerned citizen", "constituent", "none", "n/a",
  "na", "anonymous", "resident", "voter", "parent", "teacher", "student"]);

function versionTimeline(historyRows) {
  // engrossment events -> when each printed version took effect (Introduced implicit)
  const events = [{ date: "", version: "Introduced" }];
  for (const h of historyRows) {
    const m = (h.ActionText || "").match(/printed\s+([A-Z])-Engrossed/i);
    if (m) events.push({ date: h.ActionDate || "", version: `${m[1].toUpperCase()}-Engrossed` });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}
function versionAt(timeline, date) {
  let v = "Introduced";
  for (const e of timeline) if (e.date && e.date <= date) v = e.version;
  return v;
}
function voteResult(actionText) {
  const m = (actionText || "").match(/\b(Passed|Failed|Adopted|Lost|Postponed|Withdrawn)\b/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : "";
}
function tallyVotes(rows, party, field) {
  let aye = 0, nay = 0, excused = 0, dAye = 0, dNay = 0, rAye = 0, rNay = 0;
  const nayNames = [];
  for (const r of rows) {
    const v = normVote(r[field]);
    const p = party[r.VoteName] || "I";
    if (v === "Yea") { aye++; if (p === "D") dAye++; else if (p === "R") rAye++; }
    else if (v === "Nay") { nay++; nayNames.push(r.VoteName); if (p === "D") dNay++; else if (p === "R") rNay++; }
    else excused++;
  }
  return { aye, nay, excused, dAye, dNay, rAye, rNay, nayNames };
}
function affiliationCandidates(r) {
  // raw affiliation strings to test against the org allowlist (both free-text fields)
  const out = [];
  for (const v of [r.BehalfOf, r.Organization]) {
    const s = (v || "").trim();
    if (s && !AFFIL_STOP.has(s.toLowerCase())) out.push(s);
  }
  return out;
}

// ── curated organization allowlist matching ──────────────────────────────────
function normOrg(s) {
  return (s || "").toLowerCase().replace(/[.,/&'’\-]/g, " ").replace(/\s+/g, " ").trim();
}
let _matchers = null;
async function orgMatchers() {
  if (_matchers) return _matchers;
  let list = [];
  // curated list first (canonical names + aliases), then the lobbyist registry
  for (const f of ["orgs.json", "lobby_clients.json"]) {
    try { const data = await (await fetch(f)).json(); list = list.concat(data.organizations || []); }
    catch (e) { console.error(f + " load failed", e); }
  }
  _matchers = list.map(o => ({
    name: o.name,
    pats: [o.name, ...(o.aliases || [])].map(a => {
      const p = normOrg(a);
      return { p, whole: !p.includes(" ") && p.length <= 5 };  // short acronyms: whole-word only
    }).filter(x => x.p),
  }));
  return _matchers;
}
function matchOrg(aff, matchers) {
  const a = (aff || "").trim();
  if (!a) return null;
  const n = normOrg(a);
  for (const o of matchers) {
    for (const { p, whole } of o.pats) {
      if (whole ? (" " + n + " ").includes(" " + p + " ") : n.includes(p)) return o.name;
    }
  }
  // generic government/public bodies (unambiguous in an affiliation field)
  if (/^city of \S/i.test(a)) return a.replace(/\s+/g, " ").trim();
  if (/\b(department|bureau) of\b/i.test(a)) return a.replace(/\s+/g, " ").trim();
  if (/\bboard of commissioners\b/i.test(a)) return a.replace(/\s+/g, " ").trim();
  return null;
}
const MAIN_VERSION = /^(Introduced|[A-Z]-Engrossed|Enrolled)$/;

async function billHistory(session, prefix, number) {
  return cached(`hist:${session}:${prefix}:${number}`, async () => {
    const f = `SessionKey eq '${session}' and MeasurePrefix eq '${prefix}' and MeasureNumber eq ${number}`;
    const [party, committees, matchers, hist, mv, cv, test, docs] = await Promise.all([
      legislatorParty(session), committeesMap(session), orgMatchers(),
      fetchAll("MeasureHistoryActions", f, "ActionDate"),
      fetchAll("MeasureVotes", f),
      fetchAll("CommitteeVotes", f),
      fetchAll("CommitteePublicTestimonies", f),
      fetchAll("MeasureDocuments", f),
    ]);
    const tl = versionTimeline(hist);
    const cname = code => (committees[code] || {}).name || code;

    // votes
    const votes = [];
    const floorG = {};
    for (const r of mv) (floorG[`${r.Chamber}|${r.MeasureHistoryId || r.ActionDate}`] ||= []).push(r);
    for (const k in floorG) {
      const rows = floorG[k], date = (rows[0].ActionDate || "");
      votes.push({ kind: "floor", where: `${CHAMBER[rows[0].Chamber] || rows[0].Chamber} Floor`,
        date: date.slice(0, 10), version: versionAt(tl, date),
        result: voteResult(rows[0].ActionText), action: (rows[0].ActionText || "").split(".")[0].trim(),
        ...tallyVotes(rows, party, "Vote") });
    }
    const commG = {};
    for (const r of cv) (commG[`${r.CommitteeCode}|${r.MeetingDate || ""}`] ||= []).push(r);
    for (const k in commG) {
      const rows = commG[k], date = (rows[0].MeetingDate || "");
      const t = tallyVotes(rows, party, "Meaning");
      votes.push({ kind: "committee", where: cname(rows[0].CommitteeCode),
        date: date.slice(0, 10), version: versionAt(tl, date),
        result: t.aye > t.nay ? "Do pass" : "Not passed", action: "Work session", ...t });
    }
    votes.sort((a, b) => a.date.localeCompare(b.date));

    // testimony grouped by hearing (committee + date)
    const hG = {};
    for (const r of test) (hG[`${r.CommitteeCode}|${(r.MeetingDate || "").slice(0, 10)}`] ||= []).push(r);
    const hearings = [];
    const totalByPos = { Support: 0, Oppose: 0, Neutral: 0 };
    for (const r of test) { const p = POSITIONS[r.PositionOnMeasureId]; if (p in totalByPos) totalByPos[p]++; }
    for (const k in hG) {
      const rows = hG[k], date = (rows[0].MeetingDate || "");
      const positions = {};
      for (const pos of ["Support", "Oppose", "Neutral"]) {
        const recs = rows.filter(r => POSITIONS[r.PositionOnMeasureId] === pos);
        const orgs = {}; let others = 0; const otherSamples = {};
        for (const r of recs) {
          let matched = null;
          for (const cand of affiliationCandidates(r)) { matched = matchOrg(cand, matchers); if (matched) break; }
          if (matched) { orgs[matched] = (orgs[matched] || 0) + 1; }
          else {
            others++;
            const cands = affiliationCandidates(r);  // un-matched but non-empty -> sample for tooltip
            if (cands.length) otherSamples[cands[0]] = (otherSamples[cands[0]] || 0) + 1;
          }
        }
        positions[pos] = {
          count: recs.length, others,
          orgs: Object.entries(orgs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ name, count })),
          otherSamples: Object.entries(otherSamples).sort((a, b) => b[1] - a[1])
            .slice(0, 12).map(([name]) => name),
        };
      }
      hearings.push({ where: cname(rows[0].CommitteeCode), date: date.slice(0, 10),
        version: versionAt(tl, date), positions });
    }
    hearings.sort((a, b) => a.date.localeCompare(b.date));

    const versions = [];
    const seen = new Set();
    for (const d of docs) {
      const n = d.VersionDescription || "";
      if (MAIN_VERSION.test(n) && !seen.has(n)) { seen.add(n); versions.push({ name: n, url: d.DocumentUrl }); }
    }
    versions.sort((a, b) => versionRank(a.name) - versionRank(b.name));

    return { votes, testimony: { total: test.length, byPosition: totalByPos, hearings }, versions };
  });
}
function versionRank(name) {
  const i = ["Introduced", "A-Engrossed", "B-Engrossed", "C-Engrossed", "D-Engrossed", "Enrolled"].indexOf(name);
  return i < 0 ? 50 : i;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
