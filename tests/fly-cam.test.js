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
