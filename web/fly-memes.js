// Meme "PNG slaps" for the Fly Ask camera: a static image appears INSTANTLY at a random spot, stays ~1 s, then is gone.
// Pure parts (manifest parsing, placement, rate limiter, speeds, chooser, user-meme storage logic) have no DOM and no imports,
// so Node tests can load them. The DOM part (createMemeOverlay) only touches the DOM when it is called.
//
// PHOTOSENSITIVITY (hard rules, all tested):
//  - never more than 2 slaps START in any 1 s window (inclusive), whatever the speed setting, and a minimum gap between starts
//    (1.2 s normal, 0.8 s fast, 0.5 s ultra);
//  - a slap is a single static image: no full-viewport flash (never above 60 % of the viewport), no strobing, no alternating colours;
//  - at most one slap on screen (two in ULTRA);
//  - the generated PNGs have moderate luminance (tests/fly-meme-png.test.js);
//  - prefers-reduced-motion: no rotation and no size jitter, and animated (GIF / video) memes are never shown.

export const GESTURE_NAMES = ['wave', 'hands_up', 'hand_up_left', 'hand_up_right', 't_pose', 'clap', 'lean_left', 'lean_right', 'jump', 'squat', 'belly_rub',
  'thumbs_up', 'thumbs_down', 'peace', 'open_palm', 'fist', 'point_up', 'i_love_you'];
export const WILDCARD = 'any'; // manifest key / mapping target: usable by every gesture

// Card (text-only fallback) backgrounds: two stops, deliberately dark/mid so contrast with the dark page stays moderate (tested).
export const THEMES = {
  sunset: ['#c2410c', '#9d174d'], ocean: ['#0369a1', '#1e3a8a'], grape: ['#6d28d9', '#4c1d95'], lime: ['#4d7c0f', '#166534'],
  fire: ['#b91c1c', '#7c2d12'], ice: ['#0e7490', '#155e75'], candy: ['#be185d', '#7e22ce'], mono: ['#52525b', '#27272a'],
  gold: ['#a16207', '#854d0e'], mint: ['#0f766e', '#115e59'],
};
export const DEFAULT_THEME = 'grape';
export const MAX_PER_GESTURE = 12;
export const MAX_CAPTION = 28;
export const IMAGE_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .\-/]*\.(png|jpe?g|webp|avif|svg)$/i;
export const SOUNDS = ['none', 'boom', 'airhorn', 'bruh', 'violin', 'scratch', 'ding', 'buzzer', 'wow'];

export function relLuminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return NaN;
  const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrastRatio(a, b) { const la = relLuminance(a), lb = relLuminance(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }

// ---- speed settings ----
// durationMs: how long a slap stays. gapMs: minimum time between two slap STARTS. maxStack: slaps on screen at once.
export const SPEEDS = {
  normal: { label: 'Normal', durationMs: 1000, gapMs: 1200, maxStack: 1 },
  fast: { label: 'Fast', durationMs: 750, gapMs: 800, maxStack: 1 },
  ultra: { label: 'ULTRA', durationMs: 550, gapMs: 500, maxStack: 2 },
};
export const DEFAULT_SPEED = 'normal';
export const normSpeed = (s) => (typeof s === 'string' && Object.hasOwn(SPEEDS, s) ? s : DEFAULT_SPEED);
export const MAX_STARTS_PER_WINDOW = 2; // hard cap, every speed
export const WINDOW_MS = 1000;
export const CUT_MS = 60;               // the disappearance may take at most this long (it is an instant cut: 0)
export const MEDIA_MAX_MS = 1500;       // opt-in clips (GIF / video / audio) are cut after at most this long

// ---- placement ----
export const SIZE_FRAC = [0.22, 0.42];  // longer image side as a fraction of the SHORTER viewport side
export const MAX_VIEWPORT_FRAC = 0.6;   // a slap is never larger than this share of the viewport in either direction
export const MAX_ROTATE = 14;           // degrees
export const CENTERED_FRAC = 0.55;      // "centered" slaps (belly_rub): 50-60 % of the shorter side, dead centre, upright
// viewport {w,h}, imageSize {w,h} (natural size, only the aspect matters), rng () => [0,1)
// opts { reduced, centered, noJitter } -> { width, height, left, top, rotate } (left/top = unrotated box origin, rotate in degrees about the centre)
export function slapPlacement(viewport, imageSize, rng = Math.random, opts = {}) {
  const vw = Math.max(1, Number(viewport && viewport.w) || 1), vh = Math.max(1, Number(viewport && viewport.h) || 1);
  const iw = Math.max(1, Number(imageSize && imageSize.w) || 1), ih = Math.max(1, Number(imageSize && imageSize.h) || 1);
  const still = !!(opts.reduced || opts.noJitter || opts.centered);
  const r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng();
  const frac = opts.centered ? CENTERED_FRAC : still ? (SIZE_FRAC[0] + SIZE_FRAC[1]) / 2 : SIZE_FRAC[0] + (SIZE_FRAC[1] - SIZE_FRAC[0]) * r1;
  let scale = (frac * Math.min(vw, vh)) / Math.max(iw, ih);
  scale = Math.min(scale, (MAX_VIEWPORT_FRAC * vw) / iw, (MAX_VIEWPORT_FRAC * vh) / ih);
  const width = iw * scale, height = ih * scale;
  const rotate = still ? 0 : (r2 * 2 - 1) * MAX_ROTATE;
  const rad = Math.abs(rotate) * Math.PI / 180;
  const bw = width * Math.cos(rad) + height * Math.sin(rad), bh = width * Math.sin(rad) + height * Math.cos(rad); // bounding box of the rotated image
  const cx = opts.centered ? vw / 2 : bw >= vw ? vw / 2 : bw / 2 + r3 * (vw - bw);
  const cy = opts.centered ? vh / 2 : bh >= vh ? vh / 2 : bh / 2 + r4 * (vh - bh);
  return { width, height, left: cx - width / 2, top: cy - height / 2, rotate };
}

// A tiny built-in set, used only when web/memes/memes.json cannot be loaded at all (text cards, no emoji).
export const FALLBACK_MANIFEST = Object.fromEntries(GESTURE_NAMES.map((g) => [g, [{ type: 'card', caption: g.replace(/_/g, ' ').toUpperCase(), colorTheme: DEFAULT_THEME, sound: 'none' }]]));

// ---- manifest ----
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// raw: parsed JSON. Returns { byGesture: {gesture|any: [entry]}, errors: [string], count }. Never throws; malformed entries are skipped.
export function parseManifest(raw) {
  const byGesture = {};
  const errors = [];
  let count = 0;
  if (!isObj(raw)) return { byGesture, errors: ['manifest must be an object {gesture: [entries]}'], count };
  for (const key of Object.keys(raw)) {
    if (key.startsWith('_')) continue; // "_comment" and friends
    if (!GESTURE_NAMES.includes(key) && key !== WILDCARD) { errors.push(`unknown gesture "${String(key).slice(0, 40)}"`); continue; }
    const list = raw[key];
    if (!Array.isArray(list)) { errors.push(`${key}: expected an array of entries`); continue; }
    const out = [];
    if (list.length > MAX_PER_GESTURE) errors.push(`${key}: only the first ${MAX_PER_GESTURE} entries are used`);
    list.slice(0, MAX_PER_GESTURE).forEach((e, i) => {
      const where = `${key}[${i}]`;
      if (!isObj(e)) { errors.push(`${where}: not an object`); return; }
      const type = e.type;
      if (type !== 'card' && type !== 'image') { errors.push(`${where}: type must be "card" or "image"`); return; }
      const caption = typeof e.caption === 'string' ? e.caption.trim() : '';
      const entry = { type, caption, colorTheme: DEFAULT_THEME, sound: 'none' };
      if (type === 'card') {
        if (!caption) { errors.push(`${where}: a card needs a caption`); return; }
        if (caption.length > MAX_CAPTION) { errors.push(`${where}: caption longer than ${MAX_CAPTION} characters`); return; }
        if (e.emoji != null) errors.push(`${where}: emoji are not supported on cards, ignored`);
      } else {
        const src = typeof e.src === 'string' ? e.src.trim() : '';
        if (!src || !IMAGE_RE.test(src) || src.includes('..') || src.includes('//') || src.startsWith('/')) { errors.push(`${where}: src must be a relative path inside web/memes/ ending in .png .jpg .webp .avif or .svg`); return; }
        if (caption.length > 80) { errors.push(`${where}: caption longer than 80 characters`); return; }
        entry.src = src;
        if (e.centered === true) entry.centered = true;
        if (e.noJitter === true || e.centered === true) entry.noJitter = true;
      }
      if (e.colorTheme != null) { if (Object.hasOwn(THEMES, e.colorTheme)) entry.colorTheme = e.colorTheme; else errors.push(`${where}: unknown colorTheme "${String(e.colorTheme).slice(0, 20)}", using ${DEFAULT_THEME}`); }
      if (e.sound != null) { if (SOUNDS.includes(e.sound)) entry.sound = e.sound; else errors.push(`${where}: unknown sound "${String(e.sound).slice(0, 20)}", using none`); }
      out.push(entry);
    });
    if (out.length) { byGesture[key] = out; count += out.length; }
  }
  return { byGesture, errors, count };
}
export function imageUrl(src, base = '/static/memes/') { return base + String(src).split('/').map(encodeURIComponent).join('/'); }
export const memeKey = (e) => `${e.type}:${e.caption}:${e.src || e.url || ''}`;

// All entries a gesture may use: its own list plus the wildcard lists (manifest and the user's own).
export function candidatesFor(gesture, ...maps) {
  const out = [];
  for (const m of maps) {
    if (!m) continue;
    if (Object.hasOwn(m, gesture)) out.push(...m[gesture]);
    if (Object.hasOwn(m, WILDCARD)) out.push(...m[WILDCARD]);
  }
  return out;
}
// Wildcard ("any") memes only come up now and then, so the gesture-specific ones stay the main course.
export const WILD_CHANCE = 0.2;
export function splitCandidates(gesture, ...maps) {
  const specific = [], wild = [];
  for (const m of maps) {
    if (!m) continue;
    if (Object.hasOwn(m, gesture)) specific.push(...m[gesture]);
    if (Object.hasOwn(m, WILDCARD)) wild.push(...m[WILDCARD]);
  }
  return { specific, wild };
}
// Choose an entry from a list, avoiding an immediate repeat when there is a choice.
export function chooseMeme(list, rng = Math.random, lastKey = null) {
  if (!list || !list.length) return null;
  const pool = list.length > 1 ? list.filter((e) => memeKey(e) !== lastKey) : list;
  const e = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  return { entry: e, key: memeKey(e) };
}
export function pickMeme(byGesture, gesture, rng = Math.random, lastKey = null) {
  return chooseMeme(candidatesFor(gesture, byGesture), rng, lastKey);
}

// ---- rate limiter (injected clock) ----
// Two rules: a minimum gap between starts, and at most `maxPerWindow` starts in any window of `windowMs` (inclusive on both ends).
export function createMemeLimiter({ now = () => Date.now(), gapMs = SPEEDS[DEFAULT_SPEED].gapMs, maxPerWindow = MAX_STARTS_PER_WINDOW, windowMs = WINDOW_MS } = {}) {
  const starts = [];
  let gap = gapMs;
  let lastStart = -Infinity; // kept apart from `starts`: the gap (1.2 s) can be longer than the window (1 s)
  return {
    // Returns { ok:true } and records a start, or { ok:false, reason, retryInMs }.
    tryAcquire() {
      const t = now();
      while (starts.length && t - starts[0] > windowMs) starts.shift();
      if (t - lastStart < gap) return { ok: false, reason: 'cooldown', retryInMs: Math.ceil(gap - (t - lastStart)) };
      if (starts.length >= maxPerWindow) return { ok: false, reason: 'rate', retryInMs: Math.ceil(windowMs - (t - starts[0])) + 1 };
      starts.push(t); lastStart = t;
      return { ok: true };
    },
    setGap(ms) { gap = Math.max(0, Number(ms) || 0); },
    get gap() { return gap; },
    reset() { starts.length = 0; lastStart = -Infinity; },
    get recent() { return starts.slice(); },
  };
}
// Largest number of onsets inside any CLOSED window of `windowMs` (used by the safety tests).
export function maxInWindow(times, windowMs = WINDOW_MS) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] > windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}

// ---- the user's own memes: validation + storage logic (the IndexedDB adapter lives in fly.js and is injected) ----
export const USER_LIMITS = { maxFiles: 40, maxBytes: 2 * 1024 * 1024 };
export const STILL_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const MEDIA_TYPES = ['image/gif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm'];
const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' };
export function fileType(file) {
  const t = String((file && file.type) || '').toLowerCase();
  if (t) return t;
  const m = /\.([a-z0-9]+)$/i.exec(String((file && file.name) || ''));
  return (m && EXT_TYPE[m[1].toLowerCase()]) || '';
}
// ctx { allowMedia, count } -> { ok:true, kind:'image'|'gif'|'video'|'audio' } | { ok:false, reason }
export function classifyFile(file, ctx = {}) {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'not a file' };
  const type = fileType(file);
  const size = Number(file.size);
  const still = STILL_TYPES.includes(type), media = MEDIA_TYPES.includes(type);
  if (!still && !media) return { ok: false, reason: 'unsupported type (PNG, JPG and WebP are accepted)' };
  if (media && !ctx.allowMedia) return { ok: false, reason: 'GIF / video / audio memes are switched off (flashing-media opt-in)' };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'empty file' };
  if (size > USER_LIMITS.maxBytes) return { ok: false, reason: 'bigger than 2 MB' };
  if ((ctx.count || 0) >= USER_LIMITS.maxFiles) return { ok: false, reason: `limit of ${USER_LIMITS.maxFiles} memes reached` };
  return { ok: true, kind: still ? 'image' : type === 'image/gif' ? 'gif' : type.startsWith('video/') ? 'video' : 'audio', type };
}
// A gesture mapping from a dialog: only known gesture names, or the wildcard; never empty.
export function sanitizeMapping(list) {
  const out = [];
  for (const g of Array.isArray(list) ? list : []) if ((GESTURE_NAMES.includes(g) || g === WILDCARD) && !out.includes(g)) out.push(g);
  return out.includes(WILDCARD) || !out.length ? [WILDCARD] : out;
}
export function captionFromName(name) { return String(name || 'meme').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 40) || 'meme'; }
export function safeFileName(name) { const n = String(name || 'meme').replace(/[^A-Za-z0-9_.\- ]+/g, '_').replace(/^[._\- ]+/, '').slice(0, 60); return n || 'meme'; }

// storage: { getAll(): Promise<rec[]>, put(rec): Promise, delete(id): Promise }, rec = { id, name, type, size, kind, gestures, blob, addedAt }
// Every method resolves with a result object; nothing here ever throws (a broken IndexedDB just means "nothing stored").
export function createUserMemeStore(storage, { now = () => Date.now(), makeId = null } = {}) {
  let recs = [];
  let seq = 0;
  const nextId = makeId || (() => `u${now().toString(36)}${(seq++).toString(36)}`);
  const sorted = () => recs.slice().sort((a, b) => a.addedAt - b.addedAt);
  return {
    async load() {
      try { const all = await storage.getAll(); recs = (Array.isArray(all) ? all : []).filter((r) => r && typeof r.id === 'string' && r.blob).slice(0, USER_LIMITS.maxFiles); return { ok: true, count: recs.length }; }
      catch (e) { recs = []; return { ok: false, reason: 'storage unavailable' }; }
    },
    list() { return sorted(); },
    get count() { return recs.length; },
    async add(file, gestures, { allowMedia = false } = {}) {
      const c = classifyFile(file, { allowMedia, count: recs.length });
      if (!c.ok) return { ok: false, reason: c.reason, name: file && file.name };
      const rec = { id: nextId(), name: safeFileName(file.name), type: c.type, size: file.size, kind: c.kind, gestures: sanitizeMapping(gestures), blob: file, addedAt: now() };
      try { await storage.put(rec); } catch (e) { return { ok: false, reason: e && e.name === 'QuotaExceededError' ? 'browser storage is full' : 'could not store the file', name: file.name }; }
      recs.push(rec);
      return { ok: true, rec };
    },
    async remove(id) {
      const i = recs.findIndex((r) => r.id === id);
      if (i < 0) return { ok: false, reason: 'not found' };
      try { await storage.delete(id); } catch (e) { return { ok: false, reason: 'could not delete' }; }
      recs.splice(i, 1);
      return { ok: true };
    },
    // JSON in the memes.json shape, WITHOUT the files: copy the images into web/memes/user/ to use it as a shared manifest.
    exportManifest() {
      const out = { _comment: 'Exported from the Fly Ask page. Files are not included: copy them into web/memes/user/ and keep the names.' };
      for (const r of sorted()) {
        if (r.kind !== 'image') continue; // clips are a local opt-in only and never exported
        for (const g of r.gestures) (out[g] = out[g] || []).push({ type: 'image', src: `user/${r.name}`, caption: captionFromName(r.name), sound: 'none' });
      }
      return out;
    },
    // Entries for the overlay: { gesture|any: [entry] }. `urlFor(rec)` creates the object URL (DOM side).
    toEntries(urlFor, { allowMedia = false } = {}) {
      const map = {};
      for (const r of sorted()) {
        if (r.kind !== 'image' && !allowMedia) continue;
        const entry = { type: 'image', user: true, id: r.id, media: r.kind, url: urlFor(r), caption: captionFromName(r.name), colorTheme: DEFAULT_THEME, sound: 'none' };
        for (const g of r.gestures) (map[g] = map[g] || []).push(entry);
      }
      return map;
    },
  };
}

// ---- DOM overlay ----
// layer: pointer-events:none container (position:fixed, above everything); live: aria-live element.
// audio: engine with playMeme(name) (or playBoom()); loader(url) -> Promise<{w,h}> (default: an off-screen Image + decode()).
export function createMemeOverlay({ layer, live, byGesture, reduced = false, limiter, audio = null, rng = Math.random, doc = (typeof document !== 'undefined' ? document : null),
  setT = setTimeout, clearT = clearTimeout, onShow = null, viewport = null, loader = null, speed = DEFAULT_SPEED, log = console } = {}) {
  let spd = normSpeed(speed);
  const lim = limiter || createMemeLimiter({ now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()), gapMs: SPEEDS[spd].gapMs });
  if (lim.setGap) lim.setGap(SPEEDS[spd].gapMs);
  const vp = viewport || (() => ({ w: (typeof innerWidth !== 'undefined' ? innerWidth : 1280), h: (typeof innerHeight !== 'undefined' ? innerHeight : 720) }));
  const loadImg = loader || ((url) => new Promise((resolve, reject) => {
    const im = new Image(); im.decoding = 'async';
    im.onload = () => { const done = () => resolve({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }); if (im.decode) im.decode().then(done, done); else done(); };
    im.onerror = () => reject(new Error('load failed'));
    im.src = url;
  }));
  let manifest = byGesture || FALLBACK_MANIFEST;
  let userMap = {};
  let allowMedia = false;
  let active = []; // { el, timers, entry }
  let lastKey = null, shown = 0;
  const assets = new Map(); // url -> { state: 'loading'|'ready'|'failed', w, h }

  const urlOf = (e) => e.url || imageUrl(e.src);
  const isClip = (e) => !!(e.user && e.media && e.media !== 'image');
  function ensureLoaded(entry) {
    if (entry.type !== 'image') return;
    const u = urlOf(entry);
    if (assets.has(u)) return;
    if (isClip(entry)) { assets.set(u, { state: 'ready', w: 16, h: 9 }); return; } // clips are not decoded up front; they just play
    const a = { state: 'loading', w: 0, h: 0 };
    assets.set(u, a);
    loadImg(u).then((r) => { a.state = 'ready'; a.w = r.w; a.h = r.h; }, () => { a.state = 'failed'; if (log && log.info) log.info(`meme image not found, skipped: ${entry.src || entry.caption}`); });
  }
  function usable(entry) {
    if (entry.type === 'card') return true;
    if (isClip(entry) && (!allowMedia || reduced)) return false; // animated media only on explicit opt-in, never with reduced motion
    const a = assets.get(urlOf(entry));
    return !!a && a.state === 'ready';
  }
  function remove(item) {
    for (const t of item.timers) clearT(t);
    try { if (item.el.pause) item.el.pause(); } catch (_) { /* ignore */ }
    item.el.remove();
    active = active.filter((x) => x !== item);
    if (!active.length && live) live.textContent = '';
  }
  function clear() { for (const it of active.slice()) remove(it); }

  function buildEl(entry, place) {
    let el;
    if (entry.type === 'card' || (isClip(entry) && entry.media === 'audio')) {
      el = doc.createElement('div'); el.className = 'meme-slap meme-card';
      const [c1, c2] = THEMES[entry.colorTheme] || THEMES[DEFAULT_THEME];
      el.style.background = `linear-gradient(145deg, ${c1}, ${c2})`;
      const cap = doc.createElement('span'); cap.textContent = entry.caption || 'SOUND'; el.append(cap);
      el.style.fontSize = `${Math.round(place.height * Math.min(0.3, 5.2 / Math.max(5, (entry.caption || '').length)))}px`;
    } else if (isClip(entry) && entry.media === 'video') {
      el = doc.createElement('video'); el.className = 'meme-slap'; el.muted = true; el.autoplay = true; el.playsInline = true; el.loop = false; el.src = urlOf(entry);
      try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
    } else {
      el = doc.createElement('img'); el.className = 'meme-slap'; el.alt = ''; el.decoding = 'sync'; el.draggable = false; el.src = urlOf(entry);
    }
    el.setAttribute('aria-hidden', 'true'); // the caption is announced through the live region instead
    el.style.width = `${place.width.toFixed(1)}px`; el.style.height = `${place.height.toFixed(1)}px`;
    el.style.left = `${place.left.toFixed(1)}px`; el.style.top = `${place.top.toFixed(1)}px`;
    if (place.rotate) el.style.transform = `rotate(${place.rotate.toFixed(2)}deg)`;
    return el;
  }
  function playSound(name) {
    if (!audio || !name || name === 'none') return;
    try { if (audio.playMeme) audio.playMeme(name); else if (name === 'boom' && audio.playBoom) audio.playBoom(); } catch (_) { /* sound is optional */ }
  }

  // Returns { shown:boolean, reason?, retryInMs?, caption?, type?, placement? }. Never throws.
  function show(gesture) {
    const sp = splitCandidates(gesture, manifest, userMap);
    const all = [...sp.specific, ...sp.wild];
    for (const e of all) ensureLoaded(e); // starts loading anything not seen yet
    const okSpecific = sp.specific.filter(usable), okWild = sp.wild.filter(usable);
    let pool = okWild.length && (!okSpecific.length || rng() < WILD_CHANCE) ? okWild : okSpecific;
    if (!pool.length) {
      if (all.some((e) => e.type === 'image' && (assets.get(urlOf(e)) || {}).state === 'loading')) return { shown: false, reason: 'loading' }; // not decoded yet: show nothing, never a broken box
      pool = candidatesFor(gesture, FALLBACK_MANIFEST);
    }
    const pick = chooseMeme(pool, rng, lastKey);
    if (!pick) return { shown: false, reason: 'no-meme' };
    const ok = lim.tryAcquire();
    if (!ok.ok) return { shown: false, reason: ok.reason, retryInMs: ok.retryInMs };
    const cfg = SPEEDS[spd];
    while (active.length >= cfg.maxStack) remove(active[0]);
    lastKey = pick.key;
    const entry = pick.entry;
    const a = entry.type === 'image' ? assets.get(urlOf(entry)) : null;
    const size = entry.type === 'card' ? { w: 400, h: 240 } : { w: (a && a.w) || 1, h: (a && a.h) || 1 };
    const place = slapPlacement(vp(), size, rng, { reduced, centered: !!entry.centered, noJitter: !!entry.noJitter });
    const el = buildEl(entry, place);
    const item = { el, timers: [], entry };
    active.push(item);
    layer.append(el); // instant: no transition, no animation
    if (live) live.textContent = entry.caption ? `Meme: ${entry.caption}` : 'Meme';
    const life = Math.min(cfg.durationMs, isClip(entry) ? MEDIA_MAX_MS : Infinity);
    if (isClip(entry) && entry.media === 'audio') {
      try { const au = new Audio(urlOf(entry)); au.volume = 0.8; au.play().catch(() => {}); item.timers.push(setT(() => { try { au.pause(); } catch (_) { /* ignore */ } }, life)); } catch (_) { /* ignore */ }
    }
    item.timers.push(setT(() => remove(item), life)); // instant cut
    playSound(entry.sound);
    shown += 1;
    if (onShow) onShow({ gesture, caption: entry.caption, type: entry.type, placement: place });
    return { shown: true, caption: entry.caption, type: entry.type, placement: place };
  }
  return {
    show, clear,
    // Start decoding every image of the manifest (and the user's) in the background so the first slap is instant.
    preload() { for (const m of [manifest, userMap]) for (const list of Object.values(m)) for (const e of list) ensureLoaded(e); },
    setManifest(m) { manifest = m || FALLBACK_MANIFEST; },
    setUserEntries(map) { userMap = map || {}; },
    setAllowMedia(b) { allowMedia = !!b; },
    setSpeed(s) { spd = normSpeed(s); if (lim.setGap) lim.setGap(SPEEDS[spd].gapMs); },
    get speed() { return spd; },
    get shown() { return shown; },
    get active() { return active.length > 0; },
    get activeCount() { return active.length; },
    assetState(url) { const a = assets.get(url); return a ? a.state : null; },
    limiter: lim,
  };
}
