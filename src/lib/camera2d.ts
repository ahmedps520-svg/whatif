/**
 * World ↔ screen transform for 2D scenes with pan, zoom and fit-to-bounds.
 * World y points up; screen y points down.
 */
export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class Camera2D {
  /** World coordinates of the view centre. */
  cx = 0;
  cy = 0;
  /** Pixels per world unit. */
  scale = 10;
  width = 1;
  height = 1;
  /** True once the user panned/zoomed manually; auto-fit stops until reset. */
  userControlled = false;

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }

  toScreenX(x: number) {
    return (x - this.cx) * this.scale + this.width / 2;
  }

  toScreenY(y: number) {
    return this.height / 2 - (y - this.cy) * this.scale;
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.scale + this.cx, (this.height / 2 - sy) / this.scale + this.cy];
  }

  /** Fit bounds into the viewport with a margin (fraction of size). */
  fit(b: Bounds, margin = 0.12, smooth = 0) {
    const w = Math.max(b.maxX - b.minX, 1e-6);
    const h = Math.max(b.maxY - b.minY, 1e-6);
    const s = Math.min((this.width * (1 - 2 * margin)) / w, (this.height * (1 - 2 * margin)) / h);
    const tcx = (b.minX + b.maxX) / 2;
    const tcy = (b.minY + b.maxY) / 2;
    if (smooth > 0) {
      this.scale += (s - this.scale) * smooth;
      this.cx += (tcx - this.cx) * smooth;
      this.cy += (tcy - this.cy) * smooth;
    } else {
      this.scale = s;
      this.cx = tcx;
      this.cy = tcy;
    }
  }

  pan(dxPx: number, dyPx: number) {
    this.cx -= dxPx / this.scale;
    this.cy += dyPx / this.scale;
    this.userControlled = true;
  }

  zoomAt(factor: number, sx: number, sy: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(Math.max(this.scale * factor, 1e-9), 1e9);
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
    this.userControlled = true;
  }
}

/** A "nice" tick step (1, 2 or 5 × 10ⁿ) for a span divided into ~count ticks. */
export function niceStep(span: number, count = 6): number {
  const raw = span / Math.max(count, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * mag;
}

/**
 * Attach pointer handlers (drag to pan, wheel/pinch to zoom) to an element.
 * Returns a cleanup function.
 */
export function attachPanZoom(el: HTMLElement, cam: Camera2D, onChange?: () => void): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const down = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      cam.pan(e.clientX - prev.x, e.clientY - prev.y);
      onChange?.();
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        const r = el.getBoundingClientRect();
        cam.zoomAt(d / pinchDist, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        onChange?.();
      }
      pinchDist = d;
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const [sx, sy] = local(e);
    cam.zoomAt(Math.exp(-e.deltaY * 0.0015), sx, sy);
    onChange?.();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel);
  };
}
