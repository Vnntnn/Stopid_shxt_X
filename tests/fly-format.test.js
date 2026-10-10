'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../web/fly-format.js'), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

test('hostnameOf strips www and rejects non-http', async () => {
  const { hostnameOf } = await load();
  assert.equal(hostnameOf('https://www.thaipbs.or.th/news/content/570727'), 'thaipbs.or.th');
  assert.equal(hostnameOf('http://today.line.me/th/v3'), 'today.line.me');
  assert.equal(hostnameOf('javascript:alert(1)'), '');
  assert.equal(hostnameOf(''), '');
  assert.equal(hostnameOf(null), '');
  assert.equal(hostnameOf('not a url'), '');
});
test('safeHttpUrl only allows http and https', async () => {
  const { safeHttpUrl } = await load();
  assert.equal(safeHttpUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(safeHttpUrl('  http://example.com '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.org', '//x.org', 'https://', undefined, 5]) {
    assert.equal(safeHttpUrl(bad), null, String(bad));
  }
});
test('formatCost', async () => {
  const { formatCost } = await load();
  assert.equal(formatCost(0.00731437), '$0.0073');
  assert.equal(formatCost(0), '$0.0000');
  assert.equal(formatCost(1.5), '$1.50');
  assert.equal(formatCost(undefined), '');
  assert.equal(formatCost(NaN), '');
  assert.equal(formatCost('0.1'), '');
});
test('formatPct rounds and clamps', async () => {
  const { formatPct } = await load();
  assert.equal(formatPct(0.7633), '76%');
  assert.equal(formatPct(0), '0%');
  assert.equal(formatPct(1.2), '100%');
  assert.equal(formatPct(-1), '0%');
  assert.equal(formatPct(null), '-');
});
test('formatSeconds', async () => {
  const { formatSeconds } = await load();
  assert.equal(formatSeconds(4241), '4.2 s');
  assert.equal(formatSeconds(805.5), '0.8 s');
  assert.equal(formatSeconds(undefined), '');
  assert.equal(formatSeconds(-3), '');
});
test('clampText collapses whitespace and cuts by code points', async () => {
  const { clampText } = await load();
  assert.deepEqual(clampText('a \n\t b   c', 50), { text: 'a b c', cut: false });
  assert.deepEqual(clampText('abcdefghij', 4), { text: 'abcd…', cut: true });
  const thai = 'ภูมิใจไทย'.repeat(5);
  const r = clampText(thai, 10);
  assert.equal(r.cut, true);
  assert.equal(Array.from(r.text).length, 11);
  assert.deepEqual(clampText(undefined, 5), { text: '', cut: false });
  assert.equal(clampText('ab ...', 100).text, 'ab ...');
});
test('deriveChecks prefers server checks', async () => {
  const { deriveChecks } = await load();
  const c = deriveChecks({ checks: [{ name: 'x', ok: true }, { name: 'y', ok: 0 }], agree: false });
  assert.deepEqual(c, [{ name: 'x', ok: true }, { name: 'y', ok: false }]);
});
test('deriveChecks falls back to agree / mean / min_conf', async () => {
  const { deriveChecks } = await load();
  const ok = deriveChecks({ decision: 'B', agree: true, mean: { A: 0.2, B: 0.6, none: 0.2 }, min_conf: 0.5 });
  assert.equal(ok.length, 3);
  assert.deepEqual(ok.map((x) => x.ok), [true, true, true]);
  const low = deriveChecks({ decision: 'B', agree: true, mean: { B: 0.4 }, min_conf: 0.5 });
  assert.deepEqual(low.map((x) => x.ok), [true, true, false]);
  const inc = deriveChecks({ decision: 'inconclusive', agree: false, mean: { A: 0.1, B: 0.5, none: 0.3 } });
  assert.deepEqual(inc.map((x) => x.ok), [true, false, false]);
});
test('deriveChecks degrades on empty input', async () => {
  const { deriveChecks } = await load();
  assert.deepEqual(deriveChecks(null), []);
  assert.deepEqual(deriveChecks({}), []);
});
