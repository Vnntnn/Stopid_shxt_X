'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../web/fly-mimic.js'), 'utf8');
const MOCK = fs.readFileSync(path.join(__dirname, '../web/fly-mock.js'), 'utf8');
const toUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
const load = (mutate) => import(toUrl(mutate ? mutate(SRC) : SRC));
const loadMock = () => import(toUrl(MOCK));
function mutate(from, to) {
  return (src) => { assert.ok(src.includes(from), `mutation target missing: ${from}`); return src.replace(from, to); };
}

const STEP = 1000 / 15;
// Feed `ms` of the same pose; returns the last sample. noise = sigma on every coordinate (seeded).
function feed(m, pose, t0, ms, { noise = 0, seed = 1 } = {}) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / 0.7071; };
  let s = null, t = t0;
  for (; t <= t0 + ms; t += STEP) {
    const p = noise ? (typeof pose === 'function' ? pose(t - t0) : pose).map((q) => ({ ...q, x: q.x + g() * noise, y: q.y + g() * noise })) : (typeof pose === 'function' ? pose(t - t0) : pose);
    s = m.update({ ts: t, pose: p });
  }
  return { s, t };
}
async function setup(opts, mutateFn) {
  const { createMimic } = await load(mutateFn);
  const { standingPose } = await loadMock();
  const m = createMimic({ ...opts });
  return { m, pose: standingPose, mimicMod: null };
}
// a mimic that has finished calibrating on a still standing pose
async function calibrated(opts, mutateFn) {
  const env = await setup(opts, mutateFn);
  const r = feed(env.m, env.pose(), 0, 2200);
  assert.equal(env.m.calibrated, true);
  return { ...env, t: r.t };
}
const hold = (env, o, ms = 2500, extra) => feed(env.m, env.pose(o), env.t, ms, extra).s;

test('rig contract: clampRig fills, clamps and rejects NaN; blend and smooth stay in range', async () => {
  const { clampRig, blendRig, smoothRig, RIG_SPEC, IDLE_RIG, RIG_KEYS } = await load();
  const c = clampRig({ legL: 9, legR: -3, roll: NaN, wingL: Infinity, hop: 'x' });
  for (const k of RIG_KEYS) assert.ok(c[k] >= RIG_SPEC[k][0] && c[k] <= RIG_SPEC[k][1], k);
  assert.equal(c.legL, 1); assert.equal(c.legR, 0); assert.equal(c.roll, 0); assert.equal(c.hop, 0);
  assert.equal(c.wingL, IDLE_RIG.wingL, 'non-finite falls back to idle');
  const hi = clampRig({ roll: 5, squash: -5 }); assert.equal(hi.roll, 1); assert.equal(hi.squash, -1);
  assert.deepEqual(blendRig(IDLE_RIG, c, 0), { ...IDLE_RIG });
  assert.equal(blendRig(IDLE_RIG, c, 1).legL, 1);
  assert.equal(blendRig(IDLE_RIG, c, 7).legL, 1, 'weight clamps');
  let cur = { ...IDLE_RIG };
  for (let i = 0; i < 100; i++) { const n = smoothRig(cur, c, 0.016, 16); assert.ok(n.legL >= cur.legL && n.legL <= 1); cur = n; }
  assert.ok(cur.legL > 0.99);
});

test('leg and wing geometry is monotonic and bounded', async () => {
  const { legAngles, wingAngles } = await load();
  let prev = legAngles(0);
  for (let r = 0.1; r <= 1.0001; r += 0.1) { const a = legAngles(r); assert.ok(a.phi1 >= prev.phi1 && a.phi2 >= prev.phi2); prev = a; }
  assert.ok(legAngles(1).phi2 > 1.2, 'a raised forearm points up');
  assert.ok(legAngles(1, 0, 1).phi2 < legAngles(1, 0, 0).phi2, 'outward swing tips the forearm out');
  assert.ok(legAngles(0.5, 1).lowerScale < 1, 'curl shortens');
  const w0 = wingAngles(0), wm = wingAngles(0.45), w1 = wingAngles(1);
  assert.ok(w0.sweep > 1 && wm.sweep === 0 && w1.sweep === 0, 'folded = swept back');
  assert.ok(w1.lift > wm.lift && w1.twist > 0.9 && wm.twist === 0, 'up = lifted and turned to face the viewer');
});

test('One Euro filter: converges on a step without overshoot; smoother settings are slower', async () => {
  const { createOneEuro } = await load();
  const run = (mc) => { const f = createOneEuro({ minCutoff: mc }); const out = []; for (let i = 0; i < 40; i++) out.push(f.filter(i === 0 ? 0 : 1, i * STEP)); return out; };
  const fast = run(5), slow = run(0.5);
  for (const o of [fast, slow]) { for (let i = 1; i < o.length; i++) assert.ok(o[i] >= o[i - 1] - 1e-12 && o[i] <= 1 + 1e-9); }
  assert.ok(fast[39] > 0.98);
  assert.ok(slow[8] < fast[8], 'lower cutoff = smoother = slower');
});

test('raised hands: the person\'s right hand raises the screen-RIGHT leg when mirrored, and the sides flip when not', async () => {
  for (const [mirror, up, down] of [[true, 'legR', 'legL'], [false, 'legL', 'legR']]) {
    const env = await calibrated({ mirror });
    const s = hold(env, { rw: [0.37, 0.14], re: [0.38, 0.33] });
    assert.ok(s.rig[up] > 0.9, `${mirror}: ${up} ${s.rig[up]}`);
    assert.ok(s.rig[down] < 0.05, `${mirror}: ${down} stays down`);
  }
  const env = await calibrated({ mirror: true });
  const s = hold(env, { lw: [0.63, 0.14], le: [0.62, 0.33] });
  assert.ok(s.rig.legL > 0.9 && s.rig.legR < 0.05, 'left hand raises the screen-left leg');
});

test('wings: arms down = folded, T-pose = wide, hands above the head = up; ONE raised hand leaves the wings alone', async () => {
  const env = await calibrated({});
  let s = hold(env, {}, 1500);
  assert.ok(s.rig.wingL < 0.1 && s.rig.wingR < 0.1, 'arms down: folded');
  env.t += 1600;
  s = hold(env, { lw: [0.88, 0.45], rw: [0.12, 0.45], le: [0.74, 0.45], re: [0.26, 0.45] }, 2500);
  assert.ok(Math.abs(s.rig.wingL - 0.5) < 0.06 && Math.abs(s.rig.wingR - 0.5) < 0.06, `T-pose wide: ${s.rig.wingL}`);
  env.t += 2600;
  s = hold(env, { lw: [0.62, 0.12], rw: [0.38, 0.12], le: [0.62, 0.28], re: [0.38, 0.28] }, 2500);
  assert.ok(s.rig.wingL > 0.93 && s.rig.wingR > 0.93, `hands up: wings up ${s.rig.wingL}`);
  env.t += 2600;
  s = hold(env, { rw: [0.37, 0.14], re: [0.38, 0.33] }, 2500);
  assert.ok(s.rig.wingL < 0.2 && s.rig.wingR < 0.4 && s.rig.legR > 0.9, `one hand: leg not wings (${s.rig.wingR})`);
});

test('lean: shoulder tilt gives body roll with the right sign; mirror off flips it', async () => {
  for (const [mirror, sign] of [[true, 1], [false, -1]]) {
    const env = await calibrated({ mirror });
    // the person's RIGHT shoulder drops (tilt < 0 in the mock) = leaning right = screen-right down when mirrored
    let s = hold(env, { tilt: -0.035, shDx: -0.03 }, 2500);
    assert.ok(s.rig.roll * sign > 0.5, `${mirror}: right lean roll ${s.rig.roll}`);
    env.t += 2600;
    s = hold(env, { tilt: 0.035, shDx: 0.03 }, 2500);
    assert.ok(s.rig.roll * sign < -0.5, `${mirror}: left lean roll ${s.rig.roll}`);
  }
});

test('calibration: needs ~1.5 s of stillness, restarts when you move, and gates crouch and hop', async () => {
  const env = await setup({});
  const early = feed(env.m, env.pose(), 0, 1000);
  assert.equal(early.s.calibrated, false); assert.equal(early.s.status, 'calibrating'); assert.equal(early.s.statusText, 'Calibrating: stand still');
  // moving (a squat) before the baseline exists does nothing to the rig
  let s = feed(env.m, env.pose({ dy: 0.12 }), early.t, 800).s;
  assert.equal(s.rig.squash, 0);
  assert.equal(env.m.calibrated, false, 'the jump in height restarted the window');
  const r = feed(env.m, env.pose(), early.t + 900, 1800);
  assert.equal(r.s.calibrated, true); assert.equal(r.s.status, 'copying'); assert.equal(r.s.statusText, 'Copying you');
  assert.ok(Math.abs(env.m.baseline.sw - 0.16) < 0.005);
  env.m.recalibrate();
  assert.equal(env.m.calibrated, false);
  assert.equal(env.m.sample(r.t + 10).status, 'calibrating');
});

test('crouch squashes, jumping stretches and hops; a scale change freezes them', async () => {
  let env = await calibrated({});
  let s = hold(env, { dy: 0.12 }, 2500);
  assert.ok(s.rig.squash > 0.8 && s.rig.hop < -0.2, `squat ${s.rig.squash} ${s.rig.hop}`);
  env = await calibrated({});
  s = hold(env, { dy: -0.10 }, 2500);
  assert.ok(s.rig.hop > 0.8 && s.rig.squash < -0.4, `jump ${s.rig.hop} ${s.rig.squash}`);
  env = await calibrated({});
  s = hold(env, { dy: 0.12, scale: 1.5 }, 2500);
  assert.equal(Math.round(s.rig.squash * 100), 0, 'moved closer: vertical features are ignored');
});

test('dead zones: landmark jitter on a still person does nothing', async () => {
  const env = await calibrated({});
  const s = feed(env.m, env.pose(), env.t, 4000, { noise: 0.003, seed: 7 }).s;
  const r = s.rig;
  assert.ok(r.legL === 0 && r.legR === 0, 'legs');
  assert.ok(Math.abs(r.roll) < 1e-6 && r.squash === 0 && r.hop === 0, `roll/squash/hop ${r.roll} ${r.squash} ${r.hop}`);
  assert.ok(r.wingL < 0.08 && r.wingR < 0.08, 'wings');
  assert.ok(r.flapL < 0.2 && r.flapR < 0.2, 'flap');
  assert.ok(Math.abs(r.pitch) < 1e-6 && Math.abs(r.lookX) < 1e-6, `pitch ${r.pitch} look ${r.lookX} ${r.lookY}`);
});

test('landmarks lost: holds briefly, then decays to the idle pose and zero weight by the timeout', async () => {
  const { IDLE_RIG } = await load();
  const env = await calibrated({});
  let r = feed(env.m, env.pose({ rw: [0.37, 0.14], re: [0.38, 0.33] }), env.t, 2000);
  assert.ok(r.s.rig.legR > 0.9 && r.s.weight > 0.9);
  let t = r.t;
  const s1 = env.m.update({ ts: t + 200, pose: null });
  assert.ok(s1.rig.legR > 0.85, 'still holding after 200 ms');
  assert.equal(s1.status, 'copying');
  const s2 = env.m.update({ ts: t + 900, pose: null });
  assert.ok(s2.rig.legR < s1.rig.legR && s2.rig.legR > 0, 'decaying');
  assert.equal(s2.statusText, 'No body found');
  const s3 = env.m.update({ ts: t + 1700, pose: null });
  for (const k of Object.keys(IDLE_RIG)) assert.ok(Math.abs(s3.rig[k] - IDLE_RIG[k]) < 1e-9, `${k} idle`);
  const s4 = env.m.sample(t + 3000);
  assert.equal(s4.weight, 0);
  // and it comes back
  const back = feed(env.m, env.pose({ rw: [0.37, 0.14], re: [0.38, 0.33] }), t + 3100, 2000).s;
  assert.ok(back.rig.legR > 0.9 && back.weight > 0.9);
});

test('low visibility counts as lost; confidence fades the weight in and out without jumps', async () => {
  const env = await setup({});
  const good = env.pose();
  const bad = good.map((p, i) => (i === 11 || i === 12 ? { ...p, visibility: 0.2 } : p));
  const seq = [];
  let t = 0;
  for (; t < 1500; t += STEP) seq.push(env.m.update({ ts: t, pose: good }).weight);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1] - 1e-12, 'fade in is monotonic');
  assert.ok(seq[2] < 0.5 && seq[seq.length - 1] === 1, 'ramps up, then full');
  const out = [];
  for (const end = t + 2500; t < end; t += STEP) out.push(env.m.update({ ts: t, pose: bad }).weight);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] <= out[i - 1] + 1e-12 && out[i - 1] - out[i] < 0.2, 'fade out is gradual');
  assert.equal(out[out.length - 1], 0);
  assert.equal(env.m.sample(t).statusText, 'No body found');
});

test('paused and disabled: weight goes to zero, status says why', async () => {
  const env = await calibrated({});
  env.m.setPaused(true);
  let s = feed(env.m, env.pose(), env.t, 1200).s;
  assert.equal(s.weight, 0); assert.equal(s.status, 'paused');
  env.m.setPaused(false);
  s = feed(env.m, env.pose(), env.t + 1300, 1200).s;
  assert.ok(s.weight > 0.9);
  env.m.setEnabled(false);
  s = env.m.sample(env.t + 4000);
  assert.equal(s.status, 'off');
  assert.equal(env.m.gesture({ name: 'clap', ts: env.t + 4000 }), false);
});

test('smoothing: the setting slows the response and keeps it monotonic; convergence is reached', async () => {
  const at = async (smoothness, ms) => {
    const env = await calibrated({ smoothness });
    const seq = [];
    let t = env.t;
    for (; t <= env.t + ms; t += STEP) seq.push(env.m.update({ ts: t, pose: env.pose({ rw: [0.37, 0.14], re: [0.38, 0.33] }) }).rig.legR);
    return seq;
  };
  const snappy = await at(0, 2500), smooth = await at(1, 2500);
  for (const q of [snappy, smooth]) for (let i = 1; i < q.length; i++) assert.ok(q[i] >= q[i - 1] - 1e-9, 'never moves backwards');
  assert.ok(snappy[2] > smooth[2] + 0.03 && snappy[3] > smooth[3], `smoothness 1 lags (${snappy[2]} vs ${smooth[2]})`);
  assert.ok(snappy[snappy.length - 1] > 0.98 && smooth[smooth.length - 1] > 0.9, 'both converge');
});

test('clamping: absurd landmarks never leave the rig ranges', async () => {
  const { RIG_SPEC, RIG_KEYS } = await load();
  const env = await calibrated({});
  const crazy = env.pose({ rw: [9, -9], lw: [-9, 9], re: [5, -5], le: [-4, 4], tilt: 0.4, noseDx: 3 });
  const s = feed(env.m, crazy, env.t, 1500).s;
  for (const k of RIG_KEYS) assert.ok(Number.isFinite(s.rig[k]) && s.rig[k] >= RIG_SPEC[k][0] && s.rig[k] <= RIG_SPEC[k][1], `${k}=${s.rig[k]}`);
  const nan = env.pose().map((p) => ({ ...p, x: NaN }));
  const s2 = env.m.update({ ts: env.t + 5000, pose: nan });
  for (const k of RIG_KEYS) assert.ok(Number.isFinite(s2.rig[k]), k);
});

test('gesture events: clap snaps the wings shut then open, wave oscillates a leg, thumbs up lights a leg and glow', async () => {
  const env = await calibrated({});
  let cursor = env.t, base = env.t, last = null;
  const start = (ev) => { base = cursor; env.m.gesture({ ...ev, ts: base }); };
  const at = (dt) => { while (cursor < base + dt) { cursor += STEP; last = env.m.update({ ts: cursor, pose: env.pose() }); } return last; }; // standing frames keep coming
  const rest = (ms) => at(cursor - base + ms);
  start({ name: 'clap' });
  assert.ok(at(100).rig.wingL < 0.15 && at(100).rig.wingR < 0.15, 'closed');
  assert.ok(at(500).rig.wingL > 0.95, 'open');
  assert.ok(at(1900).rig.wingL < 0.2, 'released back to the body');
  rest(500);
  start({ name: 'wave', side: 'right' });
  const swings = []; let legsOk = false;
  for (let d = 300; d < 1500; d += 40) { const s = at(d); swings.push(s.rig.swingR); if (d === 620) legsOk = s.rig.legR > 0.8 && s.rig.legL < 0.1; }
  assert.ok(Math.max(...swings) > 0.5 && Math.min(...swings) < -0.5, 'swings both ways');
  assert.ok(legsOk, 'waving side up (person right = screen right)');
  rest(2500);
  start({ name: 'thumbs_up', side: 'left' });
  assert.ok(at(150).rig.glow > 0.7);
  assert.ok(at(500).rig.legL > 0.95);
  assert.ok(at(1200).rig.glow === 0, 'glow is a short pulse');
  rest(2000);
  start({ name: 'peace' });
  { const s = at(500).rig; assert.ok(s.legL > 0.8 && s.legR > 0.8 && s.swingL > 0.7 && s.swingR > 0.7, 'V'); }
  rest(2000);
  start({ name: 'fist' });
  const rolls = []; for (let d = 20; d < 480; d += 20) rolls.push(at(d).rig.roll);
  assert.ok(at(500).rig.curl > 0.9 && Math.max(...rolls) > 0.05 && Math.min(...rolls) < -0.05, 'curl and shake');
  rest(2000);
  start({ name: 'open_palm' });
  { const s = at(500).rig; assert.ok(Math.abs(s.wingL - 0.55) < 0.01 && s.flapL === 0, 'wings wide and frozen'); }
  rest(2000);
  start({ name: 'point_up' });
  assert.ok(at(750).rig.hop > 0.5, 'rises');
  rest(2000);
  start({ name: 'jump' });
  assert.ok(at(350).rig.hop > 0.7);
  assert.ok(at(1000).rig.hop < 0.05, 'a hop pulse');
  assert.equal(env.m.gesture({ name: 'unknown_thing', ts: cursor }), false);
});

test('mirror: gesture sides follow the person (left -> screen-left when mirrored, swapped otherwise)', async () => {
  for (const [mirror, key] of [[true, 'legL'], [false, 'legR']]) {
    const env = await calibrated({ mirror });
    env.m.gesture({ name: 'thumbs_up', side: 'left', ts: env.t });
    const s = env.m.sample(env.t + 500);
    assert.ok(s.rig[key] > 0.95, `${mirror} ${key}`);
  }
});

// ---- mutation checks: each one breaks the behaviour a test above pins, and that test must notice ----
test('mutation: flipping the mirror mapping is caught', async () => {
  const mut = mutate("(personSide === 'left') !== flip()", "(personSide === 'left') === flip()");
  const { createMimic } = await load(mut);
  const { standingPose } = await loadMock();
  const m = createMimic({ mirror: true });
  feed(m, standingPose(), 0, 2200);
  const s = feed(m, standingPose({ rw: [0.37, 0.14], re: [0.38, 0.33] }), 2300, 2500).s;
  assert.ok(!(s.rig.legR > 0.9 && s.rig.legL < 0.05), 'the mutant must fail the right-hand test');
});

test('mutation: reversing the roll sign is caught', async () => {
  const mut = mutate('r.roll = dz(rollP, 0.1 * k) * (S.mirror ? 1 : -1);', 'r.roll = dz(rollP, 0.1 * k) * (S.mirror ? -1 : 1);');
  const { createMimic } = await load(mut);
  const { standingPose } = await loadMock();
  const m = createMimic({ mirror: true });
  feed(m, standingPose(), 0, 2200);
  const s = feed(m, standingPose({ tilt: -0.035, shDx: -0.03 }), 2300, 2500).s;
  assert.ok(!(s.rig.roll > 0.5), 'the mutant must fail the right-lean test');
});

test('mutation: removing the dead zones is caught by the jitter test', async () => {
  const mut = (src) => mutate('const dz = (x, d) => { const a = Math.abs(x); return a <= d ? 0 :', 'const dz = (x, d) => { const a = Math.abs(x); return a <= 0 ? 0 :')(src);
  const { createMimic } = await load(mut);
  const { standingPose } = await loadMock();
  const m = createMimic({});
  feed(m, standingPose(), 0, 2200);
  const s = feed(m, standingPose(), 2300, 4000, { noise: 0.003, seed: 7 }).s;
  const quiet = s.rig.legL === 0 && s.rig.legR === 0 && Math.abs(s.rig.roll) < 1e-3 && s.rig.squash === 0 && s.rig.hop === 0;
  assert.ok(!quiet, 'the mutant must jitter');
});

test('mutation: a longer loss timeout is caught by the decay test', async () => {
  const mut = mutate('lostMs: 1500,', 'lostMs: 150000,');
  const { createMimic, IDLE_RIG } = await load(mut);
  const { standingPose } = await loadMock();
  const m = createMimic({});
  feed(m, standingPose(), 0, 2200);
  feed(m, standingPose({ rw: [0.37, 0.14], re: [0.38, 0.33] }), 2300, 2000);
  const s = m.update({ ts: 4300 + 1700, pose: null });
  assert.ok(Math.abs(s.rig.legR - IDLE_RIG.legR) > 0.5, 'the mutant is still holding the raised leg');
});
