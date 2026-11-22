import * as THREE from 'three';
import { ENV } from './map/shared.js';

// What a wet road reflects: the scene drawn a second time from a camera mirrored in the road surface,
// at reduced resolution. Road materials look this picture up (see wetRoad in map/shared.js).
// The road is treated as one level plane at the car's height, which holds while the ground is gentle.
export function createRoadReflection(renderer, scene) {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const mirror = new THREE.PerspectiveCamera();
  const normal = new THREE.Vector3(0, 1, 0), onPlane = new THREE.Vector3(), eye = new THREE.Vector3();
  const view = new THREE.Vector3(), look = new THREE.Vector3(), aim = new THREE.Vector3();
  const rotation = new THREE.Matrix4(), plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4();
  ENV.mirror.value = target.texture;

  return {
    resize(width, height) {
      target.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    },

    // Blank the picture, for when reflections are switched off.
    clear() {
      const before = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.setRenderTarget(before);
    },

    // height: the level of the road. hidden: objects to leave out (the road itself, rain, light decals).
    render(camera, height, hidden) {
      onPlane.set(0, height, 0);
      eye.setFromMatrixPosition(camera.matrixWorld);
      if (eye.y <= height) return;

      // mirror the camera's position, aim and up vector in the plane
      view.subVectors(onPlane, eye).reflect(normal).negate().add(onPlane);
      rotation.extractRotation(camera.matrixWorld);
      look.set(0, 0, -1).applyMatrix4(rotation).add(eye);
      aim.subVectors(onPlane, look).reflect(normal).negate().add(onPlane);
      mirror.position.copy(view);
      mirror.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
      mirror.lookAt(aim);
      mirror.far = camera.far;
      mirror.updateMatrixWorld();
      mirror.projectionMatrix.copy(camera.projectionMatrix);

      ENV.mirrorMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
        .multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);

      // Tilt the near plane onto the road so nothing below it is drawn (Lengyel's oblique projection).
      plane.setFromNormalAndCoplanarPoint(normal, onPlane).applyMatrix4(mirror.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const e = mirror.projectionMatrix.elements;
      q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      clip.multiplyScalar(2 / clip.dot(q));
      e[2] = clip.x;
      e[6] = clip.y;
      e[10] = clip.z + 1 - 0.003;
      e[14] = clip.w;

      const shown = hidden.map(o => o.visible), shadows = renderer.shadowMap.autoUpdate, before = renderer.getRenderTarget();
      for (const o of hidden) o.visible = false;
      renderer.shadowMap.autoUpdate = false;       // the shadow map from the main view is still good
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, mirror);
      renderer.setRenderTarget(before);
      renderer.shadowMap.autoUpdate = shadows;
      hidden.forEach((o, i) => { o.visible = shown[i]; });
    },
  };
}
