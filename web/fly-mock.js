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
    if (realGum && params.get('realmic') === '1') return realGum(c);
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
