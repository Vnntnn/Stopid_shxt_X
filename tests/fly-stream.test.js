'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../web/fly-stream.js'), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const streamOf = (chunks) => new ReadableStream({
  start(c) { for (const x of chunks) c.enqueue(x); c.close(); },
});
const enc = (s) => new TextEncoder().encode(s);
async function collect(chunks) {
  const { parseNdjsonStream } = await load();
  const out = [];
  await parseNdjsonStream(streamOf(chunks), (e) => out.push(e));
  return out;
}

test('parses whole lines', async () => {
  const out = await collect([enc('{"stage":"interpret","status":"start"}\n{"stage":"interpret","status":"done","ms":5}\n')]);
  assert.equal(out.length, 2);
  assert.equal(out[1].ms, 5);
});
test('line split across chunk boundaries', async () => {
  const out = await collect([enc('{"stage":"po'), enc('ol","status":"st'), enc('art"}\n')]);
  assert.deepEqual(out, [{ stage: 'pool', status: 'start' }]);
});
test('multibyte UTF-8 split across chunks', async () => {
  const bytes = enc('{"stage":"final","status":"done","data":{"t":"ไทย"}}\n');
  const cut = bytes.indexOf(0xe0) + 1; // inside the first Thai character
  const out = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
  assert.equal(out[0].data.t, 'ไทย');
});
test('trailing line without newline', async () => {
  const out = await collect([enc('{"a":1}\n{"b":2}')]);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});
test('malformed lines are reported, not thrown, and parsing continues', async () => {
  const out = await collect([enc('{oops\n\n{"stage":"jev","status":"start"}\n')]);
  assert.equal(out[0].stage, 'malformed');
  assert.equal(out[1].stage, 'jev');
});
test('reducer tracks stages, ms and final', async () => {
  const { applyEvent, newState } = await load();
  let s = newState();
  const frozen = s;
  s = applyEvent(s, { stage: 'interpret', status: 'start' });
  assert.equal(s.stages.interpret.status, 'running');
  s = applyEvent(s, { stage: 'interpret', status: 'done', ms: 321, data: { echo: 'x' } });
  assert.equal(s.stages.interpret.status, 'done');
  assert.equal(s.stages.interpret.ms, 321);
  assert.equal(frozen.stages.interpret.status, 'pending');
  s = applyEvent(s, { stage: 'malformed', raw: 'x' });
  assert.equal(s.malformed, 1);
  s = applyEvent(s, { stage: 'final', status: 'done', data: { decision: 'A' } });
  assert.equal(s.final.decision, 'A');
  assert.equal(s.done, true);
});
test('reducer records stage and final errors', async () => {
  const { applyEvent, newState } = await load();
  let s = applyEvent(newState(), { stage: 'research', status: 'error', error: { code: 'x', message: 'boom' } });
  assert.equal(s.stages.research.status, 'error');
  assert.equal(s.stages.research.error.message, 'boom');
  s = applyEvent(s, { stage: 'final', status: 'error', error: { code: 'provider', message: 'down' } });
  assert.equal(s.error.code, 'provider');
  assert.equal(s.final, null);
});
test('ignores unknown stages and non-objects', async () => {
  const { applyEvent, newState } = await load();
  const s = newState();
  assert.equal(applyEvent(s, null), s);
  assert.deepEqual(applyEvent(s, { stage: 'zzz', status: 'start' }).stages, s.stages);
});
