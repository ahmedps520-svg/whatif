import type { DerivedQuantity, KeyResult, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { num, str } from '../../engine/validation';

/**
 * "What if electricity disappeared?" — a transparent, branching
 * system-dynamics scenario of a sudden, long, wide-area loss of grid power.
 *
 * Grid power is prescribed by the restoration branch. Every other system's
 * service level (0–1) is an explicit function of the grid, a handful of stocks
 * (generator fuel, working generators, vehicle fuel, household food deficit,
 * safe cold food) and the assumptions set by the branches. Time is in hours;
 * stocks are advanced with explicit Euler steps (default 15 minutes). The one
 * feedback loop (communications → fuel deliveries → generators → communications)
 * is closed with a one-step lag.
 *
 * This is a scenario model for exploring dependencies, not a prediction of how
 * any country would respond.
 */

export type RestorationBranch = 'rapid' | 'regional' | 'prolonged';
export type PreparednessBranch = 'well' | 'typical' | 'minimal';
export type LogisticsBranch = 'prioritised' | 'disrupted';

/** Numbers each restoration branch sets (days). Illustrative scenario values. */
export const RESTORATION: Record<RestorationBranch, { label: string; restorationDelay: number; restorationTime: number }> = {
  rapid: { label: 'Rapid (days)', restorationDelay: 0.25, restorationTime: 2 },
  regional: { label: 'Regional (weeks)', restorationDelay: 2, restorationTime: 21 },
  prolonged: { label: 'Prolonged (months)', restorationDelay: 10, restorationTime: 90 },
};

/** Numbers each preparedness branch sets. Illustrative assumptions, not survey data. */
export const PREPAREDNESS: Record<
  PreparednessBranch,
  { label: string; hospitalBackup: number; waterBackup: number; cellGenerators: number; cellBattery: number; waterStorage: number; fuelOnHand: number; pumpBackup: number; generatorFailure: number }
> = {
  well: { label: 'Well-prepared', hospitalBackup: 98, waterBackup: 60, cellGenerators: 60, cellBattery: 8, waterStorage: 24, fuelOnHand: 96, pumpBackup: 30, generatorFailure: 0.5 },
  typical: { label: 'Typical', hospitalBackup: 90, waterBackup: 35, cellGenerators: 30, cellBattery: 4, waterStorage: 12, fuelOnHand: 48, pumpBackup: 10, generatorFailure: 2 },
  minimal: { label: 'Minimal', hospitalBackup: 60, waterBackup: 10, cellGenerators: 10, cellBattery: 2, waterStorage: 6, fuelOnHand: 24, pumpBackup: 2, generatorFailure: 5 },
};

/** Numbers each fuel-logistics branch sets. Illustrative assumptions. */
export const LOGISTICS: Record<LogisticsBranch, { label: string; resupplyCapacity: number; terminalBackup: number }> = {
  prioritised: { label: 'Prioritised', resupplyCapacity: 100, terminalBackup: 90 },
  disrupted: { label: 'Disrupted', resupplyCapacity: 30, terminalBackup: 30 },
};

export const BRANCH_KEYS = ['restoration', 'preparedness', 'logistics'] as const;

export interface BranchOption {
  value: string;
  label: string;
  detail: string;
}

export interface BranchAxis {
  key: (typeof BRANCH_KEYS)[number];
  label: string;
  options: BranchOption[];
}

function restorationDetail(b: RestorationBranch): string {
  const r = RESTORATION[b];
  return `restoration starts after ${fmtDays(r.restorationDelay)} and takes ${fmtDays(r.restorationTime)}`;
}
function preparednessDetail(b: PreparednessBranch): string {
  const r = PREPAREDNESS[b];
  return `hospitals ${r.hospitalBackup} % with generators, water pumping ${r.waterBackup} %, cell sites ${r.cellGenerators} % with generators and ${r.cellBattery} h batteries, water storage ${r.waterStorage} h, ${r.fuelOnHand} h fuel on hand, fuel stations ${r.pumpBackup} %, generator failures ${r.generatorFailure} %/day`;
}
function logisticsDetail(b: LogisticsBranch): string {
  const r = LOGISTICS[b];
  return `deliveries up to ${r.resupplyCapacity} % of generator demand, ${r.terminalBackup} % of fuel depots with backup power`;
}

function fmtDays(d: number): string {
  if (d < 1) return `${Math.round(d * 24)} h`;
  return `${Number(d.toFixed(1))} day${d === 1 ? '' : 's'}`;
}

export const BRANCH_AXES: BranchAxis[] = [
  { key: 'restoration', label: 'Grid restoration', options: (Object.keys(RESTORATION) as RestorationBranch[]).map((k) => ({ value: k, label: RESTORATION[k].label, detail: restorationDetail(k) })) },
  { key: 'preparedness', label: 'Backup preparedness', options: (Object.keys(PREPAREDNESS) as PreparednessBranch[]).map((k) => ({ value: k, label: PREPAREDNESS[k].label, detail: preparednessDetail(k) })) },
  { key: 'logistics', label: 'Fuel logistics', options: (Object.keys(LOGISTICS) as LogisticsBranch[]).map((k) => ({ value: k, label: LOGISTICS[k].label, detail: logisticsDetail(k) })) },
];

/** Every combination of the named branches (3 × 3 × 2 = 18). */
export function branchCombos(): { restoration: RestorationBranch; preparedness: PreparednessBranch; logistics: LogisticsBranch }[] {
  const out: { restoration: RestorationBranch; preparedness: PreparednessBranch; logistics: LogisticsBranch }[] = [];
  for (const restoration of Object.keys(RESTORATION) as RestorationBranch[])
    for (const preparedness of Object.keys(PREPAREDNESS) as PreparednessBranch[])
      for (const logistics of Object.keys(LOGISTICS) as LogisticsBranch[]) out.push({ restoration, preparedness, logistics });
  return out;
}

// ---------- fixed structural assumptions (documented in `equations` / `assumptions`) ----------

/** Heterogeneity: battery runtimes, storage and household reserves spread uniformly ±50 % around the stated typical value. */
export const SPREAD = 0.5;
/** Average fuel in vehicle tanks when the outage starts (fraction of a full tank). */
export const V0 = 0.5;
/** Vehicles top up toward the normal level at this rate when pumps work (1/h). */
const REFUEL_RATE = 1 / 12;
/** Households restock food (and fridges) with this time constant when shops function (h). */
export const RESTOCK_H = 48;
/** Share of food retail that can operate without grid power (generators, manual sales). */
export const SHOP_OFFGRID = 0.2;
/** Capacity an unpowered hospital retains (manual care, daylight, battery equipment). */
export const HOSPITAL_UNPOWERED = 0.15;
/** Essential-services index weights. */
export const ESI_WEIGHTS = { water: 0.25, health: 0.25, foodHouseholds: 0.2, comms: 0.15, transport: 0.15 } as const;

/** Assumptions in force for a parameter set (branch values, or the custom numbers). Fractions are 0–1, times in hours. */
export interface InForce {
  restorationDelayH: number;
  restorationTimeH: number;
  curve: 'linear' | 'scurve';
  hospitalBackup: number;
  waterBackup: number;
  cellGenerators: number;
  cellBatteryH: number;
  waterStorageH: number;
  fuelOnHandH: number;
  pumpBackup: number;
  failurePerH: number;
  resupply: number;
  terminalBackup: number;
  householdFoodDays: number;
  vehicleTankDays: number;
  fridgeH: number;
  freezerH: number;
}

export function inForce(p: ParamValues): InForce {
  const rb = str(p, 'restoration');
  const pb = str(p, 'preparedness');
  const lb = str(p, 'logistics');
  const R = rb === 'custom' ? { restorationDelay: num(p, 'restorationDelay'), restorationTime: num(p, 'restorationTime') } : RESTORATION[rb as RestorationBranch] ?? RESTORATION.regional;
  const B =
    pb === 'custom'
      ? {
          hospitalBackup: num(p, 'hospitalBackup'),
          waterBackup: num(p, 'waterBackup'),
          cellGenerators: num(p, 'cellGenerators'),
          cellBattery: num(p, 'cellBattery'),
          waterStorage: num(p, 'waterStorage'),
          fuelOnHand: num(p, 'fuelOnHand'),
          pumpBackup: num(p, 'pumpBackup'),
          generatorFailure: num(p, 'generatorFailure'),
        }
      : PREPAREDNESS[pb as PreparednessBranch] ?? PREPAREDNESS.typical;
  const Lg = lb === 'custom' ? { resupplyCapacity: num(p, 'resupplyCapacity'), terminalBackup: num(p, 'terminalBackup') } : LOGISTICS[lb as LogisticsBranch] ?? LOGISTICS.prioritised;
  return {
    restorationDelayH: R.restorationDelay * 24,
    restorationTimeH: R.restorationTime * 24,
    curve: str(p, 'restorationCurve') === 'linear' ? 'linear' : 'scurve',
    hospitalBackup: B.hospitalBackup / 100,
    waterBackup: B.waterBackup / 100,
    cellGenerators: B.cellGenerators / 100,
    cellBatteryH: B.cellBattery,
    waterStorageH: B.waterStorage,
    fuelOnHandH: B.fuelOnHand,
    pumpBackup: B.pumpBackup / 100,
    failurePerH: B.generatorFailure / 100 / 24,
    resupply: Lg.resupplyCapacity / 100,
    terminalBackup: Lg.terminalBackup / 100,
    householdFoodDays: num(p, 'householdFood'),
    vehicleTankDays: num(p, 'vehicleTank'),
    fridgeH: num(p, 'fridgeHours'),
    freezerH: num(p, 'freezerHours'),
  };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const S_K = 10;
const S_LO = sigmoid(-S_K / 2);
const S_HI = sigmoid(S_K / 2);

/** Grid service level G(t): 0 until the restoration delay, then a linear or normalised-logistic rise to 1 over the restoration time. */
export function gridLevel(t: number, a: InForce): number {
  const d = a.restorationDelayH;
  const T = a.restorationTimeH;
  if (t < d) return 0;
  if (T <= 0) return 1;
  const x = Math.min(1, (t - d) / T);
  if (a.curve === 'linear') return x;
  return clamp01((sigmoid(S_K * (x - 0.5)) - S_LO) / (S_HI - S_LO));
}

/** Share of sites (or households) whose buffer of typical size N hours still lasts at time t without power (uniform spread ±50 %). */
export function bufferShare(t: number, N: number): number {
  if (N <= 0) return 0;
  return clamp01(((1 + SPREAD) * N - t) / (2 * SPREAD * N));
}

export interface BlackoutState {
  t: number;
  /** Generator fuel on hand, hours of full-load running for all backed-up facilities. */
  F: number;
  Fcap: number;
  /** Share of installed generators still working. */
  W: number;
  /** Fleet-average vehicle tank level (fraction of a full tank). */
  V: number;
  /** Household food deficit: days of reserves used up, net of restocking. */
  z: number;
  /** Share of households with power whose refrigerated / frozen food is safe. */
  X: number;
  Y: number;
  /** Communications level at the previous step (closes the comms → logistics loop). */
  commsPrev: number;
  outage: boolean;
  fuelOutReported: boolean;
  pending: SimEvent[];
}

export interface SystemLevels {
  grid: number;
  need: number;
  /** Fuel deliveries, fraction of full-load generator demand per hour. */
  resupply: number;
  /** Fraction of needed generator running actually fuelled. */
  delivered: number;
  /** Share of installed backup generation producing when needed (working × fuelled). */
  backup: number;
  generatorsWorking: number;
  fuelH: number;
  fuelPct: number;
  terminals: number;
  batteries: number;
  storage: number;
  comms: number;
  water: number;
  pumps: number;
  transport: number;
  hospitalPower: number;
  health: number;
  shops: number;
  foodHouseholds: number;
  refrigerated: number;
  frozen: number;
  esi: number;
}

export function levels(s: BlackoutState, p: ParamValues, a: InForce = inForce(p), t: number = s.t): SystemLevels {
  const G = gridLevel(t, a);
  const need = 1 - G;
  const terminals = G + need * a.terminalBackup;
  const coord = 0.5 + 0.5 * s.commsPrev;
  const resupply = a.resupply * terminals * coord;
  const delivered = s.F > 1e-12 ? 1 : need > 1e-9 ? Math.min(1, resupply / need) : 1;
  const backup = s.W * delivered;
  const batteries = bufferShare(t, a.cellBatteryH);
  const storage = bufferShare(t, a.waterStorageH);
  const comms = G + need * (a.cellGenerators * Math.max(backup, batteries) + (1 - a.cellGenerators) * batteries);
  const water = G + need * (a.waterBackup * Math.max(backup, storage) + (1 - a.waterBackup) * storage);
  const pumps = G + need * a.pumpBackup * s.W;
  const transport = Math.min(1, s.V / V0);
  const covered = a.hospitalBackup * backup;
  const hospitalPower = G + need * (covered + (1 - covered) * HOSPITAL_UNPOWERED);
  const health = hospitalPower * (0.6 + 0.2 * water + 0.1 * comms + 0.1 * transport);
  const shops = Math.min(transport, G + need * SHOP_OFFGRID);
  const D = a.householdFoodDays;
  const foodHouseholds = D > 0 ? clamp01(((1 + SPREAD) * D - s.z) / (2 * SPREAD * D)) : s.z > 0 ? 0 : 1;
  const refrigerated = s.X + (t < a.fridgeH ? need : 0);
  const frozen = s.Y + (t < a.freezerH ? need : 0);
  const W8 = ESI_WEIGHTS;
  const esi = W8.water * water + W8.health * health + W8.foodHouseholds * foodHouseholds + W8.comms * comms + W8.transport * transport;
  return {
    grid: G,
    need,
    resupply,
    delivered,
    backup,
    generatorsWorking: s.W,
    fuelH: s.F,
    fuelPct: s.Fcap > 0 ? s.F / s.Fcap : 0,
    terminals,
    batteries,
    storage,
    comms,
    water,
    pumps,
    transport,
    hospitalPower,
    health,
    shops,
    foodHouseholds,
    refrigerated,
    frozen,
    esi,
  };
}

// ---------- text helpers (always from computed values) ----------

export function pct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const x = v * 100;
  if (x > 0 && x < 1) return '<1 %';
  if (x < 100 && x > 99) return '>99 %';
  return `${Math.round(x)} %`;
}

export function fmtDur(h: number): string {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(0, Math.round(h * 60))} min`;
  if (h < 48) return `${Number(h.toFixed(h < 10 ? 1 : 0))} h`;
  return `${Number((h / 24).toFixed(1))} days`;
}

/** Time since the outage began, for event text. */
export function fmtWhen(t: number): string {
  if (t < 72) return `${Number(t.toFixed(t < 10 ? 1 : 0))} h`;
  return `day ${Number((t / 24).toFixed(1))}`;
}

// ---------- per-system description for the status board ----------

export interface SystemRow {
  key: 'grid' | 'backup' | 'comms' | 'water' | 'transport' | 'refrigerated' | 'frozen' | 'foodHouseholds' | 'health' | 'esi';
  name: string;
  level: number;
  state: string;
  /** Backup that is merely on standby is not a problem even though nothing is running. */
  standby?: boolean;
}

export function describeSystems(s: BlackoutState, p: ParamValues): SystemRow[] {
  const a = inForce(p);
  const L = levels(s, p, a);
  const t = s.t;
  const off = L.need > 0.005;
  const rows: SystemRow[] = [];

  const d = a.restorationDelayH;
  const T = a.restorationTimeH;
  let gridState: string;
  if (L.grid >= 0.999) gridState = s.outage ? 'restored' : 'normal supply';
  else if (t < d) gridState = `down — restoration assumed to begin in ${fmtDur(d - t)}`;
  else gridState = `restoring — ${pct(L.grid)} reconnected, complete in ≈${fmtDur(Math.max(0, d + T - t))}`;
  rows.push({ key: 'grid', name: 'Grid power', level: L.grid, state: gridState });

  let backupState: string;
  const failed = 1 - s.W;
  const failText = failed > 0.02 ? `; ${pct(failed)} of units have failed` : '';
  if (!off) backupState = `standby — grid supplying${failText}`;
  else if (s.F > 1e-12) {
    const burn = L.need - L.resupply;
    backupState = burn > 1e-9 ? `running — ${fmtDur(s.F / burn)} of fuel left at current use${failText}` : `running — deliveries keep tanks topped up${failText}`;
  } else backupState = `fuel exhausted — deliveries cover ${pct(L.delivered)} of demand${failText}`;
  rows.push({ key: 'backup', name: 'Backup generation', level: L.backup, state: backupState, standby: !off });

  let commsState: string;
  if (!off) commsState = 'normal';
  else if (t < a.cellBatteryH) commsState = `on batteries — ${fmtDur(a.cellBatteryH - t)} left at a typical site`;
  else if (L.batteries > 0) commsState = `batteries running out — ${pct(L.batteries)} of unpowered sites still on battery`;
  else commsState = `batteries exhausted — only sites with running generators (${pct(a.cellGenerators * L.backup)} of unpowered sites)`;
  rows.push({ key: 'comms', name: 'Communications', level: L.comms, state: commsState });

  let waterState: string;
  if (!off) waterState = 'normal';
  else if (t < a.waterStorageH) waterState = `pressure from elevated storage — ≈${fmtDur(a.waterStorageH - t)} left in a typical system`;
  else if (L.storage > 0) waterState = `storage running out — ${pct(L.storage)} of unpowered systems still have stored water`;
  else waterState = `storage exhausted — pumping only where backup runs (${pct(a.waterBackup * L.backup)} of unpowered capacity)`;
  rows.push({ key: 'water', name: 'Water distribution', level: L.water, state: waterState });

  const transportState = L.pumps >= 0.995 && L.transport >= 0.995 ? 'normal' : `${pct(L.pumps)} of fuel stations can pump; vehicle fuel at ${pct(L.transport)} of normal`;
  rows.push({ key: 'transport', name: 'Fuel & transport', level: L.transport, state: transportState });

  const coldState = (limit: number, level: number, held: number, what: string) => {
    if (off && t < limit) return `safe for ${fmtDur(limit - t)} more without power (USDA: ≈${limit} h ${what})`;
    if (level >= 0.995) return 'safe';
    return `unsafe in homes without power for over ${limit} h; ${pct(held)} of homes have safe food again (power back in time or restocked)`;
  };
  rows.push({ key: 'refrigerated', name: 'Refrigerated food', level: L.refrigerated, state: coldState(a.fridgeH, L.refrigerated, s.X, 'in a closed fridge') });
  rows.push({ key: 'frozen', name: 'Frozen food', level: L.frozen, state: coldState(a.freezerH, L.frozen, s.Y, 'in a full, closed freezer') });

  let foodState: string;
  if (s.z < 0.05 && L.foodHouseholds >= 0.995) foodState = 'normal stocks';
  else {
    foodState = `average household has used ${Number(s.z.toFixed(1))} of ${Number(a.householdFoodDays.toFixed(1))} days of reserves; shops at ${pct(L.shops)}`;
    if (L.foodHouseholds < 0.995) foodState += `; ${pct(1 - L.foodHouseholds)} of households have run out`;
  }
  rows.push({ key: 'foodHouseholds', name: 'Household food', level: L.foodHouseholds, state: foodState });

  const healthState =
    L.health >= 0.995 ? 'normal' : `${pct(L.hospitalPower)} of hospital capacity powered; water ${pct(L.water)}, communications ${pct(L.comms)} and transport ${pct(L.transport)} limit the rest`;
  rows.push({ key: 'health', name: 'Healthcare', level: L.health, state: healthState });

  rows.push({ key: 'esi', name: 'Essential-services index', level: L.esi, state: 'weighted: water 25 %, healthcare 25 %, household food 20 %, communications 15 %, transport 15 %' });
  return rows;
}

// ---------- model ----------

function initialState(p: ParamValues): BlackoutState {
  const a = inForce(p);
  const G0 = gridLevel(0, a);
  return {
    t: 0,
    F: a.fuelOnHandH,
    Fcap: a.fuelOnHandH,
    W: 1,
    V: V0,
    z: 0,
    X: G0,
    Y: G0,
    commsPrev: 1,
    outage: G0 < 1,
    fuelOutReported: false,
    pending: [],
  };
}

function pushEvent(s: BlackoutState, e: Omit<SimEvent, 'source'>) {
  s.pending.push({ ...e, source: 'model' });
}

const isCustom = (key: string) => (p: ParamValues) => str(p, key) === 'custom';

function branchNote(axis: string, values: string): string {
  return `Used when ${axis} is set to Custom. Branch values — ${values}.`;
}

const restorationOptions = [
  ...(Object.keys(RESTORATION) as RestorationBranch[]).map((k) => ({ value: k, label: RESTORATION[k].label, description: `Grid ${restorationDetail(k)}.` })),
  { value: 'custom', label: 'Custom numbers', description: 'Use the restoration numbers under Advanced assumptions.' },
];
const preparednessOptions = [
  ...(Object.keys(PREPAREDNESS) as PreparednessBranch[]).map((k) => ({ value: k, label: PREPAREDNESS[k].label, description: `${preparednessDetail(k)[0].toUpperCase()}${preparednessDetail(k).slice(1)}.` })),
  { value: 'custom', label: 'Custom numbers', description: 'Use the preparedness numbers under Advanced assumptions.' },
];
const logisticsOptions = [
  ...(Object.keys(LOGISTICS) as LogisticsBranch[]).map((k) => ({ value: k, label: LOGISTICS[k].label, description: `${logisticsDetail(k)[0].toUpperCase()}${logisticsDetail(k).slice(1)}.` })),
  { value: 'custom', label: 'Custom numbers', description: 'Use the logistics numbers under Advanced assumptions.' },
];

const prepValues = (k: keyof (typeof PREPAREDNESS)['well'], unit: string) =>
  (Object.keys(PREPAREDNESS) as PreparednessBranch[]).map((b) => `${PREPAREDNESS[b].label}: ${PREPAREDNESS[b][k]}${unit}`).join(' · ');
const restValues = (k: 'restorationDelay' | 'restorationTime') =>
  (Object.keys(RESTORATION) as RestorationBranch[]).map((b) => `${RESTORATION[b].label.split(' ')[0]}: ${RESTORATION[b][k]} d`).join(' · ');
const logValues = (k: 'resupplyCapacity' | 'terminalBackup') => (Object.keys(LOGISTICS) as LogisticsBranch[]).map((b) => `${LOGISTICS[b].label}: ${LOGISTICS[b][k]} %`).join(' · ');

const ADV = 'Advanced assumptions';
const levelKeys = ['grid', 'backup', 'comms', 'water', 'transport', 'health', 'foodHouseholds', 'refrigerated', 'frozen', 'esi'] as const;

export const blackoutModel: SimulationModel<BlackoutState> = {
  id: 'blackout',
  name: 'Wide-Area Blackout Scenario',
  shortName: 'Blackout',
  domain: 'technology',
  viewKind: '2d',
  summary:
    'A branching system-dynamics scenario of a sudden, long loss of grid power. Backup generators, communications, water, fuel and transport, cold food, household food and healthcare each depend explicitly on the grid and on each other; branches set groups of assumptions.',
  params: [
    { key: 'restoration', label: 'Grid restoration', type: 'choice', kind: 'initial', group: 'Scenario branches', default: 'regional', options: restorationOptions, description: 'How quickly the grid comes back. Each branch sets the restoration delay and duration (listed in each option).' },
    { key: 'preparedness', label: 'Backup preparedness', type: 'choice', kind: 'initial', group: 'Scenario branches', default: 'typical', options: preparednessOptions, description: 'Generator coverage, batteries, water storage, fuel on hand and generator reliability (listed in each option). Illustrative assumptions, not survey data.' },
    { key: 'logistics', label: 'Fuel logistics', type: 'choice', kind: 'initial', group: 'Scenario branches', default: 'prioritised', options: logisticsOptions, description: 'Whether fuel deliveries to critical facilities are organised and prioritised or disrupted.' },
    // Advanced: restoration
    { key: 'restorationDelay', label: 'Restoration starts after', type: 'number', unit: 'day', kind: 'initial', group: ADV, min: 0, max: 60, step: 0.25, default: 2, description: branchNote('Grid restoration', restValues('restorationDelay')), visibleWhen: isCustom('restoration') },
    { key: 'restorationTime', label: 'Time to restore fully once started', type: 'number', unit: 'day', kind: 'initial', group: ADV, min: 0, max: 180, step: 0.5, default: 21, description: `${branchNote('Grid restoration', restValues('restorationTime'))} Set both to 0 for a reference run in which the grid never goes down.`, visibleWhen: isCustom('restoration') },
    // Advanced: preparedness
    { key: 'hospitalBackup', label: 'Hospitals with backup generators', type: 'number', unit: '%', kind: 'initial', group: ADV, min: 0, max: 100, step: 1, default: 90, description: branchNote('Backup preparedness', prepValues('hospitalBackup', ' %')), visibleWhen: isCustom('preparedness') },
    { key: 'waterBackup', label: 'Water pumping with backup power', type: 'number', unit: '%', kind: 'initial', group: ADV, min: 0, max: 100, step: 1, default: 35, description: `Share of pumping capacity with generators or gravity supply. ${branchNote('Backup preparedness', prepValues('waterBackup', ' %'))}`, visibleWhen: isCustom('preparedness') },
    { key: 'cellGenerators', label: 'Cell sites with generators', type: 'number', unit: '%', kind: 'initial', group: ADV, min: 0, max: 100, step: 1, default: 30, description: branchNote('Backup preparedness', prepValues('cellGenerators', ' %')), visibleWhen: isCustom('preparedness') },
    { key: 'cellBattery', label: 'Typical cell-site battery runtime', type: 'number', unit: 'h', kind: 'initial', group: ADV, min: 0.5, max: 48, step: 0.5, default: 4, description: `Runtimes are spread ±50 % around this value. ${branchNote('Backup preparedness', prepValues('cellBattery', ' h'))}`, visibleWhen: isCustom('preparedness') },
    { key: 'waterStorage', label: 'Typical elevated water storage lasts', type: 'number', unit: 'h', kind: 'initial', group: ADV, min: 1, max: 96, step: 1, default: 12, description: `Spread ±50 % across systems. ${branchNote('Backup preparedness', prepValues('waterStorage', ' h'))}`, visibleWhen: isCustom('preparedness') },
    { key: 'fuelOnHand', label: 'Generator fuel on hand', type: 'number', unit: 'h', kind: 'initial', group: ADV, min: 0, max: 336, step: 1, default: 48, description: `Hours of full-load running stored at backed-up facilities. ${branchNote('Backup preparedness', prepValues('fuelOnHand', ' h'))}`, visibleWhen: isCustom('preparedness') },
    { key: 'pumpBackup', label: 'Fuel stations with backup power', type: 'number', unit: '%', kind: 'initial', group: ADV, min: 0, max: 100, step: 1, default: 10, description: branchNote('Backup preparedness', prepValues('pumpBackup', ' %')), visibleWhen: isCustom('preparedness') },
    { key: 'generatorFailure', label: 'Generator failure rate while running', type: 'number', unit: '%/day', kind: 'initial', group: ADV, min: 0, max: 20, step: 0.1, default: 2, description: branchNote('Backup preparedness', prepValues('generatorFailure', ' %/day')), visibleWhen: isCustom('preparedness') },
    // Advanced: logistics
    { key: 'resupplyCapacity', label: 'Fuel resupply capacity', type: 'number', unit: '%', kind: 'initial', group: ADV, min: 0, max: 200, step: 1, default: 100, description: `Deliveries per hour as a share of full-load generator demand, when depots have power and communications work. ${branchNote('Fuel logistics', logValues('resupplyCapacity'))} 0 means no resupply at all.`, visibleWhen: isCustom('logistics') },
    { key: 'terminalBackup', label: 'Fuel depots with backup power', type: 'number', unit: '%', kind: 'initial', group: ADV, min: 0, max: 100, step: 1, default: 90, description: branchNote('Fuel logistics', logValues('terminalBackup')), visibleWhen: isCustom('logistics') },
    // Always-on assumptions
    { key: 'restorationCurve', label: 'Restoration curve shape', type: 'choice', kind: 'initial', group: 'Other assumptions', default: 'scurve', options: [
      { value: 'scurve', label: 'S-curve', description: 'Slow start (black start, first islands), faster middle, slow tail (normalised logistic).' },
      { value: 'linear', label: 'Linear', description: 'Constant restoration speed.' },
    ], description: 'Shape of grid restoration between its start and completion. Illustrative.' },
    { key: 'householdFood', label: 'Household food reserves (average)', type: 'number', unit: 'day', kind: 'initial', group: 'Other assumptions', min: 0.5, max: 60, step: 0.5, default: 7, description: 'Days of food an average household has at home, spread ±50 % across households. An assumption that varies widely; preparedness agencies commonly recommend keeping at least several days of supplies.' },
    { key: 'vehicleTank', label: 'Days a vehicle’s fuel lasts', type: 'number', unit: 'day', kind: 'initial', group: 'Other assumptions', min: 1, max: 30, step: 0.5, default: 7, description: 'How long the fuel in an average tank (assumed half full) lasts at reduced driving if pumps are down.' },
    { key: 'fridgeHours', label: 'Refrigerator keeps food safe for', type: 'number', unit: 'h', kind: 'initial', group: 'Other assumptions', min: 1, max: 12, step: 0.5, default: 4, description: 'USDA food-safety guidance: about 4 hours if the door stays closed.' },
    { key: 'freezerHours', label: 'Full freezer keeps food safe for', type: 'number', unit: 'h', kind: 'initial', group: 'Other assumptions', min: 6, max: 96, step: 1, default: 48, description: 'USDA food-safety guidance: about 48 hours for a full freezer (24 hours if half full), door closed.' },
    // Numerics
    { key: 'durationDays', label: 'Simulation duration', type: 'number', unit: 'day', kind: 'initial', group: 'Numerics', numerics: true, min: 1, max: 60, step: 1, default: 30, description: 'Run length in days (model time is in hours).' },
    { key: 'dt', label: 'Time step', type: 'number', unit: 'h', kind: 'initial', group: 'Numerics', numerics: true, min: 0.05, max: 1, step: 0.05, default: 0.25, description: 'Explicit-Euler step. Thresholds such as the 4-hour refrigerator limit are timed exactly regardless of the step.' },
  ],
  observables: [
    { key: 'esi', label: 'Essential-services index', unit: '%', provenance: 'simulated', chart: true, chartGroup: 'levels', sig: 3, description: 'Weighted average: water 25 %, healthcare 25 %, household food 20 %, communications 15 %, transport 15 %.' },
    { key: 'grid', label: 'Grid power', unit: '%', provenance: 'assumed', chart: true, chartGroup: 'levels', sig: 3, description: 'Prescribed by the restoration branch.' },
    { key: 'backup', label: 'Backup generation available', unit: '%', provenance: 'simulated', chartGroup: 'levels', sig: 3, description: 'Share of installed generators that are working and fuelled.' },
    { key: 'comms', label: 'Communications', unit: '%', provenance: 'simulated', chartGroup: 'levels', sig: 3 },
    { key: 'water', label: 'Water distribution', unit: '%', provenance: 'simulated', chart: true, chartGroup: 'levels', sig: 3 },
    { key: 'transport', label: 'Fuel & transport', unit: '%', provenance: 'simulated', chartGroup: 'levels', sig: 3, description: 'Vehicle fuel relative to normal.' },
    { key: 'health', label: 'Healthcare', unit: '%', provenance: 'simulated', chart: true, chartGroup: 'levels', sig: 3 },
    { key: 'foodHouseholds', label: 'Households with food', unit: '%', provenance: 'simulated', chartGroup: 'food', sig: 3 },
    { key: 'refrigerated', label: 'Safe refrigerated food', unit: '%', provenance: 'simulated', chartGroup: 'food', sig: 3, description: 'Share of households whose refrigerated food is still safe (USDA ≈4 h limit).' },
    { key: 'frozen', label: 'Safe frozen food', unit: '%', provenance: 'simulated', chartGroup: 'food', sig: 3, description: 'Share of households whose frozen food is still safe (USDA ≈48 h for a full freezer).' },
    { key: 'fuel', label: 'Backup fuel remaining', unit: 'h', provenance: 'simulated', chartGroup: 'fuel', sig: 3, description: 'Hours of full-load generator running left in storage.' },
    { key: 'fuelPct', label: 'Backup fuel remaining (% of tanks)', unit: '%', provenance: 'simulated', chartGroup: 'supply', readout: false, sig: 3 },
    { key: 'resupply', label: 'Fuel deliveries', unit: '%', provenance: 'simulated', chartGroup: 'supply', readout: false, sig: 3, description: 'Deliveries as a share of full-load generator demand.' },
    { key: 'generatorsWorking', label: 'Generators still working', unit: '%', provenance: 'simulated', chartGroup: 'supply', readout: false, sig: 3 },
    { key: 'pumps', label: 'Fuel stations able to pump', unit: '%', provenance: 'simulated', chartGroup: 'supply', readout: false, sig: 3 },
    { key: 'shops', label: 'Food shops operating', unit: '%', provenance: 'simulated', chartGroup: 'supply', readout: false, sig: 3 },
  ],
  primaryObservables: ['esi', 'water'],
  time: {
    unit: 'h',
    dt: (p) => num(p, 'dt'),
    sampleInterval: (p) => Math.max(num(p, 'dt'), 1),
    defaultDuration: (p) => num(p, 'durationDays') * 24,
    maxDuration: 1440,
    realtimeRate: 12,
    milestones: (p) => [...new Set([24, 72, 168, 336, 720, 1440, num(p, 'durationDays') * 24])],
  },

  init(p) {
    const s = initialState(p);
    const a = inForce(p);
    if (s.outage) {
      const R = str(p, 'restoration');
      pushEvent(s, {
        t: 0,
        id: 'outage-start',
        label: 'Wide-area grid power lost',
        detail: `Grid supply drops to 0 %. In this ${R === 'custom' ? 'custom' : RESTORATION[R as RestorationBranch]?.label.toLowerCase() ?? ''} scenario restoration begins after ${fmtDur(a.restorationDelayH)} and takes ${fmtDur(a.restorationTimeH)}. Batteries, stored water and fuel on hand now carry the load.`,
        severity: 'critical',
      });
      if (a.restorationDelayH <= 0 && a.restorationTimeH > 0) pushEvent(s, { t: 0, id: 'restoration-begins', label: 'Grid restoration begins', detail: 'Reconnection starts immediately.', severity: 'info' });
      if (a.fuelOnHandH <= 0) {
        s.fuelOutReported = true;
        pushEvent(s, { t: 0, id: 'fuel-exhausted', label: 'No generator fuel on hand', detail: 'Generators can only run as fast as deliveries arrive.', severity: 'critical' });
      }
    }
    return s;
  },

  step(s, p, dt) {
    const a = inForce(p);
    const t0 = s.t;
    const t1 = t0 + dt;
    const L = levels(s, p, a, t0);
    const G1 = gridLevel(t1, a);

    // Generator fuel: deliveries in, consumption out, capped by tank capacity.
    const burn = L.need * L.delivered;
    const F1raw = s.F + (L.resupply - burn) * dt;
    if (!s.fuelOutReported && s.F > 0 && F1raw <= 0 && L.need > 0.005) {
      s.fuelOutReported = true;
      const tc = t0 + s.F / Math.max(1e-12, burn - L.resupply);
      const cover = L.need > 0 ? Math.min(1, L.resupply / L.need) : 1;
      pushEvent(s, {
        t: tc,
        id: 'fuel-exhausted',
        label: 'Backup generator fuel on hand exhausted',
        detail: `After ${fmtWhen(tc)}. Generators can now run only as fast as deliveries arrive — about ${pct(cover)} of demand — so hospitals, water pumping and cell sites with generators lose power accordingly.`,
        severity: 'critical',
      });
    }
    s.F = Math.min(s.Fcap, Math.max(0, F1raw));
    // Generator failures while running (exact exponential decay for constant rates over the step).
    s.W *= Math.exp(-a.failurePerH * burn * dt);
    // Vehicle fuel: tanks drain at reduced driving; refuelling where pumps have power.
    const use = V0 / (24 * a.vehicleTankDays);
    const dV = -(s.V > 0 ? use : 0) + L.pumps * (use + REFUEL_RATE * Math.max(0, V0 - s.V));
    s.V = clamp01(s.V + dV * dt);
    // Household food deficit (days): consumption not covered by shops, minus restocking.
    const dz = (1 / 24) * (1 - L.shops) - (L.shops * s.z) / RESTOCK_H;
    s.z = Math.max(0, s.z + dz * dt);
    // Safe cold food among households with power: restored before the limit, or restocked since.
    const restock = (L.shops / RESTOCK_H) * dt;
    const inTime = (limit: number) => gridLevel(Math.min(t1, limit), a) - gridLevel(Math.min(t0, limit), a);
    s.X = Math.min(G1, s.X + inTime(a.fridgeH) + restock * Math.max(0, L.grid - s.X));
    s.Y = Math.min(G1, s.Y + inTime(a.freezerH) + restock * Math.max(0, L.grid - s.Y));
    s.commsPrev = L.comms;
    s.t = t1;

    if (!s.outage) return;
    const offAt = (t: number) => 1 - gridLevel(t, a) > 0.005;
    const crosses = (T: number) => t0 < T && T <= t1 + 1e-9;

    // Grid restoration milestones.
    const d = a.restorationDelayH;
    if (a.restorationTimeH > 0 && d > 0 && crosses(d)) pushEvent(s, { t: d, id: 'restoration-begins', label: 'Grid restoration begins', detail: `After ${fmtWhen(d)} without power. Reconnection is assumed to take ${fmtDur(a.restorationTimeH)}.`, severity: 'info' });
    for (const [lvl, id, label, sev] of [
      [0.5, 'grid-50', 'Grid 50 % restored', 'milestone'],
      [0.9, 'grid-90', 'Grid 90 % restored', 'milestone'],
      [0.999, 'grid-100', 'Grid fully restored', 'milestone'],
    ] as const) {
      if (L.grid < lvl && G1 >= lvl) {
        const tc = G1 > L.grid ? t0 + ((lvl - L.grid) / (G1 - L.grid)) * dt : t1;
        pushEvent(s, { t: tc, id, label, detail: `${fmtWhen(tc)} after the outage began. Essential-services index ${pct(L.esi)} at that point.`, severity: sev });
      }
    }

    // Buffers with known typical durations.
    const fixed: [number, string, string, string, SimEvent['severity']][] = [
      [a.cellBatteryH, 'cell-batteries', 'Typical cell-site batteries exhausted', `Half of the cell sites without grid power have now run their batteries flat; only sites with running generators stay on air (communications ${pct(L.comms)}).`, 'warning'],
      [(1 + SPREAD) * a.cellBatteryH, 'cell-batteries-all', 'All cell-site batteries exhausted', `Communications now depend entirely on generators at ${pct(a.cellGenerators)} of sites (communications ${pct(L.comms)}).`, 'warning'],
      [a.waterStorageH, 'water-storage', 'Elevated water storage exhausted in typical systems', `Without pumping power, half of the unpowered water systems have drained their storage (water service ${pct(L.water)}).`, 'warning'],
      [(1 + SPREAD) * a.waterStorageH, 'water-storage-all', 'Elevated water storage exhausted everywhere', `Water now reaches only systems with backup pumping (water service ${pct(L.water)}).`, 'critical'],
      [a.fridgeH, 'fridge-unsafe', `Refrigerated food unsafe in homes still without power (${Number(a.fridgeH.toFixed(1))} h)`, `${pct(L.need)} of households were still without power ${fmtWhen(a.fridgeH)} after the outage began. USDA guidance: refrigerated perishable food kept above 40 °F (4 °C) for over 4 hours should be discarded.`, 'warning'],
      [a.freezerH, 'freezer-unsafe', `Frozen food unsafe in homes still without power (${Number(a.freezerH.toFixed(0))} h)`, `${pct(L.need)} of households were still without power ${fmtWhen(a.freezerH)} after the outage began. USDA guidance: a full freezer holds its temperature for about 48 hours (24 hours if half full) with the door closed.`, 'warning'],
    ];
    for (const [T, id, label, detail, severity] of fixed) {
      if (crosses(T) && offAt(T)) pushEvent(s, { t: T, id, label, detail, severity });
    }
  },

  observe(s, p) {
    const L = levels(s, p);
    const out: Record<string, number> = {};
    for (const k of levelKeys) out[k] = L[k] * 100;
    out.fuel = L.fuelH;
    out.fuelPct = L.fuelPct * 100;
    out.resupply = L.resupply * 100;
    out.generatorsWorking = L.generatorsWorking * 100;
    out.pumps = L.pumps * 100;
    out.shops = L.shops * 100;
    return out;
  },

  clone(s) {
    return { ...s, pending: [...s.pending] };
  },

  time_of: (s) => s.t,

  detectEvents(_prev, _cur, s) {
    const out = s.pending.sort((a, b) => a.t - b.t);
    s.pending = [];
    return out;
  },

  thresholds: [
    { id: 'esi-75', observable: 'esi', op: '<', value: 75, label: 'Essential services below 75 % of normal', detail: (v, t) => `${fmtWhen(t)}: index at ${Math.round(v)} %.`, severity: 'warning' },
    { id: 'esi-50', observable: 'esi', op: '<', value: 50, label: 'Essential services below half of normal', detail: (v, t) => `${fmtWhen(t)}: index at ${Math.round(v)} %.`, severity: 'critical' },
    { id: 'water-50', observable: 'water', op: '<', value: 50, label: 'Water service below half', detail: (v, t) => `${fmtWhen(t)}: ${Math.round(v)} % of normal water distribution.`, severity: 'critical' },
    { id: 'comms-50', observable: 'comms', op: '<', value: 50, label: 'Communications below half', detail: (v, t) => `${fmtWhen(t)}: ${Math.round(v)} % of normal.`, severity: 'warning' },
    { id: 'health-50', observable: 'health', op: '<', value: 50, label: 'Healthcare capacity below half', detail: (v, t) => `${fmtWhen(t)}: ${Math.round(v)} % of normal.`, severity: 'critical' },
    { id: 'transport-50', observable: 'transport', op: '<', value: 50, label: 'Vehicle fuel below half of normal', detail: (v, t) => `${fmtWhen(t)}: ${Math.round(v)} % of normal.`, severity: 'warning' },
    { id: 'backup-50', observable: 'backup', op: '<', value: 50, label: 'Less than half of backup generation available', detail: (v, t) => `${fmtWhen(t)}: ${Math.round(v)} % of installed generators working and fuelled.`, severity: 'warning' },
    { id: 'food-90', observable: 'foodHouseholds', op: '<', value: 90, label: 'First households run out of food at home', detail: (v, t) => `${fmtWhen(t)}: ${Math.round(100 - v)} % of households have no food left.`, severity: 'warning' },
    { id: 'food-50', observable: 'foodHouseholds', op: '<', value: 50, label: 'Half of households have run out of food at home', detail: (v, t) => `${fmtWhen(t)}: household food reserves exhausted for ${Math.round(100 - v)} % of households.`, severity: 'critical' },
  ],

  describeMilestone(t, obs, p) {
    const end = Math.abs(t - num(p, 'durationDays') * 24) < 1e-6;
    const day = Number((t / 24).toFixed(1));
    return {
      label: `${end ? 'End of run — day' : 'Day'} ${day}: essential services at ${Math.round(obs.esi)} %`,
      detail: `Grid ${Math.round(obs.grid)} %, water ${Math.round(obs.water)} %, healthcare ${Math.round(obs.health)} %, communications ${Math.round(obs.comms)} %, fuel & transport ${Math.round(obs.transport)} %, households with food ${Math.round(obs.foodHouseholds)} %. Backup fuel left: ${fmtDur(obs.fuel)} of full-load running.`,
    };
  },

  derived(p) {
    const a = inForce(p);
    const half = a.restorationDelayH + a.restorationTimeH / 2;
    const out: DerivedQuantity[] = [
      { key: 'gridHalf', label: 'Grid 50 % restored at', value: half / 24, unit: 'day', formula: 'delay + T/2 (both curve shapes are symmetric)', provenance: 'assumed', note: 'Set by the restoration branch.' },
      { key: 'gridFull', label: 'Grid fully restored at', value: (a.restorationDelayH + a.restorationTimeH) / 24, unit: 'day', formula: 'delay + T', provenance: 'assumed' },
      { key: 'fuelNoResupply', label: 'Generator fuel lasts without resupply', value: a.fuelOnHandH, unit: 'h', provenance: 'assumed', note: 'At full load with the grid down.' },
      { key: 'battery', label: 'Typical cell-site battery runtime', value: a.cellBatteryH, unit: 'h', provenance: 'assumed' },
      { key: 'foodFirst', label: 'First households out of food (no shops at all)', value: (1 - SPREAD) * a.householdFoodDays, unit: 'day', formula: '(1 − 0.5)·D', provenance: 'derived', note: 'Shops that still operate stretch this.' },
    ];
    return out;
  },

  warnings(p) {
    const a = inForce(p);
    const w: Warning[] = [];
    if (a.restorationDelayH <= 0 && a.restorationTimeH <= 0) w.push({ id: 'no-outage', message: 'Restoration delay and time are both 0: the grid never goes down (reference run).', severity: 'info' });
    if (a.restorationDelayH >= num(p, 'durationDays') * 24) w.push({ id: 'before-restoration', message: 'The run ends before grid restoration begins.', severity: 'info' });
    if (a.resupply <= 0) w.push({ id: 'no-resupply', message: 'Fuel resupply is 0: generators stop when the fuel on hand runs out.', severity: 'info' });
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const out: KeyResult[] = [];
    const t = run.samples.t;
    const esi = run.samples.obs.esi ?? [];
    if (!esi.length) return out;
    let j = 0;
    for (let i = 1; i < esi.length; i++) if (esi[i] < esi[j]) j = i;
    out.push({ label: 'Lowest essential-services index', value: esi[j], unit: '%', provenance: 'simulated', sig: 3, note: `At ${fmtWhen(t[j])}.` });
    let area = 0;
    for (let i = 1; i < t.length; i++) area += 0.5 * (esi[i] + esi[i - 1]) * (t[i] - t[i - 1]);
    const span = t[t.length - 1] - t[0];
    if (span > 0) out.push({ label: 'Average essential-services index over the run', value: area / span, unit: '%', provenance: 'simulated', sig: 3 });
    out.push({ label: 'Essential-services index at the end', value: run.final.esi, unit: '%', provenance: 'simulated', sig: 3 });
    const ev = (id: string) => run.events.find((e) => e.id === id);
    for (const [id, label] of [
      ['fuel-exhausted', 'Generator fuel on hand ran out'],
      ['water-50', 'Water service fell below half'],
      ['food-50', 'Half of households out of food'],
      ['grid-50', 'Grid 50 % restored'],
      ['grid-90', 'Grid 90 % restored'],
    ] as const) {
      const e = ev(id);
      if (e) out.push({ label, value: e.t / 24, unit: 'day', provenance: 'simulated', sig: 3 });
    }
    out.push({ label: 'Households with food at the end', value: run.final.foodHouseholds, unit: '%', provenance: 'simulated', sig: 3 });
    return out;
  },

  assumptions: [
    { kind: 'simplification', text: 'This is a transparent scenario model rather than a prediction of how any country would respond. Branches are illustrative bundles of assumptions, not measured national data.' },
    { kind: 'simplification', text: 'Grid power is prescribed by the restoration branch (a delay, then a linear or S-shaped rise). Black-start capability, fuel, crews and communications are not modelled as constraints on restoration.' },
    { kind: 'established', text: 'Refrigerated food is treated as unsafe after about 4 hours without power and a full freezer after about 48 hours (24 hours if half full), following USDA food-safety guidance for closed doors.' },
    { kind: 'approximation', text: 'Restoration is assumed to reach households and sites at random, so those still without power have been without it since the start; buffers (batteries, water storage, home food) vary uniformly ±50 % around their typical values.' },
    { kind: 'speculative', text: 'Branch numbers (generator coverage, battery runtimes, storage, fuel on hand, failure rates, delivery capacity) are illustrative assumptions chosen to span plausible preparedness; they are not survey data for any country.' },
    { kind: 'simplification', text: 'All backed-up facilities share one generator-fuel pool and one delivery chain. Deliveries need fuel depots with power and are halved without communications (one-step lag).' },
    { kind: 'simplification', text: 'Fuel stations with power are assumed to have fuel to sell; station inventories, refineries and imports are not modelled.' },
    { kind: 'speculative', text: 'Healthcare capacity = powered share of hospitals × (0.6 + 0.2·water + 0.1·communications + 0.1·transport); unpowered hospitals keep 15 % of capacity. These weights are illustrative.' },
    { kind: 'simplification', text: 'The essential-services index is a weighted average chosen for illustration (water 25 %, healthcare 25 %, household food 20 %, communications 15 %, transport 15 %); it is not a validated index.' },
  ],
  limitations: [
    'Human behaviour (panic buying, hoarding, evacuation, mutual aid, crime), organised emergency response and international assistance are not modelled, or only crudely through the branches.',
    'Cascading failures across borders, cyberattacks, damage to the grid itself and the reasons for the outage are not represented.',
    'Health outcomes (illness, deaths, heat or cold exposure, medical-device dependence) are not modelled; healthcare is only a capacity level.',
    'Heating and cooling, sanitation and sewage, banking and payments, industry and agriculture are not represented.',
    'Uncertainty: how long backup fuel lasts dominates the first days; how fast the grid returns dominates everything after that. The envelope across branches shows how much the outcome depends on these choices — it is a range across modelled branches, not a probability.',
  ],
  equations: [
    { label: 'Grid', formula: 'G(t) = 0 for t < t_d;  x = min(1, (t − t_d)/T_r);  G = x (linear) or [σ(10(x − ½)) − σ(−5)] / [σ(5) − σ(−5)] (S-curve)', explanation: 'Restoration starts after delay t_d and completes over T_r, both set by the restoration branch.' },
    { label: 'Buffer share', formula: 'b(t; N) = clamp((1.5N − t) / N, 0, 1)', explanation: 'Share of sites whose buffer (battery runtime, stored water) of typical size N hours still lasts; buffers spread uniformly from 0.5N to 1.5N.' },
    { label: 'Fuel deliveries', formula: 'R = ρ · [G + (1 − G)·s_depot] · (0.5 + 0.5·C(t − Δt))', explanation: 'Delivery capacity ρ (share of full generator demand per hour), scaled by depots with power and halved without communications.' },
    { label: 'Generator fuel and output', formula: 'dF/dt = R − (1 − G)·u,  u = 1 if F > 0 else min(1, R/(1 − G)),  F ≤ F_cap,  dW/dt = −λ·(1 − G)·u·W,  B = W·u', explanation: 'Fuel on hand F (hours of full-load running) falls while generators run and refills with deliveries; generators fail at rate λ while running; B is the share of backup generation available.' },
    { label: 'Communications', formula: 'C = G + (1 − G)·[s_cell·max(B, b(t; N_bat)) + (1 − s_cell)·b(t; N_bat)]', explanation: 'Unpowered cell sites run on batteries, then only those with generators (share s_cell) stay on air.' },
    { label: 'Water', formula: 'Wt = G + (1 − G)·[s_w·max(B, b(t; N_store)) + (1 − s_w)·b(t; N_store)]', explanation: 'Elevated storage keeps pressure for a while; afterwards only systems with backup pumping (share s_w) deliver.' },
    { label: 'Fuel & transport', formula: 'Pu = G + (1 − G)·s_pump·W,  dV/dt = −v·[V > 0] + Pu·(v + k·max(0, V₀ − V)),  T = min(1, V/V₀)', explanation: 'Vehicle tanks (average V₀ = ½) drain at v = V₀/(24·days per tank); where pumps have power, vehicles refuel toward normal (k = 1/12 h⁻¹).' },
    { label: 'Healthcare', formula: 'H = [G + (1 − G)·(c_h·B + (1 − c_h·B)·0.15)] · (0.6 + 0.2·Wt + 0.1·C + 0.1·T)', explanation: 'Powered hospital capacity, reduced by water, communications and transport shortfalls.' },
    { label: 'Household food', formula: 'Shop = min(T, G + 0.2(1 − G)),  dz/dt = (1/24)(1 − Shop) − Shop·z/48 h,  Food = clamp((1.5D − z)/D, 0, 1)', explanation: 'z is the days of reserves used net of restocking; households hold 0.5D–1.5D days of food.' },
    { label: 'Cold food', formula: 'dX = ΔG(t ≤ 4 h) + Shop·(G − X)·dt/48 h,  safe fridge share = X + (1 − G)·[t < 4 h]   (freezer: same with 48 h)', explanation: 'Food is safe if power returned before the USDA limit or was restocked since; homes still without power keep safe food only until the limit.' },
    { label: 'Essential-services index', formula: 'ESI = 0.25·Wt + 0.25·H + 0.20·Food + 0.15·C + 0.15·T', explanation: 'Illustrative weighting of outcome systems (grid and backup are inputs, not outcomes).' },
  ],
  education: {
    objectives: [
      'Trace how a loss of grid power propagates through dependent systems: communications, water, fuel, food and healthcare.',
      'Distinguish buffers (batteries, stored water, fuel on hand, food at home) from sustained supply (resupply, restoration).',
      'Compare branches and explain which assumption dominates the outcome at different times.',
      'Read an envelope across scenario branches without mistaking it for a probability.',
    ],
    background: {
      beginner:
        'Almost everything around us needs electricity: phone masts, water pumps, fuel pumps, fridges and hospitals. When the power goes out, batteries, water towers, generators and the food in our cupboards keep things going for a while. This model shows how long each of those lasts and what happens when they run out — and how much depends on how quickly the power comes back.',
      intermediate:
        'Each system has a buffer that buys time: cell sites run on batteries for hours, elevated water storage keeps pressure for around a day, generators run for as long as their fuel lasts, and households have days of food. After the buffer, the service level depends on backup coverage and on resupply, which itself depends on other systems (fuel deliveries need depots with power and communications). Restoration of the grid is the only thing that ends the cascade. The 4-hour (refrigerator) and 48-hour (full freezer) food-safety limits come from USDA guidance.',
      advanced:
        'The model is a small system-dynamics network with five stocks (generator fuel, working generators, vehicle fuel, household food deficit, safe cold food) and algebraic service levels. Heterogeneity is represented by uniform distributions of buffer sizes, which turns cliff-edge depletion into ramps. The comms → deliveries → generators → comms loop is closed with a one-step lag. Branches change parameter bundles; the envelope across all 18 named combinations reflects structural scenario uncertainty, while parameter uncertainty within a branch is not sampled.',
    },
    variables: [
      { symbol: 'G', meaning: 'grid service level', unit: '%' },
      { symbol: 't_d, T_r', meaning: 'restoration delay and duration', unit: 'days' },
      { symbol: 'F, F_cap', meaning: 'generator fuel on hand and tank capacity', unit: 'h of full-load running' },
      { symbol: 'R, ρ', meaning: 'fuel deliveries and delivery capacity', unit: '% of generator demand' },
      { symbol: 'W, λ', meaning: 'working generators and failure rate', unit: '%, %/day' },
      { symbol: 'B', meaning: 'backup generation available (working × fuelled)', unit: '%' },
      { symbol: 'N_bat, N_store', meaning: 'typical battery runtime and water-storage duration', unit: 'h' },
      { symbol: 's_cell, s_w, s_pump, c_h', meaning: 'shares of cell sites, water pumping, fuel stations and hospitals with backup', unit: '%' },
      { symbol: 'V, T', meaning: 'vehicle tank level and transport level', unit: '%' },
      { symbol: 'z, D', meaning: 'household food deficit and average reserves', unit: 'days' },
      { symbol: 'ESI', meaning: 'essential-services index', unit: '%' },
    ],
    guidedSteps: [
      'Run the default branch path and note the order of events in the first two days: refrigerated food, cell batteries, water storage, generator fuel.',
      'Switch Fuel logistics to Disrupted. When does the backup fuel run out now, and what happens to water and healthcare?',
      'Switch Backup preparedness to Well-prepared. Which systems gain the most, and for how long?',
      'Choose Prolonged restoration. Compare the run with the shaded range across branches: where does it sit?',
      'Set every branch to Custom and set restoration delay and time to 0: check that every system stays at 100 % (the reference run).',
    ],
    questions: [
      'Why does communications fail before water in most branches?',
      'Which matters more for the first week: fuel on hand or fuel deliveries? For the second week?',
      'Why does refrigerated food become unsafe for almost everyone even in the rapid-restoration branch?',
      'What does the envelope across branches tell you, and what does it not tell you?',
    ],
  },
  dataSources: [
    {
      name: 'Food Safety During a Power Outage',
      provider: 'U.S. Department of Agriculture, Food Safety and Inspection Service (via FoodSafety.gov)',
      citation: 'USDA FSIS consumer guidance on keeping food safe during an emergency: a closed refrigerator keeps food safe for about 4 hours; a full freezer holds its temperature for about 48 hours (24 hours if half full).',
      url: 'https://www.foodsafety.gov/food-safety-charts/food-safety-during-power-outage',
      license: 'Public domain (U.S. government work)',
      notes: 'Used only for the two reference durations; no dataset is loaded.',
    },
  ],
};
