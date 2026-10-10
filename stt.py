"""Speech-to-text proxy to Paxa Labs. The audio stays in memory and the key never reaches the browser."""
import email.policy
from email.parser import BytesParser
import os
import re

import httpx

PAXA_URL = "https://api.paxalabs.com/v1/audio/transcriptions"
PAXA_MODEL = "paxa-stt-lite-v1-preview"
MAX_AUDIO_BYTES = 10 * 1024 * 1024
STT_TIMEOUT = 60.0
LANG = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")

# Paxa error code -> (HTTP status we return, our error code)
CODE_MAP = {"unauthorized": 401, "insufficient_credits": 402, "key_limit": 403, "audio_too_large": 413,
            "audio_invalid": 400, "audio_too_long": 400, "rate_limited": 429}
STATUS_MAP = {401: "unauthorized", 402: "insufficient_credits", 403: "key_limit", 413: "audio_too_large",
              400: "audio_invalid", 429: "rate_limited"}


class STTError(Exception):
    def __init__(self, status, code, message=""):
        super().__init__(message or code)
        self.status, self.code, self.message = status, code, message or code


def parse_multipart(content_type, body):
    """Parse a multipart/form-data body in memory -> {field: (filename|None, content_type, bytes)}."""
    if not content_type or not content_type.lower().startswith("multipart/form-data"):
        raise STTError(415, "unsupported_media_type", "Send multipart/form-data with an 'audio' field.")
    message = BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    if not message.is_multipart():
        raise STTError(400, "audio_invalid", "Malformed multipart body.")
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            fields[name] = (part.get_filename(), part.get_content_type(), part.get_payload(decode=True) or b"")
    return fields


def _upstream_error(response):
    code = None
    try:
        data = response.json()
        err = data.get("error") if isinstance(data, dict) else None
        code = (err.get("code") if isinstance(err, dict) else err) or (data.get("code") if isinstance(data, dict) else None)
    except ValueError:
        pass
    code = code if isinstance(code, str) else None
    status = response.status_code
    if status >= 500:
        return STTError(502, "stt_upstream_error", "The speech service had an error. Try again.")
    if code not in CODE_MAP:
        code = STATUS_MAP.get(status, "stt_upstream_error")
    http = CODE_MAP.get(code, 502)
    return STTError(http, code, f"Speech service: {code}")


async def transcribe(audio, filename="audio.webm", content_type="audio/webm", language="th", env=None, transport=None):
    env = os.environ if env is None else env
    key = (env.get("PAXA_API_KEY") or "").strip()
    if not key:
        raise STTError(503, "stt_not_configured", "Speech-to-text is not configured.")
    if not audio:
        raise STTError(400, "audio_invalid", "The audio is empty.")
    if len(audio) > MAX_AUDIO_BYTES:
        raise STTError(413, "audio_too_large", "Audio must be 10 MB or smaller.")
    if not LANG.match(language or ""):
        raise STTError(422, "invalid_language", "Language must be a code such as 'th' or 'en'.")
    try:
        async with httpx.AsyncClient(transport=transport, timeout=STT_TIMEOUT) as client:
            response = await client.post(PAXA_URL, headers={"Authorization": f"Bearer {key}"},
                                         files={"file": (filename or "audio.webm", audio, content_type or "audio/webm")},
                                         data={"model": PAXA_MODEL, "language": language, "response_format": "json"})
    except httpx.TimeoutException as exc:
        raise STTError(504, "stt_timeout", "The speech service timed out.") from exc
    except httpx.HTTPError as exc:
        raise STTError(502, "stt_unreachable", "Could not reach the speech service.") from exc
    if response.status_code >= 400:
        raise _upstream_error(response)
    try:
        text = response.json()["text"]
    except (ValueError, KeyError, TypeError) as exc:
        raise STTError(502, "stt_bad_response", "The speech service returned an unexpected body.") from exc
    return {"text": str(text).strip()}
