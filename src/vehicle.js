import { buildCarMesh } from './cars.js';

const G = 9.81;
const V0 = 2.0;      // below this speed the tyre model blends towards kinematic steering
const IDLE = 850;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// normalised torque curve over rpm / redline, peaking around 60 % of redline
const torqueCurve = x => (0.6 + 1.6 * x - 1.3 * x * x) / 1.092;

// Bicycle-model car. Conventions: heading 0 faces +Z, forward = (sin h, cos h),
// left = (cos h, -sin h); positive steer / yaw rate turn left.
export class Vehicle {
  constructor(spec, color) {
    this.spec = spec;
    this.a = spec.wheelbase * (1 - spec.frontWeight);   // CG to front axle
    this.b = spec.wheelbase * spec.frontWeight;         // CG to rear axle
    this.inertia = spec.mass * this.a * this.b * 1.15;
    this.tMax = spec.powerKW * 1000 / (0.826 * spec.redline * Math.PI / 30);
    this.vis = buildCarMesh(spec, color);
    this.mesh = this.vis.root;
    this.mesh.rotation.order = 'YXZ';
    this.spin = 0;
    this.signal = 'off';     // 'off' | 'left' | 'right' | 'hazard'
    this.blinkT = 0;
    this.blinkOn = false;
    this.turned = false;     // the wheel has been turned the signalled way, so straightening up cancels the signal
    this.reset(0, 0, 0);
  }

  // Switch a turn signal or the hazard lights; asking for the one that is on switches it off.
  // The hazard lights stay on until they are switched off themselves.
  setSignal(which) {
    if (this.signal === 'hazard' && which !== 'hazard') return;
    this.signal = this.signal === which ? 'off' : which;
    this.blinkT = 0;
    this.turned = false;
  }

  reset(x, z, heading) {
    Object.assign(this, {
      x, z, y: 0, placed: false, heading, vx: 0, vz: 0, vf: 0, vl: 0, yawRate: 0,
      steerIn: 0, steer: 0, throttle: 0, brake: 0, handbrake: false,
      reverse: false, gear: 0, shiftT: 0, sinceShift: 1, prevUp: 0, prevDown: 0,
      rpm: IDLE, rpmTarget: IDLE, ax: 0, ay: 0, roll: 0, pitch: 0,
      gx: 0, gz: 0, tiltX: 0, tiltZ: 0,   // ground gradient (dH/dx, dH/dz) and the body tilt following it
    });
  }

  // inp: { up, down: 0..1, steer: -1..1 (left positive), handbrake }
  control(dt, inp) {
    const s = this.spec, speed = Math.abs(this.vf);

    // Direction changes need a fresh press while stopped, so braking to a halt never slips into reverse.
    if (speed < 0.5) {
      if (!this.reverse && inp.down > 0.1 && this.prevDown <= 0.1 && inp.up < 0.1) this.reverse = true;
      else if (this.reverse && inp.up > 0.1 && this.prevUp <= 0.1 && inp.down < 0.1) { this.reverse = false; this.gear = 0; }
    }
    this.prevUp = inp.up;
    this.prevDown = inp.down;

    const thr = this.reverse ? inp.down : inp.up, brk = this.reverse ? inp.up : inp.down;
    this.throttle += clamp(thr - this.throttle, -dt * 6, dt * 3.5);
    this.brake += clamp(brk - this.brake, -dt * 10, dt * 6);
    this.handbrake = inp.handbrake;

    const turningIn = Math.abs(inp.steer) > Math.abs(this.steerIn) || inp.steer * this.steerIn < 0;
    const rate = dt * (turningIn ? 3.2 : 5);
    this.steerIn += clamp(inp.steer - this.steerIn, -rate, rate);
    // Lock shrinks with speed so a full key press asks for about 0.65 g on dry tarmac: brisk, not a skid.
    const maxSteer = Math.min(0.6, 0.65 * Math.atan(s.wheelbase * G / Math.max(speed * speed, 1)));
    this.steer = this.steerIn * maxSteer;
    if (this.signal === 'left' || this.signal === 'right') {
      const towards = this.steerIn * (this.signal === 'left' ? 1 : -1);
      if (towards > 0.3 && speed > 1) this.turned = true;
      else if (this.turned && towards < 0.06) this.signal = 'off';
    }

    // automatic gearbox
    this.shiftT = Math.max(0, this.shiftT - dt);
    this.sinceShift += dt;
    if (!this.reverse && this.sinceShift > 0.5) {
      const rpmAt = g => speed / s.wheelR * s.gears[g] * s.final * 30 / Math.PI;
      const up = (0.45 + 0.47 * this.throttle) * s.redline;
      const down = (0.18 + 0.17 * this.throttle) * s.redline;
      const rpm = rpmAt(this.gear);
      if (rpm > up && this.gear < s.gears.length - 1) {
        this.gear++; this.shiftT = 0.22; this.sinceShift = 0;
      } else if (rpm < down && this.gear > 0 && rpmAt(this.gear - 1) < up * 0.95) {
        this.gear--; this.shiftT = 0.12; this.sinceShift = 0;
      }
    }
  }

  step(h, mu) {
    const s = this.spec, m = s.mass, wb = s.wheelbase;
    const sin = Math.sin(this.heading), cos = Math.cos(this.heading);
    const vf = this.vx * sin + this.vz * cos;
    const vl = this.vx * cos - this.vz * sin;
    const dir = vf >= 0 ? 1 : -1, avf = Math.abs(vf);
    const vxc = Math.max(avf, V0), low = Math.min(1, avf / V0);

    // axle loads with longitudinal weight transfer
    const wt = m * this.ax * s.cgH / wb;
    const Nf = Math.max(m * G * 0.1, m * G * this.b / wb - wt);
    const Nr = Math.max(m * G * 0.1, m * G * this.a / wb + wt);

    // slip angles
    const af = Math.atan2(vl + this.yawRate * this.a, vxc) - this.steer * low * dir;
    const ar = Math.atan2(vl - this.yawRate * this.b, vxc);

    // engine and driveline
    const ratio = (this.reverse ? 3.4 : s.gears[this.gear]) * s.final;
    const wheelRpm = avf / s.wheelR * ratio * 30 / Math.PI;
    const rpm = Math.max(wheelRpm, IDLE + 1700 * this.throttle);   // converter slip when pulling away
    let Fd = 0;
    if (this.shiftT <= 0 && wheelRpm < s.redline) {
      Fd = this.tMax * torqueCurve(Math.min(1, rpm / s.redline)) * this.throttle * ratio * 0.9 / s.wheelR;
    }
    Fd *= clamp(1 - (Math.abs(ar) - 0.08) / 0.15, 0.2, 1);         // stability control eases power in a slide
    if (this.reverse) Fd *= 0.7 * clamp(1 - avf / 9, 0, 1);        // reversing is gentle and tops out near 30 km/h
    this.rpmTarget = Math.min(rpm, s.redline);

    const frontShare = s.drive === 'FWD' ? 1 : s.drive === 'RWD' ? 0 : 0.45;
    const capF = mu * Nf, capR = mu * Nr;
    const Fdf = Math.min(Fd * frontShare, 0.85 * capF);            // traction control
    const Fdr = Math.min(Fd * (1 - frontShare), 0.85 * capR);
    const sgn = this.reverse ? -1 : 1;

    // friction circle: grip spent on drive or braking is not available for cornering
    const uf = Fdf / capF, ur = Fdr / capR, braking = 1 - 0.3 * this.brake;
    const latF = capF * Math.sqrt(1 - 0.7 * uf * uf) * braking;
    const latR = capR * Math.sqrt(1 - 0.7 * ur * ur) * braking * (this.handbrake ? 0.35 : 1);

    const ks = s.stiff * (0.5 + 0.5 * mu) * m * G / wb;
    const Fyf = -latF * Math.tanh(0.92 * ks * this.b * af / latF);
    const Fyr = -latR * Math.tanh(ks * this.a * ar / latR);

    const cd = Math.cos(this.steer), sd = Math.sin(this.steer);
    const Fx = sgn * (Fdf * cd + Fdr) - Fyf * sd;
    const frontLat = Fyf * cd + sgn * Fdf * sd;
    const Fy = frontLat + Fyr;
    const Mz = this.a * frontLat - this.b * Fyr;

    const drag = 0.6 * s.cd * s.area * Math.hypot(this.vx, this.vz) / m;
    this.vx += ((Fx * sin + Fy * cos) / m - drag * this.vx) * h;
    this.vz += ((Fx * cos - Fy * sin) / m - drag * this.vz) * h;
    this.yawRate += Mz / this.inertia * h;
    // gravity pulls the car down the slope it stands on
    this.vx -= G * this.gx * h;
    this.vz -= G * this.gz * h;

    // brakes, rolling resistance and engine braking oppose forward motion and can stop the car dead
    let dec = 0.14 + this.brake * mu * G * 0.98 + (this.handbrake ? mu * G * 0.4 : 0);
    if (this.throttle < 0.05 && avf > 2) dec += 0.45;
    if (this.throttle < 0.02 && avf < 0.5) dec += 4;               // auto-hold keeps a stopped car from rolling downhill
    let nvf = this.vx * sin + this.vz * cos;
    const nvl = this.vx * cos - this.vz * sin;
    nvf -= Math.sign(nvf) * Math.min(Math.abs(nvf), dec * h);
    this.vx = nvf * sin + nvl * cos;
    this.vz = nvf * cos - nvl * sin;
    this.vf = nvf;
    this.vl = nvl;

    const k = Math.min(1, h * 8);
    this.ax += (Fx / m - (avf > 0.2 ? dir * dec : 0) - this.ax) * k;
    this.ay += (Fy / m - this.ay) * k;

    this.heading += this.yawRate * h;
    this.x += this.vx * h;
    this.z += this.vz * h;
  }

  // Push the car out of anything it overlaps and bounce it off. Returns the impact speed.
  collide(world) {
    const s = this.spec, r = s.W / 2, span = s.L / 2 - r, e = 0.15;
    let impact = 0;
    for (const off of [this.vis.centerZ + span, this.vis.centerZ, this.vis.centerZ - span]) {
      const rx = Math.sin(this.heading) * off, rz = Math.cos(this.heading) * off;
      world.query(this.x + rx, this.z + rz, r, (nx, nz, pen) => {
        this.x += nx * pen;
        this.z += nz * pen;
        const vn = (this.vx + this.yawRate * rz) * nx + (this.vz - this.yawRate * rx) * nz;
        if (vn >= 0) return;
        const lever = rz * nx - rx * nz;
        const j = -(1 + e) * vn / (1 / s.mass + lever * lever / this.inertia);
        this.vx = (this.vx + j * nx / s.mass) * 0.98;
        this.vz = (this.vz + j * nz / s.mass) * 0.98;
        this.yawRate += j * lever / this.inertia;
        impact = Math.max(impact, -vn);
      });
    }
    return impact;
  }

  // dark: 0..1, how much the headlamps stand out against the daylight
  // wet: 0..1 rain on the bodywork
  sync(dt, lightsOn, dark = 1, wet = 0) {
    const v = this.vis, s = this.spec;
    const k = Math.min(1, dt * 6);
    const sin = Math.sin(this.heading), cos = Math.cos(this.heading);
    // lean the whole car with the ground: nose up when it rises ahead, left side up when it rises to the left
    this.tiltX += (-Math.atan(this.gx * sin + this.gz * cos) - this.tiltX) * k;
    this.tiltZ += (Math.atan(this.gx * cos - this.gz * sin) - this.tiltZ) * k;
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.set(this.tiltX, this.heading, this.tiltZ);

    this.roll += (clamp(this.ay * s.rollK, -0.09, 0.09) - this.roll) * k;
    this.pitch += (clamp(-this.ax * s.pitchK, -0.06, 0.06) - this.pitch) * k;
    v.chassis.rotation.set(this.pitch, 0, this.roll);

    this.spin += this.vf / s.wheelR * dt;
    for (const w of v.wheels) {
      w.spin.rotation.x = this.spin;
      if (w.front) w.pivot.rotation.y = this.steer;
    }
    v.steeringWheel.rotation.z = -this.steer * 6;

    this.rpm += (this.rpmTarget - this.rpm) * Math.min(1, dt * 10);
    this.blinkT = this.signal === 'off' ? 0 : this.blinkT + dt;
    this.blinkOn = this.signal !== 'off' && this.blinkT % 0.72 < 0.36;
    const braking = this.brake > 0.05;
    const L = v.lamps, amber = side => (this.blinkOn && (this.signal === side || this.signal === 'hazard') ? 7 : 0.03);
    L.head.emissiveIntensity = lightsOn ? 8 : 0.04;
    L.drl.emissiveIntensity = lightsOn ? 1.5 : 2.6;
    L.tail.emissiveIntensity = braking ? 7 : lightsOn ? 1.6 : 0.3;
    L.reverse.emissiveIntensity = this.reverse ? 5 : 0.02;
    L.left.emissiveIntensity = amber('left');
    L.right.emissiveIntensity = amber('right');
    v.paint.roughness = Math.max(0.08, v.paint.userData.rough - 0.14 * wet);
    for (const spot of v.spots) spot.intensity = lightsOn ? 260 : 0;
    v.beamMat.opacity = lightsOn ? 0.06 + 0.3 * dark : 0;
  }
}
