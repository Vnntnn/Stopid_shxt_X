# Fly Ask front-end report

## What was built
A dark full-screen page (white rounded frame) with a procedural three.js fly in the centre, a "You" box top right
(Text | Voice toggle) and an "Output fly" box bottom left (stage stepper, answer, probability bars, agreement badge,
forward/swapped details, sources, cache badge, Jev inference ms, disclaimer). At 800px or narrower the panels stack
under the fly. Everything follows `docs/fly-ask-pipeline.md` (NDJSON `/api/ask`, multipart `/api/stt`).

## How to open
- Real backend: `/` (the backend serves `web/fly.html`; assets load from `/static/...`; old `/fly` links redirect to `/`).
- No backend: `/?mock=1` (decision A), `/?mock=inconclusive` (decision inconclusive),
  `/?mock=1&fail=<interpret|research|pool|jev|adapter>` (stage failure). Mock STT returns a canned Thai transcript
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

## Fly sound
The fly flies with procedural sound and speaks its answer in a ridiculous voice. Everything is Web Audio (no files, no libs):
`web/fly-audio.js` (engine), `web/fly-speak.js` (the spoken line), UI in `fly.js`/`fly.html`/`fly.css`.
- **Line** (`flySpeech(final, lang, level)`): Thai or English from `interpretation.language`, deterministic (seeded by decision + label + percent, so replays say the same thing), at most 200 characters, always contains the candidate label and percent, or "can't decide" for `inconclusive`. Digits, not words.
- **Stupid level** (select, default MAXIMUM, saved in `localStorage` key `fly.sound` with the mute state and volume): Off = no wing buzz, no jingle, plain voice; Silly = buzz + chipmunk voice (rate 1.3, light ring mod); MAXIMUM = buzz, slide whistle + kazoo fanfare or sad trombone, voice at rate 1.45 with ring modulation (90-130 Hz), pitch wobble, high-pass, distortion, random "bzzt" bursts and a 3x stutter of the first 150 ms.
- **Flight sound** follows the fly state: idle (barely audible), listening (fast pulse, speeds up with the mic level), thinking (stereo orbit with doppler pitch), deciding (swoop, pans to pad A left / B right / none centre), landing (descending buzz, tap, squeak), inconclusive (erratic jumps then a sad slide-down).
- **Flow**: audio unlocks on the first Send / mic / Replay / mute click. When the final event arrives the TTS fetch starts (`POST /api/tts` with the line; `/api/ask/health` `tts:false` skips it); at landing the jingle plays and the voice follows ~1 s later. The decoded buffer is kept per answer: **Replay voice** replays it with no request. A new question cancels everything. `from_cache` still speaks.
- **Controls**: bottom-right of the stage (mute toggle, volume, level); caption "Fly says: ..." with `aria-live` and the Replay button in the Output fly panel.
- **Fallbacks**: any `/api/tts` failure -> `speechSynthesis` (pitch 2, rate 1.5, `th` voice if present) + the same effects, and a small "Fly lost its voice" note; no speech either -> effects only. Nothing throws into the UI. Hidden tab: context suspended, no sound. `prefers-reduced-motion` affects visuals only.
- **Mock**: `?mock=1` / `?mock=inconclusive` serve a synthesized WAV as the voice (`?tts=fail` makes it 503 to exercise the fallback). `window.__flyAudioDebug()` (only with `?mock` or `?debug=1`) returns `{state, rms, level, muted, ...}` from an analyser on the master output; `.engine` exposes the engine for tests.
- **Tests**: `tests/fly-speak.test.js` (9) and `tests/fly-audio.test.js` (12, includes a fake AudioContext checking wiring and that `stopAll()` disconnects everything). `node --test tests/*.test.js`: 54 pass.
- **Verified in Chromium**: AudioContext `running` after the Send click and nothing before; analyser RMS > 0 while buzzing and while the voice plays, 0 when muted and after `stopAll()`; Replay makes no `/api/tts` request; `tts=fail` shows the note and uses the fallback; a real `/api/tts` MP3 (fake LLM, real backend) decodes and plays; no console errors; sound controls do not overlap the panels at 1360 px and 390 px. Screenshots `18`, `19`.
- **Not verified**: actual listening (nobody heard it: volume balance, whether it is stupid enough or annoying), `speechSynthesis` voices (headless has none to judge), Firefox/Safari. Ducking while recording is verified only with the synthetic mock mic, not a real microphone.
- **Ducking while recording**: the mic is requested with echo cancellation, noise suppression and auto gain. While recording (and while browser speech recognition listens) all fly audio goes through the master gain at 8% of the current volume (short ramp), result jingles and voice are not played, and the volume is restored smoothly when recording stops (mute still wins). The 3D `listening` animation is unchanged. Verified in `?mock=1`: master gain 0.0173 while recording vs 0.2157 after (volume 0.6 x 0.9 = 0.216 expected). Unit test with mutation checks (duck factor, voice block) in `tests/fly-audio.test.js`; 55 tests pass.

## Raw JSON view
The Output fly header has a **Cards | Raw JSON** switch (`role="tablist"`, arrow keys / Home / End, choice saved in `localStorage` `fly.view`, last sub-tab and wrap setting in `fly.raw`, all in try/catch). Raw view hides the answer block and cards (a one-line decision pill stays: decision, label, percent, "from cache", running stage or the failure message) and fills the panel (about 60 vh, the Expand drawer's full height, a 62 vh block at <= 800 px) with its own scroll.
- **Sub-tabs**: **Final** (the FINAL object; "Waiting for the final event..." until it arrives, a note if the run failed), **Stream** (every NDJSON event as `{t_ms, stage, status, event}`, `t_ms` since the request started), **Session** (`{request:{text, replay, startedAt}, events, final, error?}`). Stage error events, malformed lines and network failures (a `client`/`error` record) show up in Stream and Session; collapsed event lines carry a hint (`+720 ms research/done`, or the error message).
- **Rendering**: 2-space pretty print, monospace, colours for keys/strings/numbers/booleans/null, all built with `textContent` (no `innerHTML`). Caret per object/array, state per path (default expanded to depth 2), **Collapse all / Expand all**, **Wrap lines**, **Copy** (clipboard API, textarea fallback, button says "Copied"), **Download .json** (Blob + object URL revoked after 1 s, `fly-ask-yyyymmdd-hhmmss.json`), size badge (bytes + event count). Copy/Download use the full untruncated JSON of the current tab.
- **Large output**: strings over 4,000 chars are shortened with a "show full" button per path, at most 1,500 lines are drawn ("Show 1500 more lines"), folded nodes cost nothing, and nothing renders while Cards view is active. Check with `?mock=1&big=1` (3.7 MB session, 11 live events): longest main-thread stall 11 ms, fold-all 15 ms.
- **Live**: re-render is rAF-throttled and keeps collapsed state and scroll; Stream/Session follow the tail only when scrolled to the bottom. A new run resets everything (sub-tab and wrap are kept).
- **Code**: pure helpers and 19 tests in `web/fly-json.js` / `tests/fly-json.test.js` (the expanded tokenizer text equals `JSON.stringify(v, null, 2)`, truncation incl. surrogate pairs, collapse helpers, `sessionExport`, `exportFileName`, `byteSize`); view in `fly.js`. Mock: `?xss=1` puts `<script>`/`<img onerror>` in sources, facts and answer; `?big=1` pads the sources; `window.__flyRaw.setRun()` only with `?mock`. `node --test tests/*.test.js`: 74 pass.
- **Verified in Chromium** (`?mock=1`, `inconclusive`, `ungrounded`, `fail=research`, replay/`from_cache`, real backend with `LLM_PROVIDER=fake`): switching during and after a run, three sub-tabs, fold state kept while events arrive, Copy (confirmation; text equals the tab JSON), Download (anchor `download` name, Blob URL created and revoked), persistence across reload, `<script>` shown as text (no script/img nodes, `window.__xss` unset), keyboard arrows, 1360 / 800 / 390 px with no horizontal page overflow, drawer, no console errors. Screenshots `20`-`24`.
- **Not verified**: Firefox/Safari, a real LLM run, the real clipboard permission path (the clipboard call was stubbed; the textarea fallback was not exercised).
