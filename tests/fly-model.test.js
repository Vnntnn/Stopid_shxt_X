import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Exercise the actual pinned Three.js loader and shipped GLB, without WebGL.
const threeUrl = new URL('../web/vendor/three.module.min.js', import.meta.url).href;
const dataModule = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const utilityUrl = dataModule(readFileSync(new URL('../web/vendor/utils/BufferGeometryUtils.js', import.meta.url), 'utf8').replace("from 'three'", `from '${threeUrl}'`));
const loaderUrl = dataModule(readFileSync(new URL('../web/vendor/loaders/GLTFLoader.js', import.meta.url), 'utf8')
  .replace("from 'three'", `from '${threeUrl}'`).replace("from '../utils/BufferGeometryUtils.js'", `from '${utilityUrl}'`));
const THREE = await import(threeUrl);
const { GLTFLoader } = await import(loaderUrl);
const assetRoot = new URL('../web/models/housefly/', import.meta.url);
const bytes = readFileSync(new URL('fly.glb', assetRoot));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
// Supply bitmap dimensions in Node. Actual texture bytes still pass through the
// real loader, while WebGL decoding/rendering remains the browser's responsibility.
globalThis.self = { URL };
globalThis.createImageBitmap = async (blob) => {
  const image = Buffer.from(await blob.arrayBuffer());
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20), close() {} };
};
GLTFLoader.prototype.loadAsync = function (url) {
  assert.equal(url, '/static/models/housefly/fly.glb');
  this.manager.setURLModifier((uri) => {
    const relative = new URL(uri).pathname.replace('/static/models/housefly/', '');
    return 'data:image/png;base64,' + readFileSync(new URL(relative, assetRoot)).toString('base64');
  });
  return new Promise((resolve, reject) => this.parse(buffer, 'http://fly.test/static/models/housefly/', resolve, reject));
};
const modelUrl = dataModule(
  readFileSync(new URL('../web/fly-model.js', import.meta.url), 'utf8')
    .replace("from 'three'", `from '${threeUrl}'`)
    .replace("from '/static/vendor/loaders/GLTFLoader.js'", `from '${loaderUrl}'`)
    .replace("from '/static/fly-mimic.js'", `from '${new URL('../web/fly-mimic.js', import.meta.url).href}'`));
const { loadFlyModel, disposeModel, FLY_SCALE } = await import(modelUrl);

test('Housefly retains its textured body, hair, wings, and all six articulated legs', async () => {
  const fly = await loadFlyModel();
  const parts = [];
  fly.model.traverse((part) => { if (part.isMesh) parts.push(part); });
  assert.equal(parts.length, 30);
  assert.equal(parts.reduce((count, part) => count + part.geometry.index.count / 3, 0), 12187);
  for (const side of ['l', 'r']) {
    for (const leg of ['f', 'm', 'h']) {
      const lower = fly.model.getObjectByName(`${side}${leg}_lower`);
      assert.equal(lower.parent.name, `${side}${leg}_upper`);
    }
  }
  const bounds = new THREE.Box3().setFromObject(fly.model);
  assert.ok(Math.abs(bounds.max.x + bounds.min.x) < 0.1, 'body sides must remain balanced');
  assert.ok(fly.landingHeight > 0 && fly.landingHeight < 2, 'feet clear the landing pad');
  assert.ok(Math.abs(bounds.max.z - bounds.min.z - 3) < 0.001);
  assert.ok(bytes.length < 3 * 1024 * 1024, 'model stays small enough for local web loading');
  for (const part of parts) {
    assert.equal(part.geometry.index.count % 3, 0, `${part.name} has complete triangles`);
    const positions = part.geometry.attributes.position;
    for (const index of part.geometry.index.array) {
      assert.ok(index < positions.count, `${part.name} has valid vertex indices`);
    }
    assert.ok(positions.array.every(Number.isFinite), `${part.name} has finite vertices`);
    assert.ok(part.material.map, `${part.name} needs its original texture`);
    assert.ok(part.material.normalMap, `${part.name} needs its original normal map`);
    assert.ok(part.material.map.image.width > 0);
  }
  assert.ok(!fly.model.getObjectByName('Cylinder001'), 'display pedestal removed');
  assert.ok(fly.model.getObjectByName('head_hair'));
  disposeModel(fly.model);
});

test('wings flap and fold, legs articulate, and landed wings stop', async () => {
  const fly = await loadFlyModel();
  const wing = fly.model.getObjectByName('l_wing');
  const femur = fly.model.getObjectByName('lf_upper');
  const pose = { flap: 0, fold: 0, t: 0, landed: false, motion: 1, state: 'idle' };
  fly.update(pose);
  const airborneWing = wing.quaternion.clone();
  const airborneLeg = femur.quaternion.clone();
  fly.model.updateMatrixWorld(true);
  const airborneWingBounds = new THREE.Box3().setFromObject(wing);
  const airborneBodyBounds = new THREE.Box3().setFromObject(fly.model);
  fly.update({ ...pose, flap: 0.6, t: 1, state: 'thinking' });
  assert.ok(wing.quaternion.angleTo(airborneWing) > 0.5);
  fly.update({ ...pose, fold: 1, landed: true, state: 'deciding' });
  assert.ok(femur.quaternion.angleTo(airborneLeg) > 0.25);
  assert.ok(wing.quaternion.angleTo(airborneWing) > 1);
  const landedWing = wing.quaternion.clone();
  fly.model.updateMatrixWorld(true);
  const foldedWingBounds = new THREE.Box3().setFromObject(wing);
  const landedBodyBounds = new THREE.Box3().setFromObject(fly.model);
  assert.ok(airborneWingBounds.max.x > foldedWingBounds.max.x + 0.5, 'wings spread out during flight');
  assert.ok(airborneBodyBounds.min.y > landedBodyBounds.min.y, 'airborne legs tuck toward the body');
  assert.ok(Math.abs(fly.landingHeight + landedBodyBounds.min.y * FLY_SCALE - 0.06) < 0.01, 'landed feet rest on the pad');
  fly.update({ ...pose, fold: 1, landed: true, t: 10, state: 'deciding' });
  assert.ok(wing.quaternion.angleTo(landedWing) < 0.001);
  fly.model.traverse((part) => { assert.ok(Math.abs(part.quaternion.length()-1) < 0.001); });
  disposeModel(fly.model);
});

test('all texture files match the importer manifest and attribution stays visible', () => {
  const manifest = JSON.parse(readFileSync(new URL('source.json', assetRoot), 'utf8'));
  assert.equal(manifest.license, 'CC-BY-4.0');
  assert.equal(manifest.triangles, 12187);
  for (const [name, info] of Object.entries(manifest.files)) {
    const file = readFileSync(new URL(name, assetRoot));
    assert.equal(file.length, info.bytes);
    assert.equal(createHash('sha256').update(file).digest('hex'), info.sha256);
  }
  const html = readFileSync(new URL('../web/fly.html', import.meta.url), 'utf8');
  assert.match(html, /class="model-credit"[^>]+5fe7cbd25f9a446d8bae005893d010dd/);
  assert.match(html, /schmoldt.art · CC BY 4.0/);
});

test('camera rig drives the actual Housefly on the matching screen side and restores the flight pose', async () => {
  const fly = await loadFlyModel();
  const { IDLE_RIG } = await import(new URL('../web/fly-mimic.js', import.meta.url));
  const base = { flap: 0, fold: 0, t: 0, landed: false, motion: 1, state: 'idle' };
  const names = ['lf_upper', 'rf_upper', 'l_wing', 'r_wing', 'head'];
  fly.update(base);
  const before = Object.fromEntries(names.map((name) => [name, fly.model.getObjectByName(name).quaternion.clone()]));
  fly.update({ ...base, rig: { ...IDLE_RIG, legL: 1, wingL: 1, flapL: 0, flapR: 0, lookX: 1 }, weight: 1 });
  // The source GLB's r parts are negative X, i.e. screen-left for a fly facing the camera.
  assert.ok(fly.model.getObjectByName('rf_upper').quaternion.angleTo(before.rf_upper) > 1);
  assert.ok(fly.model.getObjectByName('lf_upper').quaternion.angleTo(before.lf_upper) < 0.4);
  assert.ok(fly.model.getObjectByName('r_wing').quaternion.angleTo(before.r_wing) > 0.5);
  assert.ok(fly.model.getObjectByName('head').quaternion.angleTo(before.head) > 0.5);
  fly.model.updateMatrixWorld(true);
  const leftBounds = new THREE.Box3().setFromObject(fly.model.getObjectByName('rf_lower'));
  const rightBounds = new THREE.Box3().setFromObject(fly.model.getObjectByName('lf_lower'));
  assert.ok(leftBounds.max.y > rightBounds.max.y + 0.2, 'raised screen-left foreleg is visibly higher');
  // Repeated camera frames must not accumulate rotations.
  const raised = fly.model.getObjectByName('rf_upper').quaternion.clone();
  for (let i = 0; i < 60; i++) fly.update({ ...base, rig: { ...IDLE_RIG, legL: 1 }, weight: 1 });
  assert.ok(fly.model.getObjectByName('rf_upper').quaternion.angleTo(raised) < 0.001);
  fly.update({ ...base, rig: { ...IDLE_RIG, legL: 1, lookX: 1 }, weight: 0 });
  for (const name of names) assert.ok(fly.model.getObjectByName(name).quaternion.angleTo(before[name]) < 0.001, `${name} resets when copy mode stops`);
  disposeModel(fly.model);
});

test('main scene connects camera hooks to the textured fly, pauses during a decision and resumes on landing', async () => {
  const keys = ['document', 'window', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, clearRect() {}, fillText() {}, measureText: (s) => ({ width: s.length * 20 }) };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, setAttribute() {}, remove() {} }) };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  let scheduled, rendered;
  globalThis.requestAnimationFrame = (fn) => { scheduled = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { scheduled = null; };
  globalThis.__captureFlyScene = (s) => { rendered = s; };
  const facade = dataModule(`
    export * from '${threeUrl}';
    import { Texture } from '${threeUrl}';
    export class WebGLRenderer {
      constructor() { this.domElement = document.createElement('canvas'); this.domElement.style = {}; }
      setPixelRatio() {} setClearColor() {} setSize() {} dispose() {}
      render(scene) { globalThis.__captureFlyScene(scene); }
    }
    export class PMREMGenerator { fromScene() { return { texture: new Texture(), dispose() {} }; } dispose() {} }
    export class Clock { elapsedTime = 0; getDelta() { this.elapsedTime += .05; return .05; } }
  `);
  const meadowUrl = dataModule(readFileSync(new URL('../web/fly-meadow.js', import.meta.url), 'utf8').replace("from 'three'", `from '${facade}'`));
  const sceneUrl = dataModule(readFileSync(new URL('../web/fly-scene.js', import.meta.url), 'utf8')
    .replace("from 'three'", `from '${facade}'`)
    .replace("from '/static/fly-model.js'", `from '${modelUrl}'`)
    .replace("from '/static/fly-meadow.js'", `from '${meadowUrl}'`)
    .replace("from '/static/fly-mimic.js'", `from '${new URL('../web/fly-mimic.js', import.meta.url).href}'`));
  let scene;
  try {
    const { createScene } = await import(sceneUrl);
    scene = createScene({ clientWidth: 1360, clientHeight: 800, appendChild() {} });
    assert.equal(await scene.modelReady, true);
    assert.equal(scene.modelStatus, 'ready');
    const model = rendered.getObjectByName('Housefly');
    const fly = rendered.children.find((child) => child.getObjectByName('Housefly'));
    const tick = (count) => { for (let i = 0; i < count; i++) scheduled(); };
    let frames = 0;
    scene.setFrameHook(() => { frames++; });
    scene.setPose({ legL: 1, roll: .6, squash: .5 }); scene.setPoseWeight(1);
    tick(50);
    assert.ok(frames > 40);
    assert.ok(fly.rotation.z > .4);
    assert.ok(fly.scale.y < FLY_SCALE);
    assert.ok(scene.getPose().weight > .99);
    const raised = model.getObjectByName('rf_upper').quaternion.clone();
    scene.setState('deciding', { pad: 'A' }); tick(1);
    assert.equal(scene.settled, false);
    assert.equal(fly.scale.y, FLY_SCALE, 'decision flight ignores the camera squash');
    assert.ok(model.getObjectByName('rf_upper').quaternion.angleTo(raised) > 1, 'camera leg pose pauses during flight');
    tick(70);
    assert.equal(scene.landed, true);
    assert.equal(scene.settled, true);
    assert.ok(fly.scale.y < FLY_SCALE, 'copy mode resumes on the flower');
    scene.setPoseWeight(0); scene.setOffsets({}); tick(50);
    assert.equal(fly.scale.y, FLY_SCALE);
    assert.equal(scene.getPose().weight, 0);
    assert.equal(rendered.background, null, 'transparent scene keeps the Thai background visible');
    assert.ok(rendered.children.every((o) => o.position.toArray().every(Number.isFinite)));
  } finally {
    scene?.dispose(); delete globalThis.__captureFlyScene;
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
