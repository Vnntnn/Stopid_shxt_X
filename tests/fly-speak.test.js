'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../web/fly-speak.js'), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const final = (decision, over = {}) => ({
  decision,
  candidates: [
    { id: 'A', label: "People's Party", prob: 0.634 },
    { id: 'B', label: 'Bhumjaithai Party', prob: 0.251 },
    { id: 'none', label: 'ยังเลือกไม่ได้', prob: 0.115 },
  ],
  interpretation: { language: 'th' },
  consistency: { agree: true },
  from_cache: false,
  ...over,
});

test('winner: label and rounded percent are always spoken, in both languages and every level', async () => {
  const { flySpeech } = await load();
  for (const lang of ['th', 'en']) {
    for (const level of [0, 1, 2]) {
      const a = flySpeech(final('A'), lang, level);
      assert.ok(a.includes("People's Party"), `${lang}/${level}: ${a}`);
      assert.ok(a.includes('63'), a);
      const b = flySpeech(final('B'), lang, level);
      assert.ok(b.includes('Bhumjaithai Party') && b.includes('25'), b);
    }
  }
  assert.match(flySpeech(final('A'), 'th'), /เปอร์เซ็นต์/);
  assert.match(flySpeech(final('A'), 'en'), /percent/);
});

test('inconclusive says it cannot decide and names no winner or number', async () => {
  const { flySpeech } = await load();
  const th = flySpeech(final('inconclusive'), 'th', 2);
  assert.match(th, /ตัดสินใจไม่ได้|สรุปไม่ได้/);
  assert.ok(!th.includes("People's") && !/\d/.test(th), th);
  const en = flySpeech(final('inconclusive'), 'en', 1);
  assert.match(en, /can't decide/);
  assert.ok(!/\d/.test(en));
});

test('Thai choice labels are preserved in speech for either landing target', async () => {
  const { flySpeech } = await load();
  const candidates = [{ id: 'A', label: 'ชา', prob: 0.7 }, { id: 'B', label: 'กาแฟ', prob: 0.3 }];
  for (const [id, label] of [['A', 'ชา'], ['B', 'กาแฟ']]) {
    for (const level of [0, 1, 2]) {
      const spoken = flySpeech(final(id, { candidates }), 'th', level);
      assert.ok(spoken.includes(label), spoken);
      assert.ok(!/Tea|Coffee/.test(spoken), spoken);
    }
  }
});

test('none is spoken as no clear choice with its label', async () => {
  const { flySpeech } = await load();
  assert.match(flySpeech(final('none'), 'th', 1), /ยังเลือกไม่ได้/);
  assert.match(flySpeech(final('none'), 'en', 1), /no clear choice/i);
});

test('language is taken from interpretation.language when not forced', async () => {
  const { flySpeech, pickLang } = await load();
  assert.equal(pickLang(final('A')), 'th');
  assert.equal(pickLang(final('A', { interpretation: { language: 'en' } })), 'en');
  assert.equal(pickLang({}), 'th');
  assert.match(flySpeech(final('A', { interpretation: { language: 'en' } })), /percent/);
  assert.match(flySpeech(final('A', { interpretation: { language: 'th' } })), /เปอร์เซ็นต์/);
  assert.match(flySpeech(final('A', { interpretation: { language: 'fr' } })), /percent/);
});

test('deterministic: same answer, same line; different answer, different seed allowed', async () => {
  const { flySpeech } = await load();
  const a = flySpeech(final('A'), 'th', 2);
  for (let i = 0; i < 5; i++) assert.equal(flySpeech(final('A'), 'th', 2), a);
  assert.equal(flySpeech(final('A', { from_cache: true }), 'th', 2), a);
});

test('every output is at most 200 characters, even with a huge label', async () => {
  const { flySpeech, MAX_CHARS } = await load();
  assert.equal(MAX_CHARS, 200);
  const big = final('A', { candidates: [{ id: 'A', label: 'x'.repeat(900), prob: 0.5 }] });
  for (const lang of ['th', 'en']) for (const level of [0, 1, 2]) {
    const s = flySpeech(big, lang, level);
    assert.ok(s.length <= 200, s.length);
    assert.ok(s.includes('50'), s);
  }
});

test('levels: 0 has no buzz, 1 some, 2 the most (stutter included)', async () => {
  const { flySpeech } = await load();
  const f = final('A', { interpretation: { language: 'en' } });
  const l0 = flySpeech(f, 'en', 0), l1 = flySpeech(f, 'en', 1), l2 = flySpeech(f, 'en', 2);
  const z = (s) => (s.match(/[Bb]z|Zz|zzz/g) || []).length;
  assert.equal(z(l0), 0, l0);
  assert.ok(z(l1) >= 1, l1);
  assert.ok(z(l2) > z(l1), `${l1} | ${l2}`);
  assert.match(l2, /\b(\w)-\1-/);
  assert.ok(l0.length < l1.length && l1.length < l2.length);
  const t0 = flySpeech(final('A'), 'th', 0);
  assert.ok(!/บึ|บิ๊|หึ่ง|ซี้ด/.test(t0), t0);
  assert.match(flySpeech(final('A'), 'th', 2), /บึ|บิ๊|หึ่ง|ซี้ด/);
});

test('missing or broken fields never throw and never invent a winner', async () => {
  const { flySpeech, summarize } = await load();
  for (const bad of [undefined, null, {}, { decision: 'A' }, { decision: 'A', candidates: 'x' }, { decision: 'B', candidates: [null, 3] }, 5]) {
    const s = flySpeech(bad, undefined, 2);
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0 && s.length <= 200);
  }
  assert.equal(summarize({}).kind, 'cant');
  const noProb = flySpeech({ decision: 'A', candidates: [{ id: 'A', label: 'Foo' }] }, 'en', 1);
  assert.ok(noProb.includes('Foo') && !/\d/.test(noProb));
  assert.equal(flySpeech(final('A'), 'th', 'bogus').includes("People's Party"), true);
});

test('seed helpers are stable', async () => {
  const { hashSeed, mulberry32 } = await load();
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
  const r1 = mulberry32(7), r2 = mulberry32(7);
  for (let i = 0; i < 5; i++) { const v = r1(); assert.equal(v, r2()); assert.ok(v >= 0 && v < 1); }
});
