import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER } from './map/meshes.js';

// Draws the people of src/people.js with rigged models that walk with a real walk cycle: eight
// characters by Quaternius (CC0, see public/people/README.txt). Each character arrives as several
// pieces, one per material; here they are joined into one mesh whose shirt, trousers, hair and skin
// can be recoloured per person, so a crowd does not look like eight people copied.

const MODELS = ['man1', 'man2', 'man3', 'man4', 'woman1', 'woman2', 'woman3', 'woman4'];
const HEIGHT = 1.72;                    // metres, before each person's own scaling
const SKIN = ['#e9c6a5', '#dfb793', '#f1d5ba', '#d4a57f', '#e4bd9a'];
const TOPS = ['#2f3b52', '#8a2f2f', '#d9d6cf', '#3f6b4f', '#1d1f24', '#b9a27a', '#4a6fa5', '#7d4f8c', '#e0a030', '#5c6670', '#c0c4c8', '#a84c3a', '#f0efe9', '#31465e', '#6e7f5a'];
const BOTTOMS = ['#22262e', '#3a4658', '#5a5148', '#1a1c20', '#6f6a60', '#2f3f5f', '#8a8376', '#26303f'];
const HAIR = ['#15120f', '#1c1612', '#231a14', '#0d0d0f', '#2e2218', '#4a4a4e', '#8c8c8c'];
const BROLLIES = ['#1c1f24', '#2b4a7a', '#7a2b2b', '#e8e6e0', '#3d6b4a', '#d8a020', '#5a3f7a'];
const pick = (list, t) => list[Math.floor(t * list.length) % list.length];
// which part of the body a piece is, from the name of its material: 0 skin, 1 top, 2 bottom, 3 hair, 4 as made
const toneOf = name => (/skin/i.test(name) ? 0 : /shirt|dress|jacket/i.test(name) ? 1 : /pants/i.test(name) ? 2 : /hair|eyebrow/i.test(name) ? 3 : 4);

function personMaterial() {
  const uniforms = { uSkin: { value: new THREE.Color() }, uTop: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() }, uHair: { value: new THREE.Color() } };
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `attribute float tone;
uniform vec3 uSkin, uTop, uBottom, uHair;
${shader.vertexShader}`.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
  if (tone < 3.5) vColor.rgb = tone < 0.5 ? uSkin : tone < 1.5 ? uTop : tone < 2.5 ? uBottom : uHair;`,
    );
  };
  m.customProgramCacheKey = () => 'person';
  m.userData.uniforms = uniforms;
  return m;
}

// Turn a loaded character into a template: one skinned mesh, scaled to HEIGHT, with its walk and idle clips.
function prepare(gltf) {
  const scene = gltf.scene, pieces = [];
  scene.traverse(o => { if (o.isSkinnedMesh) pieces.push(o); });
  const geometry = mergeGeometries(pieces.map(piece => {
    const g = piece.geometry.clone(), n = g.attributes.position.count, colours = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) piece.material.color.toArray(colours, i * 3);
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(name)) g.deleteAttribute(name);
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    g.setAttribute('tone', new THREE.BufferAttribute(new Float32Array(n).fill(toneOf(piece.material.name)), 1));
    return g;
  }));
  const first = pieces[0], body = new THREE.SkinnedMesh(geometry, personMaterial());
  body.name = 'body';
  first.parent.add(body);
  body.position.copy(first.position);
  body.quaternion.copy(first.quaternion);
  body.scale.copy(first.scale);
  body.bind(first.skeleton, first.bindMatrix);
  for (const piece of pieces) piece.parent.remove(piece);
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), k = HEIGHT / (box.max.y - box.min.y);
  scene.scale.setScalar(k);
  scene.position.y = -box.min.y * k;
  const clip = pattern => gltf.animations.find(a => pattern.test(a.name));
  const walk = clip(/Walk$/), idle = clip(/Idle$/) || clip(/Standing$/);
  if (!walk || !idle) throw new Error('character without a walk or idle animation');
  return { scene, walk, idle };
}

// ground(x, z): height of the ground. dir: where the models are, with a trailing slash.
export function createPeopleView(scene, ground, dir) {
  const group = new THREE.Group(), templates = [], pools = [], shown = new Map();     // shown: person id -> figure
  scene.add(group);
  const loader = new GLTFLoader();
  MODELS.forEach((name, i) => loader.load(`${dir}${name}.glb`, gltf => { try { templates[i] = prepare(gltf); pools[i] = []; } catch (e) { console.warn(name, e.message); } }, undefined, () => { /* without it, people of this kind are not drawn */ }));

  // a soft dark patch under the feet in place of a real shadow, and the umbrella
  const blot = new THREE.Mesh(new THREE.CircleGeometry(0.34, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }));
  const brollyShape = mergeGeometries([new THREE.ConeGeometry(0.6, 0.2, 8, 1, true).translate(0, 2.06, 0), new THREE.CylinderGeometry(0.012, 0.012, 0.95, 5).translate(0, 1.6, 0)].map(g => g.toNonIndexed()));
  const brollyMaterials = BROLLIES.map(c => new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide }));

  function figure(kind) {
    const t = templates[kind], root = new THREE.Group(), model = cloneSkinned(t.scene);
    const body = model.getObjectByName('body');
    body.material = personMaterial();
    const mixer = new THREE.AnimationMixer(model), walk = mixer.clipAction(t.walk), idle = mixer.clipAction(t.idle);
    walk.play();
    idle.play();
    const shade = blot.clone(), brolly = new THREE.Mesh(brollyShape, brollyMaterials[0]);
    shade.position.y = 0.03;
    brolly.position.set(-0.16, 0, 0.08);
    root.add(model, shade, brolly);
    return { root, kind, shown: false, uniforms: body.material.userData.uniforms, mixer, walk, idle, brolly, gait: 1, time: 0 };
  }

  const sphere = new THREE.Sphere(), frustum = new THREE.Frustum(), matrix = new THREE.Matrix4();
  let frame = 0;
  return {
    group,
    get ready() { return templates.filter(Boolean).length; },
    // camera: to animate only the figures that can be seen, and the distant ones less often
    sync(people, dt, camera) {
      frame++;
      frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const alive = new Set();
      for (const p of people) {
        const kind = Math.floor(p.look[0] * MODELS.length) % MODELS.length;
        if (!templates[kind]) continue;                     // its model has not arrived yet
        alive.add(p.id);
        let f = shown.get(p.id);
        if (!f) {
          f = pools[kind].pop() || figure(kind);
          shown.set(p.id, f);
          f.root.visible = true;
          f.root.scale.setScalar(p.height);
          f.uniforms.uSkin.value.set(pick(SKIN, p.look[1]));
          f.uniforms.uTop.value.set(pick(TOPS, p.look[2]));
          f.uniforms.uBottom.value.set(pick(BOTTOMS, (p.look[1] * 7 + p.look[2] * 3) % 1));
          f.uniforms.uHair.value.set(pick(HAIR, (p.look[0] * 11 + p.look[1] * 5) % 1));
          f.brolly.material = brollyMaterials[Math.floor(p.look[2] * 97) % brollyMaterials.length];
          f.gait = p.moving ? 1 : 0;
          f.time = 0;
        }
        const lift = p.edge.kind === 'cross' ? LAYER.mark : p.edge.kind === 'path' ? LAYER.path : LAYER.sidewalk;
        f.root.position.set(p.x, ground(p.x, p.z, p) + lift, p.z);
        // A figure is a skeleton of some forty bones, all of which the renderer goes through every frame
        // whether it is in the picture or not. Those out of sight are taken off the scene meanwhile.
        // (those close by stay, in sight or not: they are what the car's mirrors show)
        // (nor those a long way off: a figure is a couple of thousand triangles and its own draw, for a few
        // dots on the screen - they come and go a little further out once shown, so as not to flicker)
        const away = f.root.position.distanceToSquared(camera.position), reach = f.shown ? 135 : 120;
        const inView = away < reach * reach && frustum.intersectsSphere(sphere.set(f.root.position, 2.4)) || away < 40 * 40;
        if (inView !== f.shown) { f.shown = inView; if (inView) group.add(f.root); else group.remove(f.root); }
        if (!inView) continue;
        f.root.rotation.y = Math.atan2(p.ux, p.uz);
        f.brolly.visible = p.umbrella;
        // walking and standing blend into each other over a moment
        f.gait += ((p.moving ? 1 : 0) - f.gait) * Math.min(1, dt * 6);
        f.time += dt;
        const seen = true, far = f.root.position.distanceTo(camera.position);
        // the walk cycle is advanced every frame up close, every third frame beyond 45 m, and not at all out of sight
        if (seen && (far < 45 || (frame + p.id) % 3 === 0)) {
          f.walk.setEffectiveWeight(f.gait);
          f.idle.setEffectiveWeight(1 - f.gait);
          f.walk.timeScale = (p.dodge > 0 ? 2.2 : p.pace / 1.25);
          f.mixer.update(f.time);
          f.time = 0;
        }
      }
      for (const [id, f] of shown) {
        if (alive.has(id)) continue;
        if (f.shown) { f.shown = false; group.remove(f.root); }
        pools[f.kind].push(f);
        shown.delete(id);
      }
    },
  };
}
