// Pure helpers for the "Raw JSON" view of the Fly Ask output. No DOM access: the view builds nodes from these tokens
// with textContent only, because strings come from web search results and an LLM.

export const DEFAULT_DEPTH = 2;      // containers at depth < 2 start expanded
export const MAX_STRING = 4000;      // longer string values are shortened until "show full"
export const LARGE_BYTES = 200 * 1024;
export const MAX_DEPTH = 200;        // guard against absurdly deep nesting (recursion)

const esc = (p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1');
export const childPath = (path, key) => path + '/' + esc(key);

// Same view of a value that JSON.stringify has: toJSON, no undefined/functions, null for non-finite numbers.
function norm(v) {
  if (v && typeof v.toJSON === 'function') { try { v = v.toJSON(); } catch (_) { return undefined; } }
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

function cutString(s, n) {
  let cut = s.slice(0, n);
  const c = cut.charCodeAt(cut.length - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut = cut.slice(0, -1); // never split a surrogate pair
  return cut;
}

// ---- Collapse state: default depth plus per-path overrides. Immutable: every helper returns a new state. ----
export function collapseState(depth = DEFAULT_DEPTH) { return { depth, overrides: {} }; }
export function isCollapsed(cs, path, depth) {
  return Object.prototype.hasOwnProperty.call(cs.overrides, path) ? cs.overrides[path] : depth >= cs.depth;
}
export function toggleCollapsed(cs, path, depth) {
  return { depth: cs.depth, overrides: { ...cs.overrides, [path]: !isCollapsed(cs, path, depth) } };
}
export const collapseAll = () => collapseState(1);              // root stays open, everything below folds
export const expandAll = () => collapseState(Infinity);
export const allCollapsed = (cs) => cs.depth <= 1 && Object.keys(cs.overrides).length === 0;

// ---- Truncation ----
export function truncateStrings(value, n = MAX_STRING, depth = 0) {
  const v = norm(value);
  if (typeof v === 'string') return v.length > n ? `${cutString(v, n)}… [+${v.length - cutString(v, n).length} more chars]` : v;
  if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => { const t = truncateStrings(x, n, depth + 1); return t === undefined ? null : t; });
  const out = {};
  for (const k of Object.keys(v)) { const t = truncateStrings(v[k], n, depth + 1); if (t !== undefined) out[k] = t; }
  return out;
}

// ---- Size ----
function pretty(value) {
  try { return JSON.stringify(value, null, 2); } catch (_) { return undefined; }
}
export function byteSize(value) {
  const text = pretty(value);
  return text === undefined ? 0 : new TextEncoder().encode(text).length;
}
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ---- Tokens: lines of {depth, path, tokens:[{t, v}], toggle}. t is key|str|num|bool|null|punct|hint. ----
// A string token may carry `more:{path, hidden}` (shortened) and `k` (the key it belongs to).
export function tokenizeJson(value, opts = {}) {
  const { maxString = MAX_STRING, collapse = collapseState(), fullPaths = null, maxLines = Infinity, hint = null } = opts;
  const lines = [];
  let capped = false;
  const push = (line) => {
    if (lines.length >= maxLines) { capped = true; return false; }
    lines.push(line);
    return true;
  };
  const P = (v) => ({ t: 'punct', v });

  function walk(raw, path, depth, key, comma) {
    if (capped) return;
    const v = norm(raw);
    const lead = key === null ? [] : [{ t: 'key', v: JSON.stringify(key) }, P(': ')];
    const tail = comma ? [P(',')] : [];
    if (v === undefined || v === null) { push({ depth, path, tokens: [...lead, { t: 'null', v: 'null' }, ...tail], toggle: null }); return; }
    if (typeof v !== 'object') {
      let tok;
      if (typeof v === 'string') {
        if (v.length > maxString && !(fullPaths && fullPaths.has(path))) {
          const cut = cutString(v, maxString);
          tok = { t: 'str', v: JSON.stringify(cut), k: key, more: { path, hidden: v.length - cut.length } };
        } else tok = { t: 'str', v: JSON.stringify(v), k: key };
      } else if (typeof v === 'boolean') tok = { t: 'bool', v: String(v) };
      else tok = { t: 'num', v: String(v) };
      push({ depth, path, tokens: [...lead, tok, ...tail], toggle: null });
      return;
    }
    const isArr = Array.isArray(v);
    const keys = isArr ? null : Object.keys(v).filter((k) => norm(v[k]) !== undefined);
    const n = isArr ? v.length : keys.length;
    const [open, close] = isArr ? ['[', ']'] : ['{', '}'];
    if (n === 0) { push({ depth, path, tokens: [...lead, P(open + close), ...tail], toggle: null }); return; }
    if (depth >= MAX_DEPTH) { push({ depth, path, tokens: [...lead, P(open), { t: 'hint', v: ' too deep ' }, P(close), ...tail], toggle: null }); return; }
    if (isCollapsed(collapse, path, depth)) {
      let h = null;
      if (hint) { try { h = hint(v, path); } catch (_) { h = null; } }
      const size = `${n} ${isArr ? (n === 1 ? 'item' : 'items') : (n === 1 ? 'key' : 'keys')}`;
      push({ depth, path, tokens: [...lead, P(open), { t: 'hint', v: ` ${h ? h + ' · ' : ''}${size} ` }, P(close), ...tail], toggle: { path, collapsed: true, size: n } });
      return;
    }
    if (!push({ depth, path, tokens: [...lead, P(open)], toggle: { path, collapsed: false, size: n } })) return;
    for (let i = 0; i < n; i++) {
      if (capped) return;
      const k = isArr ? i : keys[i];
      walk(v[k], childPath(path, k), depth + 1, isArr ? null : k, i < n - 1);
    }
    if (capped) return;
    push({ depth, path, closing: true, tokens: [P(close), ...tail], toggle: null });
  }

  walk(value, '', 0, null, false);
  return { lines, capped };
}

// Plain text of the lines (used by tests: fully expanded and untruncated it equals JSON.stringify(value, null, indent)).
export function linesToText(lines, indent = 2) {
  return lines.map((l) => ' '.repeat(l.depth * indent) + l.tokens.map((t) => t.v).join('')).join('\n');
}

// ---- Session export ----
export function makeEventRecord(event, tMs) {
  const e = event && typeof event === 'object' ? event : null;
  return { t_ms: Math.max(0, Math.round(Number(tMs) || 0)), stage: e && e.stage != null ? e.stage : null, status: e && e.status != null ? e.status : null, event };
}

function isoOrNull(d) {
  if (d == null || d === '') return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
}

// Everything needed to reproduce / export one run: {request, events, final, error?}.
export function sessionExport(state) {
  const s = state && typeof state === 'object' ? state : {};
  const req = s.request && typeof s.request === 'object' ? s.request : {};
  const out = {
    request: { text: req.text == null ? '' : String(req.text), replay: !!req.replay, startedAt: isoOrNull(req.startedAt) },
    events: Array.isArray(s.events) ? s.events.slice() : [],
    final: s.final === undefined ? null : s.final,
  };
  if (s.error) out.error = s.error;
  return out;
}

export function exportFileName(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `fly-ask-${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
