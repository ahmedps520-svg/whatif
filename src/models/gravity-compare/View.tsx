import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { CanvasStage, type StageSize } from '../../components/CanvasStage';
import { niceStep } from '../../lib/camera2d';
import { COLORS, STATUS, withAlpha } from '../../lib/palette';
import { formatNumber, formatQuantity, type UnitId } from '../../engine/units';
import type { ParamValues, RunTracks } from '../../engine/types';
import type { ModelViewProps, Overlays } from '../../views/types';
import {
  AU,
  INTERPRETATIONS,
  MOON_DISTANCE,
  R_EARTH,
  orbitalConsequences,
  predictions,
  type GravityState,
  type OrbitChange,
  type Predictions,
  type World,
  type WorldKey,
} from './model';

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------ */

const SANS = '"Inter Variable", system-ui, sans-serif';
const MONO = '"JetBrains Mono Variable", ui-monospace, monospace';
const COL: Record<WorldKey, string> = { base: COLORS.baseline, exp: COLORS.accent };
const NAME: Record<WorldKey, string> = { base: 'BASELINE', exp: 'EXPERIMENT' };

const fmt = (v: number, sig = 3) => formatNumber(v, sig);
const n = (p: ParamValues, k: string) => Number(p[k]);

/** Strobe spacing for the dropped ball: the same in both panes so the dots compare like-for-like. */
function strobeInterval(pr: Predictions): number {
  let tf = 0;
  for (const w of [pr.base, pr.exp]) if (Number.isFinite(w.dropTime)) tf = Math.max(tf, w.dropTime);
  return niceStep(tf > 0 ? tf : 2, 6);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PaneLayout {
  w: number;
  h: number;
  compact: boolean;
  font: number;
  header: number;
  infoY: number;
  lh: number;
  scene: Rect;
  jump: Rect;
  scale: Rect;
}

function paneLayout(w: number, h: number): PaneLayout {
  const compact = w < 440 || h < 270;
  const font = compact ? 10 : 11;
  const header = compact ? 24 : 28;
  const lh = font + 3;
  const pad = 8;
  const side = Math.round(Math.min(170, Math.max(98, w * 0.27)));
  const infoH = 2 * lh + 2;
  const axisW = compact ? 26 : 32;
  const bottom = 16;
  const sceneX = pad + axisW;
  const sceneY = header + infoH + 8;
  const scene = { x: sceneX, y: sceneY, w: Math.max(40, w - side - sceneX - 10), h: Math.max(40, h - sceneY - bottom) };
  const scaleH = compact ? 42 : 48;
  const sideX = w - side;
  const jump = { x: sideX, y: header, w: side - pad, h: Math.max(70, h - header - scaleH - 6 - pad) };
  const scale = { x: sideX, y: jump.y + jump.h + 6, w: side - pad, h: scaleH };
  return { w, h, compact, font, header, infoY: header + lh - 1, lh, scene, jump, scale };
}

interface Shared {
  minX: number;
  S: number;
  towerX: number;
  dropH: number;
  gridStep: number;
  arrowPx: number;
  zTop: number;
  SJ: number;
  jumpArrowPx: number;
  figH: number;
  groundJ: number;
  strobeDt: number;
}

/** Scales computed once from BOTH worlds, so the two panes are drawn identically. */
function sharedScales(s: GravityState, pr: Predictions, p: ParamValues, tracks: RunTracks, t: number, L: PaneLayout): Shared {
  const h = n(p, 'dropHeight');
  let maxRange = 0;
  let maxApex = 0;
  for (const w of [pr.base, pr.exp]) {
    if (Number.isFinite(w.range)) maxRange = Math.max(maxRange, w.range);
    if (Number.isFinite(w.apex)) maxApex = Math.max(maxApex, w.apex);
  }
  for (const key of ['base', 'exp'] as const) {
    const tr = tracks[`proj-${key}`];
    if (tr) {
      for (let i = 0; i < tr.t.length && tr.t[i] <= t + 1e-9; i++) {
        if (tr.x[i] > maxRange) maxRange = tr.x[i];
        if (tr.y[i] > maxApex) maxApex = tr.y[i];
      }
    }
    maxRange = Math.max(maxRange, s[key].proj.x);
    maxApex = Math.max(maxApex, s[key].proj.y);
  }
  const maxY = Math.max(h, maxApex, 1) * 1.1;
  const spanRef = Math.max(maxRange, h);
  const towerX = -Math.max(0.6, 0.08 * spanRef);
  const minX = towerX - Math.max(0.4, 0.06 * spanRef);
  const maxX = Math.max(maxRange * 1.04, 0.35 * maxY, 1);
  const S = Math.min(L.scene.w / (maxX - minX), L.scene.h / maxY);
  const gridStep = niceStep(Math.max(L.scene.w, L.scene.h) / S, L.compact ? 5 : 7);

  let vmax = n(p, 'launchSpeed');
  for (const w of [pr.base, pr.exp]) if (Number.isFinite(w.dropSpeed)) vmax = Math.max(vmax, w.dropSpeed);
  const arrowPx = (Math.min(L.scene.h, L.scene.w) * 0.3) / Math.max(vmax, 1e-6);

  let zTop = n(p, 'jumpHeight0');
  let vj = 0;
  for (const w of [pr.base, pr.exp]) {
    if (Number.isFinite(w.jumpApex)) zTop = Math.max(zTop, w.jumpApex);
    vj = Math.max(vj, w.jumpTakeoffSpeed);
  }
  for (const key of ['base', 'exp'] as const) {
    zTop = Math.max(zTop, s[key].jump.z);
    vj = Math.max(vj, Math.abs(s[key].jump.vz));
  }
  zTop *= 1.15;
  const J = L.jump;
  const figH = Math.min(60, Math.max(22, J.h * 0.3));
  const groundJ = J.y + J.h - 16;
  const rulerTop = J.y + 22 + figH;
  const SJ = Math.max(1e-6, (groundJ - rulerTop) / zTop);
  const jumpArrowPx = (J.h * 0.22) / Math.max(vj, 1e-6);
  return { minX, S, towerX, dropH: h, gridStep, arrowPx, zTop, SJ, jumpArrowPx, figH, groundJ, strobeDt: strobeInterval(pr) };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, dx: number, dy: number, color: string) {
  const len = Math.hypot(dx, dy);
  if (len < 3) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + dx, y0 + dy);
  ctx.stroke();
  const a = Math.atan2(dy, dx);
  const hs = Math.min(7, len * 0.45);
  ctx.beginPath();
  ctx.moveTo(x0 + dx, y0 + dy);
  ctx.lineTo(x0 + dx - hs * Math.cos(a - 0.45), y0 + dy - hs * Math.sin(a - 0.45));
  ctx.lineTo(x0 + dx - hs * Math.cos(a + 0.45), y0 + dy - hs * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

function ball(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Simple stick figure; `crouch` 0 (straight) … 1 (deepest crouch). Not to scale. */
function figure(ctx: CanvasRenderingContext2D, cx: number, feetY: number, H: number, crouch: number, color: string, pose: 'stand' | 'push' | 'air') {
  const legLen = H * 0.48;
  const seg = legLen / 2;
  const hipY = feetY - legLen + crouch * H * 0.24;
  const half = (feetY - hipY) / 2;
  const knee = Math.sqrt(Math.max(0, seg * seg - half * half));
  const torso = H * 0.32;
  const lean = crouch * H * 0.14;
  const neckX = cx + lean;
  const neckY = hipY - Math.sqrt(Math.max(0, torso * torso - lean * lean));
  const headR = H * 0.09;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.6, H / 20);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const off of [-1.5, 1.5]) {
    ctx.moveTo(cx + off, feetY);
    ctx.lineTo(cx + knee + off, hipY + half);
    ctx.lineTo(cx, hipY);
  }
  ctx.moveTo(cx, hipY);
  ctx.lineTo(neckX, neckY);
  const shX = cx + lean * 0.85;
  const shY = neckY + H * 0.04;
  if (pose === 'air') {
    ctx.moveTo(shX, shY);
    ctx.lineTo(shX + H * 0.06, shY - H * 0.22);
  } else if (pose === 'push') {
    ctx.moveTo(shX, shY);
    ctx.lineTo(shX - H * 0.16 * (0.4 + crouch), shY + H * 0.16);
  } else {
    ctx.moveTo(shX, shY);
    ctx.lineTo(shX + 1, shY + H * 0.26);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(neckX, neckY - headR - 1, headR, 0, Math.PI * 2);
  ctx.stroke();
}

/* ------------------------------------------------------------------------ */
/* Canvas pane                                                               */
/* ------------------------------------------------------------------------ */

function drawPane(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  L: PaneLayout,
  sh: Shared,
  w: World,
  pr: Predictions,
  p: ParamValues,
  t: number,
  tracks: RunTracks,
  ov: Overlays,
) {
  const key = w.key;
  const col = COL[key];
  const fs = L.font;
  ctx.save();
  ctx.translate(ox, oy);

  // Panel and header.
  roundRect(ctx, 0.5, 0.5, L.w - 1, L.h - 1, 8);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.strokeStyle = withAlpha(col, key === 'exp' ? 0.6 : 0.4);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${fs + 1}px ${SANS}`;
  ctx.fillStyle = col;
  ctx.fillText(NAME[key], 10, L.header - 8);
  const tw = ctx.measureText(NAME[key]).width;
  ctx.font = `500 ${fs + 1}px ${MONO}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText(`g = ${fmt(w.g)} m/s²${key === 'exp' ? ` (k = ${fmt(pr.k)})` : ''}`, 10 + tw + 8, L.header - 8);

  // Current values (from the state being displayed).
  ctx.font = `${fs}px ${MONO}`;
  ctx.fillStyle = COLORS.text2;
  const d = w.drop;
  const pj = w.proj;
  const l1 = d.flying ? `drop  h ${fmt(d.y)} m · v ${fmt(Math.abs(d.vy))} m/s` : `drop  landed ${fmt(d.landT)} s · ${fmt(d.landSpeed)} m/s`;
  const l2 = pj.flying ? `throw x ${fmt(pj.x)} m · y ${fmt(pj.y)} m` : `throw landed ${fmt(pj.landX)} m · ${fmt(pj.landT)} s`;
  ctx.fillText(l1, 10, L.infoY + 2);
  ctx.fillText(l2, 10, L.infoY + 2 + L.lh);

  // Scene: world metres → pixels (same transform in both panes).
  const sc = L.scene;
  const X = (x: number) => sc.x + (x - sh.minX) * sh.S;
  const Y = (y: number) => sc.y + sc.h - y * sh.S;
  const gy = Y(0);
  const step = sh.gridStep;
  ctx.save();
  ctx.beginPath();
  ctx.rect(sc.x, sc.y - 6, sc.w + 6, sc.h + 6);
  ctx.clip();
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let y = step; Y(y) >= sc.y - 6; y += step) {
    const py = Math.round(Y(y)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sc.x, py);
    ctx.lineTo(sc.x + sc.w + 6, py);
    ctx.stroke();
  }
  for (let x = Math.ceil(sh.minX / step) * step; X(x) <= sc.x + sc.w + 6; x += step) {
    const px = Math.round(X(x)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, sc.y - 6);
    ctx.lineTo(px, gy);
    ctx.stroke();
  }
  ctx.restore();
  // Axis labels (metres).
  ctx.font = `${fs - 1}px ${MONO}`;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = 0; Y(y) >= sc.y - 2; y += step) ctx.fillText(formatNumber(y, 4), sc.x - 4, Y(y));
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('m', sc.x - 4, sc.y - 8);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let x = step; X(x) <= sc.x + sc.w; x += step) ctx.fillText(formatNumber(x, 4), X(x), gy + 4);
  ctx.textBaseline = 'alphabetic';

  // Ground.
  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(sc.x - 2, gy, sc.w + 8, 3);
  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(sc.x - 2, gy + 0.5);
  ctx.lineTo(sc.x + sc.w + 6, gy + 0.5);
  ctx.stroke();

  // Drop tower.
  const tx = X(sh.towerX);
  const ty = Y(sh.dropH);
  const br = L.compact ? 4 : 5;
  ctx.strokeStyle = withAlpha(COLORS.text2, 0.5);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tx - br - 4, gy);
  ctx.lineTo(tx - br - 4, ty);
  ctx.lineTo(tx + br + 2, ty);
  ctx.stroke();

  // Strobe positions of the dropped ball at fixed time intervals.
  const dtr = tracks[`drop-${key}`];
  if (dtr) {
    let next = 0;
    ctx.strokeStyle = withAlpha(col, 0.55);
    ctx.lineWidth = 1;
    for (let i = 0; i < dtr.t.length && dtr.t[i] <= t + 1e-9; i++) {
      if (!d.flying && dtr.t[i] > d.landT) break;
      if (dtr.t[i] + 1e-9 < next) continue;
      while (next <= dtr.t[i] + 1e-9) next += sh.strobeDt;
      ctx.beginPath();
      ctx.arc(tx, Y(dtr.y[i]), br - 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ball(ctx, tx, Y(d.y), br, col);

  // Launcher and throw trail.
  const th = (n(p, 'launchAngle') * Math.PI) / 180;
  const lx = X(0);
  ctx.strokeStyle = COLORS.text2;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(lx, gy);
  ctx.lineTo(lx + Math.cos(th) * 14, gy - Math.sin(th) * 14);
  ctx.stroke();
  const ptr = tracks[`proj-${key}`];
  if (ptr) {
    ctx.strokeStyle = withAlpha(col, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < ptr.t.length && ptr.t[i] <= t + 1e-9; i++) {
      const px = X(ptr.x[i]);
      const py = Y(ptr.y[i]);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    if (started) ctx.lineTo(X(pj.x), Y(pj.y));
    ctx.stroke();
  }
  ball(ctx, X(pj.x), Y(pj.y), br, col);

  // Measurement overlays.
  if (ov.measurements) {
    ctx.font = `${fs}px ${MONO}`;
    ctx.fillStyle = COLORS.text2;
    ctx.textAlign = 'left';
    ctx.fillText(`h ${fmt(sh.dropH)} m`, tx + br + 5, ty + 4);
    if (!d.flying) ctx.fillText(`${fmt(d.landT)} s`, tx + br + 5, ty + 4 + L.lh);
    if (pj.apexReached && pj.apexT <= t + 1e-9) {
      const ax = X(pj.apexX);
      const ay = Y(pj.apexY);
      ctx.strokeStyle = withAlpha(COLORS.text2, 0.6);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.fillText(`apex ${fmt(pj.apexY)} m`, ax, Math.max(sc.y + 2, ay - 8));
    }
    if (!pj.flying) {
      const rx = X(pj.landX);
      ctx.strokeStyle = withAlpha(col, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lx, gy - 4);
      ctx.lineTo(lx, gy - 8);
      ctx.moveTo(lx, gy - 6);
      ctx.lineTo(rx, gy - 6);
      ctx.moveTo(rx, gy - 4);
      ctx.lineTo(rx, gy - 8);
      ctx.stroke();
      ctx.textAlign = rx > sc.x + sc.w * 0.75 ? 'right' : 'center';
      ctx.fillStyle = col;
      ctx.fillText(`range ${fmt(pj.landX)} m`, ctx.textAlign === 'right' ? rx : (lx + rx) / 2, gy - 11);
    }
    ctx.textAlign = 'left';
  }

  // Velocity vectors (same px per m/s in both panes).
  if (ov.vectors) {
    if (d.flying) arrow(ctx, tx, Y(d.y), 0, -d.vy * sh.arrowPx, COLORS.text);
    if (pj.flying) arrow(ctx, X(pj.x), Y(pj.y), pj.vx * sh.arrowPx, -pj.vy * sh.arrowPx, COLORS.text);
  }

  drawJumpInset(ctx, L, sh, w, p, ov);
  drawScale(ctx, L, w, p);
  ctx.restore();
}

function drawJumpInset(ctx: CanvasRenderingContext2D, L: PaneLayout, sh: Shared, w: World, p: ParamValues, ov: Overlays) {
  const J = L.jump;
  const fs = L.font;
  const col = COL[w.key];
  const j = w.jump;
  roundRect(ctx, J.x, J.y, J.w, J.h, 6);
  ctx.fillStyle = COLORS.panel2;
  ctx.fill();
  ctx.font = `600 ${fs}px ${SANS}`;
  ctx.fillStyle = COLORS.text2;
  ctx.textAlign = 'left';
  ctx.fillText(L.compact ? 'Jump' : 'Jump · feet height', J.x + 6, J.y + 13);

  const gyJ = sh.groundJ;
  const rx = J.x + (L.compact ? 26 : 30);
  // Ruler (metres), identical in both panes.
  const rs = niceStep(sh.zTop, 4);
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rx + 0.5, gyJ);
  ctx.lineTo(rx + 0.5, gyJ - sh.zTop * sh.SJ);
  ctx.stroke();
  ctx.font = `${fs - 1}px ${MONO}`;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let z = 0; z <= sh.zTop + 1e-9; z += rs) {
    const py = Math.round(gyJ - z * sh.SJ) + 0.5;
    ctx.beginPath();
    ctx.moveTo(rx - 3, py);
    ctx.lineTo(rx + 3, py);
    ctx.stroke();
    ctx.fillText(formatNumber(z, 3), rx - 5, py);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('m', rx - 5, gyJ - sh.zTop * sh.SJ - 8);
  // Ground.
  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(rx, gyJ + 0.5);
  ctx.lineTo(J.x + J.w - 4, gyJ + 0.5);
  ctx.stroke();

  const cx = rx + (J.x + J.w - rx) * 0.5;
  const feetY = gyJ - Math.max(0, j.z) * sh.SJ;
  const d = n(p, 'pushDistance');
  const crouch = j.phase === 'push' || j.phase === 'stuck' ? Math.min(1, Math.max(0, -j.z / d)) : 0;
  const pose = j.phase === 'flight' ? 'air' : j.phase === 'push' || j.phase === 'stuck' ? 'push' : 'stand';

  if (ov.measurements && j.apexReached) {
    const ay = gyJ - j.apexZ * sh.SJ;
    ctx.strokeStyle = withAlpha(col, 0.8);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(rx, ay);
    ctx.lineTo(J.x + J.w - 4, ay);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `${fs}px ${MONO}`;
    ctx.fillStyle = col;
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt(j.apexZ)} m`, J.x + J.w - 5, ay - 3);
  }
  figure(ctx, cx, feetY, sh.figH, crouch, col, pose);
  if (ov.vectors && (j.phase === 'flight' || j.phase === 'push') && Math.abs(j.vz) > 1e-6) {
    arrow(ctx, cx + sh.figH * 0.2, feetY - sh.figH * 0.5, 0, -j.vz * sh.jumpArrowPx, COLORS.text);
  }
  // Status line (from the state).
  ctx.font = `${fs}px ${MONO}`;
  ctx.textAlign = 'left';
  let status: string;
  if (j.phase === 'stuck') {
    ctx.fillStyle = STATUS.warning;
    status = 'cannot push off';
  } else {
    ctx.fillStyle = COLORS.text2;
    status = j.phase === 'push' ? 'pushing off' : j.phase === 'flight' ? `+${fmt(Math.max(0, j.z))} m` : `landed · ${fmt(j.apexZ)} m`;
  }
  ctx.fillText(status, J.x + 6, J.y + J.h - 4);
}

function drawScale(ctx: CanvasRenderingContext2D, L: PaneLayout, w: World, p: ParamValues) {
  const B = L.scale;
  const fs = L.font;
  const m = n(p, 'bodyMass');
  const reading = (m * w.g) / n(p, 'g0');
  roundRect(ctx, B.x, B.y, B.w, B.h, 6);
  ctx.fillStyle = COLORS.panel2;
  ctx.fill();
  ctx.strokeStyle = withAlpha(COL[w.key], 0.35);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.font = `${fs - 1}px ${SANS}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('Scale reads', B.x + 6, B.y + 12);
  ctx.font = `700 ${fs + 3}px ${MONO}`;
  ctx.fillStyle = COL[w.key];
  ctx.fillText(`${fmt(reading)} kg`, B.x + 6, B.y + 13 + fs + 4);
  ctx.font = `${fs - 1}px ${MONO}`;
  ctx.fillStyle = COLORS.text2;
  ctx.fillText(`W = ${fmt(m * w.g)} N`, B.x + 6, B.y + B.h - 5);
}

/* ------------------------------------------------------------------------ */
/* Comparison table                                                          */
/* ------------------------------------------------------------------------ */

type CellState = 'done' | 'pending' | 'never';

interface Row {
  id: string;
  label: string;
  unit: UnitId;
  base: number;
  exp: number;
  sb: CellState;
  se: CellState;
  formula: string;
  expr: string;
  pred: number;
  prov: 'sim' | 'calc';
  sig?: number;
  note?: string;
}

function stateOf(done: boolean, w: World): CellState {
  return done ? 'done' : w.g > 0 ? 'pending' : 'never';
}

function buildRows(s: GravityState, pr: Predictions): Row[] {
  const B = s.base;
  const E = s.exp;
  const pairs = (fn: (w: World) => { v: number; st: CellState }) => {
    const b = fn(B);
    const e = fn(E);
    return { base: b.v, exp: e.v, sb: b.st, se: e.st };
  };
  const ratio = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : NaN);
  const jumpV = (w: World) =>
    w.jump.phase === 'stuck' ? { v: 0, st: 'done' as const } : Number.isFinite(w.jump.takeoffT) ? { v: w.jump.takeoffV, st: 'done' as const } : { v: NaN, st: 'pending' as const };
  const jumpH = (w: World) => (w.jump.phase === 'stuck' ? { v: 0, st: 'done' as const } : { v: w.jump.apexReached ? w.jump.apexZ : NaN, st: stateOf(w.jump.apexReached, w) });
  const jumpT = (w: World) =>
    w.jump.phase === 'stuck' ? { v: 0, st: 'done' as const } : { v: w.jump.phase === 'landed' ? w.jump.landT - w.jump.takeoffT : NaN, st: stateOf(w.jump.phase === 'landed', w) };
  const always = (v: (w: World) => number) => pairs((w) => ({ v: v(w), st: 'done' }));
  const rows: Row[] = [
    { id: 'g', label: 'Gravity g', unit: 'm/s2', ...always((w) => w.g), formula: 'g = k·g₀', expr: 'k', pred: pr.k, prov: 'calc' },
    { id: 'drop_t', label: 'Fall time', unit: 's', ...pairs((w) => ({ v: w.drop.landT, st: stateOf(!w.drop.flying, w) })), formula: 't = √(2h/g)', expr: '1/√k', pred: ratio(pr.exp.dropTime, pr.base.dropTime), prov: 'sim' },
    { id: 'drop_v', label: 'Impact speed', unit: 'm/s', ...pairs((w) => ({ v: w.drop.landSpeed, st: stateOf(!w.drop.flying, w) })), formula: 'v = √(2gh)', expr: '√k', pred: ratio(pr.exp.dropSpeed, pr.base.dropSpeed), prov: 'sim' },
    { id: 'range', label: 'Throw range', unit: 'm', ...pairs((w) => ({ v: w.proj.landX, st: stateOf(!w.proj.flying, w) })), formula: 'R = v² sin2θ / g', expr: '1/k', pred: ratio(pr.exp.range, pr.base.range), prov: 'sim' },
    { id: 'apex', label: 'Throw peak height', unit: 'm', ...pairs((w) => ({ v: w.proj.apexY, st: stateOf(w.proj.apexReached, w) })), formula: 'H = (v sinθ)² / 2g', expr: '1/k', pred: ratio(pr.exp.apex, pr.base.apex), prov: 'sim' },
    { id: 'tf', label: 'Throw flight time', unit: 's', ...pairs((w) => ({ v: w.proj.landT, st: stateOf(!w.proj.flying, w) })), formula: 'T = 2v sinθ / g', expr: '1/k', pred: ratio(pr.exp.flightTime, pr.base.flightTime), prov: 'sim' },
    { id: 'jv', label: 'Jump take-off speed', unit: 'm/s', ...pairs(jumpV), formula: 'v′ = √(2d(F/m − g))', expr: 'closed form', pred: ratio(pr.exp.jumpTakeoffSpeed, pr.base.jumpTakeoffSpeed), prov: 'sim' },
    { id: 'jh', label: 'Jump height', unit: 'm', ...pairs(jumpH), formula: 'h′ = d(F/m − g)/g', expr: 'closed form', pred: ratio(pr.exp.jumpApex, pr.base.jumpApex), prov: 'sim' },
    { id: 'jt', label: 'Jump time in the air', unit: 's', ...pairs(jumpT), formula: 'T = 2v′/g', expr: 'closed form', pred: ratio(pr.exp.jumpFlightTime, pr.base.jumpFlightTime), prov: 'sim' },
    { id: 'w', label: 'Body weight', unit: 'N', ...always((w) => pr[w.key].weight), formula: 'W = m g', expr: 'k', pred: pr.k, prov: 'calc', sig: 4 },
    { id: 'scale', label: 'Bathroom-scale reading', unit: 'kg', ...always((w) => pr[w.key].scaleReading), formula: 'reading = m g / g₀', expr: 'k', pred: pr.k, prov: 'calc', sig: 4, note: 'Mass is unchanged; the scale measures force.' },
    { id: 'bp', label: 'Heart→brain ΔP (hydrostatic)', unit: 'mmHg', ...always((w) => pr[w.key].bloodDp), formula: 'ΔP = ρ_blood g h', expr: 'k', pred: pr.k, prov: 'calc', note: 'Physical quantity only; physiological effects are not modelled (speculative).' },
    { id: 'fm', label: 'Leg push F/m (same legs)', unit: 'm/s2', ...always((w) => w.fm), formula: 'F/m = g₀ + v₀²/2d', expr: '1', pred: 1, prov: 'calc' },
  ];
  return rows;
}

function Cell({ v, st, unit, sig }: { v: number; st: CellState; unit: UnitId; sig?: number }) {
  if (st === 'pending') return <span className="gc-muted" title="Not reached yet in this run">…</span>;
  if (st === 'never') return <span className="gc-muted" title="With g = 0 this never happens">never</span>;
  if (!Number.isFinite(v)) return <span className="gc-muted">—</span>;
  return <>{formatQuantity(v, unit, { sig: sig ?? 3 })}</>;
}

function ComparisonTable({ s, pr, drag }: { s: GravityState; pr: Predictions; drag: boolean }) {
  const rows = buildRows(s, pr);
  return (
    <section className="gc-card" aria-labelledby="gc-table-h">
      <h3 className="gc-h" id="gc-table-h">
        Baseline vs experiment
      </h3>
      <div className="gc-table-wrap">
        <table className="gc-table">
          <thead>
            <tr>
              <th scope="col">Quantity</th>
              <th scope="col" className="gc-base">
                Baseline
              </th>
              <th scope="col" className="gc-exp">
                Experiment
              </th>
              <th scope="col">Ratio</th>
              <th scope="col" className="gc-fcol">
                Formula{drag ? ' (vacuum)' : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const done = r.sb === 'done' && r.se === 'done';
              const ratio = done && Number.isFinite(r.base) && Number.isFinite(r.exp) && r.base !== 0 ? r.exp / r.base : NaN;
              const predText = Number.isFinite(r.pred) ? `${drag && r.prov === 'sim' && r.id.startsWith('drop') === false && !r.id.startsWith('j') ? 'vacuum ' : ''}${r.expr === 'closed form' ? 'closed form' : r.expr} = ${fmt(r.pred)}` : `${r.expr}: n/a`;
              return (
                <tr key={r.id} title={r.note}>
                  <th scope="row">
                    {r.label} <span className={`gc-prov gc-prov-${r.prov}`}>{r.prov === 'sim' ? 'simulated' : 'calculated'}</span>
                    <div className="gc-finline">{r.formula}</div>
                  </th>
                  <td>
                    <Cell v={r.base} st={r.sb} unit={r.unit} sig={r.sig} />
                  </td>
                  <td className="gc-exp-v">
                    <Cell v={r.exp} st={r.se} unit={r.unit} sig={r.sig} />
                  </td>
                  <td>
                    {Number.isFinite(ratio) ? `×${fmt(ratio)}` : r.base === 0 && r.exp === 0 && done ? '—' : <span className="gc-muted">…</span>}
                    <div className="gc-pred">{predText}</div>
                  </td>
                  <td className="gc-fcol gc-formula">{r.formula}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="gc-note">
        “Simulated” values are read from the two worlds stepped together with RK4 (events located within a step); “calculated” values come directly from the
        parameters. The small line under each ratio is the closed-form prediction{drag ? ' (vacuum formulas: with air drag the throw no longer follows them, while a drop from rest in the same air still scales as 1/√k)' : ''}.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Orbital consequences (static closed-form diagrams)                        */
/* ------------------------------------------------------------------------ */

interface Pt {
  x: number;
  y: number;
}

function conicPoint(o: OrbitChange, nu: number): Pt {
  const rad = o.semiLatus / (1 + o.e * Math.cos(nu));
  // Unit vectors: start point is always on +x and motion is counter-clockwise.
  const ux = o.startAt === 'apoapsis' ? -1 : 1;
  const vy = o.startAt === 'apoapsis' ? -1 : 1;
  return { x: rad * Math.cos(nu) * ux, y: rad * Math.sin(nu) * vy };
}

function polyline(o: OrbitChange, from: number, to: number, maxR: number, k: number): string {
  const N = 240;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const nu = from + ((to - from) * i) / N;
    const den = 1 + o.e * Math.cos(nu);
    if (den <= 1e-9) break;
    const pt = conicPoint(o, nu);
    if (Math.hypot(pt.x, pt.y) > maxR) {
      pts.push(`${(pt.x * k).toFixed(2)},${(-pt.y * k).toFixed(2)}`);
      break;
    }
    pts.push(`${(pt.x * k).toFixed(2)},${(-pt.y * k).toFixed(2)}`);
  }
  return pts.join(' ');
}

function OrbitDiagram({
  o,
  title,
  central,
  centralLabel,
  centralFill,
  refs = [],
  impactR,
}: {
  o: OrbitChange;
  title: string;
  central: number;
  centralLabel: string;
  centralFill: string;
  refs?: { r: number; label: string }[];
  impactR?: number;
}) {
  const reach = o.bound ? Math.min(Math.max(o.apoapsis, o.r), 6 * o.r) : 2.2 * o.r;
  const k = 92 / reach;
  const maxR = reach * 1.2;
  const cR = Math.max(central * k, 2.5);
  let solid = '';
  let dashed = '';
  let impact: Pt | null = null;
  if (!(o.q > 0)) {
    solid = `${(o.r * k).toFixed(2)},0 ${(o.r * k).toFixed(2)},${(-maxR * k).toFixed(2)}`;
  } else if (o.startAt === 'apoapsis') {
    const hits = impactR !== undefined && o.periapsis < impactR;
    if (hits) {
      const c = Math.min(1, Math.max(-1, (o.semiLatus / impactR! - 1) / o.e));
      const nuHit = 2 * Math.PI - Math.acos(c);
      solid = polyline(o, Math.PI, nuHit, maxR, k);
      dashed = polyline(o, nuHit, 3 * Math.PI, maxR, k);
      impact = conicPoint(o, nuHit);
    } else solid = polyline(o, Math.PI, 3 * Math.PI, maxR, k);
  } else if (o.bound) {
    solid = polyline(o, 0, 2 * Math.PI, maxR, k);
  } else {
    const nuInf = Math.acos(-1 / o.e);
    solid = polyline(o, 0, nuInf - 1e-3, maxR, k);
  }
  const peri = o.bound && o.startAt !== 'circular' ? (o.startAt === 'apoapsis' ? conicPoint(o, 0) : conicPoint(o, Math.PI)) : null;
  const periLabel = o.startAt === 'apoapsis' ? 'closest' : 'farthest';
  return (
    <svg viewBox="-110 -110 220 220" role="img" aria-label={title}>
      <rect x={-110} y={-110} width={220} height={220} fill="transparent" />
      {refs.map((r) => (
        <g key={r.label}>
          <circle cx={0} cy={0} r={r.r * k} fill="none" stroke={COLORS.muted} strokeWidth={0.6} strokeDasharray="1.5 2.5" />
          <text x={0} y={-r.r * k - 2} fontSize={7} fill={COLORS.muted} textAnchor="middle">
            {r.label}
          </text>
        </g>
      ))}
      <circle cx={0} cy={0} r={o.r * k} fill="none" stroke={COLORS.baseline} strokeWidth={1} strokeDasharray="3 2.5" />
      {dashed && <polyline points={dashed} fill="none" stroke={withAlpha(COLORS.accent, 0.5)} strokeWidth={1} strokeDasharray="2 2" />}
      <circle cx={0} cy={0} r={cR} fill={centralFill} opacity={0.92} />
      {solid && <polyline points={solid} fill="none" stroke={COLORS.accent} strokeWidth={1.8} />}
      {impact && (
        <g>
          <circle cx={impact.x * k} cy={-impact.y * k} r={3.2} fill={STATUS.critical} />
          <text x={impact.x * k} y={-impact.y * k + 11} fontSize={7.5} fill={STATUS.critical} textAnchor="middle">
            impact
          </text>
        </g>
      )}
      {peri && Math.hypot(peri.x, peri.y) * k > cR + 2 && (
        <g>
          <circle cx={peri.x * k} cy={-peri.y * k} r={2.4} fill={COLORS.accent} />
          <text x={peri.x * k} y={-peri.y * k - 5} fontSize={7.5} fill={COLORS.text2} textAnchor="middle">
            {periLabel}
          </text>
        </g>
      )}
      <circle cx={o.r * k} cy={0} r={3} fill={COLORS.text} />
      <text x={o.r * k - 4} y={10} fontSize={7.5} fill={COLORS.text} textAnchor="end">
        now
      </text>
      <text x={0} y={cR + 9} fontSize={7} fill={COLORS.text2} textAnchor="middle">
        {centralLabel}
      </text>
    </svg>
  );
}

function Facts({ items }: { items: [string, string, ('warn' | 'ok')?][] }) {
  return (
    <ul className="gc-facts">
      {items.map(([k, v, tone]) => (
        <li key={k} className={tone ? `gc-${tone}` : undefined}>
          <span>{k}</span>
          <span className="gc-mono">{v}</span>
        </li>
      ))}
    </ul>
  );
}

function OrbitPanel({ p }: { p: ParamValues }) {
  const o = orbitalConsequences(p);
  const interp = INTERPRETATIONS[o.interpretation];
  const { sat, moon, earth } = o;
  const km = (m: number) => `${fmt(m / 1000, 4)} km`;
  const satFacts: [string, string, ('warn' | 'ok')?][] = [
    ['Speed at the change', `${fmt(sat.vStart / 1000)} km/s`],
    ['Circular speed needed now', `${fmt(sat.vCircNew / 1000)} km/s`],
  ];
  if (sat.bound) {
    satFacts.push(['Lowest altitude', km(sat.periapsis - R_EARTH), o.satHitsSurface ? 'warn' : undefined]);
    satFacts.push(['Highest altitude', km(sat.apoapsis - R_EARTH)]);
    satFacts.push(['Eccentricity', fmt(sat.e)]);
    if (!o.satHitsSurface) satFacts.push(['Period', `${fmt(sat.periodNew / 60)} min (was ${fmt(sat.periodOld / 60)})`]);
  } else satFacts.push(['Escape speed now', `${fmt(sat.vEscNew / 1000)} km/s — it escapes`, 'warn']);
  if (o.satHitsSurface) satFacts.push(['Reaches the ground after', `${fmt(o.satTimeToSurface / 60)} min`, 'warn']);

  const moonFacts: [string, string, ('warn' | 'ok')?][] = [];
  if (moon.bound) {
    moonFacts.push(['Closest distance', km(moon.periapsis)], ['Farthest distance', km(moon.apoapsis)], ['Eccentricity', fmt(moon.e)], ['Month', `${fmt(moon.periodNew / 86400)} d (was ${fmt(moon.periodOld / 86400)})`]);
    moonFacts.push(['Tidal pull at closest', `×${fmt(o.moonTideFactor)}`]);
  } else moonFacts.push(['Escape speed now', `${fmt(moon.vEscNew / 1000)} km/s`], ['Moon’s speed', `${fmt(moon.vStart / 1000)} km/s — it escapes`, 'warn']);
  moonFacts.push(['Roche limit (fluid approx.)', km(o.rocheNew), moon.periapsis < o.rocheNew ? 'warn' : undefined]);

  const earthFacts: [string, string, ('warn' | 'ok')?][] = [];
  if (earth.bound) {
    earthFacts.push(['Perihelion', `${fmt(earth.periapsis / AU, earth.e < 1e-3 ? 7 : 3)} AU`], ['Aphelion', `${fmt(earth.apoapsis / AU, earth.e < 1e-3 ? 7 : 3)} AU`], ['Eccentricity', fmt(earth.e)], ['Year', `${fmt(earth.periodNew / 86400, 4)} d`]);
    earthFacts.push(['Sunlight at perihelion*', `×${fmt(o.insolationPeri)}`]);
  } else earthFacts.push(['Result', 'Earth escapes the Sun', 'warn']);

  return (
    <section className="gc-card" aria-labelledby="gc-orbit-h">
      <h3 className="gc-h" id="gc-orbit-h">
        Orbital consequences <span className="gc-prov gc-prov-calc">closed form</span>
      </h3>
      <p className="gc-p">
        <strong>{interp.label}.</strong> {interp.explanation}
      </p>
      <div className="gc-orbits">
        <figure className="gc-orbit">
          <figcaption>Satellite at {fmt(o.satAltitude / 1000, 4)} km · q = {fmt(sat.q, 4)}</figcaption>
          <OrbitDiagram o={sat} title="Satellite orbit before (dashed circle) and after the change" central={R_EARTH} centralLabel="Earth (to scale)" centralFill="#1d4f7a" impactR={R_EARTH} />
          <Facts items={satFacts} />
        </figure>
        <figure className="gc-orbit">
          <figcaption>The Moon · q = {fmt(moon.q, 4)}</figcaption>
          <OrbitDiagram o={moon} title="The Moon's orbit before (dashed circle) and after the change" central={R_EARTH} centralLabel="Earth" centralFill="#1d4f7a" refs={[{ r: o.rocheNew, label: 'Roche limit' }]} />
          <Facts items={moonFacts} />
        </figure>
        <figure className="gc-orbit">
          <figcaption>Earth around the Sun · q = {fmt(earth.q, earth.e < 1e-3 && earth.e > 0 ? 7 : 4)}</figcaption>
          <OrbitDiagram
            o={earth}
            title="Earth's orbit around the Sun before (dashed circle) and after the change"
            central={6.957e8}
            centralLabel="Sun"
            centralFill="#c98500"
            refs={[
              { r: 0.387 * AU, label: 'Mercury' },
              { r: 0.723 * AU, label: 'Venus' },
            ]}
          />
          <Facts items={earthFacts} />
        </figure>
      </div>
      <Facts
        items={[
          ['Escape speed from the surface', `${fmt(o.vEscOld / 1000)} → ${fmt(o.vEscNew / 1000)} km/s`],
          ['Moon distance today (circular)', km(MOON_DISTANCE)],
        ]}
      />
      <p className="gc-note">
        Static diagrams drawn from the closed-form solution for an instantaneous change (vis-viva v² = μ(2/r − 1/a) with q = μ′/μ: a = qr/(2q − 1), e = |1 − 1/q|);
        they are not a time-stepped simulation. Dashed circle: today’s orbit (treated as circular). The satellite diagram is to scale; the Moon’s and Sun’s central
        bodies are enlarged. *Assumes the Sun’s luminosity is unchanged.
      </p>
      <Link to="/lab/gravity-doubled-moon" className="gc-link">
        Open the full numerical Moon-orbit simulation →
      </Link>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* View                                                                      */
/* ------------------------------------------------------------------------ */

const CSS = `
.gc-root { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; color: var(--text, #e8eef4); font-family: var(--font-sans, system-ui, sans-serif); }
.gc-stage { position: relative; flex: 0 0 auto; height: clamp(320px, 58vh, 620px); }
@media (max-width: 639px) { .gc-stage { height: min(150vw, 760px); } }
.gc-caption { margin: 0 4px; font-size: 12px; line-height: 1.45; color: var(--muted, #6f7c8a); }
.gc-below { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 0 2px 8px; }
@media (min-width: 1180px) { .gc-below { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: start; } }
.gc-card { background: var(--panel, #0d1117); border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: var(--radius, 10px); padding: 12px; min-width: 0; }
.gc-h { margin: 0 0 8px; font: 600 14px/1.3 var(--font-display, system-ui, sans-serif); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gc-p { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5; color: var(--text-2, #a9b5c1); }
.gc-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.gc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.gc-table th, .gc-table td { padding: 6px 5px; border-bottom: 1px solid var(--line, rgba(255,255,255,0.08)); text-align: right; vertical-align: top; }
.gc-table thead th { font-weight: 600; color: var(--text-2, #a9b5c1); font-size: 11.5px; white-space: nowrap; }
.gc-table thead th:first-child, .gc-table tbody th { text-align: left; font-weight: 500; }
.gc-table td { font-family: var(--font-mono, ui-monospace, monospace); white-space: nowrap; font-size: 12px; }
.gc-table .gc-formula { white-space: normal; text-align: left; color: var(--text-2, #a9b5c1); font-size: 11px; min-width: 120px; }
.gc-base { color: var(--baseline, #8d98a6) !important; }
.gc-exp, .gc-exp-v { color: var(--accent, #41c7ff) !important; }
.gc-pred { font-size: 10.5px; color: var(--muted, #6f7c8a); white-space: nowrap; }
.gc-finline { display: none; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--muted, #6f7c8a); margin-top: 2px; }
.gc-prov { display: inline-block; font: 500 9.5px/1.4 var(--font-sans, system-ui, sans-serif); padding: 0 5px; border-radius: 999px; vertical-align: 1px; letter-spacing: 0.02em; }
.gc-prov-sim { color: var(--prov-simulated, #41c7ff); background: rgba(65,199,255,0.1); }
.gc-prov-calc { color: var(--prov-derived, #9085e9); background: rgba(144,133,233,0.12); }
.gc-muted { color: var(--muted, #6f7c8a); }
.gc-note { margin: 8px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--muted, #6f7c8a); }
.gc-orbits { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 8px; }
.gc-orbit { margin: 0; background: var(--panel-2, #121821); border-radius: var(--radius-sm, 6px); padding: 8px; min-width: 0; }
.gc-orbit figcaption { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.gc-orbit svg { width: 100%; max-width: 260px; height: auto; display: block; margin: 0 auto; font-family: var(--font-sans, system-ui, sans-serif); }
.gc-facts { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12px; }
.gc-facts li { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; color: var(--text-2, #a9b5c1); }
.gc-facts li .gc-mono { font-family: var(--font-mono, ui-monospace, monospace); color: var(--text, #e8eef4); text-align: right; }
.gc-facts li.gc-warn .gc-mono, .gc-facts li.gc-warn { color: var(--warning, #fab219); }
.gc-link { display: inline-block; margin-top: 8px; color: var(--accent, #41c7ff); font-size: 13px; font-weight: 600; }
@media (max-width: 719px) {
  .gc-fcol { display: none; }
  .gc-finline { display: block; }
  .gc-table { font-size: 12px; }
  .gc-table th, .gc-table td { padding: 5px 3px; }
}
`;

/** Split-screen view: baseline world vs experimental world at identical scales, with a comparison table and orbit diagrams. */
export default function GravityCompareView(props: ModelViewProps<GravityState>) {
  const { runner, overlays } = props;
  const live = useRef({ runner, overlays });
  live.current = { runner, overlays };

  const draw = (ctx: CanvasRenderingContext2D, size: StageSize) => {
    const { runner, overlays } = live.current;
    const s = runner.viewState;
    const p = runner.viewParams;
    const t = runner.time;
    const tracks = runner.core.tracks;
    const pr = predictions(p);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.width, size.height);
    const sideBySide = size.width >= 640 && size.width >= size.height * 1.15;
    const gap = 8;
    const pw = sideBySide ? (size.width - gap) / 2 : size.width;
    const ph = sideBySide ? size.height : (size.height - gap) / 2;
    const L = paneLayout(pw, ph);
    const sh = sharedScales(s, pr, p, tracks, t, L);
    drawPane(ctx, 0, 0, L, sh, s.base, pr, p, t, tracks, overlays);
    drawPane(ctx, sideBySide ? pw + gap : 0, sideBySide ? 0 : ph + gap, L, sh, s.exp, pr, p, t, tracks, overlays);
  };

  const s = runner.viewState;
  const p = runner.viewParams;
  const pr = predictions(p);
  const drag = p.drag === true;
  return (
    <div className="gc-root">
      <style>{CSS}</style>
      <div className="gc-stage">
        <CanvasStage
          draw={draw}
          ariaLabel={`Split screen at identical scales. Baseline world with g = ${fmt(pr.base.g)} m/s² and experimental world with g = ${fmt(pr.exp.g)} m/s², each showing a ball dropped from ${fmt(n(p, 'dropHeight'))} m, a ball thrown at ${fmt(n(p, 'launchSpeed'))} m/s, a jumper and a bathroom-scale reading.`}
        />
      </div>
      <p className="gc-caption">
        Both panes use the same scales: metres in the scene, the jump ruler and{overlays.vectors ? ' the velocity arrows' : ' the velocity arrows (vector overlay)'}. Rings on the
        drop mark its position every {fmt(strobeInterval(pr))} s. Balls and the jumper figure are drawn larger than to scale; only the jumper’s feet height follows the ruler.
      </p>
      <div className="gc-below">
        <ComparisonTable s={s} pr={pr} drag={drag} />
        <OrbitPanel p={p} />
      </div>
    </div>
  );
}
