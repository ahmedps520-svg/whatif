/**
 * Unit handling. Every parameter and observable declares the unit the model
 * works in. Display conversion happens only at the UI boundary, so the model
 * never sees anything but its own declared unit.
 */

export type Quantity =
  | 'none'
  | 'length'
  | 'time'
  | 'mass'
  | 'velocity'
  | 'acceleration'
  | 'force'
  | 'energy'
  | 'power'
  | 'momentum'
  | 'pressure'
  | 'density'
  | 'temperature'
  | 'angle'
  | 'area'
  | 'ratio'
  | 'count'
  | 'rate'
  | 'irradiance'
  | 'luminosity';

interface UnitInfo {
  symbol: string;
  name: string;
  quantity: Quantity;
  /** Multiply by this to get the quantity's base unit (or use toBase/fromBase). */
  factor?: number;
  toBase?: (v: number) => number;
  fromBase?: (v: number) => number;
}

const U = {
  // dimensionless
  '1': { symbol: '', name: 'dimensionless', quantity: 'none', factor: 1 },
  '%': { symbol: '%', name: 'percent', quantity: 'ratio', factor: 0.01 },
  'x': { symbol: '×', name: 'multiple', quantity: 'none', factor: 1 },
  'count': { symbol: '', name: 'count', quantity: 'count', factor: 1 },
  'people': { symbol: 'people', name: 'people', quantity: 'count', factor: 1 },
  'billion': { symbol: 'billion', name: 'billion people', quantity: 'count', factor: 1e9 },
  'permille/yr': { symbol: '‰/yr', name: 'per thousand per year', quantity: 'rate', factor: 0.001 },
  '%/yr': { symbol: '%/yr', name: 'percent per year', quantity: 'rate', factor: 0.01 },
  '%/day': { symbol: '%/day', name: 'percent per day', quantity: 'rate', factor: 0.01 / 86400 },
  '1/yr': { symbol: '/yr', name: 'per year', quantity: 'rate', factor: 1 },
  'people/yr': { symbol: 'people/yr', name: 'people per year', quantity: 'rate', factor: 1 },
  'million': { symbol: 'million', name: 'million people', quantity: 'count', factor: 1e6 },
  'million/yr': { symbol: 'million/yr', name: 'million people per year', quantity: 'rate', factor: 1e6 },
  // length
  'm': { symbol: 'm', name: 'metre', quantity: 'length', factor: 1 },
  'cm': { symbol: 'cm', name: 'centimetre', quantity: 'length', factor: 0.01 },
  'mm': { symbol: 'mm', name: 'millimetre', quantity: 'length', factor: 0.001 },
  'km': { symbol: 'km', name: 'kilometre', quantity: 'length', factor: 1000 },
  'ft': { symbol: 'ft', name: 'foot', quantity: 'length', factor: 0.3048 },
  'mi': { symbol: 'mi', name: 'mile', quantity: 'length', factor: 1609.344 },
  'AU': { symbol: 'AU', name: 'astronomical unit', quantity: 'length', factor: 1.495978707e11 },
  'R_earth': { symbol: 'R⊕', name: 'Earth radius', quantity: 'length', factor: 6.371e6 },
  'R_sun': { symbol: 'R☉', name: 'solar radius', quantity: 'length', factor: 6.957e8 },
  'LD': { symbol: 'LD', name: 'lunar distance', quantity: 'length', factor: 3.844e8 },
  // time
  's': { symbol: 's', name: 'second', quantity: 'time', factor: 1 },
  'min': { symbol: 'min', name: 'minute', quantity: 'time', factor: 60 },
  'h': { symbol: 'h', name: 'hour', quantity: 'time', factor: 3600 },
  'day': { symbol: 'd', name: 'day', quantity: 'time', factor: 86400 },
  'yr': { symbol: 'yr', name: 'year', quantity: 'time', factor: 365.25 * 86400 },
  // mass
  'kg': { symbol: 'kg', name: 'kilogram', quantity: 'mass', factor: 1 },
  'g': { symbol: 'g', name: 'gram', quantity: 'mass', factor: 0.001 },
  't': { symbol: 't', name: 'tonne', quantity: 'mass', factor: 1000 },
  'lb': { symbol: 'lb', name: 'pound', quantity: 'mass', factor: 0.45359237 },
  'M_earth': { symbol: 'M⊕', name: 'Earth mass', quantity: 'mass', factor: 5.9722e24 },
  'M_moon': { symbol: 'M☾', name: 'Moon mass', quantity: 'mass', factor: 7.342e22 },
  'M_sun': { symbol: 'M☉', name: 'solar mass', quantity: 'mass', factor: 1.98847e30 },
  'M_jup': { symbol: 'M♃', name: 'Jupiter mass', quantity: 'mass', factor: 1.89813e27 },
  // velocity
  'm/s': { symbol: 'm/s', name: 'metre per second', quantity: 'velocity', factor: 1 },
  'km/s': { symbol: 'km/s', name: 'kilometre per second', quantity: 'velocity', factor: 1000 },
  'km/h': { symbol: 'km/h', name: 'kilometre per hour', quantity: 'velocity', factor: 1 / 3.6 },
  'mph': { symbol: 'mph', name: 'mile per hour', quantity: 'velocity', factor: 0.44704 },
  'ft/s': { symbol: 'ft/s', name: 'foot per second', quantity: 'velocity', factor: 0.3048 },
  'm/yr': { symbol: 'm/yr', name: 'metre per year', quantity: 'velocity', factor: 1 / (365.25 * 86400) },
  'mm/yr': { symbol: 'mm/yr', name: 'millimetre per year', quantity: 'velocity', factor: 0.001 / (365.25 * 86400) },
  'm/century': { symbol: 'm/century', name: 'metre per century', quantity: 'velocity', factor: 1 / (100 * 365.25 * 86400) },
  // acceleration
  'm/s2': { symbol: 'm/s²', name: 'metre per second squared', quantity: 'acceleration', factor: 1 },
  'gee': { symbol: 'g₀', name: 'standard gravity', quantity: 'acceleration', factor: 9.80665 },
  'ft/s2': { symbol: 'ft/s²', name: 'foot per second squared', quantity: 'acceleration', factor: 0.3048 },
  // force, energy, power, momentum
  'N': { symbol: 'N', name: 'newton', quantity: 'force', factor: 1 },
  'kgf': { symbol: 'kgf', name: 'kilogram-force', quantity: 'force', factor: 9.80665 },
  'lbf': { symbol: 'lbf', name: 'pound-force', quantity: 'force', factor: 4.4482216 },
  'J': { symbol: 'J', name: 'joule', quantity: 'energy', factor: 1 },
  'kJ': { symbol: 'kJ', name: 'kilojoule', quantity: 'energy', factor: 1000 },
  'MtTNT': { symbol: 'Mt TNT', name: 'megatonne of TNT', quantity: 'energy', factor: 4.184e15 },
  'W': { symbol: 'W', name: 'watt', quantity: 'power', factor: 1 },
  'kg*m/s': { symbol: 'kg·m/s', name: 'kilogram metre per second', quantity: 'momentum', factor: 1 },
  // pressure, density
  'Pa': { symbol: 'Pa', name: 'pascal', quantity: 'pressure', factor: 1 },
  'kPa': { symbol: 'kPa', name: 'kilopascal', quantity: 'pressure', factor: 1000 },
  'bar': { symbol: 'bar', name: 'bar', quantity: 'pressure', factor: 1e5 },
  'atm': { symbol: 'atm', name: 'standard atmosphere', quantity: 'pressure', factor: 101325 },
  'mmHg': { symbol: 'mmHg', name: 'millimetre of mercury', quantity: 'pressure', factor: 133.322 },
  'psi': { symbol: 'psi', name: 'pound per square inch', quantity: 'pressure', factor: 6894.757 },
  'kg/m3': { symbol: 'kg/m³', name: 'kilogram per cubic metre', quantity: 'density', factor: 1 },
  'g/cm3': { symbol: 'g/cm³', name: 'gram per cubic centimetre', quantity: 'density', factor: 1000 },
  'kg/m2': { symbol: 'kg/m²', name: 'kilogram per square metre (column mass)', quantity: 'none', factor: 1 },
  'g/mol': { symbol: 'g/mol', name: 'gram per mole (molar mass)', quantity: 'none', factor: 1 },
  // temperature (base: kelvin)
  'K': { symbol: 'K', name: 'kelvin', quantity: 'temperature', factor: 1 },
  'C': {
    symbol: '°C',
    name: 'degree Celsius',
    quantity: 'temperature',
    toBase: (v: number) => v + 273.15,
    fromBase: (v: number) => v - 273.15,
  },
  'F': {
    symbol: '°F',
    name: 'degree Fahrenheit',
    quantity: 'temperature',
    toBase: (v: number) => (v - 32) * (5 / 9) + 273.15,
    fromBase: (v: number) => (v - 273.15) * (9 / 5) + 32,
  },
  'dC': { symbol: '°C', name: 'temperature difference', quantity: 'none', factor: 1 },
  // angle
  'deg': { symbol: '°', name: 'degree', quantity: 'angle', factor: Math.PI / 180 },
  'rad': { symbol: 'rad', name: 'radian', quantity: 'angle', factor: 1 },
  // area
  'm2': { symbol: 'm²', name: 'square metre', quantity: 'area', factor: 1 },
  'km2': { symbol: 'km²', name: 'square kilometre', quantity: 'area', factor: 1e6 },
  'Mkm2': { symbol: 'million km²', name: 'million square kilometres', quantity: 'area', factor: 1e12 },
  'mi2': { symbol: 'mi²', name: 'square mile', quantity: 'area', factor: 2.589988e6 },
  // radiation
  'W/m2': { symbol: 'W/m²', name: 'watt per square metre', quantity: 'irradiance', factor: 1 },
  'S_earth': { symbol: 'S⊕', name: "Earth's insolation", quantity: 'irradiance', factor: 1361 },
  'L_sun': { symbol: 'L☉', name: 'solar luminosity', quantity: 'luminosity', factor: 3.828e26 },
  // abstract model units
  'index': { symbol: '', name: 'index', quantity: 'none', factor: 1 },
  'RU': { symbol: 'RU', name: 'resource unit (abstract model quantity)', quantity: 'none', factor: 1 },
  'RU/yr': { symbol: 'RU/yr', name: 'resource units per year (abstract model quantity)', quantity: 'none', factor: 1 },
} satisfies Record<string, UnitInfo>;

export type UnitId = keyof typeof U;

export const UNITS: Record<UnitId, UnitInfo> = U;

export function unitInfo(id: UnitId): UnitInfo {
  return UNITS[id] ?? UNITS['1'];
}

export function unitSymbol(id: UnitId): string {
  return unitInfo(id).symbol;
}

function toBase(id: UnitId, v: number): number {
  const u = unitInfo(id);
  return u.toBase ? u.toBase(v) : v * (u.factor ?? 1);
}

function fromBase(id: UnitId, v: number): number {
  const u = unitInfo(id);
  return u.fromBase ? u.fromBase(v) : v / (u.factor ?? 1);
}

export function canConvert(from: UnitId, to: UnitId): boolean {
  const a = unitInfo(from).quantity;
  return a !== 'none' && a === unitInfo(to).quantity;
}

export function convert(value: number, from: UnitId, to: UnitId): number {
  if (from === to) return value;
  if (!canConvert(from, to)) throw new Error(`Cannot convert ${from} to ${to}`);
  return fromBase(to, toBase(from, value));
}

export type UnitSystem = 'metric' | 'imperial';

/** Preferred display unit for a model unit under a unit system. */
const IMPERIAL: Partial<Record<UnitId, UnitId>> = {
  m: 'ft',
  km: 'mi',
  'm/s': 'ft/s',
  'km/h': 'mph',
  'm/s2': 'ft/s2',
  kg: 'lb',
  N: 'lbf',
  kgf: 'lbf',
  C: 'F',
  K: 'F',
  km2: 'mi2',
  kPa: 'psi',
};

export function displayUnit(id: UnitId, system: UnitSystem): UnitId {
  if (system === 'imperial') return IMPERIAL[id] ?? id;
  return id;
}

/** Format a number with a given count of significant figures, avoiding fake precision. */
export function formatNumber(v: number, sig = 3): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? '—' : v > 0 ? '∞' : '−∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-4) {
    const [m, e] = v.toExponential(Math.max(0, sig - 1)).split('e');
    return `${m}×10${superscript(Number(e))}`;
  }
  const digits = Math.floor(Math.log10(a)) + 1;
  const decimals = Math.max(0, sig - digits);
  const rounded = Number(v.toPrecision(sig));
  if (a >= 1e4) {
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 0 }).replace(/-/g, '−');
  }
  return rounded.toFixed(Math.min(decimals, 6)).replace(/-/g, '−');
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function superscript(n: number): string {
  return String(n)
    .split('')
    .map((c) => SUP[c] ?? c)
    .join('');
}

/** Format a value in the requested display unit with its symbol. */
export function formatQuantity(value: number, unit: UnitId, opts: { sig?: number; system?: UnitSystem; to?: UnitId } = {}): string {
  const target = opts.to ?? displayUnit(unit, opts.system ?? 'metric');
  const v = canConvert(unit, target) ? convert(value, unit, target) : value;
  const sym = unitSymbol(canConvert(unit, target) ? target : unit);
  const num = formatNumber(v, opts.sig ?? 3);
  if (!sym) return num;
  if (sym === '%' || sym === '°' || sym === '×') return `${num}${sym}`;
  return `${num} ${sym}`;
}

/** Human readable duration for model time values. */
export function formatTime(t: number, unit: UnitId): string {
  const seconds = toBase(unit, t);
  const a = Math.abs(seconds);
  if (unit === 's' && a < 600) return `${t.toFixed(a < 10 ? 2 : 1)} s`;
  if (a < 3600 * 2) return `${(seconds / 60).toFixed(1)} min`;
  if (a < 86400 * 3) return `${(seconds / 3600).toFixed(1)} h`;
  if (a < 86400 * 400) return `${(seconds / 86400).toFixed(1)} days`;
  return `${(seconds / (365.25 * 86400)).toFixed(a < 365.25 * 86400 * 100 ? 1 : 0)} yr`;
}
