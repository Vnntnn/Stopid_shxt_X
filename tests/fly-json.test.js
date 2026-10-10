import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeJson, linesToText, truncateStrings, sessionExport, exportFileName, byteSize, formatBytes, makeEventRecord,
  collapseState, isCollapsed, toggleCollapsed, collapseAll, expandAll, allCollapsed, childPath, MAX_STRING,
} from '../web/fly-json.js';

const full = (v, o = {}) => tokenizeJson(v, { collapse: expandAll(), maxString: Infinity, ...o });

test('fully expanded text equals JSON.stringify(value, null, 2)', () => {
  const v = { a: 1, b: [true, null, 'x', { c: [] , d: {} }], e: { f: -1.5e-7, g: 'q"uote\n' }, u: undefined };
  assert.equal(linesToText(full(v).lines), JSON.stringify(v, null, 2));
});

test('unicode and Thai strings survive as-is', () => {
  const v = { echo: 'ฉันเข้าใจว่าคุณถามว่า พรรคไหนนำ 🪰', name: 'ภูมิใจไทย' };
  const { lines } = full(v);
  assert.equal(linesToText(lines), JSON.stringify(v, null, 2));
  assert.ok(lines.some((l) => l.tokens.some((t) => t.t === 'str' && t.v.includes('ภูมิใจไทย'))));
});

test('strings with <script> stay plain string tokens (escaping is the renderer textContent job)', () => {
  const v = { snippet: '<script>alert(1)</script><img src=x onerror=alert(2)>' };
  const { lines } = full(v);
  const str = lines[1].tokens.find((t) => t.t === 'str');
  assert.equal(str.t, 'str');
  assert.equal(str.v, JSON.stringify(v.snippet));
  assert.equal(lines[1].tokens.find((t) => t.t === 'key').v, '"snippet"');
});

test('a <script> key name is still just a key token', () => {
  const { lines } = full({ '<script>': 1 });
  assert.equal(lines[1].tokens[0].t, 'key');
});

test('deep nesting does not overflow and is guarded', () => {
  let v = 'leaf';
  for (let i = 0; i < 100; i++) v = { n: v };
  assert.equal(linesToText(full(v).lines), JSON.stringify(v, null, 2));
  let deep = 1;
  for (let i = 0; i < 5000; i++) deep = [deep];
  const { lines } = full(deep);
  assert.ok(lines.length > 100 && lines.length < 1000);
  assert.ok(lines.some((l) => l.tokens.some((t) => t.t === 'hint' && /too deep/.test(t.v))));
});

test('default state expands depth < 2 and folds deeper containers with a size hint', () => {
  const v = { a: { b: { c: 1 } }, list: [1, 2, 3] };
  const { lines } = tokenizeJson(v);
  const txt = linesToText(lines);
  assert.match(txt, /"b": \{ 1 key \}/);
  assert.match(txt, /"list": \[$/m);
  assert.equal(lines.find((l) => l.path === '/a/b').toggle.collapsed, true);
});

test('custom hint appears on collapsed lines', () => {
  const v = { events: [{ t_ms: 10, stage: 'research', status: 'done' }] };
  const { lines } = tokenizeJson(v, { collapse: collapseState(2), hint: (x) => (x.stage ? `+${x.t_ms} ms ${x.stage}` : '') });
  assert.match(linesToText(lines), /\+10 ms research · 3 keys/);
});

test('large arrays are capped by maxLines and report it', () => {
  const v = { xs: Array.from({ length: 50000 }, (_, i) => i) };
  const r = tokenizeJson(v, { collapse: expandAll(), maxLines: 1500 });
  assert.equal(r.lines.length, 1500);
  assert.equal(r.capped, true);
  const small = tokenizeJson({ xs: [1, 2] }, { collapse: expandAll(), maxLines: 1500 });
  assert.equal(small.capped, false);
});

test('large arrays fold to one line when depth demands it', () => {
  const v = { a: { xs: Array.from({ length: 50000 }, (_, i) => i) } };
  const { lines } = tokenizeJson(v);
  assert.ok(lines.length < 10);
});

test('long strings are shortened with a show-full marker, and expand via fullPaths', () => {
  const long = 'x'.repeat(10000);
  const v = { s: long };
  const r = tokenizeJson(v, { collapse: expandAll(), maxString: 4000 });
  const tok = r.lines[1].tokens.find((t) => t.t === 'str');
  assert.equal(tok.v.length, 4002);
  assert.deepEqual(tok.more, { path: '/s', hidden: 6000 });
  const r2 = tokenizeJson(v, { collapse: expandAll(), maxString: 4000, fullPaths: new Set(['/s']) });
  const t2 = r2.lines[1].tokens.find((t) => t.t === 'str');
  assert.equal(t2.v.length, 10002);
  assert.equal(t2.more, undefined);
});

test('shortening never splits a surrogate pair', () => {
  const s = '😀'.repeat(10);
  const tok = tokenizeJson({ s }, { collapse: expandAll(), maxString: 5 }).lines[1].tokens.find((t) => t.t === 'str');
  assert.doesNotThrow(() => JSON.parse(tok.v));
  assert.equal(JSON.parse(tok.v), '😀😀');
  assert.match(truncateStrings({ s }, 5).s, /^😀😀…/);
});

test('truncateStrings shortens deep strings, keeps the rest and does not mutate', () => {
  const v = { a: ['y'.repeat(50), 'ok'], b: { c: 'z'.repeat(20), n: 3, t: true, z: null, u: undefined } };
  const snap = JSON.stringify(v);
  const t = truncateStrings(v, 10);
  assert.equal(JSON.stringify(v), snap);
  assert.equal(t.a[0], 'y'.repeat(10) + '… [+40 more chars]');
  assert.equal(t.a[1], 'ok');
  assert.equal(t.b.n, 3);
  assert.equal('u' in t.b, false);
  assert.equal(truncateStrings('short', 10), 'short');
  assert.equal(MAX_STRING, 4000);
});

test('collapse helpers are path keyed and immutable', () => {
  let cs = collapseState();
  assert.equal(isCollapsed(cs, '/a', 1), false);
  assert.equal(isCollapsed(cs, '/a/b', 2), true);
  const cs2 = toggleCollapsed(cs, '/a', 1);
  assert.equal(isCollapsed(cs2, '/a', 1), true);
  assert.equal(isCollapsed(cs, '/a', 1), false);
  assert.equal(isCollapsed(toggleCollapsed(cs2, '/a', 1), '/a', 1), false);
  assert.equal(isCollapsed(toggleCollapsed(cs, '/a/b', 2), '/a/b', 2), false);
  assert.equal(allCollapsed(collapseAll()), true);
  assert.equal(allCollapsed(cs), false);
  assert.equal(allCollapsed(toggleCollapsed(collapseAll(), '/x', 1)), false);
  assert.equal(isCollapsed(expandAll(), '/a/b/c/d', 40), false);
  assert.equal(isCollapsed(collapseAll(), '', 0), false);
  assert.equal(isCollapsed(collapseAll(), '/a', 1), true);
  assert.equal(childPath('/a', 'x/y~z'), '/a/x~1y~0z');
});

test('toggling one path leaves its siblings alone in the tokens', () => {
  const v = { a: { x: { p: 1 } }, b: { y: { q: 2 } } };
  const cs = toggleCollapsed(collapseState(), '/a/x', 2);
  const txt = linesToText(tokenizeJson(v, { collapse: cs }).lines);
  assert.match(txt, /"p": 1/);
  assert.match(txt, /"y": \{ 1 key \}/);
});

test('sessionExport has the documented shape', () => {
  const ev = makeEventRecord({ stage: 'interpret', status: 'start' }, 12.4);
  assert.deepEqual(ev, { t_ms: 12, stage: 'interpret', status: 'start', event: { stage: 'interpret', status: 'start' } });
  const s = sessionExport({ request: { text: 'สวัสดี', replay: true, startedAt: new Date(Date.UTC(2026, 9, 10, 1, 2, 3)) }, events: [ev], final: { decision: 'A' } });
  assert.deepEqual(Object.keys(s), ['request', 'events', 'final']);
  assert.deepEqual(s.request, { text: 'สวัสดี', replay: true, startedAt: '2026-10-10T01:02:03.000Z' });
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.final, { decision: 'A' });
  const e = sessionExport({ request: { text: 'q' }, events: [], final: null, error: { message: 'boom' } });
  assert.deepEqual(e.error, { message: 'boom' });
  assert.doesNotThrow(() => JSON.stringify(e));
});

test('sessionExport copes with empty and undefined fields', () => {
  for (const bad of [undefined, null, {}, { request: null, events: null }]) {
    const s = sessionExport(bad);
    assert.deepEqual(s, { request: { text: '', replay: false, startedAt: null }, events: [], final: null });
  }
  assert.equal(sessionExport({ request: { startedAt: 'not a date' } }).request.startedAt, null);
  assert.deepEqual(makeEventRecord(undefined, undefined), { t_ms: 0, stage: null, status: null, event: undefined });
  assert.equal('error' in sessionExport({ error: null }), false);
});

test('exportFileName is fly-ask-yyyymmdd-hhmmss.json in local time', () => {
  assert.equal(exportFileName(new Date(2026, 0, 5, 3, 4, 9)), 'fly-ask-20260105-030409.json');
  assert.equal(exportFileName(new Date(2026, 11, 31, 23, 59, 59)), 'fly-ask-20261231-235959.json');
  assert.match(exportFileName(), /^fly-ask-\d{8}-\d{6}\.json$/);
  assert.match(exportFileName(new Date('nope')), /^fly-ask-\d{8}-\d{6}\.json$/);
});

test('byteSize counts UTF-8 bytes of the pretty-printed JSON', () => {
  assert.equal(byteSize({ a: 1 }), '{\n  "a": 1\n}'.length);
  assert.equal(byteSize('ก'), 5); // "ก" = 3 bytes + 2 quotes
  assert.equal(byteSize(undefined), 0);
  assert.equal(byteSize(null), 4);
  const circ = {}; circ.self = circ;
  assert.equal(byteSize(circ), 0);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(300 * 1024), '300 KB');
  assert.equal(formatBytes(3 * 1048576), '3.0 MB');
});

test('empty and undefined values tokenize to something sensible', () => {
  assert.equal(linesToText(tokenizeJson(undefined).lines), 'null');
  assert.equal(linesToText(tokenizeJson({}).lines), '{}');
  assert.equal(linesToText(tokenizeJson([]).lines), '[]');
  assert.equal(linesToText(full({ a: undefined, b: [undefined, () => 1, NaN] }).lines), JSON.stringify({ a: undefined, b: [undefined, () => 1, NaN] }, null, 2));
});
