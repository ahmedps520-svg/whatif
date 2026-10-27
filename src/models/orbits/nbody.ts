/**
 * Newtonian point-mass N-body core shared by the orbital-mechanics models.
 *
 * Integrator: kick–drift–kick leapfrog (velocity Verlet), which is symplectic
 * and time-reversible for a fixed step, so energy errors oscillate instead of
 * drifting. Each engine step is split into sub-steps whose length adapts to the
 * closest, fastest pair:
 *
 *   h = min(engine dt, η · min over pairs of { √(r³ / G(mᵢ+mⱼ)), r / |v_rel| })
 *
 * The first term is the pair's dynamical (free-fall) time, the second the time
 * to cross its own separation — the limit that matters for fast close
 * encounters. Strictly, a variable step breaks exact symplecticity; the energy
 * error is therefore reported as an observable in every model so the user can
 * see the numerical accuracy for themselves.
 *
 * Everything is SI (m, kg, s). The implementation keeps per-sub-step work free
 * of object allocation: accelerations live in a module-level scratch buffer and
 * bodies store position/velocity in small fixed arrays.
 */
import { G } from './constants';

export type Vec3 = [number, number, number];

export interface Body {
  id: string;
  label: string;
  /** Fixed categorical colour slot (palette SERIES index); −1 for a star. */
  slot: number;
  /** kg */
  mass: number;
  /** m — used for collisions and display. */
  radius: number;
  /** m, in the simulation (inertial) frame. */
  pos: Vec3;
  /** m/s, in the simulation frame. */
  vel: Vec3;
  alive: boolean;
  /** Set when the body merged into another one. */
  mergedInto?: string;
  /** Set when the body was removed by the scenario (e.g. "the Moon vanishes"). */
  removed?: boolean;
  /** In a merger the body with the higher priority survives (ties: the more massive one). */
  priority?: number;
}

export interface CollisionRecord {
  /** Simulation time, s. */
  t: number;
  survivorId: string;
  impactorId: string;
  impactorMass: number;
  /** Relative speed at contact, m/s. */
  relSpeed: number;
  /** Kinetic energy of the relative motion, ½μv², J — the energy released in a perfectly inelastic merger. */
  energy: number;
  /** Impactor position and velocity relative to the survivor at contact (m, m/s). */
  rel: Vec3;
  vrel: Vec3;
}

export interface NBodyState {
  bodies: Body[];
  /** Simulation time, s. */
  t: number;
  /** Reference energy (J) at t = 0, re-based when the scenario deliberately adds or removes energy. */
  E0: number;
  /** Normalisation for the relative energy error (J). */
  Escale: number;
  /** Energy removed by perfectly inelastic mergers, J (so E + dissipated stays ≈ E0). */
  dissipated: number;
  /** Total sub-steps taken. */
  substeps: number;
  /** Number of engine steps in which the sub-step cap was reached. */
  capHits: number;
  /** True once a cap warning has been reported (models emit it once). */
  capWarned: boolean;
  /** Collisions not yet reported by the model (drained by the model). */
  collisions: CollisionRecord[];
}

export interface AdvanceOptions {
  /** Accuracy parameter η (fraction of the shortest pair timescale). */
  eta: number;
  /** Hard cap on sub-steps per call; the remainder is then taken in one step. */
  maxSubsteps?: number;
  /** Called after every sub-step (for precise event detection). Must not allocate heavily. */
  onSubstep?: (sys: NBodyState, h: number) => void;
}

export interface AdvanceResult {
  substeps: number;
  /** True when the sub-step cap was hit and accuracy was sacrificed to finish the step. */
  capped: boolean;
}

export const DEFAULT_MAX_SUBSTEPS = 50000;

// ---------------------------------------------------------------------------
// Construction

export function makeBody(init: Omit<Body, 'alive' | 'pos' | 'vel'> & { pos: number[]; vel: number[] }): Body {
  return {
    ...init,
    pos: [init.pos[0] ?? 0, init.pos[1] ?? 0, init.pos[2] ?? 0],
    vel: [init.vel[0] ?? 0, init.vel[1] ?? 0, init.vel[2] ?? 0],
    alive: true,
  };
}

export function createSystem(bodies: Body[]): NBodyState {
  const sys: NBodyState = { bodies, t: 0, E0: 0, Escale: 1, dissipated: 0, substeps: 0, capHits: 0, capWarned: false, collisions: [] };
  resetEnergyReference(sys);
  return sys;
}

/** Set the energy reference to the current state (call after all t = 0 changes). */
export function resetEnergyReference(sys: NBodyState) {
  const K = kineticEnergy(sys);
  const U = potentialEnergy(sys);
  sys.E0 = K + U;
  sys.dissipated = 0;
  // Relative to |E₀|, or to 1 % of |K| + |U| when E₀ is close to zero (near-parabolic systems).
  sys.Escale = Math.max(Math.abs(K + U), 0.01 * (Math.abs(K) + Math.abs(U)), 1e-300);
}

export function cloneSystem(sys: NBodyState): NBodyState {
  return {
    ...sys,
    bodies: sys.bodies.map((b) => ({ ...b, pos: [b.pos[0], b.pos[1], b.pos[2]], vel: [b.vel[0], b.vel[1], b.vel[2]] })),
    collisions: sys.collisions.map((c) => ({ ...c, rel: [c.rel[0], c.rel[1], c.rel[2]], vrel: [c.vrel[0], c.vrel[1], c.vrel[2]] })),
  };
}

export function findBody(sys: NBodyState, id: string): Body | undefined {
  for (const b of sys.bodies) if (b.id === id) return b;
  return undefined;
}

// ---------------------------------------------------------------------------
// Conserved quantities

export function kineticEnergy(sys: NBodyState): number {
  let k = 0;
  for (const b of sys.bodies) {
    if (!b.alive) continue;
    k += 0.5 * b.mass * (b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1] + b.vel[2] * b.vel[2]);
  }
  return k;
}

export function potentialEnergy(sys: NBodyState): number {
  const bs = sys.bodies;
  let u = 0;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (!a.alive || a.mass === 0) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j];
      if (!b.alive || b.mass === 0) continue;
      const dx = b.pos[0] - a.pos[0];
      const dy = b.pos[1] - a.pos[1];
      const dz = b.pos[2] - a.pos[2];
      u -= (G * a.mass * b.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return u;
}

export function totalEnergy(sys: NBodyState): number {
  return kineticEnergy(sys) + potentialEnergy(sys);
}

/** (E + E_dissipated − E₀) / E_scale: the integrator's relative energy error. */
export function energyError(sys: NBodyState): number {
  return (totalEnergy(sys) + sys.dissipated - sys.E0) / sys.Escale;
}

/** Total linear momentum (kg·m/s), written into `out`. */
export function momentum(sys: NBodyState, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = out[1] = out[2] = 0;
  for (const b of sys.bodies) {
    if (!b.alive) continue;
    out[0] += b.mass * b.vel[0];
    out[1] += b.mass * b.vel[1];
    out[2] += b.mass * b.vel[2];
  }
  return out;
}

/** Total angular momentum about the frame origin (kg·m²/s), written into `out`. */
export function angularMomentum(sys: NBodyState, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = out[1] = out[2] = 0;
  for (const b of sys.bodies) {
    if (!b.alive) continue;
    const [x, y, z] = b.pos;
    const [vx, vy, vz] = b.vel;
    out[0] += b.mass * (y * vz - z * vy);
    out[1] += b.mass * (z * vx - x * vz);
    out[2] += b.mass * (x * vy - y * vx);
  }
  return out;
}

export function angularMomentumMagnitude(sys: NBodyState): number {
  const L = angularMomentum(sys);
  return Math.hypot(L[0], L[1], L[2]);
}

/** Centre of mass position and velocity of the living bodies. */
export function centreOfMass(sys: NBodyState, pos: Vec3 = [0, 0, 0], vel: Vec3 = [0, 0, 0]): { mass: number; pos: Vec3; vel: Vec3 } {
  let m = 0;
  pos[0] = pos[1] = pos[2] = 0;
  vel[0] = vel[1] = vel[2] = 0;
  for (const b of sys.bodies) {
    if (!b.alive) continue;
    m += b.mass;
    for (let k = 0; k < 3; k++) {
      pos[k] += b.mass * b.pos[k];
      vel[k] += b.mass * b.vel[k];
    }
  }
  if (m > 0) for (let k = 0; k < 3; k++) {
    pos[k] /= m;
    vel[k] /= m;
  }
  return { mass: m, pos, vel };
}

/**
 * Galilean change of frame: put the centre of mass at rest at the origin.
 * Relative motions (and therefore all the physics) are unchanged.
 */
export function toBarycentricFrame(sys: NBodyState) {
  const c = centreOfMass(sys);
  if (c.mass <= 0) return;
  for (const b of sys.bodies) {
    for (let k = 0; k < 3; k++) {
      b.pos[k] -= c.pos[k];
      b.vel[k] -= c.vel[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Integration

let ACC = new Float64Array(3 * 8);

function ensureScratch(n: number) {
  if (ACC.length < 3 * n) ACC = new Float64Array(3 * Math.max(n, 2 * (ACC.length / 3)));
}

function computeAccelerations(bodies: Body[]) {
  const n = bodies.length;
  ACC.fill(0, 0, 3 * n);
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    if (!a.alive) continue;
    const ap = a.pos;
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      if (!b.alive) continue;
      const bp = b.pos;
      const dx = bp[0] - ap[0];
      const dy = bp[1] - ap[1];
      const dz = bp[2] - ap[2];
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 === 0) continue;
      const inv = 1 / (r2 * Math.sqrt(r2));
      const fa = G * b.mass * inv;
      const fb = G * a.mass * inv;
      ACC[3 * i] += fa * dx;
      ACC[3 * i + 1] += fa * dy;
      ACC[3 * i + 2] += fa * dz;
      ACC[3 * j] -= fb * dx;
      ACC[3 * j + 1] -= fb * dy;
      ACC[3 * j + 2] -= fb * dz;
    }
  }
}

/** Shortest pair timescale min(√(r³/GΣm), r/|v_rel|) in seconds (Infinity for a single body). */
export function shortestTimescale(sys: NBodyState): number {
  const bs = sys.bodies;
  let tmin = Infinity;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j];
      if (!b.alive) continue;
      const dx = b.pos[0] - a.pos[0];
      const dy = b.pos[1] - a.pos[1];
      const dz = b.pos[2] - a.pos[2];
      const r2 = dx * dx + dy * dy + dz * dz;
      const r = Math.sqrt(r2);
      const msum = a.mass + b.mass;
      if (msum > 0) {
        const tdyn = Math.sqrt((r2 * r) / (G * msum));
        if (tdyn < tmin) tmin = tdyn;
      }
      const dvx = b.vel[0] - a.vel[0];
      const dvy = b.vel[1] - a.vel[1];
      const dvz = b.vel[2] - a.vel[2];
      const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
      if (v2 > 0) {
        const tcross = r / Math.sqrt(v2);
        if (tcross < tmin) tmin = tcross;
      }
    }
  }
  return tmin;
}

/** Merge every overlapping pair (distance < rᵢ + rⱼ). Returns true if anything merged. */
function resolveCollisions(sys: NBodyState): boolean {
  const bs = sys.bodies;
  let merged = false;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j];
      if (!b.alive || !a.alive) continue;
      const dx = b.pos[0] - a.pos[0];
      const dy = b.pos[1] - a.pos[1];
      const dz = b.pos[2] - a.pos[2];
      const rs = a.radius + b.radius;
      if (dx * dx + dy * dy + dz * dz < rs * rs) {
        mergeBodies(sys, a, b);
        merged = true;
      }
    }
  }
  return merged;
}

/**
 * Perfectly inelastic merger: the more massive body absorbs the other.
 * Mass and linear momentum are conserved exactly; the survivor moves to the
 * pair's centre of mass and its radius grows so that volume is conserved.
 * The kinetic energy of the relative motion (½μv²) is removed as heat; the
 * exact energy change is booked in `dissipated` so the energy-error
 * diagnostic keeps measuring only the integrator's error.
 */
export function mergeBodies(sys: NBodyState, a: Body, b: Body) {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  const survivor = pa !== pb ? (pa > pb ? a : b) : a.mass >= b.mass ? a : b;
  const impactor = survivor === a ? b : a;
  const Ebefore = totalEnergy(sys);
  const rel: Vec3 = [impactor.pos[0] - survivor.pos[0], impactor.pos[1] - survivor.pos[1], impactor.pos[2] - survivor.pos[2]];
  const vrel: Vec3 = [impactor.vel[0] - survivor.vel[0], impactor.vel[1] - survivor.vel[1], impactor.vel[2] - survivor.vel[2]];
  const M = a.mass + b.mass;
  const mu = M > 0 ? (a.mass * b.mass) / M : 0;
  const v2 = vrel[0] * vrel[0] + vrel[1] * vrel[1] + vrel[2] * vrel[2];
  if (M > 0) {
    for (let k = 0; k < 3; k++) {
      survivor.pos[k] = (a.mass * a.pos[k] + b.mass * b.pos[k]) / M;
      survivor.vel[k] = (a.mass * a.vel[k] + b.mass * b.vel[k]) / M;
    }
  }
  survivor.radius = Math.cbrt(a.radius ** 3 + b.radius ** 3);
  const impactorMass = impactor.mass;
  survivor.mass = M;
  impactor.alive = false;
  impactor.mergedInto = survivor.id;
  const Eafter = totalEnergy(sys);
  sys.dissipated += Ebefore - Eafter;
  sys.collisions.push({
    t: sys.t,
    survivorId: survivor.id,
    impactorId: impactor.id,
    impactorMass,
    relSpeed: Math.sqrt(v2),
    energy: 0.5 * mu * v2,
    rel,
    vrel,
  });
}

/**
 * Remove a body from the system (scenario event, e.g. "the Moon vanishes").
 * The other bodies keep their positions and velocities. The energy reference is
 * re-based so the energy-error diagnostic is unaffected by the deliberate change.
 */
export function removeBody(sys: NBodyState, id: string): Body | undefined {
  const b = findBody(sys, id);
  if (!b || !b.alive) return undefined;
  const before = totalEnergy(sys);
  b.alive = false;
  b.removed = true;
  const after = totalEnergy(sys);
  sys.E0 += after - before;
  return b;
}

/**
 * Advance the system by dt seconds with adaptive kick–drift–kick leapfrog.
 * Collisions are checked after every drift.
 */
export function advance(sys: NBodyState, dt: number, opts: AdvanceOptions): AdvanceResult {
  const bodies = sys.bodies;
  const n = bodies.length;
  ensureScratch(n);
  const eta = opts.eta;
  const cap = opts.maxSubsteps ?? DEFAULT_MAX_SUBSTEPS;
  let remaining = dt;
  let count = 0;
  let capped = false;
  computeAccelerations(bodies);
  while (remaining > 0) {
    let h: number;
    if (count >= cap) {
      h = remaining;
      capped = true;
    } else {
      const hc = eta * shortestTimescale(sys);
      h = remaining <= hc ? remaining : remaining / Math.ceil(remaining / hc);
      if (!(h > 0)) h = remaining;
    }
    const half = 0.5 * h;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.alive) continue;
      b.vel[0] += half * ACC[3 * i];
      b.vel[1] += half * ACC[3 * i + 1];
      b.vel[2] += half * ACC[3 * i + 2];
      b.pos[0] += h * b.vel[0];
      b.pos[1] += h * b.vel[1];
      b.pos[2] += h * b.vel[2];
    }
    computeAccelerations(bodies);
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.alive) continue;
      b.vel[0] += half * ACC[3 * i];
      b.vel[1] += half * ACC[3 * i + 1];
      b.vel[2] += half * ACC[3 * i + 2];
    }
    sys.t += h;
    remaining = h === remaining ? 0 : remaining - h;
    count++;
    if (resolveCollisions(sys)) computeAccelerations(bodies);
    opts.onSubstep?.(sys, h);
  }
  sys.substeps += count;
  if (capped) sys.capHits++;
  return { substeps: count, capped };
}

// ---------------------------------------------------------------------------
// Two-body relative motion

export interface Elements {
  /** Separation, m. */
  r: number;
  /** Relative speed, m/s. */
  v: number;
  /** Radial velocity dr/dt, m/s (negative = approaching). */
  rdot: number;
  /** Gravitational parameter G(m₁+m₂), m³/s². */
  mu: number;
  /** Specific orbital energy v²/2 − μ/r, J/kg. */
  energy: number;
  /** Specific angular momentum |r × v|, m²/s. */
  h: number;
  /** Semi-major axis, m (negative for hyperbolic, ±Infinity for parabolic). */
  a: number;
  /** Eccentricity. */
  e: number;
  /** Periapsis distance h²/(μ(1+e)), m. */
  rp: number;
  /** Apoapsis distance, m (Infinity when unbound). */
  ra: number;
  /** Polar angle of the relative position in the x–y plane, rad. */
  theta: number;
  bound: boolean;
}

/** Osculating two-body elements of `body` relative to `primary`. */
export function osculating(body: Body, primary: Body): Elements {
  const rx = body.pos[0] - primary.pos[0];
  const ry = body.pos[1] - primary.pos[1];
  const rz = body.pos[2] - primary.pos[2];
  const vx = body.vel[0] - primary.vel[0];
  const vy = body.vel[1] - primary.vel[1];
  const vz = body.vel[2] - primary.vel[2];
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  const mu = G * (body.mass + primary.mass);
  const rdot = r > 0 ? (rx * vx + ry * vy + rz * vz) / r : 0;
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h2 = hx * hx + hy * hy + hz * hz;
  const energy = 0.5 * v2 - (r > 0 ? mu / r : 0);
  let e = NaN;
  let a = NaN;
  let rp = NaN;
  let ra = NaN;
  if (mu > 0 && r > 0) {
    // e² = 1 + 2εh²/μ² (clamped against round-off for circular orbits).
    e = Math.sqrt(Math.max(0, 1 + (2 * energy * h2) / (mu * mu)));
    a = energy !== 0 ? -mu / (2 * energy) : Infinity;
    rp = h2 / (mu * (1 + e));
    // r_p + r_a = 2a for bound orbits (also valid for the radial e = 1 case).
    ra = energy < 0 ? 2 * a - rp : Infinity;
  }
  return {
    r,
    v: Math.sqrt(v2),
    rdot,
    mu,
    energy,
    h: Math.sqrt(h2),
    a,
    e,
    rp,
    ra,
    theta: Math.atan2(ry, rx),
    bound: energy < 0,
  };
}

/** Minimal relative state, written into a caller-owned object (no allocation). */
export interface RelState {
  r: number;
  v: number;
  rdot: number;
  /** Specific orbital energy for μ = G(m₁+m₂), J/kg. */
  energy: number;
  theta: number;
}

export function newRelState(): RelState {
  return { r: 0, v: 0, rdot: 0, energy: 0, theta: 0 };
}

export function relativeState(body: Body, primary: Body, out: RelState): RelState {
  const rx = body.pos[0] - primary.pos[0];
  const ry = body.pos[1] - primary.pos[1];
  const rz = body.pos[2] - primary.pos[2];
  const vx = body.vel[0] - primary.vel[0];
  const vy = body.vel[1] - primary.vel[1];
  const vz = body.vel[2] - primary.vel[2];
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  out.r = r;
  out.v = Math.sqrt(v2);
  out.rdot = r > 0 ? (rx * vx + ry * vy + rz * vz) / r : 0;
  out.energy = 0.5 * v2 - (r > 0 ? (G * (body.mass + primary.mass)) / r : 0);
  out.theta = Math.atan2(ry, rx);
  return out;
}

/** Distance between two bodies, m. */
export function separation(a: Body, b: Body): number {
  return Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
}

/** Relative speed of two bodies, m/s. */
export function relativeSpeed(a: Body, b: Body): number {
  return Math.hypot(b.vel[0] - a.vel[0], b.vel[1] - a.vel[1], b.vel[2] - a.vel[2]);
}

// ---------------------------------------------------------------------------
// Closed-form two-body helpers (used for `derived` predictions and tests)

export interface ConicPrediction {
  a: number;
  e: number;
  rp: number;
  ra: number;
  energy: number;
  /** Orbital period, s (NaN when unbound). */
  period: number;
  bound: boolean;
}

/**
 * Conic from vis-viva for a body at distance r moving at speed v with flight-path
 * angle 0 (velocity perpendicular to the radius) around gravitational parameter μ.
 */
export function conicFromTangential(mu: number, r: number, v: number): ConicPrediction {
  const energy = 0.5 * v * v - mu / r;
  const h = r * v;
  const e = mu > 0 ? Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu))) : NaN;
  const a = energy !== 0 ? -mu / (2 * energy) : Infinity;
  const rp = mu > 0 ? (h * h) / (mu * (1 + e)) : r;
  const bound = energy < 0;
  const ra = bound ? 2 * a - rp : Infinity;
  return { a, e, rp, ra, energy, period: bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : NaN, bound };
}

/** Kepler's third law: T = 2π √(a³/μ). */
export function keplerPeriod(mu: number, a: number): number {
  return a > 0 && mu > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : NaN;
}

/**
 * Relative position and velocity of a body approaching a primary on a hyperbola
 * with speed at infinity v∞ and impact parameter b (the miss distance the body
 * would have without gravity), placed at distance D on the incoming branch.
 * The incoming asymptote points along +x (the body comes from −x, offset by −b
 * in y) and the motion is counter-clockwise about +z. μ = G(m₁ + m₂).
 */
export function hyperbolicApproach(mu: number, vInf: number, b: number, D: number): { pos: Vec3; vel: Vec3 } {
  const v = Math.sqrt(vInf * vInf + (2 * mu) / D);
  if (b <= 1e-9 * D) return { pos: [-D, 0, 0], vel: [v, 0, 0] };
  const h = b * vInf;
  const k = mu > 0 ? (h * vInf) / mu : Infinity; // = b v∞² / μ
  if (!(k < 1e8)) {
    // Gravity negligible: straight line.
    const x = Math.sqrt(Math.max(D * D - b * b, 0));
    return { pos: [-x, -b, 0], vel: [vInf, 0, 0] };
  }
  const e = Math.sqrt(1 + k * k);
  const p = (h * h) / mu;
  const cosf = Math.max(-1, Math.min(1, (p / D - 1) / e));
  const fAnom = -Math.acos(cosf); // incoming branch
  const fInf = Math.acos(-1 / e);
  const omega = Math.PI + fInf; // so the incoming asymptote direction is −x
  const th = omega + fAnom;
  const r = p / (1 + e * Math.cos(fAnom));
  const vr = (mu / h) * e * Math.sin(fAnom);
  const vt = (mu / h) * (1 + e * Math.cos(fAnom));
  const c = Math.cos(th);
  const s = Math.sin(th);
  return { pos: [r * c, r * s, 0], vel: [vr * c - vt * s, vr * s + vt * c, 0] };
}

/** Closed-form hyperbolic flyby quantities for speed at infinity v∞ and impact parameter b. */
export function hyperbolicFlyby(mu: number, vInf: number, b: number) {
  const v2 = vInf * vInf;
  // r_p = (√(μ² + b²v∞⁴) − μ) / v∞²  (well-behaved as μ → 0, where r_p → b)
  const rp = (Math.sqrt(mu * mu + b * b * v2 * v2) - mu) / v2;
  const e = mu > 0 ? Math.sqrt(1 + ((b * v2) / mu) ** 2) : Infinity;
  const deflection = Number.isFinite(e) ? 2 * Math.asin(1 / e) : 0;
  const vp = Math.sqrt(v2 + (rp > 0 ? (2 * mu) / rp : 0));
  return { rp, e, deflection, vp };
}
