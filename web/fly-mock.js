// Dev-only mock of /api/ask and /api/stt. Loaded only when ?mock is in the URL.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const SOURCES = [
  { title: 'Poll: party support, Thailand (sample)', url: 'https://example.com/poll', snippet: 'Latest poll puts the People\'s Party ahead.' },
  { title: 'News: campaign update (sample)', url: 'https://example.com/news', snippet: 'Bhumjaithai gains in the north-east.' },
];

function finalFor(decision, text) {
  const probs = decision === 'A' ? { A: 0.62, B: 0.3, none: 0.08 } : { A: 0.36, B: 0.34, none: 0.3 };
  const sw = decision === 'A' ? { A: 0.58, B: 0.35, none: 0.07 } : { A: 0.31, B: 0.4, none: 0.29 };
  return {
    decision,
    candidates: [
      { id: 'A', label: "People's Party", claim: 'Sources support a People\'s Party lead.', prob: probs.A },
      { id: 'B', label: 'Bhumjaithai', claim: 'Sources support a Bhumjaithai lead.', prob: probs.B },
      { id: 'none', label: 'No clear leader', claim: 'Sources show no clear leader.', prob: probs.none },
    ],
    interpretation: { echo: 'ฉันเข้าใจว่าคุณถามว่า พรรคประชาชน (อดีตพรรคของคุณพิธา) กับ ภูมิใจไทย พรรคไหนมีผลโพลนำ', language: 'th', question_en: text || 'Which party leads?' },
    sources: SOURCES,
    consistency: { agree: decision === 'A', forward: probs, swapped: sw },
    jev: { inference_ms: 118.4, provider: 'gemini' },
    answer_text: decision === 'A'
      ? 'จากแหล่งข้อมูลที่ค้นพบ แหล่งข้อมูลสนับสนุนว่าพรรคประชาชนมีแนวโน้มนำ (62%)'
      : 'ผลสองรอบไม่สอดคล้องกัน จึงสรุปไม่ได้ว่าฝ่ายใดนำ',
    disclaimer: 'Entertainment demo - not a prediction',
    from_cache: false,
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

export function installMock(params) {
  const mode = params.get('mock');
  const fail = params.get('fail');
  const decision = mode === 'inconclusive' ? 'inconclusive' : 'A';
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
        L.push([replay ? 60 : times[s], { stage: s, status: 'done', ms: replay ? 5 : times[s], data: s === 'interpret' ? { echo: 'x' } : {} }]);
      }
      const fin = finalFor(decision, body.text);
      if (replay) fin.from_cache = true;
      L.push([120, { stage: 'final', status: 'done', data: fin }]);
      return new Response(ndjson(L), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    if (u.endsWith('/api/stt')) {
      await sleep(900);
      return new Response(JSON.stringify({ text: 'ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู ใครจะชนะ?' }), { headers: { 'Content-Type': 'application/json' } });
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
