import { useEffect, useRef } from 'react';
import { CanvasStage } from '../../components/CanvasStage';
import { Camera2D, attachPanZoom, niceStep, type Bounds } from '../../lib/camera2d';
import { COLORS, seriesColor, withAlpha } from '../../lib/palette';
import type { ModelViewProps } from '../../views/types';
import type { ProjectileState } from './model';

/** Side view of the projectile lab: ground, objects, trails, baseline ghosts and measurements. */
export default function ProjectileView({ runner, baseline, overlays, cameraResetKey }: ModelViewProps<ProjectileState>) {
  const cam = useRef(new Camera2D());
  const props = useRef({ runner, baseline, overlays });
  props.current = { runner, baseline, overlays };

  useEffect(() => {
    cam.current.userControlled = false;
  }, [cameraResetKey]);

  const draw = (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
    const { runner, baseline, overlays } = props.current;
    const c = cam.current;
    c.resize(size.width, size.height);
    const s = runner.viewState;
    const t = runner.time;
    const tracks = runner.core.tracks;

    // Auto-fit to everything recorded so far (including the baseline ghosts).
    if (!c.userControlled) {
      const b: Bounds = { minX: -2, maxX: 10, minY: -0.5, maxY: 6 };
      const grow = (x: number, y: number) => {
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y > b.maxY) b.maxY = y;
      };
      for (const tr of Object.values(tracks)) for (let i = 0; i < tr.t.length; i++) grow(tr.x[i], tr.y[i]);
      if (baseline) for (const tr of Object.values(baseline.tracks)) for (let i = 0; i < tr.t.length; i++) grow(tr.x[i], tr.y[i]);
      for (const body of s.bodies) grow(body.x + body.r, body.y + body.r);
      const w = b.maxX - b.minX;
      b.minX -= w * 0.04;
      b.maxX += w * 0.04;
      b.minY = -Math.max(0.5, (b.maxY - b.minY) * 0.06);
      c.fit(b, 0.08, c.scale === 10 ? 0 : 0.15);
    }

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.width, size.height);

    // Metric grid.
    const [wx0, wy0] = c.toWorld(0, size.height);
    const [wx1, wy1] = c.toWorld(size.width, 0);
    const step = niceStep(Math.max(wx1 - wx0, wy1 - wy0), 10);
    ctx.lineWidth = 1;
    ctx.font = '11px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.fillStyle = COLORS.muted;
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
      const px = Math.round(c.toScreenX(x)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, size.height);
      ctx.stroke();
      ctx.fillText(`${Number(x.toPrecision(6))} m`, px + 3, c.toScreenY(0) + 14);
    }
    for (let y = Math.ceil(Math.max(0, wy0) / step) * step; y <= wy1; y += step) {
      const py = Math.round(c.toScreenY(y)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(size.width, py);
      ctx.stroke();
      if (y > 0) ctx.fillText(`${Number(y.toPrecision(6))} m`, 4, py - 3);
    }

    // Ground.
    const gy = c.toScreenY(0);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, gy, size.width, size.height - gy);
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(size.width, gy + 0.5);
    ctx.stroke();

    // Baseline ghosts (full paths) in grey.
    if (baseline) {
      ctx.strokeStyle = withAlpha(COLORS.baseline, 0.55);
      ctx.lineWidth = 1.5;
      for (const tr of Object.values(baseline.tracks)) {
        ctx.beginPath();
        for (let i = 0; i < tr.t.length; i++) {
          const px = c.toScreenX(tr.x[i]);
          const py = c.toScreenY(tr.y[i]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        // Ghost position at the current time.
        let k = 0;
        while (k < tr.t.length - 1 && tr.t[k + 1] <= t) k++;
        if (tr.t.length && tr.t[0] <= t) {
          ctx.fillStyle = withAlpha(COLORS.baseline, 0.7);
          ctx.beginPath();
          ctx.arc(c.toScreenX(tr.x[k]), c.toScreenY(tr.y[k]), 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Trails up to the displayed time.
    for (const body of s.bodies) {
      const tr = tracks[body.id];
      if (!tr) continue;
      ctx.strokeStyle = withAlpha(seriesColor(body.slot), 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < tr.t.length && tr.t[i] <= t + 1e-9; i++) {
        const px = c.toScreenX(tr.x[i]);
        const py = c.toScreenY(tr.y[i]);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Launcher marker.
    const lh = Number(runner.viewParams.launchHeight) || 0;
    ctx.strokeStyle = COLORS.text2;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.toScreenX(0), gy);
    ctx.lineTo(c.toScreenX(0), c.toScreenY(lh));
    ctx.stroke();
    const ang = (Number(runner.viewParams.launchAngle) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(c.toScreenX(0), c.toScreenY(lh));
    ctx.lineTo(c.toScreenX(0) + Math.cos(ang) * 22, c.toScreenY(lh) - Math.sin(ang) * 22);
    ctx.stroke();

    // Bodies.
    for (const body of s.bodies) {
      const px = c.toScreenX(body.x);
      const py = c.toScreenY(body.y);
      const pr = Math.max(4, body.r * c.scale);
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath();
      ctx.arc(px, py, pr + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = seriesColor(body.slot);
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 12px "Inter Variable", system-ui, sans-serif';
      ctx.fillText(body.label, px + pr + 4, py - pr - 2);

      if (overlays.vectors) {
        const vs = 0.15 * Math.max(30, Math.min(size.width, size.height)) / 30;
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + body.vx * vs * 4, py - body.vy * vs * 4);
        ctx.stroke();
        ctx.strokeStyle = COLORS.accent;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + body.ax * vs, py - body.ay * vs);
        ctx.stroke();
      }
      if (overlays.measurements && body.maxH > 0.01) {
        const tr = tracks[body.id];
        if (tr) {
          let bi = -1;
          for (let i = 0; i < tr.t.length && tr.t[i] <= t; i++) if (bi < 0 || tr.y[i] > tr.y[bi]) bi = i;
          if (bi >= 0) {
            const ax = c.toScreenX(tr.x[bi]);
            const ay = c.toScreenY(tr.y[bi]);
            ctx.strokeStyle = withAlpha(COLORS.text2, 0.5);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax, gy);
            ctx.stroke();
            ctx.fillStyle = COLORS.text2;
            ctx.font = '11px "JetBrains Mono Variable", ui-monospace, monospace';
            ctx.fillText(`${tr.y[bi].toFixed(2)} m`, ax + 4, ay - 6);
          }
        }
      }
    }

    // Legend for overlays.
    ctx.font = '11px "Inter Variable", system-ui, sans-serif';
    let ly = 16;
    const legend: [string, string][] = [];
    if (baseline) legend.push([withAlpha(COLORS.baseline, 0.8), 'Baseline path']);
    if (overlays.vectors) legend.push([COLORS.text, 'Velocity'], [COLORS.accent, 'Acceleration']);
    for (const [col, label] of legend) {
      ctx.fillStyle = col;
      ctx.fillRect(size.width - 130, ly - 4, 14, 3);
      ctx.fillStyle = COLORS.text2;
      ctx.fillText(label, size.width - 110, ly);
      ly += 16;
    }
  };

  return (
    <CanvasStage
      draw={draw}
      onMount={(canvas) => attachPanZoom(canvas, cam.current)}
      ariaLabel="Side view of the projectile experiment showing objects, trajectories and the ground"
    />
  );
}
