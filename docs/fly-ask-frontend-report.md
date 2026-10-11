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

## Camera, gestures and memes
Press **Camera** in the "You" panel (next to Text | Voice). A small mirrored preview appears top-left of the stage with the skeleton and hand
landmarks, fps, mode, the last gesture with its confidence, a red **CAMERA ON** badge and a Stop button. The camera is OFF by default.
- **Privacy**: everything runs in the browser (MediaPipe WASM + plain JS). No frame is uploaded, recorded or stored; only `audio:false` video is
  requested (`getUserMedia({video:{width:640,height:480,facingMode:"user"},audio:false})`). The camera stops on Stop, when the tab is hidden, on
  `pagehide`, or when the device disconnects, and all tracks are released.
- **Assets** (not in git, 33.7 MB): `sh scripts/fetch_camera_assets.sh` downloads `@mediapipe/tasks-vision@0.10.21` (ESM bundle + 4 wasm/js files),
  `pose_landmarker_lite.task` (5.8 MB) and `gesture_recognizer.task` (8.4 MB) into `web/vendor/mediapipe/` (git-ignored). POSIX sh, pinned versions,
  SHA-256 checked, `.part` files then atomic move, idempotent (`--force` re-downloads). They are only requested when Camera is pressed. If they are
  missing the status says `camera assets missing: run scripts/fetch_camera_assets.sh` and nothing else breaks. If MediaPipe fails to start the
  page says so and continues in **motion-only** mode (frame-difference energy on an 80x60 canvas -> a low-confidence `wave`).
- **Pipeline** (`web/fly-cam.js`): vision loop capped at 15 Hz; pose every tick, hand gestures every second tick (GPU delegate, CPU fallback);
  `web/fly-gestures.js` (pure) turns landmarks + hand labels + motion energy into events with debounce, cooldown and hysteresis.
- **Fly**: follows the nose (or a single raised hand) with smoothing and a little camera parallax, only while `idle`. Reactions `startled`, `spin`,
  `happy`, `lean_left/right` through `window.flyApi.react(name)` / `flyApi.setAttention(x,y)`; ignored (not queued) while `deciding`/`landing`
  (landed included); the follow offset ramps to zero when a run starts. NOTE: `web/fly-scene.js` was not on the allowed-files list, so it is
  untouched: `fly.js` wraps `THREE.WebGLRenderer.prototype.render` and adds offsets to the fly group the scene recomputes every frame. This is
  brittle if the scene is restructured (it finds the fly as the scene group with the most children); moving the hooks into the scene is cleaner.

### Gestures (sensitivity low / normal / high; distances in shoulder widths `sw`, times in ms; floor `0.03` image units for any stroke/rise)
Hand-label gestures (from MediaPipe Gesture Recognizer): thumbs_up, thumbs_down, peace (Victory), open_palm, fist, point_up, i_love_you.
`side` is the person's own side as shown on the mirrored preview. `nod`/`head_shake` were NOT built: the nose moves about as much as pose-lite jitters.
| gesture | thresholds (low / normal / high) |
|---|---|
| wave | swing 0.35/0.25/0.18; reversals 4/3/2 in 1400 ms; wrist above shoulder line (-0.15/0/+0.2); cooldown 2200/2000/1600 |
| hands_up | both wrists above nose by 0.4/0.2/0; hold 400/250/150; cooldown 2200/2000/1500 |
| hand_up_left/right | wrist above nose by 0.4/0.2/0.05, other hand not; hold 500/350/250; sideways range <= 0.15/0.2/0.25 (else it is a wave); cooldown 2200/2000/1500 |
| t_pose | wrist span 3.6/3.0/2.5; wrists within 0.3/0.4/0.55 of the shoulder line and outside the shoulders; hold 800/600/400; cooldown 3000/2500/2000 |
| clap | apart >= 1.0/0.8/0.6 then together <= 0.25/0.35/0.45; meetings 3/2/2 in 1800; cooldown 1800/1500/1200 |
| lean_left/right | nose offset from shoulder centre 0.6/0.45/0.3; hold 500/350/250; re-arm at half; cooldown 1500/1200/900 |
| jump | upper body rises 0.45/0.3/0.2 within 450 ms, speed 2.2/1.6/1.1 sw/s, shoulder width changes < 20/20/25 %; cooldown 1800/1500/1200 |
| squat | body below standing level by 0.9/0.65/0.45, held 350/250/150, scale stable; cooldown 3000/2500/2000; blocked 1.2 s after a jump |
| hand labels | score >= 0.75/0.6/0.45, hold 500/350/200 (open_palm 1000/800/600 because a waving hand is an open palm); cooldown 2000/1500/1200 |
| motion-only | energy >= 0.08/0.05/0.03 for 700/500/400 ms, no pose for 1 s -> `wave`, confidence <= 0.6; cooldown 3000/2500/2000 |
An attempt during a cooldown is consumed (leave the pose and come back). Continuous clapping therefore fires about every 1.5 s, by design.

### Actions (collapsible "Camera actions", saved in `localStorage` `fly.cam`)
Per gesture: [Meme] checkbox + action (Meme only, Fly reaction, Replay voice, Send current question, Pick preset question 1-3, Toggle mute) + **Test**
(runs the action without a camera; a Test never sends a question, it only reports "dry run"). Defaults: thumbs_up = replay + meme; wave = fly startled + meme;
jump = fly startled + meme; clap = fly spin + meme; hands_up, peace and the other hand gestures = meme; lean = fly follows (no meme); open_palm = nothing.
"Send current question" needs the master toggle **Let gestures ask questions (costs money)** (off by default, about $0.007 per fresh question), the gesture held
0.8 s (the engine raises that gesture's hold) and 10 s between questions; wave/jump/clap carry no hold, so they cannot ask (greyed out). Presets only fill the text box.

### Memes (`web/fly-memes.js`, `web/memes/memes.json`)
17 gestures, 34 generated cards (e.g. NICE, BRUH, SHEESH, YEET, STONKS, NO WAY, SUS, SKILL ISSUE, GIGACHAD): CSS gradients, impact-style caption, emoji; no
photos, no trademarked characters. To add your own: copy a file into `web/memes/` (png, jpg, gif, webp, avif, svg) and add
`{"type":"image","src":"my.gif","caption":"optional"}` under a gesture in `memes.json` (cards: `{"type":"card","caption":"UP TO 28 CHARS","emoji":"x","colorTheme":"ocean","sound":"boom"}`;
themes sunset ocean grape lime fire ice candy mono gold mint). Bad entries are skipped and listed in the console. **You are responsible for the rights to any image you add.**
Photosensitivity rules (enforced in code and tests): one meme at a time; one onset per >= 1.2 s globally and at most 2 per 3 s, so never more than 1 flash in any second
(stress test: 5 x 200,000 hammering attempts, max 1 per 1 s window); a meme lives 1150 ms (shorter than the cooldown); small card, never full-screen, dark/mid colours (luminance and
contrast tested); images capped at about 40 % of the viewport (240 px floor on phones); nothing blinks or alternates; `prefers-reduced-motion` = plain fade, no scale/rotate, animated
GIF/WebP shown as first frame only; `pointer-events:none`; caption announced via an `aria-live` region. Optional `boom` sound: level >= 1, honours mute and ducking.

### Mock camera and debug hooks
`/fly?cam=mock` (add `&mock=1` for the mock backend): scripted pose/hand sequences for every gesture go through the same engine, with a "MOCK CAMERA" badge and a timeline.
`window.__flyCamDebug()` -> `{running, fps, lastGesture, memesShown, mode, ...}` (only with `?cam=mock`, `?mock` or `?debug=1`); mock also has `window.__flyCamMock.play(name)` / `.test(name)`.

### Tests and verification
`node --test tests/*.test.js`: 157 pass (74 before; new: fly-gestures 69, fly-memes 10, fly-cam 3, fly-audio +1). Every gesture has a clean positive, a near miss, jitter (sigma 0.004 still fires, 0.003-0.007 on a still person never triggers at any sensitivity) and cooldown tests.
Chromium (Playwright): every gesture's meme shown in mock mode, fly reactions, actions panel, no console errors at 1360/800/390 px (no horizontal overflow), reduced-motion (`meme static`, fade only), assets-missing
message (vendor dir renamed, then restored), reactions refused while deciding, camera tracks `ended` after Stop. **Real MediaPipe**: with a canvas `captureStream` standing in for the camera, both models loaded and ran
(GPU delegate, init 238 ms; 15 fps; CPU image-mode init 140 ms, one inference of both models on a canvas 137 ms; no person in that image so 0 poses). `.wasm` is served as `application/wasm`.
Console note: MediaPipe prints its own INFO/W lines through console.error/warn (XNNPACK, OpenGL error checking) after Camera is pressed, and the missing-assets probe shows 404s then. Screenshots 25-31.
**Not verified**: a real camera and real people (pose and hand accuracy, thresholds are educated defaults and need tuning), the Gesture Recognizer on real hands, GPU on real hardware, Firefox/Safari, `http://<LAN-IP>` (shows "needs localhost or https"), a paid "ask" from a real gesture, listening to the boom.

## Copy me (mimic)
"I want to play with the fly: if we do certain poses, the fly does the same." Switch **Copy me** on (checkbox under the Camera button, default OFF, saved in
`localStorage` `fly.mimic`), press Camera, stand still for about 1.5 s, then move: the 3D fly copies you. All maths runs in the browser; landmarks never leave the page.
Status line: `Calibrating: stand still` / `Copying you` / `No body found` / `Paused while the fly works` / `Press Camera so the fly can see you`. Options: **Mirror** (default on),
**Smoothness** slider (One Euro minimum cutoff 5 Hz * 0.1^s, so 5 Hz .. 0.5 Hz), **Recalibrate**. Sensitivity (Camera actions) scales the dead zones (low 1.5x, normal 1x, high 0.65x).

**Rig and hooks (`web/fly-scene.js`)**: the render-patch hack in `fly.js` was removed. The scene exposes `setFrameHook(fn)` (called every frame with `{dt,t,state,landed}`),
`setOffsets({dx,dy,yaw,spin,flap,camX})` (additive follow/reaction extras), `setPose(partialRig)`, `setPoseWeight(0..1)`, `getPose()` (smoothed values + weight) and the getters `state`, `landed`, `settled`.
Rig values are normalised and clamped (contract in `web/fly-mimic.js`: `RIG_SPEC`, `clampRig`, `blendRig`, `smoothRig`, `legAngles`, `wingAngles`, all unit-tested). The scene smooths them (rate 16/s) and
blends them over its own state-machine look by the pose weight; at weight 0 the old code path is untouched, so thinking/deciding/landing/inconclusive are as before (screenshot 40 vs 03).
The two FRONT legs are now articulated (hip, upper segment, knee, lower segment, yellow "hand" tip) and slightly thicker and lighter so a raised "arm" reads from camera distance; wings turn to face the viewer when raised.
Rig keys: `wingL/R` (0 folded, 0.45 straight out, 1 up), `flapL/R`, `legL/R` (front leg raise), `swingL/R` (forearm out/in), `curl`, `legWiggle`, `roll`, `pitch`, `squash` (+ crouch, - stretch), `hop`, `lookX/Y`, `glow`. L/R are SCREEN sides.

| you | fly (mirror on; person's right = screen right) |
|---|---|
| wrist (75%) and elbow (25%) height vs shoulder line, in shoulder widths, dead zone 0.12 | that side's front leg raise 0..1 (hand at hip = 0, at shoulder = 0.65, above head = 1) |
| arm angle from hanging (0 deg) via T (90) to straight up (165); dead zone 28 deg; the WEAKER arm decides 70% so one raised hand moves a leg, not the wings | wings: folded 0 / wide 0.5 / up 1 (min 0.05) |
| wrist speed | flap amplitude 0.1 .. 0.8 |
| shoulder-line tilt (65%) and torso offset hips vs shoulders (45%), dead zone 0.1 | `roll` (+ = screen-right side down; sign flips with Mirror off) |
| shoulder (+hip) drop vs baseline, dead zone 0.2, full at 0.6 sw | crouch: squash up to 1, body lowers 0.4 |
| rise vs baseline, dead zone 0.12, full at 0.5 sw | hop up to 1 (and stretch -0.6) |
| shoulder width vs baseline (+-30 %) | `pitch` (low confidence) |
| nose vs ears | `lookX/lookY` (small) |
| events: `clap` | wings snap shut 0.25 s then fully open, release after 1.4 s |
| `wave` (event side) | that front leg up with a 3.5 Hz forearm swing, 2.2 s |
| `thumbs_up` | a front leg up (event side, else the higher arm) + a 0.8 s glow pulse (slow fade, no flashing) |
| `peace` | both legs up in a V, 1.8 s |
| `fist` | legs curl + a small shake (roll), 1.4 s |
| `open_palm` | wings wide (0.55) and frozen (flap 0), 1.8 s |
| `point_up` | the fly rises (hop 0.55 + nose up), 1.5 s |
| `jump` | hop pulse (the continuous signal gives the height) |

**Calibration**: while there is no baseline the status says `Calibrating: stand still`. It needs 1.5 s in which the shoulder line moves <= 0.035 image units and the shoulder width <= 14 %; moving restarts the window.
It stores the median shoulder height, hip height (if visible) and shoulder width. Arms, lean and wings work before it finishes; crouch/hop/pitch wait for it. If your size in the picture changes more than 22 % (you stepped closer/back) vertical features are
ignored and after 2 s it recalibrates by itself. **Recalibrate** clears it on demand. Toggling Copy me on starts fresh.
**Loss and confidence**: shoulders must have visibility >= 0.5. When lost, the last pose is held 300 ms, then it blends to idle and the weight to 0, fully idle at 1.5 s (`No body found`). Weight fades in over 0.4 s and out over 0.5 s, scaled by shoulder visibility.
**Questions**: the mimic is paused (weight fades out) whenever the scene is not "settled": thinking, listening (voice), the decision flight and the inconclusive spin. It fades back in once the fly has landed (it then copies you in place on the pad) or hovers again.
Discrete reactions are replaced while Copy me is on: the gesture's own mimic overlay plays instead of a canned `startled/spin/happy/lean` (`flyApi.react('startled'|'happy'|'lean_*')` also maps to overlays; `spin` stays a real spin without wing flap). The attention follow is unchanged and works together with the mimic. Memes are independent and keep their photosensitivity limits.
**Sound** (optional, level >= 1, mute/ducking honoured): a boing when the hop crosses 0.5 (>= 0.9 s apart), a squeak when a front leg goes above 0.7 (>= 1.2 s apart).

**Mock and debug**: `?cam=mock` with Copy me on plays a dance timeline instead of the gesture tour (stand, right hand, left hand, both hands up, T-pose, lean left/right, squat, jump, clap, wave, thumbs up, peace, fist, open palm, point up) with a caption "Mock pose: ...".
`window.__flyCamMock.play(name)`, `.freeze(true|false)` (hold the scripted pose), `.danceNames`, `.test(gesture)`. `window.__flyRigDebug()` (only with mock or `?debug=1`) returns the rig the scene shows now plus `weight`, `target` (mimic output), `status`, `calibrated`, `mirror`, `scripted`.

**Tests**: `node --test tests/*.test.js`: 177 pass (157 + 20 in `tests/fly-mimic.test.js`: every mapping, mirror both ways, calibration, jitter, loss decay, confidence fade, smoothing, clamping, events, and 4 mutation checks: mirror flip, roll sign, dead zone, decay timeout).
Chromium (Playwright, `?cam=mock&mock=1`, no console errors, no horizontal overflow at 390 px): every dance pose moved the matching parameters (right hand -> legR 1 / legL 0, left hand the opposite, mirror toggle flips them, T-pose wings 0.5 + legs 0.6, hands up wings 1 + legs 1, lean left roll -0.65 / lean right +0.65, squat squash 1, jump hop 1,
clap wings 0 -> 1 -> release, wave swing oscillates, thumbs up glow 0.88, peace V, fist curl 1, open palm wings 0.55 + flap 0, point up hop 0.55). A question run paused the mimic (weight 0 during thinking and the dive, `paused`), decision flight/landing look as in 03, and the mimic faded back in after landing. Screenshots 32-41.
**Not verified**: a real camera and real pose quality (thresholds, the 28 deg wing dead zone, the lean and crouch scales and the ear-based look are educated defaults from synthetic landmarks; pose-lite jitter is simulated at 0.003), people not standing in front of the camera (seated, partial body), hip visibility on laptops, the boing/squeak sounds by ear, Firefox/Safari, performance on low-end GPUs.

## Meme PNG slaps

The animated meme card is gone. A meme is now a **PNG slapped onto the screen**: it appears instantly (no fade, no scale), at a random spot, rotated by up to 14 degrees, sized 22-42 % of the shorter viewport side (never above 60 % of the viewport), `pointer-events:none`, above the 3D scene and the panels (it is meant to cover things), then is cut after the duration. The caption goes to an `aria-live` region only (no visual duplicate). The old procedural `card` type remains as a text-only fallback (no emoji) when every image of a gesture is missing.

Files: `web/fly-memes.js` (pure logic: manifest parser, `slapPlacement`, limiter, speeds, chooser, user-meme store; plus the DOM overlay), `web/memes/memes.json` (gesture -> pool), `web/memes/captions.js` + `web/memes/generator.html` + `scripts/make_meme_pngs.py` (the generator), `web/memes/png/*.png` (53 generated images, about 4.1 MB), `scripts/make_meme_sheet.py` (contact sheet, screenshot 51).

### Safety rules (all tested in `tests/fly-memes.test.js` and `tests/fly-meme-png.test.js`)
- **At most 2 slaps start in any 1 second** (closed window), at every speed, plus a minimum gap between starts. Stress tests hammer the limiter for 40 simulated minutes (random bursts), 10 minutes of one trigger per millisecond and a periodic attacker at exactly the gap, for Normal, Fast and ULTRA. Mutation checks (cap removed, gap shortened, window widened, chooser filter removed, rotation always on) each make tests fail. The stacking cap (`maxStack`) is defence in depth only: the gap already keeps ULTRA at two on screen, so removing it is not caught.
- One slap on screen (two in ULTRA); a single static image; never full-viewport; no strobing; instant cut (0 ms, limit 60 ms). Images are dimmed with `filter: brightness(.88)`.
- Generated PNGs: 480-720 px, under 120 KB, dark or colourful backgrounds with off-white text; the generator and the test both check mean luminance (0.04-0.42), near-white share (at most 22 %) and near-black share (at most 38 %), transparent pixels judged over the page background.
- `prefers-reduced-motion`: no rotation, no size jitter, and GIF / video memes are never shown.
- The user's own pictures are bright (the Son memes have white backgrounds). They are only dimmed by the 0.88 filter and kept small by the size rule; the luminance check covers the generated set only.

### Speeds (Camera actions > Meme speed, saved in `localStorage` `fly.memeSpeed`)
| | duration | min gap between starts | on screen |
|---|---|---|---|
| Normal | 1000 ms | 1200 ms | 1 |
| Fast | 750 ms | 800 ms | 1 |
| ULTRA | 550 ms | 500 ms | up to 2 |

The Test button of each gesture row goes through the same limiter. The meme sounds are synthesized in `fly-audio.js` (`playMeme`: boom, airhorn, bruh, violin, scratch, ding, buzzer, wow), level >= 1 only, honouring mute and ducking.

### Mapping (`web/memes/memes.json`, 3-5 variants per gesture, random without an immediate repeat)
`any` is a wildcard pool: used for about 1 slap in 5 on every gesture (and as a fallback when a gesture's own files are missing). jump: SIUUUU, LET'S GOOOO, ว้าวซ่า, FLY HIGH. hands_up: LET'S GOOOO, ปังมาก, GG EZ, SIX SEVEN. t_pose: T-POSE TO ASSERT DOMINANCE, +1000 AURA, LOCK IN. clap: GG EZ, 555555, งานดี, BARK. wave: SHEESH, HELLO??, BZZZZ. thumbs_up: +1000 AURA, ปังมาก, BASED, RIZZ MAX, NO CAP. thumbs_down: the Son meme, BRUH, L + RATIO, -1000 AURA. peace: SIGMA, PEACE AND LOVE, จึ้งอ่ะ, DELULU. fist: COOKED, CRASHOUT, ตึงมาก, SUS. point_up: WELL ACTUALLY, ถามหน่อย, NO CAP, อะไรของเธอ. open_palm: TALK TO THE HAND, ใจเย็นๆ, TOUCH GRASS. i_love_you: ฟินเว่อร์, ROCK ON, เขินอ่ะ, DELULU. squat: SKILL ISSUE, ไม่ไหวแล้ววว, the Son meme, ตายแล้ว. lean_left / lean_right: MEWING, NPC MOMENT, LOCK IN / THE FLY HAS SPOKEN. hand_up_left / right: ถามหน่อย, I'MA LET YOU FINISH, แล้วไงต่อ (and ONLY IN OHIO, CERTIFIED HOOD CLASSIC on the right). any: the user's two other Son pictures.

### Belly rub (new gesture `belly_rub`)
One wrist circling or rubbing on the lower torso (between the shoulder-hip midline and the hips, within the shoulders' span plus 10 %), for 0.6-0.9 s depending on sensitivity, measured relative to the shoulder midpoint so jumping or leaning does not count. Needs at least 2-3 direction changes, a minimum stroke (above the landmark jitter floor) and a minimum path; the other hand must not be on the torso or next to the rubbing hand (so a clap is not a belly rub). Hips that are out of frame are estimated from the shoulders. Cooldown 2.5-3.5 s. Default action: meme. Mapping: `png/belly-man.png`, a **centered, upright, no-jitter slap at 55 % of the shorter side** of the pregnant-man emoji U+1FAC3 (rendered from the installed Noto Color Emoji; it has the glyph, so nothing was vendored and there is no NOTICE.md; the emoji is a 136 px bitmap strike scaled up, so it is slightly soft). It is the only emoji in the set.

### Add your own PNG
1. Put the file in `web/memes/` (for example `web/memes/mine/hello.png`; keep `web/memes/images/` for pictures you do not want in git, it is ignored) and add `{"type":"image","src":"mine/hello.png","caption":"Hello","sound":"ding"}` to a gesture (or to `any`) in `memes.json`. Allowed: png jpg webp avif svg; optional `centered` / `noJitter`; sounds: none boom airhorn bruh violin scratch ding buzzer wow. A malformed entry is ignored with a console warning; a missing file is skipped with one `console.info` (the browser itself still logs the 404).
2. Or drop PNG / JPG / WebP files on the page (or press Add memes in the actions panel): a dialog asks which gestures should show them. They are stored in this browser's IndexedDB (max 40 files, 2 MB each), shown as thumbnails with a delete button, and "Export manifest" downloads the list as JSON without the files. Nothing is uploaded. GIF, video and audio files are accepted only after ticking "Also allow GIF / video / audio memes" (a flashing-media warning appears, default off), are cut after at most 1.5 s, count against the same limiter and never show with reduced motion.
3. Regenerate or edit the starter set: change `web/memes/captions.js`, then `python3 scripts/make_meme_pngs.py [id ...]` (Chromium, Pillow and the fonts Liberation Sans, Noto Sans Thai, Noto Color Emoji; it exits non-zero when a PNG breaks the size or luminance rules).

### Starter captions (53 PNGs)
English: SIUUUU; LET'S GOOOO; +1000 AURA; -1000 AURA; NO CAP / FR FR; SKILL ISSUE; L + RATIO; BASED; SIGMA; SUS; BRUH; SHEESH; GG / EZ; NPC MOMENT; COOKED; LOCK IN; MEWING; RIZZ MAX; BARK; I'MA LET YOU FINISH; WELL ACTUALLY; TOUCH GRASS; CRASHOUT; DELULU IS THE SOLULU; CERTIFIED HOOD CLASSIC; THE FLY HAS SPOKEN; HELLO??; T-POSE TO ASSERT DOMINANCE; TALK TO THE HAND; ROCK ON; PEACE AND LOVE; SIX SEVEN; ONLY IN OHIO (wanted poster); BZZZZ; AURA FARMING; FLY HIGH. Thai: ปังมาก; จึ้งอ่ะ; ตึงมาก; 555555; โอ๊ยตาย; ไม่ไหวแล้ววว; งานดี; ยอมรับ; ฟินเว่อร์; ตายแล้ว; อะไรของเธอ; ใจเย็นๆ; ถามหน่อย; แล้วไงต่อ; ว้าวซ่า; เขินอ่ะ. Layouts: centred caption, top + bottom, sticker, wanted poster, fake notification, fake subtitle bar, tier-list label; 17 are deep-fried (contrast, saturation, noise, harsh JPEG round trip). Text, shapes and the cartoon fly only: no photos, likenesses, logos or emoji. See screenshot 51.

### Verification
`node --test tests/*.test.js`: 204 pass (177 before, plus belly_rub, slap placement, limiter stress, lifecycle with fake timers, manifest validation, chooser, speeds, PNG luminance, user store with injected storage, `playMeme`). Chromium (Playwright, `?cam=mock&mock=1`, 1360 and 390 px, no console errors): slaps screenshotted while visible for jump, belly_rub, thumbs_down (the Son meme), hands_up and squat (Son), clap, peace, fist, i_love_you, t_pose and point_up (screens 42-48); belly_rub fired through the real engine from the mock timeline and showed "Pregnant man" centred; firing 20 triggers in 1 s gave one start at Normal, and a 60-trigger burst at ULTRA gave starts at 0, 505, 1009 ms (max 2 in a second, peak 2 on screen); reduced-motion emulation gave no transform and a constant width; with `web/memes/images/` renamed the Son memes were skipped (3 `console.info`, no broken images, others shown); a dropped PNG went through the dialog into IndexedDB, survived a reload, appeared as a slap and was deleted again (screens 49, 50).

**Not verified**: real laughs (whether Gen Z actually finds these funny is untested), a real camera (belly rub thresholds are from synthetic landmarks, real rubbing and out-of-frame hips are untested), audible quality of the synthesized sounds (only that nodes are created), GIF / video / audio memes in a real browser (only the logic is tested), drag and drop with real OS files (the same code path was driven through `offerFiles`), Safari and Firefox.
