// "Copy me" (mimic) mode: turns timestamped MediaPipe pose landmarks plus discrete gesture events into the parameters of the
// fly's articulated rig. PURE: no DOM, no imports, no timers and no network (frames never leave the page); every time value
// comes from the `ts` you pass in (or the injected `now` clock), so it is fully testable in Node.
//
// Landmarks are the raw MediaPipe pose points: 33 of {x, y, visibility}, x to the right and y DOWN, NOT mirrored, in 0..1 image
// units. "left"/"right" in gesture events are the person's own sides as they look on the MIRRORED preview.
// Rig sides L/R are SCREEN sides of the 3D fly (L = left on screen). With `mirror` (default) the person's own left arm drives the
// fly's screen-left side, like a mirror; without it the fly faces you like another person and the sides swap.
//
// This file also holds the rig contract shared with web/fly-scene.js (ranges, defaults, clamp, blend, leg and wing geometry).

export const RIG_SPEC = {
  wingL: [0, 1, 0.45], wingR: [0, 1, 0.45],     // 0 folded back .. 0.45 straight out .. 1 straight up
  flapL: [0, 1, 0.3], flapR: [0, 1, 0.3],       // flap amplitude (0 = frozen)
  legL: [0, 1, 0], legR: [0, 1, 0],             // FRONT leg raise: 0 down .. 1 straight up
  swingL: [-1, 1, 0], swingR: [-1, 1, 0],       // forearm swing: -1 inward .. 1 outward (waving, V sign)
  curl: [0, 1, 0],                              // legs curl in (fist)
  legWiggle: [0, 1, 0.14],                      // idle wiggle of the other four legs
  roll: [-1, 1, 0],                             // +1 = screen-right side down
  pitch: [-1, 1, 0],                            // +1 = nose down
  squash: [-1, 1, 0],                           // +1 crouch (flat and wide), -1 stretch (tall and thin)
  hop: [-1, 1, 0],                              // vertical offset (+ up)
  lookX: [-1, 1, 0], lookY: [-1, 1, 0],         // head look direction (+X screen right, +Y down)
  glow: [0, 1, 0],
};
export const RIG_KEYS = Object.keys(RIG_SPEC);
export const IDLE_RIG = Object.freeze(Object.fromEntries(RIG_KEYS.map((k) => [k, RIG_SPEC[k][2]])));

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x) => clamp(x, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth01 = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };

// Always returns a full, finite, in-range rig: missing or NaN values fall back to the idle value.
export function clampRig(rig) {
  const out = {};
  for (const k of RIG_KEYS) {
    const [lo, hi, def] = RIG_SPEC[k];
    const v = rig && typeof rig[k] === 'number' && Number.isFinite(rig[k]) ? rig[k] : def;
    out[k] = clamp(v, lo, hi);
  }
  return out;
}
export function blendRig(a, b, w) {
  const t = clamp01(Number.isFinite(w) ? w : 0), out = {};
  for (const k of RIG_KEYS) out[k] = lerp(a[k], b[k], t);
  return out;
}
// One exponential smoothing step of `cur` towards `target` (dt seconds, rate 1/s). Never overshoots.
export function smoothRig(cur, target, dt, rate = 16) {
  const k = 1 - Math.exp(-Math.max(0, dt) * rate), out = {};
  for (const key of RIG_KEYS) out[key] = cur[key] + (target[key] - cur[key]) * k;
  return out;
}

// Geometry helpers the scene uses so that the maths can be tested without WebGL.
// Front leg: elevation angles (radians above the outward horizontal) of the upper and lower segment.
export function legAngles(raise, curl = 0, swing = 0) {
  const r = clamp01(raise), c = clamp01(curl), s = clamp(swing, -1, 1);
  const phi1 = lerp(0.46, 0.95, r) - 0.15 * c;
  const phi2 = lerp(-1.22, 1.4, smooth01(r * 1.15)) - s * 0.75 * (0.35 + 0.65 * r) + c * 0.95;
  return { phi1, phi2, lowerScale: 1 - 0.35 * c };
}
// Wing: sweep (rotation about the vertical axis when folded), lift (radians above horizontal), twist 0..1 (turn the wing to face the viewer) and scale.
export function wingAngles(spread) {
  const w = clamp01(spread);
  const up = w > 0.45 ? (w - 0.45) / 0.55 : 0;
  return {
    sweep: w < 0.45 ? 1.2 * (1 - w / 0.45) : 0,
    lift: w < 0.45 ? -0.15 * (w / 0.45) : -0.15 + up * 0.95,
    twist: smooth01(up / 0.7),
    scale: 0.8 + 0.35 * smooth01(w),
  };
}

// ---- settings ----
export const SENSITIVITY_DZ = { low: 1.5, normal: 1, high: 0.65 }; // dead-zone multiplier
export const DEFAULT_SETTINGS = {
  mirror: true,
  smoothness: 0.5,          // 0 snappy .. 1 very smooth
  sensitivity: 'normal',
  minVis: 0.5,              // shoulder visibility below this = no body
  calibrateMs: 1500,        // stable standing time needed to take the baseline
  calibrateBodyY: 0.035,    // max shoulder-line movement (image units) inside the calibration window
  calibrateScale: 0.14,     // max shoulder-width change (fraction) inside the window
  holdMs: 300,              // landmarks lost: keep the last pose this long ...
  lostMs: 1500,             // ... and be back at idle after this long
  fadeInMs: 400, fadeOutMs: 500,
  scaleGuard: 0.22, scaleRecalMs: 2000,
};
export const MIMIC_STATUS_TEXT = { off: '', paused: 'Paused while the fly works', calibrating: 'Calibrating: stand still', copying: 'Copying you', lost: 'No body found' };

// One Euro filter (Casiez et al.): smooth when slow, responsive when fast. Time comes from the caller.
export function createOneEuro({ minCutoff = 1.5, beta = 0.7, dCutoff = 1 } = {}) {
  let x = null, dx = 0, t = null;
  const alpha = (dt, fc) => 1 / (1 + 1 / (2 * Math.PI * fc) / dt);
  return {
    reset() { x = null; dx = 0; t = null; },
    filter(v, ts, mc = minCutoff) {
      if (x == null || t == null || ts <= t) { x = v; dx = 0; t = ts; return x; }
      const dt = (ts - t) / 1000;
      const d = (v - x) / dt;
      dx += alpha(dt, dCutoff) * (d - dx);
      const fc = mc + beta * Math.abs(dx);
      x += alpha(dt, fc) * (v - x);
      t = ts;
      return x;
    },
    get value() { return x; },
  };
}

const dz = (x, d) => { const a = Math.abs(x); return a <= d ? 0 : Math.sign(x) * Math.min(1, (a - d) / (1 - d)); };
const vis = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? (p.visibility == null ? 1 : p.visibility) : 0);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Per-frame measurements from raw landmarks (null when there is no usable body).
function measure(pose, minVis) {
  if (!Array.isArray(pose) || pose.length < 17) return null;
  const ls = pose[11], rs = pose[12];
  if (vis(ls) < minVis || vis(rs) < minVis) return null;
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (!(sw >= 0.05 && sw <= 0.7)) return null;
  const m = { sw, ls, rs, shX: (ls.x + rs.x) / 2, shY: (ls.y + rs.y) / 2, shVis: (vis(ls) + vis(rs)) / 2 };
  const hl = pose[23], hr = pose[24];
  m.hips = vis(hl) >= minVis && vis(hr) >= minVis ? { x: (hl.x + hr.x) / 2, y: (hl.y + hr.y) / 2 } : null;
  m.arms = {};
  for (const [side, si, ei, wi] of [['left', 11, 13, 15], ['right', 12, 14, 16]]) {
    const sh = pose[si], el = pose[ei], wr = pose[wi];
    const a = { wrist: null, elbow: null, h: null, he: null, alpha: null, speedPos: null };
    if (vis(wr) >= minVis) {
      a.wrist = wr;
      a.h = (sh.y - wr.y) / sw; // above the shoulder line = positive, in shoulder widths
      const vx = wr.x - sh.x, vy = wr.y - sh.y, len = Math.hypot(vx, vy);
      if (len > 0.5 * sw) a.alpha = (Math.acos(clamp(vy / len, -1, 1)) * 180) / Math.PI; // 0 = hanging, 90 = horizontal, 180 = straight up
    }
    if (vis(el) >= minVis) { a.elbow = el; a.he = (sh.y - el.y) / sw; }
    m.arms[side] = a;
  }
  const nose = pose[0], e1 = pose[7], e2 = pose[8];
  m.head = null;
  if (vis(nose) >= minVis && vis(e1) >= minVis && vis(e2) >= minVis) {
    const ed = Math.abs(e1.x - e2.x);
    if (ed > 0.02) m.head = { x: (nose.x - (e1.x + e2.x) / 2) / ed, y: (nose.y - (e1.y + e2.y) / 2) / ed };
  }
  return m;
}

export function createMimic(opts = {}) {
  const S = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (opts[k] !== undefined) S[k] = opts[k];
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let enabled = opts.enabled !== false, paused = false;
  let lastGoodTs = -Infinity, lastUpdateTs = -Infinity, lastSampleTs = null;
  let weight = 0;
  let base = null;                     // calibrated baseline { sw, shY, hipY }
  let calBuf = [];                     // calibration window
  let scaleOffSince = null;
  let conf = 0;
  let raw = clampRig(IDLE_RIG);        // latest unsmoothed target from the body
  let smoothed = clampRig(IDLE_RIG);
  let lastM = null;
  let wristPrev = { left: null, right: null }, speed = { left: 0, right: 0 };
  let overlays = [];
  const filters = Object.fromEntries(RIG_KEYS.map((k) => [k, createOneEuro({ beta: 0.7 })]));
  const dzMul = () => SENSITIVITY_DZ[S.sensitivity] || 1;
  const minCutoff = () => 5 * Math.pow(0.1, clamp01(S.smoothness));
  const flip = () => !S.mirror;
  const rigSide = (personSide) => ((personSide === 'left') !== flip() ? 'L' : 'R'); // person-left -> screen L when mirrored

  function calibrate(m, ts) {
    if (calBuf.length && ts - calBuf[calBuf.length - 1].ts > 500) calBuf = [];
    calBuf.push({ ts, shY: m.shY, hipY: m.hips ? m.hips.y : null, sw: m.sw });
    const t0 = ts - S.calibrateMs;
    // keep the window; every sample inside it must be still
    while (calBuf.length > 1 && calBuf[0].ts < t0 - 200) calBuf.shift();
    const win = calBuf.filter((s) => s.ts >= t0 - 200);
    const ys = win.map((s) => s.shY), sws = win.map((s) => s.sw);
    const still = Math.max(...ys) - Math.min(...ys) <= S.calibrateBodyY && (Math.max(...sws) - Math.min(...sws)) / median(sws) <= S.calibrateScale;
    if (!still) { calBuf = [calBuf[calBuf.length - 1]]; return; }
    if (win[win.length - 1].ts - win[0].ts >= S.calibrateMs) {
      const hips = win.map((s) => s.hipY).filter((v) => v != null);
      base = { sw: median(sws), shY: median(ys), hipY: hips.length >= win.length * 0.8 ? median(hips) : null };
      calBuf = [];
    }
  }

  function bodyRig(m, ts) {
    const r = clampRig(IDLE_RIG);
    const k = dzMul();
    const sideKey = (personSide) => rigSide(personSide);
    // arms -> front legs and wings
    const wingRaw = {};
    for (const side of ['left', 'right']) {
      const a = m.arms[side];
      const S2 = sideKey(side);
      if (a.h != null) {
        const hEff = a.he != null ? 0.75 * a.h + 0.25 * a.he : a.h;
        r['leg' + S2] = dz(clamp01((hEff + 1.1) / 1.7), 0.12 * k);
      }
      if (a.alpha != null) {
        const lo = 28 * k, hi = 165;
        wingRaw[S2] = a.alpha <= lo ? 0 : a.alpha <= 90 ? 0.5 * (a.alpha - lo) / (90 - lo) : 0.5 + 0.5 * clamp01((a.alpha - 90) / (hi - 90));
      }
      // arm speed drives how hard that wing flaps
      const w = a.wrist;
      if (w && wristPrev[side] && ts > wristPrev[side].ts) {
        const v = Math.hypot(w.x - wristPrev[side].x, w.y - wristPrev[side].y) / m.sw / ((ts - wristPrev[side].ts) / 1000);
        speed[side] += (Math.min(v, 6) - speed[side]) * 0.4;
      } else if (!w) speed[side] *= 0.8;
      wristPrev[side] = w ? { x: w.x, y: w.y, ts } : null;
      r['flap' + S2] = 0.1 + 0.7 * clamp01((speed[side] - 0.5) / 2.5);
    }
    const wv = Object.values(wingRaw);
    if (wv.length) {
      const both = Math.min(...wv); // the weaker arm decides, so ONE raised hand moves a leg, not the wings
      for (const s of ['L', 'R']) r['wing' + s] = lerp(both, wingRaw[s] != null ? wingRaw[s] : both, 0.3);
    } else { r.wingL = r.wingR = 0.05; }
    for (const s of ['L', 'R']) r['wing' + s] = Math.max(0.05, r['wing' + s]);
    // lean: shoulder-line tilt and torso offset. Positive person roll = the person's right side lower / leaning to their right.
    const tilt = (m.rs.y - m.ls.y) / m.sw;
    const lean = m.hips ? (m.hips.x - m.shX) / m.sw : 0;
    const rollP = clamp(0.65 * (tilt / 0.45) + 0.45 * (lean / 0.7), -1, 1);
    r.roll = dz(rollP, 0.1 * k) * (S.mirror ? 1 : -1);
    // head
    if (m.head) {
      const lx = dz(clamp(-m.head.x / 0.4, -1, 1), 0.3 * k) * (S.mirror ? 1 : -1);
      r.lookX = lx; r.lookY = dz(clamp(m.head.y / 0.6, -1, 1), 0.4 * k);
    }
    // vertical body motion against the calibrated standing baseline
    let guard = false;
    if (base) {
      const ratio = m.sw / base.sw;
      r.pitch = dz(clamp((ratio - 1) / 0.3, -1, 1), 0.25 * k);
      if (Math.abs(ratio - 1) > S.scaleGuard) {
        guard = true;
        if (scaleOffSince == null) scaleOffSince = ts;
        if (ts - scaleOffSince >= S.scaleRecalMs) { base = null; calBuf = []; scaleOffSince = null; }
      } else {
        scaleOffSince = null;
        const dSh = (m.shY - base.shY) / base.sw;
        const dHip = m.hips && base.hipY != null ? (m.hips.y - base.hipY) / base.sw : null;
        const drop = dHip != null ? (dSh + dHip) / 2 : dSh; // + = lower than standing
        const crouch = dz(clamp01(drop / 0.6), 0.2 * k);
        const rise = dz(clamp01(-drop / 0.5), 0.12 * k);
        r.squash = crouch - 0.6 * rise;
        r.hop = rise - 0.4 * crouch;
      }
    }
    return { rig: r, guard };
  }

  // timed envelopes for the discrete gestures: { set: {key: [value, env]}, add: {key: value} }
  function overlayEval(ov, age) {
    const set = {}, add = {};
    const fadeOut = (dur, tail) => clamp01((dur - age) / tail);
    const fadeIn = (t) => clamp01(age / t);
    const sideKey = ov.rs;
    switch (ov.name) {
      case 'clap': {
        const env = age < 0.9 ? 1 : fadeOut(1.4, 0.5);
        const v = age < 0.25 ? 0 : 1;
        set.wingL = [v, env]; set.wingR = [v, env]; set.flapL = [0.9, env]; set.flapR = [0.9, env];
        break;
      }
      case 'wave': {
        const env = Math.min(fadeIn(0.2), fadeOut(2.2, 0.4));
        set['leg' + sideKey] = [0.92, env];
        set['swing' + sideKey] = [0.9 * Math.sin(2 * Math.PI * 3.5 * age), env];
        break;
      }
      case 'thumbs_up': {
        const env = Math.min(fadeIn(0.15), fadeOut(1.5, 0.4));
        set['leg' + sideKey] = [1, env];
        set['swing' + sideKey] = [0, env];
        set.glow = [Math.max(0, 1 - age / 0.8), 1];
        break;
      }
      case 'peace': {
        const env = Math.min(fadeIn(0.15), fadeOut(1.8, 0.4));
        for (const s of ['L', 'R']) { set['leg' + s] = [0.85, env]; set['swing' + s] = [0.85, env]; }
        break;
      }
      case 'fist': {
        const env = Math.min(fadeIn(0.1), fadeOut(1.4, 0.4));
        set.curl = [1, env];
        add.roll = 0.2 * Math.sin(2 * Math.PI * 8 * age) * Math.exp(-age * 2.5);
        break;
      }
      case 'open_palm': {
        const env = Math.min(fadeIn(0.2), fadeOut(1.8, 0.4));
        set.wingL = [0.55, env]; set.wingR = [0.55, env]; set.flapL = [0, env]; set.flapR = [0, env];
        break;
      }
      case 'point_up': {
        add.hop = 0.55 * Math.sin(Math.PI * clamp01(age / 1.5));
        add.pitch = -0.35 * Math.sin(Math.PI * clamp01(age / 1.5));
        break;
      }
      case 'jump': {
        add.hop = 0.8 * Math.sin(Math.PI * clamp01(age / 0.7));
        set.squash = [-0.6, Math.sin(Math.PI * clamp01(age / 0.7))];
        break;
      }
      case 'startled': { // replaces the fly's "startled" reaction while Copy me is on
        const env = clamp01((0.5 - age) / 0.3 + 1);
        add.hop = 0.7 * Math.exp(-age * 4) * clamp01(age / 0.06);
        set.wingL = [1, env]; set.wingR = [1, env]; set.flapL = [0.9, env]; set.flapR = [0.9, env];
        set.glow = [Math.max(0, 1 - age / 0.5), 1];
        break;
      }
      case 'happy': { // replaces the fly's "happy" reaction
        const env = Math.sin(Math.PI * clamp01(age / 1.5));
        add.hop = 0.45 * Math.abs(Math.sin(age * 9)) * env;
        for (const s of ['L', 'R']) { set['leg' + s] = [0.9, env]; set['swing' + s] = [0.7 * Math.sin(age * 14), env]; }
        break;
      }
      case 'lean_left': case 'lean_right': { // replaces the "lean" reaction: the body rolls instead of sliding
        const env = Math.min(1, Math.sin(Math.PI * clamp01(age / 1.2)) * 1.6);
        set.roll = [sideKey === 'L' ? -0.75 : 0.75, env];
        break;
      }
      default: break;
    }
    return { set, add };
  }
  const DURATION = { clap: 1.4, wave: 2.2, thumbs_up: 1.5, peace: 1.8, fist: 1.4, open_palm: 1.8, point_up: 1.5, jump: 0.7, startled: 0.9, happy: 1.5, lean_left: 1.2, lean_right: 1.2 };

  function update(frame = {}) {
    const ts = frame.ts != null ? frame.ts : now();
    lastUpdateTs = ts;
    if (!enabled) return sample(ts);
    const m = measure(frame.pose, S.minVis);
    if (!m) { lastM = null; return sample(ts); }
    lastGoodTs = ts;
    lastM = m;
    conf = clamp01((m.shVis - S.minVis) / (0.85 - S.minVis));
    if (!base) calibrate(m, ts);
    const br = bodyRig(m, ts);
    raw = clampRig(br.rig);
    const mc = minCutoff();
    const next = {};
    for (const k of RIG_KEYS) next[k] = filters[k].filter(raw[k], ts, mc);
    smoothed = clampRig(next);
    return sample(ts);
  }

  function lostFactor(ts) {
    const age = ts - lastGoodTs;
    if (!(age > S.holdMs)) return 0;
    return clamp01((age - S.holdMs) / Math.max(1, S.lostMs - S.holdMs));
  }

  function statusAt(ts) {
    if (!enabled) return 'off';
    if (paused) return 'paused';
    if (ts - lastGoodTs > 500) return 'lost';
    return base ? 'copying' : 'calibrating';
  }

  function sample(ts = now()) {
    const dtMs = lastSampleTs == null ? 0 : Math.max(0, ts - lastSampleTs);
    lastSampleTs = ts;
    const d = lostFactor(ts);
    // rig: held pose -> idle as the loss factor grows, then the gesture envelopes on top
    let rig = blendRig(smoothed, IDLE_RIG, d);
    overlays = overlays.filter((o) => (ts - o.t0) / 1000 < DURATION[o.name]);
    for (const o of overlays) {
      const { set, add } = overlayEval(o, Math.max(0, (ts - o.t0) / 1000));
      for (const [key, [v, env]] of Object.entries(set)) if (key in rig) rig[key] = lerp(rig[key], v, clamp01(env));
      for (const [key, v] of Object.entries(add)) if (key in rig) rig[key] += v;
    }
    rig = clampRig(rig);
    const target = enabled && !paused ? clamp01(conf) * (1 - d) : 0;
    const step = dtMs / (target >= weight ? S.fadeInMs : S.fadeOutMs);
    weight = target >= weight ? Math.min(target, weight + step) : Math.max(target, weight - step);
    const status = statusAt(ts);
    return { rig, weight, status, statusText: MIMIC_STATUS_TEXT[status], calibrated: !!base, confidence: conf, lost: d };
  }

  return {
    update,
    sample,
    gesture(ev) {
      if (!ev || !DURATION[ev.name] || !enabled) return false;
      const ts = ev.ts != null ? ev.ts : now();
      let rs;
      const evSide = ev.side || (ev.name === 'lean_left' ? 'left' : ev.name === 'lean_right' ? 'right' : null);
      if (evSide === 'left' || evSide === 'right') rs = rigSide(evSide);
      else rs = smoothed.legL > smoothed.legR + 0.05 ? 'L' : 'R'; // no side given (hand labels): the arm that is higher
      overlays = overlays.filter((o) => o.name !== ev.name);
      overlays.push({ name: ev.name, t0: ts, rs });
      return true;
    },
    recalibrate() { base = null; calBuf = []; scaleOffSince = null; },
    setMirror(b) { S.mirror = !!b; },
    setSmoothness(v) { S.smoothness = clamp01(Number(v)); },
    setSensitivity(s) { if (SENSITIVITY_DZ[s]) S.sensitivity = s; },
    setEnabled(b) {
      const was = enabled; enabled = !!b;
      if (enabled && !was) { base = null; calBuf = []; lastGoodTs = -Infinity; raw = clampRig(IDLE_RIG); smoothed = clampRig(IDLE_RIG); for (const k of RIG_KEYS) filters[k].reset(); overlays = []; weight = 0; lastSampleTs = null; }
    },
    setPaused(b) { paused = !!b; },
    get settings() { return { ...S }; },
    get calibrated() { return !!base; },
    get baseline() { return base ? { ...base } : null; },
    get enabled() { return enabled; },
    get paused() { return paused; },
    debug() { return { raw: { ...raw }, smoothed: { ...smoothed }, weight, base, conf, status: statusAt(lastSampleTs == null ? now() : lastSampleTs), lastGoodTs, overlays: overlays.map((o) => o.name) }; },
  };
}
