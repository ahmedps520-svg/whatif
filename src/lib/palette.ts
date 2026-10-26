/**
 * Colour tokens for canvas and WebGL drawing. CSS uses the same values as
 * custom properties (src/styles/global.css). The categorical order is
 * validated for colour-vision deficiency on the app's dark chart surface;
 * assign series in this order and never cycle past it.
 */
export const COLORS = {
  bg: '#06080b',
  panel: '#0d1117',
  panel2: '#121821',
  grid: '#19212a',
  axis: '#2b3540',
  text: '#e8eef4',
  text2: '#a9b5c1',
  muted: '#6f7c8a',
  accent: '#41c7ff',
  accentDeep: '#2d7fff',
  baseline: '#8d98a6',
  ground: '#2a2f36',
  ocean: '#0b2a4a',
  flood: '#ff8a3d',
} as const;

/** Categorical series colours, in fixed order (dark-surface steps). */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

/** Status colours are reserved for state and always paired with a label or icon. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export function seriesColor(i: number): string {
  return SERIES[Math.min(i, SERIES.length - 1)];
}

/** Sequential blue ramp (light → dark) for magnitudes. */
export const SEQ_BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Diverging blue ↔ red with a neutral grey midpoint; t in [-1, 1]. */
export function diverging(t: number): string {
  const c = Math.max(-1, Math.min(1, t));
  const mid = [56, 56, 53];
  const cold = [57, 135, 229];
  const warm = [230, 103, 103];
  const end = c < 0 ? cold : warm;
  const k = Math.abs(c);
  const ch = mid.map((m, i) => Math.round(m + (end[i] - m) * k));
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}
