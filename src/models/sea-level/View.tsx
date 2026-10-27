import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import './background';
import { CanvasStage } from '../../components/CanvasStage';
import { LineChart, type ChartSeries } from '../../components/LineChart';
import { Camera2D, attachPanZoom } from '../../lib/camera2d';
import { COLORS, SERIES, withAlpha } from '../../lib/palette';
import { formatNumber } from '../../engine/units';
import type { ModelViewProps } from '../../views/types';
import { areaBelow } from './flood';
import { getSeaLevelData, getSeaLevelError, prepareSeaLevelData, subscribeSeaLevel, type SeaLevelData } from './store';
import { ANTARCTIC_CUTOFF_LAT, CLS_EXCLUDED, CLS_LAKE, CLS_LAND, CLS_OCEAN, REGIONS, cellIndex, inundatedArea, regionInundatedArea, type ConnectivityRule, type SeaLevelProducts } from './products';
import { RESOLUTION_LIMIT_M, type SeaLevelState } from './model';

/* ------------------------------------------------------------------ colours */

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const pack = ([r, g, b]: RGB) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB;

const OCEAN_SHALLOW = hex('#2a5f8f');
const OCEAN_DEEP = hex('#06162a');
const LAKE_RGB = hex('#4a86b8');
const FLOOD_RGB = hex(COLORS.flood);
const CUTOFF_RGB = hex(SERIES[6]);
const EXCLUDED_GREY = hex('#3a3f46');
const LAND_STOPS: [number, RGB][] = [
  [-200, hex('#3a4a36')],
  [0, hex('#33503a')],
  [200, hex('#4a6240')],
  [600, hex('#676846')],
  [1500, hex('#836f56')],
  [3000, hex('#9c917f')],
  [5000, hex('#cac7c0')],
];
function landColor(z: number): RGB {
  if (z <= LAND_STOPS[0][0]) return LAND_STOPS[0][1];
  for (let k = 1; k < LAND_STOPS.length; k++) {
    const [z1, c1] = LAND_STOPS[k];
    if (z <= z1) {
      const [z0, c0] = LAND_STOPS[k - 1];
      return mix(c0, c1, (z - z0) / (z1 - z0));
    }
  }
  return LAND_STOPS[LAND_STOPS.length - 1][1];
}
const oceanColor = (z: number) => mix(OCEAN_SHALLOW, OCEAN_DEEP, Math.min(1, Math.sqrt(Math.max(0, -z) / 6000)));

const css = {
  flood: COLORS.flood,
  cutoff: SERIES[6],
  lake: '#4a86b8',
  ocean: '#2a5f8f',
  land: '#4a6240',
  excluded: '#3a3f46',
};

/* -------------------------------------------------------------- map raster */

interface Raster {
  products: SeaLevelProducts;
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
  base: Uint32Array;
  img: ImageData;
  land: Int32Array;
  key: string;
}

function buildRaster(d: SeaLevelData): Raster {
  const { products: p, grid } = d;
  const n = p.ncols * p.nrows;
  const base = new Uint32Array(n);
  const elev = grid.data;
  const land: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = p.cls[i];
    const z = elev[i];
    if (c === CLS_OCEAN) base[i] = pack(oceanColor(z));
    else if (c === CLS_LAKE) base[i] = pack(LAKE_RGB);
    else if (c === CLS_EXCLUDED) base[i] = pack(mix(landColor(z), EXCLUDED_GREY, 0.55));
    else {
      base[i] = pack(landColor(z));
      land.push(i);
    }
  }
  const mk = () => {
    const cv = document.createElement('canvas');
    cv.width = p.ncols;
    cv.height = p.nrows;
    return cv;
  };
  const before = mk();
  const after = mk();
  const img = new ImageData(p.ncols, p.nrows);
  new Uint32Array(img.data.buffer).set(base);
  before.getContext('2d')!.putImageData(img, 0, 0);
  return { products: p, before, after, base, img, land: Int32Array.from(land), key: '' };
}

/** Index of the first curve value ≥ L: the raster only changes when this changes. */
function curveIndex(values: Float64Array, L: number) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < L) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function updateAfter(r: Raster, elev: ArrayLike<number>, L: number, rule: ConnectivityRule) {
  const p = r.products;
  const key = `${rule}:${curveIndex(p.curves.connected.values, L)}:${curveIndex(p.curves.any.values, L)}`;
  if (key === r.key) return;
  r.key = key;
  const px = new Uint32Array(r.img.data.buffer);
  px.set(r.base);
  const flood = pack(FLOOD_RGB);
  const cut = pack(CUTOFF_RGB);
  const F = p.floodLevel;
  for (let k = 0; k < r.land.length; k++) {
    const i = r.land[k];
    if (F[i] < L) px[i] = flood;
    else if (elev[i] < L) px[i] = cut;
  }
  r.after.getContext('2d')!.putImageData(r.img, 0, 0);
}

/* ------------------------------------------------------------------ helpers */

const fmt = (v: number, sig = 3) => formatNumber(v, sig);
const latText = (v: number) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'N' : 'S'}`;
const lonText = (v: number) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'E' : 'W'}`;
const ruleOf = (v: unknown): ConnectivityRule => (v === 'any' ? 'any' : 'connected');

function useSeaLevel() {
  const data = useSyncExternalStore(subscribeSeaLevel, getSeaLevelData);
  const error = useSyncExternalStore(subscribeSeaLevel, getSeaLevelError);
  useEffect(() => {
    prepareSeaLevelData().catch(() => {});
  }, []);
  return { data, error };
}

type Compare = 'after' | 'before' | 'swipe';

const overlayBox: React.CSSProperties = {
  position: 'absolute',
  background: 'rgba(6, 8, 11, 0.78)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: '6px 10px',
  backdropFilter: 'blur(6px)',
  fontSize: '0.78rem',
  color: 'var(--text-2)',
  zIndex: 4,
};

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.5 }}>
      <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: color, flex: 'none' }} />
      {label}
    </li>
  );
}

const ATTRIBUTION = 'Elevation: ETOPO1 Global Relief Model (ice surface), NOAA NCEI — Amante & Eakins (2009); 0.25° point samples.';

/* --------------------------------------------------------------------- view */

export default function SeaLevelView({ runner, overlays, cameraResetKey }: ModelViewProps<SeaLevelState>) {
  const { data, error } = useSeaLevel();
  const [panel, setPanel] = useState<'map' | 'charts'>('map');
  const [compare, setCompare] = useState<Compare>('after');
  const [swipe, setSwipe] = useState(0.5);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  const cam = useRef(new Camera2D());
  const raster = useRef<Raster | null>(null);
  const live = useRef({ runner, overlays, data, compare, swipe, cell: null as number | null });
  live.current = { runner, overlays, data, compare, swipe, cell: pinned ?? hover };

  useEffect(() => {
    cam.current.userControlled = false;
  }, [cameraResetKey]);

  const state = runner.viewState;
  const params = runner.viewParams;
  const L = state.level;
  const rule = ruleOf(params.rule);
  const target = Number(params.target);

  const draw = (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
    const { runner, overlays, data, compare, swipe, cell } = live.current;
    const c = cam.current;
    c.resize(size.width, size.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.width, size.height);
    if (!data) return;
    if (!raster.current || raster.current.products !== data.products) raster.current = buildRaster(data);
    const r = raster.current;
    const level = runner.viewState.level;
    updateAfter(r, data.grid.data, level, ruleOf(runner.viewParams.rule));

    if (!c.userControlled) c.fit({ minX: -180, maxX: 180, minY: -90, maxY: 90 }, 0.01);

    const m = data.products.meta;
    const halfLon = Math.abs(m.dlon) / 2;
    const halfLat = Math.abs(m.dlat) / 2;
    const west = m.lon0 - halfLon;
    const north = m.lat0 + halfLat;
    const spanX = r.products.ncols * Math.abs(m.dlon);
    const spanY = r.products.nrows * Math.abs(m.dlat);
    const [wx0] = c.toWorld(0, 0);
    const [wx1] = c.toWorld(size.width, 0);
    const kmin = Math.max(-3, Math.floor((wx0 - west) / 360));
    const kmax = Math.min(3, Math.floor((wx1 - west) / 360));
    const pxPerCell = c.scale * Math.abs(m.dlon);
    ctx.imageSmoothingEnabled = pxPerCell < 1.5;

    const paint = (img: HTMLCanvasElement) => {
      for (let k = kmin; k <= kmax; k++) {
        const x = c.toScreenX(west + k * 360);
        ctx.drawImage(img, x, c.toScreenY(north), spanX * c.scale, spanY * c.scale);
      }
    };
    const splitX = compare === 'swipe' ? swipe * size.width : 0;
    if (compare === 'before') paint(r.before);
    else {
      paint(r.after);
      if (compare === 'swipe') {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitX, size.height);
        ctx.clip();
        paint(r.before);
        ctx.restore();
      }
    }

    // Graticule every 30° and the Antarctic exclusion line.
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(COLORS.text, 0.07);
    ctx.beginPath();
    for (let lon = -180 + kmin * 360; lon <= 180 + kmax * 360; lon += 30) {
      const x = Math.round(c.toScreenX(lon)) + 0.5;
      ctx.moveTo(x, c.toScreenY(90));
      ctx.lineTo(x, c.toScreenY(-90));
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = Math.round(c.toScreenY(lat)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
    }
    ctx.stroke();
    const yCut = Math.round(c.toScreenY(ANTARCTIC_CUTOFF_LAT)) + 0.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = withAlpha(COLORS.text2, 0.55);
    ctx.beginPath();
    ctx.moveTo(0, yCut);
    ctx.lineTo(size.width, yCut);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '11px "Inter Variable", system-ui, sans-serif';
    ctx.fillStyle = COLORS.text2;
    if (yCut > 20 && yCut < size.height - 4) ctx.fillText(`${-ANTARCTIC_CUTOFF_LAT}°S — south of here not assessed`, 8, yCut + 13);

    // Inspection rectangles.
    if (overlays.measurements) {
      ctx.lineWidth = 1.5;
      for (const reg of REGIONS) {
        for (let k = kmin; k <= kmax; k++) {
          const x0 = c.toScreenX(reg.west + k * 360);
          const x1 = c.toScreenX(reg.east + k * 360);
          const y0 = c.toScreenY(reg.north);
          const y1 = c.toScreenY(reg.south);
          if (x1 < 0 || x0 > size.width) continue;
          ctx.strokeStyle = withAlpha(COLORS.text, 0.85);
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          ctx.setLineDash([]);
          ctx.fillStyle = COLORS.text;
          ctx.fillText(reg.short, x0, y0 - 4);
        }
      }
    }

    // Inspected cell.
    if (cell !== null) {
      const row = Math.floor(cell / r.products.ncols);
      const col = cell - row * r.products.ncols;
      const lat = m.lat0 + row * m.dlat;
      const lon = m.lon0 + col * m.dlon;
      const s = Math.max(8, pxPerCell);
      for (let k = kmin; k <= kmax; k++) {
        const x = c.toScreenX(lon + k * 360);
        const y = c.toScreenY(lat);
        ctx.strokeStyle = COLORS.bg;
        ctx.lineWidth = 3;
        ctx.strokeRect(x - s / 2, y - s / 2, s, s);
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      }
    }

    // Swipe divider.
    if (compare === 'swipe') {
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(Math.round(splitX) - 1, 0, 2, size.height);
      ctx.font = '600 12px "Inter Variable", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('Today', splitX - 8, size.height - 44);
      ctx.textAlign = 'left';
      ctx.fillText(`+${fmt(level)} m`, splitX + 8, size.height - 44);
    }
  };

  const onMount = (canvas: HTMLCanvasElement) => {
    const detach = attachPanZoom(canvas, cam.current);
    let down: { x: number; y: number } | null = null;
    const cellAt = (e: PointerEvent): number | null => {
      const d = live.current.data;
      if (!d) return null;
      const rect = canvas.getBoundingClientRect();
      const [lonRaw, lat] = cam.current.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      if (lat > 90 || lat < -90) return null;
      const lon = ((((lonRaw + 180) % 360) + 360) % 360) - 180;
      const p = d.products;
      return cellIndex(p.meta, p.ncols, p.nrows, lat, lon);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const i = cellAt(e);
      setHover((h) => (h === i ? h : i));
    };
    const pdown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const i = cellAt(e);
      setPinned((p) => (p === i ? null : i));
    };
    const leave = () => setHover(null);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', pdown);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', leave);
    return () => {
      detach();
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerdown', pdown);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointerleave', leave);
    };
  };

  /* ------------------------------------------------ data-derived panels */

  const curve = useMemo(() => {
    if (!data) return null;
    const xs: number[] = [];
    const conn: number[] = [];
    const any: number[] = [];
    for (let x = 0; x <= 200 + 1e-9; x += 0.5) {
      xs.push(x);
      conn.push(areaBelow(data.products.curves.connected, x) / 1e6);
      any.push(areaBelow(data.products.curves.any, x) / 1e6);
    }
    return { xs, conn, any };
  }, [data]);

  const series: ChartSeries[] = useMemo(
    () =>
      curve
        ? [
            { id: 'connected', label: `Connected to the ocean${rule === 'connected' ? ' (active rule)' : ''}`, x: curve.xs, y: curve.conn, color: COLORS.flood },
            { id: 'any', label: `Any land below the level${rule === 'any' ? ' (active rule)' : ''}`, x: curve.xs, y: curve.any, color: SERIES[6] },
          ]
        : [],
    [curve, rule],
  );

  const totals = data ? { area: inundatedArea(data.products, L, rule), land: data.products.totals.land } : null;
  const regionRows = data
    ? REGIONS.map((reg) => {
        const rp = data.products.regions.find((x) => x.id === reg.id);
        const a = rp ? regionInundatedArea(rp, L, rule) : NaN;
        return { reg, area: a, land: rp?.landArea ?? 0, pct: rp && rp.landArea > 0 ? (100 * a) / rp.landArea : NaN };
      })
    : [];

  const cell = pinned ?? hover;
  const inspector = data && cell !== null ? describeCell(data, cell, L, rule) : null;

  if (error && !data) {
    return (
      <div className="stage-loading" role="alert" style={{ flexDirection: 'column', padding: 24, textAlign: 'center' }}>
        <strong style={{ color: 'var(--text)' }}>Could not load the elevation dataset</strong>
        <span>{error.message}</span>
        <button className="btn secondary small" onClick={() => prepareSeaLevelData().catch(() => {})}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="stage-loading" role="status">
        <span className="spinner" /> Loading ETOPO1 elevations and computing flood levels…
      </div>
    );
  }

  const lowRes = L > 0 && L < RESOLUTION_LIMIT_M;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', inset: 0, visibility: panel === 'map' ? 'visible' : 'hidden' }}>
        <CanvasStage
          draw={draw}
          onMount={onMount}
          ariaLabel={`World map of the sea at +${fmt(L)} m: present ocean in blue, newly flooded land in orange, low land the sea cannot reach in purple. Drag to pan, scroll or pinch to zoom, click a place to inspect it.`}
        />
      </div>

      {/* Top-left controls. */}
      <div style={{ ...overlayBox, top: 8, left: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: 'calc(100% - 190px)', padding: 4 }}>
        <div className="segmented small" role="group" aria-label="Panel">
          <button className={panel === 'map' ? 'on' : ''} aria-pressed={panel === 'map'} onClick={() => setPanel('map')}>
            Map
          </button>
          <button className={panel === 'charts' ? 'on' : ''} aria-pressed={panel === 'charts'} onClick={() => setPanel('charts')}>
            Charts
          </button>
        </div>
        {panel === 'map' && (
          <div className="segmented small" role="group" aria-label="Compare coastlines">
            <button className={compare === 'before' ? 'on' : ''} aria-pressed={compare === 'before'} onClick={() => setCompare('before')} title="Present coastline">
              Today
            </button>
            <button className={compare === 'after' ? 'on' : ''} aria-pressed={compare === 'after'} onClick={() => setCompare('after')} title="Hypothetical sea level">
              +{fmt(L)} m
            </button>
            <button className={compare === 'swipe' ? 'on' : ''} aria-pressed={compare === 'swipe'} onClick={() => setCompare('swipe')} title="Swipe between today and the raised sea">
              Swipe
            </button>
          </div>
        )}
        <span style={{ padding: '0 4px', color: 'var(--text)' }} className="mono">
          {totals ? `${fmt(totals.area / 1e6)} M km² · ${fmt((100 * totals.area) / totals.land, 2)} %` : ''}
        </span>
      </div>

      {lowRes && (
        <div style={{ ...overlayBox, top: 52, left: 8, maxWidth: 360, borderColor: 'rgba(250, 178, 25, 0.5)', color: 'var(--warning)' }} role="note">
          Below ≈{RESOLUTION_LIMIT_M} m this 0.25° grid cannot resolve coastlines reliably. Treat the map as indicative only.
        </div>
      )}

      {panel === 'map' && (
        <>
          {compare === 'swipe' && (
            <div style={{ ...overlayBox, left: '50%', transform: 'translateX(-50%)', bottom: 8, width: 'min(360px, 70%)', padding: '4px 10px' }}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={swipe}
                onChange={(e) => setSwipe(Number(e.target.value))}
                aria-label="Swipe position between today’s coastline (left) and the raised sea (right)"
                style={{ width: '100%' }}
              />
            </div>
          )}

          <details style={{ ...overlayBox, left: 8, bottom: compare === 'swipe' ? 52 : 8, maxWidth: 270 }} open>
            <summary style={{ cursor: 'pointer', color: 'var(--text)' }}>Legend</summary>
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
              <Swatch color={css.ocean} label="Present ocean (darker = deeper)" />
              <Swatch color={css.lake} label="Inland water (Caspian, Great Lakes)" />
              <Swatch color={css.flood} label={rule === 'any' ? 'Below the level, reachable by the sea' : 'Newly flooded (sea can reach it)'} />
              <Swatch color={css.cutoff} label={rule === 'any' ? 'Below the level but cut off — counted under this rule' : 'Below the level but cut off — stays dry'} />
              <Swatch color={css.land} label="Dry land (lighter = higher)" />
              <Swatch color={css.excluded} label="Antarctica: not assessed (ice shelves)" />
            </ul>
            <div style={{ marginTop: 4, fontSize: '0.7rem', color: 'var(--muted)', maxWidth: 250 }}>{ATTRIBUTION}</div>
          </details>

          {inspector && (
            <div style={{ ...overlayBox, right: 8, bottom: 8, width: 'min(270px, 48%)' }} aria-live="polite">
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text)', fontWeight: 600 }}>
                <span>
                  {latText(inspector.lat)}, {lonText(inspector.lon)}
                </span>
                {pinned !== null && (
                  <button className="btn-text" style={{ fontSize: '0.75rem', color: 'var(--text-2)' }} onClick={() => setPinned(null)} aria-label="Close inspection">
                    ✕
                  </button>
                )}
              </div>
              <div>
                Elevation (ETOPO1): <span className="mono" style={{ color: 'var(--text)' }}>{fmt(inspector.elev, 4)} m</span>
              </div>
              <div style={{ color: inspector.statusColor }}>{inspector.status}</div>
              {inspector.flood && <div>{inspector.flood}</div>}
              {inspector.note && <div style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>{inspector.note}</div>}
            </div>
          )}
        </>
      )}

      {panel === 'charts' && (
        <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '56px 14px 14px', background: 'var(--bg)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 16 }}>
            <LineChart
              title="Newly inundated land vs sea-level rise"
              subtitle="Hypsometric curve from ETOPO1, land outside Antarctica"
              series={series}
              xLabel="Sea-level rise (m)"
              yLabel="Million km²"
              xDomain={[0, 200]}
              includeZero
              cursorX={L}
              markers={[
                ...(target > 0 ? [{ x: target, label: `Target +${fmt(target)} m`, severity: 'milestone' as const }] : []),
                { x: RESOLUTION_LIMIT_M, label: `Below ≈${RESOLUTION_LIMIT_M} m: not reliably resolved by this grid`, severity: 'warning' as const },
              ]}
              height={220}
              showTable
            />
            <figure className="chart" style={{ margin: 0 }}>
              <figcaption className="chart-head">
                <div>
                  <div className="chart-title">Share of each region’s land below the sea at +{fmt(L)} m</div>
                  <div className="chart-sub">Approximate rectangles, not political boundaries · {rule === 'any' ? 'any land below the level' : 'connected to the ocean'}</div>
                </div>
              </figcaption>
              <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 8 }}>
                {regionRows.map(({ reg, area, land, pct }) => (
                  <li key={reg.id} title={`${reg.name}: ${reg.south}° to ${reg.north}° latitude, ${reg.west}° to ${reg.east}° longitude; ${fmt(land, 2)} km² of land in the grid`} style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 30%) 1fr auto', alignItems: 'center', gap: 8, fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reg.short}</span>
                    <span style={{ position: 'relative', height: 16, background: 'var(--panel-2)', borderRadius: 4, overflow: 'hidden' }} aria-hidden>
                      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Number.isFinite(pct) ? Math.min(100, pct) : 0}%`, background: COLORS.flood, borderRadius: '0 4px 4px 0' }} />
                    </span>
                    <span className="mono" style={{ color: 'var(--text)', minWidth: 112, textAlign: 'right' }}>
                      {Number.isFinite(pct) ? `${fmt(pct, 2)} %` : '—'} <span style={{ color: 'var(--muted)' }}>{Number.isFinite(area) ? `${fmt(area, 2)} km²` : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </figure>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 12 }}>
            {ATTRIBUTION} Present land assessed: {fmt(data.products.totals.land / 1e6)} million km². A map of where the sea would stand, not a flood forecast.
          </p>
        </div>
      )}
    </div>
  );
}

function describeCell(d: SeaLevelData, i: number, L: number, rule: ConnectivityRule) {
  const p = d.products;
  const row = Math.floor(i / p.ncols);
  const lat = p.meta.lat0 + row * p.meta.dlat;
  const lon = p.meta.lon0 + (i - row * p.ncols) * p.meta.dlon;
  const elev = d.grid.data[i];
  const F = p.floodLevel[i];
  const c = p.cls[i];
  let status = '';
  let statusColor = 'var(--text)';
  let flood = '';
  let note = '';
  if (c === CLS_OCEAN) {
    status = 'Present ocean';
    statusColor = css.ocean;
  } else if (c === CLS_LAKE) {
    const w = p.inlandWater[p.lake[i] - 1];
    status = `Inland water: ${w?.name ?? 'lake'}`;
    statusColor = css.lake;
    note = `The elevation is the lake bed; the lake surface is ≈${w?.surface ?? '?'} m.`;
    flood = Number.isFinite(F) ? `The sea joins it once the rise exceeds ${fmt(F, 4)} m${F < L ? ' (it does at this level).' : '.'}` : '';
  } else if (c === CLS_EXCLUDED) {
    status = 'Antarctica: not assessed';
    statusColor = 'var(--text-2)';
    note = 'The ice-surface grid shows floating ice shelves as low land here, so these cells are left out of all totals.';
  } else {
    flood = Number.isFinite(F) ? `Flood level: the sea reaches it once the rise exceeds ${fmt(F, 4)} m.` : 'Not connected to the ocean on this grid.';
    if (F < L) {
      status = 'Newly flooded at this level';
      statusColor = css.flood;
    } else if (elev < L) {
      status = rule === 'any' ? 'Counted as flooded (below the level, but the sea cannot reach it)' : 'Dry: below the level, but cut off from the sea';
      statusColor = css.cutoff;
    } else status = 'Dry land at this level';
    if (c === CLS_LAND && elev < 0) note = 'Land below present sea level that the sea cannot reach today.';
  }
  return { lat, lon, elev, status, statusColor, flood, note };
}
