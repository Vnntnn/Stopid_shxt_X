import { STAGES, newState, applyEvent, parseNdjsonStream } from '/static/fly-stream.js';
import { createScene } from '/static/fly-scene.js';
import { hostnameOf, formatCost, formatPct, formatSeconds, clampText, safeHttpUrl, deriveChecks } from '/static/fly-format.js';

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
  if (controller) controller.abort();
  controller = new AbortController();
  const mine = controller;
  starts = {};
  clearInterval(tick);
  $('result').hidden = true;
  $('error').hidden = true;
  openSnip.clear();
  $('send').disabled = true;
  let state = newState();
  renderStages(state);
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
