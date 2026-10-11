// Fly Ask camera pipeline: getUserMedia -> MediaPipe Tasks Vision (pose + hand gestures) -> gesture engine.
// Everything runs locally in the browser: frames are never uploaded, recorded or stored, and the camera is OFF until the
// user presses the Camera button. The pure helpers (messages, attention target) are testable in Node; the rest needs a browser.
//
// Real assets are NOT in git: scripts/fetch_camera_assets.sh downloads them into web/vendor/mediapipe/.

export const ASSET_BASE = '/static/vendor/mediapipe';
export const ASSET_FILES = ['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm', 'pose_landmarker_lite.task', 'gesture_recognizer.task'];
export const MSG_ASSETS_MISSING = 'camera assets missing: run scripts/fetch_camera_assets.sh';
export const MAX_FPS = 15;
export const MOTION_W = 80, MOTION_H = 60;

// Friendly text for getUserMedia failures (and "no getUserMedia at all").
export function describeCameraError(err, secure = true) {
  const name = err && err.name;
  if (err === 'unsupported' || name === 'unsupported') return secure ? 'This browser cannot open a camera.' : 'The camera needs a secure page: open this app on http://localhost or over https.';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'Camera permission was denied. Allow it in the browser address bar, then press Camera again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'No camera was found. Plug one in and try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'The camera is busy (another app or tab is using it). Close it and try again.';
  return 'Could not start the camera' + (err && err.message ? ` (${String(err.message).slice(0, 80)})` : '') + '.';
}

// Where the fly should look. pose: raw MediaPipe landmarks (x to the right, y down, UNMIRRORED);
// hand: landmarks of the first detected hand or null. Returns {x, y, source} with x,y in -1..1 as seen on the MIRRORED
// preview (x > 0 = right on screen, y > 0 = down), or null when nothing usable was seen.
export function attentionFrom(pose, handLandmarks) {
  const ok = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility == null || p.visibility >= 0.4);
  const mirror = (p, source) => ({ x: Math.max(-1, Math.min(1, 1 - 2 * p.x)), y: Math.max(-1, Math.min(1, p.y * 2 - 1)), source });
  if (Array.isArray(pose) && pose.length >= 17) {
    const nose = pose[0];
    const ls = pose[11], rs = pose[12];
    if (ok(nose) && ok(ls) && ok(rs)) {
      // A hand raised above the head wins: that is what the user is "pointing" with.
      const lw = pose[15], rw = pose[16];
      const up = [lw, rw].filter((w) => ok(w) && w.y < nose.y - 0.05);
      if (up.length === 1) return mirror(up[0], 'hand');
      return mirror(nose, 'nose');
    }
  }
  if (Array.isArray(handLandmarks) && ok(handLandmarks[0])) return mirror(handLandmarks[0], 'hand');
  return null;
}

export const POSE_LINES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [0, 1], [0, 4], [7, 8], [15, 17], [16, 18], [15, 19], [16, 20]];
export const HAND_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

function drawOverlay(canvas, pose, hands) {
  const g = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  g.clearRect(0, 0, w, h);
  g.lineWidth = Math.max(2, w / 160);
  const vis = (p) => p && (p.visibility == null || p.visibility >= 0.4);
  if (pose) {
    g.strokeStyle = 'rgba(141,255,196,.95)';
    for (const [a, b] of POSE_LINES) { const p = pose[a], q = pose[b]; if (vis(p) && vis(q)) { g.beginPath(); g.moveTo(p.x * w, p.y * h); g.lineTo(q.x * w, q.y * h); g.stroke(); } }
    g.fillStyle = '#ffe14d';
    for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24]) { const p = pose[i]; if (vis(p)) { g.beginPath(); g.arc(p.x * w, p.y * h, g.lineWidth * 1.4, 0, 6.2832); g.fill(); } }
  }
  for (const lm of hands || []) {
    g.strokeStyle = 'rgba(90,209,255,.95)';
    for (const [a, b] of HAND_LINES) { const p = lm[a], q = lm[b]; if (p && q) { g.beginPath(); g.moveTo(p.x * w, p.y * h); g.lineTo(q.x * w, q.y * h); g.stroke(); } }
    g.fillStyle = '#fff';
    for (const p of lm) { g.beginPath(); g.arc(p.x * w, p.y * h, g.lineWidth * 0.8, 0, 6.2832); g.fill(); }
  }
}

// ---------------------------------------------------------------------------------------------
// controller. opts:
//   video, overlay (canvas), engine (createGestureEngine), onEvent(ev), onAttention(a|null), onState(state, message)
//   onFrame(info)         optional: { fps, gesture } each second
//   mock: { buildTimeline, mockFrameAt, MOCK_ORDER } from fly-mock.js  -> ?cam=mock, no camera, no models
//   assetBase, fetchImpl, visionLoader (tests), maxFps
// States: 'off' | 'starting' | 'on' | 'error'.  info.mode: 'full' | 'motion-only' | 'mock'.
// ---------------------------------------------------------------------------------------------
export function createCamera(opts) {
  const { video, overlay, engine } = opts;
  const base = opts.assetBase || ASSET_BASE;
  const maxFps = opts.maxFps || MAX_FPS;
  const state = { running: false, starting: false, mode: 'off', fps: 0, lastGesture: null, lastConfidence: 0, frames: 0, memesShown: 0, message: '' };
  let stream = null, pose = null, gesture = null, raf = 0, timer = 0, lastTick = 0, tickNo = 0, lastTs = 0, errStreak = 0;
  let motionCanvas = null, motionCtx = null, prevLuma = null, luma = null;
  let fpsStamp = 0, fpsCount = 0;
  let mockT0 = 0, mockOffset = 0, mockTl = null, mockOrder = null, mockFrozen = null;
  let seq = 0;

  const set = (s, msg) => { state.message = msg || ''; if (opts.onState) opts.onState(s, msg || '', state); };

  async function probeAssets() {
    const f = opts.fetchImpl || fetch.bind(globalThis);
    try {
      const rs = await Promise.all(ASSET_FILES.map((p) => f(`${base}/${p}`, { method: 'HEAD', cache: 'no-cache' }).then((r) => r.ok, () => false)));
      return rs.every(Boolean);
    } catch (_) { return false; }
  }

  async function initVision() {
    const mod = await import(/* @vite-ignore */ `${base}/vision_bundle.mjs`);
    const fileset = await mod.FilesetResolver.forVisionTasks(`${base}/wasm`);
    const make = async (delegate) => {
      const p = await mod.PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: `${base}/pose_landmarker_lite.task`, delegate }, runningMode: 'VIDEO', numPoses: 1 });
      try {
        const g = await mod.GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: `${base}/gesture_recognizer.task`, delegate }, runningMode: 'VIDEO', numHands: 2 });
        return { p, g };
      } catch (err) { p.close(); throw err; }
    };
    let r, delegate = 'GPU';
    try { r = await make('GPU'); } catch (_) { delegate = 'CPU'; r = await make('CPU'); }
    return { ...r, delegate };
  }

  function sampleMotion() {
    if (!motionCanvas) { motionCanvas = document.createElement('canvas'); motionCanvas.width = MOTION_W; motionCanvas.height = MOTION_H; motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true }); }
    motionCtx.drawImage(video, 0, 0, MOTION_W, MOTION_H);
    const d = motionCtx.getImageData(0, 0, MOTION_W, MOTION_H).data;
    const n = MOTION_W * MOTION_H;
    luma = luma || new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) luma[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    let changed = 0;
    if (prevLuma) for (let i = 0; i < n; i++) if (Math.abs(luma[i] - prevLuma[i]) > 24) changed++;
    const e = prevLuma ? changed / n : 0;
    const t = prevLuma; prevLuma = luma; luma = t || new Uint8Array(n);
    return e;
  }

  function handleResult(ts, poseLm, handsList, motion, handLandmarks) {
    drawOverlay(overlay, poseLm, handLandmarks);
    if (opts.onPose) { try { opts.onPose(ts, poseLm); } catch (_) { /* decoration only */ } } // Copy me: raw landmarks stay in the page
    const evs = engine.update({ ts, pose: poseLm, hands: handsList, motion });
    for (const ev of evs) { state.lastGesture = ev.name; state.lastConfidence = ev.confidence; if (opts.onEvent) opts.onEvent(ev); }
    if (opts.onAttention) opts.onAttention(attentionFrom(poseLm, handLandmarks && handLandmarks[0]));
  }

  function fpsTick(now) {
    fpsCount += 1;
    if (!fpsStamp) fpsStamp = now;
    if (now - fpsStamp >= 1000) { state.fps = Math.round((fpsCount * 1000) / (now - fpsStamp) * 10) / 10; fpsCount = 0; fpsStamp = now; if (opts.onFrame) opts.onFrame(state); }
  }

  function tickReal() {
    if (!state.running) return;
    raf = requestAnimationFrame(tickReal);
    const now = performance.now();
    if (now - lastTick < 1000 / maxFps - 2) return;
    lastTick = now;
    if (video.readyState < 2 || !video.videoWidth) return;
    if (overlay.width !== video.videoWidth) { overlay.width = video.videoWidth; overlay.height = video.videoHeight; }
    tickNo += 1;
    const ts = Math.max(lastTs + 1, now); lastTs = ts;
    let motion = 0;
    try { motion = sampleMotion(); } catch (_) { /* tainted or not ready */ }
    let poseLm = null, handsList, handLm = null;
    if (pose && gesture) {
      try {
        const pr = pose.detectForVideo(video, ts);
        poseLm = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0] : null;
        if (tickNo % 2 === 0) {
          const gr = gesture.recognizeForVideo(video, ts + 0.5);
          handsList = (gr.gestures || []).map((g) => ({ label: g[0] && g[0].categoryName, score: g[0] ? g[0].score : 0 }));
          handLm = gr.landmarks && gr.landmarks.length ? gr.landmarks : null;
        }
        errStreak = 0;
      } catch (err) {
        errStreak += 1;
        if (errStreak >= 5) { closeVision({ p: pose, g: gesture }); pose = null; gesture = null; state.mode = 'motion-only'; set('on', 'Gesture models stopped working: motion-only mode.'); }
      }
    }
    state.frames += 1;
    handleResult(ts, poseLm, handsList, motion, handLm);
    fpsTick(now);
  }

  function tickMock() {
    if (!state.running) return;
    const now = performance.now();
    tickNo += 1;
    const tl = mockTl;
    if (mockFrozen != null) mockOffset = mockFrozen - (now - mockT0); // frozen: the scripted pose is held (screenshots, tests)
    const t = now - mockT0 + mockOffset;
    const f = opts.mock.mockFrameAt(tl, t);
    const ts = Math.max(lastTs + 1, now); lastTs = ts;
    if (overlay.width !== 320) { overlay.width = 320; overlay.height = 240; }
    state.frames += 1;
    state.mockItem = f.item.name; state.mockActive = f.active;
    handleResult(ts, f.pose, tickNo % 2 === 0 ? f.hands : undefined, 0, null);
    fpsTick(now);
    if (opts.onMockTick) opts.onMockTick(f);
  }

  async function start() {
    if (state.running || state.starting) return false;
    const mine = ++seq;
    state.starting = true;
    set('starting', 'Starting the camera...');
    engine.reset();
    lastTs = 0; tickNo = 0; fpsStamp = 0; fpsCount = 0; state.fps = 0; state.frames = 0; state.lastGesture = null; state.lastConfidence = 0; errStreak = 0; prevLuma = null;
    try {
      if (opts.mock) {
        mockTl = opts.mock.buildTimeline(mockOrder || undefined); mockT0 = performance.now(); mockOffset = 0;
        state.mode = 'mock'; state.running = true; state.starting = false;
        timer = setInterval(tickMock, Math.round(1000 / maxFps));
        set('on', 'Mock camera: scripted gestures, no real camera.');
        return true;
      }
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        state.starting = false; set('error', describeCameraError('unsupported', !!window.isSecureContext && !!navigator.mediaDevices)); return false;
      }
      const assetsReady = await probeAssets();
      if (mine !== seq) return false;
      if (!assetsReady) { state.starting = false; set('error', MSG_ASSETS_MISSING); state.missing = true; return false; }
      state.missing = false;
      let requestedStream;
      try {
        requestedStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
      } catch (err) { if (mine !== seq) return false; state.starting = false; set('error', describeCameraError(err)); return false; }
      if (mine !== seq) { requestedStream.getTracks().forEach((t) => t.stop()); return false; }
      stream = requestedStream;
      video.srcObject = stream; video.muted = true; video.playsInline = true;
      for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => { if (state.running) stop('The camera was disconnected.'); });
      await video.play();
      if (mine !== seq) return false;
      state.running = true; state.starting = false; state.mode = 'motion-only';
      set('on', 'Loading gesture models...');
      raf = requestAnimationFrame(tickReal); // motion detection works while the models load
      try {
        const t0 = performance.now();
        const loaded = await (opts.visionLoader || initVision)();
        if (mine !== seq || !state.running) { closeVision(loaded); return false; }
        pose = loaded.p; gesture = loaded.g;
        state.mode = 'full'; state.delegate = loaded.delegate; state.initMs = Math.round(performance.now() - t0);
        set('on', `Gesture models ready (${loaded.delegate}, ${state.initMs} ms).`);
      } catch (err) {
        if (mine !== seq || !state.running) return true;
        state.mode = 'motion-only';
        set('on', `Gesture models could not start (${String((err && err.message) || err).slice(0, 80)}): motion-only mode.`);
      }
      return true;
    } catch (err) {
      if (mine !== seq) return false;
      state.starting = false;
      stop(null, true);
      set('error', describeCameraError(err));
      return false;
    }
  }

  function closeVision(loaded) {
    for (const model of [loaded?.p, loaded?.g]) { try { model?.close(); } catch (_) { /* best effort */ } }
  }

  function stop(reason, silent) {
    seq += 1;
    const was = state.running || state.starting;
    state.running = false; state.starting = false;
    cancelAnimationFrame(raf); clearInterval(timer); raf = 0; timer = 0;
    if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch (_) { /* ignore */ } } stream = null; }
    try { video.pause(); video.srcObject = null; } catch (_) { /* ignore */ }
    closeVision({ p: pose, g: gesture });
    pose = null; gesture = null; prevLuma = null;
    try { overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); } catch (_) { /* ignore */ }
    state.mode = 'off'; state.fps = 0;
    if (opts.onAttention) opts.onAttention(null);
    if (was && !silent) set('off', reason || 'Camera off.');
  }

  return {
    start, stop,
    get running() { return state.running; },
    get starting() { return state.starting; },
    state,
    // mock only: jump the timeline to a gesture
    mockPlay(name) {
      if (!mockTl) return false;
      const it = mockTl.items.find((x) => x.name === name);
      if (!it) return false;
      engine.reset();
      mockOffset = it.start - (performance.now() - mockT0);
      return true;
    },
    get mockTimeline() { return mockTl; },
    // mock only: hold the timeline at its current position (or release it)
    mockFreeze(on) { if (!mockTl) return false; mockFrozen = on ? (performance.now() - mockT0 + mockOffset) : null; return true; },
    // mock only: switch to another scripted order (e.g. the Copy me dance) and restart it from the top
    mockSetOrder(order) {
      mockOrder = order || null;
      if (!state.running || !opts.mock) return false;
      engine.reset();
      mockTl = opts.mock.buildTimeline(mockOrder || undefined); mockT0 = performance.now(); mockOffset = 0;
      return true;
    },
  };
}
