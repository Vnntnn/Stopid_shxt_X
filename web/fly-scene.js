// Procedural 3D fly scene (three.js primitives only, no external assets).
import * as THREE from 'three';

const FONT = '"Noto Sans Thai", "Sarabun", system-ui, sans-serif';
const PADS = {
  A: { pos: new THREE.Vector3(-2.7, -1.2, -2.4), color: 0x5ad1ff },
  B: { pos: new THREE.Vector3(2.1, -1.2, -2.4), color: 0xffb454 },
  none: { pos: new THREE.Vector3(0, -1.2, -5.5), color: 0xb9a6ff },
};
const CENTER = new THREE.Vector3(0, 1.5, 0);
const WING_FREQ = { idle: 9, listening: 30, thinking: 20, deciding: 24, inconclusive: 16 };

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function labelSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.4, 1.275, 1);
  sprite.userData.canvas = canvas;
  return sprite;
}

function drawLabel(sprite, id, label, prob, win) {
  const canvas = sprite.userData.canvas;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.textAlign = 'center';
  g.fillStyle = win ? '#ffffff' : 'rgba(235,240,255,0.88)';
  g.font = `600 52px ${FONT}`;
  let text = label || id;
  while (g.measureText(text).width > 480 && text.length > 3) text = text.slice(0, -2);
  if (text !== (label || id)) text += '…';
  g.fillText(text, 256, 78);
  if (typeof prob === 'number') {
    g.font = `700 64px ${FONT}`;
    g.fillStyle = win ? '#8dffc4' : '#aab4d6';
    g.fillText(Math.round(prob * 100) + '%', 256, 156);
  }
  sprite.material.map.needsUpdate = true;
}

export function createScene(container, { reducedMotion = false } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    return { ok: false, error: err, setState() {}, setCandidates() {}, dispose() {} };
  }
  const motion = reducedMotion ? 0.35 : 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070f, 0.035);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const camBase = new THREE.Vector3(0, 4.2, 9.5);

  scene.add(new THREE.HemisphereLight(0x9bb4ff, 0x1a1030, 0.9));
  const key = new THREE.PointLight(0xffd6c0, 40, 30);
  key.position.set(3, 6, 6);
  scene.add(key);
  const rim = new THREE.PointLight(0x6f8cff, 30, 30);
  rim.position.set(-5, 2, -4);
  scene.add(rim);

  // Starfield
  const starCount = 700;
  const sp = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 18 + Math.random() * 30;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
    sp[i * 3 + 1] = r * Math.cos(ph) * 0.7;
    sp[i * 3 + 2] = -Math.abs(r * Math.sin(ph) * Math.sin(th)) - 4;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 0.09, transparent: true, opacity: 0.8, fog: false }));
  scene.add(stars);

  // Floor grid
  const grid = new THREE.GridHelper(40, 40, 0x24305a, 0x141c38);
  grid.position.y = -2.1;
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  scene.add(grid);

  // Pads
  const pads = {};
  for (const [id, def] of Object.entries(PADS)) {
    const grp = new THREE.Group();
    grp.position.copy(def.pos);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 40),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.12, 48),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    const sprite = labelSprite();
    sprite.position.set(0, id === 'none' ? 1.2 : 1.45, 0);
    if (id !== 'none') drawLabel(sprite, id, id, undefined, false);
    grp.add(disc, ring, sprite);
    scene.add(grp);
    pads[id] = { grp, disc, ring, sprite, glow: 0, target: 0, label: null, prob: undefined };
  }

  // Fly
  const fly = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b2038, roughness: 0.45, metalness: 0.3, emissive: 0x3a2a7a, emissiveIntensity: 0.55 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xd8182a, roughness: 0.25, emissive: 0xff2030, emissiveIntensity: 0.9 });
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xbfe4ff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x0d1020, roughness: 0.6 });

  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), bodyMat);
  abdomen.scale.set(0.62, 0.55, 1.0);
  abdomen.position.set(0, 0, -1.05);
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), bodyMat);
  thorax.scale.set(0.58, 0.55, 0.7);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), bodyMat);
  head.position.set(0, 0.02, 0.85);
  const eyeGeo = new THREE.SphereGeometry(0.34, 20, 16);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.3, 0.08, 1.05);
  eyeR.position.set(0.3, 0.08, 1.05);
  const stripeGeo = new THREE.TorusGeometry(0.58, 0.04, 8, 24);
  const stripes = [0.2, -0.3, -0.8].map((z) => {
    const s = new THREE.Mesh(stripeGeo, new THREE.MeshStandardMaterial({ color: 0x5a3cff, emissive: 0x5a3cff, emissiveIntensity: 0.6 }));
    s.position.set(0, 0, -1.05 + z * 0.9 + 0.5);
    s.scale.set(1.0 - Math.abs(z) * 0.1, 0.9, 1);
    return s;
  });
  fly.add(abdomen, thorax, head, eyeL, eyeR, ...stripes);

  const wingGeo = new THREE.CircleGeometry(1, 28);
  const makeWing = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.3, 0.4, 0.05);
    const w = new THREE.Mesh(wingGeo, wingMat);
    w.scale.set(1.0, 0.36, 1);
    w.rotation.x = -Math.PI / 2;
    w.rotation.z = side > 0 ? 0 : Math.PI;
    w.position.set(side * 0.95, 0, -0.3);
    w.rotation.z = 0;
    pivot.add(w);
    fly.add(pivot);
    return pivot;
  };
  const wingL = makeWing(-1);
  const wingR = makeWing(1);

  const legGeo = new THREE.CylinderGeometry(0.018, 0.012, 1, 5);
  const legs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = 0.35 - i * 0.35;
      const upper = new THREE.Mesh(legGeo, legMat);
      const lower = new THREE.Mesh(legGeo, legMat);
      upper.scale.y = 0.7;
      lower.scale.y = 0.8;
      const hip = new THREE.Group();
      hip.position.set(side * 0.35, -0.3, z);
      upper.position.set(side * 0.28, -0.05, 0);
      upper.rotation.z = side * -1.1;
      lower.position.set(side * 0.62, -0.42, 0);
      lower.rotation.z = side * 0.35;
      hip.add(upper, lower);
      hip.rotation.y = side * (i - 1) * 0.35;
      fly.add(hip);
      legs.push(hip);
    }
  }
  const glowTex = glowTexture();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x7a5cff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.set(5, 5, 1);
  fly.add(glow);
  fly.scale.setScalar(0.78);
  scene.add(fly);

  // Listening pulse ring
  const pulse = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 1.0, 64),
    new THREE.MeshBasicMaterial({ color: 0x8dffc4, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  scene.add(pulse);

  // Animation state
  let state = 'idle';
  let stateT = 0;
  let flapPhase = 0;
  let flapSpeed = WING_FREQ.idle;
  let fold = 0; // 0 open, 1 folded
  const pos = CENTER.clone();
  let yaw = 0;
  let spin = 0;
  let landed = false;
  let dive = null; // {curve, t, dur, padId}
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  function setState(next, opts = {}) {
    if (next === 'deciding') {
      const padId = PADS[opts.pad] ? opts.pad : 'none';
      const end = PADS[padId].pos.clone().add(new THREE.Vector3(0, 0.38, 0));
      const mid = pos.clone().lerp(end, 0.5);
      mid.y = Math.max(pos.y, end.y) + 1.4;
      dive = { curve: new THREE.QuadraticBezierCurve3(pos.clone(), mid, end), t: 0, dur: reducedMotion ? 2.2 : 3.2, padId };
      landed = false;
      for (const [id, p] of Object.entries(pads)) p.target = id === padId ? 1 : 0;
    } else {
      dive = null;
      landed = false;
      if (next !== 'inconclusive') for (const p of Object.values(pads)) p.target = 0;
    }
    if (next === 'inconclusive') spin = 14;
    state = next;
    stateT = 0;
  }

  function setCandidates(cands) {
    for (const c of cands || []) {
      const p = pads[c.id];
      if (!p) continue;
      p.label = c.label;
      p.prob = c.prob;
      drawLabel(p.sprite, c.id, c.label, c.prob, p.target > 0.5);
    }
  }
  function refreshWinnerLabels() {
    for (const [id, p] of Object.entries(pads)) if (p.label) drawLabel(p.sprite, id, p.label, p.prob, p.target > 0.5);
  }

  function resize() {
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    // Pull the camera back on narrow/tall viewports so both pads fit.
    const k = camera.aspect < 1 ? 1 + (1 - camera.aspect) * 0.9 : 1;
    camBase.z = 9.5 * k;
    if (camera.aspect > 1.2) camera.setViewOffset(w, h, 0, h * 0.03, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const clock = new THREE.Clock();
  let raf = 0;
  let lastWinner = null;
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    stateT += dt;

    // Target pose per state
    let freq = WING_FREQ[state] || 9;
    let foldTarget = 0;
    if (state === 'deciding' && dive) {
      if (!landed) {
        dive.t += dt;
        const p = Math.min(dive.t / dive.dur, 1);
        const e = p * p * (3 - 2 * p);
        dive.curve.getPoint(e, tmp);
        tmp2.copy(tmp).sub(pos);
        pos.copy(tmp);
        if (tmp2.lengthSq() > 1e-6) yaw += (Math.atan2(tmp2.x, tmp2.z) - yaw) * Math.min(1, dt * 5);
        if (p >= 1) landed = true;
      }
      if (landed) {
        freq = 1.5;
        foldTarget = 1;
        yaw += (0 - yaw) * Math.min(1, dt * 2);
      } else if (dive.t / dive.dur > 0.8) {
        freq = 14;
        foldTarget = 0.4;
      }
    } else {
      let tx = CENTER.x, ty = CENTER.y + Math.sin(t * 1.3) * 0.18 * motion, tz = CENTER.z;
      if (state === 'thinking') {
        const a = t * 1.6 * (0.5 + 0.5 * motion);
        tx = Math.cos(a) * 1.9;
        tz = Math.sin(a) * 1.0;
        ty = 1.9 + Math.sin(t * 2.1) * 0.2 * motion;
      } else if (state === 'listening') {
        ty = CENTER.y + 0.25 + Math.sin(t * 6) * 0.05 * motion;
      } else if (state === 'inconclusive') {
        tx = Math.sin(t * 3) * 0.5 * motion;
        ty = CENTER.y + 0.4 + Math.sin(t * 5) * 0.2 * motion;
      }
      tmp.set(tx, ty, tz);
      tmp2.copy(tmp).sub(pos);
      pos.lerp(tmp, 1 - Math.exp(-dt * 2.4));
      let targetYaw = 0;
      if (state === 'thinking') targetYaw = Math.sin(t * 1.6) * 0.5;
      if (state === 'inconclusive') {
        spin = Math.max(0, spin - dt * 2.2 * (reducedMotion ? 2 : 1));
        yaw += spin * dt * motion;
        targetYaw = yaw;
      }
      if (state !== 'inconclusive') {
        let d = targetYaw - yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        yaw += d * Math.min(1, dt * 3);
      }
    }
    flapSpeed += (freq - flapSpeed) * Math.min(1, dt * 6);
    fold += (foldTarget - fold) * Math.min(1, dt * 5);
    flapPhase += dt * flapSpeed * (reducedMotion ? 0.6 : 1);

    fly.position.copy(pos);
    fly.rotation.y = yaw + 0.3;
    fly.rotation.x = state === 'thinking' ? 0.15 : state === 'inconclusive' ? Math.sin(t * 7) * 0.12 * motion : Math.sin(t * 1.1) * 0.04 * motion;
    fly.rotation.z = state === 'thinking' ? -0.25 : 0;
    const amp = (1 - fold) * 0.75 + 0.05;
    const flap = Math.sin(flapPhase * Math.PI * 2) * amp;
    const sweep = fold * 1.2;
    wingL.rotation.set(0, sweep, flap);
    wingR.rotation.set(0, -sweep, -flap);
    wingL.rotation.z = flap + 0.15 * (1 - fold);
    wingR.rotation.z = -flap - 0.15 * (1 - fold);
    const glowBase = state === 'listening' ? 0.8 : 0.5;
    glow.material.opacity += (glowBase + Math.sin(t * 2) * 0.08 - glow.material.opacity) * Math.min(1, dt * 4);
    // Subtle leg shuffle when landed
    for (let i = 0; i < legs.length; i++) legs[i].rotation.x = landed ? 0 : Math.sin(t * 3 + i) * 0.05 * motion;

    // Pulse ring
    if (state === 'listening') {
      const k = (t * 0.9) % 1;
      pulse.visible = true;
      pulse.position.set(pos.x, pos.y - 0.2, pos.z);
      pulse.rotation.x = -Math.PI / 2;
      pulse.scale.setScalar(1.2 + k * 3.2);
      pulse.material.opacity = (1 - k) * 0.7;
    } else {
      pulse.visible = false;
    }

    // Pads glow
    for (const [id, p] of Object.entries(pads)) {
      const prev = p.glow;
      p.glow += (p.target - p.glow) * Math.min(1, dt * 4);
      p.disc.material.opacity = 0.22 + p.glow * 0.5 + Math.sin(t * 2 + id.length) * 0.04 * motion;
      p.ring.material.opacity = 0.55 + p.glow * 0.45;
      p.grp.scale.setScalar(1 + p.glow * 0.18);
      if ((prev > 0.5) !== (p.glow > 0.5)) lastWinner = null;
    }
    if (lastWinner === null) { refreshWinnerLabels(); lastWinner = true; }

    // Camera drift
    camera.position.set(camBase.x + Math.sin(t * 0.25) * 0.7 * motion, camBase.y + Math.sin(t * 0.19) * 0.3 * motion, camBase.z);
    camera.lookAt(0, -0.2, 0);
    stars.rotation.y = t * 0.01 * motion;

    renderer.render(scene, camera);
  }
  frame();

  function dispose() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    const geos = new Set(), mats = new Set(), texs = new Set();
    scene.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
    });
    mats.forEach((m) => { if (m.map) texs.add(m.map); });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    texs.forEach((x) => x.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { ok: true, setState, setCandidates, dispose, get state() { return state; }, get landed() { return landed; } };
}
