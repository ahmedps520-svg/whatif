import type { KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel } from '../../engine/types';
import { bool, num, str } from '../../engine/validation';

/**
 * Gravity & Projectile Lab — 2D rigid-sphere mechanics.
 *
 * Bodies are spheres moving in a vertical plane above a flat ground (y = 0).
 * Forces: uniform gravity, quadratic aerodynamic drag, ground normal force and
 * Coulomb friction. Ground and sphere–sphere contacts are resolved with impulses
 * using a coefficient of restitution. Airborne motion is integrated with RK4.
 */

export interface Body {
  id: string;
  label: string;
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  m: number;
  r: number;
  cd: number;
  e: number;
  launchT: number;
  launchX: number;
  maxH: number;
  airborne: boolean;
  resting: boolean;
  landings: number;
  apexReported: boolean;
}

export interface ProjectileState {
  t: number;
  bodies: Body[];
  nextSlot: number;
  /** Energy removed by drag, ground friction and inelastic contacts (J). */
  dissipated: number;
  lastG: number;
  pending: SimEvent[];
  gravityOffReported: boolean;
  gravityOnReported: boolean;
}

const LABELS = 'ABCDEFGHIJKL';
export const MAX_BODIES = 12;
const REST_SPEED = 0.02;

function effectiveG(p: ParamValues, t: number): number {
  const g = num(p, 'gravity');
  if (bool(p, 'gravityPause')) {
    const start = num(p, 'pauseStart');
    const dur = num(p, 'pauseDuration');
    if (t >= start && t < start + dur) return 0;
  }
  return g;
}

function makeBody(s: ProjectileState, init: Partial<Body> & { x: number; y: number; vx: number; vy: number; m: number; r: number; cd: number; e: number }): Body | null {
  if (s.bodies.length >= MAX_BODIES) return null;
  const slot = s.nextSlot++;
  const b: Body = {
    id: `body-${slot}`,
    label: LABELS[slot % LABELS.length] + (slot >= LABELS.length ? String(Math.floor(slot / LABELS.length)) : ''),
    slot,
    ax: 0,
    ay: 0,
    launchT: s.t,
    launchX: init.x,
    maxH: init.y - init.r,
    airborne: true,
    resting: false,
    landings: 0,
    apexReported: false,
    ...init,
  };
  s.bodies.push(b);
  return b;
}

function launchFromParams(s: ProjectileState, p: ParamValues, overrides: Partial<Body> = {}): Body | null {
  const v = num(p, 'launchSpeed');
  const ang = (num(p, 'launchAngle') * Math.PI) / 180;
  const r = num(p, 'radius');
  return makeBody(s, {
    x: 0,
    y: num(p, 'launchHeight') + r,
    vx: v * Math.cos(ang),
    vy: v * Math.sin(ang),
    m: num(p, 'mass'),
    r,
    cd: num(p, 'dragCoefficient'),
    e: num(p, 'restitution'),
    ...overrides,
  });
}

function setupScene(s: ProjectileState, p: ParamValues) {
  const setup = str(p, 'setup');
  const r = num(p, 'radius');
  const m = num(p, 'mass');
  const cd = num(p, 'dragCoefficient');
  const e = num(p, 'restitution');
  const h = num(p, 'dropHeight');
  switch (setup) {
    case 'compare-mass':
      makeBody(s, { x: -2 * r - 1, y: h + r, vx: 0, vy: 0, m, r, cd, e });
      makeBody(s, { x: 2 * r + 1, y: h + r, vx: 0, vy: 0, m: 2 * m, r, cd, e });
      break;
    case 'drop-vs-launch':
      makeBody(s, { x: -(2 * r + 0.5), y: h + r, vx: 0, vy: 0, m, r, cd, e });
      makeBody(s, { x: 0, y: h + r, vx: num(p, 'launchSpeed'), vy: 0, m, r, cd, e });
      break;
    case 'sliding':
      // Blocks start on the ground moving horizontally at decreasing speeds.
      for (let i = 0; i < 3; i++) {
        makeBody(s, { x: 0, y: r, vx: num(p, 'launchSpeed') * (1 - i * 0.3), vy: 0, m, r, cd, e: 0 });
      }
      for (const b of s.bodies) b.airborne = false;
      break;
    case 'collision': {
      const v = num(p, 'launchSpeed');
      makeBody(s, { x: -10, y: h + r, vx: v / 2, vy: 0, m, r, cd, e });
      makeBody(s, { x: 10, y: h + r, vx: -v / 2, vy: 0, m: m * num(p, 'massRatio'), r, cd, e });
      break;
    }
    case 'juggle':
      for (let i = 0; i < 4; i++) {
        const ang = ((55 + i * 8) * Math.PI) / 180;
        const v = num(p, 'launchSpeed') * (0.7 + 0.12 * i);
        makeBody(s, { x: i * 2, y: r, vx: v * Math.cos(ang), vy: v * Math.sin(ang), m, r, cd, e });
      }
      makeBody(s, { x: -6, y: r, vx: 0, vy: 0, m, r, cd, e });
      break;
    default:
      launchFromParams(s, p);
  }
}

/** Acceleration of a free (airborne) body. */
function freeAccel(vx: number, vy: number, b: Body, g: number, rho: number): [number, number] {
  const speed = Math.hypot(vx, vy);
  const area = Math.PI * b.r * b.r;
  const k = rho > 0 && b.cd > 0 ? (0.5 * rho * b.cd * area) / b.m : 0;
  return [-k * speed * vx, -g - k * speed * vy];
}

function rk4(b: Body, g: number, rho: number, h: number) {
  const { x, y, vx, vy } = b;
  const [a1x, a1y] = freeAccel(vx, vy, b, g, rho);
  const v2x = vx + 0.5 * h * a1x, v2y = vy + 0.5 * h * a1y;
  const [a2x, a2y] = freeAccel(v2x, v2y, b, g, rho);
  const v3x = vx + 0.5 * h * a2x, v3y = vy + 0.5 * h * a2y;
  const [a3x, a3y] = freeAccel(v3x, v3y, b, g, rho);
  const v4x = vx + h * a3x, v4y = vy + h * a3y;
  const [a4x, a4y] = freeAccel(v4x, v4y, b, g, rho);
  b.x = x + (h / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
  b.y = y + (h / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
  b.vx = vx + (h / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
  b.vy = vy + (h / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
  b.ax = a1x;
  b.ay = a1y;
}

function kinetic(b: Body) {
  return 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy);
}

function fmt(v: number, d = 2) {
  return Number(v.toFixed(d)).toString();
}

function stepBody(s: ProjectileState, p: ParamValues, b: Body, g: number, h: number) {
  const rho = num(p, 'airDensity');
  const mu = num(p, 'friction');
  const t0 = s.t;

  if (!b.airborne) {
    // On the ground. With g > 0 the normal force cancels gravity; friction opposes sliding.
    if (g <= 0 && b.vy > 0) b.airborne = true;
    else {
      const ke0 = kinetic(b);
      const speed = Math.abs(b.vx);
      const area = Math.PI * b.r * b.r;
      const drag = rho > 0 ? (0.5 * rho * b.cd * area * speed * speed) / b.m : 0;
      const decel = mu * Math.max(g, 0) + drag;
      if (speed > 0) {
        const dv = Math.min(speed, decel * h);
        const xNew = b.x + (b.vx - (Math.sign(b.vx) * dv) / 2) * h;
        b.vx -= Math.sign(b.vx) * dv;
        b.x = xNew;
        b.ax = -Math.sign(b.vx || 1) * decel;
      } else b.ax = 0;
      b.vy = 0;
      b.ay = 0;
      b.y = b.r;
      s.dissipated += ke0 - kinetic(b);
      if (Math.abs(b.vx) < REST_SPEED && !b.resting) {
        b.vx = 0;
        b.resting = true;
        s.pending.push({ t: t0 + h, id: `${b.id}-rest-${s.pending.length}-${Math.round(t0 * 1000)}`, label: `Object ${b.label} came to rest`, detail: `At x = ${fmt(b.x)} m, ${fmt(t0 + h - b.launchT)} s after release.`, severity: 'info', source: 'model' });
      }
      return;
    }
  }

  const vy0 = b.vy;
  const e0 = kinetic(b) + b.m * g * b.y;
  rk4(b, g, rho, h);
  const e1 = kinetic(b) + b.m * g * b.y;
  if (rho > 0) s.dissipated += Math.max(0, e0 - e1);

  // Apex: vertical velocity changes sign from + to −.
  if (vy0 > 0 && b.vy <= 0 && !b.apexReported) {
    const frac = vy0 / (vy0 - b.vy);
    const ta = t0 + frac * h;
    b.apexReported = true;
    s.pending.push({
      t: ta,
      id: `${b.id}-apex-${b.landings}`,
      label: `Object ${b.label} reached its highest point`,
      detail: `Height ${fmt(b.y - b.r)} m above the ground at t = ${fmt(ta)} s.`,
      severity: 'info',
      source: 'model',
    });
  }
  b.maxH = Math.max(b.maxH, b.y - b.r);

  // Ground contact.
  if (b.y - b.r < 0 && b.vy < 0) {
    const impactSpeed = Math.hypot(b.vx, b.vy);
    const vin = b.vy;
    const pen = b.r - b.y;
    const frac = Math.min(1, Math.max(0, 1 - pen / Math.max(1e-12, -vin * h)));
    const tImpact = t0 + frac * h;
    b.y = b.r;
    const ke0 = kinetic(b);
    let vyOut = -b.e * vin;
    // Friction impulse during impact, limited by the Coulomb bound μ·|J_normal|.
    const jn = (1 + b.e) * Math.abs(vin);
    const dvx = Math.min(Math.abs(b.vx), mu * jn);
    b.vx -= Math.sign(b.vx) * dvx;
    if (vyOut < Math.max(0.05, Math.sqrt(2 * Math.max(g, 0) * 0.0005))) vyOut = 0;
    b.vy = vyOut;
    s.dissipated += ke0 - kinetic(b);
    b.landings++;
    if (b.landings === 1) {
      const flight = tImpact - b.launchT;
      s.pending.push({
        t: tImpact,
        id: `${b.id}-land`,
        label: `Object ${b.label} hit the ground`,
        detail: `After ${fmt(flight)} s in flight; horizontal distance ${fmt(b.x - b.launchX)} m; impact speed ${fmt(impactSpeed)} m/s; peak height ${fmt(b.maxH)} m.`,
        severity: 'milestone',
        source: 'model',
      });
    }
    b.apexReported = false;
    if (vyOut === 0) b.airborne = false;
  }
}

function collide(s: ProjectileState, a: Body, b: Body) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minD = a.r + b.r;
  if (dist >= minD || dist === 0) return;
  const nx = dx / dist;
  const ny = dy / dist;
  const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  // Positional correction proportional to inverse mass.
  const overlap = minD - dist;
  const ia = 1 / a.m;
  const ib = 1 / b.m;
  a.x -= (overlap * nx * ia) / (ia + ib);
  a.y -= (overlap * ny * ia) / (ia + ib);
  b.x += (overlap * nx * ib) / (ia + ib);
  b.y += (overlap * ny * ib) / (ia + ib);
  if (a.y < a.r) a.y = a.r;
  if (b.y < b.r) b.y = b.r;
  if (vrel >= 0) return;
  const e = Math.min(a.e, b.e);
  const ke0 = kinetic(a) + kinetic(b);
  const j = (-(1 + e) * vrel) / (ia + ib);
  a.vx -= j * nx * ia;
  a.vy -= j * ny * ia;
  b.vx += j * nx * ib;
  b.vy += j * ny * ib;
  s.dissipated += ke0 - (kinetic(a) + kinetic(b));
  for (const body of [a, b]) {
    if (body.vy > 0 || body.y > body.r + 1e-6) {
      body.airborne = true;
      body.resting = false;
    } else if (Math.abs(body.vx) > REST_SPEED) body.resting = false;
  }
  s.pending.push({
    t: s.t,
    id: `collide-${a.id}-${b.id}-${Math.round(s.t * 1000)}`,
    label: `Objects ${a.label} and ${b.label} collided`,
    detail: `Closing speed ${fmt(-vrel)} m/s; restitution ${fmt(e)}. Momentum is exchanged along the line of centres.`,
    severity: 'info',
    source: 'model',
  });
}

export const projectileModel: SimulationModel<ProjectileState> = {
  id: 'projectile',
  name: 'Gravity & Projectile Lab',
  shortName: 'Physics Lab',
  domain: 'physics',
  viewKind: '2d',
  summary:
    'Launch, drop and collide spheres under adjustable gravity, air density and surface friction. Motion is integrated numerically (RK4) with impulse-based contacts.',
  params: [
    { key: 'setup', label: 'Experiment setup', type: 'choice', kind: 'initial', group: 'Setup', default: 'projectile', description: 'Which objects exist at t = 0.', options: [
      { value: 'projectile', label: 'Single projectile', description: 'One sphere launched with the launch settings.' },
      { value: 'compare-mass', label: 'Two masses dropped', description: 'Identical spheres, the second with twice the mass.' },
      { value: 'drop-vs-launch', label: 'Drop vs horizontal launch', description: 'One sphere dropped, one launched horizontally from the same height.' },
      { value: 'sliding', label: 'Sliding blocks', description: 'Three objects pushed along the ground at different speeds.' },
      { value: 'collision', label: 'Head-on collision', description: 'Two spheres moving toward each other.' },
      { value: 'juggle', label: 'Objects in flight', description: 'Four objects thrown upward and one resting on the ground.' },
    ] },
    { key: 'gravity', label: 'Gravitational acceleration', type: 'number', unit: 'm/s2', kind: 'live', group: 'Environment', min: 0, max: 60, step: 0.01, default: 9.81, description: 'Uniform downward acceleration g.', marks: [
      { value: 1.62, label: 'Moon' }, { value: 3.71, label: 'Mars' }, { value: 9.81, label: 'Earth' }, { value: 19.62, label: '2× Earth' }, { value: 24.79, label: 'Jupiter' },
    ] },
    { key: 'airDensity', label: 'Air density', type: 'number', unit: 'kg/m3', kind: 'live', group: 'Environment', min: 0, max: 10, step: 0.005, default: 1.225, description: 'Density of the surrounding gas, which sets aerodynamic drag. 0 is a vacuum.', marks: [
      { value: 0, label: 'Vacuum' }, { value: 0.02, label: 'Mars' }, { value: 1.225, label: 'Earth' }, { value: 2.45, label: '2× Earth' },
    ] },
    { key: 'friction', label: 'Ground friction coefficient μ', type: 'number', unit: '1', kind: 'live', group: 'Environment', min: 0, max: 1.5, step: 0.01, default: 0.4, description: 'Coulomb friction between objects and the ground (sliding and during bounces). 0 is frictionless.' },
    { key: 'gravityPause', label: 'Switch gravity off temporarily', type: 'boolean', kind: 'live', group: 'Gravity interruption', default: false, description: 'Set g to zero for a time window, then restore it.' },
    { key: 'pauseStart', label: 'Gravity off at', type: 'number', unit: 's', kind: 'live', group: 'Gravity interruption', min: 0, max: 60, step: 0.1, default: 1.5, description: 'Simulated time when gravity switches off.', visibleWhen: (p) => bool(p, 'gravityPause') },
    { key: 'pauseDuration', label: 'Gravity off for', type: 'number', unit: 's', kind: 'live', group: 'Gravity interruption', min: 0.1, max: 30, step: 0.1, default: 5, description: 'How long gravity stays off.', visibleWhen: (p) => bool(p, 'gravityPause') },
    { key: 'launchSpeed', label: 'Launch speed', type: 'number', unit: 'm/s', kind: 'spawn', group: 'Launch', min: 0, max: 150, step: 0.5, default: 20, description: 'Initial speed for launched objects (also the push speed for sliding and collision setups).' },
    { key: 'launchAngle', label: 'Launch angle', type: 'number', unit: 'deg', kind: 'spawn', group: 'Launch', min: -90, max: 90, step: 1, default: 45, description: 'Angle above horizontal.', visibleWhen: (p) => str(p, 'setup') === 'projectile' },
    { key: 'launchHeight', label: 'Launch height', type: 'number', unit: 'm', kind: 'spawn', group: 'Launch', min: 0, max: 500, step: 0.5, default: 0, description: 'Height of the launch point above the ground.' },
    { key: 'dropHeight', label: 'Drop height', type: 'number', unit: 'm', kind: 'initial', group: 'Setup', min: 0.5, max: 1000, step: 0.5, default: 50, description: 'Release height for drop, comparison and collision setups.', visibleWhen: (p) => ['compare-mass', 'drop-vs-launch', 'collision'].includes(str(p, 'setup')) },
    { key: 'massRatio', label: 'Mass ratio (right ÷ left)', type: 'number', unit: 'x', kind: 'initial', group: 'Setup', min: 0.1, max: 10, step: 0.1, default: 1, description: 'Mass of the right-hand sphere relative to the left.', visibleWhen: (p) => str(p, 'setup') === 'collision' },
    { key: 'mass', label: 'Object mass', type: 'number', unit: 'kg', kind: 'spawn', group: 'Object', min: 0.001, max: 1000, step: 0.001, default: 1, scale: 'log', description: 'Mass of each new object. In a vacuum mass does not change the trajectory; with air it changes how strongly drag decelerates the object.' },
    { key: 'radius', label: 'Object radius', type: 'number', unit: 'm', kind: 'spawn', group: 'Object', min: 0.01, max: 2, step: 0.01, default: 0.1, description: 'Sphere radius (sets the drag area πr² and collision size).' },
    { key: 'dragCoefficient', label: 'Drag coefficient C_d', type: 'number', unit: '1', kind: 'spawn', group: 'Object', min: 0, max: 2, step: 0.01, default: 0.47, description: 'Shape factor for drag. A smooth sphere is about 0.47 over a wide range of speeds.' },
    { key: 'restitution', label: 'Bounciness (restitution e)', type: 'number', unit: '1', kind: 'spawn', group: 'Object', min: 0, max: 1, step: 0.01, default: 0.6, description: 'Ratio of rebound to impact speed. 1 is perfectly elastic; 0 does not bounce.' },
    { key: 'duration', label: 'Simulation duration', type: 'number', unit: 's', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 300, step: 1, default: 20, description: 'Run length in simulated seconds.' },
    { key: 'dt', label: 'Time step', type: 'number', unit: 's', kind: 'initial', group: 'Numerics', numerics: true, min: 0.0002, max: 0.02, step: 0.0001, default: 0.002, description: 'Fixed integration step. Smaller is more accurate and slower.' },
  ],
  observables: [
    { key: 'h_A', label: 'Height of A', unit: 'm', provenance: 'simulated', chart: true, chartGroup: 'height', description: 'Height of the bottom of object A above the ground.' },
    { key: 'h_B', label: 'Height of B', unit: 'm', provenance: 'simulated', chart: true, chartGroup: 'height' },
    { key: 'h_C', label: 'Height of C', unit: 'm', provenance: 'simulated', chart: false, chartGroup: 'height' },
    { key: 'x_A', label: 'Distance of A', unit: 'm', provenance: 'simulated', chartGroup: 'distance', description: 'Horizontal position of object A.' },
    { key: 'speed_A', label: 'Speed of A', unit: 'm/s', provenance: 'simulated', chart: true, chartGroup: 'speed' },
    { key: 'speed_B', label: 'Speed of B', unit: 'm/s', provenance: 'simulated', chartGroup: 'speed' },
    { key: 'vy_A', label: 'Vertical velocity of A', unit: 'm/s', provenance: 'simulated', chartGroup: 'speed' },
    { key: 'accel_A', label: 'Acceleration of A', unit: 'm/s2', provenance: 'simulated', chartGroup: 'accel', description: 'Magnitude of the net acceleration of object A.' },
    { key: 'g', label: 'Gravity in effect', unit: 'm/s2', provenance: 'assumed', chartGroup: 'accel' },
    { key: 'ke', label: 'Kinetic energy (all)', unit: 'J', provenance: 'simulated', chartGroup: 'energy' },
    { key: 'pe', label: 'Potential energy (all)', unit: 'J', provenance: 'simulated', chartGroup: 'energy', description: 'm·g·h relative to the ground, using the gravity currently in effect.' },
    { key: 'energy', label: 'Mechanical energy (all)', unit: 'J', provenance: 'simulated', chart: true, chartGroup: 'energy' },
    { key: 'dissipated', label: 'Energy dissipated', unit: 'J', provenance: 'simulated', chartGroup: 'energy', description: 'Energy removed by drag, friction and inelastic contacts so far.' },
    { key: 'px', label: 'Horizontal momentum (all)', unit: 'kg*m/s', provenance: 'simulated', chartGroup: 'momentum' },
    { key: 'py', label: 'Vertical momentum (all)', unit: 'kg*m/s', provenance: 'simulated', chartGroup: 'momentum' },
    { key: 'airborne', label: 'Objects in flight', unit: 'count', provenance: 'simulated', readout: true, sig: 2 },
  ],
  primaryObservables: ['h_A', 'speed_A'],
  time: {
    unit: 's',
    dt: (p) => num(p, 'dt'),
    sampleInterval: 0.02,
    defaultDuration: (p) => num(p, 'duration'),
    durationParam: 'duration',
    maxDuration: 300,
    realtimeRate: 1,
  },

  init(p) {
    const s: ProjectileState = { t: 0, bodies: [], nextSlot: 0, dissipated: 0, lastG: effectiveG(p, 0), pending: [], gravityOffReported: false, gravityOnReported: false };
    setupScene(s, p);
    return s;
  },

  step(s, p, h) {
    const g = effectiveG(p, s.t);
    if (g !== s.lastG) {
      // Changing g changes potential energy (m·g·h) without any motion, so the
      // mechanical-energy curve steps at that moment; that is not dissipation.
      if (g === 0 && !s.gravityOffReported && bool(p, 'gravityPause')) {
        s.gravityOffReported = true;
        s.pending.push({ t: s.t, id: 'gravity-off', label: 'Gravity switched off', detail: 'Objects now move in straight lines, slowed only by drag.', severity: 'warning', source: 'model' });
      } else if (g > 0 && s.lastG === 0 && s.gravityOffReported && !s.gravityOnReported) {
        s.gravityOnReported = true;
        s.pending.push({ t: s.t, id: 'gravity-on', label: 'Gravity restored', detail: `g = ${fmt(g)} m/s² again.`, severity: 'warning', source: 'model' });
      }
      s.lastG = g;
      for (const b of s.bodies) if (g <= 0) b.resting = false;
    }
    for (const b of s.bodies) {
      if (b.resting && (g > 0 || (b.vx === 0 && b.vy === 0))) {
        b.ax = 0;
        b.ay = 0;
        continue;
      }
      stepBody(s, p, b, g, h);
    }
    for (let i = 0; i < s.bodies.length; i++) {
      for (let j = i + 1; j < s.bodies.length; j++) collide(s, s.bodies[i], s.bodies[j]);
    }
    for (const b of s.bodies) {
      if (b.resting && (Math.abs(b.vx) > REST_SPEED || b.vy !== 0)) b.resting = false;
      if (!b.airborne && b.vy > 0) b.airborne = true;
    }
    s.t += h;
  },

  observe(s, p) {
    const g = effectiveG(p, s.t);
    const at = (slot: number) => s.bodies.find((b) => b.slot === slot);
    const A = at(0);
    const B = at(1);
    const C = at(2);
    let ke = 0, pe = 0, px = 0, py = 0, airborne = 0;
    for (const b of s.bodies) {
      ke += kinetic(b);
      pe += b.m * g * (b.y - b.r);
      px += b.m * b.vx;
      py += b.m * b.vy;
      if (b.airborne) airborne++;
    }
    return {
      h_A: A ? A.y - A.r : NaN,
      h_B: B ? B.y - B.r : NaN,
      h_C: C ? C.y - C.r : NaN,
      x_A: A ? A.x : NaN,
      speed_A: A ? Math.hypot(A.vx, A.vy) : NaN,
      speed_B: B ? Math.hypot(B.vx, B.vy) : NaN,
      vy_A: A ? A.vy : NaN,
      accel_A: A ? Math.hypot(A.ax, A.ay) : NaN,
      g,
      ke,
      pe,
      energy: ke + pe,
      dissipated: s.dissipated,
      px,
      py,
      airborne,
    };
  },

  clone(s) {
    return { ...s, bodies: s.bodies.map((b) => ({ ...b })), pending: [...s.pending] };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  finished(s, p) {
    if (s.bodies.length === 0) return null;
    const pauseAhead = bool(p, 'gravityPause') && s.t < num(p, 'pauseStart') + num(p, 'pauseDuration');
    if (!pauseAhead && s.bodies.every((b) => b.resting)) return 'All objects have come to rest.';
    return null;
  },

  tracks(s) {
    return s.bodies.map((b) => ({ id: b.id, x: b.x, y: b.y - b.r }));
  },

  actions: [
    { id: 'launch', label: 'Launch', description: 'Launch a new object from the origin using the launch settings.' },
    { id: 'drop', label: 'Drop', description: 'Release a new object at rest from the launch height (or 10 m if the launch height is 0).' },
  ],

  applyAction(s, p, id) {
    if (s.bodies.length >= MAX_BODIES) {
      return { t: s.t, id: `limit-${s.t}`, label: `Object limit reached (${MAX_BODIES})`, detail: 'Reset the experiment to start again.', severity: 'warning' };
    }
    if (id === 'launch') {
      const b = launchFromParams(s, p);
      if (!b) return null;
      return { t: s.t, id: `${b.id}-launched`, label: `Object ${b.label} launched`, detail: `${fmt(num(p, 'launchSpeed'))} m/s at ${fmt(num(p, 'launchAngle'), 0)}° from ${fmt(num(p, 'launchHeight'))} m.`, severity: 'info' };
    }
    if (id === 'drop') {
      const r = num(p, 'radius');
      const h = num(p, 'launchHeight') > 0 ? num(p, 'launchHeight') : 10;
      const b = makeBody(s, { x: 0, y: h + r, vx: 0, vy: 0, m: num(p, 'mass'), r, cd: num(p, 'dragCoefficient'), e: num(p, 'restitution') });
      if (!b) return null;
      return { t: s.t, id: `${b.id}-dropped`, label: `Object ${b.label} dropped`, detail: `Released at rest from ${fmt(h)} m.`, severity: 'info' };
    }
    return null;
  },

  derived(p) {
    const g = num(p, 'gravity');
    const v = num(p, 'launchSpeed');
    const th = (num(p, 'launchAngle') * Math.PI) / 180;
    const h0 = num(p, 'launchHeight');
    const out = [];
    if (g > 0) {
      const vy = v * Math.sin(th);
      const tFlight = (vy + Math.sqrt(vy * vy + 2 * g * h0)) / g;
      out.push(
        { key: 'range0', label: 'Range without air', value: v * Math.cos(th) * tFlight, unit: 'm' as const, formula: 'x = v cosθ · t_f', provenance: 'derived' as const, note: 'Closed-form vacuum result for the launch settings; compare with the simulated range.' },
        { key: 'apex0', label: 'Peak height without air', value: h0 + (vy > 0 ? (vy * vy) / (2 * g) : 0), unit: 'm' as const, formula: 'h = h₀ + (v sinθ)² / 2g', provenance: 'derived' as const },
        { key: 'tf0', label: 'Flight time without air', value: tFlight, unit: 's' as const, formula: 't_f = (v sinθ + √((v sinθ)² + 2gh₀)) / g', provenance: 'derived' as const },
      );
      const rho = num(p, 'airDensity');
      const r = num(p, 'radius');
      const cd = num(p, 'dragCoefficient');
      if (rho > 0 && cd > 0) {
        const vt = Math.sqrt((2 * num(p, 'mass') * g) / (rho * cd * Math.PI * r * r));
        out.push({ key: 'vterm', label: 'Terminal speed', value: vt, unit: 'm/s' as const, formula: 'v_t = √(2mg / ρC_dA)', provenance: 'derived' as const, note: 'Speed at which drag balances gravity for the current object.' });
      }
    }
    return out;
  },

  warnings(p) {
    const w = [];
    if (num(p, 'gravity') === 0) w.push({ id: 'zero-g', message: 'Gravity is zero: objects will not fall, and resting objects stay put.', severity: 'info' as const });
    const r = num(p, 'radius');
    const m = num(p, 'mass');
    const density = m / ((4 / 3) * Math.PI * r ** 3);
    if (density < 1) w.push({ id: 'buoyancy', message: `The object's mean density (${density.toPrecision(2)} kg/m³) is close to or below air's; buoyancy, which this model ignores, would matter.`, severity: 'warning' as const });
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const land = run.events.filter((e) => e.id.endsWith('-land'));
    const hA = run.samples.obs.h_A?.filter((v) => !Number.isNaN(v)) ?? [];
    if (hA.length) out.push({ label: 'Peak height of A', value: Math.max(...hA), unit: 'm', provenance: 'simulated' });
    for (const e of land.slice(0, 3)) out.push({ label: `${e.label.replace(' hit the ground', '')}: first impact`, value: e.t, unit: 's', provenance: 'simulated', note: e.detail });
    out.push({ label: 'Energy dissipated', value: run.final.dissipated, unit: 'J', provenance: 'simulated' });
    out.push({ label: 'Final mechanical energy', value: run.final.energy, unit: 'J', provenance: 'simulated' });
    return out;
  },

  assumptions: [
    { kind: 'established', text: 'Newtonian mechanics: F = ma, with uniform gravity acting straight down.' },
    { kind: 'approximation', text: 'Aerodynamic drag is quadratic in speed, F = ½ρC_dAv², with a constant drag coefficient. Real C_d varies with speed (Reynolds number) and spin.' },
    { kind: 'simplification', text: 'Objects are rigid spheres that slide rather than roll; rotation and spin (Magnus force) are ignored.' },
    { kind: 'simplification', text: 'Air is still (no wind), its density is uniform with height, and buoyancy is neglected.' },
    { kind: 'simplification', text: 'Contacts are instantaneous impulses with a single coefficient of restitution and Coulomb friction.' },
    { kind: 'simplification', text: 'When gravity is switched off, only the objects are affected; the atmosphere and ground are not modelled responding to it.' },
  ],
  limitations: [
    'The ground is flat and infinite; there are no walls or slopes.',
    'Drag area uses the sphere cross-section; feathers, parachutes and tumbling objects are not represented.',
    'At very high speeds (near or above the speed of sound) the drag law used here is not accurate.',
    'Contact resolution is sequential and approximate when several objects touch at once.',
  ],
  equations: [
    { label: 'Equation of motion (in flight)', formula: 'dv/dt = (0, −g) − (ρ C_d A / 2m) |v| v', explanation: 'Gravity pulls down; drag opposes the velocity and grows with speed squared. Mass appears only in the drag term.' },
    { label: 'Vacuum range', formula: 'R = v² sin(2θ) / g', explanation: 'With no air and launch from the ground, range depends only on speed, angle and g.' },
    { label: 'Ground bounce', formula: "v_y' = −e v_y,  Δv_x = −sign(v_x) · min(|v_x|, μ(1+e)|v_y|)", explanation: 'Restitution sets the rebound speed; friction removes horizontal speed during the impact.' },
    { label: 'Sliding friction', formula: 'a_x = −μ g sign(v_x)', explanation: 'A sliding object decelerates at a rate proportional to gravity and the friction coefficient.' },
    { label: 'Collision impulse', formula: 'J = −(1+e)(v_rel·n) / (1/m₁ + 1/m₂)', explanation: 'Equal and opposite impulses along the line of centres conserve momentum.' },
    { label: 'Mechanical energy', formula: 'E = Σ ½mv² + Σ mgh', explanation: 'Constant in a vacuum with perfectly elastic contacts; drag, friction and inelastic bounces remove energy.' },
  ],
  education: {
    objectives: [
      'Predict how gravitational acceleration changes fall time, range and peak height.',
      'Show that mass does not affect motion in a vacuum but does once air resistance acts.',
      'Separate horizontal and vertical motion of a projectile.',
      'Track how energy is converted and dissipated, and how momentum is conserved in collisions.',
    ],
    background: {
      beginner: 'Everything near a planet is pulled toward it. Without air, a heavy ball and a light ball fall together. Air pushes back on moving objects, more strongly the faster they go, and that push matters more for light objects. Change gravity or the air and watch how far and how high things fly.',
      intermediate: 'A projectile’s horizontal and vertical motions are independent in a vacuum: horizontal speed stays constant while gravity changes vertical speed at g metres per second every second. Doubling g halves the range and peak height for the same launch. Drag adds a force opposite the velocity, proportional to v², so heavier objects of the same size (with more inertia) are slowed less.',
      advanced: 'The model integrates m dv/dt = mg − ½ρC_dA|v|v with fourth-order Runge–Kutta at a fixed step. Ground contacts apply a normal impulse with restitution e and a tangential impulse bounded by μ times the normal impulse (Coulomb). Sphere–sphere contacts use the standard impulse J = −(1+e)v_rel·n/(m₁⁻¹+m₂⁻¹), which conserves linear momentum exactly. With ρ = 0 and e = 1 total mechanical energy should be conserved to within integration error, a useful check on the time step.',
    },
    variables: [
      { symbol: 'g', meaning: 'gravitational acceleration', unit: 'm/s²' },
      { symbol: 'v, θ', meaning: 'launch speed and angle above horizontal', unit: 'm/s, °' },
      { symbol: 'ρ', meaning: 'air density', unit: 'kg/m³' },
      { symbol: 'C_d', meaning: 'drag coefficient (shape factor)' },
      { symbol: 'A', meaning: 'cross-sectional area πr²', unit: 'm²' },
      { symbol: 'm', meaning: 'object mass', unit: 'kg' },
      { symbol: 'e', meaning: 'coefficient of restitution' },
      { symbol: 'μ', meaning: 'friction coefficient' },
    ],
    guidedSteps: [
      'Run the default launch and note the range and peak height in the events list.',
      'Set air density to 0 (vacuum) and compare the simulated range with the “Range without air” value.',
      'Double gravity to 19.62 m/s² and predict the new range before running.',
      'Choose “Two masses dropped”, run with air and then in a vacuum. When do the two objects land?',
      'Choose “Head-on collision” and watch total horizontal momentum on the chart through the impact.',
    ],
    questions: [
      'Why does the launch angle for maximum range drop below 45° when air resistance is present?',
      'If gravity doubled, what would happen to the time a ball spends in the air?',
      'Where does the energy go when a ball bounces lower each time?',
    ],
  },
};
