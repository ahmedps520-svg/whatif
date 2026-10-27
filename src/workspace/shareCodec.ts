import type { ParamValues } from '../engine/types';

/** Shareable experiment configuration, encoded in the URL (no server needed). */
export interface SharedConfig {
  /** Catalog experiment id or null for a custom scenario. */
  e: string | null;
  m: string;
  /** Parameters that differ from the model defaults. */
  p: ParamValues;
  /** Baseline parameters, if any. */
  b?: ParamValues | null;
  q?: string;
  n?: string;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeConfig(c: SharedConfig): string {
  return toBase64Url(JSON.stringify(c));
}

export function decodeConfig(s: string): SharedConfig | null {
  try {
    const obj = JSON.parse(fromBase64Url(s));
    if (!obj || typeof obj !== 'object' || typeof obj.m !== 'string' || typeof obj.p !== 'object') return null;
    return obj as SharedConfig;
  } catch {
    return null;
  }
}

export function shareUrl(c: SharedConfig): string {
  const base = window.location.href.split('#')[0];
  return `${base}#/shared/${encodeConfig(c)}`;
}

export function diffParams(params: ParamValues, defaults: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(params)) if (defaults[k] !== v) out[k] = v;
  return out;
}
