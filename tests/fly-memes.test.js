'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/fly-memes.js'), 'utf8')).toString('base64'));
const loadG = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/fly-gestures.js'), 'utf8')).toString('base64'));
const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../web/memes/memes.json'), 'utf8'));

test('shipped manifest parses cleanly, covers every gesture, has >= 14 distinct cards, only safe content', async () => {
  const { parseManifest, GESTURE_NAMES, THEMES } = await load();
  const { GESTURES } = await loadG();
  assert.deepEqual([...GESTURE_NAMES].sort(), [...GESTURES].sort(), 'meme and gesture lists must agree');
  const r = parseManifest(shipped());
  assert.deepEqual(r.errors, []);
  for (const g of GESTURES) assert.ok(r.byGesture[g] && r.byGesture[g].length >= 1, `no meme for ${g}`);
  const caps = new Set();
  for (const list of Object.values(r.byGesture)) for (const e of list) { caps.add(e.caption); assert.equal(e.type, 'card'); assert.ok(e.colorTheme in THEMES); }
  assert.ok(caps.size >= 14, `only ${caps.size} distinct captions`);
  for (const c of ['NICE', 'BRUH', 'SHEESH', 'YEET', 'STONKS', 'NO WAY', 'SUS', 'SKILL ISSUE', 'GIGACHAD']) assert.ok(caps.has(c), c);
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
      { type: 'card', caption: 'EMO', emoji: 'x'.repeat(30) },
    ],
    clap: 'not an array',
    jump: { type: 'card', caption: 'obj' },
    flying: [{ type: 'card', caption: 'X' }],                    // unknown gesture
    __proto__: { evil: true },
  });
  assert.deepEqual(r.byGesture.wave.map((e) => e.caption), ['OK', 'THEME', 'SND', 'EMO']);
  assert.equal(r.byGesture.wave[1].colorTheme, 'grape');
  assert.equal(r.byGesture.wave[2].sound, 'none');
  assert.ok(!('emoji' in r.byGesture.wave[3]));
  assert.ok(!('clap' in r.byGesture) && !('jump' in r.byGesture) && !('flying' in r.byGesture));
  assert.ok(r.errors.length >= 9);
  assert.equal(({}).evil, undefined);
});

test('parseManifest: image entries only accept relative files inside web/memes', async () => {
  const { parseManifest, imageUrl } = await load();
  const good = ['a.png', 'sub/b.JPG', 'my meme.gif', 'c-d_e.webp', 'x.avif', 'y.svg'];
  const bad = ['/etc/passwd.png', '../a.png', 'a/../../b.png', 'http://evil/x.png', 'https://x.png', '//cdn/x.png', 'javascript:alert(1).png', 'a.exe', 'a.png.exe', '', 'a.html', 'data:image/png;base64,AAAA.png', 'a\\b.png', '.png'];
  const mk = (l) => l.map((src) => ({ type: 'image', src, caption: 'c' }));
  const r = parseManifest({ wave: mk(good), clap: mk(bad.slice(0, 7)), jump: mk(bad.slice(7)) });
  assert.deepEqual(r.byGesture.wave.map((e) => e.src), good);
  assert.ok(!('clap' in r.byGesture) && !('jump' in r.byGesture));
  assert.equal(r.errors.length, bad.length);
  assert.equal(imageUrl('sub/my meme.gif'), '/static/memes/sub/my%20meme.gif');
  assert.equal(parseManifest({ wave: [{ type: 'image', caption: 'no src' }] }).count, 0);
});

test('parseManifest caps entries per gesture', async () => {
  const { parseManifest, MAX_PER_GESTURE } = await load();
  const r = parseManifest({ wave: Array.from({ length: 40 }, (_, i) => ({ type: 'card', caption: 'C' + i })) });
  assert.equal(r.byGesture.wave.length, MAX_PER_GESTURE);
  assert.ok(r.errors.length === 1);
});

test('pickMeme: avoids an immediate repeat, handles empty and unknown gestures', async () => {
  const { parseManifest, pickMeme } = await load();
  const { byGesture } = parseManifest({ wave: [{ type: 'card', caption: 'A' }, { type: 'card', caption: 'B' }], clap: [{ type: 'card', caption: 'ONLY' }] });
  let last = null;
  for (let i = 0; i < 50; i++) { const p = pickMeme(byGesture, 'wave', Math.random, last); assert.notEqual(p.key, last); last = p.key; }
  assert.equal(pickMeme(byGesture, 'clap', Math.random, 'card:ONLY:').entry.caption, 'ONLY');
  assert.equal(pickMeme(byGesture, 'jump'), null);
  assert.equal(pickMeme(byGesture, 'constructor'), null);
  assert.equal(pickMeme(null, 'wave'), null);
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

test('limiter: global cooldown 1.2 s, at most 2 per 3 s (injected clock)', async () => {
  const { createMemeLimiter } = await load();
  let t = 10000;
  const lim = createMemeLimiter({ now: () => t });
  assert.equal(lim.tryAcquire().ok, true);
  t += 1199; const r1 = lim.tryAcquire(); assert.equal(r1.ok, false); assert.equal(r1.reason, 'cooldown'); assert.equal(r1.retryInMs, 1);
  t += 1; assert.equal(lim.tryAcquire().ok, true);              // 1200 after the first
  t += 1200; const r2 = lim.tryAcquire(); assert.equal(r2.ok, false); assert.equal(r2.reason, 'rate'); // third inside 3 s
  t = 10000 + 3000; assert.equal(lim.tryAcquire().ok, true);    // first one left the window
  lim.reset(); assert.equal(lim.tryAcquire().ok, true);
});

test('flash-rate safety: hammering the limiter never allows > 2 flashes in any 1 s window (actually <= 1), nor > 2 in 3 s', async () => {
  const { createMemeLimiter, maxInWindow } = await load();
  for (const seed of [1, 2, 3, 4, 5]) {
    let t = 0, s = seed;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const lim = createMemeLimiter({ now: () => t });
    const ok = [];
    for (let i = 0; i < 200000; i++) {
      t += rnd() < 0.5 ? rnd() * 5 : rnd() * 400;               // bursts of hammering and slower gaps, ~ 20 minutes of virtual time
      if (lim.tryAcquire().ok) ok.push(t);
    }
    assert.ok(ok.length > 500, 'the limiter must still let memes through');
    assert.ok(maxInWindow(ok, 1000) <= 2, `1 s window: ${maxInWindow(ok, 1000)}`);
    assert.equal(maxInWindow(ok, 1000), 1);
    assert.ok(maxInWindow(ok, 3000) <= 2, `3 s window: ${maxInWindow(ok, 3000)}`);
    for (let i = 1; i < ok.length; i++) assert.ok(ok[i] - ok[i - 1] >= 1200 - 1e-9);
  }
  // the checker itself works
  assert.equal(maxInWindow([0, 500, 900, 5000], 1000), 3);
  assert.equal(maxInWindow([], 1000), 0);
});

test('timings: one meme lives shorter than the global cooldown (never two on screen); reduced motion does not animate', async () => {
  const { memeTimings, GLOBAL_COOLDOWN_MS } = await load();
  for (const reduced of [false, true]) {
    const t = memeTimings(reduced);
    assert.ok(t.totalMs === t.stayMs + t.fadeMs);
    assert.ok(t.totalMs < GLOBAL_COOLDOWN_MS);
    assert.ok(t.stayMs >= 800 && t.stayMs <= 1000);
  }
  assert.equal(memeTimings(true).animate, false);
  assert.equal(memeTimings(false).animate, true);
});

// ---- overlay with a tiny fake DOM ----
function fakeDom() {
  const mk = (tag) => {
    const n = { tag, children: [], style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {}, classes: new Set(), listeners: {}, attrs: {}, textContent: '', removed: false };
    Object.defineProperty(n, 'className', { get() { return [...n.classes].join(' '); }, set(v) { n.classes = new Set(String(v).split(/\s+/).filter(Boolean)); } });
    n.classList = { add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c), contains: (c) => n.classes.has(c) };
    n.append = (...c) => { n.children.push(...c); };
    n.remove = () => { n.removed = true; if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n); };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    n.addEventListener = (e, f) => { n.listeners[e] = f; };
    n.getBoundingClientRect = () => ({});
    return n;
  };
  const doc = { createElement: mk };
  const layer = mk('div'); layer.append = (...c) => { for (const x of c) { x.parent = layer; layer.children.push(x); } };
  return { doc, layer, live: mk('div') };
}

test('overlay: one meme at a time, caption in the live region, fades out and is removed; reduced motion adds the static class', async () => {
  const { createMemeOverlay, createMemeLimiter, parseManifest } = await load();
  const { byGesture } = parseManifest(shipped());
  let now = 0; const timers = [];
  const setT = (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; };
  const clearT = () => {};
  const advance = (ms) => { now += ms; for (const t of timers.filter((x) => x.at <= now && !x.done)) { t.done = true; t.f(); } };
  for (const reduced of [false, true]) {
    now = 0; timers.length = 0;
    const d = fakeDom(); const booms = [];
    const ov = createMemeOverlay({ ...d, byGesture, reduced, doc: d.doc, setT, clearT, limiter: createMemeLimiter({ now: () => now }), audio: { playBoom: () => booms.push(1) }, rng: () => 0.01 });
    const r = ov.show('thumbs_up');
    assert.equal(r.shown, true); assert.equal(r.caption, 'NICE');
    assert.equal(d.layer.children.length, 1);
    const card = d.layer.children[0];
    assert.ok(card.classes.has('in')); assert.equal(card.classes.has('static'), reduced);
    assert.match(d.live.textContent, /NICE/);
    assert.equal(booms.length, 1);
    const cap = card.children.find((c) => c.classes.has('meme-cap')); assert.equal(cap.textContent, 'NICE');
    // a second request right away is refused (cooldown) and nothing else appears
    assert.equal(ov.show('wave').shown, false); assert.equal(d.layer.children.length, 1);
    advance(899); assert.ok(!card.classes.has('out'));
    advance(1); assert.ok(card.classes.has('out'));
    advance(250); assert.equal(d.layer.children.length, 0); assert.equal(d.live.textContent, '');
    advance(100);
    assert.equal(ov.show('wave').shown, true); assert.equal(d.layer.children.length, 1);
    assert.equal(ov.shown, 2);
    assert.deepEqual(ov.show('nonexistent'), { shown: false, reason: 'no-meme' });
  }
});
