// Dev-only mock of /api/ask and /api/stt. Loaded only when ?mock is in the URL.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const SOURCES = [
  { title: '"อนุทิน" มั่นใจเสียงพรรคร่วมรับศึกซักฟอก ยันไม่มีดีลล่วงหน้า "กล้าธรรม" | Thai PBS News ข่าวไทยพีบีเอส', url: 'https://www.thaipbs.or.th/news/content/570727',
    snippet: '"อนุทิน" มั่นใจเสียงพรรคร่วมรับศึกซักฟอก ยันไม่มีดีลล่วงหน้า "กล้าธรรม" | Thai PBS News ข่าวไทยพีบีเอส ... # "อนุทิน" มั่นใจเสียงพรรคร่วมรับศึกซักฟอก ยันไม่มีดีลล่วงหน้า "กล้าธรรม" ... การเมือง 10 ต.ค. 69 ... "อนุทิน" มั่นใจเสียงพรรคร่วมลุยอภิปรายไม่ไว้วางใจ ฝ่ายค้านขอเวลา 5 วัน ขณะที่วิป 2 ฝ่ายยังหารือกำหนดวันอยู่ ... ' },
  { title: '"อนุทิน" มั่นใจเสียงรัฐบาล ซัด "สาธุ" หากกล้าธรรมช่วยหนุน แซว "พลพีร์" หนาวสุด มท.2 รอดซักฟอกคนเดียว | สยามรัฐ | LINE TODAY', url: 'https://today.line.me/th/v3/article/GgNM3j8',
    snippet: '"อนุทิน" มั่นใจเสียงรัฐบาล ซัด "สาธุ" หากกล้าธรรมช่วยหนุน แซว "พลพีร์" หนาวสุด มท.2 รอดซักฟอกคนเดียว | สยามรัฐ | LINE TODAY #### สยามรัฐ' },
  { title: 'Poll: support for People\'s Party edges up, Bhumjaithai steady (sample)', url: 'https://www.example.com/poll/2026-10?utm_source=mock&very_long_parameter=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    snippet: 'A new national poll of 2,400 voters puts the People\'s Party at 31% and Bhumjaithai at 29%, within the margin of error.   The survey was fielded over\nfour days and weighted by region, age and education. ... Analysts caution that a large share of respondents remain undecided, and that regional swings differ widely from the national average. Pollsters said the next wave is due in November.' },
];
const FACTS = [
  { text: 'Anutin, Bhumjaithai leader and PM, says he is confident in coalition MPs\' support ahead of a censure debate.', source_title: '', source_url: '' },
  { text: 'Anutin said there is no advance deal with the Klatham Party and joked \'sadhu\' if it backs the government.', source_title: '', source_url: '' },
  { text: 'The opposition requested five days for the no-confidence debate; timing is still being discussed by whips.', source_title: '', source_url: '' },
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
    interpret: { echo: 'ฉันเข้าใจว่าคุณถามว่า ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู พรรคไหนมีผลโพลนำ', language: 'th',
      parties: [{ id: 'A', name: "People's Party", aliases: ['พรรคของคุณพิธา', 'พรรคประชาชน', "Pitha's party"] }, { id: 'B', name: 'Bhumjaithai Party', aliases: ['พรรคของเสี่ยหนู', 'พรรคภูมิใจไทย', "Anutin's party"] }],
      criterion: 'is ahead in the latest polls', provider: MODEL,
      usage: { prompt_tokens: 2631, completion_tokens: 217, total_tokens: 2848, cost: 0.00731437 } },
    research: { facts: FACTS, as_of: '2026-10-10', sources, grounded, provider: MODEL, merged_with: 'interpret',
      search: grounded ? { engine: 'exa', max_results: 3, results_returned: sources.length, model: MODEL } : undefined,
      notice: grounded ? undefined : NOTICE },
    pool: { state: 'Findings: ' + FACTS.map((f) => f.text).join(' '), instructions: 'Which candidate is ahead in the latest polls?',
      candidates: { A: "People's Party", B: 'Bhumjaithai Party', none: 'No clear leader' }, state_trimmed: !A },
    jev: { inference_ms: 805.5, forward: fwd, swapped: swp },
    adapter: { decision: dec, agree: A, mean, reason: A ? 'both runs agree and the mean clears the threshold' : 'forward and swapped runs disagree', min_conf: 0.5,
      forward_choice: A ? 'A' : 'B', swapped_choice: A ? 'A' : 'none', top: A ? 'A' : 'B', top_prob: A ? 0.63 : 0.5061, id_ok: true,
      checks: [{ name: 'choice id was one of the options sent', ok: true }, { name: 'forward and swapped runs name the same candidate', ok: A }, { name: 'mean probability >= 0.5', ok: A }] },
    final: {
      decision: dec,
      candidates: [
        { id: 'A', label: "People's Party", claim: "People's Party is ahead in the latest polls", prob: mean.A },
        { id: 'B', label: 'Bhumjaithai Party', claim: 'Bhumjaithai Party is ahead in the latest polls', prob: mean.B },
        { id: 'none', label: 'ไม่มีผู้นำที่ชัดเจน', claim: 'No clear leader', prob: mean.none },
      ],
      interpretation: { echo: 'ฉันเข้าใจว่าคุณถามว่า ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู พรรคไหนมีผลโพลนำ', language: 'th', question_en: 'Which candidate is ahead in the latest polls?' },
      sources,
      consistency: { agree: A, forward: fwd, swapped: swp },
      jev: { inference_ms: 805.5, provider: MODEL },
      answer_text: A ? 'จากแหล่งข้อมูลที่ค้นพบ แหล่งข้อมูลสนับสนุนว่าพรรคประชาชนมีแนวโน้มนำ (63%)' : 'ยังสรุปไม่ได้: การตรวจสองลำดับตัวเลือกให้คำตอบไม่ตรงกัน',
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

export function installMock(params) {
  const mode = params.get('mock');
  const fail = params.get('fail');
  const decision = mode === 'inconclusive' || mode === 'ungrounded' ? 'inconclusive' : 'A';
  const grounded = mode !== 'ungrounded';
  const D = dataFor(decision, grounded);
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
