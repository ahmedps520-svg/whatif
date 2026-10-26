import type { ParamDef, ParamValue, ParamValues, SimulationModel } from './types';

export interface ValidationIssue {
  key: string;
  message: string;
  /** The value that was actually applied after correction. */
  applied: ParamValue;
}

export interface ValidationResult {
  values: ParamValues;
  issues: ValidationIssue[];
}

export function defaultParams(model: SimulationModel): ParamValues {
  const out: ParamValues = {};
  for (const p of model.params) out[p.key] = p.default;
  return out;
}

/** Coerce a single raw value into a valid value for its definition. */
export function validateParam(def: ParamDef, raw: unknown): { value: ParamValue; message?: string } {
  if (def.type === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
      return { value: def.default, message: `${def.label}: "${String(raw)}" is not a number; using the default ${def.default}.` };
    }
    if (n < def.min) return { value: def.min, message: `${def.label}: ${n} is below the supported minimum; using ${def.min}.` };
    if (n > def.max) return { value: def.max, message: `${def.label}: ${n} is above the supported maximum; using ${def.max}.` };
    return { value: n };
  }
  if (def.type === 'choice') {
    const s = String(raw);
    if (def.options.some((o) => o.value === s)) return { value: s };
    return { value: def.default, message: `${def.label}: unknown option "${s}"; using "${def.default}".` };
  }
  if (typeof raw === 'boolean') return { value: raw };
  if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
  return { value: def.default, message: `${def.label}: expected on/off; using the default.` };
}

/**
 * Merge user-provided values over defaults, correcting anything invalid.
 * Unknown keys are dropped. The model never receives an invalid value.
 */
export function validateParams(model: SimulationModel, input: Partial<ParamValues> | undefined): ValidationResult {
  const values = defaultParams(model);
  const issues: ValidationIssue[] = [];
  if (!input) return { values, issues };
  for (const def of model.params) {
    if (!(def.key in input) || input[def.key] === undefined) continue;
    const { value, message } = validateParam(def, input[def.key]);
    values[def.key] = value;
    if (message) issues.push({ key: def.key, message, applied: value });
  }
  return { values, issues };
}

export function num(p: ParamValues, key: string): number {
  const v = p[key];
  return typeof v === 'number' ? v : Number(v);
}

export function str(p: ParamValues, key: string): string {
  return String(p[key]);
}

export function bool(p: ParamValues, key: string): boolean {
  return p[key] === true || p[key] === 'true';
}

export function resolve<T>(v: T | ((p: ParamValues) => T), p: ParamValues): T {
  return typeof v === 'function' ? (v as (p: ParamValues) => T)(p) : v;
}
