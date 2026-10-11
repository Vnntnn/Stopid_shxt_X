#!/bin/sh
# Start the app at http://127.0.0.1:${PORT:-8765}.
# TUNNEL=1 ./run.sh also opens a public ngrok URL (needs `ngrok` installed and logged in).
# TUNNEL_AUTH=user:pass adds a password to the public URL.
set -eu
cd "$(dirname "$0")"
PORT="${PORT:-8765}"

if [ ! -x .venv/bin/python ]; then
  PY="$(command -v python3.11 || command -v python3.12 || command -v python3.13 || command -v python3.14 || true)"
  [ -n "$PY" ] || { echo "Install Python 3.11 or newer first (brew install python@3.11)"; exit 1; }
  echo "First run: creating .venv with $PY"
  "$PY" -m venv .venv
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
fi
if [ ! -f vendor/onfly/On-Fly-Jev.pt ]; then
  .venv/bin/python scripts/download_model.py
fi

if [ "${TUNNEL:-0}" != "1" ]; then
  exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$PORT"
fi

command -v ngrok >/dev/null || { echo "ngrok not found: brew install ngrok && ngrok config add-authtoken <token>"; exit 1; }
export ONFLY_ALLOWED_HOSTS="${ONFLY_ALLOWED_HOSTS:-*.ngrok-free.app,*.ngrok-free.dev,*.ngrok.app,*.ngrok.io}"
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
if [ -n "${TUNNEL_AUTH:-}" ]; then
  ngrok http "$PORT" --basic-auth "$TUNNEL_AUTH"
else
  ngrok http "$PORT"
fi
