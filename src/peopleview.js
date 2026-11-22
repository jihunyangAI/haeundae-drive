import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER } from './map/meshes.js';

// Draws the people of src/people.js: one small figure each, from a pool. A figure is a single mesh;
// its arms and legs swing in the vertex shader, and its clothes, hair and umbrella are set per person.

const SKIN = ['#e8c4a0', '#dcb48c', '#f0d2b4', '#c99a72'];
const TOPS = ['#2f3b52', '#8a2f2f', '#d9d6cf', '#3f6b4f', '#1d1f24', '#b9a27a', '#4a6fa5', '#7d4f8c', '#e0a030', '#5c6670', '#c0c4c8', '#a84c3a'];
const BOTTOMS = ['#22262e', '#3a4658', '#5a5148', '#1a1c20', '#6f6a60', '#2f3f5f', '#8a8376'];
const HAIR = ['#15120f', '#231a14', '#3a2a1c', '#0d0d0f', '#5a5a5e', '#8c8c8c'];
const BROLLIES = ['#1c1f24', '#2b4a7a', '#7a2b2b', '#e8e6e0', '#3d6b4a', '#d8a020', '#5a3f7a'];
const pick = (list, t) => list[Math.floor(t * list.length) % list.length];

// limb: 0 body, 1 left leg, 2 right leg, 3 left arm, 4 right arm. tone: 0 skin, 1 top, 2 bottom, 3 hair, 4 shoes, 5 umbrella.
function figure() {
  const parts = [];
  const add = (geo, limb, tone, x, y, z) => {
    const g = geo.index ? geo.toNonIndexed() : geo, n = g.attributes.position.count;
    g.translate(x, y, z);
    g.deleteAttribute('uv');
    g.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
    g.setAttribute('tone', new THREE.BufferAttribute(new Float32Array(n).fill(tone), 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    parts.push(g);
  };
  add(new THREE.BoxGeometry(0.34, 0.52, 0.2), 0, 1, 0, 1.16, 0);
  add(new THREE.BoxGeometry(0.32, 0.18, 0.2), 0, 2, 0, 0.86, 0);
  add(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 6), 0, 0, 0, 1.45, 0);
  add(new THREE.SphereGeometry(0.105, 10, 8).scale(1, 1.16, 1.05), 0, 0, 0, 1.6, 0);
  add(new THREE.SphereGeometry(0.113, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1, 1.16, 1.08), 0, 3, 0, 1.615, -0.008);
  for (const [side, leg, arm] of [[1, 1, 3], [-1, 2, 4]]) {
    add(new THREE.CapsuleGeometry(0.066, 0.66, 2, 6), leg, 2, side * 0.09, 0.455, 0);
    add(new THREE.BoxGeometry(0.11, 0.07, 0.24), leg, 4, side * 0.09, 0.035, 0.045);
    add(new THREE.CapsuleGeometry(0.046, 0.46, 2, 6), arm, 1, side * 0.215, 1.13, 0);
    add(new THREE.SphereGeometry(0.046, 6, 5), arm, 0, side * 0.215, 0.85, 0);
  }
  add(new THREE.ConeGeometry(0.58, 0.2, 8, 1, true), 0, 5, -0.12, 2.04, 0.05);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.95, 5), 0, 5, -0.12, 1.56, 0.05);
  return mergeGeometries(parts);
}

function personMaterial() {
  const uniforms = {
    uStride: { value: 0 }, uSwing: { value: 0 }, uUmbrella: { value: 0 },
    uSkin: { value: new THREE.Color() }, uTop: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() },
    uHair: { value: new THREE.Color() }, uBrolly: { value: new THREE.Color() },
  };
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `attribute float limb;
attribute float tone;
uniform float uStride, uSwing, uUmbrella;
uniform vec3 uSkin, uTop, uBottom, uHair, uBrolly;
${shader.vertexShader}`.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  vColor.rgb = tone < 0.5 ? uSkin : tone < 1.5 ? uTop : tone < 2.5 ? uBottom : tone < 3.5 ? uHair : tone < 4.5 ? vec3(0.07) : uBrolly;`,
    ).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  if (limb > 0.5) {
    // legs swing from the hip and arms from the shoulder, opposite arm with each leg
    float pivot = limb < 2.5 ? 0.86 : 1.38;
    float way = (limb < 1.5 || limb > 3.5) ? 1.0 : -1.0;
    float angle = sin(uStride) * uSwing * way * (limb < 2.5 ? 0.55 : 0.42);
    float c = cos(angle), s = sin(angle), y = transformed.y - pivot;
    transformed.y = pivot + y * c - transformed.z * s;
    transformed.z = y * s + transformed.z * c;
  }
  if (tone > 4.5 && uUmbrella < 0.5) transformed = vec3(0.0, 1.2, 0.0);     // no umbrella: folded away to nothing`,
    );
  };
  m.customProgramCacheKey = () => 'person';
  m.userData.uniforms = uniforms;
  return m;
}

// ground(x, z): height of the ground.
export function createPeopleView(scene, ground) {
  const group = new THREE.Group(), geometry = figure(), pool = [], dressed = new WeakMap();
  scene.add(group);
  return {
    group,
    sync(people) {
      people.forEach((p, i) => {
        let mesh = pool[i];
        if (!mesh) {
          mesh = pool[i] = new THREE.Mesh(geometry, personMaterial());
          group.add(mesh);
        }
        const u = mesh.material.userData.uniforms;
        if (dressed.get(mesh) !== p.id) {                   // a different person is using this figure now
          dressed.set(mesh, p.id);
          u.uSkin.value.set(pick(SKIN, p.look[0]));
          u.uTop.value.set(pick(TOPS, p.look[1]));
          u.uBottom.value.set(pick(BOTTOMS, p.look[2]));
          u.uHair.value.set(pick(HAIR, (p.look[0] * 7 + p.look[1]) % 1));
          u.uBrolly.value.set(pick(BROLLIES, (p.look[1] * 5 + p.look[2]) % 1));
          mesh.scale.setScalar(p.height);
        }
        const lift = p.edge.kind === 'cross' ? LAYER.mark : p.edge.kind === 'path' ? LAYER.path : LAYER.sidewalk;
        mesh.position.set(p.x, ground(p.x, p.z) + lift, p.z);
        mesh.rotation.y = Math.atan2(p.ux, p.uz);
        mesh.visible = true;
        u.uUmbrella.value = p.umbrella ? 1 : 0;
        u.uStride.value = p.stride;
        u.uSwing.value += ((p.moving ? 1 : 0) - u.uSwing.value) * 0.2;
      });
      for (let i = people.length; i < pool.length; i++) pool[i].visible = false;
    },
  };
}
