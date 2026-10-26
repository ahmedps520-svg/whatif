import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { COLORS } from '../lib/palette';

export interface ThreeContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  /** Pixel size of the viewport. */
  size: { width: number; height: number };
}

export interface ThreeStageHandle {
  resetCamera: () => void;
  context: () => ThreeContext | null;
}

interface Props {
  /** One-time scene construction. Return a cleanup that disposes what it created. */
  setup: (ctx: ThreeContext) => (() => void) | void;
  /** Called every frame before rendering. */
  frame?: (ctx: ThreeContext, dt: number) => void;
  /** Called when the user clicks (without dragging) on the scene. */
  onPick?: (ctx: ThreeContext, ndc: THREE.Vector2, event: PointerEvent) => void;
  /** Initial camera position; restored by resetCamera. */
  cameraPosition?: [number, number, number];
  cameraTarget?: [number, number, number];
  fov?: number;
  near?: number;
  far?: number;
  ariaLabel: string;
}

/**
 * Minimal three.js host: renderer, perspective camera and orbit controls
 * (rotate, zoom, pan — mouse and touch gestures). Rendering runs on its own
 * animation loop and only reads simulation state.
 */
export const ThreeStage = forwardRef<ThreeStageHandle, Props>(function ThreeStage(
  { setup, frame, onPick, cameraPosition = [0, 2, 6], cameraTarget = [0, 0, 0], fov = 45, near = 0.01, far = 1e5, ariaLabel },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<ThreeContext | null>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
      const c = ctxRef.current;
      if (!c) return;
      c.camera.position.set(...cameraPosition);
      c.controls.target.set(...cameraTarget);
      c.controls.update();
    },
    context: () => ctxRef.current,
  }));

  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      host.innerHTML = '<p class="stage-error">3D view unavailable: this browser could not start WebGL. The simulation and its data still run; see the charts and readouts.</p>';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(COLORS.bg);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', ariaLabel);
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    camera.position.set(...cameraPosition);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(...cameraTarget);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.update();

    const ctx: ThreeContext = { scene, camera, renderer, controls, canvas, size: { width: 1, height: 1 } };
    ctxRef.current = ctx;

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, r.width);
      const h = Math.max(1, r.height);
      ctx.size.width = w;
      ctx.size.height = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 5 || !pickRef.current) return;
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      pickRef.current(ctx, ndc, e);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);

    const cleanupScene = setup(ctx);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      controls.update();
      try {
        frameRef.current?.(ctx, dt);
      } catch (err) {
        console.error('3D frame error', err);
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      cleanupScene?.();
      controls.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      canvas.remove();
      ctxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="three-host" style={{ width: '100%', height: '100%', position: 'relative' }} />;
});
