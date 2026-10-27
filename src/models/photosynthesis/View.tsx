import { useRef } from 'react';
import { CanvasStage } from '../../components/CanvasStage';
import { COLORS, SERIES, STATUS, withAlpha } from '../../lib/palette';
import type { ModelViewProps } from '../../views/types';
import { harvestAt, KCAL, type PhotoState } from './model';
import { num, str } from '../../engine/validation';

const MONO = '"JetBrains Mono Variable", ui-monospace, monospace';
const SANS = '"Inter Variable", system-ui, sans-serif';

/** Sun path across the day, a body catching the light, and today's harvest against the daily need. */
export default function PhotosynthesisView({ runner, overlays }: ModelViewProps<PhotoState>) {
  const ref = useRef({ runner, overlays });
  ref.current = { runner, overlays };

  const draw = (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
    const { runner, overlays } = ref.current;
    const s = runner.viewState;
    const p = runner.viewParams;
    const t = runner.time;
    const W = size.width;
    const H = size.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    const narrow = W < 560;
    const pad = 16;

    // ---- Sun path over the current day (top band) ----
    const top = 44;
    const bandH = Math.max(90, H * (narrow ? 0.34 : 0.42));
    const left = pad + 34;
    const right = narrow ? W - pad : W * 0.68;
    const dayStart = Math.floor(t / 24) * 24;
    const X = (h: number) => left + (h / 24) * (right - left);
    const maxEl = 90;
    const Y = (el: number) => top + bandH * (1 - Math.max(-10, el) / maxEl) * 0.88;
    // night / day shading from the actual elevation
    for (let m = 0; m < 24 * 4; m++) {
      const h = harvestAt(p, dayStart + m / 4);
      ctx.fillStyle = h.elevation > 0 ? withAlpha(SERIES[3], 0.07) : withAlpha('#000000', 0.25);
      ctx.fillRect(X(m / 4), top, X(0.25) - X(0) + 0.5, bandH);
    }
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(left, Y(0));
    ctx.lineTo(right, Y(0));
    ctx.stroke();
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = COLORS.muted;
    for (let h = 0; h <= 24; h += 6) ctx.fillText(`${h}:00`, X(h) - 14, top + bandH + 14);
    for (const el of [30, 60]) {
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(left, Y(el));
      ctx.lineTo(right, Y(el));
      ctx.stroke();
      ctx.fillText(`${el}°`, pad, Y(el) + 4);
    }
    ctx.fillText('0°', pad, Y(0) + 4);
    // sun path
    ctx.strokeStyle = SERIES[3];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let m = 0; m <= 24 * 12; m++) {
      const h = harvestAt(p, dayStart + m / 12);
      const x = X(m / 12);
      const y = Y(h.elevation);
      if (m === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // harvested power curve (scaled to its own daily maximum), drawn up to now
    let pmax = 1e-9;
    for (let m = 0; m <= 24 * 12; m++) pmax = Math.max(pmax, harvestAt(p, dayStart + m / 12).power);
    ctx.fillStyle = withAlpha(SERIES[2], 0.25);
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let m = 0; m <= Math.round((t - dayStart) * 12); m++) {
      const h = harvestAt(p, dayStart + m / 12);
      ctx.lineTo(X(m / 12), Y(0) - (h.power / pmax) * (Y(0) - top - 6) * 0.6);
    }
    ctx.lineTo(X(t - dayStart), Y(0));
    ctx.closePath();
    ctx.fill();
    // current sun
    const now = harvestAt(p, t);
    const sx = X(t - dayStart);
    const sy = Y(now.elevation);
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = now.elevation > 0 ? '#ffd166' : COLORS.muted;
    ctx.beginPath();
    ctx.arc(sx, sy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 12px ${SANS}`;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`Day ${Math.floor(t / 24) + 1} · ${String(Math.floor(now.solarHour)).padStart(2, '0')}:${String(Math.floor((now.solarHour % 1) * 60)).padStart(2, '0')} local solar time`, left, 22);
    ctx.font = `11px ${SANS}`;
    ctx.fillStyle = COLORS.text2;
    ctx.fillText(`Sun ${now.elevation.toFixed(1)}° · beam ${now.dni.toFixed(0)} W/m² · harvesting ${now.power.toFixed(1)} W`, left, 36);
    // legend
    const ly = top + bandH + 30;
    ctx.fillStyle = SERIES[3];
    ctx.fillRect(left, ly - 4, 14, 3);
    ctx.fillStyle = COLORS.text2;
    ctx.fillText('Sun elevation', left + 20, ly);
    ctx.fillStyle = withAlpha(SERIES[2], 0.6);
    ctx.fillRect(left + 120, ly - 7, 12, 9);
    ctx.fillStyle = COLORS.text2;
    ctx.fillText('Harvested power so far today (relative)', left + 138, ly);

    // ---- Body catching the light ----
    const bodyTop = narrow ? ly + 24 : top + bandH + 50;
    const bodyH = Math.max(80, H - bodyTop - pad);
    const bx = narrow ? W * 0.3 : W * 0.34;
    const by = bodyTop + bodyH * 0.92;
    const posture = str(p, 'posture');
    const exposed = num(p, 'exposedFraction') / 100;
    const scale = Math.min(bodyH * 0.8, 150);
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(bx - scale, by);
    ctx.lineTo(bx + scale, by);
    ctx.stroke();
    const skin = withAlpha(SERIES[5], 0.35 + 0.65 * exposed);
    ctx.fillStyle = skin;
    if (posture === 'lying') {
      ctx.fillRect(bx - scale * 0.5, by - scale * 0.12, scale, scale * 0.12);
    } else {
      const w = scale * 0.18;
      const hgt = scale * 0.85;
      ctx.fillRect(bx - w / 2, by - hgt, w, hgt);
      ctx.beginPath();
      ctx.arc(bx, by - hgt - w * 0.55, w * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (now.elevation > 0) {
      const a = (now.elevation * Math.PI) / 180;
      const dir = (t - dayStart) % 24 < 12 ? -1 : 1;
      ctx.strokeStyle = withAlpha('#ffd166', 0.6);
      ctx.lineWidth = 1.5;
      for (let k = -2; k <= 2; k++) {
        const ox = bx + k * scale * 0.12;
        const oy = by - scale * 0.45;
        ctx.beginPath();
        ctx.moveTo(ox + dir * Math.cos(a) * scale * 0.9, oy - Math.sin(a) * scale * 0.9);
        ctx.lineTo(ox, oy);
        ctx.stroke();
      }
    }
    ctx.font = `11px ${SANS}`;
    ctx.fillStyle = COLORS.text2;
    const label = posture === 'standing' ? 'Standing: low sun hits the body best' : posture === 'lying' ? 'Lying: high sun hits the body best' : 'Always facing the sun (best case)';
    ctx.fillText(label, bx - scale * 0.9, bodyTop + 4);
    ctx.fillText(`${(exposed * 100).toFixed(0)} % of ${num(p, 'skinArea').toFixed(2)} m² skin exposed · η = ${num(p, 'efficiency')} %`, bx - scale * 0.9, bodyTop + 18);

    // ---- Today's harvest against the daily need ----
    const need = num(p, 'dailyNeed');
    const kcal = s.harvestToday / KCAL;
    const last = Number.isFinite(s.lastDayTotal) ? s.lastDayTotal / KCAL : NaN;
    const gx = narrow ? W * 0.68 : W * 0.76;
    const gw = Math.min(46, W * 0.08);
    const gTop = narrow ? bodyTop + 10 : top + 40;
    const gBottom = H - pad - 30;
    const gH = gBottom - gTop;
    ctx.fillStyle = withAlpha(SERIES[0], 0.18);
    ctx.fillRect(gx, gTop, gw, gH);
    const frac = Math.min(1, kcal / need);
    ctx.fillStyle = SERIES[0];
    ctx.fillRect(gx, gBottom - frac * gH, gw, Math.max(1, frac * gH));
    if (Number.isFinite(last)) {
      const ly2 = gBottom - Math.min(1, last / need) * gH;
      ctx.strokeStyle = STATUS.warning;
      ctx.beginPath();
      ctx.moveTo(gx - 6, ly2);
      ctx.lineTo(gx + gw + 6, ly2);
      ctx.stroke();
    }
    ctx.font = `600 12px ${SANS}`;
    ctx.fillStyle = COLORS.text;
    ctx.fillText('Today', gx - 2, gTop - 8 < 14 ? gTop + gH + 26 : gTop - 8);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = COLORS.text2;
    const tx = gx + gw + 10;
    ctx.fillText(`${need.toFixed(0)} kcal`, tx, gTop + 10);
    ctx.fillText('daily need', tx, gTop + 24);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${kcal.toFixed(0)} kcal`, tx, Math.min(gBottom - frac * gH + 4, gBottom - 4));
    ctx.fillStyle = COLORS.text2;
    ctx.fillText(`${((kcal / need) * 100).toFixed(1)} %`, tx, Math.min(gBottom - frac * gH + 18, gBottom + 12));
    if (Number.isFinite(last) && overlays.measurements) {
      ctx.fillStyle = STATUS.warning;
      ctx.fillText(`yesterday ${last.toFixed(0)}`, tx, gBottom - Math.min(1, last / need) * gH - 6);
    }
  };

  return <CanvasStage draw={draw} ariaLabel="Sun path through the day, a body catching sunlight, and today's harvested energy compared with the daily need" />;
}
