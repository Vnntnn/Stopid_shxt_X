// Gesture classifier for the Fly Ask camera (PURE: no DOM, no imports, runs in Node for the tests).
//
// Input per frame: update({ ts, pose, hands, motion })
//   ts      ms, monotonic
//   pose    array of MediaPipe 33-point pose landmarks {x, y, visibility?} in NORMALISED RAW camera coordinates
//           (x to the right, y DOWN, as the unmirrored camera image), or null when no person is found
//   hands   undefined = no new hand result this frame; [] = hand model ran and saw nothing;
//           [{label, score, side?}] = Gesture Recognizer labels ("Thumb_Up", "Victory", ...)
//   motion  frame-difference energy 0..1 (fraction of changed pixels), optional
// Output: array of discrete events { name, confidence, ts, side?, source? }.
// "side" is the person's own side as it appears in the MIRRORED preview ('left' = left on screen).
//
// Geometry is normalised by shoulder width (sw) so thresholds do not depend on how far the user sits.
// Every threshold is a [low, normal, high] triple: "low" sensitivity = harder to trigger.

export const SENSITIVITIES = ['low', 'normal', 'high'];
export const BODY_GESTURES = ['wave', 'hands_up', 'hand_up_left', 'hand_up_right', 't_pose', 'clap', 'lean_left', 'lean_right', 'jump', 'squat', 'belly_rub'];
export const HAND_GESTURES = ['thumbs_up', 'thumbs_down', 'peace', 'open_palm', 'fist', 'point_up', 'i_love_you'];
export const GESTURES = [...BODY_GESTURES, ...HAND_GESTURES];
export const HAND_LABELS = { Thumb_Up: 'thumbs_up', Thumb_Down: 'thumbs_down', Victory: 'peace', Open_Palm: 'open_palm', Closed_Fist: 'fist', Pointing_Up: 'point_up', ILoveYou: 'i_love_you' };
export const GESTURE_TITLES = {
  wave: 'Wave', hands_up: 'Both hands up', hand_up_left: 'Left hand up', hand_up_right: 'Right hand up', t_pose: 'T-pose', clap: 'Clap',
  lean_left: 'Lean left', lean_right: 'Lean right', jump: 'Jump', squat: 'Squat', belly_rub: 'Belly rub',
  thumbs_up: 'Thumbs up', thumbs_down: 'Thumbs down', peace: 'Peace', open_palm: 'Open palm', fist: 'Fist', point_up: 'Point up', i_love_you: 'I love you',
};

export const POSE = { NOSE: 0, L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16, L_HIP: 23, R_HIP: 24 };

// ---- Threshold table: [low, normal, high]. Distances are in shoulder widths (sw), times in ms. ----
export const THRESHOLDS = {
  wave: {
    swing: [0.35, 0.25, 0.18],          // min sideways stroke of the wrist
    reversals: [4, 3, 2],               // direction changes inside the window (3 = about two full strokes back and forth)
    windowMs: [1400, 1400, 1400],
    aboveShoulder: [-0.15, 0.0, 0.2],   // wrist must be above shoulder line by this (negative = well above); positive allows below
    cooldownMs: [2200, 2000, 1600],
  },
  hands_up: {
    margin: [0.4, 0.2, 0.0],            // both wrists above the nose by this
    holdMs: [400, 250, 150],
    cooldownMs: [2200, 2000, 1500],
  },
  hand_up: {                            // hand_up_left / hand_up_right
    margin: [0.4, 0.2, 0.05],           // wrist above the nose by this, other wrist NOT above the nose
    holdMs: [500, 350, 250],
    steadyMax: [0.15, 0.2, 0.25],       // max sideways range during the hold (more than that is a wave)
    cooldownMs: [2200, 2000, 1500],
  },
  t_pose: {
    spanMin: [3.6, 3.0, 2.5],           // wrist to wrist distance
    heightTol: [0.3, 0.4, 0.55],        // wrists within this vertical distance of the shoulder line
    holdMs: [800, 600, 400],
    cooldownMs: [3000, 2500, 2000],
  },
  clap: {
    apart: [1.0, 0.8, 0.6],             // wrists must first be at least this far apart
    together: [0.25, 0.35, 0.45],       // ... then closer than this (a "meeting")
    meetings: [3, 2, 2],                // meetings inside the window
    windowMs: [1800, 1800, 1800],
    cooldownMs: [1800, 1500, 1200],
  },
  lean: {                               // lean_left / lean_right
    offset: [0.6, 0.45, 0.3],           // nose offset from the shoulder centre
    holdMs: [500, 350, 250],
    rearm: [0.5, 0.5, 0.5],             // fraction of offset the nose must come back to
    cooldownMs: [1500, 1200, 900],
  },
  jump: {
    rise: [0.45, 0.3, 0.2],             // upward displacement of the upper body inside the window
    speed: [2.2, 1.6, 1.1],             // peak upward speed, sw per second
    windowMs: [450, 450, 450],
    scaleTol: [0.2, 0.2, 0.25],         // shoulder width may change by this much (leaning into the camera is not a jump)
    cooldownMs: [1800, 1500, 1200],
  },
  squat: {
    drop: [0.9, 0.65, 0.45],            // upper body below the standing level by this
    holdMs: [350, 250, 150],
    scaleTol: [0.2, 0.2, 0.25],
    cooldownMs: [3000, 2500, 2000],
  },
  belly_rub: {                          // one wrist circling / rubbing inside the lower-torso box
    windowMs: [900, 700, 600],          // sustained motion needed (>= ~0.6 s at normal)
    swing: [0.35, 0.25, 0.19],          // min stroke between direction changes, in sw (never below MIN_ABS image units)
    reversals: [3, 2, 2],               // direction changes on the busier axis (a full circle gives 2 per axis)
    pathMin: [1.0, 0.6, 0.4],           // total hand path inside the window, in sw (a hand resting still travels about 0)
    cooldownMs: [3500, 3000, 2500],
  },
  hand: {                               // all hand-label gestures
    minScore: [0.75, 0.6, 0.45],        // Gesture Recognizer confidence
    holdMs: [500, 350, 200],
    palmHoldMs: [1000, 800, 600],       // open_palm needs longer: a waving hand is an open palm
    cooldownMs: [2000, 1500, 1200],
  },
  motion: {                             // no-pose fallback: sustained frame-difference energy emits "wave"
    energy: [0.08, 0.05, 0.03],
    holdMs: [700, 500, 400],
    cooldownMs: [3000, 2500, 2000],
  },
};
export const MIN_ABS = 0.03;            // absolute floor (normalised image units) for any stroke/rise: stops landmark jitter
export const SHOULDER_RANGE = [0.06, 0.65]; // shoulder width (image units) accepted as "a person at a sensible distance"

export function thresholds(sensitivity = 'normal') {
  const i = Math.max(0, SENSITIVITIES.indexOf(sensitivity));
  const out = {};
  for (const [g, params] of Object.entries(THRESHOLDS)) { out[g] = {}; for (const [k, v] of Object.entries(params)) out[g][k] = v[i]; }
  return out;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const conf = (margin, base = 0.55) => Math.round((base + (1 - base) * clamp01(margin)) * 100) / 100;
function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Count direction reversals of a 1-D trace where each stroke is at least `minSwing` (first stroke is not a reversal).
export function countReversals(values, minSwing) {
  if (!values.length) return { count: 0, swing: 0 };
  let lo = values[0], hi = values[0], dir = 0, pivot = values[0], count = 0, strokeStart = values[0], swingSum = 0, strokes = 0;
  for (const v of values) {
    if (dir === 0) {
      if (v < lo) lo = v; if (v > hi) hi = v;
      if (v - lo >= minSwing) { dir = 1; pivot = v; strokeStart = lo; } else if (hi - v >= minSwing) { dir = -1; pivot = v; strokeStart = hi; }
    } else if (dir === 1) {
      if (v > pivot) pivot = v;
      else if (pivot - v >= minSwing) { swingSum += pivot - strokeStart; strokes++; count++; dir = -1; strokeStart = pivot; pivot = v; }
    } else {
      if (v < pivot) pivot = v;
      else if (v - pivot >= minSwing) { swingSum += strokeStart - pivot; strokes++; count++; dir = 1; strokeStart = pivot; pivot = v; }
    }
  }
  return { count, swing: strokes ? swingSum / strokes : 0 };
}
const smooth3 = (a) => a.map((_, i) => { const s = a.slice(Math.max(0, i - 1), i + 2); return s.reduce((p, c) => p + c, 0) / s.length; });

// ---- Motion energy (frame difference), pure so it can be tested ----
export function rgbaToLuma(rgba, out) {
  const n = rgba.length >> 2;
  const dst = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) dst[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return dst;
}
export function frameDiffEnergy(prev, cur, pixelThreshold = 24) {
  if (!prev || !cur || prev.length !== cur.length || !cur.length) return 0;
  let changed = 0;
  for (let i = 0; i < cur.length; i++) if (Math.abs(cur[i] - prev[i]) > pixelThreshold) changed++;
  return changed / cur.length;
}

// ---- Frame metrics ----
const vis = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility == null || p.visibility >= 0.4);
function metricsOf(pose) {
  if (!Array.isArray(pose) || pose.length < 25) return null;
  const nose = pose[POSE.NOSE], ls = pose[POSE.L_SH], rs = pose[POSE.R_SH];
  if (!vis(nose) || !vis(ls) || !vis(rs)) return null;
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (sw < SHOULDER_RANGE[0] || sw > SHOULDER_RANGE[1]) return null;
  const dirSign = ls.x >= rs.x ? 1 : -1; // person's left is at larger x when facing the camera
  const w = (i) => (vis(pose[i]) ? pose[i] : null);
  const shY = (ls.y + rs.y) / 2;
  const lh = w(POSE.L_HIP), rh = w(POSE.R_HIP);
  // Hips are often out of frame: estimate them from the shoulders (torso is about 1.5 shoulder widths long).
  const hipY = lh && rh ? (lh.y + rh.y) / 2 : shY + 1.5 * sw;
  return { hipY, sw, nose, ls, rs, shX: (ls.x + rs.x) / 2, shY, dirSign, lw: w(POSE.L_WR), rw: w(POSE.R_WR), le: w(POSE.L_EL), re: w(POSE.R_EL), bodyY: (shY * 2 + nose.y) / 3 };
}

export function createGestureEngine(opts = {}) {
  let sens = SENSITIVITIES.includes(opts.sensitivity) ? opts.sensitivity : 'normal';
  let T = thresholds(sens);
  let enabled = opts.enabled ? new Set(opts.enabled) : null; // null = all
  const extraHold = {};
  const frames = [];                       // {ts, m}
  const st = {};                           // per-gesture state
  const S = (n) => (st[n] || (st[n] = { last: -Infinity, armed: true, since: null, seen: -Infinity }));
  let lastPoseTs = -Infinity;
  let waveActiveUntil = -Infinity;
  let suppress = {};                       // name -> until ts
  let clapPhase = 'unknown'; let meetings = [];
  let handHold = { name: null, since: 0, seen: 0, side: undefined, score: 0 };
  let handAbsentSince = null;
  let lastHandsTs = -Infinity;
  const handArmed = {};
  const motionState = { since: null, armed: true };

  const holdFor = (name, base) => Math.max(base, extraHold[name] || 0);
  const isOn = (n) => !enabled || enabled.has(n);

  function emit(out, name, confidence, ts, side, cooldown, extra) {
    const s = S(name);
    if (!isOn(name) || !s.armed || (suppress[name] || -Infinity) > ts) return false;
    if (ts - s.last < cooldown) { s.armed = false; return false; } // an attempt inside the cooldown is consumed: leave and come back to retrigger
    s.last = ts; s.armed = false;
    const ev = { name, confidence, ts };
    if (side) ev.side = side;
    if (s.heldFor != null) { ev.heldMs = Math.round(s.heldFor); s.heldFor = null; }
    if (extra) Object.assign(ev, extra);
    out.push(ev);
    return true;
  }
  function held(name, cond, ts, ms) { // true once `cond` has been continuously true for ms
    const s = S(name);
    if (!cond) { s.since = null; return false; }
    if (s.since == null) s.since = ts;
    s.heldFor = ts - s.since;
    return ts - s.since >= ms;
  }
  const recent = (ts, ms) => { const a = []; for (let i = frames.length - 1; i >= 0 && ts - frames[i].ts <= ms; i--) a.push(frames[i]); return a.reverse(); };
  const between = (ts, fromMs, toMs) => frames.filter((f) => ts - f.ts <= fromMs && ts - f.ts >= toMs);

  function waveSide(ts, which, window, swingMin, aboveMargin) {
    const win = recent(ts, window).filter((f) => f.m);
    if (win.length < 6 || win[win.length - 1].ts - win[0].ts < window * 0.6) return null;
    const pts = win.map((f) => ({ w: f.m[which], m: f.m })).filter((p) => p.w);
    if (pts.length < win.length * 0.7) return null;
    const above = pts.filter((p) => p.w.y < p.m.shY + aboveMargin * p.m.sw).length / pts.length;
    if (above < 0.8) return null;
    const sw = median(pts.map((p) => p.m.sw));
    const xs = smooth3(pts.map((p) => p.w.x));
    const r = countReversals(xs, Math.max(MIN_ABS, swingMin * sw));
    return { reversals: r.count, swing: r.swing / sw };
  }

  function update(input) {
    const { ts, pose, hands, motion } = input;
    const out = [];
    if (!Number.isFinite(ts)) return out;
    const m = metricsOf(pose);
    if (frames.length && ts < frames[frames.length - 1].ts) frames.length = 0; // clock went backwards: start over
    frames.push({ ts, m });
    while (frames.length && ts - frames[0].ts > 4000) frames.shift();
    if (m) lastPoseTs = ts;
    for (const k of Object.keys(suppress)) if (suppress[k] <= ts) delete suppress[k];

    if (m) {
      const sw = m.sw;
      // ----- wave (either hand) -----
      const tw = T.wave;
      let waveEv = false;
      for (const [which, side] of [['lw', 'left'], ['rw', 'right']]) {
        const r = waveSide(ts, which, tw.windowMs, tw.swing, tw.aboveShoulder);
        const loose = waveSide(ts, which, 800, tw.swing * 0.6, tw.aboveShoulder + 0.3);
        if (loose && loose.reversals >= 1) waveActiveUntil = Math.max(waveActiveUntil, ts + 700);
        if (r && r.reversals >= tw.reversals) {
          const c = conf(0.3 + 0.25 * (r.reversals - tw.reversals) + (r.swing / tw.swing - 1) * 0.5);
          if (emit(out, 'wave', c, ts, side, tw.cooldownMs)) { waveEv = true; waveActiveUntil = ts + 900; }
        }
        // wave re-arms only after the oscillation has stopped
      }
      if (!waveEv && ts > waveActiveUntil) S('wave').armed = true;

      // ----- hands up / one hand up -----
      const nose = m.nose.y;
      const up = (w, margin) => !!w && w.y < nose - margin * sw;
      const hu = T.hands_up;
      const both = up(m.lw, hu.margin) && up(m.rw, hu.margin);
      const bothLoose = up(m.lw, 0) && up(m.rw, 0);
      if (held('hands_up', both, ts, holdFor('hands_up', hu.holdMs))) {
        const margin = Math.min(m.lw ? (nose - m.lw.y) / sw : 0, m.rw ? (nose - m.rw.y) / sw : 0);
        if (emit(out, 'hands_up', conf(margin / 0.8), ts, null, hu.cooldownMs)) { suppress.hand_up_left = ts + 1000; suppress.hand_up_right = ts + 1000; }
      }
      if (!bothLoose) S('hands_up').armed = true;

      const hd = T.hand_up;
      for (const [which, other, name, side] of [['lw', 'rw', 'hand_up_left', 'left'], ['rw', 'lw', 'hand_up_right', 'right']]) {
        const w = m[which];
        const cond = up(w, hd.margin) && !up(m[other], 0) && ts > waveActiveUntil;
        if (held(name, cond, ts, holdFor(name, hd.holdMs))) {
          const win = recent(ts, hd.holdMs).filter((f) => f.m && f.m[which]).map((f) => f.m[which].x);
          const range = win.length ? (Math.max(...win) - Math.min(...win)) / sw : 1;
          if (range <= hd.steadyMax && emit(out, name, conf((nose - w.y) / sw / 0.8), ts, side, hd.cooldownMs)) { /* fired */ }
        }
        if (!up(w, 0)) S(name).armed = true;
      }

      // ----- T-pose -----
      const tp = T.t_pose;
      let tCond = false, span = 0;
      if (m.lw && m.rw) {
        span = Math.hypot(m.lw.x - m.rw.x, m.lw.y - m.rw.y) / sw;
        const outward = (m.lw.x - m.ls.x) * m.dirSign >= 0.8 * sw && (m.rs.x - m.rw.x) * m.dirSign >= 0.8 * sw;
        tCond = span >= tp.spanMin && outward && Math.abs(m.lw.y - m.shY) <= tp.heightTol * sw && Math.abs(m.rw.y - m.shY) <= tp.heightTol * sw;
      }
      if (held('t_pose', tCond, ts, holdFor('t_pose', tp.holdMs))) emit(out, 't_pose', conf((span / tp.spanMin - 1) * 2), ts, null, tp.cooldownMs);
      if (span < tp.spanMin * 0.8 || !m.lw || !m.rw) S('t_pose').armed = true;

      // ----- clap -----
      const cp = T.clap;
      if (m.lw && m.rw) {
        const d = Math.hypot(m.lw.x - m.rw.x, m.lw.y - m.rw.y) / sw;
        if (d >= cp.apart) clapPhase = 'apart';
        else if (d <= cp.together && clapPhase === 'apart') { clapPhase = 'together'; meetings.push(ts); }
        meetings = meetings.filter((t) => ts - t <= cp.windowMs);
        if (meetings.length >= cp.meetings) {
          if (emit(out, 'clap', conf(0.4 + 0.3 * (meetings.length - cp.meetings)), ts, null, cp.cooldownMs)) meetings = [];
        }
        if (d >= cp.apart) S('clap').armed = true;
      } else { clapPhase = 'unknown'; meetings = []; }

      // ----- lean -----
      const ln = T.lean;
      const offset = ((m.nose.x - m.shX) * m.dirSign) / sw; // > 0 : towards the person's left = left on the mirrored preview
      for (const [name, side, val] of [['lean_left', 'left', offset], ['lean_right', 'right', -offset]]) {
        if (held(name, val >= ln.offset, ts, holdFor(name, ln.holdMs))) emit(out, name, conf((val / ln.offset - 1) * 1.5), ts, side, ln.cooldownMs);
        if (val < ln.offset * ln.rearm) S(name).armed = true;
      }

      // ----- belly rub: one wrist circling/oscillating on the lower torso (coordinates relative to the shoulder midpoint) -----
      const br = T.belly_rub;
      {
        const win = recent(ts, br.windowMs).filter((f) => f.m);
        const okWin = win.length >= 6 && win[win.length - 1].ts - win[0].ts >= br.windowMs * 0.85;
        let best = null;
        if (okWin) {
          for (const [which, other, side] of [['lw', 'rw', 'left'], ['rw', 'lw', 'right']]) {
            const inBox = (f, w) => {
              if (!w) return false;
              const half = f.m.sw / 2 + 0.1 * f.m.sw, midY = (f.m.shY + f.m.hipY) / 2;
              return Math.abs(w.x - f.m.shX) <= half && w.y >= midY && w.y <= f.m.hipY + 0.2 * f.m.sw;
            };
            const mine = win.filter((f) => f.m[which]);
            if (mine.length < win.length * 0.9) continue;
            if (mine.filter((f) => inBox(f, f.m[which])).length < mine.length * 0.85) continue;
            // exactly one wrist: if the other one is in the box too, or right next to this one, it is a clap / a two-handed thing
            if (win.filter((f) => inBox(f, f.m[other]) || (f.m[other] && f.m[which] && Math.hypot(f.m[other].x - f.m[which].x, f.m[other].y - f.m[which].y) < 0.3 * f.m.sw)).length > win.length * 0.2) continue;
            const rx = smooth3(mine.map((f) => (f.m[which].x - f.m.shX) / f.m.sw)), ry = smooth3(mine.map((f) => (f.m[which].y - f.m.shY) / f.m.sw));
            const sw0 = median(mine.map((f) => f.m.sw));
            const minSwing = Math.max(br.swing, MIN_ABS / sw0);
            const cx = countReversals(rx, minSwing), cy = countReversals(ry, minSwing);
            let path = 0;
            for (let i = 1; i < rx.length; i++) path += Math.hypot(rx[i] - rx[i - 1], ry[i] - ry[i - 1]);
            const revs = Math.max(cx.count, cy.count);
            if (revs >= br.reversals && path >= br.pathMin && (!best || path > best.path)) best = { side, path, revs };
          }
        }
        if (best) emit(out, 'belly_rub', conf(0.3 + 0.2 * (best.revs - br.reversals) + (best.path / br.pathMin - 1) * 0.3), ts, best.side, br.cooldownMs);
        else if (okWin) {
          // re-arm once the rubbing has stopped (the hand rests, leaves the box or moves away)
          const last = recent(ts, 500).filter((f) => f.m);
          let still = true;
          for (const which of ['lw', 'rw']) { const ps = last.map((f) => f.m[which]).filter(Boolean); if (ps.length > 3) { let pl = 0; for (let i = 1; i < ps.length; i++) pl += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y); if (pl / (last[0].m.sw) > 0.25) still = false; } }
          if (still) S('belly_rub').armed = true;
        }
      }

      // ----- jump -----
      const jp = T.jump;
      const rec = recent(ts, jp.windowMs).filter((f) => f.m);
      const ref = between(ts, 1800, 600).filter((f) => f.m);
      if (rec.length >= 4 && ref.length >= 4) {
        const refY = median(ref.map((f) => f.m.bodyY)), refSw = median(ref.map((f) => f.m.sw));
        const minY = Math.min(...rec.map((f) => f.m.bodyY));
        const rise = (refY - minY) / sw;
        const scale = Math.abs(sw / refSw - 1);
        let speed = 0;
        for (let i = 2; i < rec.length; i++) { const dt = (rec[i].ts - rec[i - 2].ts) / 1000; if (dt > 0) speed = Math.max(speed, ((rec[i - 2].m.bodyY - rec[i].m.bodyY) / sw) / dt); }
        if (rise >= jp.rise && refY - minY >= MIN_ABS && speed >= jp.speed && scale <= jp.scaleTol) {
          if (emit(out, 'jump', conf((rise / jp.rise - 1) * 1.2), ts, null, jp.cooldownMs)) suppress.squat = ts + 1200;
        }
        if (rise < jp.rise * 0.3) S('jump').armed = true;
      }

      // ----- squat -----
      const sq = T.squat;
      const sref = between(ts, 3200, 1400).filter((f) => f.m);
      const cur = recent(ts, sq.holdMs).filter((f) => f.m);
      if (sref.length >= 5 && cur.length >= 2 && cur[cur.length - 1].ts - cur[0].ts >= sq.holdMs * 0.6) {
        const refY = median(sref.map((f) => f.m.bodyY)), refSw = median(sref.map((f) => f.m.sw));
        const drops = cur.map((f) => (f.m.bodyY - refY) / sw);
        const minDrop = Math.min(...drops);
        const scale = Math.abs(sw / refSw - 1);
        if (minDrop >= sq.drop * 0.85 && minDrop * sw >= MIN_ABS && scale <= sq.scaleTol) emit(out, 'squat', conf((minDrop / sq.drop - 1) * 1.5), ts, null, sq.cooldownMs);
        if (median(drops) < sq.drop * 0.35) S('squat').armed = true;
      }
      if (!S('squat').armed) suppress.jump = ts + 2000; // standing up from a squat is not a jump
    }

    // ----- hand-label gestures -----
    if (hands !== undefined) {
      lastHandsTs = ts;
      const hp = T.hand;
      let best = null;
      for (const h of Array.isArray(hands) ? hands : []) {
        const name = HAND_LABELS[h && h.label];
        if (!name || !(h.score >= hp.minScore)) continue;
        if (name === 'open_palm' && ts < waveActiveUntil) continue; // a waving hand is an open palm: not a gesture of its own
        if (!best || h.score > best.score) best = { name, score: h.score, side: h.side };
      }
      if (best) {
        handAbsentSince = null;
        if (handHold.name === best.name && ts - handHold.seen <= 400) { handHold.seen = ts; handHold.score = Math.max(handHold.score * 0.7 + best.score * 0.3, 0); }
        else handHold = { name: best.name, since: ts, seen: ts, side: best.side, score: best.score };
        const base = best.name === 'open_palm' ? hp.palmHoldMs : hp.holdMs; // an open palm is also what a waving hand looks like: wait longer
        if (ts - handHold.since >= holdFor(best.name, base) && (handArmed[best.name] !== false)) {
          const s = S(best.name);
          s.armed = true; s.heldFor = ts - handHold.since;
          if (emit(out, best.name, conf((handHold.score - hp.minScore) / (1 - hp.minScore) * 0.9 + 0.1, 0.5), ts, best.side, hp.cooldownMs)) handArmed[best.name] = false;
          else if (!S(best.name).armed) handArmed[best.name] = false; // blocked by the cooldown: consumed
        }
      } else {
        if (handAbsentSince == null) handAbsentSince = ts;
        if (ts - handAbsentSince >= 400) { for (const n of HAND_GESTURES) handArmed[n] = true; handHold = { name: null, since: 0, seen: 0 }; }
        else if (handHold.name && ts - handHold.seen > 400) handHold = { name: null, since: 0, seen: 0 };
      }
    }

    // ----- motion-only fallback (no pose for a while) -----
    if (Number.isFinite(motion) && ts - lastPoseTs > 1000) {
      const mo = T.motion;
      if (motion >= mo.energy) {
        if (motionState.since == null) motionState.since = ts;
        if (motionState.armed && ts - motionState.since >= mo.holdMs) {
          if (emit(out, 'wave', conf(motion / (mo.energy * 6), 0.35), ts, null, mo.cooldownMs, { source: 'motion' })) motionState.armed = false;
        }
      } else { motionState.since = null; if (motion < mo.energy * 0.5) { motionState.armed = true; S('wave').armed = true; } }
    }
    return out;
  }

  return {
    update,
    get sensitivity() { return sens; },
    setSensitivity(s) { if (SENSITIVITIES.includes(s)) { sens = s; T = thresholds(s); } },
    setEnabled(list) { enabled = list ? new Set(list) : null; },
    setExtraHold(map) { for (const k of Object.keys(extraHold)) delete extraHold[k]; Object.assign(extraHold, map || {}); },
    reset() { frames.length = 0; for (const k of Object.keys(st)) delete st[k]; suppress = {}; meetings = []; clapPhase = 'unknown'; handHold = { name: null, since: 0, seen: 0 }; waveActiveUntil = -Infinity; lastPoseTs = -Infinity; },
    get waveActive() { return frames.length ? frames[frames.length - 1].ts < waveActiveUntil : false; },
    thresholds: () => T,
  };
}

// ---------------------------------------------------------------------------------------------
// Actions: what a gesture does (pure mapping, so it is testable without a browser)
// ---------------------------------------------------------------------------------------------
export const ACTION_TYPES = ['none', 'fly', 'replay', 'ask', 'preset1', 'preset2', 'preset3', 'mute'];
export const ACTION_LABELS = {
  none: 'Meme only', fly: 'Fly reaction', replay: 'Replay voice', ask: 'Send current question (costs money)',
  preset1: 'Pick preset question 1', preset2: 'Pick preset question 2', preset3: 'Pick preset question 3', mute: 'Toggle mute',
};
export const ASK_HOLD_MS = 800;
export const ASK_COOLDOWN_MS = 10000;
export const FLY_REACTIONS = {
  wave: 'startled', jump: 'startled', clap: 'spin', thumbs_up: 'happy', hands_up: 'happy', squat: 'startled', t_pose: 'spin', belly_rub: 'happy',
  lean_left: 'lean_left', lean_right: 'lean_right', hand_up_left: 'happy', hand_up_right: 'happy',
  thumbs_down: 'startled', peace: 'happy', open_palm: 'happy', fist: 'startled', point_up: 'happy', i_love_you: 'happy',
};
const DEFAULT_ROWS = {
  wave: { meme: true, action: 'fly' }, hands_up: { meme: true, action: 'none' }, hand_up_left: { meme: true, action: 'none' }, hand_up_right: { meme: true, action: 'none' },
  t_pose: { meme: true, action: 'none' }, clap: { meme: true, action: 'fly' }, lean_left: { meme: false, action: 'fly' }, lean_right: { meme: false, action: 'fly' },
  jump: { meme: true, action: 'fly' }, squat: { meme: true, action: 'none' }, belly_rub: { meme: true, action: 'none' },
  thumbs_up: { meme: true, action: 'replay' }, thumbs_down: { meme: true, action: 'none' }, peace: { meme: true, action: 'none' },
  open_palm: { meme: false, action: 'none' }, fist: { meme: true, action: 'none' }, point_up: { meme: true, action: 'none' }, i_love_you: { meme: true, action: 'none' },
};
export function defaultActionsConfig() {
  const rows = {};
  for (const g of GESTURES) rows[g] = { ...DEFAULT_ROWS[g] };
  return { version: 1, sensitivity: 'normal', askEnabled: false, rows };
}
// Accept anything (e.g. a corrupt localStorage value) and return a valid config.
export function normalizeActionsConfig(raw) {
  const cfg = defaultActionsConfig();
  if (!raw || typeof raw !== 'object') return cfg;
  if (SENSITIVITIES.includes(raw.sensitivity)) cfg.sensitivity = raw.sensitivity;
  cfg.askEnabled = raw.askEnabled === true;
  const rows = raw.rows && typeof raw.rows === 'object' ? raw.rows : {};
  for (const g of GESTURES) {
    const r = rows[g];
    if (!r || typeof r !== 'object') continue;
    if (typeof r.meme === 'boolean') cfg.rows[g].meme = r.meme;
    if (ACTION_TYPES.includes(r.action)) cfg.rows[g].action = r.action;
  }
  return cfg;
}
// Gestures that need a longer hold because they can send a (paid) question.
export function requiredHolds(cfg) {
  const out = {};
  if (!cfg || !cfg.askEnabled) return out;
  for (const g of GESTURES) if (cfg.rows[g] && cfg.rows[g].action === 'ask') out[g] = ASK_HOLD_MS;
  return out;
}
// Decide what to do for one gesture event (ev.heldMs is set by the engine for hold-based gestures). ctx: { lastAskTs, test }. Never has side effects.
export function planAction(cfg, ev, ctx = {}) {
  const c = cfg || defaultActionsConfig();
  const row = c.rows && c.rows[ev && ev.name];
  if (!row) return { gesture: ev && ev.name, meme: false, action: 'none', ignored: true };
  const plan = { gesture: ev.name, meme: row.meme === true, action: row.action, reaction: null, blocked: null };
  if (row.action === 'fly') plan.reaction = FLY_REACTIONS[ev.name] || 'happy';
  if (row.action === 'ask') {
    if (ctx.test) { plan.dryRun = true; }
    else if (!c.askEnabled) { plan.action = 'none'; plan.blocked = 'ask-disabled'; }
    else if (!(ev.heldMs >= ASK_HOLD_MS)) { plan.action = 'none'; plan.blocked = 'ask-hold'; } // instantaneous gestures (jump, wave, clap) can never ask
    else if (Number.isFinite(ctx.lastAskTs) && ev.ts - ctx.lastAskTs < ASK_COOLDOWN_MS) { plan.action = 'none'; plan.blocked = 'ask-cooldown'; }
  }
  return plan;
}
