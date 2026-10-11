#!/bin/sh
# Start the Fly Ask app (page at http://127.0.0.1:8766/). Uses .venv if present, else the On-Fly-Jev venv.
set -eu
cd "$(dirname "$0")"
PY=.venv/bin/python
[ -x "$PY" ] || PY=On-Fly-Jev/venv/bin/python
[ -x "$PY" ] || { echo "No Python env found (.venv or On-Fly-Jev/venv)"; exit 1; }
exec "$PY" -m uvicorn app:app --host 127.0.0.1 --port "${PORT:-8766}"
