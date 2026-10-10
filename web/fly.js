import { STAGES, newState, applyEvent, parseNdjsonStream } from '/static/fly-stream.js';
import { createScene } from '/static/fly-scene.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLORS = { A: 'var(--a)', B: 'var(--b)', none: 'var(--none)' };
const STAGE_LABEL = { interpret: 'Interpret question', research: 'Research sources', pool: 'Build candidates', jev: 'Jev (2 runs)', adapter: 'Verify decision' };

if (params.has('mock')) {
  const { installMock } = await import('/static/fly-mock.js');
  installMock(params);
}

// ---- Scene ----
const scene = createScene($('stage'), { reducedMotion: reduced });
if (!scene.ok) $('webgl-fallback').hidden = false;
function fly(state, opts) {
  scene.setState(state, opts);
  $('fly-state').textContent = state;
}
if (params.has('mock')) window.__fly = { scene };
addEventListener('pagehide', () => scene.dispose());

// ---- Ask / stream ----
let controller = null;
let lastText = '';
let tick = null;
let starts = {};

function renderStages(state) {
  const ol = $('stages');
  ol.hidden = false;
  $('out-empty').hidden = true;
  ol.replaceChildren(...STAGES.map((s) => {
    const st = state.stages[s];
    const li = document.createElement('li');
    li.dataset.status = st.status;
    li.dataset.stage = s;
    const ico = document.createElement('span'); ico.className = 'ico'; ico.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = STAGE_LABEL[s] + (st.status === 'done' ? ' - done' : st.status === 'running' ? ' - working' : st.status === 'error' ? ' - failed' : '');
    const ms = document.createElement('span'); ms.className = 'ms';
    ms.textContent = st.ms != null && st.status !== 'running' && st.status !== 'pending' ? st.ms + ' ms' : '';
    li.append(ico, name, ms);
    return li;
  }));
}

function showError(message) {
  $('error').hidden = false;
  $('error-msg').textContent = message;
}

function renderFinal(f) {
  $('result').hidden = false;
  $('stages').classList.add('compact');
  $('echo').textContent = f.interpretation?.echo || '';
  $('answer').textContent = f.answer_text || '';
  const bars = $('bars');
  bars.replaceChildren(...(f.candidates || []).map((c) => {
    const li = document.createElement('li');
    li.dataset.win = String(c.id === f.decision);
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = c.label || c.id;
    const p = document.createElement('span'); p.textContent = Math.round((c.prob || 0) * 100) + '%';
    const track = document.createElement('div'); track.className = 'track';
    const fill = document.createElement('div'); fill.className = 'fill';
    fill.style.background = COLORS[c.id] || 'var(--muted)';
    fill.style.width = '0%';
    track.append(fill);
    li.append(l, p, track);
    li.title = c.claim || '';
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = Math.round((c.prob || 0) * 100) + '%'; }));
    return li;
  }));
  const agree = f.consistency?.agree;
  const chip = $('agree');
  chip.textContent = agree ? 'Both Jev runs agree' : 'Jev runs disagree';
  chip.className = 'chip ' + (agree ? 'ok' : 'warn');
  $('cache').hidden = !f.from_cache;
  $('infer').textContent = f.jev?.inference_ms != null ? `Jev inference ${Math.round(f.jev.inference_ms)} ms` : '';
  $('infer').hidden = f.jev?.inference_ms == null;
  const t = $('runs');
  const ids = (f.candidates || []).map((c) => c.id);
  const head = '<tr><th></th>' + ids.map((i) => `<th>${i}</th>`).join('') + '</tr>';
  const row = (name, o) => `<tr><th>${name}</th>` + ids.map((i) => `<td>${o && o[i] != null ? Math.round(o[i] * 100) + '%' : '-'}</td>`).join('') + '</tr>';
  t.innerHTML = head + row('forward', f.consistency?.forward) + row('swapped', f.consistency?.swapped);
  const ul = $('sources');
  ul.replaceChildren(...(f.sources || []).filter((s) => /^https?:\/\//i.test(s.url)).map((s) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = s.title || s.url;
    li.append(a);
    return li;
  }));
  $('disclaimer').textContent = f.disclaimer || 'Entertainment demo - not a prediction';
  requestAnimationFrame(() => { $('out-title').parentElement.scrollTop = 0; });
}

async function ask(text) {
  text = text.trim();
  if (!text) return;
  lastText = text;
  if (controller) controller.abort();
  controller = new AbortController();
  const mine = controller;
  starts = {};
  clearInterval(tick);
  $('result').hidden = true;
  $('error').hidden = true;
  $('send').disabled = true;
  let state = newState();
  $('stages').classList.remove('compact');
  renderStages(state);
  fly('thinking');
  scene.setCandidates([]);
  tick = setInterval(() => {
    for (const li of $('stages').children) {
      if (li.dataset.status === 'running' && starts[li.dataset.stage]) li.querySelector('.ms').textContent = Math.round(performance.now() - starts[li.dataset.stage]) + ' ms';
    }
  }, 120);
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, replay: $('replay').checked }),
      signal: mine.signal,
    });
    if (!res.ok || !res.body) {
      let msg = `Request failed (HTTP ${res.status})`;
      try { const j = await res.json(); msg = j.error?.message || j.detail?.message || (typeof j.detail === 'string' ? j.detail : msg); } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    await parseNdjsonStream(res.body, (ev) => {
      if (ev.status === 'start' && STAGES.includes(ev.stage)) starts[ev.stage] = performance.now();
      state = applyEvent(state, ev);
      renderStages(state);
    });
    if (state.final) {
      scene.setCandidates(state.final.candidates);
      renderFinal(state.final);
      const d = state.final.decision;
      if (d === 'A' || d === 'B' || d === 'none') fly('deciding', { pad: d }); else fly('inconclusive');
    } else {
      throw new Error(state.error?.message || 'The stream ended without an answer.');
    }
  } catch (err) {
    if (mine.signal.aborted) return;
    fly('idle');
    showError(err.message || String(err));
  } finally {
    if (controller === mine) { clearInterval(tick); $('send').disabled = false; }
  }
}

// ---- Text input ----
$('send').addEventListener('click', () => ask($('q').value || $('q').placeholder));
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('q').value || $('q').placeholder); }
});
$('retry').addEventListener('click', () => ask(lastText));

// ---- Mode toggle ----
function setMode(mode) {
  const voice = mode === 'voice';
  $('tab-text').setAttribute('aria-selected', String(!voice));
  $('tab-voice').setAttribute('aria-selected', String(voice));
  $('tab-text').tabIndex = voice ? -1 : 0;
  $('tab-voice').tabIndex = voice ? 0 : -1;
  $('pane-text').hidden = voice;
  $('pane-voice').hidden = !voice;
  if (!voice && rec.active) stopRecording(true);
}
$('tab-text').addEventListener('click', () => setMode('text'));
$('tab-voice').addEventListener('click', () => setMode('voice'));
for (const t of [$('tab-text'), $('tab-voice')]) {
  t.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const v = t.id === 'tab-text'; setMode(v ? 'voice' : 'text'); (v ? $('tab-voice') : $('tab-text')).focus(); }
  });
}

// ---- Voice ----
const rec = { active: false, stream: null, recorder: null, chunks: [], ctx: null, raf: 0, t0: 0, discard: false };
let countdownTimer = null;

function setMicStatus(msg) { $('mic-status').textContent = msg; }

function cancelCountdown() {
  clearInterval(countdownTimer);
  $('confirm-row').hidden = true;
  $('countdown').textContent = '';
}
function showTranscript(text) {
  const box = $('transcript');
  box.hidden = false;
  box.value = text;
  $('confirm-row').hidden = false;
  let n = 4;
  const label = () => { $('countdown').textContent = `Sending in ${n}s...`; };
  label();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) { cancelCountdown(); ask(box.value); } else label();
  }, 1000);
}
$('transcript').addEventListener('input', () => { if (!$('confirm-row').hidden) { clearInterval(countdownTimer); $('countdown').textContent = 'Edited - press Send now'; } });
$('cancel-send').addEventListener('click', () => { cancelCountdown(); setMicStatus('Cancelled. Edit the transcript and press Send, or record again.'); $('confirm-row').hidden = false; $('countdown').textContent = ''; });
$('send-voice').addEventListener('click', () => { cancelCountdown(); ask($('transcript').value); });

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

function fmt(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

async function startRecording() {
  cancelCountdown();
  if (!navigator.mediaDevices?.getUserMedia || pickMime() === null) {
    setMicStatus('This browser cannot record audio. Switch to Text input.');
    return;
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setMicStatus(denied ? 'Microphone permission was denied. Allow it in the browser, or use Text.' : 'No microphone found or it is busy. Use Text instead.');
    return;
  }
  const mime = pickMime();
  rec.chunks = [];
  rec.discard = false;
  rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = onRecorded;
  rec.recorder.start(250);
  try {
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = rec.ctx.createAnalyser();
    an.fftSize = 512;
    rec.ctx.createMediaStreamSource(rec.stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      $('meter-bar').style.width = Math.min(100, (peak / 128) * 160) + '%';
      $('mic-time').textContent = fmt(performance.now() - rec.t0);
      rec.raf = requestAnimationFrame(loop);
    };
    rec.t0 = performance.now();
    loop();
  } catch (_) { rec.t0 = performance.now(); }
  rec.active = true;
  $('mic').setAttribute('aria-pressed', 'true');
  $('mic').setAttribute('aria-label', 'Stop recording');
  setMicStatus('Listening... click again to stop.');
  fly('listening');
}

function stopRecording(discard = false) {
  if (!rec.active) return;
  rec.active = false;
  rec.discard = discard;
  cancelAnimationFrame(rec.raf);
  $('meter-bar').style.width = '0%';
  $('mic').setAttribute('aria-pressed', 'false');
  $('mic').setAttribute('aria-label', 'Start recording');
  try { rec.recorder.stop(); } catch (_) { /* already stopped */ }
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.ctx?.close().catch(() => {});
  fly('idle');
}
$('mic').addEventListener('click', () => (rec.active ? stopRecording() : startRecording()));

async function onRecorded() {
  if (rec.discard) return;
  const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
  if (blob.size < 200) { setMicStatus('Nothing was recorded. Try again.'); return; }
  setMicStatus('Transcribing...');
  const fd = new FormData();
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
  fd.append('audio', blob, `speech.${ext}`);
  fd.append('language', 'th');
  try {
    const res = await fetch('/api/stt', { method: 'POST', body: fd });
    if (!res.ok) {
      let code = '';
      try { const j = await res.json(); code = j.error?.code || j.detail?.code || j.detail || ''; } catch (_) { /* ignore */ }
      throw Object.assign(new Error(`stt ${res.status}`), { status: res.status, code });
    }
    const j = await res.json();
    if (!j.text || !j.text.trim()) { setMicStatus('No speech detected. Try again.'); return; }
    setMicStatus('Heard you. Check the text, it will send in a moment.');
    showTranscript(j.text.trim());
  } catch (err) {
    browserSpeechFallback(err.status === 503 ? 'Server speech-to-text is not configured.' : 'Server speech-to-text failed.');
  }
}

function browserSpeechFallback(reason) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setMicStatus(`${reason} This browser has no speech recognition either. Please use Text.`); return; }
  setMicStatus(`${reason} Using browser speech recognition: speak now.`);
  const r = new SR();
  r.lang = 'th-TH';
  r.interimResults = false;
  r.maxAlternatives = 1;
  fly('listening');
  r.onresult = (e) => { const t = e.results[0][0].transcript; setMicStatus('Heard you. Check the text, it will send in a moment.'); showTranscript(t); };
  r.onerror = (e) => setMicStatus(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Browser speech recognition failed (${e.error}). Use Text.`);
  r.onend = () => fly('idle');
  try { r.start(); } catch (_) { setMicStatus('Could not start browser speech recognition. Use Text.'); }
}

addEventListener('pagehide', () => { if (rec.active) stopRecording(true); });
