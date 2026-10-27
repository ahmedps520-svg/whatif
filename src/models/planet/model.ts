import type {
  DerivedQuantity,
  KeyResult,
  ParamDef,
  ParamValues,
  RunRecord,
  SimEvent,
  SimulationModel,
  Warning,
} from '../../engine/types';
import { bool, num, str } from '../../engine/validation';
import { convert, formatNumber } from '../../engine/units';
import { ETOPO_SOURCE, loadElevation, nodeAreaKm2 } from '../../data/elevation';
import type { WaterAppearance } from '../../data/earthTexture';
import { buildHypsometry, seaLevelForWaterFraction, waterFractionAtSeaLevel, type Hypsometry } from './hypsometry';

/**
 * Planet Lab — a configurable planet on a circular orbit around a single star.
 *
 * Independent inputs (mass, radius, rotation, tilt, orbit, star, albedo,
 * greenhouse depth, atmosphere, water) are kept strictly separate from the
 * quantities calculated from them (gravity, density, escape speed, orbital
 * period, solar day, insolation, temperatures, scale height, …), which are
 * reported by `derived(p)` with their formulas.
 *
 * Time evolution (model time in hours): the planet spins about a fixed axis
 * with the configured sidereal period and moves along its orbit with the
 * Kepler period, so the star's position in the sky at the observation point,
 * the declination (seasons), insolation and daylight all follow from the
 * geometry. Nothing about climate, weather, formation or long-term stability
 * is simulated.
 */

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** Physical constants and nominal astronomical values (see dataSources). */
export const CONST = {
  /** Nominal solar mass parameter GM☉ (m³/s²), IAU 2015 Resolution B3. */
  GM_SUN: 1.3271244e20,
  /** Nominal terrestrial mass parameter GM⊕ (m³/s²), IAU 2015 Resolution B3. */
  GM_EARTH: 3.986004e14,
  /** Earth's mean radius (m); the R⊕ unit of this app. */
  R_EARTH: 6.371e6,
  /** Astronomical unit (m), IAU 2012 Resolution B2. */
  AU: 1.495978707e11,
  /** Nominal solar luminosity (W), IAU 2015 Resolution B3. */
  L_SUN: 3.828e26,
  /** Stefan–Boltzmann constant (W m⁻² K⁻⁴), CODATA 2018. */
  SIGMA: 5.670374419e-8,
  /** Molar gas constant (J mol⁻¹ K⁻¹), CODATA 2018. */
  R_GAS: 8.314462618,
  /** Triple point of water (K, bar) and critical point (K, bar). */
  T_TRIPLE: 273.16,
  P_TRIPLE_BAR: 0.00611657,
  T_CRIT: 647.096,
  P_CRIT_BAR: 220.64,
  T_FREEZE: 273.15,
} as const;

/**
 * Reference values from the NASA Planetary Fact Sheets (NSSDCA, D. R. Williams),
 * rounded. Used only for slider marks, presets and calibration — never as
 * model outputs.
 */
export const REFERENCE = {
  mercury: { massKg: 0.3301e24, radiusKm: 2439.7, rotationH: 1407.6, tiltDeg: 0.034, aAU: 0.387 },
  venus: { massKg: 4.8673e24, radiusKm: 6051.8, rotationH: 5832.6, tiltDeg: 177.36, aAU: 0.723, bondAlbedo: 0.77, pressureBar: 92, molarMass: 43.45, meanTempC: 464, solarDayH: 2802.0 },
  earth: { massKg: 5.9722e24, radiusKm: 6371.0, rotationH: 23.9345, tiltDeg: 23.44, aAU: 1, bondAlbedo: 0.306, pressureBar: 1.014, molarMass: 28.97, meanTempC: 15, orbitDays: 365.256 },
  mars: { massKg: 0.64169e24, radiusKm: 3389.5, rotationH: 24.6229, tiltDeg: 25.19, aAU: 1.524, bondAlbedo: 0.25, pressureBar: 0.00636, molarMass: 43.34, meanTempC: -65, orbitDays: 686.98 },
  jupiter: { rotationH: 9.925, aAU: 5.203, molarMass: 2.22 },
  uranus: { tiltDeg: 97.77 },
  moon: { bondAlbedo: 0.11 },
} as const;

const sig3 = (v: number) => Number(v.toPrecision(3));
const massRatio = (kg: number) => sig3(kg / REFERENCE.earth.massKg);
const radiusRatio = (km: number) => sig3(km / REFERENCE.earth.radiusKm);

// ---------------------------------------------------------------------------
// Closed-form physics (exported for tests and the view)
// ---------------------------------------------------------------------------

/** Stellar flux at distance a (AU) from a star of luminosity L (L☉), in W/m². */
export function stellarFlux(lSun: number, aAU: number): number {
  const a = aAU * CONST.AU;
  return (lSun * CONST.L_SUN) / (4 * Math.PI * a * a);
}

/** Global-mean radiative equilibrium temperature (K) for flux S (W/m²) and Bond albedo A. */
export function equilibriumTemperature(S: number, albedo: number): number {
  return Math.pow((S * (1 - albedo)) / (4 * CONST.SIGMA), 0.25);
}

/** Gray-atmosphere (Eddington) surface temperature for infrared optical depth τ. */
export function grayGreenhouseTemperature(teq: number, tau: number): number {
  return teq * Math.pow(1 + 0.75 * tau, 0.25);
}

/** Optical depth τ for which the gray model turns T_eq into the observed T_s. */
export function calibrateTau(teq: number, ts: number): number {
  return (Math.pow(ts / teq, 4) - 1) / 0.75;
}

/** Earth's equilibrium temperature with this model's own formula (S at 1 AU from 1 L☉, A = 0.3). */
export const EARTH_TEQ = equilibriumTemperature(stellarFlux(1, 1), 0.3);
/** τ calibrated so Earth's T_eq becomes the fact-sheet mean surface temperature (15 °C). */
export const TAU_EARTH = Math.round(calibrateTau(EARTH_TEQ, 273.15 + REFERENCE.earth.meanTempC) * 1000) / 1000;
/** τ that reproduces Venus's fact-sheet mean surface temperature (a curve fit, not a physical retrieval). */
export const TAU_VENUS = Math.round(
  calibrateTau(equilibriumTemperature(stellarFlux(1, REFERENCE.venus.aAU), REFERENCE.venus.bondAlbedo), 273.15 + REFERENCE.venus.meanTempC) * 10,
) / 10;

/**
 * Mean solar day (h) from the sidereal rotation period and the orbital period.
 * Retrograde spin (tilt > 90°) adds the orbital motion instead of subtracting it.
 * Returns ±Infinity for synchronous (tidally locked) rotation; a negative value
 * means the star moves backwards across the sky (rises in the west).
 */
export function solarDayHours(siderealH: number, orbitH: number, tiltDeg: number): number {
  const c = Math.cos(tiltDeg * DEG);
  const sense = Math.abs(c) < 1e-9 ? 0 : Math.sign(c);
  const inv = 1 / siderealH - sense / orbitH;
  if (Math.abs(inv) * siderealH < 1e-12) return Infinity;
  return 1 / inv;
}

/** Sunset hour angle h₀ (rad): 0 = polar night, π = polar day. */
export function sunsetHourAngle(latR: number, declR: number): number {
  const n = Math.sin(latR) * Math.sin(declR);
  const d = Math.cos(latR) * Math.cos(declR);
  if (d <= 1e-12) return n > 1e-15 ? Math.PI : n < -1e-15 ? 0 : Math.PI / 2;
  const x = -n / d;
  if (x >= 1) return 0;
  if (x <= -1) return Math.PI;
  return Math.acos(x);
}

/** Daily-mean top-of-atmosphere insolation (W/m²) at latitude φ for declination δ. */
export function dailyMeanInsolation(S: number, latR: number, declR: number): number {
  const h0 = sunsetHourAngle(latR, declR);
  const q = (S / Math.PI) * (h0 * Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.sin(h0));
  return Math.max(0, q);
}

/**
 * Boiling point of water (K) at pressure p (bar) from the Antoine equation
 * (standard tabulated constants for 1–100 °C and 99–374 °C). NaN below the
 * triple-point pressure (no liquid) and above the critical pressure (no
 * distinct boiling).
 */
export function waterBoilingPointK(pBar: number): number {
  if (!(pBar >= CONST.P_TRIPLE_BAR) || pBar > CONST.P_CRIT_BAR) return NaN;
  const mmHg = (pBar * 1e5) / 133.322;
  const [A, B, C] = mmHg <= 760 ? [8.07131, 1730.63, 233.426] : [8.14019, 1810.94, 244.485];
  const tK = B / (A - Math.log10(mmHg)) - C + 273.15;
  return Math.min(CONST.T_CRIT, Math.max(CONST.T_TRIPLE, tK));
}

// ---------------------------------------------------------------------------
// Elevation data (prepare) — Earth's hypsometric curve
// ---------------------------------------------------------------------------

let hypsometry: Hypsometry | null = null;
let hypsometryPromise: Promise<void> | null = null;
let hypsometryError: string | null = null;

/** The cached hypsometric curve, or null if the elevation dataset is not loaded. */
export function getHypsometry(): Hypsometry | null {
  return hypsometry;
}

/** Error message from the last failed dataset load, if any. */
export function getHypsometryError(): string | null {
  return hypsometryError;
}

/** Inject a hypsometric curve (tests, or a host that already loaded the grid). */
export function setHypsometry(h: Hypsometry | null) {
  hypsometry = h;
  hypsometryError = null;
}

/** Load ETOPO1 once and build the curve. Never rejects: without data the model still runs. */
export function preparePlanetData(): Promise<void> {
  if (hypsometry) return Promise.resolve();
  if (!hypsometryPromise) {
    hypsometryPromise = loadElevation()
      .then((g) => {
        hypsometry = buildHypsometry(g.data, g.ncols, g.nrows, (r) => nodeAreaKm2(g, r));
        hypsometryError = null;
      })
      .catch((err: unknown) => {
        hypsometryError = err instanceof Error ? err.message : String(err);
        hypsometryPromise = null; // allow a retry
      });
  }
  return hypsometryPromise ?? Promise.resolve();
}

/** Sea-level change (m) on Earth's present terrain for a water coverage in %, or NaN without data. */
export function seaLevelForCoverage(percent: number): number {
  return hypsometry ? seaLevelForWaterFraction(hypsometry, percent / 100) : NaN;
}

// ---------------------------------------------------------------------------
// Configuration: everything computed from parameters, cached per params object
// ---------------------------------------------------------------------------

export const OBSERVERS: Record<string, { lat: number; lon: number; label: string }> = {
  equator: { lat: 0, lon: 0, label: 'Equator (0°)' },
  tropic: { lat: 23.44, lon: 0, label: '23.4°N (Tropic of Cancer)' },
  lat45: { lat: 45, lon: 0, label: '45°N' },
  arctic: { lat: 66.56, lon: 0, label: 'Arctic Circle (66.6°N)' },
  pole: { lat: 90, lon: 0, label: 'North Pole' },
};

const START_SEASONS: Record<string, number> = {
  'march-equinox': 0,
  'june-solstice': 1,
  'september-equinox': 2,
  'december-solstice': 3,
};

export type { WaterAppearance };

export interface PlanetConfig {
  mass: number;
  radius: number;
  /** GM of the planet (m³/s²) and radius (m). */
  gm: number;
  rM: number;
  g: number;
  vEsc: number;
  /** kg/m³ */
  density: number;
  aAU: number;
  /** Orbital period (h) and circular orbital speed (m/s). */
  orbitH: number;
  vOrb: number;
  locked: boolean;
  siderealH: number;
  /** Signed mean solar day (h); ±Infinity when tidally locked. */
  solarH: number;
  tiltDeg: number;
  eps: number;
  S: number;
  albedo: number;
  tau: number;
  teq: number;
  ts: number;
  override: boolean;
  pBar: number;
  molar: number;
  /** Scale height (m), column mass (kg/m²), total atmosphere mass (kg). */
  scaleHeight: number;
  column: number;
  atmMass: number;
  omega: number;
  /** Equatorial centrifugal acceleration ÷ gravity. */
  q: number;
  breakupH: number;
  water: number;
  lat: number;
  lon: number;
  boil: number;
  waterState: WaterAppearance;
  startIndex: number;
  durationH: number;
}

const cfgCache = new WeakMap<ParamValues, PlanetConfig>();

export function observerLatLon(p: ParamValues): { lat: number; lon: number } {
  const key = str(p, 'observer');
  if (key === 'custom') return { lat: num(p, 'obsLat'), lon: num(p, 'obsLon') };
  const o = OBSERVERS[key] ?? OBSERVERS.lat45;
  return { lat: o.lat, lon: o.lon };
}

/** Whether open water could be liquid at the global-mean surface temperature (a coarse check). */
export function waterAppearanceFor(ts: number, pBar: number): WaterAppearance {
  if (pBar < CONST.P_TRIPLE_BAR) return 'none';
  if (pBar > CONST.P_CRIT_BAR) return ts >= CONST.T_CRIT ? 'none' : ts < CONST.T_FREEZE ? 'ice' : 'liquid';
  const boil = waterBoilingPointK(pBar);
  if (ts >= boil) return 'none';
  return ts < CONST.T_FREEZE ? 'ice' : 'liquid';
}

export function planetConfig(p: ParamValues): PlanetConfig {
  const hit = cfgCache.get(p);
  if (hit) return hit;
  const mass = num(p, 'mass');
  const radius = num(p, 'radius');
  const gm = CONST.GM_EARTH * mass;
  const rM = CONST.R_EARTH * radius;
  const g = gm / (rM * rM);
  const vEsc = Math.sqrt((2 * gm) / rM);
  const density = (mass * REFERENCE.earth.massKg) / ((4 / 3) * Math.PI * rM ** 3);
  const aAU = num(p, 'distance');
  const aM = aAU * CONST.AU;
  const gmTotal = CONST.GM_SUN * num(p, 'starMass') + gm;
  const orbitH = (TWO_PI * Math.sqrt((aM * aM * aM) / gmTotal)) / 3600;
  const vOrb = Math.sqrt(gmTotal / aM);
  const locked = bool(p, 'tidallyLocked');
  const siderealH = locked ? orbitH : num(p, 'rotationPeriod');
  const tiltDeg = num(p, 'tilt');
  const solarH = solarDayHours(siderealH, orbitH, tiltDeg);
  const S = stellarFlux(num(p, 'luminosity'), aAU);
  const albedo = num(p, 'albedo');
  const tau = num(p, 'tau');
  const teq = equilibriumTemperature(S, albedo);
  const override = bool(p, 'tempOverride');
  const ts = override ? num(p, 'surfaceTempSet') : grayGreenhouseTemperature(teq, tau);
  const pBar = num(p, 'pressure');
  const molar = num(p, 'molarMass');
  const scaleHeight = (CONST.R_GAS * ts) / ((molar / 1000) * g);
  const column = (pBar * 1e5) / g;
  const atmMass = 4 * Math.PI * rM * rM * column;
  const omega = TWO_PI / (siderealH * 3600);
  const q = (omega * omega * rM) / g;
  const breakupH = (TWO_PI * Math.sqrt((rM * rM * rM) / gm)) / 3600;
  const { lat, lon } = observerLatLon(p);
  const cfg: PlanetConfig = {
    mass,
    radius,
    gm,
    rM,
    g,
    vEsc,
    density,
    aAU,
    orbitH,
    vOrb,
    locked,
    siderealH,
    solarH,
    tiltDeg,
    eps: tiltDeg * DEG,
    S,
    albedo,
    tau,
    teq,
    ts,
    override,
    pBar,
    molar,
    scaleHeight,
    column,
    atmMass,
    omega,
    q,
    breakupH,
    water: num(p, 'water'),
    lat,
    lon,
    boil: waterBoilingPointK(pBar),
    waterState: waterAppearanceFor(ts, pBar),
    startIndex: START_SEASONS[str(p, 'startSeason')] ?? 0,
    durationH: num(p, 'duration') * 24,
  };
  cfgCache.set(p, cfg);
  return cfg;
}

/** Engine step (h): the requested step, but never coarser than 1/48 of a rotation or solar day. */
function stepHours(p: ParamValues): number {
  const c = planetConfig(p);
  let dt = num(p, 'dt');
  for (const T of [c.siderealH, Math.abs(c.solarH), c.orbitH / 4]) if (Number.isFinite(T) && T > 0) dt = Math.min(dt, T / 48);
  return dt;
}

function sampleHours(p: ParamValues): number {
  const c = planetConfig(p);
  const day = Number.isFinite(c.solarH) ? Math.min(Math.abs(c.solarH), c.siderealH) : c.siderealH;
  return Math.max(stepHours(p), Math.min(1, day / 24));
}

// ---------------------------------------------------------------------------
// State and sky geometry
// ---------------------------------------------------------------------------

export interface PlanetState {
  /** Model time (h). */
  t: number;
  /**
   * Sidereal rotation angle θ (rad, in [0, 2π)): right ascension of the prime
   * meridian measured from the equinox direction about the spin axis.
   */
  rot: number;
  /** Sidereal rotations completed (fractional). */
  rotations: number;
  rotationsAtYear: number;
  /** Solar days elapsed (fractional; integrates 1/|T_sol|). */
  solarDays: number;
  /** Star's apparent ecliptic longitude at t = 0 (rad); 0 = northern spring equinox. */
  lambda0: number;
  /** Orbital angle travelled since t = 0 (rad, unwrapped). */
  orbit: number;
  years: number;
  lastYearT: number;
  /** Length of the last completed orbit (days), NaN before the first. */
  yearLength: number;
  sunrises: number;
  sunsets: number;
  lastSunriseT: number;
  /** Star elevation (rad) at the observation point at time t. */
  elev: number;
  /** Highest and lowest elevation (rad) reached at the current observation point, checked every step. */
  elevMax: number;
  elevMin: number;
  /** −1 polar night, 0 normal day/night cycle, +1 polar day. */
  polar: number;
  /** Observer and tilt used by the last step (to suppress false crossings after a change). */
  obsLat: number;
  obsLon: number;
  tilt: number;
  /** Report every n-th sunrise/sunset after the first three (all are counted). */
  reportEvery: number;
  pending: SimEvent[];
}

export interface Sky {
  /** Star's apparent ecliptic longitude (rad, [0, 2π)). */
  lambda: number;
  decl: number;
  /** Star elevation at the observer (rad). */
  elev: number;
  /** Local hour angle (rad, (−π, π]); 0 = local noon. */
  hourAngle: number;
  subsolarLat: number;
  subsolarLon: number;
}

function wrapPi(a: number): number {
  let x = (a + Math.PI) % TWO_PI;
  if (x < 0) x += TWO_PI;
  return x - Math.PI;
}

function wrap2Pi(a: number): number {
  const x = a % TWO_PI;
  return x < 0 ? x + TWO_PI : x;
}

/** Star direction in equatorial coordinates from ecliptic longitude λ and obliquity ε. */
function starRaDec(lambda: number, eps: number): { ra: number; decl: number } {
  const sl = Math.sin(lambda);
  return { ra: Math.atan2(Math.cos(eps) * sl, Math.cos(lambda)), decl: Math.asin(Math.max(-1, Math.min(1, Math.sin(eps) * sl))) };
}

export function skyAt(rot: number, lambda: number, eps: number, latDeg: number, lonDeg: number): Sky {
  const { ra, decl } = starRaDec(lambda, eps);
  const phi = latDeg * DEG;
  const H = wrapPi(rot + lonDeg * DEG - ra);
  const sinE = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  return {
    lambda: wrap2Pi(lambda),
    decl,
    elev: Math.asin(Math.max(-1, Math.min(1, sinE))),
    hourAngle: H,
    subsolarLat: decl,
    subsolarLon: wrapPi(ra - rot),
  };
}

export function skyOf(s: PlanetState, c: PlanetConfig): Sky {
  return skyAt(s.rot, s.lambda0 + s.orbit, c.eps, c.lat, c.lon);
}

function polarCode(c: PlanetConfig, decl: number): number {
  if (!Number.isFinite(c.solarH)) return 0;
  const h0 = sunsetHourAngle(c.lat * DEG, decl);
  return h0 === 0 ? -1 : h0 === Math.PI ? 1 : 0;
}

const fmt = (v: number, sig = 3) => formatNumber(v, sig);

function latLonText(lat: number, lon: number): string {
  const la = `${fmt(Math.abs(lat), 3)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${fmt(Math.abs(lon), 3)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la}, ${lo}`;
}

const SEASON_POINTS = [
  { id: 'march-equinox', label: 'Northern spring equinox', earth: "Earth's March equinox", what: 'The star crosses the equator heading north; day and night are equal everywhere.' },
  { id: 'june-solstice', label: 'Northern summer solstice', earth: "Earth's June solstice", what: 'The star is furthest north; northern days are longest.' },
  { id: 'september-equinox', label: 'Northern autumn equinox', earth: "Earth's September equinox", what: 'The star crosses the equator heading south.' },
  { id: 'december-solstice', label: 'Northern winter solstice', earth: "Earth's December solstice", what: 'The star is furthest south; northern days are shortest.' },
];

/** Name of the northern-hemisphere season for an ecliptic longitude (deg). */
export function seasonName(lambdaDeg: number, tiltDeg: number): string {
  if (tiltDeg < 0.05 || tiltDeg > 179.95) return 'No seasons (no axial tilt)';
  const l = ((lambdaDeg % 360) + 360) % 360;
  return ['Northern spring', 'Northern summer', 'Northern autumn', 'Northern winter'][Math.floor(l / 90) % 4];
}

function polarEvents(s: PlanetState, from: number, to: number, t: number, decl: number, lat: number): void {
  const d = `Declination ${fmt(decl / DEG)}°, observation latitude ${fmt(lat)}°.`;
  const push = (id: string, label: string, detail: string) =>
    s.pending.push({ t, id: `${id}-${s.pending.length}-${Math.round(t * 100)}`, label, detail, severity: 'milestone', source: 'model' });
  if (from === 1) push('polar-day-end', 'Polar day ends at the observation point', `The star sets again during each rotation. ${d}`);
  if (from === -1) push('polar-night-end', 'Polar night ends at the observation point', `The star rises again during each rotation. ${d}`);
  if (to === 1) push('polar-day', 'Polar day begins at the observation point', `The star stays above the horizon for a whole rotation. ${d}`);
  if (to === -1) push('polar-night', 'Polar night begins at the observation point', `The star stays below the horizon for a whole rotation. ${d}`);
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const params: ParamDef[] = [
  // Planet body
  { key: 'mass', label: 'Planet mass', type: 'number', unit: 'M_earth', kind: 'live', group: 'Planet', min: 0.01, max: 30, step: 0.001, default: 1, scale: 'log',
    description: 'Independent input. Together with the radius it sets surface gravity, density and escape velocity (calculated, see derived values).',
    marks: [
      { value: massRatio(REFERENCE.mercury.massKg), label: 'Mercury' },
      { value: massRatio(REFERENCE.mars.massKg), label: 'Mars' },
      { value: massRatio(REFERENCE.venus.massKg), label: 'Venus' },
      { value: 1, label: 'Earth' },
    ] },
  { key: 'radius', label: 'Planet radius', type: 'number', unit: 'R_earth', kind: 'live', group: 'Planet', min: 0.1, max: 5, step: 0.001, default: 1,
    description: 'Independent input (mean radius). Changing it changes gravity through g = GM/R², even at the same mass.',
    marks: [
      { value: radiusRatio(REFERENCE.mercury.radiusKm), label: 'Mercury' },
      { value: radiusRatio(REFERENCE.mars.radiusKm), label: 'Mars' },
      { value: radiusRatio(REFERENCE.venus.radiusKm), label: 'Venus' },
      { value: 1, label: 'Earth' },
    ] },
  { key: 'tidallyLocked', label: 'Tidally locked (rotation = orbit)', type: 'boolean', kind: 'live', group: 'Rotation', default: false,
    description: 'Make the sidereal rotation period equal to the calculated orbital period, so one face always points at the star.' },
  { key: 'rotationPeriod', label: 'Sidereal rotation period', type: 'number', unit: 'h', kind: 'live', group: 'Rotation', min: 1, max: 10000, step: 0.001, default: REFERENCE.earth.rotationH, scale: 'log',
    description: 'Time for one turn relative to the distant stars. The solar day (sunrise to sunrise) is calculated from this and the orbital period.',
    visibleWhen: (p) => !bool(p, 'tidallyLocked'),
    marks: [
      { value: REFERENCE.jupiter.rotationH, label: 'Jupiter' },
      { value: REFERENCE.earth.rotationH, label: 'Earth' },
      { value: REFERENCE.mars.rotationH, label: 'Mars' },
      { value: REFERENCE.mercury.rotationH, label: 'Mercury' },
      { value: REFERENCE.venus.rotationH, label: 'Venus (with 177° tilt)' },
    ] },
  { key: 'tilt', label: 'Axial tilt (obliquity)', type: 'number', unit: 'deg', kind: 'live', group: 'Rotation', min: 0, max: 180, step: 0.01, default: REFERENCE.earth.tiltDeg,
    description: 'Angle between the spin axis and the perpendicular to the orbit. It causes the seasons. Above 90° the planet spins backwards (retrograde), like Venus.',
    marks: [
      { value: 0, label: 'None' },
      { value: REFERENCE.earth.tiltDeg, label: 'Earth' },
      { value: REFERENCE.mars.tiltDeg, label: 'Mars' },
      { value: REFERENCE.uranus.tiltDeg, label: 'Uranus' },
      { value: REFERENCE.venus.tiltDeg, label: 'Venus' },
    ] },
  // Orbit and star
  { key: 'distance', label: 'Orbital distance', type: 'number', unit: 'AU', kind: 'live', group: 'Orbit & star', min: 0.05, max: 50, step: 0.001, default: 1, scale: 'log',
    description: 'Radius of the circular orbit. Sets the orbital period (Kepler III) and the stellar flux (inverse-square law).',
    marks: [
      { value: REFERENCE.mercury.aAU, label: 'Mercury' },
      { value: REFERENCE.venus.aAU, label: 'Venus' },
      { value: 1, label: 'Earth' },
      { value: REFERENCE.mars.aAU, label: 'Mars' },
      { value: REFERENCE.jupiter.aAU, label: 'Jupiter' },
    ] },
  { key: 'starMass', label: 'Star mass', type: 'number', unit: 'M_sun', kind: 'live', group: 'Orbit & star', min: 0.08, max: 10, step: 0.001, default: 1, scale: 'log',
    description: 'Sets the orbital period at a given distance. Independent of luminosity here; real main-sequence stars tie the two together (see warnings).',
    marks: [{ value: 1, label: 'Sun' }] },
  { key: 'luminosity', label: 'Star luminosity', type: 'number', unit: 'L_sun', kind: 'live', group: 'Orbit & star', min: 0.0001, max: 1000, step: 0.0001, default: 1, scale: 'log',
    description: 'Total power the star emits. With distance it sets the flux the planet receives, S = L/(4πa²).',
    marks: [{ value: 1, label: 'Sun' }, { value: 2, label: '2× Sun' }] },
  { key: 'startSeason', label: 'Orbital position at start', type: 'choice', kind: 'initial', group: 'Orbit & star', default: 'march-equinox',
    description: 'Where on its orbit the planet is at t = 0. The run starts at local midnight at longitude 0°.',
    options: [
      { value: 'march-equinox', label: 'Northern spring equinox', description: "Earth's March equinox." },
      { value: 'june-solstice', label: 'Northern summer solstice', description: "Earth's June solstice." },
      { value: 'september-equinox', label: 'Northern autumn equinox', description: "Earth's September equinox." },
      { value: 'december-solstice', label: 'Northern winter solstice', description: "Earth's December solstice." },
    ] },
  // Climate (energy balance)
  { key: 'albedo', label: 'Bond albedo', type: 'number', unit: '1', kind: 'live', group: 'Energy balance', min: 0, max: 0.95, step: 0.001, default: 0.3,
    description: 'Fraction of incoming starlight reflected to space. Earth ≈ 0.3 (NASA fact sheet: 0.306). Not changed automatically by ice, clouds or water.',
    marks: [
      { value: REFERENCE.moon.bondAlbedo, label: 'Moon' },
      { value: REFERENCE.mars.bondAlbedo, label: 'Mars' },
      { value: 0.3, label: 'Earth' },
      { value: REFERENCE.venus.bondAlbedo, label: 'Venus' },
    ] },
  { key: 'tau', label: 'Greenhouse infrared optical depth τ', type: 'number', unit: '1', kind: 'live', group: 'Energy balance', min: 0, max: 200, step: 0.001, default: TAU_EARTH,
    description: `Gray-atmosphere parameter in T_s = T_eq(1 + ¾τ)^¼. The default (${TAU_EARTH}) is calibrated so Earth's equilibrium temperature gives its observed 15 °C mean. Not linked to pressure or composition.`,
    visibleWhen: (p) => !bool(p, 'tempOverride'),
    marks: [
      { value: 0, label: 'None' },
      { value: TAU_EARTH, label: 'Earth (calibrated)' },
      { value: TAU_VENUS, label: 'Venus (fit)' },
    ] },
  { key: 'tempOverride', label: 'Set surface temperature directly', type: 'boolean', kind: 'live', group: 'Energy balance', default: false,
    description: 'Override: bypass the energy balance and use the temperature below. Labelled as an override wherever it is shown.' },
  { key: 'surfaceTempSet', label: 'Surface temperature (override)', type: 'number', unit: 'K', kind: 'live', group: 'Energy balance', min: 20, max: 2000, step: 0.1, default: 288,
    description: 'Mean surface temperature used instead of the energy-balance estimate.', visibleWhen: (p) => bool(p, 'tempOverride') },
  // Atmosphere and water
  { key: 'pressure', label: 'Surface pressure', type: 'number', unit: 'bar', kind: 'live', group: 'Atmosphere & water', min: 0, max: 100, step: 0.00001, default: REFERENCE.earth.pressureBar,
    description: 'Sets the atmospheric column mass (P/g) and water’s boiling point. It does not change τ in this model.',
    marks: [
      { value: 0, label: 'None' },
      { value: REFERENCE.mars.pressureBar, label: 'Mars' },
      { value: REFERENCE.earth.pressureBar, label: 'Earth' },
      { value: REFERENCE.venus.pressureBar, label: 'Venus' },
    ] },
  { key: 'molarMass', label: 'Mean molecular mass of the air', type: 'number', unit: 'g/mol', kind: 'live', group: 'Atmosphere & water', min: 2, max: 100, step: 0.01, default: REFERENCE.earth.molarMass,
    description: 'Average molar mass of the atmosphere. Heavier gases give a thinner (smaller scale height) atmosphere and escape less easily.',
    marks: [
      { value: REFERENCE.jupiter.molarMass, label: 'H₂/He (Jupiter)' },
      { value: REFERENCE.earth.molarMass, label: 'Earth' },
      { value: REFERENCE.mars.molarMass, label: 'Mars' },
    ] },
  { key: 'water', label: 'Surface water coverage', type: 'number', unit: '%', kind: 'live', group: 'Atmosphere & water', min: 0, max: 100, step: 0.01, default: 70.95,
    description: "Fraction of the surface under water, applied to Earth's real terrain: the lab finds the sea level that floods exactly this fraction (default = today's ocean fraction in the ETOPO1 grid).",
    marks: [{ value: 0, label: 'Dry' }, { value: 70.95, label: 'Earth today' }, { value: 100, label: 'All ocean' }] },
  // Observation
  { key: 'observer', label: 'Observation point', type: 'choice', kind: 'live', group: 'Observation', default: 'lat45',
    description: 'Where on the surface the sky is followed. Click the globe to pick any point.',
    options: [
      ...Object.entries(OBSERVERS).map(([value, o]) => ({ value, label: o.label })),
      { value: 'custom', label: 'Custom latitude/longitude' },
    ] },
  { key: 'obsLat', label: 'Latitude', type: 'number', unit: 'deg', kind: 'live', group: 'Observation', min: -90, max: 90, step: 0.1, default: 45,
    description: 'Positive north of the equator (defined by the spin axis).', visibleWhen: (p) => str(p, 'observer') === 'custom' },
  { key: 'obsLon', label: 'Longitude', type: 'number', unit: 'deg', kind: 'live', group: 'Observation', min: -180, max: 180, step: 0.1, default: 0,
    description: 'Positive east of the prime meridian.', visibleWhen: (p) => str(p, 'observer') === 'custom' },
  // Numerics
  { key: 'duration', label: 'Simulation duration', type: 'number', unit: 'day', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 4000, step: 1, default: 366,
    description: 'Run length in 24-hour days. Use at least one orbital period to see a full cycle of seasons.' },
  { key: 'dt', label: 'Time step (upper limit)', type: 'number', unit: 'h', kind: 'initial', group: 'Numerics', numerics: true, min: 0.005, max: 2, step: 0.005, default: 0.1,
    description: 'Largest fixed step. The model never uses more than 1/48 of a rotation or solar day per step; sunrise, season and orbit events are interpolated within a step.' },
];

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export const planetModel: SimulationModel<PlanetState> = {
  id: 'planet',
  name: 'Planet Lab',
  shortName: 'Planet Lab',
  domain: 'astronomy',
  viewKind: '3d',
  summary:
    'Configure a planet, its star and orbit. Gravity, density, orbital period, day length, insolation and temperature are calculated from the inputs; rotation and orbit then drive the sky, seasons and daylight at any point on the surface.',
  params,
  observables: [
    { key: 'elevation', label: 'Star elevation at the observation point', unit: 'deg', provenance: 'simulated', chart: true, chartGroup: 'angle', sig: 3, description: 'Angle of the star’s centre above the geometric horizon; negative when it is below.' },
    { key: 'elevationMax', label: 'Highest star elevation so far', unit: 'deg', provenance: 'simulated', chartGroup: 'angle', sig: 3, description: 'Maximum reached at the current observation point, checked at every time step (resets when the point moves).' },
    { key: 'elevationMin', label: 'Lowest star elevation so far', unit: 'deg', provenance: 'simulated', chartGroup: 'angle', sig: 3 },
    { key: 'declination', label: 'Star declination', unit: 'deg', provenance: 'simulated', chart: true, chartGroup: 'angle', sig: 3, description: 'Latitude where the star is overhead: δ = asin(sin ε sin λ).' },
    { key: 'insolation', label: 'Insolation now (top of atmosphere)', unit: 'W/m2', provenance: 'simulated', chart: true, chartGroup: 'flux', sig: 3, description: 'S · max(0, sin elevation) on a horizontal surface at the observation point.' },
    { key: 'dailyInsolation', label: 'Daily-mean insolation at this latitude', unit: 'W/m2', provenance: 'derived', chart: true, chartGroup: 'flux', sig: 3, description: 'Average over one solar day at the current declination. Not defined for a tidally locked planet.' },
    { key: 'daylight', label: 'Daylight per solar day', unit: 'h', provenance: 'derived', chart: true, chartGroup: 'daylight', sig: 3, description: 'Hours with the star above the horizon during one solar day at the current declination.' },
    { key: 'hourAngle', label: 'Star hour angle (0 = local noon)', unit: 'deg', provenance: 'simulated', chartGroup: 'hour', sig: 3 },
    { key: 'orbitLongitude', label: 'Orbital position (0° = northern spring equinox)', unit: 'deg', provenance: 'simulated', chartGroup: 'orbit', sig: 3, description: 'Apparent ecliptic longitude of the star: 90° northern summer solstice, 180° autumn equinox, 270° winter solstice.' },
    { key: 'subsolarLat', label: 'Subsolar latitude', unit: 'deg', provenance: 'simulated', chartGroup: 'angle', sig: 3 },
    { key: 'subsolarLon', label: 'Subsolar longitude', unit: 'deg', provenance: 'simulated', chartGroup: 'orbit', sig: 3 },
    { key: 'obsLat', label: 'Observation latitude', unit: 'deg', provenance: 'assumed', chartGroup: 'observer', sig: 3 },
    { key: 'obsLon', label: 'Observation longitude', unit: 'deg', provenance: 'assumed', chartGroup: 'observer', sig: 4 },
    { key: 'solarDays', label: 'Solar days elapsed', unit: 'count', provenance: 'simulated', chartGroup: 'counts', sig: 4 },
    { key: 'rotations', label: 'Sidereal rotations elapsed', unit: 'count', provenance: 'simulated', chartGroup: 'counts', sig: 4 },
    { key: 'sunrises', label: 'Sunrises at the observation point', unit: 'count', provenance: 'simulated', chartGroup: 'counts', sig: 4 },
    { key: 'years', label: 'Orbits completed', unit: 'count', provenance: 'simulated', chartGroup: 'counts', sig: 3 },
    { key: 'yearLength', label: 'Length of the last completed orbit', unit: 'day', provenance: 'simulated', chartGroup: 'year', sig: 5 },
    { key: 'stellarFlux', label: 'Stellar flux at the planet', unit: 'W/m2', provenance: 'derived', chartGroup: 'flux', sig: 4 },
    { key: 'surfaceTemp', label: 'Estimated mean surface temperature', unit: 'K', provenance: 'derived', chartGroup: 'temp', sig: 3 },
    { key: 'gravity', label: 'Surface gravity', unit: 'm/s2', provenance: 'derived', chartGroup: 'gravity', sig: 3 },
  ],
  primaryObservables: ['daylight', 'dailyInsolation', 'elevation'],
  time: {
    unit: 'h',
    dt: stepHours,
    sampleInterval: sampleHours,
    defaultDuration: (p) => num(p, 'duration') * 24,
    maxDuration: 4000 * 24,
    realtimeRate: 2,
    milestones: (p) => {
      const D = num(p, 'duration') * 24;
      return [0.25, 0.5, 0.75].map((f) => f * D);
    },
  },

  prepare: preparePlanetData,

  init(p) {
    const c = planetConfig(p);
    const lambda0 = (c.startIndex * Math.PI) / 2;
    const { ra } = starRaDec(lambda0, c.eps);
    // Start at local midnight on the prime meridian: hour angle π at longitude 0.
    const rot = wrap2Pi(ra + Math.PI);
    const expectedDays = Number.isFinite(c.solarH) ? c.durationH / Math.abs(c.solarH) : 0;
    const s: PlanetState = {
      t: 0,
      rot,
      rotations: 0,
      rotationsAtYear: 0,
      solarDays: 0,
      lambda0,
      orbit: 0,
      years: 0,
      lastYearT: 0,
      yearLength: NaN,
      sunrises: 0,
      sunsets: 0,
      lastSunriseT: NaN,
      elev: 0,
      elevMax: -Infinity,
      elevMin: Infinity,
      polar: 0,
      obsLat: c.lat,
      obsLon: c.lon,
      tilt: c.tiltDeg,
      reportEvery: expectedDays <= 30 ? 1 : Math.ceil(expectedDays / 20),
      pending: [],
    };
    const sky = skyOf(s, c);
    s.elev = sky.elev;
    s.elevMax = sky.elev;
    s.elevMin = sky.elev;
    s.polar = polarCode(c, sky.decl);
    const sp = SEASON_POINTS[c.startIndex];
    s.pending.push({ t: 0, id: 'start', label: `Start: ${sp.label.toLowerCase()}`, detail: `${sp.what} (${sp.earth}.) Local midnight at longitude 0°.`, severity: 'info', source: 'model' });
    if (c.tiltDeg < 0.05 || c.tiltDeg > 179.95) {
      s.pending.push({ t: 0, id: 'no-tilt', label: 'No axial tilt: no seasons', detail: 'The star stays over the equator all year, so day length and the star’s noon height never change at any latitude.', severity: 'info', source: 'model' });
    }
    if (!Number.isFinite(c.solarH)) {
      s.pending.push({
        t: 0,
        id: 'locked',
        label: 'Tidally locked: the star does not rise or set',
        detail: `At the observation point it stays ${sky.elev >= 0 ? `${fmt(sky.elev / DEG)}° above` : `${fmt(-sky.elev / DEG)}° below`} the horizon${c.tiltDeg >= 0.05 ? ', apart from a small yearly wobble caused by the tilt' : ''}.`,
        severity: 'info',
        source: 'model',
      });
    } else if (s.polar !== 0) {
      s.pending.push({
        t: 0,
        id: s.polar > 0 ? 'polar-day-start' : 'polar-night-start',
        label: s.polar > 0 ? 'Polar day at the observation point' : 'Polar night at the observation point',
        detail: `At the start the star ${s.polar > 0 ? 'stays above' : 'stays below'} the horizon for a whole rotation (declination ${fmt(sky.decl / DEG)}°, latitude ${fmt(c.lat)}°).`,
        severity: 'milestone',
        source: 'model',
      });
    }
    return s;
  },

  step(s, p, dt) {
    const c = planetConfig(p);
    const t0 = s.t;
    const e0 = s.elev;
    const orb0 = s.orbit;
    const rate = TWO_PI / c.orbitH;
    s.rot = wrap2Pi(s.rot + (TWO_PI * dt) / c.siderealH);
    s.rotations += dt / c.siderealH;
    if (Number.isFinite(c.solarH)) s.solarDays += dt / Math.abs(c.solarH);
    s.orbit += rate * dt;
    s.t = t0 + dt;
    const sky = skyOf(s, c);
    s.elev = sky.elev;

    const moved = c.lat !== s.obsLat || c.lon !== s.obsLon;
    if (moved || c.tiltDeg !== s.tilt) {
      // A parameter jump is not a sunrise: re-baseline without reporting crossings.
      if (moved) {
        s.pending.push({ t: s.t, id: `observer-${Math.round(s.t * 1000)}`, label: 'Observation point moved', detail: `Now following the sky at ${latLonText(c.lat, c.lon)}.`, severity: 'info', source: 'user' });
      }
      s.obsLat = c.lat;
      s.obsLon = c.lon;
      s.tilt = c.tiltDeg;
      s.polar = polarCode(c, sky.decl);
      s.lastSunriseT = NaN;
      s.elevMax = sky.elev;
      s.elevMin = sky.elev;
    } else {
      if (sky.elev > s.elevMax) s.elevMax = sky.elev;
      if (sky.elev < s.elevMin) s.elevMin = sky.elev;
      const e1 = sky.elev;
      if ((e0 < 0 && e1 >= 0) || (e0 >= 0 && e1 < 0)) {
        const tc = t0 + (dt * e0) / (e0 - e1 || 1);
        const day = Number.isFinite(c.solarH) ? Math.floor(s.solarDays - (s.t - tc) / Math.abs(c.solarH)) + 1 : NaN;
        const dayText = Number.isFinite(day) ? ` (solar day ${day})` : '';
        const every = s.reportEvery;
        if (e1 >= 0) {
          s.sunrises++;
          s.lastSunriseT = tc;
          const n = s.sunrises;
          if (n <= 3 || n % every === 0) {
            s.pending.push({
              t: tc,
              id: `sunrise-${n}`,
              label: `Sunrise ${n} at the observation point`,
              detail: `At t = ${fmt(tc, 4)} h${dayText}.${n === 3 && every > 1 ? ` Further sunrises and sunsets are all counted, but only one in every ${every} is listed.` : ''}`,
              severity: 'info',
              source: 'model',
            });
          }
        } else {
          s.sunsets++;
          const n = s.sunsets;
          if (n <= 3 || n % every === 0) {
            const up = Number.isFinite(s.lastSunriseT) ? ` The star was up for ${fmt(tc - s.lastSunriseT, 4)} h.` : '';
            s.pending.push({ t: tc, id: `sunset-${n}`, label: `Sunset ${n} at the observation point`, detail: `At t = ${fmt(tc, 4)} h${dayText}.${up}`, severity: 'info', source: 'model' });
          }
        }
      }
      const pc = polarCode(c, sky.decl);
      if (pc !== s.polar) {
        polarEvents(s, s.polar, pc, s.t, sky.decl, c.lat);
        s.polar = pc;
      }
    }

    // Equinoxes and solstices: the orbital angle passes a multiple of 90°.
    const quarter = Math.PI / 2;
    const q0 = Math.floor(orb0 / quarter + 1e-12);
    const q1 = Math.floor(s.orbit / quarter + 1e-12);
    const seasonal = c.tiltDeg >= 0.05 && c.tiltDeg <= 179.95;
    for (let k = q0 + 1; k <= q1; k++) {
      if (!seasonal) break;
      const tc = t0 + (k * quarter - orb0) / rate;
      const idx = (c.startIndex + k) % 4;
      const sp = SEASON_POINTS[idx];
      const decl = Math.asin(Math.sin(c.eps) * Math.sin((idx * Math.PI) / 2)) / DEG;
      s.pending.push({
        t: tc,
        id: `season-${k}`,
        label: sp.label,
        detail: `${sp.what} Declination ${fmt(Math.abs(decl) < 1e-9 ? 0 : decl)}° (${sp.earth}). Day ${fmt(tc / 24, 4)} of the run.`,
        severity: 'milestone',
        source: 'model',
      });
    }

    // Completed orbits.
    while (s.orbit >= (s.years + 1) * TWO_PI - 1e-12) {
      s.years++;
      const tc = t0 + (s.years * TWO_PI - orb0) / rate;
      const lengthH = tc - s.lastYearT;
      const rotNow = s.rotations - (s.t - tc) / c.siderealH;
      const rotIn = rotNow - s.rotationsAtYear;
      s.rotationsAtYear = rotNow;
      s.lastYearT = tc;
      s.yearLength = lengthH / 24;
      const solar = Number.isFinite(c.solarH) ? `${fmt(lengthH / Math.abs(c.solarH), 5)} solar days and ` : '';
      s.pending.push({
        t: tc,
        id: `year-${s.years}`,
        label: `Orbit ${s.years} completed`,
        detail: `This year lasted ${fmt(lengthH / 24, 6)} days (${fmt(lengthH, 6)} h): ${solar}${fmt(rotIn, 5)} sidereal rotations.`,
        severity: 'milestone',
        source: 'model',
      });
    }
  },

  observe(s, p) {
    const c = planetConfig(p);
    const sky = skyOf(s, c);
    const latR = c.lat * DEG;
    const finiteDay = Number.isFinite(c.solarH);
    return {
      elevation: sky.elev / DEG,
      elevationMax: s.elevMax / DEG,
      elevationMin: s.elevMin / DEG,
      declination: sky.decl / DEG,
      insolation: c.S * Math.max(0, Math.sin(sky.elev)),
      dailyInsolation: finiteDay ? dailyMeanInsolation(c.S, latR, sky.decl) : NaN,
      daylight: finiteDay ? (sunsetHourAngle(latR, sky.decl) / Math.PI) * Math.abs(c.solarH) : NaN,
      hourAngle: sky.hourAngle / DEG,
      orbitLongitude: sky.lambda / DEG,
      subsolarLat: sky.subsolarLat / DEG,
      subsolarLon: sky.subsolarLon / DEG,
      obsLat: c.lat,
      obsLon: c.lon,
      solarDays: finiteDay ? s.solarDays : NaN,
      rotations: s.rotations,
      sunrises: s.sunrises,
      years: s.years,
      yearLength: s.yearLength,
      stellarFlux: c.S,
      surfaceTemp: c.ts,
      gravity: c.g,
    };
  },

  clone(s) {
    return { ...s, pending: [...s.pending] };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    if (!s.pending.length) return [];
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  describeMilestone(t, obs, p) {
    const e = obs.elevation;
    const where = Number.isNaN(e) ? 'not defined' : e >= 0 ? `${fmt(e)}° above the horizon` : `${fmt(-e)}° below the horizon`;
    const parts = [`declination ${fmt(obs.declination)}°`];
    if (!Number.isNaN(obs.daylight)) parts.push(`${fmt(obs.daylight)} h of daylight per solar day`);
    if (!Number.isNaN(obs.dailyInsolation)) parts.push(`daily-mean insolation ${fmt(obs.dailyInsolation)} W/m²`);
    parts.push(`${fmt(obs.years, 3)} orbit${obs.years === 1 ? '' : 's'} completed`);
    return {
      label: `Day ${fmt(t / 24, 4)}: the star is ${where} at the observation point`,
      detail: `${seasonName(obs.orbitLongitude, num(p, 'tilt'))}, orbital position ${fmt(obs.orbitLongitude)}°; ${parts.join(', ')}.`,
    };
  },

  tracks(s, p) {
    const c = planetConfig(p);
    const L = s.lambda0 + s.orbit + Math.PI; // heliocentric longitude of the planet
    return [{ id: 'planet', x: c.aAU * Math.cos(L), y: c.aAU * Math.sin(L) }];
  },

  derived(p) {
    const c = planetConfig(p);
    const out: DerivedQuantity[] = [];
    const add = (q: DerivedQuantity) => out.push(q);
    const gEarth = CONST.GM_EARTH / (CONST.R_EARTH * CONST.R_EARTH);
    add({ key: 'gravity', label: 'Surface gravity', value: c.g, unit: 'm/s2', formula: 'g = GM / R²', provenance: 'derived', sig: 3, note: 'Calculated from the mass and radius you set; it is not an independent input.' });
    add({ key: 'gravityRel', label: 'Surface gravity relative to Earth', value: c.g / gEarth, unit: 'x', formula: 'g/g⊕ = (M/M⊕) / (R/R⊕)²', provenance: 'derived', sig: 3 });
    add({ key: 'escape', label: 'Escape velocity', value: c.vEsc / 1000, unit: 'km/s', formula: 'v_esc = √(2GM / R)', provenance: 'derived', sig: 3 });
    add({ key: 'density', label: 'Mean density', value: c.density / 1000, unit: 'g/cm3', formula: 'ρ = M / (4⁄3 π R³)', provenance: 'derived', sig: 3, note: 'Earth 5.51, Mars 3.93, Saturn 0.69 g/cm³ (NASA fact sheets).' });
    add({ key: 'orbitPeriod', label: 'Orbital period (year)', value: c.orbitH / 24, unit: 'day', formula: 'T = 2π √(a³ / G(M★ + M))', provenance: 'derived', sig: 5, note: "Kepler's third law for a circular orbit." });
    add({ key: 'orbitSpeed', label: 'Orbital speed', value: c.vOrb / 1000, unit: 'km/s', formula: 'v = √(G(M★ + M) / a)', provenance: 'derived', sig: 3 });
    if (c.locked) add({ key: 'siderealLocked', label: 'Rotation period (tidally locked)', value: c.siderealH, unit: 'h', formula: 'T_sid = T_orb', provenance: 'derived', sig: 5, note: 'Equal to the orbital period because tidal locking is switched on.' });
    const solarNote = !Number.isFinite(c.solarH)
      ? 'Tidally locked: the same face always points at the star, so there is no solar day.'
      : c.solarH < 0
        ? 'The star moves backwards across the sky (it rises in the west) because the orbital motion outpaces the rotation.'
        : c.tiltDeg > 90
          ? 'Retrograde rotation (tilt above 90°): the orbital motion shortens the solar day instead of lengthening it, so 1/T_sol = 1/T_sid + 1/T_orb.'
          : 'Sunrise to sunrise. Longer than the sidereal day because the planet also moves along its orbit.';
    add({ key: 'solarDay', label: 'Solar day', value: Math.abs(c.solarH), unit: 'h', formula: '1/T_sol = 1/T_sid − 1/T_orb', provenance: 'derived', sig: 5, note: solarNote });
    add({ key: 'breakup', label: 'Shortest rotation period before breakup', value: c.breakupH, unit: 'h', formula: 'T_min = 2π √(R³ / GM)   (ω²R = g)', provenance: 'derived', sig: 3, note: 'Below this period the equator would be flung off; real fluid planets become unstable somewhat earlier.' });
    add({ key: 'centrifugal', label: 'Equatorial centrifugal ÷ gravity', value: c.q * 100, unit: '%', formula: 'q = ω²R / g', provenance: 'derived', sig: 3 });
    add({ key: 'flux', label: 'Stellar flux at the planet', value: c.S, unit: 'W/m2', formula: 'S = L / (4π a²)', provenance: 'derived', sig: 4 });
    add({ key: 'fluxRel', label: 'Stellar flux relative to Earth', value: convert(c.S, 'W/m2', 'S_earth'), unit: 'S_earth', formula: 'S / S⊕,  S⊕ = 1361 W/m²', provenance: 'derived', sig: 3 });
    add({ key: 'teq', label: 'Equilibrium temperature', value: c.teq, unit: 'K', formula: 'T_eq = [S (1 − A) / 4σ]^¼', provenance: 'derived', sig: 3, note: 'Global mean for a fast-rotating planet that spreads heat evenly and has no greenhouse effect.' });
    add({
      key: 'ts',
      label: c.override ? 'Mean surface temperature (override)' : 'Estimated mean surface temperature',
      value: c.ts,
      unit: 'K',
      formula: c.override ? 'T_s set directly (energy balance bypassed)' : 'T_s = T_eq (1 + ¾τ)^¼',
      provenance: c.override ? 'assumed' : 'derived',
      sig: 3,
      note: c.override
        ? 'Override: this value was entered, not calculated.'
        : `Gray-atmosphere estimate. τ = ${fmt(c.tau, 3)}; Earth's τ = ${TAU_EARTH} is calibrated to the observed 15 °C mean. No climate feedbacks.`,
    });
    add({ key: 'greenhouse', label: c.override ? 'Difference from equilibrium temperature' : 'Greenhouse warming', value: c.ts - c.teq, unit: 'dC', formula: 'ΔT = T_s − T_eq', provenance: c.override ? 'assumed' : 'derived', sig: 3 });
    if (c.pBar > 0) {
      add({ key: 'scaleHeight', label: 'Atmospheric scale height', value: c.scaleHeight / 1000, unit: 'km', formula: 'H = R T_s / (M g)', provenance: 'derived', sig: 3, note: 'Height over which pressure falls by a factor e ≈ 2.7 in an isothermal atmosphere at T_s.' });
      add({ key: 'column', label: 'Atmospheric column mass', value: c.column, unit: 'kg/m2', formula: 'm_col = P / g', provenance: 'derived', sig: 3, note: 'Mass of air above each square metre of ground.' });
      add({ key: 'atmMass', label: 'Total atmospheric mass', value: c.atmMass, unit: 'kg', formula: 'M_atm = 4πR² P / g', provenance: 'derived', sig: 3 });
    }
    const boilNote =
      c.pBar < CONST.P_TRIPLE_BAR
        ? 'Below water’s triple-point pressure (611.657 Pa): liquid water cannot exist; ice turns straight to vapour.'
        : c.pBar > CONST.P_CRIT_BAR
          ? 'Above water’s critical pressure (220.64 bar): no distinct boiling point.'
          : 'Antoine-equation approximation (about ±1 °C).';
    add({ key: 'boil', label: 'Boiling point of water at this pressure', value: c.boil, unit: 'K', formula: 'log₁₀ P = A − B / (C + T)  (Antoine)', provenance: 'derived', sig: 3, note: boilNote });
    const tropic = c.tiltDeg <= 90 ? c.tiltDeg : 180 - c.tiltDeg;
    add({ key: 'tropic', label: 'Tropic latitude (star overhead at a solstice)', value: tropic, unit: 'deg', formula: 'φ_tropic = ε  (180° − ε if ε > 90°)', provenance: 'derived', sig: 3 });
    add({ key: 'polarCircle', label: 'Polar-circle latitude (polar day/night begins)', value: 90 - tropic, unit: 'deg', formula: 'φ_polar = 90° − φ_tropic', provenance: 'derived', sig: 3 });
    const h = hypsometry;
    const missing = hypsometryError ? `Elevation dataset could not be loaded (${hypsometryError}).` : 'Elevation dataset not loaded.';
    add({
      key: 'oceanToday',
      label: "Earth's ocean fraction today (elevation grid)",
      value: h ? waterFractionAtSeaLevel(h, 0) * 100 : NaN,
      unit: '%',
      formula: 'A(elevation < 0 m) / A_total',
      provenance: 'data',
      sig: 4,
      note: h ? 'Area-weighted share of ETOPO1 grid points below present sea level (inland depressions included).' : missing,
    });
    add({
      key: 'seaLevel',
      label: 'Sea-level change for this water coverage',
      // The grid holds whole metres, so the result is rounded to 1 m.
      value: h ? Math.round(seaLevelForWaterFraction(h, c.water / 100)) + 0 : NaN,
      unit: 'm',
      formula: 'z such that A(elevation < z) / A_total = coverage',
      provenance: 'data',
      sig: 5,
      note: h
        ? "Earth's terrain with more or less water — not the terrain of a different planet. All land below the new level counts as flooded (connected or not); ice sheets and the solid Earth do not respond."
        : missing,
    });
    return out;
  },

  warnings(p) {
    const c = planetConfig(p);
    const w: Warning[] = [];
    w.push({
      id: 'not-checked',
      severity: 'info',
      message:
        'Every combination of inputs is calculated, plausible or not. This lab does not check whether such a planet could form, keep its atmosphere or stay stable over long times.',
    });
    const rhoG = c.density / 1000;
    if (c.q >= 1) {
      w.push({ id: 'breakup', severity: 'critical', message: `Rotation faster than breakup: at the equator the centrifugal acceleration (${fmt(c.omega * c.omega * c.rM)} m/s²) exceeds gravity (${fmt(c.g)} m/s²). A real body would fly apart; the shortest possible period for this mass and radius is ${fmt(c.breakupH)} h.` });
    } else if (c.q >= 0.05) {
      w.push({ id: 'fast-rotation', severity: 'warning', message: `Very fast rotation: centrifugal acceleration is ${fmt(c.q * 100)}% of gravity at the equator, enough to flatten the planet noticeably (like Jupiter or Saturn). This model keeps a perfect sphere.` });
    }
    if (rhoG > 11) {
      w.push({ id: 'density-high', severity: 'warning', message: `Mean density ${fmt(rhoG)} g/cm³ is more than twice Earth's (5.51 g/cm³, the densest planet in the Solar System). That would need an extremely iron-rich, highly compressed body; such planets are not known to be common.` });
    } else if (rhoG < 0.5) {
      w.push({ id: 'density-low', severity: 'warning', message: `Mean density ${fmt(rhoG)} g/cm³ is below Saturn's (0.69 g/cm³, the least dense planet in the Solar System). Only a puffy gas giant is this light, and it would have no solid surface or ocean.` });
    } else if (rhoG < 3) {
      w.push({ id: 'density-icy', severity: 'info', message: `Mean density ${fmt(rhoG)} g/cm³ is too low for a rock-and-iron planet (Mars is 3.93, the Moon 3.34). It implies a large fraction of ice, water or gas, like Jupiter's moon Ganymede (1.94 g/cm³).` });
    }
    if (c.radius > 1.6) {
      w.push({ id: 'radius-gas', severity: 'info', message: 'Most observed planets larger than about 1.6 Earth radii have thick hydrogen/helium envelopes rather than rocky surfaces (Rogers 2015). A rocky surface at this size is possible but not typical.' });
    }
    if (c.override) {
      w.push({ id: 'override', severity: 'info', message: `Surface temperature is set directly to ${fmt(c.ts)} K (override). Albedo, flux and greenhouse do not affect it; the equilibrium temperature (${fmt(c.teq)} K) is still shown for comparison.` });
    }
    if (c.water > 0) {
      if (c.pBar < CONST.P_TRIPLE_BAR) {
        w.push({ id: 'no-liquid', severity: 'warning', message: `Surface pressure ${fmt(c.pBar)} bar is below water's triple point (0.00612 bar): liquid water cannot exist; open water would freeze and sublimate.` });
      } else if (c.pBar > CONST.P_CRIT_BAR) {
        if (c.ts >= CONST.T_CRIT) w.push({ id: 'supercritical', severity: 'warning', message: `Above water's critical point (647 K, 220.64 bar): there is no distinction between liquid water and vapour, so no ocean surface.` });
      } else if (c.ts >= c.boil) {
        w.push({
          id: 'boiling',
          severity: 'warning',
          message: `The ${c.override ? 'set' : 'estimated'} surface temperature (${fmt(c.ts)} K) is above water's boiling point at ${fmt(c.pBar)} bar (${fmt(c.boil)} K)${c.teq >= c.boil ? ', even without any greenhouse effect' : ''}: open water would boil away. The map then shows empty ocean basins.`,
        });
      } else if (c.ts < CONST.T_FREEZE) {
        w.push({ id: 'frozen', severity: 'info', message: `The global-mean surface temperature (${fmt(c.ts)} K, ${fmt(c.ts - 273.15)} °C) is below freezing: open oceans would tend to freeze over. Local and seasonal temperatures vary and the ice–albedo feedback is not modelled.` });
      }
    }
    if (c.pBar > 0) {
      const vRms = Math.sqrt((3 * CONST.R_GAS * c.ts) / (c.molar / 1000));
      if (c.vEsc < 6 * vRms) {
        w.push({ id: 'escape', severity: 'warning', message: `A gas of ${fmt(c.molar)} g/mol would probably escape over geological time: its thermal speed at ${fmt(c.ts)} K (${fmt(vRms / 1000)} km/s) is more than 1/6 of the escape velocity (${fmt(c.vEsc / 1000)} km/s). Rule of thumb only; the hotter upper atmosphere makes escape easier still.` });
      }
    }
    // Main-sequence mass–luminosity approximation (piecewise power law).
    const m = num(p, 'starMass');
    const L = num(p, 'luminosity');
    const Lms = m < 0.43 ? 0.23 * m ** 2.3 : m < 2 ? m ** 4 : 1.4 * m ** 3.5;
    if (L > 3 * Lms || L < Lms / 3) {
      w.push({ id: 'star', severity: 'info', message: `A main-sequence star of ${fmt(m)} M☉ has roughly ${fmt(Lms, 2)} L☉ (mass–luminosity approximation). ${fmt(L)} L☉ is possible for an evolving, giant or remnant star, but not for a typical star of this mass.` });
    }
    if (c.locked) {
      w.push({ id: 'locked', severity: 'info', message: 'Tidally locked: one hemisphere faces the star permanently. The equilibrium temperature assumes heat is spread around the planet; a locked planet would have a hot day side and a cold night side.' });
    }
    if (Number.isFinite(c.solarH) && Math.abs(c.solarH) > c.orbitH / 10) {
      w.push({ id: 'long-day', severity: 'info', message: `The solar day (${fmt(Math.abs(c.solarH) / 24)} days) is a large fraction of the year (${fmt(c.orbitH / 24)} days). Daylight and daily-mean values assume the declination is constant over one day, so they are only indicative.` });
    }
    if (c.durationH < c.orbitH) {
      w.push({ id: 'short-run', severity: 'info', message: `The run (${fmt(c.durationH / 24)} days) is shorter than one orbit (${fmt(c.orbitH / 24)} days), so it will not show a full cycle of seasons.` });
    }
    if (num(p, 'dt') > stepHours(p) * 1.0001) {
      w.push({ id: 'dt-limited', severity: 'info', message: `The time step is limited to ${fmt(stepHours(p))} h (1/48 of a rotation or solar day) for accuracy.` });
    }
    if (!hypsometry) {
      w.push({ id: 'no-data', severity: 'info', message: hypsometryError ? `Elevation data unavailable (${hypsometryError}); the water-coverage sea level cannot be calculated.` : 'Elevation data not loaded yet; the water-coverage sea level will appear once it is.' });
    }
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const obs = run.samples.obs;
    const finite = (a: number[] | undefined) => (a ?? []).filter((v) => Number.isFinite(v));
    const f = run.final;
    // Running extrema are tracked every step, so they are not limited by the recording interval.
    if (Number.isFinite(f.elevationMax)) out.push({ label: 'Highest star elevation at the observation point', value: f.elevationMax, unit: 'deg', provenance: 'simulated', sig: 3 });
    if (Number.isFinite(f.elevationMin)) out.push({ label: 'Lowest star elevation at the observation point', value: f.elevationMin, unit: 'deg', provenance: 'simulated', sig: 3 });
    const day = finite(obs.daylight);
    if (day.length) {
      out.push({ label: 'Longest daylight', value: Math.max(...day), unit: 'h', provenance: 'derived', sig: 3 });
      out.push({ label: 'Shortest daylight', value: Math.min(...day), unit: 'h', provenance: 'derived', sig: 3 });
    }
    // Time-weighted mean of the daily-mean insolation (trapezoid rule).
    const t = run.samples.t;
    const q = obs.dailyInsolation ?? [];
    let area = 0;
    let span = 0;
    for (let i = 1; i < t.length; i++) {
      if (Number.isFinite(q[i]) && Number.isFinite(q[i - 1])) {
        const dt = t[i] - t[i - 1];
        area += 0.5 * (q[i] + q[i - 1]) * dt;
        span += dt;
      }
    }
    if (span > 0) out.push({ label: 'Mean insolation at the observation point', value: area / span, unit: 'W/m2', provenance: 'simulated', sig: 3, note: 'Time average of the daily-mean top-of-atmosphere insolation over the run.' });
    if (Number.isFinite(f.sunrises)) out.push({ label: 'Sunrises at the observation point', value: f.sunrises, unit: 'count', provenance: 'simulated', sig: 6 });
    if (Number.isFinite(f.years)) out.push({ label: 'Orbits completed', value: f.years, unit: 'count', provenance: 'simulated', sig: 4 });
    if (Number.isFinite(f.yearLength)) out.push({ label: 'Measured length of a year', value: f.yearLength, unit: 'day', provenance: 'simulated', sig: 6 });
    if (Number.isFinite(f.gravity)) out.push({ label: 'Surface gravity', value: f.gravity, unit: 'm/s2', provenance: 'derived', sig: 3 });
    if (Number.isFinite(f.surfaceTemp)) out.push({ label: 'Mean surface temperature (estimate)', value: f.surfaceTemp, unit: 'K', provenance: 'derived', sig: 3 });
    return out;
  },

  assumptions: [
    { kind: 'established', text: "Newtonian gravity: g = GM/R² at the surface of a spherical planet, escape velocity √(2GM/R), and Kepler's third law for the orbit." },
    { kind: 'established', text: 'Seasons come from the axial tilt: the star’s declination is δ = asin(sin ε sin λ), and day length follows from latitude and declination.' },
    { kind: 'simplification', text: 'The orbit is a perfect circle (no eccentricity), so seasons come from tilt alone. Earth’s real orbit (eccentricity 0.0167) varies its insolation by about ±3.4% over the year.' },
    { kind: 'simplification', text: 'The spin axis is fixed in space (no precession or nutation) and the planet is a perfect sphere (no rotational flattening).' },
    { kind: 'simplification', text: 'The star is a point source; sunrise and sunset are when its centre crosses the geometric horizon. Atmospheric refraction and the star’s disc are ignored, which on Earth shifts sunrise and sunset by a few minutes.' },
    { kind: 'approximation', text: 'The equilibrium temperature assumes blackbody emission and heat spread evenly around the planet (appropriate for a fast rotator with an atmosphere or ocean).' },
    { kind: 'approximation', text: 'Greenhouse warming uses a one-parameter gray atmosphere, T_s = T_eq(1 + ¾τ)^¼ (Eddington radiative equilibrium, no convection). τ is calibrated to Earth’s observed mean; for other atmospheres it is a fit, not a prediction.' },
    { kind: 'simplification', text: 'Albedo, greenhouse depth, pressure and water are independent inputs with no feedbacks: water vapour, clouds, ice and pressure broadening do not change τ or the albedo.' },
    { kind: 'approximation', text: 'The atmospheric scale height assumes an isothermal atmosphere at the surface temperature and constant gravity with height.' },
    { kind: 'approximation', text: "Water's boiling point uses the Antoine equation with standard tabulated constants, accurate to about 1 °C between the triple and critical points." },
    { kind: 'simplification', text: "Water coverage is applied to Earth's present terrain (ETOPO1 ice surface): every point below the new sea level counts as water, whether or not it connects to the ocean. Ice sheets, isostasy and ocean volume are not modelled." },
    { kind: 'approximation', text: 'Atmospheric escape is flagged with the rule of thumb that a gas is retained over billions of years when the escape velocity exceeds about six times its thermal speed, evaluated at the surface temperature.' },
  ],
  limitations: [
    'This is not a climate model: temperatures are single global means with no day/night, latitude or seasonal variation, no weather, oceans, clouds or ice feedbacks.',
    'The lab does not check whether a configuration could form or remain stable (tidal evolution, orbital stability, atmospheric loss over time, interior structure).',
    "The terrain shown is always Earth's, whatever the mass or radius, and its colours are illustrative (from elevation), not land cover.",
    'One star, a circular orbit, no moons and no orbital eccentricity, precession or obliquity changes.',
    'Insolation is at the top of the atmosphere; absorption and scattering by the air and clouds are not included.',
    'Daily-mean insolation and daylight hours assume the declination is constant during a day, which fails when a solar day is a large fraction of the year.',
    'The 0.25° elevation grid is point-sampled: mountain peaks and ocean trenches are lower than in reality, and small islands and straits are missing.',
    'For thick atmospheres such as Venus’s, the gray-τ formula can be tuned to match a temperature but does not explain it.',
  ],
  equations: [
    { label: 'Surface gravity', formula: 'g = GM / R²', explanation: 'Doubling the mass doubles g; doubling the radius at the same mass quarters it.' },
    { label: 'Escape velocity', formula: 'v_esc = √(2GM / R)', explanation: 'Launch speed needed to leave the planet without further thrust (ignoring air).' },
    { label: 'Mean density', formula: 'ρ = M / (4⁄3 π R³)', explanation: 'Compared with known planets, it hints at what the planet would have to be made of.' },
    { label: "Kepler's third law", formula: 'T = 2π √(a³ / G(M★ + M))', explanation: 'A circular orbit of radius a; a more massive star means a shorter year at the same distance.' },
    { label: 'Solar day', formula: '1/T_sol = 1/T_sid − 1/T_orb', explanation: 'Each orbit the star appears to go once around the sky the opposite way, so one fewer solar day than rotations fits in a year (one more if the spin is retrograde).' },
    { label: 'Stellar flux', formula: 'S = L / (4π a²)', explanation: 'Starlight spreads over a sphere, so flux falls with the square of distance.' },
    { label: 'Equilibrium temperature', formula: 'T_eq = [S (1 − A) / 4σ]^¼', explanation: 'Absorbed starlight (cross-section πR²) balances thermal emission from the whole surface (4πR²).' },
    { label: 'Gray-atmosphere surface temperature', formula: 'T_s = T_eq (1 + ¾τ)^¼', explanation: 'An infrared-absorbing atmosphere of optical depth τ warms the surface. Calibrated: Earth needs τ ≈ ' + TAU_EARTH + '.' },
    { label: 'Solar declination', formula: 'δ = asin(sin ε · sin λ)', explanation: 'λ is the star’s position along the orbit measured from the northern spring equinox; ε is the tilt.' },
    { label: 'Star elevation', formula: 'sin h = sin φ sin δ + cos φ cos δ cos H', explanation: 'φ latitude, H hour angle (rotation of the observer relative to the star, 0 at local noon).' },
    { label: 'Daily-mean insolation', formula: 'Q = (S/π)(h₀ sin φ sin δ + cos φ cos δ sin h₀),  cos h₀ = −tan φ tan δ', explanation: 'h₀ is the sunset hour angle; h₀ = 0 is polar night and h₀ = π polar day. At the equator at an equinox Q = S/π.' },
    { label: 'Daylight', formula: 'daylight = (h₀ / π) · T_sol', explanation: 'Fraction of the solar day with the star above the horizon.' },
    { label: 'Scale height', formula: 'H = R T / (M g)', explanation: 'Pressure falls by a factor e every H metres in an isothermal atmosphere.' },
    { label: 'Column mass', formula: 'm_col = P / g', explanation: 'Surface pressure is the weight of the air above each square metre.' },
    { label: 'Breakup rotation', formula: 'ω²R = g  ⇒  T_min = 2π √(R³ / GM)', explanation: 'At this spin the equator is weightless.' },
    { label: 'Sea level for a water coverage', formula: 'A(elevation < z) / A_total = coverage', explanation: "Solved on Earth's area-weighted elevation distribution (hypsometric curve) from ETOPO1." },
  ],
  education: {
    objectives: [
      'Distinguish independent planetary properties (mass, radius, rotation, tilt, distance) from quantities calculated from them (gravity, density, escape speed, year, solar day, temperatures).',
      'Explain how axial tilt produces seasons, polar day and polar night, and how daylight length depends on latitude.',
      'Relate stellar luminosity, distance and albedo to the energy a planet absorbs and its equilibrium temperature.',
      'Explain the difference between a sidereal and a solar day, including retrograde and tidally locked rotation.',
      'Recognise that a set of numbers does not make a planet physically plausible, stable or habitable.',
    ],
    background: {
      beginner:
        "A planet's mass and size set how strongly it pulls on you. Its spin sets the length of the day, and the tilt of its spin axis gives it seasons: when your hemisphere leans toward the star, the star climbs higher and stays up longer. How far the planet is from its star, and how bright the star is, decide how much warmth arrives. Change one thing at a time and see which calculated values change with it.",
      intermediate:
        'Surface gravity g = GM/R² is not an independent setting: change mass or radius and g follows. The year comes from Kepler’s third law, and the solar day is a little longer than one rotation because the planet moves along its orbit. The star’s declination swings between +ε and −ε over the year; where |latitude| + |declination| ≥ 90° the star never sets (polar day) or never rises (polar night). Absorbed starlight S(1 − A)/4 balances thermal emission σT⁴, giving the equilibrium temperature; a greenhouse atmosphere raises the surface above it.',
      advanced:
        'The model integrates the rotation angle and orbital longitude at a fixed step and evaluates the spherical-astronomy relations exactly at each step: sin h = sin φ sin δ + cos φ cos δ cos H with H from the sidereal angle and the star’s right ascension α = atan2(cos ε sin λ, cos λ), so obliquity-induced variations (the obliquity part of the equation of time, and the libration of a tilted synchronous rotator) appear automatically. Events (sunrise, sunset, equinoxes, solstices, completed orbits, polar day/night) are interpolated within a step. The gray-atmosphere relation T_s⁴ = T_eq⁴(1 + ¾τ) is the Eddington two-stream solution for a purely radiative atmosphere; real atmospheres are convective in the troposphere and non-gray, so τ here is a calibration parameter. The water-coverage control inverts Earth’s area-weighted hypsometric curve from ETOPO1 (1 m bins).',
    },
    variables: [
      { symbol: 'M, R', meaning: 'planet mass and radius', unit: 'M⊕, R⊕' },
      { symbol: 'g', meaning: 'surface gravity (calculated)', unit: 'm/s²' },
      { symbol: 'a', meaning: 'orbital radius', unit: 'AU' },
      { symbol: 'M★, L', meaning: 'star mass and luminosity', unit: 'M☉, L☉' },
      { symbol: 'T_sid, T_sol, T_orb', meaning: 'sidereal rotation period, solar day, orbital period', unit: 'h, h, days' },
      { symbol: 'ε', meaning: 'axial tilt (obliquity)', unit: '°' },
      { symbol: 'λ', meaning: 'star’s ecliptic longitude (0° = northern spring equinox)', unit: '°' },
      { symbol: 'δ', meaning: 'star’s declination', unit: '°' },
      { symbol: 'φ, H', meaning: 'observer latitude, hour angle', unit: '°' },
      { symbol: 'S', meaning: 'stellar flux at the planet', unit: 'W/m²' },
      { symbol: 'A', meaning: 'Bond albedo' },
      { symbol: 'τ', meaning: 'gray infrared optical depth' },
      { symbol: 'T_eq, T_s', meaning: 'equilibrium and surface temperature', unit: 'K' },
      { symbol: 'P, M_mol, H', meaning: 'surface pressure, mean molar mass, scale height', unit: 'bar, g/mol, km' },
    ],
    guidedSteps: [
      'Start with the defaults (Earth). In the derived values, check surface gravity, the orbital period and the solar day against what you know.',
      'Run a full year at 45°N. Watch the daylight chart and the equinox and solstice events. When is daylight longest?',
      'Set the axial tilt to 0° and run again. What happens to daylight hours and to the noon height of the star?',
      'Choose the North Pole, start at the northern winter solstice and run for a few days: confirm the polar night.',
      'Double the planet mass and note the new gravity. Now raise the radius to about 1.41 R⊕: gravity returns to Earth’s value — what happened to the density?',
      'Switch on tidal locking and run: does the star move in the sky? Try a tilt of 20° as well.',
      'Change the water coverage and read the sea-level change computed from Earth’s real topography.',
    ],
    questions: [
      'Why is a solar day on Earth about 4 minutes longer than one rotation?',
      'At the northern summer solstice, compare the daily-mean insolation at the North Pole and at the equator. Which is larger, and why is the pole still not the warmest place?',
      'Why does doubling the star’s luminosity raise the equilibrium temperature by only about 19%?',
      'Which mass and radius would keep g = 9.8 m/s² while doubling the mass, and is that planet plausible?',
      'Why does the solar day of Venus come out shorter than its rotation period?',
    ],
  },
  dataSources: [
    {
      name: 'Planetary Fact Sheet — Metric, and the individual planet fact sheets',
      provider: 'NASA Goddard Space Flight Center, NASA Space Science Data Coordinated Archive (NSSDCA)',
      citation: 'Williams, D. R., Planetary Fact Sheet — Metric. NASA Goddard Space Flight Center.',
      url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/',
      license: 'U.S. Government work; public domain.',
      notes:
        "Reference values (rounded) for slider marks, presets and calibration: masses, mean radii, sidereal rotation periods, obliquities, orbital distances, Bond albedos, surface pressures, mean molecular weights and Earth's 15 °C / Venus's 464 °C mean temperatures.",
    },
    {
      name: 'IAU nominal solar and planetary values',
      provider: 'International Astronomical Union',
      citation: 'Prša, A. et al. 2016, "Nominal Values for Selected Solar and Planetary Quantities: IAU 2015 Resolution B3", AJ 152, 41. Astronomical unit: IAU 2012 Resolution B2.',
      url: 'https://www.iau.org/administration/resolutions/general_assemblies/',
      license: 'Published resolution; values free to use.',
      notes: 'L☉ = 3.828×10²⁶ W, GM☉ = 1.3271244×10²⁰ m³/s², GM⊕ = 3.986004×10¹⁴ m³/s², 1 AU = 149 597 870 700 m.',
    },
    {
      name: 'CODATA 2018 recommended values of the fundamental physical constants',
      provider: 'NIST',
      citation: 'Tiesinga, E. et al. 2021, Rev. Mod. Phys. 93, 025010.',
      url: 'https://physics.nist.gov/cuu/Constants/',
      license: 'Public domain (NIST).',
      notes: 'Stefan–Boltzmann constant and the molar gas constant.',
    },
    ETOPO_SOURCE,
  ],
};
