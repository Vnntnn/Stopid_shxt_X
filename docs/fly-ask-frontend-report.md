# Fly Ask front-end report

## What was built
A dark full-screen page (white rounded frame) with a procedural three.js fly in the centre, a "You" box top right
(Text | Voice toggle) and an "Output fly" box bottom left (stage stepper, answer, probability bars, agreement badge,
forward/swapped details, sources, cache badge, Jev inference ms, disclaimer). At 800px or narrower the panels stack
under the fly. Everything follows `docs/fly-ask-pipeline.md` (NDJSON `/api/ask`, multipart `/api/stt`).

## How to open
- Real backend: `/fly` (the backend serves `web/fly.html`; assets load from `/static/...`).
- No backend: `/fly?mock=1` (decision A), `/fly?mock=inconclusive` (decision inconclusive),
  `/fly?mock=1&fail=<interpret|research|pool|jev|adapter>` (stage failure). Mock STT returns a canned Thai transcript
  and, in mock mode only, a synthetic microphone is used so voice can be tried without hardware (`&realmic=1` to use the real one).

## Files (bytes)
- web/fly.html 4038, web/fly.css 7066, web/fly.js 13779 (UI, ask flow, voice)
- web/fly-scene.js 15471 (three.js scene: fly, pads, stars, states idle/listening/thinking/deciding/inconclusive)
- web/fly-stream.js 2712 (parseNdjsonStream, applyEvent, newState, STAGES)
- web/fly-mock.js 5123 (only imported when `mock` is in the query)
- web/vendor/three.module.min.js 670681 (three.js 0.160.0 from jsDelivr, verified real JS with the MIT licence header)
- tests/fly-stream.test.js (8 tests)

## Tests
`node --test tests/*.test.js`: 24 pass, 0 fail (8 new). Note: `node --test tests/` (directory arg) fails on Node 24
for the whole repo (module resolution); use the glob. `node --check` passes on every web/fly*.js.

## Browser verification (Playwright, software WebGL)
Served by a throwaway script mapping `/static/` to `web/` and `/fly` to `fly.html` (not committed). Checked: idle render,
thinking orbit with live stepper, deciding flight and landing on pad A with wings folded, inconclusive spin, voice
recording (level meter, timer) then mock STT then editable transcript then auto-send countdown then full run, stage
error with Retry, 390px layout (no horizontal overflow). Console: no errors or warnings (the only one seen was a
favicon 404 before an inline favicon was added). Measured about 145 rAF/s in headless software mode.
Screenshots in `docs/fly-ask-screens/`: 01-idle, 02-thinking, 03-decided-A, 04-inconclusive, 05-voice-listening,
06-voice-transcript (shows the run after auto-send), 07-error-retry, 08-mobile-390.

## Not verified
- Against the real backend (`/api/ask`, `/api/stt`, `/fly` route): only the mock contract was exercised. HTTP error
  bodies are parsed leniently (`error.message`, `detail.message` or string `detail`).
- Real microphone, real MediaRecorder opus output size, mic-permission-denied prompt, and the Web Speech fallback
  (code paths exist; they need a real browser with a mic and a configured/unconfigured STT backend).
- Real GPU frame rate on an integrated laptop GPU (capped DPR 2, no post-processing; only software mode measured).
- prefers-reduced-motion behaviour and the WebGL-unavailable fallback message were implemented but not exercised.
- The final test run of the 07 error screenshot was taken with `fail=research`.

## Debug cards and sources panel
The raw "Debug: <stage>" JSON dropdowns are replaced by one structured card per stage, built only with DOM APIs
(`textContent`; only `http(s)` URLs become links with `target=_blank rel="noopener noreferrer"`; long strings wrap with
`overflow-wrap:anywhere`). Each card ends with a collapsed "Raw JSON" block with a Copy button.
- **Interpret**: echo as a quote, party chips with aliases, criterion, model / tokens / cost (`$0.0073`) / latency.
- **Sources the LLM read** (research): "Searched with <engine> - n results - model - as of <date>", numbered source cards
  (hostname badge, 2-line title, 3-line snippet with more/less, "Open source"), then "Findings the LLM extracted".
  `grounded:false` shows an amber "No live web sources" banner with the `notice`; grounded with no sources shows an empty line.
- **What Jev was shown** (pool): state split into sentences, `trimmed` badge, question, A / B / none rows.
- **Jev**: forward / swapped / mean table with mini bars, winner of each run highlighted, inference time.
- **Verify decision** (adapter): decision pill + label, "confidence X vs threshold Y", pass/fail checklist (`checks`, or
  derived from `agree`/`mean`/`min_conf` when missing).
Every card tolerates missing fields (older or cached results: no `search`, `usage`, `checks`, `swapped`).

Panel: once the final event arrives the answer, bars, disclaimer and a "Sources (n)" hostname-chip row sit at the top and
the stepper with its cards below. Header buttons: **Expand** (about 60 vw drawer, own scroll, sticky header; no effect at
<= 800 px, where panels still stack) and, above the cards, **Expand all / Collapse all**. Card, snippet and raw-JSON open
state survives live re-renders and the scroll position is preserved (a CSS `transition` on the panel caused a scroll jump
and was removed).

New `web/fly-format.js` (hostnameOf, formatCost, formatPct, formatSeconds, clampText, safeHttpUrl, deriveChecks) with
`tests/fly-format.test.js` (9 tests). `node --test tests/*.test.js`: 33 pass, 0 fail.
Mock: `?mock=1`, `?mock=inconclusive` and new `?mock=ungrounded` stream the real-sample shapes (Thai titles, long snippets,
`usage`, `search`, `checks`).

Verified in Chromium (Playwright) on the mock and on the real app with `LLM_PROVIDER=fake`: no console errors or warnings,
390 px has no horizontal overflow. Screenshots `docs/fly-ask-screens/09`-`17` (collapsed, cards list, sources, Jev + adapter,
drawer, interpret/pool, ungrounded banner, mobile cards and Jev, real backend).
Not verified: a live OpenRouter run (fake LLM has no `search`/`usage`), Firefox/Safari (`line-clamp`, `color-mix`).
Note: the expanded drawer covers the centre of the fly scene by design.
