# Fly Ask: text/voice question -> LLM -> RAG -> candidate pool -> On-Fly-Jev -> verified decision

Hackathon feature on top of the existing Fly Decision Lab (`app.py`, `project_store.py`, `scrapers.py`, `web/`).
Demo question (Thai, neutral wording): "ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู ใครจะชนะ?"


> **REVISION (OpenRouter only, one LLM call) - supersedes the pipeline/config text below where they differ.**
> - Gemini is removed. `LLM_PROVIDER` is `openrouter` (default) or `fake`. Default model `deepseek/deepseek-v4.1-flash`
>   (`OPENROUTER_MODEL` overrides; reasoning disabled, temperature 0, `max_tokens` capped).
> - ONE OpenRouter call with the web plugin (`max_results: 2`) does interpret + search + 2-3 short facts. If that call
>   fails (402/429/5xx/timeout) it is retried once without web (`research.grounded=false`).
> - The candidate pool is built in CODE: `state` = one short text `Findings: ...` (<= ~400 chars), candidates `A`/`B` =
>   short party names, `none` = "No clear leader", question "Which candidate <criterion>?". Jev runs twice (A/B swapped).
> - Stage events keep the five names for the UI: `interpret` (the one call), `research` (ms 0, `merged_with: interpret`),
>   `pool` (code), `jev`, `adapter`. Measured live: ~5-6 s end to end, ~$0.007 per fresh question, ~2.6k prompt tokens.
> - Jev stays the real decision maker. Search results change between runs, so a fresh run can differ (even be
>   `inconclusive`): use the cache (`replay`) for the rehearsed demo questions.

## Honest framing (keep it light, but keep it)
On-Fly-Jev cannot forecast. The pipeline REWRITES the question into: "which statement do the retrieved sources
support?" with candidates `A`, `B` and `none` ("sources show no clear leader"). The UI shows one small line:
"Entertainment demo - not a prediction". Sources are listed in the output panel. The user does not care much about
evidence: do not add more disclaimers than that.

## Screen (user's sketch)
Dark full-screen page `/fly`. Centre: big 3D fly. Top right box "You": toggle Text | Voice (STT), input, send.
Bottom left box "Output fly": stage progress, the answer, probability bars, sources, the disclaimer line.
Fly states: `idle` (hover), `listening` (fast wings while recording), `thinking` (circles while the pipeline runs),
`deciding` -> flies to the winning candidate's pad (A left, B right, none centre-back) and lands,
`inconclusive` (confused spin, stays centre).

## Pipeline (server, `ask_pipeline.py`)
1. **interpret** (LLM, JSON): `{language, intent, parties:[{id:"A",name,aliases}], time_scope, question_en, echo}`.
   `echo` = one sentence in the user's language: "I understood: ..." (entity resolution is shown to the user:
   e.g. Pita's former party -> its successor; Anutin -> Bhumjaithai; verify with the research step).
2. **research** (Gemini with Google Search grounding, plain text + grounding sources): recent poll/news evidence
   for the parties; returns `{notes_en, sources:[{title,url,snippet}]}`. Optional: add rows from the local policy DB.
3. **pool** (LLM, JSON mode, NO tools): builds the Jev request. Hard limits (violations are repaired or rejected):
   English only; candidates A, B (+ `none`); each candidate text <= 48 tokens (checked with the model tokenizer);
   evidence total <= ~600 tokens; 2-4 evidence items with source ids.
   `state = {"question": ..., "as_of": ..., "evidence": [{"id","source","text"}...]}`,
   question = `{"type":"choice","instructions":"Which statement do the sources support?","criteria":{"A":text,"B":text,"none":text}}`.
4. **jev**: `runtime.predict` (existing, validates token limits) TWICE: forward order, and with the candidate texts
   swapped between keys A and B (map the answer back to the candidate identity).
5. **adapter** verifies: `choice` is one of the keys that were sent; both runs name the same candidate;
   mean probability of that candidate >= `JEV_MIN_CONF` (default 0.45); else decision = `inconclusive`.
   Builds `answer_text` from a TEMPLATE (not an LLM) in the user's language.
6. **cache**: every successful live result is saved to `.runtime/ask_cache.json` keyed by normalised text;
   `replay` (request flag) or any provider failure with a cache hit returns the cached result with `from_cache: true`.

## API contract (both sides build against this)
`POST /api/ask` body `{"text": str, "replay": bool=false}` -> `application/x-ndjson` stream, one JSON object per line:
`{"stage": "interpret|research|pool|jev|adapter", "status": "start|done|error", "ms": int, "data": {...}}`
then exactly one final line `{"stage":"final","status":"done","data":FINAL}` (or `{"stage":"final","status":"error","error":{"code","message"}}`).
FINAL:
```json
{"decision": "A|B|none|inconclusive",
 "candidates": [{"id":"A","label":"People's Party","claim":"...", "prob":0.62},
                {"id":"B","label":"Bhumjaithai","claim":"...","prob":0.30},
                {"id":"none","label":"No clear leader","claim":"...","prob":0.08}],
 "interpretation": {"echo":"...", "language":"th", "question_en":"..."},
 "sources": [{"title":"...","url":"https://...","snippet":"..."}],
 "consistency": {"agree": true, "forward": {"A":0.62,"B":0.30,"none":0.08}, "swapped": {"A":0.58,"B":0.35,"none":0.07}},
 "jev": {"inference_ms": 120.0, "provider": "gemini|openrouter"},
 "answer_text": "...", "disclaimer": "Entertainment demo - not a prediction", "from_cache": false}
```
`probabilities` in `candidates` are the mean of forward and swapped, per candidate identity.
`POST /api/stt` multipart field `audio` (browser MediaRecorder blob, webm/opus; <= 10 MB), optional `language` (default `th`)
-> `{"text": "..."}`. Server forwards to Paxa Labs `POST https://api.paxalabs.com/v1/audio/transcriptions`
(multipart: `file`, `model=paxa-stt-lite-v1-preview`, `language=th`, `response_format=json`;
header `Authorization: Bearer $PAXA_API_KEY`; response `{"text": "..."}`). The key never reaches the browser.
`GET /fly` serves `web/fly.html`. `GET /api/ask/health` -> which providers/keys are configured (booleans only).

## Config (`.env`, git-ignored; `.env.example` is committed)
`GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-flash-latest`; `gemini-2.5-flash` is closed to new accounts, configurable because model names change),
`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `LLM_PROVIDER` (`gemini` default; fall back to the other on error),
`PAXA_API_KEY`, `JEV_MIN_CONF`. A tiny dependency-free `.env` loader. Never log keys.

## Non-goals
No fine-tuning, no changes to the model or to `On-Fly-Jev/`, no push to the remote, no auth, no database changes.
