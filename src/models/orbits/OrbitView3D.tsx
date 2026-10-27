import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeStage, type ThreeContext, type ThreeStageHandle } from '../../three/ThreeStage';
import { COLORS, seriesColor } from '../../lib/palette';
import { niceStep } from '../../lib/camera2d';
import { formatNumber } from '../../engine/units';
import type { ParamValues } from '../../engine/types';
import type { ModelViewProps } from '../../views/types';
import type { Body, NBodyState } from './nbody';

/**
 * Shared three.js view for the orbital-mechanics models. Draws the bodies of
 * the model's N-body state, trails from the recorded tracks (up to the
 * displayed time), baseline ghost trails, a reference ring grid, optional
 * measurement line and velocity arrows, and an info card for a selected body.
 * Simulation coordinates (x, y, z) map to scene (x, z, −y) so the orbital
 * plane is horizontal.
 */

export type BodyKind = 'star' | 'planet' | 'earth' | 'moon' | 'asteroid';

export interface OrbitViewConfig<S> {
  system: (s: S) => NBodyState;
  /** Body that distances and relative speeds are measured from. */
  primaryId: string;
  /** Metres per track unit (tracks are recorded in this unit). */
  unitMetres: number;
  unitLabel: string;
  /** Scene units per track unit. */
  sceneScale: number;
  kind: (b: Body) => BodyKind;
  /** Size exaggeration per body kind in "visible scale" mode. */
  exaggeration: (p: ParamValues) => Partial<Record<BodyKind, number>>;
  /** Characteristic size of the system in track units (camera fit and ring spacing). */
  extent: (p: ParamValues) => number;
  /** Velocity-arrow length in track units per m/s. */
  arrowScale: (p: ParamValues) => number;
  /** Optional translucent shell, e.g. the 100 km atmosphere boundary. */
  shell?: { bodyId: string; altitudeMetres: number; label: string };
  ariaLabel: string;
  /** One line describing the reference frame of the drawing. */
  frameNote: string;
}

const CAP = 4200;
const STAR_COLOR = '#fff1d6';
const MIN_PX = 3;
const KIND_NAMES: Record<BodyKind, string> = { star: 'star', planet: 'planets', earth: 'Earth', moon: 'moons', asteroid: 'asteroid' };

interface TrailObj {
  line: THREE.Line;
  geom: THREE.BufferGeometry;
  attr: THREE.BufferAttribute;
  srcX: number[] | null;
  written: number;
}

interface BodyObj {
  mesh: THREE.Mesh;
  glow?: THREE.Sprite;
  shell?: THREE.Mesh;
  label: HTMLDivElement;
  arrow: THREE.ArrowHelper;
  kind: BodyKind;
  radius: number;
}

interface SceneObjs {
  root: THREE.Group;
  sphere: THREE.SphereGeometry;
  glowTex: THREE.Texture;
  point: THREE.PointLight;
  sun: THREE.DirectionalLight;
  bodies: Map<string, BodyObj>;
  trails: Map<string, TrailObj>;
  rings: THREE.Group;
  ringSpacing: number;
  baselineGroup: THREE.Group;
  baselineRef: unknown;
  ghosts: { id: string; mesh: THREE.Mesh; t: number[]; x: number[]; y: number[]; z: number[] }[];
  measure: THREE.Line;
  measureAttr: THREE.BufferAttribute;
  fitExtent: number;
  fitKey: number;
  lastPrimary: THREE.Vector3 | null;
}

function fmt(v: number, sig = 3) {
  return formatNumber(Number.isFinite(v) ? Number(v.toPrecision(sig)) : v, sig);
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,241,214,0.85)');
  grd.addColorStop(0.25, 'rgba(255,222,170,0.3)');
  grd.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function bodyColor(b: Body, kind: BodyKind) {
  return kind === 'star' ? STAR_COLOR : seriesColor(Math.max(0, b.slot));
}

/** Largest index with t[i] ≤ time, plus one (binary search). */
function countUpTo(t: number[], time: number) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time + 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function exaggerationText(f: Partial<Record<BodyKind, number>>, present: Set<BodyKind>): string {
  const parts = [...present].filter((k) => (f[k] ?? 1) !== 1).map((k) => `${KIND_NAMES[k]} ×${fmt(f[k]!, 3)}`);
  return parts.length ? `Sizes exaggerated: ${parts.join(', ')}` : 'Sizes to scale';
}

const btn: React.CSSProperties = {
  pointerEvents: 'auto',
  font: '500 11px var(--font-sans)',
  color: COLORS.text,
  background: COLORS.panel2,
  border: `1px solid ${COLORS.axis}`,
  borderRadius: 6,
  padding: '4px 8px',
  cursor: 'pointer',
};

export function OrbitView3D<S>({ runner, baseline, overlays, cameraResetKey, config }: ModelViewProps<S> & { config: OrbitViewConfig<S> }) {
  const stage = useRef<ThreeStageHandle>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const cardText = useRef<HTMLDivElement>(null);
  const measureLabel = useRef<HTMLDivElement>(null);
  const objs = useRef<SceneObjs | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [trueScale, setTrueScale] = useState(false);
  const [follow, setFollow] = useState(false);
  const live = useRef({ runner, baseline, overlays, config, selected, trueScale, follow });
  live.current = { runner, baseline, overlays, config, selected, trueScale, follow };

  useEffect(() => {
    if (objs.current) objs.current.fitKey++;
  }, [cameraResetKey]);

  const setup = (ctx: ThreeContext) => {
    const root = new THREE.Group();
    ctx.scene.add(root);
    root.add(new THREE.AmbientLight(0xffffff, 0.25));
    const point = new THREE.PointLight(STAR_COLOR, 3, 0, 0);
    root.add(point);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-60, 25, 35);
    root.add(sun);
    const rings = new THREE.Group();
    root.add(rings);
    const baselineGroup = new THREE.Group();
    root.add(baselineGroup);
    const mgeom = new THREE.BufferGeometry();
    const measureAttr = new THREE.BufferAttribute(new Float32Array(6), 3);
    mgeom.setAttribute('position', measureAttr);
    const measure = new THREE.Line(mgeom, new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.8 }));
    measure.frustumCulled = false;
    measure.visible = false;
    root.add(measure);
    objs.current = {
      root,
      sphere: new THREE.SphereGeometry(1, 32, 16),
      glowTex: glowTexture(),
      point,
      sun,
      bodies: new Map(),
      trails: new Map(),
      rings,
      ringSpacing: 0,
      baselineGroup,
      baselineRef: undefined,
      ghosts: [],
      measure,
      measureAttr,
      fitExtent: 0,
      fitKey: 1,
      lastPrimary: null,
    };
    return () => {
      const o = objs.current;
      if (o) {
        o.glowTex.dispose();
        for (const b of o.bodies.values()) b.label.remove();
      }
      objs.current = null;
    };
  };

  const ensureBody = (o: SceneObjs, b: Body, kind: BodyKind): BodyObj => {
    let bo = o.bodies.get(b.id);
    if (bo) return bo;
    const color = bodyColor(b, kind);
    const mat = kind === 'star' ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
    const mesh = new THREE.Mesh(o.sphere, mat);
    mesh.userData.id = b.id;
    o.root.add(mesh);
    let glow: THREE.Sprite | undefined;
    if (kind === 'star') {
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: o.glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      o.root.add(glow);
    }
    let shell: THREE.Mesh | undefined;
    const sh = live.current.config.shell;
    if (sh && sh.bodyId === b.id) {
      shell = new THREE.Mesh(o.sphere, new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.12, depthWrite: false }));
      o.root.add(shell);
    }
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, new THREE.Color(COLORS.text).getHex());
    arrow.visible = false;
    o.root.add(arrow);
    const label = document.createElement('div');
    label.textContent = b.label;
    Object.assign(label.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      font: '600 11px var(--font-sans)',
      color: COLORS.text2,
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      textShadow: `0 0 3px ${COLORS.bg}`,
    });
    overlay.current?.appendChild(label);
    bo = { mesh, glow, shell, label, arrow, kind, radius: 1 };
    o.bodies.set(b.id, bo);
    return bo;
  };

  const ensureTrail = (o: SceneObjs, id: string, color: string, opacity: number): TrailObj => {
    let tr = o.trails.get(id);
    if (tr) return tr;
    const geom = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', attr);
    geom.setDrawRange(0, 0);
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    line.frustumCulled = false;
    o.root.add(line);
    tr = { line, geom, attr, srcX: null, written: 0 };
    o.trails.set(id, tr);
    return tr;
  };

  const rebuildRings = (o: SceneObjs, spacing: number, count: number, k: number) => {
    for (const c of [...o.rings.children]) {
      o.rings.remove(c);
      const l = c as THREE.LineLoop;
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    const segs = 128;
    for (let i = 1; i <= count; i++) {
      const pts = new Float32Array(segs * 3);
      const r = i * spacing * k;
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        pts[3 * j] = r * Math.cos(a);
        pts[3 * j + 2] = -r * Math.sin(a);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      o.rings.add(new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: COLORS.axis, transparent: true, opacity: i % 5 === 0 ? 0.9 : 0.55 })));
    }
    o.ringSpacing = spacing;
  };

  const rebuildBaseline = (o: SceneObjs, k: number) => {
    for (const c of [...o.baselineGroup.children]) {
      o.baselineGroup.remove(c);
      const m = c as THREE.Mesh;
      m.geometry.dispose?.();
      (m.material as THREE.Material).dispose();
    }
    o.ghosts = [];
    const bl = live.current.baseline;
    o.baselineRef = bl;
    if (!bl) return;
    for (const [id, tr] of Object.entries(bl.tracks)) {
      const n = Math.min(tr.t.length, CAP);
      const stride = Math.max(1, Math.ceil(tr.t.length / CAP));
      const pts = new Float32Array(n * 3);
      for (let i = 0, j = 0; i < tr.t.length && j < n; i += stride, j++) {
        pts[3 * j] = tr.x[i] * k;
        pts[3 * j + 1] = tr.z[i] * k;
        pts[3 * j + 2] = -tr.y[i] * k;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLORS.baseline, transparent: true, opacity: 0.45 }));
      line.frustumCulled = false;
      o.baselineGroup.add(line);
      const ghost = new THREE.Mesh(o.sphere, new THREE.MeshBasicMaterial({ color: COLORS.baseline, transparent: true, opacity: 0.55 }));
      o.baselineGroup.add(ghost);
      o.ghosts.push({ id, mesh: ghost, t: tr.t, x: tr.x, y: tr.y, z: tr.z });
    }
  };

  const fit = (ctx: ThreeContext, o: SceneObjs, extentScene: number, target: THREE.Vector3) => {
    const d = Math.max(extentScene, 1e-6) * 2.7;
    ctx.camera.position.set(target.x, target.y + d * 0.62, target.z + d * 0.78);
    ctx.controls.target.copy(target);
    ctx.camera.near = Math.max(d * 1e-5, 1e-6);
    ctx.camera.far = d * 200;
    ctx.camera.updateProjectionMatrix();
    ctx.controls.update();
    o.fitExtent = extentScene;
  };

  const tmp = useRef({ v: new THREE.Vector3(), w: new THREE.Vector3(), prim: new THREE.Vector3(), lastFitKey: 0 });

  const frame = (ctx: ThreeContext) => {
    const o = objs.current;
    if (!o) return;
    const { runner, overlays, config: cfg, selected: sel, trueScale: ts, follow: fol } = live.current;
    const s = runner.viewState;
    const p = runner.viewParams;
    const sys = cfg.system(s);
    const time = runner.time;
    const kTrack = cfg.sceneScale; // scene units per track unit
    const k = cfg.sceneScale / cfg.unitMetres; // scene units per metre
    const T = tmp.current;
    const toScene = (pos: number[], out: THREE.Vector3) => out.set(pos[0] * k, pos[2] * k, -pos[1] * k);

    // Reference rings and camera fit, driven by the system's characteristic size.
    const extent = cfg.extent(runner.core.initialParams);
    const spacing = niceStep(extent, 2);
    if (spacing !== o.ringSpacing) rebuildRings(o, spacing, Math.max(2, Math.min(12, Math.ceil((1.6 * extent) / spacing))), kTrack);
    const primary = sys.bodies.find((b) => b.id === cfg.primaryId);
    if (primary) toScene(primary.pos, T.prim);
    const extentScene = extent * kTrack;
    if (T.lastFitKey !== o.fitKey || o.fitExtent === 0 || Math.abs(extentScene / o.fitExtent - 1) > 0.25) {
      T.lastFitKey = o.fitKey;
      fit(ctx, o, extentScene, fol && primary ? T.prim.clone() : new THREE.Vector3());
      o.lastPrimary = null;
    }
    if (fol && primary?.alive) {
      if (o.lastPrimary) {
        T.v.copy(T.prim).sub(o.lastPrimary);
        ctx.camera.position.add(T.v);
        ctx.controls.target.add(T.v);
      }
      o.lastPrimary = (o.lastPrimary ?? new THREE.Vector3()).copy(T.prim);
    } else o.lastPrimary = null;

    // Bodies.
    const fac = cfg.exaggeration(p);
    const tanHalf = Math.tan((ctx.camera.fov * Math.PI) / 360);
    const pxToWorld = (dist: number) => (dist * tanHalf * 2) / Math.max(ctx.size.height, 1);
    let hasStar = false;
    const present = new Set<BodyKind>();
    for (const b of sys.bodies) {
      const kind = cfg.kind(b);
      const bo = ensureBody(o, b, kind);
      bo.mesh.visible = b.alive;
      if (bo.glow) bo.glow.visible = b.alive;
      if (bo.shell) bo.shell.visible = b.alive;
      if (!b.alive) {
        bo.label.style.display = 'none';
        bo.arrow.visible = false;
        continue;
      }
      present.add(kind);
      toScene(b.pos, bo.mesh.position);
      const f = ts ? 1 : fac[kind] ?? 1;
      const rTrue = b.radius * k * f;
      const dist = ctx.camera.position.distanceTo(bo.mesh.position);
      const r = Math.max(rTrue, MIN_PX * pxToWorld(dist));
      bo.radius = r;
      bo.mesh.scale.setScalar(r);
      if (kind === 'star') {
        hasStar = true;
        o.point.position.copy(bo.mesh.position);
        bo.glow!.position.copy(bo.mesh.position);
        bo.glow!.scale.setScalar(r * 7);
      }
      if (bo.shell && cfg.shell) {
        bo.shell.position.copy(bo.mesh.position);
        bo.shell.scale.setScalar(r * (1 + cfg.shell.altitudeMetres / b.radius));
      }
      // Velocity arrows (simulation frame).
      if (overlays.vectors) {
        const sp = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
        const len = sp * cfg.arrowScale(p) * kTrack;
        if (len > 1e-3 * extentScene) {
          bo.arrow.visible = true;
          bo.arrow.position.copy(bo.mesh.position);
          bo.arrow.setDirection(T.v.set(b.vel[0], b.vel[2], -b.vel[1]).normalize());
          bo.arrow.setLength(len, Math.min(len * 0.25, extentScene * 0.06), Math.min(len * 0.12, extentScene * 0.03));
        } else bo.arrow.visible = false;
      } else bo.arrow.visible = false;
      // Name label.
      T.w.copy(bo.mesh.position).project(ctx.camera);
      if (T.w.z > 1 || T.w.z < -1) bo.label.style.display = 'none';
      else {
        const sx = ((T.w.x + 1) / 2) * ctx.size.width;
        const sy = ((1 - T.w.y) / 2) * ctx.size.height;
        const rpx = r / Math.max(pxToWorld(dist), 1e-12);
        bo.label.style.display = 'block';
        bo.label.style.transform = `translate(${Math.round(sx + Math.min(rpx, 40) + 4)}px, ${Math.round(sy - 14)}px)`;
        bo.label.style.color = b.id === sel ? COLORS.text : COLORS.text2;
      }
    }
    o.point.visible = hasStar;
    o.sun.visible = !hasStar;

    // Trails up to the displayed time (preallocated buffers, incremental writes).
    const tracks = runner.core.tracks;
    const atHead = runner.viewIndex === null;
    for (const [id, tr] of o.trails) if (!tracks[id]) tr.geom.setDrawRange(0, 0);
    for (const [id, src] of Object.entries(tracks)) {
      const b = sys.bodies.find((x) => x.id === id);
      const kind = b ? cfg.kind(b) : 'planet';
      const trail = ensureTrail(o, id, b ? bodyColor(b, kind) : COLORS.text2, kind === 'star' ? 0.5 : 0.85);
      const arr = trail.attr.array as Float32Array;
      const n = src.t.length;
      let lo = Infinity;
      let hi = 0;
      let count: number;
      if (n >= CAP) {
        // Rare (very long recordings): draw a strided copy.
        const stride = Math.ceil(n / (CAP - 1));
        const upto = countUpTo(src.t, time);
        let j = 0;
        for (let i = 0; i < upto && j < CAP; i += stride, j++) {
          arr[3 * j] = src.x[i] * kTrack;
          arr[3 * j + 1] = src.z[i] * kTrack;
          arr[3 * j + 2] = -src.y[i] * kTrack;
        }
        trail.srcX = null;
        trail.written = 0;
        lo = 0;
        hi = j;
        count = j;
      } else {
        if (src.x !== trail.srcX) {
          trail.srcX = src.x;
          trail.written = 0;
        }
        if (n < trail.written) trail.written = n;
        if (trail.written < n) {
          lo = trail.written;
          hi = n;
          for (let i = trail.written; i < n; i++) {
            arr[3 * i] = src.x[i] * kTrack;
            arr[3 * i + 1] = src.z[i] * kTrack;
            arr[3 * i + 2] = -src.y[i] * kTrack;
          }
          trail.written = n;
        }
        count = countUpTo(src.t, time);
        // Join the trail to the body's current position at the live head.
        if (atHead && count === n && b?.alive && count < CAP) {
          toScene(b.pos, T.v);
          arr[3 * count] = T.v.x;
          arr[3 * count + 1] = T.v.y;
          arr[3 * count + 2] = T.v.z;
          lo = Math.min(lo, count);
          hi = Math.max(hi, count + 1);
          count++;
        }
      }
      if (hi > lo) {
        trail.attr.clearUpdateRanges();
        trail.attr.addUpdateRange(lo * 3, (hi - lo) * 3);
        trail.attr.needsUpdate = true;
      }
      trail.geom.setDrawRange(0, count);
    }

    // Baseline ghost trails and the ghost positions at the displayed time.
    if (o.baselineRef !== live.current.baseline) rebuildBaseline(o, kTrack);
    for (const g of o.ghosts) {
      const c = countUpTo(g.t, time);
      g.mesh.visible = c > 0;
      if (!g.mesh.visible) continue;
      const i = c - 1;
      g.mesh.position.set(g.x[i] * kTrack, g.z[i] * kTrack, -g.y[i] * kTrack);
      const bo = o.bodies.get(g.id);
      g.mesh.scale.setScalar(bo ? bo.radius * 0.8 : MIN_PX * pxToWorld(ctx.camera.position.distanceTo(g.mesh.position)));
    }

    // Measurement: line and distance from the primary to the selected (or first) body.
    const ml = measureLabel.current;
    let target: Body | undefined;
    if (overlays.measurements && primary?.alive) {
      target = sys.bodies.find((b) => b.id === sel && b.alive && b.id !== primary.id) ?? sys.bodies.find((b) => b.alive && b.id !== primary.id);
    }
    if (target && primary) {
      const a = o.measureAttr.array as Float32Array;
      toScene(primary.pos, T.v);
      toScene(target.pos, T.w);
      a[0] = T.v.x;
      a[1] = T.v.y;
      a[2] = T.v.z;
      a[3] = T.w.x;
      a[4] = T.w.y;
      a[5] = T.w.z;
      o.measureAttr.needsUpdate = true;
      o.measure.visible = true;
      if (ml) {
        const d = Math.hypot(target.pos[0] - primary.pos[0], target.pos[1] - primary.pos[1], target.pos[2] - primary.pos[2]);
        T.v.add(T.w).multiplyScalar(0.5).project(ctx.camera);
        if (T.v.z > 1 || T.v.z < -1) ml.style.display = 'none';
        else {
          ml.style.display = 'block';
          ml.style.transform = `translate(${Math.round(((T.v.x + 1) / 2) * ctx.size.width)}px, ${Math.round(((1 - T.v.y) / 2) * ctx.size.height)}px) translate(-50%, -130%)`;
          ml.textContent = `${fmt(d / cfg.unitMetres, 4)} ${cfg.unitLabel}${cfg.unitLabel === 'km' ? '' : ` · ${fmt(d / 1000, 4)} km`}`;
        }
      }
    } else {
      o.measure.visible = false;
      if (ml) ml.style.display = 'none';
    }

    // Info card for the selected body (values read from the displayed state).
    const card = cardText.current;
    if (card && sel) {
      const b = sys.bodies.find((x) => x.id === sel);
      if (!b) card.textContent = '';
      else if (!b.alive) card.textContent = `${b.label}\n${b.mergedInto ? 'Merged in a collision' : b.removed ? 'Removed from the simulation' : 'Gone'}`;
      else {
        const lines = [b.label, `Mass: ${fmt(b.mass)} kg`];
        if (primary && b.id !== primary.id && primary.alive) {
          const d = Math.hypot(b.pos[0] - primary.pos[0], b.pos[1] - primary.pos[1], b.pos[2] - primary.pos[2]);
          const v = Math.hypot(b.vel[0] - primary.vel[0], b.vel[1] - primary.vel[1], b.vel[2] - primary.vel[2]);
          lines.push(`Distance to ${primary.label}: ${fmt(d / cfg.unitMetres, 4)} ${cfg.unitLabel}${cfg.unitLabel === 'km' ? '' : ` (${fmt(d / 1000, 4)} km)`}`);
          lines.push(`Speed relative to ${primary.label}: ${fmt(v / 1000, 4)} km/s`);
        } else {
          const v = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
          lines.push(`Speed in the simulation frame: ${fmt(v, 3)} m/s`);
        }
        card.textContent = lines.join('\n');
      }
    }
  };

  const onPick = (ctx: ThreeContext, ndc: THREE.Vector2) => {
    const o = objs.current;
    if (!o) return;
    const meshes = [...o.bodies.values()].filter((b) => b.mesh.visible).map((b) => b.mesh);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (hit) {
      setSelected(String(hit.object.userData.id));
      return;
    }
    // Small bodies: accept taps within ~16 px of the body's centre.
    let best: string | null = null;
    let bestD = 16;
    const v = new THREE.Vector3();
    for (const m of meshes) {
      v.copy(m.position).project(ctx.camera);
      if (v.z > 1 || v.z < -1) continue;
      const dx = ((v.x - ndc.x) / 2) * ctx.size.width;
      const dy = ((v.y - ndc.y) / 2) * ctx.size.height;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = String(m.userData.id);
      }
    }
    setSelected(best);
  };

  // React-rendered HUD (re-renders with the runner's version).
  const p = runner.viewParams;
  const extent = config.extent(runner.core.initialParams);
  const spacing = niceStep(extent, 2);
  const sys = config.system(runner.viewState);
  const present = new Set(sys.bodies.filter((b) => b.alive).map((b) => config.kind(b)));
  const primaryLabel = sys.bodies.find((b) => b.id === config.primaryId)?.label ?? 'primary';
  const arrowPerRing = spacing / config.arrowScale(p) / 1000;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: COLORS.bg }}>
      <ThreeStage ref={stage} setup={setup} frame={frame} onPick={onPick} cameraPosition={[0, 14, 18]} ariaLabel={config.ariaLabel} />
      <div ref={overlay} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <div
          ref={measureLabel}
          style={{ position: 'absolute', left: 0, top: 0, display: 'none', font: '500 11px var(--font-mono)', color: COLORS.accent, background: 'rgba(6,8,11,0.7)', padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap' }}
        />
      </div>
      {selected && (
        <div style={{ position: 'absolute', top: 10, left: 10, maxWidth: 'calc(100% - 20px)', background: 'rgba(13,17,23,0.92)', border: `1px solid ${COLORS.axis}`, borderRadius: 8, padding: '8px 28px 8px 10px', font: '12px var(--font-sans)', color: COLORS.text2, lineHeight: 1.5 }}>
          <div ref={cardText} style={{ whiteSpace: 'pre-line' }} />
          <button type="button" aria-label="Close" onClick={() => setSelected(null)} style={{ ...btn, position: 'absolute', top: 4, right: 4, padding: '0 6px', border: 'none', background: 'transparent', fontSize: 14 }}>
            ×
          </button>
        </div>
      )}
      <div style={{ position: 'absolute', left: 10, right: 10, bottom: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end', pointerEvents: 'none' }}>
        <div style={{ font: '11px var(--font-sans)', color: COLORS.text2, background: 'rgba(6,8,11,0.7)', borderRadius: 6, padding: '4px 8px', lineHeight: 1.5 }}>
          <div>{trueScale ? 'Sizes to scale' : exaggerationText(config.exaggeration(p), present)} · bodies under {MIN_PX} px drawn at {MIN_PX} px</div>
          <div>
            Rings every {fmt(spacing)} {config.unitLabel} · {config.frameNote}
          </div>
          {overlays.vectors && <div>Arrows: velocity in the simulation frame; one ring spacing = {fmt(arrowPerRing)} km/s</div>}
          {baseline && (
            <div>
              <span style={{ color: COLORS.baseline }}>━</span> Baseline paths and positions (grey)
            </div>
          )}
          {!selected && <div style={{ color: COLORS.muted }}>Tap a body for details</div>}
        </div>
        <button type="button" style={btn} onClick={() => setTrueScale((v) => !v)} aria-pressed={trueScale}>
          {trueScale ? 'Exaggerate sizes' : 'True scale'}
        </button>
        <button type="button" style={{ ...btn, borderColor: follow ? COLORS.accent : COLORS.axis }} onClick={() => setFollow((v) => !v)} aria-pressed={follow}>
          Follow {primaryLabel}
        </button>
      </div>
    </div>
  );
}
