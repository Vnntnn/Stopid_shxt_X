'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../web/fly-audio.js'), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// ---- A tiny fake Web Audio context: records nodes, params and connections ----
function makeFake() {
  const all = [];
  class Param {
    constructor(v) { this.value = v; this.calls = []; }
    setValueAtTime(v, t) { this.calls.push(['set', v, t]); return this; }
    linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); return this; }
    exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; }
    setTargetAtTime(v, t, c) { this.value = v; this.calls.push(['target', v, t, c]); return this; }
  }
  class Node {
    constructor(type, extra = {}) {
      this.kind = type; this.out = []; this.disconnected = false; this.started = false; this.stopped = false;
      Object.assign(this, extra); all.push(this);
    }
    connect(to) { this.out.push(to); return to; }
    disconnect() { this.disconnected = true; this.out = []; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  class Ctx {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 8000; this.destination = new Node('destination'); this.closed = false; Ctx.last = this; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createGain() { return new Node('gain', { gain: new Param(1) }); }
    createOscillator() { return new Node('osc', { frequency: new Param(440), detune: new Param(0), onended: null }); }
    createBiquadFilter() { return new Node('biquad', { frequency: new Param(350), Q: new Param(1) }); }
    createStereoPanner() { return new Node('panner', { pan: new Param(0) }); }
    createDynamicsCompressor() { return new Node('comp', { threshold: new Param(0), knee: new Param(0), ratio: new Param(0), attack: new Param(0), release: new Param(0) }); }
    createAnalyser() { return new Node('analyser', { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0.1); } }); }
    createWaveShaper() { return new Node('shaper', { curve: null }); }
    createBuffer(ch, len) { return { duration: len / 8000, getChannelData: () => new Float32Array(len) }; }
    createBufferSource() { return new Node('source', { buffer: null, loop: false, playbackRate: new Param(1), detune: new Param(0), onended: null }); }
    decodeAudioData(ab, ok) { const b = { duration: 1.2, getChannelData: () => new Float32Array(10) }; ok(b); return Promise.resolve(b); }
  }
  return { Ctx, all };
}

const make = async (extra = {}) => {
  const mod = await load();
  const f = makeFake();
  const engine = mod.createFlyAudio({ AudioContextCtor: f.Ctx, document: null, speech: null, ...extra });
  return { mod, f, engine };
};

test('level -> settings mapping', async () => {
  const { levelSettings, normLevel, clampVol } = await load();
  assert.equal(levelSettings(0).flight, 0);
  assert.equal(levelSettings(0).jingle, false);
  assert.equal(levelSettings(1).jingle, false);
  assert.ok(levelSettings(1).flight > 0 && levelSettings(1).flight < levelSettings(2).flight);
  assert.equal(levelSettings(2).jingle, true);
  assert.equal(levelSettings(2).stutter, true);
  assert.equal(levelSettings(2).shaper, true);
  assert.equal(levelSettings(1).shaper, false);
  assert.ok(levelSettings(2).rate >= 1.4 && levelSettings(2).rate <= 1.5);
  assert.equal(levelSettings(0).rate, 1);
  assert.equal(normLevel('x'), 2); assert.equal(normLevel(1), 1);
  assert.equal(clampVol(5), 1); assert.equal(clampVol(-1), 0); assert.equal(clampVol('nope'), 0.6);
});

test('state -> params table follows the brief', async () => {
  const { stateParams, STATES, DECIDE_SECONDS } = await load();
  const idle = stateParams('idle'), lis = stateParams('listening'), thi = stateParams('thinking', 0);
  assert.ok(idle.gain < 0.05 && idle.gain < lis.gain && idle.gain < thi.gain);
  assert.ok(lis.lfo > thi.lfo && lis.lfo > idle.lfo * 3);                       // fast pulsing
  assert.ok(stateParams('listening', 0, { mic: 1 }).lfo > lis.lfo);               // mic level speeds it up
  for (const st of STATES) { const p = stateParams(st, 0.7, { pad: 'A' }); for (const k of ['gain', 'freq', 'lfo', 'depth', 'vib', 'pan', 'q', 'noise']) assert.ok(Number.isFinite(p[k]), `${st}.${k}`); }
  for (const t of [0, 0.6, 1.2, 1.8]) { const p = stateParams('thinking', t); assert.ok(p.freq > 150 && p.freq < 260); }
  assert.ok(stateParams('thinking', 0.6).pan > 0.5 && stateParams('thinking', 1.8).pan < -0.5); // stereo sweep
  // deciding: swoops up then down, pans to the pad
  const s = (t, pad) => stateParams('deciding', t, { pad });
  assert.ok(s(DECIDE_SECONDS / 2).freq > s(0).freq + 100 && s(DECIDE_SECONDS / 2).freq > s(DECIDE_SECONDS).freq + 100);
  assert.ok(s(DECIDE_SECONDS, 'A').pan < -0.5 && s(DECIDE_SECONDS, 'B').pan > 0.5 && s(DECIDE_SECONDS, 'none').pan === 0);
  // landing descends and fades; landed is silent
  assert.ok(stateParams('landing', 0.9).freq < stateParams('landing', 0).freq - 100);
  assert.ok(stateParams('landing', 1).gain < 0.01 && stateParams('landed', 0).gain === 0);
  // inconclusive: erratic jumps, then a sad slide down
  const freqs = new Set([0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((t) => Math.round(stateParams('inconclusive', t).freq)));
  assert.ok(freqs.size >= 4);
  assert.ok(stateParams('inconclusive', 3.6).freq < 110 && stateParams('inconclusive', 3.6).gain < stateParams('inconclusive', 1).gain);
  assert.equal(stateParams('nonsense').gain, idle.gain);
});

test('PRNG and jump are deterministic', async () => {
  const { hashSeed, mulberry32, jump } = await load();
  const a = mulberry32(hashSeed('x')), b = mulberry32(hashSeed('x'));
  for (let i = 0; i < 4; i++) assert.equal(a(), b());
  assert.equal(jump(3, 'f'), jump(3, 'f'));
  assert.notEqual(jump(3, 'f'), jump(4, 'f'));
  assert.ok(Math.abs(jump(9)) <= 1);
});

test('nothing is created before unlock(); unlock builds master chain and wing bed', async () => {
  const { f, engine } = await make();
  engine.setState('thinking');
  engine.setLevel(2); engine.setVolume(0.4);
  assert.equal(f.all.length, 0);
  assert.equal(engine.unlocked, false);
  assert.equal(engine.playJingle('winA'), undefined);
  assert.equal(await engine.playVoice({ duration: 1 }), false);
  assert.equal(engine.unlock(), true);
  assert.equal(f.Ctx.last.state, 'running');
  const t = (k) => f.all.filter((n) => n.kind === k);
  assert.equal(t('comp').length, 1);
  assert.equal(t('analyser').length, 1);
  assert.ok(t('osc').length >= 5);                    // 3 drone + wing LFO + vibrato
  assert.ok(t('osc').every((o) => o.started));
  const comp = t('comp')[0], an = t('analyser')[0];
  assert.ok(comp.out.includes(an) && an.out.includes(f.Ctx.last.destination)); // master -> limiter -> analyser -> speakers
  assert.ok(t('panner').length === 1);
  assert.ok(t('biquad').some((b) => b.type === 'bandpass'));
  engine.unlock(); // idempotent
  assert.equal(t('comp').length, 1);
  engine.stopAll();
});

test('tick drives pitch/gain/pan from the state', async () => {
  const { f, engine } = await make();
  engine.unlock();
  const ctx = f.Ctx.last;
  const panner = f.all.find((n) => n.kind === 'panner');
  engine.setState('deciding', { pad: 'B' });
  ctx.currentTime = 3.2; engine._tick();
  assert.ok(panner.pan.value > 0.5);
  engine.setState('deciding', { pad: 'A' });
  ctx.currentTime = 6.4; engine._tick();
  assert.ok(panner.pan.value < -0.5);
  // level 0: flight is muted
  engine.setLevel(0); engine.setState('listening'); engine._tick();
  const lvl = f.all.filter((n) => n.kind === 'gain').find((g) => g.gain.calls.some((c) => c[0] === 'target' && c[1] === 0 && c[3] === 0.05));
  assert.ok(lvl);
  engine.stopAll();
});

test('mute and volume act on the master gain', async () => {
  const { f, engine } = await make();
  engine.unlock();
  const comp = f.all.find((n) => n.kind === 'comp');
  const master = f.all.find((n) => n.kind === 'gain' && n.out.includes(comp));
  engine.setVolume(0.5); assert.ok(master.gain.value > 0.3);
  engine.setMuted(true); assert.equal(master.gain.value, 0);
  engine.setMuted(false); assert.ok(master.gain.value > 0.3);
  engine.stopAll();
});

test('voice chain: playbackRate, ring modulator, high-pass, shaper at level 2 and stutter', async () => {
  const { f, engine } = await make();
  engine.unlock(); engine.setLevel(2);
  const before = f.all.length;
  const buf = await engine.prepareVoice(new ArrayBuffer(8));
  assert.ok(buf.duration > 0);
  engine.playVoice(buf, { seed: 'a' });
  const made = f.all.slice(before);
  const srcs = made.filter((n) => n.kind === 'source');
  assert.ok(srcs.length >= 4);                                  // 3 stutters + main
  assert.ok(srcs.every((s) => s.playbackRate.value >= 1.4 && s.playbackRate.value <= 1.5));
  assert.ok(made.some((n) => n.kind === 'shaper'));
  assert.ok(made.some((n) => n.kind === 'biquad' && n.frequency.value >= 300));
  const ring = made.find((n) => n.kind === 'gain' && n.gain.value === 0 && made.some((o) => o.kind === 'osc' && o.out.includes(n.gain)));
  assert.ok(ring, 'a carrier oscillator is connected to a gain AudioParam');
  const carrier = made.find((o) => o.kind === 'osc' && o.out.includes(ring.gain));
  assert.ok(carrier.frequency.value >= 90 && carrier.frequency.value <= 130);
  assert.ok(srcs.every((s) => s.out.length === 1));
  engine.stopAll();
  // level 1: no shaper, no stutter
  const e2 = await make(); e2.engine.unlock(); e2.engine.setLevel(1);
  const b2 = e2.f.all.length; e2.engine.playVoice({ duration: 1, getChannelData() {} });
  const m2 = e2.f.all.slice(b2);
  assert.ok(!m2.some((n) => n.kind === 'shaper'));
  assert.equal(m2.filter((n) => n.kind === 'source').length, 1);
  e2.engine.stopAll();
});

test('muted engine does not play voice or jingles', async () => {
  const { f, engine } = await make();
  engine.unlock(); engine.setMuted(true);
  const n = f.all.length;
  assert.equal(await engine.playVoice({ duration: 1 }), false);
  engine.playJingle('sad');
  assert.equal(f.all.length, n);
  engine.stopAll();
});

test('jingles only at level 2; landing makes a tap and a squeak', async () => {
  const { f, engine } = await make();
  engine.unlock();
  engine.setLevel(1);
  let n = f.all.length; engine.playJingle('winA'); assert.equal(f.all.length, n);
  engine.setLevel(0); engine.setState('landing'); assert.ok(f.all.length - n < 3);
  engine.setLevel(2);
  n = f.all.length; engine.playJingle('winA'); assert.ok(f.all.length > n + 5);
  n = f.all.length; engine.playJingle('sad'); assert.ok(f.all.length > n + 3);
  n = f.all.length; engine.setState('landing', { pad: 'A' });
  const made = f.all.slice(n);
  assert.ok(made.some((x) => x.kind === 'osc' && x.type) && made.some((x) => x.kind === 'source'));
  engine.stopAll();
});

test('stopAll disconnects and stops everything except the master chain; engine stays usable', async () => {
  const { f, engine } = await make();
  engine.unlock(); engine.setLevel(2);
  engine.setState('thinking');
  engine.playJingle('winB');
  engine.setState('landing', { pad: 'B' });
  engine.playVoice({ duration: 2, getChannelData() {} });
  const masterTypes = new Set(['destination', 'comp', 'analyser']);
  const comp = f.all.find((n) => n.kind === 'comp');
  const masterGain = f.all.find((n) => n.kind === 'gain' && n.out.includes(comp));
  const busGain = f.all.find((n) => n.kind === 'gain' && n.out.includes(masterGain));
  engine.stopAll();
  const rest = f.all.filter((n) => !masterTypes.has(n.kind) && n !== masterGain && n !== busGain);
  assert.ok(rest.length > 20);
  assert.ok(rest.every((n) => n.disconnected), 'every non-master node is disconnected');
  assert.ok(rest.filter((n) => n.kind === 'osc' || n.kind === 'source').every((n) => n.stopped));
  assert.equal(engine.debug().hasBed, false);
  assert.ok(Math.abs(engine.debug().rms - 0.1) < 1e-6 && engine.debug().level === 2 && engine.debug().muted === false);
  // usable again
  engine.setState('listening');
  assert.equal(engine.debug().hasBed, true);
  engine.dispose();
  assert.equal(f.Ctx.last.closed, true);
});

test('speech fallback: pitch 2, rate 1.5, prefers the language voice; no speech means no throw', async () => {
  const spoken = [];
  class U { constructor(t) { this.text = t; } }
  const synth = { getVoices: () => [{ lang: 'en-US', name: 'e' }, { lang: 'th-TH', name: 't' }], cancel() {}, speak(u) { spoken.push(u); setTimeout(() => u.onend && u.onend(), 0); } };
  const { engine } = await make({ speech: { synth, Utterance: U } });
  assert.equal(engine.canSpeak, true);
  assert.equal(await engine.speakFallback('บึ้นนน', 'th'), true);
  assert.equal(spoken[0].pitch, 2); assert.equal(spoken[0].rate, 1.5); assert.equal(spoken[0].voice.lang, 'th-TH');
  await engine.speakFallback('Bzzt', 'en');
  assert.equal(spoken[1].voice.lang, 'en-US');
  engine.setMuted(true);
  assert.equal(await engine.speakFallback('x', 'en'), false);
  const none = await make({ speech: null, AudioContextCtor: null });
  assert.equal(none.engine.supported, false);
  assert.equal(none.engine.unlock(), false);
  assert.equal(await none.engine.speakFallback('x', 'en'), false);
  none.engine.setState('thinking'); none.engine.stopAll();
});

test('hidden tab suspends the context and stops sound; visible resumes', async () => {
  const listeners = {};
  const doc = { hidden: false, addEventListener: (e, f) => { listeners[e] = f; }, removeEventListener() {} };
  const { f, engine } = await make({ document: doc });
  engine.unlock();
  doc.hidden = true; listeners.visibilitychange();
  assert.equal(f.Ctx.last.state, 'suspended');
  const n = f.all.length;
  assert.equal(await engine.playVoice({ duration: 1 }), false);
  assert.equal(f.all.length, n);
  doc.hidden = false; listeners.visibilitychange();
  assert.equal(f.Ctx.last.state, 'running');
  engine.stopAll();
});

test('ducking: master gain drops to <= 8% while recording, blocks voice/jingles, and restores after', async () => {
  const { f, engine } = await make();
  const { DUCK_GAIN } = await load();
  engine.unlock(); engine.setVolume(0.5); engine.setLevel(2);
  const comp = f.all.find((n) => n.kind === 'comp');
  const master = f.all.find((n) => n.kind === 'gain' && n.out.includes(comp));
  const normal = master.gain.value;
  assert.ok(normal > 0.4);
  assert.ok(DUCK_GAIN <= 0.08);
  engine.setDucked(true);
  assert.ok(master.gain.value <= normal * 0.08 + 1e-9, `ducked ${master.gain.value}`);
  assert.ok(master.gain.value > 0, 'ducked, not muted');
  const last = master.gain.calls[master.gain.calls.length - 1];
  assert.equal(last[0], 'target'); assert.ok(last[3] > 0, 'ramped, not a hard cut');
  const n = f.all.length;
  assert.equal(await engine.playVoice({ duration: 1 }), false);
  engine.playJingle('winA');
  assert.equal(f.all.length, n, 'no voice or jingle while ducked');
  engine.setVolume(1); assert.ok(master.gain.value <= 0.9 * 0.08 + 1e-9, 'volume changes stay ducked');
  engine.setDucked(false);
  assert.ok(Math.abs(master.gain.value - 0.9) < 1e-9, 'restored to the current volume');
  engine.setMuted(true); engine.setDucked(true); engine.setDucked(false); assert.equal(master.gain.value, 0, 'mute still wins');
  engine.stopAll();
});

test('playBoom: level >= 1 only, and silent when muted, ducked or before unlock', async () => {
  const { f, engine } = await make();
  assert.equal(engine.playBoom(), false);                 // locked: nothing created
  engine.unlock();
  engine.setLevel(0); let n = f.all.length; assert.equal(engine.playBoom(), false); assert.equal(f.all.length, n);
  engine.setLevel(1); n = f.all.length; assert.equal(engine.playBoom(), true); assert.ok(f.all.length > n);
  engine.setMuted(true); n = f.all.length; assert.equal(engine.playBoom(), false); assert.equal(f.all.length, n);
  engine.setMuted(false); engine.setDucked(true); n = f.all.length; assert.equal(engine.playBoom(), false); assert.equal(f.all.length, n);
  engine.setDucked(false); engine.setLevel(2); assert.equal(engine.playBoom(), true);
  engine.stopAll();
});

test('playMeme: every meme sound plays at level >= 1, honours mute / ducking / level 0, unknown names are silent', async () => {
  const { f, engine } = await make();
  assert.deepEqual([...engine.MEME_SOUNDS].sort(), ['airhorn', 'boom', 'bruh', 'buzzer', 'ding', 'scratch', 'violin', 'wow']);
  assert.equal(engine.playMeme('airhorn'), false);        // locked
  engine.unlock(); engine.setLevel(1);
  for (const n of engine.MEME_SOUNDS) { const c = f.all.length; assert.equal(engine.playMeme(n), true, n); assert.ok(f.all.length > c, n); }
  for (const bad of ['none', 'nope', undefined, null, '__proto__']) { const c = f.all.length; assert.equal(engine.playMeme(bad), false); assert.equal(f.all.length, c); }
  engine.setLevel(0); assert.equal(engine.playMeme('ding'), false);
  engine.setLevel(2); engine.setMuted(true); assert.equal(engine.playMeme('ding'), false);
  engine.setMuted(false); engine.setDucked(true); assert.equal(engine.playMeme('buzzer'), false);
  engine.setDucked(false); assert.equal(engine.playMeme('buzzer'), true);
  engine.stopAll();
});
