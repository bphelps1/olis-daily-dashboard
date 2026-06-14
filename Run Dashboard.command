#!/bin/bash
cd "$(dirname "$0")"

PORT=5001
export PORT

echo "Installing dependencies (first run only)…"
python3 -m pip install flask requests --quiet

# Open the browser once the server is up.
( sleep 2 ; open "http://127.0.0.1:$PORT" ) &

echo "Starting OLIS Daily Dashboard…  (close this window to stop it)"
python3 -m dashboard.server
