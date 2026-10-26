import { useEffect, useRef } from 'react';

export interface StageSize {
  width: number;
  height: number;
  dpr: number;
}

interface Props {
  /** Called every animation frame. Read live data from refs, not props. */
  draw: (ctx: CanvasRenderingContext2D, size: StageSize, dt: number) => void;
  /** Called once with the canvas element (attach pointer handlers here). Return a cleanup. */
  onMount?: (canvas: HTMLCanvasElement) => (() => void) | void;
  ariaLabel: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * A high-DPI canvas that resizes with its container and redraws every frame.
 * Rendering never drives simulation time; it only reads the latest state.
 */
export function CanvasStage({ draw, onMount, ariaLabel, className, style }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const size: StageSize = { width: 1, height: 1, dpr: 1 };
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      size.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      size.width = Math.max(1, r.width);
      size.height = Math.max(1, r.height);
      canvas.width = Math.round(size.width * size.dpr);
      canvas.height = Math.round(size.height * size.dpr);
    });
    ro.observe(canvas);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      try {
        drawRef.current(ctx, size, dt);
      } catch (err) {
        console.error('Render error', err);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const cleanup = onMount?.(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} role="img" aria-label={ariaLabel} className={className} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', ...style }} />;
}
