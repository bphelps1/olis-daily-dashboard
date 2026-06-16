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
function legislatorParty(session) {
  return cached(`leg:${session}`, async () => {
    const rows = await fetchAll("Legislators", `SessionKey eq '${session}'`);
    const o = {};
    for (const r of rows) o[r.LegislatorCode] = partyLetter(r.Party);
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
function chiefSponsorMap(session) {
  return cached(`spon:${session}`, async () => {
    const rows = await fetchAll("MeasureSponsors",
      `SessionKey eq '${session}' and SponsorLevel eq 'Chief'`, "PrintOrder");
    const o = {};
    for (const r of rows) {
      const k = key(r.MeasurePrefix, r.MeasureNumber);
      if (k in o) continue;
      const nm = r.LegislatoreCode || r.CommitteeCode || "";
      if (nm) o[k] = nm;
    }
    return o;
  });
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

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
