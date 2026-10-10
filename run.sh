#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "First run: python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi
if [ ! -f vendor/onfly/On-Fly-Jev.pt ]; then
  .venv/bin/python scripts/download_model.py
fi
exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "${PORT:-8765}"
