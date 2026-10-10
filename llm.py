"""LLM provider layer (Gemini, OpenRouter, deterministic fake) over httpx.

Every client exposes two coroutines:
  json(task, system, user, context=None, schema=None) -> parsed JSON (JSON mode, never combined with tools)
  research(system, user, context=None)                -> {"text": str, "sources": [{"title","url","snippet"}]}
Keys are only ever sent in request headers and are never logged or returned.
"""
import asyncio
import json
import logging
import os
import re

import httpx

log = logging.getLogger("onfly.llm")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
JSON_TIMEOUT = 30.0
RESEARCH_TIMEOUT = 45.0
THAI = re.compile(r"[฀-๿]")


class LLMError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# Codes that mean "this provider could not be reached or refused": try the other provider.
FALLBACK_CODES = ("timeout", "transport", "not_configured", "empty_response")


def _falls_back(error):
    return error.code in FALLBACK_CODES or error.code.startswith("http_")


def parse_json_text(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    try:
        return json.loads(text)
    except ValueError as exc:
        raise LLMError("bad_json", "The model did not return valid JSON.") from exc


class _HttpBase:
    backoff = 0.6

    def __init__(self, api_key, model, transport=None):
        self._key = api_key
        self.model = model
        self._transport = transport

    async def _post(self, url, headers, body, timeout):
        last = None
        for attempt in (0, 1):
            try:
                async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
                    response = await client.post(url, headers=headers, json=body)
            except httpx.TimeoutException as exc:
                raise LLMError("timeout", f"{self.name} request timed out.") from exc
            except httpx.HTTPError as exc:
                raise LLMError("transport", f"{self.name} request failed ({type(exc).__name__}).") from exc
            if response.status_code == 429 or response.status_code >= 500:
                last = response.status_code
                if attempt == 0:
                    await asyncio.sleep(self.backoff)
                    continue
            elif response.status_code >= 400:
                raise LLMError(f"http_{response.status_code}", f"{self.name} returned HTTP {response.status_code}.")
            else:
                try:
                    return response.json()
                except ValueError as exc:
                    raise LLMError("bad_response", f"{self.name} returned a non-JSON body.") from exc
        raise LLMError(f"http_{last}", f"{self.name} returned HTTP {last}.")


class GeminiClient(_HttpBase):
    name = "gemini"

    @staticmethod
    def _text(data):
        try:
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        except (KeyError, IndexError, TypeError):
            text = ""
        if not text.strip():
            raise LLMError("empty_response", "Gemini returned no text.")
        return text

    def _request(self, system, user, config=None, tools=None):
        body = {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}]}
        if config:
            body["generationConfig"] = config
        if tools:
            body["tools"] = tools
        return GEMINI_URL.format(model=self.model), {"x-goog-api-key": self._key, "content-type": "application/json"}, body

    async def json(self, task, system, user, context=None, schema=None):
        config = {"responseMimeType": "application/json", "temperature": 0.2}
        if schema:
            config["responseSchema"] = schema
        url, headers, body = self._request(system, user, config=config)
        return parse_json_text(self._text(await self._post(url, headers, body, JSON_TIMEOUT)))

    async def research(self, system, user, context=None):
        url, headers, body = self._request(system, user, tools=[{"google_search": {}}])
        data = await self._post(url, headers, body, RESEARCH_TIMEOUT)
        sources, seen = [], set()
        try:
            chunks = data["candidates"][0]["groundingMetadata"]["groundingChunks"]
        except (KeyError, IndexError, TypeError):
            chunks = []
        for chunk in chunks if isinstance(chunks, list) else []:
            web = chunk.get("web") if isinstance(chunk, dict) else None
            if isinstance(web, dict) and web.get("uri") and web["uri"] not in seen:
                seen.add(web["uri"])
                sources.append({"title": str(web.get("title") or web["uri"]), "url": web["uri"], "snippet": ""})
        return {"text": self._text(data), "sources": sources}


class OpenRouterClient(_HttpBase):
    name = "openrouter"

    def _request(self, model, system, user, extra):
        body = {"model": model, "messages": [{"role": "system", "content": system},
                                             {"role": "user", "content": user}], "temperature": 0.2, **extra}
        return OPENROUTER_URL, {"authorization": f"Bearer {self._key}", "content-type": "application/json"}, body

    @staticmethod
    def _message(data):
        try:
            message = data["choices"][0]["message"]
            if not str(message.get("content") or "").strip():
                raise KeyError
            return message
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise LLMError("empty_response", "OpenRouter returned no text.") from exc

    async def json(self, task, system, user, context=None, schema=None):
        model = self.model.removesuffix(":online")  # no web search for the no-tools stages
        url, headers, body = self._request(model, system + "\nRespond with one JSON object only.", user,
                                           {"response_format": {"type": "json_object"}})
        message = self._message(await self._post(url, headers, body, JSON_TIMEOUT))
        return parse_json_text(message["content"])

    async def research(self, system, user, context=None):
        model = self.model if self.model.endswith(":online") else self.model + ":online"
        url, headers, body = self._request(model, system, user, {})
        message = self._message(await self._post(url, headers, body, RESEARCH_TIMEOUT))
        sources, seen = [], set()
        for note in message.get("annotations") or []:
            cite = note.get("url_citation") if isinstance(note, dict) and note.get("type") == "url_citation" else None
            if isinstance(cite, dict) and cite.get("url") and cite["url"] not in seen:
                seen.add(cite["url"])
                sources.append({"title": str(cite.get("title") or cite["url"]), "url": cite["url"],
                                "snippet": str(cite.get("content") or "")[:240]})
        return {"text": message["content"], "sources": sources}


class FakeClient:
    """Deterministic canned outputs for the demo question. Everything is labelled FAKE-DEMO."""
    name = "fake"

    NOTES = ("FAKE-DEMO notes (not real data). Illustrative summary only. "
             "Recent polling snippets in this demo show the two parties within a few points of each other, "
             "with neither one consistently ahead across pollsters. "
             "Coverage in this demo describes both parties as competitive and notes that many voters remain undecided.")

    async def json(self, task, system, user, context=None, schema=None):
        context = context or {}
        if task == "interpret":
            text = context.get("text", "")
            th = bool(THAI.search(text))
            return {
                "language": "th" if th else "en",
                "intent": "compare which of two parties the recent sources show ahead",
                "parties": [
                    {"id": "A", "name": "People's Party",
                     "aliases": ["พรรคประชาชน", "People's Party", "successor of Pita Limjaroenrat's former party"]},
                    {"id": "B", "name": "Bhumjaithai",
                     "aliases": ["ภูมิใจไทย", "Bhumjaithai Party", "Anutin Charnvirakul"]}],
                "time_scope": "latest available",
                "question_en": "Between the party associated with Pita Limjaroenrat and the party led by Anutin "
                               "Charnvirakul, which does the recent evidence show ahead?",
                "echo": ("ฉันเข้าใจว่า: เปรียบเทียบพรรคประชาชน (ผู้สืบทอดพรรคเดิมของคุณพิธา) กับพรรคภูมิใจไทย (คุณอนุทิน) "
                         "ว่าหลักฐานล่าสุดชี้ว่าใครนำ") if th else
                        ("I understood: compare the People's Party (successor of Pita's former party) with "
                         "Bhumjaithai (Anutin) on who the latest evidence shows ahead."),
            }
        if task == "pool":
            a, b = context.get("parties", [{"name": "A"}, {"name": "B"}])[:2]
            ids = context.get("source_ids") or ["notes"]
            pick = lambda i: ids[i % len(ids)]
            return {
                "as_of": "demo",
                "candidates": {
                    "A": f"The sources show {a['name']} ahead of {b['name']}.",
                    "B": f"The sources show {b['name']} ahead of {a['name']}.",
                    "none": "The sources show no clear leader between the two parties."},
                "evidence": [
                    {"id": "E1", "source": pick(0), "text": "FAKE-DEMO: polling snippets place the two parties within a few points of each other."},
                    {"id": "E2", "source": pick(1), "text": "FAKE-DEMO: neither party is consistently ahead across pollsters."},
                    {"id": "E3", "source": pick(2), "text": "FAKE-DEMO: many voters are described as undecided."}]}
        raise LLMError("bad_task", f"Unknown fake task {task!r}.")

    async def research(self, system, user, context=None):
        return {"text": self.NOTES, "sources": [
            {"title": "FAKE-DEMO: Illustrative poll roundup (not a real source)", "url": "https://example.com/fake-demo/poll-roundup",
             "snippet": "FAKE-DEMO - canned text, not real data."},
            {"title": "FAKE-DEMO: Illustrative news summary (not a real source)", "url": "https://example.com/fake-demo/news-summary",
             "snippet": "FAKE-DEMO - canned text, not real data."},
            {"title": "FAKE-DEMO: Illustrative analyst note (not a real source)", "url": "https://example.com/fake-demo/analyst-note",
             "snippet": "FAKE-DEMO - canned text, not real data."}]}


class LLM:
    """Primary provider with automatic fallback to the other real provider. `.used` = provider of the last call."""

    def __init__(self, env=None, transport=None):
        env = os.environ if env is None else env
        gem = (env.get("GEMINI_API_KEY") or "").strip()
        orr = (env.get("OPENROUTER_API_KEY") or "").strip()
        self.primary = (env.get("LLM_PROVIDER") or "gemini").strip().lower()
        self.configured = {"gemini": bool(gem), "openrouter": bool(orr), "fake": self.primary == "fake"}
        real = {}
        if gem:
            real["gemini"] = GeminiClient(gem, env.get("GEMINI_MODEL") or "gemini-2.5-flash", transport)
        if orr:
            real["openrouter"] = OpenRouterClient(orr, env.get("OPENROUTER_MODEL") or "google/gemini-2.5-flash", transport)
        if self.primary == "fake":
            self.chain = [FakeClient()]
        else:
            order = ["openrouter", "gemini"] if self.primary == "openrouter" else ["gemini", "openrouter"]
            self.chain = [real[n] for n in order if n in real]
        self.used = None

    async def _call(self, method, *args, **kwargs):
        if not self.chain:
            raise LLMError("not_configured", "No LLM provider is configured (set GEMINI_API_KEY or OPENROUTER_API_KEY).")
        last = None
        for client in self.chain:
            try:
                result = await getattr(client, method)(*args, **kwargs)
                self.used = client.name
                return result
            except LLMError as exc:
                if not _falls_back(exc):
                    self.used = client.name
                    raise
                log.warning("LLM provider %s failed (%s); trying fallback", client.name, exc.code)
                last = exc
        raise last

    async def json(self, task, system, user, context=None, schema=None):
        return await self._call("json", task, system, user, context=context, schema=schema)

    async def research(self, system, user, context=None):
        return await self._call("research", system, user, context=context)
