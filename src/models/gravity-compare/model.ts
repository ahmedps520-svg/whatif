import type {
  DerivedQuantity,
  KeyResult,
  ObservableDef,
  ParamValues,
  Provenance,
  RunRecord,
  SimEvent,
  SimulationModel,
  Warning,
} from '../../engine/types';
import { formatNumber, type UnitId } from '../../engine/units';
import { bool, num, str } from '../../engine/validation';

/**
 * "What if Earth's gravity doubled?" — two worlds side by side.
 *
 * A BASELINE world (g₀) and an EXPERIMENTAL world (g = k·g₀) are stepped
 * together inside one state with the same fixed-step RK4 integrator, so every
 * comparison is produced by the same calculation. Each world contains:
 *   1. a ball dropped from rest from height h (optional quadratic drag),
 *   2. the same ball thrown from the ground at speed v and angle θ,
 *   3. a person doing a standing vertical jump (constant leg force over a
 *      push-off distance d, calibrated on the baseline world),
 *   4. apparent-weight quantities (weight, bathroom-scale reading, hydrostatic
 *      blood-pressure difference) computed from g.
 * Orbital consequences are closed-form (vis-viva) results from `derived(p)` and
 * `orbitalConsequences(p)`; they are not time-stepped here.
 */

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Earth's gravitational parameter GM⊕, m³/s² (IERS Conventions 2010). */
export const GM_EARTH = 3.986004418e14;
/** Moon/Earth mass ratio (IAU 2009 system of astronomical constants). */
export const MOON_EARTH_MASS_RATIO = 0.0123000371;
/** Sun's gravitational parameter GM☉, m³/s² (IAU 2015 nominal). */
export const GM_SUN = 1.32712440018e20;
/** Earth mean radius, m. */
export const R_EARTH = 6.371e6;
/** Moon mean radius, m. */
export const R_MOON = 1.7374e6;
/** Earth–Moon mean distance, m (treated as a circular orbit). */
export const MOON_DISTANCE = 3.844e8;
/** Astronomical unit, m (exact by definition; Earth's orbit treated as circular). */
export const AU = 1.495978707e11;
/** Density of whole blood, kg/m³ (typical value). */
export const RHO_BLOOD = 1060;
/** Pascals per millimetre of mercury. */
export const PA_PER_MMHG = 133.322;
/** Roche's coefficient for a fluid satellite: d ≈ 2.44 R_s (ρ_p/ρ_s)^(1/3). */
export const ROCHE_FLUID = 2.44;

const MAX_DURATION = 300;
/** Below this net upward acceleration (relative to g₀) the jumper is treated as unable to push off. */
const JUMP_TOL = 1e-9;

export type WorldKey = 'base' | 'exp';
export type Interpretation = 'mass' | 'G' | 'local';

export const INTERPRETATIONS: Record<Interpretation, { label: string; short: string; explanation: string }> = {
  mass: {
    label: "Earth's mass changes by the factor k (radius unchanged)",
    short: 'Earth’s mass × k',
    explanation:
      'Surface gravity g = GM/R² scales with M, so g → k·g at the same radius. The Moon and satellites keep the speed they had at the moment of the change, which is now wrong for a circular orbit: they follow new ellipses (or escape) computed with the vis-viva equation. Earth’s orbit around the Sun is affected only through Earth’s own (tiny) contribution to the Sun–Earth gravitational parameter.',
  },
  G: {
    label: 'The gravitational constant G changes by the factor k',
    short: 'G × k',
    explanation:
      'Every gravitational attraction scales by k: Earth’s pull on the Moon and satellites and also the Sun’s pull on Earth. All three orbits are recomputed with the vis-viva equation. Changing G would also change the structure and luminosity of the Sun and of Earth itself; those effects are speculative here and are not modelled (the Sun’s luminosity is held fixed).',
  },
  local: {
    label: 'Local surface field only (orbits unchanged)',
    short: 'Surface field only',
    explanation:
      'Only the gravitational field at the ground changes; orbits are left exactly as they are. This is not physically consistent — by Gauss’s law the field at the surface is set by the enclosed mass (g = GM/R²), so the same change would reach the Moon — but it is useful for isolating surface mechanics from orbital consequences.',
  },
};

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  flying: boolean;
  apexReached: boolean;
  apexX: number;
  apexY: number;
  apexT: number;
  landT: number;
  landX: number;
  landSpeed: number;
}

export type JumpPhase = 'push' | 'flight' | 'landed' | 'stuck';

export interface Jumper {
  /** Centre-of-mass height relative to the standing (take-off) position, m. Starts at −d (crouched). */
  z: number;
  vz: number;
  phase: JumpPhase;
  takeoffT: number;
  takeoffV: number;
  apexReached: boolean;
  apexZ: number;
  apexT: number;
  landT: number;
}

export interface World {
  key: WorldKey;
  /** Gravitational acceleration in this world, m/s². */
  g: number;
  /** Air density used for drag in this world, kg/m³ (0 when drag is off). */
  rho: number;
  /** Drag constant ρC_dA/(2m), 1/m (0 when drag is off). */
  kd: number;
  /** Calibrated specific leg force F/m (identical in both worlds), m/s². */
  fm: number;
  drop: Ball;
  proj: Ball;
  jump: Jumper;
  complete: boolean;
  completeT: number;
}

export interface GravityState {
  t: number;
  base: World;
  exp: World;
  pending: SimEvent[];
  allComplete: boolean;
}

/* ------------------------------------------------------------------------ */
/* Closed-form predictions                                                   */
/* ------------------------------------------------------------------------ */

export interface WorldPrediction {
  g: number;
  rho: number;
  kd: number;
  /** Vacuum results (NaN when g = 0: the object never lands). */
  dropTime: number;
  dropSpeed: number;
  range: number;
  apex: number;
  flightTime: number;
  /** Jump: F/m − g. */
  jumpNetAccel: number;
  canJump: boolean;
  jumpTakeoffSpeed: number;
  jumpApex: number;
  jumpPushTime: number;
  jumpFlightTime: number;
  /** Apparent weight. */
  weight: number;
  scaleReading: number;
  bloodDp: number;
  /** Terminal speed of the ball (NaN without drag or without gravity). */
  terminalSpeed: number;
}

export interface Predictions {
  k: number;
  g0: number;
  /** F/m = g₀ + v₀²/(2d), v₀ = √(2 g₀ h₀). */
  specificLegForce: number;
  legForce: number;
  /** Gravity factor at which F/m = g (jumping becomes impossible). */
  kCrit: number;
  base: WorldPrediction;
  exp: WorldPrediction;
}

function dragOn(p: ParamValues): boolean {
  return bool(p, 'drag');
}

function dragConstant(p: ParamValues, rho: number): number {
  if (!dragOn(p) || !(rho > 0)) return 0;
  const cd = num(p, 'dragCoefficient');
  const r = num(p, 'ballRadius');
  const m = num(p, 'ballMass');
  if (!(cd > 0) || !(m > 0)) return 0;
  return (rho * cd * Math.PI * r * r) / (2 * m);
}

export function specificLegForce(p: ParamValues): number {
  const g0 = num(p, 'g0');
  const d = num(p, 'pushDistance');
  const h0 = num(p, 'jumpHeight0');
  const v0 = Math.sqrt(2 * g0 * h0);
  return g0 + (v0 * v0) / (2 * d);
}

function worldPrediction(p: ParamValues, g: number, rho: number, fm: number): WorldPrediction {
  const h = num(p, 'dropHeight');
  const v = num(p, 'launchSpeed');
  const th = (num(p, 'launchAngle') * Math.PI) / 180;
  const d = num(p, 'pushDistance');
  const m = num(p, 'bodyMass');
  const g0 = num(p, 'g0');
  const vx = v * Math.cos(th);
  const vy = v * Math.sin(th);
  const pos = g > 0;
  const aNet = fm - g;
  const canJump = aNet > JUMP_TOL * g0;
  const vTake = canJump ? Math.sqrt(2 * d * aNet) : 0;
  const kd = dragConstant(p, rho);
  return {
    g,
    rho,
    kd,
    dropTime: pos ? Math.sqrt((2 * h) / g) : NaN,
    dropSpeed: pos ? Math.sqrt(2 * g * h) : NaN,
    range: pos ? (2 * vx * vy) / g : NaN,
    apex: pos ? (vy * vy) / (2 * g) : NaN,
    flightTime: pos ? (2 * vy) / g : NaN,
    jumpNetAccel: aNet,
    canJump,
    jumpTakeoffSpeed: vTake,
    jumpApex: canJump ? (pos ? (vTake * vTake) / (2 * g) : NaN) : 0,
    jumpPushTime: canJump ? Math.sqrt((2 * d) / aNet) : NaN,
    jumpFlightTime: canJump ? (pos ? (2 * vTake) / g : NaN) : 0,
    weight: m * g,
    scaleReading: (m * g) / g0,
    bloodDp: (RHO_BLOOD * g * num(p, 'bloodColumn')) / PA_PER_MMHG,
    terminalSpeed: kd > 0 && pos ? Math.sqrt(g / kd) : NaN,
  };
}

/** Closed-form (vacuum) predictions for both worlds, computed from the parameters only. */
export function predictions(p: ParamValues): Predictions {
  const g0 = num(p, 'g0');
  const k = num(p, 'factor');
  const fm = specificLegForce(p);
  const rho = dragOn(p) ? num(p, 'airDensity') : 0;
  const rhoExp = rho * (bool(p, 'airScales') ? k : 1);
  return {
    k,
    g0,
    specificLegForce: fm,
    legForce: num(p, 'bodyMass') * fm,
    kCrit: fm / g0,
    base: worldPrediction(p, g0, rho, fm),
    exp: worldPrediction(p, k * g0, rhoExp, fm),
  };
}

/** Upper estimate of the time a world needs to finish all scenes (NaN if it never will). */
function worldTimeBound(w: WorldPrediction, h: number): number {
  if (!(w.g > 0)) return NaN;
  let tDrop = w.dropTime;
  let tProj = w.flightTime;
  if (w.kd > 0 && w.terminalSpeed > 0) {
    const vt = w.terminalSpeed;
    // 1D bound from x(t) ≥ v_t t − (v_t²/g) ln 2; the 2D throw gets a generous margin.
    tDrop = Math.max(tDrop, h / vt + (vt / w.g) * Math.LN2);
    tProj = 2 * tProj + w.apex / vt + (vt / w.g) * Math.LN2;
  }
  const tJump = w.canJump ? w.jumpPushTime + w.jumpFlightTime : 0;
  return Math.max(tDrop, tProj, tJump);
}

/** Run length: long enough for both worlds to finish (the run stops earlier when they do). */
export function runDuration(p: ParamValues): number {
  const pr = predictions(p);
  const h = num(p, 'dropHeight');
  const tb = worldTimeBound(pr.base, h);
  const te = worldTimeBound(pr.exp, h);
  let t = 0;
  for (const x of [tb, te]) if (Number.isFinite(x)) t = Math.max(t, x);
  if (!Number.isFinite(tb) || !Number.isFinite(te)) t = Math.max(t, 15);
  return Math.min(MAX_DURATION, Math.max(2, 1.5 * t + 1));
}

function sampleInterval(p: ParamValues): number {
  const raw = runDuration(p) / 1500;
  return Math.min(0.2, Math.max(0.005, Math.ceil(raw / 0.005) * 0.005));
}

/* ------------------------------------------------------------------------ */
/* Orbits (closed form)                                                      */
/* ------------------------------------------------------------------------ */

export interface OrbitChange {
  /** Radius at the moment of the change (the old circular orbit), m. */
  r: number;
  /** Ratio of gravitational parameters μ′/μ. */
  q: number;
  muOld: number;
  muNew: number;
  /** Speed at the moment of the change (the old circular speed), m/s. */
  vStart: number;
  /** Speed a circular orbit at r would need after the change, m/s. */
  vCircNew: number;
  /** Escape speed at r after the change, m/s. */
  vEscNew: number;
  bound: boolean;
  /** Eccentricity |1 − 1/q| (NaN when q = 0: straight-line motion). */
  e: number;
  /** Semi-major axis q r/(2q − 1), m (NaN when unbound). */
  a: number;
  /** Semi-latus rectum r/q, m. */
  semiLatus: number;
  periapsis: number;
  /** NaN when unbound. */
  apoapsis: number;
  periodOld: number;
  /** NaN when unbound. */
  periodNew: number;
  /** Where on the new orbit the body is at the moment of the change. */
  startAt: 'circular' | 'apoapsis' | 'periapsis';
}

/**
 * A body on a circular orbit of radius r (speed √(μ/r), velocity perpendicular
 * to the radius) when the gravitational parameter changes suddenly from μ to μ′.
 * With q = μ′/μ the vis-viva equation v² = μ′(2/r − 1/a) gives
 *   a = q r/(2q − 1), the other apsis r/(2q − 1), e = |1 − 1/q|.
 * For q > 1 the start point becomes the apoapsis; for ½ < q < 1 the periapsis;
 * for q ≤ ½ the body is at or above the new escape speed.
 */
export function orbitAfterChange(r: number, muOld: number, muNew: number): OrbitChange {
  const q = muNew / muOld;
  const vStart = Math.sqrt(muOld / r);
  const periodOld = 2 * Math.PI * Math.sqrt((r * r * r) / muOld);
  const base = {
    r,
    q,
    muOld,
    muNew,
    vStart,
    vCircNew: Math.sqrt(Math.max(0, muNew) / r),
    vEscNew: Math.sqrt((2 * Math.max(0, muNew)) / r),
    periodOld,
  };
  if (!(q > 0)) {
    // No attraction left: straight-line motion away from the closest (start) point.
    return { ...base, bound: false, e: NaN, a: NaN, semiLatus: NaN, periapsis: r, apoapsis: NaN, periodNew: NaN, startAt: 'periapsis' };
  }
  const e = Math.abs(1 - 1 / q);
  const semiLatus = r / q;
  if (Math.abs(q - 1) < 1e-14) {
    return { ...base, bound: true, e: 0, a: r, semiLatus: r, periapsis: r, apoapsis: r, periodNew: periodOld, startAt: 'circular' };
  }
  const denom = 2 * q - 1;
  if (denom <= 0) {
    return { ...base, bound: false, e, a: NaN, semiLatus, periapsis: r, apoapsis: NaN, periodNew: NaN, startAt: 'periapsis' };
  }
  const a = (q * r) / denom;
  const other = r / denom;
  const periodNew = 2 * Math.PI * Math.sqrt((a * a * a) / muNew);
  if (q > 1) return { ...base, bound: true, e, a, semiLatus, periapsis: other, apoapsis: r, periodNew, startAt: 'apoapsis' };
  return { ...base, bound: true, e, a, semiLatus, periapsis: r, apoapsis: other, periodNew, startAt: 'periapsis' };
}

/**
 * Time from the moment of the change (at apoapsis) until the body first
 * reaches radius R on its way toward periapsis, from Kepler's equation
 * M = E − e sin E. NaN if it never gets that close.
 */
export function timeToRadius(o: OrbitChange, R: number): number {
  if (!o.bound || o.startAt !== 'apoapsis' || !(R > o.periapsis) || !(R < o.apoapsis)) return NaN;
  const cosE = Math.min(1, Math.max(-1, (1 - R / o.a) / o.e));
  const E1 = Math.acos(cosE);
  const M1 = E1 - o.e * Math.sin(E1);
  return o.periodNew / 2 - (M1 / (2 * Math.PI)) * o.periodNew;
}

export interface OrbitalConsequences {
  interpretation: Interpretation;
  k: number;
  satAltitude: number;
  sat: OrbitChange;
  moon: OrbitChange;
  earth: OrbitChange;
  satHitsSurface: boolean;
  /** Seconds until the satellite reaches the surface (atmosphere ignored), NaN if it does not. */
  satTimeToSurface: number;
  vEscOld: number;
  vEscNew: number;
  /** Lunar tidal acceleration on Earth at the Moon's closest approach ÷ today's. */
  moonTideFactor: number;
  rocheOld: number;
  rocheNew: number;
  /** Sunlight at Earth's new perihelion ÷ today's (Sun's luminosity held fixed). */
  insolationPeri: number;
}

export function interpretationOf(p: ParamValues): Interpretation {
  const s = str(p, 'interpretation');
  return s === 'G' || s === 'local' ? s : 'mass';
}

export function orbitalConsequences(p: ParamValues): OrbitalConsequences {
  const k = num(p, 'factor');
  const interp = interpretationOf(p);
  const alt = num(p, 'satAltitude') * 1000;
  const rSat = R_EARTH + alt;
  const muE = GM_EARTH;
  const muMoon = GM_EARTH * (1 + MOON_EARTH_MASS_RATIO);
  const muSun = GM_SUN + GM_EARTH;
  let muE2 = muE;
  let muMoon2 = muMoon;
  let muSun2 = muSun;
  let roche = 1;
  let tideG = 1;
  if (interp === 'mass') {
    muE2 = k * GM_EARTH;
    muMoon2 = GM_EARTH * (k + MOON_EARTH_MASS_RATIO);
    muSun2 = GM_SUN + k * GM_EARTH;
    roche = Math.cbrt(k);
  } else if (interp === 'G') {
    muE2 = k * muE;
    muMoon2 = k * muMoon;
    muSun2 = k * muSun;
    tideG = k;
  }
  const sat = orbitAfterChange(rSat, muE, muE2);
  const moon = orbitAfterChange(MOON_DISTANCE, muMoon, muMoon2);
  const earth = orbitAfterChange(AU, muSun, muSun2);
  const satHitsSurface = sat.periapsis < R_EARTH;
  const rocheOld = ROCHE_FLUID * R_MOON * Math.cbrt(1 / MOON_EARTH_MASS_RATIO);
  return {
    interpretation: interp,
    k,
    satAltitude: alt,
    sat,
    moon,
    earth,
    satHitsSurface,
    satTimeToSurface: satHitsSurface ? timeToRadius(sat, R_EARTH) : NaN,
    vEscOld: Math.sqrt((2 * muE) / R_EARTH),
    vEscNew: Math.sqrt((2 * Math.max(0, muE2)) / R_EARTH),
    moonTideFactor: tideG * Math.pow(MOON_DISTANCE / moon.periapsis, 3),
    rocheOld,
    rocheNew: rocheOld * roche,
    insolationPeri: Math.pow(AU / earth.periapsis, 2),
  };
}

/* ------------------------------------------------------------------------ */
/* Integration                                                               */
/* ------------------------------------------------------------------------ */

interface Kin {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * One RK4 step for a = (0, −gEff) − kd|v|v (velocity-dependent only).
 * gEff < 0 gives an upward acceleration (used for the jump push-off).
 */
function rk4(b: Kin, gEff: number, kd: number, h: number): Kin {
  const ax = (vx: number, vy: number) => -kd * Math.hypot(vx, vy) * vx;
  const ay = (vx: number, vy: number) => -gEff - kd * Math.hypot(vx, vy) * vy;
  const { x, y, vx, vy } = b;
  const a1x = ax(vx, vy), a1y = ay(vx, vy);
  const v2x = vx + 0.5 * h * a1x, v2y = vy + 0.5 * h * a1y;
  const a2x = ax(v2x, v2y), a2y = ay(v2x, v2y);
  const v3x = vx + 0.5 * h * a2x, v3y = vy + 0.5 * h * a2y;
  const a3x = ax(v3x, v3y), a3y = ay(v3x, v3y);
  const v4x = vx + h * a3x, v4y = vy + h * a3y;
  const a4x = ax(v4x, v4y), a4y = ay(v4x, v4y);
  return {
    x: x + (h / 6) * (vx + 2 * v2x + 2 * v3x + v4x),
    y: y + (h / 6) * (vy + 2 * v2y + 2 * v3y + v4y),
    vx: vx + (h / 6) * (a1x + 2 * a2x + 2 * a3x + a4x),
    vy: vy + (h / 6) * (a1y + 2 * a2y + 2 * a3y + a4y),
  };
}

/**
 * Advance by up to h. If `hit` becomes true during the step, locate the
 * earliest such moment by bisection (re-integrating from the step start with
 * a shorter RK4 step) and stop there. Returns the state and the time used.
 */
function advanceUntil(b: Kin, gEff: number, kd: number, h: number, hit: (k: Kin) => boolean): { k: Kin; tau: number; hit: boolean } {
  const full = rk4(b, gEff, kd, h);
  if (!hit(full)) return { k: full, tau: h, hit: false };
  let lo = 0;
  let hi = h;
  let khi = full;
  for (let i = 0; i < 64 && hi - lo > 1e-14; i++) {
    const mid = 0.5 * (lo + hi);
    const km = rk4(b, gEff, kd, mid);
    if (hit(km)) {
      hi = mid;
      khi = km;
    } else lo = mid;
  }
  return { k: khi, tau: hi, hit: true };
}

/* ------------------------------------------------------------------------ */
/* Events                                                                    */
/* ------------------------------------------------------------------------ */

const WORLD_NAME: Record<WorldKey, string> = { base: 'Baseline', exp: 'Experiment' };

function f(v: number, sig = 3): string {
  return formatNumber(v, sig);
}

function push(pending: SimEvent[], w: World, id: string, t: number, label: string, detail: string, severity: SimEvent['severity']) {
  pending.push({ t, id: `${w.key}-${id}`, label: `${WORLD_NAME[w.key]}: ${label}`, detail, severity, source: 'model' });
}

/* ------------------------------------------------------------------------ */
/* Stepping                                                                  */
/* ------------------------------------------------------------------------ */

function makeBall(x: number, y: number, vx: number, vy: number): Ball {
  return { x, y, vx, vy, flying: true, apexReached: false, apexX: NaN, apexY: NaN, apexT: NaN, landT: NaN, landX: NaN, landSpeed: NaN };
}

function makeWorld(pending: SimEvent[], key: WorldKey, p: ParamValues, wp: WorldPrediction, fm: number): World {
  const v = num(p, 'launchSpeed');
  const th = (num(p, 'launchAngle') * Math.PI) / 180;
  const d = num(p, 'pushDistance');
  const drop = makeBall(0, num(p, 'dropHeight'), 0, 0);
  drop.apexReached = true; // released at rest: the release point is the highest point.
  drop.apexX = 0;
  drop.apexY = drop.y;
  drop.apexT = 0;
  const w: World = {
    key,
    g: wp.g,
    rho: wp.rho,
    kd: wp.kd,
    fm,
    drop,
    proj: makeBall(0, 0, v * Math.cos(th), v * Math.sin(th)),
    jump: { z: -d, vz: 0, phase: wp.canJump ? 'push' : 'stuck', takeoffT: NaN, takeoffV: NaN, apexReached: false, apexZ: NaN, apexT: NaN, landT: NaN },
    complete: false,
    completeT: NaN,
  };
  if (!wp.canJump) {
    w.jump.takeoffV = 0;
    w.jump.apexZ = 0;
    push(
      pending,
      w,
      'cannot-jump',
      0,
      'the jumper cannot leave the ground',
      `The calibrated leg push gives F/m = ${f(fm)} m/s², which does not exceed g = ${f(wp.g)} m/s² (net upward acceleration ${f(fm - wp.g)} m/s²). In this constant-force model the body cannot even rise out of the crouch.`,
      'warning',
    );
  }
  return w;
}

function stepBall(s: GravityState, w: World, b: Ball, which: 'drop' | 'proj', t0: number, h: number) {
  if (!b.flying) return;
  let k: Kin = { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
  let rem = h;
  let t = t0;
  if (!b.apexReached && k.vy > 0) {
    const r = advanceUntil(k, w.g, w.kd, rem, (n) => n.vy <= 0);
    k = r.k;
    t += r.tau;
    rem -= r.tau;
    if (r.hit) {
      b.apexReached = true;
      b.apexX = k.x;
      b.apexY = k.y;
      b.apexT = t;
      push(s.pending, w, `${which}-apex`, t, 'thrown ball reached its highest point', `${f(k.y)} m above the ground at t = ${f(t)} s, ${f(k.x)} m downrange (g = ${f(w.g)} m/s²).`, 'info');
    }
  }
  if (rem > 0 && (b.apexReached || k.vy <= 0)) {
    const r = advanceUntil(k, w.g, w.kd, rem, (n) => n.y <= 0 && n.vy < 0);
    k = r.k;
    t += r.tau;
    rem -= r.tau;
    if (r.hit) {
      const speed = Math.hypot(k.vx, k.vy);
      b.flying = false;
      b.landT = t;
      b.landX = k.x;
      b.landSpeed = speed;
      if (which === 'drop') {
        push(s.pending, w, 'drop-land', t, 'dropped ball hit the ground', `Fell ${f(b.apexY)} m in ${f(t)} s; impact speed ${f(speed)} m/s (g = ${f(w.g)} m/s²${w.kd > 0 ? ', with air drag' : ', no air'}).`, 'milestone');
      } else {
        push(s.pending, w, 'proj-land', t, 'thrown ball landed', `Range ${f(k.x)} m after ${f(t)} s of flight; peak height ${f(b.apexY)} m; impact speed ${f(speed)} m/s.`, 'milestone');
      }
      k = { x: k.x, y: 0, vx: 0, vy: 0 };
    }
  }
  b.x = k.x;
  b.y = k.y;
  b.vx = k.vx;
  b.vy = k.vy;
}

function stepJumper(s: GravityState, w: World, d: number, t0: number, h: number) {
  const j = w.jump;
  if (j.phase === 'landed' || j.phase === 'stuck') return;
  let k: Kin = { x: 0, y: j.z, vx: 0, vy: j.vz };
  let rem = h;
  let t = t0;
  if (j.phase === 'push') {
    // Legs push with constant F: net acceleration F/m − g upward until the CoM reaches standing height.
    const r = advanceUntil(k, -(w.fm - w.g), 0, rem, (n) => n.y >= 0);
    k = r.k;
    t += r.tau;
    rem -= r.tau;
    if (r.hit) {
      k = { x: 0, y: 0, vx: 0, vy: k.vy };
      j.phase = 'flight';
      j.takeoffT = t;
      j.takeoffV = k.vy;
      push(s.pending, w, 'jump-takeoff', t, 'the jumper left the ground', `Take-off speed ${f(k.vy)} m/s after a ${f(t)} s push over ${f(d)} m (F/m = ${f(w.fm)} m/s², g = ${f(w.g)} m/s²).`, 'info');
    }
  }
  if (j.phase === 'flight' && rem > 0) {
    if (!j.apexReached) {
      const r = advanceUntil(k, w.g, 0, rem, (n) => n.vy <= 0);
      k = r.k;
      t += r.tau;
      rem -= r.tau;
      if (r.hit) {
        j.apexReached = true;
        j.apexZ = k.y;
        j.apexT = t;
        push(s.pending, w, 'jump-apex', t, 'the jumper reached the top of the jump', `Centre of mass ${f(k.y)} m above the standing position at t = ${f(t)} s.`, 'milestone');
      }
    }
    if (rem > 0 && j.apexReached) {
      const r = advanceUntil(k, w.g, 0, rem, (n) => n.y <= 0 && n.vy < 0);
      k = r.k;
      t += r.tau;
      rem -= r.tau;
      if (r.hit) {
        j.phase = 'landed';
        j.landT = t;
        push(s.pending, w, 'jump-land', t, 'the jumper landed', `${f(t - j.takeoffT)} s in the air; jump height ${f(j.apexZ)} m.`, 'info');
        k = { x: 0, y: 0, vx: 0, vy: 0 };
      }
    }
  }
  j.z = k.y;
  j.vz = k.vy;
}

function worldDone(w: World): boolean {
  return !w.drop.flying && !w.proj.flying && (w.jump.phase === 'landed' || w.jump.phase === 'stuck');
}

function ratio(a: number, b: number): number {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : NaN;
}

function stepWorld(s: GravityState, w: World, d: number, t0: number, h: number) {
  stepBall(s, w, w.drop, 'drop', t0, h);
  stepBall(s, w, w.proj, 'proj', t0, h);
  stepJumper(s, w, d, t0, h);
  if (!w.complete && worldDone(w)) {
    w.complete = true;
    w.completeT = Math.max(w.drop.landT, w.proj.landT, w.jump.phase === 'landed' ? w.jump.landT : 0);
  }
}

/* ------------------------------------------------------------------------ */
/* Observables                                                               */
/* ------------------------------------------------------------------------ */

const WL: Record<WorldKey, string> = { base: 'baseline', exp: 'experiment' };

function pair(
  key: string,
  label: string,
  unit: UnitId,
  provenance: Provenance,
  extra: Partial<ObservableDef> & { description: string },
): ObservableDef[] {
  return (['base', 'exp'] as const).map((w) => ({
    key: `${key}_${w}`,
    label: `${label} — ${WL[w]}`,
    unit,
    provenance,
    chartGroup: key,
    ...extra,
    description: `${extra.description} (${WL[w]} world)`,
  }));
}

const OBSERVABLES: ObservableDef[] = [
  ...pair('drop_h', 'Dropped ball height', 'm', 'simulated', { chart: true, readout: false, description: 'Height of the dropped ball above the ground' }),
  ...pair('drop_v', 'Dropped ball speed', 'm/s', 'simulated', { chart: true, readout: false, description: 'Speed of the dropped ball (0 after impact)' }),
  ...pair('proj_y', 'Thrown ball height', 'm', 'simulated', { chart: true, readout: false, description: 'Height of the thrown ball above the ground' }),
  ...pair('proj_x', 'Thrown ball distance', 'm', 'simulated', { chart: true, readout: false, description: 'Horizontal distance of the thrown ball from the launch point' }),
  ...pair('jump_h', 'Jumper height', 'm', 'simulated', { chart: true, readout: false, description: 'Centre-of-mass height of the jumper relative to the standing position (negative while crouched)' }),
  ...pair('drop_t', 'Fall time', 's', 'simulated', { description: 'Time for the dropped ball to reach the ground (n/a until it lands)' }),
  ...pair('drop_vimp', 'Impact speed (drop)', 'm/s', 'simulated', { description: 'Speed of the dropped ball at impact' }),
  ...pair('proj_range', 'Throw range', 'm', 'simulated', { description: 'Horizontal distance at which the thrown ball landed' }),
  ...pair('proj_apex', 'Throw peak height', 'm', 'simulated', { description: 'Highest point of the thrown ball' }),
  ...pair('proj_tf', 'Throw flight time', 's', 'simulated', { description: 'Time the thrown ball spent in the air' }),
  ...pair('jump_v0', 'Jump take-off speed', 'm/s', 'simulated', { description: 'Vertical speed of the jumper when the feet leave the ground (0 if the jumper cannot push off)' }),
  ...pair('jump_apex', 'Jump height', 'm', 'simulated', { description: 'Rise of the centre of mass above the standing position at the top of the jump (0 if the jumper cannot push off)' }),
  ...pair('weight', 'Body weight', 'N', 'derived', { sig: 4, description: 'Weight W = m·g of a person of the chosen body mass' }),
  ...pair('scale', 'Bathroom-scale reading', 'kg', 'derived', { sig: 4, description: 'What a scale calibrated in the baseline world (reading = W/g₀) would display' }),
  ...pair('blood_dp', 'Heart→brain blood pressure difference', 'mmHg', 'derived', { description: 'Hydrostatic pressure difference ρ_blood·g·h of a blood column of the chosen height (physical quantity only; physiological consequences are not modelled)' }),
];

/* ------------------------------------------------------------------------ */
/* Model                                                                     */
/* ------------------------------------------------------------------------ */

function finiteOrNaN(v: number): number {
  return Number.isFinite(v) ? v : NaN;
}

export const gravityCompareModel: SimulationModel<GravityState> = {
  id: 'gravity-compare',
  name: 'Two-World Gravity Comparison',
  shortName: 'Gravity ×k',
  domain: 'physics',
  viewKind: '2d',
  summary:
    'A baseline world and a world with k times the gravity, stepped side by side with the same RK4 integrator: a drop, a throw, a standing jump and apparent weight, plus the closed-form orbital consequences for the Moon, a satellite and Earth.',
  params: [
    { key: 'factor', label: 'Gravity factor k', type: 'number', unit: 'x', kind: 'initial', group: 'Gravity', min: 0, max: 5, step: 0.005, default: 2, description: 'The experimental world has g = k·g₀. The baseline world keeps g₀.', marks: [
      { value: 0.165, label: 'Moon' }, { value: 0.378, label: 'Mars' }, { value: 1, label: 'Earth' }, { value: 2, label: 'Doubled' }, { value: 2.53, label: 'Jupiter' },
    ] },
    { key: 'g0', label: 'Baseline gravity g₀', type: 'number', unit: 'm/s2', kind: 'initial', group: 'Gravity', min: 0.5, max: 30, step: 0.01, default: 9.81, description: 'Gravitational acceleration of the baseline world. The orbital section always uses the real Earth, Moon and Sun.', marks: [{ value: 9.81, label: 'Earth' }] },
    { key: 'interpretation', label: 'What changes (orbits)', type: 'choice', kind: 'initial', group: 'Orbits', default: 'mass', description: 'How the gravity change is produced. This decides the orbital consequences; the surface experiments only depend on k.', options: [
      { value: 'mass', label: 'Earth’s mass × k', description: INTERPRETATIONS.mass.label },
      { value: 'G', label: 'Gravitational constant G × k', description: INTERPRETATIONS.G.label },
      { value: 'local', label: 'Surface field only', description: INTERPRETATIONS.local.label },
    ] },
    { key: 'satAltitude', label: 'Satellite altitude', type: 'number', unit: 'km', kind: 'initial', group: 'Orbits', min: 160, max: 40000, step: 10, default: 400, scale: 'log', description: 'Altitude of the satellite’s circular orbit before the change (400 km is similar to the International Space Station).', marks: [{ value: 400, label: 'ISS' }, { value: 20200, label: 'GPS' }, { value: 35786, label: 'GEO' }] },
    { key: 'dropHeight', label: 'Drop height h', type: 'number', unit: 'm', kind: 'initial', group: 'Drop', min: 0.5, max: 500, step: 0.5, default: 20, description: 'Height from which the ball is released at rest in both worlds.' },
    { key: 'launchSpeed', label: 'Throw speed v', type: 'number', unit: 'm/s', kind: 'initial', group: 'Throw', min: 0.5, max: 100, step: 0.5, default: 15, description: 'Launch speed of the thrown ball (from ground level) in both worlds.' },
    { key: 'launchAngle', label: 'Throw angle θ', type: 'number', unit: 'deg', kind: 'initial', group: 'Throw', min: 1, max: 90, step: 1, default: 45, description: 'Launch angle above horizontal.' },
    { key: 'drag', label: 'Air drag', type: 'boolean', kind: 'initial', group: 'Air', default: false, description: 'Apply quadratic air drag to the dropped and thrown ball, identically in both worlds. Off = vacuum.' },
    { key: 'airDensity', label: 'Air density ρ', type: 'number', unit: 'kg/m3', kind: 'initial', group: 'Air', min: 0, max: 5, step: 0.005, default: 1.225, description: 'Air density at the ground (1.225 kg/m³ is sea level on Earth).', visibleWhen: (p) => bool(p, 'drag') },
    { key: 'airScales', label: 'Scale air density with g', type: 'boolean', kind: 'initial', group: 'Air', default: false, description: 'Approximation: with the same mass and temperature of atmosphere, surface pressure (and so density) is proportional to g. Off = same air in both worlds.', visibleWhen: (p) => bool(p, 'drag') },
    { key: 'ballMass', label: 'Ball mass', type: 'number', unit: 'kg', kind: 'initial', group: 'Air', min: 0.01, max: 100, step: 0.01, default: 0.5, scale: 'log', description: 'Only matters with air drag: in a vacuum the motion does not depend on mass.', visibleWhen: (p) => bool(p, 'drag') },
    { key: 'ballRadius', label: 'Ball radius', type: 'number', unit: 'm', kind: 'initial', group: 'Air', min: 0.01, max: 0.5, step: 0.005, default: 0.05, description: 'Sets the drag area πr².', visibleWhen: (p) => bool(p, 'drag') },
    { key: 'dragCoefficient', label: 'Drag coefficient C_d', type: 'number', unit: '1', kind: 'initial', group: 'Air', min: 0.05, max: 2, step: 0.01, default: 0.47, description: 'Shape factor; about 0.47 for a smooth sphere.', visibleWhen: (p) => bool(p, 'drag') },
    { key: 'pushDistance', label: 'Push-off distance d', type: 'number', unit: 'm', kind: 'initial', group: 'Jump', min: 0.1, max: 0.8, step: 0.01, default: 0.4, description: 'How far the centre of mass rises while the feet push on the ground (crouch depth).' },
    { key: 'jumpHeight0', label: 'Baseline jump height h₀', type: 'number', unit: 'm', kind: 'initial', group: 'Jump', min: 0.05, max: 1.5, step: 0.01, default: 0.5, description: 'Calibration: the leg force is chosen so the jump reaches this height in the baseline world.' },
    { key: 'bodyMass', label: 'Body mass', type: 'number', unit: 'kg', kind: 'initial', group: 'Body', min: 20, max: 200, step: 1, default: 70, description: 'Mass of the person (for weight, scale reading and leg force; the jump kinematics do not depend on it).' },
    { key: 'bloodColumn', label: 'Heart-to-brain height', type: 'number', unit: 'm', kind: 'initial', group: 'Body', min: 0.1, max: 0.6, step: 0.01, default: 0.35, description: 'Vertical height of the blood column between heart and brain when standing.' },
    { key: 'dt', label: 'Time step', type: 'number', unit: 's', kind: 'initial', group: 'Numerics', numerics: true, min: 0.0002, max: 0.01, step: 0.0001, default: 0.001, description: 'Fixed RK4 step used for both worlds. Landing, apex and take-off moments are located within a step by bisection.' },
  ],
  observables: OBSERVABLES,
  primaryObservables: ['drop_h_base', 'drop_h_exp'],
  time: {
    unit: 's',
    dt: (p) => num(p, 'dt'),
    sampleInterval: sampleInterval,
    defaultDuration: runDuration,
    maxDuration: MAX_DURATION,
    realtimeRate: 1,
  },

  init(p) {
    const pr = predictions(p);
    const pending: SimEvent[] = [];
    const base = makeWorld(pending, 'base', p, pr.base, pr.specificLegForce);
    const exp = makeWorld(pending, 'exp', p, pr.exp, pr.specificLegForce);
    return { t: 0, base, exp, pending, allComplete: false };
  },

  step(s, p, h) {
    const t0 = s.t;
    const d = num(p, 'pushDistance');
    stepWorld(s, s.base, d, t0, h);
    stepWorld(s, s.exp, d, t0, h);
    s.t = t0 + h;
    if (!s.allComplete && s.base.complete && s.exp.complete) {
      s.allComplete = true;
      const tc = Math.max(s.base.completeT, s.exp.completeT);
      const b = s.base;
      const e = s.exp;
      s.pending.push({
        t: tc,
        id: 'all-complete',
        label: 'All experiments complete in both worlds',
        detail: `Experiment ÷ baseline: fall time ×${f(ratio(e.drop.landT, b.drop.landT))}, impact speed ×${f(ratio(e.drop.landSpeed, b.drop.landSpeed))}, throw range ×${f(ratio(e.proj.landX, b.proj.landX))}; jump height ${f(b.jump.apexZ)} m → ${f(e.jump.apexZ)} m.`,
        severity: 'milestone',
        source: 'model',
      });
    }
  },

  observe(s, p) {
    const out: Record<string, number> = {};
    const m = num(p, 'bodyMass');
    const g0 = num(p, 'g0');
    const hb = num(p, 'bloodColumn');
    for (const w of [s.base, s.exp]) {
      const k = w.key;
      const j = w.jump;
      out[`drop_h_${k}`] = w.drop.y;
      out[`drop_v_${k}`] = Math.hypot(w.drop.vx, w.drop.vy);
      out[`proj_y_${k}`] = w.proj.y;
      out[`proj_x_${k}`] = w.proj.x;
      out[`jump_h_${k}`] = j.z;
      out[`drop_t_${k}`] = w.drop.flying ? NaN : w.drop.landT;
      out[`drop_vimp_${k}`] = w.drop.flying ? NaN : w.drop.landSpeed;
      out[`proj_range_${k}`] = w.proj.flying ? NaN : w.proj.landX;
      out[`proj_apex_${k}`] = w.proj.apexReached ? w.proj.apexY : NaN;
      out[`proj_tf_${k}`] = w.proj.flying ? NaN : w.proj.landT;
      out[`jump_v0_${k}`] = j.phase === 'stuck' ? 0 : Number.isFinite(j.takeoffV) ? j.takeoffV : NaN;
      out[`jump_apex_${k}`] = j.phase === 'stuck' ? 0 : j.apexReached ? j.apexZ : NaN;
      out[`weight_${k}`] = m * w.g;
      out[`scale_${k}`] = (m * w.g) / g0;
      out[`blood_dp_${k}`] = (RHO_BLOOD * w.g * hb) / PA_PER_MMHG;
    }
    return out;
  },

  clone(s) {
    const cw = (w: World): World => ({ ...w, drop: { ...w.drop }, proj: { ...w.proj }, jump: { ...w.jump } });
    return { ...s, base: cw(s.base), exp: cw(s.exp), pending: [...s.pending] };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  finished(s) {
    return s.allComplete ? 'All experiments have finished in both worlds.' : null;
  },

  tracks(s) {
    const out = [];
    for (const w of [s.base, s.exp]) {
      out.push({ id: `drop-${w.key}`, x: 0, y: w.drop.y }, { id: `proj-${w.key}`, x: w.proj.x, y: w.proj.y }, { id: `jump-${w.key}`, x: 0, y: w.jump.z });
    }
    return out;
  },

  derived(p) {
    const pr = predictions(p);
    const o = orbitalConsequences(p);
    const out: DerivedQuantity[] = [];
    const dq = (key: string, label: string, value: number, unit: UnitId, formula: string, note?: string, sig?: number, provenance: Provenance = 'derived') =>
      out.push({ key, label, value: finiteOrNaN(value), unit, formula, provenance, note, sig });
    const never = (w: WorldPrediction) => (w.g > 0 ? undefined : 'With g = 0 the ball never comes down.');
    const vac = dragOn(p) ? 'Vacuum value; the simulation includes air drag, so its result differs.' : undefined;

    dq('g_exp', 'Experimental gravity g', pr.exp.g, 'm/s2', 'g = k·g₀');
    for (const [wk, w] of [['base', pr.base], ['exp', pr.exp]] as const) {
      dq(`drop_t_${wk}`, `Fall time without air — ${WL[wk]}`, w.dropTime, 's', 't = √(2h/g)', never(w) ?? vac);
      dq(`drop_v_${wk}`, `Impact speed without air — ${WL[wk]}`, w.dropSpeed, 'm/s', 'v = √(2gh)', never(w) ?? vac);
    }
    for (const [wk, w] of [['base', pr.base], ['exp', pr.exp]] as const) {
      dq(`range_${wk}`, `Throw range without air — ${WL[wk]}`, w.range, 'm', 'R = v² sin 2θ / g', never(w) ?? vac);
      dq(`apex_${wk}`, `Throw peak height without air — ${WL[wk]}`, w.apex, 'm', 'H = (v sin θ)² / 2g', never(w) ?? vac);
      dq(`tf_${wk}`, `Throw flight time without air — ${WL[wk]}`, w.flightTime, 's', 'T = 2v sin θ / g', never(w) ?? vac);
    }
    if (dragOn(p)) {
      for (const [wk, w] of [['base', pr.base], ['exp', pr.exp]] as const) {
        dq(`vterm_${wk}`, `Terminal speed of the ball — ${WL[wk]}`, w.terminalSpeed, 'm/s', 'v_t = √(2mg / ρC_dA)', w.g > 0 ? `Air density ${f(w.rho)} kg/m³.` : 'No terminal speed without gravity.');
      }
    }
    dq('jump_fm', 'Leg push per kilogram F/m (calibrated)', pr.specificLegForce, 'm/s2', 'F/m = g₀ + v₀²/2d,  v₀ = √(2g₀h₀)', 'The same legs (same F/m) are used in both worlds.');
    dq('leg_force', 'Leg push force F', pr.legForce, 'N', 'F = m · (F/m)');
    dq('jump_kcrit', 'Gravity factor at which jumping becomes impossible', pr.kCrit, 'x', 'k_crit = (F/m)/g₀ = 1 + h₀/d', 'At this factor F/m = g and the take-off speed is zero.');
    for (const [wk, w] of [['base', pr.base], ['exp', pr.exp]] as const) {
      dq(`jump_v_${wk}`, `Take-off speed (closed form) — ${WL[wk]}`, w.jumpTakeoffSpeed, 'm/s', "v′ = √(2d(F/m − g)), 0 if F/m ≤ g", w.canJump ? undefined : 'F/m ≤ g: the jumper cannot leave the ground.');
      dq(`jump_h_${wk}`, `Jump height (closed form) — ${WL[wk]}`, w.jumpApex, 'm', "h′ = v′²/2g = d(F/m − g)/g", w.canJump ? (w.g > 0 ? undefined : 'With g = 0 the jumper never comes down.') : 'F/m ≤ g: no jump.');
    }

    // Orbits
    const interpNote = `Interpretation: ${INTERPRETATIONS[o.interpretation].short}.`;
    dq('vesc_base', 'Escape speed from Earth’s surface — today', o.vEscOld / 1000, 'km/s', 'v_esc = √(2GM/R)', undefined, 4);
    dq('vesc_exp', 'Escape speed from Earth’s surface — after the change', o.vEscNew / 1000, 'km/s', 'v_esc′ = √(2GM′/R)', o.interpretation === 'local' ? 'Only the surface field changes in this interpretation, so the far field and the escape speed are unchanged.' : interpNote, 4);
    const sat = o.sat;
    dq('sat_v', 'Satellite speed (circular orbit today)', sat.vStart / 1000, 'km/s', 'v = √(μ/r)', `r = R⊕ + ${f(o.satAltitude / 1000, 4)} km.`, 4);
    dq('sat_vcirc', 'Circular speed needed after the change', sat.vCircNew / 1000, 'km/s', 'v_c′ = √(μ′/r)', interpNote, 4);
    dq('sat_rp_alt', 'Satellite: new lowest altitude (periapsis)', (sat.periapsis - R_EARTH) / 1000, 'km', 'r_p = r/(2q − 1) for q = μ′/μ > 1', o.satHitsSurface ? 'Below the surface: the satellite would hit the ground (and the atmosphere well before that).' : sat.bound ? undefined : 'Unbound: the satellite escapes.', 4);
    dq('sat_ra_alt', 'Satellite: new highest altitude (apoapsis)', (sat.apoapsis - R_EARTH) / 1000, 'km', 'r_a = r/(2q − 1) for ½ < q < 1', sat.bound ? undefined : 'Unbound: no apoapsis, the satellite escapes Earth.', 4);
    dq('sat_e', 'Satellite: new eccentricity', sat.e, '1', 'e = |1 − 1/q|', q1Note(sat.q));
    dq('sat_T_old', 'Satellite: orbital period today', sat.periodOld / 60, 'min', 'T = 2π√(r³/μ)');
    dq('sat_T_new', 'Satellite: orbital period after the change', sat.periodNew / 60, 'min', "T′ = 2π√(a³/μ′),  a = qr/(2q − 1)", sat.bound ? (o.satHitsSurface ? 'Only meaningful if the orbit did not intersect Earth.' : undefined) : 'Unbound: no period.');
    if (o.satHitsSurface) {
      dq('sat_t_hit', 'Satellite: time until it reaches the surface', o.satTimeToSurface / 60, 'min', 'Kepler: t = T′/2 − (E − e sin E)/n at r = R⊕', 'Atmosphere ignored; drag would bring it down sooner.');
    }
    const moon = o.moon;
    dq('moon_rp', 'Moon: new closest distance (periapsis)', moon.periapsis / 1000, 'km', 'r_p = r/(2q − 1)', `Today ${f(MOON_DISTANCE / 1000, 4)} km (treated as circular).`, 4);
    dq('moon_ra', 'Moon: new farthest distance (apoapsis)', moon.apoapsis / 1000, 'km', 'r_a', moon.bound ? undefined : 'Unbound: the Moon escapes Earth.', 4);
    dq('moon_e', 'Moon: new eccentricity', moon.e, '1', 'e = |1 − 1/q|', q1Note(moon.q));
    dq('moon_T_old', 'Moon: orbital period today', moon.periodOld / 86400, 'day', 'T = 2π√(r³/G(M⊕+M☾))');
    dq('moon_T_new', 'Moon: orbital period after the change', moon.periodNew / 86400, 'day', 'T′ = 2π√(a³/μ′)', moon.bound ? undefined : 'Unbound: no period.');
    dq('moon_tide', 'Moon’s tidal pull on Earth at closest approach (× today)', o.moonTideFactor, 'x', 'tide ∝ G M☾ / r³', 'Effects of stronger tides are not modelled.');
    dq('moon_roche', 'Roche limit for the Moon (fluid-body approximation)', o.rocheNew / 1000, 'km', 'd ≈ 2.44 R☾ (M⊕′/M☾)^(1/3)', moon.periapsis > o.rocheNew ? 'The new periapsis stays outside this limit.' : 'The new periapsis is inside this limit: tidal disruption would be possible (not modelled).', 3);
    const earth = o.earth;
    dq('earth_rp', 'Earth: new perihelion distance', earth.periapsis / AU, 'AU', 'r_p = r/(2q − 1)', o.interpretation === 'mass' ? 'Only Earth’s own mass enters the Sun–Earth μ, so the change is tiny.' : undefined, 6);
    dq('earth_ra', 'Earth: new aphelion distance', earth.apoapsis / AU, 'AU', 'r_a', earth.bound ? undefined : 'Unbound: Earth would leave the Sun.', 6);
    dq('earth_e', 'Earth: new orbital eccentricity', earth.e, '1', 'e = |1 − 1/q|', q1Note(earth.q));
    dq('earth_T_new', 'Earth: length of the year after the change', earth.periodNew / 86400, 'day', 'T′ = 2π√(a³/μ′)', earth.bound ? `Today ${f(earth.periodOld / 86400, 4)} days for a circular 1 AU orbit.` : 'Unbound: no period.', 4);
    dq('earth_insol', 'Sunlight at the new perihelion (× today)', o.insolationPeri, 'x', 'S ∝ 1/r²', 'Assumes the Sun’s luminosity is unchanged (speculative under a change of G).');
    return out;
  },

  warnings(p) {
    const pr = predictions(p);
    const o = orbitalConsequences(p);
    const w: Warning[] = [];
    if (pr.k === 0) w.push({ id: 'zero-g', severity: 'info', message: 'g = 0 in the experimental world: nothing falls, so the dropped ball, the thrown ball and the jumper never return to the ground. The run stops at its time limit.' });
    if (!pr.exp.canJump) w.push({ id: 'no-jump', severity: 'info', message: `The calibrated leg push (F/m = ${f(pr.specificLegForce)} m/s²) does not exceed the experimental g (${f(pr.exp.g)} m/s²): in this model the jumper cannot leave the ground.` });
    if (o.interpretation === 'local') w.push({ id: 'local', severity: 'info', message: 'The “surface field only” interpretation is not physically consistent (Gauss’s law ties the surface field to Earth’s mass). It is used here to isolate surface mechanics.' });
    if (o.interpretation !== 'local' && !o.moon.bound) w.push({ id: 'moon-escapes', severity: 'warning', message: `With Earth’s pull scaled by ${f(o.moon.q)} the Moon’s current speed (${f(o.moon.vStart / 1000)} km/s) is at or above the new escape speed (${f(o.moon.vEscNew / 1000)} km/s): it would leave Earth.` });
    if (o.satHitsSurface) w.push({ id: 'sat-crash', severity: 'warning', message: `The satellite’s new orbit dips to ${f((o.sat.periapsis - R_EARTH) / 1000)} km altitude, below the surface: it would crash (computed from vis-viva, atmosphere ignored).` });
    if (pr.k > 1.5) w.push({ id: 'physiology', severity: 'info', message: 'Health effects of living at this gravity (circulation, bones, muscles, breathing) are not modelled; any statement about them would be speculative.' });
    if (dragOn(p)) {
      const r = num(p, 'ballRadius');
      const density = num(p, 'ballMass') / ((4 / 3) * Math.PI * r ** 3);
      const rhoMax = Math.max(pr.base.rho, pr.exp.rho);
      if (density < 20 * rhoMax) w.push({ id: 'buoyancy', severity: 'warning', message: `The ball’s mean density (${f(density)} kg/m³) is not much larger than the air’s (${f(rhoMax)} kg/m³); buoyancy, which this model ignores, would matter.` });
    }
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const fin = run.final;
    const pr = predictions(run.params);
    const o = orbitalConsequences(run.params);
    const out: KeyResult[] = [];
    const val = (v: number | undefined): number | string => (v === undefined || Number.isNaN(v) ? 'not reached in this run' : v);
    const add = (label: string, key: string, unit: UnitId, predBase: number, predExp: number, expr: string) => {
      const b = fin[`${key}_base`];
      const e = fin[`${key}_exp`];
      const r = ratio(e, b);
      const pRatio = ratio(predExp, predBase);
      out.push({ label: `${label} — baseline`, value: val(b), unit, provenance: 'simulated' });
      out.push({
        label: `${label} — experiment`,
        value: val(e),
        unit,
        provenance: 'simulated',
        note: Number.isFinite(r) ? `Ratio ${f(r)} (closed-form vacuum ${expr} = ${Number.isFinite(pRatio) ? f(pRatio) : 'n/a'}).` : undefined,
      });
    };
    add('Fall time', 'drop_t', 's', pr.base.dropTime, pr.exp.dropTime, '1/√k');
    add('Impact speed (drop)', 'drop_vimp', 'm/s', pr.base.dropSpeed, pr.exp.dropSpeed, '√k');
    add('Throw range', 'proj_range', 'm', pr.base.range, pr.exp.range, '1/k');
    add('Throw peak height', 'proj_apex', 'm', pr.base.apex, pr.exp.apex, '1/k');
    add('Jump height', 'jump_apex', 'm', pr.base.jumpApex, pr.exp.jumpApex, 'd(F/m − g)/g');
    out.push({ label: 'Bathroom-scale reading — experiment', value: fin.scale_exp, unit: 'kg', provenance: 'derived', note: `Body mass ${f(num(run.params, 'bodyMass'))} kg; weight ${f(fin.weight_exp)} N.` });
    out.push({ label: 'Satellite: new lowest altitude', value: finiteOrNaN((o.sat.periapsis - R_EARTH) / 1000), unit: 'km', provenance: 'derived', note: `${INTERPRETATIONS[o.interpretation].short}; ${o.satHitsSurface ? 'below the surface — it would crash' : o.sat.bound ? 'stays above the surface' : 'unbound — it escapes'}.` });
    out.push({ label: 'Moon: new closest distance', value: finiteOrNaN(o.moon.periapsis / 1000), unit: 'km', provenance: 'derived', note: o.moon.bound ? `Eccentricity ${f(o.moon.e)}, period ${f(o.moon.periodNew / 86400)} days.` : 'Unbound — the Moon escapes Earth.' });
    out.push({ label: 'Escape speed after the change', value: o.vEscNew / 1000, unit: 'km/s', provenance: 'derived', note: `Today ${f(o.vEscOld / 1000, 4)} km/s.` });
    return out;
  },

  assumptions: [
    { kind: 'established', text: 'Newtonian mechanics with a uniform gravitational field near the ground (heights are tiny compared with the planet’s radius).' },
    { kind: 'established', text: 'In a vacuum every object falls with the same acceleration g regardless of its mass (equivalence of inertial and gravitational mass).' },
    { kind: 'simplification', text: 'Both worlds are identical except for g (and, if chosen, air density): same ball, same launch, same person with the same legs.' },
    { kind: 'simplification', text: 'The jumper is a point mass (centre of mass) pushed upward by a constant leg force over the push-off distance d; arm swing, posture and landing are not modelled.' },
    { kind: 'approximation', text: 'The leg force is calibrated so the baseline jump reaches h₀ and is assumed unchanged in the other world. Real muscle force depends on knee angle and contraction speed (force–velocity relation), and people would adapt to a different g over time.' },
    { kind: 'simplification', text: 'Balls stop where they hit the ground (no bounce); the ground is flat.' },
    { kind: 'approximation', text: 'Air drag, when enabled, is quadratic in speed with a constant drag coefficient: F = ½ρC_dAv². Buoyancy and wind are ignored.' },
    { kind: 'simplification', text: 'Unless “Scale air density with g” is chosen, both worlds have the same air. With the same mass and temperature of atmosphere the surface pressure, and so the density, would actually scale with g (approximation used by that option).' },
    { kind: 'established', text: 'Orbits follow the two-body problem: vis-viva v² = μ(2/r − 1/a) and Kepler’s third law. Constants: GM⊕ = 3.986004418×10¹⁴ m³/s², GM☉ = 1.32712440018×10²⁰ m³/s², M☾/M⊕ = 0.0123.' },
    { kind: 'simplification', text: 'The Moon, the satellite and Earth start on circular orbits at their mean distances (the real Moon has e ≈ 0.055, Earth e ≈ 0.017), and the gravity change is instantaneous. Perturbations (the Sun on the Moon, Earth’s oblateness, atmospheric drag on the satellite) are ignored.' },
    { kind: 'approximation', text: 'When Earth’s mass or G changes, Earth’s radius is assumed unchanged; a real planet would compress somewhat.' },
    { kind: 'simplification', text: 'The “surface field only” interpretation is deliberately unphysical (it violates Gauss’s law); it isolates surface mechanics from orbital effects.' },
    { kind: 'speculative', text: 'Physiological consequences (blood circulation, bones, muscles, breathing, long-term adaptation) are not modelled. The heart-to-brain pressure difference is shown only as a hydrostatic physical quantity.' },
    { kind: 'speculative', text: 'Under a change of G the Sun’s luminosity and structure, and Earth’s interior, would change; these effects are not modelled (sunlight figures assume an unchanged Sun).' },
  ],
  limitations: [
    'Surface experiments are short (seconds to minutes); nothing about weather, oceans, geology or life under a different g is simulated.',
    'The jump model ignores how muscle force varies with knee angle and speed, so jump heights near the critical factor are only indicative.',
    'Orbital results are closed-form snapshots of the new two-body orbits; they are not time-stepped here (see the full numerical Moon-orbit simulation for that).',
    'Tidal effects on the Moon’s orbit, tidal heating, Roche-limit disruption and the Sun’s perturbation of the Moon are not modelled.',
    'Drag uses a constant drag coefficient; near or above the speed of sound it is not accurate.',
    'Event times are located to sub-step precision by bisection, but the recorded chart samples are spaced by the recording interval.',
  ],
  equations: [
    { label: 'Equation of motion (balls)', formula: 'dv/dt = (0, −g) − (ρ C_d A / 2m) |v| v', explanation: 'Integrated with fixed-step RK4 in both worlds. Without air (or with ρ = 0) only gravity acts and mass drops out.' },
    { label: 'Free fall (vacuum)', formula: 't = √(2h/g),  v = √(2gh)', explanation: 'Fall time scales as 1/√k and impact speed as √k when g → k·g.' },
    { label: 'Projectile from the ground (vacuum)', formula: 'R = v² sin 2θ / g,  H = (v sin θ)² / 2g,  T = 2v sin θ / g', explanation: 'Range, peak height and flight time all scale as 1/k.' },
    { label: 'Jump calibration', formula: 'F/m = g₀ + v₀²/(2d),  v₀ = √(2 g₀ h₀)', explanation: 'Constant leg force over the push-off distance d chosen so the baseline jump reaches h₀.' },
    { label: 'Jump in the other world', formula: "v′² = 2d(F/m − g),  h′ = v′²/(2g) = d(F/m − g)/g", explanation: 'Same legs, different g. If F/m ≤ g the person cannot leave the ground. Simulated in time (push-off then flight) and checked against this closed form.' },
    { label: 'Critical gravity factor', formula: 'k_crit = (F/m)/g₀ = 1 + h₀/d', explanation: 'The factor at which the leg push only just balances gravity.' },
    { label: 'Weight and scale reading', formula: 'W = m g,  reading = W / g₀', explanation: 'A bathroom scale measures force but is calibrated to show kilograms in the baseline world.' },
    { label: 'Hydrostatic pressure of a blood column', formula: 'ΔP = ρ_blood g h', explanation: 'Pressure difference between heart and brain level for a standing person; converted to mmHg (1 mmHg = 133.322 Pa).' },
    { label: 'Terminal speed', formula: 'v_t = √(2 m g / (ρ C_d A))', explanation: 'Speed at which drag balances weight. With the same air in both worlds the drag length L = 2m/(ρC_dA) does not involve g, so a drop from rest still takes 1/√k as long (time scale √(L/g)); a throw at a fixed launch speed does not scale this simply.' },
    { label: 'Surface gravity', formula: 'g = G M / R²', explanation: 'Doubling M or G at fixed R doubles g; by Gauss’s law the surface field cannot change without the mass (or G) changing.' },
    { label: 'Vis-viva', formula: 'v² = μ (2/r − 1/a),  μ = G(M + m)', explanation: 'Gives the new semi-major axis from the speed the body had on its old circular orbit.' },
    { label: 'Orbit after a sudden change μ → μ′ = qμ', formula: 'a = q r/(2q − 1),  r_other = r/(2q − 1),  e = |1 − 1/q|', explanation: 'For q > 1 the old radius becomes the farthest point; for q = 2 the closest point is r/3. For q ≤ ½ the body escapes.' },
    { label: 'Kepler’s third law', formula: 'T = 2π √(a³/μ)', explanation: 'Period of the new orbit.' },
    { label: 'Escape speed', formula: 'v_esc = √(2μ/R)', explanation: 'Scales as √k when μ scales by k.' },
    { label: 'Kepler’s equation', formula: 'M = E − e sin E,  r = a(1 − e cos E)', explanation: 'Used to find how long the satellite takes to reach the surface on its new orbit.' },
  ],
  education: {
    objectives: [
      'Predict how fall time, impact speed, range and peak height scale with g, and check the predictions against a simulation of two worlds side by side.',
      'Distinguish weight (a force, m·g) from mass, and explain why doubling an object’s mass alone changes nothing in a vacuum.',
      'Use a simple force model of a jump to see why jump height collapses much faster than 1/k.',
      'Use the vis-viva equation to work out what a sudden change in gravity does to orbits, and see how the answer depends on what “gravity doubled” means.',
    ],
    background: {
      beginner:
        'Gravity is the pull that makes things fall. If it were twice as strong, dropped things would hit the ground sooner and harder, a thrown ball would fly only half as far, and you would weigh twice as much on a bathroom scale — even though you would not be made of any more stuff. Your legs would be the same, so you could hardly jump at all. Here two worlds run at the same time, one with normal gravity and one with the gravity you choose, so you can watch the difference as it happens.',
      intermediate:
        'With g → k·g every free-fall time shrinks by 1/√k (from t = √(2h/g)) while speeds grow by √k. A projectile’s horizontal speed is unchanged but its time aloft is k times shorter, so range and peak height fall to 1/k. A jump is different: the legs supply a fixed force over a fixed distance, so the energy available for flight is (F − mg)·d, which shrinks as g grows, and that smaller energy must lift you against a larger g. The result, h′ = d(F/m − g)/g, falls much faster than 1/k and reaches zero at k = 1 + h₀/d. Orbits depend on what is changed: if Earth’s mass doubled, the Moon would suddenly be moving too slowly for a circle and would fall into an ellipse whose closest point is a third of today’s distance.',
      advanced:
        'Both worlds are integrated in the same state with fixed-step RK4 for dv/dt = −g ŷ − (ρC_dA/2m)|v|v; landing, apex and take-off are located inside a step by bisection on re-integrated sub-steps, so event times are not quantised to dt. For constant acceleration RK4 is exact, so in a vacuum the simulated ratios reproduce 1/√k and 1/k to rounding error. With quadratic drag and the same air, a drop from rest still scales exactly as 1/√k (the only length scale, 2m/ρC_dA, is independent of g), whereas a throw at fixed speed does not, and neither does a drop when the air density is scaled with g. The orbital part treats an instantaneous change μ → qμ for a body on a circular orbit: since v² = μ/r, vis-viva gives 1/a = (2 − 1/q)/r, the start point is an apsis, the other apsis is r/(2q − 1) and e = |1 − 1/q|. The Moon uses μ = G(M⊕ + M☾), so under “Earth’s mass × 2” its q is (2 + 0.0123)/(1.0123) ≈ 1.988 rather than exactly 2; under “G × 2” q = 2 exactly. The “surface field only” option is inconsistent with Gauss’s law but separates surface mechanics from orbital mechanics.',
    },
    variables: [
      { symbol: 'g₀', meaning: 'baseline gravitational acceleration', unit: 'm/s²' },
      { symbol: 'k', meaning: 'gravity factor: g = k·g₀ in the experimental world' },
      { symbol: 'h', meaning: 'drop height', unit: 'm' },
      { symbol: 'v, θ', meaning: 'throw speed and angle above horizontal', unit: 'm/s, °' },
      { symbol: 'd', meaning: 'push-off distance of the jump (crouch depth)', unit: 'm' },
      { symbol: 'h₀', meaning: 'jump height in the baseline world (calibration)', unit: 'm' },
      { symbol: 'F/m', meaning: 'leg push force per kilogram of body mass', unit: 'm/s²' },
      { symbol: 'm', meaning: 'mass (of the ball or the person)', unit: 'kg' },
      { symbol: 'W', meaning: 'weight, the force of gravity on a body', unit: 'N' },
      { symbol: 'ρ, C_d, A', meaning: 'air density, drag coefficient, cross-section', unit: 'kg/m³, –, m²' },
      { symbol: 'μ', meaning: 'gravitational parameter G(M + m)', unit: 'm³/s²' },
      { symbol: 'q', meaning: 'ratio μ′/μ after/before the change' },
      { symbol: 'a, e', meaning: 'semi-major axis and eccentricity of the new orbit', unit: 'm, –' },
      { symbol: 'r_p, r_a', meaning: 'closest (periapsis) and farthest (apoapsis) distance', unit: 'm' },
    ],
    guidedSteps: [
      'Run the default experiment (k = 2) and watch both panes. Which ball lands first, and by how much? Compare the fall-time ratio in the table with 1/√2.',
      'Note the throw range and peak-height ratios. Predict them for Mars (k ≈ 0.38) before changing the factor, then check.',
      'Watch the jumper. Why does the jump height drop to about a tenth when gravity only doubles? Use the F/m value in “Calculated from the parameters”.',
      'Set k to the critical factor shown in the derived values and run again: what happens to the jumper?',
      'Switch on air drag. Is the fall-time ratio still 1/√k? Is the range ratio still 1/k? Change the ball mass: in a vacuum it was hidden because it does not matter — does it matter now?',
      'Open the orbital consequences. Compare the three interpretations: what happens to the satellite and to the Moon in each? Then open the full numerical Moon-orbit simulation.',
    ],
    questions: [
      'Why does the fall time scale as 1/√k but the throw range as 1/k?',
      'How much stronger would your legs need to be to jump as high at k = 2 as you do today?',
      'A bathroom scale shows twice your usual reading at k = 2. Has your mass changed?',
      'Why would a satellite in low orbit crash if Earth’s mass suddenly doubled, while the Moon would stay in orbit?',
      'Which of the three interpretations is physically consistent, and why can the surface field not change on its own?',
    ],
  },
};

function q1Note(q: number): string | undefined {
  if (!(q > 0)) return 'No gravity left: straight-line motion.';
  if (Math.abs(q - 1) < 1e-14) return 'Unchanged: still circular.';
  if (q <= 0.5) return 'e ≥ 1: an open (escape) trajectory.';
  return undefined;
}
