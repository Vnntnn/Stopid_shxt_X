"""LLM layer: OpenRouter (one web-enabled chat call) and a deterministic fake for the demo.

`LLM.ask()` makes ONE call that interprets the question and returns a few short facts. It first tries with the
OpenRouter web plugin; on 402/429/5xx/timeout/transport errors it retries once on the same model without web
(`grounded` is then False). Keys are only sent in request headers and never logged or returned.
"""
import asyncio
import json
import logging
import os
import re

import httpx

log = logging.getLogger("onfly.llm")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"
ASK_TIMEOUT = 25.0
MAX_TOKENS = 400
THAI = re.compile(r"[฀-๿]")
PROVIDERS = ("openrouter", "fake")
UNGROUNDED_NOTICE = ("No live web search was available; this summary is from the model's general knowledge "
                     "and may be out of date.")
UNGROUNDED_RULES = (" No web access this time: use only well-established background knowledge, state uncertainty, "
                    "never invent numbers, and if you have no recent data say so in a fact. Leave source fields empty.")


class LLMError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _web_fallback(error):
    """Errors after which the same call is retried without the web plugin."""
    return error.code in ("timeout", "transport", "http_402", "http_429", "empty_response") or (
        error.code.startswith("http_5"))


def parse_json_text(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    try:
        return json.loads(text)
    except ValueError as exc:
        raise LLMError("bad_json", "The model did not return valid JSON.") from exc


class OpenRouterClient:
    name = "openrouter"
    backoff = 0.4
    web_max_results = 2

    def __init__(self, api_key, model, transport=None):
        self._key, self.model, self._transport = api_key, model, transport

    async def _post(self, body, timeout):
        headers = {"authorization": f"Bearer {self._key}", "content-type": "application/json"}
        for attempt in (0, 1):
            try:
                async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
                    response = await client.post(OPENROUTER_URL, headers=headers, json=body)
            except httpx.TimeoutException as exc:
                raise LLMError("timeout", "OpenRouter request timed out.") from exc
            except httpx.HTTPError as exc:
                raise LLMError("transport", f"OpenRouter request failed ({type(exc).__name__}).") from exc
            status = response.status_code
            if status in (429,) or status >= 500:
                if attempt == 0:
                    await asyncio.sleep(self.backoff)
                    continue
            if status >= 400:
                raise LLMError(f"http_{status}", f"OpenRouter returned HTTP {status}.")
            try:
                return response.json()
            except ValueError as exc:
                raise LLMError("bad_response", "OpenRouter returned a non-JSON body.") from exc
        raise LLMError("http_429", "OpenRouter is rate limiting.")

    async def complete(self, system, user, web, context=None, max_tokens=MAX_TOKENS):
        body = {"model": self.model, "temperature": 0, "max_tokens": max_tokens,
                "reasoning": {"enabled": False}, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system + ("" if web else UNGROUNDED_RULES)},
                             {"role": "user", "content": user}]}
        if web:
            body["plugins"] = [{"id": "web", "max_results": self.web_max_results}]
        data = await self._post(body, ASK_TIMEOUT)
        try:
            message = data["choices"][0]["message"]
            content = str(message.get("content") or "")
            if not content.strip():
                raise KeyError
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise LLMError("empty_response", "OpenRouter returned no text.") from exc
        sources, seen = [], set()
        for note in message.get("annotations") or []:
            cite = note.get("url_citation") if isinstance(note, dict) and note.get("type") == "url_citation" else None
            if isinstance(cite, dict) and cite.get("url") and cite["url"] not in seen:
                seen.add(cite["url"])
                sources.append({"title": str(cite.get("title") or cite["url"])[:200], "url": cite["url"],
                                "snippet": " ".join(str(cite.get("content") or "").split())[:240]})
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        return {"content": content, "sources": sources, "usage": usage}


class FakeClient:
    """Deterministic canned output for the demo question. Everything is labelled FAKE-DEMO."""
    name = "fake"
    model = "fake"

    async def complete(self, system, user, web, context=None, max_tokens=MAX_TOKENS):
        th = bool(THAI.search((context or {}).get("text", "")))
        data = {
            "echo": ("ฉันเข้าใจว่า: เปรียบเทียบพรรคประชาชน (ผู้สืบทอดพรรคเดิมของคุณพิธา) กับพรรคภูมิใจไทย (คุณอนุทิน) "
                     "ว่าใครนำในผลสำรวจล่าสุด") if th else
                    "I understood: compare the People's Party (successor of Pita's former party) with Bhumjaithai (Anutin).",
            "language": "th" if th else "en",
            "parties": [{"id": "A", "name": "People's Party", "aliases": ["พรรคประชาชน", "Pita's former party"]},
                        {"id": "B", "name": "Bhumjaithai", "aliases": ["ภูมิใจไทย", "Anutin Charnvirakul"]}],
            "criterion": "is ahead in the latest polls",
            "facts": [
                {"text": "FAKE-DEMO: polling snippets place the two parties within a few points of each other.",
                 "source_title": "FAKE-DEMO: Illustrative poll roundup", "source_url": "https://example.com/fake-demo/poll-roundup"},
                {"text": "FAKE-DEMO: neither party is consistently ahead across pollsters.",
                 "source_title": "FAKE-DEMO: Illustrative news summary", "source_url": "https://example.com/fake-demo/news-summary"},
                {"text": "FAKE-DEMO: many voters are described as undecided.",
                 "source_title": "FAKE-DEMO: Illustrative analyst note", "source_url": "https://example.com/fake-demo/analyst-note"}],
            "as_of": "demo"}
        sources = [{"title": f["source_title"] + " (not a real source)", "url": f["source_url"],
                    "snippet": "FAKE-DEMO - canned text, not real data."} for f in data["facts"]]
        return {"content": json.dumps(data, ensure_ascii=False), "sources": sources, "usage": {}}


class LLM:
    """`LLM_PROVIDER` is `openrouter` (default) or `fake`. `.used` = model slug of the last call."""

    def __init__(self, env=None, transport=None):
        env = os.environ if env is None else env
        key = (env.get("OPENROUTER_API_KEY") or "").strip()
        self.primary = (env.get("LLM_PROVIDER") or "openrouter").strip().lower()
        self.configured = {"openrouter": bool(key), "fake": self.primary == "fake"}
        self.client = None
        if self.primary == "fake":
            self.client = FakeClient()
        elif self.primary == "openrouter" and key:
            self.client = OpenRouterClient(key, (env.get("OPENROUTER_MODEL") or DEFAULT_MODEL).strip(), transport)
        self.used = None

    async def ask(self, system, user, context=None, max_tokens=MAX_TOKENS):
        """One call -> {"data": parsed JSON, "sources", "grounded", "provider", "usage"}."""
        if self.primary not in PROVIDERS:
            raise LLMError("bad_provider", "LLM_PROVIDER must be 'openrouter' or 'fake'.")
        if self.client is None:
            raise LLMError("not_configured", "OPENROUTER_API_KEY is not set.")
        grounded = True
        try:
            result = await self.client.complete(system, user, True, context, max_tokens)
        except LLMError as exc:
            if not _web_fallback(exc):
                raise
            log.warning("Web-enabled call failed (%s); retrying without web", exc.code)
            grounded = False
            result = await self.client.complete(system, user, False, context, max_tokens)
        self.used = self.client.model
        return {"data": parse_json_text(result["content"]), "sources": result["sources"] if grounded else [],
                "grounded": grounded, "provider": self.client.model, "usage": result["usage"]}
