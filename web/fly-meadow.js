import * as THREE from 'three';

// Seeded placement keeps the meadow stable between page loads.
function randomGenerator() {
  let seed = 713;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export function createMeadow(pads) {
  const meadow = new THREE.Group();
  const random = randomGenerator();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100),
    new THREE.MeshStandardMaterial({ color: 0x9b9c61, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.1;
  meadow.add(floor);

  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.045, 0, 0, 0.045, 0, 0, -0.032, 0.45, 0.045,
    0.045, 0, 0, 0.032, 0.45, 0.045, -0.032, 0.45, 0.045,
    -0.032, 0.45, 0.045, 0.032, 0.45, 0.045, 0, 1, 0.22,
  ], 3));
  blade.computeVertexNormals();
  const wind = { value: 0 }, windStrength = { value: 0.08 };
  const grassMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide });
  grassMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.meadowTime = wind;
    shader.uniforms.meadowWind = windStrength;
    shader.vertexShader = 'uniform float meadowTime;\nuniform float meadowWind;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      transformed.x += sin(meadowTime * 1.3 + instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.3)
        * position.y * position.y * meadowWind;
    `);
  };
  const grasses = new THREE.InstancedMesh(blade, grassMaterial, 3200);
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  let count = 0;
  while (count < grasses.count) {
    const x = (random() - 0.5) * 54;
    const z = -random() * 42 + 8;
    if (Object.values(pads).some(({ pos }) => Math.hypot(x - pos.x, z - pos.z) < 1.5)) continue;
    transform.position.set(x, -2.08, z);
    transform.rotation.set(0, random() * Math.PI * 2, (random() - 0.5) * 0.22);
    const height = 0.35 + random() * 1.15;
    transform.scale.set(0.8 + random(), height, height);
    transform.updateMatrix();
    grasses.setMatrixAt(count, transform.matrix);
    color.setHSL(0.17 + random() * 0.06, 0.25 + random() * 0.2, 0.27 + random() * 0.15);
    grasses.setColorAt(count++, color);
  }
  meadow.add(grasses);

  // Small wildflowers beyond the landing flowers add depth without extra draw calls.
  const blooms = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4),
    new THREE.MeshStandardMaterial({ roughness: 0.85 }), 150);
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.015, 0.022, 1, 4),
    new THREE.MeshStandardMaterial({ color: 0x496b32, roughness: 1 }), blooms.count);
  for (let i = 0; i < blooms.count; i++) {
    const side = random() < 0.5 ? -1 : 1;
    const x = side * (5 + random() * 21), z = -6 - random() * 30;
    const height = 0.7 + random() * 0.7;
    transform.position.set(x, -2.1 + height / 2, z);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(1, height, 1);
    transform.updateMatrix(); stems.setMatrixAt(i, transform.matrix);
    transform.position.y = -2.1 + height;
    transform.scale.set(0.12, 0.08, 0.12);
    transform.updateMatrix(); blooms.setMatrixAt(i, transform.matrix);
    blooms.setColorAt(i, new THREE.Color([0xfff5d7, 0x9e67b3, 0xf2cc65][i % 3]));
  }
  meadow.add(stems, blooms);
  meadow.userData.update = (t, motion) => { wind.value = t; windStrength.value = motion < 1 ? 0 : 0.08; };
  return meadow;
}

export function createLandingFlower(kind) {
  const flower = new THREE.Group();
  const petalColor = { jasmine: 0xfff9e8, marigold: 0xf4b633, lotus: 0xeab0c2 }[kind];
  const layers = kind === 'marigold' ? 3 : 2;
  const perLayer = kind === 'marigold' ? 16 : 8;
  const petals = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshStandardMaterial({ color: petalColor, roughness: 0.8 }), layers * perLayer);
  const transform = new THREE.Object3D();
  for (let layer = 0; layer < layers; layer++) {
    for (let i = 0; i < perLayer; i++) {
      const angle = (i + layer * 0.5) / perLayer * Math.PI * 2;
      const radius = 0.64 - layer * 0.16;
      transform.position.set(Math.sin(angle) * radius, -0.1 - layer * 0.035, Math.cos(angle) * radius);
      transform.rotation.set(0, angle, 0);
      transform.scale.set(kind === 'marigold' ? 0.19 : 0.28, kind === 'lotus' ? 0.14 : 0.09, 0.47 - layer * 0.08);
      transform.updateMatrix(); petals.setMatrixAt(layer * perLayer + i, transform.matrix);
    }
  }
  flower.add(petals);
  const center = new THREE.Mesh(new THREE.SphereGeometry(0.52, 24, 12),
    new THREE.MeshStandardMaterial({ color: kind === 'marigold' ? 0xc8841e : 0xe8ca69, roughness: 0.95 }));
  center.scale.y = 0.13;
  center.position.y = -0.07;
  flower.add(center);
  const gold = new THREE.MeshStandardMaterial({ color: 0xc69b3f, metalness: 0.65, roughness: 0.38 });
  const tray = new THREE.Mesh(new THREE.SphereGeometry(0.85, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), gold);
  tray.position.y = -0.23;
  tray.scale.y = 0.25;
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.025, 6, 32), gold);
  trim.rotation.x = -Math.PI / 2;
  trim.position.y = -0.23;
  flower.add(tray, trim);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.86, 8),
    new THREE.MeshStandardMaterial({ color: 0x4b7139, roughness: 1 }));
  stem.position.y = -0.49;
  flower.add(stem);
  const leafGeometry = new THREE.SphereGeometry(1, 10, 6);
  const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x5d863e, roughness: 1 });
  for (const side of [-1, 1]) {
    const leaf = new THREE.Mesh(leafGeometry, leafMaterial);
    leaf.position.set(side * 0.28, -0.6, 0);
    leaf.scale.set(0.4, 0.045, 0.16);
    leaf.rotation.z = side * 0.32;
    flower.add(leaf);
  }
  return flower;
}
