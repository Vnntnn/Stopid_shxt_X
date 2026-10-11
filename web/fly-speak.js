// What the fly says out loud. Pure (no DOM, no audio): the same final result always gives the same line.
// Funny on the outside, TRUE on the inside: the candidate label and the percent (or "can't decide") are always spoken.

export const MAX_CHARS = 200;

const BUZZ = {
  th: ['บึ้นนนน', 'บึ้งงงง', 'บิ๊สสสส', 'บึ๊บๆๆ', 'หึ่งงงง', 'บึ้นๆๆๆ', 'ซี้ดดดด'],
  en: ['Bzzzzz', 'Bzzzt', 'Bzz bzz', 'Zzzzzt', 'Bzzzzzzt', 'Bzzzz bzzz'],
};

// ---- Tiny deterministic PRNG (FNV-1a hash -> mulberry32) ----
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
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

export function pickLang(final, lang) {
  if (lang === 'th' || lang === 'en') return lang;
  const l = String(final?.interpretation?.language || '').toLowerCase();
  return l.startsWith('th') ? 'th' : (l ? 'en' : 'th');
}

export function normLevel(level) {
  const n = Number(level);
  return n === 0 || n === 1 || n === 2 ? n : 2;
}

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// What the winner says: { kind: 'win'|'none'|'cant', label, pct } from a FINAL object. Tolerates missing fields.
export function summarize(final) {
  const f = final && typeof final === 'object' ? final : {};
  const cands = Array.isArray(f.candidates) ? f.candidates.filter((c) => c && typeof c === 'object') : [];
  const d = f.decision;
  if (d !== 'A' && d !== 'B' && d !== 'none') return { kind: 'cant', label: '', pct: null, id: null };
  const c = cands.find((x) => x.id === d);
  const label = clip(c?.label || (d === 'none' ? '' : d), 60);
  const pct = typeof c?.prob === 'number' && isFinite(c.prob) ? Math.round(Math.min(1, Math.max(0, c.prob)) * 100) : null;
  return { kind: d === 'none' ? 'none' : 'win', label, pct, id: d };
}

// Core sentences (always carry the truth), several flavours each.
function core(sum, lang, rng) {
  const { kind, label, pct } = sum;
  const p = pct == null ? '' : String(pct);
  if (lang === 'th') {
    if (kind === 'cant') return [pick(rng, ['แมลงวันตัดสินใจไม่ได้', 'แมลงวันสรุปไม่ได้เลยจ้า', 'งงงงง แมลงวันตัดสินใจไม่ได้อ่ะ'])];
    if (kind === 'none') {
      const l = label || 'ยังเลือกไม่ได้';
      return [pick(rng, [`แมลงวันบินไปลงที่ ${l}`, `แมลงวันลงที่ช่อง ${l}`]) + (p ? ` ${p} เปอร์เซ็นต์` : ''), 'ยังไม่มีตัวเลือกที่เหมาะชัดเจน'];
    }
    const lead = pick(rng, [`แมลงวันบินไปลงที่ ${label} แล้วจ้า`, `ติ๊ด! แมลงวันเลือก ${label}`, `แมลงวันบอกว่า ${label} จ้า`]);
    return [lead + (p ? ` ${p} เปอร์เซ็นต์` : '')];
  }
  if (kind === 'cant') return [pick(rng, ["Fly can't decide", "Fly can't decide. Too confusing", "Fly is confused and can't decide"]) + '.'];
  if (kind === 'none') {
    const l = label || 'No clear choice';
    return [pick(rng, [`Fly landed on ${l}`, `The fly picked ${l}`]) + (p ? `. ${p} percent` : '') + '.', 'There is no clear choice.'];
  }
  const lead = pick(rng, [`Fly landed on ${label}`, `The fly picked ${label}`, `Fly says ${label}`]);
  return [lead + (p ? `. ${p} percent` : '') + '.'];
}

function build(sum, lang, level, rng) {
  const buzz = BUZZ[lang];
  const b = () => pick(rng, buzz);
  const parts = core(sum, lang, rng);
  if (level === 0) return parts.join(' ');
  const sad = sum.kind === 'cant';
  const out = [];
  if (level === 1) {
    out.push(`${b()}...`);
    out.push(...parts);
    out.push(sad ? (lang === 'th' ? 'บึ๊บๆๆ' : 'Bzzt bzzt') : b());
  } else {
    // MAXIMUM: stutter, buzz between every sentence, extra tail.
    const first = b();
    out.push(`${first[0]}-${first[0]}-${first}...`);
    out.push(`${b()}!`);
    parts.forEach((s, i) => { out.push(s); if (i < parts.length - 1) out.push(b()); });
    out.push(sad ? (lang === 'th' ? 'บึ๊บๆๆ บึ้นนนน' : 'Bzzt bzzt bzzzzz') : `${b()} ${b()}`);
  }
  return out.join(' ');
}

export function flySpeech(final, lang, level = 2) {
  const L = pickLang(final, lang);
  const lv = normLevel(level);
  const sum = summarize(final);
  const seed = hashSeed([sum.id || final?.decision || 'x', sum.label, sum.pct, L, lv].join('|'));
  let text = build(sum, L, lv, mulberry32(seed));
  // Length cap: drop the silliness first, never the label or percent.
  for (let l = lv - 1; text.length > MAX_CHARS && l >= 0; l--) text = build(sum, L, l, mulberry32(seed));
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  return text;
}
