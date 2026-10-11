const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/fly-composer.js'), 'utf8')).toString('base64'));

class Control {
  value = ''; placeholder = 'คำถามตัวอย่าง'; disabled = false; hidden = true; textContent = ''; style = {};
  listeners = {}; focused = false; open = false;
  addEventListener(type, fn) { this.listeners[type] = fn; }
  trigger(type, event = {}) { this.listeners[type]?.(event); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
async function setup() {
  const { createComposer } = await load();
  const controls = Object.fromEntries(['question', 'send', 'mic', 'activity', 'status', 'confirmation', 'countdown', 'cancel', 'settings', 'settingsToggle', 'settingsClose'].map((name) => [name, new Control()]));
  const sent = [], timers = new Map(); let micClicks = 0, nextTimer = 0;
  const composer = createComposer({ ...controls, onAsk: (text) => sent.push(text), onMic: () => micClicks++,
    setIntervalImpl: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearIntervalImpl: (id) => timers.delete(id) });
  return { ...controls, ...composer, sent, timers, micClicks: () => micClicks,
    tick: () => { for (const fn of [...timers.values()]) fn(); } };
}

test('typing and microphone share one composer, with the mic available directly', async () => {
  const c = await setup();
  c.question.value = 'เลือกเดินหรือขับรถ';
  c.mic.trigger('click');
  assert.equal(c.micClicks(), 1);
  assert.equal(c.question.value, 'เลือกเดินหรือขับรถ');
  assert.deepEqual(c.sent, []);
  c.send.trigger('click');
  assert.deepEqual(c.sent, ['เลือกเดินหรือขับรถ']);
});

test('speech fills the same field and sends once when its countdown completes', async () => {
  const c = await setup();
  c.showTranscript('ระหว่างชากับกาแฟ');
  assert.equal(c.question.value, 'ระหว่างชากับกาแฟ');
  assert.equal(c.question.focused, true);
  assert.equal(c.confirmation.hidden, false);
  for (let i = 0; i < 5; i++) c.tick();
  assert.deepEqual(c.sent, ['ระหว่างชากับกาแฟ']);
  assert.equal(c.timers.size, 0);
  assert.equal(c.confirmation.hidden, true);
});

test('editing or manually sending speech cancels its automatic send', async () => {
  const c = await setup();
  c.showTranscript('ข้อความจากเสียง');
  c.question.value = 'ข้อความที่แก้ไข'; c.question.trigger('input');
  for (let i = 0; i < 5; i++) c.tick();
  assert.deepEqual(c.sent, []);
  c.send.trigger('click');
  assert.deepEqual(c.sent, ['ข้อความที่แก้ไข']);
  c.showTranscript('อีกคำถาม'); c.send.trigger('click');
  for (let i = 0; i < 5; i++) c.tick();
  assert.deepEqual(c.sent, ['ข้อความที่แก้ไข', 'อีกคำถาม']);
});

test('Enter sends, Shift+Enter and IME composition do not, and an active request blocks duplicate sends', async () => {
  const c = await setup();
  let prevented = 0;
  const key = { key: 'Enter', preventDefault: () => prevented++ };
  c.question.value = 'ข้อความ';
  c.question.trigger('keydown', { ...key, shiftKey: true });
  c.question.trigger('keydown', { ...key, isComposing: true });
  assert.deepEqual(c.sent, []);
  c.question.trigger('keydown', key);
  assert.deepEqual(c.sent, ['ข้อความ']);
  assert.equal(prevented, 1);
  c.send.disabled = true; c.send.trigger('click'); c.question.trigger('keydown', key);
  assert.equal(c.sent.length, 1);
});

test('cancelling speech or recording again stops the countdown, while settings open independently', async () => {
  const c = await setup();
  c.showTranscript('ยังไม่พร้อมส่ง'); c.cancel.trigger('click');
  assert.equal(c.timers.size, 0);
  assert.equal(c.question.value, 'ยังไม่พร้อมส่ง');
  c.showTranscript('พูดใหม่'); c.mic.trigger('click');
  assert.equal(c.timers.size, 0);
  assert.equal(c.micClicks(), 1);
  c.settingsToggle.trigger('click'); assert.equal(c.settings.open, true);
  c.settingsClose.trigger('click'); assert.equal(c.settings.open, false);
  assert.deepEqual(c.sent, []);
});


test('empty messages never submit the placeholder as a question', async () => {
  const c = await setup();
  c.send.trigger('click');
  c.question.value = '   '; c.send.trigger('click');
  assert.deepEqual(c.sent, []);
});
