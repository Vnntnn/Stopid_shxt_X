"""Text-to-speech proxy to Paxa Labs. The key stays on the server; audio is cached on disk by hash."""
import asyncio
import collections
import hashlib
import logging
import os
from pathlib import Path
import re
import time
import unicodedata

import httpx

log = logging.getLogger("onfly")
PAXA_TTS_URL = "https://api.paxalabs.com/v1/tts"
DEFAULT_MODEL = "paxa-tts-flash-v1"
DEFAULT_VOICE = "lukchup"
MAX_TEXT = 400
TTS_TIMEOUT = 20.0
CACHE_DIR = Path(__file__).resolve().parent / ".runtime" / "tts_cache"
CACHE_MAX_FILES = 200
VOICE = re.compile(r"^[a-z0-9_-]{1,40}$")
_calls = collections.deque()  # monotonic times of upstream calls made by this process


class TTSError(Exception):
    def __init__(self, status, code, message=""):
        super().__init__(message or code)
        self.status, self.code, self.message = status, code, message or code


def clean_text(text):
    if not isinstance(text, str):
        raise TTSError(422, "invalid_text", "text must be a string.")
    text = "".join(" " if unicodedata.category(c) == "Cc" else c for c in text)
    text = " ".join(text.split())
    if not 1 <= len(text) <= MAX_TEXT:
        raise TTSError(422, "invalid_text", f"text must be 1 to {MAX_TEXT} characters.")
    return text


def _cache_path(model, voice, text):
    return CACHE_DIR / (hashlib.sha256(f"{model}|{voice}|{text}".encode("utf-8")).hexdigest() + ".mp3")


def _store(path, audio):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(audio)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    files = sorted(path.parent.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
    for old in files[:max(0, len(files) - CACHE_MAX_FILES)]:
        old.unlink(missing_ok=True)


def _budget_ok(limit):
    now = time.monotonic()
    while _calls and now - _calls[0] > 60:
        _calls.popleft()
    if len(_calls) >= limit:
        return False
    _calls.append(now)
    return True


def _upstream_code(response):
    try:
        data = response.json()
        err = data.get("error") if isinstance(data, dict) else None
        code = (err.get("code") if isinstance(err, dict) else err) or (data.get("code") if isinstance(data, dict) else None)
        return code if isinstance(code, str) else None
    except ValueError:
        return None


def _map_error(response):
    status = response.status_code
    if status >= 500:
        return TTSError(502, "tts_upstream", "The voice service had an error. Try again.")
    if status in (402, 403):
        return TTSError(402, "tts_no_credits", "The voice service is out of credits or at its key limit.")
    if status == 429:
        return TTSError(429, "tts_rate_limited", "The voice service is busy. Try again shortly.")
    code = _upstream_code(response) or ("unauthorized" if status == 401 else f"http_{status}")
    return TTSError(502, "tts_rejected", f"Voice service rejected the request: {code[:60]}")


async def synthesize(text, voice=None, env=None):
    """Return (mp3 bytes, cache_hit)."""
    env = os.environ if env is None else env
    key = (env.get("PAXA_API_KEY") or "").strip()
    if not key:
        raise TTSError(503, "tts_not_configured", "Text-to-speech is not configured.")
    text = clean_text(text)
    voice = voice if voice is not None else ((env.get("PAXA_TTS_VOICE") or "").strip() or DEFAULT_VOICE)
    if not isinstance(voice, str) or not VOICE.match(voice):
        raise TTSError(422, "invalid_voice", "voice must match [a-z0-9_-], 1 to 40 characters.")
    model = (env.get("PAXA_TTS_MODEL") or "").strip() or DEFAULT_MODEL
    path = _cache_path(model, voice, text)
    try:
        audio = path.read_bytes()
        if audio:
            os.utime(path)
            return audio, True
    except OSError:
        pass
    try:
        limit = int((env.get("TTS_MAX_CALLS_PER_MIN") or "").strip() or 12)
    except ValueError:
        limit = 12
    body = {"text": text, "voice": voice, "model": model, "format": "mp3", "speed": 1, "language": "auto"}
    response = None
    for attempt in (1, 2):
        if not _budget_ok(limit):
            raise TTSError(429, "tts_budget", "Too many voice requests this minute.")
        try:
            async with httpx.AsyncClient(timeout=TTS_TIMEOUT) as client:
                response = await client.post(PAXA_TTS_URL, json=body, headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError:
            response = None
            if attempt == 2:
                raise TTSError(502, "tts_upstream", "Could not reach the voice service.")
            continue
        if response.status_code >= 500 and attempt == 1:
            continue
        break
    if response.status_code >= 400:
        log.warning("tts upstream %s (text length %d)", response.status_code, len(text))
        raise _map_error(response)
    if not response.content:
        raise TTSError(502, "tts_upstream", "The voice service returned no audio.")
    try:
        _store(path, response.content)
    except OSError:
        log.exception("tts cache write failed")
    return response.content, False
