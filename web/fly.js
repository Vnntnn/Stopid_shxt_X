import { STAGES, newState, applyEvent, parseNdjsonStream } from '/static/fly-stream.js';
import { createScene } from '/static/fly-scene.js';
import { createFlyAudio } from '/static/fly-audio.js';
import { flySpeech } from '/static/fly-speak.js';
import { tokenizeJson, sessionExport, exportFileName, byteSize, formatBytes, makeEventRecord, collapseState, toggleCollapsed, collapseAll, expandAll, allCollapsed, LARGE_BYTES } from '/static/fly-json.js';
import { createMimic, RIG_KEYS } from '/static/fly-mimic.js';
import { createCamera } from '/static/fly-cam.js';
import { createGestureEngine, GESTURES, GESTURE_TITLES, SENSITIVITIES, ACTION_TYPES, ACTION_LABELS, defaultActionsConfig, normalizeActionsConfig, planAction, requiredHolds, ASK_COOLDOWN_MS } from '/static/fly-gestures.js';
import { createMemeOverlay, parseManifest, FALLBACK_MANIFEST } from '/static/fly-memes.js';
import { hostnameOf, formatCost, formatPct, formatSeconds, clampText, safeHttpUrl, deriveChecks } from '/static/fly-format.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLORS = { A: 'var(--a)', B: 'var(--b)', none: 'var(--none)' };
const STAGE_LABEL = { interpret: 'Interpret question', research: 'Research sources', pool: 'Build candidates', jev: 'Jev (2 runs)', adapter: 'Verify decision' };

const camMock = params.get('cam') === 'mock';
let mockMod = null;
if (params.has('mock') || camMock) {
  mockMod = await import('/static/fly-mock.js');
  if (params.has('mock')) mockMod.installMock(params);
}

// ---- Scene ----
const scene = createScene($('stage'), { reducedMotion: reduced });
if (!scene.ok) $('webgl-fallback').hidden = false;
function fly(state, opts) {
  scene.setState(state, opts);
  engine.setState(state, opts);
  $('fly-state').textContent = state;
}
if (params.has('mock')) window.__fly = { scene };
addEventListener('pagehide', () => { scene.dispose(); engine.dispose(); });

// ---- Fly sound (stupid on purpose). Nothing plays until a Send / mic / Replay click unlocks audio. ----
const engine = createFlyAudio();
const SOUND_KEY = 'fly.sound';
const prefs = { muted: false, volume: 0.6, level: 2 };
try {
  const j = JSON.parse(localStorage.getItem(SOUND_KEY) || '{}');
  if (typeof j.muted === 'boolean') prefs.muted = j.muted;
  if (typeof j.volume === 'number') prefs.volume = Math.min(1, Math.max(0, j.volume));
  if ([0, 1, 2].includes(j.level)) prefs.level = j.level;
} catch (_) { /* storage blocked: defaults */ }
function savePrefs() { try { localStorage.setItem(SOUND_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ } }
function syncSoundUi() {
  $('mute').setAttribute('aria-pressed', String(prefs.muted));
  $('mute').textContent = prefs.muted ? '🔇' : '🔊';
  $('mute').setAttribute('aria-label', prefs.muted ? 'Unmute fly sound' : 'Mute fly sound');
  $('vol').value = String(Math.round(prefs.volume * 100));
  $('stupid').value = String(prefs.level);
}
engine.setMuted(prefs.muted); engine.setVolume(prefs.volume); engine.setLevel(prefs.level);
syncSoundUi();
$('mute').addEventListener('click', () => { engine.unlock(); prefs.muted = !prefs.muted; engine.setMuted(prefs.muted); syncSoundUi(); savePrefs(); });
$('vol').addEventListener('input', () => { prefs.volume = Number($('vol').value) / 100; engine.setVolume(prefs.volume); savePrefs(); });
$('stupid').addEventListener('change', () => { prefs.level = Number($('stupid').value); engine.setLevel(prefs.level); savePrefs(); });
if (params.has('mock') || params.get('debug') === '1') window.__flyAudioDebug = Object.assign(() => engine.debug(), { engine });

// Voice of the current answer: text, TTS fetch (started as soon as the final event arrives), decoded buffer kept for replays.
let voice = null;
let runSeq = 0;
let landTimer = null;
let speakTimer = null;
let ttsEnabled = null; // from /api/ask/health, null = unknown (try anyway)
const JINGLE = { A: 'winA', B: 'winB', none: 'winNone', inconclusive: 'sad' };
const isPad = (d) => d === 'A' || d === 'B' || d === 'none';

function cancelVoice() {
  runSeq += 1;
  clearInterval(landTimer); clearTimeout(speakTimer);
  if (voice && voice.abort) voice.abort.abort();
  voice = null;
  engine.stopVoice();
  $('fly-says').hidden = true;
  $('voice-note').hidden = true;
}

function startVoice(final) {
  const lang = String(final?.interpretation?.language || 'th').toLowerCase().startsWith('th') ? 'th' : 'en';
  const v = { final, lang, text: flySpeech(final, lang, prefs.level), buffer: null, failed: false, abort: new AbortController() };
  v.promise = (async () => {
    try {
      if (!engine.supported) throw new Error('no web audio');
      if (ttsEnabled === null) {
        try { const h = await fetch('/api/ask/health', { signal: v.abort.signal }); if (h.ok) { const j = await h.json(); if (typeof j.tts === 'boolean') ttsEnabled = j.tts; } } catch (_) { /* unknown: try anyway */ }
      }
      if (ttsEnabled === false) throw new Error('tts not configured');
      const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: v.text }), signal: v.abort.signal });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      v.buffer = await engine.prepareVoice(await res.arrayBuffer());
    } catch (err) {
      if (!v.abort.signal.aborted) { v.failed = true; v.error = err; }
    }
    return v.buffer;
  })();
  return v;
}

async function speak(v) {
  engine.stopVoice();
  const buf = v.buffer || (v.failed ? null : await v.promise);
  if (v !== voice) return;
  if (prefs.muted || engine.ducked) return;
  engine.setState('speaking');
  let played = false;
  if (buf) played = await engine.playVoice(buf, { seed: v.text });
  else if (engine.canSpeak) played = await engine.speakFallback(v.text, v.lang);
  if (v !== voice) return;
  $('voice-note').hidden = !(v.failed || (!buf && !played));
  engine.setState('landed');
}

function onLanded(v, run) {
  if (v !== voice || run !== runSeq) return;
  const d = v.final.decision;
  engine.setState(isPad(d) ? 'landing' : 'landed', { pad: d });
  engine.playJingle(JINGLE[d] || 'sad');
  speakTimer = setTimeout(() => speak(v), isPad(d) ? 1150 : 1800);
}

// Wait for the 3D fly to land (or a timeout when there is no WebGL / the tab is hidden), then the landing sound + voice.
function watchLanding(v, run) {
  clearInterval(landTimer);
  const t0 = performance.now();
  landTimer = setInterval(() => {
    if (run !== runSeq) { clearInterval(landTimer); return; }
    const el_ = performance.now() - t0;
    const decided = isPad(v.final.decision);
    const landed = decided ? (scene.ok ? scene.landed : el_ > 3300) : el_ > 3800;
    if (landed || el_ > 8000) { clearInterval(landTimer); onLanded(v, run); }
  }, 80);
}

$('replay-voice').addEventListener('click', () => {
  if (!voice) return;
  engine.unlock();
  clearTimeout(speakTimer);
  engine.stopVoice();
  engine.playJingle(JINGLE[voice.final.decision] || 'sad');
  const v = voice;
  speakTimer = setTimeout(() => speak(v), 900);
});

// ---- Ask / stream ----
let controller = null;
let lastText = '';
let tick = null;
let starts = {};
const openDebug = new Set();   // stages whose card is open
const openRaw = new Set();     // stages whose "Raw JSON" is open
const openSnip = new Set();    // "stage:index" snippets expanded with "more"
let lastState = null;

// ---- Small DOM helpers (untrusted text only ever goes through textContent) ----
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null && text !== '') n.textContent = String(text);
  return n;
}
function extLink(url, text, cls) {
  const safe = safeHttpUrl(url);
  if (!safe) return el('span', cls ? cls + ' plain' : 'plain', text || url || '');
  const a = el('a', cls, text || safe);
  a.href = safe; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function labelsFor(state) {
  const out = {};
  const pool = state?.stages?.pool?.data?.candidates;
  if (isObj(pool)) for (const k of Object.keys(pool)) out[k] = pool[k];
  for (const c of state?.final?.candidates || []) if (c && c.id && c.label) out[c.id] = c.label;
  return out;
}
const tag = (id) => (id === 'none' ? 'none' : String(id));
function idTag(id) { const t = el('span', 'idtag', tag(id)); t.dataset.id = id; return t; }
function note(text, cls) { return el('p', 'note ' + (cls || ''), text); }

function metaRow(items) {
  const row = el('div', 'metarow');
  for (const [k, v] of items) {
    if (v == null || v === '') continue;
    const m = el('span', 'metaitem');
    m.append(el('span', 'k', k), el('span', 'v', v));
    row.append(m);
  }
  return row.children.length ? row : null;
}

// ---- Per-stage cards ----
function cardInterpret(d, st) {
  const f = document.createDocumentFragment();
  if (d.echo) f.append(el('blockquote', 'quote', d.echo));
  const parties = Array.isArray(d.parties) ? d.parties : [];
  if (parties.length) {
    const box = el('div', 'chips');
    for (const p of parties) {
      const c = el('div', 'party');
      c.dataset.id = p.id || '';
      c.append(el('span', 'pname', p.name || p.id || '?'));
      const al = Array.isArray(p.aliases) ? p.aliases.filter(Boolean) : [];
      if (al.length) c.append(el('span', 'aliases', al.join(' · ')));
      box.append(c);
    }
    f.append(box);
  }
  if (d.criterion) { const r = el('p', 'kv'); r.append(el('span', 'k', 'Criterion '), el('span', 'v', d.criterion)); f.append(r); }
  const u = isObj(d.usage) ? d.usage : {};
  const tokens = u.prompt_tokens != null || u.completion_tokens != null
    ? `${u.prompt_tokens ?? '?'} prompt / ${u.completion_tokens ?? '?'} completion tokens` : '';
  const m = metaRow([['model', d.provider], ['tokens', tokens], ['cost', formatCost(u.cost)], ['latency', formatSeconds(st.ms)], ['language', d.language]]);
  if (m) f.append(m);
  return f;
}

function cardResearch(d, st, key) {
  const f = document.createDocumentFragment();
  const sources = Array.isArray(d.sources) ? d.sources : [];
  if (d.grounded === false) {
    const b = el('div', 'banner warn');
    b.setAttribute('role', 'note');
    b.append(el('strong', '', 'No live web sources'));
    b.append(el('span', '', d.notice || 'The answer is not backed by a web search this time.'));
    f.append(b);
  } else if (d.notice) {
    f.append(note(d.notice, 'muted'));
  }
  const se = isObj(d.search) ? d.search : {};
  const n = se.results_returned != null ? se.results_returned : sources.length;
  const head = [];
  if (se.engine) head.push(`Searched with ${se.engine}`);
  else if (d.grounded !== false) head.push('Searched the web');
  if (d.grounded !== false) head.push(`${n} result${n === 1 ? '' : 's'}`);
  if (se.model || d.provider) head.push(`model ${se.model || d.provider}`);
  if (d.as_of) head.push(`as of ${d.as_of}`);
  if (head.length) f.append(el('p', 'src-head', head.join(' · ')));
  if (!sources.length) {
    if (d.grounded !== false) f.append(note('The search returned no sources.', 'muted'));
  } else {
    const ol = el('ol', 'srclist');
    sources.forEach((s, i) => {
      const li = el('li', 'srccard');
      const top = el('div', 'srctop');
      top.append(el('span', 'num', i + 1));
      const host = hostnameOf(s.url);
      top.append(el('span', host ? 'host' : 'host none', host || 'no link'));
      li.append(top);
      li.append(el('div', 'srctitle', s.title || s.url || '(untitled)'));
      const snip = clampText(s.snippet, 4000).text;
      if (snip) {
        const id = `${key}:${i}`;
        const p = el('p', 'snippet', snip);
        const open = openSnip.has(id);
        p.classList.toggle('open', open);
        li.append(p);
        if (snip.length > 150) {
          const t = el('button', 'linkbtn', open ? 'less' : 'more');
          t.type = 'button';
          t.setAttribute('aria-expanded', String(open));
          t.addEventListener('click', () => {
            const o = p.classList.toggle('open');
            if (o) openSnip.add(id); else openSnip.delete(id);
            t.textContent = o ? 'less' : 'more';
            t.setAttribute('aria-expanded', String(o));
          });
          li.append(t);
        }
      }
      if (safeHttpUrl(s.url)) li.append(extLink(s.url, 'Open source', 'open'));
      else if (s.url) li.append(el('span', 'plain urltext', s.url));
      ol.append(li);
    });
    f.append(ol);
  }
  const facts = Array.isArray(d.facts) ? d.facts : [];
  if (facts.length) {
    f.append(el('h4', 'sub', 'Findings the LLM extracted'));
    const ul = el('ul', 'facts');
    for (const x of facts) {
      const li = el('li', '', x && x.text != null ? x.text : String(x));
      if (x && x.source_url) { li.append(document.createTextNode(' ')); li.append(extLink(x.source_url, x.source_title || hostnameOf(x.source_url) || 'source', 'open')); }
      ul.append(li);
    }
    f.append(ul);
  }
  return f;
}

function cardPool(d) {
  const f = document.createDocumentFragment();
  const head = el('div', 'subhead');
  head.append(el('h4', 'sub', 'State text'));
  if (d.state_trimmed) head.append(el('span', 'badge warn', 'trimmed'));
  f.append(head);
  const box = el('div', 'stateblock');
  const sentences = String(d.state || '').split(/(?<=[.!?。])\s+/).filter(Boolean);
  if (sentences.length) for (const s of sentences) box.append(el('p', '', s));
  else box.append(el('p', 'muted', '(empty)'));
  f.append(box);
  if (d.instructions) { const q = el('p', 'kv'); q.append(el('span', 'k', 'Question '), el('span', 'v', d.instructions)); f.append(q); }
  const c = isObj(d.candidates) ? d.candidates : {};
  const ul = el('ul', 'opts');
  for (const id of ['A', 'B', 'none']) {
    if (c[id] == null) continue;
    const li = el('li');
    li.append(idTag(id), el('span', '', c[id]));
    ul.append(li);
  }
  if (ul.children.length) f.append(ul);
  return f;
}

function argmax(o) {
  let best = null;
  for (const k of Object.keys(isObj(o) ? o : {})) if (typeof o[k] === 'number' && (best == null || o[k] > o[best])) best = k;
  return best;
}
function cardJev(d, st, state) {
  const f = document.createDocumentFragment();
  const labels = labelsFor(state);
  const fwd = isObj(d.forward) ? d.forward : {};
  const swp = isObj(d.swapped) ? d.swapped : {};
  const mean = isObj(state?.stages?.adapter?.data?.mean) ? state.stages.adapter.data.mean : null;
  const ids = ['A', 'B', 'none'].filter((i) => i in fwd || i in swp || (mean && i in mean));
  if (!ids.length) { f.append(note('No probabilities were reported.', 'muted')); return f; }
  const wf = argmax(fwd), ws = argmax(swp);
  const table = el('table', 'jevtable');
  const cap = el('caption', 'sr-only', 'Probability for each option in the forward and swapped runs');
  table.append(cap);
  const thead = el('thead'); const hr = el('tr');
  for (const h of ['Option', 'Forward', 'Swapped', ...(mean ? ['Mean'] : [])]) hr.append(el('th', '', h));
  thead.append(hr); table.append(thead);
  const tb = el('tbody');
  const cell = (v, win, id) => {
    const td = el('td', win ? 'win' : '');
    if (typeof v !== 'number') { td.append(el('span', 'muted', '-')); return td; }
    td.append(el('span', 'pct', formatPct(v)));
    const tr = el('span', 'mini-track'); const fl = el('span', 'mini-fill');
    fl.style.width = Math.round(Math.min(1, Math.max(0, v)) * 100) + '%';
    fl.style.background = COLORS[id] || 'var(--muted)';
    tr.append(fl); td.append(tr);
    return td;
  };
  for (const id of ids) {
    const tr = el('tr');
    const th = el('th'); th.scope = 'row';
    th.append(idTag(id), el('span', 'optname', labels[id] || ''));
    tr.append(th, cell(fwd[id], wf === id, id), cell(swp[id], ws === id, id));
    if (mean) tr.append(cell(mean[id], argmax(mean) === id, id));
    tb.append(tr);
  }
  table.append(tb);
  const wrap = el('div', 'tablewrap'); wrap.append(table);
  f.append(wrap);
  f.append(note('Two runs with A/B swapped. The highlighted cell is the winner of that run.', 'muted'));
  const m = metaRow([['inference', d.inference_ms != null ? formatSeconds(d.inference_ms) : '']]);
  if (m) f.append(m);
  return f;
}

function cardAdapter(d, st, state) {
  const f = document.createDocumentFragment();
  const labels = labelsFor(state);
  const dec = d.decision;
  if (dec) {
    const row = el('div', 'verdict');
    const pill = el('span', 'pill', dec === 'inconclusive' ? 'inconclusive' : tag(dec));
    pill.dataset.id = dec;
    row.append(pill);
    if (dec !== 'inconclusive' && labels[dec]) row.append(el('span', 'optname', labels[dec]));
    const top = d.top_prob != null ? d.top_prob : (isObj(d.mean) && argmax(d.mean) ? d.mean[argmax(d.mean)] : null);
    if (top != null || d.min_conf != null) {
      row.append(el('span', 'conf', `confidence ${top != null ? formatPct(top) : '-'} vs threshold ${d.min_conf != null ? formatPct(d.min_conf) : '-'}`));
    }
    f.append(row);
  }
  const checks = deriveChecks(d);
  if (checks.length) {
    const ul = el('ul', 'checks');
    for (const c of checks) {
      const li = el('li', c.ok ? 'ok' : 'bad');
      const ico = el('span', 'cico', c.ok ? '✓' : '✗');
      ico.setAttribute('aria-hidden', 'true');
      li.append(ico, el('span', '', c.name), el('span', 'sr-only', c.ok ? ' (passed)' : ' (failed)'));
      ul.append(li);
    }
    f.append(ul);
  }
  if (d.reason) f.append(note(d.reason, 'muted'));
  const m = metaRow([['forward chose', d.forward_choice != null ? (Array.isArray(d.forward_choice) ? d.forward_choice[0] : d.forward_choice) : ''], ['swapped chose', d.swapped_choice != null ? (Array.isArray(d.swapped_choice) ? d.swapped_choice[0] : d.swapped_choice) : '']]);
  if (m) f.append(m);
  return f;
}

const CARDS = { interpret: cardInterpret, research: cardResearch, pool: cardPool, jev: cardJev, adapter: cardAdapter };
const SUMMARY = {
  interpret: (d, st) => [formatSeconds(st.ms), d.provider].filter(Boolean).join(' · '),
  research: (d) => (Array.isArray(d.sources) ? `${d.sources.length} source${d.sources.length === 1 ? '' : 's'}` : '') + (d.grounded === false ? ' · not grounded' : ''),
  pool: (d) => (d.state_trimmed ? 'trimmed' : ''),
  jev: (d) => (d.inference_ms != null ? formatSeconds(d.inference_ms) : ''),
  adapter: (d) => d.decision || '',
};
const CARD_TITLE = { interpret: 'Interpret', research: 'Sources the LLM read', pool: 'What Jev was shown', jev: 'Jev: two runs', adapter: 'Verify decision' };

function rawBlock(st, s) {
  const det = el('details', 'raw');
  det.open = openRaw.has(s);
  det.addEventListener('toggle', () => { if (det.open) openRaw.add(s); else openRaw.delete(s); });
  const sum = el('summary', '', 'Raw JSON');
  let body;
  try { body = JSON.stringify({ status: st.status, ms: st.ms, error: st.error, data: st.data }, null, 2); } catch (_) { body = String(st.data); }
  const copy = el('button', 'mini', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await navigator.clipboard.writeText(body); copy.textContent = 'Copied'; } catch (_) {
      const ta = el('textarea'); ta.value = body; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); copy.textContent = 'Copied'; } catch (__) { copy.textContent = 'Copy failed'; }
      ta.remove();
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  });
  const pre = el('pre', '', body);
  det.append(sum, copy, pre);
  return det;
}

function cardBody(s, st, state) {
  const body = el('div', 'cardbody');
  const d = isObj(st.data) ? st.data : {};
  if (st.status === 'error') body.append(el('p', 'banner bad', st.error?.message || 'This stage failed.'));
  try { body.append(CARDS[s](d, st, state, s)); } catch (err) { body.append(note('Could not draw this card: ' + (err.message || err), 'muted')); }
  body.append(rawBlock(st, s));
  return body;
}

function syncToggleAll() {
  const b = $('toggle-cards');
  const live = STAGES.filter((s) => lastState && lastState.stages[s].status !== 'pending');
  const allOpen = live.length > 0 && live.every((s) => openDebug.has(s));
  b.textContent = allOpen ? 'Collapse all' : 'Expand all';
  b.dataset.all = String(allOpen);
}

function renderStages(state) {
  lastState = state;
  const panel = $('out');
  const keep = panel.scrollTop;
  const ol = $('stages');
  ol.hidden = false;
  $('stages-bar').hidden = false;
  $('out-empty').hidden = true;
  ol.replaceChildren(...STAGES.map((s) => {
    const st = state.stages[s];
    const li = document.createElement('li');
    li.dataset.status = st.status;
    li.dataset.stage = s;
    const ico = document.createElement('span'); ico.className = 'ico'; ico.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'sname';
    name.textContent = STAGE_LABEL[s] + (st.status === 'done' ? ' - done' : st.status === 'running' ? ' - working' : st.status === 'error' ? ' - failed' : '');
    const ms = document.createElement('span'); ms.className = 'ms';
    ms.textContent = st.ms != null && st.status !== 'running' && st.status !== 'pending' ? st.ms + ' ms' : '';
    li.append(ico, name, ms);
    if (st.status !== 'pending') {
      const det = el('details', 'dbg');
      det.id = 'card-' + s;
      det.open = openDebug.has(s);
      det.addEventListener('toggle', () => { if (det.open) openDebug.add(s); else openDebug.delete(s); syncToggleAll(); });
      const sum = el('summary');
      sum.append(el('span', 'ctitle', CARD_TITLE[s]));
      const hint = SUMMARY[s] && isObj(st.data) ? SUMMARY[s](st.data, st) : '';
      if (hint) sum.append(el('span', 'chint', hint));
      det.append(sum);
      if (det.open || st.status === 'error') det.append(cardBody(s, st, state)); // bodies are built lazily
      det.addEventListener('toggle', () => { if (det.open && !det.querySelector('.cardbody')) det.append(cardBody(s, state.stages[s], lastState)); });
      li.append(det);
    }
    return li;
  }));
  syncToggleAll();
  panel.scrollTop = keep;
}

function showError(message) {
  $('error').hidden = false;
  $('error-msg').textContent = message;
}

function renderFinal(f) {
  const panel = $('out');
  const keep = panel.scrollTop;
  $('result').hidden = false;
  $('echo').textContent = f.interpretation?.echo || '';
  $('answer').textContent = f.answer_text || '';
  const bars = $('bars');
  bars.replaceChildren(...(f.candidates || []).map((c) => {
    const li = document.createElement('li');
    li.dataset.win = String(c.id === f.decision);
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = c.label || c.id;
    const p = document.createElement('span'); p.textContent = formatPct(c.prob || 0);
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
  const srcs = (Array.isArray(f.sources) ? f.sources : []);
  $('src-title').textContent = `Sources (${srcs.length})`;
  $('src-row').hidden = srcs.length === 0;
  $('sources').replaceChildren(...srcs.map((s) => {
    const li = el('li');
    const host = hostnameOf(s.url);
    li.append(extLink(s.url, host || s.title || s.url || 'source', 'srcchip'));
    li.firstChild.title = s.title || '';
    return li;
  }));
  $('disclaimer').textContent = f.disclaimer || 'Entertainment demo - not a prediction';
  // The answer block grows above the cards: keep the reader's scroll position, never jump.
  panel.scrollTop = keep;
  requestAnimationFrame(() => { panel.scrollTop = keep; });
}

async function ask(text) {
  text = text.trim();
  if (!text) return;
  lastText = text;
  engine.unlock();
  cancelVoice();
  if (controller) controller.abort();
  controller = new AbortController();
  const mine = controller;
  starts = {};
  const myRun = newRun(text, $('replay').checked);
  clearInterval(tick);
  $('result').hidden = true;
  $('error').hidden = true;
  openSnip.clear();
  $('send').disabled = true;
  let state = newState();
  renderStages(state);
  scheduleRaw();
  fly('thinking');
  scene.setCandidates([]);
  tick = setInterval(() => {
    for (const li of $('stages').children) {
      if (li.dataset.status === 'running' && starts[li.dataset.stage]) li.querySelector(':scope > .ms').textContent = Math.round(performance.now() - starts[li.dataset.stage]) + ' ms';
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
      myRun.events.push(makeEventRecord(ev, performance.now() - myRun.t0));
      if (ev.stage === 'final') { if (state.final) myRun.final = state.final; if (state.error) myRun.error = state.error; }
      renderStages(state);
      scheduleRaw();
    });
    if (state.final) {
      voice = startVoice(state.final);
      const run = runSeq;
      scene.setCandidates(state.final.candidates);
      renderFinal(state.final);
      $('says-text').textContent = 'Fly says: ' + voice.text;
      $('fly-says').hidden = false;
      watchLanding(voice, run);
      const d = state.final.decision;
      if (d === 'A' || d === 'B' || d === 'none') fly('deciding', { pad: d }); else fly('inconclusive');
    } else {
      throw new Error(state.error?.message || 'The stream ended without an answer.');
    }
  } catch (err) {
    if (mine.signal.aborted) return;
    fly('idle');
    const message = err.message || String(err);
    if (!myRun.error) myRun.error = { message };
    if (!myRun.events.some((r) => r.stage === 'final' && r.status === 'error')) myRun.events.push(makeEventRecord({ stage: 'client', status: 'error', error: { message } }, performance.now() - myRun.t0));
    scheduleRaw();
    showError(message);
  } finally {
    myRun.done = true;
    if (controller === mine) { clearInterval(tick); $('send').disabled = false; }
    scheduleRaw();
  }
}


// ---- Raw JSON view: the whole run as JSON (Final / Stream / Session) ----
const VIEW_KEY = 'fly.view';
const RAW_PREFS_KEY = 'fly.raw';
let run = null; // {request, events:[{t_ms,stage,status,event}], final, error, t0, done}
const rawPrefs = { tab: 'final', wrap: true };
try {
  const j = JSON.parse(localStorage.getItem(RAW_PREFS_KEY) || '{}');
  if (['final', 'stream', 'session'].includes(j.tab)) rawPrefs.tab = j.tab;
  if (typeof j.wrap === 'boolean') rawPrefs.wrap = j.wrap;
} catch (_) { /* storage blocked: defaults */ }
function saveRawPrefs() { try { localStorage.setItem(RAW_PREFS_KEY, JSON.stringify(rawPrefs)); } catch (_) { /* ignore */ } }
const LINE_STEP = 1500;
let rawTabs = {};
function resetRaw() {
  rawTabs = {};
  for (const t of ['final', 'stream', 'session']) rawTabs[t] = { cs: collapseState(), full: new Set(), cap: LINE_STEP, scroll: 0 };
}
resetRaw();
function newRun(text, replay) {
  run = { request: { text, replay: !!replay, startedAt: new Date().toISOString() }, events: [], final: null, error: null, t0: performance.now(), done: false };
  resetRaw();
  return run;
}
let view = 'cards';
let rawRaf = 0;
function scheduleRaw() {
  if (view !== 'raw' || rawRaf) return;
  rawRaf = requestAnimationFrame(() => { rawRaf = 0; renderRaw(); });
}
function rawData(tab) {
  if (!run) return undefined;
  if (tab === 'final') return run.final || undefined;
  if (tab === 'stream') return run.events;
  return sessionExport(run);
}
function rawHint(v) {
  if (v && typeof v === 'object' && 't_ms' in v && 'stage' in v) {
    const msg = v.event && v.event.error && v.event.error.message;
    return `+${v.t_ms} ms ${v.stage}/${v.status}` + (msg ? ` "${String(msg).slice(0, 80)}"` : '');
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && v.error && v.error.message) return `error "${String(v.error.message).slice(0, 80)}"`;
  return '';
}
function rawMessage(tab) {
  if (!run) return 'No run yet. Ask something and the JSON appears here.';
  if (tab === 'final') return run.done && !run.final ? 'No final event: the run ended with an error. See Stream or Session.' : 'Waiting for the final event...';
  return '';
}
function rawPill() {
  const pill = $('rawpill');
  const parts = [];
  const f = run && run.final;
  if (!run) parts.push(el('span', 'muted', 'No run yet'));
  else if (f) {
    const d = f.decision;
    const p = el('span', 'pill', d === 'inconclusive' ? 'inconclusive' : tag(d));
    p.dataset.id = d;
    parts.push(p);
    const c = (f.candidates || []).find((x) => x.id === d);
    if (c) parts.push(el('span', 'rawpill-t', `${c.label || c.id} ${formatPct(c.prob || 0)}`));
    if (f.from_cache) parts.push(el('span', 'chip', 'from cache'));
  } else if (run.error) parts.push(el('span', 'rawpill-t bad', 'Failed: ' + (run.error.message || 'error')));
  else {
    const running = lastState && STAGES.find((s) => lastState.stages[s].status === 'running');
    parts.push(el('span', 'rawpill-t', running ? `Running: ${STAGE_LABEL[running]}` : 'Running...'));
  }
  pill.replaceChildren(...parts);
}

function treeLine(line) {
  const d = document.createElement('div');
  d.className = 'jl' + (line.closing ? ' close' : '');
  d.style.setProperty('--d', String(line.depth));
  if (line.toggle) {
    const b = el('button', 'jcaret', line.toggle.collapsed ? '▸' : '▾');
    b.type = 'button';
    b.dataset.act = 'fold'; b.dataset.path = line.path; b.dataset.depth = String(line.depth);
    b.setAttribute('aria-expanded', String(!line.toggle.collapsed));
    b.setAttribute('aria-label', (line.toggle.collapsed ? 'Expand ' : 'Collapse ') + (line.path || 'root'));
    d.append(b);
  }
  for (const t of line.tokens) {
    const s = el('span', 'j-' + t.t, t.v);
    if (t.t === 'str' && t.k === 'status' && t.v === '"error"') s.classList.add('j-bad');
    d.append(s);
    if (t.more) {
      const m = el('button', 'linkbtn jmore', `… +${t.more.hidden} chars, show full`);
      m.type = 'button'; m.dataset.act = 'full'; m.dataset.path = t.more.path;
      d.append(m);
    }
  }
  return d;
}

function renderRaw() {
  if (view !== 'raw') return;
  const tab = rawPrefs.tab;
  const st = rawTabs[tab];
  const pane = $('rawpane');
  rawPill();
  for (const b of $('raw-tabs').children) { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  $('raw-wrap').setAttribute('aria-pressed', String(rawPrefs.wrap));
  pane.classList.toggle('nowrap', !rawPrefs.wrap);
  const data = rawData(tab);
  const empty = data === undefined || (tab === 'stream' && !data.length);
  $('raw-copy').disabled = empty; $('raw-dl').disabled = empty; $('raw-fold').disabled = empty;
  $('raw-fold').textContent = allCollapsed(st.cs) ? 'Expand all' : 'Collapse all';
  if (empty) {
    $('raw-size').textContent = '';
    pane.replaceChildren(el('p', 'rawempty', rawMessage(tab) || 'No events yet...'));
    return;
  }
  const bytes = byteSize(data);
  const nEv = run ? run.events.length : 0;
  $('raw-size').textContent = formatBytes(bytes) + (tab === 'final' ? '' : ` · ${nEv} event${nEv === 1 ? '' : 's'}`) + (bytes > LARGE_BYTES ? ' · large: long strings shortened' : '');
  const keep = pane.scrollTop;
  const follow = tab !== 'final' && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40 && !run.done;
  const { lines, capped } = tokenizeJson(data, { collapse: st.cs, fullPaths: st.full, maxLines: st.cap, hint: rawHint });
  const frag = document.createDocumentFragment();
  for (const l of lines) frag.append(treeLine(l));
  if (capped) {
    const m = el('button', 'mini jmore-lines', `Show ${LINE_STEP} more lines`);
    m.type = 'button'; m.dataset.act = 'lines';
    frag.append(m);
  }
  pane.replaceChildren(frag);
  pane.scrollTop = follow ? pane.scrollHeight : keep;
  if (rawFocus) {
    const sel = [...pane.querySelectorAll('button[data-act]')].find((b) => b.dataset.act === rawFocus.act && b.dataset.path === rawFocus.path);
    rawFocus = null;
    if (sel) sel.focus({ preventScroll: true });
  }
}
let rawFocus = null;

$('rawpane').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const st = rawTabs[rawPrefs.tab];
  rawFocus = { act: b.dataset.act, path: b.dataset.path };
  if (b.dataset.act === 'fold') st.cs = toggleCollapsed(st.cs, b.dataset.path, Number(b.dataset.depth));
  else if (b.dataset.act === 'full') { st.full.add(b.dataset.path); rawFocus = null; }
  else if (b.dataset.act === 'lines') { st.cap += LINE_STEP; rawFocus = null; }
  renderRaw();
});
$('raw-fold').addEventListener('click', () => {
  const st = rawTabs[rawPrefs.tab];
  st.cs = allCollapsed(st.cs) ? expandAll() : collapseAll();
  st.scroll = 0;
  renderRaw();
  $('rawpane').scrollTop = 0;
});
$('raw-wrap').addEventListener('click', () => { rawPrefs.wrap = !rawPrefs.wrap; saveRawPrefs(); renderRaw(); });

function rawText() {
  const data = rawData(rawPrefs.tab);
  if (data === undefined) return null;
  try { return JSON.stringify(data, null, 2); } catch (_) { return null; }
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through to the textarea */ }
  const ta = el('textarea', 'sr-only');
  ta.value = text; ta.setAttribute('aria-hidden', 'true');
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}
function flash(btn, text, status, ms = 1600) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  $('raw-status').textContent = status;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = old; $('raw-status').textContent = ''; }, ms);
}
$('raw-copy').addEventListener('click', async () => {
  const text = rawText();
  if (text == null) return;
  const ok = await copyToClipboard(text);
  flash($('raw-copy'), ok ? 'Copied' : 'Copy failed', ok ? 'Copied to clipboard' : 'Copy failed');
});
$('raw-dl').addEventListener('click', () => {
  const text = rawText();
  if (text == null) return;
  const name = exportFileName(new Date());
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash($('raw-dl'), 'Saved', 'Downloaded ' + name);
});

function wireTabs(box, attr, onSelect) {
  const tabs = () => [...box.querySelectorAll('[role="tab"]')];
  box.addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) onSelect(b.dataset[attr]); });
  box.addEventListener('keydown', (e) => {
    const list = tabs();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onSelect(list[j].dataset[attr]);
    list[j].focus();
  });
}
function setRawTab(t) {
  if (!rawTabs[t]) return;
  rawTabs[rawPrefs.tab].scroll = $('rawpane').scrollTop;
  rawPrefs.tab = t; saveRawPrefs();
  renderRaw();
  $('rawpane').scrollTop = rawTabs[t].scroll;
}
function setView(v, persist = true) {
  if (view === 'raw' && !$('rawview').hidden) rawTabs[rawPrefs.tab].scroll = $('rawpane').scrollTop;
  view = v === 'raw' ? 'raw' : 'cards';
  $('out').dataset.view = view;
  for (const b of $('view-seg').children) { const on = b.dataset.view === view; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  $('rawview').hidden = view !== 'raw';
  if (persist) { try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* ignore */ } }
  if (view === 'raw') { renderRaw(); $('rawpane').scrollTop = rawTabs[rawPrefs.tab].scroll; }
}
wireTabs($('view-seg'), 'view', setView);
wireTabs($('raw-tabs'), 'tab', setRawTab);
{
  let saved = 'cards';
  try { saved = localStorage.getItem(VIEW_KEY) || 'cards'; } catch (_) { /* ignore */ }
  setView(saved, false);
}
if (params.has('mock')) window.__flyRaw = { setRun(r) { run = r; resetRaw(); renderRaw(); } };

// ---- Output panel controls ----
$('expand').addEventListener('click', () => {
  const on = $('out').classList.toggle('expanded');
  $('expand').setAttribute('aria-pressed', String(on));
  $('expand').textContent = on ? 'Shrink' : 'Expand';
});
$('toggle-cards').addEventListener('click', () => {
  const open = $('toggle-cards').dataset.all !== 'true';
  for (const det of $('stages').querySelectorAll('details.dbg')) det.open = open;
  if (!open) openDebug.clear();
  syncToggleAll();
});

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
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
  engine.setDucked(true);
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
      engine.setMicLevel(Math.min(1, peak / 80));
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
  engine.setDucked(false);
  try { rec.recorder.stop(); } catch (_) { /* already stopped */ }
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.ctx?.close().catch(() => {});
  fly('idle');
}
$('mic').addEventListener('click', () => { engine.unlock(); if (rec.active) stopRecording(); else startRecording(); });

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
  engine.setDucked(true);
  r.onresult = (e) => { const t = e.results[0][0].transcript; setMicStatus('Heard you. Check the text, it will send in a moment.'); showTranscript(t); };
  r.onerror = (e) => setMicStatus(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Browser speech recognition failed (${e.error}). Use Text.`);
  r.onend = () => { engine.setDucked(false); fly('idle'); };
  try { r.start(); } catch (_) { setMicStatus('Could not start browser speech recognition. Use Text.'); }
}

addEventListener('pagehide', () => { if (rec.active) stopRecording(true); });


// =====================================================================================================
// Camera: gestures, memes and the fly's reactions. Everything is local; the camera is off until the button is pressed.
// =====================================================================================================

// ---- Fly rig: follow, reactions and "Copy me", driven through the scene's explicit hooks (scene.setFrameHook / setOffsets / setPose) ----
const rig = { follow: 0, cur: { x: 0, y: 0 }, target: { x: 0, y: 0, on: false, at: 0 }, rx: null };
const smooth01 = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const REACTIONS = { startled: 1.3, spin: 1.0, happy: 1.5, lean_left: 1.6, lean_right: 1.6 };

// ---- Copy me (mimic): the fly copies the user's pose. Pose landmarks stay in this page; nothing is uploaded or stored. ----
const MIMIC_KEY = 'fly.mimic';
const mimicCfg = { on: false, mirror: true, smooth: 0.5 };
try {
  const j = JSON.parse(localStorage.getItem(MIMIC_KEY) || '{}');
  if (typeof j.on === 'boolean') mimicCfg.on = j.on;
  if (typeof j.mirror === 'boolean') mimicCfg.mirror = j.mirror;
  if (typeof j.smooth === 'number') mimicCfg.smooth = Math.min(1, Math.max(0, j.smooth));
} catch (_) { /* storage blocked: defaults (off) */ }
function saveMimicCfg() { try { localStorage.setItem(MIMIC_KEY, JSON.stringify(mimicCfg)); } catch (_) { /* ignore */ } }
const mimic = createMimic({ mirror: mimicCfg.mirror, smoothness: mimicCfg.smooth, enabled: mimicCfg.on });
const mim = { sample: null, statusText: null, boingAt: -1e9, squeakAt: -1e9, armed: { L: true, R: true }, hopHi: false };
const copyOn = () => mimicCfg.on && cam.running; // Copy me is switched on AND a camera (real or mock) is feeding it

function mimicSfx(smp, now) {
  if (smp.weight < 0.3) { mim.hopHi = false; return; }
  const hopHi = smp.rig.hop > 0.5;
  if (hopHi && !mim.hopHi && now - mim.boingAt > 900) { mim.boingAt = now; engine.playBoing(); }
  mim.hopHi = hopHi;
  for (const s of ['L', 'R']) {
    const v = smp.rig['leg' + s];
    if (v > 0.7 && mim.armed[s] && now - mim.squeakAt > 1200) { mim.squeakAt = now; mim.armed[s] = false; engine.playSqueak(); }
    else if (v < 0.35) mim.armed[s] = true;
  }
}
function updateMimicStatus(smp) {
  let text = '', cls = '';
  if (mimicCfg.on) {
    if (!cam.running) { text = cam.starting ? 'Camera starting...' : 'Press Camera so the fly can see you'; cls = 'warn'; }
    else if (smp.status === 'paused') text = 'Paused while the fly works';
    else if (smp.status === 'calibrating') { text = 'Calibrating: stand still'; cls = 'warn'; }
    else if (smp.status === 'lost') { text = 'No body found'; cls = 'warn'; }
    else { text = 'Copying you'; cls = 'on'; }
  }
  if (text !== mim.statusText) { mim.statusText = text; const n = $('mimic-status'); n.textContent = text; n.className = 'mimic-status ' + cls; }
}

// Runs once per rendered frame, before the scene moves the fly (see fly-scene.js setFrameHook).
function onSceneFrame({ dt, t, state: st }) {
  const now = performance.now();
  const busy = st === 'deciding' || st === 'landing';        // never fight the decision flight, landed or not
  if (busy) rig.rx = null;
  if (now - rig.target.at > 900) rig.target.on = false;      // attention goes stale when the camera stops sending
  const want = !busy && st === 'idle' && rig.target.on ? 1 : 0;
  rig.follow += (want - rig.follow) * Math.min(1, dt * (want ? 5 : 8)); // ramps to 0 quickly but smoothly when a run starts
  const k = Math.min(1, dt * 5);
  const tx = rig.target.on ? rig.target.x : 0, ty = rig.target.on ? rig.target.y : 0;
  rig.cur.x += (tx - rig.cur.x) * k; rig.cur.y += (ty - rig.cur.y) * k;
  let dx = rig.cur.x * 1.9 * rig.follow, dy = -rig.cur.y * 0.8 * rig.follow, yaw = -rig.cur.x * 0.5 * rig.follow, spin = 0, flap = 0;
  if (rig.rx) {
    const r = rig.rx; r.t += dt;
    const p = r.t / r.dur;
    if (p >= 1) rig.rx = null;
    else if (r.name === 'startled') { const env = r.t < 0.12 ? r.t / 0.12 : Math.exp(-(r.t - 0.12) * 3.2); dx += r.dir * 1.7 * env; dy += 0.55 * env; flap = env; }
    else if (r.name === 'spin') { spin = Math.PI * 2 * smooth01(p); dy += Math.sin(p * Math.PI) * 0.35; flap = r.noFlap ? 0 : 0.5; }
    else if (r.name === 'happy') { const env = Math.sin(p * Math.PI); dy += Math.abs(Math.sin(r.t * 9)) * 0.45 * env; flap = 0.7 * env; }
    else if (r.name === 'lean_left' || r.name === 'lean_right') { const env = Math.sin(p * Math.PI); dx += (r.name === 'lean_left' ? -1 : 1) * 1.6 * Math.min(1, env * 1.6); yaw += (r.name === 'lean_left' ? -1 : 1) * 0.4 * env; }
  }
  scene.setOffsets({ dx, dy, yaw, spin, flap, camX: rig.cur.x * 0.45 * rig.follow }); // the view shifts a little against the fly

  // Copy me: pause it whenever the scene's own state machine is mid-manoeuvre (thinking, listening, deciding flight); it fades back in once settled.
  mimic.setPaused(!scene.settled);
  const smp = mimic.sample(now);
  mim.sample = smp;
  scene.setPose(smp.rig);
  scene.setPoseWeight(smp.weight);
  if (mimicCfg.on) mimicSfx(smp, now);
  updateMimicStatus(smp);
}
const flyApi = {
  // Returns true when the reaction was accepted. Ignored (not queued) while the fly is deciding or landing.
  react(name) {
    if (!(name in REACTIONS) || !scene.ok) return false;
    const st = scene.state;
    if (st === 'deciding' || st === 'landing') return false;
    if (copyOn() && scene.settled) {
      // while Copy me is on the reactions become their mimic equivalents (no sliding, no wing flap on top of the pose)
      if (name !== 'spin') { mimic.gesture({ name, ts: performance.now() }); return true; }
      rig.rx = { name, t: 0, dur: REACTIONS[name], dir: 1, noFlap: true };
      return true;
    }
    rig.rx = { name, t: 0, dur: REACTIONS[name], dir: Math.random() < 0.5 ? -1 : 1 };
    return true;
  },
  // x, y in -1..1 on the (mirrored) screen; null releases. Only used while idle.
  setAttention(x, y) {
    if (x == null || y == null) { rig.target.on = false; return; }
    rig.target.x = Math.max(-1, Math.min(1, x)); rig.target.y = Math.max(-1, Math.min(1, y)); rig.target.on = true; rig.target.at = performance.now();
  },
};
window.flyApi = flyApi;

// ---- Settings (localStorage, always in try/catch) ----
const CAM_KEY = 'fly.cam';
let camCfg = defaultActionsConfig();
try { camCfg = normalizeActionsConfig(JSON.parse(localStorage.getItem(CAM_KEY) || 'null')); } catch (_) { /* defaults */ }
function saveCamCfg() { try { localStorage.setItem(CAM_KEY, JSON.stringify(camCfg)); } catch (_) { /* ignore */ } }
const PRESETS = ['ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู ใครจะชนะ?', "Who is ahead in the latest polls: the People's Party or Bhumjaithai?", 'ใครจะได้เป็นนายกรัฐมนตรีคนต่อไป?'];

// ---- Memes ----
let memeManifest = FALLBACK_MANIFEST;
const memes = createMemeOverlay({ layer: $('meme-layer'), live: $('meme-live'), byGesture: memeManifest, reduced, audio: engine });
(async () => {
  try {
    const res = await fetch('/static/memes/memes.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const parsed = parseManifest(await res.json());
    if (parsed.count > 0) { memeManifest = parsed.byGesture; memes.setManifest(memeManifest); }
    if (parsed.errors.length) console.warn('memes.json:', parsed.errors.join('; '));
  } catch (_) { /* built-in fallback cards are used */ }
})();

// ---- Gesture -> action ----
const camEngine = createGestureEngine({ sensitivity: camCfg.sensitivity });
camEngine.setExtraHold(requiredHolds(camCfg));
let lastAskTs = NaN;
let camLastInfo = null;
const camStatus = (text, bad) => { const n = $('cam-status'); n.textContent = text || ''; n.hidden = !text; n.classList.toggle('bad', !!bad); };
function setCamLast(ev, plan, extra) {
  const bits = [];
  if (plan.meme) bits.push('meme');
  if (plan.action !== 'none') bits.push(plan.action === 'fly' ? `fly ${plan.reaction || ''}`.trim() : plan.action);
  if (plan.blocked) bits.push(`(${plan.blocked})`);
  if (extra) bits.push(extra);
  $('cam-last').textContent = `${GESTURE_TITLES[ev.name] || ev.name} ${Math.round((ev.confidence || 0) * 100)}%${bits.length ? ' → ' + bits.join(' + ') : ''}`;
  camLastInfo = { name: ev.name, confidence: ev.confidence, ts: ev.ts, test: !!ev.test };
}
function onGesture(ev, test = false) {
  const plan = planAction(camCfg, ev, { lastAskTs, test });
  if (plan.ignored) return;
  let extra = '';
  if (mimicCfg.on) mimic.gesture({ name: ev.name, side: ev.side, ts: performance.now() }); // Copy me: the fly acts the gesture out itself
  if (plan.meme) { const r = memes.show(ev.name); if (!r.shown) extra = `no meme: ${r.reason}`; }
  switch (plan.action) {
    case 'fly':
      if (copyOn()) extra = extra || 'copy me'; // the mimic already acts this gesture out; a canned reaction would fight it
      else if (!flyApi.react(plan.reaction)) extra = extra || 'fly is busy';
      break;
    case 'replay': if (voice) $('replay-voice').click(); else extra = extra || 'nothing to replay yet'; break;
    case 'mute': $('mute').click(); break;
    case 'preset1': case 'preset2': case 'preset3': {
      const n = Number(plan.action.slice(-1)) - 1;
      setMode('text'); $('q').value = PRESETS[n]; extra = extra || `preset ${n + 1} loaded, press Send`;
      break;
    }
    case 'ask': {
      const text = ($('q').value || $('q').placeholder || '').trim();
      if (plan.dryRun) { extra = `dry run: would send "${text.slice(0, 40)}"`; break; }
      if ($('send').disabled || !text) { extra = 'busy or empty, not sent'; break; }
      lastAskTs = ev.ts; ask(text); extra = 'question sent';
      break;
    }
    default: break;
  }
  setCamLast(ev, plan, extra);
}

// ---- Camera controller ----
const camUi = { items: [] };
const cam = createCamera({
  video: $('cam-video'), overlay: $('cam-overlay'), engine: camEngine,
  mock: camMock ? mockMod : null,
  onEvent: (ev) => onGesture(ev),
  onPose: (ts, pose) => { if (mimicCfg.on) mimic.update({ ts, pose }); },
  onAttention: (a) => { if (a) flyApi.setAttention(a.x, a.y); else flyApi.setAttention(null); },
  onFrame: (st) => { $('cam-fps').textContent = `${st.fps} fps`; },
  onMockTick: (f) => {
    const name = f.item.name;
    if (camUi.now !== name) {
      camUi.now = name;
      if (mimicCfg.on) { $('mock-caption').textContent = 'Mock pose: ' + (mockMod.DANCE_CAPTIONS[name] || name); $('mock-caption').hidden = false; }
      let before = true;
      for (const li of camUi.items) { li.classList.toggle('now', li.dataset.g === name); if (li.dataset.g === name) before = false; li.classList.toggle('done', before); }
    }
  },
  onState: (s, msg, st) => {
    const on = s === 'on';
    $('cam-toggle').setAttribute('aria-pressed', String(on || s === 'starting'));
    $('cam-toggle-label').textContent = on || s === 'starting' ? 'Camera on' : 'Camera';
    $('cam-box').hidden = !(on || s === 'starting');
    $('cam-mockbadge').hidden = !camMock;
    $('cam-timeline').hidden = !camMock;
    if (!on) $('mock-caption').hidden = true;
    $('cam-mode').textContent = st.mode === 'full' ? `pose + hands (${st.delegate || ''})` : st.mode === 'motion-only' ? 'motion only' : st.mode === 'mock' ? 'scripted' : '';
    camStatus(msg, s === 'error');
    if (!on) { $('cam-fps').textContent = '0 fps'; flyApi.setAttention(null); memes.clear(); }
  },
});
$('cam-toggle').addEventListener('click', () => {
  engine.unlock();
  if (cam.running || cam.starting) cam.stop('Camera off.'); else cam.start();
});
$('cam-stop').addEventListener('click', () => cam.stop('Camera off.'));
document.addEventListener('visibilitychange', () => { if (document.hidden && (cam.running || cam.starting)) cam.stop('Camera stopped because the tab was hidden.'); });
addEventListener('pagehide', () => cam.stop(null, true));
// Mock camera: the timeline is the gesture tour, or the "Copy me" dance while Copy me is on
function buildMockTimeline() {
  if (!camMock) return;
  const order = mimicCfg.on ? mockMod.DANCE_ORDER : mockMod.MOCK_ORDER;
  camUi.items = []; camUi.now = null;
  $('cam-timeline').textContent = '';
  $('cam-timeline').hidden = false;
  for (const g of order) { const li = el('li', '', (mimicCfg.on && mockMod.DANCE_CAPTIONS[g]) || GESTURE_TITLES[g] || g); li.dataset.g = g; camUi.items.push(li); $('cam-timeline').append(li); }
  cam.mockSetOrder(order);
  if (!mimicCfg.on) $('mock-caption').hidden = true;
}
buildMockTimeline();

// ---- "Camera actions" panel ----
function applyCamCfg(persist = true) {
  camCfg = normalizeActionsConfig(camCfg);
  camEngine.setSensitivity(camCfg.sensitivity);
  camEngine.setExtraHold(requiredHolds(camCfg));
  const anyAsk = GESTURES.some((g) => camCfg.rows[g].action === 'ask');
  $('cam-ask-hint').classList.toggle('warn', anyAsk && !camCfg.askEnabled);
  if (persist) saveCamCfg();
}
const INSTANT = ['wave', 'jump', 'clap']; // no hold time: they can never ask a question
function buildRows() {
  const box = $('cam-rows');
  box.textContent = '';
  for (const g of GESTURES) {
    const row = el('div', 'cam-row'); row.setAttribute('role', 'listitem'); row.dataset.g = g;
    row.append(el('span', 'gname', GESTURE_TITLES[g] || g));
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = camCfg.rows[g].meme; cb.setAttribute('aria-label', `Show a meme for ${GESTURE_TITLES[g]}`);
    cb.addEventListener('change', () => { camCfg.rows[g].meme = cb.checked; applyCamCfg(); });
    lab.append(cb, document.createTextNode('Meme')); row.append(lab);
    const sel = el('select'); sel.setAttribute('aria-label', `Action for ${GESTURE_TITLES[g]}`);
    for (const a of ACTION_TYPES) { const o = el('option', '', ACTION_LABELS[a]); o.value = a; if (a === 'ask' && INSTANT.includes(g)) o.disabled = true; sel.append(o); }
    sel.value = camCfg.rows[g].action;
    sel.addEventListener('change', () => { camCfg.rows[g].action = sel.value; applyCamCfg(); });
    row.append(sel);
    const t = el('button', 'mini', 'Test'); t.type = 'button'; t.setAttribute('aria-label', `Test ${GESTURE_TITLES[g]}`);
    t.addEventListener('click', () => { engine.unlock(); onGesture({ name: g, confidence: 1, ts: performance.now(), test: true }, true); });
    row.append(t);
    box.append(row);
  }
}
buildRows();
$('cam-sens').value = camCfg.sensitivity;
$('cam-sens').addEventListener('change', () => { camCfg.sensitivity = $('cam-sens').value; applyCamCfg(); });
$('cam-ask').checked = camCfg.askEnabled;
$('cam-ask').addEventListener('change', () => { camCfg.askEnabled = $('cam-ask').checked; applyCamCfg(); });
applyCamCfg(false);

// ---- Debug / verification hooks (only with ?cam=mock, ?mock or ?debug=1) ----
if (camMock || params.has('mock') || params.get('debug') === '1') {
  window.__flyCamDebug = () => ({ running: cam.running, fps: cam.state.fps, lastGesture: camLastInfo, memesShown: memes.shown, mode: cam.state.mode, message: cam.state.message, frames: cam.state.frames, delegate: cam.state.delegate || null, initMs: cam.state.initMs || null });
  window.__flyApi = flyApi;
  if (camMock) window.__flyCamMock = { play: (n) => cam.mockPlay(n), names: mockMod.MOCK_ORDER.slice(), freeze: (b) => cam.mockFreeze(b), danceNames: mockMod.DANCE_ORDER.slice(), test: (n) => onGesture({ name: n, confidence: 1, ts: performance.now(), test: true }, true) };
}

// ---- Copy me controls ----
function syncMimicUi() {
  $('mimic-on').checked = mimicCfg.on;
  $('mimic-opts').hidden = !mimicCfg.on;
  $('mimic-mirror').checked = mimicCfg.mirror;
  $('mimic-smooth').value = String(Math.round(mimicCfg.smooth * 100));
}
syncMimicUi();
$('mimic-on').addEventListener('change', () => {
  mimicCfg.on = $('mimic-on').checked;
  mimic.setEnabled(mimicCfg.on);
  syncMimicUi(); saveMimicCfg(); buildMockTimeline();
  if (mimicCfg.on) engine.unlock(); // lets the boing / squeak play
});
$('mimic-mirror').addEventListener('change', () => { mimicCfg.mirror = $('mimic-mirror').checked; mimic.setMirror(mimicCfg.mirror); saveMimicCfg(); });
$('mimic-smooth').addEventListener('input', () => { mimicCfg.smooth = Number($('mimic-smooth').value) / 100; mimic.setSmoothness(mimicCfg.smooth); saveMimicCfg(); });
$('mimic-recal').addEventListener('click', () => mimic.recalibrate());
if (scene.ok) scene.setFrameHook(onSceneFrame);
if (camMock || params.has('mock') || params.get('debug') === '1') {
  // read-only snapshot of the rig the scene is showing now (plus the mimic's target) for the browser tests
  window.__flyRigDebug = () => {
    const smp = mim.sample || mimic.sample();
    const cur = scene.ok ? scene.getPose() : { ...smp.rig, weight: smp.weight };
    return { ...cur, target: { ...smp.rig, weight: smp.weight }, status: smp.status, calibrated: smp.calibrated, mirror: mimicCfg.mirror, copyOn: mimicCfg.on, state: scene.ok ? scene.state : null, settled: scene.ok ? scene.settled : null, rigKeys: RIG_KEYS, scripted: cam.state.mockItem || null };
  };
}
