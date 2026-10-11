'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const b64 = (f) => 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web', f), 'utf8')).toString('base64');
const loadG = () => import(b64('fly-gestures.js'));
const loadM = () => import(b64('fly-mock.js'));

// Run frames through a fresh engine; returns [events...] (all gestures).
async function play(frames, { sensitivity = 'normal', pre = [], configure } = {}) {
  const { createGestureEngine } = await loadG();
  const eng = createGestureEngine({ sensitivity });
  if (configure) configure(eng);
  const evs = [];
  for (const f of [...pre, ...frames]) for (const e of eng.update({ ts: f.ts, pose: f.pose, hands: f.hands, motion: f.motion })) evs.push(e);
  return evs;
}
async function scene(name, opts) { const m = await loadM(); return m.buildScene(name, opts); }
const names = (evs) => evs.map((e) => e.name);
// Standing still for `ms` before a scene gives jump/squat their history
const stand = async (ms, noise = 0) => { const m = await loadM(); return m.buildScene('wave', { rest: ms, amp: 0, tail: 0, noise }).frames.filter((f) => f.ts <= ms); };

const BODY_POS = [
  ['wave', 'wave', 0.2], ['hands_up', 'hands_up', 0.3], ['hand_up_left', 'hand_up_left', 0.25], ['hand_up_right', 'hand_up_right', 0.25],
  ['t_pose', 't_pose', 0.35], ['clap', 'clap', 0.2], ['lean_left', 'lean_left', 0.2], ['lean_right', 'lean_right', 0.2], ['jump', 'jump', 0.15], ['squat', 'squat', 0.3],
];

for (const [scn, expected, nearAmp] of BODY_POS) {
  test(`${scn}: clean sequence fires exactly that gesture once`, async () => {
    const s = await scene(scn);
    const evs = await play(s.frames);
    assert.deepEqual(names(evs), [expected], JSON.stringify(evs));
    assert.ok(evs[0].confidence > 0.5 && evs[0].confidence <= 1);
    assert.ok(evs[0].ts >= s.restMs, 'must not fire before the movement starts');
  });
  test(`${scn}: near miss (movement at ${nearAmp * 100}% size) does not fire`, async () => {
    const s = await scene(scn, { amp: nearAmp });
    assert.deepEqual(names(await play(s.frames)), []);
  });
  test(`${scn}: robust to landmark jitter (sigma 0.004) and still fires`, async () => {
    for (const seed of [1, 2, 3]) {
      const s = await scene(scn, { noise: 0.004, seed });
      const evs = await play(s.frames);
      assert.ok(names(evs).includes(expected), `seed ${seed}: ${JSON.stringify(names(evs))}`);
      assert.ok(names(evs).filter((n) => n === expected).length === 1, `seed ${seed} fired twice`);
    }
  });
}

test('every body gesture respects its cooldown, then fires again', async () => {
  const m = await loadM();
  for (const g of ['wave', 'hands_up', 'clap', 'lean_left', 'jump']) {
    const a = m.buildScene(g);
    const b = m.buildScene(g, { t0: a.endTs + 20, rest: 300 });          // second attempt a moment later: inside the cooldown or armed late
    const c = m.buildScene(g, { t0: b.endTs + 6000, rest: 2200 });       // well after the cooldown
    const evs = await play([...a.frames, ...b.frames, ...c.frames]);
    const n = names(evs).filter((x) => x === g).length;
    assert.ok(n >= 2 && n <= 4, `${g}: ${n}`);
    for (let i = 1; i < evs.length; i++) if (evs[i].name === evs[i - 1].name) assert.ok(evs[i].ts - evs[i - 1].ts >= 900, `${g} gap ${evs[i].ts - evs[i - 1].ts}`);
  }
});

test('cooldown: a held pose fires once, never repeatedly', async () => {
  const m = await loadM();
  const s = m.buildScene('hands_up', { tail: 0 });
  const held = s.frames.filter((f) => f.ts > s.restMs + 600).length;
  assert.ok(held > 5);
  const long = [...s.frames];
  const last = s.frames[s.frames.length - 1];
  for (let i = 1; i <= 120; i++) long.push({ ts: last.ts + i * 66.7, pose: last.pose, hands: undefined }); // hold the pose 8 more seconds
  assert.deepEqual(names(await play(long)), ['hands_up']);
});

test('jitter: a person standing still never triggers anything at any sensitivity', async () => {
  const m = await loadM();
  const { SENSITIVITIES } = await loadG();
  for (const sens of SENSITIVITIES) for (const noise of [0.003, 0.005, 0.007]) for (const seed of [1, 2, 3, 4]) {
    const s = m.buildScene('wave', { amp: 0, rest: 9000, tail: 0, noise, seed });
    const evs = await play(s.frames, { sensitivity: sens });
    assert.deepEqual(names(evs), [], `${sens} noise ${noise} seed ${seed}: ${JSON.stringify(evs)}`);
  }
});

test('jitter on a raised, steady hand (hand_up) never becomes a wave', async () => {
  const m = await loadM();
  for (const seed of [1, 2, 3]) {
    const s = m.buildScene('hand_up_right', { noise: 0.006, seed, amp: 1 });
    const evs = await play(s.frames, { sensitivity: 'high' });
    assert.ok(!names(evs).includes('wave'), JSON.stringify(names(evs)));
  }
});

test('a wave is not also reported as hand_up or open_palm', async () => {
  const m = await loadM();
  const s = m.buildScene('wave', { tail: 0 });
  const withPalm = s.frames.map((f, i) => ({ ...f, hands: i % 2 === 0 ? (f.ts > s.restMs ? [{ label: 'Open_Palm', score: 0.95 }] : []) : undefined }));
  const evs = await play(withPalm);
  assert.deepEqual(names(evs), ['wave']);
});

test('side of one-hand gestures: left hand up is "left", right is "right"; leans too', async () => {
  const L = await play((await scene('hand_up_left')).frames), R = await play((await scene('hand_up_right')).frames);
  assert.equal(L[0].side, 'left'); assert.equal(R[0].side, 'right');
  assert.equal((await play((await scene('lean_left')).frames))[0].side, 'left');
  assert.equal((await play((await scene('lean_right')).frames))[0].side, 'right');
});

test('jump: leaning toward the camera (shoulder width grows) is not a jump; slow standing-up is not a jump', async () => {
  const m = await loadM();
  const { standingPose } = m;
  const lean = [];
  for (let i = 0, t = 0; t < 4000; i++, t = i * 66.7) lean.push({ ts: t, pose: standingPose({ dy: -0.1 * Math.min(1, Math.max(0, (t - 2200) / 400)), scale: 1 + 0.5 * Math.min(1, Math.max(0, (t - 2200) / 400)) }) });
  assert.ok(!names(await play(lean)).includes('jump'));
  const slow = [];
  for (let i = 0, t = 0; t < 5000; i++, t = i * 66.7) slow.push({ ts: t, pose: standingPose({ dy: -0.1 * Math.min(1, Math.max(0, (t - 2000) / 2000)) }) });
  assert.ok(!names(await play(slow)).includes('jump'));
});

test('squat is not triggered right after a jump lands, and jump is not a squat', async () => {
  const m = await loadM();
  const a = m.buildScene('jump');
  const evs = await play(a.frames);
  assert.deepEqual(names(evs), ['jump']);
});

test('clap: hands resting together (praying) is not a clap', async () => {
  const m = await loadM();
  const frames = [];
  for (let i = 0, t = 0; t < 6000; i++, t = i * 66.7) frames.push({ ts: t, pose: m.standingPose({ lw: [0.51, 0.62], rw: [0.49, 0.62] }) });
  assert.deepEqual(names(await play(frames)), []);
});

test('lean: turning back (return to centre) re-arms, a second lean later fires again', async () => {
  const m = await loadM();
  const a = m.buildScene('lean_left'), b = m.buildScene('lean_left', { t0: a.endTs + 20, rest: 800 });
  const evs = await play([...a.frames, ...b.frames, ...m.buildScene('lean_left', { t0: b.endTs + 20, rest: 800 }).frames]);
  const n = names(evs).filter((x) => x === 'lean_left').length;
  assert.ok(n >= 2 && n <= 3, String(n));
});

test('sensitivity: borderline movement fires at high, not at low', async () => {
  const s = await scene('lean_left', { amp: 0.5 });          // nose offset about 0.4 sw: between low (0.6) and high (0.3)
  assert.deepEqual(names(await play(s.frames, { sensitivity: 'low' })), []);
  assert.deepEqual(names(await play(s.frames, { sensitivity: 'high' })), ['lean_left']);
  const j = await scene('jump', { amp: 0.5 });
  assert.deepEqual(names(await play(j.frames, { sensitivity: 'low' })), []);
  assert.ok(names(await play(j.frames, { sensitivity: 'high' })).includes('jump'));
});

test('threshold table: three levels everywhere, ordered from harder to easier', async () => {
  const { THRESHOLDS, thresholds, SENSITIVITIES } = await loadG();
  for (const [g, params] of Object.entries(THRESHOLDS)) for (const [k, v] of Object.entries(params)) assert.equal(v.length, 3, `${g}.${k}`);
  assert.ok(thresholds('low').wave.swing > thresholds('normal').wave.swing && thresholds('normal').wave.swing > thresholds('high').wave.swing);
  assert.ok(thresholds('low').jump.rise > thresholds('high').jump.rise);
  assert.ok(thresholds('low').hand.minScore > thresholds('high').hand.minScore);
  assert.deepEqual(thresholds('bogus'), thresholds('low') && thresholds('low'));
  assert.deepEqual(SENSITIVITIES, ['low', 'normal', 'high']);
});

// ---- hand-label gestures ----
const HANDS = { thumbs_up: 'Thumb_Up', thumbs_down: 'Thumb_Down', peace: 'Victory', open_palm: 'Open_Palm', fist: 'Closed_Fist', point_up: 'Pointing_Up', i_love_you: 'ILoveYou' };
function handFrames(label, { from = 0, ms = 1200, score = 0.92, gapAfter = 0, fps = 15 } = {}) {
  const out = []; const step = 1000 / fps;
  for (let i = 0, t = from; t <= from + ms + gapAfter; i++, t = from + i * step) out.push({ ts: t, pose: null, hands: i % 2 === 0 ? (t <= from + ms ? [{ label, score }] : []) : undefined });
  return out;
}
for (const [name, label] of Object.entries(HANDS)) {
  test(`${name}: stable ${label} fires once; a flicker, a weak score or a different label does not`, async () => {
    assert.deepEqual(names(await play(handFrames(label))), [name]);
    assert.deepEqual(names(await play(handFrames(label, { ms: 150 }))), []);                 // flicker
    assert.deepEqual(names(await play(handFrames(label, { score: 0.4 }))), []);              // weak
    // alternating labels never reach the hold time
    const other = label === 'Closed_Fist' ? 'Victory' : 'Closed_Fist';
    const alt = []; for (let i = 0; i < 40; i++) alt.push({ ts: i * 133, pose: null, hands: [{ label: i % 2 ? label : other, score: 0.95 }] });
    assert.ok(!names(await play(alt)).includes(name));
  });
  test(`${name}: cooldown and re-arm after the hand leaves`, async () => {
    const H = name === 'open_palm' ? 800 : 350;                                              // hold time of that gesture
    const a = handFrames(label, { ms: H + 80, gapAfter: 450 });
    const b = handFrames(label, { from: H + 600, ms: H + 400, gapAfter: 600 });             // hand left and came back: re-armed but inside the cooldown
    const c = handFrames(label, { from: 8000, ms: H + 300 });                                // well after
    const evs = await play([...a, ...b, ...c]);
    assert.deepEqual(names(evs), [name, name]);
    assert.ok(evs[1].ts > 5000);
  });
}
test('hand gesture held forever fires once; jitter in score does not matter', async () => {
  const f = []; for (let i = 0; i < 300; i++) f.push({ ts: i * 100, pose: null, hands: [{ label: 'Thumb_Up', score: 0.8 + ((i * 37) % 10) / 100 }] });
  assert.deepEqual(names(await play(f)), ['thumbs_up']);
});
test('hand gesture hold time grows with an extra hold (used by "ask" actions)', async () => {
  const f = handFrames('Thumb_Up', { ms: 1500 });
  const evs = await play(f, { configure: (e) => e.setExtraHold({ thumbs_up: 800 }) });
  assert.equal(evs.length, 1);
  assert.ok(evs[0].heldMs >= 800, String(evs[0].heldMs));
  assert.deepEqual(names(await play(handFrames('Thumb_Up', { ms: 600 }), { configure: (e) => e.setExtraHold({ thumbs_up: 800 }) })), []);
});
test('disabled gestures emit nothing', async () => {
  const s = await scene('hands_up');
  assert.deepEqual(names(await play(s.frames, { configure: (e) => e.setEnabled(['wave']) })), []);
});

// ---- no-pose fallback ----
test('motion-only fallback: sustained motion energy without a pose emits a low-confidence wave; noise floor does not', async () => {
  const mk = (energy, ms = 2500) => { const f = []; for (let i = 0, t = 0; t < ms; i++, t = i * 66.7) f.push({ ts: t, pose: null, motion: energy }); return f; };
  const evs = await play(mk(0.12));
  assert.equal(evs.length, 1); assert.equal(evs[0].name, 'wave'); assert.equal(evs[0].source, 'motion'); assert.ok(evs[0].confidence < 0.8);
  assert.deepEqual(names(await play(mk(0.008, 8000))), []);
  assert.deepEqual(names(await play(mk(0.12, 200))), []);
});
test('motion energy is ignored while a pose is tracked', async () => {
  const s = await scene('wave', { amp: 0, rest: 3000, tail: 0 });
  assert.deepEqual(names(await play(s.frames.map((f) => ({ ...f, motion: 0.3 })))), []);
});

// ---- helpers ----
test('countReversals: counts strokes above the swing, ignores jitter', async () => {
  const { countReversals } = await loadG();
  const sine = (cycles, amp, n = 60) => Array.from({ length: n }, (_, i) => Math.sin((i / n) * cycles * 2 * Math.PI) * amp);
  assert.equal(countReversals(sine(2, 0.05), 0.04).count, 3);
  assert.equal(countReversals(sine(2, 0.01), 0.04).count, 0);
  assert.equal(countReversals([0.5, 0.5, 0.5], 0.01).count, 0);
  assert.equal(countReversals([], 0.1).count, 0);
});
test('frameDiffEnergy / rgbaToLuma', async () => {
  const { frameDiffEnergy, rgbaToLuma } = await loadG();
  const a = new Uint8Array(100).fill(100), b = new Uint8Array(100).fill(100);
  assert.equal(frameDiffEnergy(a, b), 0);
  for (let i = 0; i < 25; i++) b[i] = 200;
  assert.equal(frameDiffEnergy(a, b), 0.25);
  for (let i = 25; i < 100; i++) b[i] = 110;                      // small change below the pixel threshold
  assert.equal(frameDiffEnergy(a, b), 0.25);
  assert.equal(frameDiffEnergy(a, new Uint8Array(3)), 0);
  const l = rgbaToLuma(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]));
  assert.ok(l[0] >= 254 && l[1] === 0);
});
test('engine tolerates garbage input', async () => {
  const { createGestureEngine } = await loadG();
  const e = createGestureEngine();
  assert.deepEqual(e.update({ ts: NaN }), []);
  assert.deepEqual(e.update({ ts: 1, pose: [] }), []);
  assert.deepEqual(e.update({ ts: 2, pose: Array.from({ length: 33 }, () => ({ x: NaN, y: 0 })) }), []);
  assert.deepEqual(e.update({ ts: 3, pose: null, hands: [null, { label: 'Nope', score: 1 }, {}] }), []);
  assert.deepEqual(e.update({ ts: 1 }), []);                     // clock going backwards resets, no throw
});

// ---- mock timeline: every gesture exactly once, in order ----
test('mock camera timeline triggers every gesture exactly once through the real engine', async () => {
  const m = await loadM(); const { createGestureEngine, GESTURES } = await loadG();
  const tl = m.buildTimeline();
  const eng = createGestureEngine();
  const got = [];
  for (let k = 0, t = 0; t < tl.totalMs; k++, t = k * 66.7) {
    const f = m.mockFrameAt(tl, t);
    for (const e of eng.update({ ts: t, pose: f.pose, hands: k % 2 === 0 ? f.hands : undefined })) got.push(e.name);
  }
  assert.deepEqual(got, m.MOCK_ORDER, JSON.stringify(got));
  assert.deepEqual([...new Set(got)].sort(), [...GESTURES].sort());
});

// ---- actions mapping ----
test('default actions follow the brief', async () => {
  const { defaultActionsConfig, GESTURES } = await loadG();
  const c = defaultActionsConfig();
  assert.equal(c.askEnabled, false);
  assert.deepEqual(Object.keys(c.rows).sort(), [...GESTURES].sort());
  assert.deepEqual(c.rows.thumbs_up, { meme: true, action: 'replay' });
  assert.equal(c.rows.wave.action, 'fly'); assert.equal(c.rows.wave.meme, true);
  assert.equal(c.rows.jump.action, 'fly'); assert.equal(c.rows.jump.meme, true);
  assert.deepEqual(c.rows.hands_up, { meme: true, action: 'none' });
  assert.deepEqual(c.rows.peace, { meme: true, action: 'none' });
  assert.deepEqual(c.rows.clap, { meme: true, action: 'fly' });
  assert.equal(c.rows.lean_left.action, 'fly'); assert.equal(c.rows.lean_right.action, 'fly');
  for (const r of Object.values(c.rows)) assert.notEqual(r.action, 'ask');
});
test('normalizeActionsConfig repairs corrupt storage and never enables ask by accident', async () => {
  const { normalizeActionsConfig, defaultActionsConfig } = await loadG();
  assert.deepEqual(normalizeActionsConfig(null), defaultActionsConfig());
  assert.deepEqual(normalizeActionsConfig('x'), defaultActionsConfig());
  const c = normalizeActionsConfig({ sensitivity: 'ultra', askEnabled: 'yes', rows: { wave: { meme: 'maybe', action: 'rm -rf' }, bogus: { meme: true }, jump: { meme: false, action: 'mute' } } });
  assert.equal(c.sensitivity, 'normal'); assert.equal(c.askEnabled, false);
  assert.deepEqual(c.rows.wave, defaultActionsConfig().rows.wave);
  assert.deepEqual(c.rows.jump, { meme: false, action: 'mute' });
  assert.ok(!('bogus' in c.rows));
  assert.equal(normalizeActionsConfig({ askEnabled: true }).askEnabled, true);
});
test('planAction: meme and fly reaction mapping', async () => {
  const { defaultActionsConfig, planAction } = await loadG();
  const c = defaultActionsConfig();
  assert.deepEqual(planAction(c, { name: 'wave', ts: 1 }), { gesture: 'wave', meme: true, action: 'fly', reaction: 'startled', blocked: null });
  assert.equal(planAction(c, { name: 'clap', ts: 1 }).reaction, 'spin');
  assert.equal(planAction(c, { name: 'jump', ts: 1 }).reaction, 'startled');
  assert.equal(planAction(c, { name: 'lean_left', ts: 1 }).reaction, 'lean_left');
  assert.equal(planAction(c, { name: 'lean_left', ts: 1 }).meme, false);
  assert.equal(planAction(c, { name: 'thumbs_up', ts: 1 }).action, 'replay');
  assert.equal(planAction(c, { name: 'nope', ts: 1 }).ignored, true);
});
test('planAction: "ask" needs the master toggle, a 0.8 s hold and a 10 s cooldown', async () => {
  const { defaultActionsConfig, planAction, requiredHolds, ASK_HOLD_MS, ASK_COOLDOWN_MS } = await loadG();
  const c = defaultActionsConfig();
  c.rows.thumbs_up.action = 'ask';
  const ev = { name: 'thumbs_up', ts: 100000, heldMs: 900 };
  assert.equal(planAction(c, ev).blocked, 'ask-disabled'); assert.equal(planAction(c, ev).action, 'none');
  assert.deepEqual(requiredHolds(c), {});
  c.askEnabled = true;
  assert.deepEqual(requiredHolds(c), { thumbs_up: ASK_HOLD_MS });
  assert.equal(planAction(c, ev).action, 'ask'); assert.equal(planAction(c, ev).blocked, null);
  assert.equal(planAction(c, { ...ev, heldMs: 400 }).blocked, 'ask-hold');
  assert.equal(planAction(c, { ...ev, heldMs: undefined }).blocked, 'ask-hold');
  assert.equal(planAction(c, ev, { lastAskTs: 100000 - ASK_COOLDOWN_MS + 1 }).blocked, 'ask-cooldown');
  assert.equal(planAction(c, ev, { lastAskTs: 100000 - ASK_COOLDOWN_MS }).action, 'ask');
  // the Test button is a dry run: never asks, even with the master toggle off
  c.askEnabled = false;
  const t = planAction(c, { name: 'thumbs_up', ts: 1 }, { test: true });
  assert.equal(t.action, 'ask'); assert.equal(t.dryRun, true);
  // jump/wave/clap carry no hold, so they can never trigger an ask
  c.askEnabled = true; c.rows.jump.action = 'ask';
  assert.equal(planAction(c, { name: 'jump', ts: 1e6 }).blocked, 'ask-hold');
});
