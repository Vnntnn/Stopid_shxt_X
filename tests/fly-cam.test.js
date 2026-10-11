'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/fly-cam.js'), 'utf8')).toString('base64'));

test('camera error messages are friendly and specific', async () => {
  const { describeCameraError } = await load();
  assert.match(describeCameraError({ name: 'NotAllowedError' }), /permission/i);
  assert.match(describeCameraError({ name: 'NotFoundError' }), /No camera/);
  assert.match(describeCameraError({ name: 'NotReadableError' }), /busy/);
  assert.match(describeCameraError('unsupported', false), /localhost or over https/);
  assert.match(describeCameraError(null), /Could not start/);
});

test('attention target: mirrored, nose by default, a raised hand wins, null when nothing is seen', async () => {
  const { attentionFrom } = await load();
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  pose[0] = { x: 0.25, y: 0.3, visibility: 1 }; pose[11] = { x: 0.33, y: 0.45, visibility: 1 }; pose[12] = { x: 0.17, y: 0.45, visibility: 1 };
  pose[15] = { x: 0.4, y: 0.7, visibility: 1 }; pose[16] = { x: 0.1, y: 0.7, visibility: 1 };
  const a = attentionFrom(pose, null);
  assert.equal(a.source, 'nose'); assert.ok(a.x > 0.4, 'raw left of the image is right on the mirrored preview'); assert.ok(a.y < 0);
  pose[16] = { x: 0.1, y: 0.1, visibility: 1 };
  assert.equal(attentionFrom(pose, null).source, 'hand');
  assert.equal(attentionFrom(null, null), null);
  assert.equal(attentionFrom(null, [{ x: 1.5, y: -3 }]).x, -1);
});

test('asset list matches the download script and the script pins versions and checksums', async () => {
  const { ASSET_FILES, MSG_ASSETS_MISSING } = await load();
  const sh = fs.readFileSync(path.join(__dirname, '../scripts/fetch_camera_assets.sh'), 'utf8');
  for (const f of ASSET_FILES) assert.ok(sh.includes(f), f);
  assert.match(sh, /set -eu/); assert.match(sh, /\.part/);
  assert.equal((sh.match(/[0-9a-f]{64}/g) || []).length >= 8, true);
  assert.match(sh, /tasks-vision@\$\{VER\}/); assert.match(sh, /VER="\d+\.\d+\.\d+"/);
  assert.equal(MSG_ASSETS_MISSING, 'camera assets missing: run scripts/fetch_camera_assets.sh');
  assert.match(fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8'), /^web\/vendor\/mediapipe\/$/m);
});

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise((r) => setImmediate(r));
async function cameraHarness(run) {
  const originals = Object.fromEntries(['window', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [], frames = new Map(), states = [], trackEvents = {};
  let stopped = 0, closed = 0;
  const track = { stop() { stopped++; }, addEventListener(name, fn) { trackEvents[name] = fn; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const media = { getUserMedia: async (constraints) => { calls.push(constraints); return stream; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: media } });
  globalThis.requestAnimationFrame = (fn) => { const id = frames.size + 1; frames.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const video = { srcObject: null, play: async () => {}, pause() {} };
  const vision = () => ({ p: { close() { closed++; } }, g: { close() { closed++; } }, delegate: 'CPU' });
  const { createCamera } = await load();
  const base = { video, overlay: { width: 320, height: 240, getContext: () => ({ clearRect() {} }) },
    engine: { reset() {}, update: () => [] }, fetchImpl: async () => ({ ok: true }),
    visionLoader: async () => vision(), onState: (s) => states.push(s) };
  try { await run({ createCamera, base, video, media, calls, frames, states, stream, vision, trackEvents, stopped: () => stopped, closed: () => closed }); }
  finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('camera stays off until started, requests video only and releases tracks, models and frames on stop', async () => {
  await cameraHarness(async (h) => {
    const cam = h.createCamera(h.base);
    assert.equal(cam.running, false);
    assert.equal(h.calls.length, 0);
    assert.equal(await cam.start(), true);
    assert.equal(cam.state.mode, 'full');
    assert.equal(h.calls[0].audio, false);
    assert.equal(h.video.srcObject, h.stream);
    cam.stop();
    assert.equal(cam.running, false);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.stopped(), 1);
    assert.equal(h.closed(), 2);
    assert.equal(h.frames.size, 0);
  });
});

test('stopping during the asset probe never opens a camera afterward', async () => {
  await cameraHarness(async (h) => {
    const assets = deferred();
    const cam = h.createCamera({ ...h.base, fetchImpl: () => assets.promise });
    const starting = cam.start();
    cam.stop();
    assets.resolve({ ok: true });
    assert.equal(await starting, false);
    assert.equal(h.calls.length, 0);
    assert.equal(cam.running, false);
    assert.equal(h.states.at(-1), 'off');
  });
});

test('a cancelled permission request cannot replace a restarted camera stream', async () => {
  await cameraHarness(async (h) => {
    const permission = deferred(); let requested = 0, oldStopped = 0;
    h.media.getUserMedia = () => ++requested === 1 ? permission.promise : Promise.resolve(h.stream);
    const cam = h.createCamera(h.base);
    const first = cam.start(); await flush();
    cam.stop();
    assert.equal(await cam.start(), true);
    permission.resolve({ getTracks: () => [{ stop() { oldStopped++; } }] });
    assert.equal(await first, false);
    assert.equal(oldStopped, 1);
    assert.equal(h.video.srcObject, h.stream);
    assert.equal(cam.running, true);
    assert.equal(h.stopped(), 0);
    cam.stop();
    assert.equal(h.stopped(), 1);
  });
});

test('models finishing after stop are closed instead of reviving the camera', async () => {
  await cameraHarness(async (h) => {
    const models = deferred();
    const cam = h.createCamera({ ...h.base, visionLoader: () => models.promise });
    const starting = cam.start(); await flush();
    assert.equal(cam.running, true);
    cam.stop(); models.resolve(h.vision());
    assert.equal(await starting, false);
    assert.equal(h.closed(), 2);
    assert.equal(cam.state.mode, 'off');
    assert.equal(h.video.srcObject, null);
    assert.equal(h.states.at(-1), 'off');
  });
});


test('permission denial leaves no stream and allows a later retry', async () => {
  await cameraHarness(async (h) => {
    h.media.getUserMedia = async () => { throw { name: 'NotAllowedError' }; };
    const cam = h.createCamera(h.base);
    assert.equal(await cam.start(), false);
    assert.equal(h.states.at(-1), 'error');
    assert.equal(cam.starting, false);
    assert.equal(cam.running, false);
    assert.equal(h.video.srcObject, null);
    h.media.getUserMedia = async () => h.stream;
    assert.equal(await cam.start(), true);
    cam.stop();
  });
});

test('a failed video playback releases the camera before showing the error fallback', async () => {
  await cameraHarness(async (h) => {
    h.video.play = async () => { throw new Error('Playback failed'); };
    const cam = h.createCamera(h.base);
    assert.equal(await cam.start(), false);
    assert.equal(h.states.at(-1), 'error');
    assert.equal(cam.running, false);
    assert.equal(cam.starting, false);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.stopped(), 1);
    assert.equal(h.frames.size, 0);
  });
});

test('camera disconnection during playback startup cancels startup and releases the stream', async () => {
  await cameraHarness(async (h) => {
    const playback = deferred();
    h.video.play = () => playback.promise;
    const cam = h.createCamera(h.base);
    const starting = cam.start(); await flush();
    h.trackEvents.ended(); playback.resolve();
    assert.equal(await starting, false);
    assert.equal(h.states.at(-1), 'off');
    assert.equal(cam.running, false);
    assert.equal(cam.starting, false);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.stopped(), 1);
    assert.equal(h.frames.size, 0);
  });
});

test('camera disconnection after startup closes models and returns to the off fallback', async () => {
  await cameraHarness(async (h) => {
    const cam = h.createCamera(h.base);
    await cam.start(); h.trackEvents.ended();
    assert.equal(h.states.at(-1), 'off');
    assert.equal(cam.running, false);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.closed(), 2);
    assert.equal(h.frames.size, 0);
  });
});
