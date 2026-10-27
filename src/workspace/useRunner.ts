import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveRunner } from '../engine/runner';
import type { ParamValues, SimulationModel } from '../engine/types';

/**
 * Create a LiveRunner for a model and drive it from requestAnimationFrame.
 * React re-renders are throttled (panels and charts don't need 60 fps);
 * views draw on their own loop straight from runner state.
 */
export function useRunner(model: SimulationModel | null, params: ParamValues | null, fps = 12) {
  const runner = useMemo(() => (model && params ? new LiveRunner(model, params) : null), [model, params]);
  const [version, setVersion] = useState(0);
  const lastEmit = useRef(0);

  useEffect(() => {
    if (!runner) return;
    let pending = false;
    let lastStatus = runner.status;
    const unsub = runner.subscribe(() => {
      const now = performance.now();
      const statusChanged = runner.status !== lastStatus;
      lastStatus = runner.status;
      if (statusChanged || runner.status !== 'running' || now - lastEmit.current > 1000 / fps) {
        lastEmit.current = now;
        setVersion(runner.version);
        pending = false;
      } else pending = true;
    });
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      runner.tick(dt);
      if (pending && now - lastEmit.current > 1000 / fps) {
        lastEmit.current = now;
        pending = false;
        setVersion(runner.version);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [runner, fps]);

  return { runner, version };
}
