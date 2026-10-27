import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CanvasStage } from '../../components/CanvasStage';
import { earthTextureLegend, imageToCanvas, renderEarthTexture } from '../../data/earthTexture';
import { loadElevation, type ElevationGrid } from '../../data/elevation';
import { formatNumber } from '../../engine/units';
import { num } from '../../engine/validation';
import { COLORS, SERIES, withAlpha } from '../../lib/palette';
import { ThreeStage, type ThreeContext, type ThreeStageHandle } from '../../three/ThreeStage';
import type { ModelViewProps } from '../../views/types';
import {
  getHypsometry,
  planetConfig,
  preparePlanetData,
  seaLevelForCoverage,
  seasonName,
  skyOf,
  type PlanetConfig,
  type PlanetState,
} from './model';
import styles from './View.module.css';

/**
 * Planet Lab view: a three.js globe in a planet-centred, non-rotating frame
 * (world +Y = orbit normal). The globe's orientation comes only from the
 * simulated state: the spin axis is tilted by ε and the globe is turned by the
 * sidereal rotation angle s.rot, so motion always reflects the configured
 * period. Starlight comes from the star's direction at the current orbital
 * position, which puts the terminator in the right place.
 */

const STAR = '#fff1cf';
const ATMOS = '#8fc3ff';
const OBS_COLOR = SERIES[1];
const EQUATOR_COLOR = COLORS.accent;
const TROPIC_COLOR = SERIES[3];
const POLAR_COLOR = SERIES[6];
/** Vertical exaggeration of the atmosphere shell (visual cue only). */
const ATMOS_EXAGGERATION = 15;
const DEG = Math.PI / 180;

type SurfaceMode = 'auto' | 'earth' | 'neutral';
type DataStatus = 'loading' | 'ready' | 'failed';

interface SceneObjects {
  globe: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
  atmosphere: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  sun: THREE.DirectionalLight;
  star: THREE.Mesh;
  marker: THREE.Group;
  lines: THREE.Group;
  subsolar: THREE.Mesh;
  axisArrow: THREE.ArrowHelper;
  sunArrow: THREE.ArrowHelper;
  raycaster: THREE.Raycaster;
  linesTilt: number;
  markerKey: string;
}

/** Earth-terrain texture is shown automatically when the planet has water and an Earth-like size. */
function isEarthLike(c: PlanetConfig): boolean {
  return c.water > 0 && c.radius >= 0.5 && c.radius <= 2.5;
}

function atmosphereLook(c: PlanetConfig) {
  if (!(c.pBar > 0) || !Number.isFinite(c.scaleHeight) || c.scaleHeight <= 0) return { visible: false, thickness: 0, opacity: 0 };
  const thickness = Math.min(0.18, Math.max(0.012, (ATMOS_EXAGGERATION * c.scaleHeight) / c.rM));
  const opacity = Math.min(0.85, Math.max(0.06, 0.32 + 0.14 * Math.log10(c.pBar)));
  return { visible: true, thickness, opacity };
}

/** Body-frame point (three.js sphere UV convention: lon 0 → +X, 90°E → −Z, north → +Y). */
function bodyPoint(latDeg: number, lonDeg: number, r = 1): THREE.Vector3 {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

let neutralCanvas: HTMLCanvasElement | null = null;
/** Deterministic neutral grey-brown surface (value noise), used while loading or for non-Earth-like planets. */
function neutralTexture(): HTMLCanvasElement {
  if (neutralCanvas) return neutralCanvas;
  const W = 512;
  const H = 256;
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number, cell: number) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const wrap = Math.round(W / cell);
    const v = (i: number, j: number) => hash(((i % wrap) + wrap) % wrap, j);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy;
  };
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = 0.5 * noise(x, y, 64) + 0.3 * noise(x, y, 16) + 0.2 * noise(x, y, 4);
      const k = 0.75 + 0.4 * n;
      const o = (y * W + x) * 4;
      data[o] = 132 * k;
      data[o + 1] = 122 * k;
      data[o + 2] = 110 * k;
      data[o + 3] = 255;
    }
  }
  neutralCanvas = imageToCanvas({ width: W, height: H, data });
  return neutralCanvas;
}

function makeCircle(points: THREE.Vector3[], color: string, opacity: number, dashed: boolean): THREE.Line {
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.04, gapSize: 0.03 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const line = new THREE.Line(geom, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

function parallel(latDeg: number, r = 1.003): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 160; i++) pts.push(bodyPoint(latDeg, (i / 160) * 360 - 180, r));
  return pts;
}

function buildLines(group: THREE.Group, tiltDeg: number) {
  for (const child of [...group.children]) {
    group.remove(child);
    const l = child as THREE.Line;
    l.geometry.dispose();
    (l.material as THREE.Material).dispose();
  }
  for (const lat of [-60, -30, 30, 60]) group.add(makeCircle(parallel(lat), COLORS.text2, 0.18, false));
  const meridian: THREE.Vector3[] = [];
  for (let i = 0; i <= 80; i++) meridian.push(bodyPoint(-90 + (i / 80) * 180, 0, 1.003));
  group.add(makeCircle(meridian, COLORS.text2, 0.25, false));
  group.add(makeCircle(parallel(0), EQUATOR_COLOR, 0.85, false));
  const tropic = tiltDeg <= 90 ? tiltDeg : 180 - tiltDeg;
  if (tropic >= 0.05) {
    group.add(makeCircle(parallel(tropic), TROPIC_COLOR, 0.85, true));
    group.add(makeCircle(parallel(-tropic), TROPIC_COLOR, 0.85, true));
    if (tropic < 89.95) {
      group.add(makeCircle(parallel(90 - tropic), POLAR_COLOR, 0.85, true));
      group.add(makeCircle(parallel(-(90 - tropic)), POLAR_COLOR, 0.85, true));
    }
  }
}

const ATMOS_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ATMOS_FRAG = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = pow(1.0 - max(dot(vN, vV), 0.0), 2.2);
  float lit = smoothstep(-0.3, 0.35, dot(vN, uSun));
  gl_FragColor = vec4(uColor, uOpacity * (0.12 + 0.88 * rim) * (0.12 + 0.88 * lit));
}`;

function fmt(v: number, sig = 3) {
  return formatNumber(v, sig);
}

function latLon(lat: number, lon: number) {
  return `${fmt(Math.abs(lat), 3)}°${lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(lon), 4)}°${lon >= 0 ? 'E' : 'W'}`;
}

/** Track value at time t (nearest earlier recorded point). */
function trackAt(tr: { t: number[]; x: number[]; y: number[] } | undefined, t: number): [number, number] | null {
  if (!tr || !tr.t.length || t < tr.t[0]) return null;
  let lo = 0;
  let hi = tr.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tr.t[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return [tr.x[lo], tr.y[lo]];
}

export default function PlanetView({ runner, baseline, overlays, version, cameraResetKey }: ModelViewProps<PlanetState>) {
  const stageRef = useRef<ThreeStageHandle>(null);
  const live = useRef({ runner, overlays, baseline });
  live.current = { runner, overlays, baseline };
  const objs = useRef<SceneObjects | null>(null);
  const texRef = useRef<THREE.Texture | null>(null);
  const pendingCanvas = useRef<HTMLCanvasElement | null>(null);
  const texKeyRef = useRef<string | null>(null);
  const [grid, setGrid] = useState<ElevationGrid | null>(null);
  const [dataStatus, setDataStatus] = useState<DataStatus>('loading');
  const [mode, setMode] = useState<SurfaceMode>('auto');
  const [legendOpen, setLegendOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 720);

  // Elevation grid (shared cached promise) and the model's hypsometric curve.
  useEffect(() => {
    let alive = true;
    Promise.all([loadElevation(), preparePlanetData()]).then(
      ([g]) => {
        if (!alive) return;
        if (getHypsometry()) {
          setGrid(g);
          setDataStatus('ready');
        } else setDataStatus('failed');
      },
      () => alive && setDataStatus('failed'),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    stageRef.current?.resetCamera();
  }, [cameraResetKey]);

  const p = runner.viewParams;
  const s = runner.viewState;
  const c = planetConfig(p);
  const earthLike = isEarthLike(c);
  const useEarth = grid !== null && (mode === 'earth' || (mode === 'auto' && earthLike));
  const water = num(p, 'water');
  const texKey = useEarth ? `earth|${water.toFixed(2)}|${c.waterState}` : 'neutral';
  const seaLevel = seaLevelForCoverage(water);

  const applyCanvas = (canvas: HTMLCanvasElement) => {
    const o = objs.current;
    if (!o) {
      pendingCanvas.current = canvas;
      return;
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    o.globe.material.map = tex;
    o.globe.material.needsUpdate = true;
    texRef.current?.dispose();
    texRef.current = tex;
  };

  // Regenerate the texture only when the water coverage, its state or the surface mode change (debounced).
  useEffect(() => {
    if (texKeyRef.current === texKey) return;
    const first = texKeyRef.current === null;
    const id = window.setTimeout(
      () => {
        texKeyRef.current = texKey;
        if (texKey === 'neutral' || !grid) {
          applyCanvas(neutralTexture());
          return;
        }
        const sea = seaLevelForCoverage(water);
        const narrow = window.innerWidth < 720;
        const img = renderEarthTexture(grid, { width: narrow ? 1024 : 1440, seaLevel: Number.isFinite(sea) ? sea : 0, water: c.waterState });
        applyCanvas(imageToCanvas(img));
      },
      first ? 0 : 220,
    );
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texKey, grid]);

  useEffect(
    () => () => {
      texRef.current?.dispose();
      texRef.current = null;
    },
    [],
  );

  const setup = (ctx: ThreeContext) => {
    const { scene, controls } = ctx;
    controls.minDistance = 1.4;
    controls.maxDistance = 25;
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    const sun = new THREE.DirectionalLight(STAR, 3.1);
    scene.add(sun, sun.target);

    const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    scene.add(globe);
    const lines = new THREE.Group();
    globe.add(lines);

    const marker = new THREE.Group();
    const markerMat = new THREE.MeshBasicMaterial({ color: OBS_COLOR });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), markerMat);
    head.position.y = 0.08;
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.08, 6), markerMat);
    pin.position.y = 0.04;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.028, 24), new THREE.MeshBasicMaterial({ color: OBS_COLOR, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    marker.add(head, pin, ring);
    globe.add(marker);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMOS_VERT,
        fragmentShader: ATMOS_FRAG,
        uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uColor: { value: new THREE.Color(ATMOS) }, uOpacity: { value: 0.3 } },
        transparent: true,
        depthWrite: false,
      }),
    );
    scene.add(atmosphere);

    const star = new THREE.Mesh(new THREE.SphereGeometry(1.4, 24, 16), new THREE.MeshBasicMaterial({ color: STAR }));
    scene.add(star);
    const subsolar = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), new THREE.MeshBasicMaterial({ color: STAR }));
    scene.add(subsolar);
    const axisArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1.5, 0), 3, COLORS.text, 0.14, 0.07);
    const sunArrow = new THREE.ArrowHelper(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(2.6, 0, 0), 1.3, STAR, 0.16, 0.08);
    scene.add(axisArrow, sunArrow);

    objs.current = { globe, atmosphere, sun, star, marker, lines, subsolar, axisArrow, sunArrow, raycaster: new THREE.Raycaster(), linesTilt: NaN, markerKey: '' };
    applyCanvas(pendingCanvas.current ?? neutralTexture());
    pendingCanvas.current = null;
    return () => {
      objs.current = null;
    };
  };

  const basis = useRef({ m: new THREE.Matrix4(), bx: new THREE.Vector3(), by: new THREE.Vector3(), bz: new THREE.Vector3(), sun: new THREE.Vector3() });

  const frame = () => {
    const o = objs.current;
    if (!o) return;
    const { runner, overlays } = live.current;
    const st = runner.viewState;
    const pc = planetConfig(runner.viewParams);
    const eps = pc.eps;
    const b = basis.current;
    // Equatorial axes in the world frame (world X = equinox direction, world Y = orbit normal).
    const ce = Math.cos(eps);
    const se = Math.sin(eps);
    const ct = Math.cos(st.rot);
    const sn = Math.sin(st.rot);
    // x_eq = (1,0,0); y_eq = (0, −sin ε, −cos ε); z_eq (spin axis) = (0, cos ε, −sin ε)
    b.bx.set(ct, -sn * se, -sn * ce);
    b.by.set(0, ce, -se);
    b.bz.set(sn, ct * se, ct * ce);
    b.m.makeBasis(b.bx, b.by, b.bz);
    o.globe.quaternion.setFromRotationMatrix(b.m);

    const lambda = st.lambda0 + st.orbit;
    b.sun.set(Math.cos(lambda), 0, -Math.sin(lambda));
    o.sun.position.copy(b.sun).multiplyScalar(10);
    o.star.position.copy(b.sun).multiplyScalar(70);
    o.subsolar.position.copy(b.sun).multiplyScalar(1.006);
    o.subsolar.visible = overlays.measurements;

    const look = atmosphereLook(pc);
    o.atmosphere.visible = look.visible;
    o.atmosphere.scale.setScalar(1 + look.thickness);
    o.atmosphere.material.uniforms.uOpacity.value = look.opacity;
    (o.atmosphere.material.uniforms.uSun.value as THREE.Vector3).copy(b.sun);

    if (o.linesTilt !== pc.tiltDeg) {
      buildLines(o.lines, pc.tiltDeg);
      o.linesTilt = pc.tiltDeg;
    }
    o.lines.visible = overlays.measurements;

    const key = `${pc.lat},${pc.lon}`;
    if (o.markerKey !== key) {
      const n = bodyPoint(pc.lat, pc.lon);
      o.marker.position.copy(n);
      o.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().normalize());
      o.markerKey = key;
    }

    o.axisArrow.visible = overlays.vectors;
    o.sunArrow.visible = overlays.vectors;
    if (overlays.vectors) {
      o.axisArrow.position.copy(b.by).multiplyScalar(-1.5);
      o.axisArrow.setDirection(b.by);
      o.sunArrow.position.copy(b.sun).multiplyScalar(2.6);
      o.sunArrow.setDirection(b.sun.clone().negate());
    }
  };

  const onPick = (ctx: ThreeContext, ndc: THREE.Vector2) => {
    const o = objs.current;
    if (!o) return;
    o.raycaster.setFromCamera(ndc, ctx.camera);
    const hit = o.raycaster.intersectObject(o.globe, false)[0];
    if (!hit) return;
    const local = o.globe.worldToLocal(hit.point.clone()).normalize();
    const lat = Math.round(Math.asin(Math.max(-1, Math.min(1, local.y))) * (1800 / Math.PI)) / 10;
    const lon = Math.round(Math.atan2(-local.z, local.x) * (1800 / Math.PI)) / 10;
    const r = live.current.runner;
    r.setParam('observer', 'custom');
    r.setParam('obsLat', lat);
    r.setParam('obsLon', lon === -180 ? 180 : lon);
  };

  const drawInset = (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
    const { runner, baseline } = live.current;
    const st = runner.viewState;
    const pc = planetConfig(runner.viewParams);
    const W = size.width;
    const H = size.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const bTrack = baseline?.tracks.planet;
    const bAU = bTrack && bTrack.x.length ? Math.hypot(bTrack.x[0], bTrack.y[0]) : 0;
    const maxAU = Math.max(pc.aAU, bAU);
    const R = Math.min(W, H) / 2 - 16;
    if (R <= 2) return; // not laid out yet
    const scale = R / maxAU;
    // Baseline orbit and position (grey).
    if (bTrack && bAU > 0) {
      ctx.strokeStyle = withAlpha(COLORS.baseline, 0.35);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, bAU * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const bp = trackAt(bTrack, runner.time);
      if (bp) {
        ctx.fillStyle = withAlpha(COLORS.baseline, 0.85);
        ctx.beginPath();
        ctx.arc(cx + bp[0] * scale, cy - bp[1] * scale, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const r = pc.aAU * scale;
    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Season points: the planet is opposite the star's apparent longitude.
    const seasonal = pc.tiltDeg >= 0.05 && pc.tiltDeg <= 179.95;
    if (seasonal) {
      ctx.font = '9px "Inter Variable", system-ui, sans-serif';
      ctx.fillStyle = COLORS.muted;
      const labels = ['N spring', 'N summer', 'N autumn', 'N winter'];
      for (let k = 0; k < 4; k++) {
        const L = (k * Math.PI) / 2 + Math.PI;
        const x = cx + r * Math.cos(L);
        const y = cy - r * Math.sin(L);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        const tw = ctx.measureText(labels[k]).width;
        const lx = Math.max(1, Math.min(W - tw - 1, x - tw / 2 + Math.cos(L) * 4));
        const ly = Math.max(9, Math.min(H - 2, y - Math.sin(L) * 9 + 3));
        ctx.fillText(labels[k], lx, ly);
      }
    }
    // Star.
    ctx.fillStyle = STAR;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    // Planet and the projection of its spin axis on the orbital plane (toward ecliptic +y).
    const L = st.lambda0 + st.orbit + Math.PI;
    const px = cx + r * Math.cos(L);
    const py = cy - r * Math.sin(L);
    if (seasonal) {
      ctx.strokeStyle = COLORS.text;
      ctx.lineWidth = 1.5;
      const len = 11 * Math.sin(pc.eps);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - len);
      ctx.stroke();
    }
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
  };

  // ---- HUD values (React-rendered; refreshed via `version`) ----
  void version;
  const sky = skyOf(s, c);
  const lambdaDeg = (((sky.lambda / DEG) % 360) + 360) % 360;
  const elevDeg = sky.elev / DEG;
  const finiteDay = Number.isFinite(c.solarH);
  const lst = 12 + (sky.hourAngle / DEG) / 15;
  const lstH = Math.floor(((lst % 24) + 24) % 24);
  const lstM = Math.floor(((((lst % 24) + 24) % 24) - lstH) * 60);
  const legend = useEarth ? earthTextureLegend({ seaLevel: Number.isFinite(seaLevel) ? seaLevel : 0, water: c.waterState }) : [];
  const look = atmosphereLook(c);

  return (
    <div className={styles.root}>
      <ThreeStage
        ref={stageRef}
        setup={setup}
        frame={frame}
        onPick={onPick}
        cameraPosition={[0, 1.1, 3.6]}
        fov={40}
        ariaLabel="3D globe of the configured planet, lit from the direction of its star. Click the globe to choose the observation point."
      />

      <div className={`${styles.panel} ${styles.inset}`} aria-label="Orbit seen from above the orbital plane">
        <div className={styles.insetTitle}>Orbit (not to scale)</div>
        <div className={styles.insetCanvas}>
          <CanvasStage draw={drawInset} ariaLabel="Top-down view of the orbit with the planet's current position and the season points" />
        </div>
        <div className={styles.season}>{seasonName(lambdaDeg, c.tiltDeg)}</div>
        <div className={styles.mono}>
          {fmt(lambdaDeg, 3)}° · {fmt((lambdaDeg / 360) * 100, 2)}% of the orbit
        </div>
      </div>

      <div className={`${styles.panel} ${styles.observer}`}>
        <div>
          Observation point <strong className={styles.mono}>{latLon(c.lat, c.lon)}</strong>
        </div>
        <div className={styles.mono}>
          Star {elevDeg >= 0 ? `${fmt(elevDeg)}° above` : `${fmt(-elevDeg)}° below`} the horizon
          {finiteDay ? ` · local solar time ${String(lstH).padStart(2, '0')}:${String(lstM).padStart(2, '0')}` : ' · no solar day (locked)'}
        </div>
        {finiteDay && Math.abs(Math.abs(c.solarH) - 24) > 0.05 && (
          <div className={styles.hint}>Clock: 24 equal parts of this planet’s {fmt(Math.abs(c.solarH), 4)} h solar day.</div>
        )}
        <div className={styles.hint}>Click the globe to move the observation point.</div>
      </div>

      <div className={`${styles.panel} ${styles.legendWrap}`}>
        <button type="button" className={styles.legendToggle} aria-expanded={legendOpen} onClick={() => setLegendOpen((v) => !v)}>
          <span>Legend</span>
          <span aria-hidden="true">{legendOpen ? '−' : '+'}</span>
        </button>
        {legendOpen && (
          <>
            <div className={styles.seg} role="group" aria-label="Globe surface">
              {(
                [
                  ['auto', 'Auto'],
                  ['earth', 'Earth terrain'],
                  ['neutral', 'Neutral'],
                ] as const
              ).map(([m, label]) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} title={m === 'auto' ? 'Earth terrain when water coverage is above 0% and the radius is 0.5–2.5 R⊕; otherwise a neutral surface.' : undefined}>
                  {label}
                </button>
              ))}
            </div>
            {dataStatus === 'loading' && <div className={styles.status}>Loading Earth elevation data… (neutral surface for now)</div>}
            {dataStatus === 'failed' && <div className={styles.status}>Elevation data unavailable: neutral placeholder surface.</div>}
            <ul className={styles.legendList}>
              {useEarth ? (
                legend.map((e) => (
                  <li key={e.key}>
                    <span className={styles.swatch} style={{ background: e.color }} />
                    {e.label}
                  </li>
                ))
              ) : (
                <li>
                  <span className={styles.swatch} style={{ background: '#857b70' }} />
                  Neutral surface (no terrain shown)
                </li>
              )}
              {overlays.measurements && (
                <>
                  <li style={{ color: EQUATOR_COLOR }}>
                    <span className={styles.lineSwatch} />
                    <span style={{ color: 'var(--text-2)' }}>Equator</span>
                  </li>
                  {c.tiltDeg >= 0.05 && c.tiltDeg <= 179.95 && (
                    <>
                      <li style={{ color: TROPIC_COLOR }}>
                        <span className={`${styles.lineSwatch} ${styles.dashed}`} />
                        <span style={{ color: 'var(--text-2)' }}>Tropics (±{fmt(c.tiltDeg <= 90 ? c.tiltDeg : 180 - c.tiltDeg)}°)</span>
                      </li>
                      <li style={{ color: POLAR_COLOR }}>
                        <span className={`${styles.lineSwatch} ${styles.dashed}`} />
                        <span style={{ color: 'var(--text-2)' }}>Polar circles</span>
                      </li>
                    </>
                  )}
                  <li>
                    <span className={styles.dot} style={{ background: STAR }} />
                    Subsolar point
                  </li>
                </>
              )}
              <li>
                <span className={styles.dot} style={{ background: OBS_COLOR }} />
                Observation point
              </li>
              {overlays.vectors && (
                <>
                  <li style={{ color: COLORS.text }}>
                    <span className={styles.lineSwatch} />
                    <span style={{ color: 'var(--text-2)' }}>Rotation axis (points north)</span>
                  </li>
                  <li style={{ color: STAR }}>
                    <span className={styles.lineSwatch} />
                    <span style={{ color: 'var(--text-2)' }}>Direction of starlight</span>
                  </li>
                </>
              )}
            </ul>
            {useEarth && (
              <p className={styles.note}>
                Earth’s terrain (NOAA ETOPO1) with {fmt(water, 3)}% water
                {Number.isFinite(seaLevel) ? `: sea level ${seaLevel >= 0 ? '+' : '−'}${fmt(Math.abs(Math.round(seaLevel)), 4)} m` : ''}. Colours come from elevation, not land cover; ice is an approximate rule.
                {c.waterState === 'ice' && ' Water drawn frozen: global-mean temperature below 0 °C.'}
                {c.waterState === 'none' && ' Basins drawn dry: water cannot stay liquid at this mean temperature and pressure.'}
              </p>
            )}
            <p className={styles.note}>
              {look.visible
                ? `Atmosphere shell: height ∝ scale height (×${ATMOS_EXAGGERATION}), opacity grows with surface pressure — a visual cue, not to scale.`
                : 'No atmosphere (surface pressure 0).'}{' '}
              Star size and distance are not to scale.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
