import { useMemo, useRef, useState } from 'react';
import type { LiveRunner } from '../engine/runner';
import type { RunRecord, SimEvent } from '../engine/types';
import { formatTime } from '../engine/units';

interface Props {
  runner: LiveRunner;
  version: number;
  baseline: RunRecord | null;
}

const SEV_CLASS: Record<SimEvent['severity'], string> = {
  info: 'ev-info',
  milestone: 'ev-milestone',
  warning: 'ev-warning',
  critical: 'ev-critical',
};

/**
 * Interactive timeline: recorded span, current position, event markers for
 * this run (top lane) and the baseline run (bottom lane). Dragging seeks to
 * recorded states; it never integrates backwards.
 */
export function Timeline({ runner, baseline }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; label: string } | null>(null);
  const dur = runner.core.duration;
  const head = runner.core.time;
  const cur = runner.time;
  const unit = runner.model.time.unit;
  const events = runner.core.events.filter((e) => e.source !== 'user' || e.severity !== 'info');
  const baseEvents = useMemo(() => (baseline?.events ?? []).filter((e) => e.severity !== 'info'), [baseline]);
  const pos = (t: number) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;

  const seekAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const t = ((clientX - r.left) / r.width) * dur;
    runner.seekTime(Math.min(Math.max(0, t), head));
  };

  return (
    <div className="timeline">
      <div
        className="tl-track"
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label="Simulation timeline"
        aria-valuemin={0}
        aria-valuemax={dur}
        aria-valuenow={cur}
        aria-valuetext={formatTime(cur, unit)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekAt(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons) seekAt(e.clientX);
          const r = ref.current!.getBoundingClientRect();
          const t = ((e.clientX - r.left) / r.width) * dur;
          setHover({ x: e.clientX - r.left, label: formatTime(Math.max(0, t), unit) + (t > head ? ' (not simulated yet)' : '') });
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') runner.stepBack();
          else if (e.key === 'ArrowRight') runner.stepForward();
          else if (e.key === 'Home') runner.seekIndex(0);
          else if (e.key === 'End') runner.goLive();
          else return;
          e.preventDefault();
        }}
      >
        <div className="tl-recorded" style={{ width: pos(head) }} />
        <div className="tl-lane top">
          {events.map((e, i) => (
            <span key={i} className={`tl-mark ${SEV_CLASS[e.severity]}`} style={{ left: pos(e.t) }} title={`${formatTime(e.t, unit)} — ${e.label}`} />
          ))}
        </div>
        {baseline && (
          <div className="tl-lane bottom" aria-label="Baseline events">
            {baseEvents.map((e, i) => (
              <span key={i} className="tl-mark ev-baseline" style={{ left: pos(e.t) }} title={`Baseline ${formatTime(e.t, unit)} — ${e.label}`} />
            ))}
          </div>
        )}
        <div className="tl-head" style={{ left: pos(cur) }} />
        {hover && (
          <div className="tl-hover" style={{ left: hover.x }}>
            {hover.label}
          </div>
        )}
      </div>
      <div className="tl-legend">
        <span>
          <i className="tl-key ev-milestone" /> milestone
        </span>
        <span>
          <i className="tl-key ev-warning" /> threshold
        </span>
        {baseline && (
          <span>
            <i className="tl-key ev-baseline" /> baseline events
          </span>
        )}
        <span className="muted">Drag to inspect recorded states</span>
      </div>
    </div>
  );
}
