// Meme flash overlay for the Fly Ask camera.
// Pure parts (manifest parsing, rate limiter, themes, timings) have no DOM and no imports, so Node tests can load them.
// The DOM part (createMemeOverlay) only touches the DOM when it is called.
//
// PHOTOSENSITIVITY: at most ONE meme at a time, one onset per >= 1.2 s (so never more than 1 flash in any second,
// and never more than 2 in 3 s), cards use mid-dark backgrounds (no white flashes), the overlay is small (never
// full-screen), nothing blinks or alternates, and prefers-reduced-motion gets a plain fade without scaling or rotating.

export const GESTURE_NAMES = ['wave', 'hands_up', 'hand_up_left', 'hand_up_right', 't_pose', 'clap', 'lean_left', 'lean_right', 'jump', 'squat',
  'thumbs_up', 'thumbs_down', 'peace', 'open_palm', 'fist', 'point_up', 'i_love_you'];

// Card backgrounds: two stops, deliberately dark/mid so contrast with the dark page stays moderate (tested).
export const THEMES = {
  sunset: ['#c2410c', '#9d174d'], ocean: ['#0369a1', '#1e3a8a'], grape: ['#6d28d9', '#4c1d95'], lime: ['#4d7c0f', '#166534'],
  fire: ['#b91c1c', '#7c2d12'], ice: ['#0e7490', '#155e75'], candy: ['#be185d', '#7e22ce'], mono: ['#52525b', '#27272a'],
  gold: ['#a16207', '#854d0e'], mint: ['#0f766e', '#115e59'],
};
export const DEFAULT_THEME = 'grape';
export const MAX_PER_GESTURE = 12;
export const MAX_CAPTION = 28;
export const IMAGE_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .\-/]*\.(png|jpe?g|gif|webp|avif|svg)$/i;
export const SOUNDS = ['boom', 'none'];

export function relLuminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return NaN;
  const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrastRatio(a, b) { const la = relLuminance(a), lb = relLuminance(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }

// Timings in ms. A meme's whole life (in + hold + out) must stay under the global cooldown so two never overlap.
export function memeTimings(reducedMotion) {
  return reducedMotion
    ? { popMs: 150, stayMs: 900, fadeMs: 250, animate: false, totalMs: 1150 }
    : { popMs: 150, stayMs: 900, fadeMs: 250, animate: true, totalMs: 1150 };
}
export const GLOBAL_COOLDOWN_MS = 1200;
export const MAX_PER_WINDOW = 2;
export const WINDOW_MS = 3000;

// A tiny built-in set, used only when web/memes/memes.json cannot be loaded at all.
export const FALLBACK_MANIFEST = Object.fromEntries(GESTURE_NAMES.map((g) => [g, [{ type: 'card', caption: g.replace(/_/g, ' ').toUpperCase(), emoji: '✨', colorTheme: DEFAULT_THEME, sound: 'none' }]]));

// ---- manifest ----
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// raw: parsed JSON. Returns { byGesture: {gesture: [entry]}, errors: [string], count }. Never throws.
export function parseManifest(raw) {
  const byGesture = {};
  const errors = [];
  let count = 0;
  if (!isObj(raw)) return { byGesture, errors: ['manifest must be an object {gesture: [entries]}'], count };
  for (const key of Object.keys(raw)) {
    if (key.startsWith('_')) continue; // "_comment" and friends
    if (!GESTURE_NAMES.includes(key)) { errors.push(`unknown gesture "${String(key).slice(0, 40)}"`); continue; }
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
        if (typeof e.emoji === 'string' && e.emoji.length <= 8) entry.emoji = e.emoji;
        else if (e.emoji != null) errors.push(`${where}: emoji ignored (string up to 8 characters)`);
      } else {
        const src = typeof e.src === 'string' ? e.src.trim() : '';
        if (!src || !IMAGE_RE.test(src) || src.includes('..') || src.includes('//') || src.startsWith('/')) { errors.push(`${where}: src must be a relative path inside web/memes/ ending in .png .jpg .gif .webp .avif or .svg`); return; }
        if (caption.length > 80) { errors.push(`${where}: caption longer than 80 characters`); return; }
        entry.src = src;
      }
      if (e.colorTheme != null) { if (Object.hasOwn(THEMES, e.colorTheme)) entry.colorTheme = e.colorTheme; else errors.push(`${where}: unknown colorTheme "${String(e.colorTheme).slice(0, 20)}", using ${DEFAULT_THEME}`); }
      if (e.sound != null) { if (SOUNDS.includes(e.sound)) entry.sound = e.sound; else errors.push(`${where}: unknown sound "${String(e.sound).slice(0, 20)}", using none`); }
      out.push(entry);
    });
    const good = out;
    if (good.length) { byGesture[key] = good; count += good.length; }
  }
  return { byGesture, errors, count };
}
export function imageUrl(src, base = '/static/memes/') { return base + String(src).split('/').map(encodeURIComponent).join('/'); }
// Choose an entry for a gesture, avoiding an immediate repeat when there is a choice.
export function pickMeme(byGesture, gesture, rng = Math.random, lastKey = null) {
  const list = byGesture && Object.hasOwn(byGesture, gesture) ? byGesture[gesture] : null;
  if (!list || !list.length) return null;
  const key = (e) => `${e.type}:${e.caption}:${e.src || ''}`;
  const pool = list.length > 1 ? list.filter((e) => key(e) !== lastKey) : list;
  const e = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  return { entry: e, key: key(e) };
}

// ---- rate limiter (injected clock) ----
export function createMemeLimiter({ now = () => Date.now(), cooldownMs = GLOBAL_COOLDOWN_MS, maxPerWindow = MAX_PER_WINDOW, windowMs = WINDOW_MS } = {}) {
  const starts = [];
  return {
    // Returns { ok:true } and records a start, or { ok:false, reason, retryInMs }.
    tryAcquire() {
      const t = now();
      while (starts.length && t - starts[0] >= windowMs) starts.shift();
      const last = starts.length ? starts[starts.length - 1] : -Infinity;
      if (t - last < cooldownMs) return { ok: false, reason: 'cooldown', retryInMs: Math.ceil(cooldownMs - (t - last)) };
      if (starts.length >= maxPerWindow) return { ok: false, reason: 'rate', retryInMs: Math.ceil(windowMs - (t - starts[0])) };
      starts.push(t);
      return { ok: true };
    },
    reset() { starts.length = 0; },
    get recent() { return starts.slice(); },
  };
}
// Largest number of onsets inside any sliding window of `windowMs` (used by the safety tests).
export function maxInWindow(times, windowMs = 1000) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] >= windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}

// ---- DOM overlay ----
// layer: the pointer-events:none container; live: aria-live element; audio: engine with playBoom(); onShow(info)
export function createMemeOverlay({ layer, live, byGesture, reduced = false, limiter, audio = null, rng = Math.random, doc = (typeof document !== 'undefined' ? document : null), setT = setTimeout, clearT = clearTimeout, onShow = null } = {}) {
  const lim = limiter || createMemeLimiter({ now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) });
  const timing = memeTimings(reduced);
  let current = null, timers = [], lastKey = null, shown = 0, manifest = byGesture || FALLBACK_MANIFEST;

  function clear() {
    for (const t of timers) clearT(t);
    timers = [];
    if (current) { current.remove(); current = null; }
  }
  function build(entry) {
    const card = doc.createElement('div');
    card.className = 'meme ' + (entry.type === 'image' ? 'meme-image' : 'meme-card');
    card.dataset.theme = entry.colorTheme;
    card.setAttribute('aria-hidden', 'true'); // the caption is announced through the live region instead
    if (reduced) card.classList.add('static');
    const [c1, c2] = THEMES[entry.colorTheme] || THEMES[DEFAULT_THEME];
    card.style.setProperty('--c1', c1); card.style.setProperty('--c2', c2);
    card.style.setProperty('--tilt', `${(rng() * 8 - 4).toFixed(1)}deg`);
    if (entry.type === 'image') {
      const img = doc.createElement('img');
      img.alt = entry.caption || 'meme';
      img.decoding = 'async';
      img.addEventListener('error', () => { if (current === card) { card.className = 'meme meme-card' + (reduced ? ' static' : ''); img.remove(); addText(card, { caption: entry.caption || 'MEME', emoji: '🖼️' }); } });
      if (reduced && /\.(gif|webp|avif)$/i.test(entry.src)) {
        // Animated formats must not move under prefers-reduced-motion: keep only the first frame on a canvas.
        img.addEventListener('load', () => {
          try {
            const c = doc.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.className = 'meme-still';
            c.getContext('2d').drawImage(img, 0, 0); c.setAttribute('role', 'img'); c.setAttribute('aria-label', entry.caption || 'meme');
            img.replaceWith(c);
          } catch (_) { img.dispatchEvent(new Event('error')); }
        });
      }
      img.src = imageUrl(entry.src);
      card.append(img);
      if (entry.caption) { const cap = doc.createElement('div'); cap.className = 'meme-cap'; cap.textContent = entry.caption; cap.style.setProperty('--n', String(Math.max(5, entry.caption.length))); card.append(cap); }
    } else addText(card, entry);
    return card;
  }
  function addText(card, entry) {
    if (entry.emoji) { const em = doc.createElement('div'); em.className = 'meme-emoji'; em.setAttribute('aria-hidden', 'true'); em.textContent = entry.emoji; card.append(em); }
    const cap = doc.createElement('div'); cap.className = 'meme-cap'; cap.textContent = entry.caption;
    cap.style.setProperty('--n', String(Math.max(5, entry.caption.length)));
    card.append(cap);
  }
  // Returns { shown:boolean, reason?, caption? }
  function show(gesture) {
    const pick = pickMeme(manifest, gesture, rng, lastKey);
    if (!pick) return { shown: false, reason: 'no-meme' };
    const ok = lim.tryAcquire();
    if (!ok.ok) return { shown: false, reason: ok.reason, retryInMs: ok.retryInMs };
    clear();
    lastKey = pick.key;
    const card = build(pick.entry);
    current = card;
    layer.append(card);
    // force a frame between insertion and the class so the transition runs
    card.getBoundingClientRect();
    card.classList.add('show');
    if (live) live.textContent = pick.entry.caption ? `Meme: ${pick.entry.caption}` : 'Meme';
    if (pick.entry.sound === 'boom' && audio && audio.playBoom) { try { audio.playBoom(); } catch (_) { /* sound is optional */ } }
    timers.push(setT(() => { card.classList.add('leaving'); }, timing.stayMs));
    timers.push(setT(() => { if (current === card) { card.remove(); current = null; } if (live) live.textContent = ''; }, timing.stayMs + timing.fadeMs));
    shown += 1;
    if (onShow) onShow({ gesture, caption: pick.entry.caption, type: pick.entry.type });
    return { shown: true, caption: pick.entry.caption, type: pick.entry.type };
  }
  return { show, clear, setManifest(m) { manifest = m || FALLBACK_MANIFEST; }, get shown() { return shown; }, get active() { return !!current; }, timing, limiter: lim };
}
