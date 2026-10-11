'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/fly-memes.js'), 'utf8')).toString('base64'));
const loadG = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/fly-gestures.js'), 'utf8')).toString('base64'));
const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../web/memes/memes.json'), 'utf8'));
const MEMES_DIR = path.join(__dirname, '../web/memes');
const SPEED_NAMES = ['normal', 'fast', 'ultra'];
const EMOJI = /\p{Extended_Pictographic}/u;

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- manifest
test('shipped manifest: parses cleanly, every gesture has variants, PNG files exist, mapping follows the brief, no emoji', async () => {
  const { parseManifest, GESTURE_NAMES, SOUNDS } = await load();
  const { GESTURES } = await loadG();
  assert.deepEqual([...GESTURE_NAMES].sort(), [...GESTURES].sort(), 'meme and gesture lists must agree');
  const raw = shipped();
  const r = parseManifest(raw);
  assert.deepEqual(r.errors, []);
  for (const g of GESTURES) assert.ok(r.byGesture[g] && r.byGesture[g].length >= (g === 'belly_rub' ? 1 : 3), `too few memes for ${g}`);
  const caption = (g) => r.byGesture[g].map((e) => e.caption.toUpperCase());
  const has = (g, text) => assert.ok(caption(g).some((c) => c.includes(text.toUpperCase())), `${g} should include ${text}: ${caption(g)}`);
  for (const t of ['SIUUUU', "LET'S GOOOO", 'ว้าวซ่า']) has('jump', t);
  for (const t of ['ปังมาก', 'GG EZ']) has('hands_up', t);
  has('t_pose', 'T-POSE'); has('t_pose', '+1000 AURA');
  for (const t of ['GG EZ', '555555', 'งานดี']) has('clap', t);
  for (const t of ['SHEESH', 'HELLO']) has('wave', t);
  for (const t of ['+1000 AURA', 'ปังมาก', 'BASED']) has('thumbs_up', t);
  for (const t of ['BRUH', 'L + RATIO']) has('thumbs_down', t);
  assert.ok(r.byGesture.thumbs_down.some((e) => e.src === 'images/son/son-son-meme.png') && r.byGesture.squat.some((e) => e.src === 'images/son/son-son-meme.png'));
  assert.ok(r.byGesture.any.some((e) => e.src === 'images/son/images.jpg') && r.byGesture.any.some((e) => e.src === 'images/son/imagescharlie.jpg'));
  for (const t of ['SIGMA', 'จึ้งอ่ะ']) has('peace', t);
  for (const t of ['COOKED', 'CRASHOUT', 'ตึงมาก']) has('fist', t);
  for (const t of ['WELL ACTUALLY', 'ถามหน่อย']) has('point_up', t);
  for (const t of ['TALK TO THE HAND', 'ใจเย็นๆ']) has('open_palm', t);
  for (const t of ['ฟินเว่อร์', 'ROCK ON']) has('i_love_you', t);
  for (const t of ['SKILL ISSUE', 'ไม่ไหวแล้ววว']) has('squat', t);
  for (const g of ['lean_left', 'lean_right']) { has(g, 'MEWING'); has(g, 'NPC MOMENT'); }
  for (const g of ['hand_up_left', 'hand_up_right']) { has(g, 'ถามหน่อย'); has(g, "I'MA LET YOU FINISH"); }
  const belly = r.byGesture.belly_rub[0];
  assert.deepEqual([belly.type, belly.src, belly.centered, belly.noJitter], ['image', 'png/belly-man.png', true, true]);
  const pngs = new Set();
  for (const list of Object.values(r.byGesture)) for (const e of list) {
    assert.equal(e.type, 'image');
    assert.ok(SOUNDS.includes(e.sound));
    if (e.src.startsWith('png/')) { pngs.add(e.src); assert.ok(fs.existsSync(path.join(MEMES_DIR, e.src)), `${e.src} missing`); }
  }
  assert.ok(pngs.size >= 45, `only ${pngs.size} distinct generated PNGs are wired in`);
  assert.ok(!EMOJI.test(JSON.stringify(raw)), 'memes.json must not contain emoji');
  assert.ok(!/"emoji"\s*:/.test(fs.readFileSync(path.join(MEMES_DIR, 'memes.json'), 'utf8')));
  assert.ok(new Set(Object.values(r.byGesture).flat().map((e) => e.sound)).size >= 7, 'the synthesized sounds are actually used');
});

test('captions.js: no emoji anywhere except the one deliberate belly-man slap; >= 48 PNGs in the right size range', () => {
  const src = fs.readFileSync(path.join(MEMES_DIR, 'captions.js'), 'utf8');
  const win = {}; new Function('window', src)(win);
  assert.ok(win.MEMES.length >= 48);
  for (const m of win.MEMES) {
    const t = [m.text, m.text2, m.head].filter(Boolean).join(' ');
    if (m.id === 'belly-man') { assert.equal(m.text, '\u{1FAC3}'); continue; }
    assert.ok(!EMOJI.test(t), `${m.id} contains an emoji`);
    assert.ok(m.size[0] >= 480 && m.size[0] <= 720 && m.size[1] >= 480 && m.size[1] <= 720, m.id);
  }
  assert.equal(new Set(win.MEMES.map((m) => m.id)).size, win.MEMES.length, 'duplicate ids');
  for (const m of win.MEMES) assert.ok(fs.existsSync(path.join(MEMES_DIR, 'png', m.id + '.png')), `${m.id}.png not generated`);
  assert.ok(fs.readdirSync(path.join(MEMES_DIR, 'png')).filter((f) => f.endsWith('.png')).length >= 48);
});

test('parseManifest: malformed entries are reported and skipped, never thrown', async () => {
  const { parseManifest } = await load();
  for (const bad of [null, undefined, 5, 'x', [], [1], true]) { const r = parseManifest(bad); assert.equal(r.count, 0); assert.ok(r.errors.length === 1); }
  const r = parseManifest({
    _comment: 'ignored',
    wave: [
      { type: 'card', caption: 'OK' },
      { type: 'card' },                                          // no caption
      { type: 'card', caption: 'X'.repeat(60) },                 // too long
      { type: 'video', caption: 'nope' },                        // bad type
      null, 7, 'str', [],                                        // not objects
      { type: 'card', caption: 'THEME', colorTheme: 'neon' },    // bad theme -> default, still shown
      { type: 'card', caption: 'SND', sound: 'bang' },
      { type: 'card', caption: 'EMO', emoji: 'x' },              // emoji are not supported: ignored with a note
      { type: 'image', src: 'png/a.png', caption: 'c', sound: 'airhorn', centered: true },
    ],
    clap: 'not an array',
    jump: { type: 'card', caption: 'obj' },
    flying: [{ type: 'card', caption: 'X' }],                    // unknown gesture
    any: [{ type: 'image', src: 'x/y.webp', caption: 'wild' }],
    __proto__: { evil: true },
  });
  assert.deepEqual(r.byGesture.wave.map((e) => e.caption), ['OK', 'THEME', 'SND', 'EMO', 'c']);
  assert.equal(r.byGesture.wave[1].colorTheme, 'grape');
  assert.equal(r.byGesture.wave[2].sound, 'none');
  assert.ok(!('emoji' in r.byGesture.wave[3]));
  assert.deepEqual([r.byGesture.wave[4].sound, r.byGesture.wave[4].centered, r.byGesture.wave[4].noJitter], ['airhorn', true, true]);
  assert.equal(r.byGesture.any.length, 1);
  assert.ok(!('clap' in r.byGesture) && !('jump' in r.byGesture) && !('flying' in r.byGesture));
  assert.ok(r.errors.length >= 9);
  assert.equal(({}).evil, undefined);
});

test('parseManifest: image entries only accept relative files inside web/memes (no GIF here: that is the opt-in path)', async () => {
  const { parseManifest, imageUrl } = await load();
  const good = ['a.png', 'sub/b.JPG', 'my meme.jpeg', 'c-d_e.webp', 'x.avif', 'y.svg', 'png/siuuuu.png'];
  const bad = ['/etc/passwd.png', '../a.png', 'a/../../b.png', 'http://evil/x.png', 'https://x.png', '//cdn/x.png', 'javascript:alert(1).png', 'a.exe', 'a.png.exe', '', 'a.html', 'data:image/png;base64,AAAA.png', 'a\\b.png', '.png', 'a.gif'];
  const mk = (l) => l.map((src) => ({ type: 'image', src, caption: 'c' }));
  const r = parseManifest({ wave: mk(good), clap: mk(bad.slice(0, 7)), jump: mk(bad.slice(7, 12)), peace: mk(bad.slice(12)) });
  assert.deepEqual(r.byGesture.wave.map((e) => e.src), good);
  assert.ok(!('clap' in r.byGesture) && !('jump' in r.byGesture) && !('peace' in r.byGesture));
  assert.equal(r.errors.length, bad.length);
  assert.equal(imageUrl('sub/my meme.png'), '/static/memes/sub/my%20meme.png');
  assert.equal(parseManifest({ wave: [{ type: 'image', caption: 'no src' }] }).count, 0);
});

test('parseManifest caps entries per gesture', async () => {
  const { parseManifest, MAX_PER_GESTURE } = await load();
  const r = parseManifest({ wave: Array.from({ length: 40 }, (_, i) => ({ type: 'card', caption: 'C' + i })) });
  assert.equal(r.byGesture.wave.length, MAX_PER_GESTURE);
  assert.ok(r.errors.length === 1);
});

// ---------------------------------------------------------------- chooser
test('chooseMeme / pickMeme: never the same meme twice in a row; empty, unknown gestures and wildcards behave', async () => {
  const { parseManifest, pickMeme, chooseMeme, memeKey } = await load();
  const { byGesture } = parseManifest({ wave: [{ type: 'card', caption: 'A' }, { type: 'card', caption: 'B' }], clap: [{ type: 'card', caption: 'ONLY' }], any: [{ type: 'card', caption: 'WILD' }] });
  let last = null;
  const seen = new Set();
  for (let i = 0; i < 300; i++) { const p = pickMeme(byGesture, 'wave', Math.random, last); assert.notEqual(p.key, last); last = p.key; seen.add(p.entry.caption); }
  assert.deepEqual([...seen].sort(), ['A', 'B', 'WILD'], 'the wildcard pool is used too');
  assert.equal(pickMeme(null, 'wave'), null);
  assert.equal(pickMeme({}, 'wave'), null);
  assert.equal(pickMeme(byGesture, 'constructor').entry.caption, 'WILD');
  // a single choice may repeat (there is nothing else to show)
  const one = [{ type: 'card', caption: 'X' }];
  assert.equal(chooseMeme(one, Math.random, memeKey(one[0])).entry.caption, 'X');
  assert.equal(chooseMeme([], Math.random), null);
  // deterministic worst case: an rng that always returns 0 would repeat forever without the filter
  let k = null; const two = [{ type: 'card', caption: 'A' }, { type: 'card', caption: 'B' }];
  const order = []; for (let i = 0; i < 6; i++) { const p = chooseMeme(two, () => 0, k); order.push(p.entry.caption); k = p.key; }
  assert.deepEqual(order, ['A', 'B', 'A', 'B', 'A', 'B']);
});

test('theme colours are mid/dark: no near-white flashes, moderate contrast with the page', async () => {
  const { THEMES, relLuminance, contrastRatio } = await load();
  for (const [name, stops] of Object.entries(THEMES)) for (const c of stops) {
    const L = relLuminance(c);
    assert.ok(L >= 0.02 && L <= 0.25, `${name} ${c} luminance ${L}`);
    assert.ok(contrastRatio(c, '#05070f') <= 6, `${name} ${c} contrast vs page ${contrastRatio(c, '#05070f')}`);
    assert.ok(contrastRatio(c, '#ffffff') >= 4.5, `${name} ${c}: white caption must stay readable`);
  }
  assert.ok(Number.isNaN(relLuminance('nope')));
});

// ---------------------------------------------------------------- placement
test('slapPlacement: stays on screen, rotation within +-14, size 22-42 % of the shorter side, never above 60 % of the viewport', async () => {
  const { slapPlacement, SIZE_FRAC, MAX_ROTATE, MAX_VIEWPORT_FRAC } = await load();
  const rnd = lcg(7);
  const viewports = [[1360, 800], [390, 780], [1920, 1080], [800, 800], [320, 568], [2560, 600], [600, 2400], [1024, 768], [200, 200]];
  const images = [[600, 600], [720, 480], [480, 720], [640, 640], [498, 449], [596, 335], [1, 1], [4000, 300], [300, 4000]];
  let rotMax = 0, fMin = 9, fMax = 0;
  for (const [vw, vh] of viewports) for (const [iw, ih] of images) for (let i = 0; i < 400; i++) {
    const p = slapPlacement({ w: vw, h: vh }, { w: iw, h: ih }, rnd);
    const rad = Math.abs(p.rotate) * Math.PI / 180;
    const bw = p.width * Math.cos(rad) + p.height * Math.sin(rad), bh = p.width * Math.sin(rad) + p.height * Math.cos(rad);
    const cx = p.left + p.width / 2, cy = p.top + p.height / 2;
    const tag = `${vw}x${vh} ${iw}x${ih} ${JSON.stringify(p)}`;
    assert.ok(cx - bw / 2 >= -1e-6 && cx + bw / 2 <= vw + 1e-6 && cy - bh / 2 >= -1e-6 && cy + bh / 2 <= vh + 1e-6, 'off screen: ' + tag);
    assert.ok(Math.abs(p.rotate) <= MAX_ROTATE + 1e-9, tag); rotMax = Math.max(rotMax, Math.abs(p.rotate));
    assert.ok(Math.abs(p.width / p.height - iw / ih) < 1e-6 * (iw / ih) + 1e-9, 'aspect: ' + tag);
    assert.ok(p.width <= MAX_VIEWPORT_FRAC * vw + 1e-6 && p.height <= MAX_VIEWPORT_FRAC * vh + 1e-6, '60 %: ' + tag);
    const f = Math.max(p.width, p.height) / Math.min(vw, vh);
    assert.ok(f <= SIZE_FRAC[1] + 1e-9, 'too big: ' + tag);
    const capped = Math.abs(p.width - MAX_VIEWPORT_FRAC * vw) < 1e-6 || Math.abs(p.height - MAX_VIEWPORT_FRAC * vh) < 1e-6;
    assert.ok(capped || f >= SIZE_FRAC[0] - 1e-9, 'too small: ' + tag);
    if (!capped) { fMin = Math.min(fMin, f); fMax = Math.max(fMax, f); }
  }
  assert.ok(rotMax > 13, 'rotation range is really used');
  assert.ok(fMin < 0.24 && fMax > 0.4, `size range is really used ${fMin} ${fMax}`);
  const spots = new Set(); for (let i = 0; i < 50; i++) { const p = slapPlacement({ w: 1360, h: 800 }, { w: 600, h: 600 }, rnd); spots.add(Math.round(p.left / 20)); }
  assert.ok(spots.size > 10, 'the position is random');
});

test('slapPlacement: reduced motion has no rotation and no size jitter; centered / noJitter slaps are upright and dead centre', async () => {
  const { slapPlacement, CENTERED_FRAC } = await load();
  const rnd = lcg(3);
  const sizes = new Set();
  for (let i = 0; i < 100; i++) {
    const p = slapPlacement({ w: 1360, h: 800 }, { w: 600, h: 600 }, rnd, { reduced: true });
    assert.equal(p.rotate, 0); sizes.add(p.width.toFixed(3));
  }
  assert.equal(sizes.size, 1, 'size must not jitter under reduced motion');
  const c = slapPlacement({ w: 1000, h: 700 }, { w: 720, h: 720 }, rnd, { centered: true });
  assert.equal(c.rotate, 0);
  assert.ok(Math.abs(c.left + c.width / 2 - 500) < 1e-9 && Math.abs(c.top + c.height / 2 - 350) < 1e-9);
  assert.ok(Math.abs(c.width / 700 - CENTERED_FRAC) < 1e-9 && CENTERED_FRAC >= 0.5 && CENTERED_FRAC <= 0.6);
  const tall = slapPlacement({ w: 390, h: 780 }, { w: 720, h: 720 }, rnd, { centered: true });
  assert.ok(tall.width <= 0.6 * 390 + 1e-9 && Math.abs(tall.left + tall.width / 2 - 195) < 1e-9);
  const nj = slapPlacement({ w: 1000, h: 700 }, { w: 600, h: 600 }, rnd, { noJitter: true });
  assert.equal(nj.rotate, 0);
  for (const [v, i] of [[{ w: 0, h: 0 }, { w: 0, h: 0 }], [null, null], [{ w: NaN, h: 5 }, { w: 'x' }]]) { const p = slapPlacement(v, i, rnd); for (const k of ['width', 'height', 'left', 'top', 'rotate']) assert.ok(Number.isFinite(p[k]), k); }
});

// ---------------------------------------------------------------- speeds + limiter
test('speed table: Normal / Fast / ULTRA durations, gaps and stacking', async () => {
  const { SPEEDS, normSpeed, DEFAULT_SPEED, MAX_STARTS_PER_WINDOW, WINDOW_MS, CUT_MS } = await load();
  assert.deepEqual(Object.keys(SPEEDS), SPEED_NAMES);
  assert.deepEqual([SPEEDS.normal.durationMs, SPEEDS.fast.durationMs, SPEEDS.ultra.durationMs], [1000, 750, 550]);
  assert.deepEqual([SPEEDS.normal.gapMs, SPEEDS.fast.gapMs, SPEEDS.ultra.gapMs], [1200, 800, 500]);
  assert.deepEqual([SPEEDS.normal.maxStack, SPEEDS.fast.maxStack, SPEEDS.ultra.maxStack], [1, 1, 2]);
  assert.equal(DEFAULT_SPEED, 'normal'); assert.equal(MAX_STARTS_PER_WINDOW, 2); assert.equal(WINDOW_MS, 1000); assert.ok(CUT_MS <= 60);
  for (const bad of [undefined, null, 'turbo', 5, '__proto__', 'constructor']) assert.equal(normSpeed(bad), 'normal');
  for (const s of SPEED_NAMES) assert.equal(normSpeed(s), s);
  for (const s of ['normal', 'fast']) assert.ok(SPEEDS[s].durationMs <= SPEEDS[s].gapMs, `${s}: without stacking a slap is gone before the next may start`);
});

test('limiter: gap between starts, window cap inclusive, retry hints (injected clock)', async () => {
  const { createMemeLimiter } = await load();
  let t = 10000;
  const lim = createMemeLimiter({ now: () => t, gapMs: 1200 });
  assert.equal(lim.tryAcquire().ok, true);
  t += 1199; const r1 = lim.tryAcquire(); assert.equal(r1.ok, false); assert.equal(r1.reason, 'cooldown'); assert.equal(r1.retryInMs, 1);
  t += 1; assert.equal(lim.tryAcquire().ok, true);              // 1200 after the first
  lim.reset(); t = 0; lim.setGap(500);
  assert.equal(lim.tryAcquire().ok, true); t = 500; assert.equal(lim.tryAcquire().ok, true);
  t = 1000; const r2 = lim.tryAcquire(); assert.equal(r2.ok, false); assert.equal(r2.reason, 'rate'); // 0, 500, 1000 would be 3 in a closed 1 s window
  t = 1001; assert.equal(lim.tryAcquire().ok, true);
  lim.reset(); assert.equal(lim.tryAcquire().ok, true);
  assert.equal(lim.gap, 500);
});

test('SAFETY: hammering for simulated minutes never lets more than 2 slaps start in any 1 s window, at every speed', async () => {
  const { createMemeLimiter, maxInWindow, SPEEDS } = await load();
  for (const speed of SPEED_NAMES) for (const seed of [1, 2, 3]) {
    let t = 0;
    const rnd = lcg(seed * 977);
    const lim = createMemeLimiter({ now: () => t, gapMs: SPEEDS[speed].gapMs });
    const ok = [];
    for (let i = 0; i < 400000; i++) {                          // ~ 40 minutes of virtual time in bursts and lulls
      t += rnd() < 0.6 ? rnd() * 3 : rnd() * 300;
      if (lim.tryAcquire().ok) ok.push(t);
    }
    assert.ok(ok.length > 1000, `${speed}: the limiter must still let memes through (${ok.length})`);
    assert.ok(maxInWindow(ok, 1000) <= 2, `${speed}: ${maxInWindow(ok, 1000)} slaps in one second`);
    for (let i = 1; i < ok.length; i++) assert.ok(ok[i] - ok[i - 1] >= SPEEDS[speed].gapMs - 1e-9, `${speed}: gap ${ok[i] - ok[i - 1]}`);
  }
  for (const speed of SPEED_NAMES) {
    let t = 0; const lim = createMemeLimiter({ now: () => t, gapMs: SPEEDS[speed].gapMs }); const ok = [];
    for (; t < 10 * 60 * 1000; t += 1) if (lim.tryAcquire().ok) ok.push(t);   // a trigger every millisecond for ten minutes
    assert.ok(maxInWindow(ok, 1000) <= 2, speed);
    let t2 = 0; const l2 = createMemeLimiter({ now: () => t2, gapMs: SPEEDS[speed].gapMs }); const ok2 = [];
    for (let i = 0; i < 5000; i++) { t2 = i * SPEEDS[speed].gapMs; if (l2.tryAcquire().ok) ok2.push(t2); } // a periodic attacker at exactly the gap length
    assert.ok(maxInWindow(ok2, 1000) <= 2, speed + ' periodic');
  }
  assert.equal(maxInWindow([0, 500, 900, 5000], 1000), 3);   // the checker itself works
  assert.equal(maxInWindow([0, 1000], 1000), 2);              // closed window
  assert.equal(maxInWindow([], 1000), 0);
});

// ---------------------------------------------------------------- overlay with a tiny fake DOM and fake timers
function fakeDom() {
  const mk = (tag) => {
    const n = { tag, children: [], style: {}, attrs: {}, textContent: '', removed: false, src: '', className: '' };
    n.append = (...c) => { for (const x of c) { x.parent = n; n.children.push(x); } };
    n.remove = () => { n.removed = true; if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n); };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    n.pause = () => {}; n.play = () => Promise.resolve();
    return n;
  };
  return { doc: { createElement: mk }, layer: mk('div'), live: mk('div') };
}
function clock() {
  const c = { now: 0, timers: [], seq: 0 };
  c.setT = (f, ms) => { const t = { id: ++c.seq, f, at: c.now + ms, done: false }; c.timers.push(t); return t.id; };
  c.clearT = (id) => { const t = c.timers.find((x) => x.id === id); if (t) t.done = true; };
  c.advance = (ms) => { const end = c.now + ms; for (;;) { const due = c.timers.filter((x) => !x.done && x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; c.now = due.at; due.done = true; due.f(); } c.now = end; };
  c.pending = () => c.timers.filter((x) => !x.done).length;
  return c;
}
const readyLoader = (sizes = {}) => (url) => (sizes[url] === 'fail' ? Promise.reject(new Error('404')) : Promise.resolve(sizes[url] || { w: 600, h: 600 }));
const settle = () => new Promise((r) => setImmediate(r));
async function makeOverlay(opts = {}) {
  const m = await load();
  const d = fakeDom(); const c = clock();
  const { byGesture } = m.parseManifest(opts.manifest || { wave: [{ type: 'image', src: 'png/a.png', caption: 'A', sound: 'airhorn' }, { type: 'image', src: 'png/b.png', caption: 'B', sound: 'ding' }], clap: [{ type: 'image', src: 'png/c.png', caption: 'C', centered: true }] });
  const sounds = []; const infos = [];
  const ov = m.createMemeOverlay({ ...d, byGesture, reduced: !!opts.reduced, doc: d.doc, setT: c.setT, clearT: c.clearT, limiter: m.createMemeLimiter({ now: () => c.now }), loader: opts.loader || readyLoader(), rng: opts.rng || lcg(5),
    viewport: () => ({ w: 1360, h: 800 }), speed: opts.speed, log: { info: (x) => infos.push(x) }, audio: { playMeme: (n) => sounds.push(n), playBoom: () => sounds.push('boom') } });
  ov.preload(); await settle();
  return { m, d, c, ov, sounds, infos };
}

test('overlay lifecycle: appears at t=0 instantly (no animation), caption in the live region, gone exactly at the duration, no leaked timers', async () => {
  const { d, c, ov, sounds } = await makeOverlay();
  const r = ov.show('wave');
  assert.equal(r.shown, true);
  assert.equal(d.layer.children.length, 1, 'visible immediately, same tick');
  const el = d.layer.children[0];
  assert.equal(el.className, 'meme-slap');                       // no show / fade / pop class: nothing animates
  assert.ok(!('transition' in el.style) && !('animation' in el.style));
  assert.equal(el.attrs['aria-hidden'], 'true');
  assert.match(el.src, /^\/static\/memes\/png\/[ab]\.png$/);
  assert.match(d.live.textContent, /^Meme: [AB]$/);
  assert.equal(sounds.length, 1);
  assert.equal(c.pending(), 1);
  c.advance(999); assert.equal(d.layer.children.length, 1);
  c.advance(1); assert.equal(d.layer.children.length, 0, 'gone at 1000 ms');
  assert.equal(d.live.textContent, '');
  assert.equal(c.pending(), 0, 'no timers left behind');
  assert.equal(ov.active, false);
  c.advance(10); const early = ov.show('wave'); assert.deepEqual([early.shown, early.reason], [false, 'cooldown']);
  c.advance(300); assert.equal(ov.show('wave').shown, true);
  assert.equal(ov.shown, 2);
  ov.clear(); assert.equal(d.layer.children.length, 0); assert.equal(c.pending(), 0);
  assert.doesNotThrow(() => ov.show('nonexistent_gesture'));      // a fallback card or nothing, never a throw
});

test('overlay: positions are inside the viewport, rotated within +-14 deg, and never animate; reduced motion has no rotation', async () => {
  for (const reduced of [false, true]) {
    const { d, c, ov } = await makeOverlay({ reduced, rng: lcg(11) });
    const rots = new Set();
    for (let i = 0; i < 40; i++) {
      const r = ov.show('wave'); assert.equal(r.shown, true);
      const el = d.layer.children[0];
      const w = parseFloat(el.style.width), h = parseFloat(el.style.height), l = parseFloat(el.style.left), t = parseFloat(el.style.top);
      assert.ok(l >= -1 && t >= -1 && l + w <= 1361 && t + h <= 801, `${l} ${t} ${w} ${h}`);
      assert.ok(w <= 0.6 * 1360 && h <= 0.6 * 800);
      const rot = el.style.transform ? parseFloat(/rotate\((-?[\d.]+)deg\)/.exec(el.style.transform)[1]) : 0;
      assert.ok(Math.abs(rot) <= 14.01); rots.add(rot);
      c.advance(1300);
    }
    if (reduced) assert.deepEqual([...rots], [0]); else assert.ok(rots.size > 10);
  }
});

test('overlay: the centered belly slap is upright, dead centre and 50-60 % of the shorter side', async () => {
  const { d, ov } = await makeOverlay();
  assert.equal(ov.show('clap').shown, true);   // the "clap" entry of this test manifest is centered
  const el = d.layer.children[0];
  const w = parseFloat(el.style.width), h = parseFloat(el.style.height), l = parseFloat(el.style.left), t = parseFloat(el.style.top);
  assert.ok(Math.abs(l + w / 2 - 680) < 0.2 && Math.abs(t + h / 2 - 400) < 0.2);
  assert.equal(el.style.transform, undefined);
  assert.ok(Math.max(w, h) / 800 >= 0.5 && Math.max(w, h) / 800 <= 0.6);
});

test('overlay: sounds go through the audio engine by name; a missing engine or a throwing one is harmless', async () => {
  const { ov, sounds, m } = await makeOverlay({ rng: () => 0 });
  ov.show('wave'); assert.deepEqual(sounds, ['airhorn']);
  const d2 = fakeDom(); const c2 = clock();
  const { byGesture } = m.parseManifest({ wave: [{ type: 'image', src: 'a.png', caption: 'A', sound: 'bruh' }] });
  for (const audio of [null, {}, { playMeme() { throw new Error('boom'); } }]) {
    const ov2 = m.createMemeOverlay({ ...d2, byGesture, doc: d2.doc, setT: c2.setT, clearT: c2.clearT, loader: readyLoader(), viewport: () => ({ w: 800, h: 600 }), audio, limiter: m.createMemeLimiter({ now: () => c2.now }) });
    ov2.preload(); await settle();
    assert.equal(ov2.show('wave').shown, true); c2.advance(2000);
  }
});

test('overlay: ULTRA stacks at most 2, Normal and Fast show one, speed changes the duration and the gap', async () => {
  const { d, c, ov } = await makeOverlay({ speed: 'ultra', manifest: { wave: [1, 2, 3, 4, 5].map((i) => ({ type: 'image', src: `png/${i}.png`, caption: String(i) })) } });
  assert.equal(ov.show('wave').shown, true);
  c.advance(499); assert.equal(ov.show('wave').shown, false);
  c.advance(1); assert.equal(ov.show('wave').shown, true);          // 500 ms later: second slap, first still up (550 ms)
  assert.equal(d.layer.children.length, 2);
  c.advance(49); assert.equal(d.layer.children.length, 2);
  c.advance(1); assert.equal(d.layer.children.length, 1, 'first one cut at 550 ms');
  c.advance(450);                                                    // t = 1000: a third start would make 3 in a closed second -> refused
  assert.deepEqual([ov.show('wave').shown, ov.limiter.recent.length], [false, 2]);
  c.advance(1); assert.equal(ov.show('wave').shown, true);
  assert.ok(d.layer.children.length <= 2);
  let peak = 0;
  for (let i = 0; i < 100; i++) { c.advance(137); ov.show('wave'); peak = Math.max(peak, d.layer.children.length); }
  assert.equal(peak, 2); c.advance(5000); assert.equal(d.layer.children.length, 0); assert.equal(c.pending(), 0);
  for (const [speed, dur, gap] of [['normal', 1000, 1200], ['fast', 750, 800]]) {
    ov.setSpeed(speed); assert.equal(ov.speed, speed); c.advance(5000);
    assert.equal(ov.show('wave').shown, true); c.advance(dur - 1); assert.equal(d.layer.children.length, 1); c.advance(1); assert.equal(d.layer.children.length, 0);
    c.advance(gap - dur - 1); assert.equal(ov.show('wave').shown, false); c.advance(1); assert.equal(ov.show('wave').shown, true);
    for (let i = 0; i < 50; i++) { c.advance(97); ov.show('wave'); assert.ok(d.layer.children.length <= 1, speed); }
    c.advance(3000);
  }
  ov.setSpeed('bogus'); assert.equal(ov.speed, 'normal');
});

test('overlay: the live overlay obeys the limiter for every speed when hammered through show() (no more than 2 starts in 1 s)', async () => {
  for (const speed of SPEED_NAMES) {
    const { c, ov, m } = await makeOverlay({ speed });
    const starts = [];
    for (let i = 0; i < 20000; i++) { c.advance(7); if (ov.show('wave').shown) starts.push(c.now); }
    assert.ok(starts.length > 50, speed);
    assert.ok(m.maxInWindow(starts, 1000) <= 2, `${speed}: ${m.maxInWindow(starts, 1000)}`);
  }
});

test('overlay: a missing image is skipped silently (one console.info), never a broken box; slow images show nothing until decoded', async () => {
  const man = { wave: [{ type: 'image', src: 'images/son/gone.png', caption: 'GONE' }, { type: 'image', src: 'png/ok.png', caption: 'OK' }], squat: [{ type: 'image', src: 'images/son/gone2.png', caption: 'G2' }] };
  const { d, c, ov, infos } = await makeOverlay({ manifest: man, loader: readyLoader({ '/static/memes/images/son/gone.png': 'fail', '/static/memes/images/son/gone2.png': 'fail' }) });
  for (let i = 0; i < 12; i++) { const r = ov.show('wave'); assert.equal(r.shown, true); assert.equal(r.caption, 'OK'); assert.ok(d.layer.children.every((x) => !/gone/.test(x.src))); c.advance(1300); }
  assert.equal(infos.length, 2, 'one console.info per missing file: ' + infos.join('|'));
  const r = ov.show('squat'); assert.equal(r.shown, true); assert.equal(r.type, 'card'); // every file of a gesture missing: a plain text card
  assert.equal(d.layer.children[0].tag, 'div'); assert.ok(!EMOJI.test(d.layer.children[0].children[0].textContent));
  const m = await load(); const d2 = fakeDom(); const c2 = clock(); let release;
  const slow = () => new Promise((res) => { release = () => res({ w: 500, h: 500 }); });
  const ov2 = m.createMemeOverlay({ ...d2, byGesture: m.parseManifest({ wave: [{ type: 'image', src: 'png/slow.png', caption: 'S' }] }).byGesture, doc: d2.doc, setT: c2.setT, clearT: c2.clearT, loader: slow, viewport: () => ({ w: 800, h: 600 }), limiter: m.createMemeLimiter({ now: () => c2.now }) });
  assert.deepEqual(ov2.show('wave'), { shown: false, reason: 'loading' }); assert.equal(d2.layer.children.length, 0);
  assert.equal(ov2.limiter.recent.length, 0, 'a not-ready image does not use up the rate limit');
  release(); await settle();
  assert.equal(ov2.show('wave').shown, true);
});

test('overlay: clips need the opt-in, never show under reduced motion, and are cut after at most 1.5 s', async () => {
  for (const reduced of [false, true]) {
    const { m, d, c, ov } = await makeOverlay({ reduced, manifest: { wave: [{ type: 'card', caption: 'CARD' }] } });
    ov.setUserEntries({ wave: [{ type: 'image', user: true, media: 'gif', url: 'blob:x', caption: 'gif', colorTheme: 'grape', sound: 'none' }, { type: 'image', user: true, media: 'video', url: 'blob:v', caption: 'vid', colorTheme: 'grape', sound: 'none' }] });
    for (let i = 0; i < 10; i++) { const r = ov.show('wave'); assert.equal(r.caption, 'CARD', 'clips are off by default'); c.advance(1300); }
    ov.setAllowMedia(true);
    const got = new Set(); for (let i = 0; i < 30; i++) { const r = ov.show('wave'); if (r.shown) got.add(r.caption); c.advance(1300); }
    if (reduced) assert.deepEqual([...got], ['CARD']); else assert.ok(got.has('gif') || got.has('vid'));
    assert.ok(m.MEDIA_MAX_MS <= 1500);
    assert.equal(d.layer.children.length, 0);
  }
});

// ---------------------------------------------------------------- the user's own memes (injected storage)
function memStorage(opts = {}) {
  const rows = new Map();
  return { rows, async getAll() { if (opts.failLoad) throw new Error('blocked'); return [...rows.values()]; }, async put(r) { if (opts.failPut) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } rows.set(r.id, r); }, async delete(id) { if (opts.failDelete) throw new Error('x'); rows.delete(id); } };
}
const file = (name, size = 1000, type) => ({ name, size, type: type === undefined ? 'image/png' : type });

test('classifyFile: PNG / JPG / WebP only, max 2 MB, max 40 files; GIF / video / audio only with the opt-in', async () => {
  const { classifyFile, USER_LIMITS } = await load();
  assert.deepEqual(USER_LIMITS, { maxFiles: 40, maxBytes: 2 * 1024 * 1024 });
  for (const [n, t] of [['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.webp', 'image/webp'], ['a.PNG', '']]) assert.equal(classifyFile(file(n, 10, t)).ok, true, n);
  assert.equal(classifyFile(file('a.png', 2 * 1024 * 1024)).ok, true);
  assert.equal(classifyFile(file('a.png', 2 * 1024 * 1024 + 1)).ok, false);
  assert.equal(classifyFile(file('a.png', 0)).ok, false);
  assert.equal(classifyFile(file('a.png', 10), { count: 39 }).ok, true);
  assert.equal(classifyFile(file('a.png', 10), { count: 40 }).ok, false);
  for (const [n, t, kind] of [['a.gif', 'image/gif', 'gif'], ['a.mp4', 'video/mp4', 'video'], ['a.webm', 'video/webm', 'video'], ['a.mp3', 'audio/mpeg', 'audio'], ['a.ogg', 'audio/ogg', 'audio']]) {
    assert.equal(classifyFile(file(n, 10, t)).ok, false, n + ' is off by default');
    const r = classifyFile(file(n, 10, t), { allowMedia: true }); assert.deepEqual([r.ok, r.kind], [true, kind]);
  }
  for (const bad of [file('a.exe', 10, 'application/x-msdownload'), file('a.svg', 10, 'image/svg+xml'), file('a.html', 10, 'text/html'), null, undefined, 'str']) assert.equal(classifyFile(bad, { allowMedia: true }).ok, false);
});

test('user meme store: add / list / delete / export (no blobs) / quota and storage failures are reported, never thrown', async () => {
  const { createUserMemeStore, WILDCARD } = await load();
  const st = memStorage(); let t = 1000;
  const store = createUserMemeStore(st, { now: () => t++ });
  assert.deepEqual(await store.load(), { ok: true, count: 0 });
  const a = await store.add(file('Son Face.png', 100), ['jump', 'bogus']); assert.equal(a.ok, true);
  assert.deepEqual(a.rec.gestures, ['jump']);
  const b = await store.add(file('wild.jpg', 100, 'image/jpeg'), []); assert.deepEqual(b.rec.gestures, [WILDCARD]);
  const c = await store.add(file('x.png', 100), ['squat', 'any', 'jump']); assert.deepEqual(c.rec.gestures, [WILDCARD]);
  assert.equal(store.count, 3); assert.equal(st.rows.size, 3);
  const huge = await store.add(file('huge.png', 3 * 1024 * 1024), ['jump']); assert.equal(huge.ok, false); assert.match(huge.reason, /2 MB/);
  assert.equal((await store.add(file('c.gif', 10, 'image/gif'), ['jump'])).ok, false);
  const gif = await store.add(file('c.gif', 10, 'image/gif'), ['jump'], { allowMedia: true }); assert.equal(gif.ok, true);
  const exp = store.exportManifest();
  assert.ok(!JSON.stringify(exp).includes('blob'));
  assert.deepEqual(exp.jump, [{ type: 'image', src: 'user/Son Face.png', caption: 'Son Face', sound: 'none' }]);
  assert.equal(exp.any.length, 2); assert.ok(!JSON.stringify(exp).includes('c.gif'), 'clips are never exported');
  const entries = store.toEntries((r) => 'blob:' + r.id);
  assert.ok(entries.jump.every((e) => e.user && e.media === 'image'), 'clips are left out without the opt-in');
  assert.ok(store.toEntries((r) => 'blob:' + r.id, { allowMedia: true }).jump.some((e) => e.media === 'gif'));
  assert.deepEqual(await store.remove(a.rec.id), { ok: true }); assert.equal(store.count, 3);
  assert.equal((await store.remove('nope')).ok, false);
  const again = createUserMemeStore(st); assert.equal((await again.load()).count, st.rows.size);
  const s2 = createUserMemeStore(memStorage()); let ok = 0;
  for (let i = 0; i < 50; i++) if ((await s2.add(file(`f${i}.png`, 10), ['jump'])).ok) ok++;
  assert.equal(ok, 40, 'at most 40 files');
  const full = createUserMemeStore(memStorage({ failPut: true })); const r = await full.add(file('a.png', 10), ['jump']); assert.deepEqual([r.ok, r.reason], [false, 'browser storage is full']); assert.equal(full.count, 0);
  const broken = createUserMemeStore(memStorage({ failLoad: true })); assert.equal((await broken.load()).ok, false); assert.deepEqual(broken.list(), []);
  const nodel = createUserMemeStore(memStorage({ failDelete: true })); const ad = await nodel.add(file('a.png', 10), ['jump']); assert.equal((await nodel.remove(ad.rec.id)).ok, false); assert.equal(nodel.count, 1);
  assert.equal((await createUserMemeStore({ getAll: async () => 'junk' }).load()).count, 0);
});

test('user memes: names, captions and gesture mappings are sanitised', async () => {
  const { safeFileName, captionFromName, sanitizeMapping } = await load();
  assert.ok(!safeFileName('../../etc/pa<ss>wd.png').includes('/') && !safeFileName('../../etc/pa<ss>wd.png').includes('<'));
  assert.ok(!safeFileName('<script>.png').includes('<'));
  assert.equal(safeFileName(''), 'meme');
  assert.equal(captionFromName('my_cool-meme.PNG'), 'my cool meme');
  assert.equal(captionFromName('x'.repeat(100) + '.png').length, 40);
  assert.deepEqual(sanitizeMapping(['jump', 'jump', 'squat']), ['jump', 'squat']);
  assert.deepEqual(sanitizeMapping('nope'), ['any']);
  assert.deepEqual(sanitizeMapping(['__proto__', 'constructor']), ['any']);
});

test('overlay: wildcard ("any") memes only come up now and then (about 20 %), and are the fallback when a gesture has none', async () => {
  const man = { wave: [{ type: 'image', src: 'png/a.png', caption: 'SPECIFIC' }], any: [{ type: 'image', src: 'png/w.png', caption: 'WILD' }], jump: [{ type: 'image', src: 'png/gone.png', caption: 'GONE' }] };
  const { c, ov, m } = await makeOverlay({ manifest: man, rng: lcg(99), loader: readyLoader({ '/static/memes/png/gone.png': 'fail' }) });
  const counts = { SPECIFIC: 0, WILD: 0 };
  for (let i = 0; i < 1000; i++) { const r = ov.show('wave'); counts[r.caption]++; c.advance(1300); }
  assert.ok(counts.WILD > 120 && counts.WILD < 280, JSON.stringify(counts));
  assert.equal(m.WILD_CHANCE, 0.2);
  for (let i = 0; i < 5; i++) { assert.equal(ov.show('jump').caption, 'WILD'); c.advance(1300); }  // the gesture's own file is missing: the wildcard fills in
  for (let i = 0; i < 5; i++) { assert.equal(ov.show('squat').caption, 'WILD'); c.advance(1300); }  // no list at all for this gesture
});
