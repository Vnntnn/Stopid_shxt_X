# Fly Ask backend report

## What was built
- `envload.py` - dependency-free `.env` loader (comments, quotes, `export`, never overrides set vars); called at app import. `.env` is git-ignored; `.env.example` committed with empty values.
- `llm.py` - `GeminiClient` (REST, `x-goog-api-key`, JSON mode OR `google_search` tool, never both), `OpenRouterClient` (Bearer, `json_object`; research uses the `:online` slug, JSON stages strip `:online`; `url_citation` annotations), `FakeClient` (demo question, every source labelled FAKE-DEMO), `LLM` router (`LLM_PROVIDER`, automatic fallback on timeout/transport/HTTP errors when the other key exists, 1 retry on 429/5xx, 30 s / 45 s timeouts, `LLMError(code, message)`).
- `stt.py` - Paxa proxy; multipart parsed in memory (stdlib `email`, so audio never hits disk, no python-multipart needed); Paxa error codes mapped to HTTP status; missing key -> 503 `{"error":"stt_not_configured"}`.
- `ask_pipeline.py` - interpret -> research -> pool -> jev (forward + swapped) -> adapter as an async generator of NDJSON events; strict validation + one repair re-prompt; real-tokenizer limits (48-token option, head, state, 600-token evidence budget; evidence trimmed, too-long candidates re-prompted); templated Thai/English `answer_text`; atomic cache `.runtime/ask_cache.json`.
- `app.py` routes: `POST /api/ask` (NDJSON, 8 KB cap, text 1..500, replay bool), `POST /api/stt`, `GET /fly` (404 message if `web/fly.html` missing), `GET /api/ask/health`.

## Run
`LLM_PROVIDER=fake ./On-Fly-Jev/venv/bin/python -m uvicorn app:app --port 8766` (needs `vendor/onfly/*.pt` symlinks, git-ignored: `ln -s ../../On-Fly-Jev/On-Fly-Jev.pt vendor/onfly/` and same for `fly100.pt`; SHA-256 hashes matched the pinned ones).
Tests: `./On-Fly-Jev/venv/bin/python -m unittest tests.test_ask_pipeline` (43 tests, ~2 s, no keys/model).

## Env vars
`GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`), `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `google/gemini-2.5-flash`; use `...:online` or let research append it), `LLM_PROVIDER` (`gemini`|`openrouter`|`fake`), `PAXA_API_KEY`, `JEV_MIN_CONF` (0.45).

## Design notes
- Candidate order is seeded by the normalised text: the forward run maps keys A/B to a shuffled order of the parties, the swapped run uses the reverse. Final `candidates` stay in interpreter order A, B, none. `consistency.forward/swapped` are keyed by candidate identity (mapped back), not Jev key.
- `jev.inference_ms` is the sum of the two runs; `jev.provider` is the last LLM provider used.
- Model not ready or a provider failure (after fallback) with a cache hit returns the cached final (`from_cache: true`, stage events flagged `cached`); without a hit it is a stage error plus a final error line.
- Health returns booleans only (`gemini`, `openrouter`, `fake`, `stt`, `model_ready`, `cache_entries`); tests grep the body for key text.
- A `.env` with real keys already exists in the repo root (git-ignored, not created by me). The real run used `LLM_PROVIDER=fake`, so no real key was used.

## Real run (real On-Fly-Jev on CPU, fake LLM, port 8766)
Model ready in 3.65 s. Stream (long fields cut):
```
{"stage": "interpret", "status": "start", "ms": 0, "data": {}}
{"stage": "interpret", "status": "done", "ms": 0, "data": {"interpretation": {"language": "th", "intent": "compare which of two parties the recent sources show ahead", "parties": [{"id": "A", "name": "People's Party", "aliases": [
{"stage": "research", "status": "start", "ms": 0, "data": {}}
{"stage": "research", "status": "done", "ms": 0, "data": {"sources": [{"title": "FAKE-DEMO: Illustrative poll roundup (not a real source)", "url": "https://example.com/fake-demo/poll-roundup", "snippet": "FAKE-DEMO - canned text, 
{"stage": "pool", "status": "start", "ms": 0, "data": {}}
{"stage": "pool", "status": "done", "ms": 2, "data": {"candidates": {"A": "The sources show People's Party ahead of Bhumjaithai.", "B": "The sources show Bhumjaithai ahead of People's Party.", "none": "The sources show no clear le
{"stage": "jev", "status": "start", "ms": 0, "data": {}}
{"stage": "jev", "status": "done", "ms": 893, "data": {"inference_ms": 887.4, "forward": {"A": 0.2633, "B": 0.2775, "none": 0.4592}, "swapped": {"B": 0.2257, "A": 0.3314, "none": 0.4429}}}
{"stage": "adapter", "status": "start", "ms": 0, "data": {}}
{"stage": "adapter", "status": "done", "ms": 0, "data": {"decision": "none", "agree": true, "mean": {"A": 0.2974, "B": 0.2516, "none": 0.4511}}}
{"stage": "final", "status": "done", "data": {"decision": "none", "candidates": [{"id": "A", "label": "People's Party", "claim": "The sources show People's Party ahead of Bhumjaithai.", "prob": 0.2974}, {"id": "B", "label": "Bhumj
```
Final decision `none` (A 0.2974, B 0.2516, none 0.4511; forward none 0.4592, swapped none 0.4429; both runs agree; mean 0.4511 just above the 0.45 threshold). Inference 887.4 ms for both calls (about 440 ms each). Replay returned `from_cache: true`. `/fly` returned 200 (front-end files exist); the server was stopped and the test cache file deleted.

## Tests (43, all pass)
LLM request shapes (Gemini JSON vs search, OpenRouter), 429 retry, fallback, repair path (invalid shape, non-JSON, second failure), validators, limits (48-token option with fake and the real tokenizer, evidence trimming, 600-token budget, hopeless context), swap mapping, key-A-always -> inconclusive, none, threshold, unsent choice id, cache/replay/provider-failure, STT forwarding and error mapping, env loader, routes (ndjson, 422/413/403, model-not-ready), health with no key text.

## Mutation checks (each reverted, suite green again)
- swapped map not swapped -> `test_always_key_a_is_inconclusive...` fails.
- agreement rule forced True -> 2 tests fail.
- choice-id verification removed -> 2 tests fail.
- threshold check removed -> 2 tests fail.
- probabilities keyed by Jev key instead of identity -> 5 tests fail.

## Only tested against mocks (never against the real services)
- Gemini `generateContent` (JSON mode, `google_search` tool, `groundingChunks` parsing; grounding URLs are usually Google redirect links with the domain as title, snippets empty).
- OpenRouter `chat/completions` (`json_object`, `:online` research, `annotations.url_citation` parsing; response shapes assumed from docs).
- Paxa `audio/transcriptions` (multipart fields, Bearer auth, error-body shape; both `{"error":{"code"}}` and `{"error":"code"}` are accepted; status-only fallback mapping).
- Real LLM quality: the prompts (interpret, research, pool) were never run against a real model, so the one-repair path may fire more or less often than expected.
- Browser MediaRecorder webm uploads through `/api/stt` (only synthetic multipart tested).
