"""Tiny dependency-free .env loader. Never overrides variables that are already set."""
import os
from pathlib import Path


def parse_env(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not key.replace("_", "").isalnum() or key[0].isdigit():
            continue
        if value[:1] in ("'", '"'):
            end = value.find(value[0], 1)
            value = value[1:end] if end > 0 else value[1:]
        else:
            hash_at = value.find(" #")
            value = (value[:hash_at] if hash_at >= 0 else value).strip()
        values[key] = value
    return values


def load_env(path=None):
    """Load KEY=VALUE pairs from `path` (default: .env next to this file). Returns the keys that were set."""
    path = Path(path) if path else Path(__file__).resolve().parent / ".env"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    set_keys = []
    for key, value in parse_env(text).items():
        if key not in os.environ:
            os.environ[key] = value
            set_keys.append(key)
    return set_keys
