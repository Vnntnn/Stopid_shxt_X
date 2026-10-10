// Fly sound engine: procedural wing buzz that follows the fly state, a stupid result jingle and a chipmunk
// ring-modulated fly voice. Web Audio only, no libraries, no audio files. The AudioContext is injectable so the
// graph wiring can be tested with a fake context in node. Nothing makes a sound before unlock() (user gesture).
// Self-contained on purpose (no imports) so tests can load it standalone.

// ---------- Pure helpers (unit-tested) ----------
export const LEVEL_NAMES = ['Off', 'Silly', 'MAXIMUM'];

export function normLevel(l) { const n = Number(l); return n === 0 || n === 1 || n === 2 ? n : 2; }
export function clampVol(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.6; }

// level -> what the engine is allowed to do
export function levelSettings(level) {
  switch (normLevel(level)) {
    case 0: return { flight: 0, jingle: false, rate: 1.0, ring: 0, vibrato: 0, shaper: false, bursts: 0, stutter: false, voiceBed: 0 };
    case 1: return { flight: 0.7, jingle: false, rate: 1.3, ring: 0.35, vibrato: 25, shaper: false, bursts: 0, stutter: false, voiceBed: 0.5 };
    default: return { flight: 1, jingle: true, rate: 1.45, ring: 0.6, vibrato: 55, shaper: true, bursts: 3, stutter: true, voiceBed: 1 };
  }
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAD_PAN = { A: -0.85, B: 0.85, none: 0 };
export function padPan(pad) { return pad in PAD_PAN ? PAD_PAN[pad] : 0; }
// While the mic records, all fly sound is ducked to this share of the volume so STT is not polluted.
export const DUCK_GAIN = 0.08;
export const DECIDE_SECONDS = 3.2;
export const STATES = ['idle', 'listening', 'thinking', 'deciding', 'landing', 'landed', 'inconclusive', 'speaking'];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (p) => { p = clamp01(p); return p * p * (3 - 2 * p); };
// deterministic "random" in [-1, 1] for step i (used for erratic pitch jumps, testable)
export function jump(i, salt = 1) { return mulberry32(hashSeed(`${salt}:${i}`))() * 2 - 1; }

// Parameter curve of the wing bed for a state at time t (seconds since entering it).
// gain 0..1 (before level/master), freq Hz (base of the drone), lfo Hz (tremolo = wing beat), depth 0..1, vib cents,
// pan -1..1, q band-pass Q, noise 0..1 (share of filtered noise).
export function stateParams(state, t = 0, info = {}) {
  const base = { gain: 0.02, freq: 195, lfo: 4, depth: 0.3, vib: 6, pan: 0, q: 3, noise: 0.1 };
  switch (state) {
    case 'listening': {
      const mic = clamp01(Number(info.mic) || 0);
      return { ...base, gain: 0.2 + mic * 0.2, freq: 225, lfo: 22 + mic * 14, depth: 0.65, vib: 12, q: 4, noise: 0.15 };
    }
    case 'thinking': {
      const w = (2 * Math.PI) / 2.4; // one orbit every 2.4 s
      return { ...base, gain: 0.22 + 0.06 * Math.cos(w * t), freq: 205 - 26 * Math.cos(w * t) /* doppler: higher while approaching */, lfo: 17, depth: 0.55, vib: 10, pan: Math.sin(w * t) * 0.9, q: 3.5, noise: 0.12 };
    }
    case 'deciding': {
      const p = clamp01(t / DECIDE_SECONDS);
      const arc = Math.sin(Math.PI * p);
      return { ...base, gain: 0.18 + 0.4 * arc, freq: 195 + 170 * arc, lfo: 16 + 10 * arc, depth: 0.5, vib: 14, pan: padPan(info.pad) * smooth(p), q: 3, noise: 0.18 };
    }
    case 'landing': {
      const p = clamp01(t / 1.0);
      return { ...base, gain: 0.3 * (1 - p) * (1 - p), freq: 215 - 150 * p, lfo: 17 - 10 * p, depth: 0.7, vib: 8, pan: padPan(info.pad) * 0.9, q: 3, noise: 0.25 * (1 - p) };
    }
    case 'landed': return { ...base, gain: 0.0, lfo: 3 };
    case 'speaking': return { ...base, gain: 0.1, freq: 210, lfo: 30, depth: 0.5, vib: 18, q: 3 };
    case 'inconclusive': {
      if (t > 2.4) { // sad slide-down
        const p = clamp01((t - 2.4) / 1.4);
        return { ...base, gain: 0.26 * (1 - p), freq: 190 - 110 * p, lfo: 9 - 6 * p, depth: 0.6, vib: 4, pan: 0, q: 3, noise: 0.05 };
      }
      const i = Math.floor(t * 7); // erratic: new random pitch ~7 times per second
      return { ...base, gain: 0.26, freq: 195 + jump(i, 'f') * 85, lfo: 8 + Math.abs(jump(i, 'l')) * 24, depth: 0.7, vib: 40, pan: jump(i, 'p') * 0.6, q: 4, noise: 0.2 };
    }
    default: return base; // idle: lazy, barely audible
  }
}

// ---------- The engine ----------
export function createFlyAudio(opts = {}) {
  const g = typeof window !== 'undefined' ? window : {};
  const AC = opts.AudioContextCtor !== undefined ? opts.AudioContextCtor : (g.AudioContext || g.webkitAudioContext || null);
  const doc = opts.document !== undefined ? opts.document : (typeof document !== 'undefined' ? document : null);
  const speechImpl = opts.speech !== undefined ? opts.speech
    : (g.speechSynthesis && g.SpeechSynthesisUtterance ? { synth: g.speechSynthesis, Utterance: g.SpeechSynthesisUtterance } : null);
  const rand = opts.random || mulberry32(hashSeed('fly' + Date.now()));
  const setTimer = opts.setInterval || ((f, ms) => { const h = setInterval(f, ms); if (h && h.unref) h.unref(); return h; });
  const clearTimer = opts.clearInterval || clearInterval;
  const setTimeoutX = opts.setTimeout || ((f, ms) => { const h = setTimeout(f, ms); if (h && h.unref) h.unref(); return h; });
  const clearTimeoutX = opts.clearTimeout || clearTimeout;

  let ctx = null;
  let master = null;            // { bus, gain, comp, analyser } persistent
  let level = 2, muted = false, volume = 0.6, ducked = false;
  let state = 'idle', info = {}, stateStart = 0;
  let tickHandle = null;
  let bed = null;               // continuous wing buzz
  const live = [];              // every node created after master (for disposal)
  const starters = [];          // oscillators / buffer sources to stop
  const timers = new Set();
  const voiceEnders = new Set();
  let noiseBuf = null;
  let unlocked = false;
  let hiddenSuspend = false;
  let micLevel = 0;
  let speaking = null;

  const supported = !!AC;
  const mk = (kind, ...a) => { const n = ctx[kind](...a); live.push(n); return n; };
  const osc = (type, f) => { const o = mk('createOscillator'); o.type = type; o.frequency.value = f; starters.push(o); return o; };
  const gainNode = (v) => { const n = mk('createGain'); n.gain.value = v; return n; };
  const bp = (f, q, type = 'bandpass') => { const n = mk('createBiquadFilter'); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
  const link = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); };
  function noiseSource(loop = true) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 2)), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
    }
    const s = mk('createBufferSource'); s.buffer = noiseBuf; s.loop = loop; starters.push(s);
    return s;
  }
  function later(fn, seconds) {
    const h = setTimeoutX(() => { timers.delete(h); fn(); }, Math.max(0, seconds * 1000));
    timers.add(h);
    return h;
  }
  const lv = () => levelSettings(level);
  const audible = () => !(doc && doc.hidden);

  const masterTarget = () => (muted ? 0 : volume * 0.9 * (ducked ? DUCK_GAIN : 1));
  function applyMaster() {
    if (!master || !ctx) return;
    const v = masterTarget();
    try { master.gain.gain.setTargetAtTime(v, ctx.currentTime, ducked ? 0.03 : 0.12); } catch (_) { master.gain.gain.value = v; }
  }

  function buildMaster() {
    // bus -> master gain -> limiter -> analyser -> speakers
    const bus = ctx.createGain();
    const gainM = ctx.createGain(); gainM.gain.value = masterTarget();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 6; comp.ratio.value = 14; comp.attack.value = 0.003; comp.release.value = 0.2;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    link(bus, gainM, comp, analyser, ctx.destination);
    master = { bus, gain: gainM, comp, analyser, nodes: [bus, gainM, comp, analyser] };
  }

  // ---- continuous wing bed ----
  function ensureBed() {
    if (!ctx || bed) return;
    const detune = [1, 1.012, 0.5];
    const types = ['sawtooth', 'sawtooth', 'square'];
    const mix = gainNode(0.5);
    const oscs = detune.map((r, i) => { const o = osc(types[i], 195 * r); o.connect(mix); return o; });
    const filt = bp(400, 3);
    const trem = gainNode(0.7);
    const level_ = gainNode(0);
    const pan = mk('createStereoPanner');
    // wing-beat tremolo
    const lfo = osc('sine', 4); const lfoDepth = gainNode(0.3); link(lfo, lfoDepth); lfoDepth.connect(trem.gain);
    // vibrato
    const vib = osc('sine', 6.5); const vibAmt = gainNode(6);
    vib.connect(vibAmt); for (const o of oscs) vibAmt.connect(o.detune);
    // noise
    const nz = noiseSource(); const nzF = bp(1800, 0.8); const nzG = gainNode(0.1); link(nz, nzF, nzG, level_);
    link(mix, filt, trem, level_, pan, master.bus);
    for (const o of [...oscs, lfo, vib, nz]) o.start();
    bed = { oscs, ratios: detune, filt, trem, level: level_, pan, lfo, lfoDepth, vibAmt, nzG, mix };
    stateStart = ctx.currentTime;
  }

  function tick() {
    if (!ctx || !bed || !master) return;
    const now = ctx.currentTime;
    const p = stateParams(state, now - stateStart, { ...info, mic: micLevel });
    const k = lv().flight, T = 0.05;
    const set = (param, v) => { try { param.setTargetAtTime(v, now, T); } catch (_) { param.value = v; } };
    set(bed.level.gain, audible() ? p.gain * k : 0);
    bed.oscs.forEach((o, i) => set(o.frequency, p.freq * bed.ratios[i]));
    set(bed.filt.frequency, p.freq * 2.1);
    set(bed.filt.Q, p.q);
    set(bed.lfo.frequency, p.lfo);
    set(bed.lfoDepth.gain, p.depth / 2);
    set(bed.trem.gain, 1 - p.depth / 2);
    set(bed.vibAmt.gain, p.vib);
    set(bed.nzG.gain, p.noise);
    set(bed.pan.pan, Math.max(-1, Math.min(1, p.pan)));
  }

  function startTicker() {
    if (tickHandle != null || !ctx) return;
    tickHandle = setTimer(() => tick(), 50);
  }

  // ---- one-shot helpers ----
  function shotEnd(seconds) { later(() => pruneDead(), seconds + 0.3); }
  function pruneDead() { /* nodes of finished one-shots are disconnected by stopAll / dispose; keep the list bounded */
    if (live.length > 400) {
      const keep = new Set(bed ? bedNodes() : []);
      for (let i = live.length - 1; i >= 0; i--) {
        const n = live[i];
        if (keep.has(n) || n._fly_keep) continue;
        if (n._fly_done) { try { n.disconnect(); } catch (_) { /* ignore */ } live.splice(i, 1); }
      }
    }
  }
  function bedNodes() { return bed ? [...bed.oscs, bed.filt, bed.trem, bed.level, bed.pan, bed.lfo, bed.lfoDepth, bed.vibAmt, bed.nzG, bed.mix] : []; }
  function envelope(param, t0, peak, a, hold, r) {
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(peak, t0 + a);
    param.setValueAtTime(peak, t0 + a + hold);
    param.linearRampToValueAtTime(0.0001, t0 + a + hold + r);
  }
  function finish(srcs, t) { for (const s of srcs) { try { s.stop(t); } catch (_) { /* ignore */ } s._fly_done = true; } shotEnd(Math.max(0, t - (ctx ? ctx.currentTime : 0))); }

  function landingShot() {
    if (!ctx || lv().flight === 0 || !audible()) return;
    const t0 = ctx.currentTime;
    // bzzzzrrrr: descending buzz
    const o = osc('sawtooth', 230); const f = bp(500, 2); const gn = gainNode(0.0001);
    o.frequency.setValueAtTime(230, t0); o.frequency.exponentialRampToValueAtTime(55, t0 + 0.95);
    envelope(gn.gain, t0, 0.45, 0.03, 0.55, 0.4);
    // growl: fast tremolo
    const trem = osc('square', 38); const tg = gainNode(0.4); link(trem, tg); tg.connect(gn.gain);
    link(o, f, gn, master.bus);
    o.start(t0); trem.start(t0); finish([o, trem], t0 + 1.1);
    // tap
    const tap = noiseSource(false); const tf = bp(2600, 2); const tgn = gainNode(0.0001);
    envelope(tgn.gain, t0 + 0.95, 0.5, 0.002, 0.01, 0.05);
    link(tap, tf, tgn, master.bus); tap.start(t0 + 0.95, 0, 0.1); finish([tap], t0 + 1.1);
    // squeak
    const sq = osc('sine', 2400); const sg = gainNode(0.0001);
    sq.frequency.setValueAtTime(2300, t0 + 1.02); sq.frequency.exponentialRampToValueAtTime(3600, t0 + 1.12);
    envelope(sg.gain, t0 + 1.02, 0.16, 0.01, 0.06, 0.05);
    link(sq, sg, master.bus); sq.start(t0 + 1.02); finish([sq], t0 + 1.25);
  }

  // ---- result jingles (level 2 only) ----
  function slideWhistle(t0, from, to, dur, peak = 0.3) {
    const o = osc('sine', from); const gn = gainNode(0.0001);
    o.frequency.setValueAtTime(from, t0); o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const v = osc('sine', 7); const va = gainNode(30); link(v, va); va.connect(o.detune);
    envelope(gn.gain, t0, peak, 0.04, dur - 0.12, 0.1);
    link(o, gn, master.bus); o.start(t0); v.start(t0); finish([o, v], t0 + dur + 0.05);
  }
  function kazoo(t0, notes, peak = 0.22) {
    const o = osc('sawtooth', notes[0][0]); const f = bp(1200, 1.6); const gn = gainNode(0.0001);
    const v = osc('sine', 6); const va = gainNode(28); link(v, va); va.connect(o.detune);
    let t = t0;
    for (const [freq, dur] of notes) {
      o.frequency.setValueAtTime(freq, t);
      gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(peak, t + 0.02);
      gn.gain.setValueAtTime(peak, t + dur * 0.8); gn.gain.linearRampToValueAtTime(0.0001, t + dur * 0.98);
      t += dur;
    }
    link(o, f, gn, master.bus); o.start(t0); v.start(t0); finish([o, v], t + 0.05);
    return t;
  }
  function sadTrombone(t0) {
    const o = osc('sawtooth', 233); const f = bp(700, 1.2, 'lowpass'); const gn = gainNode(0.0001);
    const wah = osc('sine', 5.5); const wg = gainNode(350); link(wah, wg); wg.connect(f.frequency);
    const notes = [[233, 0.5], [220, 0.5], [208, 0.5], [196, 1.2]];
    let t = t0;
    for (const [freq, dur] of notes) {
      o.frequency.setValueAtTime(freq, t);
      gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(0.3, t + 0.04);
      gn.gain.setValueAtTime(0.3, t + dur * 0.85); gn.gain.linearRampToValueAtTime(0.0001, t + dur * 0.99);
      t += dur;
    }
    o.frequency.setValueAtTime(196, t - 1.2); o.frequency.exponentialRampToValueAtTime(150, t - 0.05);
    link(o, f, gn, master.bus); o.start(t0); wah.start(t0); finish([o, wah], t + 0.05);
  }

  function playJingle(kind) {
    if (!ctx || muted || ducked || !audible() || !lv().jingle) return;
    const t0 = ctx.currentTime + 0.02;
    switch (kind) {
      case 'winA': slideWhistle(t0, 450, 2300, 0.7); kazoo(t0 + 0.75, [[392, 0.14], [392, 0.14], [392, 0.14], [523, 0.5]]); break;
      case 'winB': slideWhistle(t0, 2300, 380, 0.75); kazoo(t0 + 0.8, [[523, 0.14], [523, 0.14], [440, 0.14], [330, 0.5]]); break;
      case 'winNone': slideWhistle(t0, 500, 1800, 0.35); slideWhistle(t0 + 0.4, 1800, 500, 0.35); kazoo(t0 + 0.8, [[262, 0.2], [262, 0.5]]); break;
      case 'sad': case 'inconclusive': sadTrombone(t0); break;
      default: break;
    }
  }

  // ---- fly voice ----
  function shaperCurve() {
    const n = 256, c = new Float32Array(n), k = 12;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return c;
  }

  async function prepareVoice(data) {
    if (!ctx) throw new Error('audio is locked');
    if (data && typeof data.getChannelData === 'function') return data; // already an AudioBuffer
    const copy = data.slice ? data.slice(0) : data;
    return await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(copy, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  function playVoice(buffer, o = {}) {
    if (!ctx || !master || muted || ducked || !audible()) return Promise.resolve(false);
    const L = lv();
    const t0 = ctx.currentTime + 0.05;
    const rng = mulberry32(hashSeed(o.seed || 'voice'));
    const rate = L.rate;
    const input = gainNode(1);
    const dry = gainNode(1 - L.ring * 0.6);
    const ringG = gainNode(0);                 // gain is driven by the oscillator: true ring modulation
    const wet = gainNode(L.ring * 1.5);
    const mixer = gainNode(1);
    const hp = bp(L.ring ? 380 : 120, 0.7, 'highpass');
    const vGain = gainNode(0.9);
    link(input, dry, mixer); link(input, ringG, wet, mixer);
    const carrier = osc('sine', 90 + rng() * 40); carrier.connect(ringG.gain);
    let tail = mixer; link(mixer, hp); tail = hp;
    if (L.shaper) { const sh = mk('createWaveShaper'); sh.curve = shaperCurve(); link(tail, sh); tail = sh; }
    link(tail, vGain, master.bus);
    // pitch wobble
    const wob = osc('sine', 8 + rng() * 3); const wobAmt = gainNode(L.vibrato); link(wob, wobAmt);
    const srcs = [carrier, wob];
    const makeSrc = (when, offset, dur) => {
      const s = mk('createBufferSource'); s.buffer = buffer; s.playbackRate.value = rate; starters.push(s);
      if (s.detune) wobAmt.connect(s.detune);
      s.connect(input);
      if (dur) s.start(when, offset, dur); else s.start(when, offset);
      srcs.push(s);
      return s;
    };
    let t = t0;
    if (L.stutter) { // re-trigger the first 150 ms a few times, then go
      const piece = 0.15 / rate;
      for (let i = 0; i < 3; i++) { makeSrc(t, 0, 0.15); t += piece * 1.05; }
    }
    const main = makeSrc(t, 0);
    const endT = t + buffer.duration / rate;
    carrier.start(t0); wob.start(t0);
    // bzzt bursts
    for (let i = 0; i < L.bursts; i++) {
      const bt = t0 + 0.2 + rng() * Math.max(0.2, endT - t0 - 0.5);
      const bo = osc('sawtooth', 170 + rng() * 120); const bf = bp(900, 2); const bg = gainNode(0.0001);
      envelope(bg.gain, bt, 0.22, 0.01, 0.05 + rng() * 0.05, 0.03);
      link(bo, bf, bg, master.bus); bo.start(bt); finish([bo], bt + 0.2);
    }
    vGain.gain.setValueAtTime(0.9, endT);
    return new Promise((resolve) => {
      let done = false;
      const end = () => { if (done) return; done = true; voiceEnders.delete(end); finish(srcs, ctx.currentTime + 0.01); resolve(true); };
      voiceEnders.add(end);
      main.onended = end;
      later(end, endT - ctx.currentTime + 0.4);
    });
  }

  // ---- fallbacks ----
  function canSpeak() { return !!(speechImpl && speechImpl.synth && speechImpl.Utterance); }
  function pickVoice(lang) {
    try {
      const vs = speechImpl.synth.getVoices ? speechImpl.synth.getVoices() : [];
      const want = lang === 'th' ? 'th' : 'en';
      return vs.find((v) => String(v.lang || '').toLowerCase().startsWith(want)) || null;
    } catch (_) { return null; }
  }
  function speakFallback(text, lang) {
    if (!canSpeak() || muted || !audible()) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const u = new speechImpl.Utterance(String(text));
        u.pitch = 2; u.rate = 1.5; u.volume = clampVol(volume);
        const v = pickVoice(lang);
        if (v) u.voice = v;
        u.lang = (v && v.lang) || (lang === 'th' ? 'th-TH' : 'en-US');
        let fin = false;
        const done = () => { if (fin) return; fin = true; speaking = null; resolve(true); };
        u.onend = done; u.onerror = done;
        speaking = u;
        speechImpl.synth.cancel();
        speechImpl.synth.speak(u);
        later(done, Math.min(20, 3 + String(text).length / 6));
      } catch (_) { resolve(false); }
    });
  }

  // ---- public surface ----
  function unlock() {
    if (!supported) return false;
    try {
      if (!ctx) {
        ctx = new AC();
        buildMaster();
        if (doc && doc.addEventListener) {
          doc.addEventListener('visibilitychange', onVisibility);
        }
      }
      if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); }
      unlocked = true;
      ensureBed(); startTicker(); tick();
      return true;
    } catch (_) { return false; }
  }

  function onVisibility() {
    if (!ctx) return;
    if (doc.hidden) { hiddenSuspend = true; try { const r = ctx.suspend(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ } if (speechImpl?.synth?.cancel) speechImpl.synth.cancel(); }
    else if (hiddenSuspend && unlocked) { hiddenSuspend = false; try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ } }
  }

  function setState(next, i = {}) {
    state = STATES.includes(next) ? next : 'idle';
    info = i || {};
    stateStart = ctx ? ctx.currentTime : 0;
    if (!unlocked) return;
    ensureBed(); startTicker();
    if (state === 'landing') landingShot();
    tick();
  }

  function stopVoice() {
    for (const e of [...voiceEnders]) e();
    if (speechImpl?.synth?.cancel) { try { speechImpl.synth.cancel(); } catch (_) { /* ignore */ } }
    speaking = null;
  }

  function stopAll() {
    if (tickHandle != null) { clearTimer(tickHandle); tickHandle = null; }
    for (const h of timers) clearTimeoutX(h);
    timers.clear();
    for (const e of [...voiceEnders]) e();
    for (const s of starters.splice(0)) { try { s.stop(); } catch (_) { /* never started or already stopped */ } }
    for (const n of live.splice(0)) { try { n.disconnect(); } catch (_) { /* ignore */ } }
    bed = null;
    if (speechImpl?.synth?.cancel) { try { speechImpl.synth.cancel(); } catch (_) { /* ignore */ } }
    speaking = null;
  }

  function dispose() {
    stopAll();
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
    if (ctx) { try { for (const n of master.nodes) n.disconnect(); } catch (_) { /* ignore */ } try { const r = ctx.close(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ } }
    ctx = null; master = null; unlocked = false;
  }

  function rms() {
    if (!master) return 0;
    const a = master.analyser;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  return {
    get supported() { return supported; },
    get unlocked() { return unlocked; },
    get ctx() { return ctx; },
    get state() { return state; },
    get canSpeak() { return canSpeak(); },
    unlock,
    setState,
    setMicLevel(v) { micLevel = clamp01(Number(v) || 0); },
    setLevel(l) { level = normLevel(l); if (unlocked) tick(); },
    setDucked(d) { ducked = !!d; if (ducked) stopVoice(); applyMaster(); },
    get ducked() { return ducked; },
    setMuted(m) { muted = !!m; applyMaster(); if (muted) stopVoice(); },
    setVolume(v) { volume = clampVol(v); applyMaster(); },
    prepareVoice,
    playVoice,
    async playResultVoice(data, o) { const b = await prepareVoice(data); return playVoice(b, o); },
    speakFallback,
    playJingle,
    stopVoice,
    stopAll,
    dispose,
    debug() {
      return { state, rms: rms(), level, muted, volume, ctxState: ctx ? ctx.state : 'none', nodes: live.length, hasBed: !!bed, ducked, masterGain: master ? master.gain.gain.value : null };
    },
    _tick: tick,
  };
}
