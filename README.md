# OLIS Daily Dashboard

A lightweight Flask web app that turns the Oregon Legislature's public
[OLIS OData API](https://api.oregonlegislature.gov/odata/odataservice.svc) into a
daily legislative tracking dashboard. It shows what's happening on the House and
Senate floors and in committees on any given day, with automatic flags for bills
that drew heavy public testimony, split party-line votes, or crossed party lines.

No accounts, API keys, or database required — it reads the public API live.

## Features

- **Four tabs:** House Floor, Senate Floor, House Committees, Senate Committees.
- **Any date, past or future.** Pick a date to see that day's floor agenda and
  committee meetings. Three modes:
  - **Today** → *Live* (committees grouped into In Session / Upcoming / Concluded
    by the current time, auto-refreshing every 5 minutes).
  - **Past** → *Historical*.
  - **Future** → *Upcoming* (great for seeing what's on the schedule tomorrow).
- **Interim aware.** Interim committee meetings live under a different session key
  than the regular session, so the **Session** selector defaults to **Auto (by
  date)** and picks the right session automatically. Interim meetings are usually
  informational — their topics and invited speakers are shown, not just bills.
- **Committee details** expand inline to show each meeting's agenda, room, and
  start time.
- **Bill flags:**
  | Flag | Meaning |
  |------|---------|
  | 🔴 *N testimonies* | 25+ public testimony submissions |
  | ⚠️ *Partisan vote* | Committee vote split strictly along party lines |
  | ✅ *Bipartisan* | Members of both parties voted yes in committee |
  | 🔵 *House/Senate: R split (N)* | Republicans crossed over on a bill that passed the floor |
  | 🔵 *House/Senate: D split (N)* | Democrats crossed over on a bill that passed the floor |

  Floor-split flags travel with the bill across chambers — a House split is still
  shown when the bill comes up in the Senate.

## Requirements

- Python 3.9 or newer

## Running it

### macOS (easiest)

Double-click **`Run Dashboard.command`**. It installs the two dependencies on
first run, starts the server, and opens <http://127.0.0.1:5001> in your browser.
Leave the Terminal window open while you use it; close it (or press Ctrl-C) to stop.

> First time only: if macOS blocks the file, right-click it → **Open** → **Open**.

### Any platform (terminal)

```bash
pip install -r requirements.txt
python3 -m dashboard.server
```

Then open <http://127.0.0.1:5001>. To use a different port:
`PORT=8000 python3 -m dashboard.server`.

## Notes

- The app only listens on `127.0.0.1` (your own machine). To give the whole team
  a single shared link, it needs to be deployed to a host — it's a standard,
  stateless Flask app and works on services like Render, Railway, Fly.io, or
  PythonAnywhere.
- API responses are cached in memory for 10 minutes, so the first load of a given
  day is the slow one and everything after is instant until the cache expires.
- Data comes straight from OLIS and reflects whatever the Legislature has posted.

## Project layout

```
dashboard/
├── server.py     # Flask routes
├── api.py        # all OLIS API calls + caching
├── flags.py      # testimony / partisan / bipartisan / floor-split logic
├── templates/
│   └── index.html
└── static/
    └── style.css
```
