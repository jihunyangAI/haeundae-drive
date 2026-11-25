import * as THREE from 'three';

// The mist the rear wheels throw up on a wet road: a small pool of soft dots, each born at a wheel,
// carried back and up, and faded out within a second.
const COUNT = 90;

export function createSpray(scene) {
  const positions = new Float32Array(COUNT * 3), fade = new Float32Array(COUNT);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('fade', new THREE.BufferAttribute(fade, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uScale: { value: 600 }, uTint: { value: 1 } },
    vertexShader: `
      uniform float uScale;
      attribute float fade;
      varying float vFade;
      void main() {
        vec4 mv = viewMatrix * vec4(position, 1.0);
        vFade = fade;
        gl_PointSize = clamp((0.5 + (1.0 - fade) * 1.4) * uScale / -mv.z, 1.0, 90.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uTint;
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(0.82, 0.86, 0.9) * uTint, smoothstep(0.5, 0.0, d) * vFade * 0.22);
      }`,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  points.visible = false;
  scene.add(points);
  const parts = Array.from({ length: COUNT }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
  let next = 0, owed = 0;

  return {
    points,
    // car: { x, y, z, heading, vf, vx, vz }. wet: 0..1. halfTrack, rear: where the rear wheels are. tint: brightness of the light.
    update(dt, car, wet, { halfTrack = 0.8, rear = 1.3, tint = 1, scale = 600 } = {}) {
      const speed = Math.abs(car.vf), rate = wet > 0.25 && speed > 6 ? Math.min(70, speed * 3.2) * wet : 0;
      owed += rate * dt;
      const fx = Math.sin(car.heading), fz = Math.cos(car.heading), back = Math.sign(car.vf) || 1;
      while (owed >= 1) {
        owed--;
        const p = parts[next], i = next * 3, side = Math.random() < 0.5 ? -1 : 1;
        next = (next + 1) % COUNT;
        // right of the heading (fx, fz) is (-fz, fx)
        positions[i] = car.x - fx * rear * back - fz * side * halfTrack + (Math.random() - 0.5) * 0.3;
        positions[i + 1] = car.y + 0.1;
        positions[i + 2] = car.z - fz * rear * back + fx * side * halfTrack + (Math.random() - 0.5) * 0.3;
        p.life = 1;
        p.vx = car.vx * 0.35 + (Math.random() - 0.5) * 1.2;
        p.vz = car.vz * 0.35 + (Math.random() - 0.5) * 1.2;
        p.vy = 0.8 + Math.random() * 1.6 + speed * 0.04;
      }
      let alive = false;
      parts.forEach((p, k) => {
        if (p.life <= 0) { fade[k] = 0; return; }
        alive = true;
        p.life -= dt * 1.3;
        p.vy -= 2.2 * dt;
        positions[k * 3] += p.vx * dt;
        positions[k * 3 + 1] += p.vy * dt;
        positions[k * 3 + 2] += p.vz * dt;
        fade[k] = Math.max(0, p.life);
      });
      points.visible = alive;
      if (!alive) return;
      material.uniforms.uTint.value = tint;
      material.uniforms.uScale.value = scale;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.fade.needsUpdate = true;
    },
  };
}
