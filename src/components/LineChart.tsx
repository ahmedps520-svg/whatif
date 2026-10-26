import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { niceStep } from '../lib/camera2d';
import { COLORS, STATUS, seriesColor, withAlpha } from '../lib/palette';
import { formatNumber } from '../engine/units';

export interface ChartSeries {
  id: string;
  label: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Defaults to the categorical slot by order (baseline series are grey). */
  color?: string;
  role?: 'experiment' | 'baseline' | 'reference';
}

export interface ChartBand {
  id: string;
  label: string;
  x: ArrayLike<number>;
  lo: ArrayLike<number>;
  hi: ArrayLike<number>;
  color?: string;
}

export interface ChartMarker {
  x: number;
  label: string;
  severity?: 'info' | 'milestone' | 'warning' | 'critical';
}

interface Props {
  series: ChartSeries[];
  bands?: ChartBand[];
  title?: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  /** Vertical cursor (e.g. current simulated time). */
  cursorX?: number | null;
  markers?: ChartMarker[];
  /** Click or drag on the plot to seek. */
  onScrub?: (x: number) => void;
  height?: number;
  xDomain?: [number, number];
  yDomain?: [number, number];
  includeZero?: boolean;
  /** Bump to redraw when the arrays were mutated in place. */
  version?: number;
  /** Horizontal reference lines (e.g. thresholds). */
  refLines?: { y: number; label: string }[];
  showTable?: boolean;
  emptyMessage?: string;
}

const PAD = { l: 56, r: 14, t: 12, b: 34 };

function bisect(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1;
  return lo;
}

function extent(series: ChartSeries[], bands: ChartBand[], key: 'x' | 'y'): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const scan = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  };
  for (const s of series) scan(s[key]);
  for (const b of bands) {
    if (key === 'x') scan(b.x);
    else {
      scan(b.lo);
      scan(b.hi);
    }
  }
  return [min, max];
}

/**
 * Canvas line chart with axes, legend, hover crosshair + tooltip, event
 * markers, a scrubbable time cursor and an accessible data table.
 */
export function LineChart(props: Props) {
  const {
    series,
    bands = [],
    title,
    subtitle,
    xLabel,
    yLabel,
    xFormat = (v) => formatNumber(v, 3),
    yFormat = (v) => formatNumber(v, 3),
    cursorX,
    markers = [],
    onScrub,
    height = 220,
    includeZero = false,
    version = 0,
    refLines = [],
    showTable = true,
    emptyMessage = 'No data yet — run the simulation.',
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ px: number; py: number } | null>(null);
  const [width, setWidth] = useState(600);
  const dragging = useRef(false);

  const colored = useMemo(() => {
    let slot = 0;
    return series.map((s) => ({
      ...s,
      color: s.color ?? (s.role === 'baseline' ? COLORS.baseline : s.role === 'reference' ? COLORS.muted : seriesColor(slot++)),
    }));
  }, [series]);

  const hasData = colored.some((s) => s.x.length > 0);

  const domains = useMemo(() => {
    let [x0, x1] = props.xDomain ?? extent(colored, bands, 'x');
    let [y0, y1] = props.yDomain ?? extent(colored, bands, 'y');
    for (const r of refLines) {
      if (!props.yDomain) {
        y0 = Math.min(y0, r.y);
        y1 = Math.max(y1, r.y);
      }
    }
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) [x0, x1] = [0, 1];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) [y0, y1] = [0, 1];
    if (includeZero && !props.yDomain) {
      y0 = Math.min(y0, 0);
      y1 = Math.max(y1, 0);
    }
    if (x1 - x0 < 1e-12) x1 = x0 + 1;
    if (y1 - y0 < 1e-12 * Math.max(1, Math.abs(y0))) {
      const pad = Math.abs(y0) * 0.05 || 1;
      y0 -= pad;
      y1 += pad;
    } else if (!props.yDomain) {
      const pad = (y1 - y0) * 0.06;
      y1 += pad;
      if (!(includeZero && y0 === 0)) y0 -= pad;
    }
    return { x0, x1, y0, y1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colored, bands, props.xDomain, props.yDomain, includeZero, version, refLines]);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toPx = useCallback(
    (x: number, y: number): [number, number] => {
      const { x0, x1, y0, y1 } = domains;
      const pw = width - PAD.l - PAD.r;
      const ph = height - PAD.t - PAD.b;
      return [PAD.l + ((x - x0) / (x1 - x0)) * pw, PAD.t + (1 - (y - y0) / (y1 - y0)) * ph];
    },
    [domains, width, height],
  );

  const fromPx = useCallback(
    (px: number): number => {
      const { x0, x1 } = domains;
      const pw = width - PAD.l - PAD.r;
      return x0 + ((px - PAD.l) / pw) * (x1 - x0);
    },
    [domains, width],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { x0, x1, y0, y1 } = domains;
    const pw = width - PAD.l - PAD.r;
    const ph = height - PAD.t - PAD.b;

    // Grid and ticks.
    ctx.font = '11px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.lineWidth = 1;
    const ys = niceStep(y1 - y0, Math.max(3, Math.floor(ph / 40)));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + ys * 1e-9; v += ys) {
      const [, py] = toPx(x0, v);
      ctx.strokeStyle = Math.abs(v) < ys * 1e-6 ? COLORS.axis : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(PAD.l, Math.round(py) + 0.5);
      ctx.lineTo(PAD.l + pw, Math.round(py) + 0.5);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(yFormat(Math.abs(v) < ys * 1e-6 ? 0 : v), PAD.l - 6, py);
    }
    const xs = niceStep(x1 - x0, Math.max(3, Math.floor(pw / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + xs * 1e-9; v += xs) {
      const [px] = toPx(v, y0);
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(xFormat(Math.abs(v) < xs * 1e-6 ? 0 : v), px, PAD.t + ph + 6);
    }
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(PAD.l, PAD.t + ph + 0.5);
    ctx.lineTo(PAD.l + pw, PAD.t + ph + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t - 2, pw, ph + 4);
    ctx.clip();

    // Reference lines.
    for (const r of refLines) {
      const [, py] = toPx(x0, r.y);
      ctx.strokeStyle = withAlpha(STATUS.warning, 0.6);
      ctx.beginPath();
      ctx.moveTo(PAD.l, py);
      ctx.lineTo(PAD.l + pw, py);
      ctx.stroke();
      ctx.fillStyle = COLORS.text2;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(r.label, PAD.l + 6, py - 2);
    }

    // Uncertainty bands (10% wash of the series hue).
    for (const b of bands) {
      ctx.fillStyle = withAlpha(b.color ?? seriesColor(0), 0.14);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < b.x.length; i++) {
        if (!Number.isFinite(b.hi[i])) continue;
        const [px, py] = toPx(b.x[i], b.hi[i]);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      for (let i = b.x.length - 1; i >= 0; i--) {
        if (!Number.isFinite(b.lo[i])) continue;
        const [px, py] = toPx(b.x[i], b.lo[i]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Lines: baseline first so experimental series sit on top.
    const ordered = [...colored].sort((a, b) => (a.role === 'baseline' ? -1 : 0) - (b.role === 'baseline' ? -1 : 0));
    for (const s of ordered) {
      const n = s.x.length;
      if (!n) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.role === 'baseline' ? 1.5 : 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      const stride = Math.max(1, Math.floor(n / (pw * 2)));
      for (let i = 0; i < n; i += stride) {
        const yv = s.y[i];
        if (!Number.isFinite(yv)) {
          pen = false;
          continue;
        }
        const [px, py] = toPx(s.x[i], yv);
        if (!pen) {
          ctx.moveTo(px, py);
          pen = true;
        } else ctx.lineTo(px, py);
      }
      if (stride > 1 && Number.isFinite(s.y[n - 1])) {
        const [px, py] = toPx(s.x[n - 1], s.y[n - 1]);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      // End dot with a surface ring.
      for (let i = n - 1; i >= 0; i--) {
        if (Number.isFinite(s.y[i])) {
          const [px, py] = toPx(s.x[i], s.y[i]);
          ctx.fillStyle = COLORS.panel;
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
    }
    ctx.restore();

    // Event markers along the top edge.
    for (const m of markers) {
      if (m.x < x0 || m.x > x1) continue;
      const [px] = toPx(m.x, y1);
      ctx.strokeStyle = m.severity === 'critical' ? STATUS.critical : m.severity === 'warning' ? STATUS.warning : m.severity === 'milestone' ? COLORS.accent : COLORS.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, PAD.t);
      ctx.lineTo(px + 0.5, PAD.t + ph);
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(px - 4, PAD.t);
      ctx.lineTo(px + 4, PAD.t);
      ctx.lineTo(px, PAD.t + 6);
      ctx.closePath();
      ctx.fill();
    }

    // Time cursor.
    if (cursorX != null && cursorX >= x0 && cursorX <= x1) {
      const [px] = toPx(cursorX, y0);
      ctx.strokeStyle = COLORS.text;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, PAD.t);
      ctx.lineTo(Math.round(px) + 0.5, PAD.t + ph);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Hover crosshair.
    if (hover && hover.px >= PAD.l && hover.px <= PAD.l + pw) {
      ctx.strokeStyle = COLORS.text2;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(Math.round(hover.px) + 0.5, PAD.t);
      ctx.lineTo(Math.round(hover.px) + 0.5, PAD.t + ph);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const hx = fromPx(hover.px);
      for (const s of colored) {
        const i = bisect(s.x, hx);
        if (i < 0 || !Number.isFinite(s.y[i])) continue;
        const [px, py] = toPx(s.x[i], s.y[i]);
        ctx.fillStyle = COLORS.panel;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [colored, bands, domains, width, height, hover, cursorX, markers, refLines, toPx, fromPx, xFormat, yFormat, version]);

  const tooltip = useMemo(() => {
    if (!hover || !hasData) return null;
    const hx = fromPx(hover.px);
    const rows = colored
      .map((s) => {
        const i = bisect(s.x, hx);
        if (i < 0) return null;
        return { id: s.id, label: s.label, color: s.color, x: s.x[i], y: s.y[i] };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && Number.isFinite(r.y));
    if (!rows.length) return null;
    const nearMarkers = markers.filter((m) => Math.abs(toPx(m.x, 0)[0] - hover.px) < 6);
    return { x: rows[0].x, rows, markers: nearMarkers };
  }, [hover, colored, fromPx, hasData, markers, toPx]);

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>, kind: 'move' | 'down' | 'up' | 'leave') => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (kind === 'leave') {
      setHover(null);
      dragging.current = false;
      return;
    }
    setHover({ px, py });
    if (kind === 'down' && onScrub) {
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      onScrub(fromPx(px));
    } else if (kind === 'move' && dragging.current && onScrub) onScrub(fromPx(px));
    else if (kind === 'up') dragging.current = false;
  };

  const tableRows = useMemo(() => {
    if (!showTable || !hasData) return [];
    const main = colored[0];
    const n = main.x.length;
    const step = Math.max(1, Math.ceil(n / 40));
    const out: { x: number; ys: number[] }[] = [];
    for (let i = 0; i < n; i += step) {
      out.push({ x: main.x[i], ys: colored.map((s) => s.y[bisect(s.x, main.x[i])]) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colored, showTable, hasData, version]);

  return (
    <figure className="chart" ref={wrapRef}>
      {(title || colored.length > 1) && (
        <figcaption className="chart-head">
          {title && (
            <div>
              <div className="chart-title">{title}</div>
              {subtitle && <div className="chart-sub">{subtitle}</div>}
            </div>
          )}
          {colored.length + bands.length > 1 && (
            <ul className="legend" aria-label="Legend">
              {colored.map((s) => (
                <li key={s.id}>
                  <span className="legend-key" style={{ background: s.color }} />
                  {s.label}
                </li>
              ))}
              {bands.map((b) => (
                <li key={b.id}>
                  <span className="legend-key band" style={{ background: withAlpha(b.color ?? seriesColor(0), 0.35) }} />
                  {b.label}
                </li>
              ))}
            </ul>
          )}
        </figcaption>
      )}
      <div className="chart-plot" style={{ height }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height, display: 'block', cursor: onScrub ? 'col-resize' : 'crosshair', touchAction: 'pan-y' }}
          onPointerMove={(e) => onPointer(e, 'move')}
          onPointerDown={(e) => onPointer(e, 'down')}
          onPointerUp={(e) => onPointer(e, 'up')}
          onPointerLeave={(e) => onPointer(e, 'leave')}
          role="img"
          aria-label={`${title ?? yLabel} versus ${xLabel}`}
        />
        <div className="axis-label y">{yLabel}</div>
        <div className="axis-label x">{xLabel}</div>
        {!hasData && <div className="chart-empty">{emptyMessage}</div>}
        {tooltip && hover && (
          <div className="chart-tip" style={{ left: Math.min(hover.px + 14, width - 190), top: Math.max(4, hover.py - 20) }}>
            <div className="tip-x">
              {xLabel}: {xFormat(tooltip.x)}
            </div>
            {tooltip.rows.map((r) => (
              <div key={r.id} className="tip-row">
                <span className="legend-key" style={{ background: r.color }} />
                <span className="tip-label">{r.label}</span>
                <span className="tip-val">{yFormat(r.y)}</span>
              </div>
            ))}
            {tooltip.markers.map((m, i) => (
              <div key={i} className="tip-marker">
                ▾ {m.label}
              </div>
            ))}
          </div>
        )}
      </div>
      {showTable && hasData && (
        <details className="chart-table">
          <summary>Data table</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{xLabel}</th>
                  {colored.map((s) => (
                    <th key={s.id}>{s.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, i) => (
                  <tr key={i}>
                    <td>{xFormat(r.x)}</td>
                    {r.ys.map((y, j) => (
                      <td key={j}>{Number.isFinite(y) ? yFormat(y) : '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
