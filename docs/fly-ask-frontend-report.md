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
