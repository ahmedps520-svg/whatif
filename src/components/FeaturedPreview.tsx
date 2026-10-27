import { useEffect, useRef, useState } from 'react';
import { CanvasStage } from './CanvasStage';
import { runInBackground, CancelledError } from '../engine/workerClient';
import type { RunRecord } from '../engine/types';
import type { ExperimentDef } from '../experiments/types';
import { getModel } from '../models/registry';
import { COLORS, seriesColor, withAlpha } from '../lib/palette';
import { formatQuantity, formatTime } from '../engine/units';

const cache = new Map<string, RunRecord>();

/**
 * Animated preview generated from a real headless run of the experiment's
 * model — trajectories if the model records tracks, otherwise its primary
 * time series drawn progressively. Never a canned animation.
 */
export function FeaturedPreview({ exp, reduceMotion }: { exp: ExperimentDef; reduceMotion: boolean }) {
  const [run, setRun] = useState<RunRecord | null>(cache.get(exp.id) ?? null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(cache.has(exp.id) ? 'ready' : 'loading');
  const startRef = useRef(performance.now());
  const model = getModel(exp.modelId)!;

  useEffect(() => {
    startRef.current = performance.now();
    if (cache.has(exp.id)) {
      setRun(cache.get(exp.id)!);
      setState('ready');
      return;
    }
    setState('loading');
    const job = runInBackground(exp.modelId, exp.params, { maxSamples: 800, timeoutMs: 8000 });
    job.promise
      .then((r) => {
        cache.set(exp.id, r);
        setRun(r);
        setState('ready');
      })
      .catch((e) => {
        if (!(e instanceof CancelledError)) setState('error');
      });
    return () => job.cancel();
  }, [exp]);

  const draw = (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
    ctx.clearRect(0, 0, size.width, size.height);
    if (!run) return;
    const tEnd = run.samples.t.at(-1) ?? 1;
    const loop = 7000;
    const frac = reduceMotion ? 1 : ((performance.now() - startRef.current) % (loop + 1500)) / loop;
    const tNow = Math.min(1, frac) * tEnd;
    const tracks = Object.entries(run.tracks);
    const pad = 18;
    if (tracks.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [, tr] of tracks)
        for (let i = 0; i < tr.t.length; i++) {
          minX = Math.min(minX, tr.x[i]);
          maxX = Math.max(maxX, tr.x[i]);
          minY = Math.min(minY, tr.y[i]);
          maxY = Math.max(maxY, tr.y[i]);
        }
      const s = Math.min((size.width - 2 * pad) / (maxX - minX || 1), (size.height - 2 * pad) / (maxY - minY || 1));
      const ox = (size.width - (maxX - minX) * s) / 2;
      const oy = (size.height + (maxY - minY) * s) / 2;
      const X = (x: number) => ox + (x - minX) * s;
      const Y = (y: number) => oy - (y - minY) * s;
      tracks.forEach(([, tr], k) => {
        ctx.strokeStyle = withAlpha(seriesColor(k), 0.9);
        ctx.lineWidth = 2;
        ctx.beginPath();
        let last = -1;
        for (let i = 0; i < tr.t.length && tr.t[i] <= tNow; i++) {
          if (i === 0) ctx.moveTo(X(tr.x[i]), Y(tr.y[i]));
          else ctx.lineTo(X(tr.x[i]), Y(tr.y[i]));
          last = i;
        }
        ctx.stroke();
        if (last >= 0) {
          ctx.fillStyle = COLORS.bg;
          ctx.beginPath();
          ctx.arc(X(tr.x[last]), Y(tr.y[last]), 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = seriesColor(k);
          ctx.beginPath();
          ctx.arc(X(tr.x[last]), Y(tr.y[last]), 4, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    } else {
      const key = model.primaryObservables?.[0] ?? model.observables.find((o) => o.chart)?.key ?? model.observables[0].key;
      const ys = run.samples.obs[key] ?? [];
      const ts = run.samples.t;
      let min = Infinity, max = -Infinity;
      for (const v of ys) if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      if (!Number.isFinite(min)) return;
      if (max - min < 1e-12) { max += 1; min -= 1; }
      const X = (t: number) => pad + (t / tEnd) * (size.width - 2 * pad);
      const Y = (v: number) => size.height - pad - ((v - min) / (max - min)) * (size.height - 2 * pad);
      ctx.strokeStyle = seriesColor(0);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      let lastI = 0;
      for (let i = 0; i < ts.length && ts[i] <= tNow; i++) {
        if (!Number.isFinite(ys[i])) continue;
        if (!started) { ctx.moveTo(X(ts[i]), Y(ys[i])); started = true; } else ctx.lineTo(X(ts[i]), Y(ys[i]));
        lastI = i;
      }
      ctx.stroke();
      const o = model.observables.find((x) => x.key === key)!;
      ctx.fillStyle = COLORS.text2;
      ctx.font = '12px "JetBrains Mono Variable", ui-monospace, monospace';
      if (started) ctx.fillText(`${o.label}: ${formatQuantity(ys[lastI], o.unit, { sig: 3 })}`, pad, pad + 4);
    }
    ctx.fillStyle = COLORS.muted;
    ctx.font = '11px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.fillText(`t = ${formatTime(tNow, model.time.unit)}`, pad, size.height - 6);
  };

  return (
    <div className="featured-preview">
      {state === 'loading' && (
        <div className="fp-status">
          <span className="spinner small" /> Running the model…
        </div>
      )}
      {state === 'error' && <div className="fp-status">Preview unavailable</div>}
      <CanvasStage draw={draw} ariaLabel={`Preview of ${exp.title}, computed from a run of the model`} />
      <div className="fp-caption">Live preview computed by the model with this experiment’s settings</div>
    </div>
  );
}
