// Dev-only mock of /api/ask and /api/stt. Loaded only when ?mock is in the URL.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const SOURCES = [
  { title: 'MOCK: ตัวอย่างข้อมูลชาและกาแฟ', url: 'https://example.com/mock-drink-comparison',
    snippet: 'ข้อมูลสมมติสำหรับทดสอบ UI ไม่ใช่แหล่งอ้างอิงจริง' },
];
const FACTS = [
  { text: 'MOCK User: choose a drink with less caffeine.', source_title: '', source_url: '' },
  { text: 'MOCK: the example tea serving has less caffeine than the example coffee serving.', source_title: '', source_url: '' },
  { text: 'MOCK: caffeine depends on the drink type, preparation and serving size.', source_title: '', source_url: '' },
];
const MODEL = 'deepseek/deepseek-v4.1-flash';
const NOTICE = 'Web search was unavailable (HTTP 402), so this answer uses the model\'s own knowledge only.';

function dataFor(decision, grounded) {
  const A = decision === 'A';
  const fwd = A ? { A: 0.71, B: 0.2, none: 0.09 } : { A: 0.0946, B: 0.7633, none: 0.1421 };
  const swp = A ? { A: 0.55, B: 0.3, none: 0.15 } : { B: 0.249, A: 0.2087, none: 0.5423 };
  const mean = A ? { A: 0.63, B: 0.25, none: 0.12 } : { A: 0.1517, B: 0.5061, none: 0.3422 };
  const dec = A ? 'A' : 'inconclusive';
  const sources = grounded ? SOURCES : [];
  return {
    interpret: { echo: 'ฉันเข้าใจว่า: เปรียบเทียบชาและกาแฟ ว่าอะไรมีคาเฟอีนน้อยกว่า (คำถามตัวอย่าง)', language: 'th',
      options: [{ id: 'A', name: 'Tea', label: 'ชา', aliases: ['ชา'] }, { id: 'B', name: 'Coffee', label: 'กาแฟ', aliases: ['กาแฟ'] }],
      criterion: 'contains less caffeine', provider: MODEL,
      usage: { prompt_tokens: 2631, completion_tokens: 217, total_tokens: 2848, cost: 0.00731437 } },
    research: { facts: FACTS, as_of: '2026-10-10', sources, grounded, provider: MODEL, merged_with: 'interpret',
      search: grounded ? { engine: 'exa', max_results: 3, results_returned: sources.length, model: MODEL } : undefined,
      notice: grounded ? undefined : NOTICE },
    pool: { state: 'Findings: ' + FACTS.map((f) => f.text).join(' '), instructions: 'Which candidate contains less caffeine?',
      candidates: { A: 'Tea', B: 'Coffee', none: 'No clear choice' }, state_trimmed: !A },
    jev: { inference_ms: 805.5, forward: fwd, swapped: swp },
    adapter: { decision: dec, agree: A, mean, reason: A ? 'both runs agree and the mean clears the threshold' : 'forward and swapped runs disagree', min_conf: 0.5,
      forward_choice: A ? 'A' : 'B', swapped_choice: A ? 'A' : 'none', top: A ? 'A' : 'B', top_prob: A ? 0.63 : 0.5061, id_ok: true,
      checks: [{ name: 'choice id was one of the options sent', ok: true }, { name: 'forward and swapped runs name the same candidate', ok: A }, { name: 'mean probability >= 0.5', ok: A }] },
    final: {
      decision: dec,
      candidates: [
        { id: 'A', label: 'ชา', claim: 'Tea contains less caffeine', prob: mean.A },
        { id: 'B', label: 'กาแฟ', claim: 'Coffee contains less caffeine', prob: mean.B },
        { id: 'none', label: 'ยังเลือกไม่ได้', claim: 'No clear choice', prob: mean.none },
      ],
      interpretation: { echo: 'ฉันเข้าใจว่า: เปรียบเทียบชาและกาแฟ ว่าอะไรมีคาเฟอีนน้อยกว่า (คำถามตัวอย่าง)', language: 'th', question_en: 'Which candidate contains less caffeine?' },
      sources,
      consistency: { agree: A, forward: fwd, swapped: swp },
      jev: { inference_ms: 805.5, provider: MODEL },
      answer_text: A ? 'คำตอบตัวอย่าง: แมลงวันเลือกชา (น้ำหนัก 63%)' : 'ยังสรุปไม่ได้: การตรวจสองลำดับตัวเลือกให้คำตอบไม่ตรงกัน',
      research: { grounded, provider: MODEL },
      disclaimer: 'Entertainment demo - not a prediction', from_cache: false },
  };
}

function ndjson(lines) {
  return new ReadableStream({
    async start(controller) {
      for (const [delay, obj] of lines) {
        await sleep(delay);
        const s = JSON.stringify(obj) + '\n';
        // Split mid-line sometimes to exercise chunk handling.
        const bytes = enc.encode(s);
        const cut = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
      }
      controller.close();
    },
  });
}

// A fake "voice": syllable-like buzzy bursts with a wobbling pitch, as a 16-bit mono WAV. Enough to exercise the effects chain.
function fakeVoiceWav(text) {
  const rate = 22050;
  const dur = Math.min(2.6, 0.9 + String(text).length * 0.012);
  const n = Math.floor(rate * dur);
  const pcm = new Int16Array(n);
  let phase = 0;
  let seed = 1;
  for (const ch of String(text)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const syl = Math.max(0, Math.sin(t * 2 * Math.PI * 4.2));            // ~4 syllables per second
    const f = 240 + 90 * Math.sin(t * 2 * Math.PI * 1.3) + 40 * Math.sin(t * 17);
    phase += f / rate;
    const saw = 2 * (phase % 1) - 1;
    const v = (saw * 0.6 + (rnd() * 2 - 1) * 0.08) * syl * Math.min(1, t * 20, (dur - t) * 20);
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0.6 * 32767;
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

export function installMock(params) {
  const notice = document.createElement('aside');
  notice.className = 'mock-notice';
  notice.setAttribute('role', 'status');
  notice.append(document.createTextNode('โหมดทดสอบ · คำตอบตัวอย่าง ไม่ได้อ่านคำถามจริง '));
  const live = document.createElement('a');
  live.href = '/'; live.textContent = 'ใช้แมลงวันจริง';
  notice.append(live);
  document.getElementById('stage').append(notice);
  const mode = params.get('mock');
  const fail = params.get('fail');
  const decision = mode === 'inconclusive' || mode === 'ungrounded' ? 'inconclusive' : 'A';
  const grounded = mode !== 'ungrounded';
  const D = dataFor(decision, grounded);
  // ?xss=1 puts markup in strings that come from "the web" / "the LLM" (must render as text everywhere).
  if (params.get('xss') === '1' && grounded) {
    const evil = 'Breaking <script>alert(1)</script> <img src=x onerror="window.__xss=1"> end';
    for (const list of [D.research.sources, D.final.sources]) { list[0] = { ...list[0], snippet: evil, title: evil }; }
    D.research.facts = [{ text: evil, source_title: '', source_url: '' }, ...D.research.facts.slice(1)];
    D.final.answer_text = evil;
  }
  // ?big=1 pads the sources so the final payload is several hundred KB (exercises lazy rendering / truncation).
  if (params.get('big') === '1' && grounded) {
    const pad = Array.from({ length: 300 }, (_, i) => ({ title: `Padding source ${i + 1}`, url: `https://example.com/pad/${i + 1}`, snippet: `ข้อความยาว ${i} `.repeat(120) }));
    D.research.sources = D.research.sources.concat(pad);
    D.final.sources = D.final.sources.concat(pad);
    D.research.facts = D.research.facts.concat([{ text: 'x'.repeat(9000), source_title: '', source_url: '' }]);
  }
  const realFetch = window.fetch.bind(window);

  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/ask')) {
      const body = JSON.parse(opts.body || '{}');
      const replay = !!body.replay;
      const L = [];
      const stages = ['interpret', 'research', 'pool', 'jev', 'adapter'];
      const times = { interpret: 700, research: 1500, pool: 800, jev: 900, adapter: 300 };
      for (const s of stages) {
        L.push([120, { stage: s, status: 'start', ms: 0, data: {} }]);
        if (fail === s) {
          L.push([times[s] / 2, { stage: s, status: 'error', ms: times[s] / 2, error: { code: 'mock_failure', message: `Mock failure in ${s}` } }]);
          L.push([50, { stage: 'final', status: 'error', error: { code: 'mock_failure', message: `Mock failure in stage "${s}"` } }]);
          return new Response(ndjson(L), { headers: { 'Content-Type': 'application/x-ndjson' } });
        }
        L.push([replay ? 60 : times[s], { stage: s, status: 'done', ms: replay ? 5 : times[s], data: D[s] }]);
      }
      const fin = D.final;
      if (replay) fin.from_cache = true;
      L.push([120, { stage: 'final', status: 'done', data: fin }]);
      return new Response(ndjson(L), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    if (u.endsWith('/api/tts')) {
      const body = JSON.parse(opts.body || '{}');
      (window.__mockTts = window.__mockTts || []).push(body.text);
      await sleep(350);
      if (params.get('tts') === 'fail') {
        return new Response(JSON.stringify({ error: 'tts_not_configured', message: 'TTS is not configured (mock)' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const seen = (window.__mockTtsSeen = window.__mockTtsSeen || new Set());
      const hit = seen.has(body.text); seen.add(body.text);
      return new Response(fakeVoiceWav(body.text), { headers: { 'Content-Type': 'audio/wav', 'x-tts-cache': hit ? 'hit' : 'miss' } });
    }
    if (u.endsWith('/api/stt')) {
      await sleep(900);
      return new Response(JSON.stringify({ text: 'ระหว่างชากับกาแฟ ถ้าอยากลดคาเฟอีนควรเลือกอะไร?' }), { headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  // No real microphone (CI, headless, laptop without one): give MediaRecorder a synthetic stream.
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  const realGum = md.getUserMedia ? md.getUserMedia.bind(md) : null;
  md.getUserMedia = async (c) => {
    if (realGum && (params.get('realmic') === '1' || (c && c.video))) return realGum(c); // the synthetic stream is audio only
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    osc.frequency.value = 220;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    return dest.stream;
  };
}

// ---------------------------------------------------------------------------------------------
// Mock camera: scripted pose / hand-label sequences that go through the SAME gesture engine as a
// real camera (?cam=mock). Pure data generators: no DOM, no network (also used by the tests).
// Raw camera coordinates: x right, y down, the person's LEFT side is at larger x. Shoulder width 0.16.
// ---------------------------------------------------------------------------------------------
function rng32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const MOCK_SW = 0.16;
const BASE = {
  nose: [0.5, 0.30], ls: [0.58, 0.45], rs: [0.42, 0.45], le: [0.60, 0.58], re: [0.40, 0.58], lw: [0.60, 0.70], rw: [0.40, 0.70], lh: [0.56, 0.85], rh: [0.44, 0.85],
};

// o: { dy, scale, noseDx, lw:[x,y], rw:[x,y], le, re, shDx } -> 33 landmarks {x, y, visibility}
export function standingPose(o = {}) {
  const dy = o.dy || 0, sc = o.scale || 1, shDx = o.shDx || 0;
  const tilt = o.tilt || 0; // > 0: the person's LEFT shoulder drops (shoulder line tilts), used by the Copy me dance
  const sh = (p, dx = 0) => [0.5 + (p[0] - 0.5) * sc + dx, 0.45 + (p[1] - 0.45) * sc + dy];
  const pt = (p, v = 1) => ({ x: p[0], y: p[1], visibility: v });
  const nose = sh(BASE.nose, (o.noseDx || 0));
  const ls = sh(BASE.ls, shDx), rs = sh(BASE.rs, shDx);
  if (tilt) { ls[1] += tilt; rs[1] -= tilt; }
  const lw = o.lw ? [o.lw[0], o.lw[1] + dy] : sh(BASE.lw, shDx);
  const rw = o.rw ? [o.rw[0], o.rw[1] + dy] : sh(BASE.rw, shDx);
  const le = o.le ? [o.le[0], o.le[1] + dy] : sh(BASE.le, shDx);
  const re = o.re ? [o.re[0], o.re[1] + dy] : sh(BASE.re, shDx);
  const lm = Array.from({ length: 33 }, () => pt(nose, 0.5));
  const set = (i, p, v = 1) => { lm[i] = pt(p, v); };
  set(0, nose);
  set(1, [nose[0] + 0.015, nose[1] - 0.02]); set(2, [nose[0] + 0.03, nose[1] - 0.02]); set(3, [nose[0] + 0.045, nose[1] - 0.015]);
  set(4, [nose[0] - 0.015, nose[1] - 0.02]); set(5, [nose[0] - 0.03, nose[1] - 0.02]); set(6, [nose[0] - 0.045, nose[1] - 0.015]);
  set(7, [nose[0] + 0.07, nose[1]]); set(8, [nose[0] - 0.07, nose[1]]); set(9, [nose[0] + 0.015, nose[1] + 0.04]); set(10, [nose[0] - 0.015, nose[1] + 0.04]);
  set(11, ls); set(12, rs); set(13, le); set(14, re); set(15, lw); set(16, rw);
  set(17, [lw[0] + 0.01, lw[1] + 0.03]); set(18, [rw[0] - 0.01, rw[1] + 0.03]); set(19, [lw[0] + 0.02, lw[1] + 0.025]); set(20, [rw[0] - 0.02, rw[1] + 0.025]);
  set(21, [lw[0] - 0.01, lw[1] + 0.02]); set(22, [rw[0] + 0.01, rw[1] + 0.02]);
  set(23, [BASE.lh[0], BASE.lh[1] + dy], 0.9); set(24, [BASE.rh[0], BASE.rh[1] + dy], 0.9);
  set(25, [0.57, 1.12 + dy], 0.1); set(26, [0.43, 1.12 + dy], 0.1); set(27, [0.57, 1.3 + dy], 0.05); set(28, [0.43, 1.3 + dy], 0.05);
  set(29, [0.58, 1.32 + dy], 0.05); set(30, [0.42, 1.32 + dy], 0.05); set(31, [0.59, 1.35 + dy], 0.05); set(32, [0.41, 1.35 + dy], 0.05);
  return lm;
}

const TAU = Math.PI * 2;
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
// Scene definitions: dur (ms of the action), rest (ms of standing before it, enough history for jump/squat),
// pose(tSec, amp) -> standingPose options, hands(tSec) -> label list. `amp` scales the key movement (0.2 = a near miss).
export const MOCK_SCENES = {
  wave: { dur: 2400, rest: 800, pose: (t, a) => ({ rw: [0.40 + Math.sin(TAU * 2.2 * t) * 0.045 * a, 0.38 - ease(t / 0.3) * 0.0], re: [0.38, 0.47] }) },
  hands_up: { dur: 1800, rest: 800, pose: (t, a) => { const k = ease(t / 0.4) * a; return { lw: [0.62, 0.70 - 0.55 * k], rw: [0.38, 0.70 - 0.55 * k], le: [0.62, 0.58 - 0.3 * k], re: [0.38, 0.58 - 0.3 * k] }; } },
  hand_up_left: { dur: 1800, rest: 800, pose: (t, a) => { const k = ease(t / 0.4) * a; return { lw: [0.63, 0.70 - 0.56 * k], le: [0.62, 0.58 - 0.25 * k] }; } },
  hand_up_right: { dur: 1800, rest: 800, pose: (t, a) => { const k = ease(t / 0.4) * a; return { rw: [0.37, 0.70 - 0.56 * k], re: [0.38, 0.58 - 0.25 * k] }; } },
  t_pose: { dur: 2200, rest: 800, pose: (t, a) => { const k = ease(t / 0.5) * a; return { lw: [0.60 + 0.28 * k, 0.70 - 0.25 * k], rw: [0.40 - 0.28 * k, 0.70 - 0.25 * k], le: [0.60 + 0.14 * k, 0.58 - 0.13 * k], re: [0.40 - 0.14 * k, 0.58 - 0.13 * k] }; } },
  clap: { dur: 1500, rest: 800, pose: (t, a) => { const g = ease(t / 0.3); const x = 0.10 * a * (0.5 + 0.5 * Math.cos(TAU * 2 * t)); const y = 0.70 - 0.15 * g; return { lw: [0.5 + x, y], rw: [0.5 - x, y], le: [0.57, 0.6], re: [0.43, 0.6] }; } },
  lean_left: { dur: 1800, rest: 800, pose: (t, a) => ({ noseDx: 0.12 * ease(t / 0.4) * a, shDx: 0.02 * ease(t / 0.4) * a }) },
  lean_right: { dur: 1800, rest: 800, pose: (t, a) => ({ noseDx: -0.12 * ease(t / 0.4) * a, shDx: -0.02 * ease(t / 0.4) * a }) },
  jump: { dur: 1500, rest: 2200, pose: (t, a) => ({ dy: t < 0.6 ? -0.10 * Math.sin(Math.PI * t / 0.6) * a : 0 }) },
  belly_rub: { dur: 2200, rest: 800, pose: (t, a) => { const k = ease(t / 0.3), r = 0.045 * a, c = [0.47, 0.75]; return { rw: [0.40 + (c[0] + Math.cos(TAU * 2.2 * t) * r - 0.40) * k, 0.70 + (c[1] + Math.sin(TAU * 2.2 * t) * r - 0.70) * k], re: [0.42, 0.62] }; } },
  squat: { dur: 2200, rest: 3600, pose: (t, a) => ({ dy: 0.12 * a * ease(t / 0.7) * (t < 1.6 ? 1 : 1 - ease((t - 1.6) / 0.5)) }) },
};
// ---- "Copy me" dance: held poses with a 0.3 s ease-in, standing in between. Names start with d_ (the others are reused as they are). ----
const ARM_UP = (side, k) => (side === 'r' ? { rw: [0.37, 0.70 - 0.56 * k], re: [0.38, 0.58 - 0.25 * k] } : { lw: [0.63, 0.70 - 0.56 * k], le: [0.62, 0.58 - 0.25 * k] });
export const DANCE_SCENES = {
  d_stand: { dur: 2600, rest: 0, pose: () => ({}) },
  d_right_hand: { dur: 2200, rest: 300, pose: (t) => ARM_UP('r', ease(t / 0.4)) },
  d_left_hand: { dur: 2200, rest: 300, pose: (t) => ARM_UP('l', ease(t / 0.4)) },
  d_both_up: { dur: 2200, rest: 300, pose: (t) => { const k = ease(t / 0.4); return { lw: [0.62, 0.70 - 0.58 * k], rw: [0.38, 0.70 - 0.58 * k], le: [0.62, 0.58 - 0.3 * k], re: [0.38, 0.58 - 0.3 * k] }; } },
  d_t_pose: { dur: 2200, rest: 300, pose: (t) => { const k = ease(t / 0.5); return { lw: [0.60 + 0.28 * k, 0.70 - 0.25 * k], rw: [0.40 - 0.28 * k, 0.70 - 0.25 * k], le: [0.60 + 0.14 * k, 0.58 - 0.13 * k], re: [0.40 - 0.14 * k, 0.58 - 0.13 * k] }; } },
  d_lean_left: { dur: 2200, rest: 300, pose: (t) => ({ tilt: 0.035 * ease(t / 0.4), shDx: 0.03 * ease(t / 0.4), noseDx: 0.05 * ease(t / 0.4) }) },
  d_lean_right: { dur: 2200, rest: 300, pose: (t) => ({ tilt: -0.035 * ease(t / 0.4), shDx: -0.03 * ease(t / 0.4), noseDx: -0.05 * ease(t / 0.4) }) },
  d_squat: { dur: 2200, rest: 300, pose: (t) => ({ dy: 0.12 * ease(t / 0.6) * (t < 1.7 ? 1 : 1 - ease((t - 1.7) / 0.5)) }) },
};
export const DANCE_ORDER = ['d_stand', 'd_right_hand', 'd_left_hand', 'd_both_up', 'd_t_pose', 'd_lean_left', 'd_lean_right', 'd_squat', 'jump', 'clap', 'wave', 'thumbs_up', 'peace', 'fist', 'open_palm', 'point_up'];
export const DANCE_CAPTIONS = {
  d_stand: 'Stand still (calibrating)', d_right_hand: 'Raise right hand', d_left_hand: 'Raise left hand', d_both_up: 'Both hands up', d_t_pose: 'T-pose, arms wide',
  d_lean_left: 'Lean left', d_lean_right: 'Lean right', d_squat: 'Squat', jump: 'Jump', clap: 'Clap', wave: 'Wave', thumbs_up: 'Thumbs up', peace: 'Peace sign', fist: 'Fist', open_palm: 'Open palm', point_up: 'Point up',
};
const sceneOf = (name) => MOCK_SCENES[name] || DANCE_SCENES[name];

const HAND_SCENES = { thumbs_up: 'Thumb_Up', thumbs_down: 'Thumb_Down', peace: 'Victory', open_palm: 'Open_Palm', fist: 'Closed_Fist', point_up: 'Pointing_Up', i_love_you: 'ILoveYou' };
for (const [g, label] of Object.entries(HAND_SCENES)) MOCK_SCENES[g] = { dur: 1700, rest: 700, pose: () => ({}), hands: () => [{ label, score: 0.93 }] };
export const MOCK_ORDER = ['wave', 'hands_up', 'hand_up_left', 'hand_up_right', 't_pose', 'clap', 'lean_left', 'lean_right', 'jump', 'squat', 'belly_rub', 'thumbs_up', 'thumbs_down', 'peace', 'open_palm', 'fist', 'point_up', 'i_love_you'];

// Frames of one scene: [{ts, pose, hands}] starting at ts = t0, restMs of standing first. noise = sigma on x/y.
export function buildScene(name, { t0 = 0, fps = 15, amp = 1, noise = 0, seed = 1, rest, tail = 500, handEvery = 2 } = {}) {
  const sc = sceneOf(name);
  const rand = rng32(seed);
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rand(); return (u - 3) / 0.7071; }; // ~N(0,1)
  const frames = [];
  const restMs = rest == null ? sc.rest : rest;
  const total = restMs + sc.dur + tail, step = 1000 / fps;
  for (let k = 0, t = 0; t <= total; k++, t = k * step) {
    const active = t >= restMs && t <= restMs + sc.dur;
    const ts = Math.round((t0 + t) * 100) / 100;
    const o = active ? sc.pose((t - restMs) / 1000, amp) : {};
    let pose = standingPose(o);
    if (noise) pose = pose.map((p) => ({ ...p, x: p.x + gauss() * noise, y: p.y + gauss() * noise }));
    let hands;
    if (k % handEvery === 0) hands = active && sc.hands ? sc.hands((t - restMs) / 1000) : [];
    frames.push({ ts, pose, hands });
  }
  return { frames, restMs, durMs: sc.dur, endTs: t0 + total };
}

// Whole timeline for ?cam=mock: every gesture in turn (a visible schedule for the UI).
export function buildTimeline(order = MOCK_ORDER) {
  let t = 0; const items = [];
  for (const name of order) {
    const s = sceneOf(name);
    items.push({ name, start: t, actionStart: t + s.rest, end: t + s.rest + s.dur + 500 });
    t += s.rest + s.dur + 500;
  }
  return { items, totalMs: t };
}
export function mockFrameAt(timeline, tMs, fps = 15) {
  const total = timeline.totalMs;
  const t = ((tMs % total) + total) % total;
  const it = timeline.items.find((x) => t >= x.start && t < x.end) || timeline.items[0];
  const sc = sceneOf(it.name);
  const local = t - it.start, active = local >= sc.rest && local <= sc.rest + sc.dur;
  const pose = standingPose(active ? sc.pose((local - sc.rest) / 1000, 1) : {});
  const hands = active && sc.hands ? sc.hands() : [];
  return { item: it, pose, hands, active, local };
}
