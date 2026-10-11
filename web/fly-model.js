import * as THREE from 'three';
import { GLTFLoader } from '/static/vendor/loaders/GLTFLoader.js';
import { clampRig, wingAngles } from '/static/fly-mimic.js';

export const FLY_SCALE = 1;

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

// Schmoldt5000 / schmoldt.art's textured Housefly, with authored motion pivots.
export async function loadFlyModel() {
  const { scene: model } = await new GLTFLoader().loadAsync('/static/models/housefly/fly.glb');
  const parts = {};
  model.traverse((part) => {
    if (!part.isMesh && part.name) parts[part.name] = { object: part, rest: part.quaternion.clone() };
    if (part.isMesh) {
      if (part.name.endsWith('_hair')) {
        // Alpha-tested hair cards keep their fine detail without sorting halos.
        part.material.alphaTest = 0.35;
        part.material.transparent = false;
      }
      if (part.name.startsWith('l_wing') || part.name.startsWith('r_wing')) {
        // Keep the author's wing texture; lightweight transparency suits this stage.
        part.material.transmission = 0;
        part.material.opacity = 0.75;
        part.material.depthWrite = false;
      }
    }
  });
  for (const name of ['body', 'head', 'l_wing', 'r_wing',
    ...['l', 'r'].flatMap((side) => ['f', 'm', 'h'].flatMap((leg) => [`${side}${leg}_upper`, `${side}${leg}_lower`]))]) {
    if (!parts[name]) {
      disposeModel(model);
      throw new Error(`Fly model is missing ${name}`);
    }
  }
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  // The importer normalizes the model; the feet determine pad clearance.
  const landingHeight = -bounds.min.y * FLY_SCALE + 0.06;
  const flapRotation = new THREE.Quaternion();
  const foldRotation = new THREE.Quaternion();
  const legRotation = new THREE.Quaternion();
  const poseRotation = new THREE.Quaternion();
  const poseTarget = new THREE.Quaternion();

  return {
    model,
    landingHeight,
    update({ flap, fold, t, landed, motion, state, rig, weight = 0, flapPhase = 0, extraFlap = 0 }) {
      const W = THREE.MathUtils.clamp(Number.isFinite(weight) ? weight : 0, 0, 1);
      const rg = clampRig(rig);
      for (const [side, sign] of [['l', 1], ['r', -1]]) {
        // The author's anatomical left is +X (screen right when facing the camera).
        const screenSide = side === 'l' ? 'R' : 'L';
        const wing = parts[`${side}_wing`];
        flapRotation.setFromAxisAngle(Z, sign * flap);
        // The original pose has wings folded backward over the abdomen.
        foldRotation.setFromAxisAngle(Y, -sign * (1 - fold) * 1.05);
        wing.object.quaternion.copy(flapRotation).multiply(foldRotation).multiply(wing.rest);
        if (W > 0) {
          const wa = wingAngles(rg['wing' + screenSide]);
          const rigFlap = Math.sin(flapPhase * Math.PI * 2) * rg['flap' + screenSide] * 0.75 * motion;
          poseTarget.setFromAxisAngle(Z, sign * (wa.lift + rigFlap));
          poseRotation.setFromAxisAngle(Y, -sign * (1.05 - wa.sweep));
          poseTarget.multiply(poseRotation).multiply(wing.rest);
          wing.object.quaternion.slerp(poseTarget, W);
        }
        poseRotation.setFromAxisAngle(Z, sign * extraFlap);
        wing.object.quaternion.premultiply(poseRotation);
        for (const [index, leg] of ['f', 'm', 'h'].entries()) {
          const upper = parts[`${side}${leg}_upper`];
          const lower = parts[`${side}${leg}_lower`];
          const shuffle = Math.sin(t * 3 + index * 2 + sign) * 0.055 * motion;
          const tuck = (1 - fold) * 0.32;
          legRotation.setFromAxisAngle(Z, sign * (tuck + (landed ? shuffle * 0.15 : shuffle)));
          upper.object.quaternion.copy(upper.rest).multiply(legRotation);
          legRotation.setFromAxisAngle(X, (leg === 'h' ? 1 : -1) * tuck * 0.8);
          lower.object.quaternion.copy(lower.rest).multiply(legRotation);
          if (W > 0) {
            const raise = leg === 'f' ? rg['leg' + screenSide] : 0;
            const wiggle = Math.sin(t * (3 + 9 * rg.legWiggle) + index * 2 + sign) * rg.legWiggle * 0.3 * motion;
            poseRotation.setFromAxisAngle(Z, sign * (raise * 1.65 + wiggle + rg.curl * 0.2));
            poseTarget.copy(upper.rest).multiply(poseRotation);
            upper.object.quaternion.slerp(poseTarget, W);
            poseRotation.setFromAxisAngle(Z, sign * (raise * 0.85 + rg.curl * 0.7));
            poseTarget.copy(lower.rest).multiply(poseRotation);
            poseRotation.setFromAxisAngle(Y, leg === 'f' ? sign * rg['swing' + screenSide] * 0.65 : 0);
            poseTarget.multiply(poseRotation);
            lower.object.quaternion.slerp(poseTarget, W);
          }
        }
      }
      const head = parts.head;
      flapRotation.setFromAxisAngle(Y, Math.sin(t * 2) * (state === 'listening' ? 0.06 : 0.015) * motion);
      head.object.quaternion.copy(head.rest).multiply(flapRotation);
      if (W > 0) {
        poseRotation.setFromAxisAngle(Y, rg.lookX * 0.6);
        poseTarget.copy(head.rest).multiply(poseRotation);
        poseRotation.setFromAxisAngle(X, rg.lookY * 0.4);
        poseTarget.multiply(poseRotation);
        head.object.quaternion.slerp(poseTarget, W);
      }
    },
  };
}

export function disposeModel(model) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  model.traverse((part) => {
    if (part.geometry) geometries.add(part.geometry);
    if (part.material) for (const material of Array.isArray(part.material) ? part.material : [part.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) for (const value of Object.values(material)) {
    if (value?.isTexture) textures.add(value);
  }
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}
